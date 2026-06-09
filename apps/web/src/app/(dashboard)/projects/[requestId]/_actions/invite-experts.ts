'use server';

import 'server-only';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { projectRequestsRepository, requestExpertRelationshipsRepository } from '@balo/db';
import { requireAdmin } from '@/lib/auth/require-admin';
import { log } from '@/lib/logging';
import { publishNotificationEvent } from '@/lib/notifications/publish';

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
  | { success: false; error: string };

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
 * Admin triage — invite one or more experts to a request.
 *
 * Loops `invite()` per expert (per-expert dup invites are skipped idempotently),
 * then performs a SINGLE request-level transition to `experts_invited` only when
 * the request is currently `requested`/`exploratory_meeting_requested` and at
 * least one new invite landed. `experts_invited → experts_invited` is illegal, so
 * the "invite another" path performs no transition.
 */
export async function inviteExpertsAction(
  input: z.infer<typeof inputSchema>
): Promise<InviteExpertsResult> {
  let admin;
  try {
    admin = await requireAdmin();
  } catch {
    return { success: false, error: 'You do not have permission to do this.' };
  }

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

    const invited: InvitedExpert[] = [];
    for (const expertProfileId of expertProfileIds) {
      try {
        const rel = await requestExpertRelationshipsRepository.invite({
          projectRequestId: requestId,
          expertProfileId,
          invitedByUserId: admin.id,
        });
        invited.push({ relationshipId: rel.id, expertProfileId });

        // Fire-and-forget per successful invite — never blocks the batch.
        publishNotificationEvent('project.expert_invited', {
          correlationId: rel.id,
          projectRequestId: requestId,
          expertProfileId,
          title: request.title,
        }).catch(() => {
          // publishNotificationEvent logs internally.
        });
      } catch {
        // Unique (project_request_id, expert_profile_id) index → already invited.
        // Treat as an idempotent skip so a partial overlap doesn't abort the batch.
        log.warn('Duplicate invite skipped', { requestId, expertProfileId });
      }
    }

    // Single, idempotent request-level transition — only on the FIRST invite.
    const needsTransition = TRANSITION_FROM_STATUSES.has(request.status);
    const transitioned = needsTransition && invited.length > 0;
    if (transitioned) {
      await projectRequestsRepository.transitionStatus({
        id: requestId,
        to: 'experts_invited',
        expectedFrom: request.status,
      });
    }

    if (invited.length > 0) {
      log.info('Experts invited to request', {
        requestId,
        adminUserId: admin.id,
        invitedCount: invited.length,
        transitioned,
      });
    }

    revalidatePath(`/projects/${requestId}`);

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
  } catch (error) {
    log.error('Failed to invite experts', {
      requestId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { success: false, error: 'Could not invite experts. Please try again.' };
  }
}
