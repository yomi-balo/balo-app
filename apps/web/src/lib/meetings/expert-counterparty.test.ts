import { describe, it, expect } from 'vitest';
import { counterpartyAgencySource, expertCounterpartyLabels } from './expert-counterparty';

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

describe('counterpartyAgencySource', () => {
  it('reads the pin for a case meeting', () => {
    expect(counterpartyAgencySource(true, { deliveringAgencyId: 'ag-1' })).toEqual({
      from: 'engagement',
      deliveringAgencyId: 'ag-1',
    });
  });

  it('treats a case meeting with no readable case row as an unpinned one', () => {
    expect(counterpartyAgencySource(true, undefined)).toEqual({
      from: 'engagement',
      deliveringAgencyId: null,
    });
  });

  it('reads the engagement pin for any engagement-grain meeting', () => {
    expect(counterpartyAgencySource(true, { deliveringAgencyId: 'ag-2' })).toEqual({
      from: 'engagement',
      deliveringAgencyId: 'ag-2',
    });
  });

  it('reads the expert profile for every other meeting', () => {
    expect(counterpartyAgencySource(false, undefined)).toEqual({ from: 'expert_profile' });
  });
});
