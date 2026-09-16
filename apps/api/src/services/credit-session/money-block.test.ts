import { describe, it, expect, beforeEach, vi } from 'vitest';

const {
  mockFindForClientMoneyView,
  mockFindForExpertView,
  mockFindForAdminView,
  mockFindBySession,
  mockToClientMoneyBlock,
  mockToExpertMoneyBlock,
  mockToAdminMoneyBlock,
  mockAuthorizeActor,
  mockAuthorizeExpert,
  mockWarn,
} = vi.hoisted(() => ({
  mockFindForClientMoneyView: vi.fn(),
  mockFindForExpertView: vi.fn(),
  mockFindForAdminView: vi.fn(),
  mockFindBySession: vi.fn(),
  mockToClientMoneyBlock: vi.fn(),
  mockToExpertMoneyBlock: vi.fn(),
  mockToAdminMoneyBlock: vi.fn(),
  mockAuthorizeActor: vi.fn(),
  mockAuthorizeExpert: vi.fn(),
  // ⚠ HOISTED AND SHARED (fix round 1, review finding 5). The factory below used to return a
  // FRESH `vi.fn()` per `createLogger()` call, so the warn the service actually emits was
  // unreachable from any assertion — and the service's own docblock invokes the verbatim-pin
  // rule ("dashboards key on this string"). An unassertable mock made that rule unenforced.
  mockWarn: vi.fn(),
}));

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: mockWarn, error: vi.fn() }),
}));
vi.mock('@balo/db', () => ({
  creditSessionsRepository: {
    findForClientMoneyView: mockFindForClientMoneyView,
    findForExpertView: mockFindForExpertView,
    findForAdminView: mockFindForAdminView,
  },
  expertPayoutRecordsRepository: { findBySession: mockFindBySession },
  toClientMoneyBlock: mockToClientMoneyBlock,
  toExpertMoneyBlock: mockToExpertMoneyBlock,
  toAdminMoneyBlock: mockToAdminMoneyBlock,
}));
// The real pure platform-authz map — `admin`/`super_admin` hold MANAGE_PLATFORM_FEES; `user` none.
vi.mock('./authorize-session-actor.js', () => ({ authorizeSessionActor: mockAuthorizeActor }));
vi.mock('./authorize-session-expert-visibility.js', () => ({
  authorizeSessionExpertVisibility: mockAuthorizeExpert,
}));

import { resolveSessionMoneyBlock, resolveAdminMoneyBlock } from './money-block.js';
import type { PlatformCapabilityActor } from '../../authz/platform.js';
import type { PlatformCapability } from '@balo/shared/authz';

describe('resolveSessionMoneyBlock', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockToClientMoneyBlock.mockReturnValue({ lens: 'client' });
    mockToExpertMoneyBlock.mockReturnValue({ lens: 'expert' });
    mockFindForClientMoneyView.mockResolvedValue({ id: 'session_1' });
    mockFindForExpertView.mockResolvedValue({ id: 'session_1' });
  });

  it('resolves the CLIENT lens for a company member', async () => {
    mockAuthorizeActor.mockResolvedValue({ ok: true, session: {}, role: 'member' });
    const res = await resolveSessionMoneyBlock('session_1', 'user_1');
    expect(res).toEqual({ ok: true, block: { lens: 'client' } });
    // The expert gate is never consulted for a company member.
    expect(mockAuthorizeExpert).not.toHaveBeenCalled();
    expect(mockToExpertMoneyBlock).not.toHaveBeenCalled();
  });

  it('falls through to the EXPERT lens (with payout status) when not a member', async () => {
    mockAuthorizeActor.mockResolvedValue({ ok: false, code: 'forbidden' });
    mockAuthorizeExpert.mockResolvedValue({ ok: true, session: {}, expertProfileId: 'expert_1' });
    mockFindBySession.mockResolvedValue({ status: 'recorded' });
    const res = await resolveSessionMoneyBlock('session_1', 'expert_user');
    expect(res).toEqual({ ok: true, block: { lens: 'expert' } });
    expect(mockToExpertMoneyBlock).toHaveBeenCalledWith({ id: 'session_1' }, 'recorded');
    // A client never receives the expert lens (and vice versa).
    expect(mockToClientMoneyBlock).not.toHaveBeenCalled();
  });

  it('404s (hides existence) for a stranger — neither member nor expert', async () => {
    mockAuthorizeActor.mockResolvedValue({ ok: false, code: 'forbidden' });
    mockAuthorizeExpert.mockResolvedValue({ ok: false, code: 'forbidden' });
    const res = await resolveSessionMoneyBlock('session_1', 'stranger');
    expect(res).toEqual({ ok: false, code: 'not_found' });
  });

  it('404s a member when the projection read returns nothing (raced delete)', async () => {
    mockAuthorizeActor.mockResolvedValue({ ok: true, session: {}, role: 'member' });
    mockFindForClientMoneyView.mockResolvedValue(undefined);
    const res = await resolveSessionMoneyBlock('session_1', 'user_1');
    expect(res).toEqual({ ok: false, code: 'not_found' });
  });
});

/**
 * BAL-560 (D11) — `resolveAdminMoneyBlock` takes the ACTOR, not a bare `platformRole` string.
 * `PlatformCapabilityActor.platformCapabilities` is REQUIRED, so a caller that still has only a
 * role string is a COMPILE error rather than a silent bypass — which is what turned this
 * signature widening from an optional tidy-up into a mandatory one.
 */
function actor(
  platformRole: string,
  platformCapabilities: PlatformCapability[] | null = null
): PlatformCapabilityActor {
  return { platformRole, platformCapabilities };
}

