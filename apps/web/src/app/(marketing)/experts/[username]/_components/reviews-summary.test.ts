import { describe, it, expect } from 'vitest';
import type { ProfileReviewEntryView } from '@/components/expert/profile/types';
import {
  distribution,
  engagementsLabel,
  filterEntries,
  kindCounts,
  kindPhrase,
  showMoreLabel,
} from './reviews-summary';

function entry(
  key: string,
  engagementKind: 'project' | 'case',
  rating = 5
): ProfileReviewEntryView {
  return {
    key,
    engagementKind,
    rating,
    dateLabel: 'Oct 2026',
    topics: [],
    raters: [],
    sharedCompanyName: null,
  };
}

describe('kindPhrase', () => {
  it('names a single project', () => {
    expect(kindPhrase([entry('a', 'project')])).toBe('1 project');
  });

  it('joins projects and consultations', () => {
    expect(kindPhrase([entry('a', 'project'), entry('b', 'project'), entry('c', 'case')])).toBe(
      '2 projects and 1 consultation'
    );
  });

  it('omits a kind with no entries', () => {
    expect(kindPhrase([entry('a', 'case'), entry('b', 'case')])).toBe('2 consultations');
  });

  it('is empty without entries', () => {
    expect(kindPhrase([])).toBe('');
  });
});

describe('kindCounts', () => {
  it('splits projects from consultations', () => {
    expect(kindCounts([entry('a', 'project'), entry('b', 'case'), entry('c', 'case')])).toEqual({
      projects: 1,
      consultations: 2,
    });
  });
});

describe('distribution', () => {
  it('rounds half up into the nearest star bucket', () => {
    const result = distribution([entry('a', 'project', 4.5), entry('b', 'project', 4.4)]);
    expect(result).toEqual({ 1: 0, 2: 0, 3: 0, 4: 1, 5: 1 });
  });

  it('counts every entry exactly once', () => {
    const result = distribution([
      entry('a', 'project', 1),
      entry('b', 'case', 3),
      entry('c', 'case', 3.2),
    ]);
    expect(result).toEqual({ 1: 1, 2: 0, 3: 2, 4: 0, 5: 0 });
  });
});

describe('filterEntries', () => {
  const entries = [entry('a', 'project'), entry('b', 'case'), entry('c', 'project')];

  it('returns everything for all', () => {
    expect(filterEntries(entries, 'all').map((e) => e.key)).toEqual(['a', 'b', 'c']);
  });

  it('keeps one kind', () => {
    expect(filterEntries(entries, 'project').map((e) => e.key)).toEqual(['a', 'c']);
    expect(filterEntries(entries, 'case').map((e) => e.key)).toEqual(['b']);
  });
});

describe('labels', () => {
  it('pluralises the show-more label', () => {
    expect(showMoreLabel(1)).toBe('Show 1 more review');
    expect(showMoreLabel(5)).toBe('Show 5 more reviews');
  });

  it('pluralises engagements', () => {
    expect(engagementsLabel(1)).toBe('1 engagement');
    expect(engagementsLabel(8)).toBe('8 engagements');
  });
});
