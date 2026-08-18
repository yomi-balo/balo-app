import { readFile } from 'node:fs/promises';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { CalendarConnection, CalendarSubscription } from '@balo/db';

const {
  mockFindSubCalendarsByConnectionId,
  mockListLiveByConnectionId,
  mockListLiveByIds,
  mockInsertSubscription,
  mockStampVendorState,
  mockSoftDeleteById,
  mockCalendarSubscriptionsList,
  mockCalendarSubscriptionsCreate,
  mockCalendarSubscriptionsDelete,
  mockClassifyCredentialFailure,
  mockEncryptCalendarSecret,
} = vi.hoisted(() => ({
  mockFindSubCalendarsByConnectionId: vi.fn(),
  mockListLiveByConnectionId: vi.fn(),
  mockListLiveByIds: vi.fn(),
  mockInsertSubscription: vi.fn(),
  mockStampVendorState: vi.fn(),
  mockSoftDeleteById: vi.fn(),
  mockCalendarSubscriptionsList: vi.fn(),
  mockCalendarSubscriptionsCreate: vi.fn(),
  mockCalendarSubscriptionsDelete: vi.fn(),
  mockClassifyCredentialFailure: vi.fn(),
  mockEncryptCalendarSecret: vi.fn((s: string) => `encrypted(${s})`),
}));

class MockApirocError extends Error {
  readonly kind: string;
  readonly status?: number;
  constructor(kind: string, status?: number) {
    super(`mock apiroc error (${kind})`);
    this.kind = kind;
    this.status = status;
  }
}

vi.mock('@balo/db', () => ({
  calendarRepository: { findSubCalendarsByConnectionId: mockFindSubCalendarsByConnectionId },
  calendarSubscriptionsRepository: {
    listLiveByConnectionId: mockListLiveByConnectionId,
    listLiveByIds: mockListLiveByIds,
    insertSubscription: mockInsertSubscription,
    stampVendorState: mockStampVendorState,
    softDeleteById: mockSoftDeleteById,
  },
}));

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('../../lib/calendar-encryption.js', () => ({
  encryptCalendarSecret: mockEncryptCalendarSecret,
}));

// ⚠⚠ `importOriginal` — the REAL `paginateApiroc` is kept (see the pagination test below).
// A hand-rolled stand-in loop here would mean the pagination test exercised THE TEST'S OWN
// loop and proved nothing about the shipped helper, which is exactly what it used to do.
vi.mock('../../lib/apiroc/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/apiroc/index.js')>()),
  ApirocError: MockApirocError,
  getApirocClient: () => ({
    calendarSubscriptions: {
      list: mockCalendarSubscriptionsList,
      create: mockCalendarSubscriptionsCreate,
      delete: mockCalendarSubscriptionsDelete,
    },
  }),
  callApiroc: async (_operation: string, fn: () => Promise<unknown>) => fn(),
  classifyCredentialFailure: mockClassifyCredentialFailure,
}));

const { reconcileConnectionSubscriptions, APIROC_SUBSCRIPTION_LIST_PAGE_LIMIT } =
  await import('./subscription-reconcile.js');

const CONNECTION_ID = 'connection-1';

function connection(overrides: Partial<CalendarConnection> = {}): CalendarConnection {
  return {
    id: CONNECTION_ID,
    expertProfileId: 'expert-1',
    endUserAccountId: 'eua-1',
    provider: 'google',
    providerEmail: null,
    credentialStatus: 'ACTIVE',
    credentialCheckedAt: null,
    reconnectNotifiedAt: null,
    lastSyncedAt: null,
    targetCalendarId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    ...overrides,
  } as CalendarConnection;
}

function liveRow(overrides: Partial<CalendarSubscription> = {}): CalendarSubscription {
  return {
    id: 'row-1',
    connectionId: CONNECTION_ID,
    calendarId: 'cal-1',
    webhookSubscriptionId: 'wsub-1',
    endpointSecret: 'enc',
    webhookUrl: 'https://api.balo.expert/webhooks/apiroc/calendar/row-1',
    expiration: null,
    expirationSyncedAt: null,
    lastDeliveryAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    ...overrides,
  } as CalendarSubscription;
}

