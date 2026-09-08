import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('server-only', () => ({}));

const mockRequireOnboardedUser = vi.fn();
const mockGetSession = vi.fn();
vi.mock('@/lib/auth/session', () => ({
  requireOnboardedUser: () => mockRequireOnboardedUser(),
  getSession: () => mockGetSession(),
}));

const mockFindForSessionSync = vi.fn();
const mockAuditRecord = vi.fn();
vi.mock('@balo/db', () => ({
  usersRepository: { findForSessionSync: (...a: unknown[]) => mockFindForSessionSync(...a) },
  auditEventsRepository: { record: (...a: unknown[]) => mockAuditRecord(...a) },
  db: {},
}));

const mockBuildImpersonatedSessionUser = vi.fn();
vi.mock('@/lib/auth/impersonation-target', () => ({
  buildImpersonatedSessionUser: (...a: unknown[]) => mockBuildImpersonatedSessionUser(...a),
}));

const mockSealPreservedAdminSession = vi.fn();
const mockUnsealPreservedAdminSession = vi.fn();
const mockWritePreservedAdminCookie = vi.fn();
const mockReadPreservedAdminCookie = vi.fn();
const mockClearPreservedAdminCookie = vi.fn();
vi.mock('@/lib/auth/impersonation-preserved-session', () => ({
  sealPreservedAdminSession: (...a: unknown[]) => mockSealPreservedAdminSession(...a),
  unsealPreservedAdminSession: (...a: unknown[]) => mockUnsealPreservedAdminSession(...a),
  writePreservedAdminCookie: (...a: unknown[]) => mockWritePreservedAdminCookie(...a),
  readPreservedAdminCookie: (...a: unknown[]) => mockReadPreservedAdminCookie(...a),
  clearPreservedAdminCookie: (...a: unknown[]) => mockClearPreservedAdminCookie(...a),
}));

const mockRevalidatePath = vi.fn();
vi.mock('next/cache', () => ({
  revalidatePath: (...a: unknown[]) => mockRevalidatePath(...a),
}));

const { mockLogInfo, mockLogWarn, mockLogError } = vi.hoisted(() => ({
  mockLogInfo: vi.fn(),
  mockLogWarn: vi.fn(),
  mockLogError: vi.fn(),
}));
vi.mock('@/lib/logging', () => ({
  log: { info: mockLogInfo, warn: mockLogWarn, error: mockLogError },
}));

// `@/lib/auth/impersonation`, `@/lib/authz/platform`, `@/lib/auth/session-config` and
// `@balo/shared/authz` are DELIBERATELY NOT mocked — they are pure, dependency-free logic and
// the whole point of this file is to prove the REAL policy decisions the action makes.
import { startImpersonationAction, stopImpersonationAction } from './impersonation';

const ADMIN_ID = '11111111-1111-4111-8111-111111111111';
const TARGET_ID = '22222222-2222-4222-8222-222222222222';

function superAdminActor(overrides: Record<string, unknown> = {}) {
  return {
    id: ADMIN_ID,
    email: 'admin@balo.com',
    firstName: 'Ada',
    lastName: 'Admin',
    avatarUrl: null,
    activeMode: 'client',
    onboardingCompleted: true,
    platformRole: 'super_admin',
    companyId: 'company-admin',
    companyName: 'Balo Staff',
    companyRole: 'owner',
    isImpersonating: undefined as boolean | undefined,
    impersonatorUserId: undefined as string | undefined,
    ...overrides,
  };
}

function sessionSyncRow(overrides: Record<string, unknown> = {}) {
  return {
    status: 'active',
    activeMode: 'client',
    platformRole: 'super_admin',
    onboardingCompleted: true,
    deletedAt: null,
    expertProfileId: null,
    activeCompanyId: null,
    expertApprovedAt: null,
    verticalId: null,
    ...overrides,
  };
}

function targetSessionUser(overrides: Record<string, unknown> = {}) {
  return {
    id: TARGET_ID,
    email: 'target@northwind.test',
    firstName: 'Tara',
    lastName: 'Getty',
    avatarUrl: null,
    activeMode: 'client',
    onboardingCompleted: true,
    platformRole: 'user',
    companyId: 'company-1',
    companyName: 'Northwind Industrial',
    companyRole: 'member',
    ...overrides,
  };
}

function fakeSession(overrides: Record<string, unknown> = {}) {
  return {
    user: superAdminActor(),
    accessToken: 'admin-access-token',
    refreshToken: 'admin-refresh-token',
    updateConfig: vi.fn(),
    save: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuditRecord.mockResolvedValue({ id: 'audit-1' });
  mockSealPreservedAdminSession.mockResolvedValue('sealed-admin-session');
});

