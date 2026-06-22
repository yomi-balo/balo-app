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

  it('renders the AI card disabled and does not transition on click', async () => {
    const user = userEvent.setup();
    renderPanel();
    const aiCard = screen.getByRole('button', { name: /upload docs/i });
    expect(aiCard).toBeDisabled();
    expect(screen.getByText('AI')).toBeInTheDocument();
    expect(screen.getByText('Coming soon')).toBeInTheDocument();

    await user.click(aiCard);
    expect(
      screen.getByRole('heading', { name: /start a project with priya sharma/i })
    ).toBeInTheDocument();
    expect(mockTrack).not.toHaveBeenCalledWith(
      PROJECT_EVENTS.PROJECT_ENTRY_SELECTED,
      expect.anything()
    );
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
