/**
 * BAL-653 — the events the call toast owns. The one list both apps read: the web bell keeps them
 * out of the arrival toast and reads them by id on a case visit, and the db path sweep skips them.
 */
export const CALL_TOAST_EVENTS = ['call.ringing', 'call.no_answer'] as const;

export type CallToastEvent = (typeof CALL_TOAST_EVENTS)[number];

export function isCallToastEvent(event: string): event is CallToastEvent {
  return (CALL_TOAST_EVENTS as readonly string[]).includes(event);
}