afterEach(() => {
  vi.useRealTimers();
});

describe('startImpersonationAction', () => {
  it('returns not_signed_in when there is no session', async () => {
    mockRequireOnboardedUser.mockRejectedValue(new Error('Unauthorized'));

    const result = await startImpersonationAction({ targetUserId: TARGET_ID, reason: 'support' });

    expect(result).toEqual({
      success: false,
      error: 'You are not signed in.',
      code: 'not_signed_in',
    });
  });

  it('returns already_impersonating — no nesting, ever', async () => {
    mockRequireOnboardedUser.mockResolvedValue(
      superAdminActor({ isImpersonating: true, impersonatorUserId: 'someone-else' })
    );

    const result = await startImpersonationAction({ targetUserId: TARGET_ID, reason: 'support' });

    expect(result).toMatchObject({ success: false, code: 'already_impersonating' });
    expect(mockFindForSessionSync).not.toHaveBeenCalled();
    // BAL-553 fix round 1, F5 — a break-glass surface must not refuse silently.
    expect(mockLogWarn).toHaveBeenCalledWith(
      'Impersonation start refused',
      expect.objectContaining({ code: 'already_impersonating', actorUserId: ADMIN_ID })
    );
  });

  // BAL-553 fix round 1, S1/F6 — a `null` (or otherwise garbage) payload must return the clean
  // `invalid` refusal via `safeParse`, never throw an unhandled TypeError from dereferencing
  // `input.targetUserId` before validation.
  it('returns invalid (not a crash) for a null payload', async () => {
    mockRequireOnboardedUser.mockResolvedValue(superAdminActor());

    const result = await startImpersonationAction(
      null as unknown as { targetUserId: string; reason: string }
    );

    expect(result).toMatchObject({ success: false, code: 'invalid' });
    expect(mockFindForSessionSync).not.toHaveBeenCalled();
  });

  it('returns denied for an actor without IMPERSONATE_USER on the sealed role (e.g. platform admin) — no DB round trip paid', async () => {
    mockRequireOnboardedUser.mockResolvedValue(superAdminActor({ platformRole: 'admin' }));

    const result = await startImpersonationAction({ targetUserId: TARGET_ID, reason: 'support' });

    expect(result).toMatchObject({ success: false, code: 'denied' });
    expect(mockFindForSessionSync).not.toHaveBeenCalled();
    expect(mockLogWarn).toHaveBeenCalledWith(
      'Impersonation start refused',
      expect.objectContaining({ code: 'denied', actorUserId: ADMIN_ID })
    );
  });

  it('returns invalid for a malformed input (missing reason)', async () => {
    mockRequireOnboardedUser.mockResolvedValue(superAdminActor());

    const result = await startImpersonationAction({ targetUserId: TARGET_ID, reason: '' });

    expect(result).toMatchObject({ success: false, code: 'invalid' });
    // F5 — schema-failure refusals warn too. No `targetUserId` in the payload: the input never
    // validated, so it is never logged (S1).
    expect(mockLogWarn).toHaveBeenCalledWith(
      'Impersonation start refused',
      expect.objectContaining({ code: 'invalid', actorUserId: ADMIN_ID })
    );
    expect(mockLogWarn).not.toHaveBeenCalledWith(
      'Impersonation start refused',
      expect.objectContaining({ targetUserId: expect.anything() })
    );
  });

  it('returns invalid for a non-uuid targetUserId', async () => {
    mockRequireOnboardedUser.mockResolvedValue(superAdminActor());

    const result = await startImpersonationAction({ targetUserId: 'not-a-uuid', reason: 'x' });

    expect(result).toMatchObject({ success: false, code: 'invalid' });
    expect(mockLogWarn).toHaveBeenCalledWith(
      'Impersonation start refused',
      expect.objectContaining({ code: 'invalid', actorUserId: ADMIN_ID })
    );
  });

  it('returns invalid for a self-target', async () => {
    mockRequireOnboardedUser.mockResolvedValue(superAdminActor());

    const result = await startImpersonationAction({ targetUserId: ADMIN_ID, reason: 'x' });

    expect(result).toMatchObject({ success: false, code: 'invalid' });
    expect(mockFindForSessionSync).not.toHaveBeenCalled();
    // F5 — here the input DID validate (a real UUID equal to actor.id), so the validated
    // targetUserId is safe to log.
    expect(mockLogWarn).toHaveBeenCalledWith(
      'Impersonation start refused',
      expect.objectContaining({ code: 'invalid', actorUserId: ADMIN_ID, targetUserId: ADMIN_ID })
    );
  });

  it('returns denied when the fresh DB re-read shows the actor lost the capability (demoted since the cookie was sealed)', async () => {
    mockRequireOnboardedUser.mockResolvedValue(superAdminActor());
    mockFindForSessionSync.mockResolvedValueOnce(sessionSyncRow({ platformRole: 'admin' }));

    const result = await startImpersonationAction({ targetUserId: TARGET_ID, reason: 'support' });

    expect(result).toMatchObject({ success: false, code: 'denied' });
    expect(mockFindForSessionSync).toHaveBeenCalledTimes(1);
  });

  it('returns denied when the fresh DB re-read shows the actor is suspended', async () => {
    mockRequireOnboardedUser.mockResolvedValue(superAdminActor());
    mockFindForSessionSync.mockResolvedValueOnce(sessionSyncRow({ status: 'suspended' }));

    const result = await startImpersonationAction({ targetUserId: TARGET_ID, reason: 'support' });

    expect(result).toMatchObject({ success: false, code: 'denied' });
  });

  it('returns target_unavailable when the target row is missing', async () => {
    mockRequireOnboardedUser.mockResolvedValue(superAdminActor());
    mockFindForSessionSync.mockResolvedValueOnce(sessionSyncRow()).mockResolvedValueOnce(null);

    const result = await startImpersonationAction({ targetUserId: TARGET_ID, reason: 'support' });

    expect(result).toMatchObject({ success: false, code: 'target_unavailable' });
  });

  it('returns target_unavailable when the target is soft-deleted', async () => {
    mockRequireOnboardedUser.mockResolvedValue(superAdminActor());
    mockFindForSessionSync
      .mockResolvedValueOnce(sessionSyncRow())
      .mockResolvedValueOnce(sessionSyncRow({ deletedAt: new Date() }));

    const result = await startImpersonationAction({ targetUserId: TARGET_ID, reason: 'support' });

    expect(result).toMatchObject({ success: false, code: 'target_unavailable' });
  });

  it('returns target_is_staff when the target is a platform admin', async () => {
    mockRequireOnboardedUser.mockResolvedValue(superAdminActor());
    mockFindForSessionSync
      .mockResolvedValueOnce(sessionSyncRow())
      .mockResolvedValueOnce(sessionSyncRow({ platformRole: 'admin' }));

    const result = await startImpersonationAction({ targetUserId: TARGET_ID, reason: 'support' });

    expect(result).toMatchObject({ success: false, code: 'target_is_staff' });
    expect(mockBuildImpersonatedSessionUser).not.toHaveBeenCalled();
  });

  it('returns target_is_staff when the target is a super_admin (cannot impersonate another staff member)', async () => {
    mockRequireOnboardedUser.mockResolvedValue(superAdminActor());
    mockFindForSessionSync
      .mockResolvedValueOnce(sessionSyncRow())
      .mockResolvedValueOnce(sessionSyncRow({ platformRole: 'super_admin' }));

    const result = await startImpersonationAction({ targetUserId: TARGET_ID, reason: 'support' });

    expect(result).toMatchObject({ success: false, code: 'target_is_staff' });
  });

  it('returns target_unavailable when the target has no derivable workspace', async () => {
    mockRequireOnboardedUser.mockResolvedValue(superAdminActor());
    mockFindForSessionSync
      .mockResolvedValueOnce(sessionSyncRow())
      .mockResolvedValueOnce(sessionSyncRow({ platformRole: 'user' }));
    mockBuildImpersonatedSessionUser.mockResolvedValue(null);

    const result = await startImpersonationAction({ targetUserId: TARGET_ID, reason: 'support' });

    expect(result).toMatchObject({ success: false, code: 'target_unavailable' });
  });

  it('succeeds: audits BEFORE the swap, seals+writes the preserved cookie, swaps and re-arms the session config, revalidates, and returns an EXACT expiresAt', async () => {
    // BAL-553 fix round 1, F8 — fake timers PIN the 30-minute arithmetic. Before this, changing
    // `IMPERSONATED_SESSION_MAX_AGE_SECONDS` or the `Date.now() + … * 1000` computation, or
    // deleting `expiresAt` from the audit row entirely, failed nothing here: `typeof === 'number'`
    // and `objectContaining({ reason })` both still pass against a wrong number / a missing key.
    const fixedNow = new Date('2026-03-01T12:00:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(fixedNow);

    mockRequireOnboardedUser.mockResolvedValue(superAdminActor());
    mockFindForSessionSync
      .mockResolvedValueOnce(sessionSyncRow())
      .mockResolvedValueOnce(sessionSyncRow({ platformRole: 'user' }));
    mockBuildImpersonatedSessionUser.mockResolvedValue(targetSessionUser());
    const session = fakeSession();
    const originalAdminUser = session.user;
    mockGetSession.mockResolvedValue(session);

    const result = await startImpersonationAction({
      targetUserId: TARGET_ID,
      reason: 'support ticket 42',
    });

    const expectedExpiresAt = fixedNow.getTime() + 1800 * 1000;
    expect(result).toEqual({
      success: true,
      targetUserId: TARGET_ID,
      expiresAt: expectedExpiresAt,
    });

    expect(mockAuditRecord).toHaveBeenCalledWith(
      {
        actorUserId: ADMIN_ID,
        action: 'impersonation.started',
        entityType: 'user',
        entityId: TARGET_ID,
        metadata: { reason: 'support ticket 42', expiresAt: expectedExpiresAt },
      },
      expect.anything()
    );
    expect(mockLogInfo).toHaveBeenCalledWith(
      'Impersonation started',
      expect.objectContaining({
        actorUserId: ADMIN_ID,
        targetUserId: TARGET_ID,
        expiresAt: expectedExpiresAt,
      })
    );

    expect(mockSealPreservedAdminSession).toHaveBeenCalledWith({
      user: originalAdminUser,
      accessToken: 'admin-access-token',
      refreshToken: 'admin-refresh-token',
    });
    expect(mockWritePreservedAdminCookie).toHaveBeenCalledWith('sealed-admin-session');

    expect(session.user).toMatchObject({
      id: TARGET_ID,
      isImpersonating: true,
      impersonatorUserId: ADMIN_ID,
    });
    expect(session.accessToken).toBeUndefined();
    expect(session.refreshToken).toBeUndefined();
    expect(session.updateConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        ttl: 1800,
        cookieOptions: expect.objectContaining({ maxAge: 1800 }),
      })
    );
    expect(session.save).toHaveBeenCalledTimes(1);
    expect(mockRevalidatePath).toHaveBeenCalledWith('/', 'layout');

    // Audit precedes the swap — the audit call's own arguments must not already carry the
    // post-swap `session.user` mutation as a side effect (it is a plain object literal, not a
    // reference into `session.user`).
    const [auditCallOrder] = mockAuditRecord.mock.invocationCallOrder;
    const [saveCallOrder] = session.save.mock.invocationCallOrder;
    if (auditCallOrder === undefined)
      throw new Error('expected auditEventsRepository.record to have been called');
    if (saveCallOrder === undefined) throw new Error('expected session.save to have been called');
    expect(auditCallOrder).toBeLessThan(saveCallOrder);
  });

  it('logs and returns failed on an unexpected error', async () => {
    mockRequireOnboardedUser.mockResolvedValue(superAdminActor());
    mockFindForSessionSync
      .mockResolvedValueOnce(sessionSyncRow())
      .mockResolvedValueOnce(sessionSyncRow({ platformRole: 'user' }));
    mockBuildImpersonatedSessionUser.mockResolvedValue(targetSessionUser());
    mockAuditRecord.mockRejectedValue(new Error('DB down'));

    const result = await startImpersonationAction({ targetUserId: TARGET_ID, reason: 'support' });

    expect(result).toMatchObject({ success: false, code: 'failed' });
    expect(mockLogError).toHaveBeenCalledWith(
      'Impersonation start failed',
      expect.objectContaining({ actorUserId: ADMIN_ID, targetUserId: TARGET_ID, error: 'DB down' })
    );
  });
});

