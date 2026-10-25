import 'server-only';

import { z } from 'zod';
import { proposalDraftGenerationsRepository, proposalsRepository } from '@balo/db';
import { MAX_PROPOSAL_DRAFTS_PER_HOUR } from '@balo/shared/project-requests';
import type { SessionUser } from '@/lib/auth/session';
import { isImpersonatedSession } from '@/lib/auth/impersonation';
import { postBaloApiJson } from '@/lib/api/balo-api-client';
import { PROJECT_SERVER_EVENTS, trackServerAndFlush } from '@/lib/analytics/server';
import { log } from '@/lib/logging';
import { toProposalDraftGenerationView } from '@/lib/project-request/proposal/proposal-draft-view';
import type { ProposalDraftGenerationView } from '@/lib/project-request/proposal/proposal-draft-types';
import { resolveProposalAuthorAccess } from './proposal-author-access';

const ONE_HOUR_MS = 60 * 60 * 1000;

const startInputSchema = z.object({
  requestId: z.uuid(),
  relationshipId: z.uuid(),
});

const pollInputSchema = startInputSchema.extend({
  generationId: z.uuid(),
});

export type StartProposalDraftInput = z.infer<typeof startInputSchema>;
export type GetProposalDraftInput = z.infer<typeof pollInputSchema>;

/** The api answers `{ enqueued: true }` on success; nothing else is read from the body. */
function parseEnqueueResponse(parsed: Record<string, unknown>): { enqueued: true } | null {
  return parsed['enqueued'] === true ? { enqueued: true } : null;
}

/**
 * Start (or resume) the one automatic AI generation for a relationship's composer.
 *
 * Idempotent per relationship: an existing live row is returned as its view with no api call,
 * and a concurrent second start is resolved by the table's partial unique index. Order matters:
 * the gate and the cheap "nothing to do" checks run before the hourly cap, and the cap runs
 * before any row is written, so a capped expert leaves no trace.
 *
 * Never throws; every non-pending outcome is a view the composer renders quietly.
 */
export async function runStartProposalDraft(
  user: SessionUser,
  input: StartProposalDraftInput
): Promise<ProposalDraftGenerationView> {
  const parsed = startInputSchema.safeParse(input);
  if (!parsed.success) return { status: 'skipped' };
  const { requestId, relationshipId } = parsed.data;

  // A staff member viewing as the expert must not write a generation row, spend the expert's
  // hourly allowance or bill a model call on their behalf.
  if (isImpersonatedSession(user)) return { status: 'skipped' };

  try {
    const access = await resolveProposalAuthorAccess(user, requestId, relationshipId);
    if (!access.ok || access.relationship.status !== 'proposal_requested') {
      return { status: 'skipped' };
    }

    const existingProposal = await proposalsRepository.findCurrentByRelationship(relationshipId);
    if (existingProposal !== undefined) return { status: 'skipped' };

    const existing =
      await proposalDraftGenerationsRepository.findLiveByRelationship(relationshipId);
    if (existing !== undefined) return toProposalDraftGenerationView(existing, Date.now());

    const recentCount = await proposalDraftGenerationsRepository.countCreatedSince({
      requestedByUserId: user.id,
      since: new Date(Date.now() - ONE_HOUR_MS),
    });
    if (recentCount >= MAX_PROPOSAL_DRAFTS_PER_HOUR) {
      log.info('Proposal draft generation rate-capped', {
        relationshipId,
        userId: user.id,
        recentCount,
      });
      return { status: 'skipped' };
    }

    const { row, created } = await proposalDraftGenerationsRepository.createOrGetForRelationship({
      relationshipId,
      requestedByUserId: user.id,
    });
    if (!created) return toProposalDraftGenerationView(row, Date.now());

    const enqueued = await postBaloApiJson(
      '/proposal-drafts/generate',
      { generationId: row.id },
      parseEnqueueResponse,
      'proposal draft generation'
    );
    if (!enqueued.ok) {
      // Fails AND releases the row, so the expert sees the failure line on this visit and the
      // next visit opens a fresh generation instead of finding this one: an api outage does not
      // use up the relationship's one draft. The released row still counts towards the hourly
      // cap. `undefined` means the worker finished the row first, so analytics stay silent.
      const failed = await proposalDraftGenerationsRepository.releaseAfterEnqueueFailure({
        generationId: row.id,
      });
      if (failed !== undefined) {
        trackServerAndFlush(PROJECT_SERVER_EVENTS.PROPOSAL_DRAFT_GENERATED, {
          relationship_id: relationshipId,
          status: 'failed',
          latency_ms:
            (failed.completedAt ?? failed.createdAt).getTime() - failed.createdAt.getTime(),
          milestone_count: 0,
          distinct_id: user.id,
        });
      }
      log.error('Proposal draft generation enqueue failed', {
        generationId: row.id,
        relationshipId,
        userId: user.id,
        status: enqueued.status,
        code: enqueued.code,
      });
      return { status: 'failed' };
    }

    log.info('Proposal draft generation started', {
      relationshipId,
      generationId: row.id,
      userId: user.id,
    });
    return { status: 'pending', generationId: row.id };
  } catch (error) {
    log.error('Proposal draft generation start failed', {
      relationshipId,
      userId: user.id,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { status: 'failed' };
  }
}

/**
 * Poll one generation. The generation id, the access-checked relationship and the requesting
 * user are all in the read's WHERE, so a foreign id is indistinguishable from a missing one:
 * both answer `failed`, and this never tells "not yours" from "does not exist".
 */
export async function runGetProposalDraft(
  user: SessionUser,
  input: GetProposalDraftInput
): Promise<ProposalDraftGenerationView> {
  const parsed = pollInputSchema.safeParse(input);
  if (!parsed.success) return { status: 'failed' };
  const { requestId, relationshipId, generationId } = parsed.data;

  try {
    const access = await resolveProposalAuthorAccess(user, requestId, relationshipId);
    if (!access.ok) return { status: 'failed' };

    const row = await proposalDraftGenerationsRepository.findForRequester({
      generationId,
      relationshipId,
      requestedByUserId: user.id,
    });
    if (row === undefined) return { status: 'failed' };

    return toProposalDraftGenerationView(row, Date.now());
  } catch (error) {
    log.error('Proposal draft generation poll failed', {
      relationshipId,
      generationId,
      userId: user.id,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { status: 'failed' };
  }
}
