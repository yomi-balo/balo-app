import { describe, expect, it } from 'vitest';
import { caseClosedBeforeStart, caseClosureNames } from './case-closure';

const START = new Date('2026-09-27T10:00:00.000Z');
const at = (offsetMs: number): Date => new Date(START.getTime() + offsetMs);

describe('caseClosedBeforeStart (BAL-474, D12.1(c))', () => {
  it('an ACTIVE case is never closed before the start — whatever a stray closedAt says', () => {
    expect(caseClosedBeforeStart({ isActive: true, closedAt: null }, START)).toBe(false);
    expect(caseClosedBeforeStart({ isActive: true, closedAt: at(-60_000) }, START)).toBe(false);
  });

  it.each([
    ['a day before the start', at(-24 * 60 * 60_000), true],
    ['one millisecond before the start', at(-1), true],
    ['exactly AT the start (the boundary is NOT "before")', at(0), false],
    ['after the start (the client resolved it while the expert waited)', at(5 * 60_000), false],
  ])('a non-active case closed %s', (_label, closedAt, expected) => {
    expect(caseClosedBeforeStart({ isActive: false, closedAt }, START)).toBe(expected);
  });

  it('a non-active case with NO close instant is closed before the start — never billed on a guess', () => {
    expect(caseClosedBeforeStart({ isActive: false, closedAt: null }, START)).toBe(true);
  });
});

describe('caseClosureNames (BAL-474, R6-C3 / R6F-2)', () => {
  it('returns the trimmed first name and the company name', () => {
    expect(caseClosureNames({ firstName: '  Maya ' }, { name: 'Northwind' })).toEqual({
      closedByFirstName: 'Maya',
      companyName: 'Northwind',
    });
  });

  it('no closer row (an inactivity-sweep close): the first name is null', () => {
    expect(caseClosureNames(undefined, { name: 'Northwind' })).toEqual({
      closedByFirstName: null,
      companyName: 'Northwind',
    });
  });

  it('a null or blank first name is null, never an empty attribution', () => {
    expect(
      caseClosureNames({ firstName: null }, { name: 'Northwind' }).closedByFirstName
    ).toBeNull();
    expect(
      caseClosureNames({ firstName: '   ' }, { name: 'Northwind' }).closedByFirstName
    ).toBeNull();
  });

  it('no company row: the company name is null', () => {
    expect(caseClosureNames({ firstName: 'Maya' }, undefined)).toEqual({
      closedByFirstName: 'Maya',
      companyName: null,
    });
  });
});
