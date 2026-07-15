import type { EmailAttachmentSpec } from '@balo/shared/notifications';

export interface DeliveryPayload {
  recipientId: string;
  /**
   * Literal recipient email, set only for non-user recipients (e.g. the `admin`
   * ops inbox). When present, the email channel uses it directly and bypasses the
   * `usersRepository.findById` lookup.
   */
  recipientEmail?: string;
  template: string;
  event: string;
  data: Record<string, unknown>;
  payload: Record<string, unknown>;
  /**
   * BAL-386: optional email attachments carried from the event payload. The email
   * adapter resolves each spec's bytes (from R2) at send time — the BullMQ payload
   * stays light. Forwarded by the dispatcher from `context.payload.attachments`.
   */
  attachments?: EmailAttachmentSpec[];
}

export interface DeliveryResult {
  success: boolean;
  provider: string;
  providerMessageId?: string;
  error?: string;
}
