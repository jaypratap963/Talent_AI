// ─────────────────────────────────────────────────────────────────
// components/interview/interview.component.ts
//
// Single service source: SpeechService only.
// StreamingSpeechService removed — it was the root cause of the bug.
//
// FLOW:
//   VAD commits → SpeechService.processRecording()
//     → Whisper returns real transcript
//     → analysisComplete$ → interview.setLastAnalysis()
//     → transcriptComplete$ → submitAnswer()
//     → interview.sendAIMessage()
//       → filler clip + GPT stream + sentence TTS queue
//       → onEnd callback → scheduleAutoMic()
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
  isStreaming    = signal(false);

  messages    = computed(() => this.interview.chatHistory());
  isActive    = computed(() => this.interview.isActive());
  isCompleted = computed(() => this.interview.isCompleted());
  isLoading   = computed(() => this.ai.isLoading());
  isTyping    = computed(() => this.interview.isTyping());
  evaluation  = computed(() => this.interview.session().evaluation);
  questionNum = computed(() => this.interview.questionCount());
  currentQ    = computed(() => this.interview.session().currentQuestion);
  phase       = computed(() => this.speech.phase());
  isSpeaking  = computed(() => this.speech.isSpeaking());
  isListening = computed(() => this.speech.isListening());
  // liveText shows VAD status ("🎙 Recording...") not the transcript
  // The real transcript only appears after Whisper returns
  liveText    = computed(() => this.speech.transcript());
  recordingMs = computed(() => this.speech.recordingMs());

  statusLabel = computed<string>(() => {
    if (!this.isStarted()) return '';
    if (this.isStreaming())                   return 'Alex is thinking...';
    if (this.isTyping() || this.isLoading())  return 'Thinking...';
    switch (this.phase()) {
      case 'ai-speaking':   return 'Alex is speaking...';
      case 'listening':     return 'Listening for your voice...';
      case 'user-speaking': return "I'm listening...";
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
  private micOpenCheck: ReturnType<typeof setInterval> | null = null;

  ngOnInit(): void {
    this.demoMode.set(!this.ai.hasApiKey());

    // 1. Analysis arrives first — store it before transcript fires
    this.subs.add(
      this.speech.analysisComplete$.subscribe(analysis => {
        this.interview.setLastAnalysis(analysis);
      })
    );

    // 2. Whisper transcript ready — submit as answer
    this.subs.add(
      this.speech.transcriptComplete$.subscribe(text => {
        // Guard: ignore status strings that slipped through
        // (shouldn't happen now, but safety net)
        const isStatusText = ['🎙 Recording...', 'Transcribing...', 'Processing...', 'Take your time...', 'Listening...'].includes(text);
        if (isStatusText) return;

        this.textInput.set(text);
        this.submitAnswer();
      })
    );

    // 3. GPT streaming token → animate avatar immediately
    this.subs.add(
      this.ai.streamToken$.subscribe(() => {
        if (!this.isStreaming()) this.isStreaming.set(true);
      })
    );

    // 4. GPT response assembled → stop streaming indicator
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

  // ── Interview lifecycle ────────────────────────────────────────

  async startInterview(): Promise<void> {
    this.isStarted.set(true);
    await this.interview.startInterview(this.demoMode());
    this.scheduleAutoMic();
  }

  async submitAnswer(): Promise<void> {
    const text = this.textInput().trim();
    if (!text || this.isLoading() || this.isTyping()) return;

    // Final guard against status strings
    const junkStrings = ['🎙 Recording...', 'Transcribing...', 'Processing your answer...', 'Listening...', 'Take your time...', '[Demo mode — type your answer instead]'];
    if (junkStrings.some(j => text.includes(j))) {
      this.textInput.set('');
      return;
    }

    this.textInput.set('');
    this.ai.stopAudio();
    this.speech.stopSpeaking();

    await this.interview.submitUserAnswer(text, this.demoMode());
    this.scheduleAutoMic();
  }

  // ─────────────────────────────────────────────────────────────
  // AUTO MIC OPEN
  // Waits until Alex finishes speaking AND phase returns to idle,
  // then opens mic. The 150ms polling is fine — it only runs for
  // at most the duration of Alex's response (~5-15s).
  // ─────────────────────────────────────────────────────────────

  private scheduleAutoMic(): void {
    if (!this.speech.sttSupported) return;
    this.clearMicCheck();

    this.micOpenCheck = setInterval(() => {
      const ready =
        !this.isSpeaking()   &&
        !this.isStreaming()  &&
        !this.isTyping()     &&
        !this.isLoading()    &&
        this.phase() === 'idle' &&
        this.isActive();

      if (ready) {
        this.clearMicCheck();
        setTimeout(() => {
          if (this.isActive() && !this.isListening()) {
            this.speech.startListening();
          }
        }, 500); // 500ms buffer after audio clears
      }
    }, 150);

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