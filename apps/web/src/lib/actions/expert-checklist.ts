import 'server-only';

import { cache } from 'react';
import { requireOnboardedUser } from '@/lib/auth/session';
import { expertSearchabilityRepository } from '@balo/db';
import { deriveExpertChecklist } from '@balo/shared/experts';
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

  if (user.activeMode !== 'expert') {
    throw new Error('Expert mode required');
  }

  const expertProfileId = user.expertProfileId;
  if (!expertProfileId) {
    throw new Error('Expert profile required');
  }

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
  const actorImpersonating = user.isImpersonating === true;

  // D1/D3.2 — symmetric: writes BOTH directions, conditional (a no-op when the row already
  // matches). Best-effort: a reconcile failure must never break the render, which is why
  // BOTH the write and its post-commit effects are inside this one try/catch rather than
  // letting it propagate.
  try {
    await reconcileFromRead({
      expertProfileId,
      actorUserId: user.id,
      derivation,
      currentSearchable: snapshot.currentSearchable,
      actorImpersonating,
    });
  } catch (error) {
    log.error('Expert searchability reconcile failed', {
      expertProfileId,
      userId: user.id,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
  }

  return {
    items: derivation.items,
    completedCount: derivation.completedCount,
    allComplete: derivation.allComplete,
    rateCents: snapshot.rateCents,
  };
});
