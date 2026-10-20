import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from '@/test/axe';
import type { PartyDomainForSettings } from '@balo/db';

const mockRefresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mockRefresh }) }));

import { DomainsSection } from './domains-section';

function domain(over: Partial<PartyDomainForSettings>): PartyDomainForSettings {
  return {
    id: 'd1',
    domain: 'northwind.com',
    createdAt: new Date('2020-01-01T00:00:00Z'),
    attribution: { kind: 'signup', name: 'Jordan Ellis' },
    ...over,
  };
}

describe('DomainsSection', () => {
  it('renders nothing for an agency with no domains', () => {
    const { container } = render(
      <DomainsSection party="agency" partyName="Lattice" domains={[]} />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('invites a company with no domains to contact support', () => {
    render(<DomainsSection party="company" partyName="Northwind" domains={[]} />);

    expect(screen.getByRole('heading', { name: 'Domains' })).toBeInTheDocument();
    expect(
      screen.getByText(/Want teammates with your work email to join automatically\?/)
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Contact Balo support' })).toHaveAttribute(
      'href',
      'mailto:support@getbalo.com'
    );
  });

  it('renders the error state and retries via a router refresh when the read failed', async () => {
    const user = userEvent.setup();
    render(<DomainsSection party="agency" partyName="Lattice" domains={null} />);

    expect(screen.getByText("We couldn't load your domains")).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /try again/i }));
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['company', /based on your join setting below/i],
    ['agency', /joins your team automatically/i],
  ] as const)('shows the %s description', (party, text) => {
    render(<DomainsSection party={party} partyName="Northwind" domains={[domain({})]} />);
    expect(screen.getByText(text)).toBeInTheDocument();
  });

  it('names each signup person with "@ party" once, and attributes Balo-added rows to Balo', () => {
    render(
      <DomainsSection
        party="company"
        partyName="Northwind"
        domains={[
          domain({ id: 'd1', domain: 'northwind.com' }),
          domain({ id: 'd2', domain: 'northwind.io' }),
          domain({ id: 'd3', domain: 'northwind.co.uk', attribution: { kind: 'balo' } }),
        ]}
      />
    );

    expect(
      screen.getByText('Added automatically when Jordan Ellis @ Northwind signed up')
    ).toBeInTheDocument();
    expect(screen.getByText('Added automatically when Jordan Ellis signed up')).toBeInTheDocument();
    expect(screen.getByText('Added by Balo')).toBeInTheDocument();
  });

  it('offers the support contact and no add or remove control', () => {
    render(<DomainsSection party="company" partyName="Northwind" domains={[domain({})]} />);

    expect(screen.getByRole('link', { name: 'Contact Balo support' })).toHaveAttribute(
      'href',
      'mailto:support@getbalo.com'
    );
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /remove|add/i })).not.toBeInTheDocument();
  });

  it('has no accessibility violations', async () => {
    const { container } = render(
      <DomainsSection party="company" partyName="Northwind" domains={[domain({})]} />
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
