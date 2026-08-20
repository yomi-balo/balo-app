import 'server-only';

import { expertSearchabilityRepository, type ExpertSearchabilityWriteResult } from '@balo/db';
import {
  buildSearchabilityAnalyticsProperties,
  type ExpertChecklistDerivation,
} from '@balo/shared/experts';
import { log } from '@/lib/logging';
import { trackServerAndFlush, EXPERT_SETUP_SERVER_EVENTS } from '@/lib/analytics/server';
import { publishNotificationEvent } from '@/lib/notifications/publish';

/**
 * BAL-414 (D3.2) — the web-side read-path reconciliation. `getChecklistStatus()` calls this
 * on EVERY render (`cache()`-wrapped, so once per request even though three routes call it),
 * as the backstop for the five non-calendar items — the server-side API triggers (§B/§C of
 * the plan) own the calendar-credential half. Now writes BOTH directions (D1), where the
 * pre-BAL-414 code only ever set `searchable: true`.
 *
 * Self-wraps in a transaction — `apps/web` has no caller-supplied executor to join, unlike
 * `apps/api`'s credential-break path, which must join the credential-status transaction. The
 * write is the SAME conditional compare-and-set as every other trigger
 * (`expertSearchabilityRepository.applySearchable`), so a stable state (the overwhelmingly
 * common case — most renders change nothing) writes no row, logs nothing, tracks nothing, and
 * publishes nothing. That idempotence is what makes it safe to call on every page load.
 *
 * ⚠ CHEAP-4 (fix round 1) — `currentSearchable` (already in hand from
 * `expertSearchabilityRepository.loadInputs`, no second query) skips the repository round trip
 * — a BEGIN/UPDATE/COMMIT — when it already equals `derivation.allComplete`, mirroring the
 * `needsWrite` advisory fast path `apps/api`'s `reconcileExpertSearchability` already uses.
 * ADVISORY ONLY: the conditional compare-and-set inside `applySearchable` remains the
 * correctness guarantee (see that repository's docblock) — this is purely a fast path over the
 * overwhelmingly common no-change case, never a substitute for the CAS itself.
 */
export interface ReconcileFromReadInput {
  readonly expertProfileId: string;
  /** The session user viewing their own dashboard — D6's `dashboard_read` source is the one
   *  case with a genuine human actor; every other source is a system actor (`null`). */
  readonly actorUserId: string;
  readonly derivation: ExpertChecklistDerivation;
  /** The committed value of `expert_profiles.searchable` at read time — CHEAP-4's advisory
   *  fast-path input. */
  readonly currentSearchable: boolean;
  /** S2 — recorded into `audit_events.metadata` (never used to gate authorization) when the
   *  session viewing this dashboard is a staff member's impersonated session. */
  readonly actorImpersonating?: boolean;
}

export async function reconcileFromRead(
  input: ReconcileFromReadInput
): Promise<ExpertSearchabilityWriteResult> {
  // CHEAP-4 — advisory fast path only. `applySearchable`'s `searchable <> $1` predicate would
  // no-op anyway; skipping the round trip on the common no-change case just avoids the extra
  // BEGIN/UPDATE/COMMIT on every dashboard render. Whether anything actually "changed" always
  // comes from the repository, never from this comparison.
  if (input.currentSearchable === input.derivation.allComplete) {
    return { changed: false };
  }

  const result = await expertSearchabilityRepository.applySearchable({
    expertProfileId: input.expertProfileId,
    searchable: input.derivation.allComplete,
    actorUserId: input.actorUserId,
    source: 'dashboard_read',
    failingItems: input.derivation.failingItems,
    actorImpersonating: input.actorImpersonating,
  });

  if (!result.changed) return result;

  log.info('Expert searchability changed', {
    expertProfileId: input.expertProfileId,
    searchable: input.derivation.allComplete,
    previousSearchable: result.previousSearchable,
    source: 'dashboard_read',
    failingItems: input.derivation.failingItems,
    auditEventId: result.auditEventId,
  });

  trackServerAndFlush(
    EXPERT_SETUP_SERVER_EVENTS.SEARCHABILITY_CHANGED,
    buildSearchabilityAnalyticsProperties({
      expertProfileId: input.expertProfileId,
      searchable: input.derivation.allComplete,
      previousSearchable: result.previousSearchable,
      failingItems: input.derivation.failingItems,
    })
  );

  try {
    if (input.derivation.allComplete) {
      await publishNotificationEvent('expert.searchability_restored', {
        correlationId: result.auditEventId,
        expertProfileId: input.expertProfileId,
      });
    } else {
      await publishNotificationEvent('expert.searchability_lost', {
        correlationId: result.auditEventId,
        expertProfileId: input.expertProfileId,
        failingItems: [...input.derivation.failingItems],
      });
    }
  } catch (err: unknown) {
    // `publishNotificationEvent` is documented never to throw (it swallows internally), but
    // guarding here costs nothing and keeps this function's contract honest independent of
    // that implementation detail.
    log.error('Failed to publish expert searchability notification', {
      event: input.derivation.allComplete
        ? 'expert.searchability_restored'
        : 'expert.searchability_lost',
      expertProfileId: input.expertProfileId,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
  }

  return result;
}
