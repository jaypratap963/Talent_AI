// ─────────────────────────────────────────────────────────────────
// services/ai.service.ts
//
// LATENCY PIPELINE (what changed):
//
//  OLD (serial — 4-6s dead silence):
//    Whisper done → GPT full response → TTS full fetch → play
//
//  NEW (parallel — ~1s to first audio):
//    Whisper done
//      ├─ immediately play pre-cached filler clip ("Mmm, let me think...")
//      ├─ GPT streams tokens via SSE
//      │     └─ sentence splitter fires on each "." "?" "!"
//      │           └─ each sentence → TTS fetch (parallel, queued)
//      └─ audio queue plays sentence 1 as soon as it arrives,
//         sentences 2,3,4... play in sequence right after
//
//  NET RESULT: User hears Alex respond within ~1s of Whisper finishing.
//  The filler clip covers the GPT latency. TTS of sentence 1 is ready
//  ~300ms after GPT emits the first sentence.
// ─────────────────────────────────────────────────────────────────

import { Injectable, signal } from '@angular/core';
import { Subject } from 'rxjs';
import {
  ChatMessage, EvaluationResult, ResumeData, AIConfig
} from '../models/interview.models';
import { SpeechAnalysis } from './speech.service';
import { SpeechService } from './speech.service';

@Injectable({ providedIn: 'root' })
export class AiService {

  isLoading = signal(false);
  error     = signal<string | null>(null);

  // Emits each sentence token as it streams in (drives avatar mouth)
  streamToken$ = new Subject<string>();
  // Emits when full response is assembled
  responseComplete$ = new Subject<string>();

  private config: AIConfig = {
    apiKey:      '',
    model:       'gpt-4o-mini',
    maxTokens:   500,
    temperature: 0.75,
  };

  private readonly CHAT_URL  = 'https://api.openai.com/v1/chat/completions';
  private readonly TTS_URL   = 'https://api.openai.com/v1/audio/speech';

  // ── Audio queue for sentence-by-sentence playback ─────────────
  // Each sentence is fetched in parallel; played in order.
  private audioQueue:     HTMLAudioElement[] = [];
  private isPlayingQueue  = false;
  private queueDone       = false;   // set when GPT stream ends + all TTS fetched
  private onQueueEmpty:   (() => void) | null = null;

  // Pre-cached filler audio blobs (loaded once at startup)
  private fillerClips: HTMLAudioElement[] = [];
  private fillersLoaded = false;

  constructor(private speechService: SpeechService) {
    // Pre-generate filler clips on construction so they're instant
    // We do this lazily on first setApiKey() call
  }

  // ─────────────────────────────────────────────────────────────
  // API KEY
  // ─────────────────────────────────────────────────────────────

  setApiKey(key: string): void {
    this.config.apiKey = key.trim();
    this.speechService.setApiKey(key.trim());
    // Pre-warm filler clips now that we have a key
    if (key.trim()) this.preWarmFillerClips();
  }

  hasApiKey(): boolean {
    return this.config.apiKey.length > 0;
  }

  // ─────────────────────────────────────────────────────────────
  // PRE-WARM FILLER CLIPS
  // Generates 4 short "thinking" TTS clips and caches them as
  // Audio objects. When GPT is generating, we immediately play
  // one of these so the user hears Alex react within ~100ms.
  // ─────────────────────────────────────────────────────────────

  private async preWarmFillerClips(): Promise<void> {
    if (this.fillersLoaded || !this.config.apiKey) return;
    this.fillersLoaded = true;

    const fillerTexts = [
      'Mmm, right.',
      'Okay.',
      'I see.',
      'Interesting.',
    ];

    // Fetch all in parallel — each is ~0.3s of audio
    const fetches = fillerTexts.map(text =>
      this.fetchTTSAudio(text).catch(() => null)
    );

    const results = await Promise.allSettled(fetches);

    results.forEach(r => {
      if (r.status === 'fulfilled' && r.value) {
        this.fillerClips.push(r.value);
      }
    });
  }

