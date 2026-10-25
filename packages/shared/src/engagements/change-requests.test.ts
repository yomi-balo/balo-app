import { describe, expect, it } from 'vitest';
import {
  REPEAT_CHANGE_REQUEST_MIN_ROUND,
  isRepeatChangeRequestRound,
  joinTitles,
} from './change-requests';

describe('joinTitles', () => {
  it('returns an empty string for none', () => {
    expect(joinTitles([])).toBe('');
  });

  it('returns a single title as-is', () => {
    expect(joinTitles(['Design'])).toBe('Design');
  });

  it('joins two titles with "and"', () => {
    expect(joinTitles(['Design', 'Build'])).toBe('Design and Build');
  });

  it('joins three or more titles with commas and a final "and"', () => {
    expect(joinTitles(['Design', 'Build', 'Launch'])).toBe('Design, Build and Launch');
    expect(joinTitles(['A', 'B', 'C', 'D'])).toBe('A, B, C and D');
  });
});

describe('isRepeatChangeRequestRound', () => {
  it('is false before the threshold round', () => {
    expect(isRepeatChangeRequestRound(0)).toBe(false);
    expect(isRepeatChangeRequestRound(REPEAT_CHANGE_REQUEST_MIN_ROUND - 1)).toBe(false);
  });

  it('is true from the threshold round on', () => {
    expect(REPEAT_CHANGE_REQUEST_MIN_ROUND).toBe(2);
    expect(isRepeatChangeRequestRound(2)).toBe(true);
    expect(isRepeatChangeRequestRound(5)).toBe(true);
  });
});
