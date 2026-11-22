import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockFindCase,
  mockGetMemberRole,
  mockRoleHasCapability,
  mockHasEngagementCapability,
  mockFindExpertUserId,
} = vi.hoisted(() => ({
  mockFindCase: vi.fn(),
  mockGetMemberRole: vi.fn(),
  mockRoleHasCapability: vi.fn(),
  mockHasEngagementCapability: vi.fn(),
  mockFindExpertUserId: vi.fn(),
}));

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('@balo/db', () => ({
  caseEngagementsRepository: { findByEngagementId: mockFindCase },
  partyMembershipsRepository: { getMemberRole: mockGetMemberRole },
  expertsRepository: { findUserIdByProfileId: mockFindExpertUserId },
}));
vi.mock('@balo/shared/authz', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@balo/shared/authz')>()),
  roleHasCapability: mockRoleHasCapability,
}));
vi.mock('../meetings/authorize-engagement-host.js', () => ({
  hasEngagementCapability: mockHasEngagementCapability,
}));

import { CAPABILITIES, ENGAGEMENT_CAPABILITIES } from '@balo/shared/authz';
import { authorizeCallNow } from './authorize-call-now.js';

const ENGAGEMENT_ID = '33333333-3333-4333-8333-333333333333';
const COMPANY_ID = '44444444-4444-4444-8444-444444444444';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const EXPERT_PROFILE_ID = '66666666-6666-4666-8666-666666666666';
const CASE_ROW = {
  id: ENGAGEMENT_ID,
  companyId: COMPANY_ID,
  expertProfileId: EXPERT_PROFILE_ID,
  closedAt: new Date('2026-01-01'),
};

