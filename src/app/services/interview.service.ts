// ─────────────────────────────────────────────────────────────────
// services/interview.service.ts
//
// Changes for latency layer:
// - sendAIMessage() now uses getNextMessageStreaming() instead of
//   getNextMessage() — response starts playing before GPT finishes
// - Whisper result immediately triggers filler clip + GPT stream
// - setLastAnalysis() feeds speech confidence into the prompt
// ─────────────────────────────────────────────────────────────────

import { Injectable, signal, computed } from '@angular/core';
import {
  ChatMessage, InterviewSession, ResumeData, EvaluationResult
} from '../models/interview.models';
import { AiService } from './ai.service';
import { SpeechService, SpeechAnalysis } from './speech.service';

@Injectable({ providedIn: 'root' })
export class InterviewService {

  session       = signal<InterviewSession>(this.createEmptySession());
  isActive      = computed(() => this.session().status === 'active');
  isCompleted   = computed(() => this.session().status === 'completed');
  chatHistory   = computed(() => this.session().chatHistory);
  hasResume     = computed(() => !!this.session().resumeData);
  questionCount = computed(() => this.session().questionCount);
  isTyping      = signal(false);

  // Last speech analysis from Whisper — consumed once per AI turn
  private lastAnalysis: SpeechAnalysis | null = null;

  constructor(
    private aiService:    AiService,
    private speechService: SpeechService
  ) {}

  private createEmptySession(): InterviewSession {
    return {
      id:              crypto.randomUUID(),
      status:          'idle',
      resumeData:      null,
      chatHistory:     [],
      currentQuestion: '',
      questionCount:   0,
      startedAt:       null,
      completedAt:     null,
      evaluation:      null,
    };
  }

  setResumeData(data: ResumeData): void {
    this.session.update(s => ({ ...s, resumeData: data }));
  }

  setLastAnalysis(a: SpeechAnalysis): void {
    this.lastAnalysis = a;
  }

  async startInterview(demoMode = false): Promise<void> {
    const resume = this.session().resumeData;
    if (!resume) throw new Error('No resume loaded');

    this.session.update(() => ({
      ...this.createEmptySession(),
      status:     'active',
      resumeData: resume,
      startedAt:  new Date(),
    }));

    await this.sendAIMessage(demoMode);
  }

  async submitUserAnswer(text: string, demoMode = false): Promise<void> {
    if (!text.trim() || !this.isActive()) return;

    this.addMessage({
      id:        crypto.randomUUID(),
      role:      'user',
      content:   text.trim(),
      timestamp: new Date(),
    });

    if (this.session().questionCount >= 8) {
      await this.endInterview(demoMode);
      return;
    }

    await this.sendAIMessage(demoMode);
  }

  async endInterview(demoMode = false): Promise<void> {
    const session = this.session();
    if (!session.resumeData) return;

    const closing = "That wraps up our interview today. Thank you for your time — you'll hear back from us shortly. Let me prepare your evaluation now...";

    this.addMessage({
      id: crypto.randomUUID(), role: 'assistant',
      content: closing, timestamp: new Date(),
    });

    // Speak closing line (no streaming needed for one sentence)
    this.speechService.speak(closing);

    this.session.update(s => ({
      ...s, status: 'completed', completedAt: new Date(),
    }));

    if (!demoMode && this.aiService.hasApiKey()) {
      try {
        const evaluation = await this.aiService.evaluateInterview(
          session.chatHistory, session.resumeData
        );
        this.session.update(s => ({ ...s, evaluation }));
      } catch (e) {
        console.error('Evaluation error:', e);
      }
    } else {
      this.session.update(s => ({
        ...s,
        evaluation: {
          overallScore: 76, technicalScore: 80,
          communicationScore: 72, confidenceScore: 75,
          strengths: ['Clear explanations', 'Specific examples', 'Confident delivery'],
          improvements: ['More quantitative outcomes', 'STAR format for behavioral questions', 'Ask clarifying questions'],
          summary: 'Strong candidate. Good communication and problem-solving. Strengthen answers with measurable results.',
        },
      }));
    }
  }

