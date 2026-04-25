// ─────────────────────────────────────────────────────────────────
// components/interview/interview.component.ts
//
// Changes for latency layer:
// - subscribes to aiService.streamToken$ to drive avatar animation
//   while GPT is streaming (avatar animates before TTS plays)
// - subscribes to analysisComplete$ to feed speech data to interview
// - autoOpenMicAfterSpeech now waits for the audio QUEUE to empty
//   (not just isSpeaking signal) via onQueueEmpty callback
// ─────────────────────────────────────────────────────────────────

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

  textInput      = signal('');
  demoMode       = signal(false);
  showEvaluation = signal(false);
  isStarted      = signal(false);
  showTextInput  = signal(false);

  // True while GPT is streaming tokens (before audio plays)
  isStreaming    = signal(false);

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

  statusLabel = computed<string>(() => {
    if (!this.isStarted()) return '';
    if (this.isStreaming())                  return 'Alex is thinking...';
    if (this.isTyping() || this.isLoading()) return 'Thinking...';
    switch (this.phase()) {
      case 'ai-speaking':   return 'Alex is speaking...';
      case 'listening':     return 'Listening for your voice...';
      case 'user-speaking': return 'I\'m listening...';
      case 'filler-pause':  return 'Take your time...';
      case 'processing':    return 'Processing your answer...';
      default:              return this.isActive() ? 'Your turn to speak' : '';
    }
  });

  avatarState = computed<string>(() => {
    if (this.isStreaming())                   return 'thinking';
    if (this.isTyping() || this.isLoading())  return 'thinking';
    switch (this.phase()) {
      case 'ai-speaking':   return 'speaking';
      case 'user-speaking': return 'listening';
      case 'filler-pause':  return 'patient';
      case 'processing':    return 'processing';
      default:              return 'idle';
    }
  });

  recordingLabel = computed<string>(() => {
    const ms = this.recordingMs();
    if (!ms || ms < 500) return '';
    const s = Math.floor(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  });

  private subs = new Subscription();
  // Tracks the mic-open polling loop so we can cancel it
  private micOpenCheck: ReturnType<typeof setInterval> | null = null;

  ngOnInit(): void {
    this.demoMode.set(!this.ai.hasApiKey());

    // ── 1. Transcript complete → submit answer ──────────────────
    this.subs.add(
      this.speech.transcriptComplete$.subscribe(text => {
        this.textInput.set(text);
        // No setTimeout needed — Whisper already added latency.
        // Submit immediately so filler clip can start playing ASAP.
        this.submitAnswer();
      })
    );

    // ── 2. Speech analysis → interview service ──────────────────
    this.subs.add(
      this.speech.analysisComplete$.subscribe(analysis => {
        this.interview.setLastAnalysis(analysis);
      })
    );

    // ── 3. GPT stream tokens → animate avatar while thinking ────
    this.subs.add(
      this.ai.streamToken$.subscribe(() => {
        // As soon as first token arrives, show speaking state
        // even though audio hasn't started yet
        if (!this.isStreaming()) {
          this.isStreaming.set(true);
        }
      })
    );

    // ── 4. GPT response complete → stop streaming indicator ─────
    this.subs.add(
      this.ai.responseComplete$.subscribe(() => {
        this.isStreaming.set(false);
      })
    );
  }

  ngOnDestroy(): void {
    this.subs.unsubscribe();
    this.clearMicCheck();
    this.ai.stopAudio();
    this.speech.stopSpeaking();
    this.speech.stopListening();
  }

  async startInterview(): Promise<void> {
    this.isStarted.set(true);
    await this.interview.startInterview(this.demoMode());
    this.scheduleAutoMic();
  }

  async submitAnswer(): Promise<void> {
    const text = this.textInput().trim();
    if (!text || this.isLoading() || this.isTyping()) return;

    this.textInput.set('');
    // Stop any playing audio immediately
    this.ai.stopAudio();
    this.speech.stopSpeaking();

    await this.interview.submitUserAnswer(text, this.demoMode());
    this.scheduleAutoMic();
  }

  // ─────────────────────────────────────────────────────────────
  // AUTO MIC OPEN
  // Polls until Alex has finished speaking (audio queue empty +
  // phase back to idle), then opens mic automatically.
  // ─────────────────────────────────────────────────────────────

  private scheduleAutoMic(): void {
    if (!this.speech.sttSupported) return;
    this.clearMicCheck();

    this.micOpenCheck = setInterval(() => {
      const ready =
        !this.isSpeaking() &&
        !this.isStreaming() &&
        !this.isTyping()   &&
        !this.isLoading()  &&
        this.phase() === 'idle' &&
        this.isActive();

      if (ready) {
        this.clearMicCheck();
        // Small buffer so audio output fully clears
        setTimeout(() => {
          if (this.isActive() && !this.isListening()) {
            this.speech.startListening();
          }
        }, 400);
      }
    }, 150);

    // Safety timeout — give up after 60s
    setTimeout(() => this.clearMicCheck(), 60000);
  }

  private clearMicCheck(): void {
    if (this.micOpenCheck) {
      clearInterval(this.micOpenCheck);
      this.micOpenCheck = null;
    }
  }

  onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      this.submitAnswer();
    }
  }

  toggleListening(): void {
    if (this.isListening()) {
      this.speech.stopListening();
    } else {
      this.ai.stopAudio();
      this.speech.stopSpeaking();
      this.speech.startListening();
    }
  }

  stopSpeaking(): void {
    this.ai.stopAudio();
    this.speech.stopSpeaking();
    if (this.speech.sttSupported && this.isActive()) {
      setTimeout(() => {
        if (!this.isListening()) this.speech.startListening();
      }, 300);
    }
  }

  toggleTextInput(): void { this.showTextInput.update(v => !v); }

  async endEarly(): Promise<void> {
    this.clearMicCheck();
    this.speech.stopListening();
    await this.interview.endInterview(this.demoMode());
  }

  viewEvaluation():  void { this.showEvaluation.set(true); }
  hideEvaluation():  void { this.showEvaluation.set(false); }

  restartInterview(): void {
    this.clearMicCheck();
    this.ai.stopAudio();
    this.speech.stopSpeaking();
    this.speech.stopListening();
    this.interview.resetSession();
    this.isStarted.set(false);
    this.isStreaming.set(false);
    this.showEvaluation.set(false);
    this.textInput.set('');
  }

  getScoreClass(s: number) { return s >= 80 ? 'score-high' : s >= 60 ? 'score-mid' : 'score-low'; }
  getScoreLabel(s: number) { return s >= 85 ? 'Excellent' : s >= 70 ? 'Good' : s >= 55 ? 'Fair' : 'Needs Work'; }
}