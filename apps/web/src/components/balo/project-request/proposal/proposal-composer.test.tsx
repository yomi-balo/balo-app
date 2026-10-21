import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { track, PROJECT_EVENTS } from '@/lib/analytics';
import { ProposalComposer, type ProposalComposerProps } from './proposal-composer';
import {
  emptyDraftState,
  nextDraftKey,
  type ProposalDraftState,
  type ProposalMilestoneDraft,
} from './proposal-composer-state';
import type { ProposalExpertIdentity } from './proposal-review-types';

// The `full` overview editor's bubble menu breaks in JSDOM — replace the
// dynamic RichTextEditor with a plain textarea (the critical test caveat). This
// lets us drive composer LOGIC (readiness, method switching, preview) without
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
  RichTextViewer: (props: { value: string }) => <div>{props.value}</div>,
}));

// Mock the autosave action — assert it fires; default success.
const saveProposalDraftAction = vi.fn();
vi.mock('@/app/(dashboard)/projects/[requestId]/_actions/save-proposal-draft', () => ({
  saveProposalDraftAction: (...args: unknown[]) => saveProposalDraftAction(...args),
}));

// The real `useSendProposal` runs against these action mocks.
const submitProposalAction = vi.fn();
vi.mock('@/app/(dashboard)/projects/[requestId]/_actions/submit-proposal', () => ({
  submitProposalAction: (...args: unknown[]) => submitProposalAction(...args),
}));
const resubmitProposalAction = vi.fn();
vi.mock('@/app/(dashboard)/projects/[requestId]/_actions/resubmit-proposal', () => ({
  resubmitProposalAction: (...args: unknown[]) => resubmitProposalAction(...args),
}));
vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    dismiss: vi.fn(),
  }),
}));
vi.mock('@/app/(dashboard)/projects/[requestId]/_actions/request-proposal-document-upload', () => ({
  requestProposalDocumentUploadAction: vi.fn(),
}));
vi.mock('@/app/(dashboard)/projects/[requestId]/_actions/confirm-proposal-document-upload', () => ({
  confirmProposalDocumentUploadAction: vi.fn(),
}));

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => router,
  usePathname: () => '/projects/r1/proposal/rel1',
}));

// Replace the upload pipeline with a recording stub: the composer's two controllers
// (`ref`, `terms`) are captured so tests can call `ensureProposalId` and assert that
// the page-wide drop reaches the `ref` controller's `uploadFiles`.
type UploadKind = 'ref' | 'terms';
interface UploadArgs {
  ensureProposalId: () => Promise<string | null>;
  single?: boolean;
}
const uploads = vi.hoisted(() => ({
  uploadFiles: { ref: vi.fn(), terms: vi.fn() },
  args: {} as Partial<Record<'ref' | 'terms', UploadArgs>>,
}));
vi.mock('./proposal-document-uploader', () => ({
  useProposalDocumentUpload: (args: UploadArgs & { kind: UploadKind }) => {
    uploads.args[args.kind] = args;
    return {
      progress: null,
      removingId: null,
      uploadFiles: uploads.uploadFiles[args.kind],
      remove: vi.fn(),
    };
  },
  ProposalDocumentUploaderView: () => <div data-testid="uploader-view" />,
}));

const REQUEST_ID = '11111111-1111-1111-1111-111111111111';
const RELATIONSHIP_ID = '22222222-2222-2222-2222-222222222222';
const FROM_PROPOSAL_ID = '33333333-3333-3333-3333-333333333333';

const EXPERT: ProposalExpertIdentity = {
  name: 'Sam Expert',
  initials: 'SE',
  company: null,
  headline: 'CPQ Specialist',
  rating: 4.8,
  ratingCount: 12,
};

function renderComposer(
  initial: ProposalDraftState,
  overrides: Partial<ProposalComposerProps> = {}
): void {
  render(
    <ProposalComposer
      requestId={REQUEST_ID}
      relationshipId={RELATIONSHIP_ID}
      clientFirstName="Priya"
      clientName="Priya Shah"
      companyName="Northwind"
      clientCompanyName="Northwind"
      requestTitle="Quote-to-cash rebuild"
      requestSummary="Rebuild our quoting flow."
      requestDescription={<p>The full brief body</p>}
      header={<h1>Quote-to-cash rebuild header</h1>}
      expert={EXPERT}
      initialState={initial}
      {...overrides}
    />
  );
}

/** Render the composer in REVISE mode (A6.4) — a change request is present. */
function renderReviseComposer(
  initial: ProposalDraftState,
  overrides: { section?: string; note?: string; currentVersion?: number } = {}
): void {
  renderComposer(initial, {
    changeRequest: {
      section: overrides.section ?? 'pricing',
      note: overrides.note ?? 'The price is a little high — can you trim scope?',
    },
    fromProposalId: FROM_PROPOSAL_ID,
    currentVersion: overrides.currentVersion ?? 1,
  });
}

/** A ready Fixed draft (typed total A$5,000 = 500,000 cents, one priced milestone). */
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
    fixedPriceCents: 500_000,
    cadence: 'monthly',
    milestones: [
      {
        key: nextDraftKey(),
        title: 'Discovery',
        descriptionHtml: '',
        acceptanceCriteria: '',
        valueCents: 500_000,
        estimatedMinutes: null,
      },
    ],
    installments: [{ key: nextDraftKey(), label: 'Full', pct: 100 }],
    milestonePricingEnabled: true,
    documents: [],
  };
}

/** A ready T&M draft: 120 min (2h) × A$200/hr (20_000 cents) = A$400. */
function readyTmDraft(): ProposalDraftState {
  return {
    ...readyDraft(),
    pricingMethod: 'tm',
    depositCents: 100_000,
    rateCents: 20_000,
    fixedPriceCents: null,
    milestones: [
      {
        key: nextDraftKey(),
        title: 'Discovery',
        descriptionHtml: '',
        acceptanceCriteria: '',
        valueCents: null,
        estimatedMinutes: 120,
      },
    ],
    installments: [],
    milestonePricingEnabled: false,
  };
}

function rail(): HTMLElement {
  return screen.getByRole('complementary', { name: 'Proposal summary' });
}

/** The Undo handler of the most recent `toast(message, { action })` call. */
function lastToastUndo(): () => void {
  const options = vi.mocked(toast).mock.calls.at(-1)?.[1] as
    | { action?: { onClick?: () => void } }
    | undefined;
  const onClick = options?.action?.onClick;
  if (onClick === undefined) throw new Error('expected a toast with an Undo action');
  return onClick;
}

