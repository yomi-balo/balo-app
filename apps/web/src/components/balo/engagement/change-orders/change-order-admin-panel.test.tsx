import { describe, expect, it } from 'vitest';

import { render, screen, within } from '@/test/utils';
import { axe } from '@/test/axe';

import { ChangeOrderAdminPanel, type ChangeOrderAdminMoneyView } from './change-order-admin-panel';

const FIXED: Extract<ChangeOrderAdminMoneyView, { kind: 'fixed' }> = {
  kind: 'fixed',
  rows: [
    {
      label: 'Accepted price',
      expert: 'A$12,500',
      client: 'A$15,625',
      margin: 'A$3,125',
      strong: false,
    },
    {
      label: 'Change approved 20 Oct',
      expert: '+A$1,500',
      client: '+A$1,875',
      margin: '+A$375',
      strong: false,
    },
    {
      label: 'Current price',
      expert: 'A$14,000',
      client: 'A$17,500',
      margin: 'A$3,500',
      strong: true,
    },
  ],
  upfrontLabel: '−A$4,688',
  finalInvoiceLabel: 'A$12,812',
  finalInvoiceNegative: false,
  pendingNote: 'Waiting on Northwind: +A$500 expert, +A$625 client (not in the totals yet).',
  creditNeededText: null,
  footnote: 'Under v1 manual invoicing, the final invoice figure is what goes into Xero.',
};

describe('ChangeOrderAdminPanel · fixed price', () => {
  it('shows both sides of every amount, the invoiced upfront and the final invoice', () => {
    render(<ChangeOrderAdminPanel money={FIXED} />);
    expect(screen.getByRole('heading', { name: 'Price and final invoice' })).toBeInTheDocument();
    expect(screen.getByText('Balo staff only')).toBeInTheDocument();
    const table = screen.getByRole('table');
    expect(within(table).getByRole('columnheader', { name: 'Expert' })).toBeInTheDocument();
    expect(within(table).getByRole('columnheader', { name: 'Client' })).toBeInTheDocument();
    expect(within(table).getByRole('columnheader', { name: 'Balo margin' })).toBeInTheDocument();
    expect(within(table).getByText('Current price')).toBeInTheDocument();
    expect(within(table).getByText('A$14,000')).toBeInTheDocument();
    expect(within(table).getByText('A$17,500')).toBeInTheDocument();
    expect(within(table).getByText('Already invoiced upfront')).toBeInTheDocument();
    expect(within(table).getByText('−A$4,688')).toBeInTheDocument();
    expect(within(table).getByText('A$12,812')).not.toHaveClass('text-destructive');
    expect(screen.getByText(/Waiting on Northwind/)).toBeInTheDocument();
    expect(screen.getByText(/goes into Xero/)).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Credit needed' })).not.toBeInTheDocument();
  });

  it('raises the credit banner when the final invoice is negative', () => {
    render(
      <ChangeOrderAdminPanel
        money={{
          ...FIXED,
          finalInvoiceLabel: '−A$1,200',
          finalInvoiceNegative: true,
          creditNeededText:
            'Credit needed: A$1,200. The approved change took the price below what Northwind has already been invoiced.',
        }}
      />
    );
    expect(screen.getByRole('region', { name: 'Credit needed' })).toHaveTextContent(
      'Credit needed: A$1,200.'
    );
    expect(screen.getByText('−A$1,200')).toHaveClass('text-destructive');
  });

  it('has no accessibility violations', async () => {
    const { container } = render(<ChangeOrderAdminPanel money={FIXED} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('ChangeOrderAdminPanel · time and materials', () => {
  it('shows the estimate telescope and no invoice columns', () => {
    render(
      <ChangeOrderAdminPanel
        money={{
          kind: 'tm',
          rows: [
            { label: 'Accepted estimate', value: '56 hrs', strong: false },
            { label: 'Change approved 20 Oct', value: '+10 hrs', strong: false },
            { label: 'Current estimate', value: '66 hrs', strong: true },
          ],
          pendingNote: null,
          footnote: 'Billed each period from logged time.',
        }}
      />
    );
    expect(screen.getByRole('heading', { name: 'Hours and changes' })).toBeInTheDocument();
    expect(screen.getByText('Current estimate')).toBeInTheDocument();
    expect(screen.getByText('66 hrs')).toBeInTheDocument();
    expect(screen.queryByText('Final invoice')).not.toBeInTheDocument();
    expect(screen.queryByText('Balo margin')).not.toBeInTheDocument();
    expect(screen.getByText('Billed each period from logged time.')).toBeInTheDocument();
  });
});
