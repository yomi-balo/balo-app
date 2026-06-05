import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { track, PROJECT_EVENTS } from '@/lib/analytics';
import { toast } from 'sonner';

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));

// useIsMobile reads window.matchMedia (absent in jsdom). The codebase pattern is
// to mock the hook directly — default to desktop (right-side panel).
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }));

// Mock the Server Action module — the drawer calls it on submit.
const { mockSubmit } = vi.hoisted(() => ({ mockSubmit: vi.fn() }));
vi.mock('../../_actions/submit-project-request', () => ({
  submitProjectRequestAction: mockSubmit,
}));

import { ProjectDrawer } from './project-drawer';

const mockTrack = vi.mocked(track);
const mockToast = vi.mocked(toast);

const BASE_PROPS = {
  expertProfileId: 'expert-profile-1',
  expertName: 'Priya Sharma',
  expertFirstName: 'Priya',
} as const;

function renderDrawer(overrides: Partial<React.ComponentProps<typeof ProjectDrawer>> = {}) {
  return render(<ProjectDrawer open onOpenChange={vi.fn()} {...BASE_PROPS} {...overrides} />);
}

/** Renders, then walks start → manual → fills required fields → review. */
async function advanceToReview(): Promise<ReturnType<typeof userEvent.setup>> {
  const user = userEvent.setup();
  renderDrawer();
  await user.click(screen.getByRole('button', { name: /describe it yourself/i }));
  await user.type(screen.getByLabelText(/project title/i), '  Lead routing rebuild  ');
  await user.type(screen.getByLabelText(/what do you need/i), '  Rebuild lead routing in Flow.  ');
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

  it('renders the AI card disabled with a badge + visible/announced "Coming soon" cue and does not transition on click', async () => {
    const user = userEvent.setup();
    renderDrawer();
    const aiCard = screen.getByRole('button', { name: /upload docs/i });
    expect(aiCard).toBeDisabled();
    // Keeps the "AI" accent badge.
    expect(screen.getByText('AI')).toBeInTheDocument();
    // Reason is visible to sighted users...
    expect(screen.getByText('Coming soon')).toBeInTheDocument();
    // ...and announced to AT via the accessible name.
    expect(aiCard).toHaveAccessibleName(/coming soon/i);

    await user.click(aiCard);
    // Still on start — card is inert, no entry-selected event fired.
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
      expert_id: 'expert-profile-1',
      method: 'manual',
    });
  });

  it('gates Review until both title and description are filled', async () => {
    const user = userEvent.setup();
    renderDrawer();
    await user.click(screen.getByRole('button', { name: /describe it yourself/i }));

    const reviewBtn = screen.getByRole('button', { name: /^review/i });
    expect(reviewBtn).toBeDisabled();

    await user.type(screen.getByLabelText(/project title/i), 'A title');
    expect(reviewBtn).toBeDisabled();

    await user.type(screen.getByLabelText(/what do you need/i), 'A description');
    expect(reviewBtn).toBeEnabled();
  });

  it('submits the happy path: trimmed fields + source manual, fires submitted event, shows done', async () => {
    const user = await advanceToReview();
    // Pick budget + timeline so has_budget / has_timeline are true.
    await user.click(screen.getByRole('radio', { name: 'A$2–5k' }));
    await user.click(screen.getByRole('radio', { name: 'ASAP' }));
    await user.click(screen.getByRole('radio', { name: 'Integration' }));

    await user.click(screen.getByRole('button', { name: /submit request/i }));

    await waitFor(() => {
      expect(mockSubmit).toHaveBeenCalledWith({
        expertProfileId: 'expert-profile-1',
        title: 'Lead routing rebuild',
        description: 'Rebuild lead routing in Flow.',
        focusArea: 'Integration',
        budget: 'A$2–5k',
        timeline: 'ASAP',
        source: 'manual',
      });
    });

    expect(mockTrack).toHaveBeenCalledWith(PROJECT_EVENTS.PROJECT_REQUEST_SUBMITTED, {
      expert_id: 'expert-profile-1',
      has_budget: true,
      has_timeline: true,
      focus_areas: ['Integration'],
      method: 'manual',
    });
    expect(await screen.findByText(/request sent to priya/i)).toBeInTheDocument();
    expect(mockToast.success).toHaveBeenCalledWith('Request sent', expect.objectContaining({}));
  });

  it('reports has_budget/has_timeline false and empty focus_areas when chips untouched', async () => {
    const user = await advanceToReview();
    await user.click(screen.getByRole('button', { name: /submit request/i }));

    await waitFor(() => {
      expect(mockTrack).toHaveBeenCalledWith(PROJECT_EVENTS.PROJECT_REQUEST_SUBMITTED, {
        expert_id: 'expert-profile-1',
        has_budget: false,
        has_timeline: false,
        focus_areas: [],
        method: 'manual',
      });
    });
  });

  it('on submit failure shows an inline error + toast.error and stays on review', async () => {
    mockSubmit.mockResolvedValue({ success: false, error: 'Something went wrong.' });
    const user = await advanceToReview();

    await user.click(screen.getByRole('button', { name: /submit request/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong.');
    expect(mockToast.error).toHaveBeenCalledWith('Something went wrong.');
    // Still on review (Submit button present, no done heading).
    expect(screen.getByRole('button', { name: /submit request/i })).toBeInTheDocument();
    expect(screen.queryByText(/request sent to priya/i)).not.toBeInTheDocument();
  });

  it('fires PROJECT_DRAWER_OPENED exactly once on open', () => {
    renderDrawer();
    const openCalls = mockTrack.mock.calls.filter(
      ([event]) => event === PROJECT_EVENTS.PROJECT_DRAWER_OPENED
    );
    expect(openCalls).toHaveLength(1);
    expect(openCalls[0]?.[1]).toEqual({ expert_id: 'expert-profile-1' });
  });

  it('does not fire PROJECT_DRAWER_OPENED when closed', () => {
    render(<ProjectDrawer open={false} onOpenChange={vi.fn()} {...BASE_PROPS} />);
    expect(mockTrack).not.toHaveBeenCalledWith(
      PROJECT_EVENTS.PROJECT_DRAWER_OPENED,
      expect.anything()
    );
  });

  it('fires PROJECT_STEP_VIEWED for each step', async () => {
    const user = await advanceToReview();
    const steps = mockTrack.mock.calls
      .filter(([event]) => event === PROJECT_EVENTS.PROJECT_STEP_VIEWED)
      .map(([, props]) => (props as { step: string }).step);
    expect(steps).toContain('start');
    expect(steps).toContain('manual');
    expect(steps).toContain('review');

    await user.click(screen.getByRole('button', { name: /submit request/i }));
    await waitFor(() => {
      const afterSubmit = mockTrack.mock.calls
        .filter(([event]) => event === PROJECT_EVENTS.PROJECT_STEP_VIEWED)
        .map(([, props]) => (props as { step: string }).step);
      expect(afterSubmit).toContain('done');
    });
  });

  it('persists the draft to localStorage and hydrates it on remount', async () => {
    const user = userEvent.setup();
    const { unmount } = renderDrawer();
    await user.click(screen.getByRole('button', { name: /describe it yourself/i }));
    await user.type(screen.getByLabelText(/project title/i), 'Persisted title');

    await waitFor(() => {
      const raw = window.localStorage.getItem('balo:project-draft:expert-profile-1');
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
      expect(window.localStorage.getItem('balo:project-draft:expert-profile-1')).not.toBeNull();
    });

    await user.click(screen.getByRole('button', { name: /submit request/i }));

    await waitFor(() => {
      expect(window.localStorage.getItem('balo:project-draft:expert-profile-1')).toBeNull();
    });
  });

  it('has no accessibility violations', async () => {
    const { baseElement } = renderDrawer();
    expect(await axe(baseElement)).toHaveNoViolations();
  });
});
