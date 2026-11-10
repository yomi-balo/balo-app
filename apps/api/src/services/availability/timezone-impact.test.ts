import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockFindResolverSettings,
  mockListRules,
  mockListConfirmedInRange,
  mockListUpcoming,
  mockResolveCompanies,
  mockWarn,
} = vi.hoisted(() => ({
  mockFindResolverSettings: vi.fn(),
  mockListRules: vi.fn(),
  mockListConfirmedInRange: vi.fn(),
  mockListUpcoming: vi.fn(),
  mockResolveCompanies: vi.fn(),
  mockWarn: vi.fn(),
}));

vi.mock('@balo/db', () => ({
  expertsRepository: { findResolverSettings: mockFindResolverSettings },
  availabilityRulesRepository: { listByExpertProfileId: mockListRules },
  consultationsRepository: { listConfirmedInRange: mockListConfirmedInRange },
  availabilityOverridesRepository: { listUpcoming: mockListUpcoming },
  resolveClientCompaniesForMeetings: mockResolveCompanies,
}));

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: mockWarn, error: vi.fn() }),
}));

import {
  TIMEZONE_IMPACT_DETAIL_LIMIT,
  TIMEZONE_IMPACT_HORIZON_DAYS,
  findTimezoneImpact,
} from './timezone-impact';

const EXPERT_ID = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';
const USER_ID = 'a1b2c3d4-5678-4e9f-8a1b-2c3d4e5f6789';
const OTHER_USER_ID = 'f1e2d3c4-b5a6-4978-9a8b-7c6d5e4f3a2b';

// Monday 2 Nov 2026 00:00 UTC. Sydney is on AEDT (UTC+11) and London on GMT (UTC+0).
const NOW = new Date('2026-11-02T00:00:00Z');

function rule(dayOfWeek: number, startTime: string, endTime: string) {
  return { dayOfWeek, startTime, endTime };
}

const MON_FRI_9_TO_5 = [1, 2, 3, 4, 5].map((d) => rule(d, '09:00:00', '17:00:00'));

function consultation(id: string, startAt: string, endAt: string) {
  return {
    id,
    meetingId: `meeting-${id}`,
    expertProfileId: EXPERT_ID,
    startAt: new Date(startAt),
    endAt: new Date(endAt),
    status: 'confirmed' as const,
  };
}

// Tue 3 Nov 10:00–10:30 Sydney.
const TUE_10AM_SYDNEY = consultation('c1', '2026-11-02T23:00:00Z', '2026-11-02T23:30:00Z');

function run(proposedTimezone: string) {
  return findTimezoneImpact({
    expertProfileId: EXPERT_ID,
    userId: USER_ID,
    proposedTimezone,
    now: NOW,
  });
}

