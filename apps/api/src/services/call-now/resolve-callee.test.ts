import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockFindLatest, mockGetMemberRole, mockFindTimezone, mockRoleHasCapability, mockWarn } =
  vi.hoisted(() => ({
    mockFindLatest: vi.fn(),
    mockGetMemberRole: vi.fn(),
    mockFindTimezone: vi.fn(),
    mockRoleHasCapability: vi.fn(),
    mockWarn: vi.fn(),
  }));

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: mockWarn, error: vi.fn() }),
}));
vi.mock('@balo/db', () => ({
  auditEventsRepository: { findLatestByEntityAndAction: mockFindLatest },
  partyMembershipsRepository: { getMemberRole: mockGetMemberRole },
  usersRepository: { findTimezoneContext: mockFindTimezone },
}));
vi.mock('@balo/shared/authz', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@balo/shared/authz')>()),
  roleHasCapability: mockRoleHasCapability,
}));

import type { CaseEngagementRow } from '@balo/db';
import { resolveCallee } from './resolve-callee.js';

const ENGAGEMENT_ID = '33333333-3333-4333-8333-333333333333';
const COMPANY_ID = '44444444-4444-4444-8444-444444444444';
const CALLER = '11111111-1111-4111-8111-111111111111';
const EXPERT_USER = '22222222-2222-4222-8222-222222222222';
const BOOKER = '55555555-5555-4555-8555-555555555555';
const CASE_ROW = { id: ENGAGEMENT_ID, companyId: COMPANY_ID } as unknown as CaseEngagementRow;
const EXPERT_SETTINGS = { userId: EXPERT_USER, timezone: 'Australia/Sydney' };

function input(side: 'client' | 'expert', callerUserId: string) {
  return { caseRow: CASE_ROW, side, callerUserId, expertSettings: EXPERT_SETTINGS };
}

describe('resolveCallee', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindLatest.mockResolvedValue({ actorUserId: BOOKER });
    mockGetMemberRole.mockResolvedValue('member');
    mockRoleHasCapability.mockReturnValue(true);
    mockFindTimezone.mockResolvedValue({ savedTimezone: 'America/New_York', expert: null });
  });

  describe('client caller → the delivering expert', () => {
    it('rings the expert in the expert’s own time zone, reading no audit row', async () => {
      await expect(resolveCallee(input('client', CALLER))).resolves.toEqual({
        ok: true,
        userId: EXPERT_USER,
        timeZone: 'Australia/Sydney',
      });
      expect(mockFindLatest).not.toHaveBeenCalled();
    });

    it('is `self` when the client caller is the expert (and logs it)', async () => {
      await expect(resolveCallee(input('client', EXPERT_USER))).resolves.toEqual({
        ok: false,
        reason: 'self',
      });
      expect(mockWarn).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'self', engagementId: ENGAGEMENT_ID }),
        expect.any(String)
      );
    });
  });

  describe('expert caller → the booker', () => {
    it('rings the actor of the case’s `engagement.created` row, in their saved zone', async () => {
      await expect(resolveCallee(input('expert', EXPERT_USER))).resolves.toEqual({
        ok: true,
        userId: BOOKER,
        timeZone: 'America/New_York',
      });
      expect(mockFindLatest).toHaveBeenCalledWith({
        entityType: 'engagement',
        entityId: ENGAGEMENT_ID,
        action: 'engagement.created',
      });
      expect(mockGetMemberRole).toHaveBeenCalledWith('company', COMPANY_ID, BOOKER);
    });

    it('falls back to UTC when the booker has no saved zone', async () => {
      mockFindTimezone.mockResolvedValue({ savedTimezone: null, expert: null });

      await expect(resolveCallee(input('expert', EXPERT_USER))).resolves.toMatchObject({
        ok: true,
        timeZone: 'UTC',
      });
    });

    it('falls back to UTC when the user row is gone', async () => {
      mockFindTimezone.mockResolvedValue(null);

      await expect(resolveCallee(input('expert', EXPERT_USER))).resolves.toMatchObject({
        timeZone: 'UTC',
      });
    });

    it('is `no_actor` for a missing row or a NULL actor, with no membership read', async () => {
      mockFindLatest.mockResolvedValueOnce(undefined);
      await expect(resolveCallee(input('expert', EXPERT_USER))).resolves.toEqual({
        ok: false,
        reason: 'no_actor',
      });

      mockFindLatest.mockResolvedValueOnce({ actorUserId: null });
      await expect(resolveCallee(input('expert', EXPERT_USER))).resolves.toEqual({
        ok: false,
        reason: 'no_actor',
      });
      expect(mockGetMemberRole).not.toHaveBeenCalled();
      expect(mockWarn).toHaveBeenCalledTimes(2);
    });

    it('is `departed` when the booker no longer has a company role', async () => {
      mockGetMemberRole.mockResolvedValue(undefined);

      await expect(resolveCallee(input('expert', EXPERT_USER))).resolves.toEqual({
        ok: false,
        reason: 'departed',
      });
    });

    it('is `departed` when the booker’s role lacks PARTICIPATE', async () => {
      mockRoleHasCapability.mockReturnValue(false);

      await expect(resolveCallee(input('expert', EXPERT_USER))).resolves.toEqual({
        ok: false,
        reason: 'departed',
      });
    });

    it('reads the booker’s zone alongside their role, not after it', async () => {
      let releaseRole: (role: string) => void = () => undefined;
      mockGetMemberRole.mockReturnValue(
        new Promise<string>((resolve) => {
          releaseRole = resolve;
        })
      );

      const result = resolveCallee(input('expert', EXPERT_USER));
      await vi.waitFor(() => expect(mockFindTimezone).toHaveBeenCalledTimes(1));
      releaseRole('owner');

      await expect(result).resolves.toMatchObject({ ok: true, userId: BOOKER });
    });

    it('is `self` when the expert caller is the booker', async () => {
      mockFindLatest.mockResolvedValue({ actorUserId: EXPERT_USER });

      await expect(resolveCallee(input('expert', EXPERT_USER))).resolves.toEqual({
        ok: false,
        reason: 'self',
      });
    });
  });
});
