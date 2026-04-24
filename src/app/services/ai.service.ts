// ─────────────────────────────────────────────
// services/ai.service.ts
// Handles all communication with OpenAI Chat API.
// Now accepts SpeechAnalysis to adapt interviewer
// tone and difficulty based on how the candidate spoke.
// ─────────────────────────────────────────────

import { Injectable, signal } from '@angular/core';
import { ChatMessage, EvaluationResult, ResumeData, AIConfig } from '../models/interview.models';
import { SpeechAnalysis } from './speech.service';
import { SpeechService } from './speech.service';

@Injectable({ providedIn: 'root' })
export class AiService {

  isLoading = signal(false);
  error     = signal<string | null>(null);

  private config: AIConfig = {
    apiKey:      '',
    model:       'gpt-4o-mini',
    maxTokens:   600,
    temperature: 0.7,
  };

  private readonly OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

  // Inject SpeechService so setApiKey propagates to it automatically
  constructor(private speechService: SpeechService) {}

  // ── API Key ───────────────────────────────────

  setApiKey(key: string): void {
    this.config.apiKey = key.trim();
    // Keep speech service in sync — it needs the key for Whisper + TTS
    this.speechService.setApiKey(key.trim());
  }

  hasApiKey(): boolean {
    return this.config.apiKey.length > 0;
  }

  // ── System Prompt ─────────────────────────────

  /**
   * Builds the interviewer system prompt.
   * If speech analysis is provided, it appends a coaching note
   * so Alex can react to HOW the candidate answered (not just what).
   */
  private buildSystemPrompt(resume: ResumeData, analysis?: SpeechAnalysis | null): string {
    // Build dynamic coaching note from speech analysis
    let speechNote = '';
    if (analysis) {
      const secs = Math.round(analysis.rawDurationMs / 1000);

      if (analysis.confidenceHint === 'hesitant') {
        speechNote = `
SPEECH ANALYSIS OF LAST ANSWER:
- Confidence level : HESITANT
- Fillers detected : ${analysis.hasFillers ? 'Yes (um/uh/like etc.)' : 'No'}
- Notable pauses   : ${analysis.pauseCount}
- Answer duration  : ${secs}s
→ The candidate sounded uncertain. Either gently probe deeper ("You seemed to hesitate — 
  can you elaborate on that point?") or ask a supportive follow-up to give them another 
  chance to demonstrate knowledge. Do NOT embarrass them, but do note the hesitation.`;

      } else if (analysis.confidenceHint === 'confident') {
        speechNote = `
SPEECH ANALYSIS OF LAST ANSWER:
- Confidence level : CONFIDENT
- Fillers detected : ${analysis.hasFillers ? 'Minor' : 'None'}
- Answer duration  : ${secs}s
→ Strong, clear delivery. You may increase question difficulty or ask a more nuanced 
  follow-up. Acknowledge briefly: "Good answer." then move forward.`;

      } else {
        speechNote = `
SPEECH ANALYSIS OF LAST ANSWER:
- Confidence level : MIXED
- Fillers detected : ${analysis.hasFillers ? 'Yes' : 'No'}
- Answer duration  : ${secs}s
→ Answer was reasonable but delivery was uneven. Ask a standard follow-up or transition.`;
      }
    }

    return `You are Alex, a sharp and experienced Senior Technical Interviewer at a top tech company.

PERSONALITY:
- Professional but human — warm tone, not robotic
- Ask ONE focused question at a time, never two at once
- Probe weak or vague answers: "Can you be more specific?" or "Walk me through that concretely"
- Acknowledge strong answers briefly: "Good point." or "Interesting approach."
- Do NOT accept buzzword-stuffing without substance — push back politely
- Adapt difficulty: if candidate struggles, ask an easier follow-up; if confident, increase challenge

CANDIDATE RESUME:
${resume.rawText.slice(0, 2000)}
Key skills: ${resume.skills.join(', ') || 'General software engineering'}
${speechNote}

INTERVIEW RULES:
1. Start with a warm greeting and ask the candidate to introduce themselves
2. Ask maximum 8–10 questions total across the session
3. Mix question types: technical, behavioral (STAR), situational
4. After every 2–3 questions, brief transition: "Let's shift to something different."
5. If the answer is weak, push back once: "I'd like a more concrete example."
6. At question 8+, tell the candidate you have 1–2 more questions
7. Keep each response under 3 sentences
8. NEVER reveal evaluation scores during the interview

OUTPUT FORMAT: Respond only with the interview question or follow-up. No meta-commentary.`;
  }

