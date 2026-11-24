import { describe, expect, it } from 'vitest';
import {
  buildClauseIndex,
  clauseLabel,
  formatTermsDate,
  resolveClauseRefs,
  splitEmphasis,
  type TermsSection,
} from './terms';

const SECTIONS: readonly TermsSection[] = [
  {
    id: 'first',
    title: 'First',
    clauses: [{ id: 'first.a', text: 'A', children: [{ id: 'first.a.x', text: 'X' }] }],
  },
  { id: 'second', title: 'Second', clauses: [{ text: 'B' }] },
];

const INDEX = buildClauseIndex(SECTIONS);

describe('clauseLabel', () => {
  it.each([
    [[3], '3'],
    [[3, 7], '3.7'],
    [[3, 7, 1], '3.7.1'],
    [[6, 3, 1, 1], '(a)'],
    [[6, 3, 1, 3], '(c)'],
    [[23, 2, 4, 1, 1], 'i.'],
    [[23, 2, 4, 1, 2], 'ii.'],
  ])('labels %j as %s', (position, label) => {
    expect(clauseLabel(position)).toBe(label);
  });

  it('rejects an empty, too deep, or out-of-range path', () => {
    expect(() => clauseLabel([])).toThrow(RangeError);
    expect(() => clauseLabel([1, 1, 1, 1, 1, 1])).toThrow(RangeError);
    expect(() => clauseLabel([1, 1, 1, 1, 99])).toThrow(RangeError);
    expect(() => clauseLabel([1, 1, 1, 27])).toThrow(RangeError);
    expect(() => clauseLabel([1, 1, 1, 0])).toThrow(RangeError);
  });
});

describe('buildClauseIndex and resolveClauseRefs', () => {
  it('maps section and clause ids to their visible numbers', () => {
    expect(INDEX.get('first')).toBe('1');
    expect(INDEX.get('first.a')).toBe('1.1');
    expect(INDEX.get('first.a.x')).toBe('1.1.1');
    expect(INDEX.get('second')).toBe('2');
  });

  it('replaces a token with the clause number', () => {
    expect(resolveClauseRefs('see clause {{clause:first.a.x}}', INDEX)).toBe('see clause 1.1.1');
  });

  it('throws on an unknown id', () => {
    expect(() => resolveClauseRefs('{{clause:nope}}', INDEX)).toThrow('nope');
  });

  it('leaves text without tokens unchanged', () => {
    expect(resolveClauseRefs('no tokens here', INDEX)).toBe('no tokens here');
  });
});

describe('splitEmphasis', () => {
  it('returns plain text as one run', () => {
    expect(splitEmphasis('plain')).toEqual([{ text: 'plain', emphasis: 'none' }]);
  });

  it('returns no runs for empty text', () => {
    expect(splitEmphasis('')).toEqual([]);
  });

  it('splits bold and italic runs around plain text', () => {
    expect(splitEmphasis('a **b** c *d* e')).toEqual([
      { text: 'a ', emphasis: 'none' },
      { text: 'b', emphasis: 'bold' },
      { text: ' c ', emphasis: 'none' },
      { text: 'd', emphasis: 'italic' },
      { text: ' e', emphasis: 'none' },
    ]);
  });

  it('reads a whole-string italic line', () => {
    expect(splitEmphasis('*Last Updated: 23rd July 2025*')).toEqual([
      { text: 'Last Updated: 23rd July 2025', emphasis: 'italic' },
    ]);
  });

  it('keeps punctuation around a bold run in plain runs', () => {
    expect(splitEmphasis('“**Site**”.')).toEqual([
      { text: '“', emphasis: 'none' },
      { text: 'Site', emphasis: 'bold' },
      { text: '”.', emphasis: 'none' },
    ]);
  });

  it('throws on an unclosed marker', () => {
    expect(() => splitEmphasis('a **b')).toThrow('Unclosed');
    expect(() => splitEmphasis('a *b')).toThrow('Unclosed');
  });

  it('throws on an empty marker pair', () => {
    expect(() => splitEmphasis('a **** b')).toThrow('Empty');
  });
});

describe('formatTermsDate', () => {
  it('formats an ISO date as a long en-GB date', () => {
    expect(formatTermsDate('2025-07-23')).toBe('23 July 2025');
    expect(formatTermsDate('2026-10-12')).toBe('12 October 2026');
  });
});
