'use server';

import 'server-only';

import { z } from 'zod';
import {
  projectRequestsRepository,
  proposalsRepository,
  type ProjectRequestWithRelations,
} from '@balo/db';
import { BALO_CLOSE_REASONS, type BaloCloseReason } from '@balo/shared/project-requests';
import { requireOnboardedUser, type SessionUser } from '@/lib/auth/session';
import { hasPlatformCapability, PLATFORM_CAPABILITIES } from '@/lib/authz/platform';
import { log } from '@/lib/logging';
import { inviteExpertsAction } from '@/app/(dashboard)/projects/[requestId]/_actions/invite-experts';
import { requestProposalAsAdmin } from '@/app/(dashboard)/projects/[requestId]/_actions/request-proposal-as-admin';
import { closeRequestAsAdminAction } from '@/app/(dashboard)/projects/[requestId]/_actions/close-request-as-admin';
import { declineTrackAsAdminAction } from '@/app/(dashboard)/projects/[requestId]/_actions/decline-track-as-admin';
import { runSubmitEoi } from '@/app/(dashboard)/projects/[requestId]/_actions/_shared/submit-eoi-core';
import { runSaveProposalDraft } from '@/app/(dashboard)/projects/[requestId]/_actions/_shared/save-proposal-draft-core';
import { runSubmitProposal } from '@/app/(dashboard)/projects/[requestId]/_actions/_shared/submit-proposal-core';
import { runAcceptProposal } from '@/app/(dashboard)/projects/[requestId]/_actions/_shared/accept-proposal-core';
import { runMarkThreadRead } from '@/app/(dashboard)/projects/[requestId]/_actions/_shared/mark-thread-read-core';
import {
  resolveClientActor,
  resolveExpertActor,
  type ActorResolution,
} from '../_lib/resolve-step-actor';
import {
  planFastForward,
  refusalCopy,
  FAST_FORWARD_TARGETS,
  type FastForwardStep,
} from '../_lib/fast-forward-plan';
import {
  FAST_FORWARD_CLOSE_NOTE,
  FAST_FORWARD_EOI_MESSAGE,
  fastForwardProposalDraft,
} from '../_lib/fast-forward-fixtures';

