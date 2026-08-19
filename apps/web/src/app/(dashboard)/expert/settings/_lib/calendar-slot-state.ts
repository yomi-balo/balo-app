import type { CalendarConnection } from '../_types/calendar';

/** Client-owned, per provider. Never persisted, never derived from the server. */
export type CalendarTransientState =
  | 'connecting' // OAuth round trip in flight for THIS provider
  | 'o365_guidance' // microsoft only — pre-OAuth admin-consent explainer is open
  | 'o365_waiting' // microsoft only — callback said o365_admin_approval
  | 'attempt_failed'; // the OAuth round trip for THIS provider came back an error, or timed out

export type CalendarSlotState =
  | 'idle'
  | 'connecting'
  | 'o365_guidance'
  | 'o365_waiting'
  | 'attempt_failed'
  | 'setting_up'
  | 'connected'
  | 'reconnect_needed';

export interface DeriveSlotStateInput {
  readonly connection: CalendarConnection | undefined;
  readonly transient: CalendarTransientState | undefined;
}

/**
 * The per-provider slot state machine, as a pure function so it is unit-testable without
 * React. See plan §4.5 for the full transition table that drives `transient`.
 */
export function deriveSlotState({
  connection,
  transient,
}: DeriveSlotStateInput): CalendarSlotState {
  // Transients that describe an IN-FLIGHT interaction always win — the expert is mid-flow.
  if (transient === 'o365_guidance') return 'o365_guidance';
  if (transient === 'o365_waiting') return 'o365_waiting';
  if (transient === 'connecting') return 'connecting';

  // A FAILED attempt only takes the card when there is nothing else to show. If a live row
  // exists, that row's own status is the truth (a failed reconnect on an EXPIRED credential is
  // still "reconnect needed" — the failure is reported by a toast, not by hiding the state that
  // tells the expert what to do next).
  if (transient === 'attempt_failed' && connection === undefined) return 'attempt_failed';
  if (connection === undefined) return 'idle';

  switch (connection.credentialStatus) {
    case 'ACTIVE':
      return 'connected';
    case 'SYNC_PENDING':
      return 'setting_up';
    case 'EXPIRED':
    case 'REVOKED':
      // apiroc skill: "build no distinct UX for the two". ONE state, two wire values.
      return 'reconnect_needed';
    default: {
      const exhaustive: never = connection.credentialStatus;
      return exhaustive;
    }
  }
}
