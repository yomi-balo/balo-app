import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { axe } from 'jest-axe';
import type { PartyDomainForSettings } from '@balo/db';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('../_actions/set-join-mode', () => ({ setCompanyJoinMode: vi.fn() }));
vi.mock('../_actions/approve-join-request', () => ({ approveJoinRequest: vi.fn() }));
vi.mock('../_actions/decline-join-request', () => ({ declineJoinRequest: vi.fn() }));

import { MembersAccessClient, type MembersAccessDto } from './members-access-client';

const DOMAIN: PartyDomainForSettings = {
  id: 'd1',
  domain: 'northwind.com',
  createdAt: new Date('2020-01-01T00:00:00Z'),
  attribution: { kind: 'signup', name: 'Jordan Ellis' },
};

function makeDto(over: Partial<MembersAccessDto> = {}): MembersAccessDto {
  return {
    companyId: '22222222-2222-4222-8222-222222222222',
    companyName: 'Northwind',
    domains: [DOMAIN],
    mode: 'request',
    lastChangedByName: 'Jordan Ellis',
    lastChangedAt: new Date('2020-07-03T00:00:00Z'),
    pending: [],
    resolved: [],
    ...over,
  };
}

describe('MembersAccessClient', () => {
  it('renders the header, capability chip, and all three company sections', () => {
    render(<MembersAccessClient dto={makeDto()} />);

    expect(screen.getByRole('heading', { name: /members & access/i })).toBeInTheDocument();
    expect(screen.getByText(/northwind · company workspace/i)).toBeInTheDocument();
    expect(screen.getByText(/admin · manage members/i)).toBeInTheDocument();

    // Domains section (shared) + its row.
    expect(screen.getByText('northwind.com')).toBeInTheDocument();
    // Join mode section.
    expect(screen.getByRole('radiogroup', { name: /join mode/i })).toBeInTheDocument();
    // Join requests section (empty here).
    expect(screen.getByText(/you're all caught up/i)).toBeInTheDocument();
  });

  it('hides the Domains card for a company with no domains but keeps the other sections', () => {
    render(<MembersAccessClient dto={makeDto({ domains: [] })} />);

    expect(screen.queryByRole('heading', { name: 'Domains' })).not.toBeInTheDocument();
    expect(screen.getByRole('radiogroup', { name: /join mode/i })).toBeInTheDocument();
  });

  it('shows the Domains error state when the domains read failed', () => {
    render(<MembersAccessClient dto={makeDto({ domains: null })} />);

    expect(screen.getByRole('alert')).toHaveTextContent(/couldn't load your domains/i);
    expect(screen.getByRole('radiogroup', { name: /join mode/i })).toBeInTheDocument();
  });

  it('has no accessibility violations', async () => {
    const { container } = render(<MembersAccessClient dto={makeDto()} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
