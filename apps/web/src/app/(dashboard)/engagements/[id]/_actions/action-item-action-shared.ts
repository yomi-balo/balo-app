import 'server-only';

import { revalidatePath } from 'next/cache';
import {
  actionItemsRepository,
  engagementsRepository,
  EngagementNotActiveError,
  InvalidActionItemTransitionError,
  type ActionItem,
  type ActionItemAssigneeParty,
  type EngagementWithMilestones,
} from '@balo/db';
import {
  resolveEngagementLens,
  type EngagementLens,
} from '@/lib/engagement/resolve-engagement-lens';
import { deriveEngagementParties, personAtCompany } from '@/lib/engagement/engagement-parties';
import { hasCapability, CAPABILITIES } from '@/lib/authz';
import { requireOnboardedUser, type SessionUser } from '@/lib/auth/session';
import { publishNotificationEvent } from '@/lib/notifications/publish';
import { log } from '@/lib/logging';
import { resolveClientRecipientId, deriveEngagementTitle } from './milestone-action-shared';
import { formatLongUtc } from './engagement-lifecycle-shared';

/**
 * The uniform result every action-item Server Action returns. The client island
 * toasts a copy of its own choosing on success (`actionItemId` reconciles the
 * optimistic list) and toasts `error` verbatim on failure — all `error` copy below is
 * friendly + non-leaking.
 */
export type ActionItemActionResult =
  | { success: true; actionItemId: string }
  | { success: false; error: string };

// ── Friendly, non-leaking copy (returned verbatim; the client toasts it) ─────
export const NOT_SIGNED_IN = 'You are not signed in.';
export const INVALID_REQUEST = 'Invalid request.';
export const NOT_FOUND = 'This engagement could not be found.';
export const NOT_A_PARTICIPANT = 'Only people on this project can do that.';
export const NOT_ACTIVE = "This project isn't active.";
export const ACTION_ITEM_GONE = 'This action item is no longer here — refresh and try again.';
export const STATUS_CHANGED =
  'This action item changed since you loaded the page. Refresh and try again.';
export const GENERIC_FAILURE = 'Something went wrong. Please try again.';

/** `requireOnboardedUser` wrapped once → the uniform `NOT_SIGNED_IN` result on throw. */
export async function requireActionItemUser(): Promise<
  { ok: true; user: SessionUser } | { ok: false; error: string }
> {
  try {
    return { ok: true, user: await requireOnboardedUser() };
  } catch {
    return { ok: false, error: NOT_SIGNED_IN };
  }
}

/** The authorized context handed to a per-action `perform` callback. */
export interface AuthorizedActionItem {
  user: SessionUser;
  engagement: EngagementWithMilestones;
  lens: EngagementLens;
  /** Present iff `opts.actionItemId` was supplied AND validated (IDOR). */
  actionItem?: ActionItem;
}

/** The gate result — the loaded engagement + lens (+ the validated item) or a friendly error. */
export type ActionItemGateResult =
  | {
      ok: true;
      engagement: EngagementWithMilestones;
      lens: EngagementLens;
      actionItem?: ActionItem;
    }
  | { ok: false; error: string };

/**
 * The single IDOR-safe engagement-participant gate for every action-item mutation.
 * Reuses the established delivery-workspace seam (never hand-rolled):
 *   1. Load the engagement via the workspace loader (hydrates company + expertProfile
 *      needed for parties + notify).
 *   2. `resolveEngagementLens` — a stranger (`null`) or a missing row both yield the
 *      SAME `NOT_FOUND` (existence never leaks); denials are `log.warn`ed.
 *   3. Per-lens authorization: `client` → LIVE `hasCapability(PARTICIPATE)`
 *      (defense-in-depth beyond the cached cookie; a removed member fails closed);
 *      `expert` → the `lens === 'expert'` `expertProfileId` equality IS the check
 *      (the house pattern); `admin` → allowed (observer — confirmed product decision).
 *   4. `status !== 'active'` → `NOT_ACTIVE` (writes only on live engagements).
 *   5. When `opts.actionItemId` is set: `findById` → miss / not-in-this-engagement /
 *      soft-removed → `ACTION_ITEM_GONE` (a forged id from another engagement is
 *      rejected before any write).
 */
export async function gateEngagementParticipant(
  user: SessionUser,
  engagementId: string,
  opts?: { actionItemId?: string }
): Promise<ActionItemGateResult> {
  const deny = (reason: string, error: string): { ok: false; error: string } => {
    log.warn('Action item action denied', {
      engagementId,
      actionItemId: opts?.actionItemId,
      userId: user.id,
      reason,
    });
    return { ok: false, error };
  };

  const engagement = await engagementsRepository.findEngagementWithMilestones(engagementId);
  if (engagement === undefined) {
    return deny('engagement_not_found', NOT_FOUND);
  }

  const ctx = resolveEngagementLens(user, engagement);
  if (ctx === null) {
    // Stranger — same 404 as a missing row (no existence leak).
    return deny('not_a_participant', NOT_FOUND);
  }

  // Per-lens authorization beyond the lens resolution itself:
  //  - client: defense-in-depth — re-check LIVE membership (a stale cookie fails closed);
  //  - expert: the `lens === 'expert'` expertProfileId equality IS the check (house pattern);
  //  - admin:  allowed (observer; confirmed product decision).
  if (ctx.lens === 'client') {
    const allowed = await hasCapability(user, CAPABILITIES.PARTICIPATE, {
      companyId: engagement.companyId,
    });
    if (!allowed) {
      return deny('no_capability', NOT_A_PARTICIPANT);
    }
  }

  if (engagement.status !== 'active') {
    return deny('not_active', NOT_ACTIVE);
  }

  // IDOR: an action-item-scoped action must target an item that belongs to THIS engagement.
  if (opts?.actionItemId !== undefined) {
    const actionItem = await actionItemsRepository.findById(opts.actionItemId);
    if (
      actionItem === undefined ||
      actionItem.engagementId !== engagement.id ||
      actionItem.deletedAt !== null
    ) {
      return deny('action_item_not_in_engagement', ACTION_ITEM_GONE);
    }
    return { ok: true, engagement, lens: ctx.lens, actionItem };
  }

  return { ok: true, engagement, lens: ctx.lens };
}

