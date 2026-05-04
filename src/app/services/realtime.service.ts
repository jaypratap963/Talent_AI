// ─────────────────────────────────────────────────────────────────
// services/realtime.service.ts
//
// Manages the full OpenAI Realtime pipeline via your Node backend.
//
// AUDIO IN (mic → OpenAI):
//   getUserMedia → AudioContext (24kHz) → ScriptProcessor
//   → PCM16 conversion → WebSocket.send(binary)
//   OpenAI's server_vad handles ALL start/stop detection.
//   No timers. No volume thresholds. No guessing.
//
// AUDIO OUT (OpenAI → speaker):
//   WebSocket receives base64 PCM16 chunks
//   → decode → AudioContext buffer → schedule for playback
//   Chunks are queued and played gaplessly using AudioContext time.
//
// EVENTS EMITTED (Angular signals + RxJS subjects):
//   phase signal        → drives avatar animation
//   userTranscript$     → what user said (after VAD commits)
//   responseText$       → Alex's full response text (for chat history)
//   responseTextDelta$  → streaming tokens (for live text display)
// ─────────────────────────────────────────────────────────────────

import { Injectable, signal, NgZone } from "@angular/core";
import { Subject } from "rxjs";

export type RealtimePhase =
  | "idle"
  | "connecting"
  | "ready" // connected, waiting for user
  | "user-speaking" // VAD detected speech
  | "user-done" // VAD detected end of speech
  | "processing" // OpenAI processing the audio
  | "alex-speaking" // Alex's audio is playing
  | "error";

@Injectable({ providedIn: "root" })
export class RealtimeService {
  // ── Public signals (drive UI) ─────────────────────────────────
  phase = signal<RealtimePhase>("idle");
  isConnected = signal(false);
  isMicActive = signal(false);
  isSpeaking = signal(false); // Alex is speaking
  userTranscript = signal(""); // live transcript of user speech
  alexText = signal(""); // streaming Alex response text
  error = signal<string | null>(null);

  // ── Output subjects ───────────────────────────────────────────
  // userTranscript$ — fires once per complete user turn
  userTranscript$ = new Subject<string>();
  // responseText$ — fires once Alex's full response is ready
  responseText$ = new Subject<string>();
  // responseTextDelta$ — fires per token for streaming display
  responseTextDelta$ = new Subject<string>();
  // sessionReady$ — fires when OpenAI session is configured
  sessionReady$ = new Subject<void>();

  // ── Private ───────────────────────────────────────────────────
  private ws: WebSocket | null = null;
  private backendUrl = "ws://localhost:3001";

  // Mic / audio input
  private audioCtx: AudioContext | null = null;
  private micStream: MediaStream | null = null;
  private scriptProc: ScriptProcessorNode | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;

  // Audio output — plays Alex's voice gaplessly
  private playCtx: AudioContext | null = null;
  private playNextAt = 0;
  private activeBuffers = 0; // buffers scheduled but not finished
  private audioStreamDone = false; // true after response_audio_done
  // Mic gate: while true, zero bytes are sent to OpenAI.
  // Prevents Alex's speaker output triggering server_vad as user speech.
  private micSuspended = false;

  // Accumulated response text for current turn
  private currentResponseText = "";

  constructor(private ngZone: NgZone) {}

  // ─────────────────────────────────────────────────────────────
  // CONNECT TO BACKEND
  // Sends resume context so backend can configure OpenAI session.
  // ─────────────────────────────────────────────────────────────

  async connect(resumeText: string, skills: string): Promise<void> {
    if (this.isConnected()) return;

    this.phase.set("connecting");
    this.error.set(null);

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.backendUrl);
      this.ws.binaryType = "arraybuffer";

      const timeout = setTimeout(() => {
        reject(new Error("Connection timeout. Is the backend running?"));
        this.ws?.close();
      }, 8000);

      this.ws.onopen = () => {
        clearTimeout(timeout);

        // Send resume context — backend uses this for the system prompt
        this.ws!.send(
          JSON.stringify({
            type: "init",
            resumeText: resumeText,
            skills: skills,
            questionCount: 0,
          }),
        );
      };

      this.ws.onmessage = (event) => {
        this.ngZone.run(() => this.handleServerEvent(event.data));
      };

      this.ws.onerror = (e) => {
        clearTimeout(timeout);
        this.ngZone.run(() => {
          this.error.set(
            "Cannot connect to backend. Run: cd backend && node server.js",
          );
          this.phase.set("error");
        });
        reject(new Error("WebSocket connection failed"));
      };

      this.ws.onclose = () => {
        this.ngZone.run(() => {
          this.isConnected.set(false);
          this.isMicActive.set(false);
          if (this.phase() !== "idle") {
            this.phase.set("idle");
          }
        });
      };