/**
 * BAL-275 — the dev-only request fast-forward. Drives an already-created project request
 * forward along the real origination spine by invoking each real handler with that step's
 * genuinely-required actor (§5), derived from the request graph. Plus a "mark a thread read"
 * affordance for either party (§7's `markThreadRead` row).
 *
 * Every capability gate runs at full strength, every repository writer takes the BAL-546
 * advisory lock, and every notification / audit row / attribution column / `revalidatePath` fires
 * exactly as production fires it — nothing here manufactures a row a real handler never produces.
 *
 * ⚠ ANALYTICS ARE THE ONE EXCEPTION. A fast-forwarded request is NOT a valid PostHog fixture.
 * Balo's origination analytics are split by AUDIENCE (BAL-357): only the two money-bearing events
 * are emitted server-side, from inside the cores this file calls, so only those two fire here —
 *   • `PROJECT_PROPOSAL_SUBMITTED` — `_shared/submit-proposal-core.ts`
 *   • `PROJECT_PROPOSAL_ACCEPTED`  — `_shared/accept-proposal-core.ts`
 * both via `trackServerAndFlush` (itself a no-op without `POSTHOG_API_KEY`, the dev default) and
 * both attributed to the DERIVED party as `distinct_id`, never to the dev operator.
 *
 * EVERY other origination event is fired CLIENT-side by the surface that reacts to the action's
 * return value. This file discards those payloads, so a fast-forward produces NONE of:
 *   • invite            → `PROJECT_EXPERT_INVITED` + `PROJECT_REQUEST_STATUS_TRANSITIONED`
 *                          (`expert-invite-dialog.tsx`; drops `firstAdminActionMs`)
 *   • eoi               → `PROJECT_EOI_SUBMITTED` (`eoi-entry.tsx`; drops `timeToEoiMs`)
 *   • request_proposal  → `PROJECT_PROPOSAL_REQUESTED` + `PROJECT_REQUEST_STATUS_TRANSITIONED`
 *                          (`admin-health-panel.tsx`)
 *   • submit_proposal   → `MILESTONE_EFFORT_ESTIMATED` + `PROJECT_REQUEST_STATUS_TRANSITIONED`
 *                          (`submit-proposal-dialog.tsx`)
 *   • accept            → `PROJECT_REQUEST_STATUS_TRANSITIONED` (`accept-confirm-modal.tsx`)
 *   • close             → `PROJECT_REQUEST_CLOSED` (`close-request-sheet.tsx`)
 *   • decline_track     → `PROJECT_TRACK_DECLINED` (`decline-track-dialog.tsx`)
 * `markThreadRead` loses nothing — neither path emits analytics; the real surface's
 * `CONVERSATION_THREAD_SELECTED` (`conversation-stage.tsx`) belongs to TAB SELECTION, not to the
 * mark-read write.
 *
 * Dropping the client half is deliberate and correct for a headless fixture tool (there is no
 * browser and no viewer whose `distinct_id` those events would carry), but it means
 * `PROJECT_REQUEST_STATUS_TRANSITIONED` — the canonical transition stream — is ABSENT for every
 * step a fast-forward performs. Never validate a PostHog funnel, conversion rate or
 * time-to-transition metric against fast-forwarded data. Do NOT "fix" this by emitting those
 * events from here: that would mint server-side duplicates of client-only events under a
 * synthetic `distinct_id`, poisoning the very funnels this paragraph warns about.
 *
 * Four of
 * the seven targets (`experts_invited`, `proposal_requested`, `closed`, track-`declined`) run the
 * shipped ADMIN Server Action UNMODIFIED, on the dev operator's OWN session (they are staff by
 * construction of the entry token below). Only three spine steps plus `markThreadRead` are
 * performed by a non-staff party and so need a derived actor, built by
 * `../_lib/resolve-step-actor.ts` — see §3 / §5 of the BAL-275 plan for the full reasoning.
 */

// ─── §4.2 — the entry gate ──────────────────────────────────────────────────────────────────

type OperatorGate = { ok: true; user: SessionUser } | { ok: false; error: string };

/**
 * BAL-275 S1 fix — an ALLOWLIST, not a `!== 'production'` DENYLIST, and the difference is the
 * whole point (mirrors `apps/api/src/services/seed/truncate.ts:338-378`, which litigated this
 * exact question first and reached the same conclusion). A denylist fails OPEN on a `NODE_ENV`
 * that is unset, misspelt, or overridden — and this gate protects an act-on-behalf primitive, not
 * merely a seed script: fail-open here means any `admin`/`super_admin` can accept proposals AS
 * THE CLIENT against real customer requests. `next start` sets `NODE_ENV=production` itself, but
 * a value overridden via the Vercel dashboard (Vercel permits this) would silently un-pin that,
 * and an unset or typo'd var must never fall through to "not production". An allowlist inverts
 * it: an environment this code does not RECOGNISE is refused, so every unfamiliar or missing
 * value is denied by the same rule that denies production.
 */
const FAST_FORWARD_ALLOWED_NODE_ENVS: readonly string[] = ['development', 'test'];

/**
 * NON-EXPORTED, deliberately (§4.2): a `'use server'` file may export only async functions, so
 * this helper — unconstrained by that rule — is the ONE definition of the gate, called first by
 * all three exported actions below. Order is load-bearing:
 *  1. `FAST_FORWARD_ALLOWED_NODE_ENVS.includes(process.env.NODE_ENV ?? '')` refusal FIRST, before
 *     any identity or capability work — the production-inertness this token's own docblock
 *     promises (`platform.ts`) depends on this running before `hasPlatformCapability` is ever
 *     reached in a production process.
 *  2. `requireOnboardedUser()` — an authenticated, onboarded session (also keeps
 *     `onboarding-mutation-gate.test.ts`'s `AUTH_HELPERS` name-scan satisfied).
 *  3. `hasPlatformCapability(user, PLATFORM_CAPABILITIES.FAST_FORWARD_REQUEST)` — NEVER
 *     `platformRole ===` (ADR-1029 / ADR-1035).
 *
 * Resolved ONCE, on the dev operator — never re-resolved per step, and never on a derived actor.
 * Pinned by `apps/web/src/invariants/fast-forward-capability-dev-only.test.ts`.
 */
