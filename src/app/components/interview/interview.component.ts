import {
  Component,
  OnInit,
  OnDestroy,
  inject,
  signal,
  computed,
  ElementRef,
  AfterViewInit,
  ViewChild,
  NgZone,
} from "@angular/core";
import { CommonModule } from "@angular/common";
import { FormsModule } from "@angular/forms";
import { Subscription } from "rxjs";

import { InterviewService } from "../../services/interview.service";
import { RealtimeService } from "../../services/realtime.service";
import { SpeechService } from "../../services/speech.service";
import { AiService } from "../../services/ai.service";
import { ChatWindowComponent } from "../chat-window/chat-window.component";

@Component({
  selector: "app-interview",
  standalone: true,
  imports: [CommonModule, FormsModule, ChatWindowComponent],
  templateUrl: "./interview.component.html",
  styleUrls: ["./interview.component.scss"],
})
export class InterviewComponent implements OnInit, OnDestroy {
  interview = inject(InterviewService);
  realtime = inject(RealtimeService);
  speech = inject(SpeechService);
  ai = inject(AiService);

  // ── UI state ──────────────────────────────────
  textInput = signal("");
  demoMode = signal(false);
  showEvaluation = signal(false);
  isStarted = signal(false);
  showTextInput = signal(false);
  isConnecting = signal(false);
  @ViewChild("simliVideo") simliVideoRef!: ElementRef<HTMLVideoElement>;
  private ngZone = inject(NgZone);

  showPlayback = signal(false);
  confidenceTurns = computed(() => this.interview.confidenceTurns());
  annotations = computed(() => this.interview.annotations());
  annotationsLoading = computed(() => this.interview.annotationsLoading());

  avgConfidence = computed(() => {
    const turns = this.confidenceTurns();
    if (!turns.length) return 0;
    return Math.round(turns.reduce((s, t) => s + t.score, 0) / turns.length);
  });

  // ── Derived from interview service ────────────
  messages = computed(() => this.interview.chatHistory());
  isActive = computed(() => this.interview.isActive());
  isCompleted = computed(() => this.interview.isCompleted());
  isLoading = computed(() => this.ai.isLoading());
  isTyping = computed(() => this.interview.isTyping());
  evaluation = computed(() => this.interview.session().evaluation);
  questionNum = computed(() => this.interview.questionCount());
  currentQ = computed(() => this.interview.session().currentQuestion);

  // ── Derived from realtime service ─────────────
  phase = computed(() => this.realtime.phase());
  isSpeaking = computed(() => this.realtime.isSpeaking());
  // isListening = mic is active (replaces old speech.isListening signal)
  isListening = computed(() => this.realtime.isMicActive());
  // liveText = what VAD is showing / user transcript
  liveText = computed(() => this.realtime.userTranscript());
  // sttSupported = mic API available
  readonly sttSupported = !!navigator.mediaDevices?.getUserMedia;

  // ── Avatar status label ───────────────────────
  statusLabel = computed<string>(() => {
    if (!this.isStarted()) return "";
    if (this.isConnecting()) return "Connecting to Madeline...";
    switch (this.phase()) {
      case "connecting":
        return "Setting up interview...";
      case "ready":
        return this.realtime.madelineHasSpokeYet()
          ? "Your turn to speak"
          : "Please wait! Starting the interview...";
      case "user-speaking":
        return "I'm listening...";
      case "user-done":
        return "Processing...";
      case "processing":
        return "Madeline is thinking...";
      case "madeline-speaking":
        return "Madeline is speaking...";
      case "error":
        return this.realtime.error() || "Connection error";
      default:
        return this.isActive() ? "Your turn to speak" : "";
    }
  });

  // ── Avatar animation class ────────────────────
  avatarState = computed<string>(() => {
    if (this.isConnecting() || this.phase() === "connecting") return "thinking";
    switch (this.phase()) {
      case "user-speaking":
        return "listening";
      case "user-done":
      case "processing":
        return "thinking";
      case "madeline-speaking":
        return "speaking";
      default:
        // Demo / non-realtime fallback
        if (this.isTyping() || this.isLoading()) return "thinking";
        if (this.speech.isSpeaking()) return "speaking";
        if (this.speech.phase() === "user-speaking") return "listening";
        return "idle";
    }
  });

  private subs = new Subscription();

