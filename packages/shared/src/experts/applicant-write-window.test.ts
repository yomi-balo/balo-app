import { describe, it, expect } from 'vitest';
import {
  APPLICANT_POST_SUBMIT_GRACE_MS,
  classifyApplicantDraftWrite,
} from './applicant-write-window';

/**
 * BAL-593 H1 — every row of the ruling's table, plus the two boundary ms values and the
 * null-`submittedAt` edge.
 *
 * ⚠ EVERY FIXTURE IS RELATIVE TO A FROZEN `NOW`, NEVER `Date.now()`
 * (`reference_hardcoded_date_fixtures_are_time_bombs`).
 */
const NOW = new Date('2026-01-15T00:00:00.000Z');

describe('APPLICANT_POST_SUBMIT_GRACE_MS', () => {
  it('is 60 000 ms (60s)', () => {
    expect(APPLICANT_POST_SUBMIT_GRACE_MS).toBe(60_000);
  });
});

describe('classifyApplicantDraftWrite', () => {
  it('returns ok for draft, regardless of submittedAt', () => {
    expect(classifyApplicantDraftWrite('draft', null, NOW)).toBe('ok');
    expect(classifyApplicantDraftWrite('draft', new Date(NOW.getTime() - 1), NOW)).toBe('ok');
  });

  it('returns declined for rejected', () => {
    expect(classifyApplicantDraftWrite('rejected', new Date(NOW.getTime() - 1), NOW)).toBe(
      'declined'
    );
  });

  it('returns closed for under_review', () => {
    expect(classifyApplicantDraftWrite('under_review', new Date(NOW.getTime() - 1), NOW)).toBe(
      'closed'
    );
  });

  it('returns closed for approved', () => {
    expect(classifyApplicantDraftWrite('approved', new Date(NOW.getTime() - 1), NOW)).toBe(
      'closed'
    );
  });

  it('returns closed for any unrecognised status', () => {
    expect(
      classifyApplicantDraftWrite('some_future_status', new Date(NOW.getTime() - 1), NOW)
    ).toBe('closed');
  });

  describe('submitted', () => {
    it('returns closed when submittedAt is null — no evidence of a recent submit', () => {
      expect(classifyApplicantDraftWrite('submitted', null, NOW)).toBe('closed');
    });

    it('returns ok at exactly the grace boundary (60 000 ms)', () => {
      const submittedAt = new Date(NOW.getTime() - APPLICANT_POST_SUBMIT_GRACE_MS);
      expect(classifyApplicantDraftWrite('submitted', submittedAt, NOW)).toBe('ok');
    });

    it('returns closed one ms past the grace boundary (60 001 ms)', () => {
      const submittedAt = new Date(NOW.getTime() - (APPLICANT_POST_SUBMIT_GRACE_MS + 1));
      expect(classifyApplicantDraftWrite('submitted', submittedAt, NOW)).toBe('closed');
    });

    it('returns ok well within grace (30s, the autosave debounce)', () => {
      const submittedAt = new Date(NOW.getTime() - 30_000);
      expect(classifyApplicantDraftWrite('submitted', submittedAt, NOW)).toBe('ok');
    });

    it('returns ok for a submittedAt at exactly now', () => {
      expect(classifyApplicantDraftWrite('submitted', NOW, NOW)).toBe('ok');
    });

    it('returns closed well past grace (2h, a staff edit landing later)', () => {
      const submittedAt = new Date(NOW.getTime() - 2 * 3_600_000);
      expect(classifyApplicantDraftWrite('submitted', submittedAt, NOW)).toBe('closed');
    });
  });
});
