import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { PayoutAssuranceNote } from './payout-assurance-note';

const TRIGGER = 'How pricing works';

const SUPPORTING_LINE =
  'You receive this full amount. Balo adds a service margin to the price your client sees.';
const ROW_QUOTE_TITLE = 'Your quote is yours';
const ROW_QUOTE_BODY = 'The amount you set here is exactly what you’re paid — no deductions.';
const ROW_MARGIN_TITLE = 'Balo adds a margin';
const ROW_MARGIN_BODY =
  'We add a service margin on top of your quote. That combined figure is the only price your client sees.';
const ROW_RATES_TITLE = 'Rates too';
const ROW_RATES_BODY =
  'On time & materials work, the margin also applies to your hourly rate and deposit.';
const FOOTER =
  'The margin percentage isn’t shown to you, and it isn’t itemised for your client — they simply see one total price.';

function getTrigger(): HTMLElement {
  return screen.getByRole('button', { name: TRIGGER });
}

describe('PayoutAssuranceNote', () => {
  it('renders the supporting line and a closed trigger at rest (popover not open)', () => {
    render(<PayoutAssuranceNote pricingMethod="fixed" />);
    expect(screen.getByText(SUPPORTING_LINE, { exact: false, selector: 'p' })).toBeInTheDocument();
    expect(getTrigger()).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('opens the disclosure popover on trigger click', async () => {
    const user = userEvent.setup();
    render(<PayoutAssuranceNote pricingMethod="fixed" />);

    await user.click(getTrigger());

    const dialog = await screen.findByRole('dialog', { name: TRIGGER });
    expect(dialog).toBeInTheDocument();
    expect(getTrigger()).toHaveAttribute('aria-expanded', 'true');
  });

  it('closes on Escape and returns focus to the trigger', async () => {
    const user = userEvent.setup();
    render(<PayoutAssuranceNote pricingMethod="fixed" />);

    const trigger = getTrigger();
    await user.click(trigger);
    expect(await screen.findByRole('dialog', { name: TRIGGER })).toBeInTheDocument();

    await user.keyboard('{Escape}');

    await screen.findByRole('button', { name: TRIGGER });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(getTrigger()).toHaveFocus();
  });

  it('closes when the close (X) button is activated', async () => {
    const user = userEvent.setup();
    render(<PayoutAssuranceNote pricingMethod="fixed" />);

    await user.click(getTrigger());
    const dialog = await screen.findByRole('dialog', { name: TRIGGER });

    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(dialog).not.toBeInTheDocument();
  });

  it('renders the exact disclosure copy verbatim when open', async () => {
    const user = userEvent.setup();
    render(<PayoutAssuranceNote pricingMethod="fixed" />);
    await user.click(getTrigger());
    await screen.findByRole('dialog', { name: TRIGGER });

    expect(screen.getByText(ROW_QUOTE_TITLE)).toBeInTheDocument();
    expect(screen.getByText(ROW_QUOTE_BODY)).toBeInTheDocument();
    expect(screen.getByText(ROW_MARGIN_TITLE)).toBeInTheDocument();
    expect(screen.getByText(ROW_MARGIN_BODY)).toBeInTheDocument();
    expect(screen.getByText(FOOTER)).toBeInTheDocument();
  });

  it('shows the "Rates too" row for time & materials pricing', async () => {
    const user = userEvent.setup();
    render(<PayoutAssuranceNote pricingMethod="tm" />);
    await user.click(getTrigger());
    await screen.findByRole('dialog', { name: TRIGGER });

    expect(screen.getByText(ROW_RATES_TITLE)).toBeInTheDocument();
    expect(screen.getByText(ROW_RATES_BODY)).toBeInTheDocument();
  });

  it('omits the "Rates too" row for fixed-price pricing', async () => {
    const user = userEvent.setup();
    render(<PayoutAssuranceNote pricingMethod="fixed" />);
    await user.click(getTrigger());
    await screen.findByRole('dialog', { name: TRIGGER });

    expect(screen.queryByText(ROW_RATES_TITLE)).not.toBeInTheDocument();
    expect(screen.queryByText(ROW_RATES_BODY)).not.toBeInTheDocument();
  });

  it('never renders a margin percentage or any bare digit (fixed)', async () => {
    const user = userEvent.setup();
    render(<PayoutAssuranceNote pricingMethod="fixed" />);
    await user.click(getTrigger());
    await screen.findByRole('dialog', { name: TRIGGER });

    // Whole document (portal included) — no digit and no "%" may appear.
    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/\d/);
    expect(text).not.toContain('%');
  });

  it('never renders a margin percentage or any bare digit (tm)', async () => {
    const user = userEvent.setup();
    render(<PayoutAssuranceNote pricingMethod="tm" />);
    await user.click(getTrigger());
    await screen.findByRole('dialog', { name: TRIGGER });

    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/\d/);
    expect(text).not.toContain('%');
  });

  it('has no accessibility violations when open (tm)', async () => {
    const user = userEvent.setup();
    render(<PayoutAssuranceNote pricingMethod="tm" />);
    await user.click(getTrigger());
    await screen.findByRole('dialog', { name: TRIGGER });

    // 'region' is a page-level landmark rule, inapplicable to an isolated component.
    const results = await axe(document.body, { rules: { region: { enabled: false } } });
    expect(results).toHaveNoViolations();
  });
});
