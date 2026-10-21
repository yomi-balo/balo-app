import { beforeAll, describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { render, screen } from '@/test/utils';
import { EMPTY_TAXONOMY } from '@/lib/search/taxonomy';
import type { EligibleCompany } from '@balo/shared/credit';
import { StepConfirm, type StepConfirmProps } from './step-confirm';
import type { FixedCaseSummary } from './types';

// Radix Select needs the Pointer Capture APIs jsdom lacks (`company-picker.test.tsx`).
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn();
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
});

vi.mock('motion/react', async () => {
  const { createMotionStub } = await import('@/test/motion-stub');
  return createMotionStub();
});

// The real TipTap editor can't mount in jsdom (established `booking-flow-dialog.test.tsx`
// precedent) — only exercised here on the new-case branch, stubbed the same way.
vi.mock('@/components/balo/rich-text-editor', () => ({
  RichTextEditor: ({ placeholder }: { placeholder?: string }) => (
    <textarea aria-label="What you'd like to discuss" placeholder={placeholder} />
  ),
}));

const COMPANIES: EligibleCompany[] = [
  { id: 'company-1', name: 'Northwind Industrial', logoUrl: null },
  { id: 'company-2', name: 'Acme Corp', logoUrl: null },
];

const CASE_CONTEXT: FixedCaseSummary = {
  engagementId: 'engagement-1',
  title: 'Flow interview loop',
  consultationCount: 2,
  openedAtIso: '2026-06-12T09:00:00Z',
};

function renderStepConfirm(over: Partial<StepConfirmProps> = {}) {
  const props: StepConfirmProps = {
    slot: {
      startIso: '2026-09-01T04:00:00.000Z',
      endIso: '2026-09-01T04:30:00.000Z',
      durationMinutes: 30,
    },
    viewerTimezone: 'UTC',
    expertFirstName: 'Amara',
    onChangeTime: vi.fn(),
    openCases: null,
    offerNewCase: true,
    caseChoiceLoading: false,
    caseSelection: { kind: 'existing', engagementId: 'engagement-1' },
    onCaseSelectionChange: vi.fn(),
    caseContextSummary: CASE_CONTEXT,
    title: '',
    onTitleChange: vi.fn(),
    descriptionHtml: '',
    onDescriptionChange: vi.fn(),
    productIds: [],
    onProductIdsChange: vi.fn(),
    productsTaxonomy: EMPTY_TAXONOMY,
    showValidation: false,
    companies: null,
    companyReadFailed: false,
    onRetryCompanies: vi.fn(),
    companyId: null,
    onCompanyIdChange: vi.fn(),
    hasMultipleEligibleCompanies: false,
    guests: [],
    onGuestsChange: vi.fn(),
    viewerEmailDomain: null,
    clientCompanyName: null,
    staleSlot: false,
    staleSlotFollowUp: null,
    fundingSection: null,
    draftNotice: null,
    submitting: false,
    submitDisabled: false,
    onBack: vi.fn(),
    onSubmit: vi.fn(),
    ...over,
  };
  return render(<StepConfirm {...props} />);
}

const BILLED_TO_TEXT = /Billed to Northwind Industrial — same as the rest of this case\./;

// UX-1 (BAL-400 round 2) — `step-confirm.tsx:245-249` used to gate on the `companies` PROP,
// which the wrapper forces to `null` on every attach shape — making the note structurally dead
// code. It must gate on "does this client have >1 eligible company" alone.
describe('StepConfirm — the billing-account note (UX-1)', () => {
  it('renders on the ATTACH shape for a multi-company client — the exact case that was dead code', () => {
    renderStepConfirm({
      caseSelection: { kind: 'existing', engagementId: 'engagement-1' },
      companies: null, // the wrapper's real, forced-null attach-shape value
      hasMultipleEligibleCompanies: true,
      clientCompanyName: 'Northwind Industrial',
    });
    expect(screen.getByText(BILLED_TO_TEXT)).toBeInTheDocument();
  });

  it('stays absent for a single-eligible-company client, even with a resolved company name', () => {
    renderStepConfirm({
      caseSelection: { kind: 'existing', engagementId: 'engagement-1' },
      hasMultipleEligibleCompanies: false,
      clientCompanyName: 'Northwind Industrial',
    });
    expect(screen.queryByText(BILLED_TO_TEXT)).not.toBeInTheDocument();
  });

  it('stays absent when no company name has resolved yet, even for a multi-company client', () => {
    renderStepConfirm({
      caseSelection: { kind: 'existing', engagementId: 'engagement-1' },
      hasMultipleEligibleCompanies: true,
      clientCompanyName: null,
    });
    expect(screen.queryByText(BILLED_TO_TEXT)).not.toBeInTheDocument();
  });

  it('never renders on the NEW-case shape — the note is attach-only by spec', () => {
    renderStepConfirm({
      caseSelection: { kind: 'new' },
      companies: COMPANIES,
      companyId: 'company-1',
      hasMultipleEligibleCompanies: true,
      clientCompanyName: 'Northwind Industrial',
    });
    expect(screen.queryByText(BILLED_TO_TEXT)).not.toBeInTheDocument();
  });
});

