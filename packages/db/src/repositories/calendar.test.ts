import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

const DIALECT = new PgDialect();

// ── Hoisted mocks ────────────────────────────────────────────────

const {
  mockReturning,
  mockWhere,
  mockSet,
  mockValues,
  mockOnConflictDoUpdate,
  mockTransaction,
  mockFindFirst,
  mockFindMany,
} = vi.hoisted(() => ({
  mockReturning: vi.fn(),
  mockWhere: vi.fn(),
  mockSet: vi.fn(),
  mockValues: vi.fn(),
  mockOnConflictDoUpdate: vi.fn(),
  mockTransaction: vi.fn(),
  mockFindFirst: vi.fn(),
  mockFindMany: vi.fn(),
}));

function setupUpdateChain() {
  mockWhere.mockResolvedValue(undefined);
  mockSet.mockReturnValue({ where: mockWhere });
}

function setupDeleteChain() {
  mockWhere.mockResolvedValue(undefined);
}

vi.mock('../client', () => ({
  db: {
    query: {
      calendarConnections: {
        findFirst: (...args: unknown[]) => mockFindFirst(...args),
        findMany: (...args: unknown[]) => mockFindMany(...args),
      },
      calendarSubCalendars: {
        findFirst: (...args: unknown[]) => mockFindFirst(...args),
        findMany: (...args: unknown[]) => mockFindMany(...args),
      },
    },
    insert: (..._args: unknown[]) => ({
      values: (...vArgs: unknown[]) => {
        mockValues(...vArgs);
        return {
          onConflictDoUpdate: (...oArgs: unknown[]) => {
            mockOnConflictDoUpdate(...oArgs);
            return { returning: mockReturning };
          },
          returning: mockReturning,
        };
      },
    }),
    update: (..._args: unknown[]) => ({
      set: (...sArgs: unknown[]) => {
        mockSet(...sArgs);
        return {
          where: (...wArgs: unknown[]) => {
            mockWhere(...wArgs);
            return undefined;
          },
        };
      },
    }),
    delete: (..._args: unknown[]) => ({
      where: (...wArgs: unknown[]) => {
        mockWhere(...wArgs);
        return undefined;
      },
    }),
    transaction: (...args: unknown[]) => mockTransaction(...args),
  },
}));

import { calendarRepository } from './calendar';

// ── Tests ──────────────────────────────────────────────────────

