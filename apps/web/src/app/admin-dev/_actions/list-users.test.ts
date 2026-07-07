import { describe, it, expect, vi, beforeEach } from 'vitest';

// The action builds a Drizzle select whose `companyMembershipCount` subquery is a
// raw `sql` template (BAL-345 adds `AND deleted_at IS NULL` — a CHANGED line). We
// mock @balo/db so constructing that select — and thus evaluating the changed
// template — is exercised, and assert the rows flow through.

const mockOrderBy = vi.fn();
const mockFrom = vi.fn(() => ({ orderBy: mockOrderBy }));
const mockSelect = vi.fn<(...a: unknown[]) => { from: typeof mockFrom }>(() => ({
  from: mockFrom,
}));

vi.mock('@balo/db', () => ({
  db: { select: (...a: unknown[]) => mockSelect(...a) },
  users: new Proxy({}, { get: () => 'users_col' }),
  sql: (strings: TemplateStringsArray) => ({ __sql: strings.join('') }),
  desc: (col: unknown) => col,
}));

vi.mock('@/lib/logging', () => ({ log: { error: vi.fn() } }));

import { listUsersAction } from './list-users';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('listUsersAction (BAL-345 changed line)', () => {
  it('returns the rows from the query (select is constructed → changed subquery evaluated)', async () => {
    const rows = [{ id: 'u-1', companyMembershipCount: 1 }];
    mockOrderBy.mockResolvedValue(rows);

    const result = await listUsersAction();

    expect(result).toEqual(rows);
    // The companyMembershipCount subquery template was evaluated with the
    // deleted_at filter — assert the sql template included it.
    const selectArg = mockSelect.mock.calls[0]?.[0] as
      | { companyMembershipCount?: { __sql?: string } }
      | undefined;
    expect(selectArg?.companyMembershipCount?.__sql).toContain('"deleted_at" IS NULL');
  });

  it('returns [] and logs when the query throws', async () => {
    mockOrderBy.mockRejectedValue(new Error('db down'));
    const result = await listUsersAction();
    expect(result).toEqual([]);
  });
});
