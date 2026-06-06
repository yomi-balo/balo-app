import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Constants ────────────────────────────────────────────────────

const USER_ID = 'a0000000-0000-4000-8000-000000000001';
const WORKOS_ID = 'user_workos_123';
const PROFILE_ID = 'b0000000-0000-4000-8000-000000000002';

// ── Mocks ────────────────────────────────────────────────────────

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

// `eq`/`and`/`inArray` are passed straight to the (mocked) query builder, so
// they just need to be callable; we don't assert on their output. Table tokens
// are referenced only by identity inside the action, so plain sentinels suffice.
// NOTE: factory is hoisted — keep all helpers inline (no outer-scope refs).
vi.mock('@balo/db', () => {
  const tableToken = (name: string): Record<string, string> => ({ __table: name });
  return {
    db: {
      select: (...a: unknown[]) => mockDbSelect(...a),
      transaction: (...a: unknown[]) => mockTransaction(...a),
    },
    users: tableToken('users'),
    expertProfiles: tableToken('expertProfiles'),
    expertCompetency: tableToken('expertCompetency'),
    expertCertifications: tableToken('expertCertifications'),
    expertLanguages: tableToken('expertLanguages'),
    expertIndustries: tableToken('expertIndustries'),
    workHistory: tableToken('workHistory'),
    companyMembers: tableToken('companyMembers'),
    companies: tableToken('companies'),
    agencyMembers: tableToken('agencyMembers'),
    meetingGuests: tableToken('meetingGuests'),
    eq: vi.fn((...a: unknown[]) => ({ op: 'eq', a })),
    and: vi.fn((...a: unknown[]) => ({ op: 'and', a })),
    inArray: vi.fn((...a: unknown[]) => ({ op: 'inArray', a })),
  };
});

const mockDeleteUser = vi.fn();
vi.mock('@/lib/auth/config', () => ({
  getWorkOS: () => ({ userManagement: { deleteUser: (...a: unknown[]) => mockDeleteUser(...a) } }),
}));

// Top-level db.select() — only used to fetch the user by id.
const mockDbSelect = vi.fn();
const mockTransaction = vi.fn();

import { deleteUserAction } from './delete-user';
import { revalidatePath } from 'next/cache';

// ── Helpers ──────────────────────────────────────────────────────

// Top-level `db.select().from().where().limit()` resolving to a user row.
function setupUserLookup(user: Record<string, unknown> | null): void {
  mockDbSelect.mockReturnValue({
    from: () => ({
      where: () => ({
        limit: () => Promise.resolve(user ? [user] : []),
      }),
    }),
  });
}

// Builds a chainable transaction client. The action issues two `tx.select(...)`
// reads (expert profiles, then personal companies) and many `tx.delete/update`
// terminal calls. We track delete/update so tests can assert children were
// cleaned up, and return the queued select results in call order.
interface TxRecorder {
  deletes: unknown[];
  updates: unknown[];
}

function makeTx(
  profileRows: { id: string }[],
  personalCompanyRows: { id: string }[]
): {
  tx: Record<string, unknown>;
  recorder: TxRecorder;
} {
  const recorder: TxRecorder = { deletes: [], updates: [] };
  const selectResults = [profileRows, personalCompanyRows];
  let selectIdx = 0;

  const tx = {
    select: () => ({
      from: () => {
        // Personal-company query chains .innerJoin().where(); the profile query
        // chains .where(). Support both by returning a thenable-ish chain.
        const result = selectResults[selectIdx] ?? [];
        selectIdx += 1;
        const chain = {
          innerJoin: () => chain,
          where: () => Promise.resolve(result),
        };
        return chain;
      },
    }),
    delete: (table: unknown) => ({
      where: () => {
        recorder.deletes.push(table);
        return Promise.resolve(undefined);
      },
    }),
    update: (table: unknown) => ({
      set: () => ({
        where: () => {
          recorder.updates.push(table);
          return Promise.resolve(undefined);
        },
      }),
    }),
  };

  return { tx, recorder };
}

function setupTransaction(
  profileRows: { id: string }[],
  personalCompanyRows: { id: string }[]
): TxRecorder {
  const { tx, recorder } = makeTx(profileRows, personalCompanyRows);
  mockTransaction.mockImplementation(async (cb: (tx: unknown) => Promise<void>) => {
    await cb(tx);
  });
  return recorder;
}

// ── Tests ────────────────────────────────────────────────────────

