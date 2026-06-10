'use server';

import 'server-only';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import {
  projectRequestsRepository,
  requestExpertRelationshipsRepository,
  conversationsRepository,
  InvalidStatusTransitionError,
  InvalidRelationshipTransitionError,
  type ProjectRequestWithRelations,
  type RelationshipStatus,
} from '@balo/db';
import { requireUser } from '@/lib/auth/session';
import { resolveConversationAccess } from '@/lib/project-request/resolve-conversation-access';
import { log } from '@/lib/logging';
import { publishNotificationEvent } from '@/lib/notifications/publish';

const inputSchema = z.object({
  requestId: z.uuid(),
  // A CLAIM — validated server-side by `resolveConversationAccess`, never an authority.
  relationshipId: z.uuid(),
});

const ALREADY_REQUESTED = "You've already requested a proposal from this expert.";
const NO_LONGER_AVAILABLE = 'You can no longer request a proposal from this expert.';
const GENERIC_FAILURE = 'Could not request the proposal. Please try again.';

/** Relationship statuses at/after a proposal request — re-requesting is a no-op. */
const AT_OR_PAST_PROPOSAL_REQUEST = new Set<RelationshipStatus>([
  'proposal_requested',
  'proposal_submitted',
  'accepted',
]);

export type RequestProposalResult =
  | {
      success: true;
      /** Whether the REQUEST-level status advanced `eoi_submitted → proposal_requested`. */
      transitioned: boolean;
      expertProfileId: string;
      /** Server-computed — the island attaches these to `PROJECT_PROPOSAL_REQUESTED`. */
      analytics: {
        /** Relationships at/after `proposal_requested`, INCLUDING this one. */
        proposalRequestCount: number;
        /** Earliest live EOI on the request → now; `null` if none resolvable. */
        timeFromFirstEoiMs: number | null;
        /** This thread's live message rows. */
        messageCount: number;
        /** This thread's live file rows. */
        fileCount: number;
      };
    }
  | { success: false; error: string; code?: 'already_requested' };

/**
 * Earliest live-EOI `submittedAt` across the request's relationships (each is
 * hydrated `limit:1` newest-first). Known approximation (recorded in the event
 * map): a withdrawn-and-resubmitted EOI reports the resubmit time.
 */
function firstEoiSubmittedAt(request: ProjectRequestWithRelations): Date | null {
  let earliest: Date | null = null;
  for (const relationship of request.relationships) {
    const [eoi] = relationship.expressionsOfInterest;
    if (eoi === undefined) continue;
    if (earliest === null || eoi.submittedAt.getTime() < earliest.getTime()) {
      earliest = eoi.submittedAt;
    }
  }
  return earliest;
}

/**
 * Client requests a formal proposal from one expert (BAL-272 / A5).
 *
 * The confirmation beat lives in the UI; this action is the commit:
 *  - per-thread truth: the RELATIONSHIP transitions `eoi_submitted →
 *    proposal_requested` (stamping `proposal_requested_at`), guarded by
 *    `expectedFrom` against double-clicks and stale tabs;
 *  - request-level aggregate: advanced `eoi_submitted → proposal_requested` on
 *    the FIRST proposal request only, caller-owned, tolerating
 *    `InvalidStatusTransitionError` as a benign concurrent race — byte-for-byte
 *    the `submit-eoi.ts` pattern;
 *  - notifies the expert (`project.proposal_requested`, email + in-app,
 *    fire-and-forget) and returns server-computed analytics for the island.
 *
 * IDOR-safe: `relationshipId` is only a claim — `resolveConversationAccess`
 * denies non-participants, admin observers, closed threads and foreign
 * relationship ids with uniform non-leaking copy. Access alone is not enough
 * (the resolver admits the expert's own thread), so an explicit lens guard
 * rejects any non-client caller.
 *
 * Proposal cap (`proposal_cap` column) enforcement hooks here — deferred.
 */
