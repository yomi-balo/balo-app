/**
 * BAL-283 (Ruling 3) — `shareAvailabilityAction`'s wire types. Kept in a SIBLING,
 * non-`'use server'` module for the same reason `book-intro-call-types.ts` is
 * (memory `reference_use_server_no_value_exports`).
 */

// ⚠ ONE DEFINITION OF THE SURFACE LIST (round-1 W10) — canonical in `@balo/analytics`.
import type { ConversationCallSurface } from '@balo/analytics/events';

export interface ShareAvailabilityInput {
  requestId: string;
  relationshipId: string;
  /** Analytics only — NEVER an authorization input. */
  surface: ConversationCallSurface;
}

export type ShareAvailabilityResult =
  | {
      ok: true;
      isReshare: boolean;
      calendarConnected: boolean;
      /**
       * BAL-283 (round-1 C1) — the instant actually STAMPED on
       * `request_expert_relationships.availability_shared_at`, returned so the client island
       * can flip its own `ConversationThreadView` optimistically.
       *
       * ⚠ LOAD-BEARING, NOT DECORATIVE. `router.refresh()` PRESERVES client component state by
       * design, and `<ConversationStage key={view.id}>` keys on the REQUEST id — which does not
       * change on a refresh. Without this value the expert's post-share half of the ticket is
       * dead: the "Availability shared" pill never renders, the nudge never flips to waiting,
       * and "Propose times" stays a live primary CTA that re-stamps the row on every click
       * (with the 24h rule silently suppressing the notification the toast implies was sent).
       */
      sharedAtIso: string;
    }
  | { ok: false; code: 'invalid_request' | 'not_permitted' | 'failed' };