async function resolveFastForwardOperator(): Promise<OperatorGate> {
  if (!FAST_FORWARD_ALLOWED_NODE_ENVS.includes(process.env.NODE_ENV ?? '')) {
    return { ok: false, error: 'The fast-forward is not available in production.' };
  }

  let user: SessionUser;
  try {
    user = await requireOnboardedUser();
  } catch {
    return { ok: false, error: 'You are not signed in.' };
  }

  if (!hasPlatformCapability(user, PLATFORM_CAPABILITIES.FAST_FORWARD_REQUEST)) {
    return { ok: false, error: 'You do not have permission to do this.' };
  }

  return { ok: true, user };
}

// ─── Shared types ───────────────────────────────────────────────────────────────────────────

/** Every step that needs an existing track (relationship) already on the request. */
const NEEDS_RELATIONSHIP_STEPS = new Set<FastForwardStep>([
  'eoi',
  'request_proposal',
  'submit_proposal',
  'accept',
  'decline_track',
]);

interface StepContext {
  readonly requestId: string;
  readonly request: ProjectRequestWithRelations;
  readonly relationshipId: string | null;
  readonly expertProfileId: string | undefined;
  readonly proposalId: string | null;
  readonly closeReason: BaloCloseReason;
}

/** U3 — the label shown for a step run on the dev operator's own session (never a derived party). */
const DEV_OPERATOR_LABEL = 'dev operator';

type StepOutcome =
  | { ok: true; actorLabel: string; relationshipId?: string; proposalId?: string }
  | { ok: false; error: string };

/** Display name for a party — join first/last, fallback for a name-less row. */
function displayName(person: { firstName: string | null; lastName: string | null }): string {
  const full = [person.firstName, person.lastName].filter(Boolean).join(' ').trim();
  return full.length > 0 ? full : 'Unnamed';
}

function findTrack(
  request: ProjectRequestWithRelations,
  relationshipId: string
): ProjectRequestWithRelations['relationships'][number] | undefined {
  return request.relationships.find((relationship) => relationship.id === relationshipId);
}

function logActorRefusal(requestId: string, side: 'client' | 'expert', reason: string): void {
  log.warn('Fast-forward actor could not be resolved', { requestId, side, reason });
}

/**
 * Narrow `ctx.relationshipId` to a non-null id before running a step that needs one — the ONE
 * place that "pick a track first" refusal is worded, shared by every relationship-bearing step.
 */
async function withRequiredRelationship(
  ctx: StepContext,
  run: (relationshipId: string) => Promise<StepOutcome>
): Promise<StepOutcome> {
  if (ctx.relationshipId === null) {
    return { ok: false, error: 'Pick a track before fast-forwarding to that status.' };
  }
  return run(ctx.relationshipId);
}

// ─── §7 — per-step runners ──────────────────────────────────────────────────────────────────

/** `experts_invited` — dev operator's own session (they are staff by construction of the entry token). */
async function runInviteStep(ctx: StepContext): Promise<StepOutcome> {
  if (ctx.expertProfileId === undefined) {
    return { ok: false, error: 'Pick an expert to invite before fast-forwarding to that status.' };
  }
  const result = await inviteExpertsAction({
    requestId: ctx.requestId,
    expertProfileIds: [ctx.expertProfileId],
  });
  if (!result.success) {
    return { ok: false, error: result.error };
  }
  const [invited] = result.invited;
  if (invited === undefined) {
    return {
      ok: false,
      error: 'The invite did not create a new track — that expert may already be invited.',
    };
  }
  return { ok: true, actorLabel: DEV_OPERATOR_LABEL, relationshipId: invited.relationshipId };
}