function dropFiles(files: File[]): void {
  const event = new Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: { types: ['Files'], files } });
  act(() => {
    globalThis.dispatchEvent(event);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  saveProposalDraftAction.mockReset();
  saveProposalDraftAction.mockResolvedValue({ success: true, proposalId: 'p1' });
  submitProposalAction.mockReset();
  submitProposalAction.mockResolvedValue({
    success: true,
    transitioned: true,
    analytics: { milestoneCount: 1, totalEstimatedMinutes: 0, pricingMethod: 'fixed' },
  });
  resubmitProposalAction.mockReset();
  uploads.args = {};
  vi.spyOn(globalThis, 'scrollTo').mockImplementation(() => {});
});

describe('ProposalComposer — one page', () => {
  it('lays the sections out in a fixed order with no tabs', () => {
    renderComposer(readyDraft());
    const sectionTitles = [
      'Overview',
      'Milestones',
      'Price and payments',
      'Not included',
      'Attachments',
    ];
    const titles = screen
      .getAllByRole('heading', { level: 2 })
      .map((h) => sectionTitles.find((title) => h.textContent?.startsWith(title)))
      .filter((title) => title !== undefined);
    expect(titles).toEqual(sectionTitles);
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    expect(screen.queryByRole('tabpanel')).not.toBeInTheDocument();
  });

  it('swaps the pricing section for Rates and billing under T&M', () => {
    renderComposer(readyTmDraft());
    expect(screen.getByRole('heading', { name: 'Rates and billing' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Price and payments' })).not.toBeInTheDocument();
  });

  it('lists the readiness issues for an empty draft and never disables the CTA', () => {
    renderComposer(emptyDraftState());
    expect(within(rail()).getByText(/things left before you can send/i)).toBeInTheDocument();
    expect(within(rail()).getByRole('button', { name: /add an overview/i })).toBeInTheDocument();
    expect(within(rail()).getByRole('button', { name: 'Preview and send' })).toBeEnabled();
  });

  it('shows "Ready to send" for a complete draft', () => {
    renderComposer(readyDraft());
    expect(within(rail()).getByText('Ready to send')).toBeInTheDocument();
  });

  it('has no bottom sheet or confirm dialog', () => {
    renderComposer(readyDraft());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('shows the brief summary and reveals the body on "Show brief"', async () => {
    const user = userEvent.setup();
    renderComposer(readyDraft());
    expect(screen.getByText('Rebuild our quoting flow.')).toBeVisible();
    expect(screen.getByText('The full brief body')).not.toBeVisible();

    const toggle = screen.getByRole('button', { name: 'Show brief' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await user.click(toggle);

    expect(screen.getByText('The full brief body')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Hide brief' })).toHaveAttribute(
      'aria-expanded',
      'true'
    );
  });

  it('shows the draft save status in the property bar row', async () => {
    const user = userEvent.setup();
    renderComposer(readyDraft());
    await user.type(screen.getByLabelText('Proposal overview'), ' more');
    expect(await screen.findByText('Saved as draft', {}, { timeout: 2000 })).toBeInTheDocument();
  });
});

describe('ProposalComposer — autosave and slice setters', () => {
  it('fires an autosave after an edit (debounced)', async () => {
    const user = userEvent.setup();
    renderComposer(readyDraft());

    await user.type(screen.getByLabelText('Proposal overview'), ' more');

    await waitFor(() => expect(saveProposalDraftAction).toHaveBeenCalled(), { timeout: 2000 });
    expect(saveProposalDraftAction.mock.calls[0]?.[0]).toMatchObject({
      requestId: REQUEST_ID,
      relationshipId: RELATIONSHIP_ID,
    });
  });

  it('autosave failure is quiet (shows "Couldn\'t save draft", typing not blocked)', async () => {
    const user = userEvent.setup();
    saveProposalDraftAction.mockResolvedValue({ success: false, error: 'nope' });
    renderComposer(readyDraft());

    const overview = screen.getByLabelText('Proposal overview');
    await user.type(overview, ' x');

    expect(await screen.findByText(/couldn't save draft/i, {}, { timeout: 2000 })).toBeVisible();
    await user.type(overview, ' y');
    expect((overview as HTMLTextAreaElement).value).toContain(' x y');
  });

  it('autosave thrown rejection sets the error status (catch path)', async () => {
    const user = userEvent.setup();
    saveProposalDraftAction.mockRejectedValue(new Error('network'));
    renderComposer(readyDraft());

    await user.type(screen.getByLabelText('Proposal overview'), ' z');

    expect(await screen.findByText(/couldn't save draft/i, {}, { timeout: 2000 })).toBeVisible();
  });

  it('forces a draft-create (autosave) when an upload needs an id and none exists yet', async () => {
    saveProposalDraftAction.mockResolvedValue({ success: true, proposalId: 'created-1' });
    renderComposer(emptyDraftState());

    let id: string | null | undefined;
    await act(async () => {
      id = await uploads.args.ref?.ensureProposalId();
    });

    expect(saveProposalDraftAction).toHaveBeenCalled();
    expect(id).toBe('created-1');
  });

  it('returns the existing id without a redundant save when the draft already exists', async () => {
    renderComposer(readyDraft());

    let id: string | null | undefined;
    await act(async () => {
      id = await uploads.args.terms?.ensureProposalId();
    });

    expect(id).toBe('p1');
    expect(saveProposalDraftAction).not.toHaveBeenCalled();
  });

  it('wires the terms controller as single-document and the ref controller as multi', () => {
    renderComposer(readyDraft());
    expect(uploads.args.terms?.single).toBe(true);
    expect(uploads.args.ref?.single).toBeUndefined();
  });

  it('edits the timeframe and exclusions and autosaves the new values', async () => {
    const user = userEvent.setup();
    renderComposer(readyDraft());

    await user.click(screen.getByRole('button', { name: 'About 6 weeks' }));
    const weeks = screen.getByRole('textbox', { name: 'Weeks' });
    await user.clear(weeks);
    await user.type(weeks, '9');
    await user.keyboard('{Escape}');
    await user.type(screen.getByLabelText(/what's not included/i), 'No data migration');

    await waitFor(
      () => {
        const last = saveProposalDraftAction.mock.calls.at(-1)?.[0] as {
          timeframeWeeks?: number;
          exclusions?: string;
        };
        expect(last.timeframeWeeks).toBe(9);
        expect(last.exclusions).toContain('No data migration');
      },
      { timeout: 3000 }
    );
  });

  it('adds a milestone from the Milestones section', async () => {
    const user = userEvent.setup();
    renderComposer(readyDraft());

    await user.click(screen.getByRole('button', { name: /add milestone/i }));

    await waitFor(
      () => {
        const last = saveProposalDraftAction.mock.calls.at(-1)?.[0] as { milestones?: unknown[] };
        expect(last?.milestones?.length).toBe(2);
      },
      { timeout: 2000 }
    );
  });

  it('drives the T&M deposit and rate setters from the Rates and billing section', async () => {
    const user = userEvent.setup();
    renderComposer(readyTmDraft());

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

  it('drives the project price, payment schedule and cadence setters', async () => {
    const user = userEvent.setup();
    renderComposer(readyDraft());

    const price = screen.getByLabelText('Project price');
    await user.clear(price);
    await user.type(price, '7500');
    await user.click(screen.getByRole('button', { name: '50 / 50' }));

    await waitFor(
      () => {
        const last = saveProposalDraftAction.mock.calls.at(-1)?.[0] as {
          priceCents?: number;
          installments?: { pct: number }[];
        };
        expect(last.priceCents).toBe(750_000);
        expect(last.installments?.map((i) => i.pct)).toEqual([50, 50]);
      },
      { timeout: 3000 }
    );
  });
});

describe('ProposalComposer — One per milestone stays in step with the milestones', () => {
  function threeMilestoneDraft(): ProposalDraftState {
    const base = readyDraft();
    const titles = ['Discovery', 'Build', 'Launch'];
    return {
      ...base,
      fixedPriceCents: 0,
      milestonePricingEnabled: false,
      milestones: titles.map((title) => ({
        key: nextDraftKey(),
        title,
        descriptionHtml: '',
        acceptanceCriteria: '',
        valueCents: null,
        estimatedMinutes: null,
      })),
    };
  }

  it('regenerates the payments when a milestone is added, keeping the preset highlighted', async () => {
    const user = userEvent.setup();
    renderComposer(threeMilestoneDraft());

    const preset = screen.getByRole('button', { name: 'One per milestone' });
    await user.click(preset);
    expect(screen.getAllByLabelText(/^Payment \d+ name$/i)).toHaveLength(3);

    await user.click(screen.getByRole('button', { name: /add milestone/i }));

    expect(screen.getAllByLabelText(/^Payment \d+ name$/i)).toHaveLength(4);
    expect(screen.getByRole('button', { name: 'One per milestone' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
  });

  it('stops following once a payment is edited by hand', async () => {
    const user = userEvent.setup();
    renderComposer(threeMilestoneDraft());

    await user.click(screen.getByRole('button', { name: 'One per milestone' }));
    const [firstName] = screen.getAllByLabelText(/^Payment \d+ name$/i);
    if (firstName === undefined) throw new Error('expected payment rows');
    await user.type(firstName, 'x');
    await user.click(screen.getByRole('button', { name: /add milestone/i }));

    expect(screen.getAllByLabelText(/^Payment \d+ name$/i)).toHaveLength(3);
    expect(screen.getByRole('button', { name: 'One per milestone' })).toHaveAttribute(
      'aria-pressed',
      'false'
    );
  });
});

describe('ProposalComposer — pricing-method switch (BAL-294 → BAL-610)', () => {
  const mockTrack = vi.mocked(track);
  const mockToast = vi.mocked(toast);

  it('Fixed→T&M with a typed price switches immediately: no dialog, an event and an Undo toast', async () => {
    const user = userEvent.setup();
    renderComposer(readyDraft()); // fixedPriceCents = 500_000

    await user.click(screen.getByRole('button', { name: /fixed price/i }));
    await user.click(screen.getByRole('radio', { name: /time & materials/i }));

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /time & materials/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Rates and billing' })).toBeInTheDocument();
    expect(mockTrack).toHaveBeenCalledWith(PROJECT_EVENTS.PROPOSAL_PRICING_METHOD_SWITCHED, {
      proposal_id: 'p1',
      from_method: 'fixed',
      to_method: 'tm',
      had_typed_price: true,
    });
    expect(mockToast).toHaveBeenCalledWith(
      'Switched to time and materials. Your fixed amounts come back if you switch again.',
      { id: expect.any(String), action: { label: 'Undo', onClick: expect.any(Function) } }
    );
  });

  it('Undo restores Fixed with the typed price and fires the reversed event', async () => {
    const user = userEvent.setup();
    renderComposer(readyDraft());

    await user.click(screen.getByRole('button', { name: /fixed price/i }));
    await user.click(screen.getByRole('radio', { name: /time & materials/i }));
    const undo = lastToastUndo();
    act(() => undo());

    expect(screen.getByRole('heading', { name: 'Price and payments' })).toBeInTheDocument();
    expect(screen.getByLabelText('Project price')).toHaveValue(5000);
    expect(mockTrack).toHaveBeenLastCalledWith(PROJECT_EVENTS.PROPOSAL_PRICING_METHOD_SWITCHED, {
      proposal_id: 'p1',
      from_method: 'tm',
      to_method: 'fixed',
      had_typed_price: true,
    });
  });

  it('T&M→Fixed pre-fills the price with the last derived total and seeds the payment schedule', async () => {
    const user = userEvent.setup();
    renderComposer(readyTmDraft()); // 120 min × A$200/hr = A$400 derived total

    await user.click(screen.getByRole('button', { name: /time & materials/i }));
    await user.click(screen.getByRole('radio', { name: /fixed price/i }));

    expect(screen.getByLabelText('Project price')).toHaveValue(400);
    expect(screen.getByLabelText('Payment 1 name')).toBeInTheDocument();
    expect(mockTrack).toHaveBeenCalledWith(PROJECT_EVENTS.PROPOSAL_PRICING_METHOD_SWITCHED, {
      proposal_id: 'p1',
      from_method: 'tm',
      to_method: 'fixed',
      had_typed_price: false,
    });
    expect(mockToast).toHaveBeenCalledWith(
      'Switched to fixed price. Your hour estimates come back if you switch again.',
      expect.anything()
    );
  });

  it('T&M→Fixed leaves the price blank when there is nothing to pre-fill', async () => {
    const user = userEvent.setup();
    const draft = { ...readyTmDraft(), rateCents: null };
    renderComposer(draft);

    await user.click(screen.getByRole('button', { name: /time & materials/i }));
    await user.click(screen.getByRole('radio', { name: /fixed price/i }));

    expect(screen.getByLabelText('Project price')).toHaveValue(null);
  });

  it('Fixed→T&M with no typed price reports had_typed_price:false', async () => {
    const user = userEvent.setup();
    renderComposer({ ...readyDraft(), fixedPriceCents: null });

    await user.click(screen.getByRole('button', { name: /fixed price/i }));
    await user.click(screen.getByRole('radio', { name: /time & materials/i }));

    expect(mockTrack).toHaveBeenCalledWith(PROJECT_EVENTS.PROPOSAL_PRICING_METHOD_SWITCHED, {
      proposal_id: 'p1',
      from_method: 'fixed',
      to_method: 'tm',
      had_typed_price: false,
    });
  });

  it('choosing the current method does nothing', async () => {
    const user = userEvent.setup();
    renderComposer(readyDraft());

    await user.click(screen.getByRole('button', { name: /fixed price/i }));
    await user.click(screen.getByRole('radio', { name: /fixed price/i }));

    expect(mockTrack).not.toHaveBeenCalledWith(
      PROJECT_EVENTS.PROPOSAL_PRICING_METHOD_SWITCHED,
      expect.anything()
    );
    expect(mockToast).not.toHaveBeenCalled();
  });
});

describe('ProposalComposer — "Price each milestone" switch', () => {
  const mockTrack = vi.mocked(track);
  const mockToast = vi.mocked(toast);

  it('switching it off clears the amounts, keeps the price, tracks it and offers Undo', async () => {
    const user = userEvent.setup();
    renderComposer(readyDraft());

    await user.click(screen.getByRole('switch', { name: /price each milestone/i }));

    expect(screen.queryByLabelText('Milestone 1 amount')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Project price')).toHaveValue(5000);
    expect(mockTrack).toHaveBeenCalledWith(PROJECT_EVENTS.PROPOSAL_MILESTONE_PRICING_TOGGLED, {
      proposal_id: 'p1',
      enabled: false,
      milestone_count: 1,
    });
    expect(mockToast).toHaveBeenCalledWith(
      'Milestone amounts removed. Your project price stays the same.',
      { id: expect.any(String), action: { label: 'Undo', onClick: expect.any(Function) } }
    );

    await waitFor(
      () => {
        const last = saveProposalDraftAction.mock.calls.at(-1)?.[0] as {
          milestones?: { valueCents: number | null }[];
        };
        expect(last.milestones?.map((m) => m.valueCents)).toEqual([null]);
      },
      { timeout: 2000 }
    );
  });

  it('Undo restores the amounts and the switch and tracks enabled:true', async () => {
    const user = userEvent.setup();
    renderComposer(readyDraft());

    await user.click(screen.getByRole('switch', { name: /price each milestone/i }));
    const undo = lastToastUndo();
    act(() => undo());

    expect(screen.getByLabelText('Milestone 1 amount')).toHaveValue(5000);
    expect(screen.getByRole('switch', { name: /price each milestone/i })).toBeChecked();
    expect(mockTrack).toHaveBeenLastCalledWith(PROJECT_EVENTS.PROPOSAL_MILESTONE_PRICING_TOGGLED, {
      proposal_id: 'p1',
      enabled: true,
      milestone_count: 1,
    });
  });

  it('switching it off with no amounts set tracks but shows no toast', async () => {
    const user = userEvent.setup();
    const draft = readyDraft();
    renderComposer({
      ...draft,
      milestones: draft.milestones.map((m) => ({ ...m, valueCents: null })),
    });

    await user.click(screen.getByRole('switch', { name: /price each milestone/i }));

    expect(mockTrack).toHaveBeenCalledWith(PROJECT_EVENTS.PROPOSAL_MILESTONE_PRICING_TOGGLED, {
      proposal_id: 'p1',
      enabled: false,
      milestone_count: 1,
    });
    expect(mockToast).not.toHaveBeenCalled();
  });

  it('switching it on tracks enabled:true and shows the amount fields', async () => {
    const user = userEvent.setup();
    renderComposer({ ...readyDraft(), milestonePricingEnabled: false });

    await user.click(screen.getByRole('switch', { name: /price each milestone/i }));

    expect(screen.getByLabelText('Milestone 1 amount')).toBeInTheDocument();
    expect(mockTrack).toHaveBeenCalledWith(PROJECT_EVENTS.PROPOSAL_MILESTONE_PRICING_TOGGLED, {
      proposal_id: 'p1',
      enabled: true,
      milestone_count: 1,
    });
  });
});

describe('ProposalComposer — jump, preview and send', () => {
  const mockTrack = vi.mocked(track);

  it('the rail CTA with issues left jumps to the first one (source cta) and stays in edit', async () => {
    const user = userEvent.setup();
    renderComposer(emptyDraftState());
    const scroll = vi.spyOn(Element.prototype, 'scrollIntoView');

    await user.click(within(rail()).getByRole('button', { name: 'Preview and send' }));

    expect(scroll).toHaveBeenCalled();
    expect(mockTrack).toHaveBeenCalledWith(PROJECT_EVENTS.PROPOSAL_CHECKLIST_JUMPED, {
      proposal_id: '',
      issue_id: 'overview',
      source: 'cta',
    });
    expect(screen.queryByText(/previewing as/i)).not.toBeInTheDocument();
  });

  it('a rail checklist item jumps with source rail', async () => {
    const user = userEvent.setup();
    renderComposer(emptyDraftState());

    await user.click(within(rail()).getByRole('button', { name: /add an overview/i }));

    expect(mockTrack).toHaveBeenCalledWith(PROJECT_EVENTS.PROPOSAL_CHECKLIST_JUMPED, {
      proposal_id: '',
      issue_id: 'overview',
      source: 'rail',
    });
  });

  it('the mobile bar jumps to the first issue with source mobile_bar', async () => {
    const user = userEvent.setup();
    renderComposer(emptyDraftState());

    await user.click(screen.getByRole('button', { name: /things? left$/ }));

    expect(mockTrack).toHaveBeenCalledWith(PROJECT_EVENTS.PROPOSAL_CHECKLIST_JUMPED, {
      proposal_id: '',
      issue_id: 'overview',
      source: 'mobile_bar',
    });
  });

  it('the mobile bar CTA also jumps with source mobile_bar', async () => {
    const user = userEvent.setup();
    renderComposer(emptyDraftState());

    const ctas = screen.getAllByRole('button', { name: 'Preview and send' });
    const mobileCta = ctas.at(-1);
    if (mobileCta === undefined) throw new Error('expected the mobile bar CTA');
    await user.click(mobileCta);

    expect(mockTrack).toHaveBeenCalledWith(
      PROJECT_EVENTS.PROPOSAL_CHECKLIST_JUMPED,
      expect.objectContaining({ source: 'mobile_bar' })
    );
  });

  it('Ctrl+Enter with issues left jumps with source shortcut', async () => {
    const user = userEvent.setup();
    renderComposer(emptyDraftState());

    await user.keyboard('{Control>}{Enter}{/Control}');

    expect(mockTrack).toHaveBeenCalledWith(
      PROJECT_EVENTS.PROPOSAL_CHECKLIST_JUMPED,
      expect.objectContaining({ source: 'shortcut' })
    );
  });

  it('a plain Enter does not preview or jump', async () => {
    const user = userEvent.setup();
    renderComposer(readyDraft());

    await user.keyboard('{Enter}');

    expect(screen.queryByText(/previewing as/i)).not.toBeInTheDocument();
    expect(mockTrack).not.toHaveBeenCalledWith(
      PROJECT_EVENTS.PROPOSAL_PREVIEW_OPENED,
      expect.anything()
    );
  });

  it('the CTA with nothing left opens the preview and tracks PREVIEW_OPENED', async () => {
    const user = userEvent.setup();
    renderComposer(readyDraft());

    await user.click(within(rail()).getByRole('button', { name: 'Preview and send' }));

    expect(screen.getByText('Previewing as Northwind')).toBeInTheDocument();
    expect(globalThis.scrollTo).toHaveBeenCalledWith(0, 0);
    expect(mockTrack).toHaveBeenCalledWith(PROJECT_EVENTS.PROPOSAL_PREVIEW_OPENED, {
      proposal_id: 'p1',
      pricing_method: 'fixed',
      is_resubmit: false,
      milestone_count: 1,
      milestones_priced: true,
    });
  });

  it('Ctrl+Enter on a ready draft opens the preview', async () => {
    const user = userEvent.setup();
    renderComposer(readyDraft());

    await user.keyboard('{Control>}{Enter}{/Control}');

    expect(screen.getByText('Previewing as Northwind')).toBeInTheDocument();
  });

  it('"Back to editing" returns to the composer', async () => {
    const user = userEvent.setup();
    renderComposer(readyDraft());

    await user.click(within(rail()).getByRole('button', { name: 'Preview and send' }));
    await user.click(screen.getByRole('button', { name: 'Back to editing' }));

    expect(screen.queryByText(/previewing as/i)).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Overview' })).toBeInTheDocument();
  });

  it('the preview shows the expert figure at identity money, not a marked-up one', async () => {
    const user = userEvent.setup();
    renderComposer(readyDraft());

    await user.click(within(rail()).getByRole('button', { name: 'Preview and send' }));

    expect(screen.getAllByText(/5,000/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/6,250/)).not.toBeInTheDocument();
  });

  it('preview → Send → sent screen, with a final save flushed first and no refresh', async () => {
    const user = userEvent.setup();
    renderComposer(readyDraft());

    await user.click(within(rail()).getByRole('button', { name: 'Preview and send' }));
    await user.click(screen.getByRole('button', { name: 'Send to Northwind' }));

    expect(
      await screen.findByRole('heading', { name: 'Nice work. Your proposal is with Northwind' })
    ).toBeInTheDocument();
    expect(saveProposalDraftAction).toHaveBeenCalled();
    expect(submitProposalAction).toHaveBeenCalledWith({
      requestId: REQUEST_ID,
      relationshipId: RELATIONSHIP_ID,
      proposalId: 'p1',
    });
    expect(router.refresh).not.toHaveBeenCalled();
    expect(screen.queryByText(/previewing as/i)).not.toBeInTheDocument();
  });

  it('a rejected send keeps the user in the preview', async () => {
    const user = userEvent.setup();
    submitProposalAction.mockResolvedValue({ success: false, error: 'Not ready' });
    renderComposer(readyDraft());

    await user.click(within(rail()).getByRole('button', { name: 'Preview and send' }));
    await user.click(screen.getByRole('button', { name: 'Send to Northwind' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Not ready'));
    expect(screen.getByText('Previewing as Northwind')).toBeInTheDocument();
  });
});

describe('ProposalComposer — drop anywhere', () => {
  it('shows the overlay while a file drag is over the page and hides it on drop', () => {
    renderComposer(readyDraft());
    const enter = new Event('dragenter', { bubbles: true, cancelable: true });
    Object.defineProperty(enter, 'dataTransfer', { value: { types: ['Files'], files: [] } });
    act(() => {
      globalThis.dispatchEvent(enter);
    });
    expect(screen.getByText('Drop to attach to your proposal')).toBeInTheDocument();

    dropFiles([]);
    expect(screen.queryByText('Drop to attach to your proposal')).not.toBeInTheDocument();
  });

  it('a window drop uploads through the ref controller only', () => {
    renderComposer(readyDraft());
    const file = new File(['x'], 'brief.pdf', { type: 'application/pdf' });

    dropFiles([file]);

    expect(uploads.uploadFiles.ref).toHaveBeenCalledWith([file]);
    expect(uploads.uploadFiles.terms).not.toHaveBeenCalled();
  });

  it('ignores drops once the preview is open', async () => {
    const user = userEvent.setup();
    renderComposer(readyDraft());
    await user.click(within(rail()).getByRole('button', { name: 'Preview and send' }));

    dropFiles([new File(['x'], 'brief.pdf', { type: 'application/pdf' })]);

    expect(uploads.uploadFiles.ref).not.toHaveBeenCalled();
  });
});

describe('ProposalComposer — revise mode (A6.4 / BAL-290)', () => {
  const mockTrack = vi.mocked(track);
  const mockToast = vi.mocked(toast);

  it('pins the client note beside the section it is about, with attribution', () => {
    renderReviseComposer(readyDraft(), { section: 'pricing', note: 'Please trim the price.' });

    expect(screen.getByText(/asked for a change to the pricing/i)).toBeInTheDocument();
    expect(screen.getByText(/“Please trim the price\.”/)).toBeInTheDocument();
    expect(screen.getByText('Priya Shah @ Northwind asked for one change.')).toBeInTheDocument();

    const note = document.getElementById('proposal-change-note');
    const pricing = document.getElementById('proposal-section-pricing');
    const milestones = document.getElementById('proposal-section-milestones');
    if (note === null || pricing === null || milestones === null) {
      throw new Error('expected the note and both sections');
    }
    expect(note.compareDocumentPosition(pricing) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(
      milestones.compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it.each([
    ['general', 'proposal-section-overview', 'the proposal'],
    ['milestones', 'proposal-section-milestones', 'the milestones'],
    ['payment_terms', 'proposal-section-pricing', 'the payment schedule'],
  ])('places a %s note above its section', (section, sectionId, phrase) => {
    renderReviseComposer(readyDraft(), { section });
    expect(
      screen.getByText(new RegExp(`asked for a change to ${phrase}`, 'i'))
    ).toBeInTheDocument();
    const note = document.getElementById('proposal-change-note');
    const target = document.getElementById(sectionId);
    if (note === null || target === null) throw new Error('expected the note and its section');
    expect(note.compareDocumentPosition(target) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(note.nextElementSibling).toBe(target);
  });

  it('places a timeline note under the property bar, before the brief', () => {
    renderReviseComposer(readyDraft(), { section: 'timeline' });
    const note = document.getElementById('proposal-change-note');
    const overview = document.getElementById('proposal-section-overview');
    if (note === null || overview === null) throw new Error('expected the note and overview');
    expect(note.compareDocumentPosition(overview) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText(/asked for a change to the timeline/i)).toBeInTheDocument();
  });

  it('"Go to note" scrolls to the note', async () => {
    const user = userEvent.setup();
    renderReviseComposer(readyDraft());
    const scroll = vi.spyOn(Element.prototype, 'scrollIntoView');

    await user.click(screen.getByRole('button', { name: 'Go to note' }));

    expect(scroll).toHaveBeenCalled();
  });

  it('keeps an unaddressed note as a soft item on a ready proposal; "Mark as addressed" clears it', async () => {
    const user = userEvent.setup();
    renderReviseComposer(readyDraft(), { section: 'pricing' });

    expect(
      within(rail()).getByRole('button', {
        name: "Priya's note on pricing isn't marked as addressed",
      })
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Mark as addressed' }));

    expect(screen.getByText('Marked as addressed')).toBeInTheDocument();
    expect(
      within(rail()).queryByRole('button', { name: /isn't marked as addressed/i })
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Show note' }));
    expect(screen.getByText(/can you trim scope/i)).toBeInTheDocument();
  });

  it('jumping to the soft item tracks the change_request issue', async () => {
    const user = userEvent.setup();
    renderReviseComposer(readyDraft(), { section: 'pricing' });

    await user.click(within(rail()).getByRole('button', { name: /isn't marked as addressed/i }));

    expect(mockTrack).toHaveBeenCalledWith(PROJECT_EVENTS.PROPOSAL_CHECKLIST_JUMPED, {
      proposal_id: 'p1',
      issue_id: 'change_request',
      source: 'rail',
    });
  });

  it('labels the CTA "Preview and resend" and shows "Not saved until you resend"', () => {
    renderReviseComposer(readyDraft());
    expect(within(rail()).getByRole('button', { name: 'Preview and resend' })).toBeInTheDocument();
    expect(screen.getByText('Not saved until you resend')).toBeInTheDocument();
  });

  it('does NOT autosave on edit (local-only until resend)', async () => {
    const user = userEvent.setup();
    renderReviseComposer(readyDraft());

    await user.type(screen.getByLabelText('Proposal overview'), ' more scope');
    await new Promise((resolve) => setTimeout(resolve, 1000));

    expect(saveProposalDraftAction).not.toHaveBeenCalled();
    expect(screen.queryByText('Saved as draft')).not.toBeInTheDocument();
  });

  it('keeps "Not saved until you resend" in the preview and hides it once sent', async () => {
    const user = userEvent.setup();
    resubmitProposalAction.mockResolvedValue({
      success: true,
      proposalId: 'v2-id',
      version: 2,
      expertProfileId: 'exp-42',
      analytics: { priceCents: 500_000, currency: 'aud' },
    });
    renderReviseComposer(readyDraft());

    await user.click(within(rail()).getByRole('button', { name: 'Preview and resend' }));
    expect(screen.getByText('Not saved until you resend')).toBeInTheDocument();
    expect(mockTrack).toHaveBeenCalledWith(
      PROJECT_EVENTS.PROPOSAL_PREVIEW_OPENED,
      expect.objectContaining({ is_resubmit: true })
    );

    await user.click(screen.getByRole('button', { name: 'Resend to Northwind' }));

    expect(
      await screen.findByRole('heading', { name: 'Version 2 is with Northwind' })
    ).toBeInTheDocument();
    expect(screen.queryByText('Not saved until you resend')).not.toBeInTheDocument();
  });

  it('resending calls resubmitProposalAction with the full payload and fires PROPOSAL_RESUBMITTED', async () => {
    const user = userEvent.setup();
    resubmitProposalAction.mockResolvedValue({
      success: true,
      proposalId: 'v2-id',
      version: 2,
      expertProfileId: 'exp-42',
      analytics: { priceCents: 500_000, currency: 'aud' },
    });
    renderReviseComposer(readyDraft(), { currentVersion: 1 });

    await user.click(within(rail()).getByRole('button', { name: 'Preview and resend' }));
    await user.click(screen.getByRole('button', { name: 'Resend to Northwind' }));

    await waitFor(() => expect(resubmitProposalAction).toHaveBeenCalled());
    const payload = resubmitProposalAction.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload).toMatchObject({
      requestId: REQUEST_ID,
      relationshipId: RELATIONSHIP_ID,
      fromProposalId: FROM_PROPOSAL_ID,
      pricingMethod: 'fixed',
    });
    expect(Array.isArray(payload.milestones)).toBe(true);
    expect(mockTrack).toHaveBeenCalledWith(PROJECT_EVENTS.PROPOSAL_RESUBMITTED, {
      request_id: REQUEST_ID,
      relationship_id: RELATIONSHIP_ID,
      expert_id: 'exp-42',
      version: 2,
      price_cents: 500_000,
      currency: 'aud',
    });
    expect(saveProposalDraftAction).not.toHaveBeenCalled();
    expect(router.refresh).not.toHaveBeenCalled();
    expect(mockToast.success).toHaveBeenCalledWith('Version 2 sent to Northwind');
  });
});

function firstMilestone(draft: ProposalDraftState): ProposalMilestoneDraft {
  const [first] = draft.milestones;
  if (first === undefined) throw new Error('expected a milestone');
  return first;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function openPreviewAndSend(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(within(rail()).getByRole('button', { name: 'Preview and send' }));
  await user.click(screen.getByRole('button', { name: 'Send to Northwind' }));
}

describe('ProposalComposer — header and edit tree', () => {
  it('shows the header only while editing', async () => {
    const user = userEvent.setup();
    renderComposer(readyDraft());
    expect(screen.getByRole('heading', { name: 'Quote-to-cash rebuild header' })).toBeVisible();

    await user.click(within(rail()).getByRole('button', { name: 'Preview and send' }));
    expect(
      screen.queryByRole('heading', { name: 'Quote-to-cash rebuild header' })
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Send to Northwind' }));
    await screen.findByRole('heading', { name: 'Nice work. Your proposal is with Northwind' });
    expect(screen.queryByText('Quote-to-cash rebuild header')).not.toBeInTheDocument();
  });

  it('keeps the edit tree mounted through the preview, so expanded rows survive', async () => {
    const user = userEvent.setup();
    renderComposer(readyDraft());
    await user.click(screen.getByRole('button', { name: 'Show details for milestone 1' }));

    await user.click(within(rail()).getByRole('button', { name: 'Preview and send' }));
    expect(screen.getByLabelText('Milestone 1 title')).not.toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Back to editing' }));

    expect(screen.getByLabelText('Milestone 1 title')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Hide details for milestone 1' })).toBeVisible();
  });

  it('restores the scroll position on "Back to editing" and starts the preview at the top', async () => {
    const user = userEvent.setup();
    renderComposer(readyDraft());
    vi.spyOn(globalThis, 'scrollY', 'get').mockReturnValue(640);
    const scrollTo = vi.mocked(globalThis.scrollTo);

    await user.click(within(rail()).getByRole('button', { name: 'Preview and send' }));
    expect(scrollTo).toHaveBeenLastCalledWith(0, 0);
    await user.click(screen.getByRole('button', { name: 'Back to editing' }));

    expect(scrollTo).toHaveBeenLastCalledWith(0, 640);
  });
});

describe('ProposalComposer — Ctrl+Enter inside an editor', () => {
  it('previews and stops the key before the editor sees it', () => {
    renderComposer(readyDraft());
    const overview = screen.getByLabelText('Proposal overview');
    const seenByEditor = vi.fn();
    overview.addEventListener('keydown', seenByEditor);

    const notCancelled = fireEvent.keyDown(overview, { key: 'Enter', ctrlKey: true });

    expect(notCancelled).toBe(false);
    expect(seenByEditor).not.toHaveBeenCalled();
    expect(screen.getByText('Previewing as Northwind')).toBeInTheDocument();
  });

  it('lets a plain Enter reach the editor', () => {
    renderComposer(readyDraft());
    const overview = screen.getByLabelText('Proposal overview');
    const seenByEditor = vi.fn();
    overview.addEventListener('keydown', seenByEditor);

    fireEvent.keyDown(overview, { key: 'Enter' });

    expect(seenByEditor).toHaveBeenCalledTimes(1);
  });
});

describe('ProposalComposer — flush before send', () => {
  it('waits for a save in flight, and does not save again when nothing changed since', async () => {
    const user = userEvent.setup();
    const inFlight = deferred<{ success: true; proposalId: string }>();
    saveProposalDraftAction.mockImplementationOnce(() => inFlight.promise);
    renderComposer(readyDraft());
    await user.type(screen.getByLabelText('Proposal overview'), ' x');
    await waitFor(() => expect(saveProposalDraftAction).toHaveBeenCalledTimes(1), {
      timeout: 2000,
    });

    await openPreviewAndSend(user);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(submitProposalAction).not.toHaveBeenCalled();

    await act(async () => inFlight.resolve({ success: true, proposalId: 'p1' }));

    await waitFor(() => expect(submitProposalAction).toHaveBeenCalledTimes(1));
    expect(saveProposalDraftAction).toHaveBeenCalledTimes(1);
  });

  it('saves again after the in-flight save when the draft changed since it began', async () => {
    const user = userEvent.setup();
    const inFlight = deferred<{ success: true; proposalId: string }>();
    saveProposalDraftAction.mockImplementationOnce(() => inFlight.promise);
    renderComposer(readyDraft());
    const overview = screen.getByLabelText('Proposal overview');
    await user.type(overview, ' x');
    await waitFor(() => expect(saveProposalDraftAction).toHaveBeenCalledTimes(1), {
      timeout: 2000,
    });
    await user.type(overview, ' y');

    await openPreviewAndSend(user);
    await act(async () => inFlight.resolve({ success: true, proposalId: 'p1' }));

    await waitFor(() => expect(submitProposalAction).toHaveBeenCalledTimes(1));
    expect(saveProposalDraftAction).toHaveBeenCalledTimes(2);
    const savedOverview = (saveProposalDraftAction.mock.calls[1]?.[0] as { overview: string })
      .overview;
    expect(savedOverview).toContain(' x y');
    expect(submitProposalAction.mock.invocationCallOrder[0]).toBeGreaterThan(
      saveProposalDraftAction.mock.invocationCallOrder[1] ?? Infinity
    );
  });

  it('aborts the send with the error toast when the flush fails', async () => {
    const user = userEvent.setup();
    saveProposalDraftAction.mockResolvedValue({ success: false, error: 'nope' });
    renderComposer(readyDraft());

    await openPreviewAndSend(user);

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(submitProposalAction).not.toHaveBeenCalled();
    expect(screen.getByText('Previewing as Northwind')).toBeInTheDocument();
  });
});

describe('ProposalComposer — save status', () => {
  it('announces a failed save assertively with a Retry that saves again', async () => {
    const user = userEvent.setup();
    saveProposalDraftAction.mockResolvedValue({ success: false, error: 'nope' });
    renderComposer(readyDraft());
    await user.type(screen.getByLabelText('Proposal overview'), ' x');

    await waitFor(
      () => expect(screen.getByRole('alert')).toHaveTextContent("Couldn't save draft"),
      {
        timeout: 2000,
      }
    );

    saveProposalDraftAction.mockResolvedValue({ success: true, proposalId: 'p1' });
    const callsBefore = saveProposalDraftAction.mock.calls.length;
    await user.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByText('Saved as draft')).toBeInTheDocument();
    expect(saveProposalDraftAction.mock.calls.length).toBe(callsBefore + 1);
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });

  it('announces a landed save politely and keeps "Saving…" out of the live regions', async () => {
    const user = userEvent.setup();
    const inFlight = deferred<{ success: true; proposalId: string }>();
    saveProposalDraftAction.mockImplementationOnce(() => inFlight.promise);
    renderComposer(readyDraft());
    await user.type(screen.getByLabelText('Proposal overview'), ' x');

    const saving = await screen.findByText('Saving…', {}, { timeout: 2000 });
    expect(saving.closest('[role="status"], [role="alert"], [aria-live]')).toBeNull();

    await act(async () => inFlight.resolve({ success: true, proposalId: 'p1' }));
    const saved = await screen.findByText('Saved as draft');
    expect(saved).toHaveAttribute('role', 'status');
  });

  it('does not announce the revise note', () => {
    renderReviseComposer(readyDraft());
    const note = screen.getByText('Not saved until you resend');
    expect(note.closest('[role="status"], [role="alert"], [aria-live]')).toBeNull();
  });
});

describe('ProposalComposer — undo hardening', () => {
  const mockToast = vi.mocked(toast);

  it('milestone-pricing Undo keeps the amount of a row added after the switch', async () => {
    const user = userEvent.setup();
    renderComposer(readyDraft());
    await user.click(screen.getByRole('switch', { name: /price each milestone/i }));
    const undo = lastToastUndo();
    await user.click(screen.getByRole('button', { name: /add milestone/i }));
    await user.type(screen.getByLabelText('Milestone 2 title'), 'Build');

    act(() => undo());

    expect(screen.getByLabelText('Milestone 1 amount')).toHaveValue(5000);
    expect(screen.getByLabelText('Milestone 2 title')).toHaveValue('Build');
    expect(screen.getByLabelText('Milestone 2 amount')).toBeInTheDocument();
  });

  it('gives the milestone-pricing toast a stable id and dismisses it on re-enable', async () => {
    const user = userEvent.setup();
    renderComposer(readyDraft());
    const toggle = screen.getByRole('switch', { name: /price each milestone/i });
    await user.click(toggle);
    const options = mockToast.mock.calls.at(-1)?.[1] as { id?: string };
    expect(options.id).toEqual(expect.any(String));

    await user.click(toggle);

    expect(toast.dismiss).toHaveBeenCalledWith(options.id);
  });

  it('dismisses the Undo toasts on leaving the edit screen', async () => {
    const user = userEvent.setup();
    renderComposer(readyDraft());
    await user.click(screen.getByRole('switch', { name: /price each milestone/i }));
    const options = mockToast.mock.calls.at(-1)?.[1] as { id?: string };
    vi.mocked(toast.dismiss).mockClear();

    await user.click(within(rail()).getByRole('button', { name: 'Preview and send' }));

    expect(toast.dismiss).toHaveBeenCalledWith(options.id);
  });

  it('method-switch Undo leaves a price edited after the switch alone', async () => {
    const user = userEvent.setup();
    renderComposer(readyTmDraft()); // pre-fills the Fixed price with A$400
    await user.click(screen.getByRole('button', { name: /time & materials/i }));
    await user.click(screen.getByRole('radio', { name: /fixed price/i }));
    const undo = lastToastUndo();
    const price = screen.getByLabelText('Project price');
    await user.clear(price);
    await user.type(price, '900');

    act(() => undo());
    await user.click(screen.getByRole('button', { name: /time & materials/i }));
    await user.click(screen.getByRole('radio', { name: /fixed price/i }));

    expect(screen.getByLabelText('Project price')).toHaveValue(900);
  });

  it('a stale method-switch Undo does nothing and fires no event', async () => {
    const user = userEvent.setup();
    renderComposer(readyDraft());
    await user.click(screen.getByRole('button', { name: /fixed price/i }));
    await user.click(screen.getByRole('radio', { name: /time & materials/i }));
    const staleUndo = lastToastUndo();
    await user.click(screen.getByRole('button', { name: /time & materials/i }));
    await user.click(screen.getByRole('radio', { name: /fixed price/i }));
    vi.mocked(track).mockClear();

    act(() => staleUndo());

    expect(screen.getByRole('heading', { name: 'Price and payments' })).toBeInTheDocument();
    expect(track).not.toHaveBeenCalled();
  });
});

describe('ProposalComposer — removing a milestone', () => {
  it('offers Undo for a milestone with content and restores it at its index', async () => {
    const user = userEvent.setup();
    const draft = readyDraft();
    const second = { ...firstMilestone(draft), key: nextDraftKey(), title: 'Build' };
    const third = { ...firstMilestone(draft), key: nextDraftKey(), title: 'Launch' };
    renderComposer({ ...draft, milestones: [...draft.milestones, second, third] });

    await user.click(screen.getByRole('button', { name: 'Remove milestone 2' }));
    expect(screen.getByLabelText('Milestone 2 title')).toHaveValue('Launch');
    act(() => lastToastUndo()());

    expect(screen.getByLabelText('Milestone 2 title')).toHaveValue('Build');
    expect(screen.getByLabelText('Milestone 3 title')).toHaveValue('Launch');
  });

  it('shows no Undo for an empty milestone', async () => {
    const user = userEvent.setup();
    const draft = readyDraft();
    const empty = {
      ...firstMilestone(draft),
      key: nextDraftKey(),
      title: '',
      valueCents: null,
    };
    renderComposer({ ...draft, milestones: [...draft.milestones, empty] });
    vi.mocked(toast).mockClear();

    await user.click(screen.getByRole('button', { name: 'Remove milestone 2' }));

    expect(toast).not.toHaveBeenCalled();
  });
});

describe('ProposalComposer — attribution without a company', () => {
  it('names the bare client in the revise summary and the note', () => {
    renderComposer(readyDraft(), {
      companyName: 'the client',
      clientCompanyName: null,
      changeRequest: { section: 'pricing', note: 'Please trim the price.' },
      fromProposalId: FROM_PROPOSAL_ID,
      currentVersion: 1,
    });

    expect(screen.getByText('Priya Shah asked for one change.')).toBeInTheDocument();
    expect(screen.queryByText(/@/)).not.toBeInTheDocument();
  });

  it('names the bare client on a timeline note', () => {
    renderComposer(readyDraft(), {
      companyName: 'the client',
      clientCompanyName: null,
      changeRequest: { section: 'timeline', note: 'Can this land sooner?' },
      fromProposalId: FROM_PROPOSAL_ID,
      currentVersion: 1,
    });

    expect(screen.getByText('Priya Shah')).toBeInTheDocument();
    expect(screen.queryByText(/@/)).not.toBeInTheDocument();
  });
});

describe('ProposalComposer — timeline note attribution', () => {
  it('names the company on the first mention and uses the bare name after', () => {
    renderReviseComposer(readyDraft(), { section: 'timeline' });

    expect(screen.getByText('Priya Shah @ Northwind')).toBeInTheDocument();
    expect(screen.getByText('Priya Shah asked for one change.')).toBeInTheDocument();
  });
});
