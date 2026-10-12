import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/utils';

const {
  mockGetCurrentUser,
  mockRedirect,
  mockNotFound,
  mockHasPlatformCapability,
  mockGetPartyForStaff,
  mockListForStaff,
  mockLogError,
} = vi.hoisted(() => ({
  mockGetCurrentUser: vi.fn(),
  mockRedirect: vi.fn(() => {
    throw new Error('NEXT_REDIRECT');
  }),
  mockNotFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
  mockHasPlatformCapability: vi.fn(),
  mockGetPartyForStaff: vi.fn(),
  mockListForStaff: vi.fn(),
  mockLogError: vi.fn(),
}));

vi.mock('@/lib/auth/session', () => ({ getCurrentUser: mockGetCurrentUser }));
vi.mock('@/lib/authz/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/authz/platform')>();
  return {
    ...actual,
    hasPlatformCapability: (...args: Parameters<typeof actual.hasPlatformCapability>): boolean =>
      mockHasPlatformCapability(...args),
  };
});
vi.mock('next/navigation', () => ({
  redirect: mockRedirect,
  notFound: mockNotFound,
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock('@balo/db', () => ({
  partyDomainsStaffRepository: {
    getPartyForStaff: (...a: unknown[]) => mockGetPartyForStaff(...a),
    listForStaff: (...a: unknown[]) => mockListForStaff(...a),
  },
}));
vi.mock('@/lib/logging', () => ({
  log: { error: (...a: unknown[]) => mockLogError(...a), info: vi.fn(), warn: vi.fn() },
}));
vi.mock('@/components/layout/breadcrumb-context', () => ({
  EntityCrumb: ({ label }: { label: string }) => <span data-testid="crumb">{label}</span>,
}));

const workspaceProps = vi.hoisted(() => ({ last: null as unknown }));
vi.mock('../../_components/staff-domains-workspace', () => ({
  StaffDomainsWorkspace: (props: unknown) => {
    workspaceProps.last = props;
    return <div data-testid="workspace" />;
  },
}));

import { PLATFORM_CAPABILITIES, platformRoleHasCapability } from '@balo/shared/authz';
import AdminPartyDomainsPage from './page';

const PARTY_ID = '11111111-1111-4111-8111-111111111111';
const ADMIN = { id: 'admin-1', platformRole: 'admin' };
const PARTY = {
  partyType: 'company',
  partyId: PARTY_ID,
  name: 'Acme',
  isPersonal: false,
  memberCount: 3,
};
const ROW = {
  id: 'row-1',
  domain: 'acme.com',
  source: 'admin_added',
  createdAt: new Date('2026-10-03T08:00:00.000Z'),
  createdBy: { firstName: 'Sam', lastName: 'Staff' },
  addedVia: 'balo',
  reason: 'Asked by CFO',
};

const renderPage = async (partyType = 'company', partyId = PARTY_ID): Promise<void> => {
  const ui = await AdminPartyDomainsPage({ params: Promise.resolve({ partyType, partyId }) });
  render(ui);
};

beforeEach(() => {
  vi.clearAllMocks();
  workspaceProps.last = null;
  mockGetCurrentUser.mockResolvedValue(ADMIN);
  mockHasPlatformCapability.mockImplementation(
    (user: { platformRole: 'user' | 'admin' | 'super_admin' }, capability: string) =>
      platformRoleHasCapability(user.platformRole, capability as never)
  );
  mockGetPartyForStaff.mockResolvedValue(PARTY);
  mockListForStaff.mockResolvedValue([ROW]);
});

describe('AdminPartyDomainsPage', () => {
  it('redirects a signed-out visitor to login', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    await expect(renderPage()).rejects.toThrow('NEXT_REDIRECT');
    expect(mockRedirect).toHaveBeenCalledWith('/login');
  });

  it('404s without VIEW_PLATFORM_ADMIN, before any repository read', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u', platformRole: 'user' });
    await expect(renderPage()).rejects.toThrow('NEXT_NOT_FOUND');
    expect(mockHasPlatformCapability).toHaveBeenCalledWith(
      expect.anything(),
      PLATFORM_CAPABILITIES.VIEW_PLATFORM_ADMIN
    );
    expect(mockGetPartyForStaff).not.toHaveBeenCalled();
  });

  it.each([
    ['an unknown party type', 'team', PARTY_ID],
    ['a non-uuid id', 'company', 'not-a-uuid'],
  ])('404s for %s without a repository read', async (_label, type, id) => {
    await expect(renderPage(type, id)).rejects.toThrow('NEXT_NOT_FOUND');
    expect(mockGetPartyForStaff).not.toHaveBeenCalled();
  });

  it('404s for a party that does not exist', async () => {
    mockGetPartyForStaff.mockResolvedValue(undefined);
    await expect(renderPage()).rejects.toThrow('NEXT_NOT_FOUND');
    expect(mockListForStaff).not.toHaveBeenCalled();
  });

  it('projects rows to the display DTO and passes canManage', async () => {
    await renderPage();

    expect(screen.getByTestId('crumb')).toHaveTextContent('Acme domains');
    expect(workspaceProps.last).toEqual({
      party: PARTY,
      canManage: true,
      domains: [
        {
          id: 'row-1',
          domain: 'acme.com',
          addedVia: 'balo',
          createdAt: '2026-10-03T08:00:00.000Z',
          createdByName: 'Sam Staff',
          reason: 'Asked by CFO',
        },
      ],
    });
  });

  it('maps a nameless creator to null and never forwards `source`', async () => {
    mockListForStaff.mockResolvedValue([
      { ...ROW, createdBy: { firstName: null, lastName: null } },
      { ...ROW, id: 'row-2', createdBy: null },
    ]);
    await renderPage();

    const { domains } = workspaceProps.last as { domains: Record<string, unknown>[] };
    expect(domains.map((d) => d.createdByName)).toEqual([null, null]);
    expect(domains.every((d) => !('source' in d))).toBe(true);
  });

  it('renders read-only (canManage false) when MANAGE_PARTY_DOMAINS is not held', async () => {
    mockHasPlatformCapability.mockImplementation(
      (_user: unknown, capability: string) =>
        capability === PLATFORM_CAPABILITIES.VIEW_PLATFORM_ADMIN
    );
    await renderPage();
    expect(workspaceProps.last).toMatchObject({ canManage: false });
  });

  it('logs and hands the workspace `domains: null` when the list read fails', async () => {
    mockListForStaff.mockRejectedValue(new Error('db down'));
    await renderPage();

    expect(mockLogError).toHaveBeenCalledWith(
      'Failed to load party domains for staff',
      expect.objectContaining({ partyId: PARTY_ID, error: 'db down' })
    );
    expect(workspaceProps.last).toMatchObject({ domains: null });
  });
});
