import { describe, it, expect } from 'vitest';
import { CASE_INACTIVITY_DAYS, caseInactivityAnchor, isCaseInactive } from './index';

const NOW = new Date('2026-08-04T00:00:00.000Z');
const daysAgo = (n: number): Date => new Date(NOW.getTime() - n * 86_400_000);
const daysAhead = (n: number): Date => new Date(NOW.getTime() + n * 86_400_000);

describe('CASE_INACTIVITY_DAYS', () => {
  it('is 30', () => {
    expect(CASE_INACTIVITY_DAYS).toBe(30);
  });
});

describe('caseInactivityAnchor', () => {
  it('returns the last completed consultation when there is one', () => {
    const last = daysAgo(5);
    expect(
      caseInactivityAnchor({
        caseCreatedAt: daysAgo(90),
        lastCompletedConsultationAt: last,
      }).getTime()
    ).toBe(last.getTime());
  });

  it('falls back to the case creation when none has completed', () => {
    const created = daysAgo(90);
    expect(
      caseInactivityAnchor({
        caseCreatedAt: created,
        lastCompletedConsultationAt: null,
      }).getTime()
    ).toBe(created.getTime());
  });
});

describe('isCaseInactive', () => {
  const cases: Array<{
    name: string;
    input: Parameters<typeof isCaseInactive>[0];
    expected: boolean;
  }> = [
    {
      name: 'no consultation ever, case created 31 days ago → inactive (creation fallback)',
      input: {
        now: NOW,
        caseCreatedAt: daysAgo(31),
        lastCompletedConsultationAt: null,
        nextScheduledConsultationAt: null,
      },
      expected: true,
    },
    {
      name: 'no consultation ever, case created 29 days ago → active',
      input: {
        now: NOW,
        caseCreatedAt: daysAgo(29),
        lastCompletedConsultationAt: null,
        nextScheduledConsultationAt: null,
      },
      expected: false,
    },
    {
      name: 'last completed 31 days ago, created 90 days ago → inactive (anchor is the consultation)',
      input: {
        now: NOW,
        caseCreatedAt: daysAgo(90),
        lastCompletedConsultationAt: daysAgo(31),
        nextScheduledConsultationAt: null,
      },
      expected: true,
    },
    {
      name: 'last completed 5 days ago, created 90 days ago → active (a recent consultation resets the clock)',
      input: {
        now: NOW,
        caseCreatedAt: daysAgo(90),
        lastCompletedConsultationAt: daysAgo(5),
        nextScheduledConsultationAt: null,
      },
      expected: false,
    },
    {
      name: 'last completed 40 days ago BUT one scheduled tomorrow → active (the skip rule wins)',
      input: {
        now: NOW,
        caseCreatedAt: daysAgo(90),
        lastCompletedConsultationAt: daysAgo(40),
        nextScheduledConsultationAt: daysAhead(1),
      },
      expected: false,
    },
    {
      name: 'a consultation scheduled in the PAST does not skip → inactive (only UPCOMING skips)',
      input: {
        now: NOW,
        caseCreatedAt: daysAgo(90),
        lastCompletedConsultationAt: daysAgo(40),
        nextScheduledConsultationAt: daysAgo(2),
      },
      expected: true,
    },
    {
      name: 'exactly 30 days elapsed → inactive (INCLUSIVE >=, matching the sweep cutoff convention)',
      input: {
        now: NOW,
        caseCreatedAt: daysAgo(30),
        lastCompletedConsultationAt: null,
        nextScheduledConsultationAt: null,
      },
      expected: true,
    },
    {
      name: 'custom thresholdDays honoured — 8 days elapsed against a 7-day threshold → inactive',
      input: {
        now: NOW,
        caseCreatedAt: daysAgo(8),
        lastCompletedConsultationAt: null,
        nextScheduledConsultationAt: null,
        thresholdDays: 7,
      },
      expected: true,
    },
    {
      name: 'custom thresholdDays honoured — 6 days elapsed against a 7-day threshold → active',
      input: {
        now: NOW,
        caseCreatedAt: daysAgo(6),
        lastCompletedConsultationAt: null,
        nextScheduledConsultationAt: null,
        thresholdDays: 7,
      },
      expected: false,
    },
  ];

  for (const { name, input, expected } of cases) {
    it(name, () => {
      expect(isCaseInactive(input)).toBe(expected);
    });
  }
});
