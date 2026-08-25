/**
 * BAL-283 — `bookIntroCallAction`'s wire types. Kept in a SIBLING, non-`'use server'` module
 * because `book-intro-call.ts` is `'use server'`, and a `'use server'` module may export ONLY
 * async functions (memory `reference_use_server_no_value_exports`) — mirrors
 * `actions/types.ts`'s own split for the same reason.
 *
 * ⚠ `BookingFailureCode` (`actions/types.ts`) is deliberately NOT reused here. Five of its nine
 * members are case/company-shaped (`case_not_available`, `company_selection_required`,
 * `no_eligible_company`, `company_not_eligible`, `idempotency_key_conflict`) and would be
 * permanently unreachable on this money-free, case-free, single-company-agnostic surface.
 */

import type { SlotDurationMinutes } from '@balo/shared/availability';
// ⚠ ONE DEFINITION OF THE SURFACE LIST (round-1 W10). `ConversationCallSurface` is canonical in
// `@balo/analytics`; re-declaring `'header' | 'rail' | 'nudge'` inline here (and in three other
// modules) put the wire contract in six places, five of which could drift silently.
import type { ConversationCallSurface } from '@balo/analytics/events';

export interface BookIntroCallInput {
  requestId: string;
  relationshipId: string;
  slot: {
    startIso: string;
    endIso: string;
    durationMinutes: SlotDurationMinutes;
  };
  /** Client-minted `crypto.randomUUID()`, stable in a `useRef` across "Try again" retries. */
  bookingNonce: string;
  /** ≤ 8 (BAL-408's cap) — guests are ALLOWED on the intro call (owner amendment). */
  guests: ReadonlyArray<{ email: string; name?: string }>;
  /** Analytics only — NEVER an authorization input. */
  surface: ConversationCallSurface;
}

export type IntroCallBookingFailureCode =
  | 'invalid_request' // zod, or api 400 context_type_mismatch
  | 'not_permitted' // gate denial, declined/withdrawn relationship, or api 404
  | 'slot_unavailable' // api 409 window_not_available
  | 'rate_limited' // api 429/503
  | 'booking_failed'; // anything else, incl. transport (status 0)

export type BookIntroCallResult =
  | {
      ok: true;
      meetingId: string;
      /** `/join/m/{meetingId}` — NEVER the raw Daily url. */
      joinPath: string;
      /** `false` ⇒ the Daily room did not come up yet; the booked state must not show a live link. */
      provisioned: boolean;
      /** The SERVER's window (S2 precedent) — never the client's submitted slot. */
      scheduledStartIso: string;
      scheduledEndIso: string;
      durationMinutes: number;
      guestsInvited: number;
      guestInviteFailed: boolean;
    }
  | { ok: false; code: IntroCallBookingFailureCode };
