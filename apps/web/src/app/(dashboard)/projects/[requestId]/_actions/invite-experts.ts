'use server';

import 'server-only';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import {
  expertsRepository,
  projectRequestsRepository,
  requestExpertRelationshipsRepository,
} from '@balo/db';
import { PLATFORM_CAPABILITIES } from '@/lib/authz/platform';
import { log } from '@/lib/logging';
import { publishNotificationEvent } from '@/lib/notifications/publish';
import { lockContentionFailure } from './_shared/deadlock';
import { requireRequestStaffCapability } from './_shared/require-request-staff-capability';

const inputSchema = z.object({
  requestId: z.uuid(),
  // 20 = a sane invite-batch cap.
  expertProfileIds: z.array(z.uuid()).min(1).max(20),
});

export interface InvitedExpert {
  relationshipId: string;
  expertProfileId: string;
}

export type InviteExpertsResult =
  | {
      success: true;
      invitedCount: number;
      /** Whether the request-level status advanced to `experts_invited`. */
      transitioned: boolean;
      /** The status the request transitioned FROM (only when `transitioned`). */
      from?: 'requested' | 'exploratory_meeting_requested';
      /** ms from request creation → first admin action — only on the first move. */
      firstAdminActionMs?: number;
      invited: InvitedExpert[];
    }
  | {
      success: false;
      error: string;
      /** Set when the batch was refused because an expert cannot take new work. */
      code?: 'expert_unavailable';
      /** The `expert_profiles.id`s that cannot take new work — present with `code`. */
      unavailableExpertProfileIds?: string[];
    };

/** Statuses from which the FIRST invite advances the request to `experts_invited`. */
const TRANSITION_FROM_STATUSES = new Set<string>(['requested', 'exploratory_meeting_requested']);
/** Statuses where inviting (first or another) is allowed. */
const INVITE_WINDOW_STATUSES = new Set<string>([
  'requested',
  'exploratory_meeting_requested',
  'experts_invited',
  'eoi_submitted',
]);

/**
 * The selected experts who cannot take new work (paused, suspended or deleted owner, not
 * published), with why. An invite opens new work, so one such expert refuses the whole batch.
 */
async function findUnavailableExperts(
  expertProfileIds: readonly string[]
): Promise<{ id: string; reason: string }[]> {
  const eligibilities = await Promise.all(
    expertProfileIds.map((id) => expertsRepository.findNewWorkEligibility(id))
  );
  const unavailable: { id: string; reason: string }[] = [];
  expertProfileIds.forEach((id, index) => {
    const eligibility = eligibilities[index];
    if (eligibility !== undefined && !eligibility.eligible) {
      unavailable.push({ id, reason: eligibility.reason });
    }
  });
  return unavailable;
}

/** The batch refusal when any selected expert cannot take new work, else `null`. */
async function refuseUnavailableExperts(
  requestId: string,
  adminUserId: string,
  expertProfileIds: readonly string[]
): Promise<Extract<InviteExpertsResult, { success: false }> | null> {
  const unavailable = await findUnavailableExperts(expertProfileIds);
  if (unavailable.length === 0) return null;
  log.warn('Expert invite refused — expert not taking on new work', {
    requestId,
    adminUserId,
    unavailable,
  });
  return {
    success: false,
    error: "One or more of these experts aren't taking on new work right now.",
    code: 'expert_unavailable',
    unavailableExpertProfileIds: unavailable.map((u) => u.id),
  };
}

/**
 * Invite each selected expert, returning only the ones newly invited. `invite()`
 * returns `undefined` for a LIVE duplicate (idempotent skip); a previously removed
 * (soft-deleted) expert is re-invited as a fresh row. A genuine error (FK /
 * connection) is NOT caught here — it propagates to the action's catch so the
 * admin sees a real failure rather than a silent "skipped".
 */
async function inviteEachExpert(
  requestId: string,
  expertProfileIds: readonly string[],
  invitedByUserId: string,
  title: string
): Promise<InvitedExpert[]> {
  const invited: InvitedExpert[] = [];
  for (const expertProfileId of expertProfileIds) {
    const rel = await requestExpertRelationshipsRepository.invite({
      projectRequestId: requestId,
      expertProfileId,
      invitedByUserId,
    });
    if (rel === undefined) {
      log.warn('Duplicate invite skipped (live relationship already exists)', {
        requestId,
        expertProfileId,
      });
      continue;
    }
    invited.push({ relationshipId: rel.id, expertProfileId });

    // Fire-and-forget per successful invite — never blocks the batch.
    publishNotificationEvent('project.expert_invited', {
      correlationId: rel.id,
      projectRequestId: requestId,
      expertProfileId,
      title,
    }).catch(() => {
      // publishNotificationEvent logs internally.
    });
  }
  return invited;
}

