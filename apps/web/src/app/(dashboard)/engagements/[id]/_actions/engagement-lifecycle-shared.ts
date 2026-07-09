import 'server-only';

import { revalidatePath } from 'next/cache';
import {
  engagementsRepository,
  MilestonesIncompleteError,
  InvalidEngagementTransitionError,
  type EngagementWithMilestones,
} from '@balo/db';
import { resolveEngagementLens } from '@/lib/engagement/resolve-engagement-lens';
import type { SessionUser } from '@/lib/auth/session';
import { log } from '@/lib/logging';
import { DAY_MS, GENERIC_FAILURE, NOT_FOUND } from './milestone-action-shared';

// Re-export the reused signed-in wrapper, notify helpers, generic copy, and the
// millisecond denominators so the three lifecycle actions import everything they
// need from THIS single shared module (mirrors `milestone-action-shared` for D2/D3).
export {
  requireExpertUser as requireSignedInUser,
  resolveClientRecipientId,
  deriveEngagementTitle,
  INVALID_REQUEST,
  DAY_MS,
  HOUR_MS,
} from './milestone-action-shared';

/**
 * The uniform result the three engagement-lifecycle actions return. The client
 * island toasts `error` verbatim on failure (all copy is friendly + non-leaking)
 * and `router.refresh()`es on success.
 */
export type EngagementActionResult = { success: true } | { success: false; error: string };

// ── Friendly, non-leaking copy (returned verbatim; the client toasts it) ─────
export const ONLY_EXPERT = 'Only the delivering expert can do that.';
export const ONLY_ADMIN = 'Only Balo can cancel an engagement.';
export const NOT_ACTIVE = "This project isn't active.";
export const NOT_UNDER_REVIEW = "This project isn't under review.";
export const ENGAGEMENT_CLOSED = 'This engagement is already closed.';
export const MILESTONES_INCOMPLETE =
  'Not every milestone is complete yet — finish them before sending the project for review.';
export const STATUS_CHANGED = "This project's status changed. Refresh and try again.";
export const REASON_REQUIRED = 'A reason is required.';

/** The shared gate result — the loaded engagement or a friendly error. */
export type GateResult =
  | { ok: true; engagement: EngagementWithMilestones }
  | { ok: false; error: string };

/** The engagement statuses an expert lifecycle action can require. */
export type ExpertGateStatus = 'active' | 'pending_acceptance';

// ── Date helpers (deterministic under TZ=UTC) — kept local to the actions, NOT
//    imported from the view module (the view derives its own display copy) ─────

/** "4 Jul" — day + short month, UTC. */
export function formatShortUtc(date: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'short',
  }).format(date);
}

/** "9 Jul 2026" — day + short month + year, UTC. */
export function formatLongUtc(date: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(date);
}

/** Whole days between `from` and `now` (never negative). */
export function wholeDaysSince(from: Date, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - from.getTime()) / DAY_MS));
}

/**
 * The shared load-and-resolve prefix: load the engagement → resolve the viewer lens
 * → a stranger (`ctx === null`) or a missing row both yield the same `NOT_FOUND`
 * (existence never leaks). Denials are `log.warn`ed (recoverable telemetry) — never
 * any body copy. Extracted so BOTH gates below share it (SonarCloud new-code
 * duplication gate).
 */
async function loadEngagementLens(
  user: SessionUser,
  engagementId: string
): Promise<
  | { ok: true; engagement: EngagementWithMilestones; lens: 'client' | 'expert' | 'admin' }
  | { ok: false; error: string }
> {
  const engagement = await engagementsRepository.findEngagementWithMilestones(engagementId);
  if (engagement === undefined) {
    log.warn('Engagement lifecycle denied', {
      engagementId,
      userId: user.id,
      reason: 'engagement_not_found',
    });
    return { ok: false, error: NOT_FOUND };
  }
  const ctx = resolveEngagementLens(user, engagement);
  if (ctx === null) {
    // Stranger — same 404 as a missing row (no existence leak).
    log.warn('Engagement lifecycle denied', {
      engagementId,
      userId: user.id,
      reason: 'not_a_party',
    });
    return { ok: false, error: NOT_FOUND };
  }
  return { ok: true, engagement, lens: ctx.lens };
}

