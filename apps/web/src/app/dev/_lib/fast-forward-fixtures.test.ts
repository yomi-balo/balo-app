import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { installmentsSumTo100 } from '@balo/db';
import { proposalDraftBaseFields } from '@/app/(dashboard)/projects/[requestId]/_actions/proposal-schema';
import { validateProposalReadiness } from '@/app/(dashboard)/projects/[requestId]/_actions/proposal-readiness';
import { sanitizeProjectHtml } from '@/lib/sanitize/project-html';
import { isDescriptionEmpty } from '@/components/balo/rich-text-editor';
import {
  FAST_FORWARD_CLOSE_NOTE,
  FAST_FORWARD_EOI_MESSAGE,
  fastForwardProposalDraft,
} from './fast-forward-fixtures';

/**
 * These tests deliberately prove the fixtures against the REAL validation chain (the same
 * schema, readiness function, and sanitiser production traffic goes through) — never a
 * reimplementation of any of them (BAL-275 plan §8 / §15). A drift between this fixture and a
 * real tightening of any of those rules must fail HERE, not surface as a mystifying dev-tool 500.
 */

const REQUEST_ID = '11111111-1111-4111-8111-111111111111';
const RELATIONSHIP_ID = '22222222-2222-4222-8222-222222222222';

describe('FAST_FORWARD_EOI_MESSAGE', () => {
  it('is non-empty', () => {
    expect(FAST_FORWARD_EOI_MESSAGE.length).toBeGreaterThan(0);
  });

  it('is within the core byte guard (<=20000 bytes)', () => {
    expect(Buffer.byteLength(FAST_FORWARD_EOI_MESSAGE, 'utf8')).toBeLessThanOrEqual(20_000);
  });

  it('survives the REAL sanitizeProjectHtml and is non-empty afterwards', () => {
    const sanitized = sanitizeProjectHtml(FAST_FORWARD_EOI_MESSAGE);
    expect(sanitized.length).toBeGreaterThan(0);
    expect(sanitized).toContain('<p>');
  });

  it('is NOT reported empty by the REAL isDescriptionEmpty (the exact guard submit-eoi-core.ts applies)', () => {
    const sanitized = sanitizeProjectHtml(FAST_FORWARD_EOI_MESSAGE);
    expect(isDescriptionEmpty(sanitized)).toBe(false);
  });

  it('is gender-neutral', () => {
    expect(FAST_FORWARD_EOI_MESSAGE.toLowerCase()).not.toMatch(/\b(he|she|him|her|his|hers)\b/);
  });
});

describe('FAST_FORWARD_CLOSE_NOTE', () => {
  it('meets the real action Zod bound (>=8, <=2000 chars)', () => {
    expect(FAST_FORWARD_CLOSE_NOTE.length).toBeGreaterThanOrEqual(8);
    expect(FAST_FORWARD_CLOSE_NOTE.length).toBeLessThanOrEqual(2000);
  });

  it('is gender-neutral', () => {
    expect(FAST_FORWARD_CLOSE_NOTE.toLowerCase()).not.toMatch(/\b(he|she|him|her|his|hers)\b/);
  });
});

describe('fastForwardProposalDraft', () => {
  const draft = fastForwardProposalDraft(REQUEST_ID, RELATIONSHIP_ID);

  it('parses against the REAL proposalDraftBaseFields schema (the same one save-proposal-draft-core uses)', () => {
    const schema = z.object(proposalDraftBaseFields);
    const parsed = schema.safeParse(draft);
    expect(parsed.success, JSON.stringify(parsed.success ? null : parsed.error.issues)).toBe(true);
  });

  it('does NOT hardcode a currency — the field is absent so the schema default applies', () => {
    expect(draft.currency).toBeUndefined();
  });

  it('carries exactly one milestone and one installment (the smallest coherent shape)', () => {
    expect(draft.milestones).toHaveLength(1);
    expect(draft.installments).toHaveLength(1);
  });

  it('passes the REAL validateProposalReadiness for a fixed-price proposal', () => {
    const readiness = validateProposalReadiness({
      overview: draft.overview,
      pricingMethod: draft.pricingMethod,
      milestones: draft.milestones.map((m) => ({
        title: m.title,
        valueCents: m.valueCents ?? null,
        estimatedMinutes: m.estimatedMinutes ?? null,
      })),
      installments: draft.installments.map((i) => ({ pct: i.pct })),
      depositCents: draft.depositCents ?? null,
      rateCents: draft.rateCents ?? null,
    });
    expect(readiness).toEqual({ ready: true });
  });

  it('installments sum to exactly 100 via the REAL installmentsSumTo100', () => {
    expect(installmentsSumTo100(draft.installments)).toBe(true);
  });

  it('the sum of milestone valueCents does not exceed priceCents (the in-transaction coherence rule)', () => {
    const totalMilestoneValue = draft.milestones.reduce((sum, m) => sum + (m.valueCents ?? 0), 0);
    expect(totalMilestoneValue).toBeLessThanOrEqual(draft.priceCents);
  });

  it('the overview survives sanitizeProjectHtml and is non-empty', () => {
    const sanitized = sanitizeProjectHtml(draft.overview);
    expect(isDescriptionEmpty(sanitized)).toBe(false);
  });

  it('every milestone is titled (a readiness precondition, checked directly)', () => {
    expect(draft.milestones.every((m) => m.title.trim().length > 0)).toBe(true);
    expect(draft.milestones.filter((m) => m.title.trim().length > 0)).toHaveLength(
      draft.milestones.length
    );
  });

  it('carries the requestId / relationshipId it was called with (never invented)', () => {
    expect(draft.requestId).toBe(REQUEST_ID);
    expect(draft.relationshipId).toBe(RELATIONSHIP_ID);
  });

  it('is gender-neutral', () => {
    expect(draft.overview.toLowerCase()).not.toMatch(/\b(he|she|him|her|his|hers)\b/);
  });
});