      // Wait for 'ready' event before resolving
      const sub = this.sessionReady$.subscribe(() => {
        sub.unsubscribe();
        resolve();
      });
    });
  }

  // ─────────────────────────────────────────────────────────────
  // HANDLE SERVER EVENTS
  // All messages from backend → OpenAI events flow through here.
  // ─────────────────────────────────────────────────────────────

  private handleServerEvent(raw: string): void {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    switch (msg.type) {
      // ── Session ready ───────────────────────────────────────
      case "ready":
        this.isConnected.set(true);
        this.phase.set("ready");
        this.sessionReady$.next();
        break;

      case "user_speech_start":
        // If mic is suspended Alex is still playing — ignore bleed-through.
        if (this.micSuspended) break;
        // DO NOT stop Alex's audio here. user_speech_start fires the instant
        // VAD hears any sound — a breath, a filler, even room noise.
        // We only act on committed audio (user_audio_committed below).
        this.phase.set("user-speaking");
        this.userTranscript.set("");
        break;

      case "user_speech_stop":
        if (this.micSuspended) break;
        this.phase.set("user-done");
        break;

      case 'user_audio_committed':
  if (this.micSuspended) break;
  // NOW stop Alex if somehow still playing — user has actually finished
  // a real utterance (VAD confirmed full speech + silence window).
  this.stopAlexAudio();
  this.phase.set('processing');
  break;

      // ── Transcript of what user said ────────────────────────
      case "user_transcript":
        // Discard if mic was suspended — this is Alex's own voice
        // that leaked into the mic and was transcribed as user input.
        if (this.micSuspended) break;
        const transcript = msg.transcript?.trim() ?? "";
        if (transcript) {
          this.userTranscript.set(transcript);
          this.userTranscript$.next(transcript);
        }
        break;

      // ── Alex's response is being generated ─────────────────
      case "response_started":
        this.currentResponseText = "";
        this.alexText.set("");
        this.audioStreamDone = false;
        this.activeBuffers = 0;
        this.micSuspended = true; // stop mic BEFORE first audio chunk
        this.phase.set("processing");
        break;

      // ── Streaming text token from Alex ──────────────────────
      case "response_text_delta":
        this.currentResponseText += msg.delta;
        this.alexText.set(this.currentResponseText);
        this.responseTextDelta$.next(msg.delta);
        break;

      // ── Alex's full text response complete ──────────────────
      case "response_text_done":
        this.currentResponseText = msg.text || this.currentResponseText;
        this.alexText.set(this.currentResponseText);
        this.responseText$.next(this.currentResponseText);
        break;

      // ── Alex's audio chunk (PCM16 base64) ──────────────────
      // This fires ~30 times per second while Alex speaks
      // We decode and queue each chunk for gapless playback
      case "response_audio_delta":
        this.playAudioChunk(msg.delta);
        break;

      // ── Alex's audio stream complete ────────────────────────
      case "response_audio_done":
        this.audioStreamDone = true;
        // If all buffers already finished before this event arrived, finish now
        if (this.activeBuffers === 0) {
          this.onAlexFinished();
        }
        break;

      // ── Full response complete ───────────────────────────────
      case "response_done":
        // Phase transitions to ready after audio finishes
        // (handled in schedulePlayback via isPlaying flag)
        break;

      // ── Error ───────────────────────────────────────────────
      case "error":
        this.error.set(msg.message || "Realtime API error");
        this.phase.set("error");
        break;

      case "disconnected":
        this.isConnected.set(false);
        this.phase.set("idle");
        break;
    }
  }

  // ─────────────────────────────────────────────────────────────
  // START MIC
  // Opens mic → converts to PCM16 @ 24kHz → streams to backend.
  // PCM16 is what OpenAI Realtime expects.
  // ─────────────────────────────────────────────────────────────

  async startMic(): Promise<void> {
    if (this.isMicActive()) return;

    try {
      this.micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          // 24kHz matches OpenAI Realtime input format
          sampleRate: 24000,
          channelCount: 1,
        },
      });
    } catch {
      this.error.set("Microphone permission denied.");
      return;
    }

    // AudioContext at 24kHz for PCM16 conversion
    this.audioCtx = new AudioContext({ sampleRate: 24000 });
    this.sourceNode = this.audioCtx.createMediaStreamSource(this.micStream);

    // ScriptProcessor: reads raw float32 samples, converts to PCM16 int16
    // Buffer size 4096 = ~170ms chunks at 24kHz (good balance of latency vs overhead)
    this.scriptProc = this.audioCtx.createScriptProcessor(4096, 1, 1);

    this.scriptProc.onaudioprocess = (e) => {
      // THE CORE FIX: while Alex is speaking, send nothing to OpenAI.
      // Without this, Alex's speaker output bleeds into the mic,
      // OpenAI's VAD commits it as user speech, and the transcript
      // triggers a new response that cuts Alex off mid-sentence.
      if (this.micSuspended) return;
      if (!this.isConnected() || this.ws?.readyState !== WebSocket.OPEN) return;

      const float32 = e.inputBuffer.getChannelData(0);
      const pcm16 = this.float32ToPCM16(float32);

      // Send as binary — backend detects binary and forwards as audio
      this.ws!.send(pcm16.buffer);
    };

    this.sourceNode.connect(this.scriptProc);
    // Connect to destination with zero volume — required for onaudioprocess to fire
    // (Chrome won't run the processor if output isn't connected)
    this.scriptProc.connect(this.audioCtx.destination);

    this.isMicActive.set(true);
  }

  stopMic(): void {
    this.scriptProc?.disconnect();
    this.sourceNode?.disconnect();
    this.scriptProc = null;
    this.sourceNode = null;

    this.micStream?.getTracks().forEach((t) => t.stop());
    this.micStream = null;

    this.audioCtx?.close().catch(() => {});
    this.audioCtx = null;

    this.isMicActive.set(false);
  }

  // ─────────────────────────────────────────────────────────────
  // FLOAT32 → PCM16 CONVERSION
  // OpenAI Realtime expects 16-bit signed integer PCM.
  // Web Audio API gives us float32 in range -1.0 to 1.0.
  // ─────────────────────────────────────────────────────────────

  private float32ToPCM16(float32: Float32Array): Int16Array {
    const int16 = new Int16Array(float32.length);
    for (let i = 0; i < float32.length; i++) {
      // Clamp to -1..1, scale to int16 range
      const clamped = Math.max(-1, Math.min(1, float32[i]));
      int16[i] =
        clamped < 0
          ? clamped * 32768 // negative: multiply by 32768
          : clamped * 32767; // positive: multiply by 32767 (avoid overflow)
    }
    return int16;
  }

  // ─────────────────────────────────────────────────────────────
  // PLAY AUDIO CHUNK — gapless PCM16 playback
  //
  // OpenAI streams PCM16 audio as base64 chunks.
  // We decode each chunk and schedule it precisely on the
  // AudioContext timeline so chunks play back-to-back with
  // zero gap and no dropouts.
  // ─────────────────────────────────────────────────────────────

  private playAudioChunk(base64: string): void {
    if (!base64) return;

    if (!this.playCtx) {
      this.playCtx = new AudioContext({ sampleRate: 24000 });
      this.playNextAt = this.playCtx.currentTime;
    }

    // Synchronous decode — NO async/await here.
    // async causes microtask delays between chunks which lets
    // AudioContext.currentTime drift past playNextAt, creating
    // audible gaps (the "stuttering mid-sentence" bug).
    const binary = atob(base64);
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);

    const int16 = new Int16Array(bytes.buffer);
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 32768;

    const buffer = this.playCtx.createBuffer(1, float32.length, 24000);
    buffer.copyToChannel(float32, 0);

    const source = this.playCtx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.playCtx.destination);

    const startAt = Math.max(this.playNextAt, this.playCtx.currentTime);
    source.start(startAt);
    this.playNextAt = startAt + buffer.duration;

    this.activeBuffers++;

    // Update Angular signals only on the FIRST chunk of each turn.
    // Calling ngZone.run() on every chunk triggers change detection
    // (~10ms each) which causes the same currentTime drift / gap bug.
    if (!this.isSpeaking()) {
      this.ngZone.run(() => {
        this.isSpeaking.set(true);
        this.phase.set("alex-speaking");
      });
    }

    source.onended = () => {
      this.activeBuffers--;
      // Declare Alex done only when:
      // 1. OpenAI confirmed all chunks sent (audioStreamDone)
      // 2. Every scheduled buffer has finished playing (activeBuffers === 0)
      if (this.audioStreamDone && this.activeBuffers === 0) {
        this.onAlexFinished();
      }
    };
  }

  // Called exactly once when all of Alex's audio has finished playing.
  private onAlexFinished(): void {
    this.micSuspended = false; // resume mic — user can now speak
    this.audioStreamDone = false;
    this.activeBuffers = 0;
    this.ngZone.run(() => {
      this.isSpeaking.set(false);
      this.phase.set("ready");
    });
  }

  private stopAlexAudio(): void {
    if (this.playCtx) {
      this.playCtx.close().catch(() => {});
      this.playCtx = null;
      this.playNextAt = 0;
    }
    this.activeBuffers = 0;
    this.audioStreamDone = false;
    this.micSuspended = false;
    this.isSpeaking.set(false);
  }

  // ─────────────────────────────────────────────────────────────
  // MANUAL STOP (user presses stop button)
  // Commits whatever audio is in the buffer, forcing transcription.
  // ─────────────────────────────────────────────────────────────

  manualCommit(): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "commit_audio" }));
    }
  }

  // ─────────────────────────────────────────────────────────────
  // UPDATE QUESTION COUNT
  // Sent to backend after each answer so the system prompt
  // adapts ("You have 7 questions remaining")
  // ─────────────────────────────────────────────────────────────

  updateQuestionCount(count: number): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(
        JSON.stringify({
          type: "update_session",
          questionCount: count,
        }),
      );
    }
  }

  // ─────────────────────────────────────────────────────────────
  // DISCONNECT
  // ─────────────────────────────────────────────────────────────

  disconnect(): void {
    this.stopMic();
    this.stopAlexAudio();
    this.ws?.close();
    this.ws = null;
    this.isConnected.set(false);
    this.isMicActive.set(false);
    this.isSpeaking.set(false);
    this.phase.set("idle");
  }
}
