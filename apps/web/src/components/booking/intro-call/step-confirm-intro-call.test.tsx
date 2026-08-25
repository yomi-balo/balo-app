import { describe, it, expect, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { render, screen } from '@/test/utils';
import { StepConfirmIntroCall } from './step-confirm-intro-call';

const SLOT = {
  startIso: '2026-06-05T09:00:00.000Z',
  endIso: '2026-06-05T09:30:00.000Z',
  durationMinutes: 30 as const,
};

function renderStep(overrides: Record<string, unknown> = {}) {
  const onChangeTime = vi.fn();
  const onGuestsChange = vi.fn();
  const onBack = vi.fn();
  const onSubmit = vi.fn();
  const rendered = render(
    <StepConfirmIntroCall
      slot={SLOT}
      viewerTimezone="UTC"
      requestTitle="CPQ implementation"
      onChangeTime={onChangeTime}
      guests={[]}
      onGuestsChange={onGuestsChange}
      viewerEmailDomain="northwind.example"
      clientCompanyName="Northwind Industrial"
      staleSlot={false}
      submitting={false}
      onBack={onBack}
      onSubmit={onSubmit}
      {...overrides}
    />
  );
  return { ...rendered, onChangeTime, onGuestsChange, onBack, onSubmit };
}

/** The ONE sentence on this step that may mention money — and only to negate it. */
const FREE_LINE = 'Free — no charge, no commitment.';

describe('StepConfirmIntroCall', () => {
  it('shows the slot summary, the request-title context strip, and the free reassurance line', () => {
    renderStep();
    expect(screen.getByText('Intro call · 30 min')).toBeInTheDocument();
    expect(screen.getByText(/Intro call for/)).toBeInTheDocument();
    expect(screen.getByText('CPQ implementation', { exact: false })).toBeInTheDocument();
    expect(screen.getByText('Free — no charge, no commitment.')).toBeInTheDocument();
  });

  /**
   * ⚠ THIS ASSERTION USED TO BE VACUOUS (round-1 C3). It regexed `/per minute/`,
   * `/cancellation/`, `/existing case/` and `/bill(ed)? to/` — and NONE of them matched the
   * word actually on screen, which was the guest composer's "guests don't change what you
   * PAY". A green that proves nothing is worse than no test, so the vocabulary is now the
   * MONEY vocabulary itself, not a list of component names.
   */
  it('renders NO money vocabulary anywhere on the step — Ruling 2', () => {
    const { container } = renderStep();
    // Assert over the WHOLE rendered text, minus the one sanctioned negation — a per-node
    // `queryByText` would have missed the guest composer's counter, which is exactly how the
    // original assertion stayed green while "guests don't change what you pay" was on screen.
    const text = (container.textContent ?? '').replace(FREE_LINE, '');
    expect(text).not.toMatch(/\bpay\b|charge|billed|\bcost\b|price|per minute|\$\d/i);
    expect(screen.getByText(FREE_LINE)).toBeInTheDocument();
  });

  it('never renders CaseChoiceSection / CompanyPicker chrome', () => {
    renderStep();
    expect(screen.queryByText(/existing case/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/cancellation/i)).not.toBeInTheDocument();
  });

  it('renders the guest invite composer (D7 — guests ARE allowed)', () => {
    renderStep();
    expect(screen.getByLabelText('Guest email address')).toBeInTheDocument();
  });

  it('the participant counter carries NO pricing clause on this free surface (C3)', () => {
    renderStep();
    expect(screen.getByText('2 of 10')).toBeInTheDocument();
  });

  /**
   * ⚠ PRE-ENGAGEMENT: there is no case and no prior consultation (round-1 C4). The composer's
   * DEFAULT copy promises a same-domain colleague "this whole case, including consultations
   * held before today" — false here, on the common path.
   */
  it('the LIVE disclosure for a same-company address says "this intro call", never "this whole case"', async () => {
    const user = userEvent.setup();
    renderStep();
    await user.type(screen.getByLabelText('Guest email address'), 'colleague@northwind.example');

    expect(
      screen.getByText('Same company as you — they’ll only see this intro call and its recap.')
    ).toBeInTheDocument();
    expect(screen.queryByText(/whole case/i)).not.toBeInTheDocument();
  });

  it('the ADDED-guest summary says "this intro call", never "every consultation in this case"', () => {
    // The composer is CONTROLLED — the added guest arrives as a prop, not from local state.
    renderStep({ guests: [{ email: 'colleague@northwind.example' }] });

    expect(
      screen.getByText('colleague@northwind.example will only see this intro call and its recap.')
    ).toBeInTheDocument();
    expect(screen.queryByText(/every consultation in this case/i)).not.toBeInTheDocument();
  });

  it('shows the StaleSlotBanner when staleSlot is true, and fires onChangeTime', async () => {
    const user = userEvent.setup();
    const { onChangeTime } = renderStep({ staleSlot: true });
    expect(screen.getByText('This time was just booked by someone else.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Choose a new time' }));
    expect(onChangeTime).toHaveBeenCalledTimes(1);
  });

  it('fires onSubmit on confirm and shows "Booking…" while submitting', async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderStep();
    await user.click(screen.getByRole('button', { name: 'Confirm & book call' }));
    expect(onSubmit).toHaveBeenCalledTimes(1);

    renderStep({ submitting: true });
    expect(screen.getByText('Booking…')).toBeInTheDocument();
  });

  it('"See other times" and Back both invoke the change-time path', async () => {
    const user = userEvent.setup();
    const { onChangeTime, onBack } = renderStep();
    await user.click(screen.getByRole('button', { name: 'See other times' }));
    expect(onChangeTime).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: /Back/ }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
