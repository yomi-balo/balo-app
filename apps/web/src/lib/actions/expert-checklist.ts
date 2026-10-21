import 'server-only';

import { cache } from 'react';
import { requireOnboardedUser } from '@/lib/auth/session';
import { APPROVED_EXPERT_REQUIRED_ERROR, resolveApprovedExpert } from '@/lib/auth/approved-expert';
import { isImpersonatedSession } from '@/lib/auth/impersonation';
import { calendarRepository, expertSearchabilityRepository } from '@balo/db';
import { unreadableBusyReadTargets } from '@balo/shared/calendar';
import {
  calendarConnectionNeedsReconnect,
  deriveExpertChecklist,
  deriveExpertLiveStatus,
  isExpertLiveStatusVisible,
  type ExpertChecklistItemKey,
  type ExpertLiveStatus,
} from '@balo/shared/experts';
import { log } from '@/lib/logging';
import { reconcileFromRead } from '@/lib/expert/searchability';

export interface ChecklistStatus {
  items: {
    profile: boolean;
    phone: boolean;
    rate: boolean;
    calendar: boolean;
    availability: boolean;
    payouts: boolean;
  };
  completedCount: number;
  allComplete: boolean;
  /** Raw per-minute rate in cents from expert profile. Used by settings tabs to avoid a second DB query. */
  rateCents: number | null;
  /**
   * BAL-566 (R2) — a connection the expert HAD has broken (EXPIRED/REVOKED) and none is
   * currently ACTIVE. Derived from the SAME snapshot this call already fetched — no second
   * query. Drives the dashboard's calendar-disconnected banner; `false` for an expert who never
   * connected at all (that is setup, covered by `items.calendar`).
   */
  calendarNeedsReconnect: boolean;
  /**
   * BAL-591 — the "Available for new work" switch, from the same snapshot. Not a checklist item:
   * a paused expert still counts as set up, so the dashboard only softens its availability row.
   */
  availableForWork: boolean;
  /** BAL-603 — the post-reconcile `searchable` value: what search and the public profile now see. */
  searchable: boolean;
  /** BAL-603 — the public-profile slug; `null` until the expert picks one. */
  username: string | null;
  /** BAL-603 — the one-time go-live card has been shown (`live_celebration_seen_at` is set). */
  liveCelebrationSeen: boolean;
  /**
   * BAL-603 — the sidebar status, or `null` before the expert first went live or when the
   * busy-read lookup failed (hide the badge rather than show a false "Live").
   */
  liveStatus: ExpertLiveStatus | null;
}

/**
 * BAL-414 (D1/D3.2) — server-side function to compute checklist status. Called from server
 * components. `searchable` now derives from `allComplete` in BOTH directions (D1) — this is
 * the READ-PATH RECONCILIATION BACKSTOP for the five non-calendar items; the API-side triggers
 * (§B/§C of the plan) own the calendar-credential half and can de-list a dormant expert who
 * never opens this dashboard at all, which is what makes this backstop safe to leave
 * idempotent and best-effort here.
 *
 * The fetch is now ONE repository call (`expertSearchabilityRepository.loadInputs`), not a
 * five-repository fan-out — see that repository's docblock for the D4 ANY-ACTIVE semantics
 * and the soft-delete filters it applies at the SQL layer.
 *
 * ⚠ S2 (fix round 1) — this became a WRITE path (`reconcileFromRead` mutates on every render)
 * but kept a bare read-path auth check. `requireOnboardedUser()` is the fail-closed gate every
 * other privileged mutation uses; a bare `requireUser()`/`getSession()` here would leave an
 * un-onboarded session able to trigger a write. (This module stays `import 'server-only'`, not
 * `'use server'`, so it is still outside `onboarding-mutation-gate.test.ts`'s scan — that gate
 * only walks Server Actions — but the auth check itself is now the same fail-closed one.)
 */
