import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/utils';

const {
  mockGetCurrentUser,
  mockRedirect,
  mockNotFound,
  mockHasPlatformCapability,
  mockFindDetails,
  mockGetIndustries,
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
  mockFindDetails: vi.fn(),
  mockGetIndustries: vi.fn(),
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
  companiesRepository: { findAdminDetailsById: (...a: unknown[]) => mockFindDetails(...a) },
  referenceDataRepository: { getIndustries: () => mockGetIndustries() },
}));
vi.mock('@/lib/logging', () => ({
  log: { error: (...a: unknown[]) => mockLogError(...a), info: vi.fn(), warn: vi.fn() },
}));
vi.mock('@/components/layout/breadcrumb-context', () => ({
  EntityCrumb: ({ label }: { label: string }) => <span data-testid="crumb">{label}</span>,
}));

const workspaceProps = vi.hoisted(() => ({ last: null as unknown }));
vi.mock('../_components/company-details-workspace', () => ({
  CompanyDetailsWorkspace: (props: unknown) => {
    workspaceProps.last = props;
    return <div data-testid="workspace" />;
  },
}));

import { PLATFORM_CAPABILITIES, platformRoleHasCapability } from '@balo/shared/authz';
import AdminCompanyDetailsPage from './page';

const COMPANY_ID = '11111111-1111-4111-8111-111111111111';
const ADMIN = { id: 'admin-1', platformRole: 'admin' };
const COMPANY = {
  id: COMPANY_ID,
  name: 'Acme',
  isPersonal: false,
  industryId: 'ind-1',
  industryName: 'Logistics',
  industryIsActive: true,
  reviewNameHiddenAt: new Date('2026-10-03T08:00:00.000Z'),
};

const renderPage = async (companyId = COMPANY_ID): Promise<void> => {
  const ui = await AdminCompanyDetailsPage({ params: Promise.resolve({ companyId }) });
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
  mockFindDetails.mockResolvedValue(COMPANY);
  mockGetIndustries.mockResolvedValue([
    { id: 'ind-1', name: 'Logistics', sortOrder: 1, isActive: true },
    { id: 'ind-2', name: 'Retail', sortOrder: 2, isActive: true },
  ]);
});

describe('AdminCompanyDetailsPage', () => {
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
    expect(mockFindDetails).not.toHaveBeenCalled();
  });

  it('404s for a non-uuid id without a repository read', async () => {
    await expect(renderPage('not-a-uuid')).rejects.toThrow('NEXT_NOT_FOUND');
    expect(mockFindDetails).not.toHaveBeenCalled();
  });

  it('404s for a company that does not exist', async () => {
    mockFindDetails.mockResolvedValue(undefined);
    await expect(renderPage()).rejects.toThrow('NEXT_NOT_FOUND');
    expect(mockGetIndustries).not.toHaveBeenCalled();
  });

  it('projects the company to the display DTO, lists industries and passes canManage', async () => {
    await renderPage();

    expect(screen.getByTestId('crumb')).toHaveTextContent('Acme details');
    expect(workspaceProps.last).toEqual({
      company: {
        id: COMPANY_ID,
        name: 'Acme',
        isPersonal: false,
        industryId: 'ind-1',
        industryName: 'Logistics',
        industryIsActive: true,
        reviewNameHiddenAt: '2026-10-03T08:00:00.000Z',
      },
      industries: [
        { id: 'ind-1', name: 'Logistics' },
        { id: 'ind-2', name: 'Retail' },
      ],
      canManage: true,
    });
  });

  it('maps a visible company name to a null hidden timestamp', async () => {
    mockFindDetails.mockResolvedValue({ ...COMPANY, reviewNameHiddenAt: null });
    await renderPage();
    expect(workspaceProps.last).toMatchObject({ company: { reviewNameHiddenAt: null } });
  });

  it('renders read-only (canManage false) when MANAGE_COMPANY_DETAILS is not held', async () => {
    mockHasPlatformCapability.mockImplementation(
      (_user: unknown, capability: string) =>
        capability === PLATFORM_CAPABILITIES.VIEW_PLATFORM_ADMIN
    );
    await renderPage();
    expect(workspaceProps.last).toMatchObject({ canManage: false });
  });

  it('logs and hands the workspace `industries: null` when the industry read fails', async () => {
    mockGetIndustries.mockRejectedValue(new Error('db down'));
    await renderPage();

    expect(mockLogError).toHaveBeenCalledWith(
      'Failed to load industries for staff company details',
      expect.objectContaining({ companyId: COMPANY_ID, error: 'db down' })
    );
    expect(workspaceProps.last).toMatchObject({ industries: null });
  });
});
