// ─────────────────────────────────────────────────────────────────
// services/speech.service.ts
//
// VAD ARCHITECTURE:
//
//   Mic → AudioWorklet (vad-processor.js) — audio thread
//              │  postMessage every ~32ms
//              ▼
//   Main thread receives { rms, envelope, isSpeech }
//              │
//   SilenceTracker — accumulates REAL silence duration
//   using envelope follower output (not a timer that resets
//   on any sound — only resets on actual confirmed speech)
//              │
//   3-tier decision:
//     envelope still high  → breath/thinking, ignore
//     envelope low < 1.8s  → short pause, wait
//     envelope low ≥ 2.5s  → committed, send to Whisper
//              │
//   MediaRecorder captured full audio turn
//              │
//   Whisper API → raw transcript with fillers
//              │
//   buildAnalysis() → SpeechAnalysis
//              │
//   transcriptComplete$ + analysisComplete$
//
// TTS: OpenAI shimmer voice → Audio element
//      Fallback: browser speechSynthesis
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

// Internal state — tighter than the public SpeechPhase
type TurnState =
  | "inactive" // mic not open
  | "waiting" // mic open, no speech yet
  | "speaking" // speech detected, recording
  | "silence-short" // silence < COMMIT_MS, still within patience window
  | "silence-long" // silence >= PATIENCE_MS, showing "take your time"
  | "committing"; // sending to Whisper

@Injectable({ providedIn: "root" })
export class SpeechService {
  // ── Public signals ────────────────────────────────────────────
  phase = signal<SpeechPhase>("idle");
  isListening = signal(false);
  isSpeaking = signal(false);
  transcript = signal("");
  recordingMs = signal(0);
  error = signal<string | null>(null);

  transcriptComplete$ = new Subject<string>();
  analysisComplete$ = new Subject<SpeechAnalysis>();

  readonly sttSupported = !!navigator.mediaDevices?.getUserMedia;
  readonly ttsSupported = true;

  // ── Private state ─────────────────────────────────────────────
  private turnState: TurnState = "inactive";

  // AudioWorklet pipeline
  private audioCtx: AudioContext | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private micStream: MediaStream | null = null;

  // MediaRecorder
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private turnStart = 0;

  // Silence tracking — uses wall clock, updated by worklet messages
  // This is the key: silenceStartMs is only set when envelope is LOW
  // It resets immediately when envelope rises again (voice resumed)
  private silenceStartMs: number | null = null;
  private hadSpeech = false; // at least one speech frame this turn
  private totalSpeechMs = 0; // total ms of speech (for momentum)
  private lastSpeechMs = 0; // timestamp of last speech frame

  // UI counter
  private durationInterval: ReturnType<typeof setInterval> | null = null;

  // ── Timing constants ──────────────────────────────────────────
  //
  // The most important numbers in the whole system.
  // Tune COMMIT_SILENCE_MS if it still cuts off too early.
  //
  private readonly MIN_SPEECH_MS = 400;
  private readonly PATIENCE_SILENCE_MS = 1500;
  private readonly COMMIT_SILENCE_MS = 3000; // increased
  private readonly MOMENTUM_PER_10S = 600;
  private readonly MAX_TURN_MS = 120000;

  // ── NEW: speech stability + smart commit ──────────────────────
  private speechStartCandidate: number | null = null;
  private lastStableSpeechMs: number = 0;

  private readonly SPEECH_STABILITY_MS = 120; // ignore noise spikes
  private readonly RESUME_GRACE_MS = 700; // wait before final commit

  private apiKey = "";
  private ttsAudio: HTMLAudioElement | null = null;

  constructor(private ngZone: NgZone) {}

  setApiKey(k: string): void {
    this.apiKey = k.trim();
  }

  // ─────────────────────────────────────────────────────────────
  // START LISTENING
  // ─────────────────────────────────────────────────────────────

