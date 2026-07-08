import 'server-only';

import { revalidatePath } from 'next/cache';
import {
  engagementsRepository,
  companiesRepository,
  EngagementNotActiveError,
  InvalidMilestoneTransitionError,
  type EngagementMilestoneStatus,
  type EngagementWithMilestones,
} from '@balo/db';
import { resolveEngagementLens } from '@/lib/engagement/resolve-engagement-lens';
import type { EngagementParties } from '@/lib/engagement/engagement-parties';
import { requireUser, type SessionUser } from '@/lib/auth/session';
import { log } from '@/lib/logging';

/** Milliseconds in a day / hour — the milestone metric denominators. */
export const DAY_MS = 24 * 60 * 60 * 1000;
export const HOUR_MS = 60 * 60 * 1000;

/** One live milestone off the hydrated engagement graph. */
export type EngagementMilestoneNode = EngagementWithMilestones['milestones'][number];

/**
 * The uniform result the three expert milestone actions return. The client toasts
 * `error` verbatim on failure (all copy is friendly + non-leaking) and reconciles
 * the optimistic rail on success via `status`.
 */
export type MilestoneActionResult =
  | { success: true; milestoneId: string; status: EngagementMilestoneStatus }
  | { success: false; error: string };

// ── Friendly, non-leaking copy (returned verbatim; the client toasts it) ─────
export const NOT_SIGNED_IN = 'You are not signed in.';
export const INVALID_REQUEST = 'Invalid request.';
export const NOT_FOUND = 'This engagement could not be found.';
export const ONLY_EXPERT = 'Only the delivering expert can update milestones.';
export const ENGAGEMENT_LOCKED = 'The delivery plan is locked while the project is in review.';
export const MILESTONE_GONE =
  'This milestone is no longer part of this engagement — refresh and try again.';
export const STALE_TRANSITION =
  'This milestone changed since you loaded the page. Refresh and try again.';
export const GENERIC_FAILURE = 'Something went wrong. Please try again.';

/** The audited authorize result — the loaded engagement + the target milestone. */
export type AuthorizeResult =
  | { ok: true; engagement: EngagementWithMilestones; milestone: EngagementMilestoneNode }
  | { ok: false; error: string };

/**
 * The shared expert-lens auth + IDOR + status pre-check chain (steps 3–7), kept in
 * ONE audited place so the three actions never copy-paste it (SonarCloud new-code
 * duplication gate). Runs: load engagement → expert-lens gate → engagement-active
 * guard → IDOR membership (milestone ∈ engagement) → status pre-check.
 *
 * Gates on `lens === 'expert'` (NOT `isDeliveringExpert`): an admin who incidentally
 * delivers resolves to `lens: 'admin'` (observer precedence) and is correctly blocked.
 * A stranger (`ctx === null`) sees the same `NOT_FOUND` as a missing row (existence
 * never leaks). Denials are `log.warn`ed (recoverable telemetry) — never the
 * completion-note body.
 */
export async function authorizeExpertMilestone(
  user: SessionUser,
  engagementId: string,
  milestoneId: string,
  expectedStatus: EngagementMilestoneStatus
): Promise<AuthorizeResult> {
  const deny = (reason: string, error: string): { ok: false; error: string } => {
    log.warn('Milestone action denied', { engagementId, milestoneId, userId: user.id, reason });
    return { ok: false, error };
  };

  const engagement = await engagementsRepository.findEngagementWithMilestones(engagementId);
  if (engagement === undefined) {
    return deny('engagement_not_found', NOT_FOUND);
  }

  const ctx = resolveEngagementLens(user, engagement);
  if (ctx === null) {
    // Stranger — same 404 as a missing row (no existence leak).
    return deny('not_a_party', NOT_FOUND);
  }
  if (ctx.lens !== 'expert') {
    return deny('wrong_lens', ONLY_EXPERT);
  }

  if (engagement.status !== 'active') {
    return deny('engagement_locked', ENGAGEMENT_LOCKED);
  }

  // IDOR: a forged milestoneId from another engagement is rejected before any write.
  const milestone = engagement.milestones.find((m) => m.id === milestoneId);
  if (milestone === undefined) {
    return deny('milestone_not_in_engagement', MILESTONE_GONE);
  }

  // Status pre-check — a friendly race message before the DB write.
  if (milestone.status !== expectedStatus) {
    return deny('stale_status', STALE_TRANSITION);
  }

  return { ok: true, engagement, milestone };
}

