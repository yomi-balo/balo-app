import 'server-only';

import sanitizeHtml from 'sanitize-html';
import { z } from 'zod';
import { proposalDraftGenerationsRepository, type ProposalDraftGeneration } from '@balo/db';
import {
  DRAFT_DEADLINE_MS,
  PROPOSAL_DRAFT_MAX_ACCEPTANCE_CRITERIA,
  PROPOSAL_DRAFT_MAX_DESCRIPTION_HTML,
  PROPOSAL_DRAFT_MAX_MILESTONES,
  PROPOSAL_DRAFT_MAX_OVERVIEW_HTML,
  PROPOSAL_DRAFT_MAX_TITLE,
  PROPOSAL_DRAFT_MIN_MILESTONES,
} from '@balo/shared/project-requests';
import { plainTextLength } from '@/components/balo/rich-text/plain-text';
import { log } from '@/lib/logging';
import { PROPOSAL_OVERVIEW_ALLOWED_TAGS } from '@/lib/sanitize/allowed-tags';
import { sanitizeProjectHtml, sanitizeProposalOverviewHtml } from '@/lib/sanitize/project-html';
import type { ProposalDraftGenerationView, ProposalDraftPatch } from './proposal-draft-types';

/**
 * Re-parses the stored jsonb on the way out. The column is typed `ProposalDraftOutput`, but
 * the type is a promise the database cannot keep, so the bounds are re-checked here from the
 * same constants the worker's output schema uses.
 */
const storedOutputSchema = z.object({
  overviewHtml: z.string().max(PROPOSAL_DRAFT_MAX_OVERVIEW_HTML),
  milestones: z
    .array(
      z.object({
        title: z.string().max(PROPOSAL_DRAFT_MAX_TITLE),
        descriptionHtml: z.string().max(PROPOSAL_DRAFT_MAX_DESCRIPTION_HTML),
        acceptanceCriteria: z.string().max(PROPOSAL_DRAFT_MAX_ACCEPTANCE_CRITERIA),
      })
    )
    .min(PROPOSAL_DRAFT_MIN_MILESTONES)
    .max(PROPOSAL_DRAFT_MAX_MILESTONES),
});

const DRAFT_ALLOWED_TAGS = PROPOSAL_OVERVIEW_ALLOWED_TAGS.filter((tag) => tag !== 'a');

/**
 * Second pass over already-sanitised draft HTML: unwrap every anchor, keeping its text. The
 * prompt forbids links, but a drafted link would land in front of the expert unreviewed as a
 * clickable, so none survives. The first pass has already removed every attribute but an
 * anchor's, so no attribute is allowed here.
 */
function stripLinks(html: string): string {
  return sanitizeHtml(html, { allowedTags: DRAFT_ALLOWED_TAGS, allowedAttributes: {} });
}

/**
 * Sanitise a stored generation's output into the patch the composer applies, or `null` when
 * it does not hold the shape or the floor (a non-empty overview after sanitising).
 *
 * The overview and each milestone description are sanitised with DIFFERENT allow-lists, the
 * same split `submit-proposal-core.ts` applies: `sanitizeProposalOverviewHtml` for the overview,
 * `sanitizeProjectHtml` for milestone descriptions. Titles and acceptance criteria are plain
 * text rendered as input values, so they are trimmed and never treated as HTML. Links are
 * unwrapped to their text in both HTML fields.
 */
export function toProposalDraftPatch(output: unknown): ProposalDraftPatch | null {
  const parsed = storedOutputSchema.safeParse(output);
  if (!parsed.success) return null;

  const overviewHtml = stripLinks(sanitizeProposalOverviewHtml(parsed.data.overviewHtml));
  if (plainTextLength(overviewHtml) === 0) return null;

  return {
    overviewHtml,
    milestones: parsed.data.milestones.map((milestone) => ({
      title: milestone.title.trim(),
      descriptionHtml: stripLinks(sanitizeProjectHtml(milestone.descriptionHtml)),
      acceptanceCriteria: milestone.acceptanceCriteria.trim(),
    })),
  };
}

/**
 * Map a generation row to what the composer renders. A `pending` row older than
 * {@link DRAFT_DEADLINE_MS} reads as `failed`: the timeout is derived here and never stored,
 * so no reaper job exists. A `succeeded` row whose output no longer holds the shape is logged
 * and reads as `failed`.
 */
export function toProposalDraftGenerationView(
  row: ProposalDraftGeneration | undefined,
  nowMs: number
): ProposalDraftGenerationView {
  if (row === undefined) return { status: 'none' };

  if (row.status === 'pending') {
    if (nowMs - row.createdAt.getTime() > DRAFT_DEADLINE_MS) return { status: 'failed' };
    return { status: 'pending', generationId: row.id };
  }

  if (row.status === 'failed') return { status: 'failed' };

  const patch = toProposalDraftPatch(row.output);
  if (patch === null) {
    log.error('Proposal draft output failed its shape or floor check', {
      generationId: row.id,
      relationshipId: row.relationshipId,
    });
    return { status: 'failed' };
  }
  return { status: 'succeeded', generationId: row.id, patch };
}

/**
 * Server-side initial state for the composer: the relationship's live generation, if any, so
 * a revisit hydrates with a `succeeded` draft already applied and no round trip.
 *
 * Never throws: the draft is an extra, and a lookup failure must not take the composer down.
 * A failure reads as `skipped`, which renders the blank composer with no note and starts
 * nothing.
 */
export async function loadProposalDraftGenerationView(
  relationshipId: string
): Promise<ProposalDraftGenerationView> {
  try {
    const row = await proposalDraftGenerationsRepository.findLiveByRelationship(relationshipId);
    return toProposalDraftGenerationView(row, Date.now());
  } catch (error) {
    log.error('Failed to load the proposal draft generation', {
      relationshipId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { status: 'skipped' };
  }
}