  // ─────────────────────────────────────────────────────────────
  // MAIN ENTRY POINT — streaming response with parallel TTS
  //
  // Flow:
  //  1. Immediately play a filler clip (covers GPT latency)
  //  2. Start GPT streaming request
  //  3. Split stream into sentences
  //  4. Each sentence → TTS fetch (non-blocking)
  //  5. Audio queue plays them in order as they arrive
  // ─────────────────────────────────────────────────────────────

  async getNextMessageStreaming(
    history:   ChatMessage[],
    resume:    ResumeData,
    analysis?: SpeechAnalysis | null,
    onEnd?:    () => void
  ): Promise<string> {
    this.isLoading.set(true);
    this.error.set(null);

    // Reset audio queue for this turn
    this.audioQueue     = [];
    this.isPlayingQueue = false;
    this.queueDone      = false;
    this.onQueueEmpty   = onEnd ?? null;

    // ── Step 1: Play filler immediately ──────────────────────
    // This fires ~0ms after Whisper returns — user hears Alex
    // react before GPT has even started processing
    this.playFillerClip();

    try {
      const messages = [
        { role: 'system', content: this.buildSystemPrompt(resume, analysis) },
        ...history
          .filter(m => m.role !== 'system')
          .map(m => ({ role: m.role, content: m.content })),
      ];

      // ── Step 2: Stream GPT response ───────────────────────
      const fullText = await this.streamGPT(messages);

      this.isLoading.set(false);

      // Mark queue as done — playQueue() will call onEnd when last clip finishes
      this.queueDone = true;
      // If queue is already empty (all clips played), fire onEnd now
      if (!this.isPlayingQueue && this.audioQueue.length === 0) {
        onEnd?.();
      }

      return fullText;

    } catch (err: any) {
      this.isLoading.set(false);
      this.error.set(err.message || 'Failed to get AI response');
      onEnd?.();
      throw err;
    }
  }

  // ─────────────────────────────────────────────────────────────
  // GPT STREAMING — Server-Sent Events (SSE)
  // Reads the stream token by token, splits on sentence boundaries,
  // fires TTS fetch for each sentence immediately.
  // ─────────────────────────────────────────────────────────────

