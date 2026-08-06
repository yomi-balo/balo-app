import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { RATING_LABELS, type ReviewLandingContext } from '@balo/shared/reviews';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const mockSubmit = vi.fn();
vi.mock('@/app/review/_actions/submit-token-review', () => ({
  submitTokenReviewAction: (...a: unknown[]) => mockSubmit(...a),
}));

import { ReviewForm } from './review-form';
import { toast } from 'sonner';

const TOKEN = 'x2Fq7ZtQmA9pLd3Wc1Rb8YvNhKsE0uJt';

const CONTEXT: ReviewLandingContext = {
  engagementKind: 'case',
  clientCompanyName: 'Northwind Industrial',
  expertPartyLabel: 'CloudPeak Consulting',
  expertGivenName: 'Amara',
  reviewerFirstName: 'Dana',
  title: 'Flow interview stuck on a record-triggered loop',
  concludedOnIso: '2026-08-03T00:00:00.000Z',
};

function renderForm(
  overrides: Partial<React.ComponentProps<typeof ReviewForm>> = {}
): ReturnType<typeof render> {
  return render(
    <ReviewForm token={TOKEN} context={CONTEXT} prefill={null} existing={null} {...overrides} />
  );
}

function star(n: 1 | 2 | 3 | 4 | 5): HTMLElement {
  return screen.getByRole('radio', { name: `${n} out of 5 — ${RATING_LABELS[n]}` });
}

/**
 * No prior review → pick 4 → send → "Change my review". The state the stale-disclosure
 * bug lived in: a live review exists on the server but `existing` is `null`.
 */
async function sendFourThenReopen(): Promise<ReturnType<typeof userEvent.setup>> {
  const user = userEvent.setup();
  renderForm();

  await user.click(star(4));
  await user.click(screen.getByRole('button', { name: 'Send my review' }));
  await user.click(await screen.findByRole('button', { name: 'Change my review' }));

  return user;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSubmit.mockResolvedValue({ success: true, created: true });
});