  resetSession(): void {
    this.aiService.stopAudio();
    this.speechService.stopSpeaking();
    this.speechService.stopListening();
    this.lastAnalysis = null;
    this.session.set(this.createEmptySession());
  }

  // ─────────────────────────────────────────────────────────────
  // SEND AI MESSAGE — streaming version
  //
  // Timeline after Whisper returns transcript:
  //   t=0ms   : filler clip plays ("Mmm, right.")
  //   t=0ms   : GPT stream request fires
  //   t~800ms : GPT emits first sentence
  //   t~1100ms: TTS fetch for sentence 1 completes → plays
  //   t~1600ms: TTS fetch for sentence 2 → queued, plays right after
  //   User hears Alex speaking at t~1100ms vs t~4000ms before
  // ─────────────────────────────────────────────────────────────

  private async sendAIMessage(demoMode: boolean): Promise<void> {
    const session = this.session();
    if (!session.resumeData) return;

    this.isTyping.set(true);

    // Add typing placeholder
    const typingId = crypto.randomUUID();
    this.addMessage({
      id: typingId, role: 'assistant',
      content: '', timestamp: new Date(), isTyping: true,
    });

    // Consume and clear analysis for this turn
    const analysis    = this.lastAnalysis;
    this.lastAnalysis = null;

    try {
      let responseText: string;

      if (demoMode || !this.aiService.hasApiKey()) {
        // Demo mode — simulate streaming delay
        await this.delay(600 + Math.random() * 400);
        responseText = this.aiService.getDemoResponse(session.questionCount);

        this.removeMessage(typingId);
        this.isTyping.set(false);

        this.addMessage({
          id: crypto.randomUUID(), role: 'assistant',
          content: responseText, timestamp: new Date(),
        });

        this.session.update(s => ({
          ...s,
          currentQuestion: responseText,
          questionCount:   s.questionCount + 1,
        }));

        // Browser TTS for demo (no API key)
        this.speechService.speak(responseText);

      } else {
        // ── REAL MODE: streaming pipeline ──────────────────────
        //
        // getNextMessageStreaming() will:
        //  1. Play filler clip immediately
        //  2. Stream GPT tokens
        //  3. Split into sentences → fetch TTS per sentence
        //  4. Play sentences as they arrive
        //  5. Call onEnd when last sentence finishes playing
        //
        responseText = await this.aiService.getNextMessageStreaming(
          session.chatHistory.filter(m => !m.isTyping),
          session.resumeData,
          analysis,
          () => {
            // onEnd — called when last TTS sentence finishes playing
            // This is where we re-open the mic
            this.speechService.phase.set('idle');
          }
        );

        this.removeMessage(typingId);
        this.isTyping.set(false);

        this.addMessage({
          id: crypto.randomUUID(), role: 'assistant',
          content: responseText, timestamp: new Date(),
        });

        this.session.update(s => ({
          ...s,
          currentQuestion: responseText,
          questionCount:   s.questionCount + 1,
        }));
      }

    } catch (err: any) {
      this.removeMessage(typingId);
      this.isTyping.set(false);

      this.addMessage({
        id: crypto.randomUUID(), role: 'assistant',
        content: `⚠️ ${err.message || 'Failed to get response. Check your API key.'}`,
        timestamp: new Date(), isError: true,
      });
    }
  }

  private addMessage(msg: ChatMessage): void {
    this.session.update(s => ({
      ...s, chatHistory: [...s.chatHistory, msg],
    }));
  }

  private removeMessage(id: string): void {
    this.session.update(s => ({
      ...s, chatHistory: s.chatHistory.filter(m => m.id !== id),
    }));
  }

  private delay(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
  }
}