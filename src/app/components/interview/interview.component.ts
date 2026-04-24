// ─────────────────────────────────────────────
// components/interview/interview.component.ts
// Avatar-based interview screen.
// Subscribes to both transcriptComplete$ AND
// analysisComplete$ from SpeechService so that
// speech analysis flows into the AI prompt.
// ─────────────────────────────────────────────

import {
  Component, OnInit, OnDestroy, inject, signal, computed
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Subscription } from 'rxjs';

import { InterviewService } from '../../services/interview.service';
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
  speech    = inject(SpeechService);
  ai        = inject(AiService);

  // ── Local UI state ─────────────────────────────
  textInput      = signal('');
  demoMode       = signal(false);
  showEvaluation = signal(false);
  isStarted      = signal(false);
  showTextInput  = signal(false);

  // ── Derived from services ──────────────────────
  messages      = computed(() => this.interview.chatHistory());
  isActive      = computed(() => this.interview.isActive());
  isCompleted   = computed(() => this.interview.isCompleted());
  isLoading     = computed(() => this.ai.isLoading());
  isTyping      = computed(() => this.interview.isTyping());
  evaluation    = computed(() => this.interview.session().evaluation);
  questionNum   = computed(() => this.interview.questionCount());
  currentQ      = computed(() => this.interview.session().currentQuestion);
  phase         = computed(() => this.speech.phase());
  isSpeaking    = computed(() => this.speech.isSpeaking());
  isListening   = computed(() => this.speech.isListening());
  liveText      = computed(() => this.speech.transcript());
  recordingMs   = computed(() => this.speech.recordingMs());

  /** Human-readable status label shown below the avatar */
  statusLabel = computed<string>(() => {
    if (!this.isStarted()) return '';
    if (this.isTyping() || this.isLoading()) return 'Thinking...';

    switch (this.phase()) {
      case 'ai-speaking':   return 'Alex is speaking...';
      case 'listening':     return 'Listening for your voice...';
      case 'user-speaking': return 'I\'m listening...';
      case 'filler-pause':  return 'Take your time...';
      case 'processing':    return 'Processing your answer...';
      case 'ai-thinking':   return 'One moment...';
      default:              return this.isActive() ? 'Your turn to speak' : '';
    }
  });

  /** CSS class applied to the avatar element — drives all animations */
  avatarState = computed<string>(() => {
    if (this.isTyping() || this.isLoading()) return 'thinking';
    switch (this.phase()) {
      case 'ai-speaking':   return 'speaking';
      case 'user-speaking': return 'listening';
      case 'filler-pause':  return 'patient';
      case 'processing':    return 'processing';
      default:              return 'idle';
    }
  });

  /** Formatted recording duration e.g. "0:04" */
  recordingLabel = computed<string>(() => {
    const ms = this.recordingMs();
    if (!ms) return '';
    const s = Math.floor(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  });

  private subs = new Subscription();

  ngOnInit(): void {
    this.demoMode.set(!this.ai.hasApiKey());

    // 1. When Whisper returns the final transcript → submit as answer
    this.subs.add(
      this.speech.transcriptComplete$.subscribe(text => {
        this.textInput.set(text);
        // Small delay so user sees what was heard before it submits
        setTimeout(() => this.submitAnswer(), 300);
      })
    );

    // 2. When speech analysis arrives → store in interview service
    //    so the AI prompt gets enriched with confidence data
    this.subs.add(
      this.speech.analysisComplete$.subscribe(analysis => {
        this.interview.setLastAnalysis(analysis);
      })
    );
  }

  ngOnDestroy(): void {
    this.subs.unsubscribe();
    this.speech.stopSpeaking();
    this.speech.stopListening();
  }

  // ── Interview lifecycle ────────────────────────

  async startInterview(): Promise<void> {
    this.isStarted.set(true);
    await this.interview.startInterview(this.demoMode());
    // Auto-open mic once AI finishes its first question
    this.autoOpenMicAfterSpeech();
  }

  async submitAnswer(): Promise<void> {
    const text = this.textInput().trim();
    if (!text || this.isLoading() || this.isTyping()) return;

    this.textInput.set('');
    this.speech.stopSpeaking(); // Stop AI if still talking

    await this.interview.submitUserAnswer(text, this.demoMode());
    this.autoOpenMicAfterSpeech();
  }

  /**
   * Polls until AI stops speaking, then auto-opens mic.
   * Creates a hands-free conversation loop.
   */
  private autoOpenMicAfterSpeech(): void {
    if (!this.speech.sttSupported) return;

    const check = setInterval(() => {
      const ready = !this.isSpeaking()
                 && !this.isTyping()
                 && !this.isLoading()
                 && this.isActive();

      if (ready) {
        clearInterval(check);
        setTimeout(() => {
          if (this.isActive() && !this.isListening()) {
            this.speech.startListening();
          }
        }, 500); // Brief pause after AI finishes
      }
    }, 200);

    // Safety: stop polling after 60s
    setTimeout(() => clearInterval(check), 60000);
  }

  onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      this.submitAnswer();
    }
  }

  // ── Voice controls ─────────────────────────────

  toggleListening(): void {
    if (this.isListening()) {
      // User manually stops — commit whatever was recorded
      this.speech.stopListening();
    } else {
      this.speech.stopSpeaking();
      this.speech.startListening();
    }
  }

  stopSpeaking(): void {
    this.speech.stopSpeaking();
    // Open mic immediately after user mutes AI
    if (this.speech.sttSupported && this.isActive()) {
      setTimeout(() => {
        if (!this.isListening()) this.speech.startListening();
      }, 300);
    }
  }

  toggleTextInput(): void {
    this.showTextInput.update(v => !v);
  }

  // ── Session control ────────────────────────────

  async endEarly(): Promise<void> {
    this.speech.stopListening();
    await this.interview.endInterview(this.demoMode());
  }

  viewEvaluation():  void { this.showEvaluation.set(true); }
  hideEvaluation():  void { this.showEvaluation.set(false); }

  restartInterview(): void {
    this.speech.stopSpeaking();
    this.speech.stopListening();
    this.interview.resetSession();
    this.isStarted.set(false);
    this.showEvaluation.set(false);
    this.textInput.set('');
  }

  // ── Score helpers ──────────────────────────────

  getScoreClass(score: number): string {
    if (score >= 80) return 'score-high';
    if (score >= 60) return 'score-mid';
    return 'score-low';
  }

  getScoreLabel(score: number): string {
    if (score >= 85) return 'Excellent';
    if (score >= 70) return 'Good';
    if (score >= 55) return 'Fair';
    return 'Needs Work';
  }
}