describe('ReviewForm', () => {
  it('says what is being rated before it asks anything', () => {
    renderForm();

    expect(screen.getByText(CONTEXT.title)).toBeInTheDocument();
    expect(
      screen.getByText(/Case with CloudPeak Consulting, for Northwind Industrial/)
    ).toBeInTheDocument();
    expect(screen.getByText(/wrapped up 3 August 2026/)).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'How was working with Amara?' })
    ).toBeInTheDocument();
  });

  it('starts with no rating: submit disabled and the note field hidden', () => {
    renderForm();

    expect(screen.getByRole('button', { name: 'Send my review' })).toBeDisabled();
    expect(screen.queryByLabelText(/Anything you/)).not.toBeInTheDocument();
    expect(screen.getByText('Pick a star to send your review')).toBeInTheDocument();
  });

  it('says "pick a star" ONCE — not twice, ~200px apart, on one short card', () => {
    renderForm();

    expect(screen.getAllByText(/Pick a star to send your review/)).toHaveLength(1);
    // The line under the button carries the thing the star label cannot say.
    expect(screen.getByText('Nothing is saved until you send it.')).toBeInTheDocument();
  });

  it('reveals the note field and enables submit on the first pick', async () => {
    const user = userEvent.setup();
    renderForm();

    await user.click(star(4));

    expect(screen.getByLabelText(/Anything you/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send my review' })).toBeEnabled();
    expect(screen.getByText('Nothing is saved until you send it.')).toBeInTheDocument();
  });

  it('arrives prefilled from ?r and shows the mis-tap affordance ONCE', async () => {
    const user = userEvent.setup();
    renderForm({ prefill: 4 });

    expect(star(4)).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText(/That's the star you tapped in the email/)).toBeInTheDocument();

    await user.click(star(2));

    expect(screen.queryByText(/That's the star you tapped in the email/)).not.toBeInTheDocument();
  });

  it('posts ONLY the token, the rating and the trimmed body — no ids of any kind', async () => {
    const user = userEvent.setup();
    renderForm({ prefill: 5 });

    await user.type(screen.getByLabelText(/Anything you/), '  Fixed it in one call  ');
    await user.click(screen.getByRole('button', { name: 'Send my review' }));

    await waitFor(() => expect(mockSubmit).toHaveBeenCalledTimes(1));
    expect(mockSubmit).toHaveBeenCalledWith({
      token: TOKEN,
      rating: 5,
      body: 'Fixed it in one call',
    });
  });

  it('omits an empty body rather than sending whitespace', async () => {
    const user = userEvent.setup();
    renderForm({ prefill: 3 });

    await user.type(screen.getByLabelText(/Anything you/), '   ');
    await user.click(screen.getByRole('button', { name: 'Send my review' }));

    await waitFor(() => expect(mockSubmit).toHaveBeenCalledWith({ token: TOKEN, rating: 3 }));
  });

  it('shows the success state — rating echoed in words, body quoted — and does NOT toast', async () => {
    const user = userEvent.setup();
    renderForm({ prefill: 4 });

    await user.type(screen.getByLabelText(/Anything you/), 'Calm and clear');
    await user.click(screen.getByRole('button', { name: 'Send my review' }));

    expect(
      await screen.findByRole('heading', { name: /Thank you — that's genuinely useful./ })
    ).toBeInTheDocument();
    expect(
      screen.getByText(`You rated Amara 4 out of 5 — ${RATING_LABELS[4]}.`)
    ).toBeInTheDocument();
    expect(screen.getByText('Calm and clear')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Sign in to see the engagement' })).toBeInTheDocument();
    // The full-page success state IS the confirmation — a toast on top is noise.
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('toasts on the RESUBMIT path, where the page barely changes', async () => {
    const user = userEvent.setup();
    renderForm({ prefill: 4 });

    await user.click(screen.getByRole('button', { name: 'Send my review' }));
    await user.click(await screen.findByRole('button', { name: 'Change my review' }));
    // The CTA is an UPDATE now — there IS a live review, this session just wrote it.
    await user.click(screen.getByRole('button', { name: 'Update my review' }));

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Your review is updated'));
  });

  it('after Change my review, the box quotes THIS SESSION — not the stale server prop', async () => {
    const user = userEvent.setup();
    renderForm({
      existing: { rating: 3, body: 'Half of it landed', ratedOnIso: '2026-07-12T00:00:00.000Z' },
    });

    await user.click(star(5));
    await user.click(screen.getByRole('button', { name: 'Update my review' }));
    await user.click(await screen.findByRole('button', { name: 'Change my review' }));

    // `existing` is a server prop and the action deliberately revalidates nothing, so
    // trusting it here would tell the reviewer the live review is still the 3 from July.
    expect(screen.getByText(/You rated Amara 5 out of 5 a moment ago\./)).toBeInTheDocument();
    expect(screen.queryByText(/3 out of 5 on 12 July 2026/)).not.toBeInTheDocument();
  });

  it('becomes an update after the first send even when there was no prior review', async () => {
    await sendFourThenReopen();

    expect(screen.getByText(/You rated Amara 4 out of 5 a moment ago\./)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Update my review' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send my review' })).not.toBeInTheDocument();
  });

  it('keeps quoting the last SUCCESSFUL send when a resubmit then fails', async () => {
    const user = await sendFourThenReopen();

    mockSubmit.mockResolvedValue({
      success: false,
      error: "We couldn't save your review just now.",
    });
    await user.click(star(2));
    await user.click(screen.getByRole('button', { name: 'Update my review' }));

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    // The 2 never landed; the live review is still the 4.
    expect(screen.getByText(/You rated Amara 4 out of 5 a moment ago\./)).toBeInTheDocument();
  });

  it('keeps the draft on failure and offers Try again — no blame, nothing lost', async () => {
    const user = userEvent.setup();
    mockSubmit.mockResolvedValue({
      success: false,
      error: "We couldn't save your review just now.",
    });
    renderForm({ prefill: 2 });

    await user.type(screen.getByLabelText(/Anything you/), 'Half of it landed');
    await user.click(screen.getByRole('button', { name: 'Send my review' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      "We couldn't save your review just now."
    );
    expect(screen.getByLabelText(/Anything you/)).toHaveValue('Half of it landed');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled();
    expect(star(2)).toHaveAttribute('aria-checked', 'true');
  });

  it('shows the already-rated disclosure and switches the CTA to Update', () => {
    renderForm({
      existing: { rating: 3, body: 'Half of it landed', ratedOnIso: '2026-07-12T00:00:00.000Z' },
    });

    expect(
      screen.getByText(
        /You rated Amara 3 out of 5 on 12 July 2026\. Sending this replaces that — nothing changes until you do\./
      )
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Update my review' })).toBeInTheDocument();
    expect(screen.getByLabelText(/Anything you/)).toHaveValue('Half of it landed');
  });

  it('lets the emailed star override the existing rating', () => {
    renderForm({
      prefill: 5,
      existing: { rating: 3, body: null, ratedOnIso: '2026-07-12T00:00:00.000Z' },
    });

    expect(star(5)).toHaveAttribute('aria-checked', 'true');
  });

  it('discloses truthfully WHAT publishes and UNDER WHOSE NAME', () => {
    renderForm();

    expect(
      screen.getByText(
        /Your review is published on Amara's Balo expert profile — your rating, what you wrote, and your company name,/
      )
    ).toBeInTheDocument();
    expect(screen.getByText(/Your own name is not shown\./)).toBeInTheDocument();
    expect(screen.getByText(/This link was sent to/)).toBeInTheDocument();
    // The COMPANY-attribution half is truthful (D6) and stays exactly as it was.
    expect(
      screen.getByText(/recorded as Northwind Industrial's review of Amara/)
    ).toBeInTheDocument();
    expect(
      screen.getByText(/If this was forwarded to you, ask them to send it themselves\./)
    ).toBeInTheDocument();
    // FIRST NAME ONLY — never an email address.
    expect(screen.queryByText(/@/)).not.toBeInTheDocument();
  });

  it('names a profile that EXISTS: the person, never the agency the party label carries', () => {
    renderForm();

    // `listPublicByExpert` is keyed on `expert_profile_id`, and the only public profile
    // route is `(marketing)/experts/[username]` — the INDIVIDUAL expert's page. There is
    // no agency profile route anywhere, so "CloudPeak Consulting's Balo profile" would
    // send a reviewer to a surface that does not exist, and would misdescribe whose page
    // their words land on while they decide how frank to be.
    const disclosure = screen.getByText(/Your review is published on/);
    expect(disclosure).toHaveTextContent("Amara's Balo expert profile");
    expect(disclosure).not.toHaveTextContent(/CloudPeak/);

    // …while the CONTEXT CARD still names the PARTY. That one is correct: it answers
    // "what am I being asked about", and the client contracted with the agency.
    expect(
      screen.getByText(/Case with CloudPeak Consulting, for Northwind Industrial/)
    ).toBeInTheDocument();
  });

  it('disables the stars and the button while the submit is in flight', async () => {
    const user = userEvent.setup();
    let resolveSubmit: (value: { success: true; created: boolean }) => void = () => {};
    mockSubmit.mockReturnValue(
      new Promise((resolve) => {
        resolveSubmit = resolve;
      })
    );
    renderForm({ prefill: 5 });

    await user.click(screen.getByRole('button', { name: 'Send my review' }));

    expect(await screen.findByRole('button', { name: /Sending your review/ })).toBeDisabled();
    expect(star(1)).toBeDisabled();

    resolveSubmit({ success: true, created: true });
    expect(await screen.findByRole('button', { name: 'Change my review' })).toBeInTheDocument();
  });

  it('has no axe violations in the capture state', async () => {
    const { container } = renderForm({ prefill: 4 });

    expect(await axe(container)).toHaveNoViolations();
  });
});