describe('stopImpersonationAction', () => {
  it('returns not_signed_in when there is no session user', async () => {
    mockGetSession.mockResolvedValue(fakeSession({ user: undefined }));

    const result = await stopImpersonationAction();

    expect(result).toEqual({
      success: false,
      error: 'You are not signed in.',
      code: 'not_signed_in',
    });
  });

  it('returns not_impersonating for a normal session — with NO capability check', async () => {
    mockGetSession.mockResolvedValue(fakeSession({ user: superAdminActor() }));

    const result = await stopImpersonationAction();

    expect(result).toMatchObject({ success: false, code: 'not_impersonating' });
    expect(mockReadPreservedAdminCookie).not.toHaveBeenCalled();
  });

  it('fails closed — destroys the session — when the preserved cookie is missing', async () => {
    const session = fakeSession({
      user: targetSessionUser({ isImpersonating: true, impersonatorUserId: ADMIN_ID }),
    });
    mockGetSession.mockResolvedValue(session);
    mockReadPreservedAdminCookie.mockResolvedValue(undefined);

    const result = await stopImpersonationAction();

    expect(result).toMatchObject({ success: false, code: 'restore_unavailable' });
    expect(session.destroy).toHaveBeenCalledTimes(1);
    expect(mockClearPreservedAdminCookie).toHaveBeenCalledTimes(1);
    expect(mockLogWarn).toHaveBeenCalledWith(
      'Impersonation stop could not restore the staff session',
      expect.objectContaining({ targetUserId: TARGET_ID, impersonatorUserId: ADMIN_ID })
    );
    expect(mockAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'impersonation.stopped',
        metadata: { outcome: 'restore_unavailable' },
      }),
      expect.anything()
    );
    expect(session.save).not.toHaveBeenCalled();
  });

  it('fails closed when the preserved seal does not unseal (expired/forged/tampered)', async () => {
    const session = fakeSession({
      user: targetSessionUser({ isImpersonating: true, impersonatorUserId: ADMIN_ID }),
    });
    mockGetSession.mockResolvedValue(session);
    mockReadPreservedAdminCookie.mockResolvedValue('some-seal');
    mockUnsealPreservedAdminSession.mockResolvedValue(null);

    const result = await stopImpersonationAction();

    expect(result).toMatchObject({ success: false, code: 'restore_unavailable' });
    expect(session.destroy).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the preserved session belongs to a DIFFERENT start (impersonatorUserId mismatch)', async () => {
    const session = fakeSession({
      user: targetSessionUser({ isImpersonating: true, impersonatorUserId: ADMIN_ID }),
    });
    mockGetSession.mockResolvedValue(session);
    mockReadPreservedAdminCookie.mockResolvedValue('some-seal');
    mockUnsealPreservedAdminSession.mockResolvedValue({
      user: superAdminActor({ id: 'a-different-admin' }),
      accessToken: 'at',
      refreshToken: 'rt',
    });

    const result = await stopImpersonationAction();

    expect(result).toMatchObject({ success: false, code: 'restore_unavailable' });
    expect(session.destroy).toHaveBeenCalledTimes(1);
  });

  it('succeeds: restores the admin session, un-arms the 30-minute config, clears the preserved cookie, and revalidates', async () => {
    const session = fakeSession({
      user: targetSessionUser({ isImpersonating: true, impersonatorUserId: ADMIN_ID }),
    });
    mockGetSession.mockResolvedValue(session);
    mockReadPreservedAdminCookie.mockResolvedValue('some-seal');
    mockUnsealPreservedAdminSession.mockResolvedValue({
      user: superAdminActor(),
      accessToken: 'admin-access-token',
      refreshToken: 'admin-refresh-token',
    });

    const result = await stopImpersonationAction();

    expect(result).toEqual({ success: true });
    expect(session.user).toMatchObject({ id: ADMIN_ID });
    expect(session.user.isImpersonating).toBeUndefined();
    expect(session.accessToken).toBe('admin-access-token');
    expect(session.refreshToken).toBe('admin-refresh-token');
    expect(session.updateConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        cookieOptions: expect.objectContaining({ maxAge: 60 * 60 * 24 * 7 }),
      })
    );
    expect(session.save).toHaveBeenCalledTimes(1);
    expect(mockClearPreservedAdminCookie).toHaveBeenCalledTimes(1);
    expect(mockAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: ADMIN_ID,
        action: 'impersonation.stopped',
        entityType: 'user',
        entityId: TARGET_ID,
        metadata: { outcome: 'restored' },
      }),
      expect.anything()
    );
    expect(mockLogInfo).toHaveBeenCalledWith(
      'Impersonation stopped',
      expect.objectContaining({ actorUserId: ADMIN_ID, targetUserId: TARGET_ID })
    );
    expect(mockRevalidatePath).toHaveBeenCalledWith('/', 'layout');
  });

  it('logs and returns failed on an unexpected error', async () => {
    const session = fakeSession({
      user: targetSessionUser({ isImpersonating: true, impersonatorUserId: ADMIN_ID }),
      save: vi.fn().mockRejectedValue(new Error('save failed')),
    });
    mockGetSession.mockResolvedValue(session);
    mockReadPreservedAdminCookie.mockResolvedValue('some-seal');
    mockUnsealPreservedAdminSession.mockResolvedValue({
      user: superAdminActor(),
      accessToken: 'admin-access-token',
      refreshToken: 'admin-refresh-token',
    });

    const result = await stopImpersonationAction();

    expect(result).toMatchObject({ success: false, code: 'failed' });
    expect(mockLogError).toHaveBeenCalledWith(
      'Impersonation stop failed',
      expect.objectContaining({ targetUserId: TARGET_ID, impersonatorUserId: ADMIN_ID })
    );
  });
});
