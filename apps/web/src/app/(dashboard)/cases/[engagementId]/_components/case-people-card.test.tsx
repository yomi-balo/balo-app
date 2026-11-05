import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/utils';
import type { CasePersonView } from '@/lib/cases/case-view-types';
import { CasePeopleCard } from './case-people-card';

/**
 * The People card names the viewer ("You") and the counterparty. Only an entry the server gave
 * an `href` — the client lens's delivering expert, whose public profile resolves — is a link.
 */
function renderCard(people: readonly CasePersonView[], lens: 'client' | 'expert' = 'client') {
  return render(
    <CasePeopleCard
      people={people}
      lens={lens}
      clientCompanyName="Northwind Industrial"
      hasCaseScopeDomains={false}
    />
  );
}

describe('CasePeopleCard — the counterparty link', () => {
  it("links the expert's name to their public profile", () => {
    renderCard([
      { name: 'Dana Whitfield', isViewer: true },
      { name: 'Amara Okafor', isViewer: false, href: '/experts/amara' },
    ]);
    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(1);
    expect(screen.getByRole('link', { name: 'Amara Okafor' })).toHaveAttribute(
      'href',
      '/experts/amara'
    );
    expect(screen.getByText('You')).toBeInTheDocument();
  });

  it('renders the name unlinked when the profile does not resolve', () => {
    renderCard([
      { name: 'Dana Whitfield', isViewer: true },
      { name: 'Amara Okafor', isViewer: false, href: null },
    ]);
    expect(screen.getByText(/Amara Okafor/)).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('never links the client company on the expert lens', () => {
    renderCard(
      [
        { name: 'Amara Okafor', isViewer: true },
        { name: 'Northwind Industrial', isViewer: false, href: null },
      ],
      'expert'
    );
    expect(screen.getByText(/Northwind Industrial/)).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });
});
