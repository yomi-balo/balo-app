import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

const mockReadLiveUserRow = vi.fn();
vi.mock('./live-user', () => ({
  readLiveUserRow: (...args: unknown[]) => mockReadLiveUserRow(...args),
}));

const mockTrackServerAndFlush = vi.fn();
vi.mock('@/lib/analytics/server', () => ({
  trackServerAndFlush: (...args: unknown[]) => mockTrackServerAndFlush(...args),
  AUTH_SERVER_EVENTS: { SESSION_INVALIDATED: 'auth_session_invalidated' },
}));

import { log } from '@/lib/logging';
import { codeLinesOf, resolveRouteDir } from '@/invariants/_source-scan';
import {
  ACCOUNT_UNREADABLE,
  AccountNotLiveError,
  accountRefusalFor,
  assertAccountLive,
  noteAccountRefusal,
} from './account-liveness';

const LIVE = { status: 'active', deletedAt: null };
const SUSPENDED = { status: 'suspended', deletedAt: null };
const DELETED = { status: 'active', deletedAt: new Date('2026-01-01T00:00:00.000Z') };

describe('accountRefusalFor (BAL-568)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null for a live row, and emits nothing', async () => {
    mockReadLiveUserRow.mockResolvedValue(LIVE);
    await expect(accountRefusalFor('user-1')).resolves.toBeNull();
    expect(mockTrackServerAndFlush).not.toHaveBeenCalled();
  });

  it('returns account_suspended for a suspended row', async () => {
    mockReadLiveUserRow.mockResolvedValue(SUSPENDED);
    await expect(accountRefusalFor('user-1')).resolves.toBe('account_suspended');
  });

  it('returns account_deleted for a soft-deleted row', async () => {
    mockReadLiveUserRow.mockResolvedValue(DELETED);
    await expect(accountRefusalFor('user-1')).resolves.toBe('account_deleted');
  });

  it('returns account_deleted when the row is missing entirely', async () => {
    mockReadLiveUserRow.mockResolvedValue(null);
    await expect(accountRefusalFor('ghost')).resolves.toBe('account_deleted');
  });

  /**
   * ⚠⚠ FAIL CLOSED ON ACCESS, FAIL OPEN ON TEARDOWN. A DB fault refuses — an unreachable database
   * must not be a way to keep acting while suspended — but it must NOT be counted as a session
   * invalidation and must NOT claim the account is suspended. A blip that signed every user out
   * with "your account has been suspended" would be a mass-logout incident and a lie.
   */
  it('⚠ a DB fault refuses as account_unreadable, logs, and emits NO analytics', async () => {
    mockReadLiveUserRow.mockRejectedValue(new Error('connection terminated'));

    await expect(accountRefusalFor('user-1')).resolves.toBe(ACCOUNT_UNREADABLE);

    expect(mockTrackServerAndFlush).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith(
      'Account liveness read failed — refusing',
      expect.objectContaining({ actorUserId: 'user-1', error: 'connection terminated' })
    );
  });

  /**
   * ⚠ THE FULL LITERAL, NOT `expect.objectContaining`. A payload pin that only checks a subset
   * passes against a payload carrying an extra field — including one carrying the token, the
   * email or the WorkOS `sub`, which is exactly what must never be attached here.
   */
  it('⚠ emits session_invalidated with the EXACT payload for a real refusal', async () => {
    mockReadLiveUserRow.mockResolvedValue(SUSPENDED);

    await accountRefusalFor('user-1');

    expect(mockTrackServerAndFlush).toHaveBeenCalledTimes(1);
    expect(mockTrackServerAndFlush).toHaveBeenCalledWith('auth_session_invalidated', {
      distinct_id: 'user-1',
      path: 'action',
      reason: 'suspended',
    });
  });

  /**
   * ⚠⚠ THE `path` IS THE CALLER'S TO SUPPLY (fix round 1, F3). It was HARD-CODED to `'action'` —
   * specified that way by the plan (§5.2), so a plan defect rather than a builder slip — which
   * meant every RENDER-path refusal (`getCurrentUser` runs from three layouts) was reported as an
   * action refusal, and R3's `page` arm came only from the sync route. That defeats the whole
   * point of the dimension: knowing how often a suspended account is stopped OUTSIDE a page load.
   */
  it('⚠ reports the path the CALLER supplies, not a constant', async () => {
    mockReadLiveUserRow.mockResolvedValue(SUSPENDED);

    await accountRefusalFor('user-1', 'page');

    expect(mockTrackServerAndFlush).toHaveBeenCalledWith('auth_session_invalidated', {
      distinct_id: 'user-1',
      path: 'page',
      reason: 'suspended',
    });
    expect(log.info).toHaveBeenCalledWith('Session invalidated: account not live', {
      userId: 'user-1',
      path: 'page',
      reason: 'suspended',
    });
  });

  it('defaults to action when the caller supplies no path — the dominant seam', async () => {
    mockReadLiveUserRow.mockResolvedValue(SUSPENDED);

    await accountRefusalFor('user-1');

    expect(mockTrackServerAndFlush).toHaveBeenCalledWith(
      'auth_session_invalidated',
      expect.objectContaining({ path: 'action' })
    );
  });
});