export async function requestProposalAction(
  input: z.infer<typeof inputSchema>
): Promise<RequestProposalResult> {
  let user;
  try {
    user = await requireUser();
  } catch {
    return { success: false, error: 'You are not signed in.' };
  }

  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: 'Invalid request.' };
  }
  const { requestId, relationshipId } = parsed.data;

  try {
    const access = await resolveConversationAccess(user, requestId, relationshipId);
    if (!access.ok) {
      return { success: false, error: access.error };
    }

    // Lens guard: an expert must never trigger their own proposal request.
    if (access.ctx.lens !== 'client') {
      return { success: false, error: 'Only the client can request a proposal.' };
    }

    // Pre-check the loaded relationship for friendly stale-UI copy (the
    // transition's `expectedFrom` guard remains the authoritative gate).
    const { relationship } = access;
    if (AT_OR_PAST_PROPOSAL_REQUEST.has(relationship.status)) {
      return { success: false, error: ALREADY_REQUESTED, code: 'already_requested' };
    }
    if (relationship.status !== 'eoi_submitted') {
      return { success: false, error: NO_LONGER_AVAILABLE };
    }

    // Per-thread truth: advance THE RELATIONSHIP. `expectedFrom` turns a
    // concurrent double-click into a typed error, not a corrupt state.
    try {
      await requestExpertRelationshipsRepository.transitionStatus({
        id: relationshipId,
        to: 'proposal_requested',
        expectedFrom: 'eoi_submitted',
      });
    } catch (error) {
      if (error instanceof InvalidRelationshipTransitionError) {
        return { success: false, error: ALREADY_REQUESTED, code: 'already_requested' };
      }
      throw error;
    }

    // Caller-owned REQUEST-level transition, FIRST-REQUEST-ONLY: the request
    // status is the max-progress aggregate. A second expert's proposal request
    // arrives when the request is already `proposal_requested` → skip.
    // `expectedFrom` also defends the two-first-requests race.
    let transitioned = false;
    if (access.request.status === 'eoi_submitted') {
      try {
        await projectRequestsRepository.transitionStatus({
          id: requestId,
          to: 'proposal_requested',
          expectedFrom: 'eoi_submitted',
        });
        transitioned = true;
      } catch (error) {
        if (error instanceof InvalidStatusTransitionError) {
          // Another thread's first request advanced it between our read and
          // write — same end-state. The relationship transition stands.
          log.warn('Proposal request transition skipped (already advanced via another thread)', {
            requestId,
          });
        } else {
          throw error;
        }
      }
    }

    // Server-computed analytics — the graph was loaded PRE-transition, so this
    // relationship still counts as `eoi_submitted` there (hence the +1).
    const proposalRequestCount =
      access.request.relationships.filter((r) => AT_OR_PAST_PROPOSAL_REQUEST.has(r.status)).length +
      1;
    const firstEoiAt = firstEoiSubmittedAt(access.request);
    const timeFromFirstEoiMs = firstEoiAt === null ? null : Date.now() - firstEoiAt.getTime();
    const { messageCount, fileCount } =
      await conversationsRepository.countThreadActivity(relationshipId);

    log.info('Proposal requested', {
      requestId,
      relationshipId,
      userId: user.id,
      transitioned,
    });

    // Fire-and-forget — notification failure must not block the commit.
    publishNotificationEvent('project.proposal_requested', {
      correlationId: relationshipId,
      projectRequestId: requestId,
      relationshipId,
      expertProfileId: relationship.expertProfileId,
      title: access.request.title,
    }).catch(() => {
      // publishNotificationEvent logs internally.
    });

    revalidatePath(`/projects/${requestId}`);

    return {
      success: true,
      transitioned,
      expertProfileId: relationship.expertProfileId,
      analytics: { proposalRequestCount, timeFromFirstEoiMs, messageCount, fileCount },
    };
  } catch (error) {
    log.error('Failed to request proposal', {
      requestId,
      relationshipId,
      userId: user.id,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { success: false, error: GENERIC_FAILURE };
  }
}
