import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── Hoisted mocks ──────────────────────────────────────────────

const { mockFindResolverSettings, mockListConfirmedInRange, mockResolveCompanies } = vi.hoisted(
  () => ({
    mockFindResolverSettings: vi.fn(),
    mockListConfirmedInRange: vi.fn(),
    mockResolveCompanies: vi.fn(),
  })
);

vi.mock('@balo/db', () => ({
  expertsRepository: { findResolverSettings: mockFindResolverSettings },
  consultationsRepository: { listConfirmedInRange: mockListConfirmedInRange },
  resolveClientCompaniesForMeetings: mockResolveCompanies,
}));

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { CONFLICT_DETAIL_LIMIT, findOverrideConflicts } from './override-conflicts';

const EXPERT_ID = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';
const USER_ID = 'a1b2c3d4-5678-4e9f-8a1b-2c3d4e5f6789';
const OTHER_USER_ID = 'f1e2d3c4-b5a6-4978-9a8b-7c6d5e4f3a2b';

const settings = (overrides: Partial<Record<string, unknown>> = {}) => ({
  userId: USER_ID,
  timezone: 'Australia/Sydney',
  bufferBeforeMinutes: 15,
  bufferAfterMinutes: 30,
  minimumNoticeMinutes: 120,
  ...overrides,
});

function consultation(
  id: string,
  startAt: string,
  endAt: string,
  meetingId = `meeting-${id}`
): {
  id: string;
  meetingId: string;
  expertProfileId: string;
  startAt: Date;
  endAt: Date;
  status: 'confirmed';
} {
  return {
    id,
    meetingId,
    expertProfileId: EXPERT_ID,
    startAt: new Date(startAt),
    endAt: new Date(endAt),
    status: 'confirmed',
  };
}

