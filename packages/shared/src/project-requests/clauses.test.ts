import { describe, expect, it } from 'vitest';
import {
  PROPOSAL_CHANGE_SECTIONS,
  PROPOSAL_CHANGE_SECTION_PHRASE,
  proposalChangeSectionPhrase,
} from './index';
import {
  PROPOSAL_CLAUSE_COUNT_FROM,
  PROPOSAL_CLAUSE_KINDS,
  PROPOSAL_CLAUSE_MAX_CHARS,
  PROPOSAL_CLAUSE_MAX_ITEMS,
  clauseMentionsAmount,
  groupClauseBodies,
  normalizeClauseBody,
  splitPastedClauses,
  stripListMarker,
} from './clauses';

describe('clause constants', () => {
  it('lists the kinds in document order', () => {
    expect([...PROPOSAL_CLAUSE_KINDS]).toEqual(['assumption', 'exclusion', 'additional_term']);
  });

  it('pins the caps', () => {
    expect(PROPOSAL_CLAUSE_MAX_ITEMS).toBe(20);
    expect(PROPOSAL_CLAUSE_MAX_CHARS).toBe(500);
    expect(PROPOSAL_CLAUSE_COUNT_FROM).toBe(420);
  });
});

describe('normalizeClauseBody', () => {
  it('collapses a line break and the whitespace around it to one space', () => {
    expect(normalizeClauseBody('a\nb ')).toBe('a b');
    expect(normalizeClauseBody('a \n\n  b')).toBe('a b');
    expect(normalizeClauseBody('a\r\nb')).toBe('a b');
  });

  it('trims and leaves interior spacing on a single line alone', () => {
    expect(normalizeClauseBody('  two  words  ')).toBe('two  words');
  });

  it('returns an empty string for blank input', () => {
    expect(normalizeClauseBody(' \n \n ')).toBe('');
  });
});

describe('stripListMarker', () => {
  it.each([
    ['- two rounds of revisions', 'two rounds of revisions'],
    ['• two rounds of revisions', 'two rounds of revisions'],
    ['* two rounds of revisions', 'two rounds of revisions'],
    ['1. two rounds of revisions', 'two rounds of revisions'],
    ['2) two rounds of revisions', 'two rounds of revisions'],
    ['— two rounds of revisions', 'two rounds of revisions'],
    ['  – two rounds of revisions', 'two rounds of revisions'],
  ])('strips the marker from %j', (input, expected) => {
    expect(stripListMarker(input)).toBe(expected);
  });

  it('keeps a number that is part of the sentence', () => {
    expect(stripListMarker('2 rounds of revisions')).toBe('2 rounds of revisions');
    expect(stripListMarker('-no space after the dash')).toBe('-no space after the dash');
  });

  it('strips only one marker', () => {
    expect(stripListMarker('- - nested')).toBe('- nested');
  });
});

describe('splitPastedClauses', () => {
  it('returns one body per non-blank line with markers stripped', () => {
    expect(splitPastedClauses('- one\r\n\n2. two\n  \n• three\n')).toEqual(['one', 'two', 'three']);
  });

  it('returns a single body for single-line text', () => {
    expect(splitPastedClauses('just one')).toEqual(['just one']);
  });

  it('returns nothing for blank text', () => {
    expect(splitPastedClauses(' \n\n')).toEqual([]);
  });
});

describe('clauseMentionsAmount', () => {
  it.each([
    'A$165/hr',
    '$500',
    '200 AUD',
    'billed per day',
    '€40',
    '1,200.50 dollars',
    '95 / hour',
  ])('is true for %j', (body) => {
    expect(clauseMentionsAmount(body)).toBe(true);
  });

  it.each(['two rounds', 'Phase 2', 'Two rounds of revisions per milestone', 'Sandbox access'])(
    'is false for %j',
    (body) => {
      expect(clauseMentionsAmount(body)).toBe(false);
    }
  );
});

describe('groupClauseBodies', () => {
  it('splits rows by kind and keeps each list in input order', () => {
    expect(
      groupClauseBodies([
        { kind: 'exclusion', body: 'e1' },
        { kind: 'assumption', body: 'a1' },
        { kind: 'additional_term', body: 't1' },
        { kind: 'assumption', body: 'a2' },
        { kind: 'exclusion', body: 'e2' },
      ])
    ).toEqual({
      assumptions: ['a1', 'a2'],
      exclusions: ['e1', 'e2'],
      additionalTerms: ['t1'],
    });
  });

  it('returns three empty lists for no rows', () => {
    expect(groupClauseBodies([])).toEqual({ assumptions: [], exclusions: [], additionalTerms: [] });
  });
});

describe('proposal change section phrases', () => {
  it('has the seven sections in pgEnum order', () => {
    expect([...PROPOSAL_CHANGE_SECTIONS]).toEqual([
      'general',
      'milestones',
      'pricing',
      'payment_terms',
      'timeline',
      'assumptions_exclusions',
      'terms',
    ]);
  });

  it.each(PROPOSAL_CHANGE_SECTIONS)('has a phrase for %s that is not the raw key', (section) => {
    const phrase = proposalChangeSectionPhrase(section);
    expect(phrase).toBe(PROPOSAL_CHANGE_SECTION_PHRASE[section]);
    expect(phrase).toMatch(/^the /);
    expect(phrase).not.toContain('_');
  });

  it('names the new sections', () => {
    expect(proposalChangeSectionPhrase('assumptions_exclusions')).toBe(
      'the assumptions and exclusions'
    );
    expect(proposalChangeSectionPhrase('terms')).toBe('the terms');
    expect(proposalChangeSectionPhrase('payment_terms')).toBe('the payment schedule');
  });

  it('reads an unknown section as the whole proposal', () => {
    expect(proposalChangeSectionPhrase('not_a_section')).toBe('the proposal');
  });
});
