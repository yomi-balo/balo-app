// ⚠ apps/api relative imports MUST carry `.js` (opposite of packages/shared). Cross-package
// specifiers (`@balo/...`) must not.
import {
  expertSearchabilityRepository,
  type ExpertSearchabilitySource,
  type ExpertSearchabilityWriteResult,
} from '@balo/db';
import { createLogger } from '@balo/shared/logging';
import { trackServer, EXPERT_SETUP_SERVER_EVENTS } from '@balo/analytics/server';
import {
  deriveExpertChecklist,
  withCredentialStatusOverride,
  buildSearchabilityAnalyticsProperties,
  type ExpertChecklistDerivation,
} from '@balo/shared/experts';
import type {
  ExpertSearchabilityLostPayload,
  ExpertSearchabilityRestoredPayload,
} from '@balo/shared/notifications';
import { notificationEvents } from '../../notifications/publisher.js';

const log = createLogger('expert-searchability');

/**
 * BAL-414 §B — plan / commit / emit, and the convenience wrapper that composes them for callers
 * with no transaction of their own. Keeps the six-item checklist rule OUT of
 * `services/calendar/credential-status.ts`: that file is THE ONE PLACE A CREDENTIAL IS MARKED
 * BROKEN and stays provider-agnostic and single-purpose; this module is the ONLY thing that
 * knows what "complete" means, and it is a pure consumer of `@balo/shared/experts` +
 * `@balo/db`'s `expertSearchabilityRepository` — never a second definition of either.
 *
 * Four production call sites (§C of the plan): the credential-break trigger
 * (`credential-status.ts`, `publishNotification: false` — the reconnect email is the notice),
 * the health-probe heal branch, the OAuth reconnect callback, and the disconnect route. All four
 * import `reconcileExpertSearchability` — the self-wrapped, plan→commit(tx)→emit entry point.
 * The credential-break path is the ONE caller that needs the intermediate `plan` /
 * `commitSearchabilityPlan` seam, because its boolean flip and the credential status flip must
 * commit or roll back TOGETHER (§B.4) — see that file for the composed transaction.
 */

/**
 * The repository's optional transaction executor, DERIVED from its own signature rather than
 * imported: `DbExecutor` lives in `@balo/db`'s internal `repositories/_shared/` and is not part
 * of the package's public surface. Mirrors `apps/api/src/services/meetings/presence-writer.ts`'s
 * `PresenceExecutor` trick — same reason, same pattern.
 */
export type SearchabilityExecutor = NonNullable<
  Parameters<typeof expertSearchabilityRepository.applySearchable>[1]
>;

export interface SearchabilityPlan {
  readonly expertProfileId: string;
  readonly derivation: ExpertChecklistDerivation;
  readonly currentSearchable: boolean;
  /** `=== derivation.allComplete` (D1, symmetric). */
  readonly targetSearchable: boolean;
  /** ADVISORY fast-path only — see §G.3. Never the thing that decides whether effects fire. */
  readonly needsWrite: boolean;
  readonly rateCents: number | null;
}

/**
 * Load + derive. NO WRITES, no transaction. Returns `null` when the profile (or its user row)
 * is gone — a real but rare race (the expert was deleted between trigger and reconcile).
 */
export async function planSearchabilityReconciliation(input: {
  readonly expertProfileId: string;
  /** CHEAP-5 (fix round 1) — every caller already knows its source; carrying it into the
   *  `profile_missing` log is the only way to tell a probe tick from a dashboard render apart
   *  in Axiom. */
  readonly source: ExpertSearchabilitySource;
  readonly credentialStatusOverride?: {
    readonly connectionId: string;
    readonly credentialStatus: string;
  };
}): Promise<SearchabilityPlan | null> {
  const snapshot = await expertSearchabilityRepository.loadInputs(input.expertProfileId);
  if (snapshot === undefined) {
    log.warn(
      { expertProfileId: input.expertProfileId, source: input.source },
      'searchability_reconcile_profile_missing'
    );
    return null;
  }

  // §B.3 — the credential-break path supplies the post-flip status for the ONE connection
  // that is changing; its own flip has not committed when this runs, so the read above cannot
  // see it. Every other caller omits this and reads the committed set as-is.
  const calendarConnections = input.credentialStatusOverride
    ? withCredentialStatusOverride(
        snapshot.inputs.calendarConnections,
        input.credentialStatusOverride.connectionId,
        input.credentialStatusOverride.credentialStatus
      )
    : snapshot.inputs.calendarConnections;

  const derivation = deriveExpertChecklist({ ...snapshot.inputs, calendarConnections });

  return {
    expertProfileId: input.expertProfileId,
    derivation,
    currentSearchable: snapshot.currentSearchable,
    targetSearchable: derivation.allComplete,
    needsWrite: derivation.allComplete !== snapshot.currentSearchable,
    rateCents: snapshot.rateCents,
  };
}

