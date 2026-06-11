import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { ProposalComposer } from './proposal-composer';
import { emptyDraftState, nextDraftKey, type ProposalDraftState } from './proposal-composer-state';

// The `full` overview editor's bubble menu breaks in JSDOM — replace the
// dynamic RichTextEditor with a plain textarea (the critical test caveat). This
// lets us drive composer LOGIC (readiness gating, method switching, sheet) without
// TipTap internals.
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

// Mock the autosave action — assert it fires; default success.
const saveProposalDraftAction = vi.fn();
vi.mock('@/app/(dashboard)/projects/[requestId]/_actions/save-proposal-draft', () => ({
  saveProposalDraftAction: (...args: unknown[]) => saveProposalDraftAction(...args),
}));

// The submit action + document actions are pulled in by child components; mock to
// no-ops so the composer mounts cleanly.
vi.mock('@/app/(dashboard)/projects/[requestId]/_actions/submit-proposal', () => ({
  submitProposalAction: vi.fn().mockResolvedValue({ success: false, error: 'noop' }),
}));
vi.mock('@/app/(dashboard)/projects/[requestId]/_actions/request-proposal-document-upload', () => ({
  requestProposalDocumentUploadAction: vi.fn(),
}));
vi.mock('@/app/(dashboard)/projects/[requestId]/_actions/confirm-proposal-document-upload', () => ({
  confirmProposalDocumentUploadAction: vi.fn(),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

// Replace the uploader with a probe that calls `ensureProposalId` on click — this
// exercises the composer's draft-create-before-upload path (edge-case 5) without
// presign/XHR internals. The probe surfaces the resolved id for assertion.
const ensureResults: Array<string | null> = [];
vi.mock('./proposal-document-uploader', () => ({
  ProposalDocumentUploader: (props: {
    kind: string;
    ensureProposalId: () => Promise<string | null>;
  }) => (
    <button
      type="button"
      data-testid={`uploader-${props.kind}`}
      onClick={() => {
        void props.ensureProposalId().then((id) => ensureResults.push(id));
      }}
    >
      ensure {props.kind}
    </button>
  ),
}));

const REQUEST_ID = '11111111-1111-1111-1111-111111111111';
const RELATIONSHIP_ID = '22222222-2222-2222-2222-222222222222';

function renderComposer(initial: ProposalDraftState): void {
  render(
    <ProposalComposer
      requestId={REQUEST_ID}
      relationshipId={RELATIONSHIP_ID}
      clientFirstName="Priya"
      initialState={initial}
    />
  );
}

/** A ready Fixed draft. */
function readyDraft(): ProposalDraftState {
  return {
    proposalId: 'p1',
    overview: '<p>A clear overview of the engagement.</p>',
    pricingMethod: 'fixed',
    currency: 'aud',
    timeframeWeeks: 6,
    exclusions: '',
    depositCents: null,
    rateCents: null,
    cadence: 'monthly',
    milestones: [
      {
        key: nextDraftKey(),
        title: 'Discovery',
        descriptionHtml: '',
        acceptanceCriteria: '',
        valueCents: 500_000,
      },
    ],
    installments: [{ key: nextDraftKey(), label: 'Full', pct: 100 }],
    documents: [],
  };
}

describe('ProposalComposer', () => {
  beforeEach(() => {
    saveProposalDraftAction.mockReset();
    saveProposalDraftAction.mockResolvedValue({ success: true, proposalId: 'p1' });
  });

  it('disables Submit until the draft is ready (readiness gating)', () => {
    renderComposer(emptyDraftState());
    const submitButtons = screen.getAllByRole('button', { name: /submit to priya/i });
    expect(submitButtons.length).toBeGreaterThan(0);
    submitButtons.forEach((button) => expect(button).toBeDisabled());
  });

  it('enables Submit and shows "Ready to submit" for a complete draft', () => {
    renderComposer(readyDraft());
    // The summary card renders twice (desktop sticky + the sheet copy).
    expect(screen.getAllByText(/ready to submit/i).length).toBeGreaterThan(0);
    const submitButtons = screen.getAllByRole('button', { name: /submit to priya/i });
    expect(submitButtons.length).toBeGreaterThan(0);
    submitButtons.forEach((button) => expect(button).not.toBeDisabled());
  });

  it('lists readiness issues for an empty draft', () => {
    renderComposer(emptyDraftState());
    expect(screen.getAllByText(/before you can submit/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/add an overview/i).length).toBeGreaterThan(0);
  });

  it('switches the Payment tab shape when the pricing method changes to T&M', async () => {
    const user = userEvent.setup();
    renderComposer(readyDraft());

    // Overview tab: switch method to Time & materials.
    await user.click(screen.getByRole('radio', { name: /time & materials/i }));

    // Payment tab now shows deposit/rate (T&M), not installments.
    await user.click(screen.getByRole('tab', { name: /payment & terms/i }));
    expect(screen.getByLabelText(/deposit/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/hourly rate/i)).toBeInTheDocument();
    expect(screen.queryByText(/payment installments/i)).not.toBeInTheDocument();
  });

  it('shows installments on the Payment tab for Fixed pricing', async () => {
    const user = userEvent.setup();
    renderComposer(readyDraft());
    await user.click(screen.getByRole('tab', { name: /payment & terms/i }));
    expect(screen.getByText(/payment installments/i)).toBeInTheDocument();
    expect(screen.getByText(/total from milestones/i)).toBeInTheDocument();
  });

  it('shows grouped whole-dollar total + timeframe in the mobile summary bar', () => {
    renderComposer(readyDraft());
    // A$5,000 from the single 500_000-cent milestone, then "1 milestone · ~6 wks".
    const bar = screen.getByRole('button', { name: /ready to submit/i });
    expect(bar).toHaveTextContent('A$5,000');
    expect(bar).toHaveTextContent('1 milestone');
    expect(bar).toHaveTextContent('~6 wks');
  });

  it('renders the Submit CTA with the shared blue→violet gradient', () => {
    renderComposer(readyDraft());
    const [submit] = screen.getAllByRole('button', { name: /submit to priya/i });
    expect(submit?.className).toContain('bg-gradient-to-r');
    expect(submit?.className).toContain('to-violet-600');
  });

  it('opens the mobile summary sheet from the collapsed bar', async () => {
    const user = userEvent.setup();
    renderComposer(readyDraft());
    // The mobile summary bar reports readiness.
    const bar = screen.getByRole('button', { name: /ready to submit/i });
    await user.click(bar);
    // Sheet content mounts a dialog with the summary heading (now 2 instances:
    // sticky desktop + sheet) — assert at least the sheet title is reachable.
    expect(screen.getByText('Proposal summary')).toBeInTheDocument();
  });

  it('fires an autosave after an edit (debounced)', async () => {
    const user = userEvent.setup();
    renderComposer(readyDraft());

    const overview = screen.getByLabelText('Proposal overview');
    await user.type(overview, ' more');

    await waitFor(
      () => {
        expect(saveProposalDraftAction).toHaveBeenCalled();
      },
      { timeout: 2000 }
    );
    const call = saveProposalDraftAction.mock.calls[0]?.[0];
    expect(call).toMatchObject({ requestId: REQUEST_ID, relationshipId: RELATIONSHIP_ID });
  });

  it('autosave failure is quiet (shows "Couldn\'t save draft", typing not blocked)', async () => {
    const user = userEvent.setup();
    saveProposalDraftAction.mockResolvedValue({ success: false, error: 'nope' });
    renderComposer(readyDraft());

    const overview = screen.getByLabelText('Proposal overview');
    await user.type(overview, ' x');

    // The summary card surfaces the error label — no toast, no thrown error.
    await waitFor(
      () => expect(screen.getAllByText(/couldn't save draft/i).length).toBeGreaterThan(0),
      {
        timeout: 2000,
      }
    );
    // Typing continues to update the field (input is never disabled on failure).
    await user.type(overview, ' y');
    expect((overview as HTMLTextAreaElement).value).toContain(' x y');
  });

  it('forces a draft-create (autosave) when an upload needs an id and none exists yet', async () => {
    const user = userEvent.setup();
    ensureResults.length = 0;
    saveProposalDraftAction.mockResolvedValue({ success: true, proposalId: 'created-1' });
    // Empty draft → proposalId is null; ensureProposalId must flush a save first.
    renderComposer(emptyDraftState());

    // Go to Attachments and trigger the uploader probe → ensureProposalId().
    await user.click(screen.getByRole('tab', { name: /attachments/i }));
    await user.click(screen.getByTestId('uploader-ref'));

    await waitFor(() => expect(saveProposalDraftAction).toHaveBeenCalled());
    await waitFor(() => expect(ensureResults).toContain('created-1'));
  });

  it('returns the existing id without a redundant save when the draft already exists', async () => {
    const user = userEvent.setup();
    ensureResults.length = 0;
    saveProposalDraftAction.mockResolvedValue({ success: true, proposalId: 'p1' });
    renderComposer(readyDraft()); // proposalId 'p1' already set

    await user.click(screen.getByRole('tab', { name: /attachments/i }));
    await user.click(screen.getByTestId('uploader-ref'));

    await waitFor(() => expect(ensureResults).toContain('p1'));
    // ensureProposalId short-circuits — no save fired purely to mint an id.
    expect(saveProposalDraftAction).not.toHaveBeenCalled();
  });

  it('autosave thrown rejection sets the error status (catch path)', async () => {
    const user = userEvent.setup();
    saveProposalDraftAction.mockRejectedValue(new Error('network'));
    renderComposer(readyDraft());

    await user.type(screen.getByLabelText('Proposal overview'), ' z');

    await waitFor(
      () => expect(screen.getAllByText(/couldn't save draft/i).length).toBeGreaterThan(0),
      { timeout: 2000 }
    );
  });

  it('edits the Overview-tab timeframe + exclusions (slice setters) and autosaves the new values', async () => {
    const user = userEvent.setup();
    renderComposer(readyDraft());

    await user.clear(screen.getByLabelText(/estimated timeframe/i));
    await user.type(screen.getByLabelText(/estimated timeframe/i), '9');
    await user.type(screen.getByLabelText(/what's not included/i), 'No data migration');

    await waitFor(() => expect(saveProposalDraftAction).toHaveBeenCalled(), { timeout: 2000 });
    const lastPayload = saveProposalDraftAction.mock.calls.at(-1)?.[0] as {
      timeframeWeeks?: number;
      exclusions?: string;
    };
    expect(lastPayload.timeframeWeeks).toBe(9);
    expect(lastPayload.exclusions).toContain('No data migration');
  });

  it('adds a milestone from the Milestones tab (addMilestone slice setter)', async () => {
    const user = userEvent.setup();
    renderComposer(readyDraft());

    await user.click(screen.getByRole('tab', { name: /milestones/i }));
    const addButtons = screen.getAllByRole('button', { name: /add milestone/i });
    const [addMilestone] = addButtons;
    if (addMilestone === undefined) throw new Error('expected an add-milestone button');
    await user.click(addMilestone);

    await waitFor(
      () => {
        const last = saveProposalDraftAction.mock.calls.at(-1)?.[0] as {
          milestones?: unknown[];
        };
        expect(last?.milestones?.length).toBe(2);
      },
      { timeout: 2000 }
    );
  });

  it('drives the T&M deposit / rate / cadence setters from the Payment tab', async () => {
    const user = userEvent.setup();
    const tmDraft: ProposalDraftState = {
      ...readyDraft(),
      pricingMethod: 'tm',
      depositCents: 100_000,
      rateCents: 20_000,
    };
    renderComposer(tmDraft);

    await user.click(screen.getByRole('tab', { name: /payment & terms/i }));
    await user.type(screen.getByLabelText(/deposit/i), '5');
    await user.type(screen.getByLabelText(/hourly rate/i), '0');

    await waitFor(() => expect(saveProposalDraftAction).toHaveBeenCalled(), { timeout: 2000 });
    const last = saveProposalDraftAction.mock.calls.at(-1)?.[0] as {
      pricingMethod?: string;
      depositCents?: number;
      rateCents?: number;
    };
    expect(last.pricingMethod).toBe('tm');
    expect(typeof last.depositCents).toBe('number');
    expect(typeof last.rateCents).toBe('number');
  });

  it('flushes a final save before submit (onBeforeSubmit) when confirming', async () => {
    const user = userEvent.setup();
    renderComposer(readyDraft());

    // Open submit dialog (desktop card CTA), confirm → onBeforeSubmit flushes a save.
    const [submit] = screen.getAllByRole('button', { name: /submit to priya/i });
    if (submit === undefined) throw new Error('expected a submit button');
    await user.click(submit);
    await user.click(await screen.findByRole('button', { name: 'Submit proposal' }));

    // The flush triggers a save before the (mocked, failing) submit action runs.
    await waitFor(() => expect(saveProposalDraftAction).toHaveBeenCalled());
  });

  it('opens the submit dialog from the mobile summary sheet', async () => {
    const user = userEvent.setup();
    renderComposer(readyDraft());

    // Open the bottom sheet, then click its Submit CTA.
    await user.click(screen.getByRole('button', { name: /ready to submit/i }));
    expect(screen.getByText('Proposal summary')).toBeInTheDocument();

    const submitButtons = screen.getAllByRole('button', { name: /submit to priya/i });
    const [firstSubmit] = submitButtons;
    if (firstSubmit === undefined) throw new Error('expected a submit button');
    await user.click(firstSubmit);

    // The confirm dialog mounts (its own copy "Submit your proposal to Priya?").
    expect(await screen.findByText(/submit your proposal to priya/i)).toBeInTheDocument();
  });
});
