import type { CallNowPresence } from '@balo/analytics/events';
import type { CallNowConfirmView } from './call-now-types';

/**
 * The `presence` property on the Call now entry and confirm events. Only the client lens is ever
 * shown whether the expert is online; an expert calling a client is never told, so that arm
 * reports `'unknown'` rather than a value it never saw.
 */
export function callNowPresence(confirm: CallNowConfirmView | null): CallNowPresence {
  if (confirm?.kind !== 'client_terms') return 'unknown';
  return confirm.calleeOnline ? 'online' : 'offline';
}