/**
 * The EXPERT-lens gate for request-completion (`requiredStatus: 'active'`) and
 * withdraw (`requiredStatus: 'pending_acceptance'`). Gates on `lens === 'expert'`
 * (NOT `isDeliveringExpert`): an admin who incidentally delivers resolves to
 * `lens: 'admin'` (observer precedence) and is correctly blocked. Wrong status →
 * the per-status friendly race message. Implemented fresh here (not reusing
 * `gateExpertActiveEngagement` from milestone-action-shared, whose message +
 * status are milestone-specific) so the two files stay independent.
 */
export async function gateExpertEngagement(
  user: SessionUser,
  engagementId: string,
  requiredStatus: ExpertGateStatus
): Promise<GateResult> {
  const loaded = await loadEngagementLens(user, engagementId);
  if (!loaded.ok) {
    return loaded;
  }
  if (loaded.lens !== 'expert') {
    log.warn('Engagement lifecycle denied', {
      engagementId,
      userId: user.id,
      reason: 'wrong_lens',
    });
    return { ok: false, error: ONLY_EXPERT };
  }
  if (loaded.engagement.status !== requiredStatus) {
    log.warn('Engagement lifecycle denied', {
      engagementId,
      userId: user.id,
      reason: 'wrong_status',
    });
    return {
      ok: false,
      error: requiredStatus === 'active' ? NOT_ACTIVE : NOT_UNDER_REVIEW,
    };
  }
  return { ok: true, engagement: loaded.engagement };
}

/**
 * The ADMIN-lens gate for cancel. Requires the admin (observer) lens and a
 * cancellable status (`active | pending_acceptance`); a terminal engagement →
 * `ENGAGEMENT_CLOSED`. The repo re-validates the legal `from` status under its lock.
 */
export async function gateAdminEngagement(
  user: SessionUser,
  engagementId: string
): Promise<GateResult> {
  const loaded = await loadEngagementLens(user, engagementId);
  if (!loaded.ok) {
    return loaded;
  }
  if (loaded.lens !== 'admin') {
    log.warn('Engagement lifecycle denied', {
      engagementId,
      userId: user.id,
      reason: 'wrong_lens',
    });
    return { ok: false, error: ONLY_ADMIN };
  }
  const { status } = loaded.engagement;
  if (status !== 'active' && status !== 'pending_acceptance') {
    log.warn('Engagement lifecycle denied', {
      engagementId,
      userId: user.id,
      reason: 'engagement_closed',
    });
    return { ok: false, error: ENGAGEMENT_CLOSED };
  }
  return { ok: true, engagement: loaded.engagement };
}

/**
 * The single audited orchestration boundary shared by all three lifecycle actions:
 * resolve the caller's `authorize` gate → run `perform` (repo write + analytics +
 * notify + `log.info`) → `revalidatePath` on success. The two typed D0 race errors
 * are mapped to friendly copy WITHOUT logging (an expected concurrent-tab race);
 * any other throw is the genuine failure boundary (`log.error` with message +
 * stack → `GENERIC_FAILURE`). Kept in ONE place so the try/catch/revalidate/map
 * body exists exactly once (SonarCloud new-code duplication gate).
 */
export async function runEngagementLifecycleAction(
  engagementId: string,
  logContext: Record<string, unknown>,
  failLabel: string,
  authorize: () => Promise<GateResult>,
  perform: (engagement: EngagementWithMilestones) => Promise<EngagementActionResult>
): Promise<EngagementActionResult> {
  try {
    const authorized = await authorize();
    if (!authorized.ok) {
      return { success: false, error: authorized.error };
    }
    const result = await perform(authorized.engagement);
    // A typed-race failure surfaced by `perform` → no revalidate (nothing changed).
    if (result.success) {
      revalidatePath(`/engagements/${engagementId}`);
    }
    return result;
  } catch (error) {
    // Belt-and-braces against the two-writer / stale-tab race the D0 repo re-checks
    // under its FOR UPDATE lock (the web pre-check can pass then the row moves).
    if (error instanceof MilestonesIncompleteError) {
      return { success: false, error: MILESTONES_INCOMPLETE };
    }
    if (error instanceof InvalidEngagementTransitionError) {
      return { success: false, error: STATUS_CHANGED };
    }
    log.error(failLabel, {
      engagementId,
      ...logContext,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { success: false, error: GENERIC_FAILURE };
  }
}
