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
}));

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
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
vi.mock('./authorize-session-expert.js', () => ({ authorizeSessionExpert: mockAuthorizeExpert }));

import { resolveSessionMoneyBlock, resolveAdminMoneyBlock } from './money-block.js';

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

describe('resolveAdminMoneyBlock', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockToAdminMoneyBlock.mockReturnValue({ lens: 'admin', marginAudMinor: 3750 });
  });

  it('serializes the admin (margin-bearing) block for a platform-staff role', async () => {
    mockFindForAdminView.mockResolvedValue({ id: 'session_1' });
    const result = await resolveAdminMoneyBlock('session_1', 'admin');
    expect(result).toEqual({ ok: true, block: { lens: 'admin', marginAudMinor: 3750 } });
  });

  it('SELF-ASSERTS the capability — a non-privileged role is forbidden WITHOUT reading the session', async () => {
    const result = await resolveAdminMoneyBlock('session_1', 'user');
    expect(result).toEqual({ ok: false, code: 'forbidden' });
    // Defense-in-depth: never touches the margin-bearing view for a role that lacks the capability.
    expect(mockFindForAdminView).not.toHaveBeenCalled();
    expect(mockToAdminMoneyBlock).not.toHaveBeenCalled();
  });

  it('returns not_found when the session is missing (staff role)', async () => {
    mockFindForAdminView.mockResolvedValue(undefined);
    const result = await resolveAdminMoneyBlock('nope', 'super_admin');
    expect(result).toEqual({ ok: false, code: 'not_found' });
    expect(mockToAdminMoneyBlock).not.toHaveBeenCalled();
  });
});