/** `eoi_submitted` — derived EXPERT (E1: `runSubmitEoi`). */
async function runEoiStep(ctx: StepContext): Promise<StepOutcome> {
  return withRequiredRelationship(ctx, async (relationshipId) => {
    const track = findTrack(ctx.request, relationshipId);
    if (track === undefined) {
      return { ok: false, error: 'Could not find that track on the request.' };
    }
    const actor = await resolveExpertActor(track);
    if (!actor.ok) {
      logActorRefusal(ctx.requestId, 'expert', actor.error);
      return { ok: false, error: actor.error };
    }
    const result = await runSubmitEoi(actor.user, {
      requestId: ctx.requestId,
      message: FAST_FORWARD_EOI_MESSAGE,
    });
    return result.success
      ? { ok: true, actorLabel: displayName(actor.user) }
      : { ok: false, error: result.error };
  });
}

/**
 * `proposal_requested` — dev operator's own session (`requestProposalAsAdmin` re-resolves
 * `MANAGE_ANY_REQUEST_SOURCING`, session + live).
 */
async function runRequestProposalStep(ctx: StepContext): Promise<StepOutcome> {
  return withRequiredRelationship(ctx, async (relationshipId) => {
    const result = await requestProposalAsAdmin({ requestId: ctx.requestId, relationshipId });
    return result.success
      ? { ok: true, actorLabel: DEV_OPERATOR_LABEL }
      : { ok: false, error: result.error };
  });
}

/** `proposal_submitted` — derived EXPERT for both sub-steps (E2 draft, then E3 submit). */
async function runSubmitProposalStep(ctx: StepContext): Promise<StepOutcome> {
  return withRequiredRelationship(ctx, async (relationshipId) => {
    const track = findTrack(ctx.request, relationshipId);
    if (track === undefined) {
      return { ok: false, error: 'Could not find that track on the request.' };
    }
    const actor = await resolveExpertActor(track);
    if (!actor.ok) {
      logActorRefusal(ctx.requestId, 'expert', actor.error);
      return { ok: false, error: actor.error };
    }

    const draftResult = await runSaveProposalDraft(
      actor.user,
      fastForwardProposalDraft(ctx.requestId, relationshipId)
    );
    if (!draftResult.success) {
      return { ok: false, error: draftResult.error };
    }

    const submitResult = await runSubmitProposal(actor.user, {
      requestId: ctx.requestId,
      relationshipId,
      proposalId: draftResult.proposalId,
    });
    return submitResult.success
      ? { ok: true, actorLabel: displayName(actor.user), proposalId: submitResult.proposalId }
      : { ok: false, error: submitResult.error };
  });
}

/**
 * `accepted` — derived CLIENT (E4: `runAcceptProposal`). `proposalId` is carried from the
 * `submit_proposal` step when this run performed it, or, when the plan enters directly at
 * `accept` (the request was already `proposal_submitted`), re-read via the existing exported
 * READ `proposalsRepository.findCurrentByRelationship` — never a writer.
 */
async function runAcceptStep(ctx: StepContext): Promise<StepOutcome> {
  return withRequiredRelationship(ctx, async (relationshipId) => {
    // S3 — containment check, matching every sibling step: never resolve a proposal for a
    // relationship id that isn't actually on this request. Without this, an arbitrary
    // `relationshipId` gives a pre-authorization existence oracle for "does this relationship
    // have a live submitted proposal" via the two distinguishable refusals below.
    if (findTrack(ctx.request, relationshipId) === undefined) {
      return { ok: false, error: 'Could not find that track on the request.' };
    }

    const actor = await resolveClientActor(ctx.request);
    if (!actor.ok) {
      logActorRefusal(ctx.requestId, 'client', actor.error);
      return { ok: false, error: actor.error };
    }

    let proposalId = ctx.proposalId;
    if (proposalId === null) {
      const current = await proposalsRepository.findCurrentByRelationship(relationshipId);
      if (current === undefined) {
        return { ok: false, error: 'This track has no submitted proposal to accept.' };
      }
      proposalId = current.id;
    }

    const result = await runAcceptProposal(actor.user, {
      requestId: ctx.requestId,
      relationshipId,
      proposalId,
    });
    return result.success
      ? { ok: true, actorLabel: displayName(actor.user) }
      : { ok: false, error: result.error };
  });
}