describe('authorizeCallNow (AC11)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindCase.mockResolvedValue(CASE_ROW);
    mockGetMemberRole.mockResolvedValue(undefined);
    mockRoleHasCapability.mockReturnValue(true);
    mockHasEngagementCapability.mockResolvedValue(false);
    mockFindExpertUserId.mockResolvedValue({ user: { id: USER_ID } });
  });

  it('denies an unknown case with the single `case_not_found` literal and reads nothing else', async () => {
    mockFindCase.mockResolvedValue(undefined);

    await expect(
      authorizeCallNow({ engagementId: ENGAGEMENT_ID, userId: USER_ID })
    ).resolves.toEqual({
      ok: false,
      code: 'case_not_found',
    });
    expect(mockGetMemberRole).not.toHaveBeenCalled();
    expect(mockHasEngagementCapability).not.toHaveBeenCalled();
  });

  it('client arm: a company role holding PARTICIPATE is the client side', async () => {
    mockGetMemberRole.mockResolvedValue('member');

    const result = await authorizeCallNow({ engagementId: ENGAGEMENT_ID, userId: USER_ID });

    expect(result).toEqual({ ok: true, side: 'client', caseRow: CASE_ROW, mayRing: true });
    expect(mockGetMemberRole).toHaveBeenCalledWith('company', COMPANY_ID, USER_ID);
    expect(mockRoleHasCapability).toHaveBeenCalledWith('member', CAPABILITIES.PARTICIPATE);
  });

  it('a user with a company role is judged on the client arm only, even when refused PARTICIPATE and a host', async () => {
    mockGetMemberRole.mockResolvedValue('member');
    mockRoleHasCapability.mockReturnValue(false);
    mockHasEngagementCapability.mockResolvedValue(true);

    // The host read runs alongside the membership read; its answer is never used for a member.
    await expect(
      authorizeCallNow({ engagementId: ENGAGEMENT_ID, userId: USER_ID })
    ).resolves.toEqual({
      ok: false,
      code: 'case_not_found',
    });
  });

  it('answers a client caller without waiting on the expert-side reads', async () => {
    mockGetMemberRole.mockResolvedValue('member');
    mockRoleHasCapability.mockReturnValue(true);
    mockHasEngagementCapability.mockReturnValue(new Promise(() => undefined));

    await expect(
      authorizeCallNow({ engagementId: ENGAGEMENT_ID, userId: USER_ID })
    ).resolves.toMatchObject({ ok: true, side: 'client' });
  });

  it('a failed expert-side read never fails a client caller', async () => {
    mockGetMemberRole.mockResolvedValue('member');
    mockRoleHasCapability.mockReturnValue(true);
    mockHasEngagementCapability.mockRejectedValue(new Error('db down'));

    await expect(
      authorizeCallNow({ engagementId: ENGAGEMENT_ID, userId: USER_ID })
    ).resolves.toMatchObject({ ok: true, side: 'client' });
  });

  it('a failed expert-side read fails an expert caller', async () => {
    mockHasEngagementCapability.mockRejectedValue(new Error('db down'));

    await expect(
      authorizeCallNow({ engagementId: ENGAGEMENT_ID, userId: USER_ID })
    ).rejects.toThrow('db down');
  });

  it('reads the role, the host capability and the delivering expert together, not in series', async () => {
    let releaseRole: (role: undefined) => void = () => undefined;
    mockGetMemberRole.mockReturnValue(
      new Promise<undefined>((resolve) => {
        releaseRole = resolve;
      })
    );
    mockHasEngagementCapability.mockResolvedValue(true);

    const result = authorizeCallNow({ engagementId: ENGAGEMENT_ID, userId: USER_ID });
    await vi.waitFor(() => {
      expect(mockHasEngagementCapability).toHaveBeenCalledTimes(1);
      expect(mockFindExpertUserId).toHaveBeenCalledTimes(1);
    });
    releaseRole(undefined);

    await expect(result).resolves.toMatchObject({ ok: true, side: 'expert' });
  });

  it('expert arm: no company role and HOST_MEETINGS on this case is the expert side', async () => {
    mockHasEngagementCapability.mockResolvedValue(true);

    const result = await authorizeCallNow({ engagementId: ENGAGEMENT_ID, userId: USER_ID });

    expect(result).toEqual({ ok: true, side: 'expert', caseRow: CASE_ROW, mayRing: true });
    expect(mockHasEngagementCapability).toHaveBeenCalledWith(
      { id: USER_ID },
      ENGAGEMENT_CAPABILITIES.HOST_MEETINGS,
      { contextType: 'case', contextId: ENGAGEMENT_ID }
    );
    expect(mockFindExpertUserId).toHaveBeenCalledWith(EXPERT_PROFILE_ID);
  });

  it('⚠ expert arm: an agency owner/admin holding HOST_MEETINGS may view but NOT ring — identity, not role', async () => {
    mockHasEngagementCapability.mockResolvedValue(true);
    mockFindExpertUserId.mockResolvedValue({ user: { id: 'delivering-expert-user' } });

    const result = await authorizeCallNow({ engagementId: ENGAGEMENT_ID, userId: USER_ID });

    expect(result).toEqual({ ok: true, side: 'expert', caseRow: CASE_ROW, mayRing: false });
  });

  it('expert arm: an unreadable delivering expert fails closed — may not ring', async () => {
    mockHasEngagementCapability.mockResolvedValue(true);
    mockFindExpertUserId.mockResolvedValue(undefined);

    await expect(
      authorizeCallNow({ engagementId: ENGAGEMENT_ID, userId: USER_ID })
    ).resolves.toMatchObject({ ok: true, mayRing: false });
  });

  it('a non-member without the engagement capability (agency role `expert`, stranger) is `case_not_found`', async () => {
    await expect(
      authorizeCallNow({ engagementId: ENGAGEMENT_ID, userId: USER_ID })
    ).resolves.toEqual({
      ok: false,
      code: 'case_not_found',
    });
  });

  it('does not gate on the case being open: a closed case still authorizes its member', async () => {
    mockGetMemberRole.mockResolvedValue('owner');

    const result = await authorizeCallNow({ engagementId: ENGAGEMENT_ID, userId: USER_ID });

    expect(result).toMatchObject({ ok: true, side: 'client' });
  });
});

describe('services/call-now never branches on a role, lens or active mode (ADR-1029)', () => {
  const dir = dirname(fileURLToPath(import.meta.url));
  const sources = readdirSync(dir)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map((name) => ({ name, text: readFileSync(join(dir, name), 'utf8') }));

  it('scans a non-empty set of source files', () => {
    expect(sources.length).toBeGreaterThan(5);
  });

  it.each(['role', 'platformRole', 'lens', 'activeMode'])(
    "has no `%s ===` / `%s !== '…'` comparison against a string literal",
    (identifier) => {
      const offenders = sources.filter(({ text }) => {
        const code = text
          .split('\n')
          .filter((line) => !line.trimStart().startsWith('*') && !line.trimStart().startsWith('//'))
          .join('\n');
        return [`${identifier} === '`, `${identifier} !== '`, `${identifier}Side === '`].some(
          (needle) => code.includes(needle)
        );
      });
      expect(offenders.map((o) => o.name)).toEqual([]);
    }
  );
});
