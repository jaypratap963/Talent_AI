import { Injectable, signal, computed } from "@angular/core";
import {
  ChatMessage,
  InterviewSession,
  ResumeData,
  EvaluationResult,
  ConfidenceTurn,
  AnnotatedMessage,
} from "../models/interview.models";
import { AiService } from "./ai.service";
import { SpeechService } from "./speech.service";

@Injectable({ providedIn: "root" })
export class InterviewService {
  session = signal<InterviewSession>(this.createEmptySession());
  isActive = computed(() => this.session().status === "active");
  isCompleted = computed(() => this.session().status === "completed");
  chatHistory = computed(() => this.session().chatHistory);
  hasResume = computed(() => !!this.session().resumeData);
  questionCount = computed(() => this.session().questionCount);
  isTyping = signal(false);

  // ── Plain-array log for evaluation ────────────────────────────
  // WHY: chatHistory is a reactive signal. Reading it inside an async
  // function that runs after a setTimeout can hit Angular zone-flush
  // timing and return a stale snapshot. This plain array is populated
  // synchronously alongside the signal — no zone, no reactivity, no
  // timing issue. It is the single source of truth for evaluation.
  private _chatLog: { role: "user" | "assistant"; content: string }[] = [];

  // Confidence tracking
  private _madelineFinishedAt: number | null = null; // timestamp Madeline stopped speaking
  private _currentQuestion = ""; // last question Madeline asked
  private _turnIndex = 0;

  // Public signal for live confidence display
  confidenceTurns = signal<ConfidenceTurn[]>([]);
  annotations = signal<AnnotatedMessage[]>([]);
  annotationsLoading = signal(false);

  constructor(
    private aiService: AiService,
    private speechService: SpeechService,
  ) {}

  private createEmptySession(): InterviewSession {
    return {
      id: crypto.randomUUID(),
      status: "idle",
      resumeData: null,
      chatHistory: [],
      currentQuestion: "",
      questionCount: 0,
      startedAt: null,
      completedAt: null,
      evaluation: null,
      confidenceTurns: [], // ADD
      annotations: [], // ADD
    };
  }

  setResumeData(data: ResumeData): void {
    this.session.update((s) => ({ ...s, resumeData: data }));
  }

  // ── Called by realtime component ──────────────

  /** Mark session as active (realtime mode) */
  markActive(): void {
    this.session.update((s) => ({
      ...s,
      status: "active",
      startedAt: new Date(),
    }));
  }

  /** Add user's spoken message to chat history (realtime mode) */
  addUserMessage(text: string): void {
    if (!text.trim()) return;
    const msg: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: text.trim(),
      timestamp: new Date(),
    };
    // Push to plain log FIRST — guaranteed sync, no zone/signal timing risk
    this._chatLog.push({ role: "user", content: text.trim() });
    this.addMessage(msg);

