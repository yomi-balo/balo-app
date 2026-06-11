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

// Mock the Server Action modules the drawer / sub-components import.
const { mockSubmit } = vi.hoisted(() => ({ mockSubmit: vi.fn() }));
vi.mock('../../_actions/submit-project-request', () => ({
  submitProjectRequestAction: mockSubmit,
}));
vi.mock('../../_actions/refetch-project-taxonomies', () => ({
  refetchProjectTaxonomiesAction: vi.fn(),
}));
vi.mock('../../_actions/request-project-document-upload', () => ({
  requestProjectDocumentUploadAction: vi.fn(),
}));
vi.mock('../../_actions/confirm-project-document-upload', () => ({
  confirmProjectDocumentUploadAction: vi.fn(),
}));
vi.mock('../../_actions/remove-project-document', () => ({
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

import { ProjectDrawer } from './project-drawer';

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

const BASE_PROPS = {
  expertProfileId: '99999999-9999-9999-9999-999999999999',
  expertName: 'Priya Sharma',
  expertFirstName: 'Priya',
  expertInitials: 'PS',
  expertAvatarKey: null,
  projectTaxonomies: TAXONOMIES,
} as const;

function renderDrawer(overrides: Partial<React.ComponentProps<typeof ProjectDrawer>> = {}) {
  return render(<ProjectDrawer open onOpenChange={vi.fn()} {...BASE_PROPS} {...overrides} />);
}

/** start → manual → fill required fields → review. */
async function advanceToReview(): Promise<ReturnType<typeof userEvent.setup>> {
  const user = userEvent.setup();
  renderDrawer();
  await user.click(screen.getByRole('button', { name: /describe it yourself/i }));
  await user.type(screen.getByLabelText(/project title/i), 'Lead routing rebuild');
  await user.type(
    screen.getByLabelText(/project description/i),
    'Rebuild our lead routing in Flow.'
  );
  await user.click(screen.getByRole('button', { name: /^review/i }));
  return user;
}

describe('ProjectDrawer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    mockSubmit.mockResolvedValue({ success: true, projectRequestId: 'pr-1' });
  });

  it('opens to the start step with both path cards', () => {
    renderDrawer();
    expect(
      screen.getByRole('heading', { name: /start a project with priya sharma/i })
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /describe it yourself/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /upload docs/i })).toBeInTheDocument();
  });

  it('renders the AI card disabled and does not transition on click', async () => {
    const user = userEvent.setup();
    renderDrawer();
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
    renderDrawer();
    await user.click(screen.getByRole('button', { name: /describe it yourself/i }));

    expect(screen.getByLabelText(/project title/i)).toBeInTheDocument();
    expect(mockTrack).toHaveBeenCalledWith(PROJECT_EVENTS.PROJECT_ENTRY_SELECTED, {
      expert_id: BASE_PROPS.expertProfileId,
      method: 'manual',
    });
  });

  it('defaults routing to Direct and shows the Direct FormDescription', async () => {
    const user = userEvent.setup();
    renderDrawer();
    await user.click(screen.getByRole('button', { name: /describe it yourself/i }));

    const radios = screen.getAllByRole('radio');
    // Direct card (first) is checked by default.
    expect(radios[0]).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText(/priya receives this brief directly/i)).toBeInTheDocument();
    // Submit-related copy will be "Send to Priya".
  });

  it('switches all routing-aware copy when Match is selected', async () => {
    const user = userEvent.setup();
    renderDrawer();
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
    renderDrawer();
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
    renderDrawer();
    await user.click(screen.getByRole('button', { name: /describe it yourself/i }));
    await user.type(screen.getByLabelText(/project title/i), 'Lead routing rebuild');
    await user.type(
      screen.getByLabelText(/project description/i),
      'Rebuild our lead routing in Flow.'
    );
    // Tags + products live on the manual step.
    await user.click(screen.getByRole('button', { name: 'New Salesforce Implementation' }));
    await user.click(screen.getByRole('button', { name: 'Sales Cloud' }));
    await user.click(screen.getByRole('button', { name: /^review/i }));

    await user.click(screen.getByRole('button', { name: /send to priya/i }));

    await waitFor(() => {
      expect(mockSubmit).toHaveBeenCalledWith(
        expect.objectContaining({
          sendTo: 'direct',
          expertProfileId: BASE_PROPS.expertProfileId,
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
      expert_id: BASE_PROPS.expertProfileId,
      send_to: 'direct',
      tag_count: 1,
      product_count: 1,
      document_count: 0,
      method: 'manual',
    });
    expect(await screen.findByText(/request sent to priya/i)).toBeInTheDocument();
    expect(mockToast.success).toHaveBeenCalledWith('Request sent', expect.objectContaining({}));
  });

  it('captures budget (whole dollars → cents) and timeline into the submit payload', async () => {
    const user = userEvent.setup();
    renderDrawer();
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
    renderDrawer();
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
    renderDrawer();
    await user.click(screen.getByRole('button', { name: /describe it yourself/i }));
    await user.type(screen.getByLabelText(/min budget/i), '9000');
    await user.type(screen.getByLabelText(/max budget/i), '1000');

    expect(await screen.findByRole('alert')).toHaveTextContent(/at least the minimum/i);
  });

  it('coerces budget input to whole-dollar cents (tolerates commas, ignores decimals)', async () => {
    const user = userEvent.setup();
    renderDrawer();
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
    renderDrawer();
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
    renderDrawer();
    const openCalls = mockTrack.mock.calls.filter(
      ([event]) => event === PROJECT_EVENTS.PROJECT_DRAWER_OPENED
    );
    expect(openCalls).toHaveLength(1);
    expect(openCalls[0]?.[1]).toEqual({ expert_id: BASE_PROPS.expertProfileId });
  });

  it('does not fire PROJECT_DRAWER_OPENED when closed', () => {
    render(<ProjectDrawer open={false} onOpenChange={vi.fn()} {...BASE_PROPS} />);
    expect(mockTrack).not.toHaveBeenCalledWith(
      PROJECT_EVENTS.PROJECT_DRAWER_OPENED,
      expect.anything()
    );
  });

  it('persists the draft to localStorage and hydrates it on remount', async () => {
    const user = userEvent.setup();
    const { unmount } = renderDrawer();
    await user.click(screen.getByRole('button', { name: /describe it yourself/i }));
    await user.type(screen.getByLabelText(/project title/i), 'Persisted title');

    await waitFor(() => {
      const raw = window.localStorage.getItem(`balo:project-draft:${BASE_PROPS.expertProfileId}`);
      expect(raw).toContain('Persisted title');
    });

    unmount();
    renderDrawer();
    await user.click(screen.getByRole('button', { name: /describe it yourself/i }));
    expect(screen.getByLabelText(/project title/i)).toHaveValue('Persisted title');
  });

  it('clears the draft from localStorage on successful submit', async () => {
    const user = await advanceToReview();
    await waitFor(() => {
      expect(
        window.localStorage.getItem(`balo:project-draft:${BASE_PROPS.expertProfileId}`)
      ).not.toBeNull();
    });

    await user.click(screen.getByRole('button', { name: /send to priya/i }));

    await waitFor(() => {
      expect(
        window.localStorage.getItem(`balo:project-draft:${BASE_PROPS.expertProfileId}`)
      ).toBeNull();
    });
  });

  it('has no accessibility violations', async () => {
    const { baseElement } = renderDrawer();
    expect(await axe(baseElement)).toHaveNoViolations();
  });
});