  private buildEvaluationPrompt(): string {
    return `You are evaluating a completed job interview. Analyze the full conversation and return a JSON object ONLY (no markdown, no explanation) with this exact structure:
{
  "overallScore": <0-100>,
  "technicalScore": <0-100>,
  "communicationScore": <0-100>,
  "confidenceScore": <0-100>,
  "strengths": ["<strength1>", "<strength2>", "<strength3>"],
  "improvements": ["<area1>", "<area2>", "<area3>"],
  "summary": "<2-3 sentence honest professional summary>"
}`;
  }

  // ── Core API Call ─────────────────────────────

  private async callOpenAI(messages: Array<{ role: string; content: string }>): Promise<string> {
    if (!this.hasApiKey()) {
      throw new Error('No API key set. Please enter your OpenAI API key.');
    }

    const response = await fetch(this.OPENAI_URL, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        model:       this.config.model,
        messages,
        max_tokens:  this.config.maxTokens,
        temperature: this.config.temperature,
      }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      const msg = (errorData as any)?.error?.message || `API error ${response.status}`;
      throw new Error(msg);
    }

    const data = await response.json() as any;
    return data.choices?.[0]?.message?.content?.trim() ?? '';
  }

  // ── Public Methods ────────────────────────────

  /**
   * Gets the next AI question.
   * Accepts optional speech analysis so the prompt adapts
   * to the candidate's vocal confidence and delivery.
   */
  async getNextMessage(
    history:  ChatMessage[],
    resume:   ResumeData,
    analysis?: SpeechAnalysis | null
  ): Promise<string> {
    this.isLoading.set(true);
    this.error.set(null);

    try {
      const messages = [
        { role: 'system', content: this.buildSystemPrompt(resume, analysis) },
        ...history
          .filter(m => m.role !== 'system')
          .map(m => ({ role: m.role, content: m.content })),
      ];
      return await this.callOpenAI(messages);
    } catch (err: any) {
      this.error.set(err.message || 'Failed to get AI response');
      throw err;
    } finally {
      this.isLoading.set(false);
    }
  }

  async evaluateInterview(history: ChatMessage[], resume: ResumeData): Promise<EvaluationResult> {
    this.isLoading.set(true);

    try {
      const conversationText = history
        .filter(m => m.role !== 'system')
        .map(m => `${m.role === 'user' ? 'CANDIDATE' : 'INTERVIEWER'}: ${m.content}`)
        .join('\n');

      const messages = [
        { role: 'system', content: this.buildEvaluationPrompt() },
        {
          role:    'user',
          content: `Resume context: ${resume.skills.join(', ')}\n\nInterview transcript:\n${conversationText}`,
        },
      ];

      const raw     = await this.callOpenAI(messages);
      const cleaned = raw.replace(/```json|```/g, '').trim();
      return JSON.parse(cleaned) as EvaluationResult;

    } catch (err: any) {
      console.error('Evaluation failed:', err);
      return this.getFallbackEvaluation();
    } finally {
      this.isLoading.set(false);
    }
  }

  private getFallbackEvaluation(): EvaluationResult {
    return {
      overallScore:        70,
      technicalScore:      70,
      communicationScore:  70,
      confidenceScore:     70,
      strengths:    ['Completed the interview', 'Provided responses to questions'],
      improvements: ['Could not evaluate — API error occurred'],
      summary: 'Interview completed. Evaluation could not be fully processed due to a technical issue.',
    };
  }

  getDemoResponse(questionCount: number): string {
    const demoQuestions = [
      "Hi! I'm Alex, and I'll be conducting your interview today. To get started, could you walk me through your background and what brings you to this role?",
      "That's a solid overview. Can you tell me about a technically challenging project you've worked on recently? What was your specific contribution?",
      "Interesting. How did you approach debugging that? What tools or strategies did you use?",
      "Let's talk about teamwork. Describe a situation where you disagreed with a technical decision your team made. How did you handle it?",
      "I'd like a more concrete example of the outcome — what metrics or results came from that?",
      "Let's shift gears. How do you stay current with new technologies? Can you give me an example where you applied something you recently learned?",
      "Good. Now a situational question: if you were given an ambiguous feature request with a tight deadline, how would you proceed?",
      "We're almost done. Last question — where do you see yourself technically in the next 2 years, and how does this role fit into that?",
    ];
    return demoQuestions[Math.min(questionCount, demoQuestions.length - 1)];
  }
}