describe('calendarRepository', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('findConnectionByExpertProfileId', () => {
    it('returns connection when found', async () => {
      const mockConn = { id: 'conn-1', expertProfileId: 'ep-1', credentialStatus: 'ACTIVE' };
      mockFindFirst.mockResolvedValue(mockConn);

      const result = await calendarRepository.findConnectionByExpertProfileId('ep-1');

      expect(result).toEqual(mockConn);
      expect(mockFindFirst).toHaveBeenCalled();
    });

    it('returns undefined when not found', async () => {
      mockFindFirst.mockResolvedValue(undefined);

      const result = await calendarRepository.findConnectionByExpertProfileId('ep-none');

      expect(result).toBeUndefined();
    });
  });

  describe('upsertApirocConnection', () => {
    /**
     * ⚠ THIS SUITE CANNOT PROVE THE ARBITER WORKS — it mocks the whole Drizzle client, so
     * `onConflictDoUpdate` only records its argument and never reaches a Postgres planner.
     * A wrong arbiter raises 42P10 at PLAN time and this file stays green. The behavioural
     * proof lives in `calendar.integration.test.ts`. What IS worth pinning here is the
     * SHAPE of the argument, cheaply and with no Docker.
     */
    it('inserts or upserts and returns the connection', async () => {
      const mockConn = { id: 'conn-1', expertProfileId: 'ep-1' };
      mockReturning.mockReturnValue([mockConn]);

      const result = await calendarRepository.upsertApirocConnection({
        expertProfileId: 'ep-1',
        provider: 'google',
        endUserAccountId: 'eua-1',
      });

      expect(result).toEqual(mockConn);
      expect(mockValues).toHaveBeenCalledWith(
        expect.objectContaining({
          expertProfileId: 'ep-1',
          provider: 'google',
          endUserAccountId: 'eua-1',
          // Absent `credentialStatus` must mean ACTIVE at the WRITE, not "let the column
          // default decide" — the default is a schema fact this method must not depend on.
          credentialStatus: 'ACTIVE',
        })
      );
    });

    it('writes NONE of the Cronofy identity columns — an Apiroc row stores a pointer, not tokens', async () => {
      mockReturning.mockReturnValue([{ id: 'conn-1' }]);

      await calendarRepository.upsertApirocConnection({
        expertProfileId: 'ep-1',
        provider: 'microsoft',
        endUserAccountId: 'eua-2',
      });

      const [values] = mockValues.mock.calls[0] as [Record<string, unknown>];
      for (const column of ['cronofySub', 'accessToken', 'refreshToken', 'tokenExpiresAt']) {
        expect(values).not.toHaveProperty(column);
      }
    });

    it('carries an explicit SYNC_PENDING through to the write', async () => {
      mockReturning.mockReturnValue([{ id: 'conn-1' }]);

      await calendarRepository.upsertApirocConnection({
        expertProfileId: 'ep-1',
        provider: 'google',
        endUserAccountId: 'eua-1',
        credentialStatus: 'SYNC_PENDING',
      });

      expect(mockValues).toHaveBeenCalledWith(
        expect.objectContaining({ credentialStatus: 'SYNC_PENDING' })
      );
    });

    it('arbits on (expert_profile_id, provider) and restates the partial predicate as targetWhere', async () => {
      mockReturning.mockReturnValue([{ id: 'conn-1' }]);

      await calendarRepository.upsertApirocConnection({
        expertProfileId: 'ep-1',
        provider: 'google',
        endUserAccountId: 'eua-1',
      });

      const [config] = mockOnConflictDoUpdate.mock.calls[0] as [
        { target: { name: string }[]; targetWhere?: unknown; set: Record<string, unknown> },
      ];

      // BAL-467 dropped `cal_conn_expert_profile_idx`. An arbiter naming expertProfileId
      // alone no longer matches ANY index.
      expect(config.target.map((column) => column.name)).toEqual(['expert_profile_id', 'provider']);
      // The arbiter index is PARTIAL; without targetWhere, Postgres cannot infer it.
      expect(config.targetWhere).toBeDefined();
      // `provider` is half the arbiter, so the conflicting row already holds this value —
      // re-assigning it in the update arm would be meaningless.
      expect(config.set).not.toHaveProperty('provider');
    });

    /**
     * ⚠ THE ONE-LINE REGRESSION THAT WOULD SILENCE EVERY SECOND BREAKAGE. Without
     * `reconnectNotifiedAt: null` in the update arm, an expert who reconnects keeps the
     * stale marker, and the notify-once check then suppresses the email for the NEXT
     * breakage — forever. Nothing else in the suite can see that.
     */
    it('CLEARS reconnectNotifiedAt in the update arm, and stamps the credential as checked', async () => {
      mockReturning.mockReturnValue([{ id: 'conn-1' }]);

      await calendarRepository.upsertApirocConnection({
        expertProfileId: 'ep-1',
        provider: 'google',
        endUserAccountId: 'eua-1',
      });

      const [config] = mockOnConflictDoUpdate.mock.calls[0] as [{ set: Record<string, unknown> }];
      expect(config.set.reconnectNotifiedAt).toBeNull();
      expect(config.set.credentialCheckedAt).toBeInstanceOf(Date);
      // Reconnecting a LIVE row must not leave it soft-deleted.
      expect(config.set.deletedAt).toBeNull();
    });
  });

  describe('findConnectionByExpertAndProvider', () => {
    it('returns the connection for that (expert, provider) pair', async () => {
      const mockConn = { id: 'conn-1', provider: 'microsoft' };
      mockFindFirst.mockResolvedValue(mockConn);

      expect(
        await calendarRepository.findConnectionByExpertAndProvider('ep-1', 'microsoft')
      ).toEqual(mockConn);
    });

    it('returns undefined when that provider is not connected', async () => {
      mockFindFirst.mockResolvedValue(undefined);

      expect(
        await calendarRepository.findConnectionByExpertAndProvider('ep-1', 'google')
      ).toBeUndefined();
    });
  });

  describe('listConnectionsByExpertProfileId', () => {
    it('returns every live connection the expert holds', async () => {
      const conns = [{ provider: 'google' }, { provider: 'microsoft' }];
      mockFindMany.mockResolvedValue(conns);

      expect(await calendarRepository.listConnectionsByExpertProfileId('ep-1')).toEqual(conns);
    });

    it('returns an empty array when the expert has connected nothing', async () => {
      mockFindMany.mockResolvedValue([]);

      expect(await calendarRepository.listConnectionsByExpertProfileId('ep-1')).toEqual([]);
    });
  });

  describe('findConnectionsByEndUserAccountId', () => {
    it('returns EVERY connection on that Apiroc End User Account', async () => {
      // Plural by design: cal_conn_end_user_account_idx is deliberately non-unique.
      const conns = [{ expertProfileId: 'ep-1' }, { expertProfileId: 'ep-2' }];
      mockFindMany.mockResolvedValue(conns);

      expect(await calendarRepository.findConnectionsByEndUserAccountId('eua-1')).toEqual(conns);
    });
  });

  describe('updateTargetCalendarIdForProvider', () => {
    it('sets the target calendar for one provider only', async () => {
      setupUpdateChain();

      await calendarRepository.updateTargetCalendarIdForProvider('ep-1', 'google', 'cal-1');

      expect(mockSet).toHaveBeenCalledWith(expect.objectContaining({ targetCalendarId: 'cal-1' }));
    });
  });

  describe('softDeleteConnectionForProvider', () => {
    it('sets deletedAt for one provider only', async () => {
      setupUpdateChain();

      await calendarRepository.softDeleteConnectionForProvider('ep-1', 'google');

      expect(mockSet).toHaveBeenCalledWith(
        expect.objectContaining({ deletedAt: expect.any(Date) })
      );
    });
  });

  describe('setCredentialStatusForProvider', () => {
    it('writes the credential status for one provider', async () => {
      setupUpdateChain();

      await calendarRepository.setCredentialStatusForProvider('ep-1', 'google', 'EXPIRED');

      expect(mockSet).toHaveBeenCalledWith(
        expect.objectContaining({ credentialStatus: 'EXPIRED' })
      );
    });

    /**
     * ⚠ THE REASON THIS METHOD EXISTS. The deleted `updateConnectionStatus` fan-out scoped
     * by `expertProfileId` ALONE, so one provider's EXPIRED branded the other provider's
     * connection broken — and, via the fail-closed booking gate, made the expert unbookable
     * on a healthy calendar. Asserts the WHERE argument itself, not merely that `.where()`
     * was called.
     */
    it('scopes the WHERE clause on provider, not merely expertProfileId', async () => {
      setupUpdateChain();

      await calendarRepository.setCredentialStatusForProvider('ep-1', 'microsoft', 'REVOKED');

      expect(mockWhere).toHaveBeenCalled();
      const [condition] = mockWhere.mock.calls[0] ?? [];
      const rendered = DIALECT.sqlToQuery(condition as Parameters<PgDialect['sqlToQuery']>[0]).sql;
      expect(rendered).toContain('"provider"');
      expect(rendered).toContain('"expert_profile_id"');
      expect(rendered).toContain('"deleted_at" is null');
    });

    it('clears reconnectNotifiedAt when the status goes back to ACTIVE, and only then', async () => {
      setupUpdateChain();
      await calendarRepository.setCredentialStatusForProvider('ep-1', 'google', 'ACTIVE');
      expect(mockSet).toHaveBeenCalledWith(
        expect.objectContaining({ credentialStatus: 'ACTIVE', reconnectNotifiedAt: null })
      );

      vi.clearAllMocks();
      setupUpdateChain();
      await calendarRepository.setCredentialStatusForProvider('ep-1', 'google', 'EXPIRED');
      const [written] = mockSet.mock.calls[0] as [Record<string, unknown>];
      // A non-ACTIVE write must LEAVE the marker alone — overwriting it is what would make
      // the notify-once check meaningless.
      expect(written).not.toHaveProperty('reconnectNotifiedAt');
    });
  });

  describe('setCredentialStatus', () => {
    it('is keyed by connection id and guards soft deletes', async () => {
      setupUpdateChain();

      await calendarRepository.setCredentialStatus('conn-1', 'EXPIRED');

      expect(mockSet).toHaveBeenCalledWith(
        expect.objectContaining({ credentialStatus: 'EXPIRED' })
      );
      const [condition] = mockWhere.mock.calls[0] ?? [];
      const rendered = DIALECT.sqlToQuery(condition as Parameters<PgDialect['sqlToQuery']>[0]).sql;
      expect(rendered).toContain('"id"');
      expect(rendered).toContain('"deleted_at" is null');
    });

    it('clears reconnectNotifiedAt on the heal to ACTIVE — the invariant lives here, not at the call site', async () => {
      setupUpdateChain();

      await calendarRepository.setCredentialStatus('conn-1', 'ACTIVE');

      expect(mockSet).toHaveBeenCalledWith(
        expect.objectContaining({ credentialStatus: 'ACTIVE', reconnectNotifiedAt: null })
      );
    });
  });

  describe('markCredentialChecked', () => {
    it('stamps the caller-supplied instant, so one sweep tick stamps one instant', async () => {
      setupUpdateChain();
      const checkedAt = new Date('2026-08-18T10:00:00.000Z');

      await calendarRepository.markCredentialChecked('conn-1', checkedAt);

      expect(mockSet).toHaveBeenCalledWith(
        expect.objectContaining({ credentialCheckedAt: checkedAt })
      );
    });
  });

  describe('markReconnectNotified', () => {
    it('stamps the notification marker for one connection', async () => {
      setupUpdateChain();
      const notifiedAt = new Date('2026-08-18T10:05:00.000Z');

      await calendarRepository.markReconnectNotified('conn-1', notifiedAt);

      expect(mockSet).toHaveBeenCalledWith(
        expect.objectContaining({ reconnectNotifiedAt: notifiedAt })
      );
    });
  });

  describe('updateLastSyncedAt', () => {
    it('updates lastSyncedAt timestamp', async () => {
      setupUpdateChain();

      await calendarRepository.updateLastSyncedAt('conn-1');

      expect(mockSet).toHaveBeenCalled();
    });
  });

  describe('softDeleteConnection', () => {
    it('sets deletedAt timestamp', async () => {
      setupUpdateChain();

      await calendarRepository.softDeleteConnection('ep-1');

      expect(mockSet).toHaveBeenCalledWith(
        expect.objectContaining({
          deletedAt: expect.any(Date),
        })
      );
    });
  });

  describe('findStaleConnections', () => {
    it('returns stale connections', async () => {
      const stale = [{ id: 'conn-1', credentialStatus: 'ACTIVE' }];
      mockFindMany.mockResolvedValue(stale);

      const result = await calendarRepository.findStaleConnections(new Date());

      expect(result).toEqual(stale);
    });

    /**
     * ⚠ THE OBJECTION-1 REGRESSION, AS FAR AS A MOCKED SUITE CAN SEE IT. The old filter read
     * `eq(status, 'connected')`. A rename WITHOUT the typed column would have left that
     * literal compiling and matching zero rows forever, with the 15-minute staleness cron
     * reporting nothing wrong. `.$type<CalendarCredentialStatus>()` makes the stale literal a
     * `tsc` error; this asserts the RENDERED filter names the new column and the new value,
     * which is the part a type cannot pin. The real-Postgres proof is in the integration suite.
     */
    it('filters on credential_status = ACTIVE — not the retired `status`/`connected` pair', async () => {
      mockFindMany.mockResolvedValue([]);

      await calendarRepository.findStaleConnections(new Date('2026-08-18T00:00:00.000Z'));

      const [args] = mockFindMany.mock.calls[0] as [{ where: unknown }];
      const query = DIALECT.sqlToQuery(args.where as Parameters<PgDialect['sqlToQuery']>[0]);
      expect(query.sql).toContain('"credential_status"');
      expect(query.sql).not.toContain('"status"');
      expect(query.params).toContain('ACTIVE');
      expect(query.params).not.toContain('connected');
    });

    /**
     * ⚠⚠ THE BAL-396 FIX-ROUND REGRESSION TEST. The filter used to read
     * `lt(last_synced_at, threshold)`, and `last_synced_at`'s only writer was the deleted
     * Cronofy webhook route — so it is NULL forever, `lt(NULL, threshold)` is NULL (not
     * true), and the query returned `[]` on EVERY tick, permanently. Repointing at
     * `credential_checked_at` restores a real signal (stamped by the health probe and by
     * connect/reconnect); this asserts the RENDERED filter names the new column, which a
     * mocked suite can see even though it cannot prove the behaviour end to end (that is
     * `calendar.integration.test.ts`'s job).
     */
    it('filters on credential_checked_at, NOT the dead-forever last_synced_at column', async () => {
      mockFindMany.mockResolvedValue([]);

      await calendarRepository.findStaleConnections(new Date('2026-08-18T00:00:00.000Z'));

      const [args] = mockFindMany.mock.calls[0] as [{ where: unknown }];
      const query = DIALECT.sqlToQuery(args.where as Parameters<PgDialect['sqlToQuery']>[0]);
      expect(query.sql).toContain('"credential_checked_at"');
      expect(query.sql).not.toContain('"last_synced_at"');
      // A NEVER-CHECKED connection (NULL) must match immediately, not wait out a threshold.
      expect(query.sql).toContain('"credential_checked_at" is null');
    });
  });

  describe('listConnectionsDueForHealthCheck', () => {
    it('bounds the batch, and treats a NULL check time as never-checked', async () => {
      const due = [{ id: 'conn-1' }];
      mockFindMany.mockResolvedValue(due);

      const result = await calendarRepository.listConnectionsDueForHealthCheck(
        new Date('2026-08-18T09:00:00.000Z'),
        100
      );

      expect(result).toEqual(due);
      const [args] = mockFindMany.mock.calls[0] as [{ where: unknown; limit: number }];
      expect(args.limit).toBe(100);
      const rendered = DIALECT.sqlToQuery(args.where as Parameters<PgDialect['sqlToQuery']>[0]).sql;
      // Never-checked rows must be candidates, not skipped — a connection that has NEVER been
      // proven is the one most in need of proving.
      expect(rendered).toContain('"credential_checked_at" is null');
      expect(rendered).toContain('"deleted_at" is null');
    });

    /**
     * ⚠ `end_user_account_id IS NOT NULL` is GONE — migration 0069 made the column
     * `NOT NULL`, so the predicate was vacuous (always true), never protective.
     */
    it('does NOT filter on end_user_account_id — the column is NOT NULL since migration 0069', async () => {
      mockFindMany.mockResolvedValue([]);

      await calendarRepository.listConnectionsDueForHealthCheck(new Date(), 10);

      const [args] = mockFindMany.mock.calls[0] as [{ where: unknown }];
      const rendered = DIALECT.sqlToQuery(args.where as Parameters<PgDialect['sqlToQuery']>[0]).sql;
      expect(rendered).not.toContain('end_user_account_id');
    });

    it('does NOT filter by credential status — the probe is also the healer', async () => {
      mockFindMany.mockResolvedValue([]);

      await calendarRepository.listConnectionsDueForHealthCheck(new Date(), 10);

      const [args] = mockFindMany.mock.calls[0] as [{ where: unknown }];
      const query = DIALECT.sqlToQuery(args.where as Parameters<PgDialect['sqlToQuery']>[0]);
      // Filtering to ACTIVE here would make every broken connection permanently broken:
      // nothing would ever re-probe a SYNC_PENDING or EXPIRED row to find it working again.
      expect(query.sql).not.toContain('"credential_status"');
      expect(query.params).not.toContain('ACTIVE');
    });
  });

  describe('listBusyReadTargets', () => {
    it('keeps ONLY conflict-checked calendar ids, and reports provisioned from row presence', async () => {
      mockFindMany.mockResolvedValue([
        {
          id: 'conn-1',
          provider: 'google',
          endUserAccountId: 'eua-1',
          credentialStatus: 'ACTIVE',
          subCalendars: [
            { calendarId: 'cal-work', conflictCheck: true },
            { calendarId: 'cal-personal', conflictCheck: false },
          ],
        },
      ]);

      expect(await calendarRepository.listBusyReadTargets('ep-1')).toEqual([
        {
          connectionId: 'conn-1',
          provider: 'google',
          endUserAccountId: 'eua-1',
          credentialStatus: 'ACTIVE',
          calendarIds: ['cal-work'],
          provisioned: true,
        },
      ]);
    });

    /**
     * ⚠ TWO DIFFERENT EMPTY ANSWERS, AND CONFLATING THEM IS A DOUBLE-BOOKING. `calendarIds:
     * []` with `provisioned: true` is the expert's explicit choice to conflict-check nothing;
     * `provisioned: false` is "Balo never listed this account's calendars", which the booking
     * gate must fail CLOSED on.
     */
    it('distinguishes "conflict-checks nothing" from "never provisioned"', async () => {
      mockFindMany.mockResolvedValue([
        {
          id: 'conn-optout',
          provider: 'google',
          endUserAccountId: 'eua-1',
          credentialStatus: 'ACTIVE',
          subCalendars: [{ calendarId: 'cal-personal', conflictCheck: false }],
        },
        {
          id: 'conn-unprovisioned',
          provider: 'microsoft',
          endUserAccountId: 'eua-2',
          credentialStatus: 'SYNC_PENDING',
          subCalendars: [],
        },
      ]);

      const targets = await calendarRepository.listBusyReadTargets('ep-1');

      expect(targets[0]).toMatchObject({ calendarIds: [], provisioned: true });
      expect(targets[1]).toMatchObject({ calendarIds: [], provisioned: false });
    });

    /**
     * ⚠ NON-ACTIVE CONNECTIONS MUST COME BACK. Dropping them here would hand the booking
     * gate an empty list, which it reads as "this expert has no external calendar" — failing
     * OPEN and double-booking an expert in front of a paying client.
     */
    it('returns EXPIRED and REVOKED targets too, so the caller can fail closed', async () => {
      mockFindMany.mockResolvedValue([
        {
          id: 'conn-expired',
          provider: 'google',
          endUserAccountId: 'eua-1',
          credentialStatus: 'EXPIRED',
          subCalendars: [{ calendarId: 'cal-work', conflictCheck: true }],
        },
        {
          id: 'conn-revoked',
          provider: 'microsoft',
          endUserAccountId: 'eua-2',
          credentialStatus: 'REVOKED',
          subCalendars: [{ calendarId: 'cal-team', conflictCheck: true }],
        },
      ]);

      expect(
        (await calendarRepository.listBusyReadTargets('ep-1')).map(
          (target) => target.credentialStatus
        )
      ).toEqual(['EXPIRED', 'REVOKED']);
    });

    it('projects no token column into the hydration — the SELECT names four columns', async () => {
      mockFindMany.mockResolvedValue([]);

      expect(await calendarRepository.listBusyReadTargets('ep-1')).toEqual([]);

      const [args] = mockFindMany.mock.calls[0] as [{ columns: Record<string, boolean> }];
      expect(Object.keys(args.columns).sort()).toEqual([
        'credentialStatus',
        'endUserAccountId',
        'id',
        'provider',
      ]);
    });
  });

  describe('findSubCalendarsByConnectionId', () => {
    it('returns sub-calendars for a connection', async () => {
      const subs = [{ calendarId: 'cal-1', name: 'Primary' }];
      mockFindMany.mockResolvedValue(subs);

      const result = await calendarRepository.findSubCalendarsByConnectionId('conn-1');

      expect(result).toEqual(subs);
    });
  });

  describe('replaceSubCalendars', () => {
    it('runs transaction to delete and insert sub-calendars', async () => {
      const txDeleteWhere = vi.fn();
      const txInsertValues = vi.fn();
      const mockTx = {
        delete: () => ({ where: txDeleteWhere }),
        insert: () => ({ values: txInsertValues }),
      };
      mockTransaction.mockImplementation(async (fn: (tx: typeof mockTx) => Promise<void>) => {
        await fn(mockTx);
      });

      await calendarRepository.replaceSubCalendars('conn-1', [
        {
          calendarId: 'cal-1',
          name: 'Primary',
          provider: 'google',
          isPrimary: true,
          conflictCheck: true,
        },
      ]);

      expect(mockTransaction).toHaveBeenCalled();
      expect(txDeleteWhere).toHaveBeenCalled();
      expect(txInsertValues).toHaveBeenCalled();
    });

    it('only deletes when calendars array is empty', async () => {
      const txDeleteWhere = vi.fn();
      const txInsertValues = vi.fn();
      const mockTx = {
        delete: () => ({ where: txDeleteWhere }),
        insert: () => ({ values: txInsertValues }),
      };
      mockTransaction.mockImplementation(async (fn: (tx: typeof mockTx) => Promise<void>) => {
        await fn(mockTx);
      });

      await calendarRepository.replaceSubCalendars('conn-1', []);

      expect(txDeleteWhere).toHaveBeenCalled();
      expect(txInsertValues).not.toHaveBeenCalled();
    });
  });

  describe('updateConflictCheck', () => {
    it('updates conflictCheck for a sub-calendar', async () => {
      setupUpdateChain();

      await calendarRepository.updateConflictCheck('conn-1', 'cal-1', true);

      expect(mockSet).toHaveBeenCalledWith(expect.objectContaining({ conflictCheck: true }));
    });
  });

  describe('findSubCalendarByCalendarId', () => {
    it('returns specific sub-calendar', async () => {
      const sub = { calendarId: 'cal-1', name: 'Primary', isPrimary: true };
      mockFindFirst.mockResolvedValue(sub);

      const result = await calendarRepository.findSubCalendarByCalendarId('conn-1', 'cal-1');

      expect(result).toEqual(sub);
    });
  });

  describe('deleteSubCalendarsByConnectionId', () => {
    it('deletes all sub-calendars for a connection', async () => {
      setupDeleteChain();

      await calendarRepository.deleteSubCalendarsByConnectionId('conn-1');

      expect(mockWhere).toHaveBeenCalled();
    });
  });

  describe('upsertAvailabilityCache', () => {
    it('upserts availability cache', async () => {
      mockReturning.mockReturnValue([]);

      await calendarRepository.upsertAvailabilityCache('ep-1', new Date());

      expect(mockValues).toHaveBeenCalled();
    });
  });

  describe('clearAvailabilityCache', () => {
    it('clears availability cache (sets earliestAvailableAt to null)', async () => {
      mockReturning.mockReturnValue([]);

      await calendarRepository.clearAvailabilityCache('ep-1');

      expect(mockValues).toHaveBeenCalled();
    });
  });
});
