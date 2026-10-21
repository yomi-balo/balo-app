import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { draftToReviewDoc } from './proposal-draft-preview';
import {
  emptyDraftState,
  nextDraftKey,
  toSavePayload,
  type ProposalDraftState,
} from './proposal-composer-state';
import type { ProposalExpertIdentity } from './proposal-review-types';

const REQUEST_ID = '11111111-1111-1111-1111-111111111111';
const RELATIONSHIP_ID = '22222222-2222-2222-2222-222222222222';

const EXPERT: ProposalExpertIdentity = {
  name: 'Dana Expert',
  initials: 'DE',
  company: 'CloudPeak',
  headline: 'CPQ Specialist',
  rating: 4.8,
  ratingCount: 12,
};

const CTX = { requestId: REQUEST_ID, relationshipId: RELATIONSHIP_ID, version: 2, expert: EXPERT };

function fixedDraft(): ProposalDraftState {
  return {
    ...emptyDraftState(),
    proposalId: 'p1',
    overview: '<p>Overview</p>',
    timeframeWeeks: 6,
    exclusions: '<p>Not included</p>',
    fixedPriceCents: 1_000_000,
    milestonePricingEnabled: true,
    milestones: [
      {
        key: nextDraftKey(),
        title: 'Discovery',
        descriptionHtml: '<p>Workshops</p>',
        acceptanceCriteria: 'Signed-off plan',
        valueCents: 400_000,
        estimatedMinutes: null,
      },
      {
        key: nextDraftKey(),
        title: 'Build',
        descriptionHtml: '',
        acceptanceCriteria: '',
        valueCents: 600_000,
        estimatedMinutes: null,
      },
    ],
    installments: [
      { key: nextDraftKey(), label: 'Upfront', pct: 40 },
      { key: nextDraftKey(), label: 'On delivery', pct: 60 },
    ],
    documents: [
      {
        id: 'd1',
        proposalId: 'p1',
        kind: 'ref',
        fileName: 'scope.pdf',
        contentType: 'application/pdf',
        sizeBytes: 2048,
        uploadedByUserId: 'u1',
        createdAtIso: '2026-10-21T00:00:00.000Z',
      },
    ],
  };
}

describe('draftToReviewDoc', () => {
  it('shows the expert-typed price as-is (identity money)', () => {
    const doc = draftToReviewDoc(fixedDraft(), CTX);
    expect(doc.priceCents).toBe(1_000_000);
    expect(doc.milestones.map((m) => m.valueCents)).toEqual([400_000, 600_000]);
    expect(doc.currency).toBe('aud');
  });

  it('mirrors toSavePayload exactly', () => {
    const s = fixedDraft();
    const payload = toSavePayload(s, REQUEST_ID, RELATIONSHIP_ID);
    const doc = draftToReviewDoc(s, CTX);
    expect(doc.pricingMethod).toBe(payload.pricingMethod);
    expect(doc.overviewHtml).toBe(payload.overview);
    expect(doc.exclusionsHtml).toBe(payload.exclusions);
    expect(doc.timeframeWeeks).toBe(6);
    expect(doc.milestones.map((m) => m.descriptionHtml)).toEqual(['<p>Workshops</p>', null]);
    expect(doc.milestones.map((m) => m.acceptanceCriteria)).toEqual(['Signed-off plan', null]);
    expect(doc.installments.map((i) => [i.label, i.pct])).toEqual([
      ['Upfront', 40],
      ['On delivery', 60],
    ]);
  });

  it('nulls milestone values while "Price each milestone" is off', () => {
    const s = fixedDraft();
    s.milestonePricingEnabled = false;
    const doc = draftToReviewDoc(s, CTX);
    expect(doc.milestones.every((m) => m.valueCents === null)).toBe(true);
    expect(doc.priceCents).toBe(1_000_000);
  });

  it('passes ctx through and marks the doc as a draft', () => {
    const doc = draftToReviewDoc(fixedDraft(), CTX);
    expect(doc.relationshipId).toBe(RELATIONSHIP_ID);
    expect(doc.version).toBe(2);
    expect(doc.expert).toBe(EXPERT);
    expect(doc.status).toBe('draft');
    expect(doc.id).toBe('p1');
  });

  it('falls back to a placeholder id before the first save', () => {
    const doc = draftToReviewDoc({ ...fixedDraft(), proposalId: null }, CTX);
    expect(doc.id).toBe('draft-preview');
  });

  it('never sets adminPricing', () => {
    expect(draftToReviewDoc(fixedDraft(), CTX)).not.toHaveProperty('adminPricing');
  });

  it('maps documents to attachments', () => {
    expect(draftToReviewDoc(fixedDraft(), CTX).attachments).toEqual([
      { id: 'd1', fileName: 'scope.pdf', sizeBytes: 2048, kind: 'ref' },
    ]);
  });

  it('maps T&M commercials and emits no installments', () => {
    const s: ProposalDraftState = {
      ...fixedDraft(),
      pricingMethod: 'tm',
      rateCents: 25_000,
      depositCents: 0,
      cadence: 'fortnightly',
      milestones: fixedDraft().milestones.map((m) => ({ ...m, estimatedMinutes: 120 })),
    };
    const doc = draftToReviewDoc(s, CTX);
    expect(doc.pricingMethod).toBe('tm');
    expect(doc.priceCents).toBe(100_000);
    expect(doc.rateCents).toBe(25_000);
    expect(doc.depositCents).toBe(0);
    expect(doc.cadence).toBe('fortnightly');
    expect(doc.installments).toEqual([]);
    expect(doc.milestones.every((m) => m.valueCents === null)).toBe(true);
  });

  it('nulls absent optionals', () => {
    const doc = draftToReviewDoc({ ...fixedDraft(), exclusions: '', timeframeWeeks: null }, CTX);
    expect(doc.exclusionsHtml).toBeNull();
    expect(doc.timeframeWeeks).toBeNull();
    expect(doc.rateCents).toBeNull();
    expect(doc.depositCents).toBeNull();
    expect(doc.cadence).toBeNull();
  });

  it('does not import the Balo fee helpers (the preview is never marked up)', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./proposal-draft-preview.ts', import.meta.url)),
      'utf8'
    );
    expect(source).not.toContain('applyBaloFee');
    expect(source).not.toContain('calculateClientRate');
  });
});
