// ─────────────────────────────────────────────
// services/interview.service.ts
// Central session orchestrator.
// Now stores the last SpeechAnalysis from Whisper
// and passes it to AiService so Alex adapts to
// how the candidate actually sounded.
// ─────────────────────────────────────────────

import { Injectable, signal, computed } from '@angular/core';
import {
  ChatMessage, InterviewSession, ResumeData, EvaluationResult
} from '../models/interview.models';
import { AiService } from './ai.service';
import { SpeechService, SpeechAnalysis } from './speech.service';

@Injectable({ providedIn: 'root' })
export class InterviewService {

  // ── Session state ─────────────────────────────
  session = signal<InterviewSession>(this.createEmptySession());

  // ── Computed derived state ────────────────────
  isActive      = computed(() => this.session().status === 'active');
  isCompleted   = computed(() => this.session().status === 'completed');
  chatHistory   = computed(() => this.session().chatHistory);
  hasResume     = computed(() => !!this.session().resumeData);
  questionCount = computed(() => this.session().questionCount);

  // ── Typing indicator ──────────────────────────
  isTyping = signal(false);

  // ── Speech analysis from last Whisper result ──
  // Stored here so sendAIMessage can read it without
  // needing the component to pass it through.
  private lastAnalysis: SpeechAnalysis | null = null;

  constructor(
    private aiService:     AiService,
    private speechService: SpeechService
  ) {}

  // ── Session factory ───────────────────────────

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

  // ── Public API ────────────────────────────────

  setResumeData(data: ResumeData): void {
    this.session.update(s => ({ ...s, resumeData: data }));
  }

  /**
   * Called by interview.component when speech analysis arrives
   * from the SpeechService's analysisComplete$ observable.
   * Stored until the next AI message is requested.
   */
  setLastAnalysis(analysis: SpeechAnalysis): void {
    this.lastAnalysis = analysis;
  }

  async startInterview(demoMode = false): Promise<void> {
    const resume = this.session().resumeData;
    if (!resume) throw new Error('No resume loaded');

    // Fresh session, keep resume
    this.session.update(() => ({
      ...this.createEmptySession(),
      status:    'active',
      resumeData: resume,
      startedAt: new Date(),
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

    // AI closing line — speak it too
    const closingText = "That wraps up our interview today. Thank you for your time — you'll hear back from us shortly. Let me prepare your evaluation now...";

    this.addMessage({
      id:        crypto.randomUUID(),
      role:      'assistant',
      content:   closingText,
      timestamp: new Date(),
    });

    // Speak the closing message
    this.speechService.speak(closingText);

    this.session.update(s => ({
      ...s,
      status:      'completed',
      completedAt: new Date(),
    }));

    // Generate evaluation in background
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
      // Demo fallback scores
      this.session.update(s => ({
        ...s,
        evaluation: {
          overallScore:       76,
          technicalScore:     80,
          communicationScore: 72,
          confidenceScore:    75,
          strengths: [
            'Clear technical explanations',
            'Good use of specific examples',
            'Confident delivery',
          ],
          improvements: [
            'Provide more quantitative outcomes',
            'Structure behavioral answers using STAR format',
            'Ask clarifying questions before answering',
          ],
          summary: 'Strong technical candidate with good communication skills. Shows solid problem-solving ability. Could strengthen answers with more measurable results and structured storytelling.',
        },
      }));
    }
  }

  resetSession(): void {
    this.speechService.stopSpeaking();
    this.speechService.stopListening();
    this.lastAnalysis = null;
    this.session.set(this.createEmptySession());
  }

  // ── Private helpers ───────────────────────────

  /**
   * Requests next AI message, passes speech analysis so Alex can
   * adapt tone (e.g. "You seemed hesitant — can you elaborate?")
   * then speaks the response via OpenAI TTS.
   */
  private async sendAIMessage(demoMode: boolean): Promise<void> {
    const session = this.session();
    if (!session.resumeData) return;

    this.isTyping.set(true);

    // Show typing placeholder
    const typingId = crypto.randomUUID();
    this.addMessage({
      id:        typingId,
      role:      'assistant',
      content:   '',
      timestamp: new Date(),
      isTyping:  true,
    });

    // Capture analysis for this turn, then clear it
    const analysis = this.lastAnalysis;
    this.lastAnalysis = null;

    try {
      let responseText: string;

      if (demoMode || !this.aiService.hasApiKey()) {
        await this.delay(700 + Math.random() * 500);
        responseText = this.aiService.getDemoResponse(session.questionCount);
      } else {
        responseText = await this.aiService.getNextMessage(
          session.chatHistory.filter(m => !m.isTyping),
          session.resumeData,
          analysis   // ← pass speech analysis to prompt
        );
      }

      this.removeMessage(typingId);
      this.isTyping.set(false);

      this.addMessage({
        id:        crypto.randomUUID(),
        role:      'assistant',
        content:   responseText,
        timestamp: new Date(),
        isTyping:  false,
      });

      this.session.update(s => ({
        ...s,
        currentQuestion: responseText,
        questionCount:   s.questionCount + 1,
      }));

      // Speak via OpenAI TTS (shimmer voice)
      // Cast to any because speak() is now async but we don't need to await it here
      (this.speechService.speak(responseText) as any);

    } catch (err: any) {
      this.removeMessage(typingId);
      this.isTyping.set(false);

      this.addMessage({
        id:        crypto.randomUUID(),
        role:      'assistant',
        content:   `⚠️ ${err.message || 'Failed to get response. Please check your API key.'}`,
        timestamp: new Date(),
        isError:   true,
      });
    }
  }

  private addMessage(msg: ChatMessage): void {
    this.session.update(s => ({
      ...s,
      chatHistory: [...s.chatHistory, msg],
    }));
  }

  private removeMessage(id: string): void {
    this.session.update(s => ({
      ...s,
      chatHistory: s.chatHistory.filter(m => m.id !== id),
    }));
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}