describe('findOverrideConflicts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns expert_not_found when settings are null, without reading consultations', async () => {
    mockFindResolverSettings.mockResolvedValue(null);

    const result = await findOverrideConflicts({
      expertProfileId: EXPERT_ID,
      userId: USER_ID,
      startDate: '2026-12-24',
      endDate: '2026-12-26',
    });

    expect(result).toEqual({ outcome: 'expert_not_found' });
    expect(mockListConfirmedInRange).not.toHaveBeenCalled();
  });

  it('S1 — returns the SAME expert_not_found outcome when userId does not own this profile, without reading consultations', async () => {
    mockFindResolverSettings.mockResolvedValue(settings());

    const result = await findOverrideConflicts({
      expertProfileId: EXPERT_ID,
      userId: OTHER_USER_ID,
      startDate: '2026-12-24',
      endDate: '2026-12-26',
    });

    expect(result).toEqual({ outcome: 'expert_not_found' });
    expect(mockListConfirmedInRange).not.toHaveBeenCalled();
  });

  it('returns zero conflicts and does not resolve companies when there are no overlapping rows', async () => {
    mockFindResolverSettings.mockResolvedValue(settings());
    mockListConfirmedInRange.mockResolvedValue([]);

    const result = await findOverrideConflicts({
      expertProfileId: EXPERT_ID,
      userId: USER_ID,
      startDate: '2026-12-24',
      endDate: '2026-12-26',
      now: new Date('2026-08-20T00:00:00.000Z'),
    });

    expect(result).toEqual({
      outcome: 'ok',
      timezone: 'Australia/Sydney',
      conflictCount: 0,
      truncated: false,
      conflicts: [],
    });
    expect(mockResolveCompanies).not.toHaveBeenCalled();
  });

  it('passes the BARE expanded block to listConfirmedInRange — no CONSULTATION_LOAD_PAD_MS (Sydney)', async () => {
    mockFindResolverSettings.mockResolvedValue(settings({ timezone: 'Australia/Sydney' }));
    mockListConfirmedInRange.mockResolvedValue([]);

    await findOverrideConflicts({
      expertProfileId: EXPERT_ID,
      userId: USER_ID,
      startDate: '2026-12-24',
      endDate: '2026-12-26',
      now: new Date('2026-08-20T00:00:00.000Z'),
    });

    expect(mockListConfirmedInRange).toHaveBeenCalledWith(
      EXPERT_ID,
      new Date('2026-12-23T13:00:00.000Z'),
      new Date('2026-12-26T13:00:00.000Z')
    );
  });

  it('passes the BARE expanded block to listConfirmedInRange — no CONSULTATION_LOAD_PAD_MS (UTC)', async () => {
    mockFindResolverSettings.mockResolvedValue(settings({ timezone: 'UTC' }));
    mockListConfirmedInRange.mockResolvedValue([]);

    await findOverrideConflicts({
      expertProfileId: EXPERT_ID,
      userId: USER_ID,
      startDate: '2026-12-24',
      endDate: '2026-12-26',
      now: new Date('2026-08-20T00:00:00.000Z'),
    });

    expect(mockListConfirmedInRange).toHaveBeenCalledWith(
      EXPERT_ID,
      new Date('2026-12-24T00:00:00.000Z'),
      new Date('2026-12-27T00:00:00.000Z')
    );
  });

  it('clamps rangeStart forward to `now` when the block starts today', async () => {
    mockFindResolverSettings.mockResolvedValue(settings({ timezone: 'UTC' }));
    mockListConfirmedInRange.mockResolvedValue([]);
    const now = new Date('2026-12-24T05:00:00.000Z');

    await findOverrideConflicts({
      expertProfileId: EXPERT_ID,
      userId: USER_ID,
      startDate: '2026-12-24',
      endDate: '2026-12-24',
      now,
    });

    expect(mockListConfirmedInRange).toHaveBeenCalledWith(
      EXPERT_ID,
      now,
      new Date('2026-12-25T00:00:00.000Z')
    );
  });

  it('short-circuits to zero conflicts with NO query for an all-past block', async () => {
    mockFindResolverSettings.mockResolvedValue(settings({ timezone: 'UTC' }));

    const result = await findOverrideConflicts({
      expertProfileId: EXPERT_ID,
      userId: USER_ID,
      startDate: '2026-01-01',
      endDate: '2026-01-01',
      now: new Date('2026-08-20T00:00:00.000Z'),
    });

    expect(result).toEqual({
      outcome: 'ok',
      timezone: 'UTC',
      conflictCount: 0,
      truncated: false,
      conflicts: [],
    });
    expect(mockListConfirmedInRange).not.toHaveBeenCalled();
  });

  it('sorts unsorted rows ascending by startAt, ties broken by id', async () => {
    mockFindResolverSettings.mockResolvedValue(settings({ timezone: 'UTC' }));
    mockListConfirmedInRange.mockResolvedValue([
      consultation('b', '2026-12-25T10:00:00.000Z', '2026-12-25T11:00:00.000Z'),
      consultation('a', '2026-12-24T09:00:00.000Z', '2026-12-24T10:00:00.000Z'),
      consultation('z', '2026-12-24T09:00:00.000Z', '2026-12-24T10:00:00.000Z'),
    ]);
    mockResolveCompanies.mockResolvedValue(new Map());

    const result = await findOverrideConflicts({
      expertProfileId: EXPERT_ID,
      userId: USER_ID,
      startDate: '2026-12-24',
      endDate: '2026-12-26',
      now: new Date('2026-08-20T00:00:00.000Z'),
    });

    if (result.outcome !== 'ok') throw new Error('expected ok outcome');
    expect(result.conflicts.map((c) => c.consultationId)).toEqual(['a', 'z', 'b']);
  });

  it('caps detail rows at CONFLICT_DETAIL_LIMIT and reports truncated + exact conflictCount', async () => {
    mockFindResolverSettings.mockResolvedValue(settings({ timezone: 'UTC' }));
    // Each row's startAt is 10 MINUTES apart (never wrapping across the 25 rows), so every
    // row has a distinct startAt and the id-based tie-break never has to run — the slice
    // returned by the service therefore matches this array's own insertion order.
    const rows = Array.from({ length: 25 }, (_, i) => {
      const minutes = i * 10;
      const start = new Date(Date.UTC(2026, 11, 24, 0, minutes));
      const end = new Date(start.getTime() + 5 * 60 * 1000);
      return consultation(
        `c${i.toString().padStart(2, '0')}`,
        start.toISOString(),
        end.toISOString()
      );
    });
    mockListConfirmedInRange.mockResolvedValue(rows);
    mockResolveCompanies.mockResolvedValue(new Map());

    const result = await findOverrideConflicts({
      expertProfileId: EXPERT_ID,
      userId: USER_ID,
      startDate: '2026-12-24',
      endDate: '2026-12-26',
      now: new Date('2026-08-20T00:00:00.000Z'),
    });

    if (result.outcome !== 'ok') throw new Error('expected ok outcome');
    expect(result.conflictCount).toBe(25);
    expect(result.conflicts).toHaveLength(CONFLICT_DETAIL_LIMIT);
    expect(result.truncated).toBe(true);
    expect(mockResolveCompanies).toHaveBeenCalledWith(
      expect.arrayContaining(rows.slice(0, CONFLICT_DETAIL_LIMIT).map((r) => r.meetingId)),
      // S2 — the expert containment term is threaded through, not dropped.
      EXPERT_ID
    );
    expect((mockResolveCompanies.mock.calls[0]?.[0] as string[]).length).toBe(
      CONFLICT_DETAIL_LIMIT
    );
  });

  it('renders clientCompanyName null for a meeting missing from the company map', async () => {
    mockFindResolverSettings.mockResolvedValue(settings({ timezone: 'UTC' }));
    mockListConfirmedInRange.mockResolvedValue([
      consultation('a', '2026-12-24T09:00:00.000Z', '2026-12-24T10:00:00.000Z', 'meeting-a'),
    ]);
    mockResolveCompanies.mockResolvedValue(new Map());

    const result = await findOverrideConflicts({
      expertProfileId: EXPERT_ID,
      userId: USER_ID,
      startDate: '2026-12-24',
      endDate: '2026-12-26',
      now: new Date('2026-08-20T00:00:00.000Z'),
    });

    if (result.outcome !== 'ok') throw new Error('expected ok outcome');
    expect(result.conflicts).toEqual([
      {
        consultationId: 'a',
        startAt: new Date('2026-12-24T09:00:00.000Z'),
        endAt: new Date('2026-12-24T10:00:00.000Z'),
        clientCompanyName: null,
      },
    ]);
  });

  it('renders the resolved clientCompanyName when present in the company map', async () => {
    mockFindResolverSettings.mockResolvedValue(settings({ timezone: 'UTC' }));
    mockListConfirmedInRange.mockResolvedValue([
      consultation('a', '2026-12-24T09:00:00.000Z', '2026-12-24T10:00:00.000Z', 'meeting-a'),
    ]);
    mockResolveCompanies.mockResolvedValue(
      new Map([['meeting-a', { companyId: 'co-1', companyName: 'Northwind Industrial' }]])
    );

    const result = await findOverrideConflicts({
      expertProfileId: EXPERT_ID,
      userId: USER_ID,
      startDate: '2026-12-24',
      endDate: '2026-12-26',
      now: new Date('2026-08-20T00:00:00.000Z'),
    });

    if (result.outcome !== 'ok') throw new Error('expected ok outcome');
    expect(result.conflicts[0]?.clientCompanyName).toBe('Northwind Industrial');
    // S2 — the expert containment term is threaded through, not dropped.
    expect(mockResolveCompanies).toHaveBeenCalledWith(['meeting-a'], EXPERT_ID);
  });

  it('DST — a block spanning the Australia/Sydney transition expands to a non-24h day', async () => {
    // Sydney enters DST (AEST → AEDT) on the first Sunday of October — 2026-10-04. The
    // override starting `2026-10-04` therefore spans a 23-hour local day.
    mockFindResolverSettings.mockResolvedValue(settings({ timezone: 'Australia/Sydney' }));
    mockListConfirmedInRange.mockResolvedValue([]);

    await findOverrideConflicts({
      expertProfileId: EXPERT_ID,
      userId: USER_ID,
      startDate: '2026-10-04',
      endDate: '2026-10-04',
      now: new Date('2026-08-20T00:00:00.000Z'),
    });

    const [, calledStart, calledEnd] = mockListConfirmedInRange.mock.calls[0] as [
      string,
      Date,
      Date,
    ];
    const hours = (calledEnd.getTime() - calledStart.getTime()) / (60 * 60 * 1000);
    expect(hours).toBe(23);
  });
});
