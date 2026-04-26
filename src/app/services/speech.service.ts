// ─────────────────────────────────────────────────────────────────
// services/speech.service.ts
//
// SINGLE SOURCE OF TRUTH for all audio in/out.
// No StreamingSpeechService. No WebSocket backend. No partial chunks.
//
// RECORDING PIPELINE:
//   getUserMedia → AudioWorklet VAD (vad-processor.js)
//     → VAD detects real silence (envelope follower, not timer)
//     → MediaRecorder accumulates ONE complete audio blob per answer
//     → blob → Whisper API (one call, complete audio, accurate result)
//     → transcript + analysis emitted
//
// TTS PIPELINE:
//   text → OpenAI TTS API → Audio element (sentence queue)
//   Fallback: browser speechSynthesis
//
// ROOT CAUSE OF OLD BUG:
//   StreamingSpeechService sent rolling 2.5s audio windows to Whisper.
//   Each window returned a fragment like "Recording your answer" because
//   that's what was audible in that 2.5s slice. The transcript signal
//   held that fragment, and finish() emitted it as the "final" answer.
//   Fix: record the WHOLE turn as one blob, send ONCE when VAD commits.
// ─────────────────────────────────────────────────────────────────

import { Injectable, signal, NgZone } from "@angular/core";
import { Subject } from "rxjs";

export type SpeechPhase =
  | "idle"
  | "listening"
  | "user-speaking"
  | "filler-pause"
  | "processing"
  | "ai-thinking"
  | "ai-speaking";

export interface SpeechAnalysis {
  transcript: string;
  hasFillers: boolean;
  fillerCount: number;
  pauseCount: number;
  confidenceHint: "confident" | "hesitant" | "unclear";
  rawDurationMs: number;
  wordsPerMinute: number;
}

type TurnState =
  | "inactive"
  | "waiting"
  | "speaking"
  | "silence-short"
  | "silence-long"
  | "committing";

@Injectable({ providedIn: "root" })
export class SpeechService {
  // ── Public reactive signals ───────────────────────────────────
  phase = signal<SpeechPhase>("idle");
  isListening = signal(false);
  isSpeaking = signal(false);
  // Live status text shown in avatar UI — never the actual transcript
  // until Whisper returns. This prevents garbage text going to GPT.
  transcript = signal("");
  recordingMs = signal(0);
  error = signal<string | null>(null);

  // ── Output streams ────────────────────────────────────────────
  // transcriptComplete$ emits ONLY after Whisper returns clean text
  // analysisComplete$   emits the confidence analysis for GPT prompt
  transcriptComplete$ = new Subject<string>();
  analysisComplete$ = new Subject<SpeechAnalysis>();

  readonly sttSupported = !!navigator.mediaDevices?.getUserMedia;
  readonly ttsSupported = true;

  // ── Private: VAD + recording ──────────────────────────────────
  private turnState: TurnState = "inactive";
  private audioCtx: AudioContext | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private scriptProc: ScriptProcessorNode | null = null;
  private micStream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private turnStart = 0;

  // Silence tracking — wall clock based, reset by envelope data
  private silenceStartMs: number | null = null;
  private hadSpeech = false;
  private totalSpeechMs = 0;
  private lastSpeechMs = 0;
  private speechStartCandidate: number | null = null;
  private lastStableSpeechMs = 0;
  private durationInterval: ReturnType<typeof setInterval> | null = null;

  // ── VAD timing constants ──────────────────────────────────────
  // These are the knobs. Increase COMMIT_SILENCE_MS if it still
  // cuts off mid-thought. Decrease SPEECH_STABILITY_MS if it's
  // slow to start detecting voice.
  private readonly MIN_SPEECH_MS = 400;
  private readonly SPEECH_STABILITY_MS = 100; // ms of continuous voice before counting
  private readonly PATIENCE_SILENCE_MS = 1500; // show "take your time" after this
  private readonly COMMIT_SILENCE_MS = 3000; // submit after this much real silence
  private readonly RESUME_GRACE_MS = 600; // after scheduling commit, check if resumed
  private readonly MOMENTUM_PER_10S = 500; // extra patience per 10s of speech
  private readonly MAX_TURN_MS = 120000;

  private apiKey = "";
  private ttsAudio: HTMLAudioElement | null = null;

