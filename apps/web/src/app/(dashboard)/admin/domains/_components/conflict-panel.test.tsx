import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/utils';
import { axe } from 'jest-axe';
import { ConflictPanel } from './conflict-panel';
import type { ConflictOwnerView } from '../_lib/staff-domain-types';

const OWNER: ConflictOwnerView = {
  domainId: 'd-1',
  partyType: 'company',
  partyId: 'p-1',
  partyName: 'Acme & Co',
  memberCount: 12,
  source: 'auto_captured',
  addedVia: 'signup',
  createdAt: '2026-10-03T08:00:00.000Z',
  createdByName: 'Dana Lee',
};

describe('ConflictPanel', () => {
  it('names the owner, how the domain got there, and that people stay put', () => {
    render(<ConflictPanel domain="acme.com" owner={OWNER} targetName="Globex" />);

    expect(screen.getByText('acme.com belongs to Acme & Co')).toBeInTheDocument();
    expect(
      screen.getByText(
        /Acme & Co is a company with 12 members\. The domain was captured when Dana Lee @ Acme & Co signed up on 3 Oct 2026\./
      )
    ).toBeInTheDocument();
    expect(
      screen.getByText(/will join Globex; everyone already in Acme & Co stays/)
    ).toBeInTheDocument();
  });

  it('uses the admin-added sentence for a staff-added owner', () => {
    render(
      <ConflictPanel
        domain="acme.com"
        owner={{ ...OWNER, source: 'admin_added', addedVia: 'balo', createdByName: 'Sam Staff' }}
        targetName="Globex"
      />
    );
    expect(screen.getByText(/It was added by Sam Staff on 3 Oct 2026\./)).toBeInTheDocument();
  });

  it('links to the owner in Lookup with the name encoded', () => {
    render(<ConflictPanel domain="acme.com" owner={OWNER} targetName="Globex" />);
    expect(screen.getByRole('link', { name: 'View Acme & Co in Lookup' })).toHaveAttribute(
      'href',
      '/admin/lookup?q=Acme%20%26%20Co'
    );
  });

  it('has no accessibility violations', async () => {
    const { container } = render(
      <ConflictPanel domain="acme.com" owner={OWNER} targetName="Globex" />
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