export const getChecklistStatus = cache(async (): Promise<ChecklistStatus> => {
  const user = await requireOnboardedUser();

  const gate = await resolveApprovedExpert(user);
  if (!gate.ok) {
    throw new Error(APPROVED_EXPERT_REQUIRED_ERROR);
  }
  const { expertProfileId } = gate;

  // S4 — the scoped overload: an extra `AND expert_profiles.user_id = :userId` term on a
  // by-id read against a table with no RLS. `session.user.id` is the caller's own id, so this
  // is a no-op for a well-formed session and a defence-in-depth guard against a future caller
  // passing a mismatched id.
  const snapshot = await expertSearchabilityRepository.loadInputs(expertProfileId, undefined, {
    userId: user.id,
  });

  if (!snapshot) {
    log.error('Profile or user not found in checklist', {
      expertProfileId,
      userId: user.id,
    });
    throw new Error('Profile or user not found');
  }

  const derivation = deriveExpertChecklist(snapshot.inputs);

  // S2 — audit-integrity residual: a staff member operating under an impersonated session must
  // not have this de-list attributed to the impersonated expert alone. Preferred over refusing
  // the reconcile (which would leave `searchable` stale): the write still happens, and the fact
  // of impersonation rides into `audit_events.metadata` alongside it.
  //
  // ⚠ This is the ANNOTATION pattern, not BAL-528's refusal — the write proceeds. Both read the
  // same predicate; only this call site tolerates the session.
  const actorImpersonating = isImpersonatedSession(user);
  // BAL-553 — the impersonating staff member's own id, alongside the boolean above. Omitted
  // (via `reconcileFromRead` → `applySearchable`'s own omit-when-absent spread) on a normal
  // session, since `user.impersonatorUserId` is undefined there.
  const actorImpersonatorUserId = user.impersonatorUserId;

  // D1/D3.2 — symmetric: writes BOTH directions, conditional (a no-op when the row already
  // matches). Best-effort: a reconcile failure must never break the render, which is why
  // BOTH the write and its post-commit effects are inside this one try/catch rather than
  // letting it propagate.
  let searchable = snapshot.currentSearchable;
  try {
    await reconcileFromRead({
      expertProfileId,
      actorUserId: user.id,
      derivation,
      currentSearchable: snapshot.currentSearchable,
      actorImpersonating,
      actorImpersonatorUserId,
    });
    // D4 — post-reconcile: the value this very render just wrote, not the stale snapshot.
    searchable = derivation.allComplete;
  } catch (error) {
    log.error('Expert searchability reconcile failed', {
      expertProfileId,
      userId: user.id,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
  }

  const liveCelebrationSeen = snapshot.liveCelebrationSeenAt !== null;
  const liveStatus = await resolveLiveStatus({
    expertProfileId,
    allComplete: derivation.allComplete,
    failingItems: derivation.failingItems,
    liveCelebrationSeen,
    searchable,
    availableForWork: snapshot.availableForWork,
  });

  return {
    items: derivation.items,
    completedCount: derivation.completedCount,
    allComplete: derivation.allComplete,
    rateCents: snapshot.rateCents,
    calendarNeedsReconnect: calendarConnectionNeedsReconnect(snapshot.inputs.calendarConnections),
    availableForWork: snapshot.availableForWork,
    searchable,
    username: snapshot.username,
    liveCelebrationSeen,
    liveStatus,
  };
});

/**
 * BAL-603 — the busy-read lookup only runs where it can change the answer (visible, listed and
 * accepting work). A failed lookup yields `null` so the badge hides instead of claiming "Live".
 * ⚠ Read-only: the go-live stamp is never written here, because this also runs on a Link prefetch.
 */
async function resolveLiveStatus(input: {
  expertProfileId: string;
  allComplete: boolean;
  failingItems: readonly ExpertChecklistItemKey[];
  liveCelebrationSeen: boolean;
  searchable: boolean;
  availableForWork: boolean;
}): Promise<ExpertLiveStatus | null> {
  const { expertProfileId, ...rest } = input;
  let hasUnreadableBusyTarget = false;
  if (isExpertLiveStatusVisible(rest) && rest.searchable && rest.availableForWork) {
    try {
      const targets = await calendarRepository.listBusyReadTargets(expertProfileId);
      hasUnreadableBusyTarget = unreadableBusyReadTargets(targets).length > 0;
    } catch (error) {
      log.warn('Live status busy-read failed', {
        expertProfileId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }
  return deriveExpertLiveStatus({ ...rest, hasUnreadableBusyTarget });
}
