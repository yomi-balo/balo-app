import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockGetCallNowRing,
  mockResolveCaseAccess,
  mockFindCompanyName,
  mockFindDisplayProfile,
  mockFindDisplayUser,
  mockLog,
} = vi.hoisted(() => ({
  mockGetCallNowRing: vi.fn(),
  mockResolveCaseAccess: vi.fn(),
  mockFindCompanyName: vi.fn(),
  mockFindDisplayProfile: vi.fn(),
  mockFindDisplayUser: vi.fn(),
  mockLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('server-only', () => ({}));
vi.mock('@balo/db', () => ({
  companiesRepository: { findNameById: mockFindCompanyName },
  expertsRepository: { findDisplayProfileById: mockFindDisplayProfile },
  usersRepository: { findDisplayById: mockFindDisplayUser },
}));
vi.mock('@/lib/call-now/call-now-api-client', () => ({ getCallNowRing: mockGetCallNowRing }));
vi.mock('@/lib/cases/resolve-case-access', () => ({ resolveCaseAccess: mockResolveCaseAccess }));
vi.mock('@/lib/logging', () => ({ log: mockLog }));

import { loadCallNowCallerView } from './load-call-now-caller-view';

const RING_ID = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const MEETING_ID = '0f7b1c2d-3e4f-4a5b-8c9d-0e1f2a3b4c5d';
const USER_ID = '11111111-2222-4333-8444-555555555555';
const ENGAGEMENT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const COMPANY_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const EXPERT_PROFILE_ID = '88888888-8888-4888-8888-888888888888';
const EXPIRES = '2026-11-19T10:00:45.000Z';

const INPUT = { ringId: RING_ID, meetingId: MEETING_ID, userId: USER_ID };

function ring(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ringId: RING_ID,
    meetingId: MEETING_ID,
    engagementId: ENGAGEMENT_ID,
    status: 'ringing',
    placement: 'new_meeting',
    expiresAt: EXPIRES,
    role: 'caller',
    awaitsAnswer: false,
    meetingEnded: false,
    reachedBy: 'sms',
    ...overrides,
  };
}

function access(lens: 'client' | 'expert', conversationWritable = true): Record<string, unknown> {
  return {
    lens,
    engagementId: ENGAGEMENT_ID,
    companyId: COMPANY_ID,
    expertProfileId: EXPERT_PROFILE_ID,
    conversationWritable,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetCallNowRing.mockResolvedValue({ ok: true, data: ring() });
  mockResolveCaseAccess.mockResolvedValue(access('client'));
  mockFindCompanyName.mockResolvedValue({ id: COMPANY_ID, name: 'Northwind' });
  mockFindDisplayProfile.mockResolvedValue({
    id: EXPERT_PROFILE_ID,
    userId: 'expert-user',
    publicProfileUsername: 'dana-okoro',
  });
  mockFindDisplayUser.mockResolvedValue({
    id: 'expert-user',
    firstName: 'Dana',
    lastName: 'Okoro',
  });
});

describe('loadCallNowCallerView', () => {
  it('client lens: the expert’s first name, the ring facts and a bookable expert', async () => {
    await expect(loadCallNowCallerView(INPUT)).resolves.toEqual({
      ringId: RING_ID,
      engagementId: ENGAGEMENT_ID,
      meetingId: MEETING_ID,
      copyArm: 'client',
      status: 'ringing',
      expiresAtIso: EXPIRES,
      reachedBy: 'sms',
      calleeLabel: 'Dana',
      bookInPage: true,
    });
    expect(mockResolveCaseAccess).toHaveBeenCalledWith(ENGAGEMENT_ID, USER_ID);
    expect(mockFindCompanyName).not.toHaveBeenCalled();
  });

  it('client lens: an expert with no public profile is not bookable in the page', async () => {
    mockFindDisplayProfile.mockResolvedValue({
      id: EXPERT_PROFILE_ID,
      userId: 'expert-user',
      publicProfileUsername: null,
    });

    await expect(loadCallNowCallerView(INPUT)).resolves.toMatchObject({ bookInPage: false });
  });

  it('client lens: a closed case is not bookable in the page', async () => {
    mockResolveCaseAccess.mockResolvedValue(access('client', false));

    await expect(loadCallNowCallerView(INPUT)).resolves.toMatchObject({ bookInPage: false });
  });

  it('client lens: an unreadable expert name falls back to neutral copy', async () => {
    mockFindDisplayUser.mockResolvedValue(undefined);

    await expect(loadCallNowCallerView(INPUT)).resolves.toMatchObject({
      calleeLabel: 'your expert',
    });
  });

  it('client lens: a missing expert profile is neutral and not bookable', async () => {
    mockFindDisplayProfile.mockResolvedValue(undefined);

    await expect(loadCallNowCallerView(INPUT)).resolves.toMatchObject({
      calleeLabel: 'your expert',
      bookInPage: false,
    });
    expect(mockFindDisplayUser).not.toHaveBeenCalled();
  });

  it('expert lens: the client company, never bookable', async () => {
    mockResolveCaseAccess.mockResolvedValue(access('expert'));

    await expect(loadCallNowCallerView(INPUT)).resolves.toMatchObject({
      copyArm: 'expert',
      calleeLabel: 'Northwind',
      bookInPage: false,
    });
    expect(mockFindDisplayProfile).not.toHaveBeenCalled();
  });

  it('expert lens: an unreadable company falls back to neutral copy', async () => {
    mockResolveCaseAccess.mockResolvedValue(access('expert'));
    mockFindCompanyName.mockResolvedValue(undefined);

    await expect(loadCallNowCallerView(INPUT)).resolves.toMatchObject({
      calleeLabel: 'the client',
    });
  });

  it('⚠ a ring the viewer is not the caller of is absent', async () => {
    mockGetCallNowRing.mockResolvedValue({ ok: true, data: ring({ role: 'callee' }) });
    await expect(loadCallNowCallerView(INPUT)).resolves.toBeNull();

    mockGetCallNowRing.mockResolvedValue({ ok: true, data: ring({ role: null }) });
    await expect(loadCallNowCallerView(INPUT)).resolves.toBeNull();
    expect(mockResolveCaseAccess).not.toHaveBeenCalled();
  });

  it('⚠ a ring for a different meeting is absent', async () => {
    mockGetCallNowRing.mockResolvedValue({
      ok: true,
      data: ring({ meetingId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' }),
    });

    await expect(loadCallNowCallerView(INPUT)).resolves.toBeNull();
  });

  it('a viewer who has lost the case is absent', async () => {
    mockResolveCaseAccess.mockResolvedValue(null);

    await expect(loadCallNowCallerView(INPUT)).resolves.toBeNull();
  });

  it('degrades to absent on an api failure, logging anything but a 404', async () => {
    mockGetCallNowRing.mockResolvedValue({ ok: false, status: 503, code: 'request_failed' });
    await expect(loadCallNowCallerView(INPUT)).resolves.toBeNull();
    expect(mockLog.warn).toHaveBeenCalledTimes(1);

    mockLog.warn.mockClear();
    mockGetCallNowRing.mockResolvedValue({ ok: false, status: 404, code: 'ring_not_found' });
    await expect(loadCallNowCallerView(INPUT)).resolves.toBeNull();
    expect(mockLog.warn).not.toHaveBeenCalled();
  });

  it('degrades to absent and logs when a read throws', async () => {
    mockResolveCaseAccess.mockRejectedValue(new Error('db down'));

    await expect(loadCallNowCallerView(INPUT)).resolves.toBeNull();
    expect(mockLog.warn).toHaveBeenCalledWith(
      'Call room could not load its ring view',
      expect.objectContaining({ ringId: RING_ID, meetingId: MEETING_ID, error: 'db down' })
    );
  });
});
