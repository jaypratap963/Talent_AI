// ─────────────────────────────────────────────
// components/chat-window/chat-window.component.ts
// INTERNAL USE ONLY — no visible UI rendered.
// The chat history is maintained in memory for
// AI context, evaluation, and future features.
// The avatar-based interview UI lives in
// interview.component instead.
// ─────────────────────────────────────────────

import {
  Component, Input, ChangeDetectionStrategy
} from '@angular/core';
import { ChatMessage } from '../../models/interview.models';

@Component({
  selector: 'app-chat-window',
  standalone: true,
  imports: [],
  template: `<!-- Chat history maintained internally; UI is avatar-based -->`,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ChatWindowComponent {
  /** Full chat history — used by parent for context, not displayed */
  @Input() messages: ChatMessage[] = [];

  /** Track by message ID for future use */
  trackById(_: number, msg: ChatMessage): string {
    return msg.id;
  }
}
