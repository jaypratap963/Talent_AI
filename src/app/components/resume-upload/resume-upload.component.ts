// ─────────────────────────────────────────────
// components/resume-upload/resume-upload.component.ts
// Handles drag-and-drop or click-to-upload PDF resume.
// Shows upload progress, extracted skills preview.
// ─────────────────────────────────────────────

import {
  Component, Output, EventEmitter, signal, inject
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ResumeParserService } from '../../services/resume-parser.service';
import { InterviewService } from '../../services/interview.service';
import { AiService } from '../../services/ai.service';
import { ResumeData } from '../../models/interview.models';

@Component({
  selector: 'app-resume-upload',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './resume-upload.component.html',
  styleUrls: ['./resume-upload.component.scss'],
})
export class ResumeUploadComponent {

  @Output() resumeReady = new EventEmitter<ResumeData>();

  private parser    = inject(ResumeParserService);
  private interview = inject(InterviewService);
  private aiService = inject(AiService);

  // ── Component State ───────────────────────────
  isDragOver   = signal(false);
  isProcessing = signal(false);
  errorMsg     = signal<string | null>(null);
  resume       = signal<ResumeData | null>(null);
  apiKey       = signal('');
  demoMode     = signal(false);

  // ── Drag and Drop ─────────────────────────────

  onDragOver(event: DragEvent): void {
    event.preventDefault();
    this.isDragOver.set(true);
  }

  onDragLeave(event: DragEvent): void {
    event.preventDefault();
    this.isDragOver.set(false);
  }

  onDrop(event: DragEvent): void {
    event.preventDefault();
    this.isDragOver.set(false);
    const file = event.dataTransfer?.files[0];
    if (file) this.processFile(file);
  }

  /** Triggered when user clicks "Browse" */
  onFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (file) this.processFile(file);
  }

  // ── File Processing ───────────────────────────

  /** Parses the uploaded file and stores resume data */
  async processFile(file: File): Promise<void> {
    this.errorMsg.set(null);
    this.isProcessing.set(true);

    try {
      const data = await this.parser.parseFile(file);
      this.resume.set(data);
      this.interview.setResumeData(data);
    } catch (err: any) {
      this.errorMsg.set(err.message || 'Failed to parse resume');
    } finally {
      this.isProcessing.set(false);
    }
  }

  // ── Configuration ─────────────────────────────

  /** User enters their OpenAI key; stored in memory only */
  onApiKeyChange(value: string): void {
    this.apiKey.set(value);
    this.aiService.setApiKey(value);
  }

  /** Proceed to interview with either real AI or demo mode */
  startInterview(): void {
    if (!this.resume()) return;
    this.resumeReady.emit(this.resume()!);
  }

  toggleDemoMode(): void {
    this.demoMode.update(v => !v);
    if (this.demoMode()) {
      this.apiKey.set('');
    }
  }

  removeResume(): void {
    this.resume.set(null);
    this.errorMsg.set(null);
  }
}
