import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { axe } from '@/test/axe';
import {
  RATING_LABELS,
  formatReviewAttribution,
  type ReviewLandingContext,
} from '@balo/shared/reviews';
import { buildAttributionLine } from '@/components/balo/reviews/attribution-line';
import { buildReviewCaptureSeeds } from '@/test/fixtures/review-capture-seeds';

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
  reviewerLastInitial: 'M',
  reviewerJobTitle: null,
  reviewerLastShowCompany: null,
  clientCompanyNameAllowed: true,
  clientIndustryName: null,
  title: 'Flow interview stuck on a record-triggered loop',
  concludedOnIso: '2026-08-03T00:00:00.000Z',
};

const EXISTING_BASE = {
  bodyVisibility: 'public',
  showCompany: true,
  reviewerRole: null,
} as const;

/** The seeds fixture is the single source of the capture defaults the forms resolve from. */
const SEEDS = buildReviewCaptureSeeds({
  identity: {
    engagementKind: 'case',
    reviewerFirstName: 'Dana',
    reviewerLastInitial: 'M',
    companyName: 'Northwind Industrial',
  },
});

function lineFor(input: {
  role: string | null;
  showCompany: boolean;
  hasNote?: boolean;
  bodyVisibility?: 'public' | 'private';
  companyNameAllowed?: boolean;
  industryName?: string | null;
}): string {
  return buildAttributionLine({
    expertName: 'Amara',
    attribution: formatReviewAttribution({
      firstName: SEEDS.identity.reviewerFirstName,
      lastInitial: SEEDS.identity.reviewerLastInitial,
      role: input.role,
      companyName: SEEDS.identity.companyName,
      industryName: input.industryName ?? null,
      showCompany: input.showCompany,
      companyNameAllowed: input.companyNameAllowed ?? true,
    }),
    hasNote: input.hasNote ?? false,
    bodyVisibility: input.bodyVisibility ?? 'public',
  }).text;
}

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
    expect(screen.queryByLabelText(/Add a note/)).not.toBeInTheDocument();
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

    expect(screen.getByLabelText(/Add a note/)).toBeInTheDocument();
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

  it('posts ONLY the token, the review fields and the attribution choices — no ids of any kind', async () => {
    const user = userEvent.setup();
    renderForm({ prefill: 5 });

    await user.type(screen.getByLabelText(/Add a note/), '  Fixed it in one call  ');
    await user.click(screen.getByRole('button', { name: 'Send my review' }));

    await waitFor(() => expect(mockSubmit).toHaveBeenCalledTimes(1));
    expect(mockSubmit).toHaveBeenCalledWith({
      token: TOKEN,
      rating: 5,
      body: 'Fixed it in one call',
      showCompany: true,
      bodyVisibility: 'public',
    });
  });

  it('omits an empty body rather than sending whitespace', async () => {
    const user = userEvent.setup();
    renderForm({ prefill: 3 });

    await user.type(screen.getByLabelText(/Add a note/), '   ');
    await user.click(screen.getByRole('button', { name: 'Send my review' }));

    await waitFor(() =>
      expect(mockSubmit).toHaveBeenCalledWith({
        token: TOKEN,
        rating: 3,
        showCompany: true,
        bodyVisibility: 'public',
      })
    );
  });

  it('shows the success state — rating echoed in words, body quoted — and does NOT toast', async () => {
    const user = userEvent.setup();
    renderForm({ prefill: 4 });

    await user.type(screen.getByLabelText(/Add a note/), 'Calm and clear');
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
      existing: {
        rating: 3,
        body: 'Half of it landed',
        ratedOnIso: '2026-07-12T00:00:00.000Z',
        ...EXISTING_BASE,
      },
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

    await user.type(screen.getByLabelText(/Add a note/), 'Half of it landed');
    await user.click(screen.getByRole('button', { name: 'Send my review' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      "We couldn't save your review just now."
    );
    expect(screen.getByLabelText(/Add a note/)).toHaveValue('Half of it landed');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled();
    expect(star(2)).toHaveAttribute('aria-checked', 'true');
  });

  it('shows the already-rated disclosure and switches the CTA to Update', () => {
    renderForm({
      existing: {
        rating: 3,
        body: 'Half of it landed',
        ratedOnIso: '2026-07-12T00:00:00.000Z',
        ...EXISTING_BASE,
      },
    });

    expect(
      screen.getByText(
        /You rated Amara 3 out of 5 on 12 July 2026\. Sending this replaces that — nothing changes until you do\./
      )
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Update my review' })).toBeInTheDocument();
    expect(screen.getByLabelText(/Add a note/)).toHaveValue('Half of it landed');
  });

  it('lets the emailed star override the existing rating', () => {
    renderForm({
      prefill: 5,
      existing: {
        rating: 3,
        body: null,
        ratedOnIso: '2026-07-12T00:00:00.000Z',
        ...EXISTING_BASE,
      },
    });

    expect(star(5)).toHaveAttribute('aria-checked', 'true');
  });

  it('discloses UNDER WHOSE NAME the review is sent, by first name only', () => {
    renderForm();

    expect(screen.getByText('Dana')).toBeInTheDocument();
    expect(
      screen.getByText(/Whatever you send here is submitted under Dana’s name\./)
    ).toBeInTheDocument();
    expect(
      screen.getByText(/If this was forwarded to you, ask them to send it themselves\./)
    ).toBeInTheDocument();
    // FIRST NAME ONLY — never an email address.
    expect(screen.queryByText(/@/)).not.toBeInTheDocument();
  });

  it('no longer carries the visibility paragraph the live line replaces', () => {
    renderForm();

    expect(screen.queryByText(/Your review is published on/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Your own name is not shown/)).not.toBeInTheDocument();
    expect(screen.queryByText(/recorded as/)).not.toBeInTheDocument();
  });

  it('falls back to "the person it was sent to" when there is no first name', () => {
    renderForm({ context: { ...CONTEXT, reviewerFirstName: null, reviewerLastInitial: null } });

    expect(screen.queryByText(/This link was sent to/)).not.toBeInTheDocument();
    expect(
      screen.getByText(
        /Whatever you send here is submitted under the name of the person it was sent to\./
      )
    ).toBeInTheDocument();
  });

  it('still names the PARTY on the context card, and the person in the live line', () => {
    renderForm({ prefill: 4 });

    expect(
      screen.getByText(/Case with CloudPeak Consulting, for Northwind Industrial/)
    ).toBeInTheDocument();
    // The profile is the INDIVIDUAL expert's page, so the live line names Amara, not the agency.
    const line = screen.getByText(lineFor({ role: null, showCompany: true }));
    expect(line).not.toHaveTextContent(/CloudPeak/);
  });

  it('renders the live line exactly as the shared formatter builds it, and follows the role and the box', async () => {
    const user = userEvent.setup();
    renderForm({ prefill: 4 });

    expect(screen.getByText(lineFor({ role: null, showCompany: true }))).toBeInTheDocument();

    await user.type(screen.getByRole('textbox', { name: /Your role/ }), 'RevOps Lead');
    expect(
      screen.getByText(lineFor({ role: 'RevOps Lead', showCompany: true }))
    ).toBeInTheDocument();

    await user.click(
      screen.getByRole('checkbox', { name: 'Show Northwind Industrial on the review' })
    );
    expect(
      screen.getByText(lineFor({ role: 'RevOps Lead', showCompany: false }))
    ).toBeInTheDocument();
  });

  it('falls back to role and industry when the company may not be named', () => {
    renderForm({
      prefill: 4,
      context: {
        ...CONTEXT,
        clientCompanyNameAllowed: false,
        clientIndustryName: 'Logistics',
        reviewerJobTitle: 'RevOps Lead',
      },
    });

    expect(
      screen.getByText(
        lineFor({
          role: 'RevOps Lead',
          showCompany: true,
          companyNameAllowed: false,
          industryName: 'Logistics',
        })
      )
    ).toBeInTheDocument();
  });

  it('prefills a first review from the landing context: saved role and last company choice', async () => {
    const user = userEvent.setup();
    renderForm({
      prefill: 4,
      context: { ...CONTEXT, reviewerJobTitle: 'Head of CRM', reviewerLastShowCompany: false },
    });

    expect(screen.getByRole('textbox', { name: /Your role/ })).toHaveValue('Head of CRM');
    expect(
      screen.getByRole('checkbox', { name: 'Show Northwind Industrial on the review' })
    ).not.toBeChecked();

    await user.click(screen.getByRole('button', { name: 'Send my review' }));
    await waitFor(() =>
      expect(mockSubmit).toHaveBeenCalledWith(
        expect.objectContaining({ reviewerRole: 'Head of CRM', showCompany: false })
      )
    );
  });

  it('labels the note "Add a note (optional)" with the public-reader placeholder', async () => {
    const user = userEvent.setup();
    renderForm();
    await user.click(star(4));

    const note = screen.getByRole('textbox', { name: 'Add a note (optional)' });
    expect(note).toHaveAttribute(
      'placeholder',
      'What would you tell another team thinking of working with Amara?'
    );
  });

  it('flags an @ in the role inline and will not send until it is fixed', async () => {
    const user = userEvent.setup();
    renderForm({ prefill: 4 });

    const field = screen.getByRole('textbox', { name: /Your role/ });
    await user.type(field, 'CTO @Salesforce');

    expect(screen.getByText('Roles can’t include @ or special characters')).toBeInTheDocument();
    expect(field).toHaveAttribute('aria-invalid', 'true');
    const send = screen.getByRole('button', { name: 'Send my review' });
    expect(send).toBeDisabled();
    expect(mockSubmit).not.toHaveBeenCalled();

    await user.clear(field);
    await user.type(field, 'CTO');
    expect(send).toBeEnabled();
  });

  it('hides the saved-title helper when an existing review (not the job title) seeded the role', () => {
    renderForm({
      existing: {
        rating: 3,
        body: null,
        ratedOnIso: '2026-07-12T00:00:00.000Z',
        ...EXISTING_BASE,
        reviewerRole: 'RevOps Lead',
      },
      context: { ...CONTEXT, reviewerJobTitle: 'RevOps Lead' },
    });
    expect(screen.queryByText(/From your last review/)).not.toBeInTheDocument();
  });

  it('shows the saved-title helper only until the seeded role is cleared', async () => {
    const user = userEvent.setup();
    renderForm({ prefill: 4, context: { ...CONTEXT, reviewerJobTitle: 'Head of CRM' } });
    expect(screen.getByText(/From your last review/)).toBeInTheDocument();
    await user.clear(screen.getByRole('textbox', { name: /Your role/ }));
    expect(screen.queryByText(/From your last review/)).not.toBeInTheDocument();
  });

  it('renders no checkbox for a company that may not be named, and sends showCompany false', async () => {
    const user = userEvent.setup();
    renderForm({ prefill: 4, context: { ...CONTEXT, clientCompanyNameAllowed: false } });

    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(
      screen.getByText(lineFor({ role: null, showCompany: true, companyNameAllowed: false }))
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Send my review' }));
    await waitFor(() =>
      expect(mockSubmit).toHaveBeenCalledWith(expect.objectContaining({ showCompany: false }))
    );
  });

  it('sends all three attribution fields when RESUBMITTING over an existing review', async () => {
    const user = userEvent.setup();
    renderForm({
      existing: {
        rating: 3,
        body: 'Half of it landed',
        ratedOnIso: '2026-07-12T00:00:00.000Z',
        bodyVisibility: 'private',
        showCompany: false,
        reviewerRole: 'Sales Director',
      },
    });

    // The existing review's own values win over the job title and the last choice.
    expect(screen.getByRole('textbox', { name: /Your role/ })).toHaveValue('Sales Director');
    expect(
      screen.getByRole('checkbox', { name: 'Show Northwind Industrial on the review' })
    ).not.toBeChecked();
    expect(
      screen.getByRole('button', { name: 'Show the note on Amara’s profile instead' })
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Update my review' }));
    await waitFor(() =>
      expect(mockSubmit).toHaveBeenCalledWith({
        token: TOKEN,
        rating: 3,
        body: 'Half of it landed',
        reviewerRole: 'Sales Director',
        showCompany: false,
        bodyVisibility: 'private',
      })
    );
  });

  it('sends a private note choice and caps the role at 60 characters', async () => {
    const user = userEvent.setup();
    renderForm({ prefill: 4 });

    expect(screen.getByRole('textbox', { name: /Your role/ })).toHaveAttribute('maxlength', '60');

    await user.type(screen.getByLabelText(/Add a note/), 'Between us');
    await user.click(
      screen.getByRole('button', { name: 'Send the note to Balo privately instead' })
    );
    expect(
      screen.getByText(
        lineFor({ role: null, showCompany: true, hasNote: true, bodyVisibility: 'private' })
      )
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Send my review' }));
    await waitFor(() =>
      expect(mockSubmit).toHaveBeenCalledWith(
        expect.objectContaining({ body: 'Between us', bodyVisibility: 'private' })
      )
    );
  });

  it('shows no attribution controls until a star is chosen', () => {
    renderForm();

    expect(screen.queryByRole('textbox', { name: /Your role/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Preview' })).not.toBeInTheDocument();
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
