import { log } from './index';

/**
 * Predefined business events for consistent naming.
 * Add new events here as you build features.
 *
 * Naming convention: entity_action (lowercase, underscore)
 */
export type BusinessEvent =
  // Auth events
  | 'user_signed_up'
  | 'user_logged_in'
  | 'user_logged_out'
  // Case events
  | 'case_created'
  | 'case_updated'
  | 'case_resolved'
  // Consultation events
  | 'consultation_requested'
  | 'consultation_booked'
  | 'consultation_started'
  | 'consultation_completed'
  | 'consultation_cancelled'
  // Payment events
  | 'payment_initiated'
  | 'payment_completed'
  | 'payment_failed'
  | 'payout_requested'
  // Message events
  | 'message_sent'
  | 'attachment_uploaded'
  // Profile events
  | 'profile_updated'
  | 'availability_updated';

/**
 * Log a business event with consistent structure.
 * userId and requestId are automatically attached via context.
 *
 * @example
 * logEvent('consultation_booked', {
 *   consultantId: 'abc',
 *   caseId: '123',
 *   amount: 150,
 * });
 */
export function logEvent(event: BusinessEvent, data?: Record<string, unknown>) {
  log.info(`[EVENT] ${event}`, {
    event,
    eventData: data,
    timestamp: new Date().toISOString(),
  });
}

/**
 * Log a business event with explicit userId (for cases where
 * the action affects a different user than the requester).
 *
 * @example
 * logEventForUser('consultation_cancelled', targetUserId, {
 *   cancelledBy: adminUserId,
 *   reason: 'no_show',
 * });
 */
export function logEventForUser(
  event: BusinessEvent,
  targetUserId: string,
  data?: Record<string, unknown>
) {
  log.info(`[EVENT] ${event}`, {
    event,
    targetUserId,
    eventData: data,
    timestamp: new Date().toISOString(),
  });
}
