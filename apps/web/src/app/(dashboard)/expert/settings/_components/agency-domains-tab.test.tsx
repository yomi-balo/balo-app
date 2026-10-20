import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from '@/test/axe';
import type { PartyDomainForSettings } from '@balo/db';

const refreshMock = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: refreshMock }) }));

import { AgencyDomainsTab } from './agency-domains-tab';

const DOMAIN: PartyDomainForSettings = {
  id: 'a1',
  domain: 'latticeconsulting.com',
  createdAt: new Date('2020-01-01T00:00:00Z'),
  attribution: { kind: 'signup', name: 'Sam Okafor' },
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('AgencyDomainsTab', () => {
  it('renders the read-only domains list with no join-mode or queue affordances', () => {
    render(<AgencyDomainsTab partyName="Lattice" domains={[DOMAIN]} />);
    expect(screen.getByText('latticeconsulting.com')).toBeInTheDocument();
    expect(
      screen.getByText('Added automatically when Sam Okafor @ Lattice signed up')
    ).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('radiogroup', { name: /join mode/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/join requests/i)).not.toBeInTheDocument();
  });

  it('renders an error state with retry when domains are null', async () => {
    const user = userEvent.setup();
    render(<AgencyDomainsTab partyName="Lattice" domains={null} />);

    expect(screen.getByRole('alert')).toHaveTextContent(/couldn't load your domains/i);
    await user.click(screen.getByRole('button', { name: /try again/i }));
    expect(refreshMock).toHaveBeenCalledOnce();
  });

  // The settings panel wrapper owns the width; a centred cap here would float the tab away from
  // the tab strip's left edge.
  it.each([
    ['loaded', [DOMAIN]],
    ['error', null],
  ] as const)('sets no centring or width cap of its own (%s)', (_state, domains) => {
    const { container } = render(
      <AgencyDomainsTab partyName="Lattice" domains={domains === null ? null : [...domains]} />
    );
    const root = container.firstElementChild;
    expect(root).not.toBeNull();
    expect(root?.className).not.toMatch(/\bmx-auto\b|\bmax-w-/);
  });

  it('has no accessibility violations', async () => {
    const { container } = render(<AgencyDomainsTab partyName="Lattice" domains={[DOMAIN]} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
