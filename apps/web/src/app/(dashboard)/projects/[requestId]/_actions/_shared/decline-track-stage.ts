import 'server-only';

import type { RelationshipStatus } from '@balo/db';
import {
  narrowToDeclinableRelationshipStatus,
  type DeclinableRelationshipStatus,
} from '@balo/shared/project-requests';
import { log } from '@/lib/logging';

/**
 * BAL-540 — narrow `declineTrack`'s `previousStatus` (typed as the full 6-value
 * `RelationshipStatus`) to the 4 stages a track can actually be declined FROM. Shared by
 * `decline-track.ts` and `decline-track-as-admin.ts`.
 *
 * A THIN WRAPPER over `@balo/shared/project-requests`' `narrowToDeclinableRelationshipStatus`,
 * which is the ONE narrowing for this union across the whole codebase (the fix round collapsed
 * four hand-written copies with three different failure modes into it). This wrapper adds only
 * the SERVER-SIDE decision about what to do with a `null`.
 *
 * ⚠ IT DOES NOT THROW, DELIBERATELY. Both call sites reach it AFTER `declineTrack` has already
 * COMMITTED, so a throw here would leave the track declined with no notification published and
 * a generic failure shown to the user. `declineTrack` refuses `accepted`/`declined` at its own
 * transition guard (`RELATIONSHIP_STATUS_TRANSITIONS`), so `null` is unreachable on the happy
 * path — if it ever happens it is a repository invariant violation, which is worth a `log.error`
 * and the least-wrong stage label, not a lost notification.
 */
export function toDeclineTrackStage(status: RelationshipStatus): DeclinableRelationshipStatus {
  const stage = narrowToDeclinableRelationshipStatus(status);
  if (stage !== null) return stage;

  log.error('declineTrack returned an unexpected previousStatus', {
    previousStatus: status,
  });
  // The stage every track passes through — the least-wrong label for copy that has to say
  // SOMETHING, on a path that is already an invariant violation.
  return 'invited';
}
