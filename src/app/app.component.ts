// ─────────────────────────────────────────────
// app.component.ts
// Root component — acts as the page router.
// Shows either the ResumeUpload screen or the
// Interview screen based on application state.
// ─────────────────────────────────────────────

import { Component, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ResumeUploadComponent } from './components/resume-upload/resume-upload.component';
import { InterviewComponent } from './components/interview/interview.component';
import { InterviewService } from './services/interview.service';
import { ResumeData } from './models/interview.models';

type AppScreen = 'upload' | 'interview';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, ResumeUploadComponent, InterviewComponent],
  template: `
    @switch (currentScreen()) {
      @case ('upload') {
        <app-resume-upload (resumeReady)="onResumeReady($event)" />
      }
      @case ('interview') {
        <app-interview />
      }
    }
  `,
})
export class AppComponent {

  currentScreen = signal<AppScreen>('upload');

  constructor(private interviewService: InterviewService) {
    // If we navigate back from interview, listen for reset
  }

  /** Called when the upload screen emits a ready resume */
  onResumeReady(resume: ResumeData): void {
    // Resume is already stored in InterviewService by the upload component
    this.currentScreen.set('interview');
  }
}
