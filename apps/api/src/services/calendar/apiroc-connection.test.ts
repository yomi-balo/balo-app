import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockUpsertApirocConnection,
  mockSetCredentialStatusForProvider,
  mockReplaceSubCalendars,
  mockUpdateTargetCalendarIdForProvider,
  mockFindConnectionByExpertAndProvider,
  mockFindSubCalendarsByConnectionId,
  mockDeleteSubCalendarsByConnectionId,
  mockSoftDeleteConnectionForProvider,
  mockClearAvailabilityCache,
  mockCalendarsList,
  mockEndUserAccountsDelete,
  mockLog,
} = vi.hoisted(() => ({
  mockUpsertApirocConnection: vi.fn(),
  mockSetCredentialStatusForProvider: vi.fn(),
  mockReplaceSubCalendars: vi.fn(),
  mockUpdateTargetCalendarIdForProvider: vi.fn(),
  mockFindConnectionByExpertAndProvider: vi.fn(),
  mockFindSubCalendarsByConnectionId: vi.fn(),
  mockDeleteSubCalendarsByConnectionId: vi.fn(),
  mockSoftDeleteConnectionForProvider: vi.fn(),
  mockClearAvailabilityCache: vi.fn(),
  mockCalendarsList: vi.fn(),
  mockEndUserAccountsDelete: vi.fn(),
  mockLog: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@balo/db', () => ({
  calendarRepository: {
    upsertApirocConnection: mockUpsertApirocConnection,
    setCredentialStatusForProvider: mockSetCredentialStatusForProvider,
    replaceSubCalendars: mockReplaceSubCalendars,
    updateTargetCalendarIdForProvider: mockUpdateTargetCalendarIdForProvider,
    findConnectionByExpertAndProvider: mockFindConnectionByExpertAndProvider,
    findSubCalendarsByConnectionId: mockFindSubCalendarsByConnectionId,
    deleteSubCalendarsByConnectionId: mockDeleteSubCalendarsByConnectionId,
    softDeleteConnectionForProvider: mockSoftDeleteConnectionForProvider,
    clearAvailabilityCache: mockClearAvailabilityCache,
  },
}));

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => mockLog,
}));

vi.mock('../../lib/apiroc/index.js', () => ({
  getApirocClient: () => ({
    calendars: { list: mockCalendarsList },
    endUserAccounts: { delete: mockEndUserAccountsDelete },
  }),
  callApiroc: async (_operation: string, fn: () => Promise<unknown>) => fn(),
  paginateApiroc: async (
    _operation: string,
    fetchPage: (
      pageToken: string | undefined
    ) => Promise<{ data: unknown[]; nextPageToken?: string }>
  ) => {
    const results: unknown[] = [];
    let pageToken: string | undefined;
    for (;;) {
      const page = await fetchPage(pageToken);
      results.push(...page.data);
      if (!page.nextPageToken) break;
      pageToken = page.nextPageToken;
    }
    return results;
  },
}));

const { persistApirocConnection, provisionConnection, disconnectProvider } =
  await import('./apiroc-connection.js');

import type { CalendarConnection } from '@balo/db';

function buildConnection(overrides: Partial<CalendarConnection> = {}): CalendarConnection {
  return {
    id: 'conn-1',
    expertProfileId: 'expert-1',
    provider: 'exp-provider-a',
    endUserAccountId: 'eua-1',
    providerEmail: 'dana@example.com',
    targetCalendarId: null,
    credentialStatus: 'ACTIVE',
    reconnectNotifiedAt: null,
    credentialCheckedAt: null,
    lastSyncedAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    deletedAt: null,
    ...overrides,
  };
}

describe('persistApirocConnection', () => {
  beforeEach(() => vi.clearAllMocks());

  it('delegates to calendarRepository.upsertApirocConnection with no token fields', async () => {
    mockUpsertApirocConnection.mockResolvedValue(buildConnection());
    const result = await persistApirocConnection({
      expertProfileId: 'expert-1',
      provider: 'exp-provider-a',
      endUserAccountId: 'eua-1',
    });
    expect(mockUpsertApirocConnection).toHaveBeenCalledWith({
      expertProfileId: 'expert-1',
      provider: 'exp-provider-a',
      endUserAccountId: 'eua-1',
    });
    expect(result.id).toBe('conn-1');
  });
});

