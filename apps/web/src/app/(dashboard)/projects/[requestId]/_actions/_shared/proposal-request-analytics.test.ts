import { describe, it, expect } from 'vitest';
import type { ProjectRequestWithRelations } from '@balo/db';
import { AT_OR_PAST_PROPOSAL_REQUEST, firstEoiSubmittedAt } from './proposal-request-analytics';

/** Minimal request graph carrying only the fields `firstEoiSubmittedAt` reads. */
function buildRequest(
  relationships: Array<{ expressionsOfInterest: Array<{ submittedAt: Date }> }>
): ProjectRequestWithRelations {
  return { relationships } as unknown as ProjectRequestWithRelations;
}

describe('AT_OR_PAST_PROPOSAL_REQUEST', () => {
  it('contains the statuses at/after a proposal request', () => {
    expect(AT_OR_PAST_PROPOSAL_REQUEST.has('proposal_requested')).toBe(true);
    expect(AT_OR_PAST_PROPOSAL_REQUEST.has('proposal_submitted')).toBe(true);
    expect(AT_OR_PAST_PROPOSAL_REQUEST.has('accepted')).toBe(true);
  });

  it('excludes earlier and terminal-negative statuses', () => {
    expect(AT_OR_PAST_PROPOSAL_REQUEST.has('invited')).toBe(false);
    expect(AT_OR_PAST_PROPOSAL_REQUEST.has('eoi_submitted')).toBe(false);
    expect(AT_OR_PAST_PROPOSAL_REQUEST.has('declined')).toBe(false);
  });
});

describe('firstEoiSubmittedAt', () => {
  it('returns null when no relationship has a live EOI', () => {
    const request = buildRequest([{ expressionsOfInterest: [] }, { expressionsOfInterest: [] }]);
    expect(firstEoiSubmittedAt(request)).toBeNull();
  });

  it('returns null for a request with no relationships', () => {
    const request = buildRequest([]);
    expect(firstEoiSubmittedAt(request)).toBeNull();
  });

  it('returns the earliest submittedAt across relationships', () => {
    const older = new Date('2026-01-01T00:00:00.000Z');
    const newer = new Date('2026-02-01T00:00:00.000Z');
    const request = buildRequest([
      { expressionsOfInterest: [{ submittedAt: newer }] },
      { expressionsOfInterest: [{ submittedAt: older }] },
    ]);
    expect(firstEoiSubmittedAt(request)).toEqual(older);
  });

  it('ignores relationships without a live EOI and returns the only live one', () => {
    const only = new Date('2026-03-01T00:00:00.000Z');
    const request = buildRequest([
      { expressionsOfInterest: [] },
      { expressionsOfInterest: [{ submittedAt: only }] },
    ]);
    expect(firstEoiSubmittedAt(request)).toEqual(only);
  });
});
