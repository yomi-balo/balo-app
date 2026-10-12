import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const {
  mockGetCurrentUser,
  mockHasCapability,
  mockFindById,
  mockListDomains,
  mockFindLatest,
  mockListPending,
  mockListResolved,
  mockFindNames,
  mockRedirect,
  mockNotFound,
  mockLogError,
} = vi.hoisted(() => ({
  mockGetCurrentUser: vi.fn(),
  mockHasCapability: vi.fn(),
  mockFindById: vi.fn(),
  mockListDomains: vi.fn(),
  mockFindLatest: vi.fn(),
  mockListPending: vi.fn(),
  mockListResolved: vi.fn(),
  mockFindNames: vi.fn(),
  mockRedirect: vi.fn(() => {
    throw new Error('REDIRECT');
  }),
  mockNotFound: vi.fn(() => {
    throw new Error('NOT_FOUND');
  }),
  mockLogError: vi.fn(),
}));

vi.mock('next/navigation', () => ({ redirect: mockRedirect, notFound: mockNotFound }));
vi.mock('@/lib/logging', () => ({ log: { error: mockLogError } }));
vi.mock('@/lib/auth/session', () => ({ getCurrentUser: mockGetCurrentUser }));
vi.mock('@/lib/authz', () => ({
  hasCapability: mockHasCapability,
  CAPABILITIES: { MANAGE_MEMBERS: 'manage_members' },
}));
vi.mock('@balo/db', () => ({
  companiesRepository: { findById: mockFindById },
  partyDomainsRepository: { listForPartySettings: mockListDomains },
  auditEventsRepository: { findLatestByEntityAndAction: mockFindLatest },
  partyJoinRequestsRepository: {
    listPendingByParty: mockListPending,
    listResolvedByParty: mockListResolved,
  },
  usersRepository: { findNamesByIds: mockFindNames },
}));
vi.mock('./_components/members-access-client', () => ({
  MembersAccessClient: ({ dto }: { dto: Record<string, unknown> }) => (
    <div data-testid="shell">{`${dto.companyName}|${dto.mode}|${(dto.domains as unknown[] | null)?.length ?? 'error'}|${dto.lastChangedByName}`}</div>
  ),
}));

import MembersAccessPage from './page';

const COMPANY_ID = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
  vi.clearAllMocks();
  mockRedirect.mockImplementation(() => {
    throw new Error('REDIRECT');
  });
  mockNotFound.mockImplementation(() => {
    throw new Error('NOT_FOUND');
  });
});

describe('MembersAccessPage gating', () => {
  it('redirects to /login when there is no user', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    await expect(MembersAccessPage()).rejects.toThrow('REDIRECT');
    expect(mockRedirect).toHaveBeenCalledWith('/login');
  });

  it('notFound() when the actor lacks MANAGE_MEMBERS', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u1', companyId: COMPANY_ID });
    mockHasCapability.mockResolvedValue(false);
    await expect(MembersAccessPage()).rejects.toThrow('NOT_FOUND');
    expect(mockFindById).not.toHaveBeenCalled();
  });

  it('notFound() for a personal workspace (only a promoted organization reaches this surface)', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u1', companyId: COMPANY_ID });
    mockHasCapability.mockResolvedValue(true);
    mockFindById.mockResolvedValue({
      id: COMPANY_ID,
      name: 'Personal',
      isPersonal: true,
      domainJoinMode: 'auto',
    });
    await expect(MembersAccessPage()).rejects.toThrow('NOT_FOUND');
    expect(mockNotFound).toHaveBeenCalled();
  });

  it('notFound() when the company row is missing', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u1', companyId: COMPANY_ID });
    mockHasCapability.mockResolvedValue(true);
    mockFindById.mockResolvedValue(undefined);
    await expect(MembersAccessPage()).rejects.toThrow('NOT_FOUND');
  });

  it('renders the shell with a PII-free DTO for an eligible company admin', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'admin-1', companyId: COMPANY_ID });
    mockHasCapability.mockResolvedValue(true);
    mockFindById.mockResolvedValue({
      id: COMPANY_ID,
      name: 'Northwind',
      isPersonal: false,
      domainJoinMode: 'request',
    });
    mockListDomains.mockResolvedValue([{ id: 'd1' }]);
    mockFindLatest.mockResolvedValue({
      actorUserId: 'u9',
      createdAt: new Date('2020-07-03T00:00:00Z'),
    });
    mockFindNames.mockResolvedValue([{ id: 'u9', firstName: 'Jordan', lastName: 'Ellis' }]);
    mockListPending.mockResolvedValue([]);
    mockListResolved.mockResolvedValue([]);

    const ui = await MembersAccessPage();
    render(ui);

    const shell = screen.getByTestId('shell');
    expect(shell).toHaveTextContent('Northwind');
    expect(shell).toHaveTextContent('request');
    expect(shell).toHaveTextContent('Jordan Ellis');
    expect(mockFindNames).toHaveBeenCalledWith(['u9']);
  });

  it('hands the client the projected domains only, with no staff identity', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'admin-1', companyId: COMPANY_ID });
    mockHasCapability.mockResolvedValue(true);
    mockFindById.mockResolvedValue({
      id: COMPANY_ID,
      name: 'Northwind',
      isPersonal: false,
      domainJoinMode: 'auto',
    });
    const projected = [{ id: 'd1', domain: 'northwind.com', attribution: { kind: 'balo' } }];
    mockListDomains.mockResolvedValue(projected);
    mockFindLatest.mockResolvedValue(undefined);
    mockListPending.mockResolvedValue([]);
    mockListResolved.mockResolvedValue([]);

    const ui = await MembersAccessPage();

    expect(mockListDomains).toHaveBeenCalledWith('company', COMPANY_ID);
    const props = (ui as { props: { dto: { domains: unknown } } }).props;
    expect(props.dto.domains).toBe(projected);
    expect(JSON.stringify(props.dto.domains)).not.toMatch(/firstName|lastName|createdBy/);
  });

  it('degrades a failed domains read to domains: null and logs it, without failing the page', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'admin-1', companyId: COMPANY_ID });
    mockHasCapability.mockResolvedValue(true);
    mockFindById.mockResolvedValue({
      id: COMPANY_ID,
      name: 'Northwind',
      isPersonal: false,
      domainJoinMode: 'auto',
    });
    mockListDomains.mockRejectedValue(new Error('db down'));
    mockFindLatest.mockResolvedValue(undefined);
    mockListPending.mockResolvedValue([]);
    mockListResolved.mockResolvedValue([]);

    render(await MembersAccessPage());

    expect(screen.getByTestId('shell')).toHaveTextContent('Northwind|auto|error|null');
    expect(mockLogError).toHaveBeenCalledWith(
      'Failed to load company domains for members & access',
      expect.objectContaining({ companyId: COMPANY_ID, error: 'db down' })
    );
  });

  it('leaves lastChangedByName null when the mode was never changed', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'admin-1', companyId: COMPANY_ID });
    mockHasCapability.mockResolvedValue(true);
    mockFindById.mockResolvedValue({
      id: COMPANY_ID,
      name: 'Northwind',
      isPersonal: false,
      domainJoinMode: 'auto',
    });
    mockListDomains.mockResolvedValue([]);
    mockFindLatest.mockResolvedValue(undefined);
    mockListPending.mockResolvedValue([]);
    mockListResolved.mockResolvedValue([]);

    const ui = await MembersAccessPage();
    render(ui);

    expect(screen.getByTestId('shell')).toHaveTextContent('Northwind|auto|0|null');
    expect(mockFindNames).not.toHaveBeenCalled();
  });
});