describe('findTimezoneImpact', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindResolverSettings.mockResolvedValue({ userId: USER_ID, timezone: 'Australia/Sydney' });
    mockListRules.mockResolvedValue(MON_FRI_9_TO_5);
    mockListConfirmedInRange.mockResolvedValue([]);
    mockListUpcoming.mockResolvedValue([]);
    mockResolveCompanies.mockResolvedValue(new Map());
  });

  it('exposes the 90-day horizon and the 20-row detail cap', () => {
    expect(TIMEZONE_IMPACT_HORIZON_DAYS).toBe(90);
    expect(TIMEZONE_IMPACT_DETAIL_LIMIT).toBe(20);
  });

  it('returns expert_not_found when the profile is missing', async () => {
    mockFindResolverSettings.mockResolvedValue(null);

    await expect(run('Europe/London')).resolves.toEqual({ outcome: 'expert_not_found' });
    expect(mockListConfirmedInRange).not.toHaveBeenCalled();
  });

  it('returns expert_not_found for a userId mismatch without resolving any company', async () => {
    mockListConfirmedInRange.mockResolvedValue([TUE_10AM_SYDNEY]);

    const result = await findTimezoneImpact({
      expertProfileId: EXPERT_ID,
      userId: OTHER_USER_ID,
      proposedTimezone: 'Europe/London',
      now: NOW,
    });

    expect(result).toEqual({ outcome: 'expert_not_found' });
    expect(mockResolveCompanies).not.toHaveBeenCalled();
    expect(mockListConfirmedInRange).not.toHaveBeenCalled();
  });

  it('reads consultations from now to now + 90 days', async () => {
    await run('Europe/London');

    expect(mockListConfirmedInRange).toHaveBeenCalledWith(
      EXPERT_ID,
      NOW,
      new Date('2027-01-31T00:00:00Z')
    );
  });

  it('returns zero affected without computing windows when there are no consultations', async () => {
    const result = await run('Europe/London');

    expect(result).toEqual({
      outcome: 'ok',
      timezone: 'Europe/London',
      affectedCount: 0,
      truncated: false,
      affected: [],
      nextTimeOff: null,
    });
    expect(mockResolveCompanies).not.toHaveBeenCalled();
  });

  it('counts nothing as affected when the proposed zone is the zone the rules were authored in', async () => {
    mockListConfirmedInRange.mockResolvedValue([TUE_10AM_SYDNEY]);

    const result = await run('Australia/Sydney');

    expect(result).toMatchObject({ outcome: 'ok', affectedCount: 0, affected: [] });
  });

  it('flags a 10:00 Sydney consultation when the rules are re-read in London', async () => {
    mockListConfirmedInRange.mockResolvedValue([TUE_10AM_SYDNEY]);
    mockResolveCompanies.mockResolvedValue(
      new Map([['meeting-c1', { companyName: 'Northwind Industrial' }]])
    );

    const result = await run('Europe/London');

    expect(result).toEqual({
      outcome: 'ok',
      timezone: 'Europe/London',
      affectedCount: 1,
      truncated: false,
      affected: [
        {
          consultationId: 'c1',
          startAt: TUE_10AM_SYDNEY.startAt,
          endAt: TUE_10AM_SYDNEY.endAt,
          clientCompanyName: 'Northwind Industrial',
        },
      ],
      nextTimeOff: null,
    });
    expect(mockResolveCompanies).toHaveBeenCalledWith(['meeting-c1'], EXPERT_ID);
  });

  it('flags a partial overlap with the window end (16:30–17:30 Sydney)', async () => {
    mockListConfirmedInRange.mockResolvedValue([
      consultation('c2', '2026-11-03T05:30:00Z', '2026-11-03T06:30:00Z'),
    ]);

    const result = await run('Australia/Sydney');

    expect(result).toMatchObject({ outcome: 'ok', affectedCount: 1 });
  });

  it('treats a consultation spanning two adjacent rules as contained', async () => {
    mockListRules.mockResolvedValue([
      rule(3, '09:00:00', '12:00:00'),
      rule(3, '12:00:00', '17:00:00'),
    ]);
    // Wed 4 Nov 11:30–12:30 Sydney.
    mockListConfirmedInRange.mockResolvedValue([
      consultation('c3', '2026-11-04T00:30:00Z', '2026-11-04T01:30:00Z'),
    ]);

    const result = await run('Australia/Sydney');

    expect(result).toMatchObject({ outcome: 'ok', affectedCount: 0 });
  });

  it('treats a consultation inside a rule that crosses midnight as contained', async () => {
    mockListRules.mockResolvedValue([rule(4, '22:00:00', '02:00:00')]);
    // Thu 5 Nov 23:30 → Fri 6 Nov 00:30 Sydney.
    mockListConfirmedInRange.mockResolvedValue([
      consultation('c4', '2026-11-05T12:30:00Z', '2026-11-05T13:30:00Z'),
    ]);

    const result = await run('Australia/Sydney');

    expect(result).toMatchObject({ outcome: 'ok', affectedCount: 0 });
  });

  it('flags every consultation when the expert has no rules', async () => {
    mockListRules.mockResolvedValue([]);
    mockListConfirmedInRange.mockResolvedValue([TUE_10AM_SYDNEY]);

    const result = await run('Australia/Sydney');

    expect(result).toMatchObject({ outcome: 'ok', affectedCount: 1 });
  });

  it('caps the detail rows at 20, sorted by start, and reports the exact count', async () => {
    // 21 half-hour Sunday-night Sydney slots (no rules cover Sunday), 1 hour apart.
    const rows = Array.from({ length: TIMEZONE_IMPACT_DETAIL_LIMIT + 1 }, (_, i) => {
      const start = new Date(Date.parse('2026-11-07T20:00:00Z') + i * 3_600_000);
      return {
        ...consultation(`c${String(i).padStart(2, '0')}`, start.toISOString(), start.toISOString()),
        endAt: new Date(start.getTime() + 1_800_000),
      };
    });
    mockListConfirmedInRange.mockResolvedValue([...rows].reverse());

    const result = await run('Australia/Sydney');

    if (result.outcome !== 'ok') throw new Error('expected ok');
    expect(result.affectedCount).toBe(21);
    expect(result.truncated).toBe(true);
    expect(result.affected).toHaveLength(20);
    expect(result.affected[0]?.consultationId).toBe('c00');
    expect(result.affected[19]?.consultationId).toBe('c19');
    expect(mockResolveCompanies.mock.calls[0]?.[0]).toHaveLength(20);
  });

  it('is not truncated at exactly 20 affected', async () => {
    mockListRules.mockResolvedValue([]);
    mockListConfirmedInRange.mockResolvedValue(
      Array.from({ length: 20 }, (_, i) =>
        consultation(
          `c${i}`,
          new Date(Date.parse('2026-11-07T20:00:00Z') + i * 3_600_000).toISOString(),
          new Date(Date.parse('2026-11-07T20:30:00Z') + i * 3_600_000).toISOString()
        )
      )
    );

    const result = await run('Australia/Sydney');

    expect(result).toMatchObject({ outcome: 'ok', affectedCount: 20, truncated: false });
  });

  it('returns a null company name and warns when the company cannot be resolved', async () => {
    mockListConfirmedInRange.mockResolvedValue([TUE_10AM_SYDNEY]);

    const result = await run('Europe/London');

    if (result.outcome !== 'ok') throw new Error('expected ok');
    expect(result.affected[0]?.clientCompanyName).toBeNull();
    expect(mockWarn).toHaveBeenCalledWith(
      { expertProfileId: EXPERT_ID, meetingId: 'meeting-c1' },
      expect.stringContaining('no resolvable client company')
    );
  });

  it('reports the first upcoming time-off block', async () => {
    mockListUpcoming.mockResolvedValue([
      { startDate: '2026-12-24', endDate: '2027-01-02' },
      { startDate: '2027-02-01', endDate: '2027-02-03' },
    ]);

    const result = await run('Europe/London');

    expect(result).toMatchObject({
      outcome: 'ok',
      nextTimeOff: { startDate: '2026-12-24', endDate: '2027-01-02' },
    });
  });
});
