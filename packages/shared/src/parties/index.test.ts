import { describe, it, expect } from 'vitest';
import { expertPartyDisplayName } from './index';

/**
 * Unit truth-table for the pure counterpart-name helper (BAL-336). Mocks
 * nothing — `@balo/shared/parties` has no `db` import and no I/O. The
 * party-vs-person convention decides the counterpart label the A7 inbox (D6) and
 * the delivery workspace (D1) both render, so the rules are locked here.
 */

describe('expertPartyDisplayName', () => {
  it('returns the agency name for an agency party', () => {
    expect(
      expertPartyDisplayName({
        type: 'agency',
        agencyName: 'Cloudreach',
        firstName: 'Priya',
        lastName: 'Nadella',
      })
    ).toBe('Cloudreach');
  });

  it('falls back to the person name for an agency with a blank agency name', () => {
    expect(
      expertPartyDisplayName({
        type: 'agency',
        agencyName: '   ',
        firstName: 'Priya',
        lastName: 'Nadella',
      })
    ).toBe('Priya Nadella');
  });

  it('falls back to the person name for an agency with a null agency name', () => {
    expect(
      expertPartyDisplayName({
        type: 'agency',
        agencyName: null,
        firstName: 'Priya',
        lastName: 'Nadella',
      })
    ).toBe('Priya Nadella');
  });

  it('returns "First Last" for a freelancer', () => {
    expect(
      expertPartyDisplayName({
        type: 'freelancer',
        agencyName: null,
        firstName: 'Sam',
        lastName: 'Okafor',
      })
    ).toBe('Sam Okafor');
  });

  it('returns just the first name when the last name is null', () => {
    expect(
      expertPartyDisplayName({
        type: 'freelancer',
        agencyName: null,
        firstName: 'Sam',
        lastName: null,
      })
    ).toBe('Sam');
  });

  it('returns "An expert" when no name resolves', () => {
    expect(
      expertPartyDisplayName({
        type: 'freelancer',
        agencyName: null,
        firstName: null,
        lastName: null,
      })
    ).toBe('An expert');
  });

  it('ignores a whitespace-only agency name and trims the person name', () => {
    expect(
      expertPartyDisplayName({
        type: 'freelancer',
        agencyName: null,
        firstName: '  ',
        lastName: 'Okafor',
      })
    ).toBe('Okafor');
  });
});