/** `closed` — dev operator's own session (holds `CLOSE_ANY_REQUEST` via the staff bundle). */
async function runCloseStep(ctx: StepContext): Promise<StepOutcome> {
  const result = await closeRequestAsAdminAction({
    requestId: ctx.requestId,
    reason: ctx.closeReason,
    note: FAST_FORWARD_CLOSE_NOTE,
  });
  return result.success
    ? { ok: true, actorLabel: DEV_OPERATOR_LABEL }
    : { ok: false, error: result.error };
}

/** track-`declined` — dev operator's own session (holds `CLOSE_ANY_REQUEST`). */
async function runDeclineTrackStep(ctx: StepContext): Promise<StepOutcome> {
  return withRequiredRelationship(ctx, async (relationshipId) => {
    const result = await declineTrackAsAdminAction({ requestId: ctx.requestId, relationshipId });
    return result.success
      ? { ok: true, actorLabel: DEV_OPERATOR_LABEL }
      : { ok: false, error: result.error };
  });
}

async function runFastForwardStep(step: FastForwardStep, ctx: StepContext): Promise<StepOutcome> {
  switch (step) {
    case 'invite':
      return runInviteStep(ctx);
    case 'eoi':
      return runEoiStep(ctx);
    case 'request_proposal':
      return runRequestProposalStep(ctx);
    case 'submit_proposal':
      return runSubmitProposalStep(ctx);
    case 'accept':
      return runAcceptStep(ctx);
    case 'close':
      return runCloseStep(ctx);
    case 'decline_track':
      return runDeclineTrackStep(ctx);
  }
}

// ─── `fastForwardRequestAction` ────────────────────────────────────────────────────────────

const fastForwardRequestInputSchema = z.object({
  requestId: z.uuid(),
  target: z.enum(FAST_FORWARD_TARGETS),
  /** Required only when the plan's first step is `invite` — the expert the operator picked. */
  expertProfileId: z.uuid().optional(),
  /** Required for every plan that does not start with `invite` and touches a track. */
  relationshipId: z.uuid().optional(),
  /** Only consulted when the plan includes `close`; defaults to `'unfilled'`. */
  closeReason: z.enum(BALO_CLOSE_REASONS).optional(),
});

export type FastForwardRequestInput = z.infer<typeof fastForwardRequestInputSchema>;

export interface FastForwardStepReport {
  step: FastForwardStep;
  success: boolean;
  error?: string;
  /** U3 — "as whom" this step ran: a derived party's display name, or `DEV_OPERATOR_LABEL`. */
  actorLabel?: string;
}

export type FastForwardRequestResult =
  | { success: true; from: string; to: string; steps: FastForwardStepReport[] }
  | { success: false; error: string; steps?: FastForwardStepReport[] };

/**
 * §7.1 — the step loop. Re-reads the request graph BEFORE every step (the previous step's
 * atomic rollup derivation moved it), executes steps sequentially, and stops at the first
 * non-success — steps already committed stay committed (§12: each step is its own transaction;
 * there is no cross-step transaction and there must not be one).
 */
