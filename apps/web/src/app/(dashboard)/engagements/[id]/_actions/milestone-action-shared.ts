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
import {
  deriveEngagementParties,
  type EngagementParties,
} from '@/lib/engagement/engagement-parties';
import { requireUser, type SessionUser } from '@/lib/auth/session';
import { publishNotificationEvent } from '@/lib/notifications/publish';
import { plainMessageToHtml } from '@/lib/sanitize/plain-message-html';
import { sanitizeProjectHtml } from '@/lib/sanitize/project-html';
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
export const PLAN_CHANGED =
  'The delivery plan changed since you loaded the page. Refresh and try again.';
export const GENERIC_FAILURE = 'Something went wrong. Please try again.';

/**
 * Debounce window (ms) for title-only ("cosmetic") edits — Decision D. A burst of
 * rapid typo fixes on the SAME milestone collapses into one delivered notification
 * because the `correlationId` is time-bucketed by this window (the dispatcher dedups
 * on the resulting `jobId`). Material edits are exempt (always re-notify). 10 min,
 * tunable — documented in the PR.
 */
export const EDIT_COSMETIC_DEBOUNCE_MS = 10 * 60_000;

/** The audited authorize result — the loaded engagement + the target milestone. */
export type AuthorizeResult =
  | { ok: true; engagement: EngagementWithMilestones; milestone: EngagementMilestoneNode }
  | { ok: false; error: string };

/** The shared expert-lens gate result — the loaded engagement or a friendly error. */
type GateResult = { ok: true; engagement: EngagementWithMilestones } | { ok: false; error: string };

/**
 * The shared 3-step prefix of every expert delivery-plan action: load engagement →
 * expert-lens gate → engagement-active guard. Extracted so it exists in ONE audited
 * place (SonarCloud new-code duplication gate) — both {@link authorizeExpertMilestone}
 * (which adds an IDOR + status pre-check) and {@link authorizeExpertEngagement} (which
 * adds an OPTIONAL IDOR check, no status) build on it.
 *
 * Gates on `lens === 'expert'` (NOT `isDeliveringExpert`): an admin who incidentally
 * delivers resolves to `lens: 'admin'` (observer precedence) and is correctly blocked.
 * A stranger (`ctx === null`) sees the same `NOT_FOUND` as a missing row (existence
 * never leaks). Denials are `log.warn`ed (recoverable telemetry) — never any body copy.
 */
