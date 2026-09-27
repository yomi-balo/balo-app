import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { track, PROJECT_EVENTS } from '@/lib/analytics';
import { toast } from 'sonner';
import type { ProjectRequestTaxonomies } from '@/lib/project-request/load-project-taxonomy';

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));

// useIsMobile reads window.matchMedia (absent in jsdom) — default to desktop.
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }));

// Mock the Server Action modules the panel / sub-components import.
const { mockSubmit, mockRefetch } = vi.hoisted(() => ({
  mockSubmit: vi.fn(),
  mockRefetch: vi.fn(),
}));
vi.mock('@/lib/project-request/actions/submit-project-request', () => ({
  submitProjectRequestAction: mockSubmit,
}));
vi.mock('@/lib/project-request/actions/refetch-project-taxonomies', () => ({
  refetchProjectTaxonomiesAction: mockRefetch,
}));
vi.mock('@/lib/project-request/actions/request-project-document-upload', () => ({
  requestProjectDocumentUploadAction: vi.fn(),
}));
vi.mock('@/lib/project-request/actions/confirm-project-document-upload', () => ({
  confirmProjectDocumentUploadAction: vi.fn(),
}));
vi.mock('@/lib/project-request/actions/remove-project-document', () => ({
  removeProjectDocumentAction: vi.fn(),
}));

// BAL-254 — the AI brief-parse Server Actions the polling hook calls.
const { mockStartBrief, mockGetBrief } = vi.hoisted(() => ({
  mockStartBrief: vi.fn(),
  mockGetBrief: vi.fn(),
}));
vi.mock('@/lib/project-request/actions/start-project-brief-parse', () => ({
  startProjectBriefParseAction: mockStartBrief,
}));
vi.mock('@/lib/project-request/actions/get-project-brief-parse', () => ({
  getProjectBriefParseAction: mockGetBrief,
}));

// BAL-254 — the real DocumentUploader drives a presigned-upload + XHR flow that is out of
// scope for this panel-level suite (covered by `document-uploader.test.tsx`). A single button
// stand-in lets the AI-flow tests attach a document without re-exercising that machinery.
//
// ⚠ THE STAND-IN HONOURS `initialDocuments` (BAL-254 W1). The real component's seeding is tested
// in `document-uploader.test.tsx`; what THIS suite has to prove is the other half — that the
// panel actually hands it `draft.documents` on every mount, including the remount that
// "Change source documents" causes. So the mock renders what it was seeded with and APPENDS on
// attach, exactly as the real one now does.
interface MockDoc {
  r2Key: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
}
// Every `onDocumentsChange` the stand-in was rendered with, in order — so a test can play the part
// of an upload that finishes AFTER its uploader was replaced (it keeps its last-rendered props).
const { mockUploaderHandlers } = vi.hoisted(() => ({
  mockUploaderHandlers: [] as Array<(docs: MockDoc[]) => void>,
}));
vi.mock('@/components/balo/document-uploader', async () => {
  const { useState } = await import('react');
  return {
    DocumentUploader: function MockDocumentUploader({
      initialDocuments,
      onDocumentsChange,
      onRequireAuth,
    }: {
      initialDocuments?: readonly MockDoc[];
      onDocumentsChange: (docs: MockDoc[]) => void;
      onRequireAuth?: () => void;
    }) {
      // ⚠ LAZY, like the real uploader: `initialDocuments` is read ONCE, on mount. So a test only
      // sees a replaced draft's files here if the panel actually REMOUNTED the uploader.
      const [rows, setRows] = useState<MockDoc[]>(() => [...(initialDocuments ?? [])]);
      mockUploaderHandlers.push(onDocumentsChange);
      return (
        <div>
          <p>{`seeded: ${rows.length}`}</p>
          {rows.map((doc) => (
            <p key={doc.r2Key}>{doc.fileName}</p>
          ))}
          <button
            type="button"
            onClick={() => {
              // BAL-582 (D1) — the mock honours `onRequireAuth` exactly as the real uploader does:
              // signed out, an attach calls it instead of publishing a document.
              if (onRequireAuth) {
                onRequireAuth();
                return;
              }
              const next = [
                ...rows,
                {
                  r2Key: `project-documents/c/u/k${rows.length}`,
                  fileName: `rfp-${rows.length}.pdf`,
                  contentType: 'application/pdf',
                  sizeBytes: 1024,
                },
              ];
              setRows(next);
              onDocumentsChange(next);
            }}
          >
            Attach test file
          </button>
        </div>
      );
    },
  };
});

// The real RichTextEditor is a code-split TipTap (ProseMirror) component that
// can't mount in jsdom. Mock the public module with a controlled textarea that
// emits the same HTML contract, plus pass-through validation helpers.
vi.mock('@/components/balo/rich-text-editor', () => ({
  RichTextEditor: ({
    value,
    onChange,
    placeholder,
  }: {
    value: string;
    onChange: (html: string) => void;
    placeholder?: string;
  }) => {
    // Show the plain text (strip the <p> wrapper) so char-by-char typing doesn't
    // re-wrap cumulatively; emit a single <p>…</p> HTML on change.
    const plain = value.replace(/<[^<>]*>/g, '');
    return (
      <textarea
        aria-label="Project description"
        placeholder={placeholder}
        value={plain}
        onChange={(e) => onChange(e.target.value ? `<p>${e.target.value}</p>` : '')}
      />
    );
  },
  RichTextViewer: ({ value }: { value: string }) => <div data-testid="rt-viewer">{value}</div>,
  validateDescription: (html: string) => {
    const text = html.replace(/<[^<>]*>/g, '').trim();
    if (text.length < 10) return 'Add a few words about what you need.';
    return null;
  },
}));

import { ProjectRequestPanel } from './project-request-panel';
import type { ProjectRequestSeed } from './project-seed';
import { NEW_REQUEST_NOTICE_COPY } from './new-request-notice';

const mockTrack = vi.mocked(track);
const mockToast = vi.mocked(toast);

const TAXONOMIES: ProjectRequestTaxonomies = {
  tags: {
    groups: [
      {
        id: 'g1',
        name: 'Foundational',
        items: [
          { id: '11111111-1111-1111-1111-111111111111', name: 'New Salesforce Implementation' },
          { id: '22222222-2222-2222-2222-222222222222', name: 'Data Migration / Data Cleanup' },
        ],
      },
    ],
  },
  products: {
    groups: [
      {
        id: 'c1',
        name: 'Core Clouds',
        items: [{ id: '33333333-3333-3333-3333-333333333333', name: 'Sales Cloud' }],
      },
    ],
  },
};

const EXPERT_PROFILE_ID = '99999999-9999-9999-9999-999999999999';

const BASE_PROPS = {
  entryPoint: 'profile' as const,
  expertProfileId: EXPERT_PROFILE_ID,
  expert: {
    name: 'Priya Sharma',
    firstName: 'Priya',
    initials: 'PS',
    avatarKey: null,
  },
  projectTaxonomies: TAXONOMIES,
} as const;

function renderPanel(overrides: Partial<React.ComponentProps<typeof ProjectRequestPanel>> = {}) {
  return render(<ProjectRequestPanel open onClose={vi.fn()} {...BASE_PROPS} {...overrides} />);
}

/** start → manual → fill required fields → review. */
async function advanceToReview(): Promise<ReturnType<typeof userEvent.setup>> {
  const user = userEvent.setup();
  renderPanel();
  await user.click(screen.getByRole('button', { name: /describe it yourself/i }));
  await user.type(screen.getByLabelText(/project title/i), 'Lead routing rebuild');
  await user.type(
    screen.getByLabelText(/project description/i),
    'Rebuild our lead routing in Flow.'
  );
  await user.click(screen.getByRole('button', { name: /^review/i }));
  return user;
}

