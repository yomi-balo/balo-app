import type { CreditSessionStatus, EligibleCompany } from '@balo/shared/credit';

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

/**
 * BAL-401 — `openSessionAction` outcome. Distinct from the shared generic `ActionResult<T>` (kept
 * pristine for connect/end/nudge) because a failure MAY carry the eligible companies when the api
 * returns `company_selection_required` (>1 CONSUME_CREDITS company, none chosen).
 */
export type OpenSessionActionResult =
  | { success: true; data: OpenSessionData }
  | { success: false; error: string; code?: string; companies?: EligibleCompany[] };

/** `POST /sessions` success body. */
export interface OpenSessionData {
  sessionId: string;
  status: CreditSessionStatus;
  holdId: string | null;
}

/**
 * ⚠ BAL-466 (F1, review fix round) — `EndSessionData` / `ConnectSessionData` were removed:
 * `endSessionAction` and `connectSessionAction` (their only consumers) were deleted from
 * `session-mutations.ts` — a `'presence'` session's lifecycle is system-only. If a route-facing
 * end/connect Server Action is ever legitimately needed again (never for a `'presence'`
 * session — the api itself refuses that), reintroduce the type alongside it rather than
 * resurrecting a dead export ahead of a caller.
 */
