import { Injectable, signal, computed } from '@angular/core';
import {
  ChatMessage, InterviewSession, ResumeData, EvaluationResult
} from '../models/interview.models';
import { AiService } from './ai.service';
import { SpeechService } from './speech.service';

@Injectable({ providedIn: 'root' })
export class InterviewService {

  session       = signal<InterviewSession>(this.createEmptySession());
  isActive      = computed(() => this.session().status === 'active');
  isCompleted   = computed(() => this.session().status === 'completed');
  chatHistory   = computed(() => this.session().chatHistory);
  hasResume     = computed(() => !!this.session().resumeData);
  questionCount = computed(() => this.session().questionCount);
  isTyping      = signal(false);

  constructor(
    private aiService:     AiService,
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

  // ── Called by realtime component ──────────────

  /** Mark session as active (realtime mode — no AI call needed, OpenAI handles it) */
  markActive(): void {
    this.session.update(s => ({
      ...s,
      status:    'active',
      startedAt: new Date(),
    }));
  }

  /** Add user's spoken message to chat history (realtime mode) */
  addUserMessage(text: string): void {
    if (!text.trim()) return;
    this.addMessage({
      id:        crypto.randomUUID(),
      role:      'user',
      content:   text.trim(),
      timestamp: new Date(),
    });
  }

  /** Add Alex's response to chat history (realtime mode) */
  addAlexMessage(text: string): void {
    if (!text.trim()) return;

    // Clear any typing placeholder
    this.session.update(s => ({
      ...s,
      chatHistory: s.chatHistory.filter(m => !m.isTyping),
    }));

    this.addMessage({
      id:        crypto.randomUUID(),
      role:      'assistant',
      content:   text.trim(),
      timestamp: new Date(),
    });

    this.session.update(s => ({
      ...s,
      currentQuestion: text.trim(),
      questionCount:   s.questionCount + 1,
    }));
  }

  // ── Standard (demo / non-realtime) mode ──────

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

    this.addMessage({
      id:        crypto.randomUUID(),
      role:      'assistant',
      content:   "That wraps up our interview today. Thank you for your time — you'll hear back from us shortly. Let me prepare your evaluation now...",
      timestamp: new Date(),
    });

    this.session.update(s => ({ ...s, status: 'completed', completedAt: new Date() }));

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
    this.session.set(this.createEmptySession());
  }

private async sendAIMessage(demoMode: boolean): Promise<void> {
  const session = this.session();
  if (!session.resumeData) return;

  this.isTyping.set(true);
  const typingId = crypto.randomUUID();

  this.addMessage({
    id: typingId, role: 'assistant',
    content: '', timestamp: new Date(), isTyping: true,
  });

  try {
    let responseText: string;

    if (demoMode || !this.aiService.hasApiKey()) {
      // ── Demo mode — no streaming, use browser TTS ────────────
      await this.delay(800 + Math.random() * 600);
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

      // Browser TTS for demo — speak() handles isSpeaking + mic closing
      this.speechService.speak(responseText);

    } else {
      // ── Real mode — streaming pipeline handles TTS internally ─
      // Do NOT call speechService.speak() here — getNextMessageStreaming
      // manages the audio queue, isSpeaking, and phase directly.
      responseText = await this.aiService.getNextMessageStreaming(
        session.chatHistory.filter(m => !m.isTyping),
        session.resumeData,
        null,    // pass analysis here if you add lastAnalysis tracking later
        () => {
          // onEnd: fires when last TTS sentence finishes playing
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
      // ← No speechService.speak() — streaming already playing audio
    }

  } catch (err: any) {
    this.removeMessage(typingId);
    this.isTyping.set(false);
    this.addMessage({
      id: crypto.randomUUID(), role: 'assistant',
      content: `⚠️ ${err.message || 'Failed to get response.'}`,
      timestamp: new Date(), isError: true,
    });
  }
}

  addMessage(msg: ChatMessage): void {
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