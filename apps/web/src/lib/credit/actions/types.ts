import type { CreditSessionStatus, DrawdownState } from '@balo/shared/credit';

/**
 * BAL-378 (ADR-1040 Lane 2) — pure result types for the credit-session Server Actions.
 *
 * Kept in a dependency-free module (NOT the `'use server'` action file, whose exports
 * must all be async functions, and NOT the server-only transport client) so a client
 * component can `import type { … }` them without dragging any server code into the
 * bundle (types are erased at compile time).
 */

/** A user-initiated mutation outcome the component layer toasts. */
export type ActionResult<T> =
  | { success: true; data: T }
  | { success: false; error: string; code?: string };

/** `POST /sessions` success body. */
export interface OpenSessionData {
  sessionId: string;
  status: CreditSessionStatus;
  holdId: string | null;
}

/**
 * `POST /sessions/:id/end` success body. Deliberately EXCLUDES `expertAccruedMinor` (the raw
 * pre-markup expert pay) — it is a fee/PII-boundary value that must never reach the client.
 */
export interface EndSessionData {
  settlementStatus: string;
  overdraftSettledMinor: number | null;
}

/** `POST /sessions/:id/connect` returns the freshly-derived drawdown state. */
export type ConnectSessionData = DrawdownState;
