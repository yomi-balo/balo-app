import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetMemberRole, mockHasEngagementCapability, mockWarn } = vi.hoisted(() => ({
  mockGetMemberRole: vi.fn(),
  mockHasEngagementCapability: vi.fn(),
  mockWarn: vi.fn(),
}));

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: mockWarn, error: vi.fn() }),
}));
vi.mock('@balo/db', () => ({
  partyMembershipsRepository: { getMemberRole: mockGetMemberRole },
}));
vi.mock('./authorize-engagement-host.js', () => ({
  hasEngagementCapability: mockHasEngagementCapability,
}));
// ⚠ `@balo/shared/authz` and `@balo/shared/meetings` are DELIBERATELY NOT MOCKED. The REAL
// role→capability map is what the `member` / agency-`expert` rows below are asserting, and the
// real `canEndMeeting` is the rule under test. Mocking either would make this file assert its
// own fixtures.

import { ENGAGEMENT_CAPABILITIES } from '@balo/shared/authz';
import { resolveEndAuthority, logEndAuthorityDenied } from './authorize-end-meeting.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const COMPANY_ID = '33333333-3333-4333-8333-333333333333';
const MEETING_ID = '22222222-2222-4222-8222-222222222222';
const SUBJECT = { contextType: 'case', contextId: '44444444-4444-4444-8444-444444444444' } as const;

function authorityFor(companyRole: string | undefined, isExpertHost: boolean) {
  mockGetMemberRole.mockResolvedValue(companyRole);
  mockHasEngagementCapability.mockResolvedValue(isExpertHost);
  return resolveEndAuthority({ userId: USER_ID, companyId: COMPANY_ID, subject: SUBJECT });
}

describe('resolveEndAuthority (BAL-134 D6 + D7)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('NEITHER — no company membership and no host capability', async () => {
    await expect(authorityFor(undefined, false)).resolves.toEqual({
      canEndMeeting: false,
      endedBy: null,
      isExpertHost: false,
      isClientPrincipal: false,
    });
  });

  it('EXPERT HOST only — `expert_host`', async () => {
    await expect(authorityFor(undefined, true)).resolves.toMatchObject({
      canEndMeeting: true,
      endedBy: 'expert_host',
    });
  });

  /**
   * ⚠ D6 — `CONSUME_CREDITS` SITS IN THE BASE MEMBER BUNDLE, so a plain `member` may end their
   * own consultation. `MANAGE_BILLING` would have been owner/admin-only and would have stopped
   * exactly the person the ADR names ("a delegate acting for the booker").
   */
  it.each(['owner', 'admin', 'member'] as const)(
    'CLIENT PRINCIPAL — a company `%s` may end, as `client_principal`',
    async (role) => {
      await expect(authorityFor(role, false)).resolves.toMatchObject({
        canEndMeeting: true,
        endedBy: 'client_principal',
        isClientPrincipal: true,
      });
    }
  );

  it('BOTH — the expert label wins the (unreachable) tie', async () => {
    await expect(authorityFor('owner', true)).resolves.toMatchObject({
      canEndMeeting: true,
      endedBy: 'expert_host',
    });
  });

  /**
   * ⚠⚠ D6's SECOND HONEST POINT: an agency `expert` shares the base member bundle, so this is
   * the one case where the token choice genuinely narrows. `CONSUME_CREDITS` is only ever
   * resolved with a **COMPANY** scope, and an agency-side actor holds no company membership —
   * so the client arm is unreachable for them and the expert side must come through the
   * engagement axis or not at all.
   */
  it('⚠ an AGENCY `expert` cannot satisfy the CLIENT arm — it is company-scoped by construction', async () => {
    const authority = await authorityFor(undefined, false);

    expect(authority.isClientPrincipal).toBe(false);
    expect(authority.canEndMeeting).toBe(false);
    // The scope actually asked for is a COMPANY, never an agency.
    expect(mockGetMemberRole).toHaveBeenCalledWith('company', COMPANY_ID, USER_ID);
  });

  /**
   * ⚠ A GUEST HAS NO `company_members` ROW AT ALL, so `getMemberRole` answers `undefined` and
   * every membership token fails closed. The narrowing is STRUCTURAL, not token-driven.
   */
  it('⚠ a GUEST (no membership row) fails closed on both arms', async () => {
    await expect(authorityFor(undefined, false)).resolves.toMatchObject({
      canEndMeeting: false,
      endedBy: null,
    });
  });

  it('asks the ENGAGEMENT axis for HOST_MEETINGS, on the gate-resolved subject', async () => {
    await authorityFor(undefined, true);

    expect(mockHasEngagementCapability).toHaveBeenCalledWith(
      { id: USER_ID },
      ENGAGEMENT_CAPABILITIES.HOST_MEETINGS,
      SUBJECT
    );
  });

  it('⚠ resolves both axes CONCURRENTLY — this is on the path of a button that must always work', async () => {
    let membershipSettled = false;
    mockGetMemberRole.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      membershipSettled = true;
      return undefined;
    });
    mockHasEngagementCapability.mockImplementation(async () => {
      // If these ran in sequence, the membership read would already have finished.
      expect(membershipSettled).toBe(false);
      return false;
    });

    await resolveEndAuthority({ userId: USER_ID, companyId: COMPANY_ID, subject: SUBJECT });
  });

  it('⚠ never answers `system_idle` — that label belongs to the sweep, not to an actor', async () => {
    for (const [role, host] of [
      [undefined, false],
      ['member', false],
      [undefined, true],
      ['owner', true],
    ] as const) {
      const authority = await authorityFor(role, host);
      expect(authority.endedBy).not.toBe('system_idle');
    }
  });
});

describe('logEndAuthorityDenied', () => {
  it('logs the SHAPE — the wire gets one literal and never this detail', () => {
    logEndAuthorityDenied(
      MEETING_ID,
      USER_ID,
      { canEndMeeting: false, endedBy: null, isExpertHost: false, isClientPrincipal: false },
      'client'
    );

    expect(mockWarn).toHaveBeenCalledWith(
      {
        meetingId: MEETING_ID,
        userId: USER_ID,
        side: 'client',
        isExpertHost: false,
        isClientPrincipal: false,
        reason: 'no_end_authority',
      },
      'Meeting end denied'
    );
  });
});
