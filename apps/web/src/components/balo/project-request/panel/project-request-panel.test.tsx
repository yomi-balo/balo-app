import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@/test/utils';
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
vi.mock('@/components/balo/document-uploader', () => ({
  DocumentUploader: ({
    initialDocuments,
    onDocumentsChange,
  }: {
    initialDocuments?: readonly MockDoc[];
    onDocumentsChange: (docs: MockDoc[]) => void;
  }) => {
    const seeded = initialDocuments ?? [];
    return (
      <div>
        <p>{`seeded: ${seeded.length}`}</p>
        {seeded.map((doc) => (
          <p key={doc.r2Key}>{doc.fileName}</p>
        ))}
        <button
          type="button"
          onClick={() =>
            onDocumentsChange([
              ...seeded,
              {
                r2Key: `project-documents/c/u/k${seeded.length}`,
                fileName: `rfp-${seeded.length}.pdf`,
                contentType: 'application/pdf',
                sizeBytes: 1024,
              },
            ])
          }
        >
          Attach test file
        </button>
      </div>
    );
  },
}));

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
    expect(openCalls[0]?.[1]).toEqual({ expert_id: EXPERT_PROFILE_ID });
  });

  it('does not fire PROJECT_DRAWER_OPENED when closed', () => {
    render(<ProjectRequestPanel open={false} onClose={vi.fn()} {...BASE_PROPS} />);
    expect(mockTrack).not.toHaveBeenCalledWith(
      PROJECT_EVENTS.PROJECT_DRAWER_OPENED,
      expect.anything()
    );
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

    it('does not fire the expert-keyed open analytics event', () => {
      renderContextFree();
      expect(mockTrack).not.toHaveBeenCalledWith(
        PROJECT_EVENTS.PROJECT_DRAWER_OPENED,
        expect.anything()
      );
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