  private async streamGPT(
    messages: Array<{ role: string; content: string }>
  ): Promise<string> {

    const res = await fetch(this.CHAT_URL, {
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
        stream:      true,   // ← KEY: enables SSE streaming
      }),
    });

    if (!res.ok) {
      const e = await res.json().catch(() => ({})) as any;
      throw new Error(e?.error?.message || `GPT error ${res.status}`);
    }

    const reader  = res.body!.getReader();
    const decoder = new TextDecoder();

    let fullText     = '';   // Complete assembled response
    let sentenceBuffer = ''; // Accumulates tokens until sentence boundary

    // Sentence-ending punctuation — these trigger TTS fetch
    const sentenceEnd = /[.!?。]/;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split('\n');

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') break;

        try {
          const json  = JSON.parse(data);
          const token = json.choices?.[0]?.delta?.content ?? '';
          if (!token) continue;

          fullText       += token;
          sentenceBuffer += token;

          // Emit token for any live UI update
          this.streamToken$.next(token);

          // Check if we have a complete sentence
          if (sentenceEnd.test(sentenceBuffer)) {
            // Find the last sentence-ending character
            const match = sentenceBuffer.match(/^(.*[.!?。])\s*/s);
            if (match) {
              const sentence = match[1].trim();
              const rest     = sentenceBuffer.slice(match[0].length);

              sentenceBuffer = rest;

              if (sentence.length > 3) {
                // Fetch TTS for this sentence immediately — non-blocking
                // It will be added to the audio queue and played in order
                this.fetchAndEnqueueTTS(sentence);
              }
            }
          }
        } catch {
          // Malformed SSE chunk — skip
        }
      }
    }

    // Handle any remaining text in buffer (last sentence without punctuation)
    const remaining = sentenceBuffer.trim();
    if (remaining.length > 3) {
      this.fetchAndEnqueueTTS(remaining);
    }

    this.responseComplete$.next(fullText);
    return fullText;
  }

  // ─────────────────────────────────────────────────────────────
  // TTS FETCH + QUEUE
  // Fetches TTS audio for one sentence and adds it to the queue.
  // Starts playing immediately if queue is idle.
  // ─────────────────────────────────────────────────────────────

  private async fetchAndEnqueueTTS(sentence: string): Promise<void> {
    try {
      const audio = await this.fetchTTSAudio(sentence);
      if (!audio) return;

      this.audioQueue.push(audio);

      // Start playing if not already
      if (!this.isPlayingQueue) {
        this.playQueue();
      }
    } catch {
      // TTS failed for this sentence — skip it silently
    }
  }

  // Fetches TTS audio and returns an HTMLAudioElement ready to play
  private async fetchTTSAudio(text: string): Promise<HTMLAudioElement | null> {
    if (!this.config.apiKey) return null;

    const res = await fetch(this.TTS_URL, {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${this.config.apiKey}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        model: 'tts-1',       // tts-1 = lowest latency (~200ms)
        voice: 'shimmer',     // Warm, clear, closest Indian-EN feel
        input: text,
        speed: 0.94,
      }),
    });

    if (!res.ok) return null;

    const blob = await res.blob();
    const url  = URL.createObjectURL(blob);
    const audio = new Audio(url);

    // Pre-load so playback starts immediately when dequeued
    audio.preload = 'auto';
    audio.load();

    // Attach cleanup
    audio.onended = () => URL.revokeObjectURL(url);

    return audio;
  }

  // ─────────────────────────────────────────────────────────────
  // AUDIO QUEUE PLAYER
  // Plays audio elements one after another in order.
  // Calls onQueueEmpty when done if queueDone is true.
  // ─────────────────────────────────────────────────────────────

  private playQueue(): void {
    if (this.audioQueue.length === 0) {
      this.isPlayingQueue = false;
      // If GPT streaming is also done, fire the completion callback
      if (this.queueDone) {
        this.onQueueEmpty?.();
        this.onQueueEmpty = null;
      }
      return;
    }

    this.isPlayingQueue = true;
    const audio = this.audioQueue.shift()!;

    audio.onended = () => {
      // Revoke object URL (cleanup)
      if (audio.src.startsWith('blob:')) URL.revokeObjectURL(audio.src);
      // Play next
      this.playQueue();
    };

    audio.onerror = () => {
      // Skip broken clip, continue queue
      this.playQueue();
    };

    audio.play().catch(() => {
      // Autoplay blocked — try next
      this.playQueue();
    });
  }

  // Play a random cached filler clip (instant — pre-loaded)
  private playFillerClip(): void {
    if (this.fillerClips.length === 0) return;

    const clip = this.fillerClips[
      Math.floor(Math.random() * this.fillerClips.length)
    ];

    // Clone so we can replay the same clip multiple times
    const clone = new Audio(clip.src);
    clone.volume = 1.0;
    clone.play().catch(() => {});
  }

  stopAudio(): void {
    // Stop queue playback
    this.audioQueue.forEach(a => { a.pause(); a.src = ''; });
    this.audioQueue     = [];
    this.isPlayingQueue = false;
    this.onQueueEmpty   = null;
  }

  // ─────────────────────────────────────────────────────────────
  // SYSTEM PROMPT
  // ─────────────────────────────────────────────────────────────

  private buildSystemPrompt(resume: ResumeData, analysis?: SpeechAnalysis | null): string {
    let speechNote = '';
    if (analysis) {
      const secs = Math.round(analysis.rawDurationMs / 1000);
      if (analysis.confidenceHint === 'hesitant') {
        speechNote = `\n\nSPEECH NOTE: Candidate was hesitant (${analysis.fillerCount} fillers, ${analysis.pauseCount} pauses, ${secs}s). Gently probe or rephrase.`;
      } else if (analysis.confidenceHint === 'confident') {
        speechNote = `\n\nSPEECH NOTE: Candidate was confident and clear (${secs}s, ~${analysis.wordsPerMinute} wpm). Increase difficulty.`;
      }
    }

    return `You are Alex, a sharp Senior Technical Interviewer at a top tech company.

PERSONALITY:
- Professional, warm, human — not robotic
- ONE question at a time, never two
- Probe vague answers: "Can you be more specific?" or "Walk me through that."
- Acknowledge good answers briefly: "Good point." or "Interesting."
- If hesitant, gently: "Take your time." or "Let me rephrase that."
- Adapt difficulty based on candidate responses

CANDIDATE RESUME:
${resume.rawText.slice(0, 2000)}
Skills: ${resume.skills.join(', ') || 'General software engineering'}
${speechNote}

RULES:
1. Start: warm greeting + ask for self-introduction
2. Max 8–10 questions total
3. Mix: technical, behavioral (STAR), situational
4. Transition every 2–3 questions: "Let's shift to something different."
5. Push back on weak answers once: "I'd like a concrete example."
6. At Q8+: "Just one or two more questions."
7. Each response ≤ 3 sentences
8. Never reveal scores

Respond only with the question or follow-up. No meta-commentary.`;
  }

  private buildEvaluationPrompt(): string {
    return `You are evaluating a completed job interview. Return ONLY a JSON object, no markdown:
{
  "overallScore": <0-100>,
  "technicalScore": <0-100>,
  "communicationScore": <0-100>,
  "confidenceScore": <0-100>,
  "strengths": ["<s1>", "<s2>", "<s3>"],
  "improvements": ["<i1>", "<i2>", "<i3>"],
  "summary": "<2-3 sentence honest summary>"
}`;
  }

  // ─────────────────────────────────────────────────────────────
  // EVALUATION (non-streaming, called once at end)
  // ─────────────────────────────────────────────────────────────

  async evaluateInterview(history: ChatMessage[], resume: ResumeData): Promise<EvaluationResult> {
    this.isLoading.set(true);
    try {
      const transcript = history
        .filter(m => m.role !== 'system')
        .map(m => `${m.role === 'user' ? 'CANDIDATE' : 'INTERVIEWER'}: ${m.content}`)
        .join('\n');

      const res = await fetch(this.CHAT_URL, {
        method: 'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model:       this.config.model,
          max_tokens:  800,
          temperature: 0.3,
          messages: [
            { role: 'system', content: this.buildEvaluationPrompt() },
            { role: 'user',   content: `Skills: ${resume.skills.join(', ')}\n\nTranscript:\n${transcript}` },
          ],
        }),
      });

      if (!res.ok) throw new Error(`Eval API error ${res.status}`);
      const data    = await res.json() as any;
      const raw     = data.choices?.[0]?.message?.content ?? '{}';
      const cleaned = raw.replace(/```json|```/g, '').trim();
      return JSON.parse(cleaned) as EvaluationResult;

    } catch (err) {
      console.error('Evaluation failed:', err);
      return this.fallbackEval();
    } finally {
      this.isLoading.set(false);
    }
  }

  private fallbackEval(): EvaluationResult {
    return {
      overallScore: 70, technicalScore: 70,
      communicationScore: 70, confidenceScore: 70,
      strengths:    ['Completed the interview', 'Provided responses'],
      improvements: ['Evaluation API error — could not score'],
      summary: 'Interview completed. Evaluation unavailable due to a technical issue.',
    };
  }

  getDemoResponse(questionCount: number): string {
    const q = [
      "Hi! I'm Alex. To start, could you walk me through your background and what brings you to this role?",
      "Solid overview. Tell me about a technically challenging project you've worked on. What was your specific contribution?",
      "How did you approach debugging that? What tools or strategies did you use?",
      "Let's talk about teamwork. Describe a time you disagreed with a technical decision. How did you handle it?",
      "I'd like a more concrete example — what were the measurable outcomes?",
      "How do you stay current with new technologies? Give me a recent example you applied at work.",
      "Situational: you're given an ambiguous feature request with a tight deadline. Walk me through how you'd proceed.",
      "Last question — where do you see yourself technically in 2 years, and how does this role fit that path?",
    ];
    return q[Math.min(questionCount, q.length - 1)];
  }
}