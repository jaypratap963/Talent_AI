import {
  Component, OnInit, OnDestroy, inject, signal, computed
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Subscription } from 'rxjs';

import { InterviewService } from '../../services/interview.service';
import { RealtimeService } from '../../services/realtime.service';
import { SpeechService } from '../../services/speech.service';
import { AiService } from '../../services/ai.service';
import { ChatWindowComponent } from '../chat-window/chat-window.component';

@Component({
  selector: 'app-interview',
  standalone: true,
  imports: [CommonModule, FormsModule, ChatWindowComponent],
  templateUrl: './interview.component.html',
  styleUrls: ['./interview.component.scss'],
})
export class InterviewComponent implements OnInit, OnDestroy {

  interview = inject(InterviewService);
  realtime  = inject(RealtimeService);
  speech    = inject(SpeechService);
  ai        = inject(AiService);

  // ── UI state ──────────────────────────────────
  textInput      = signal('');
  demoMode       = signal(false);
  showEvaluation = signal(false);
  isStarted      = signal(false);
  showTextInput  = signal(false);
  isConnecting   = signal(false);

  // ── Derived from interview service ────────────
  messages      = computed(() => this.interview.chatHistory());
  isActive      = computed(() => this.interview.isActive());
  isCompleted   = computed(() => this.interview.isCompleted());
  isLoading     = computed(() => this.ai.isLoading());
  isTyping      = computed(() => this.interview.isTyping());
  evaluation    = computed(() => this.interview.session().evaluation);
  questionNum   = computed(() => this.interview.questionCount());
  currentQ      = computed(() => this.interview.session().currentQuestion);

  // ── Derived from realtime service ─────────────
  phase          = computed(() => this.realtime.phase());
  isSpeaking     = computed(() => this.realtime.isSpeaking());
  // isListening = mic is active (replaces old speech.isListening signal)
  isListening    = computed(() => this.realtime.isMicActive());
  // liveText = what VAD is showing / user transcript
  liveText       = computed(() => this.realtime.userTranscript());
  // sttSupported = mic API available
  readonly sttSupported = !!(navigator.mediaDevices?.getUserMedia);

  // ── Avatar status label ───────────────────────
  statusLabel = computed<string>(() => {
    if (!this.isStarted()) return '';
    if (this.isConnecting()) return 'Connecting to Alex...';
    switch (this.phase()) {
      case 'connecting':    return 'Setting up interview...';
      case 'ready':         return 'Your turn to speak';
      case 'user-speaking': return "I'm listening...";
      case 'user-done':     return 'Processing...';
      case 'processing':    return 'Alex is thinking...';
      case 'alex-speaking': return 'Alex is speaking...';
      case 'error':         return this.realtime.error() || 'Connection error';
      default:              return this.isActive() ? 'Your turn to speak' : '';
    }
  });

  // ── Avatar animation class ────────────────────
  avatarState = computed<string>(() => {
    if (this.isConnecting() || this.phase() === 'connecting') return 'thinking';
    switch (this.phase()) {
      case 'user-speaking': return 'listening';
      case 'user-done':
      case 'processing':    return 'thinking';
      case 'alex-speaking': return 'speaking';
      default:
        // Demo / non-realtime fallback
        if (this.isTyping() || this.isLoading()) return 'thinking';
        if (this.speech.isSpeaking()) return 'speaking';
        if (this.speech.phase() === 'user-speaking') return 'listening';
        return 'idle';
    }
  });

  private subs = new Subscription();

  ngOnInit(): void {
    this.demoMode.set(!this.ai.hasApiKey());

    // ── Realtime mode subscriptions ───────────────
    // 1. User transcript → store in chat history
    this.subs.add(
      this.realtime.userTranscript$.subscribe(transcript => {
        this.interview.addUserMessage(transcript);

        // Check if 8 questions answered → end interview
        if (this.interview.questionCount() >= 8) {
          this.endEarly();
        }
      })
    );

    // 2. Alex's response text → store in chat history
    this.subs.add(
      this.realtime.responseText$.subscribe(text => {
        this.interview.addAlexMessage(text);
        // Update question count in backend prompt
        this.realtime.updateQuestionCount(this.interview.questionCount());
      })
    );

    // ── Demo / non-realtime mode subscription ─────
    // 3. Old-style STT transcript (demo mode only)
    this.subs.add(
      this.speech.transcriptComplete$.subscribe(text => {
        if (!this.demoMode()) return; // Only handle in demo mode
        this.textInput.set(text);
        this.submitAnswer();
      })
    );
  }

  ngOnDestroy(): void {
    this.subs.unsubscribe();
    this.realtime.disconnect();
    this.speech.stopSpeaking();
    this.speech.stopListening();
  }

  // ── Interview lifecycle ────────────────────────

  async startInterview(): Promise<void> {
    this.isStarted.set(true);

    if (this.demoMode()) {
      // Demo: use old pipeline (no backend needed)
      await this.interview.startInterview(true);
      return;
    }

    // Realtime mode
    this.isConnecting.set(true);
    try {
      const resume     = this.interview.session().resumeData;
      const resumeText = resume?.rawText  ?? '';
      const skills     = resume?.skills?.join(', ') ?? '';

      await this.realtime.connect(resumeText, skills);
      await this.realtime.startMic();
      this.interview.markActive();
      this.isConnecting.set(false);
    } catch (err: any) {
      this.isConnecting.set(false);
      this.realtime.error.set(err.message || 'Failed to connect to backend');
    }
  }

  // Used in demo mode and text input fallback
  async submitAnswer(): Promise<void> {
    const text = this.textInput().trim();
    if (!text || this.isLoading() || this.isTyping()) return;
    this.textInput.set('');

    if (this.demoMode()) {
      this.speech.stopSpeaking();
      await this.interview.submitUserAnswer(text, true);
    } else {
      // Realtime mode: inject typed text as user turn
      this.interview.addUserMessage(text);
    }
  }

  onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey) {
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

  // Stop Alex mid-sentence
  stopSpeaking(): void {
    if (this.demoMode()) {
      this.speech.stopSpeaking();
    } else {
      // Interrupt realtime audio
      (this.realtime as any).stopAlexAudio();
    }
  }

  toggleTextInput(): void {
    this.showTextInput.update(v => !v);
  }

  async endEarly(): Promise<void> {
    if (!this.demoMode()) {
      this.realtime.stopMic();
    } else {
      this.speech.stopListening();
    }
    await this.interview.endInterview(this.demoMode());
    // Speak closing via regular TTS
    this.speech.speak("That wraps up our interview. Thank you for your time. Let me prepare your evaluation.");
  }

  viewEvaluation():  void { this.showEvaluation.set(true); }
  hideEvaluation():  void { this.showEvaluation.set(false); }

  restartInterview(): void {
    this.realtime.disconnect();
    this.speech.stopSpeaking();
    this.speech.stopListening();
    this.interview.resetSession();
    this.isStarted.set(false);
    this.isConnecting.set(false);
    this.showEvaluation.set(false);
    this.textInput.set('');
  }

  getScoreClass(s: number) { return s >= 80 ? 'score-high' : s >= 60 ? 'score-mid' : 'score-low'; }
  getScoreLabel(s: number) { return s >= 85 ? 'Excellent' : s >= 70 ? 'Good' : s >= 55 ? 'Fair' : 'Needs Work'; }
}