/**
 * Best-effort client company owner user id → drives `recipient:'client'`. Wrapped in
 * try/catch → `undefined` (never throws): the mutation is already committed, so a
 * lookup hiccup (or a company with no owner) must not drop the whole action — the
 * `recipient:'client'` rules simply skip, and the admin rules still fire.
 */
export async function resolveClientRecipientId(companyId: string): Promise<string | undefined> {
  try {
    const owner = await companiesRepository.findOwnerByCompanyId(companyId);
    return owner.id;
  } catch {
    return undefined;
  }
}

/**
 * The engagement/project title for notification copy — mirrors the D1 view-mapper
 * rule (retainer-safe): the source request title, else `Delivery with {expert}`.
 */
export function deriveEngagementTitle(
  engagement: EngagementWithMilestones,
  parties: EngagementParties
): string {
  return engagement.projectRequest?.title?.trim() || `Delivery with ${parties.expertPartyShort}`;
}

/** "30 Jun 2026" — day + short month + year, UTC (deterministic). */
export function formatCompletedOn(date: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(date);
}

/** `requireUser` wrapped once → the uniform `NOT_SIGNED_IN` result on throw. */
export async function requireExpertUser(): Promise<
  { ok: true; user: SessionUser } | { ok: false; error: string }
> {
  try {
    return { ok: true, user: await requireUser() };
  } catch {
    return { ok: false, error: NOT_SIGNED_IN };
  }
}

/**
 * Delegate a milestone transition to the repo, mapping the two typed race errors to
 * friendly copy (`EngagementNotActiveError → ENGAGEMENT_LOCKED`,
 * `InvalidMilestoneTransitionError → STALE_TRANSITION`). Any other error RETHROWS to
 * the action's `GENERIC_FAILURE` boundary. This double-guards the two-experts /
 * stale-tab race where the row changed between the step-7 pre-check and the locked
 * transition. Shared so the three actions never re-implement the mapping.
 */
export async function runMilestoneTransition<T>(
  fn: () => Promise<T>
): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    if (error instanceof EngagementNotActiveError) {
      return { ok: false, error: ENGAGEMENT_LOCKED };
    }
    if (error instanceof InvalidMilestoneTransitionError) {
      return { ok: false, error: STALE_TRANSITION };
    }
    throw error;
  }
}

/** The authorized context handed to a per-action `perform` callback. */
export interface AuthorizedMilestone {
  user: SessionUser;
  engagement: EngagementWithMilestones;
  milestone: EngagementMilestoneNode;
}

/**
 * The shared orchestration scaffolding for the three expert milestone actions:
 * authorize (steps 3–7 via {@link authorizeExpertMilestone}) → run the per-action
 * `perform` (repo transition + analytics + notify + `log.info`) → `revalidatePath`
 * on success → the single `GENERIC_FAILURE` boundary (`log.error` with message +
 * stack) for any non-typed rethrow. Keeps the requireUser/parse steps in each action
 * (their schemas differ) but the audited try/catch/revalidate scaffolding here (one
 * copy — SonarCloud new-code duplication gate).
 */
export async function runExpertMilestoneAction(
  user: SessionUser,
  input: { engagementId: string; milestoneId: string },
  expectedStatus: EngagementMilestoneStatus,
  failLabel: string,
  perform: (authorized: AuthorizedMilestone) => Promise<MilestoneActionResult>
): Promise<MilestoneActionResult> {
  const { engagementId, milestoneId } = input;
  try {
    const authorized = await authorizeExpertMilestone(
      user,
      engagementId,
      milestoneId,
      expectedStatus
    );
    if (!authorized.ok) {
      return { success: false, error: authorized.error };
    }

    const result = await perform({
      user,
      engagement: authorized.engagement,
      milestone: authorized.milestone,
    });
    // A typed-race failure surfaced by `perform` → no revalidate (nothing changed).
    if (result.success) {
      revalidatePath(`/engagements/${engagementId}`);
    }
    return result;
  } catch (error) {
    log.error(failLabel, {
      engagementId,
      milestoneId,
      userId: user.id,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { success: false, error: GENERIC_FAILURE };
  }
}
