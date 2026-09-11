import { describe, it, expect } from 'vitest';
import { PROJECT_COUNT_RANGES, projectRangeLabel } from './project-ranges';

describe('PROJECT_COUNT_RANGES', () => {
  it('carries exactly the five stored lower bounds the schema documents, in picker order', () => {
    expect(PROJECT_COUNT_RANGES.map((range) => range.min)).toEqual([0, 1, 10, 26, 50]);
  });

  /**
   * FIX ROUND F13 — the three copies had DRIFTED: the picker rendered "1-9" for the value the
   * two review surfaces rendered as "1–9". One definition means one dash.
   */
  it('labels every bounded range with an EN DASH, never a hyphen', () => {
    const bounded = PROJECT_COUNT_RANGES.filter((range) => range.min > 0 && range.min < 50);
    expect(bounded).toHaveLength(3);
    for (const range of bounded) {
      expect(range.label).toContain('–');
      expect(range.label).not.toContain('-');
    }
  });
});

describe('projectRangeLabel', () => {
  it('maps each stored lower bound to its label', () => {
    expect(projectRangeLabel(0)).toBe('None');
    expect(projectRangeLabel(1)).toBe('1–9');
    expect(projectRangeLabel(10)).toBe('10–25');
    expect(projectRangeLabel(26)).toBe('26–50');
    expect(projectRangeLabel(50)).toBe('50+');
  });

  it('renders a dash placeholder for an unanswered question', () => {
    expect(projectRangeLabel(null)).toBe('—');
    expect(projectRangeLabel(undefined)).toBe('—');
  });

  it('renders a dash placeholder for a stored value outside the vocabulary', () => {
    expect(projectRangeLabel(7)).toBe('—');
  });
});
