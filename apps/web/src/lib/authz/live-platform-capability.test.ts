import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

const mockFindForSessionSync = vi.fn();
vi.mock('@balo/db', () => ({
  usersRepository: {
    findForSessionSync: (...args: unknown[]) => mockFindForSessionSync(...args),
  },
}));

// BAL-568 — the read now goes through `readLiveUserRow`, which is `React.cache()`'d. There is no
// request scope in a unit test, so pass `cache` through. ⚠ THE `@balo/db` DOUBLE ABOVE STILL
// DRIVES EVERY CASE BELOW UNCHANGED, because `readLiveUserRow` calls straight through to it —
// which is exactly why reusing `findForSessionSync` rather than a narrower reader costs zero
// test churn.
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return { ...actual, cache: <T>(fn: T): T => fn };
});

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PLATFORM_CAPABILITIES } from '@balo/shared/authz';
import { codeLinesOf, resolveRouteDir } from '@/invariants/_source-scan';
import { log } from '@/lib/logging';
import { actorHoldsPlatformCapability } from './live-platform-capability';

/**
 * BAL-560 fix round 1 (security F2) — the live-row gate for mutating Server Actions.
 * `checkSessionDrift` only runs during a page RENDER, so a Server Action gates on a cookie that
 * can be seven days stale. This helper re-reads the row.
 */
const USER_ID = 'user-1';

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: 'active',
    activeMode: 'client',
    platformRole: 'admin',
    platformCapabilities: null,
    onboardingCompleted: true,
    deletedAt: null,
    expertProfileId: null,
    activeCompanyId: null,
    expertApprovedAt: null,
    verticalId: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('actorHoldsPlatformCapability', () => {
  it('grants when the LIVE row holds the capability by role', async () => {
    mockFindForSessionSync.mockResolvedValue(row());

    await expect(
      actorHoldsPlatformCapability(USER_ID, PLATFORM_CAPABILITIES.MANAGE_PLATFORM_FEES)
    ).resolves.toBe(true);
    expect(mockFindForSessionSync).toHaveBeenCalledWith(USER_ID);
  });

  it('denies a capability the live role does not hold', async () => {
    mockFindForSessionSync.mockResolvedValue(row({ platformRole: 'admin' }));

    await expect(
      actorHoldsPlatformCapability(USER_ID, PLATFORM_CAPABILITIES.REDRIVE_JOB)
    ).resolves.toBe(false);
  });

  /**
   * ⚠ THE WHOLE POINT (security F2). The session cookie is not consulted at all — a revoked
   * override is enforced on the very next Server Action, not at the next page render.
   */
  it('denies when the LIVE row REVOKES the capability by override, whatever the cookie said', async () => {
    mockFindForSessionSync.mockResolvedValue(
      row({ platformRole: 'admin', platformCapabilities: ['view_platform_admin'] })
    );

    await expect(
      actorHoldsPlatformCapability(USER_ID, PLATFORM_CAPABILITIES.MANAGE_PLATFORM_FEES)
    ).resolves.toBe(false);
  });

  it('denies when the LIVE override is EMPTY — "holds nothing" revokes the role bundle', async () => {
    mockFindForSessionSync.mockResolvedValue(
      row({ platformRole: 'super_admin', platformCapabilities: [] })
    );

    await expect(
      actorHoldsPlatformCapability(USER_ID, PLATFORM_CAPABILITIES.MANAGE_PLATFORM_FEES)
    ).resolves.toBe(false);
  });

  it('grants when the LIVE override NAMES a capability the role lacks (widening is expressible)', async () => {
    mockFindForSessionSync.mockResolvedValue(
      row({ platformRole: 'admin', platformCapabilities: ['redrive_job'] })
    );

    await expect(
      actorHoldsPlatformCapability(USER_ID, PLATFORM_CAPABILITIES.REDRIVE_JOB)
    ).resolves.toBe(true);
  });

  it('denies a NON-STAFF live role even when the row carries an override (D1 defence in depth)', async () => {
    mockFindForSessionSync.mockResolvedValue(
      row({ platformRole: 'user', platformCapabilities: ['manage_platform_fees'] })
    );

    await expect(
      actorHoldsPlatformCapability(USER_ID, PLATFORM_CAPABILITIES.MANAGE_PLATFORM_FEES)
    ).resolves.toBe(false);
  });

  /**
   * BAL-558 — the live-row seam stays STRINGS-ONLY (the api actor path, D6); it never decodes
   * seal-order indexes. A row that somehow carries a NUMBER (the sealed-cookie wire shape, never
   * a legal `users.platform_capabilities` value) is filtered out by `isPlatformCapability`
   * exactly like any other non-string entry — it is NOT reinterpreted as an index.
   */
  it('a live row storing a NUMBER `[5]` is NOT decoded as an index — denies VIEW_PLATFORM_ADMIN', async () => {
    mockFindForSessionSync.mockResolvedValue(
      row({ platformRole: 'admin', platformCapabilities: [5] })
    );

    await expect(
      actorHoldsPlatformCapability(USER_ID, PLATFORM_CAPABILITIES.VIEW_PLATFORM_ADMIN)
    ).resolves.toBe(false);
  });

  // ── Liveness: the same three conditions the impersonation entry point applies ──────────────
  it.each([
    ['the row is missing', null],
    ['the row is soft-deleted', row({ deletedAt: new Date('2026-01-01') })],
    ['the row is suspended', row({ status: 'suspended' })],
    ['the row is inactive', row({ status: 'inactive' })],
  ])('denies when %s, even though the role would otherwise grant', async (_label, value) => {
    mockFindForSessionSync.mockResolvedValue(value);

    await expect(
      actorHoldsPlatformCapability(USER_ID, PLATFORM_CAPABILITIES.MANAGE_PLATFORM_FEES)
    ).resolves.toBe(false);
  });

  /**
   * ⚠ FIX ROUND 3 (R4). Every call site puts this gate ABOVE its own `try` — that placement is
   * load-bearing (capability resolved BEFORE the input is parsed, so the error shape leaks no
   * existence). The consequence is that a throwing read here would surface as an UNHANDLED
   * rejection out of the Server Action, not as its normal failure message. So the `try` lives
   * inside the helper: it logs and DENIES.
   */
  it('R4: a throwing DB read DENIES rather than propagating — the action cannot crash', async () => {
    mockFindForSessionSync.mockRejectedValue(new Error('connection terminated'));

    await expect(
      actorHoldsPlatformCapability(USER_ID, PLATFORM_CAPABILITIES.MANAGE_PLATFORM_FEES)
    ).resolves.toBe(false);
  });

  it('R4: the swallowed DB failure is LOGGED with the actor and the capability', async () => {
    mockFindForSessionSync.mockRejectedValue(new Error('connection terminated'));

    await actorHoldsPlatformCapability(USER_ID, PLATFORM_CAPABILITIES.MANAGE_PLATFORM_FEES);

    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledWith(
      'Live platform-capability check failed — denying',
      expect.objectContaining({
        actorUserId: USER_ID,
        capability: 'manage_platform_fees',
        error: 'connection terminated',
      })
    );
  });

  it('R4: a NON-Error rejection is still denied and still logged (String-coerced)', async () => {
    mockFindForSessionSync.mockRejectedValue('pool exhausted');

    await expect(
      actorHoldsPlatformCapability(USER_ID, PLATFORM_CAPABILITIES.REDRIVE_JOB)
    ).resolves.toBe(false);
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledWith(
      'Live platform-capability check failed — denying',
      expect.objectContaining({ error: 'pool exhausted', stack: undefined })
    );
  });

  it('R4: a SUCCESSFUL check logs nothing — the catch is not on the happy path', async () => {
    mockFindForSessionSync.mockResolvedValue(row());

    await expect(
      actorHoldsPlatformCapability(USER_ID, PLATFORM_CAPABILITIES.MANAGE_PLATFORM_FEES)
    ).resolves.toBe(true);
    expect(log.error).not.toHaveBeenCalled();
  });

  it('an unknown token in the live override denies and the rest resolve — it does not throw', async () => {
    mockFindForSessionSync.mockResolvedValue(
      row({
        platformRole: 'admin',
        platformCapabilities: ['a_token_that_no_longer_exists', 'manage_platform_fees'],
      })
    );

    await expect(
      actorHoldsPlatformCapability(USER_ID, PLATFORM_CAPABILITIES.MANAGE_PLATFORM_FEES)
    ).resolves.toBe(true);
    await expect(
      actorHoldsPlatformCapability(USER_ID, PLATFORM_CAPABILITIES.VIEW_PLATFORM_ADMIN)
    ).resolves.toBe(false);
  });
});

