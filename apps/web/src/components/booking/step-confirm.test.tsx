import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@/test/utils';
import { EMPTY_TAXONOMY } from '@/lib/search/taxonomy';
import type { EligibleCompany } from '@balo/shared/credit';
import { StepConfirm, type StepConfirmProps } from './step-confirm';
import type { FixedCaseSummary } from './types';

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
    caseChoiceLoading: false,
    caseSelection: { kind: 'existing', engagementId: 'engagement-1' },
    onCaseSelectionChange: vi.fn(),
    caseContextSummary: CASE_CONTEXT,
    showCaseEscapeHatch: true,
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
