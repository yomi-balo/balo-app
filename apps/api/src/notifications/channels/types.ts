import type { EmailAttachmentSpec } from '@balo/shared/notifications';
import type { CalendarInviteSpec } from '../calendar-invite-spec.js';

interface DeliveryPayloadBase {
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
}

/** STANDARD class — the Brevo transactional API, optional R2 attachments. */
interface StandardDeliveryPayload extends DeliveryPayloadBase {
  /**
   * BAL-386: optional email attachments carried from the event payload. The email
   * adapter resolves each spec's bytes (from R2) at send time — the BullMQ payload
   * stays light. Forwarded by the dispatcher from `context.payload.attachments`.
   */
  attachments?: EmailAttachmentSpec[];
  calendarInvite?: never;
}

/**
 * CALENDAR class (BAL-475) — the Brevo SMTP relay, nodemailer `icalEvent`.
 *
 * ⚠ NO OTHER ATTACHMENTS, BY TYPE (ADR-1044 Ruling 4 guardrail 2) — `attachments` is
 * unrepresentable on this arm, not merely unused, so a calendar-class message can never carry
 * one. BullMQ job data is untyped JSON at runtime, so the channel ALSO enforces this at runtime
 * (`channels/calendar-invite-delivery.ts` step 0).
 */
interface CalendarDeliveryPayload extends DeliveryPayloadBase {
  calendarInvite: CalendarInviteSpec;
  attachments?: never;
}

export type DeliveryPayload = StandardDeliveryPayload | CalendarDeliveryPayload;

export interface DeliveryResult {
  success: boolean;
  provider: string;
  providerMessageId?: string;
  error?: string;
}
