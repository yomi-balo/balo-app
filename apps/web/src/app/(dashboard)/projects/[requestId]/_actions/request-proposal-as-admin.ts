'use server';

import 'server-only';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import {
  projectRequestsRepository,
  requestExpertRelationshipsRepository,
  conversationsRepository,
  InvalidRelationshipTransitionError,
  type RelationshipStatus,
} from '@balo/db';
import { requireAdmin } from '@/lib/auth/require-admin';
import { log } from '@/lib/logging';
import { publishNotificationEvent } from '@/lib/notifications/publish';
import {
  AT_OR_PAST_PROPOSAL_REQUEST,
  firstEoiSubmittedAt,
} from './_shared/proposal-request-analytics';

const inputSchema = z.object({
  requestId: z.uuid(),
  relationshipId: z.uuid(),
});

const ALREADY_REQUESTED = 'A proposal has already been requested from this expert.';
const NO_LONGER_AVAILABLE = 'You can no longer request a proposal from this expert.';
const REQUEST_GONE = 'This request can no longer take a proposal request.';
const NOT_ON_REQUEST = 'This expert is not on this request.';
const GENERIC_FAILURE = 'Could not request the proposal. Please try again.';

export type RequestProposalAsAdminResult =
  | {
      success: true;
      expertProfileId: string;
      /** Whether the REQUEST-level rollup advanced as a result of this transition. */
      transitioned: boolean;
      /** The request-level from→to when it advanced; `null` otherwise. */
      requestTransition: { from: string; to: string } | null;
      /** Server-computed — the admin island attaches these to `PROJECT_PROPOSAL_REQUESTED`. */
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
 * Advance the relationship → `proposal_requested` with NO `expectedFrom` (admin
 * full bypass — the transition map permits `invited`/`eoi_submitted →
 * proposal_requested`). The advance ALSO derives the request rollup atomically
 * (ADR-1025 / BAL-295). Maps a concurrent race
 * (`InvalidRelationshipTransitionError`) to `'already_requested'`; rethrows
 * anything unexpected to the action's generic-failure boundary. Split out so the
 * action's cognitive complexity stays under the gate.
 */
async function advanceRelationshipGuarded(
  relationshipId: string
): Promise<'ok' | 'already_requested'> {
  try {
    await requestExpertRelationshipsRepository.transitionStatus({
      id: relationshipId,
      to: 'proposal_requested',
    });
    return 'ok';
  } catch (error) {
    if (error instanceof InvalidRelationshipTransitionError) {
      return 'already_requested';
    }
    throw error;
  }
}

/**
 * Friendly stale-UI pre-check on the loaded relationship status (the transition
 * map remains the authoritative gate). Returns an error result to short-circuit
 * with, or `null` when the relationship is requestable. Split out to keep the
 * action's cognitive complexity under the gate.
 */
function precheckRelationshipStatus(
  status: RelationshipStatus
): Extract<RequestProposalAsAdminResult, { success: false }> | null {
  if (AT_OR_PAST_PROPOSAL_REQUEST.has(status)) {
    return { success: false, error: ALREADY_REQUESTED, code: 'already_requested' };
  }
  if (status !== 'invited' && status !== 'eoi_submitted') {
    return { success: false, error: NO_LONGER_AVAILABLE };
  }
  return null;
}

/**
 * Admin requests a formal proposal from one expert ON BEHALF of the client
 * (BAL-315). The full admin bypass: the relationship may be `invited` OR
 * `eoi_submitted` (no client EOI required), unlike the client path which gates on
 * `eoi_submitted`. The relationship transitions → `proposal_requested` (stamping
 * `proposal_requested_at`) and that advance derives the request-level status
 * atomically (ADR-1025 / BAL-295), so this action issues NO separate request
 * transition.
 *
 * Notifies the EXPERT (`project.proposal_requested`, email + in-app — the reused,
 * unchanged BAL-272 notification) AND the CLIENT (request owner) with an in-app
 * heads-up gated on `initiatedBy: 'admin'`. Returns server-computed analytics for
 * the admin client island, which fires `PROJECT_PROPOSAL_REQUESTED` after the
 * action resolves (mirroring the client path's transport).
 *
 * Authorization: platform `admin`/`super_admin` via `requireAdmin()`. IDOR-safe:
 * the relationship must belong to the request (else `NOT_ON_REQUEST`).
 */
export async function requestProposalAsAdmin(
  input: z.infer<typeof inputSchema>
): Promise<RequestProposalAsAdminResult> {
  let admin;
  try {
    // TODO(BAL-314): replace the platformRole gate with canActOnBehalf(admin, request).
    admin = await requireAdmin();
  } catch {
    return { success: false, error: 'You do not have permission to do this.' };
  }

  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: 'Invalid request.' };
  }
  const { requestId, relationshipId } = parsed.data;

  try {
    const request = await projectRequestsRepository.findByIdWithRelations(requestId);
    if (request === undefined) {
      return { success: false, error: REQUEST_GONE };
    }

    // The relationship MUST belong to this request (IDOR-safe — a foreign id
    // simply isn't in the hydrated graph).
    const relationship = request.relationships.find((r) => r.id === relationshipId);
    if (relationship === undefined) {
      return { success: false, error: NOT_ON_REQUEST };
    }

    // Friendly pre-check (the transition map remains the authoritative gate).
    const precheck = precheckRelationshipStatus(relationship.status);
    if (precheck !== null) {
      return precheck;
    }

    // Server-computed analytics from the PRE-transition graph (matches the client
    // path's +1 semantics — this relationship still counts below proposal_requested
    // in the loaded snapshot).
    const proposalRequestCount =
      request.relationships.filter((r) => AT_OR_PAST_PROPOSAL_REQUEST.has(r.status)).length + 1;
    const firstEoiAt = firstEoiSubmittedAt(request);
    const timeFromFirstEoiMs = firstEoiAt === null ? null : Date.now() - firstEoiAt.getTime();

    const beforeStatus = request.status;
    if ((await advanceRelationshipGuarded(relationshipId)) === 'already_requested') {
      return { success: false, error: ALREADY_REQUESTED, code: 'already_requested' };
    }

    // Re-source the request-level transition from the now-coherent stored column
    // (the rollup advanced inside the relationship transition above).
    const after = await projectRequestsRepository.findById(requestId);
    const transitioned = after !== undefined && after.status !== beforeStatus;
    const requestTransition =
      transitioned && after !== undefined ? { from: beforeStatus, to: after.status } : null;

    const { messageCount, fileCount } =
      await conversationsRepository.countThreadActivity(relationshipId);

    log.info('Admin requested proposal', {
      requestId,
      relationshipId,
      adminUserId: admin.id,
      transitioned,
    });

    // Fire-and-forget — notification failure must not block the commit. The
    // expert arm is the reused BAL-272 notification; `initiatedBy: 'admin'` +
    // `recipientId` fan out the in-app client heads-up.
    publishNotificationEvent('project.proposal_requested', {
      correlationId: relationshipId,
      projectRequestId: requestId,
      relationshipId,
      expertProfileId: relationship.expertProfileId,
      title: request.title,
      initiatedBy: 'admin',
      recipientId: request.createdByUserId,
    }).catch(() => {
      // publishNotificationEvent logs internally.
    });

    revalidatePath(`/projects/${requestId}`);

    return {
      success: true,
      expertProfileId: relationship.expertProfileId,
      transitioned,
      requestTransition,
      analytics: { proposalRequestCount, timeFromFirstEoiMs, messageCount, fileCount },
    };
  } catch (error) {
    log.error('Failed to request proposal as admin', {
      requestId,
      relationshipId,
      adminUserId: admin.id,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { success: false, error: GENERIC_FAILURE };
  }
}