  ngOnInit(): void {
    this.demoMode.set(false);

    // ── Realtime mode subscriptions ───────────────
    // 1. User transcript → store in chat history
    // this.subs.add(
    //   this.realtime.userTranscript$.subscribe((transcript) => {
    //     this.interview.addUserMessage(transcript);
    //   }),
    // );

    // 2. Madeline's response text → store in chat history
    this.subs.add(
      this.realtime.responseText$.subscribe((text) => {
        this.interview.addMadelineMessage(text);
        this.realtime.updateQuestionCount(this.interview.questionCount());
      }),
    );

    // Natural interview end — triggered by Madeline's INTERVIEW_COMPLETE signal
    this.subs.add(
      this.realtime.interviewComplete$.subscribe(() => {
        setTimeout(() => this.endInterview(), 300);
      }),
    );

    // ── Demo / non-realtime mode subscription ─────
    // 3. Old-style STT transcript (demo mode only)
    this.subs.add(
      this.speech.transcriptComplete$.subscribe((text) => {
        if (!this.demoMode()) return; // Only handle in demo mode
        this.textInput.set(text);
        this.submitAnswer();
      }),
    );

    // Track when Madeline finishes for confidence pause timing
    this.subs.add(
      this.realtime.madelineFinished$.subscribe(() => {
        this.interview.markMadelineFinished(this.currentQ());
      }),
    );

    // Record confidence when user speaks
    this.subs.add(
      this.realtime.userTranscript$.subscribe((transcript) => {
        this.interview.addUserMessage(transcript);
        this.interview.recordConfidenceTurn(transcript); // ADD THIS
      }),
    );

    // Forward Madeline's audio chunks to Simli for lip sync
    this.subs.add(
      this.realtime.audioChunk$.subscribe((chunk) => {
        this.sendAudioToSimli(chunk);
      }),
    );
  }

  ngOnDestroy(): void {
    this.subs.unsubscribe();
    this.realtime.disconnect();
    this.speech.stopSpeaking();
    this.speech.stopListening();
    // ADD THESE:
    this.simliWs?.close();
    this.simliPc?.close();
  }

  // ── Interview lifecycle ────────────────────────

  async startInterview(): Promise<void> {
    this.isStarted.set(true);

    if (this.demoMode()) {
      await this.interview.startInterview(true);
      return;
    }

    this.isConnecting.set(true);
    try {
      const resume = this.interview.session().resumeData;
      this.interview.resetSession();
      if (resume) this.interview.setResumeData(resume);
      const resumeText = resume?.rawText ?? "";
      const skills = resume?.skills?.join(", ") ?? "";

      // Step 1: Connect to OpenAI backend (fast — ~1s)
      await this.realtime.connect(resumeText, skills);

      // Step 2: Start mic immediately — do NOT wait for Simli.
      // Mic must be running before we trigger Madeline's first question.
      await this.realtime.startMic();
      this.interview.markActive();
      this.isConnecting.set(false);

      // Step 3: Connect Simli in background (takes 3-8s for WebRTC).
      // connectSimli resolves only after Simli sends "START" — meaning
      // the avatar is rendering and ready to receive audio.
      // Only THEN do we trigger Madeline's first question via start_interview.
      // This guarantees lip sync from word one, with zero blocking on mic.
      await new Promise((r) => setTimeout(r, 0)); // tick so DOM renders
      const videoEl = this.simliVideoRef?.nativeElement;
      if (videoEl) {
        this.connectSimliThenStart(videoEl);
      } else {
        // No video element — just start immediately without avatar
        this.realtime.triggerFirstQuestion();
      }
    } catch (err: any) {
      this.isConnecting.set(false);
      this.realtime.error.set(err.message || "Failed to connect to backend");
    }
  }

  // Connects Simli, waits for it to be ready, THEN triggers Madeline's first word.
  // Runs entirely in the background — does not block mic or UI.
  private async connectSimliThenStart(
    videoEl: HTMLVideoElement,
  ): Promise<void> {
    try {
      await this.connectSimli(videoEl); // resolves when Simli sends START
      console.log("Simli ready — triggering first question");
    } catch (e) {
      console.warn("Simli failed — starting interview without avatar");
    }
    // Always trigger the question — interview continues even if Simli fails
    this.realtime.triggerFirstQuestion();
  }

  // Used in demo mode and text input fallback
  async submitAnswer(): Promise<void> {
    const text = this.textInput().trim();
    if (!text || this.isLoading() || this.isTyping()) return;
    this.textInput.set("");

    if (this.demoMode()) {
      this.speech.stopSpeaking();
      await this.interview.submitUserAnswer(text, true);
    } else {
      // Realtime mode: inject typed text as user turn
      this.interview.addUserMessage(text);
    }
  }