  constructor(private ngZone: NgZone) {}

  setApiKey(k: string): void {
    this.apiKey = k.trim();
  }

  muteVAD(muted: boolean): void {
    this.workletNode?.port.postMessage({ muted });
    // ScriptProcessor fallback: just disable the flag via a closure variable
    // (handled by the isSpeaking guard in AiService before any frame fires)
  }

  // ─────────────────────────────────────────────────────────────
  // START LISTENING
  // Opens mic, sets up VAD via AudioWorklet, starts MediaRecorder.
  // MediaRecorder records the ENTIRE turn — not chunks.
  // ─────────────────────────────────────────────────────────────

  async startListening(): Promise<void> {
    if (this.isListening()) return;

    this.error.set(null);
    this.transcript.set("");
    this.recordingMs.set(0);

    // ── Mic ───────────────────────────────────────────────────
    try {
      this.micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          sampleRate: 16000,
          channelCount: 1,
        },
      });
    } catch {
      this.error.set("Microphone permission denied. Please allow mic access.");
      return;
    }

    // ── AudioContext for VAD ───────────────────────────────────
    this.audioCtx = new AudioContext({ sampleRate: 16000 });

    let vadSetup: "worklet" | "script" | "failed" = "failed";

    try {
      await this.audioCtx.audioWorklet.addModule("/assets/vad-processor.js");
      this.workletNode = new AudioWorkletNode(this.audioCtx, "vad-processor");
      this.workletNode.port.onmessage = (e) => {
        this.ngZone.run(() => this.onVADFrame(e.data));
      };
      const src = this.audioCtx.createMediaStreamSource(this.micStream);
      src.connect(this.workletNode);
      // Do NOT connect to destination — prevents echo
      vadSetup = "worklet";
    } catch {
      // AudioWorklet failed — use ScriptProcessor fallback
      try {
        const src = this.audioCtx.createMediaStreamSource(this.micStream);
        const proc = this.audioCtx.createScriptProcessor(2048, 1, 1);
        let env = 0;
        let lastSpeech = false;

        proc.onaudioprocess = (e) => {
          const buf = e.inputBuffer.getChannelData(0);
          let sum = 0;
          for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
          const rms = Math.sqrt(sum / buf.length);
          env += rms > env ? 0.4 * (rms - env) : 0.012 * (rms - env);
          const isSpeech = env > (lastSpeech ? 0.008 : 0.018);
          lastSpeech = isSpeech;
          // Throttle: only send ~every 32ms (matches worklet rate)
          if (Math.random() < 0.16) {
            this.ngZone.run(() =>
              this.onVADFrame({ rms, envelope: env, isSpeech }),
            );
          }
        };

        src.connect(proc);
        proc.connect(this.audioCtx.destination);
        this.scriptProc = proc;
        vadSetup = "script";
      } catch {
        vadSetup = "failed";
      }
    }

    if (vadSetup === "failed") {
      this.error.set("Audio processing unavailable in this browser.");
      this.micStream.getTracks().forEach((t) => t.stop());
      this.audioCtx.close();
      return;
    }

    // ── MediaRecorder — records ONE complete blob per turn ─────
    const mime =
      ["audio/webm;codecs=opus", "audio/webm", "audio/ogg"].find((t) =>
        MediaRecorder.isTypeSupported(t),
      ) ?? "";

    this.recorder = new MediaRecorder(
      this.micStream,
      mime ? { mimeType: mime } : {},
    );
    this.chunks = [];

    this.recorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };

    // onstop fires after commit() calls recorder.stop()
    // At this point chunks[] contains the COMPLETE turn audio
    this.recorder.onstop = () => {
      this.ngZone.run(() => this.processRecording());
    };

    // Collect every 200ms — smaller chunks = less data loss on stop
    this.recorder.start(200);

    // ── Reset state ────────────────────────────────────────────
    this.turnState = "waiting";
    this.hadSpeech = false;
    this.totalSpeechMs = 0;
    this.lastSpeechMs = 0;
    this.silenceStartMs = null;
    this.speechStartCandidate = null;
    this.lastStableSpeechMs = 0;
    this.turnStart = Date.now();

    this.isListening.set(true);
    this.phase.set("listening");
    this.transcript.set("Listening...");

    // Duration counter (UI only)
    this.durationInterval = setInterval(() => {
      this.ngZone.run(() => this.recordingMs.set(Date.now() - this.turnStart));
    }, 300);

    // Hard cap
    setTimeout(() => {
      if (this.isListening()) this.ngZone.run(() => this.scheduleCommit());
    }, this.MAX_TURN_MS);
  }

  // ─────────────────────────────────────────────────────────────
  // VAD FRAME HANDLER
  // Receives { rms, envelope, isSpeech } every ~32ms.
  // Drives the TurnState machine. NEVER modifies transcript
  // with actual speech content — that only happens after Whisper.
  // ─────────────────────────────────────────────────────────────

  private onVADFrame(data: {
    rms: number;
    envelope: number;
    isSpeech: boolean;
  }): void {
    if (this.turnState === "inactive" || this.turnState === "committing")
      return;

    const now = Date.now();

    // ── Speech stability debounce ──────────────────────────────
    // Require SPEECH_STABILITY_MS of continuous voice before
    // treating it as real speech (prevents noise/cough triggers)
    let confirmedSpeech = false;
    if (data.isSpeech) {
      if (!this.speechStartCandidate) this.speechStartCandidate = now;
      if (now - this.speechStartCandidate >= this.SPEECH_STABILITY_MS) {
        confirmedSpeech = true;
        this.lastStableSpeechMs = now;
      }
    } else {
      this.speechStartCandidate = null;
    }

    if (confirmedSpeech) {
      // ── Voice confirmed ──────────────────────────────────────
      this.silenceStartMs = null; // Reset silence clock

      if (!this.hadSpeech) this.hadSpeech = true;

      // Accumulate speech duration for momentum
      if (this.lastSpeechMs > 0) {
        const gap = now - this.lastSpeechMs;
        if (gap < 300) this.totalSpeechMs += gap;
      }
      this.lastSpeechMs = now;

      if (this.turnState !== "speaking") {
        this.turnState = "speaking";
        this.phase.set("user-speaking");
        // Show recording indicator — NOT "Recording your answer"
        // because that string was literally what Whisper was returning.
        // Use a neutral status that can't be confused with transcript text.
        this.transcript.set("🎙 Recording...");
      }
      return;
    }

    // ── Silence handling ───────────────────────────────────────
    if (!this.hadSpeech) return; // Haven't heard anything yet

    if (!this.silenceStartMs) this.silenceStartMs = now;
    const silenceDuration = now - this.silenceStartMs;

    // Momentum: longer speech = more patience
    const momentum =
      Math.floor(this.totalSpeechMs / 10000) * this.MOMENTUM_PER_10S;
    const commitAt = this.COMMIT_SILENCE_MS + momentum;

    if (silenceDuration >= commitAt) {
      this.scheduleCommit();
    } else if (silenceDuration >= this.PATIENCE_SILENCE_MS) {
      if (this.turnState !== "silence-long") {
        this.turnState = "silence-long";
        this.phase.set("filler-pause");
        this.transcript.set("Take your time...");
      }
    } else {
      if (this.turnState === "speaking") {
        this.turnState = "silence-short";
        // No UI change for a short breath — keeps experience smooth
      }
    }
  }

  // ─────────────────────────────────────────────────────────────
  // SCHEDULE COMMIT
  // Waits RESUME_GRACE_MS then checks if user resumed speaking.
  // If they did — cancel, go back to speaking state.
  // This prevents committing when user just takes a breath before
  // a final clause ("...and that's why — [breath] — I chose React")
  // ─────────────────────────────────────────────────────────────

  private scheduleCommit(): void {
    if (this.turnState === "committing") return;
    this.turnState = "committing";

    setTimeout(() => {
      const now = Date.now();
      // If user spoke within the grace period, un-commit
      if (now - this.lastStableSpeechMs < this.RESUME_GRACE_MS) {
        this.turnState = "speaking";
        this.silenceStartMs = null;
        return;
      }
      this.commit();
    }, this.RESUME_GRACE_MS);
  }

  private commit(): void {
    this.phase.set("processing");
    this.transcript.set("Processing your answer...");
    this.stopListening();
    // recorder.onstop → processRecording()
  }

  // ─────────────────────────────────────────────────────────────
  // STOP LISTENING
  // ─────────────────────────────────────────────────────────────

  stopListening(): void {
    if (this.durationInterval) {
      clearInterval(this.durationInterval);
      this.durationInterval = null;
    }

    this.isListening.set(false);

    if (this.recorder?.state !== "inactive") {
      this.recorder?.stop(); // triggers onstop → processRecording
    }

    this.workletNode?.disconnect();
    this.workletNode?.port.close();
    this.workletNode = null;

    this.scriptProc?.disconnect();
    this.scriptProc = null;

    this.micStream?.getTracks().forEach((t) => t.stop());
    this.micStream = null;

    this.audioCtx?.close().catch(() => {});
    this.audioCtx = null;
  }

  // ─────────────────────────────────────────────────────────────
  // PROCESS RECORDING
  // Called by recorder.onstop — has the COMPLETE audio blob.
  // Sends to Whisper once. Emits clean transcript.
  // ─────────────────────────────────────────────────────────────

  private async processRecording(): Promise<void> {
    const durationMs = Date.now() - this.turnStart;

    const prevState = this.turnState;
    this.turnState = "inactive";

    // Guard: nothing useful recorded
    if (
      !this.hadSpeech ||
      this.chunks.length === 0 ||
      durationMs < this.MIN_SPEECH_MS
    ) {
      this.phase.set("idle");
      this.transcript.set("");
      return;
    }

    const mime = this.recorder?.mimeType || "audio/webm";
    const blob = new Blob(this.chunks, { type: mime });
    this.chunks = [];

    if (blob.size < 2000) {
      this.phase.set("idle");
      this.transcript.set("");
      return;
    }

    try {
      this.transcript.set("Transcribing...");

      const text = await this.callWhisper(blob, mime);

      if (!text.trim()) {
        this.phase.set("idle");
        this.transcript.set("");
        return;
      }

      // Only NOW do we set transcript to actual speech content
      this.transcript.set(text);

      const analysis = this.buildAnalysis(text, durationMs);

      // Emit in order: analysis first (stores in interview service),
      // then transcript (triggers submitAnswer in component)
      this.analysisComplete$.next(analysis);
      this.transcriptComplete$.next(text);
    } catch (err: any) {
      this.error.set(
        err.message || "Transcription failed. Check your API key.",
      );
      this.phase.set("idle");
      this.transcript.set("");
    }
  }

  // ─────────────────────────────────────────────────────────────
  // WHISPER — sends complete audio blob, gets full transcript
  // ─────────────────────────────────────────────────────────────

  private async callWhisper(blob: Blob, mimeType: string): Promise<string> {
    if (!this.apiKey) {
      // Demo mode — simulate realistic delay
      await new Promise((r) => setTimeout(r, 800));
      return "[Demo mode — type your answer instead]";
    }

    const ext = mimeType.includes("ogg")
      ? "ogg"
      : mimeType.includes("mp4")
        ? "mp4"
        : "webm";

    const form = new FormData();
    form.append("file", blob, `answer.${ext}`);
    form.append("model", "whisper-1");
    form.append("language", "en");
    // Tell Whisper to preserve fillers and hesitations
    // so the AI can detect confidence from the transcript
    form.append(
      "prompt",
      "This is a job interview answer. " +
        "Transcribe exactly as spoken. " +
        "Preserve filler words: um, uh, like, you know, so, basically. " +
        'Mark clear hesitation pauses as "...". ' +
        "Do not correct grammar or clean up speech.",
    );

    const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: form,
    });

    if (!res.ok) {
      const e = (await res.json().catch(() => ({}))) as any;
      throw new Error(e?.error?.message || `Whisper API error ${res.status}`);
    }

    const data = (await res.json()) as { text: string };
    return data.text?.trim() ?? "";
  }

  // ─────────────────────────────────────────────────────────────
  // SPEECH ANALYSIS — confidence signals for GPT prompt
  // ─────────────────────────────────────────────────────────────

  private buildAnalysis(text: string, durationMs: number): SpeechAnalysis {
    const lower = text.toLowerCase();
    const fillerRx =
      /\b(um+|uh+|er+|ah+|hmm+|like|you know|i mean|basically|so so|right right)\b/g;
    const fillers = lower.match(fillerRx) || [];
    const pauses = (text.match(/\.\.\.|—|\[pause\]/g) || []).length;
    const words = text.split(/\s+/).filter(Boolean).length;
    const minutes = durationMs / 60000;
    const wpm = minutes > 0 ? Math.round(words / minutes) : 0;
    const ratio = fillers.length / Math.max(words, 1);

    const confidenceHint: SpeechAnalysis["confidenceHint"] =
      ratio > 0.12 || pauses >= 3 || (words < 8 && durationMs > 4000)
        ? "hesitant"
        : ratio < 0.04 && wpm >= 90 && wpm <= 180
          ? "confident"
          : "unclear";

    return {
      transcript: text,
      hasFillers: fillers.length > 0,
      fillerCount: fillers.length,
      pauseCount: pauses,
      confidenceHint,
      rawDurationMs: durationMs,
      wordsPerMinute: wpm,
    };
  }

  // ─────────────────────────────────────────────────────────────
  // TTS — OpenAI shimmer voice
  // ─────────────────────────────────────────────────────────────

  async speak(text: string, onEnd?: () => void): Promise<void> {
    this.stopSpeaking();
    // NEW: kill the mic the instant AI audio starts — VAD must not hear TTS output
    if (this.isListening()) {
      this.muteVAD(true);
      this.stopListening();
    }
    const clean = text
      .replace(/[*_`#]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!clean) {
      onEnd?.();
      return;
    }

    if (!this.apiKey) {
      this.browserTTS(clean, onEnd);
      return;
    }

    try {
      this.isSpeaking.set(true);
      this.phase.set("ai-speaking");

      const res = await fetch("https://api.openai.com/v1/audio/speech", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "tts-1",
          voice: "shimmer",
          input: clean,
          speed: 0.94,
        }),
      });

      if (!res.ok) throw new Error(`TTS error ${res.status}`);

      const url = URL.createObjectURL(await res.blob());
      this.ttsAudio = new Audio(url);

      this.ttsAudio.onended = () =>
        this.ngZone.run(() => {
          this.isSpeaking.set(false);
          this.phase.set("idle");
          URL.revokeObjectURL(url);
          onEnd?.();
        });

      this.ttsAudio.onerror = () =>
        this.ngZone.run(() => {
          this.isSpeaking.set(false);
          this.phase.set("idle");
          onEnd?.();
        });

      await this.ttsAudio.play();
    } catch (err: any) {
      console.error("TTS error, using browser fallback:", err.message);
      this.isSpeaking.set(false);
      this.browserTTS(clean, onEnd);
    }
  }

  stopSpeaking(): void {
    if (this.ttsAudio) {
      this.ttsAudio.pause();
      this.ttsAudio.src = "";
      this.ttsAudio = null;
    }
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    this.isSpeaking.set(false);
    this.muteVAD(false); // ← ADD: re-arm VAD after AI finishes
  }

  private browserTTS(text: string, onEnd?: () => void): void {
    if (!("speechSynthesis" in window)) {
      onEnd?.();
      return;
    }
    const utt = new SpeechSynthesisUtterance(text);
    const voices = window.speechSynthesis.getVoices();
    const voice =
      voices.find((v) => v.lang === "en-IN") ||
      voices.find((v) => v.name.toLowerCase().includes("india")) ||
      voices.find(
        (v) => v.lang.startsWith("en-US") && v.name.includes("Google"),
      ) ||
      voices.find((v) => v.lang.startsWith("en")) ||
      voices[0];
    if (voice) utt.voice = voice;
    utt.rate = 0.93;
    utt.pitch = 1.0;
    utt.volume = 1.0;
    utt.onstart = () =>
      this.ngZone.run(() => {
        this.isSpeaking.set(true);
        this.phase.set("ai-speaking");
      });
    utt.onend = () =>
      this.ngZone.run(() => {
        this.isSpeaking.set(false);
        this.phase.set("idle");
        onEnd?.();
      });
    utt.onerror = () =>
      this.ngZone.run(() => {
        this.isSpeaking.set(false);
        this.phase.set("idle");
        onEnd?.();
      });
    window.speechSynthesis.speak(utt);
  }

  destroy(): void {
    this.stopListening();
    this.stopSpeaking();
    this.transcriptComplete$.complete();
    this.analysisComplete$.complete();
  }
}