async function runFastForwardRequest(
  operator: SessionUser,
  input: FastForwardRequestInput
): Promise<FastForwardRequestResult> {
  const { requestId, target, expertProfileId, relationshipId, closeReason } = input;

  const initialRequest = await projectRequestsRepository.findByIdWithRelations(requestId);
  if (initialRequest === undefined) {
    return { success: false, error: 'This request no longer exists.' };
  }

  // F1 — every spine step below acts on the SELECTED TRACK, so they must be planned from that
  // track's own status, never from `request.status` (a max-progress rollup over every live track:
  // on a multi-track request it reports the FURTHEST track, not the picked one). Left `undefined`
  // when no track was picked, or when the id is not on this request — the plan then falls back to
  // request grain, and the per-step runners refuse on their own terms ("Pick a track…" /
  // "Could not find that track on the request.").
  const selectedTrackStatus =
    relationshipId === undefined ? undefined : findTrack(initialRequest, relationshipId)?.status;

  const plan = planFastForward(initialRequest.status, target, selectedTrackStatus);
  if (!plan.ok) {
    return { success: false, error: refusalCopy(plan.refusal) };
  }

  const [firstStep] = plan.steps;
  if (firstStep === 'invite' && expertProfileId === undefined) {
    return {
      success: false,
      error: 'Pick an expert to invite before fast-forwarding to that status.',
    };
  }
  if (
    firstStep !== 'invite' &&
    plan.steps.some((step) => NEEDS_RELATIONSHIP_STEPS.has(step)) &&
    relationshipId === undefined
  ) {
    return { success: false, error: 'Pick a track before fast-forwarding to that status.' };
  }

  const fromStatus = initialRequest.status;
  const steps: FastForwardStepReport[] = [];
  let liveRelationshipId = relationshipId ?? null;
  let liveProposalId: string | null = null;

  for (const step of plan.steps) {
    const request = await projectRequestsRepository.findByIdWithRelations(requestId);
    if (request === undefined) {
      steps.push({ step, success: false, error: 'This request no longer exists.' });
      return { success: false, error: 'This request no longer exists.', steps };
    }

    const outcome = await runFastForwardStep(step, {
      requestId,
      request,
      relationshipId: liveRelationshipId,
      expertProfileId,
      proposalId: liveProposalId,
      closeReason: closeReason ?? 'unfilled',
    });

    if (!outcome.ok) {
      steps.push({ step, success: false, error: outcome.error });
      log.warn('Fast-forward step refused', { requestId, step, error: outcome.error });
      return { success: false, error: outcome.error, steps };
    }

    steps.push({ step, success: true, actorLabel: outcome.actorLabel });
    if (outcome.relationshipId !== undefined) liveRelationshipId = outcome.relationshipId;
    if (outcome.proposalId !== undefined) liveProposalId = outcome.proposalId;
  }

  const after = await projectRequestsRepository.findById(requestId);
  const toStatus = after?.status ?? fromStatus;

  log.info('Request fast-forwarded', {
    requestId,
    target,
    from: fromStatus,
    to: toStatus,
    steps: plan.steps,
    operatorUserId: operator.id,
  });

  return { success: true, from: fromStatus, to: toStatus, steps };
}