const DESCRIPTION_ERROR = "Add a few words about what you'd like to discuss.";

// M2 [CRITICAL] — the ordinary new-case path (title filled, description left blank) used to
// dead-end on the wrapper's generic hard panel because nothing gated it client-side. The
// inline, field-level message is what step-confirm.tsx owns; the wrapper's early-return guard
// is pinned separately in booking-flow-dialog.test.tsx.
describe('StepConfirm — the description real-text gate (M2)', () => {
  it('shows the inline error once validation is triggered on an empty editor', () => {
    renderStepConfirm({
      caseSelection: { kind: 'new' },
      title: 'Migration planning',
      descriptionHtml: '',
      showValidation: true,
    });
    expect(screen.getByText(DESCRIPTION_ERROR)).toBeInTheDocument();
  });

  it('treats markup non-emptiness as empty — a bare <p></p> still errors', () => {
    renderStepConfirm({
      caseSelection: { kind: 'new' },
      title: 'Migration planning',
      descriptionHtml: '<p></p>',
      showValidation: true,
    });
    expect(screen.getByText(DESCRIPTION_ERROR)).toBeInTheDocument();
  });

  it('stays silent before validation has been triggered, even when empty', () => {
    renderStepConfirm({
      caseSelection: { kind: 'new' },
      descriptionHtml: '',
      showValidation: false,
    });
    expect(screen.queryByText(DESCRIPTION_ERROR)).not.toBeInTheDocument();
  });

  it('clears once real text content is present', () => {
    renderStepConfirm({
      caseSelection: { kind: 'new' },
      descriptionHtml: '<p>Migrating a record-triggered flow.</p>',
      showValidation: true,
    });
    expect(screen.queryByText(DESCRIPTION_ERROR)).not.toBeInTheDocument();
  });
});

// UX-3 (BAL-400 round 2) — a company (re)selection's open-cases read used to render NOTHING
// while in flight, so the form visibly lost/regained a chunk of layout with no indication
// anything was happening.
describe('StepConfirm — the case-choice loading skeleton (UX-3)', () => {
  it('renders the 2-row skeleton while a read is in flight and no cases have resolved yet', () => {
    renderStepConfirm({ caseChoiceLoading: true, openCases: null });
    expect(screen.getByTestId('case-choice-skeleton')).toBeInTheDocument();
  });

  it('does not render once the read resolves, even if it later flips back to loading=false', () => {
    renderStepConfirm({ caseChoiceLoading: false, openCases: null });
    expect(screen.queryByTestId('case-choice-skeleton')).not.toBeInTheDocument();
  });

  it('yields to the real section once cases have resolved, even if the flag is stale-true', () => {
    renderStepConfirm({
      caseChoiceLoading: true,
      openCases: [
        {
          engagementId: 'e-1',
          title: 'Flow interview loop',
          createdAt: '2026-05-01T00:00:00.000Z',
          lastActivityAt: '2026-06-01T00:00:00.000Z',
          consultationCount: 2,
        },
      ],
    });
    expect(screen.queryByTestId('case-choice-skeleton')).not.toBeInTheDocument();
    expect(screen.getByText('Which case is this for?')).toBeInTheDocument();
  });
});