describe('provisionConnection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no existing sub-calendar rows — matches "first provisioning" for every test
    // that doesn't explicitly care about conflict-check preservation across a reconnect.
    mockFindSubCalendarsByConnectionId.mockResolvedValue([]);
  });

  it('lists, stores writable calendars, defaults the target to primary, and returns ACTIVE', async () => {
    mockCalendarsList.mockResolvedValue({
      data: [
        { id: 'cal-primary', name: 'Primary', isPrimary: true, readOnly: false },
        { id: 'cal-secondary', name: 'Secondary', isPrimary: false, readOnly: false },
        { id: 'cal-readonly', name: 'Holidays', isPrimary: false, readOnly: true },
      ],
    });

    const connection = buildConnection();
    const status = await provisionConnection(connection);

    expect(status).toBe('ACTIVE');
    expect(mockReplaceSubCalendars).toHaveBeenCalledWith('conn-1', [
      expect.objectContaining({ calendarId: 'cal-primary', isPrimary: true, conflictCheck: true }),
      expect.objectContaining({
        calendarId: 'cal-secondary',
        isPrimary: false,
        conflictCheck: false,
      }),
    ]);
    // Read-only calendar excluded entirely.
    const [, storedCalendars] = mockReplaceSubCalendars.mock.calls[0] as [string, unknown[]];
    expect(storedCalendars).toHaveLength(2);

    expect(mockUpdateTargetCalendarIdForProvider).toHaveBeenCalledWith(
      'expert-1',
      'exp-provider-a',
      'cal-primary'
    );
    expect(mockSetCredentialStatusForProvider).toHaveBeenCalledWith(
      'expert-1',
      'exp-provider-a',
      'ACTIVE'
    );
    expect(mockClearAvailabilityCache).not.toHaveBeenCalled();
  });

  it('treats an OMITTED isPrimary the same as an explicit false (provider-parity guard)', async () => {
    mockCalendarsList.mockResolvedValue({
      data: [{ id: 'cal-a', name: 'A', readOnly: false }], // isPrimary omitted entirely
    });

    await provisionConnection(buildConnection());

    expect(mockReplaceSubCalendars).toHaveBeenCalledWith('conn-1', [
      expect.objectContaining({ calendarId: 'cal-a', isPrimary: false, conflictCheck: false }),
    ]);
    // No primary found ⇒ no target calendar write.
    expect(mockUpdateTargetCalendarIdForProvider).not.toHaveBeenCalled();
  });

  it('paginates to exhaustion, following nextPageToken across multiple pages', async () => {
    mockCalendarsList
      .mockResolvedValueOnce({
        data: [{ id: 'cal-1', name: 'One', isPrimary: true, readOnly: false }],
        nextPageToken: 'page-2',
      })
      .mockResolvedValueOnce({
        data: [{ id: 'cal-2', name: 'Two', isPrimary: false, readOnly: false }],
        nextPageToken: 'page-3',
      })
      .mockResolvedValueOnce({ data: [] }); // Microsoft's trailing empty page — no nextPageToken

    await provisionConnection(buildConnection());

    expect(mockCalendarsList).toHaveBeenCalledTimes(3);
    expect(mockCalendarsList).toHaveBeenNthCalledWith(1, 'eua-1', undefined);
    expect(mockCalendarsList).toHaveBeenNthCalledWith(2, 'eua-1', { pageToken: 'page-2' });
    expect(mockCalendarsList).toHaveBeenNthCalledWith(3, 'eua-1', { pageToken: 'page-3' });
    const [, storedCalendars] = mockReplaceSubCalendars.mock.calls[0] as [string, unknown[]];
    expect(storedCalendars).toHaveLength(2);
  });

  it('never clobbers an already-set target calendar on re-provision (the probe heal path)', async () => {
    mockCalendarsList.mockResolvedValue({
      data: [{ id: 'cal-primary', name: 'Primary', isPrimary: true, readOnly: false }],
    });

    await provisionConnection(buildConnection({ targetCalendarId: 'cal-already-chosen' }));

    expect(mockUpdateTargetCalendarIdForProvider).not.toHaveBeenCalled();
  });

  it('a calendars.list failure persists SYNC_PENDING and stores nothing', async () => {
    mockCalendarsList.mockRejectedValue(new Error('network timeout'));

    const status = await provisionConnection(buildConnection());

    expect(status).toBe('SYNC_PENDING');
    expect(mockReplaceSubCalendars).not.toHaveBeenCalled();
    expect(mockUpdateTargetCalendarIdForProvider).not.toHaveBeenCalled();
    expect(mockSetCredentialStatusForProvider).toHaveBeenCalledWith(
      'expert-1',
      'exp-provider-a',
      'SYNC_PENDING'
    );
    // ⚠ round-2 fix #6 — without this, `earliest_available_at` keeps its stale pre-breakage
    // value and the expert stays advertised as available while every booking 409s.
    expect(mockClearAvailabilityCache).toHaveBeenCalledWith('expert-1');
  });

  /**
   * ⚠⚠ BAL-396 FIX ROUND — THE ABSORBING-STATE REGRESSION TEST. A `calendars.list` SUCCESS
   * with zero writable calendars (empty 200, or every calendar `readOnly`) used to still
   * persist `ACTIVE`: `replaceSubCalendars(id, [])` wipes every sub-calendar row,
   * `listBusyReadTargets` then reports `provisioned: false`, and the booking gate fails
   * CLOSED forever with no recovery path (the probe only re-provisions a non-ACTIVE
   * connection). `SYNC_PENDING` keeps this connection inside that heal path instead.
   *
   * ⚠⚠ ROUND-2 FIX #4 — this branch must NOT call `replaceSubCalendars` at all. Wiping the
   * rows here means a single TRANSIENT zero-writable response destroys exactly the
   * conflict-check preferences round 1 set out to preserve; the next successful
   * re-provision would then see `existing = []` and reset everything to primary-only.
   */
  it('a calendars.list SUCCESS with ZERO writable calendars persists SYNC_PENDING, not ACTIVE, and does NOT touch sub-calendar rows', async () => {
    mockCalendarsList.mockResolvedValue({
      data: [{ id: 'cal-readonly', name: 'Holidays', isPrimary: true, readOnly: true }],
    });

    const status = await provisionConnection(buildConnection());

    expect(status).toBe('SYNC_PENDING');
    expect(mockReplaceSubCalendars).not.toHaveBeenCalled();
    expect(mockUpdateTargetCalendarIdForProvider).not.toHaveBeenCalled();
    expect(mockSetCredentialStatusForProvider).toHaveBeenCalledWith(
      'expert-1',
      'exp-provider-a',
      'SYNC_PENDING'
    );
    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: 'conn-1' }),
      'apiroc_connection_provisioning_incomplete'
    );
    expect(mockClearAvailabilityCache).toHaveBeenCalledWith('expert-1');
  });

  it('a calendars.list SUCCESS with ZERO calendars listed at all ALSO persists SYNC_PENDING, and does NOT touch sub-calendar rows', async () => {
    mockCalendarsList.mockResolvedValue({ data: [] });

    const status = await provisionConnection(buildConnection());

    expect(status).toBe('SYNC_PENDING');
    expect(mockReplaceSubCalendars).not.toHaveBeenCalled();
    expect(mockSetCredentialStatusForProvider).toHaveBeenCalledWith(
      'expert-1',
      'exp-provider-a',
      'SYNC_PENDING'
    );
    expect(mockClearAvailabilityCache).toHaveBeenCalledWith('expert-1');
  });

  it('round-2 fix #4 — a TRANSIENT zero-writable response leaves an existing sub-calendar’s conflict-check row completely untouched (never wiped)', async () => {
    // This connection was previously provisioned with a real, conflict-checked calendar —
    // `findSubCalendarsByConnectionId` still has the row. `calendars.list` now transiently
    // returns nothing writable (e.g. a flaky page). Round 1's `replaceSubCalendars(id, [])`
    // would have destroyed that row here; round 2 must not touch it at all.
    mockFindSubCalendarsByConnectionId.mockResolvedValue([
      { calendarId: 'cal-work', conflictCheck: true },
    ]);
    mockCalendarsList.mockResolvedValue({ data: [] });

    const status = await provisionConnection(buildConnection());

    expect(status).toBe('SYNC_PENDING');
    expect(mockReplaceSubCalendars).not.toHaveBeenCalled();
  });

  /**
   * ⚠⚠ BAL-396 FIX ROUND — RECONNECT MUST NOT SILENTLY DESTROY THE EXPERT'S CONFLICT-CHECK
   * CHOICES. `provisionConnection` runs on EVERY OAuth reconnect callback, and
   * `replaceSubCalendars` deletes-then-inserts — so writing `conflictCheck: cal.isPrimary`
   * unconditionally reverted any calendar the expert had opted into or out of
   * conflict-checking, on every reconnect.
   *
   * ⚠⚠ ROUND-2 FIX #3 — round 1's preservation had NO PRIMARY FLOOR. `routes/calendar/
   * api.ts:281` refuses to let an expert disable conflict-checking on a PRIMARY calendar,
   * because `listBusyReadTargets` filters on this flag and a primary excluded from free/busy
   * makes the expert's real commitments invisible to the booking gate. A calendar that was
   * OFF while non-primary and later BECOMES primary at the provider must have that choice
   * OVERRIDDEN on re-provision, not preserved — preserving it would silently and
   * indefinitely violate `api.ts:281`'s invariant. So this test now asserts the opposite of
   * its original pin for `cal-primary`: `conflictCheck: true`, always, because it is
   * primary — while `cal-secondary`, which is NOT primary, still keeps its preserved choice.
   */
  it('floors conflictCheck to true for the PRIMARY calendar even if the expert had it off, and still preserves a non-primary calendar’s choice', async () => {
    // The expert previously turned conflict-checking OFF for what is NOW the primary
    // calendar (e.g. it became primary at the provider after that choice was made), and ON
    // for the non-primary secondary calendar.
    mockFindSubCalendarsByConnectionId.mockResolvedValue([
      { calendarId: 'cal-primary', conflictCheck: false },
      { calendarId: 'cal-secondary', conflictCheck: true },
    ]);
    mockCalendarsList.mockResolvedValue({
      data: [
        { id: 'cal-primary', name: 'Primary', isPrimary: true, readOnly: false },
        { id: 'cal-secondary', name: 'Secondary', isPrimary: false, readOnly: false },
      ],
    });

    await provisionConnection(buildConnection());

    expect(mockReplaceSubCalendars).toHaveBeenCalledWith('conn-1', [
      // The primary-calendar floor (api.ts:281) wins over the expert's stored preference.
      expect.objectContaining({ calendarId: 'cal-primary', conflictCheck: true }),
      // The expert had turned this ON despite it not being primary — that choice survives.
      expect.objectContaining({ calendarId: 'cal-secondary', conflictCheck: true }),
    ]);
  });

  it('round-2 fix #3 — a non-primary calendar the expert turned OFF still keeps that choice (the floor is primary-only)', async () => {
    mockFindSubCalendarsByConnectionId.mockResolvedValue([
      { calendarId: 'cal-primary', conflictCheck: true },
      { calendarId: 'cal-secondary', conflictCheck: false },
    ]);
    mockCalendarsList.mockResolvedValue({
      data: [
        { id: 'cal-primary', name: 'Primary', isPrimary: true, readOnly: false },
        { id: 'cal-secondary', name: 'Secondary', isPrimary: false, readOnly: false },
      ],
    });

    await provisionConnection(buildConnection());

    expect(mockReplaceSubCalendars).toHaveBeenCalledWith('conn-1', [
      expect.objectContaining({ calendarId: 'cal-primary', conflictCheck: true }),
      expect.objectContaining({ calendarId: 'cal-secondary', conflictCheck: false }),
    ]);
  });

  it('defaults a genuinely NEW calendar id to the primary-only rule, even on a re-provision', async () => {
    mockFindSubCalendarsByConnectionId.mockResolvedValue([
      { calendarId: 'cal-primary', conflictCheck: true },
    ]);
    mockCalendarsList.mockResolvedValue({
      data: [
        { id: 'cal-primary', name: 'Primary', isPrimary: true, readOnly: false },
        { id: 'cal-new', name: 'New', isPrimary: false, readOnly: false },
      ],
    });

    await provisionConnection(buildConnection());

    expect(mockReplaceSubCalendars).toHaveBeenCalledWith('conn-1', [
      expect.objectContaining({ calendarId: 'cal-primary', conflictCheck: true }),
      expect.objectContaining({ calendarId: 'cal-new', conflictCheck: false }),
    ]);
  });
});