describe('resolveAdminMoneyBlock', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockToAdminMoneyBlock.mockReturnValue({ lens: 'admin', marginAudMinor: 3750 });
  });

  it('serializes the admin (margin-bearing) block for a platform-staff role', async () => {
    mockFindForAdminView.mockResolvedValue({ id: 'session_1' });
    const result = await resolveAdminMoneyBlock('session_1', actor('admin'));
    expect(result).toEqual({ ok: true, block: { lens: 'admin', marginAudMinor: 3750 } });
  });

  it('SELF-ASSERTS the capability — a non-privileged role is forbidden WITHOUT reading the session', async () => {
    const result = await resolveAdminMoneyBlock('session_1', actor('user'));
    expect(result).toEqual({ ok: false, code: 'forbidden' });
    // Defense-in-depth: never touches the margin-bearing view for a role that lacks the capability.
    expect(mockFindForAdminView).not.toHaveBeenCalled();
    expect(mockToAdminMoneyBlock).not.toHaveBeenCalled();
  });

  /**
   * ⚠ VERBATIM LOG PIN (fix round 1, review finding 5; memory
   * `feedback_monitor_strings_need_verbatim_pin`). The service's docblock says BAL-560 preserved
   * this line's key set and message "byte-for-byte" because dashboards key on both — a claim
   * nothing held, because the logging mock handed out a fresh `vi.fn()` per call. It is held now.
   *
   * The message is asserted against the FULL literal, not `stringContaining`, and the payload
   * against the EXACT key set, not `objectContaining`: a widened payload (e.g. leaking the
   * override itself into logs) must fail here, and so must a reworded message.
   */
  it('emits the refusal warn with the EXACT key set and the VERBATIM message', async () => {
    await resolveAdminMoneyBlock('session_1', actor('user'));

    expect(mockWarn).toHaveBeenCalledTimes(1);
    const call = mockWarn.mock.calls[0];
    expect(call, 'the warn must have been captured').toBeDefined();
    if (call === undefined) return;

    const [payload, message] = call as [Record<string, unknown>, string];
    expect(Object.keys(payload).sort()).toEqual(['platformRole', 'sessionId']);
    expect(payload).toEqual({ sessionId: 'session_1', platformRole: 'user' });
    expect(message).toBe(
      'Admin money-block denied at the service boundary — role lacks MANAGE_PLATFORM_FEES'
    );
  });

  it('the refusal warn NEVER carries the override itself — it is an authorization input, not log data', async () => {
    await resolveAdminMoneyBlock('session_1', actor('admin', ['view_platform_admin']));

    expect(mockWarn).toHaveBeenCalledTimes(1);
    const call = mockWarn.mock.calls[0];
    expect(call).toBeDefined();
    if (call === undefined) return;
    const [payload] = call as [Record<string, unknown>, string];
    expect(Object.keys(payload).sort()).toEqual(['platformRole', 'sessionId']);
    expect(payload).not.toHaveProperty('platformCapabilities');
  });

  it('returns not_found when the session is missing (staff role)', async () => {
    mockFindForAdminView.mockResolvedValue(undefined);
    const result = await resolveAdminMoneyBlock('nope', actor('super_admin'));
    expect(result).toEqual({ ok: false, code: 'not_found' });
    expect(mockToAdminMoneyBlock).not.toHaveBeenCalled();
  });

  /**
   * ⚠ THE FEE-BLIND STAFF VIEWER, PROVEN REACHABLE AT THE MONEY BOUNDARY. This is the shape
   * BAL-551 wants and the reason the column exists: an `admin` ROW whose per-user override omits
   * `MANAGE_PLATFORM_FEES`. Before BAL-560 the bare role string made this inexpressible — the
   * service would have served them the margin-bearing block.
   *
   * ⚠ D12 limitation, stated so nobody infers otherwise from this test: such a viewer still
   * receives the ADMIN LENS and still sees the admin surfaces. Only capability-gated FIELDS
   * narrow. The lens resolvers are deliberately untouched by this ticket.
   */
  it('BAL-560: an override that REMOVES manage_platform_fees from an admin is forbidden, without reading the view', async () => {
    const result = await resolveAdminMoneyBlock(
      'session_1',
      actor('admin', ['view_platform_admin', 'manage_promo_codes'])
    );
    expect(result).toEqual({ ok: false, code: 'forbidden' });
    expect(mockFindForAdminView).not.toHaveBeenCalled();
    expect(mockToAdminMoneyBlock).not.toHaveBeenCalled();
  });

  it('BAL-560: an EMPTY override is forbidden too — "holds nothing" revokes the whole role bundle', async () => {
    const result = await resolveAdminMoneyBlock('session_1', actor('super_admin', []));
    expect(result).toEqual({ ok: false, code: 'forbidden' });
    expect(mockFindForAdminView).not.toHaveBeenCalled();
  });

  it('BAL-560: an override that GRANTS manage_platform_fees to a role lacking it is served', async () => {
    mockFindForAdminView.mockResolvedValue({ id: 'session_1' });
    // A `super_admin` row narrowed to exactly one token still holds THAT token.
    const result = await resolveAdminMoneyBlock(
      'session_1',
      actor('super_admin', ['manage_platform_fees'])
    );
    expect(result).toEqual({ ok: true, block: { lens: 'admin', marginAudMinor: 3750 } });
  });

  it('BAL-560: a NULL override resolves byte-identically to the role bundle (the migration no-op)', async () => {
    mockFindForAdminView.mockResolvedValue({ id: 'session_1' });
    const withNull = await resolveAdminMoneyBlock('session_1', actor('admin', null));
    const withUndefined = await resolveAdminMoneyBlock('session_1', actor('admin', undefined));
    expect(withNull).toEqual({ ok: true, block: { lens: 'admin', marginAudMinor: 3750 } });
    expect(withUndefined).toEqual(withNull);
  });
});