describe('deleteUserAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('NODE_ENV', 'development');
    mockDeleteUser.mockResolvedValue(undefined);
    setupUserLookup({ id: USER_ID, workosId: WORKOS_ID, email: 'test@example.com' });
    setupTransaction([{ id: PROFILE_ID }], []);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('production guard', () => {
    it('returns error when NODE_ENV is production', async () => {
      vi.stubEnv('NODE_ENV', 'production');
      const result = await deleteUserAction(USER_ID);
      expect(result).toEqual({ success: false, error: 'Not available in production.' });
      expect(mockTransaction).not.toHaveBeenCalled();
    });
  });

  describe('input validation', () => {
    it('returns error for a non-UUID user ID', async () => {
      const result = await deleteUserAction('not-a-uuid');
      expect(result).toEqual({ success: false, error: 'Invalid user ID.' });
      expect(mockDbSelect).not.toHaveBeenCalled();
    });
  });

  describe('user lookup', () => {
    it('returns error when the user is not found', async () => {
      setupUserLookup(null);
      const result = await deleteUserAction(USER_ID);
      expect(result).toEqual({ success: false, error: 'User not found.' });
      expect(mockTransaction).not.toHaveBeenCalled();
    });
  });

  describe('successful deletion with an expert profile', () => {
    it('deletes expert-profile children when profile IDs exist (lines 61-63)', async () => {
      const recorder = setupTransaction([{ id: PROFILE_ID }], []);
      await deleteUserAction(USER_ID);
      // The four child deletes + workHistory should all have fired because
      // profileIds.length > 0. Identity-check a couple of the targeted tables.
      const deletedTableNames = recorder.deletes.map((t) => (t as Record<string, string>).__table);
      expect(deletedTableNames).toContain('expertCompetency');
      expect(deletedTableNames).toContain('expertCertifications');
      expect(deletedTableNames).toContain('expertLanguages');
      expect(deletedTableNames).toContain('expertIndustries');
      expect(deletedTableNames).toContain('workHistory');
    });

    it('runs inside a transaction and deletes the user', async () => {
      const recorder = setupTransaction([{ id: PROFILE_ID }], []);
      const result = await deleteUserAction(USER_ID);
      expect(mockTransaction).toHaveBeenCalledTimes(1);
      const deletedTableNames = recorder.deletes.map((t) => (t as Record<string, string>).__table);
      expect(deletedTableNames).toContain('users');
      expect(result.success).toBe(true);
    });

    it('deletes the WorkOS identity and revalidates the admin path', async () => {
      const result = await deleteUserAction(USER_ID);
      expect(mockDeleteUser).toHaveBeenCalledWith(WORKOS_ID);
      expect(revalidatePath).toHaveBeenCalledWith('/admin-dev');
      expect(result).toEqual({ success: true, warning: undefined });
    });
  });

  describe('successful deletion without an expert profile', () => {
    it('skips the child deletes when there are no profile IDs', async () => {
      const recorder = setupTransaction([], []);
      const result = await deleteUserAction(USER_ID);
      const deletedTableNames = recorder.deletes.map((t) => (t as Record<string, string>).__table);
      expect(deletedTableNames).not.toContain('expertCompetency');
      // The user row itself is still deleted.
      expect(deletedTableNames).toContain('users');
      expect(result.success).toBe(true);
    });

    it('deletes personal company members + companies when present', async () => {
      const recorder = setupTransaction([], [{ id: 'company-1' }]);
      await deleteUserAction(USER_ID);
      const deletedTableNames = recorder.deletes.map((t) => (t as Record<string, string>).__table);
      expect(deletedTableNames).toContain('companies');
      expect(deletedTableNames).toContain('companyMembers');
    });
  });

  describe('error handling', () => {
    it('returns a DB error when the transaction throws', async () => {
      mockTransaction.mockRejectedValue(new Error('deadlock'));
      const result = await deleteUserAction(USER_ID);
      expect(result).toEqual({
        success: false,
        error: 'Database deletion failed. Check server logs for details.',
      });
      expect(mockDeleteUser).not.toHaveBeenCalled();
    });

    it('returns a warning when WorkOS deletion fails (best-effort)', async () => {
      mockDeleteUser.mockRejectedValue(new Error('workos down'));
      const result = await deleteUserAction(USER_ID);
      expect(result.success).toBe(true);
      expect(result.warning).toMatch(/WorkOS identity removal failed/i);
      expect(revalidatePath).toHaveBeenCalledWith('/admin-dev');
    });
  });
});
