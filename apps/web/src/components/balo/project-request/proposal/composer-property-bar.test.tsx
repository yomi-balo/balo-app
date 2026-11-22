import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { ComposerPropertyBar } from './composer-property-bar';
import type { ProposalPricingMethod } from './proposal-composer-state';

interface RenderOptions {
  pricingMethod?: ProposalPricingMethod;
  timeframeWeeks?: number | null;
  trailing?: React.ReactNode;
}

function renderBar(options: RenderOptions = {}): {
  onPricingMethodChange: ReturnType<typeof vi.fn>;
  onTimeframeChange: ReturnType<typeof vi.fn>;
} {
  const onPricingMethodChange = vi.fn();
  const onTimeframeChange = vi.fn();
  render(
    <ComposerPropertyBar
      pricingMethod={options.pricingMethod ?? 'fixed'}
      onPricingMethodChange={onPricingMethodChange}
      timeframeWeeks={options.timeframeWeeks === undefined ? null : options.timeframeWeeks}
      onTimeframeChange={onTimeframeChange}
      trailing={options.trailing}
    />
  );
  return { onPricingMethodChange, onTimeframeChange };
}

describe('ComposerPropertyBar', () => {
  it('labels the chips from the current state', () => {
    renderBar({ pricingMethod: 'tm', timeframeWeeks: 6 });
    expect(screen.getByRole('button', { name: /time & materials/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'About 6 weeks' })).toBeInTheDocument();
  });

  it('uses the singular for one week', () => {
    renderBar({ timeframeWeeks: 1 });
    expect(screen.getByRole('button', { name: 'About 1 week' })).toBeInTheDocument();
  });

  it('shows "Add timeframe" when no timeframe is set', () => {
    renderBar({ timeframeWeeks: null });
    expect(screen.getByRole('button', { name: 'Add timeframe' })).toBeInTheDocument();
  });

  it('has only the pricing and timeframe chips, with no Terms chip', () => {
    renderBar({ timeframeWeeks: 6 });
    expect(screen.getAllByRole('button')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: /terms/i })).not.toBeInTheDocument();
  });

  it('renders the trailing slot without imposing a live region', () => {
    renderBar({ trailing: <span>Saved as draft</span> });
    const status = screen.getByText('Saved as draft');
    expect(status.closest('[aria-live]')).toBeNull();
  });

  describe('pricing method', () => {
    it('lists both methods as radios with the current one checked', async () => {
      const user = userEvent.setup();
      renderBar({ pricingMethod: 'fixed' });
      await user.click(screen.getByRole('button', { name: /fixed price/i }));
      const group = screen.getByRole('radiogroup', { name: 'Pricing method' });
      expect(within(group).getByRole('radio', { name: /fixed price/i })).toHaveAttribute(
        'aria-checked',
        'true'
      );
      expect(within(group).getByRole('radio', { name: /time & materials/i })).toHaveAttribute(
        'aria-checked',
        'false'
      );
    });

    it('calls the handler with the picked method and closes the popover', async () => {
      const user = userEvent.setup();
      const { onPricingMethodChange } = renderBar({ pricingMethod: 'fixed' });
      await user.click(screen.getByRole('button', { name: /fixed price/i }));
      await user.click(screen.getByRole('radio', { name: /time & materials/i }));
      expect(onPricingMethodChange).toHaveBeenCalledWith('tm');
      expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
    });
  });

  describe('timeframe', () => {
    it('steps the weeks with the − and + buttons', async () => {
      const user = userEvent.setup();
      const { onTimeframeChange } = renderBar({ timeframeWeeks: 6 });
      await user.click(screen.getByRole('button', { name: 'About 6 weeks' }));
      await user.click(screen.getByRole('button', { name: 'More weeks' }));
      expect(onTimeframeChange).toHaveBeenLastCalledWith(7);
      await user.click(screen.getByRole('button', { name: 'Fewer weeks' }));
      expect(onTimeframeChange).toHaveBeenLastCalledWith(5);
    });

    it('never steps below one week and starts from one when empty', async () => {
      const user = userEvent.setup();
      const { onTimeframeChange } = renderBar({ timeframeWeeks: 1 });
      await user.click(screen.getByRole('button', { name: 'About 1 week' }));
      await user.click(screen.getByRole('button', { name: 'Fewer weeks' }));
      expect(onTimeframeChange).toHaveBeenLastCalledWith(1);
    });

    it('starts the + stepper at one week when nothing is set', async () => {
      const user = userEvent.setup();
      const { onTimeframeChange } = renderBar({ timeframeWeeks: null });
      await user.click(screen.getByRole('button', { name: 'Add timeframe' }));
      await user.click(screen.getByRole('button', { name: 'More weeks' }));
      expect(onTimeframeChange).toHaveBeenLastCalledWith(1);
    });

    it('keeps digits only, caps the input at three digits and floors it at one', async () => {
      const user = userEvent.setup();
      const { onTimeframeChange } = renderBar({ timeframeWeeks: null });
      await user.click(screen.getByRole('button', { name: 'Add timeframe' }));
      const input = screen.getByRole('textbox', { name: 'Weeks' });
      await user.type(input, '1a2');
      expect(onTimeframeChange).toHaveBeenLastCalledWith(2);
      await user.clear(input);
      await user.type(input, '0');
      expect(onTimeframeChange).toHaveBeenLastCalledWith(1);
    });

    it('clearing the input writes null', async () => {
      const user = userEvent.setup();
      const { onTimeframeChange } = renderBar({ timeframeWeeks: 4 });
      await user.click(screen.getByRole('button', { name: 'About 4 weeks' }));
      await user.clear(screen.getByRole('textbox', { name: 'Weeks' }));
      expect(onTimeframeChange).toHaveBeenLastCalledWith(null);
    });

    it('"Remove timeframe" writes null and closes the popover', async () => {
      const user = userEvent.setup();
      const { onTimeframeChange } = renderBar({ timeframeWeeks: 4 });
      await user.click(screen.getByRole('button', { name: 'About 4 weeks' }));
      await user.click(screen.getByRole('button', { name: 'Remove timeframe' }));
      expect(onTimeframeChange).toHaveBeenCalledWith(null);
      expect(screen.queryByRole('textbox', { name: 'Weeks' })).not.toBeInTheDocument();
    });

    it('offers no remove button when there is no timeframe', async () => {
      const user = userEvent.setup();
      renderBar({ timeframeWeeks: null });
      await user.click(screen.getByRole('button', { name: 'Add timeframe' }));
      expect(screen.queryByRole('button', { name: 'Remove timeframe' })).not.toBeInTheDocument();
    });
  });
});