  onKeyDown(event: KeyboardEvent): void {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      this.submitAnswer();
    }
  }

  // Mic toggle for manual control
  toggleListening(): void {
    if (this.demoMode()) {
      if (this.speech.isListening()) {
        this.speech.stopListening();
      } else {
        this.speech.stopSpeaking();
        this.speech.startListening();
      }
    }
    // In realtime mode mic is always-on — button is hidden
  }

  // Stop Madeline mid-sentence
  stopSpeaking(): void {
    if (this.demoMode()) {
      this.speech.stopSpeaking();
    } else {
      // Interrupt realtime audio
      (this.realtime as any).stopMadelineAudio();
    }
  }

  toggleTextInput(): void {
    this.showTextInput.update((v) => !v);
  }

  // Called when user manually clicks "End Session"
  async endEarly(): Promise<void> {
    this.realtime.stopMic();
    this.realtime.disconnect();
    await this.interview.endInterview(false);
    // No speech.speak() here — Madeline already said goodbye via OpenAI audio,
    // OR user ended manually and we don't need a second voice on top.
  }

  // Called automatically when Madeline detects natural interview end
  async endInterview(): Promise<void> {
    // Wait for Madeline's closing audio to finish playing before stopping mic
    // The mic is already suspended during Madeline's speech, so just stop it after
    setTimeout(() => {
      this.realtime.stopMic();
    }, 500);
    await this.interview.endInterview(false);
    // Do NOT call speech.speak() — Madeline already said the goodbye via OpenAI voice
  }

  viewEvaluation(): void {
    this.showEvaluation.set(true);
  }
  hideEvaluation(): void {
    this.showEvaluation.set(false);
  }

  restartInterview(): void {
    this.realtime.disconnect();
    this.speech.stopSpeaking();
    this.speech.stopListening();
    this.interview.resetSession();
    this.isStarted.set(false);
    this.isConnecting.set(false);
    this.showEvaluation.set(false);
    this.textInput.set("");
  }

  getScoreClass(s: number) {
    return s >= 80 ? "score-high" : s >= 60 ? "score-mid" : "score-low";
  }
  getScoreLabel(s: number) {
    return s >= 85
      ? "Excellent"
      : s >= 70
        ? "Good"
        : s >= 55
          ? "Fair"
          : "Needs Work";
  }

  viewPlayback(): void {
    this.showPlayback.set(true);
  }
  hidePlayback(): void {
    this.showPlayback.set(false);
  }

  getAnnotationClass(label: string): string {
    return (
      {
        strong: "ann-strong",
        adequate: "ann-adequate",
        weak: "ann-weak",
        missed: "ann-missed",
      }[label] ?? ""
    );
  }

  getAnnotationIcon(label: string): string {
    return (
      { strong: "✅", adequate: "🟡", weak: "🔶", missed: "❌" }[label] ?? "•"
    );
  }

  getConfidenceClass(score: number): string {
    return score >= 70 ? "conf-high" : score >= 45 ? "conf-mid" : "conf-low";
  }

  getConfidenceLabel(score: number): string {
    return score >= 70 ? "Confident" : score >= 45 ? "Moderate" : "Needs Work";
  }

  private simliPc: RTCPeerConnection | null = null;
  simliConnected = signal(false);
  simliVideoEl: HTMLVideoElement | null = null;

  private simliWs: WebSocket | null = null;
  // connectSimli returns a Promise that resolves when Simli is ready to receive audio.
  // "Ready" = Simli WebSocket sends "START" (meaning WebRTC is established and
  // the avatar is rendering). This is the signal we wait for before triggering
  // Madeline's first question, so lip sync works from the very first word.
  async connectSimli(videoEl: HTMLVideoElement): Promise<void> {
    this.simliVideoEl = videoEl;

    const base =
      window.location.hostname === "localhost"
        ? "http://localhost:3001"
        : "https://talentaibackend-production.up.railway.app";

    return new Promise(async (resolve, reject) => {
      // Hard timeout — if Simli takes > 10s, give up and start without it
      const timeout = setTimeout(() => {
        console.warn("Simli connection timeout — starting without avatar");
        resolve();
      }, 10000);

      try {
        // 1. Get ICE servers
        const iceRes = await fetch(`${base}/simli/ice`);
        const iceServers = await iceRes.json();

        // 2. Create peer connection
        this.simliPc = new RTCPeerConnection({
          iceServers,
          sdpSemantics: "unified-plan",
        } as any);

        this.simliPc.addTransceiver("audio", { direction: "recvonly" });
        this.simliPc.addTransceiver("video", { direction: "recvonly" });

        // 3. Handle incoming video/audio tracks
        this.simliPc.addEventListener("track", (evt) => {
          if (evt.track.kind === "video" && this.simliVideoEl) {
            this.simliVideoEl.srcObject = evt.streams[0];
            this.ngZone.run(() => this.simliConnected.set(true));
            // Tell realtime service to delay audio ~220ms so video catches up
            this.realtime.simliAudioDelay = 0.22;
            console.log("Simli video track attached");
          }
        });

        // 4. Create offer — use trickle ICE (don't wait for gathering)
        const offer = await this.simliPc.createOffer();
        await this.simliPc.setLocalDescription(offer);

        // 5. Get token
        const tokenRes = await fetch(`${base}/simli/start`, { method: "POST" });
        const tokenData = await tokenRes.json();
        const token = tokenData.session_token;
        if (!token) throw new Error("No Simli token");
        console.log("Simli token OK — opening WebSocket");

        // 6. Connect WebSocket
        const wsUrl = `wss://api.simli.ai/compose/webrtc/p2p?session_token=${token}`;
        this.simliWs = new WebSocket(wsUrl);
        let answerSet = false;

        this.simliWs.addEventListener("open", () => {
          console.log("Simli WS open — sending offer");
          this.simliWs!.send(
            JSON.stringify({
              sdp: this.simliPc!.localDescription!.sdp,
              type: this.simliPc!.localDescription!.type,
            }),
          );
        });

        this.simliPc.addEventListener("icecandidate", (e) => {
          if (e.candidate && this.simliWs?.readyState === WebSocket.OPEN) {
            this.simliWs.send(
              JSON.stringify({
                type: "ice_candidate",
                candidate: e.candidate.toJSON(),
              }),
            );
          }
        });

        this.simliWs.addEventListener("message", async (evt) => {
          const data = evt.data;

          if (data === "START") {
            console.log("Simli START — avatar is live and rendering");
            // Send a silent audio chunk to "prime" the avatar render
            this.simliWs!.send(new Uint8Array(6400).buffer);
            clearTimeout(timeout);
            resolve(); // ← This is the key: resolve ONLY when Simli confirms ready
            return;
          }
          if (data === "STOP") {
            this.simliWs?.close();
            return;
          }

          try {
            const msg = JSON.parse(data);
            if ((msg.type === "answer" || msg.sdp) && !answerSet) {
              answerSet = true;
              await this.simliPc!.setRemoteDescription(
                new RTCSessionDescription({
                  type: msg.type || "answer",
                  sdp: msg.sdp,
                }),
              );
              console.log("Simli WebRTC answer applied");
            } else if (msg.type === "ice_candidate" && msg.candidate) {
              await this.simliPc!.addIceCandidate(
                new RTCIceCandidate(msg.candidate),
              );
            }
          } catch {
            /* non-JSON, ignore */
          }
        });

        this.simliWs.addEventListener("error", (e) => {
          console.warn("Simli WS error:", e);
          clearTimeout(timeout);
          resolve(); // resolve on error so interview still starts
        });

        this.simliWs.addEventListener("close", () => {
          this.ngZone.run(() => this.simliConnected.set(false));
          this.realtime.simliAudioDelay = 0;
        });
      } catch (e) {
        clearTimeout(timeout);
        console.warn("Simli setup failed:", e);
        resolve(); // always resolve — interview must start
      }
    });
  }

  avgPauseSeconds = computed(() => {
    const turns = this.confidenceTurns();
    if (!turns.length) return 0;
    return (
      turns.reduce((s, t) => s + t.pauseMs, 0) /
      turns.length /
      1000
    ).toFixed(1);
  });

  avgWordCount = computed(() => {
    const turns = this.confidenceTurns();
    if (!turns.length) return 0;
    return Math.round(
      turns.reduce((s, t) => s + t.wordCount, 0) / turns.length,
    );
  });

  totalFillers = computed(() =>
    this.confidenceTurns().reduce((s, t) => s + t.fillerCount, 0),
  );

  sendAudioToSimli(base64Pcm16at24k: string): void {
    if (!this.simliWs || this.simliWs.readyState !== WebSocket.OPEN) return;
    if (!this.simliConnected()) return;

    // Decode base64 → int16 samples at 24kHz
    const binary = atob(base64Pcm16at24k);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const int16_24k = new Int16Array(bytes.buffer);

    // Downsample 24000 → 16000 (ratio 2/3 — drop every 3rd sample)
    const ratio = 16000 / 24000; // 0.666...
    const outLength = Math.floor(int16_24k.length * ratio);
    const int16_16k = new Int16Array(outLength);

    for (let i = 0; i < outLength; i++) {
      // Linear interpolation for better quality than simple decimation
      const srcIdx = i / ratio;
      const idx0 = Math.floor(srcIdx);
      const idx1 = Math.min(idx0 + 1, int16_24k.length - 1);
      const frac = srcIdx - idx0;
      int16_16k[i] = Math.round(
        int16_24k[idx0] * (1 - frac) + int16_24k[idx1] * frac,
      );
    }

    this.simliWs.send(int16_16k.buffer);
  }
}