/** Conditional write + audit row. Pass `executor` to join a caller's transaction. */
export async function commitSearchabilityPlan(
  plan: SearchabilityPlan,
  input: { readonly source: ExpertSearchabilitySource; readonly actorUserId: string | null },
  executor?: SearchabilityExecutor
): Promise<ExpertSearchabilityWriteResult> {
  return expertSearchabilityRepository.applySearchable(
    {
      expertProfileId: plan.expertProfileId,
      searchable: plan.targetSearchable,
      actorUserId: input.actorUserId,
      source: input.source,
      failingItems: plan.derivation.failingItems,
    },
    executor
  );
}

/**
 * POST-COMMIT effects: structured log, `trackServer`, and (when `publishNotification`) the
 * notification publish. ⚠ NEVER call inside a transaction — a publish from inside
 * `db.transaction` fires before commit and does not roll back
 * (`packages/db/src/invariants/repositories-never-notify.test.ts`). A no-op when
 * `result.changed === false` — that IS the idempotence guarantee: a retried job or a
 * re-rendered dashboard on an already-stable row writes nothing, so it announces nothing.
 */
export async function emitSearchabilityChange(input: {
  readonly expertProfileId: string;
  readonly plan: SearchabilityPlan;
  readonly result: ExpertSearchabilityWriteResult;
  readonly source: ExpertSearchabilitySource;
  readonly publishNotification: boolean;
}): Promise<void> {
  const { result } = input;
  if (!result.changed) return;

  log.info(
    {
      expertProfileId: input.expertProfileId,
      searchable: input.plan.targetSearchable,
      previousSearchable: result.previousSearchable,
      source: input.source,
      failingItems: input.plan.derivation.failingItems,
      auditEventId: result.auditEventId,
    },
    'expert_searchability_changed'
  );

  trackServer(
    EXPERT_SETUP_SERVER_EVENTS.SEARCHABILITY_CHANGED,
    buildSearchabilityAnalyticsProperties({
      expertProfileId: input.expertProfileId,
      searchable: input.plan.targetSearchable,
      previousSearchable: result.previousSearchable,
      failingItems: input.plan.derivation.failingItems,
    })
  );

  if (!input.publishNotification) return;

  try {
    if (input.plan.targetSearchable) {
      const payload: ExpertSearchabilityRestoredPayload = {
        correlationId: result.auditEventId,
        expertProfileId: input.expertProfileId,
      };
      await notificationEvents.publish('expert.searchability_restored', payload);
    } else {
      const payload: ExpertSearchabilityLostPayload = {
        correlationId: result.auditEventId,
        expertProfileId: input.expertProfileId,
        failingItems: [...input.plan.derivation.failingItems],
      };
      await notificationEvents.publish('expert.searchability_lost', payload);
    }
  } catch (err: unknown) {
    log.error(
      {
        event: input.plan.targetSearchable
          ? 'expert.searchability_restored'
          : 'expert.searchability_lost',
        expertProfileId: input.expertProfileId,
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      },
      'Failed to publish expert searchability notification'
    );
  }
}

/**
 * plan → commit (self-wrapped tx) → emit. The default entry point for callers with no
 * transaction of their own — the health probe, the OAuth callback, and the disconnect route.
 * `credential-status.ts`'s credential-break path calls `planSearchabilityReconciliation` +
 * `commitSearchabilityPlan` + `emitSearchabilityChange` directly instead, because its write
 * must join the credential-status transaction (§B.4).
 */
export async function reconcileExpertSearchability(input: {
  readonly expertProfileId: string;
  readonly source: ExpertSearchabilitySource;
  readonly actorUserId: string | null;
  readonly publishNotification: boolean;
  readonly credentialStatusOverride?: {
    readonly connectionId: string;
    readonly credentialStatus: string;
  };
}): Promise<ExpertSearchabilityWriteResult> {
  const plan = await planSearchabilityReconciliation({
    expertProfileId: input.expertProfileId,
    source: input.source,
    credentialStatusOverride: input.credentialStatusOverride,
  });
  if (plan === null) return { changed: false };

  // §G.3 — `needsWrite` is an ADVISORY FAST PATH ONLY: skipping the repository round trip when
  // the plan already matches the committed row is safe (the compare-and-set would no-op
  // anyway), but the decision of whether anything "changed" always comes from the repository's
  // result, never from this flag.
  const result = plan.needsWrite
    ? await commitSearchabilityPlan(plan, {
        source: input.source,
        actorUserId: input.actorUserId,
      })
    : ({ changed: false } as const);

  await emitSearchabilityChange({
    expertProfileId: input.expertProfileId,
    plan,
    result,
    source: input.source,
    publishNotification: input.publishNotification,
  });

  return result;
}
