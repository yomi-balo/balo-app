import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { track, EXPERT_RATE_EVENTS } from '@/lib/analytics';
import { RateTab } from './rate-tab';
import { saveRateAction } from '../_actions/save-rate';

vi.mock('../_actions/save-rate', () => ({ saveRateAction: vi.fn() }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const mockSave = vi.mocked(saveRateAction);

const minuteInput = (): HTMLInputElement =>
  screen.getByRole('textbox', { name: 'Rate per minute in dollars' });
const hourInput = (): HTMLInputElement =>
  screen.getByRole('textbox', { name: 'Rate per hour in dollars' });
const conversionRegion = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[aria-live="polite"]');
const saveButton = (): HTMLElement => screen.getByRole('button', { name: /Save rate/ });

async function typeRate(input: HTMLElement, value: string): Promise<void> {
  const user = userEvent.setup();
  await user.clear(input);
  await user.type(input, value);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSave.mockResolvedValue({ success: true });
});

describe('RateTab — header', () => {
  it('opens with the shared settings header: icon left of the title, not a centred hero', () => {
    const { container } = render(<RateTab initialRateCents={250} />);

    const heading = screen.getByRole('heading', { level: 1, name: 'Set Your Rate' });
    expect(screen.getByText(/This is your take-home rate\./).closest('div')).toContainElement(
      heading
    );
    expect(heading.closest('.text-center')).toBeNull();

    const header = heading.closest('.items-start');
    expect(header?.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    expect(container.querySelector('.mx-auto')).toBeNull();
  });
});

describe('RateTab — unit toggle', () => {
  it('round-trips between units without enabling Save', async () => {
    const user = userEvent.setup();
    render(<RateTab initialRateCents={230} />);
    expect(minuteInput()).toHaveValue('2.30');

    await user.click(screen.getByRole('radio', { name: 'Per hour' }));
    expect(hourInput()).toHaveValue('138.00');
    expect(screen.getByRole('radio', { name: 'Per hour' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: 'Per minute' })).toHaveAttribute(
      'aria-checked',
      'false'
    );
    expect(screen.getByText('/ hour')).toBeInTheDocument();
    expect(saveButton()).toBeDisabled();

    await user.click(screen.getByRole('radio', { name: 'Per minute' }));
    expect(minuteInput()).toHaveValue('2.30');
    expect(saveButton()).toBeDisabled();
  });

  it('re-renders a rounded hourly entry from the stored per-minute cents', async () => {
    const user = userEvent.setup();
    render(<RateTab initialRateCents={230} />);

    await user.click(screen.getByRole('radio', { name: 'Per hour' }));
    await typeRate(hourInput(), '200');
    await user.click(screen.getByRole('radio', { name: 'Per minute' }));
    expect(minuteInput()).toHaveValue('3.34');

    await user.click(screen.getByRole('radio', { name: 'Per hour' }));
    expect(hourInput()).toHaveValue('200.40');
  });

  it('keeps an empty input empty across a toggle and clears a zero entry', async () => {
    const user = userEvent.setup();
    render(<RateTab initialRateCents={null} />);

    await user.click(screen.getByRole('radio', { name: 'Per hour' }));
    expect(hourInput()).toHaveValue('');

    await typeRate(hourInput(), '0');
    await user.click(screen.getByRole('radio', { name: 'Per minute' }));
    expect(minuteInput()).toHaveValue('');
  });

  it('is a no-op when the active option is clicked again', async () => {
    const user = userEvent.setup();
    render(<RateTab initialRateCents={null} />);

    await typeRate(minuteInput(), '2.');
    await user.click(screen.getByRole('radio', { name: 'Per minute' }));
    expect(minuteInput()).toHaveValue('2.');
  });

  it('exposes a radiogroup with a single tab stop on the checked radio', () => {
    render(<RateTab initialRateCents={230} />);

    expect(screen.getByRole('radiogroup', { name: 'Enter your rate' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Per minute' })).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('radio', { name: 'Per hour' })).toHaveAttribute('tabindex', '-1');
  });

  it('moves and selects with the arrow, Home and End keys', async () => {
    const user = userEvent.setup();
    render(<RateTab initialRateCents={230} />);

    screen.getByRole('radio', { name: 'Per minute' }).focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('radio', { name: 'Per hour' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: 'Per hour' })).toHaveFocus();
    expect(screen.getByRole('radio', { name: 'Per hour' })).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('radio', { name: 'Per minute' })).toHaveAttribute('tabindex', '-1');

    await user.keyboard('{ArrowLeft}');
    expect(screen.getByRole('radio', { name: 'Per minute' })).toHaveAttribute(
      'aria-checked',
      'true'
    );

    await user.keyboard('{End}');
    expect(screen.getByRole('radio', { name: 'Per hour' })).toHaveAttribute('aria-checked', 'true');

    await user.keyboard('{Home}');
    expect(screen.getByRole('radio', { name: 'Per minute' })).toHaveAttribute(
      'aria-checked',
      'true'
    );

    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('radio', { name: 'Per hour' })).toHaveAttribute('aria-checked', 'true');

    await user.keyboard('{ArrowUp}');
    expect(screen.getByRole('radio', { name: 'Per minute' })).toHaveAttribute(
      'aria-checked',
      'true'
    );
  });

  it('ignores keys that are not navigation keys', async () => {
    const user = userEvent.setup();
    render(<RateTab initialRateCents={230} />);

    screen.getByRole('radio', { name: 'Per minute' }).focus();
    await user.keyboard('a');
    expect(screen.getByRole('radio', { name: 'Per minute' })).toHaveAttribute(
      'aria-checked',
      'true'
    );
  });
});

describe('RateTab — conversion line', () => {
  it('explains the rounding in a live region the input points to', async () => {
    const user = userEvent.setup();
    render(<RateTab initialRateCents={null} />);
    await user.click(screen.getByRole('radio', { name: 'Per hour' }));
    await typeRate(hourInput(), '200');

    const describedBy = hourInput().getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    const region = document.getElementById(describedBy ?? '');
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region).toHaveAttribute('aria-atomic', 'true');
    expect(region).toHaveTextContent(
      "You're paid per minute, so this saves as A$3.34/minute (A$200.40/hour) take-home"
    );
    expect(region?.querySelector('svg')).not.toBeNull();
  });

  it('shows the plain per-minute line when the hourly amount divides exactly', async () => {
    const user = userEvent.setup();
    render(<RateTab initialRateCents={null} />);
    await user.click(screen.getByRole('radio', { name: 'Per hour' }));
    await typeRate(hourInput(), '150');

    expect(conversionRegion()).toHaveTextContent("That's A$2.50/minute take-home");
    expect(screen.queryByText(/You're paid per minute/)).toBeNull();
    expect(conversionRegion()?.querySelector('svg')).toBeNull();
  });

  it('shows the hourly equivalent in minute mode', () => {
    render(<RateTab initialRateCents={230} />);
    expect(conversionRegion()).toHaveTextContent("That's A$138.00/hour take-home");
  });

  it('renders no take-home text while the input is empty', () => {
    render(<RateTab initialRateCents={null} />);
    expect(conversionRegion()?.textContent).toBe('');
  });
});

describe('RateTab — validation', () => {
  it('rejects an hourly amount above the maximum and accepts the maximum itself', async () => {
    const user = userEvent.setup();
    render(<RateTab initialRateCents={null} />);
    await user.click(screen.getByRole('radio', { name: 'Per hour' }));

    await typeRate(hourInput(), '3000.01');
    expect(screen.getByRole('alert')).toHaveTextContent('Max rate is A$3000.00/hour');
    expect(saveButton()).toBeDisabled();

    await typeRate(hourInput(), '3000.00');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(saveButton()).toBeEnabled();
  });

  it('rejects a per-minute amount above the maximum', async () => {
    render(<RateTab initialRateCents={null} />);

    await typeRate(minuteInput(), '50.01');
    expect(screen.getByRole('alert')).toHaveTextContent('Max rate is A$50.00/min');
    expect(saveButton()).toBeDisabled();
  });

  it('rejects a zero rate', async () => {
    render(<RateTab initialRateCents={null} />);

    await typeRate(minuteInput(), '0');
    expect(screen.getByRole('alert')).toHaveTextContent('Rate must be greater than zero');
  });

  it('ignores input that is not a dollar amount', async () => {
    render(<RateTab initialRateCents={null} />);

    await typeRate(minuteInput(), '1a.234');
    expect(minuteInput()).toHaveValue('1.23');
  });
});

describe('RateTab — save', () => {
  it('saves the rounded-up per-minute cents from an hourly entry', async () => {
    const user = userEvent.setup();
    render(<RateTab initialRateCents={230} />);
    await user.click(screen.getByRole('radio', { name: 'Per hour' }));
    await typeRate(hourInput(), '200');
    await user.click(saveButton());

    expect(mockSave).toHaveBeenCalledWith({ ratePerMinuteCents: 334 });
    expect(toast.success).toHaveBeenCalledWith('Rate saved — A$200.40/hour');
    expect(hourInput()).toHaveValue('200.40');
    expect(screen.getByText(/That's/)).toHaveTextContent("That's A$3.34/minute take-home");
    expect(track).toHaveBeenCalledWith(EXPERT_RATE_EVENTS.RATE_SAVED, {
      rate_per_minute_cents: 334,
      is_initial_setup: false,
      input_unit: 'hour',
      was_rounded: true,
    });
  });

  it('saves a per-minute entry and flags the initial setup', async () => {
    const user = userEvent.setup();
    render(<RateTab initialRateCents={null} />);
    await typeRate(minuteInput(), '2.30');
    await user.click(saveButton());

    expect(mockSave).toHaveBeenCalledWith({ ratePerMinuteCents: 230 });
    expect(toast.success).toHaveBeenCalledWith('Rate saved — A$2.30/min');
    expect(track).toHaveBeenCalledWith(EXPERT_RATE_EVENTS.RATE_SAVED, {
      rate_per_minute_cents: 230,
      is_initial_setup: true,
      input_unit: 'minute',
      was_rounded: false,
    });
  });

  it('shows the server error when the action reports failure', async () => {
    const user = userEvent.setup();
    mockSave.mockResolvedValue({ success: false, error: 'x' });
    render(<RateTab initialRateCents={null} />);
    await typeRate(minuteInput(), '2.30');
    await user.click(saveButton());

    expect(toast.error).toHaveBeenCalledWith('x');
    expect(track).not.toHaveBeenCalled();
  });

  it('falls back to a default message when the failure carries none', async () => {
    const user = userEvent.setup();
    mockSave.mockResolvedValue({ success: false });
    render(<RateTab initialRateCents={null} />);
    await typeRate(minuteInput(), '2.30');
    await user.click(saveButton());

    expect(toast.error).toHaveBeenCalledWith('Failed to save rate');
  });

  it('shows a generic message when the action throws', async () => {
    const user = userEvent.setup();
    mockSave.mockRejectedValue(new Error('network'));
    render(<RateTab initialRateCents={null} />);
    await typeRate(minuteInput(), '2.30');
    await user.click(saveButton());

    expect(toast.error).toHaveBeenCalledWith('Failed to save rate. Please try again.');
  });
});

describe('RateTab — what clients see', () => {
  it('states the fee as a share of the client price and drops the quick-math box', () => {
    render(<RateTab initialRateCents={230} />);

    expect(screen.queryByText(/Quick math/)).toBeNull();
    expect(screen.getByText("Includes Balo's 20% service fee")).toBeInTheDocument();
  });
});
