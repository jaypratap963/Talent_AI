// ─────────────────────────────────────────────
// models/interview.models.ts
// All shared TypeScript interfaces for the app
// ─────────────────────────────────────────────

/** A single message in the chat history */
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: Date;
  isTyping?: boolean;       // true while the AI "types" the response
  isError?: boolean;        // true if message failed
}

/** Parsed resume data */
export interface ResumeData {
  fileName: string;
  rawText: string;
  skills: string[];         // extracted skill keywords
  experience: string[];     // job titles / companies found
  uploadedAt: Date;
}

/** Interview session state */
export interface InterviewSession {
  id: string;
  status: 'idle' | 'active' | 'paused' | 'completed';
  resumeData: ResumeData | null;
  chatHistory: ChatMessage[];
  currentQuestion: string;
  questionCount: number;
  startedAt: Date | null;
  completedAt: Date | null;
  evaluation: EvaluationResult | null;
}

/** Per-answer evaluation from the AI */
export interface EvaluationResult {
  overallScore: number;       // 0–100
  technicalScore: number;
  communicationScore: number;
  confidenceScore: number;
  strengths: string[];
  improvements: string[];
  summary: string;
}

/** Voice/speech state */
export interface SpeechState {
  isListening: boolean;
  isSpeaking: boolean;
  isSupported: boolean;
  transcript: string;
  error: string | null;
}

/** Configuration for OpenAI API calls */
export interface AIConfig {
  apiKey: string;
  model: string;
  maxTokens: number;
  temperature: number;
}