    console.log(
      `[ChatLog] user message added. Total log: ${this._chatLog.length}`,
    );
  }

  /** Add Madeline's response to chat history (realtime mode) */
  addMadelineMessage(text: string): void {
    if (!text.trim()) return;

    // Clear any typing placeholder
    this.session.update((s) => ({
      ...s,
      chatHistory: s.chatHistory.filter((m) => !m.isTyping),
    }));

    const msg: ChatMessage = {
      id: crypto.randomUUID(),
      role: "assistant",
      content: text.trim(),
      timestamp: new Date(),
    };
    // Push to plain log FIRST
    this._chatLog.push({ role: "assistant", content: text.trim() });
    this.addMessage(msg);

    this.session.update((s) => ({
      ...s,
      currentQuestion: text.trim(),
      questionCount: s.questionCount + 1,
    }));

    console.log(
      `[ChatLog] madeline message added. Total log: ${this._chatLog.length}`,
    );
  }

  // ── Standard (demo / non-realtime) mode ──────

  async startInterview(demoMode = false): Promise<void> {
    const resume = this.session().resumeData;
    if (!resume) throw new Error("No resume loaded");

    this._chatLog = []; // reset log on new interview
    this.session.update(() => ({
      ...this.createEmptySession(),
      status: "active",
      resumeData: resume,
      startedAt: new Date(),
    }));

    await this.sendAIMessage(demoMode);
  }

  async submitUserAnswer(text: string, demoMode = false): Promise<void> {
    if (!text.trim() || !this.isActive()) return;

    this._chatLog.push({ role: "user", content: text.trim() });
    this.addMessage({
      id: crypto.randomUUID(),
      role: "user",
      content: text.trim(),
      timestamp: new Date(),
    });

    if (this.session().questionCount >= 8) {
      await this.endInterview(demoMode);
      return;
    }

    await this.sendAIMessage(demoMode);
  }

  async endInterview(demoMode = false): Promise<void> {
    if (!this.session().resumeData) return;

    const closingText =
      "That wraps up our interview today. Thank you for your time — you'll hear back from us shortly. Let me prepare your evaluation now...";

    // Push closing message to log TOO so evaluator sees it
    this._chatLog.push({ role: "assistant", content: closingText });
    this.addMessage({
      id: crypto.randomUUID(),
      role: "assistant",
      content: closingText,
      timestamp: new Date(),
    });

    this.session.update((s) => ({
      ...s,
      status: "completed",
      completedAt: new Date(),
    }));

    const logSnapshot = [...this._chatLog];
    console.log(
      `[Evaluation] ${logSnapshot.length} messages:`,
      logSnapshot.map((m) => `${m.role}: ${m.content.slice(0, 40)}`),
    );

    const resumeData = this.session().resumeData!;
    this.annotationsLoading.set(true);
    try {
      const evaluation = await this.evaluateViaBackend(logSnapshot, resumeData);
      this.session.update((s) => ({ ...s, evaluation }));

      // Fetch annotations after evaluation completes
      const turns = this.confidenceTurns();
      if (turns.length > 0) {
        const annotations = await this.annotateViaBackend(turns, resumeData);
        this.annotations.set(annotations);
      }
      this.annotationsLoading.set(false);
    } catch (e) {
      console.error("Evaluation error:", e);
      this.session.update((s) => ({
        ...s,
        evaluation: {
          overallScore: 0,
          technicalScore: 0,
          communicationScore: 0,
          confidenceScore: 0,
          strengths: ["Evaluation failed — please try again"],
          improvements: ["Check your internet connection"],
          summary: "Could not reach evaluation service.",
        },
      }));
      this.annotationsLoading.set(false);
    }
  }

  private async annotateViaBackend(
    turns: ConfidenceTurn[],
    resumeData: ResumeData,
  ): Promise<AnnotatedMessage[]> {
    const backendUrl =
      window.location.hostname === "localhost"
        ? "http://localhost:3001/annotate"
        : "https://talentaibackend-production.up.railway.app/annotate";

    const response = await fetch(backendUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        turns: turns.map((t) => ({
          question: t.question,
          answer: t.answer,
          turnIndex: t.turnIndex,
        })),
        resumeText: resumeData.rawText.slice(0, 1000),
      }),
    });

    if (!response.ok) throw new Error("Annotation failed");
    return response.json();
  }

  private async evaluateViaBackend(
    chatLog: { role: "user" | "assistant"; content: string }[],
    resumeData: ResumeData,
  ): Promise<EvaluationResult> {
    const backendUrl =
      window.location.hostname === "localhost"
        ? "http://localhost:3001/evaluate"
        : "https://talentaibackend-production.up.railway.app/evaluate";

    const response = await fetch(backendUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatHistory: chatLog, // plain objects, no ChatMessage extras
        resumeText: resumeData.rawText.slice(0, 1500),
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Evaluation failed ${response.status}: ${err}`);
    }
    return response.json();
  }

  resetSession(): void {
    this.speechService.stopSpeaking();
    this.speechService.stopListening();
    this._chatLog = []; // reset plain log too
    this._turnIndex = 0;
    this._madelineFinishedAt = null;
    this._currentQuestion = "";
    this.confidenceTurns.set([]);
    this.annotations.set([]);
    this.annotationsLoading.set(false);
    this.session.set(this.createEmptySession());
  }

  private async sendAIMessage(demoMode: boolean): Promise<void> {
    const session = this.session();
    if (!session.resumeData) return;

    this.isTyping.set(true);
    const typingId = crypto.randomUUID();

    this.addMessage({
      id: typingId,
      role: "assistant",
      content: "",
      timestamp: new Date(),
      isTyping: true,
    });

    try {
      let responseText: string;

      if (demoMode || !this.aiService.hasApiKey()) {
        await this.delay(800 + Math.random() * 600);
        responseText = this.aiService.getDemoResponse(session.questionCount);

        this.removeMessage(typingId);
        this.isTyping.set(false);

        this._chatLog.push({ role: "assistant", content: responseText });
        this.addMessage({
          id: crypto.randomUUID(),
          role: "assistant",
          content: responseText,
          timestamp: new Date(),
        });

        this.session.update((s) => ({
          ...s,
          currentQuestion: responseText,
          questionCount: s.questionCount + 1,
        }));

        this.speechService.speak(responseText);
      } else {
        responseText = await this.aiService.getNextMessageStreaming(
          session.chatHistory.filter((m) => !m.isTyping),
          session.resumeData,
          null,
          () => {
            this.speechService.phase.set("idle");
          },
        );

        this.removeMessage(typingId);
        this.isTyping.set(false);

        this._chatLog.push({ role: "assistant", content: responseText });
        this.addMessage({
          id: crypto.randomUUID(),
          role: "assistant",
          content: responseText,
          timestamp: new Date(),
        });

        this.session.update((s) => ({
          ...s,
          currentQuestion: responseText,
          questionCount: s.questionCount + 1,
        }));
      }
    } catch (err: any) {
      this.removeMessage(typingId);
      this.isTyping.set(false);
      this.addMessage({
        id: crypto.randomUUID(),
        role: "assistant",
        content: `⚠️ ${err.message || "Failed to get response."}`,
        timestamp: new Date(),
        isError: true,
      });
    }
  }

  addMessage(msg: ChatMessage): void {
    this.session.update((s) => ({
      ...s,
      chatHistory: [...s.chatHistory, msg],
    }));
  }

  private removeMessage(id: string): void {
    this.session.update((s) => ({
      ...s,
      chatHistory: s.chatHistory.filter((m) => m.id !== id),
    }));
  }

  private delay(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  /** Called by interview.component when Madeline's audio ends — starts pause timer */
  markMadelineFinished(question: string): void {
    this._madelineFinishedAt = Date.now();
    this._currentQuestion = question;
  }

  /** Called when user transcript arrives — records confidence for this turn */
  recordConfidenceTurn(answer: string): void {
    const pauseMs = this._madelineFinishedAt
      ? Date.now() - this._madelineFinishedAt
      : 6000;
    const words = answer.trim().split(/\s+/).filter(Boolean);
    const wordCount = words.length;

    // Extended filler word detection (case-insensitive)
    const fillerPattern =
      /\b(um+|uh+|like|you know|basically|sort of|kind of|right|so yeah|i mean|actually|literally|honestly|well|okay so|you see|alright|hmm+|err+|ah+|and so|you know what i mean|at the end of the day|to be honest|to be fair)\b/gi;
    const fillerCount = (answer.match(fillerPattern) || []).length;

    // Uncertainty / low-confidence signal detection
    const uncertaintyPattern =
      /\b(i don'?t know|not sure|i'?m not sure|i'?m unsure|i guess|maybe|perhaps|i think|i believe|probably|might be|could be|i'?m not certain|kind of|sort of)\b/gi;
    const uncertaintyCount = (answer.match(uncertaintyPattern) || []).length;

    // ── Word score (strictest weight) ─────────────────────
    // < 10 words  = very weak (likely deflecting or one-liner)
    // 10–30 words = minimal — partial credit
    // 30–100 words = solid answer range
    // 100–160 words = ideal range (detailed without rambling)
    // > 160 words  = slight rambling penalty
    let wordScore: number;
    if (wordCount < 10)
      wordScore = wordCount * 3; // 0–30
    else if (wordCount < 30)
      wordScore = 30 + ((wordCount - 10) / 20) * 25; // 30–55
    else if (wordCount < 60)
      wordScore = 55 + ((wordCount - 30) / 30) * 30; // 55–85
    else if (wordCount <= 160)
      wordScore = 85 + ((wordCount - 60) / 100) * 15; // 85–100
    else wordScore = Math.max(65, 100 - (wordCount - 160) / 8);

    // ── Pause score ────────────────────────────────────────
    // Fast response (< 1.5s) = very confident
    // 1.5–4s = normal thinking time
    // 4–9s   = noticeable hesitation
    // > 9s   = significant struggle
    let pauseScore: number;
    if (pauseMs < 1500) pauseScore = 100;
    else if (pauseMs < 4000)
      pauseScore = 100 - ((pauseMs - 1500) / 2500) * 25; // 75–100
    else if (pauseMs < 9000)
      pauseScore = 75 - ((pauseMs - 4000) / 5000) * 40; // 35–75
    else pauseScore = Math.max(10, 35 - ((pauseMs - 9000) / 1000) * 4);

    // ── Filler score ───────────────────────────────────────
    const fillerRate = wordCount > 0 ? fillerCount / wordCount : 0;
    let fillerScore: number;
    if (fillerRate < 0.02)
      fillerScore = 100; // < 2% — very clean
    else if (fillerRate < 0.06)
      fillerScore = 80; // occasional fillers
    else if (fillerRate < 0.12)
      fillerScore = 55; // frequent fillers
    else fillerScore = 25; // very filler-heavy

    // ── Uncertainty penalty (additive deduction) ────────────
    const uncertaintyPenalty = Math.min(35, uncertaintyCount * 12);

    // ── Composite score ────────────────────────────────────
    // Word count is the dominant factor — a meaningful answer is the baseline
    const rawScore =
      wordScore * 0.5 +
      pauseScore * 0.3 +
      fillerScore * 0.2 -
      uncertaintyPenalty;

    const score = Math.max(0, Math.min(100, Math.round(rawScore)));

    this._turnIndex++;
    const turn: ConfidenceTurn = {
      turnIndex: this._turnIndex,
      question: this._currentQuestion,
      answer,
      pauseMs,
      wordCount,
      fillerCount,
      score,
    };

    this.confidenceTurns.update((turns) => [...turns, turn]);
    this._madelineFinishedAt = null;
  }
}
