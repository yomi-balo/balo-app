import { describe, it, expect } from 'vitest';
import { EXPERT_DECLINE_REASONS } from '@balo/shared/experts';
import {
  EXPERT_DECLINE_REASON_LABEL,
  readExpertDeclineReason,
} from './expert-decline-reason-label.js';

describe('EXPERT_DECLINE_REASON_LABEL', () => {
  it.each(EXPERT_DECLINE_REASONS)('has a label for %s', (reason) => {
    expect(typeof EXPERT_DECLINE_REASON_LABEL[reason]).toBe('string');
    expect(EXPERT_DECLINE_REASON_LABEL[reason].length).toBeGreaterThan(0);
  });

  it('has a label for every EXPERT_DECLINE_REASONS member (total map)', () => {
    expect(Object.keys(EXPERT_DECLINE_REASON_LABEL).sort()).toEqual(
      [...EXPERT_DECLINE_REASONS].sort()
    );
  });

  it('never mentions a staff-only note', () => {
    for (const reason of EXPERT_DECLINE_REASONS) {
      expect(EXPERT_DECLINE_REASON_LABEL[reason]).not.toMatch(/note/i);
    }
  });
});

describe('readExpertDeclineReason', () => {
  it.each(EXPERT_DECLINE_REASONS)('narrows %s through unchanged', (reason) => {
    expect(readExpertDeclineReason(reason)).toBe(reason);
  });

  it('falls back to not_a_fit for an unrecognised value', () => {
    expect(readExpertDeclineReason('not-a-real-reason')).toBe('not_a_fit');
  });

  it('falls back to not_a_fit for a non-string value', () => {
    expect(readExpertDeclineReason(undefined)).toBe('not_a_fit');
    expect(readExpertDeclineReason(42)).toBe('not_a_fit');
  });
});