describe('StepConfirm — inline funding section, draft notice and stale-slot follow-up (BAL-608)', () => {
  it('shows the normal Back / Confirm row when there is no funding section', () => {
    renderStepConfirm();

    expect(screen.getByRole('button', { name: 'Back' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Confirm & book/ })).toBeInTheDocument();
  });

  it('renders the funding section after the billing line and omits the Back / Confirm row', () => {
    renderStepConfirm({ fundingSection: <div data-testid="funding-section">Top up</div> });

    const section = screen.getByTestId('funding-section');
    const billing = screen.getByText(/Charged only for time used/);
    expect(
      billing.compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Back' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Confirm & book/ })).not.toBeInTheDocument();
  });

  it('keeps the company hint and the cancellation line beside the funding section', () => {
    renderStepConfirm({
      fundingSection: <div>Top up</div>,
      caseSelection: { kind: 'new' },
      companies: COMPANIES,
      companyId: null,
    });

    expect(screen.getByText('Choose which account this is billed to')).toBeInTheDocument();
    expect(screen.getByText(/Free to cancel/i)).toBeInTheDocument();
  });

  it('locks the time and the case dropdown while a funding step is under way', () => {
    renderStepConfirm({
      fundingBusy: true,
      openCases: [
        {
          engagementId: 'engagement-1',
          title: 'Flow interview loop',
          createdAt: '2026-06-12T09:00:00Z',
          lastActivityAt: '2026-06-13T09:00:00Z',
          consultationCount: 2,
        },
      ],
    });

    expect(screen.getByRole('button', { name: 'See other times' })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'Which case is this for?' })).toBeDisabled();
  });

  it('names the selected case in the dropdown alone — no repeated case card', () => {
    renderStepConfirm({
      openCases: [
        {
          engagementId: 'engagement-1',
          title: 'Flow interview loop',
          createdAt: '2026-06-12T09:00:00Z',
          lastActivityAt: '2026-06-13T09:00:00Z',
          consultationCount: 2,
        },
      ],
    });

    expect(screen.getByRole('combobox', { name: 'Which case is this for?' })).toHaveTextContent(
      'Flow interview loop'
    );
    expect(screen.queryByText(/so far · opened/)).not.toBeInTheDocument();
  });

  it('a paused expert: the dropdown lists open cases only, never "Start a new case"', async () => {
    const user = userEvent.setup();
    renderStepConfirm({
      offerNewCase: false,
      openCases: [
        {
          engagementId: 'engagement-1',
          title: 'Flow interview loop',
          createdAt: '2026-06-12T09:00:00Z',
          lastActivityAt: '2026-06-13T09:00:00Z',
          consultationCount: 2,
        },
        {
          engagementId: 'engagement-2',
          title: 'Duplicate cleanup',
          createdAt: '2026-06-10T09:00:00Z',
          lastActivityAt: '2026-06-11T09:00:00Z',
          consultationCount: 1,
        },
      ],
    });
    await user.click(screen.getByRole('combobox', { name: 'Which case is this for?' }));
    const options = await screen.findAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual([
      expect.stringContaining('Flow interview loop'),
      expect.stringContaining('Duplicate cleanup'),
    ]);
  });

  it('a paused expert with only this case: nothing to switch to, so the card, not a dropdown', () => {
    renderStepConfirm({
      offerNewCase: false,
      openCases: [
        {
          engagementId: 'engagement-1',
          title: 'Flow interview loop',
          createdAt: '2026-06-12T09:00:00Z',
          lastActivityAt: '2026-06-13T09:00:00Z',
          consultationCount: 2,
        },
      ],
    });
    expect(screen.queryByRole('combobox', { name: 'Which case is this for?' })).toBeNull();
    expect(screen.getByText(/so far · opened/)).toBeInTheDocument();
  });

  it('shows the read-only case card when there is no dropdown', () => {
    renderStepConfirm();
    expect(screen.queryByRole('combobox', { name: 'Which case is this for?' })).toBeNull();
    expect(screen.getByText(/so far · opened/)).toBeInTheDocument();
  });

  it('locks the company picker while a funding step is under way', () => {
    renderStepConfirm({
      fundingBusy: true,
      caseSelection: { kind: 'new' },
      caseContextSummary: null,
      companies: COMPANIES,
      companyId: COMPANIES[0]?.id ?? null,
    });

    expect(screen.getByRole('combobox')).toBeDisabled();
  });

  it('leaves the time live when nothing is under way', () => {
    renderStepConfirm();

    expect(screen.getByRole('button', { name: 'See other times' })).toBeEnabled();
  });

  it('disables Confirm & book with a busy mark while the pre-flight is answering', () => {
    renderStepConfirm({ preflightPending: true });

    const confirm = screen.getByRole('button', { name: /Confirm & book/ });
    expect(confirm).toBeDisabled();
    expect(confirm).toHaveAttribute('aria-busy', 'true');
  });

  it('shows no draft notice by default', () => {
    renderStepConfirm();

    expect(screen.queryByText('Filled in from your last visit')).not.toBeInTheDocument();
  });

  it('fires onClear from the draft notice', async () => {
    const user = userEvent.setup();
    const onClear = vi.fn();
    renderStepConfirm({ draftNotice: { onClear } });

    expect(screen.getByText('Filled in from your last visit')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Clear' }));

    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it('renders the follow-up under the stale-slot banner', () => {
    renderStepConfirm({
      staleSlot: true,
      staleSlotFollowUp: 'Your top-up went through, so A$300 is in Northwind balance.',
    });

    expect(screen.getByText('This time was just booked by someone else.')).toBeInTheDocument();
    expect(
      screen.getByText('Your top-up went through, so A$300 is in Northwind balance.')
    ).toBeInTheDocument();
  });
});