/**
 * The single audited orchestration boundary shared by all five action-item actions
 * (mirrors `runExpertEngagementAction`): gate via {@link gateEngagementParticipant} →
 * run `perform` (repo write + analytics + notify + `log.info`) → `revalidatePath` on
 * success → map the two typed race errors to friendly copy WITHOUT logging (an expected
 * concurrent-tab race the repo re-checks under its FOR UPDATE lock:
 * `EngagementNotActiveError → NOT_ACTIVE`, `InvalidActionItemTransitionError →
 * STATUS_CHANGED`); any other throw is the genuine failure boundary (`log.error` with
 * message + stack → `GENERIC_FAILURE`). Kept in ONE place (SonarCloud new-code
 * duplication gate).
 */
export async function runActionItemAction(
  user: SessionUser,
  engagementId: string,
  opts: { actionItemId?: string },
  failLabel: string,
  perform: (authorized: AuthorizedActionItem) => Promise<ActionItemActionResult>
): Promise<ActionItemActionResult> {
  const logContext: Record<string, unknown> =
    opts.actionItemId === undefined
      ? { userId: user.id }
      : { actionItemId: opts.actionItemId, userId: user.id };
  try {
    const gate = await gateEngagementParticipant(user, engagementId, opts);
    if (!gate.ok) {
      return { success: false, error: gate.error };
    }
    const result = await perform({
      user,
      engagement: gate.engagement,
      lens: gate.lens,
      actionItem: gate.actionItem,
    });
    // A typed-race failure surfaced by `perform` → no revalidate (nothing changed).
    if (result.success) {
      revalidatePath(`/engagements/${engagementId}`);
    }
    return result;
  } catch (error) {
    if (error instanceof EngagementNotActiveError) {
      return { success: false, error: NOT_ACTIVE };
    }
    if (error instanceof InvalidActionItemTransitionError) {
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

/**
 * The notification recipients for the assigned SIDE: for `client`, the best-effort
 * company owner (`recipientId`; may be undefined → the client rule skips); for `expert`,
 * the engagement's delivering `expertProfileId` (→ the resolver hydrates data.expert).
 */
export async function deriveAssigneeNotifyTargets(
  engagement: EngagementWithMilestones,
  assigneeParty: ActionItemAssigneeParty
): Promise<{ recipientId?: string; expertProfileId?: string }> {
  if (assigneeParty === 'client') {
    return { recipientId: await resolveClientRecipientId(engagement.company.id) };
  }
  return { expertProfileId: engagement.expertProfileId };
}

/**
 * The retrospective person who assigned the item (BAL-329): `expert` → the expert's
 * "@ agency" first-mention; `client` → the acting person "@ company"; `admin` → 'Balo'
 * (the platform actor label).
 */
export function deriveActorLabel(
  engagement: EngagementWithMilestones,
  lens: EngagementLens,
  user: SessionUser
): string {
  if (lens === 'admin') {
    return 'Balo';
  }
  if (lens === 'expert') {
    return deriveEngagementParties(engagement).expertRetroFirstMention;
  }
  return personAtCompany(
    { firstName: user.firstName, lastName: user.lastName },
    engagement.company.name
  );
}

/**
 * Publish `action_item.assigned` (fire-and-forget) — ONE place so create-with-assignee
 * AND assign never copy-paste the payload assembly (SonarCloud new-code duplication
 * gate). Resolves the assigned-side targets, derives the retrospective actor label +
 * project title (BAL-329), and stamps a fresh `correlationId` so a reassign re-notifies
 * (a dispatcher retry dedups by jobId). A lost notification leaves a diagnosable trace.
 */
export async function publishActionItemAssigned(
  engagement: EngagementWithMilestones,
  lens: EngagementLens,
  user: SessionUser,
  actionItem: ActionItem,
  assigneeParty: ActionItemAssigneeParty
): Promise<void> {
  const targets = await deriveAssigneeNotifyTargets(engagement, assigneeParty);
  const parties = deriveEngagementParties(engagement);
  const correlationId = `${actionItem.id}:assigned:${Date.now()}`;
  publishNotificationEvent('action_item.assigned', {
    correlationId,
    engagementId: engagement.id,
    actionItemId: actionItem.id,
    assigneeParty,
    recipientId: targets.recipientId,
    expertProfileId: targets.expertProfileId,
    actorLabel: deriveActorLabel(engagement, lens, user),
    projectTitle: deriveEngagementTitle(engagement, parties),
    actionItemBody: actionItem.body,
    dueOn: actionItem.dueAt ? formatLongUtc(actionItem.dueAt) : undefined,
  }).catch((error) => {
    log.error('action_item.assigned publish failed', {
      correlationId,
      engagementId: engagement.id,
      actionItemId: actionItem.id,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
  });
}
