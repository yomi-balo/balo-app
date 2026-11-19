import type { CallNowPresence } from '@balo/analytics/events';

/**
 * The `callee_presence` property on the Call now events: `online` or `offline`, from the api's
 * `calleeOnline`. The api never reports real client presence to an expert caller, so that arm
 * always reads `offline` — the loader's value, not one the expert never saw.
 */
export function callNowPresence(input: { readonly calleeOnline: boolean }): CallNowPresence {
  return input.calleeOnline ? 'online' : 'offline';
}
