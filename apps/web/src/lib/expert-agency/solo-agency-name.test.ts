import { describe, it, expect } from 'vitest';
import { soloAgencyName } from './solo-agency-name';

describe('soloAgencyName', () => {
  it('joins first and last name', () => {
    expect(soloAgencyName('Jane', 'Doe')).toBe('Jane Doe');
  });

  it('uses whichever part is present', () => {
    expect(soloAgencyName('Jane', null)).toBe('Jane');
    expect(soloAgencyName(null, 'Doe')).toBe('Doe');
  });

  it('falls back to a neutral label when there is no usable name', () => {
    expect(soloAgencyName(null, null)).toBe('Independent Expert');
    expect(soloAgencyName(' ', ' ')).toBe('Independent Expert');
  });
});
