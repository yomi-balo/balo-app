import { describe, it, expect } from 'vitest';
import {
  currentBillingPeriod,
  estimateCrossed,
  hoursLabel,
  loggedValueCents,
  percentOfEstimate,
} from './time-entries';

const d = (iso: string): Date => new Date(`${iso}T00:00:00Z`);

describe('currentBillingPeriod', () => {
  it('is null when activation or cadence is missing', () => {
    expect(currentBillingPeriod(null, 'monthly', d('2026-02-01'))).toBeNull();
    expect(currentBillingPeriod(d('2026-01-05'), null, d('2026-02-01'))).toBeNull();
  });

  it('anchors monthly periods on the activation day', () => {
    expect(currentBillingPeriod(d('2026-01-15'), 'monthly', d('2026-01-20'))).toEqual({
      startOn: '2026-01-15',
      endOn: '2026-02-15',
      nextInvoiceOn: '2026-02-15',
    });
  });

  it('rolls over exactly on endOn and stays inside the day before', () => {
    const activated = d('2026-01-15');
    expect(currentBillingPeriod(activated, 'monthly', d('2026-02-14'))?.startOn).toBe('2026-01-15');
    expect(currentBillingPeriod(activated, 'monthly', d('2026-02-15'))).toMatchObject({
      startOn: '2026-02-15',
      endOn: '2026-03-15',
    });
  });

  it('clamps a 31st anchor to short months without drifting', () => {
    const activated = d('2026-01-31');
    expect(currentBillingPeriod(activated, 'monthly', d('2026-02-10'))).toMatchObject({
      startOn: '2026-01-31',
      endOn: '2026-02-28',
    });
    expect(currentBillingPeriod(activated, 'monthly', d('2026-02-28'))).toMatchObject({
      startOn: '2026-02-28',
      endOn: '2026-03-31',
    });
    expect(currentBillingPeriod(activated, 'monthly', d('2026-03-31'))).toMatchObject({
      startOn: '2026-03-31',
      endOn: '2026-04-30',
    });
  });

  it('clamps to 29 February in a leap year', () => {
    expect(currentBillingPeriod(d('2028-01-31'), 'monthly', d('2028-02-15'))).toMatchObject({
      startOn: '2028-01-31',
      endOn: '2028-02-29',
    });
  });

  it('crosses a year boundary', () => {
    expect(currentBillingPeriod(d('2026-11-20'), 'monthly', d('2027-01-05'))).toMatchObject({
      startOn: '2026-12-20',
      endOn: '2027-01-20',
    });
  });

  it('uses 14-day blocks for fortnightly', () => {
    const activated = d('2026-01-01');
    expect(currentBillingPeriod(activated, 'fortnightly', d('2026-01-14'))).toMatchObject({
      startOn: '2026-01-01',
      endOn: '2026-01-15',
    });
    expect(currentBillingPeriod(activated, 'fortnightly', d('2026-01-15'))).toMatchObject({
      startOn: '2026-01-15',
      endOn: '2026-01-29',
    });
  });

  it('returns the first period when now is before activation', () => {
    expect(currentBillingPeriod(d('2026-03-10'), 'monthly', d('2026-01-01'))).toMatchObject({
      startOn: '2026-03-10',
      endOn: '2026-04-10',
    });
    expect(currentBillingPeriod(d('2026-03-10'), 'fortnightly', d('2026-01-01'))).toMatchObject({
      startOn: '2026-03-10',
      endOn: '2026-03-24',
    });
  });

  it('reads the UTC date of the activation timestamp', () => {
    const activated = new Date('2026-01-15T23:30:00Z');
    expect(
      currentBillingPeriod(activated, 'monthly', new Date('2026-01-16T00:10:00Z'))
    ).toMatchObject({ startOn: '2026-01-15' });
  });

  describe('in a time zone', () => {
    it("rolls into the new period on the morning it starts in the expert's zone", () => {
      // Activated 1 Oct (Melbourne). 20:00Z on 31 Oct is 07:00 on 1 Nov in Melbourne (AEDT).
      const activated = new Date('2026-10-01T00:00:00Z');
      const now = new Date('2026-10-31T20:00:00Z');
      expect(currentBillingPeriod(activated, 'monthly', now)).toMatchObject({
        startOn: '2026-10-01',
        endOn: '2026-11-01',
      });
      expect(currentBillingPeriod(activated, 'monthly', now, 'Australia/Melbourne')).toEqual({
        startOn: '2026-11-01',
        endOn: '2026-12-01',
        nextInvoiceOn: '2026-12-01',
      });
    });

    it('anchors on the activation day in that zone', () => {
      // 20:00Z on 30 Sep is 06:00 on 1 Oct in Melbourne (AEST, UTC+10).
      const activated = new Date('2026-09-30T20:00:00Z');
      const now = new Date('2026-10-10T00:00:00Z');
      expect(currentBillingPeriod(activated, 'monthly', now)?.startOn).toBe('2026-09-30');
      expect(currentBillingPeriod(activated, 'monthly', now, 'Australia/Melbourne')).toMatchObject({
        startOn: '2026-10-01',
        endOn: '2026-11-01',
      });
    });

    it('matches UTC when the zone is null', () => {
      const activated = d('2026-01-15');
      expect(currentBillingPeriod(activated, 'fortnightly', d('2026-02-01'), null)).toEqual(
        currentBillingPeriod(activated, 'fortnightly', d('2026-02-01'))
      );
    });
  });
});

describe('estimateCrossed', () => {
  it('crosses when the sum moves from within the estimate to beyond it', () => {
    expect(estimateCrossed(465, 495, 480)).toBe(true);
  });

  it('does not cross when the sum lands exactly on the estimate', () => {
    expect(estimateCrossed(450, 480, 480)).toBe(false);
  });

  it('crosses from exactly the estimate to beyond it', () => {
    expect(estimateCrossed(480, 495, 480)).toBe(true);
  });

  it('does not cross again once already beyond the estimate', () => {
    expect(estimateCrossed(495, 510, 480)).toBe(false);
  });

  it('crosses an estimate of zero on the first entry', () => {
    expect(estimateCrossed(0, 15, 0)).toBe(true);
  });

  it('never crosses a null estimate', () => {
    expect(estimateCrossed(0, 9999, null)).toBe(false);
  });
});

describe('percentOfEstimate', () => {
  it('rounds to a whole percentage', () => {
    expect(percentOfEstimate(240, 480)).toBe(50);
    expect(percentOfEstimate(500, 480)).toBe(104);
  });

  it('is null for a null or zero estimate', () => {
    expect(percentOfEstimate(60, null)).toBeNull();
    expect(percentOfEstimate(60, 0)).toBeNull();
  });
});

describe('loggedValueCents', () => {
  it('rounds up to the next cent', () => {
    expect(loggedValueCents(60, 15000)).toBe(15000);
    expect(loggedValueCents(15, 10001)).toBe(2501);
  });

  it('is zero without a rate or time', () => {
    expect(loggedValueCents(60, null)).toBe(0);
    expect(loggedValueCents(0, 15000)).toBe(0);
  });
});

describe('hoursLabel', () => {
  it('uses the singular only for exactly one hour', () => {
    expect(hoursLabel(60)).toBe('1 hr');
    expect(hoursLabel(90)).toBe('1.5 hrs');
    expect(hoursLabel(15)).toBe('0.25 hrs');
    expect(hoursLabel(0)).toBe('0 hrs');
    expect(hoursLabel(120)).toBe('2 hrs');
  });
});
