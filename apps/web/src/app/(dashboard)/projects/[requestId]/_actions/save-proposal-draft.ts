'use server';

import 'server-only';

import { z } from 'zod';
import {
  proposalsRepository,
  proposalMilestonesRepository,
  proposalPaymentInstallmentsRepository,
  ProposalNotDraftError,
  type ProposalMilestoneInput,
  type ProposalPaymentInstallmentInput,
} from '@balo/db';
import { requireUser } from '@/lib/auth/session';
import { resolveConversationAccess } from '@/lib/project-request/resolve-conversation-access';
import { log } from '@/lib/logging';

/**
 * Autosave payload (A6.2 / BAL-288). The composer sends its FULL current draft
 * state — header + the complete milestone + installment lists (replace-all). All
 * fields are partial-draft tolerant: a brand-new draft may have a near-empty
 * overview, no milestones, etc. The submit action — NOT this one — enforces
 * readiness. Money is integer minor units.
 */
const milestoneSchema = z.object({
  title: z.string().max(200),
  descriptionHtml: z.string().max(20_000).nullable().optional(),
  acceptanceCriteria: z.string().max(2000).nullable().optional(),
  valueCents: z.number().int().nonnegative().nullable().optional(),
});

const installmentSchema = z.object({
  label: z.string().max(120),
  pct: z.number().int().min(0).max(100),
});

const inputSchema = z.object({
  requestId: z.uuid(),
  // A CLAIM — validated server-side by `resolveConversationAccess`.
  relationshipId: z.uuid(),
  overview: z.string().max(50_000),
  pricingMethod: z.enum(['fixed', 'tm']),
  priceCents: z.number().int().nonnegative(),
  currency: z.string().min(1).max(8).optional(),
  timeframeWeeks: z.number().int().positive().optional(),
  exclusions: z.string().max(20_000).optional(),
  depositCents: z.number().int().nonnegative().optional(),
  rateCents: z.number().int().nonnegative().optional(),
  cadence: z.enum(['monthly', 'fortnightly']).optional(),
  milestones: z.array(milestoneSchema).max(50),
  installments: z.array(installmentSchema).max(50),
});

export type SaveProposalDraftInput = z.infer<typeof inputSchema>;

export type SaveProposalDraftResult =
  | { success: true; proposalId: string }
  | { success: false; error: string };

const NOT_SIGNED_IN = 'You are not signed in.';
const INVALID_REQUEST = 'Invalid request.';
const ONLY_EXPERT = 'Only the expert can build a proposal.';
const STALE_DRAFT = 'This proposal can no longer be edited.';
const GENERIC_FAILURE = "Couldn't save your draft. Please try again.";

/** The header columns shared by `createDraft` / `updateDraft`. */
type DraftHeader = {
  overview: string;
  pricingMethod: 'fixed' | 'tm';
  priceCents: number;
  currency?: string;
  timeframeWeeks?: number;
  exclusions?: string;
  depositCents?: number;
  rateCents?: number;
  cadence?: 'monthly' | 'fortnightly';
};

/**
 * True when `error` is a Postgres unique-violation (SQLSTATE 23505). Structural
 * narrowing (no `any`, no assertion) — the `in` guard narrows `object` to carry
 * `code`. Mirrors the confirm-upload actions' helper.
 */
function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  return 'code' in error && error.code === '23505';
}

/**
 * Create-or-update the single current `draft` for a relationship, idempotent under
 * a concurrent first-save. `createDraft` is gated by the partial unique
 * `proposal_current_per_relationship_idx`: if two first-saves race, the loser hits
 * a 23505. We recover by re-fetching the now-existing current draft and routing to
 * `updateDraft` — the concurrent first-save degrades to a no-op update, never a
 * GENERIC_FAILURE. Returns the draft's id.
 */
async function createOrUpdateDraft(relationshipId: string, header: DraftHeader): Promise<string> {
  const existing = await proposalsRepository.findCurrentByRelationship(relationshipId);
  if (existing !== undefined) {
    const updated = await proposalsRepository.updateDraft({ proposalId: existing.id, ...header });
    return updated.id;
  }

  try {
    const created = await proposalsRepository.createDraft({ relationshipId, ...header });
    return created.id;
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    // A concurrent first-save won the create race — adopt its draft.
    const current = await proposalsRepository.findCurrentByRelationship(relationshipId);
    if (current === undefined) throw error;
    const updated = await proposalsRepository.updateDraft({ proposalId: current.id, ...header });
    return updated.id;
  }
}

/**
 * Autosave the expert's current `draft` proposal for a relationship (A6.2 /
 * BAL-288). Create-or-update: if no current proposal exists yet → `createDraft`,
 * else → `updateDraft`; then replace-all the milestone + installment sets via
 * their `setForProposal` repos. Returns the draft's `proposalId` so the composer
 * can persist it in state and update-in-place on the next autosave.
 *
 * Best-effort by design (the composer never blocks typing on it): on a stale
 * autosave landing AFTER submit, `updateDraft` throws `ProposalNotDraftError` —
 * we warn-log it and return friendly stale-UI copy rather than corrupting a
 * submitted proposal. Expert-lens guarded (mirrors `request-proposal.ts`'s
 * client guard); `resolveConversationAccess` denies non-participants / foreign
 * relationship ids.
 */
export async function saveProposalDraftAction(
  input: SaveProposalDraftInput
): Promise<SaveProposalDraftResult> {
  let user;
  try {
    user = await requireUser();
  } catch {
    return { success: false, error: NOT_SIGNED_IN };
  }

  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: INVALID_REQUEST };
  }
  const data = parsed.data;
  const { requestId, relationshipId } = data;

  try {
    const access = await resolveConversationAccess(user, requestId, relationshipId);
    if (!access.ok) {
      return { success: false, error: access.error };
    }
    if (access.ctx.lens !== 'expert') {
      return { success: false, error: ONLY_EXPERT };
    }

    const header: DraftHeader = {
      overview: data.overview,
      pricingMethod: data.pricingMethod,
      priceCents: data.priceCents,
      currency: data.currency,
      timeframeWeeks: data.timeframeWeeks,
      exclusions: data.exclusions,
      depositCents: data.depositCents,
      rateCents: data.rateCents,
      cadence: data.cadence,
    };

    // Create-or-update the single current draft (idempotent under a create race).
    const proposalId = await createOrUpdateDraft(relationshipId, header);

    // Replace-all the child sets (the composer always sends the complete lists).
    const milestones: ProposalMilestoneInput[] = data.milestones.map((m) => ({
      title: m.title,
      descriptionHtml: m.descriptionHtml ?? null,
      acceptanceCriteria: m.acceptanceCriteria ?? null,
      valueCents: m.valueCents ?? null,
    }));
    const installments: ProposalPaymentInstallmentInput[] = data.installments.map((i) => ({
      label: i.label,
      pct: i.pct,
    }));

    await proposalMilestonesRepository.setForProposal({ proposalId, milestones });
    await proposalPaymentInstallmentsRepository.setForProposal({ proposalId, installments });

    return { success: true, proposalId };
  } catch (error) {
    // A stale autosave landing after submit is EXPECTED — warn, not error.
    if (error instanceof ProposalNotDraftError) {
      log.warn('Proposal draft autosave rejected (no longer a draft)', {
        requestId,
        relationshipId,
        userId: user.id,
        status: error.status,
      });
      return { success: false, error: STALE_DRAFT };
    }
    log.error('Failed to save proposal draft', {
      requestId,
      relationshipId,
      userId: user.id,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { success: false, error: GENERIC_FAILURE };
  }
}
