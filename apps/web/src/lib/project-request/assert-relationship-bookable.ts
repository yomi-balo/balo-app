import 'server-only';

import { requestExpertRelationshipsRepository } from '@balo/db';
import { relationshipDeniesHosting } from '@balo/shared/authz';

/**
 * BAL-283 (plan §7.2) — the ONE web-side "is this relationship still live and not declined"
 * check, shared by both `bookIntroCallAction` and `shareAvailabilityAction`.
 *
 * ⚠ BELT-AND-BRACES, STATED PLAINLY. The AUTHORITATIVE gate is `apps/api`'s `loadSubject`
 * (`authorize-meeting-booking.ts`'s `request_interaction` arm), which denies a declined
 * relationship independently, on the SAME shared predicate. This exists so:
 *   1. `shareAvailabilityAction` — which never hits `POST /meetings` at all — is gated on
 *      decline/withdrawal too, not just on thread-open status.
 *   2. `bookIntroCallAction` fails with a specific, worded denial ('This request has moved on')
 *      before spending a network hop, rather than surfacing the api's bare 404.
 *
 * `declined` is ALREADY unreachable through `resolveConversationAccess` in the ordinary case —
 * `authorizeThread` calls `isThreadOpenStatus`, which excludes `declined` — so the value this
 * check adds on top is the PARTIAL-WRITE case: `declinedAt` stamped while `status` still reads
 * `eoi_submitted` passes `isThreadOpenStatus` and is denied only by the both-columns predicate
 * `relationshipDeniesHosting` applies (deliberately: it fails CLOSED when the two disagree).
 *
 * `requestExpertRelationshipsRepository.findById` already filters `deleted_at IS NULL`, so this
 * ALSO denies a withdrawn (soft-deleted) expert — a state `relationshipDeniesHosting` cannot
 * observe on its own, because it never sees a `deletedAt` column.
 *
 * ONE READ, freshly taken at the top of each action, before its write — the same "the service
 * NEVER TRUSTS ITS CALLER'S VERDICT" posture `isExactBookingReplay` documents on the api side.
 */
export async function assertRelationshipBookable(relationshipId: string): Promise<boolean> {
  const row = await requestExpertRelationshipsRepository.findById(relationshipId);
  if (row === undefined) {
    return false; // missing or soft-deleted (withdrawn)
  }
  return !relationshipDeniesHosting(row);
}
