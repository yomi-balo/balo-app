import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { OverviewTab } from './overview-tab';
import type { ProposalPricingMethod } from './proposal-composer-state';

// The full overview TipTap editor breaks in JSDOM — swap it for a textarea so we
// can drive the pricing-method radiogroup + timeframe/exclusions logic.
vi.mock('@/components/balo/rich-text-editor', () => ({
  RichTextEditor: (props: {
    value: string;
    onChange: (html: string) => void;
    ariaLabel?: string;
  }) => (
    <textarea
      aria-label={props.ariaLabel}
      value={props.value}
      onChange={(e) => props.onChange(e.target.value)}
    />
  ),
}));

interface Handlers {
  onOverviewChange: ReturnType<typeof vi.fn<(html: string) => void>>;
  onPricingMethodChange: ReturnType<typeof vi.fn<(m: ProposalPricingMethod) => void>>;
  onTimeframeChange: ReturnType<typeof vi.fn<(w: number | null) => void>>;
  onExclusionsChange: ReturnType<typeof vi.fn<(v: string) => void>>;
}

function renderOverview(method: ProposalPricingMethod = 'fixed'): Handlers {
  const handlers: Handlers = {
    onOverviewChange: vi.fn<(html: string) => void>(),
    onPricingMethodChange: vi.fn<(m: ProposalPricingMethod) => void>(),
    onTimeframeChange: vi.fn<(w: number | null) => void>(),
    onExclusionsChange: vi.fn<(v: string) => void>(),
  };
  render(
    <OverviewTab
      overview="<p>hi</p>"
      onOverviewChange={handlers.onOverviewChange}
      pricingMethod={method}
      onPricingMethodChange={handlers.onPricingMethodChange}
      timeframeWeeks={6}
      onTimeframeChange={handlers.onTimeframeChange}
      exclusions=""
      onExclusionsChange={handlers.onExclusionsChange}
    />
  );
  return handlers;
}

describe('OverviewTab — pricing method radiogroup', () => {
  it('renders a labelled radiogroup with two radios', () => {
    renderOverview();
    const group = screen.getByRole('radiogroup', { name: 'Pricing method' });
    expect(group).toBeInTheDocument();
    expect(screen.getAllByRole('radio')).toHaveLength(2);
  });

  it('marks the selected method aria-checked and tabIndex 0 (roving)', () => {
    renderOverview('fixed');
    const fixed = screen.getByRole('radio', { name: /fixed price/i });
    const tm = screen.getByRole('radio', { name: /time & materials/i });
    expect(fixed).toHaveAttribute('aria-checked', 'true');
    expect(fixed).toHaveAttribute('tabindex', '0');
    expect(tm).toHaveAttribute('aria-checked', 'false');
    expect(tm).toHaveAttribute('tabindex', '-1');
  });

  it('clicking the other card selects it', async () => {
    const user = userEvent.setup();
    const { onPricingMethodChange } = renderOverview('fixed');
    await user.click(screen.getByRole('radio', { name: /time & materials/i }));
    expect(onPricingMethodChange).toHaveBeenCalledWith('tm');
  });

  it('ArrowRight moves selection to the next radio', async () => {
    const user = userEvent.setup();
    const { onPricingMethodChange } = renderOverview('fixed');
    screen.getByRole('radio', { name: /fixed price/i }).focus();
    await user.keyboard('{ArrowRight}');
    expect(onPricingMethodChange).toHaveBeenCalledWith('tm');
  });

  it('ArrowLeft wraps from the first radio to the last', async () => {
    const user = userEvent.setup();
    const { onPricingMethodChange } = renderOverview('fixed');
    screen.getByRole('radio', { name: /fixed price/i }).focus();
    await user.keyboard('{ArrowLeft}');
    expect(onPricingMethodChange).toHaveBeenCalledWith('tm');
  });

  it('ArrowDown from T&M wraps back to Fixed', async () => {
    const user = userEvent.setup();
    const { onPricingMethodChange } = renderOverview('tm');
    screen.getByRole('radio', { name: /time & materials/i }).focus();
    await user.keyboard('{ArrowDown}');
    expect(onPricingMethodChange).toHaveBeenCalledWith('fixed');
  });

  it('parses the timeframe input — null when cleared, integer otherwise', async () => {
    const user = userEvent.setup();
    const { onTimeframeChange } = renderOverview();
    const input = screen.getByLabelText('Estimated timeframe');
    // Controlled by the `timeframeWeeks={6}` prop; a fresh keystroke appends to
    // "6", so "69" exercises the integer parse without the prop ever updating.
    await user.type(input, '9');
    expect(onTimeframeChange).toHaveBeenLastCalledWith(69);
    await user.clear(input);
    expect(onTimeframeChange).toHaveBeenLastCalledWith(null);
  });
});