async function gateExpertActiveEngagement(
  user: SessionUser,
  engagementId: string
): Promise<GateResult> {
  const deny = (reason: string, error: string): { ok: false; error: string } => {
    log.warn('Engagement action denied', { engagementId, userId: user.id, reason });
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
  return { ok: true, engagement };
}

/**
 * The milestone-scoped authorize chain: the shared {@link gateExpertActiveEngagement}
 * prefix, THEN the two milestone-specific steps — IDOR membership (milestone ∈
 * engagement) → status pre-check. Behaviour is identical to the pre-refactor helper
 * (its unit tests stay green); the shared prefix simply lives in one place now.
 */
export async function authorizeExpertMilestone(
  user: SessionUser,
  engagementId: string,
  milestoneId: string,
  expectedStatus: EngagementMilestoneStatus
): Promise<AuthorizeResult> {
  const gate = await gateExpertActiveEngagement(user, engagementId);
  if (!gate.ok) {
    return { ok: false, error: gate.error };
  }

  const deny = (reason: string, error: string): { ok: false; error: string } => {
    log.warn('Milestone action denied', { engagementId, milestoneId, userId: user.id, reason });
    return { ok: false, error };
  };

  // IDOR: a forged milestoneId from another engagement is rejected before any write.
  const milestone = gate.engagement.milestones.find((m) => m.id === milestoneId);
  if (milestone === undefined) {
    return deny('milestone_not_in_engagement', MILESTONE_GONE);
  }

  // Status pre-check — a friendly race message before the DB write.
  if (milestone.status !== expectedStatus) {
    return deny('stale_status', STALE_TRANSITION);
  }

  return { ok: true, engagement: gate.engagement, milestone };
}

/** The authorized context for a status-optional engagement-scoped action. */
export interface AuthorizedEngagement {
  user: SessionUser;
  engagement: EngagementWithMilestones;
  /** Present iff `opts.milestoneId` was supplied AND validated (IDOR). */
  milestone?: EngagementMilestoneNode;
}

/**
 * Status-OPTIONAL engagement-level authorize for the D3 scope-edit actions. Runs the
 * shared {@link gateExpertActiveEngagement} prefix, then — ONLY when `opts.milestoneId`
 * is supplied — an IDOR membership check (milestone ∈ engagement → `MILESTONE_GONE` on
 * miss). No status pre-check (add / reorder have no milestone; edit / remove have no
 * expected status — the repo re-validates `active` under its lock). Add / reorder pass
 * no `milestoneId`; edit / remove pass one to get the validated node back.
 */
export async function authorizeExpertEngagement(
  user: SessionUser,
  engagementId: string,
  opts?: { milestoneId?: string }
): Promise<
  | { ok: true; engagement: EngagementWithMilestones; milestone?: EngagementMilestoneNode }
  | { ok: false; error: string }
> {
  const gate = await gateExpertActiveEngagement(user, engagementId);
  if (!gate.ok) {
    return { ok: false, error: gate.error };
  }

  if (opts?.milestoneId !== undefined) {
    const milestone = gate.engagement.milestones.find((m) => m.id === opts.milestoneId);
    if (milestone === undefined) {
      log.warn('Engagement action denied', {
        engagementId,
        milestoneId: opts.milestoneId,
        userId: user.id,
        reason: 'milestone_not_in_engagement',
      });
      return { ok: false, error: MILESTONE_GONE };
    }
    return { ok: true, engagement: gate.engagement, milestone };
  }

  return { ok: true, engagement: gate.engagement };
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
 * The single audited orchestration boundary shared by BOTH public runners
 * ({@link runExpertMilestoneAction} milestone-scoped + {@link runExpertEngagementAction}
 * engagement-scoped): resolve the caller's `authorize` → run `perform` (repo write +
 * analytics + notify + `log.info`) → `revalidatePath` on success → the single
 * `GENERIC_FAILURE` boundary (`log.error` with message + stack) for any non-typed
 * rethrow. Kept private and generic over the authorized context `C` so the try /
 * catch / revalidate / log.error body exists in exactly ONE place (SonarCloud new-code
 * duplication gate) — the two public runners are thin adapters that differ only in
 * which authorize helper they call and their log context.
 */
async function runAuthorizedEngagementAction<C>(
  engagementId: string,
  logContext: Record<string, unknown>,
  failLabel: string,
  authorize: () => Promise<{ ok: true; context: C } | { ok: false; error: string }>,
  perform: (context: C) => Promise<MilestoneActionResult>
): Promise<MilestoneActionResult> {
  try {
    const authorized = await authorize();
    if (!authorized.ok) {
      return { success: false, error: authorized.error };
    }
    const result = await perform(authorized.context);
    // A typed-race failure surfaced by `perform` → no revalidate (nothing changed).
    if (result.success) {
      revalidatePath(`/engagements/${engagementId}`);
    }
    return result;
  } catch (error) {
    log.error(failLabel, {
      engagementId,
      ...logContext,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { success: false, error: GENERIC_FAILURE };
  }
}

/**
 * The milestone-scoped runner (D2 start / complete / revert): authorize via
 * {@link authorizeExpertMilestone} (adds the IDOR + status pre-check), then delegate
 * to the shared {@link runAuthorizedEngagementAction} boundary. `perform` receives the
 * guaranteed `AuthorizedMilestone` (milestone always present).
 */
export async function runExpertMilestoneAction(
  user: SessionUser,
  input: { engagementId: string; milestoneId: string },
  expectedStatus: EngagementMilestoneStatus,
  failLabel: string,
  perform: (authorized: AuthorizedMilestone) => Promise<MilestoneActionResult>
): Promise<MilestoneActionResult> {
  const { engagementId, milestoneId } = input;
  return runAuthorizedEngagementAction<AuthorizedMilestone>(
    engagementId,
    { milestoneId, userId: user.id },
    failLabel,
    async () => {
      const res = await authorizeExpertMilestone(user, engagementId, milestoneId, expectedStatus);
      return res.ok
        ? { ok: true, context: { user, engagement: res.engagement, milestone: res.milestone } }
        : { ok: false, error: res.error };
    },
    perform
  );
}

/**
 * The status-OPTIONAL engagement-scoped runner (D3 add / update / remove / reorder):
 * authorize via {@link authorizeExpertEngagement} (optional IDOR when `opts.milestoneId`
 * is set), then delegate to the shared {@link runAuthorizedEngagementAction} boundary.
 * `perform` receives an {@link AuthorizedEngagement} (`milestone` present iff a
 * `milestoneId` was supplied and validated).
 */
export async function runExpertEngagementAction(
  user: SessionUser,
  engagementId: string,
  opts: { milestoneId?: string },
  failLabel: string,
  perform: (authorized: AuthorizedEngagement) => Promise<MilestoneActionResult>
): Promise<MilestoneActionResult> {
  const logContext: Record<string, unknown> =
    opts.milestoneId !== undefined
      ? { milestoneId: opts.milestoneId, userId: user.id }
      : { userId: user.id };
  return runAuthorizedEngagementAction<AuthorizedEngagement>(
    engagementId,
    logContext,
    failLabel,
    async () => {
      const res = await authorizeExpertEngagement(user, engagementId, opts);
      return res.ok
        ? { ok: true, context: { user, engagement: res.engagement, milestone: res.milestone } }
        : { ok: false, error: res.error };
    },
    perform
  );
}

// ── Scope-change helpers (add / edit / remove) — DRY the summary + notify + edge
//    sanitise so each thin action never copy-pastes them (duplication gate) ──────

/** `added 'X'` | `removed 'X'` | `updated 'X'` — the single change-summary builder. */
export function buildChangeSummary(kind: 'added' | 'edited' | 'removed', title: string): string {
  const verb = kind === 'added' ? 'added' : kind === 'removed' ? 'removed' : 'updated';
  return `${verb} '${title}'`;
}

/**
 * Publish `engagement.scope_changed` (fire-and-forget) — one place so add / edit /
 * remove never copy-paste the payload assembly. Resolves the client company owner
 * (best-effort → `recipientId` may be `undefined`: the client rules skip, admins
 * still fire), derives the retrospective actor label + project title (BAL-329), and
 * builds the summary from `changeKind` + `milestoneTitle`. Swallows errors (the
 * mutation is already committed; `publishNotificationEvent` logs internally).
 */
export async function publishScopeChange(
  engagement: EngagementWithMilestones,
  input: {
    changeKind: 'added' | 'edited' | 'removed';
    milestoneId: string;
    milestoneTitle: string;
    correlationId: string;
  }
): Promise<void> {
  const parties = deriveEngagementParties(engagement);
  const recipientId = await resolveClientRecipientId(engagement.company.id);
  publishNotificationEvent('engagement.scope_changed', {
    correlationId: input.correlationId,
    engagementId: engagement.id,
    milestoneId: input.milestoneId,
    recipientId,
    actorExpertLabel: parties.expertRetroFirstMention,
    projectTitle: deriveEngagementTitle(engagement, parties),
    changeKind: input.changeKind,
    changeSummary: buildChangeSummary(input.changeKind, input.milestoneTitle),
  }).catch(() => {
    // publishNotificationEvent logs internally.
  });
}

/**
 * Plain-text milestone description → sanitised project HTML (the SAME allow-list the
 * proposal composer uses on milestone `descriptionHtml`). Reuses the shared
 * `plainMessageToHtml` escaper/paragraph-wrapper (no bespoke escaper), then runs
 * {@link sanitizeProjectHtml} as the security boundary. Blank / whitespace → `null`
 * (clears the field). Never `sanitizeProposalOverviewHtml` (wider allow-list).
 */
export function descriptionTextToSafeHtml(text: string | null | undefined): string | null {
  const html = plainMessageToHtml(text ?? '');
  if (html === '') {
    return null;
  }
  return sanitizeProjectHtml(html);
}
