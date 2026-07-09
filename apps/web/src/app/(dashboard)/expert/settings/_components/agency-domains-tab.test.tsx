import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import type { PartyDomainWithCreator } from '@balo/db';

const refreshMock = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: refreshMock }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/app/(dashboard)/settings/team/_actions/add-domain', () => ({ addPartyDomain: vi.fn() }));
vi.mock('@/app/(dashboard)/settings/team/_actions/remove-domain', () => ({
  removePartyDomain: vi.fn(),
}));

import { AgencyDomainsTab } from './agency-domains-tab';

const AGENCY_ID = '33333333-3333-4333-8333-333333333333';

const DOMAIN: PartyDomainWithCreator = {
  id: 'a1',
  domain: 'latticeconsulting.com',
  source: 'auto_captured',
  createdAt: new Date('2020-01-01T00:00:00Z'),
  createdBy: { id: 'u1', firstName: 'Sam', lastName: 'Okafor' },
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('AgencyDomainsTab', () => {
  it('renders the domains section and the ADR-1034 lock note when domains load', () => {
    render(<AgencyDomainsTab agencyId={AGENCY_ID} partyName="Lattice" domains={[DOMAIN]} />);
    expect(screen.getByText('latticeconsulting.com')).toBeInTheDocument();
    expect(screen.getByText(/membership is decided by verified email/i)).toBeInTheDocument();
    // NO join-mode / queue affordances exist in this tree.
    expect(screen.queryByRole('radiogroup', { name: /join mode/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/join requests/i)).not.toBeInTheDocument();
  });

  it('renders the agency empty invitation for a solo agency-of-one', () => {
    render(<AgencyDomainsTab agencyId={AGENCY_ID} partyName="Lattice" domains={[]} />);
    expect(
      screen.getByText(/colleagues who sign up with it join your team automatically/i)
    ).toBeInTheDocument();
  });

  it('renders an error state with retry when domains are null', async () => {
    const user = userEvent.setup();
    render(<AgencyDomainsTab agencyId={AGENCY_ID} partyName="Lattice" domains={null} />);

    expect(screen.getByRole('alert')).toHaveTextContent(/couldn't load your domains/i);
    await user.click(screen.getByRole('button', { name: /try again/i }));
    expect(refreshMock).toHaveBeenCalledOnce();
  });

  it('has no accessibility violations', async () => {
    const { container } = render(
      <AgencyDomainsTab agencyId={AGENCY_ID} partyName="Lattice" domains={[DOMAIN]} />
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
