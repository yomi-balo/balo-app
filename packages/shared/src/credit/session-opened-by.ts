/**
 * BAL-474 (ADR-1040 Amendment 7 §C, plan AD-5) — who OPENED a credit session: the
 * `credit_sessions.opened_by` vocabulary, restated here because `@balo/shared` cannot import
 * `@balo/db`'s enum (the dependency runs `@balo/db → @balo/shared`, never the reverse). Pinned
 * against the pgEnum — same set, same order — by
 * `packages/db/src/invariants/credit-session-opened-by-labels.test.ts`.
 *
 *   `client` — a client company member acted (BAL-466's admission, and every pre-BAL-474 row).
 *   `guest`  — a client-side, EMAIL-invited guest's admission opened it, ON BEHALF of the booker.
 *   `system` — a terminal path or the durability backstop opened it, ON BEHALF of the booker.
 *
 * ⚠ `initiating_member_id` is the booker on the two on-behalf labels — attribution only (D4): a
 * booker who has since left the company is NOT re-checked for `CONSUME_CREDITS`, and every
 * booker-addressed notice for an on-behalf session is gated on current membership instead (D5.7).
 */
export const CREDIT_SESSION_OPENED_BY = ['client', 'guest', 'system'] as const;

export type CreditSessionOpenedByLabel = (typeof CREDIT_SESSION_OPENED_BY)[number];