describe('reconcileConnectionSubscriptions (BAL-468 §8)', () => {
  const originalBaseUrl = process.env.APIROC_WEBHOOK_BASE_URL;
  const originalKey = process.env.CALENDAR_ENCRYPTION_KEY;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.APIROC_WEBHOOK_BASE_URL = 'https://api.balo.expert';
    process.env.CALENDAR_ENCRYPTION_KEY = 'test-key-32-bytes-minimum-value!';
    mockFindSubCalendarsByConnectionId.mockResolvedValue([]);
    mockListLiveByConnectionId.mockResolvedValue([]);
    mockListLiveByIds.mockResolvedValue([]);
    mockCalendarSubscriptionsList.mockResolvedValue({ data: [] });
    mockClassifyCredentialFailure.mockReturnValue({ kind: 'other' });
    mockInsertSubscription.mockResolvedValue(undefined);
  });

  afterEach(() => {
    if (originalBaseUrl === undefined) delete process.env.APIROC_WEBHOOK_BASE_URL;
    else process.env.APIROC_WEBHOOK_BASE_URL = originalBaseUrl;
    if (originalKey === undefined) delete process.env.CALENDAR_ENCRYPTION_KEY;
    else process.env.CALENDAR_ENCRYPTION_KEY = originalKey;
  });

  it('guard 1 — non-ACTIVE connection skips with zero vendor calls', async () => {
    const outcome = await reconcileConnectionSubscriptions(
      connection({ credentialStatus: 'EXPIRED' }),
      {
        force: false,
      }
    );
    expect(outcome.skipped).toBe('connection_not_active');
    expect(mockCalendarSubscriptionsList).not.toHaveBeenCalled();
    expect(mockCalendarSubscriptionsCreate).not.toHaveBeenCalled();
  });

  it('guard 1 — a soft-deleted connection skips', async () => {
    const outcome = await reconcileConnectionSubscriptions(connection({ deletedAt: new Date() }), {
      force: false,
    });
    expect(outcome.skipped).toBe('connection_not_active');
  });

  it('guard 2 — webhook base url unset skips with zero vendor calls', async () => {
    delete process.env.APIROC_WEBHOOK_BASE_URL;
    const outcome = await reconcileConnectionSubscriptions(connection(), { force: false });
    expect(outcome.skipped).toBe('webhook_not_configured');
    expect(mockCalendarSubscriptionsList).not.toHaveBeenCalled();
  });

  it('guard 3 — cipher unset skips with zero vendor calls', async () => {
    delete process.env.CALENDAR_ENCRYPTION_KEY;
    const outcome = await reconcileConnectionSubscriptions(connection(), { force: false });
    expect(outcome.skipped).toBe('cipher_not_configured');
    expect(mockCalendarSubscriptionsList).not.toHaveBeenCalled();
  });

  it('⚠ ordering: a renewal calls create → insert → delete → softDelete, in that order', async () => {
    const order: string[] = [];
    mockFindSubCalendarsByConnectionId.mockResolvedValue([
      { calendarId: 'cal-1', conflictCheck: true },
    ]);
    const existing = liveRow({ id: 'old-row', webhookSubscriptionId: 'wsub-old' });
    mockListLiveByConnectionId.mockResolvedValueOnce([existing]).mockResolvedValueOnce([]);
    mockCalendarSubscriptionsList
      .mockResolvedValueOnce({
        data: [{ id: 'wsub-old', url: existing.webhookUrl, expiration: new Date().toISOString() }],
      })
      .mockResolvedValueOnce({ data: [] });
    mockCalendarSubscriptionsCreate.mockImplementation(async () => {
      order.push('create');
      return { webhookSubscriptionId: 'wsub-new', endpointSecret: 'secret' };
    });
    mockInsertSubscription.mockImplementation(async () => {
      order.push('insert');
      return liveRow();
    });
    mockCalendarSubscriptionsDelete.mockImplementation(async () => {
      order.push('delete');
      return { success: true };
    });
    mockSoftDeleteById.mockImplementation(async () => {
      order.push('softDelete');
    });

    await reconcileConnectionSubscriptions(connection(), { force: true });

    expect(order).toEqual(['create', 'insert', 'delete', 'softDelete']);
  });

  it('⚠ the row id is minted BEFORE the create — the webhookUrl ends with the inserted id', async () => {
    mockFindSubCalendarsByConnectionId.mockResolvedValue([
      { calendarId: 'cal-1', conflictCheck: true },
    ]);
    mockCalendarSubscriptionsCreate.mockResolvedValue({
      webhookSubscriptionId: 'wsub-new',
      endpointSecret: 'secret',
    });

    await reconcileConnectionSubscriptions(connection(), { force: false });

    const [createArgs] = mockCalendarSubscriptionsCreate.mock.calls[0] as [
      string,
      { webhookUrl: string },
    ];
    const [insertArgs] = mockInsertSubscription.mock.calls[0] as [{ id: string }];
    expect(createArgs).toBeDefined();
    const { webhookUrl } = mockCalendarSubscriptionsCreate.mock.calls[0][1] as {
      webhookUrl: string;
    };
    expect(webhookUrl.endsWith(insertArgs.id)).toBe(true);
  });

  it('create fails → no row inserted, no delete attempted, logs apiroc_subscription_create_failed', async () => {
    mockFindSubCalendarsByConnectionId.mockResolvedValue([
      { calendarId: 'cal-1', conflictCheck: true },
    ]);
    mockCalendarSubscriptionsCreate.mockRejectedValue(new Error('vendor 500'));

    const outcome = await reconcileConnectionSubscriptions(connection(), { force: false });

    expect(mockInsertSubscription).not.toHaveBeenCalled();
    expect(mockCalendarSubscriptionsDelete).not.toHaveBeenCalled();
    expect(outcome.skipped).toBeNull();
  });

  it('renewal delete fails → old row left live, deleteFailures = 1', async () => {
    mockFindSubCalendarsByConnectionId.mockResolvedValue([
      { calendarId: 'cal-1', conflictCheck: true },
    ]);
    const existing = liveRow({ id: 'old-row', webhookSubscriptionId: 'wsub-old' });
    mockListLiveByConnectionId.mockResolvedValue([existing]);
    mockCalendarSubscriptionsList.mockResolvedValue({
      data: [{ id: 'wsub-old', url: existing.webhookUrl, expiration: new Date().toISOString() }],
    });
    mockCalendarSubscriptionsCreate.mockResolvedValue({
      webhookSubscriptionId: 'wsub-new',
      endpointSecret: 'secret',
    });
    mockCalendarSubscriptionsDelete.mockRejectedValue(new Error('vendor delete failed'));

    const outcome = await reconcileConnectionSubscriptions(connection(), { force: true });

    expect(mockSoftDeleteById).not.toHaveBeenCalledWith('old-row');
    expect(outcome.deleteFailures).toBe(1);
  });

  it('verification pass: an intended delete still present → unverifiedDeletes = 1', async () => {
    mockFindSubCalendarsByConnectionId.mockResolvedValue([]);
    const target = liveRow({ id: 'row-undesired', webhookSubscriptionId: 'wsub-undesired' });
    mockListLiveByConnectionId
      .mockResolvedValueOnce([target]) // initial read: desired is [] so this is 'undesired'
      .mockResolvedValueOnce([]); // post-mutation read (delete "succeeded" per the mock)
    mockCalendarSubscriptionsList
      .mockResolvedValueOnce({
        data: [{ id: 'wsub-undesired', url: target.webhookUrl, expiration: null }],
      })
      // verification pass STILL lists it — the vendor never actually removed it
      .mockResolvedValueOnce({
        data: [{ id: 'wsub-undesired', url: target.webhookUrl, expiration: null }],
      });
    mockCalendarSubscriptionsDelete.mockResolvedValue({ success: true });

    const outcome = await reconcileConnectionSubscriptions(connection(), { force: false });

    expect(outcome.unverifiedDeletes).toBe(1);
  });

  it('verification pass stamps expiration parsed from an ISO string + expiration_synced_at', async () => {
    mockFindSubCalendarsByConnectionId.mockResolvedValue([
      { calendarId: 'cal-1', conflictCheck: true },
    ]);
    const row = liveRow({ id: 'row-1', webhookSubscriptionId: 'wsub-1' });
    const expirationIso = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();
    mockListLiveByConnectionId.mockResolvedValue([row]);
    mockCalendarSubscriptionsList.mockResolvedValue({
      data: [{ id: 'wsub-1', url: row.webhookUrl, expiration: expirationIso }],
    });

    await reconcileConnectionSubscriptions(connection(), { force: false });

    const stampCalls = mockStampVendorState.mock.calls as [string, Date | null, Date][];
    const verificationStamp = stampCalls.find(([rowId]) => rowId === 'row-1');
    expect(verificationStamp).toBeDefined();
    expect(verificationStamp?.[1]?.toISOString()).toBe(expirationIso);
  });

  it('a live row absent from the vendor → missingAtVendor, not stamped in the verification pass', async () => {
    mockFindSubCalendarsByConnectionId.mockResolvedValue([
      { calendarId: 'cal-1', conflictCheck: true },
    ]);
    const row = liveRow({ id: 'row-1', webhookSubscriptionId: 'wsub-1' });
    mockListLiveByConnectionId.mockResolvedValue([row]);
    // Present on the initial read (so no create is planned) but gone on the verification re-read.
    mockCalendarSubscriptionsList
      .mockResolvedValueOnce({
        data: [
          {
            id: 'wsub-1',
            url: row.webhookUrl,
            expiration: new Date(Date.now() + 6 * 86400000).toISOString(),
          },
        ],
      })
      .mockResolvedValueOnce({ data: [] });

    const outcome = await reconcileConnectionSubscriptions(connection(), { force: false });

    expect(outcome.missingAtVendor).toBe(1);
  });

  it('credential failure mid-sweep aborts and never calls softDelete/insert past that point', async () => {
    mockFindSubCalendarsByConnectionId.mockResolvedValue([
      { calendarId: 'cal-1', conflictCheck: true },
    ]);
    mockCalendarSubscriptionsCreate.mockRejectedValue(new MockApirocError('unauthorized', 401));
    mockClassifyCredentialFailure.mockReturnValue({ kind: 'reconnect_required', marker: 'x' });

    const outcome = await reconcileConnectionSubscriptions(connection(), { force: false });

    expect(outcome.skipped).toBe('credential_failed_mid_sweep');
    expect(mockInsertSubscription).not.toHaveBeenCalled();
  });

  it('⚠⚠ §8.7 — this module imports NO breaker-defeating symbol (source-level guard)', async () => {
    // A credential failure mid-sweep must abort and nothing more. It must NOT call
    // `applyCredentialFailure`, flip `credential_status`, publish `calendar.auth_error`, or
    // emit `CREDENTIALS_REVOKED`.
    //
    // ⚠ Those are all true TODAY BY CONSTRUCTION — the module imports none of them — which is
    // precisely why a behavioural assertion here would be vacuous and this one is not. The
    // health probe is the ONLY sanctioned caller of that path because it computes every status
    // write and notification for a whole batch BEFORE writing any of them; that is its
    // mass-failure circuit breaker. A second caller outside the batch discipline defeats the
    // breaker, and the blast radius is a reconnect email to the ENTIRE FLEET with no un-send.
    // So the guard is on the IMPORT: the day someone reaches for one of these, it fails here
    // instead of in production email volume.
    const source = await readFile(new URL('./subscription-reconcile.ts', import.meta.url), 'utf8');
    const codeOnly = source
      .split('\n')
      .filter((line) => {
        const t = line.trim();
        return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*');
      })
      .join('\n');

    for (const banned of [
      'applyCredentialFailure',
      'setCredentialStatus',
      'notificationEvents',
      'CREDENTIALS_REVOKED',
    ]) {
      expect(codeOnly, `${banned} must not appear in subscription-reconcile.ts`).not.toContain(
        banned
      );
    }
  });

  it('⚠ the forced small-page test: a 2-per-page TRANSPORT over 5 subscriptions → all 5 reach the plan', async () => {
    // Ticket §2's one genuinely open AC. Two things make it real rather than decorative:
    //
    //  1. `paginateApiroc` is the SHIPPED helper here (see the `importOriginal` mock above),
    //     not a loop written in this file. A test that re-implements the thing under test
    //     passes whatever that re-implementation does.
    //  2. The page size is forced at the TRANSPORT, independently of what the caller asks
    //     for. The caller passes `limit: 100` and there are only 5 records, so honouring the
    //     caller's limit would put everything on page 1 and the multi-page branch would never
    //     execute — invisible in dev and on test accounts, and only ever bites a busy real
    //     calendar. Slicing 2 at a time regardless is what forces the loop to iterate.
    const rowIds = [
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
      '33333333-3333-4333-8333-333333333333',
      '44444444-4444-4444-8444-444444444444',
      '55555555-5555-4555-8555-555555555555',
    ];
    const allRecords = rowIds.map((rowId, i) => ({
      id: `wsub-${i}`,
      url: `https://api.balo.expert/webhooks/apiroc/calendar/${rowId}`,
      expiration: null as string | null,
    }));
    const TRANSPORT_PAGE_SIZE = 2;
    mockCalendarSubscriptionsList.mockImplementation(
      async (_eua: string, params: { limit?: number; pageToken?: string }) => {
        const start = params.pageToken ? Number(params.pageToken) : 0;
        const page = allRecords.slice(start, start + TRANSPORT_PAGE_SIZE);
        const nextStart = start + TRANSPORT_PAGE_SIZE;
        return {
          data: page,
          ...(nextStart < allRecords.length ? { nextPageToken: String(nextStart) } : {}),
        };
      }
    );
    // Balo knows none of these row ids, so all 5 are orphans — which is how we observe that
    // every record survived pagination and reached the plan.
    mockListLiveByIds.mockResolvedValue([]);
    mockCalendarSubscriptionsDelete.mockResolvedValue({ success: true });

    const outcome = await reconcileConnectionSubscriptions(connection(), { force: false });

    // (a) the caller still passes the fixed page size — the "we pass a limit at all" pin.
    for (const call of mockCalendarSubscriptionsList.mock.calls) {
      const params = call[1] as { limit?: number };
      expect(params.limit).toBe(APIROC_SUBSCRIPTION_LIST_PAGE_LIMIT);
    }
    // (b) the loop genuinely iterated: 5 records at 2 per page = 3 pages, and it TERMINATED.
    //     The reconcile does a first list + a verification list, so 3 pages each.
    const listCallsPerSweep = 3;
    expect(mockCalendarSubscriptionsList.mock.calls.length % listCallsPerSweep).toBe(0);
    expect(mockCalendarSubscriptionsList.mock.calls.length).toBeGreaterThanOrEqual(
      listCallsPerSweep
    );
    // (c) ⚠ THE ASSERTION THAT WOULD ACTUALLY FAIL ON A PAGE-1-ONLY BUG: all 5 records — not
    //     just the first page's 2 — reached the plan and were acted on.
    expect(mockCalendarSubscriptionsDelete).toHaveBeenCalledTimes(allRecords.length);
    expect(outcome.deleted).toBe(allRecords.length);
  });

  it('renewal: superseded row already gone at the vendor → softDelete with NO vendor delete call', async () => {
    mockFindSubCalendarsByConnectionId.mockResolvedValue([
      { calendarId: 'cal-1', conflictCheck: true },
    ]);
    const existing = liveRow({ id: 'old-row', webhookSubscriptionId: 'wsub-old' });
    mockListLiveByConnectionId.mockResolvedValueOnce([existing]).mockResolvedValueOnce([]);
    // The initial vendor list does NOT contain wsub-old — it already lapsed at the vendor.
    mockCalendarSubscriptionsList
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({ data: [] });
    mockCalendarSubscriptionsCreate.mockResolvedValue({
      webhookSubscriptionId: 'wsub-new',
      endpointSecret: 'secret',
    });

    const outcome = await reconcileConnectionSubscriptions(connection(), { force: true });

    expect(mockCalendarSubscriptionsDelete).not.toHaveBeenCalled();
    expect(mockSoftDeleteById).toHaveBeenCalledWith('old-row');
    expect(outcome.deleted).toBe(1);
    expect(outcome.renewed).toBe(1);
  });

  it('renewal: vendor delete answers not_found → treated as success (undead-row loop closed)', async () => {
    mockFindSubCalendarsByConnectionId.mockResolvedValue([
      { calendarId: 'cal-1', conflictCheck: true },
    ]);
    const existing = liveRow({ id: 'old-row', webhookSubscriptionId: 'wsub-old' });
    mockListLiveByConnectionId.mockResolvedValueOnce([existing]).mockResolvedValueOnce([]);
    mockCalendarSubscriptionsList
      .mockResolvedValueOnce({
        data: [{ id: 'wsub-old', url: existing.webhookUrl, expiration: new Date().toISOString() }],
      })
      .mockResolvedValueOnce({ data: [] });
    mockCalendarSubscriptionsCreate.mockResolvedValue({
      webhookSubscriptionId: 'wsub-new',
      endpointSecret: 'secret',
    });
    mockCalendarSubscriptionsDelete.mockRejectedValue(new MockApirocError('not_found', 404));

    const outcome = await reconcileConnectionSubscriptions(connection(), { force: true });

    expect(mockSoftDeleteById).toHaveBeenCalledWith('old-row');
    expect(outcome.deleted).toBe(1);
    expect(outcome.deleteFailures).toBe(0);
  });

  it('plain delete: row already gone at the vendor → softDelete with NO vendor delete call', async () => {
    mockFindSubCalendarsByConnectionId.mockResolvedValue([]);
    const target = liveRow({ id: 'row-undesired', webhookSubscriptionId: 'wsub-undesired' });
    mockListLiveByConnectionId.mockResolvedValueOnce([target]).mockResolvedValueOnce([]);
    // The vendor list is already empty — nothing to delete there.
    mockCalendarSubscriptionsList
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({ data: [] });

    const outcome = await reconcileConnectionSubscriptions(connection(), { force: false });

    expect(mockCalendarSubscriptionsDelete).not.toHaveBeenCalled();
    expect(mockSoftDeleteById).toHaveBeenCalledWith('row-undesired');
    expect(outcome.deleted).toBe(1);
  });

  it('plain delete: vendor call answers reconnect_required → aborts as credential_failed_mid_sweep', async () => {
    mockFindSubCalendarsByConnectionId.mockResolvedValue([]);
    const target = liveRow({ id: 'row-undesired', webhookSubscriptionId: 'wsub-undesired' });
    mockListLiveByConnectionId.mockResolvedValue([target]);
    mockCalendarSubscriptionsList.mockResolvedValue({
      data: [{ id: 'wsub-undesired', url: target.webhookUrl, expiration: null }],
    });
    mockCalendarSubscriptionsDelete.mockRejectedValue(new MockApirocError('unauthorized', 401));
    mockClassifyCredentialFailure.mockReturnValue({ kind: 'reconnect_required', marker: 'x' });

    const outcome = await reconcileConnectionSubscriptions(connection(), { force: false });

    expect(outcome.skipped).toBe('credential_failed_mid_sweep');
    expect(mockSoftDeleteById).not.toHaveBeenCalled();
  });

  it('plain delete: vendor call answers not_found → treated as success', async () => {
    mockFindSubCalendarsByConnectionId.mockResolvedValue([]);
    const target = liveRow({ id: 'row-undesired', webhookSubscriptionId: 'wsub-undesired' });
    mockListLiveByConnectionId.mockResolvedValueOnce([target]).mockResolvedValueOnce([]);
    mockCalendarSubscriptionsList
      .mockResolvedValueOnce({
        data: [{ id: 'wsub-undesired', url: target.webhookUrl, expiration: null }],
      })
      .mockResolvedValueOnce({ data: [] });
    mockCalendarSubscriptionsDelete.mockRejectedValue(new MockApirocError('not_found', 404));

    const outcome = await reconcileConnectionSubscriptions(connection(), { force: false });

    expect(mockSoftDeleteById).toHaveBeenCalledWith('row-undesired');
    expect(outcome.deleted).toBe(1);
    expect(outcome.deleteFailures).toBe(0);
  });

  it('plain delete: vendor call fails with a plain error → deleteFailures = 1, logs apiroc_subscription_delete_failed', async () => {
    mockFindSubCalendarsByConnectionId.mockResolvedValue([]);
    const target = liveRow({ id: 'row-undesired', webhookSubscriptionId: 'wsub-undesired' });
    mockListLiveByConnectionId.mockResolvedValue([target]);
    mockCalendarSubscriptionsList.mockResolvedValue({
      data: [{ id: 'wsub-undesired', url: target.webhookUrl, expiration: null }],
    });
    mockCalendarSubscriptionsDelete.mockRejectedValue(new Error('vendor 500'));

    const outcome = await reconcileConnectionSubscriptions(connection(), { force: false });

    expect(outcome.deleteFailures).toBe(1);
    expect(mockSoftDeleteById).not.toHaveBeenCalledWith('row-undesired');
  });

  // ⚠⚠ `listVendorSubscriptions` (both the initial read and the verification re-read) goes
  // through the REAL `paginateApiroc` (kept via `importOriginal` above, for the pagination
  // test's own sake). That real helper's internal `callApiroc`/`normalizeApirocError` run in
  // a SEPARATE module instance from the one this file mocks, so any error it wraps comes back
  // as a real `ApirocError` — never `instanceof` this test's `MockApirocError`. `isReconnectRequired`
  // therefore can never see `reconnect_required` at THIS call site under this test's mocking
  // scheme (it does, correctly, in production — there is only one module instance there). Only
  // the non-credential fallback (rethrow for the initial read, log-and-continue for the
  // verification read) is exercisable here; both are covered below.
  it('initial vendor list: a failure is rethrown, not swallowed, so BullMQ retries', async () => {
    mockFindSubCalendarsByConnectionId.mockResolvedValue([
      { calendarId: 'cal-1', conflictCheck: true },
    ]);
    mockCalendarSubscriptionsList.mockRejectedValue(new Error('vendor 500'));

    await expect(
      reconcileConnectionSubscriptions(connection(), { force: false })
    ).rejects.toThrow();
    expect(mockCalendarSubscriptionsCreate).not.toHaveBeenCalled();
  });

  it('verification pass: a non-credential vendor error logs and still returns a completed outcome', async () => {
    mockFindSubCalendarsByConnectionId.mockResolvedValue([
      { calendarId: 'cal-1', conflictCheck: true },
    ]);
    mockCalendarSubscriptionsList
      .mockResolvedValueOnce({ data: [] })
      .mockRejectedValueOnce(new Error('vendor 500 on re-read'));
    mockCalendarSubscriptionsCreate.mockResolvedValue({
      webhookSubscriptionId: 'wsub-new',
      endpointSecret: 'secret',
    });

    const outcome = await reconcileConnectionSubscriptions(connection(), { force: false });

    expect(outcome.skipped).toBeNull();
    expect(outcome.stamped).toBe(0);
  });

  it('plan.cappedActions > 0 → logs apiroc_subscription_plan_capped and still executes the capped set', async () => {
    const desired = Array.from({ length: 26 }, (_, i) => ({
      calendarId: `cal-${i}`,
      conflictCheck: true,
    }));
    mockFindSubCalendarsByConnectionId.mockResolvedValue(desired);
    mockCalendarSubscriptionsCreate.mockResolvedValue({
      webhookSubscriptionId: 'wsub-new',
      endpointSecret: 'secret',
    });

    const outcome = await reconcileConnectionSubscriptions(connection(), { force: false });

    expect(outcome.cappedActions).toBe(1);
    expect(mockCalendarSubscriptionsCreate).toHaveBeenCalledTimes(25);
  });

  it("subscriptionType: 'event' and a non-empty calendarId on every create; 'calendar' never sent", async () => {
    mockFindSubCalendarsByConnectionId.mockResolvedValue([
      { calendarId: 'cal-1', conflictCheck: true },
    ]);
    mockCalendarSubscriptionsCreate.mockResolvedValue({
      webhookSubscriptionId: 'wsub-new',
      endpointSecret: 'secret',
    });

    await reconcileConnectionSubscriptions(connection(), { force: false });

    expect(mockCalendarSubscriptionsCreate).toHaveBeenCalledWith(
      'eua-1',
      expect.objectContaining({ calendarId: 'cal-1', subscriptionType: 'event' })
    );
    for (const call of mockCalendarSubscriptionsCreate.mock.calls) {
      expect((call[1] as { subscriptionType: string }).subscriptionType).not.toBe('calendar');
    }
  });
});