type InvitableRequest = NonNullable<Awaited<ReturnType<typeof projectRequestsRepository.findById>>>;

/**
 * Single, idempotent request-level transition to `experts_invited` — only on the FIRST invite.
 * Returns whether it ran.
 */
async function transitionOnFirstInvite(
  request: InvitableRequest,
  invitedCount: number
): Promise<boolean> {
  const transitioned = TRANSITION_FROM_STATUSES.has(request.status) && invitedCount > 0;
  if (transitioned) {
    await projectRequestsRepository.transitionStatus({
      id: request.id,
      to: 'experts_invited',
      expectedFrom: request.status,
    });
  }
  return transitioned;
}

function buildSuccessResult(
  request: InvitableRequest,
  invited: InvitedExpert[],
  transitioned: boolean
): Extract<InviteExpertsResult, { success: true }> {
  const from =
    request.status === 'requested' || request.status === 'exploratory_meeting_requested'
      ? request.status
      : undefined;
  return {
    success: true,
    invitedCount: invited.length,
    transitioned,
    from: transitioned ? from : undefined,
    firstAdminActionMs:
      request.status === 'requested' ? Date.now() - request.createdAt.getTime() : undefined,
    invited,
  };
}

/**
 * Admin triage — invite one or more experts to a request.
 *
 * Invites each expert (live dup invites are skipped idempotently; removed experts
 * can be re-invited), then performs a SINGLE request-level transition to
 * `experts_invited` only when the request is currently
 * `requested`/`exploratory_meeting_requested` and at least one new invite landed.
 * `experts_invited → experts_invited` is illegal, so the "invite another" path
 * performs no transition.
 */
export async function inviteExpertsAction(
  input: z.infer<typeof inputSchema>
): Promise<InviteExpertsResult> {
  const auth = await requireRequestStaffCapability(
    PLATFORM_CAPABILITIES.MANAGE_ANY_REQUEST_SOURCING
  );
  if (!auth.ok) {
    return { success: false, error: auth.error };
  }
  const admin = auth.user;

  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: 'Invalid request.' };
  }
  const { requestId, expertProfileIds } = parsed.data;

  try {
    const request = await projectRequestsRepository.findById(requestId);
    if (request === undefined) {
      return { success: false, error: 'This request no longer exists.' };
    }

    if (!INVITE_WINDOW_STATUSES.has(request.status)) {
      return { success: false, error: 'Experts can no longer be invited to this request.' };
    }

    const refusal = await refuseUnavailableExperts(requestId, admin.id, expertProfileIds);
    if (refusal !== null) return refusal;

    const invited = await inviteEachExpert(requestId, expertProfileIds, admin.id, request.title);

    const transitioned = await transitionOnFirstInvite(request, invited.length);

    if (invited.length > 0) {
      log.info('Experts invited to request', {
        requestId,
        adminUserId: admin.id,
        invitedCount: invited.length,
        transitioned,
      });
    }

    revalidatePath(`/projects/${requestId}`);

    return buildSuccessResult(request, invited, transitioned);
  } catch (error) {
    // ⚠ fix round R1 — `requestExpertRelationshipsRepository.invite` is one of the eleven
    // writers serialised on the per-request advisory lock (`_shared/request-lock.ts`) — it is
    // the racer named in `close()`'s own KNOWN RESIDUAL block. A 55P03 here means the invite
    // never wrote anything and a retry queues again. WARN + retryable copy, checked BEFORE the
    // generic fallback below — never `log.error` for an expected-rare, self-healing event.
    const lockContention = lockContentionFailure(
      error,
      'Expert invite aborted by lock contention — retryable',
      { requestId, adminUserId: admin.id }
    );
    if (lockContention !== null) return lockContention;
    log.error('Failed to invite experts', {
      requestId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { success: false, error: 'Could not invite experts. Please try again.' };
  }
}