describe('disconnectProvider', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns silently when no connection exists for this (expert, provider)', async () => {
    mockFindConnectionByExpertAndProvider.mockResolvedValue(undefined);
    await disconnectProvider('expert-1', 'exp-provider-a');
    expect(mockEndUserAccountsDelete).not.toHaveBeenCalled();
    expect(mockDeleteSubCalendarsByConnectionId).not.toHaveBeenCalled();
    expect(mockSoftDeleteConnectionForProvider).not.toHaveBeenCalled();
  });

  it('deletes the vendor account, sub-calendars, then soft-deletes, in order', async () => {
    mockFindConnectionByExpertAndProvider.mockResolvedValue(buildConnection());
    mockEndUserAccountsDelete.mockResolvedValue({ success: true });

    await disconnectProvider('expert-1', 'exp-provider-a');

    expect(mockEndUserAccountsDelete).toHaveBeenCalledWith('eua-1');
    expect(mockDeleteSubCalendarsByConnectionId).toHaveBeenCalledWith('conn-1');
    expect(mockSoftDeleteConnectionForProvider).toHaveBeenCalledWith('expert-1', 'exp-provider-a');
  });

  it('is best-effort on the vendor call: a failure still removes Balo-side state', async () => {
    mockFindConnectionByExpertAndProvider.mockResolvedValue(buildConnection());
    mockEndUserAccountsDelete.mockRejectedValue(new Error('vendor 500'));

    await disconnectProvider('expert-1', 'exp-provider-a');

    expect(mockDeleteSubCalendarsByConnectionId).toHaveBeenCalledWith('conn-1');
    expect(mockSoftDeleteConnectionForProvider).toHaveBeenCalledWith('expert-1', 'exp-provider-a');
    expect(mockLog.warn).toHaveBeenCalled();
  });
});
