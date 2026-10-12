import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@/test/utils';
import { axe } from 'jest-axe';

const { mockRefresh, mockRemove } = vi.hoisted(() => ({
  mockRefresh: vi.fn(),
  mockRemove: vi.fn(),
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mockRefresh }) }));
vi.mock('../_actions/add-party-domain', () => ({ addPartyDomainAction: vi.fn() }));
vi.mock('../_actions/reassign-party-domain', () => ({ reassignPartyDomainAction: vi.fn() }));
vi.mock('../_actions/remove-party-domain', () => ({
  removePartyDomainAction: (...a: unknown[]) => mockRemove(...a),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { StaffDomainsWorkspace } from './staff-domains-workspace';
import type { StaffDomainRowDto, StaffPartyDto } from '../_lib/staff-domain-types';

const COMPANY: StaffPartyDto = {
  partyType: 'company',
  partyId: 'p-1',
  name: 'Acme',
  isPersonal: false,
  memberCount: 3,
};

const ROWS: StaffDomainRowDto[] = [
  {
    id: 'r1',
    domain: 'acme.com',
    addedVia: 'signup',
    createdAt: '2026-10-03T08:00:00.000Z',
    createdByName: 'Dana Lee',
    reason: null,
  },
  {
    id: 'r2',
    domain: 'acme.co.nz',
    addedVia: 'balo',
    createdAt: '2026-10-04T08:00:00.000Z',
    createdByName: 'Sam Staff',
    reason: 'Asked by the CFO',
  },
];

beforeEach(() => vi.clearAllMocks());

describe('StaffDomainsWorkspace', () => {
  it('renders the header, type pill, member count, rows and the add card for a manager', () => {
    render(<StaffDomainsWorkspace party={COMPANY} domains={ROWS} canManage />);

    expect(screen.getByRole('heading', { level: 1, name: 'Acme domains' })).toBeInTheDocument();
    expect(screen.getByText('Company')).toBeInTheDocument();
    expect(screen.getByText('3 members')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /back to lookup/i })).toHaveAttribute(
      'href',
      '/admin/lookup'
    );
    expect(screen.getByText('acme.com')).toBeInTheDocument();
    expect(screen.getByText('From signup')).toBeInTheDocument();
    expect(screen.getByText('Added by Balo')).toBeInTheDocument();
    expect(
      screen.getByText('Captured when Dana Lee @ Acme signed up on 3 Oct 2026')
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Add a domain' })).toBeInTheDocument();
    expect(
      screen.queryByText(/needs the Manage party domains permission/i)
    ).not.toBeInTheDocument();
  });

  it('uses the agency description and pill for an agency', () => {
    render(
      <StaffDomainsWorkspace
        party={{ ...COMPANY, partyType: 'agency', memberCount: 1 }}
        domains={ROWS}
        canManage
      />
    );
    expect(screen.getByText('Agency')).toBeInTheDocument();
    expect(screen.getByText('1 member')).toBeInTheDocument();
    expect(screen.getByText(/join Acme automatically/)).toBeInTheDocument();
  });

  it('read-only viewers see the Lock note, no add card and no Remove', () => {
    render(<StaffDomainsWorkspace party={COMPANY} domains={ROWS} canManage={false} />);

    expect(screen.getByText(/needs the Manage party domains permission/i)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Add a domain' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^remove/i })).not.toBeInTheDocument();
  });

  it('a personal workspace gets the personal note instead of the add card', () => {
    render(
      <StaffDomainsWorkspace party={{ ...COMPANY, isPersonal: true }} domains={[]} canManage />
    );

    expect(
      screen.getByText(/personal workspace, so a domain on it would never match/i)
    ).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Add a domain' })).not.toBeInTheDocument();
    expect(screen.queryByText(/Add one below/)).not.toBeInTheDocument();
  });

  it('empty state invites a manager to add one', () => {
    render(<StaffDomainsWorkspace party={COMPANY} domains={[]} canManage />);
    expect(
      screen.getByText(
        'Acme has no domains, so no one joins it by email domain. Add one below if the customer asked for it.'
      )
    ).toBeInTheDocument();
  });

  it('empty state for a read-only viewer carries no add invitation', () => {
    render(<StaffDomainsWorkspace party={COMPANY} domains={[]} canManage={false} />);
    expect(
      screen.getByText('Acme has no domains, so no one joins it by email domain.')
    ).toBeInTheDocument();
  });

  it('error state offers a retry that refreshes the route', () => {
    render(<StaffDomainsWorkspace party={COMPANY} domains={null} canManage />);

    expect(screen.getByRole('alert')).toHaveTextContent(/couldn't load Acme’s domains/i);
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });

  it('announces a successful change in the live region', async () => {
    mockRemove.mockResolvedValue({
      success: true,
      message: 'acme.com removed from Acme. Owners and admins have been notified.',
    });
    render(<StaffDomainsWorkspace party={COMPANY} domains={ROWS} canManage />);

    fireEvent.click(screen.getByRole('button', { name: 'Remove acme.com' }));
    fireEvent.change(screen.getByLabelText('Reason', { selector: '#remove-reason-r1' }), {
      target: { value: 'Left' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Remove domain' }));

    const line = await screen.findByText(
      'acme.com removed from Acme. Owners and admins have been notified.'
    );
    await waitFor(() => expect(line).toHaveFocus());
  });

  it('clears the previous status line when the next action starts', async () => {
    mockRemove.mockResolvedValueOnce({ success: true, message: 'first done' });
    mockRemove.mockImplementationOnce(() => new Promise(() => undefined));
    render(<StaffDomainsWorkspace party={COMPANY} domains={ROWS} canManage />);

    fireEvent.click(screen.getByRole('button', { name: 'Remove acme.com' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove domain' }));
    expect(await screen.findByText('first done')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Remove acme.co.nz' }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove domain' }).at(-1) as HTMLElement);
    await waitFor(() => expect(screen.queryByText('first done')).not.toBeInTheDocument());
  });

  it('has no accessibility violations', async () => {
    const { container } = render(
      <StaffDomainsWorkspace party={COMPANY} domains={ROWS} canManage />
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
