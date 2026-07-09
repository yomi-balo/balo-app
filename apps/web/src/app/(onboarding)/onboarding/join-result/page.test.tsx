import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/utils';

// ── Mocks ───────────────────────────────────────────────────────
// `redirect` throws (mirroring Next's NEXT_REDIRECT control-flow throw) so we can
// assert the target. The repos + session are mocked; `@/lib/logging` is globally
// mocked in test/setup.ts. `JoinResultView` is stubbed to a marker capturing props.

const { mockRedirect } = vi.hoisted(() => ({
  mockRedirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));
vi.mock('next/navigation', () => ({ redirect: mockRedirect }));

const { mockGetCurrentUser } = vi.hoisted(() => ({ mockGetCurrentUser: vi.fn() }));
vi.mock('@/lib/auth/session', () => ({ getCurrentUser: mockGetCurrentUser }));

const { mockCompanyFindById, mockGetMemberRole, mockFindLatest } = vi.hoisted(() => ({
  mockCompanyFindById: vi.fn(),
  mockGetMemberRole: vi.fn(),
  mockFindLatest: vi.fn(),
}));
vi.mock('@balo/db', () => ({
  companiesRepository: { findById: mockCompanyFindById },
  partyMembershipsRepository: { getMemberRole: mockGetMemberRole },
  partyJoinRequestsRepository: { findLatestByUserAndParty: mockFindLatest },
}));

const { mockView } = vi.hoisted(() => ({ mockView: vi.fn() }));
vi.mock('../_components/join-result-view', () => ({
  JoinResultView: (props: Record<string, unknown>) => {
    mockView(props);
    return <div data-testid="join-result-view" />;
  },
}));

import JoinResultPage from './page';

const PARTY = 'company-1';

function run(searchParams: Record<string, string | string[] | undefined>) {
  return JoinResultPage({ searchParams });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetCurrentUser.mockResolvedValue({ id: 'user-1', onboardingCompleted: false });
  mockCompanyFindById.mockResolvedValue({ id: PARTY, name: 'Acme' });
  mockGetMemberRole.mockResolvedValue('member');
  mockFindLatest.mockResolvedValue({ id: 'req-1', status: 'declined' });
});

// ── Tests ───────────────────────────────────────────────────────

describe('JoinResultPage — auth + param parsing', () => {
  it('redirects to /login when unauthenticated', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    await expect(run({ status: 'approved', party: PARTY })).rejects.toThrow('REDIRECT:/login');
  });

  it('redirects to /dashboard for an invalid status', async () => {
    await expect(run({ status: 'bogus', party: PARTY })).rejects.toThrow('REDIRECT:/dashboard');
    expect(mockCompanyFindById).not.toHaveBeenCalled();
  });

  it('redirects to /dashboard when the party id is missing', async () => {
    await expect(run({ status: 'approved' })).rejects.toThrow('REDIRECT:/dashboard');
  });

  it('redirects to /dashboard when the company is not found', async () => {
    mockCompanyFindById.mockResolvedValue(undefined);
    await expect(run({ status: 'approved', party: PARTY })).rejects.toThrow('REDIRECT:/dashboard');
  });
});

describe('JoinResultPage — approved re-validation (fail closed)', () => {
  it('renders the approved phase when the user IS a live member', async () => {
    mockGetMemberRole.mockResolvedValue('member');
    const el = await run({ status: 'approved', party: PARTY });
    render(el);
    expect(screen.getByTestId('join-result-view')).toBeInTheDocument();
    expect(mockView).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'approved', companyName: 'Acme', alreadyOnboarded: false })
    );
    expect(mockGetMemberRole).toHaveBeenCalledWith('company', PARTY, 'user-1');
  });

  it('redirects to /dashboard when the approved param is forged (NOT a member)', async () => {
    mockGetMemberRole.mockResolvedValue(undefined);
    await expect(run({ status: 'approved', party: PARTY })).rejects.toThrow('REDIRECT:/dashboard');
    expect(mockView).not.toHaveBeenCalled();
  });
});

describe('JoinResultPage — declined re-validation (fail closed)', () => {
  it('renders the declined phase when the user has a genuine declined request', async () => {
    mockFindLatest.mockResolvedValue({ id: 'req-1', status: 'declined' });
    const el = await run({ status: 'declined', party: PARTY });
    render(el);
    expect(mockView).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'declined', companyName: 'Acme' })
    );
    expect(mockFindLatest).toHaveBeenCalledWith('company', PARTY, 'user-1');
  });

  it('redirects to /dashboard when there is NO request (forged param — closes the oracle)', async () => {
    mockFindLatest.mockResolvedValue(undefined);
    await expect(run({ status: 'declined', party: PARTY })).rejects.toThrow('REDIRECT:/dashboard');
    expect(mockView).not.toHaveBeenCalled();
  });

  it('redirects to /dashboard when the latest request is still PENDING (stale)', async () => {
    mockFindLatest.mockResolvedValue({ id: 'req-1', status: 'pending' });
    await expect(run({ status: 'declined', party: PARTY })).rejects.toThrow('REDIRECT:/dashboard');
    expect(mockView).not.toHaveBeenCalled();
  });

  it('redirects to /dashboard when the latest request is APPROVED (stale)', async () => {
    mockFindLatest.mockResolvedValue({ id: 'req-1', status: 'approved' });
    await expect(run({ status: 'declined', party: PARTY })).rejects.toThrow('REDIRECT:/dashboard');
    expect(mockView).not.toHaveBeenCalled();
  });
});

describe('JoinResultPage — passthrough + resilience', () => {
  it('passes alreadyOnboarded=true through when the requester already completed onboarding', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1', onboardingCompleted: true });
    const el = await run({ status: 'approved', party: PARTY });
    render(el);
    expect(mockView).toHaveBeenCalledWith(expect.objectContaining({ alreadyOnboarded: true }));
  });

  it('redirects to /dashboard (fail closed) when a re-validation read throws', async () => {
    mockGetMemberRole.mockRejectedValue(new Error('DB down'));
    await expect(run({ status: 'approved', party: PARTY })).rejects.toThrow('REDIRECT:/dashboard');
    expect(mockView).not.toHaveBeenCalled();
  });
});