describe('ProjectRequestPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    globalThis.localStorage.clear();
    mockSubmit.mockResolvedValue({ success: true, projectRequestId: 'pr-1' });
    mockRefetch.mockResolvedValue(TAXONOMIES);
  });

  it('opens to the start step with both path cards', () => {
    renderPanel();
    expect(
      screen.getByRole('heading', { name: /start a project with priya sharma/i })
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /describe it yourself/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /upload docs/i })).toBeInTheDocument();
  });

  it('the AI card is enabled and routes to the upload step, firing PROJECT_ENTRY_SELECTED', async () => {
    const user = userEvent.setup();
    renderPanel();
    const aiCard = screen.getByRole('button', { name: /upload docs/i });
    expect(aiCard).not.toBeDisabled();

    await user.click(aiCard);

    expect(screen.getByRole('heading', { name: /upload your project docs/i })).toBeInTheDocument();
    expect(mockTrack).toHaveBeenCalledWith(PROJECT_EVENTS.PROJECT_ENTRY_SELECTED, {
      expert_id: EXPERT_PROFILE_ID,
      entry_point: 'profile',
      method: 'ai',
    });
  });

  it('advances to the form and fires PROJECT_ENTRY_SELECTED on selecting manual', async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByRole('button', { name: /describe it yourself/i }));

    expect(screen.getByLabelText(/project title/i)).toBeInTheDocument();
    expect(mockTrack).toHaveBeenCalledWith(PROJECT_EVENTS.PROJECT_ENTRY_SELECTED, {
      expert_id: EXPERT_PROFILE_ID,
      entry_point: 'profile',
      method: 'manual',
    });
  });

  it('defaults routing to Direct and shows the Direct FormDescription', async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByRole('button', { name: /describe it yourself/i }));

    const radios = screen.getAllByRole('radio');
    // Direct card (first) is checked by default.
    expect(radios[0]).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText(/priya receives this brief directly/i)).toBeInTheDocument();
    // Submit-related copy will be "Send to Priya".
  });

  it('switches all routing-aware copy when Match is selected', async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByRole('button', { name: /describe it yourself/i }));

    // Direct (default) shows no routing-aware manual heading.
    expect(
      screen.queryByText(/tell us what you need and we'll match you with the right expert/i)
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole('radio', { name: /find me an expert/i }));

    expect(
      screen.getByText(/our team reviews your brief and introduces a matched expert/i)
    ).toBeInTheDocument();
    // Match adds a routing-aware framing heading above the selector.
    expect(
      screen.getByText(/tell us what you need and we'll match you with the right expert/i)
    ).toBeInTheDocument();
  });

  it('blocks Review with an inline message until title + description are valid', async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByRole('button', { name: /describe it yourself/i }));

    // Empty → clicking Review surfaces validation and stays on manual.
    await user.click(screen.getByRole('button', { name: /^review/i }));
    expect(screen.getByText(/give your project a title/i)).toBeInTheDocument();
    expect(screen.getByText(/add a few words about what you need/i)).toBeInTheDocument();
    // Still on manual (description editor visible).
    expect(screen.getByLabelText(/project description/i)).toBeInTheDocument();

    await user.type(screen.getByLabelText(/project title/i), 'A real title');
    await user.type(screen.getByLabelText(/project description/i), 'Enough description here.');
    await user.click(screen.getByRole('button', { name: /^review/i }));
    // Advanced to review (read-only viewer present).
    expect(await screen.findByTestId('rt-viewer')).toBeInTheDocument();
  });

  it('submits a Direct request with the discriminated-union payload + analytics', async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByRole('button', { name: /describe it yourself/i }));
    await user.type(screen.getByLabelText(/project title/i), 'Lead routing rebuild');
    await user.type(
      screen.getByLabelText(/project description/i),
      'Rebuild our lead routing in Flow.'
    );
    // Tags + products live on the manual step; their browse lists are overlay
    // popups, so open each picker before toggling a chip.
    await user.click(screen.getByPlaceholderText('Filter project types…'));
    await user.click(screen.getByRole('button', { name: 'New Salesforce Implementation' }));
    await user.click(screen.getByPlaceholderText('Filter products…'));
    await user.click(screen.getByRole('button', { name: 'Sales Cloud' }));
    await user.click(screen.getByRole('button', { name: /^review/i }));

    await user.click(screen.getByRole('button', { name: /send to priya/i }));

    await waitFor(() => {
      expect(mockSubmit).toHaveBeenCalledWith(
        expect.objectContaining({
          sendTo: 'direct',
          expertProfileId: EXPERT_PROFILE_ID,
          title: 'Lead routing rebuild',
          description: '<p>Rebuild our lead routing in Flow.</p>',
          tagIds: ['11111111-1111-1111-1111-111111111111'],
          productIds: ['33333333-3333-3333-3333-333333333333'],
          documents: [],
          source: 'manual',
        })
      );
    });

    expect(mockTrack).toHaveBeenCalledWith(PROJECT_EVENTS.PROJECT_REQUEST_SUBMITTED, {
      expert_id: EXPERT_PROFILE_ID,
      entry_point: 'profile',
      send_to: 'direct',
      tag_count: 1,
      product_count: 1,
      document_count: 0,
      method: 'manual',
    });
    expect(await screen.findByText(/request sent to priya/i)).toBeInTheDocument();
    expect(mockToast.success).toHaveBeenCalledWith('Request sent', expect.objectContaining({}));
  });

  it('calls onSubmitted with the created request id after a successful submit', async () => {
    const onSubmitted = vi.fn();
    const user = userEvent.setup();
    render(
      <ProjectRequestPanel open onClose={vi.fn()} {...BASE_PROPS} onSubmitted={onSubmitted} />
    );
    await user.click(screen.getByRole('button', { name: /describe it yourself/i }));
    await user.type(screen.getByLabelText(/project title/i), 'Lead routing rebuild');
    await user.type(
      screen.getByLabelText(/project description/i),
      'Rebuild our lead routing in Flow.'
    );
    await user.click(screen.getByRole('button', { name: /^review/i }));
    await user.click(screen.getByRole('button', { name: /send to priya/i }));

    await waitFor(() => expect(onSubmitted).toHaveBeenCalledWith('pr-1'));
  });

  it('captures budget (whole dollars → cents) and timeline into the submit payload', async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByRole('button', { name: /describe it yourself/i }));
    await user.type(screen.getByLabelText(/project title/i), 'Budgeted build');
    await user.type(
      screen.getByLabelText(/project description/i),
      'Rebuild our lead routing in Flow.'
    );

    await user.type(screen.getByLabelText(/min budget/i), '5000');
    await user.type(screen.getByLabelText(/max budget/i), '12000');
    await user.type(screen.getByLabelText(/timeline/i), 'Target go-live: end of Q3');

    await user.click(screen.getByRole('button', { name: /^review/i }));
    await user.click(screen.getByRole('button', { name: /send to priya/i }));

    await waitFor(() => {
      expect(mockSubmit).toHaveBeenCalledWith(
        expect.objectContaining({
          // Whole-dollar input persisted as integer cents.
          budgetMinCents: 500000,
          budgetMaxCents: 1200000,
          timeline: 'Target go-live: end of Q3',
        })
      );
    });
  });

  it('clears budget back to null when the input is emptied or invalid', async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByRole('button', { name: /describe it yourself/i }));
    await user.type(screen.getByLabelText(/project title/i), 'Budget edge cases');
    await user.type(
      screen.getByLabelText(/project description/i),
      'Rebuild our lead routing in Flow.'
    );

    const minBudget = screen.getByLabelText(/min budget/i);
    // Typed then fully cleared → null (empty-string branch).
    await user.type(minBudget, '5000');
    await user.clear(minBudget);
    // Non-numeric input → null (invalid branch).
    await user.type(screen.getByLabelText(/max budget/i), 'abc');

    await user.click(screen.getByRole('button', { name: /^review/i }));
    await user.click(screen.getByRole('button', { name: /send to priya/i }));

    await waitFor(() => {
      expect(mockSubmit).toHaveBeenCalledWith(
        expect.objectContaining({ budgetMinCents: null, budgetMaxCents: null })
      );
    });
  });

  it('shows the budget-range alert when max is below min', async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByRole('button', { name: /describe it yourself/i }));
    await user.type(screen.getByLabelText(/min budget/i), '9000');
    await user.type(screen.getByLabelText(/max budget/i), '1000');

    expect(await screen.findByRole('alert')).toHaveTextContent(/at least the minimum/i);
  });

  it('coerces budget input to whole-dollar cents (tolerates commas, ignores decimals)', async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByRole('button', { name: /describe it yourself/i }));
    await user.type(screen.getByLabelText(/project title/i), 'Whole-dollar budget');
    await user.type(
      screen.getByLabelText(/project description/i),
      'Rebuild our lead routing in Flow.'
    );

    // Paste delivers the whole string in a single onChange (models a real paste /
    // autofill) so the handler's coercion — not intermediate controlled-input
    // states — is what's under test.
    // Comma thousands-separator tolerated → 150000 cents (not nulled).
    await user.click(screen.getByLabelText(/min budget/i));
    await user.paste('1,500');
    // A stray decimal collapses to its whole-dollar part → 4500000 cents
    // (no rounding-up surprise; stored cents stay a multiple of 100).
    await user.click(screen.getByLabelText(/max budget/i));
    await user.paste('45000.50');

    await user.click(screen.getByRole('button', { name: /^review/i }));
    await user.click(screen.getByRole('button', { name: /send to priya/i }));

    await waitFor(() => {
      expect(mockSubmit).toHaveBeenCalledWith(
        expect.objectContaining({ budgetMinCents: 150000, budgetMaxCents: 4500000 })
      );
    });
  });

  it('omits expertProfileId and uses Match copy when routing is Match', async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByRole('button', { name: /describe it yourself/i }));
    await user.click(screen.getByRole('radio', { name: /find me an expert/i }));
    await user.type(screen.getByLabelText(/project title/i), 'Match me up');
    await user.type(screen.getByLabelText(/project description/i), 'We need help scoping work.');
    await user.click(screen.getByRole('button', { name: /^review/i }));

    await user.click(screen.getByRole('button', { name: /find me an expert/i }));

    await waitFor(() => {
      expect(mockSubmit).toHaveBeenCalledWith(
        expect.objectContaining({ sendTo: 'match', title: 'Match me up' })
      );
    });
    // No expertProfileId in the match payload.
    const payload = mockSubmit.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload).not.toHaveProperty('expertProfileId');
    expect(await screen.findByText(/we're finding your expert/i)).toBeInTheDocument();
  });

  it('on submit failure shows an inline error + toast.error and stays on review', async () => {
    mockSubmit.mockResolvedValue({ success: false, error: 'Something went wrong.' });
    const user = await advanceToReview();

    await user.click(screen.getByRole('button', { name: /send to priya/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong.');
    expect(mockToast.error).toHaveBeenCalledWith('Something went wrong.');
    expect(screen.getByRole('button', { name: /send to priya/i })).toBeInTheDocument();
    expect(screen.queryByText(/request sent to priya/i)).not.toBeInTheDocument();
  });

  it('fires PROJECT_DRAWER_OPENED exactly once on open', () => {
    renderPanel();
    const openCalls = mockTrack.mock.calls.filter(
      ([event]) => event === PROJECT_EVENTS.PROJECT_DRAWER_OPENED
    );
    expect(openCalls).toHaveLength(1);
    expect(openCalls[0]?.[1]).toEqual({ expert_id: EXPERT_PROFILE_ID, entry_point: 'profile' });
  });

  it('does not fire PROJECT_DRAWER_OPENED when closed', () => {
    render(<ProjectRequestPanel open={false} onClose={vi.fn()} {...BASE_PROPS} />);
    expect(mockTrack).not.toHaveBeenCalledWith(
      PROJECT_EVENTS.PROJECT_DRAWER_OPENED,
      expect.anything()
    );
  });

  // BAL-582 (R3) — a reopen fires exactly one STEP_VIEWED, for the OPENING step, never the step
  // the panel happened to be showing when it was closed.
  it('a panel closed on review and reopened fires one step:"start" STEP_VIEWED, never "review"', async () => {
    const user = userEvent.setup();
    const { rerender } = renderPanel();
    await user.click(screen.getByRole('button', { name: /describe it yourself/i }));
    await user.type(screen.getByLabelText(/project title/i), 'Lead routing rebuild');
    await user.type(
      screen.getByLabelText(/project description/i),
      'Rebuild our lead routing in Flow.'
    );
    await user.click(screen.getByRole('button', { name: /^review/i }));
    await screen.findByTestId('rt-viewer');

    rerender(<ProjectRequestPanel open={false} onClose={vi.fn()} {...BASE_PROPS} />);
    mockTrack.mockClear();
    rerender(<ProjectRequestPanel open onClose={vi.fn()} {...BASE_PROPS} />);

    const stepViewedCalls = mockTrack.mock.calls.filter(
      ([event]) => event === PROJECT_EVENTS.PROJECT_STEP_VIEWED
    );
    expect(stepViewedCalls).toHaveLength(1);
    expect(stepViewedCalls[0]?.[1]).toMatchObject({ step: 'start' });
    expect(
      stepViewedCalls.some(([, payload]) => (payload as { step: string }).step === 'review')
    ).toBe(false);
  });

  it('persists the draft to localStorage and hydrates it on remount', async () => {
    const user = userEvent.setup();
    const { unmount } = renderPanel();
    await user.click(screen.getByRole('button', { name: /describe it yourself/i }));
    await user.type(screen.getByLabelText(/project title/i), 'Persisted title');

    await waitFor(() => {
      const raw = globalThis.localStorage.getItem(`balo:project-draft:${EXPERT_PROFILE_ID}`);
      expect(raw).toContain('Persisted title');
    });

    unmount();
    renderPanel();
    await user.click(screen.getByRole('button', { name: /describe it yourself/i }));
    expect(screen.getByLabelText(/project title/i)).toHaveValue('Persisted title');
  });

  it('clears the draft from localStorage on successful submit', async () => {
    const user = await advanceToReview();
    await waitFor(() => {
      expect(
        globalThis.localStorage.getItem(`balo:project-draft:${EXPERT_PROFILE_ID}`)
      ).not.toBeNull();
    });

    await user.click(screen.getByRole('button', { name: /send to priya/i }));

    await waitFor(() => {
      expect(globalThis.localStorage.getItem(`balo:project-draft:${EXPERT_PROFILE_ID}`)).toBeNull();
    });
  });

  it('has no accessibility violations', async () => {
    const { baseElement } = renderPanel();
    expect(await axe(baseElement)).toHaveNoViolations();
  });

  // ── BAL-254: the AI brief path ──────────────────────────────────────────
  // Real timers throughout (the 2s poll interval is a real setInterval) — fake timers plus
  // userEvent's internal async waits proved unreliable together in this suite, so each test
  // waits on the real 2s tick via `waitFor`/`findBy*` with a generous per-test timeout instead.

  describe('AI brief path', () => {
    const AI_DRAFT = {
      title: 'AI-drafted title',
      descriptionHtml: '<p>AI-drafted description</p>',
      tagIds: ['11111111-1111-1111-1111-111111111111'],
      productIds: ['33333333-3333-3333-3333-333333333333'],
      unmatchedTagLabels: ['sandbox refresh'],
      unmatchedProductLabels: [],
    };

    /**
     * start → the AI card → the `upload` step. Extracted so the BAL-254 W1/W2 tests below do not
     * add a fourth and fifth verbatim copy of this preamble (SonarCloud's new-code duplication
     * gate is <3%, and this block was already repeated across the existing AI tests).
     */
    async function openAiUploadStep(): Promise<ReturnType<typeof userEvent.setup>> {
      const user = userEvent.setup();
      renderPanel();
      await user.click(screen.getByRole('button', { name: /upload docs/i }));
      return user;
    }

    /** Attach the stand-in's file and click Generate (no waiting — the caller decides). */
    async function attachAndClickGenerate(user: ReturnType<typeof userEvent.setup>): Promise<void> {
      await user.click(screen.getByRole('button', { name: /attach test file/i }));
      await user.click(screen.getByRole('button', { name: /generate brief/i }));
    }

    /** …and wait for the `review` step's AI banner. */
    async function attachAndGenerate(user: ReturnType<typeof userEvent.setup>): Promise<void> {
      await attachAndClickGenerate(user);
      await screen.findByText(/ai-drafted from your documents/i, {}, { timeout: 4000 });
    }

    it('the Generate brief CTA is disabled with 0 files', async () => {
      const user = userEvent.setup();
      renderPanel();
      await user.click(screen.getByRole('button', { name: /upload docs/i }));
      expect(screen.getByRole('button', { name: /generate brief/i })).toBeDisabled();
      expect(screen.getByText(/add at least one file to generate a brief/i)).toBeInTheDocument();
    });

    it('a successful generate prefills all four fields and lands on review with the AI banner', async () => {
      mockStartBrief.mockResolvedValue({ success: true, parseId: 'parse-1' });
      mockGetBrief.mockResolvedValue({ status: 'succeeded', draft: AI_DRAFT });

      const user = userEvent.setup();
      renderPanel();
      await user.click(screen.getByRole('button', { name: /upload docs/i }));
      await user.click(screen.getByRole('button', { name: /attach test file/i }));
      await user.click(screen.getByRole('button', { name: /generate brief/i }));

      expect(
        await screen.findByText(
          /ai-drafted from your documents — check over everything below/i,
          {},
          { timeout: 4000 }
        )
      ).toBeInTheDocument();
      expect(await screen.findByTestId('rt-viewer')).toHaveTextContent('AI-drafted description');
      expect(screen.getByText(/sandbox refresh/i)).toBeInTheDocument();
    }, 8000);

    it('a failed generate shows the failure banner with Try again / Write it myself instead', async () => {
      mockStartBrief.mockResolvedValue({ success: true, parseId: 'parse-1' });
      mockGetBrief.mockResolvedValue({ status: 'failed', failureReason: 'unreadable' });

      const user = userEvent.setup();
      renderPanel();
      await user.click(screen.getByRole('button', { name: /upload docs/i }));
      await user.click(screen.getByRole('button', { name: /attach test file/i }));
      await user.click(screen.getByRole('button', { name: /generate brief/i }));

      expect(
        await screen.findByText(
          /we couldn't draft a brief from these files/i,
          {},
          { timeout: 4000 }
        )
      ).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
      const writeItMyself = screen.getByRole('button', { name: /write it myself instead/i });
      expect(writeItMyself).toBeInTheDocument();

      await user.click(writeItMyself);
      // Advances to the manual (fields) screen with documents untouched.
      expect(screen.getByLabelText(/project title/i)).toBeInTheDocument();
    }, 8000);

    it('Regenerate without edits runs immediately (no confirm dialog)', async () => {
      mockStartBrief.mockResolvedValue({ success: true, parseId: 'parse-1' });
      mockGetBrief.mockResolvedValue({ status: 'succeeded', draft: AI_DRAFT });

      const user = userEvent.setup();
      renderPanel();
      await user.click(screen.getByRole('button', { name: /upload docs/i }));
      await user.click(screen.getByRole('button', { name: /attach test file/i }));
      await user.click(screen.getByRole('button', { name: /generate brief/i }));
      await screen.findByText(/ai-drafted from your documents/i, {}, { timeout: 4000 });

      mockStartBrief.mockClear();
      await user.click(screen.getByRole('button', { name: /regenerate/i }));

      expect(screen.queryByText(/regenerate the brief\?/i)).not.toBeInTheDocument();
      expect(mockStartBrief).toHaveBeenCalled();
    }, 8000);

    it('Regenerate with edits opens the confirm dialog, and confirming re-runs it', async () => {
      mockStartBrief.mockResolvedValue({ success: true, parseId: 'parse-1' });
      mockGetBrief.mockResolvedValue({ status: 'succeeded', draft: AI_DRAFT });

      const user = userEvent.setup();
      renderPanel();
      await user.click(screen.getByRole('button', { name: /upload docs/i }));
      await user.click(screen.getByRole('button', { name: /attach test file/i }));
      await user.click(screen.getByRole('button', { name: /generate brief/i }));
      await screen.findByText(/ai-drafted from your documents/i, {}, { timeout: 4000 });

      // Edit the title via the shared fields screen, then come back to review.
      await user.click(screen.getAllByRole('button', { name: /^edit$/i })[0] as HTMLElement);
      await user.clear(screen.getByLabelText(/project title/i));
      await user.type(screen.getByLabelText(/project title/i), 'A human-edited title');
      await user.click(screen.getByRole('button', { name: /^review/i }));

      mockStartBrief.mockClear();
      await user.click(screen.getByRole('button', { name: /regenerate/i }));

      expect(screen.getByText(/regenerate the brief\?/i)).toBeInTheDocument();
      expect(mockStartBrief).not.toHaveBeenCalled();

      await user.click(screen.getByRole('button', { name: /^regenerate$/i }));
      expect(mockStartBrief).toHaveBeenCalled();
    }, 8000);

    it('submit sends source: "ai" for a request generated via the AI path', async () => {
      mockStartBrief.mockResolvedValue({ success: true, parseId: 'parse-1' });
      mockGetBrief.mockResolvedValue({ status: 'succeeded', draft: AI_DRAFT });

      const user = userEvent.setup();
      renderPanel();
      await user.click(screen.getByRole('button', { name: /upload docs/i }));
      await user.click(screen.getByRole('button', { name: /attach test file/i }));
      await user.click(screen.getByRole('button', { name: /generate brief/i }));
      await screen.findByText(/ai-drafted from your documents/i, {}, { timeout: 4000 });

      await user.click(screen.getByRole('button', { name: /send to priya/i }));

      await waitFor(() => {
        expect(mockSubmit).toHaveBeenCalledWith(expect.objectContaining({ source: 'ai' }));
      });
    }, 8000);

    // ── F14 — `source` must follow the path the user ACTUALLY took ────────────────────────
    it('⚠ trying the AI path and then writing it by hand submits source: "manual"', async () => {
      const user = userEvent.setup();
      renderPanel();

      // Into the AI path…
      await user.click(screen.getByRole('button', { name: /upload docs/i }));
      expect(
        screen.getByRole('heading', { name: /upload your project docs/i })
      ).toBeInTheDocument();

      // …then back out and write it by hand. `handleSelectManual` used to leave `source` at
      // 'ai', so this draft was recorded as AI-generated and rendered the AI provenance banner.
      await user.click(screen.getByRole('button', { name: /^back$/i }));
      await user.click(screen.getByRole('button', { name: /describe it yourself/i }));
      await user.type(screen.getByLabelText(/project title/i), 'Lead routing rebuild');
      await user.type(
        screen.getByLabelText(/project description/i),
        'Rebuild our lead routing in Flow.'
      );
      await user.click(screen.getByRole('button', { name: /^review/i }));

      expect(screen.queryByText(/ai-drafted from your documents/i)).not.toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: /send to priya/i }));
      await waitFor(() => {
        expect(mockSubmit).toHaveBeenCalledWith(expect.objectContaining({ source: 'manual' }));
      });
    }, 8000);

    // ── F16 — the attached files stay on screen, so the failure copy stays true ────────────
    it('⚠ the uploader stays mounted while generating, and is still there after a failure', async () => {
      mockStartBrief.mockResolvedValue({ success: true, parseId: 'parse-1' });
      mockGetBrief.mockResolvedValue({ status: 'pending' });

      const user = userEvent.setup();
      renderPanel();
      await user.click(screen.getByRole('button', { name: /upload docs/i }));
      await user.click(screen.getByRole('button', { name: /attach test file/i }));
      await user.click(screen.getByRole('button', { name: /generate brief/i }));

      // The wait state is showing…
      expect(
        await screen.findByText(/reading your documents/i, {}, { timeout: 4000 })
      ).toBeInTheDocument();
      // …and the uploader is STILL MOUNTED behind it. Unmounting it dropped its internal row
      // state, so the post-failure screen showed an empty dropzone under a banner that says
      // "Your files are still attached."
      expect(screen.getByRole('button', { name: /attach test file/i })).toBeInTheDocument();

      mockGetBrief.mockResolvedValue({ status: 'failed', failureReason: 'timed_out' });
      expect(
        await screen.findByText(/this is taking longer than expected/i, {}, { timeout: 6000 })
      ).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /attach test file/i })).toBeInTheDocument();
    }, 12000);

    // ── W1 — "Change source documents" must not land on an empty dropzone ─────────────────
    it('⚠ "Change source documents" re-seeds the uploader from the draft, and a new file APPENDS', async () => {
      mockStartBrief.mockResolvedValue({ success: true, parseId: 'parse-1' });
      mockGetBrief.mockResolvedValue({ status: 'succeeded', draft: AI_DRAFT });

      const user = await openAiUploadStep();
      expect(screen.getByText('seeded: 0')).toBeInTheDocument();
      await attachAndGenerate(user);

      // Back to `upload` — which UNMOUNTS and remounts the uploader. It used to come back empty
      // while the draft still held the file, and the next attach REPLACED rather than appended,
      // silently dropping the original from the parse input and the request's attachments.
      await user.click(screen.getByRole('button', { name: /change source documents/i }));
      expect(await screen.findByText('seeded: 1')).toBeInTheDocument();
      expect(screen.getByText('rfp-0.pdf')).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: /attach test file/i }));
      await user.click(screen.getByRole('button', { name: /generate brief/i }));

      await waitFor(() =>
        expect(mockStartBrief).toHaveBeenLastCalledWith({
          documents: [
            expect.objectContaining({ r2Key: 'project-documents/c/u/k0' }),
            expect.objectContaining({ r2Key: 'project-documents/c/u/k1' }),
          ],
        })
      );
    }, 12000);

    it("the manual step's uploader is seeded too (review → Edit keeps the attachments)", async () => {
      mockStartBrief.mockResolvedValue({ success: true, parseId: 'parse-1' });
      mockGetBrief.mockResolvedValue({ status: 'succeeded', draft: AI_DRAFT });

      const user = await openAiUploadStep();
      await attachAndGenerate(user);

      await user.click(screen.getAllByRole('button', { name: /^edit$/i })[0] as HTMLElement);

      expect(await screen.findByText('seeded: 1')).toBeInTheDocument();
    }, 12000);

    // ── W2 — leaving the AI path must abandon the generation ──────────────────────────────
    it('⚠ a LATE success cannot overwrite a hand-typed draft after the user switched to manual', async () => {
      mockStartBrief.mockResolvedValue({ success: true, parseId: 'parse-1' });
      // The first poll HANGS — it is still in flight when the user walks away, and only resolves
      // once the test releases it. That is the exact shape of the race: `isFlowActive` (F5) is
      // still true here, because the drawer is open and the step is not `done`.
      let releasePoll: ((value: unknown) => void) | undefined;
      const pending = new Promise((resolve) => {
        releasePoll = resolve;
      });
      mockGetBrief.mockReturnValueOnce(pending);
      mockGetBrief.mockResolvedValue({ status: 'pending' });

      const user = await openAiUploadStep();
      await attachAndClickGenerate(user);
      await screen.findByText(/reading your documents/i, {}, { timeout: 4000 });
      await waitFor(() => expect(mockGetBrief).toHaveBeenCalled(), { timeout: 4000 });

      // Leave the AI path: back to `start`, then "I'll write it myself".
      await user.click(screen.getByRole('button', { name: /change entry method/i }));
      await user.click(screen.getByRole('button', { name: /describe it yourself/i }));
      await user.type(screen.getByLabelText(/project title/i), 'My own title');

      // …and only NOW does the parse land.
      releasePoll?.({ status: 'succeeded', draft: AI_DRAFT });
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Still on `manual`, still the hand-typed draft, no forced navigation to `review`.
      expect(screen.getByLabelText(/project title/i)).toHaveValue('My own title');
      expect(screen.queryByTestId('rt-viewer')).not.toBeInTheDocument();
      expect(screen.queryByText(/ai-drafted from your documents/i)).not.toBeInTheDocument();
    }, 12000);

    // ── F5 — submit is not live while a regenerate is rewriting the draft ─────────────────
    it('⚠ Submit is disabled during a regenerate', async () => {
      mockStartBrief.mockResolvedValue({ success: true, parseId: 'parse-1' });
      mockGetBrief.mockResolvedValue({ status: 'succeeded', draft: AI_DRAFT });

      const user = userEvent.setup();
      renderPanel();
      await user.click(screen.getByRole('button', { name: /upload docs/i }));
      await user.click(screen.getByRole('button', { name: /attach test file/i }));
      await user.click(screen.getByRole('button', { name: /generate brief/i }));
      await screen.findByText(/ai-drafted from your documents/i, {}, { timeout: 4000 });

      expect(screen.getByRole('button', { name: /send to priya/i })).not.toBeDisabled();

      // Regenerate, and keep the second parse pending.
      mockGetBrief.mockResolvedValue({ status: 'pending' });
      await user.click(screen.getByRole('button', { name: /regenerate/i }));

      // Submitting here used to reach `done`, and the late success then repopulated the
      // just-cleared draft and dragged the user back to `review`.
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /send to priya/i })).toBeDisabled();
      });
      expect(mockSubmit).not.toHaveBeenCalled();
    }, 12000);
  });

  // ── AC#6: contract + mount-mode coverage ──────────────────────────────

  describe('context-free mode (no expertProfileId / expert)', () => {
    const CONTEXT_FREE_PROPS = {
      entryPoint: 'direct' as const,
      projectTaxonomies: TAXONOMIES,
    };

    function renderContextFree(
      overrides: Partial<React.ComponentProps<typeof ProjectRequestPanel>> = {}
    ) {
      return render(
        <ProjectRequestPanel open onClose={vi.fn()} {...CONTEXT_FREE_PROPS} {...overrides} />
      );
    }

    it('omits the expert name from the start heading', () => {
      renderContextFree();
      // The visible start-step <h2> reads "Start a project" with no expert name.
      // (The drawer also renders an sr-only SheetTitle with the same text, so
      // assert there is no expert-bound "…with {name}" variant instead.)
      expect(screen.getAllByRole('heading', { name: /^start a project$/i }).length).toBeGreaterThan(
        0
      );
      expect(
        screen.queryByRole('heading', { name: /start a project with/i })
      ).not.toBeInTheDocument();
    });

    it('defaults routing to Match and renders a neutral Direct card', async () => {
      const user = userEvent.setup();
      renderContextFree();
      await user.click(screen.getByRole('button', { name: /describe it yourself/i }));

      // Match (second radio) is checked by default in context-free mode.
      expect(screen.getByRole('radio', { name: /find me an expert/i })).toHaveAttribute(
        'aria-checked',
        'true'
      );
      // Direct card renders neutral copy (no expert name).
      expect(screen.getByRole('radio', { name: /send to an expert/i })).toBeInTheDocument();
    });

    it('submits sendTo:match with no expertProfileId even if Direct is selected', async () => {
      const user = userEvent.setup();
      renderContextFree();
      await user.click(screen.getByRole('button', { name: /describe it yourself/i }));
      // Select the neutral Direct card — submit must still clamp to match.
      await user.click(screen.getByRole('radio', { name: /send to an expert/i }));
      await user.type(screen.getByLabelText(/project title/i), 'Need help scoping');
      await user.type(
        screen.getByLabelText(/project description/i),
        'We need help scoping a Salesforce build.'
      );
      await user.click(screen.getByRole('button', { name: /^review/i }));
      await user.click(screen.getByRole('button', { name: /find me an expert/i }));

      await waitFor(() => {
        expect(mockSubmit).toHaveBeenCalledWith(
          expect.objectContaining({ sendTo: 'match', title: 'Need help scoping' })
        );
      });
      const payload = mockSubmit.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(payload).not.toHaveProperty('expertProfileId');
    });

    it('autosaves to the entry-scoped key (not an expert key)', async () => {
      const user = userEvent.setup();
      renderContextFree();
      await user.click(screen.getByRole('button', { name: /describe it yourself/i }));
      await user.type(screen.getByLabelText(/project title/i), 'Context-free draft');

      await waitFor(() => {
        const raw = globalThis.localStorage.getItem('balo:project-draft:entry:direct');
        expect(raw).toContain('Context-free draft');
      });
    });

    // A context-free mount fires the funnel events too, with exactly `entry_point` and no
    // `expert_id` key (there is none to carry).
    it('fires PROJECT_DRAWER_OPENED with exactly entry_point and no expert_id', () => {
      renderContextFree();
      expect(mockTrack).toHaveBeenCalledWith(PROJECT_EVENTS.PROJECT_DRAWER_OPENED, {
        entry_point: 'direct',
      });
      const [, payload] = mockTrack.mock.calls.find(
        ([event]) => event === PROJECT_EVENTS.PROJECT_DRAWER_OPENED
      ) as [string, Record<string, unknown>];
      expect(payload).not.toHaveProperty('expert_id');
    });

    it('fires PROJECT_STEP_VIEWED and PROJECT_REQUEST_SUBMITTED without an expert_id key', async () => {
      const user = userEvent.setup();
      renderContextFree();
      await user.click(screen.getByRole('button', { name: /describe it yourself/i }));

      const stepCalls = mockTrack.mock.calls.filter(
        ([event]) => event === PROJECT_EVENTS.PROJECT_STEP_VIEWED
      ) as [string, Record<string, unknown>][];
      const manualStepCall = stepCalls.find(([, payload]) => payload.step === 'manual');
      expect(manualStepCall?.[1]).toEqual({ entry_point: 'direct', step: 'manual' });

      await user.type(screen.getByLabelText(/project title/i), 'Need help scoping');
      await user.type(
        screen.getByLabelText(/project description/i),
        'We need help scoping a Salesforce build.'
      );
      await user.click(screen.getByRole('button', { name: /^review/i }));
      await user.click(screen.getByRole('button', { name: /find me an expert/i }));

      await waitFor(() => expect(mockSubmit).toHaveBeenCalled());
      const submittedCall = mockTrack.mock.calls.find(
        ([event]) => event === PROJECT_EVENTS.PROJECT_REQUEST_SUBMITTED
      ) as [string, Record<string, unknown>];
      expect(submittedCall[1]).not.toHaveProperty('expert_id');
      expect(submittedCall[1]).toMatchObject({ entry_point: 'direct', send_to: 'match' });
    });

    it('self-loads taxonomies on open when projectTaxonomies is omitted', async () => {
      const user = userEvent.setup();
      render(<ProjectRequestPanel open onClose={vi.fn()} entryPoint="direct" />);

      await waitFor(() => expect(mockRefetch).toHaveBeenCalledTimes(1));

      // The self-loaded options render in the picker on the manual step; the
      // browse list is an overlay popup, so open the picker first.
      await user.click(screen.getByRole('button', { name: /describe it yourself/i }));
      await user.click(await screen.findByPlaceholderText('Filter project types…'));
      expect(
        await screen.findByRole('button', { name: 'New Salesforce Implementation' })
      ).toBeInTheDocument();
    });
  });

  // ── BAL-582 (§3b/§3c, D1) — the home mount: hero seed application + the signed-out auth gate ──
  describe('home mount (BAL-582)', () => {
    const SALES_CLOUD_ID = '33333333-3333-3333-3333-333333333333';
    const SERVICE_CLOUD_ID = '44444444-4444-4444-4444-444444444444';
    const HOME_TAXONOMIES: ProjectRequestTaxonomies = {
      tags: TAXONOMIES.tags,
      products: {
        groups: [
          {
            id: 'c1',
            name: 'Core Clouds',
            items: [
              { id: SALES_CLOUD_ID, name: 'Sales Cloud' },
              { id: SERVICE_CLOUD_ID, name: 'Service Cloud' },
            ],
          },
        ],
      },
    };
    const HOME_KEY = 'balo:project-draft:entry:home';
    const AI_BRIEF_WITH_UNMATCHED = {
      title: 'AI-drafted title',
      descriptionHtml: '<p>AI-drafted description</p>',
      tagIds: [],
      productIds: [],
      unmatchedTagLabels: ['sandbox refresh'],
      unmatchedProductLabels: [],
    };

    function renderHome(overrides: Partial<React.ComponentProps<typeof ProjectRequestPanel>> = {}) {
      return render(
        <ProjectRequestPanel
          open
          onClose={vi.fn()}
          entryPoint="home"
          projectTaxonomies={HOME_TAXONOMIES}
          {...overrides}
        />
      );
    }

    it('fires DRAWER_OPENED once with entry_point home, and STEP_VIEWED once for manual (never start)', () => {
      renderHome({ seed: { title: 'x' } });

      const openCalls = mockTrack.mock.calls.filter(
        ([event]) => event === PROJECT_EVENTS.PROJECT_DRAWER_OPENED
      );
      expect(openCalls).toHaveLength(1);
      expect(openCalls[0]?.[1]).toEqual({ entry_point: 'home' });

      const stepCalls = mockTrack.mock.calls.filter(
        ([event]) => event === PROJECT_EVENTS.PROJECT_STEP_VIEWED
      ) as [string, Record<string, unknown>][];
      expect(stepCalls).toHaveLength(1);
      expect(stepCalls[0]?.[1]).toEqual({ entry_point: 'home', step: 'manual' });
      expect(stepCalls.some(([, payload]) => payload.step === 'start')).toBe(false);
    });

    describe('seed application (§3b/§3c)', () => {
      it('a title seed opens at manual, filled, with Match copy', () => {
        renderHome({ seed: { title: 'Migrate us from HubSpot' } });
        expect(screen.getByLabelText(/project title/i)).toHaveValue('Migrate us from HubSpot');
        expect(screen.getByRole('radio', { name: /find me an expert/i })).toHaveAttribute(
          'aria-checked',
          'true'
        );
      });

      it('a description seed fills the editor', () => {
        renderHome({ seed: { descriptionText: 'We need a Data Cloud rollout.' } });
        expect(screen.getByLabelText(/project description/i)).toHaveValue(
          'We need a Data Cloud rollout.'
        );
      });

      it('a products-only seed opens at manual', () => {
        renderHome({ seed: { productIds: [SALES_CLOUD_ID] } });
        expect(screen.getByLabelText(/project title/i)).toBeInTheDocument();
      });

      it('no seed opens at start', () => {
        renderHome();
        expect(
          screen.getAllByRole('heading', { name: /^start a project$/i }).length
        ).toBeGreaterThan(0);
      });

      // ── A NEW search starts a fresh request; an in-drawer notice offers Undo ──────────────
      const STALE_HOME_DRAFT = {
        title: 'Old project title',
        descriptionHtml: '<p>An older, unrelated brief.</p>',
        productIds: [SALES_CLOUD_ID],
        documents: [
          {
            r2Key: 'project-documents/c/u/old',
            fileName: 'old-rfp.pdf',
            contentType: 'application/pdf',
            sizeBytes: 2048,
          },
        ],
        timeline: '6 weeks',
      };

      function storeDraft(draft: Record<string, unknown>): void {
        globalThis.localStorage.setItem(
          HOME_KEY,
          JSON.stringify({ ...draft, savedAt: Date.now() })
        );
      }

      /** The home mount, for a `rerender` close → reopen with a (possibly different) seed. */
      function homePanel(open: boolean, seed?: ProjectRequestSeed): React.JSX.Element {
        return (
          <ProjectRequestPanel
            open={open}
            onClose={vi.fn()}
            entryPoint="home"
            projectTaxonomies={HOME_TAXONOMIES}
            seed={seed}
          />
        );
      }

      const titleField = (): HTMLElement => screen.getByLabelText(/project title/i);
      const briefField = (): HTMLElement => screen.getByLabelText(/project description/i);
      const notice = (): HTMLElement | null => screen.queryByText(NEW_REQUEST_NOTICE_COPY.message);
      const undoButton = (): HTMLElement =>
        screen.getByRole('button', { name: NEW_REQUEST_NOTICE_COPY.undoLabel });

      it('a NEW search starts a fresh request — nothing from the earlier draft carries over', () => {
        storeDraft(STALE_HOME_DRAFT);
        renderHome({ seed: { title: 'Migrate from Tableau' } });

        expect(titleField()).toHaveValue('Migrate from Tableau');
        expect(briefField()).toHaveValue('');
        expect(screen.getByLabelText(/timeline/i)).toHaveValue('');
        expect(screen.getByText('seeded: 0')).toBeInTheDocument();
        expect(screen.queryByText('old-rfp.pdf')).not.toBeInTheDocument();
        expect(screen.queryByText('Sales Cloud')).not.toBeInTheDocument();
        expect(notice()).toBeInTheDocument();
        expect(toast).not.toHaveBeenCalled();
      });

      it('Undo in the drawer restores the earlier draft whole — its files in a remounted uploader too', async () => {
        const user = userEvent.setup();
        storeDraft(STALE_HOME_DRAFT);
        renderHome({ seed: { title: 'Migrate from Tableau' } });

        await user.click(undoButton());

        expect(titleField()).toHaveValue('Old project title');
        expect(briefField()).toHaveValue('An older, unrelated brief.');
        expect(screen.getByLabelText(/timeline/i)).toHaveValue('6 weeks');
        expect(screen.getByText('seeded: 1')).toBeInTheDocument();
        expect(screen.getByText('old-rfp.pdf')).toBeInTheDocument();
        expect(screen.getByText('Sales Cloud')).toBeInTheDocument();
        expect(notice()).not.toBeInTheDocument();
      });

      it('after an Undo, reopening with the same search continues the restored draft', async () => {
        const user = userEvent.setup();
        storeDraft(STALE_HOME_DRAFT);
        const { rerender } = renderHome({ seed: { title: 'Migrate from Tableau' } });
        await user.click(undoButton());

        rerender(homePanel(false, { title: 'Migrate from Tableau' }));
        rerender(homePanel(true, { title: 'Migrate from Tableau' }));

        expect(titleField()).toHaveValue('Old project title');
        expect(notice()).not.toBeInTheDocument();
      });

      it('Dismiss hides the notice and keeps the fresh request', async () => {
        const user = userEvent.setup();
        storeDraft(STALE_HOME_DRAFT);
        renderHome({ seed: { title: 'Migrate from Tableau' } });

        await user.click(
          screen.getByRole('button', { name: NEW_REQUEST_NOTICE_COPY.dismissLabel })
        );

        expect(notice()).not.toBeInTheDocument();
        expect(titleField()).toHaveValue('Migrate from Tableau');
      });

      it('the Undo offer lapses once the visitor adds to the fresh request', async () => {
        const user = userEvent.setup();
        storeDraft(STALE_HOME_DRAFT);
        renderHome({ seed: { title: 'Migrate from Tableau' } });

        await user.type(briefField(), 'Dashboards first.');

        expect(notice()).not.toBeInTheDocument();
      });

      it('the Undo offer lapses when the drawer closes', () => {
        storeDraft(STALE_HOME_DRAFT);
        const { rerender } = renderHome({ seed: { title: 'Migrate from Tableau' } });
        expect(notice()).toBeInTheDocument();

        rerender(homePanel(false, { title: 'Migrate from Tableau' }));
        rerender(homePanel(true, { title: 'Migrate from Tableau' }));

        expect(notice()).not.toBeInTheDocument();
        expect(titleField()).toHaveValue('Migrate from Tableau');
      });

      it('a LONG new search (description seed) leaves no stale title behind', () => {
        storeDraft(STALE_HOME_DRAFT);
        const brief = `We need to move every Tableau dashboard to CRM Analytics ${'x'.repeat(80)}`;
        renderHome({ seed: { descriptionText: brief } });

        expect(titleField()).toHaveValue('');
        expect(briefField()).toHaveValue(brief);
      });

      it('the search that started a draft continues it on a later visit, even after its title was edited', () => {
        storeDraft({
          ...STALE_HOME_DRAFT,
          title: 'Edited in the panel',
          seededFrom: { text: 'Migrate CPQ', productIds: [] },
        });
        renderHome({ seed: { title: 'Migrate CPQ' } });

        expect(titleField()).toHaveValue('Edited in the panel');
        expect(briefField()).toHaveValue('An older, unrelated brief.');
        expect(screen.getByText('old-rfp.pdf')).toBeInTheDocument();
        expect(notice()).not.toBeInTheDocument();
      });

      it('a draft no search started, already titled with this search, continues', () => {
        storeDraft(STALE_HOME_DRAFT);
        renderHome({ seed: { title: 'Old project title' } });

        expect(briefField()).toHaveValue('An older, unrelated brief.');
        expect(notice()).not.toBeInTheDocument();
      });

      it('continuing a draft no search started ADOPTS the search — a later title edit then survives', async () => {
        const user = userEvent.setup();
        storeDraft(STALE_HOME_DRAFT);
        const { rerender } = renderHome({ seed: { title: 'Old project title' } });
        await user.clear(titleField());
        await user.type(titleField(), 'Renamed in the panel');

        rerender(homePanel(false, { title: 'Old project title' }));
        rerender(homePanel(true, { title: 'Old project title' }));

        expect(titleField()).toHaveValue('Renamed in the panel');
        expect(briefField()).toHaveValue('An older, unrelated brief.');
      });

      it('a new search over an EMPTY draft shows no notice — there is nothing to undo', () => {
        renderHome({ seed: { title: 'First ever search' } });
        expect(titleField()).toHaveValue('First ever search');
        expect(notice()).not.toBeInTheDocument();
      });

      it('refining a search whose draft the visitor never touched shows no notice', () => {
        storeDraft({ title: 'Migrate CPQ', seededFrom: { text: 'Migrate CPQ', productIds: [] } });
        renderHome({ seed: { title: 'Migrate CPQ to Revenue Cloud' } });

        expect(titleField()).toHaveValue('Migrate CPQ to Revenue Cloud');
        expect(notice()).not.toBeInTheDocument();
      });

      it("a new search's products are the chips' alone, never the earlier draft's", () => {
        storeDraft(STALE_HOME_DRAFT);
        renderHome({ seed: { title: 'New', productIds: [SERVICE_CLOUD_ID, 'stale-id'] } });

        expect(screen.getByText('Service Cloud')).toBeInTheDocument();
        expect(screen.queryByText('Sales Cloud')).not.toBeInTheDocument();
        expect(screen.getByText('1 selected')).toBeInTheDocument();
      });

      it('the same search with the SAME chips never re-adds a product removed in the panel', () => {
        storeDraft({
          title: 'Migrate CPQ',
          productIds: [],
          seededFrom: { text: 'Migrate CPQ', productIds: [SERVICE_CLOUD_ID] },
        });
        renderHome({ seed: { title: 'Migrate CPQ', productIds: [SERVICE_CLOUD_ID] } });

        expect(screen.queryByText('Service Cloud')).not.toBeInTheDocument();
      });

      it('the same search with CHANGED chips unions the new chips in', () => {
        storeDraft({
          title: 'Migrate CPQ',
          productIds: [SALES_CLOUD_ID],
          seededFrom: { text: 'Migrate CPQ', productIds: [SALES_CLOUD_ID] },
        });
        renderHome({
          seed: { title: 'Migrate CPQ', productIds: [SALES_CLOUD_ID, SERVICE_CLOUD_ID] },
        });

        expect(screen.getByText('Sales Cloud')).toBeInTheDocument();
        expect(screen.getByText('Service Cloud')).toBeInTheDocument();
        expect(screen.getByText('2 selected')).toBeInTheDocument();
      });

      it('chips with an EMPTY search continue the draft: union, filtered to live ids', () => {
        storeDraft({ title: 'Kept', productIds: [SALES_CLOUD_ID] });
        renderHome({ seed: { productIds: [SERVICE_CLOUD_ID, 'stale-id'] } });

        expect(titleField()).toHaveValue('Kept');
        expect(notice()).not.toBeInTheDocument();
        expect(screen.getByText('Sales Cloud')).toBeInTheDocument();
        expect(screen.getByText('Service Cloud')).toBeInTheDocument();
        expect(screen.getByText('2 selected')).toBeInTheDocument();
      });

      it('the self-load path applies seeded products after mockRefetch resolves', async () => {
        mockRefetch.mockResolvedValue(HOME_TAXONOMIES);
        render(
          <ProjectRequestPanel
            open
            onClose={vi.fn()}
            entryPoint="home"
            seed={{ productIds: [SERVICE_CLOUD_ID] }}
          />
        );

        await waitFor(() => expect(mockRefetch).toHaveBeenCalled());
        expect(await screen.findByText('Service Cloud')).toBeInTheDocument();
      });

      it('a reopen with the SAME search keeps panel edits; a CHANGED search starts fresh', async () => {
        const user = userEvent.setup();
        const { rerender } = renderHome({ seed: { title: 'First title' } });
        expect(titleField()).toHaveValue('First title');

        await user.clear(titleField());
        await user.type(titleField(), 'Edited in the panel');

        rerender(homePanel(false, { title: 'First title' }));
        rerender(homePanel(true, { title: 'First title' }));
        expect(titleField()).toHaveValue('Edited in the panel');
        expect(notice()).not.toBeInTheDocument();

        rerender(homePanel(false, { title: 'First title' }));
        rerender(homePanel(true, { title: 'Second title' }));
        expect(titleField()).toHaveValue('Second title');
        expect(notice()).toBeInTheDocument();
      });

      it('a same-search reopen refills a brief the visitor cleared (a cleared editor reads empty)', async () => {
        const user = userEvent.setup();
        const long = `Move every Tableau dashboard to CRM Analytics ${'y'.repeat(90)}`;
        const { rerender } = renderHome({ seed: { descriptionText: long } });
        await user.clear(briefField());
        expect(briefField()).toHaveValue('');

        rerender(homePanel(false, { descriptionText: long }));
        rerender(homePanel(true, { descriptionText: long }));

        expect(briefField()).toHaveValue(long);
      });

      it('picking chips with an EMPTY search is not a new search — the same search still continues', async () => {
        const user = userEvent.setup();
        const { rerender } = renderHome({ seed: { title: 'Same search' } });
        await user.clear(titleField());
        await user.type(titleField(), 'Edited in the panel');

        rerender(homePanel(false, { title: 'Same search' }));
        rerender(homePanel(true, { productIds: [SERVICE_CLOUD_ID] }));
        rerender(homePanel(false, { productIds: [SERVICE_CLOUD_ID] }));
        rerender(homePanel(true, { title: 'Same search' }));

        expect(titleField()).toHaveValue('Edited in the panel');
        expect(notice()).not.toBeInTheDocument();
      });

      it("an Undo before the taxonomy self-loads keeps the earlier draft's products", async () => {
        const user = userEvent.setup();
        storeDraft(STALE_HOME_DRAFT);
        let resolveTaxonomies: (value: ProjectRequestTaxonomies) => void = () => {};
        mockRefetch.mockReturnValue(
          new Promise<ProjectRequestTaxonomies>((resolve) => {
            resolveTaxonomies = resolve;
          })
        );
        render(
          <ProjectRequestPanel
            open
            onClose={vi.fn()}
            entryPoint="home"
            seed={{ title: 'New', productIds: [SERVICE_CLOUD_ID] }}
          />
        );

        await user.click(undoButton());
        await act(async () => {
          resolveTaxonomies(HOME_TAXONOMIES);
        });

        expect(await screen.findByText('Sales Cloud')).toBeInTheDocument();
        expect(screen.queryByText('Service Cloud')).not.toBeInTheDocument();
      });

      it("a late upload from the REPLACED draft's uploader never lands in the fresh request", async () => {
        const stored = (): { title?: string; documents?: MockDoc[] } =>
          JSON.parse(globalThis.localStorage.getItem(HOME_KEY) ?? '{}');
        const late = {
          r2Key: 'project-documents/c/u/late',
          fileName: 'late.pdf',
          contentType: 'application/pdf',
          sizeBytes: 1,
        };
        // An upload starts on this open, and the drawer closes before it finishes: the unmounted
        // uploader keeps its last-rendered `onDocumentsChange`.
        const { rerender } = renderHome({ seed: { title: 'First search' } });
        const replaced = mockUploaderHandlers.at(-1);
        rerender(homePanel(false, { title: 'First search' }));

        // A new search starts a fresh request; then the orphaned upload finishes.
        rerender(homePanel(true, { title: 'Second search' }));
        const current = mockUploaderHandlers.at(-1);
        expect(current).not.toBe(replaced);
        act(() => replaced?.([late]));
        await waitFor(() => expect(stored().title).toBe('Second search'));
        expect(stored().documents).toEqual([]);

        // The fresh request's own uploader still publishes normally.
        act(() => current?.([late]));
        await waitFor(() => expect(stored().documents).toEqual([late]));
      });

      it("a fresh request never shows the earlier AI brief's unmatched-label hints or AI edit events", async () => {
        mockStartBrief.mockResolvedValue({ success: true, parseId: 'parse-1' });
        mockGetBrief.mockResolvedValue({ status: 'succeeded', draft: AI_BRIEF_WITH_UNMATCHED });
        const user = userEvent.setup();
        const { rerender } = renderHome();
        await user.click(screen.getByRole('button', { name: /upload docs/i }));
        await user.click(screen.getByRole('button', { name: /attach test file/i }));
        await user.click(screen.getByRole('button', { name: /generate brief/i }));
        expect(
          await screen.findByText(/sandbox refresh/i, {}, { timeout: 4000 })
        ).toBeInTheDocument();

        rerender(homePanel(false));
        rerender(homePanel(true, { title: 'Tableau migration' }));
        expect(mockTrack).not.toHaveBeenCalledWith(
          PROJECT_EVENTS.PROJECT_AI_FIELDS_EDITED,
          expect.anything()
        );
        await user.type(briefField(), 'Rebuild our lead routing in Flow.');
        await user.click(screen.getByRole('button', { name: /^review/i }));
        expect(await screen.findByText('Tableau migration')).toBeInTheDocument();
        expect(screen.queryByText(/sandbox refresh/i)).not.toBeInTheDocument();
      }, 12000);

      it('Undo brings back the earlier AI brief with its unmatched-label hints', async () => {
        mockStartBrief.mockResolvedValue({ success: true, parseId: 'parse-1' });
        mockGetBrief.mockResolvedValue({ status: 'succeeded', draft: AI_BRIEF_WITH_UNMATCHED });
        const user = userEvent.setup();
        const { rerender } = renderHome();
        await user.click(screen.getByRole('button', { name: /upload docs/i }));
        await user.click(screen.getByRole('button', { name: /attach test file/i }));
        await user.click(screen.getByRole('button', { name: /generate brief/i }));
        await screen.findByText(/sandbox refresh/i, {}, { timeout: 4000 });

        rerender(homePanel(false));
        rerender(homePanel(true, { title: 'Tableau migration' }));
        await user.click(undoButton());
        await user.click(screen.getByRole('button', { name: /^review/i }));

        expect(await screen.findByText(/sandbox refresh/i)).toBeInTheDocument();
      }, 12000);

      it('resumeDraft opens at manual for a manual-source draft', () => {
        globalThis.localStorage.setItem(
          HOME_KEY,
          JSON.stringify({ title: 'Resumed', source: 'manual', savedAt: Date.now() })
        );
        renderHome({ resumeDraft: true });
        expect(screen.getByLabelText(/project title/i)).toHaveValue('Resumed');
      });

      it("resumeDraft opens at upload for an 'ai'-source draft (gated there)", () => {
        globalThis.localStorage.setItem(
          HOME_KEY,
          JSON.stringify({ title: 'Resumed AI', source: 'ai', savedAt: Date.now() })
        );
        renderHome({ resumeDraft: true });
        expect(
          screen.getByRole('heading', { name: /upload your project docs/i })
        ).toBeInTheDocument();
      });

      it('Back from a seeded manual step still reaches the AI card', async () => {
        const user = userEvent.setup();
        renderHome({ seed: { title: 'Seeded' } });
        await user.click(screen.getByRole('button', { name: /change entry method/i }));
        expect(screen.getByRole('button', { name: /upload docs/i })).toBeInTheDocument();
      });
    });

    describe('auth gate (D1)', () => {
      it('Submit calls onAuthRequired and never mockSubmit when signed out', async () => {
        const onAuthRequired = vi.fn();
        const user = userEvent.setup();
        renderHome({ onAuthRequired });
        await user.click(screen.getByRole('button', { name: /describe it yourself/i }));
        await user.type(screen.getByLabelText(/project title/i), 'Need scoping');
        await user.type(
          screen.getByLabelText(/project description/i),
          'We need help scoping this work.'
        );
        await user.click(screen.getByRole('button', { name: /^review/i }));
        await user.click(screen.getByRole('button', { name: /find me an expert/i }));

        expect(onAuthRequired).toHaveBeenCalledTimes(1);
        expect(mockSubmit).not.toHaveBeenCalled();
      });

      it('attaching a document (manual step) calls onAuthRequired instead of publishing one', async () => {
        const onAuthRequired = vi.fn();
        const user = userEvent.setup();
        renderHome({ onAuthRequired });
        await user.click(screen.getByRole('button', { name: /describe it yourself/i }));
        await user.click(screen.getByRole('button', { name: /attach test file/i }));

        expect(onAuthRequired).toHaveBeenCalledTimes(1);
      });

      it('attaching a document (upload/AI step) calls onAuthRequired instead of publishing one', async () => {
        const onAuthRequired = vi.fn();
        const user = userEvent.setup();
        renderHome({ onAuthRequired });
        await user.click(screen.getByRole('button', { name: /upload docs/i }));
        await user.click(screen.getByRole('button', { name: /attach test file/i }));

        expect(onAuthRequired).toHaveBeenCalledTimes(1);
      });

      it('without onAuthRequired, Submit acts normally (unchanged behaviour)', async () => {
        const user = userEvent.setup();
        renderHome();
        await user.click(screen.getByRole('button', { name: /describe it yourself/i }));
        await user.type(screen.getByLabelText(/project title/i), 'Need scoping');
        await user.type(
          screen.getByLabelText(/project description/i),
          'We need help scoping this work.'
        );
        await user.click(screen.getByRole('button', { name: /^review/i }));
        await user.click(screen.getByRole('button', { name: /find me an expert/i }));

        await waitFor(() => expect(mockSubmit).toHaveBeenCalled());
      });

      it('prop flip (in-place sign-in): the draft + step survive, and Submit then acts', async () => {
        const onAuthRequired = vi.fn();
        const user = userEvent.setup();
        const { rerender } = renderHome({ onAuthRequired });
        await user.click(screen.getByRole('button', { name: /describe it yourself/i }));
        await user.type(screen.getByLabelText(/project title/i), 'Need scoping');
        await user.type(
          screen.getByLabelText(/project description/i),
          'We need help scoping this work.'
        );
        await user.click(screen.getByRole('button', { name: /^review/i }));
        await screen.findByTestId('rt-viewer');

        rerender(
          <ProjectRequestPanel
            open
            onClose={vi.fn()}
            entryPoint="home"
            projectTaxonomies={HOME_TAXONOMIES}
            onAuthRequired={undefined}
          />
        );

        // Still on review, draft untouched by the prop flip.
        expect(screen.getByTestId('rt-viewer')).toBeInTheDocument();
        expect(onAuthRequired).not.toHaveBeenCalled();

        await user.click(screen.getByRole('button', { name: /find me an expert/i }));

        await waitFor(() => expect(mockSubmit).toHaveBeenCalled());
      });
    });
  });

  describe('onClose contract', () => {
    it('invokes onClose from the header close button', async () => {
      const onClose = vi.fn();
      const user = userEvent.setup();
      render(<ProjectRequestPanel open onClose={onClose} {...BASE_PROPS} />);

      await user.click(screen.getByRole('button', { name: /close/i }));
      expect(onClose).toHaveBeenCalled();
    });

    it('invokes onClose from the done "Done" button', async () => {
      const onClose = vi.fn();
      const user = userEvent.setup();
      render(<ProjectRequestPanel open onClose={onClose} {...BASE_PROPS} />);
      await user.click(screen.getByRole('button', { name: /describe it yourself/i }));
      await user.type(screen.getByLabelText(/project title/i), 'Lead routing rebuild');
      await user.type(
        screen.getByLabelText(/project description/i),
        'Rebuild our lead routing in Flow.'
      );
      await user.click(screen.getByRole('button', { name: /^review/i }));
      await user.click(screen.getByRole('button', { name: /send to priya/i }));

      const doneButton = await screen.findByRole('button', { name: /^done$/i });
      await user.click(doneButton);
      expect(onClose).toHaveBeenCalled();
    });
  });
});