export async function fastForwardRequestAction(
  input: FastForwardRequestInput
): Promise<FastForwardRequestResult> {
  const gate = await resolveFastForwardOperator();
  if (!gate.ok) {
    return { success: false, error: gate.error };
  }

  const parsed = fastForwardRequestInputSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: 'Invalid request.' };
  }

  try {
    return await runFastForwardRequest(gate.user, parsed.data);
  } catch (error) {
    log.error('Fast-forward request failed', {
      requestId: parsed.data.requestId,
      target: parsed.data.target,
      operatorUserId: gate.user.id,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { success: false, error: 'Could not fast-forward this request. Please try again.' };
  }
}

// ─── `markThreadReadAsPartyAction` ─────────────────────────────────────────────────────────

const markThreadReadAsPartyInputSchema = z.object({
  requestId: z.uuid(),
  relationshipId: z.uuid(),
  side: z.enum(['client', 'expert']),
});

export type MarkThreadReadAsPartyInput = z.infer<typeof markThreadReadAsPartyInputSchema>;

export type MarkThreadReadAsPartyResult =
  | { success: true; lastReadAtIso: string }
  | { success: false; error: string };

async function resolvePartyExpertActor(
  request: ProjectRequestWithRelations,
  relationshipId: string
): Promise<ActorResolution> {
  const track = findTrack(request, relationshipId);
  if (track === undefined) {
    return { ok: false, error: 'Could not find that track on the request.' };
  }
  return resolveExpertActor(track);
}

async function runMarkThreadReadAsParty(
  input: MarkThreadReadAsPartyInput
): Promise<MarkThreadReadAsPartyResult> {
  const { requestId, relationshipId, side } = input;

  const request = await projectRequestsRepository.findByIdWithRelations(requestId);
  if (request === undefined) {
    return { success: false, error: 'This request no longer exists.' };
  }

  const actor =
    side === 'client'
      ? await resolveClientActor(request)
      : await resolvePartyExpertActor(request, relationshipId);
  if (!actor.ok) {
    logActorRefusal(requestId, side, actor.error);
    return { success: false, error: actor.error };
  }

  return runMarkThreadRead(actor.user, { requestId, relationshipId });
}

/**
 * `markThreadRead` — derived CLIENT or EXPERT, operator picks the side (§7). The dev operator
 * CANNOT do this themselves: `resolveConversationAccess` denies admin observers outright
 * (`resolve-conversation-access.ts:120`), so this row has no staff-session arm at all.
 */
export async function markThreadReadAsPartyAction(
  input: MarkThreadReadAsPartyInput
): Promise<MarkThreadReadAsPartyResult> {
  const gate = await resolveFastForwardOperator();
  if (!gate.ok) {
    return { success: false, error: gate.error };
  }

  const parsed = markThreadReadAsPartyInputSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: 'Invalid request.' };
  }

  try {
    return await runMarkThreadReadAsParty(parsed.data);
  } catch (error) {
    log.error('Fast-forward mark-thread-read failed', {
      requestId: parsed.data.requestId,
      relationshipId: parsed.data.relationshipId,
      side: parsed.data.side,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { success: false, error: 'Could not update the thread. Please try again.' };
  }
}

// ─── `inspectFastForwardRequestAction` ─────────────────────────────────────────────────────

const inspectFastForwardRequestInputSchema = z.object({ requestId: z.uuid() });

export type InspectFastForwardRequestInput = z.infer<typeof inspectFastForwardRequestInputSchema>;

export interface FastForwardTrack {
  relationshipId: string;
  expertProfileId: string;
  expertName: string;
  status: string;
}

export type InspectFastForwardRequestResult =
  | {
      success: true;
      requestId: string;
      status: string;
      clientContactName: string;
      tracks: FastForwardTrack[];
    }
  | { success: false; error: string };

async function runInspectFastForwardRequest(
  input: InspectFastForwardRequestInput
): Promise<InspectFastForwardRequestResult> {
  const request = await projectRequestsRepository.findByIdWithRelations(input.requestId);
  if (request === undefined) {
    return { success: false, error: 'This request no longer exists.' };
  }

  return {
    success: true,
    requestId: request.id,
    status: request.status,
    clientContactName: displayName(request.createdByUser),
    tracks: request.relationships.map((relationship) => ({
      relationshipId: relationship.id,
      expertProfileId: relationship.expertProfileId,
      expertName: displayName(relationship.expertProfile.user),
      status: relationship.status,
    })),
  };
}

/** Row 1 of the panel ("Load a request") — status + client contact + track list for the picker. */
export async function inspectFastForwardRequestAction(
  input: InspectFastForwardRequestInput
): Promise<InspectFastForwardRequestResult> {
  const gate = await resolveFastForwardOperator();
  if (!gate.ok) {
    return { success: false, error: gate.error };
  }

  const parsed = inspectFastForwardRequestInputSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: 'Invalid request.' };
  }

  try {
    return await runInspectFastForwardRequest(parsed.data);
  } catch (error) {
    log.error('Fast-forward inspect failed', {
      requestId: parsed.data.requestId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { success: false, error: 'Could not load that request. Please try again.' };
  }
}
