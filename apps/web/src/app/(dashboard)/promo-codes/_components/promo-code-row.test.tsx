import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { makePromoRow as makeRow } from '@/test/fixtures/promo-codes';
import { PromoCodeRow } from './promo-code-row';

const noop = (): void => {};

describe('PromoCodeRow', () => {
  it('renders code, grant, cap usage, remaining, validity, and the status chip', () => {
    render(
      <PromoCodeRow
        row={makeRow()}
        selected={false}
        last
        onView={noop}
        onEditCap={noop}
        onDeactivate={noop}
      />
    );
    expect(screen.getByText('WELCOME50')).toBeInTheDocument();
    expect(screen.getByText('A$50.00')).toBeInTheDocument();
    expect(screen.getByText('30 of 100 redeemed')).toBeInTheDocument();
    expect(screen.getByText('70 left')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
    // Validity dates render viewer-local via <LocalDate> (UTC "1 Jul" under TZ=UTC).
    expect(screen.getByText(/Valid/)).toHaveTextContent('1 Jul');
  });

  it('fires onView with the code id when View is clicked', async () => {
    const onView = vi.fn();
    const user = userEvent.setup();
    render(
      <PromoCodeRow
        row={makeRow()}
        selected={false}
        last
        onView={onView}
        onEditCap={noop}
        onDeactivate={noop}
      />
    );
    await user.click(screen.getByRole('button', { name: /view redemptions/i }));
    expect(onView).toHaveBeenCalledWith('p-1');
  });

  it('reflects the selected state and offers to hide', () => {
    render(
      <PromoCodeRow
        row={makeRow()}
        selected
        last
        onView={noop}
        onEditCap={noop}
        onDeactivate={noop}
      />
    );
    const viewButton = screen.getByRole('button', { name: /hide redemptions/i });
    expect(viewButton).toHaveAttribute('aria-pressed', 'true');
  });

  it('fires onEditCap and onDeactivate with the row', async () => {
    const onEditCap = vi.fn();
    const onDeactivate = vi.fn();
    const user = userEvent.setup();
    const row = makeRow();
    render(
      <PromoCodeRow
        row={row}
        selected={false}
        last
        onView={noop}
        onEditCap={onEditCap}
        onDeactivate={onDeactivate}
      />
    );
    await user.click(screen.getByRole('button', { name: /edit cap/i }));
    await user.click(screen.getByRole('button', { name: /deactivate/i }));
    expect(onEditCap).toHaveBeenCalledWith(row);
    expect(onDeactivate).toHaveBeenCalledWith(row);
  });

  it('hides the Deactivate action for an already-deactivated code', () => {
    render(
      <PromoCodeRow
        row={makeRow({ displayStatus: 'deactivated' })}
        selected={false}
        last
        onView={noop}
        onEditCap={noop}
        onDeactivate={noop}
      />
    );
    expect(screen.queryByRole('button', { name: /deactivate/i })).not.toBeInTheDocument();
    expect(screen.getByText('Deactivated')).toBeInTheDocument();
  });
});
