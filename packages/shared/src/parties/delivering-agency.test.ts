import { describe, expect, it } from 'vitest';
import { deliveringAgencyIdFor } from './delivering-agency';

describe('deliveringAgencyIdFor', () => {
  it('returns the engagement pin, ignoring a different profile agency', () => {
    expect(
      deliveringAgencyIdFor({ from: 'engagement', deliveringAgencyId: 'agency-a' }, 'agency-b')
    ).toBe('agency-a');
  });

  it('keeps a NULL engagement pin NULL even when the profile has an agency', () => {
    expect(
      deliveringAgencyIdFor({ from: 'engagement', deliveringAgencyId: null }, 'agency-b')
    ).toBeNull();
  });

  it('returns the profile agency for an expert_profile source', () => {
    expect(deliveringAgencyIdFor({ from: 'expert_profile' }, 'agency-b')).toBe('agency-b');
  });

  it('returns null for an expert_profile source whose profile has no agency', () => {
    expect(deliveringAgencyIdFor({ from: 'expert_profile' }, null)).toBeNull();
  });
});