  async startListening(): Promise<void> {
    if (this.isListening()) return;

    this.error.set(null);
    this.transcript.set("");
    this.recordingMs.set(0);

    // ── 1. Mic ────────────────────────────────────────────────
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
      this.error.set("Microphone permission denied. Please allow access.");
      return;
    }

    // ── 2. AudioContext + Worklet ─────────────────────────────
    this.audioCtx = new AudioContext({ sampleRate: 16000 });

    try {
      // Load our VAD processor from assets
      await this.audioCtx.audioWorklet.addModule("/assets/vad-processor.js");
    } catch (e) {
      // If worklet fails (e.g. HTTP serving issue), fall back to ScriptProcessor
      console.warn("AudioWorklet failed, using ScriptProcessor fallback", e);
      this.startWithScriptProcessor();
      return;
    }

    this.workletNode = new AudioWorkletNode(this.audioCtx, "vad-processor");

    // This is the hot path — called every ~32ms from audio thread
    this.workletNode.port.onmessage = (e) => {
      // Run inside ngZone so signals update properly
      this.ngZone.run(() => this.onVADFrame(e.data));
    };

    const src = this.audioCtx.createMediaStreamSource(this.micStream);
    src.connect(this.workletNode);
    // Do NOT connect workletNode to destination — no echo

    // ── 3. MediaRecorder ─────────────────────────────────────
    this.setupRecorder();

    // ── 4. Reset turn state ───────────────────────────────────
    this.turnState = "waiting";
    this.hadSpeech = false;
    this.totalSpeechMs = 0;
    this.lastSpeechMs = 0;
    this.silenceStartMs = null;
    this.turnStart = Date.now();

    this.isListening.set(true);
    this.phase.set("listening");
    this.transcript.set("Listening...");

    // ── 5. Duration counter ───────────────────────────────────
    this.durationInterval = setInterval(() => {
      this.ngZone.run(() => this.recordingMs.set(Date.now() - this.turnStart));
    }, 300);

