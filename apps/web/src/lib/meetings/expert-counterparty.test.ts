import { describe, it, expect } from 'vitest';
import { expertCounterpartyLabels } from './expert-counterparty';

describe('expertCounterpartyLabels (BAL-566 D7)', () => {
  it('names the person and the agency for an agency-based expert', () => {
    expect(
      expertCounterpartyLabels({ firstName: 'Priya', lastName: 'Sharma', agencyName: 'CloudPeak' })
    ).toEqual({ personName: 'Priya Sharma', agencyLabel: 'CloudPeak' });
  });

  it('has no org label for an independent expert', () => {
    expect(
      expertCounterpartyLabels({ firstName: 'Priya', lastName: 'Sharma', agencyName: null })
    ).toEqual({ personName: 'Priya Sharma', agencyLabel: null });
  });

  it('falls back to "An expert" when the name is missing', () => {
    expect(expertCounterpartyLabels({ firstName: null, lastName: null, agencyName: null })).toEqual(
      {
        personName: 'An expert',
        agencyLabel: null,
      }
    );
  });
});
