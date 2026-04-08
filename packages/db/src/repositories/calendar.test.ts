import { describe, it, expect, vi, beforeEach } from 'vitest';

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
      const mockConn = { id: 'conn-1', expertProfileId: 'ep-1', status: 'connected' };
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

  describe('findConnectionByChannelId', () => {
    it('returns connection by channel ID', async () => {
      const mockConn = { id: 'conn-1', channelId: 'ch-1' };
      mockFindFirst.mockResolvedValue(mockConn);

      const result = await calendarRepository.findConnectionByChannelId('ch-1');

      expect(result).toEqual(mockConn);
    });
  });

  describe('upsertConnection', () => {
    it('inserts or upserts and returns the connection', async () => {
      const mockConn = { id: 'conn-1', expertProfileId: 'ep-1' };
      mockReturning.mockReturnValue([mockConn]);

      const result = await calendarRepository.upsertConnection({
        expertProfileId: 'ep-1',
        cronofySub: 'sub-1',
        provider: 'google',
        accessToken: 'enc-access',
        refreshToken: 'enc-refresh',
        tokenExpiresAt: new Date(),
        status: 'connected',
      });

      expect(result).toEqual(mockConn);
      expect(mockValues).toHaveBeenCalled();
    });
  });

  describe('updateConnectionTokens', () => {
    it('updates tokens and expiry', async () => {
      setupUpdateChain();

      await calendarRepository.updateConnectionTokens('ep-1', {
        accessToken: 'new-access',
        refreshToken: 'new-refresh',
        tokenExpiresAt: new Date(),
      });

      expect(mockSet).toHaveBeenCalled();
    });
  });

  describe('updateConnectionStatus', () => {
    it('updates status', async () => {
      setupUpdateChain();

      await calendarRepository.updateConnectionStatus('ep-1', 'auth_error');

      expect(mockSet).toHaveBeenCalledWith(expect.objectContaining({ status: 'auth_error' }));
    });
  });

  describe('updateConnectionChannelId', () => {
    it('updates channel ID', async () => {
      setupUpdateChain();

      await calendarRepository.updateConnectionChannelId('ep-1', 'ch-new');

      expect(mockSet).toHaveBeenCalledWith(expect.objectContaining({ channelId: 'ch-new' }));
    });
  });

  describe('updateLastSyncedAt', () => {
    it('updates lastSyncedAt timestamp', async () => {
      setupUpdateChain();

      await calendarRepository.updateLastSyncedAt('conn-1');

      expect(mockSet).toHaveBeenCalled();
    });
  });

  describe('updateTargetCalendarId', () => {
    it('updates target calendar ID', async () => {
      setupUpdateChain();

      await calendarRepository.updateTargetCalendarId('ep-1', 'cal-1');

      expect(mockSet).toHaveBeenCalledWith(expect.objectContaining({ targetCalendarId: 'cal-1' }));
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
      const stale = [{ id: 'conn-1', status: 'connected' }];
      mockFindMany.mockResolvedValue(stale);

      const result = await calendarRepository.findStaleConnections(new Date());

      expect(result).toEqual(stale);
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

  describe('findConnectionWithSubCalendars', () => {
    it('returns connection with sub-calendars included', async () => {
      const connWithSubs = {
        id: 'conn-1',
        expertProfileId: 'ep-1',
        subCalendars: [{ calendarId: 'cal-1' }],
      };
      mockFindFirst.mockResolvedValue(connWithSubs);

      const result = await calendarRepository.findConnectionWithSubCalendars('ep-1');

      expect(result).toEqual(connWithSubs);
    });
  });
});