/**
 * ⚠⚠ BAL-568 — TWO SOURCE ASSERTIONS, BOTH OF WHICH EVERY BEHAVIOURAL CASE ABOVE IS BLIND TO.
 *
 *  · R5, ONE DEFINITION OF "LIVE": this file used to inline `row.deletedAt !== null ||
 *    row.status !== 'active'`. Those three conditions produce identical outcomes to
 *    `userRowIsLive`, so no behavioural test can tell the two apart — only reading the source can.
 *  · R7, ONE READ PER REQUEST: the 22 platform-gated staff actions must not pay two round trips
 *    for the same row. `React.cache()` is a no-op outside a request scope (vitest included), so
 *    the dedupe is not observable at runtime here either.
 */
describe('⚠ BAL-568 source pins (R5 one definition, R7 one read)', () => {
  const SRC_DIR = resolveRouteDir(['apps/web/src', 'src']);
  const SOURCE = codeLinesOf(
    readFileSync(path.join(SRC_DIR, 'lib/authz/live-platform-capability.ts'), 'utf8')
  );

  it('uses the SHARED liveness predicate and restates none of its conditions', () => {
    expect(SRC_DIR).not.toBe('');
    expect(SOURCE.length).toBeGreaterThan(200);
    // It genuinely is the module under test — a path typo would make the rest vacuous.
    expect(SOURCE).toContain('export async function actorHoldsPlatformCapability');
    expect(SOURCE).toContain('userRowIsLive(row)');
    expect(SOURCE).not.toContain("!== 'active'");
    expect(SOURCE).not.toContain('row.deletedAt !== null');
  });

  it('reads through the ONE cached reader and never the repository directly', () => {
    expect(SOURCE).toContain('readLiveUserRow(userId)');
    expect(SOURCE).not.toContain('usersRepository.findForSessionSync(');
  });
});
