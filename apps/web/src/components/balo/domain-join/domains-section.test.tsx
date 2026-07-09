import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { axe } from 'jest-axe';
import type { PartyDomainWithCreator } from '@balo/db';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/app/(dashboard)/settings/team/_actions/add-domain', () => ({ addPartyDomain: vi.fn() }));
vi.mock('@/app/(dashboard)/settings/team/_actions/remove-domain', () => ({
  removePartyDomain: vi.fn(),
}));

import { DomainsSection } from './domains-section';

const PARTY_ID = '22222222-2222-4222-8222-222222222222';

function domain(over: Partial<PartyDomainWithCreator>): PartyDomainWithCreator {
  return {
    id: 'd1',
    domain: 'northwind.com',
    source: 'auto_captured',
    createdAt: new Date('2020-01-01T00:00:00Z'),
    createdBy: { id: 'u1', firstName: 'Jordan', lastName: 'Ellis' },
    ...over,
  };
}

describe('DomainsSection', () => {
  it('renders the company empty invitation and the add form', () => {
    render(
      <DomainsSection party="company" partyId={PARTY_ID} partyName="Northwind" domains={[]} />
    );

    // Action-led title (never bare "No … yet" absence copy — balo-ui).
    expect(screen.getByRole('heading', { name: 'Add your first domain' })).toBeInTheDocument();
    expect(screen.queryByText(/no domains yet/i)).not.toBeInTheDocument();
    expect(
      screen.getByText(/add your company's email domain so teammates can join automatically/i)
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/add a domain/i)).toBeInTheDocument();
  });

  it('renders the agency-specific empty copy with the action-led title', () => {
    render(<DomainsSection party="agency" partyId={PARTY_ID} partyName="Lattice" domains={[]} />);
    expect(screen.getByRole('heading', { name: 'Add your first domain' })).toBeInTheDocument();
    expect(
      screen.getByText(/colleagues who sign up with it join your team automatically/i)
    ).toBeInTheDocument();
  });

  it('renders rows with source-aware attribution and first-mention "@ party" only once per person', () => {
    const domains: PartyDomainWithCreator[] = [
      domain({ id: 'd1', domain: 'northwind.com', source: 'auto_captured' }),
      domain({ id: 'd2', domain: 'northwind.io', source: 'admin_added' }),
      domain({
        id: 'd3',
        domain: 'northwind.co.uk',
        source: 'admin_added',
        createdBy: { id: 'u2', firstName: 'Riley', lastName: 'Chen' },
      }),
    ];
    render(
      <DomainsSection party="company" partyId={PARTY_ID} partyName="Northwind" domains={domains} />
    );

    // Jordan is first-mentioned on d1 (with @ party), bare on d2.
    expect(screen.getByText('Captured from Jordan Ellis @ Northwind')).toBeInTheDocument();
    expect(screen.getByText('Added by Jordan Ellis')).toBeInTheDocument();
    // Riley is first-mentioned on d3 (with @ party).
    expect(screen.getByText('Added by Riley Chen @ Northwind')).toBeInTheDocument();
    expect(screen.getByText('northwind.co.uk')).toBeInTheDocument();
  });

  it('has no accessibility violations', async () => {
    const { container } = render(
      <DomainsSection
        party="company"
        partyId={PARTY_ID}
        partyName="Northwind"
        domains={[domain({})]}
      />
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
