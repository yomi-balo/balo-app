import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

const mockFindForSessionSync = vi.fn();
vi.mock('@balo/db', () => ({
  usersRepository: {
    findForSessionSync: (...args: unknown[]) => mockFindForSessionSync(...args),
  },
}));

import { PLATFORM_CAPABILITIES } from '@balo/shared/authz';
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
