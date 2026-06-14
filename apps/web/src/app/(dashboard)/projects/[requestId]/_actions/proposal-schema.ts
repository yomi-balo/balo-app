import { z } from 'zod';

/**
 * Shared Zod validation for the proposal composer payload (BAL-288 / BAL-294).
 *
 * The autosave (`save-proposal-draft`) and resubmit (`resubmit-proposal`) actions
 * accept the SAME composer body — header + replace-all milestone/installment lists;
 * resubmit only adds `fromProposalId`. The shape was duplicated byte-for-byte inline
 * in both actions, so it lives here as the single source of truth (no duplication).
 * Plain module — NO `'use server'` (it exports schemas/consts, not server actions).
 * Money is integer minor units everywhere (matches the proposals schema).
 */

/**
 * Sane upper bounds for the non-negative integer money/minutes fields — these only
 * fail closed at the DB int4 write today, so we bound them here too (defence in
 * depth; BAL-294 review). Both sit comfortably above any legitimate value yet far
 * below int4 max (2_147_483_647):
 *   - MAX_MINUTES: ten years of round-the-clock effort — no deliverable estimate exceeds this.
 *   - MAX_CENTS:   A$10,000,000.00 — generous for a single consulting proposal.
 */
export const MAX_MINUTES = 60 * 24 * 366 * 10;
export const MAX_CENTS = 1_000_000_000;
const MINUTES_MSG = 'Estimated effort is too large.';
const CENTS_MSG = 'Amount is too large.';

const milestoneSchema = z.object({
  title: z.string().max(200),
  descriptionHtml: z.string().max(20_000).nullable().optional(),
  acceptanceCriteria: z.string().max(2000).nullable().optional(),
  valueCents: z.number().int().nonnegative().max(MAX_CENTS, CENTS_MSG).nullable().optional(),
  // T&M-only estimated effort in minutes (integer; BAL-294). Partial-draft tolerant.
  estimatedMinutes: z
    .number()
    .int()
    .nonnegative()
    .max(MAX_MINUTES, MINUTES_MSG)
    .nullable()
    .optional(),
});

const installmentSchema = z.object({
  label: z.string().max(120),
  pct: z.number().int().min(0).max(100),
});

/**
 * Header + replace-all list fields shared by the autosave and resubmit payloads.
 * Spread into each action's `z.object(...)` (resubmit adds `fromProposalId`). All
 * fields are partial-draft tolerant: a brand-new draft may have a near-empty
 * overview, no milestones, etc. Readiness is enforced at submit — NOT here.
 */
export const proposalDraftBaseFields = {
  requestId: z.uuid(),
  // A CLAIM — validated server-side by `resolveConversationAccess`.
  relationshipId: z.uuid(),
  overview: z.string().max(50_000),
  pricingMethod: z.enum(['fixed', 'tm']),
  priceCents: z.number().int().nonnegative().max(MAX_CENTS, CENTS_MSG),
  currency: z.string().min(1).max(8).optional(),
  timeframeWeeks: z.number().int().positive().optional(),
  exclusions: z.string().max(20_000).optional(),
  depositCents: z.number().int().nonnegative().max(MAX_CENTS, CENTS_MSG).optional(),
  rateCents: z.number().int().nonnegative().max(MAX_CENTS, CENTS_MSG).optional(),
  cadence: z.enum(['monthly', 'fortnightly']).optional(),
  milestones: z.array(milestoneSchema).max(50),
  installments: z.array(installmentSchema).max(50),
};
