import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockSetJoinMode, mockGetMemberRole, mockFindById } = vi.hoisted(() => ({
  mockSetJoinMode: vi.fn(),
  mockGetMemberRole: vi.fn(),
  mockFindById: vi.fn(),
}));

vi.mock('@balo/db', () => ({
  companiesRepository: { setDomainJoinMode: mockSetJoinMode, findById: mockFindById },
  partyMembershipsRepository: { getMemberRole: mockGetMemberRole },
}));

const mockRequireUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({ requireUser: () => mockRequireUser() }));

const mockEmitModeChanged = vi.fn();
vi.mock('@/lib/analytics/party-join', () => ({
  emitDomainJoinModeChanged: (...a: unknown[]) => mockEmitModeChanged(...a),
}));

const mockRevalidate = vi.fn();
vi.mock('next/cache', () => ({ revalidatePath: (...a: unknown[]) => mockRevalidate(...a) }));

import { setCompanyJoinMode } from './set-join-mode';

const COMPANY_ID = '22222222-2222-4222-8222-222222222222';
const ADMIN = { id: 'admin-1' };

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireUser.mockResolvedValue(ADMIN);
  // Default: a real (non-personal) company so the isPersonal guard is inert.
  mockFindById.mockResolvedValue({ id: COMPANY_ID, isPersonal: false });
});

describe('setCompanyJoinMode', () => {
  it('requires a signed-in user — no repo call', async () => {
    mockRequireUser.mockRejectedValue(new Error('no session'));
    const result = await setCompanyJoinMode({ companyId: COMPANY_ID, mode: 'request' });
    expect(result).toEqual({ success: false, error: 'You must be signed in to do this.' });
    expect(mockSetJoinMode).not.toHaveBeenCalled();
  });

  it('rejects an invalid mode — no repo call', async () => {
    const result = await setCompanyJoinMode({
      companyId: COMPANY_ID,
      // @ts-expect-error — deliberately invalid mode for the schema guard
      mode: 'sideways',
    });
    expect(result).toEqual({ success: false, error: 'Invalid request.' });
    expect(mockGetMemberRole).not.toHaveBeenCalled();
    expect(mockSetJoinMode).not.toHaveBeenCalled();
  });

  it('DENIES a base member — no repo call', async () => {
    mockGetMemberRole.mockResolvedValue('member');
    const result = await setCompanyJoinMode({ companyId: COMPANY_ID, mode: 'off' });
    expect(result).toEqual({ success: false, error: 'You do not have permission to do this.' });
    expect(mockSetJoinMode).not.toHaveBeenCalled();
  });

  it('ALLOWS an admin — on a real change, emits {from,to} and revalidates', async () => {
    mockGetMemberRole.mockResolvedValue('admin');
    mockSetJoinMode.mockResolvedValue({ previous: 'auto', next: 'request', changed: true });

    const result = await setCompanyJoinMode({ companyId: COMPANY_ID, mode: 'request' });

    expect(result).toEqual({ success: true });
    expect(mockSetJoinMode).toHaveBeenCalledWith(COMPANY_ID, 'request', 'admin-1');
    // Gate resolved against the COMPANY scope.
    expect(mockGetMemberRole).toHaveBeenCalledWith('company', COMPANY_ID, 'admin-1');
    expect(mockEmitModeChanged).toHaveBeenCalledWith('auto', 'request', 'admin-1');
    expect(mockRevalidate).toHaveBeenCalledWith('/settings/team');
  });

  it('DENIES a personal-workspace company — no repo call', async () => {
    mockGetMemberRole.mockResolvedValue('owner');
    mockFindById.mockResolvedValue({ id: COMPANY_ID, isPersonal: true });

    const result = await setCompanyJoinMode({ companyId: COMPANY_ID, mode: 'request' });

    expect(result).toEqual({
      success: false,
      error: "This isn't available for personal workspaces.",
    });
    expect(mockSetJoinMode).not.toHaveBeenCalled();
    expect(mockEmitModeChanged).not.toHaveBeenCalled();
    expect(mockRevalidate).not.toHaveBeenCalled();
  });

  it('succeeds silently on a same-mode no-op — no analytics, no revalidate', async () => {
    mockGetMemberRole.mockResolvedValue('owner');
    mockSetJoinMode.mockResolvedValue({ previous: 'request', next: 'request', changed: false });

    const result = await setCompanyJoinMode({ companyId: COMPANY_ID, mode: 'request' });

    expect(result).toEqual({ success: true });
    expect(mockEmitModeChanged).not.toHaveBeenCalled();
    expect(mockRevalidate).not.toHaveBeenCalled();
  });

  it('maps a repo failure (e.g. not-found) to the friendly message', async () => {
    mockGetMemberRole.mockResolvedValue('owner');
    mockSetJoinMode.mockRejectedValue(new Error('Company not found: x'));

    const result = await setCompanyJoinMode({ companyId: COMPANY_ID, mode: 'off' });

    expect(result).toEqual({
      success: false,
      error: 'Could not update join mode. Please try again.',
    });
  });
});
