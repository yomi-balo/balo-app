import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import {
  derivePromoCounts,
  type PromoCodeAdminRow,
  type PromoCodesAdminDTO,
} from '@/lib/promo-codes/promo-codes-view';
import { makePromoRow as makeRow } from '@/test/fixtures/promo-codes';
import { PromoCodesShell } from './promo-codes-shell';

// Stub the mutation dialogs — this test covers the shell's filter/tiles/panel wiring,
// not the dialogs (which pull in Server Actions). Keeps `@balo/db` out of the bundle.
vi.mock('./mint-promo-dialog', () => ({ MintPromoDialog: () => null }));
vi.mock('./edit-cap-dialog', () => ({ EditCapDialog: () => null }));
vi.mock('./deactivate-code-dialog', () => ({ DeactivateCodeDialog: () => null }));

vi.mock('motion/react', () => ({
  motion: new Proxy(
    {},
    {
      get:
        (_t, tag: string) =>
        ({ children, ...rest }: { children?: React.ReactNode } & Record<string, unknown>) => {
          const { initial, animate, transition, ...domProps } = rest;
          void initial;
          void animate;
          void transition;
          const Tag = tag as keyof React.JSX.IntrinsicElements;
          return <Tag {...domProps}>{children}</Tag>;
        },
    }
  ),
}));

function makeDto(rows: PromoCodeAdminRow[]): PromoCodesAdminDTO {
  return { rows, counts: derivePromoCounts(rows), isEmpty: rows.length === 0 };
}

const ACTIVE_ROW = makeRow({ id: 'a', code: 'ACTIVE1', displayStatus: 'active' });
const SCHEDULED_ROW = makeRow({ id: 's', code: 'SOON1', displayStatus: 'scheduled' });
const EXPIRED_ROW = makeRow({ id: 'e', code: 'OLD1', displayStatus: 'expired' });
const FULL_DTO = makeDto([ACTIVE_ROW, SCHEDULED_ROW, EXPIRED_ROW]);

describe('PromoCodesShell', () => {
  it('renders every code under the default "All" filter', () => {
    render(<PromoCodesShell dto={FULL_DTO} />);
    expect(screen.getByText('ACTIVE1')).toBeInTheDocument();
    expect(screen.getByText('SOON1')).toBeInTheDocument();
    expect(screen.getByText('OLD1')).toBeInTheDocument();
  });

  it('narrows to a single status when its tile is clicked, and clears back to all', async () => {
    const user = userEvent.setup();
    render(<PromoCodesShell dto={FULL_DTO} />);
    await user.click(screen.getByRole('button', { name: /scheduled/i }));
    expect(screen.getByText('SOON1')).toBeInTheDocument();
    expect(screen.queryByText('ACTIVE1')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /show all/i }));
    expect(screen.getByText('ACTIVE1')).toBeInTheDocument();
  });

  it('shows a positive filtered-empty invitation when a status slice is empty', async () => {
    const user = userEvent.setup();
    render(<PromoCodesShell dto={makeDto([ACTIVE_ROW])} />);
    await user.click(screen.getByRole('button', { name: /deactivated/i }));
    expect(screen.getByText('Nothing deactivated')).toBeInTheDocument();
    expect(screen.queryByText('ACTIVE1')).not.toBeInTheDocument();
  });

  it('renders the true-zero invitation (not tiles) when the DTO is empty', () => {
    render(<PromoCodesShell dto={makeDto([])} />);
    expect(screen.getByText('Mint your first promo code')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /scheduled/i })).not.toBeInTheDocument();
  });

  it('toggles the redemptions panel for a code from its View action', async () => {
    const user = userEvent.setup();
    render(<PromoCodesShell dto={FULL_DTO} />);
    expect(
      screen.queryByRole('region', { name: /redemptions for ACTIVE1/i })
    ).not.toBeInTheDocument();

    const [viewButton] = screen.getAllByRole('button', { name: /view redemptions/i });
    if (viewButton === undefined) throw new Error('expected a view-redemptions action');
    await user.click(viewButton);
    expect(screen.getByRole('region', { name: /redemptions for ACTIVE1/i })).toBeInTheDocument();

    // Clicking again hides the panel.
    await user.click(screen.getByRole('button', { name: /hide redemptions/i }));
    expect(
      screen.queryByRole('region', { name: /redemptions for ACTIVE1/i })
    ).not.toBeInTheDocument();
  });

  it('always offers the one emphasised "Mint a code" action', () => {
    render(<PromoCodesShell dto={FULL_DTO} />);
    expect(screen.getByRole('button', { name: /mint a code/i })).toBeInTheDocument();
  });
});
