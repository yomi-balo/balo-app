import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { axe } from 'jest-axe';
import { FolderKanban, Layers, Ticket } from 'lucide-react';
import type { ResolvedCatalogueRow } from '../_lib/admin-catalogue';
import { CatalogueList } from './catalogue-list';

/**
 * BAL-534 — synthetic `ResolvedCatalogueRow[]` fixtures, built inline rather than derived from
 * `ADMIN_CATALOGUE_ROWS`, so this test does not re-pin production copy.
 */
function row(overrides: Partial<ResolvedCatalogueRow> = {}): ResolvedCatalogueRow {
  return {
    key: 'sample',
    title: 'Sample surface',
    description: 'A description of the sample surface.',
    href: '/sample',
    icon: FolderKanban,
    requiredCapability: null,
    status: 'Shipped',
    tone: 'success',
    isShipped: true,
    isViewOnly: false,
    linkHref: '/sample',
    ...overrides,
  };
}

describe('CatalogueList (BAL-534)', () => {
  it('shipped + not gated: renders a link with the href, a status chip, and no "View only"', () => {
    render(<CatalogueList rows={[row({ key: 'a', title: 'Engagements', icon: Ticket })]} />);
    const link = screen.getByRole('link', { name: /Engagements/ });
    expect(link).toHaveAttribute('href', '/sample');
    expect(within(link).getByText('Shipped')).toBeInTheDocument();
    expect(within(link).queryByText('View only')).not.toBeInTheDocument();
  });

  it('shipped + gated: renders a link with the href AND "View only"', () => {
    render(
      <CatalogueList
        rows={[
          row({
            key: 'b',
            title: 'Promo codes',
            icon: Ticket,
            isViewOnly: true,
          }),
        ]}
      />
    );
    const link = screen.getByRole('link', { name: /Promo codes/ });
    expect(link).toHaveAttribute('href', '/sample');
    expect(within(link).getByText('View only')).toBeInTheDocument();
  });

  it('not shipped: renders no link, the title as plain text, and the status chip', () => {
    render(
      <CatalogueList
        rows={[
          row({
            key: 'c',
            title: 'Taxonomy',
            icon: Layers,
            isShipped: false,
            linkHref: null,
            status: 'Seeded, not editable',
            tone: 'neutral',
          }),
        ]}
      />
    );
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    const inertRow = screen.getByTestId('catalogue-row-inert');
    expect(within(inertRow).getByText('Taxonomy')).toBeInTheDocument();
    expect(within(inertRow).getByText('Seeded, not editable')).toBeInTheDocument();
  });

  it('has no accessibility violations', async () => {
    const { container } = render(
      <CatalogueList
        rows={[
          row({ key: 'a', title: 'Engagements', icon: Ticket }),
          row({ key: 'b', title: 'Promo codes', icon: Ticket, isViewOnly: true }),
          row({
            key: 'c',
            title: 'Taxonomy',
            icon: Layers,
            isShipped: false,
            linkHref: null,
          }),
        ]}
      />
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