    // ── 6. Hard cap ───────────────────────────────────────────
    setTimeout(() => {
      if (this.isListening()) this.ngZone.run(() => this.commit());
    }, this.MAX_TURN_MS);
  }

  private setupRecorder(): void {
    const mime =
      ["audio/webm;codecs=opus", "audio/webm", "audio/ogg"].find((t) =>
        MediaRecorder.isTypeSupported(t),
      ) ?? "";

    this.recorder = new MediaRecorder(
      this.micStream!,
      mime ? { mimeType: mime } : {},
    );
    this.chunks = [];

    this.recorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };

    this.recorder.onstop = () => {
      this.ngZone.run(() => this.processRecording());
    };

    this.recorder.start(150); // Collect every 150ms
  }

  // ─────────────────────────────────────────────────────────────
  // VAD FRAME HANDLER
  // Called every ~32ms with envelope data from audio worklet.
  // This is where ALL timing decisions happen.
  // ─────────────────────────────────────────────────────────────

  private onVADFrame(data: {
    rms: number;
    envelope: number;
    isSpeech: boolean;
  }): void {
    if (this.turnState === "inactive" || this.turnState === "committing")
      return;

    const now = Date.now();

    // ─────────────────────────────────────────────
    // STEP 1: STABILIZE SPEECH (ANTI-NOISE)
    // ─────────────────────────────────────────────
    let stableSpeech = false;

    if (data.isSpeech) {
      if (!this.speechStartCandidate) {
        this.speechStartCandidate = now;
      }

      if (now - this.speechStartCandidate >= this.SPEECH_STABILITY_MS) {
        stableSpeech = true;
        this.lastStableSpeechMs = now;
      }
    } else {
      this.speechStartCandidate = null;
    }

    // ─────────────────────────────────────────────
    // STEP 2: SPEECH DETECTED
    // ─────────────────────────────────────────────
    if (stableSpeech) {
      this.silenceStartMs = null;

      if (!this.hadSpeech) {
        this.hadSpeech = true;
      }

      if (this.lastSpeechMs > 0) {
        const gap = now - this.lastSpeechMs;
        if (gap < 200) this.totalSpeechMs += gap;
      }

      this.lastSpeechMs = now;

      if (this.turnState !== "speaking") {
        this.turnState = "speaking";
        this.phase.set("user-speaking");
        this.transcript.set("Recording your answer...");
      }

      return;
    }

    // ─────────────────────────────────────────────
    // STEP 3: HANDLE SILENCE
    // ─────────────────────────────────────────────
    if (!this.hadSpeech) return;

    if (!this.silenceStartMs) {
      this.silenceStartMs = now;
    }

    const silenceDuration = now - this.silenceStartMs;

    // ── Dynamic threshold (momentum)
    const momentum =
      Math.floor(this.totalSpeechMs / 10000) * this.MOMENTUM_PER_10S;
    const commitAt = this.COMMIT_SILENCE_MS + momentum;
    const patienceAt = this.PATIENCE_SILENCE_MS;

    // ─────────────────────────────────────────────
    // STEP 4: SMART END DETECTION
    // ─────────────────────────────────────────────
    const speechGap = now - this.lastStableSpeechMs;

    const isLikelyEnd =
      speechGap > 1200 && // user stopped speaking
      this.totalSpeechMs > 1500 && // not a short answer
      silenceDuration > 1200;

    // ─────────────────────────────────────────────
    // STEP 5: DECISION
    // ─────────────────────────────────────────────

    if (silenceDuration >= commitAt || isLikelyEnd) {
      this.scheduleCommit(); // ⬅️ IMPORTANT (not direct commit)
    } else if (silenceDuration >= patienceAt) {
      if (this.turnState !== "silence-long") {
        this.turnState = "silence-long";
        this.phase.set("filler-pause");
        this.transcript.set("Take your time...");
      }
    } else {
      if (this.turnState === "speaking") {
        this.turnState = "silence-short";
      }
    }
  }

  private scheduleCommit(): void {
    if (this.turnState === "committing") return;

    this.turnState = "committing";

    setTimeout(() => {
      const now = Date.now();

      // If user resumed speaking, cancel commit
      if (now - this.lastStableSpeechMs < this.RESUME_GRACE_MS) {
        this.turnState = "speaking";
        return;
      }

      this.commit();
    }, this.RESUME_GRACE_MS);
  }

  // ─────────────────────────────────────────────────────────────
  // COMMIT — stop recording, hand off to Whisper
  // ─────────────────────────────────────────────────────────────

  private commit(): void {
    if (this.turnState === "committing" || this.turnState === "inactive")
      return;

    this.turnState = "committing";
    this.phase.set("processing");
    this.transcript.set("Processing...");

    this.stopListening();
    // recorder.onstop → processRecording() is called automatically
  }

  // ─────────────────────────────────────────────────────────────
  // STOP LISTENING — tears down audio pipeline
  // ─────────────────────────────────────────────────────────────

  stopListening(): void {
    if (this.durationInterval) {
      clearInterval(this.durationInterval);
      this.durationInterval = null;
    }

    this.isListening.set(false);

    // Stop recorder — triggers onstop → processRecording()
    if (this.recorder?.state !== "inactive") {
      this.recorder?.stop();
    }

    // Disconnect worklet
    this.workletNode?.disconnect();
    this.workletNode?.port.close();
    this.workletNode = null;

    // Stop mic tracks
    this.micStream?.getTracks().forEach((t) => t.stop());
    this.micStream = null;

    // Close audio context
    this.audioCtx?.close().catch(() => {});
    this.audioCtx = null;
  }

  // ─────────────────────────────────────────────────────────────
  // PROCESS RECORDING — upload to Whisper
  // ─────────────────────────────────────────────────────────────

  private async processRecording(): Promise<void> {
    const durationMs = Date.now() - this.turnStart;

    // Guards
    if (
      !this.hadSpeech ||
      this.chunks.length === 0 ||
      durationMs < this.MIN_SPEECH_MS
    ) {
      this.phase.set("idle");
      this.transcript.set("");
      this.turnState = "inactive";
      return;
    }

    const mime = this.recorder?.mimeType || "audio/webm";
    const blob = new Blob(this.chunks, { type: mime });
    this.chunks = [];
    this.turnState = "inactive";

    if (blob.size < 1500) {
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

      const analysis = this.buildAnalysis(text, durationMs);

      this.transcript.set(text);
      this.transcriptComplete$.next(text);
      this.analysisComplete$.next(analysis);
    } catch (err: any) {
      this.error.set(err.message || "Transcription failed");
      this.phase.set("idle");
      this.transcript.set("");
    }
  }

  // ─────────────────────────────────────────────────────────────
  // WHISPER
  // ─────────────────────────────────────────────────────────────

  private async callWhisper(blob: Blob, mimeType: string): Promise<string> {
    if (!this.apiKey) {
      await new Promise((r) => setTimeout(r, 600));
      return "[Demo — audio not transcribed]";
    }

    const ext = mimeType.includes("ogg")
      ? "ogg"
      : mimeType.includes("mp4")
        ? "mp4"
        : "webm";
    const form = new FormData();
    form.append("file", blob, `speech.${ext}`);
    form.append("model", "whisper-1");
    form.append("language", "en");
    form.append(
      "prompt",
      "Transcribe this job interview answer exactly as spoken. " +
        "Preserve all filler words: um, uh, like, you know, so, basically. " +
        'Mark clear hesitation pauses with "...". Do not clean up or correct.',
    );

    const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: form,
    });

    if (!res.ok) {
      const e = (await res.json().catch(() => ({}))) as any;
      throw new Error(e?.error?.message || `Whisper ${res.status}`);
    }

    const data = (await res.json()) as { text: string };
    return data.text?.trim() ?? "";
  }

  // ─────────────────────────────────────────────────────────────
  // SPEECH ANALYSIS
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

      if (!res.ok) throw new Error(`TTS ${res.status}`);

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
      console.error("TTS error:", err.message);
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

  // ─────────────────────────────────────────────────────────────
  // SCRIPTPROCESSOR FALLBACK (Safari / worklet load failure)
  // ─────────────────────────────────────────────────────────────

  private startWithScriptProcessor(): void {
    if (!this.audioCtx || !this.micStream) return;

    // ScriptProcessor is deprecated but works everywhere
    const bufferSize = 2048;
    const processor = this.audioCtx.createScriptProcessor(bufferSize, 1, 1);
    const src = this.audioCtx.createMediaStreamSource(this.micStream);

    let envelope = 0;
    let isSpeech = false;

    processor.onaudioprocess = (e) => {
      const samples = e.inputBuffer.getChannelData(0);
      let sum = 0;
      for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
      const rms = Math.sqrt(sum / samples.length);

      envelope +=
        rms > envelope ? 0.4 * (rms - envelope) : 0.012 * (rms - envelope);

      const wasS = isSpeech;
      if (!isSpeech && envelope > 0.018) isSpeech = true;
      if (isSpeech && envelope < 0.008) isSpeech = false;

      if (isSpeech !== wasS || Math.random() < 0.1) {
        this.ngZone.run(() => this.onVADFrame({ rms, envelope, isSpeech }));
      }
    };

    src.connect(processor);
    processor.connect(this.audioCtx.destination);
    this.setupRecorder();

    this.turnState = "waiting";
    this.hadSpeech = false;
    this.totalSpeechMs = 0;
    this.lastSpeechMs = 0;
    this.silenceStartMs = null;
    this.turnStart = Date.now();

    this.isListening.set(true);
    this.phase.set("listening");
    this.transcript.set("Listening...");

    this.durationInterval = setInterval(() => {
      this.ngZone.run(() => this.recordingMs.set(Date.now() - this.turnStart));
    }, 300);
  }

  destroy(): void {
    this.stopListening();
    this.stopSpeaking();
    this.transcriptComplete$.complete();
    this.analysisComplete$.complete();
  }
}
