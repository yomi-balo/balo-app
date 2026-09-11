import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SessionUser } from '@/lib/auth/session';

const { mockListApplicationsForReview } = vi.hoisted(() => ({
  mockListApplicationsForReview: vi.fn(),
}));

vi.mock('@balo/db', () => ({
  expertsRepository: { listApplicationsForReview: mockListApplicationsForReview },
}));

import { loadApplications } from './load-applications';
import { APPLICATION_LIST_LIMIT } from './application-list-view';

function user(overrides: Partial<SessionUser> = {}): SessionUser {
  return {
    id: 'user-x',
    email: 'x@example.com',
    firstName: 'X',
    lastName: 'Y',
    avatarUrl: null,
    activeMode: 'client',
    onboardingCompleted: true,
    platformRole: 'admin',
    companyId: 'company-1',
    companyName: 'Northwind Industrial',
    companyRole: 'owner',
    ...overrides,
  };
}

const EMPTY_LIST = {
  rows: [],
  counts: { pending: 0, approved: 0, declined: 0 },
  truncated: false,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('loadApplications — the authorization proof', () => {
  it('a non-staff user gets { ok: false, reason: forbidden } and the repository is never called', async () => {
    const dto = await loadApplications(user({ platformRole: 'user' }), 'pending');
    expect(dto).toEqual({ ok: false, reason: 'forbidden' });
    expect(mockListApplicationsForReview).not.toHaveBeenCalled();
  });

  it('staff calls the repository exactly once with the requested filter and the caller-side limit', async () => {
    mockListApplicationsForReview.mockResolvedValue(EMPTY_LIST);
    const dto = await loadApplications(user({ platformRole: 'admin' }), 'pending');
    expect(mockListApplicationsForReview).toHaveBeenCalledTimes(1);
    expect(mockListApplicationsForReview).toHaveBeenCalledWith({
      filter: 'pending',
      decidedSince: expect.any(Date),
      limit: APPLICATION_LIST_LIMIT,
    });
    expect(dto).toEqual({ ok: true, ...EMPTY_LIST });
  });

  it('a super_admin is also staff', async () => {
    mockListApplicationsForReview.mockResolvedValue(EMPTY_LIST);
    await loadApplications(user({ platformRole: 'super_admin' }), 'declined');
    expect(mockListApplicationsForReview).toHaveBeenCalledTimes(1);
  });

  it('passes rows, counts and truncated straight through', async () => {
    const list = {
      rows: [
        {
          expertProfileId: 'p1',
          applicantUserId: 'u1',
          firstName: 'Priya',
          lastName: 'Shah',
          email: 'priya@example.com',
          agencyName: null,
          applicationStatus: 'submitted',
          submittedAt: new Date('2026-01-01'),
          decidedAt: null,
          decidedByFirstName: null,
          decidedByLastName: null,
          declineReason: null,
        },
      ],
      counts: { pending: 1, approved: 0, declined: 0 },
      truncated: false,
    };
    mockListApplicationsForReview.mockResolvedValue(list);
    const dto = await loadApplications(user(), 'pending');
    expect(dto).toEqual({ ok: true, ...list });
  });

  it('uses a decidedSince roughly DECIDED_WINDOW_DAYS in the past', async () => {
    mockListApplicationsForReview.mockResolvedValue(EMPTY_LIST);
    const before = Date.now();
    await loadApplications(user(), 'approved');
    const calls = mockListApplicationsForReview.mock.calls as [{ decidedSince: Date }][];
    const [call] = calls;
    if (call === undefined) throw new Error('expected the repository to have been called');
    const [{ decidedSince }] = call;
    expect(decidedSince).toBeInstanceOf(Date);
    const expectedMs = before - 30 * 86_400_000;
    expect(Math.abs(decidedSince.getTime() - expectedMs)).toBeLessThan(5000);
  });
});