describe('assertAccountLive (BAL-568)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not throw for a live row', async () => {
    mockReadLiveUserRow.mockResolvedValue(LIVE);
    await expect(assertAccountLive('user-1')).resolves.toBeUndefined();
  });

  it.each([
    ['suspended', SUSPENDED, 'account_suspended'],
    ['soft-deleted', DELETED, 'account_deleted'],
    ['missing', null, 'account_deleted'],
  ])('throws AccountNotLiveError with code %s for a %s row', async (_label, row, code) => {
    mockReadLiveUserRow.mockResolvedValue(row);
    await expect(assertAccountLive('user-1')).rejects.toBeInstanceOf(AccountNotLiveError);
    mockReadLiveUserRow.mockResolvedValue(row);
    await expect(assertAccountLive('user-1')).rejects.toMatchObject({ code });
  });

  it('throws with account_unreadable when the read fails', async () => {
    mockReadLiveUserRow.mockRejectedValue(new Error('down'));
    await expect(assertAccountLive('user-1')).rejects.toMatchObject({
      code: ACCOUNT_UNREADABLE,
    });
  });

  /**
   * ⚠ IT IS AN ORDINARY `Error` SUBCLASS, DELIBERATELY. Every shipped call site wraps its actor
   * resolution in a bare `catch` that returns "not signed in"; an `Error` is handled there with
   * zero edits, whereas a `redirect()` would throw `NEXT_REDIRECT` and be swallowed into a silent
   * failure of the sign-out.
   */
  it('⚠ the thrown value is a plain Error subclass, not a redirect', async () => {
    mockReadLiveUserRow.mockResolvedValue(SUSPENDED);
    await expect(assertAccountLive('user-1')).rejects.toBeInstanceOf(Error);
    mockReadLiveUserRow.mockResolvedValue(SUSPENDED);
    await expect(assertAccountLive('user-1')).rejects.toMatchObject({
      name: 'AccountNotLiveError',
    });
  });
});

describe('noteAccountRefusal — the one logging/emission point for every path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ['page', 'account_deleted', 'deleted'],
    ['api', 'account_suspended', 'suspended'],
    ['action', 'account_suspended', 'suspended'],
  ] as const)('carries path=%s through to both the log and the event', (path, code, reason) => {
    noteAccountRefusal(code, path, 'user-9');

    expect(log.info).toHaveBeenCalledWith('Session invalidated: account not live', {
      userId: 'user-9',
      path,
      reason,
    });
    expect(mockTrackServerAndFlush).toHaveBeenCalledWith('auth_session_invalidated', {
      distinct_id: 'user-9',
      path,
      reason,
    });
  });
});

/**
 * ⚠⚠ THE PER-REQUEST DEDUP PIN, AND IT IS A SOURCE ASSERTION FOR THE SAME REASON `readLiveUserRow`'s
 * is (fix round 1, F3). `React.cache()` is a NO-OP outside a React request scope — vitest included
 * — so the dedup cannot be observed at runtime here; only the source can show it is armed.
 *
 * What it prevents: `readLiveUserRow` is cached so the READ dedupes, but the EMISSION was not, and
 * the seams call it more than once per request. On the MARKETING surface nothing converges (there
 * is no `checkSessionDrift` redirect to eject the user), so a suspended visitor emitted two events
 * and two log lines on EVERY page view, indefinitely — each one a *flushing* PostHog call.
 */
describe('⚠ the emission is deduped per request (F3)', () => {
  const SRC_DIR = resolveRouteDir(['apps/web/src', 'src']);
  const SOURCE = codeLinesOf(
    readFileSync(path.join(SRC_DIR, 'lib/auth/account-liveness.ts'), 'utf8')
  );

  it('wraps noteAccountRefusal in React.cache(), keyed on the code, path and userId', () => {
    expect(SRC_DIR).not.toBe('');
    expect(SOURCE.length).toBeGreaterThan(200);
    expect(SOURCE).toContain("import { cache } from 'react';");
    expect(SOURCE).toContain('export const noteAccountRefusal = cache(');
    // It is genuinely the module under test — a path typo would make the above vacuous.
    expect(SOURCE).toContain('export async function accountRefusalFor');
  });
});
