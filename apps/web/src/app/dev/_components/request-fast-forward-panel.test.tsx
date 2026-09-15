import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@/test/utils';
import userEvent from '@testing-library/user-event';

// Radix Select drives the open/select interaction through Pointer Capture APIs jsdom doesn't
// implement — stub them so the listbox can open (the `balo-panel.test.tsx` precedent).
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn();
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
});

// Mock motion to a plain div — framer-motion misbehaves in jsdom (mirrors seed-panel.test.tsx).
const MOTION_ONLY_PROPS = new Set(['whileHover', 'whileTap', 'transition', 'initial', 'animate']);
vi.mock('motion/react', () => ({
  useReducedMotion: () => false,
  motion: new Proxy(
    {},
    {
      get: () => {
        return ({ children, ...props }: { children?: React.ReactNode }) => {
          const rest = Object.fromEntries(
            Object.entries(props as Record<string, unknown>).filter(
              ([key]) => !MOTION_ONLY_PROPS.has(key)
            )
          );
          return <div {...rest}>{children}</div>;
        };
      },
    }
  ),
}));

const { mockToast } = vi.hoisted(() => ({
  mockToast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock('sonner', () => ({ toast: mockToast }));

const { mockInspect, mockFastForward, mockMarkRead } = vi.hoisted(() => ({
  mockInspect: vi.fn(),
  mockFastForward: vi.fn(),
  mockMarkRead: vi.fn(),
}));
vi.mock('../_actions/fast-forward', () => ({
  inspectFastForwardRequestAction: mockInspect,
  fastForwardRequestAction: mockFastForward,
  markThreadReadAsPartyAction: mockMarkRead,
}));

const { mockSearchExperts } = vi.hoisted(() => ({ mockSearchExperts: vi.fn() }));
vi.mock('@/app/(dashboard)/projects/[requestId]/_actions/search-experts-for-invite', () => ({
  searchExpertsForInviteAction: mockSearchExperts,
}));

import { RequestFastForwardPanel } from './request-fast-forward-panel';

const LOADED_REQUEST = {
  success: true as const,
  requestId: 'req-1',
  status: 'proposal_submitted',
  clientContactName: 'Dana Lee',
  tracks: [
    {
      relationshipId: 'rel-1',
      expertProfileId: 'exp-1',
      expertName: 'Sam Ortiz',
      status: 'proposal_submitted',
    },
  ],
};

async function loadRequest(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  mockInspect.mockResolvedValue(LOADED_REQUEST);
  await user.type(screen.getByLabelText('Project request id'), 'req-1');
  await user.click(screen.getByRole('button', { name: 'Inspect' }));
  await waitFor(() => expect(screen.getByText('proposal_submitted')).toBeInTheDocument());
}

/** R3 — the last element of a (possibly empty) list, or an explicit throw. Never an index-position `!`. */
function lastOrThrow<T>(items: readonly T[]): T {
  const item = items.at(-1);
  if (item === undefined) {
    throw new Error('Expected at least one matching element.');
  }
  return item;
}

/**
 * BAL-275 fix round (R2) — this flake is PANEL-SPECIFIC and its root cause is NOT IDENTIFIED.
 * Reproduced directly: 1-3 of 7 one-shot `user.click` attempts fail to open the Radix listbox
 * under contended CPU (jsdom's `pointerdown`-driven open handler never fires), and no amount of
 * WAITING helps — the option genuinely never renders, only re-clicking the trigger does.
 *
 * This is NOT the generic `reference_web_timer_tests_flake_under_local_load` CPU-load flake: the
 * shipped `balo-panel.test.tsx` exercises the same Radix Select pattern and passed 19/19 one-shot
 * at the same load average (562); a "disabled" race on the trigger was also probed and disproved.
 * Nothing else shipped in `apps/web/src` needs this retry shape today.
 *
 * The retry is retained DELIBERATELY, not removed — mutation-proven non-vacuous: the helper
 * contains no `expect()`, only returns after a genuine option click, and throws on the 4th failed
 * attempt; mutating `onValueChange` to a no-op turns these tests RED. A follow-up ticket is owed
 * to find the actual root cause — an unexplained retry over a genuine failure could be masking a
 * real defect.
 */
async function openSelectAndChoose(
  user: ReturnType<typeof userEvent.setup>,
  comboboxName: string,
  optionName: string
): Promise<void> {
  const MAX_ATTEMPTS = 4;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    await user.click(screen.getByRole('combobox', { name: comboboxName }));
    try {
      const option = await screen.findByRole(
        'option',
        { name: optionName },
        { timeout: attempt === MAX_ATTEMPTS ? 3000 : 500 }
      );
      await user.click(option);
      return;
    } catch (error) {
      if (attempt === MAX_ATTEMPTS) throw error;
    }
  }
}

describe('RequestFastForwardPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders both cards under the section heading, and the D9 reset-warning copy', () => {
    render(<RequestFastForwardPanel />);
    expect(screen.getByText('Project Request Fast-Forward')).toBeInTheDocument();
    expect(screen.getByText('Fast-forward to a status')).toBeInTheDocument();
    expect(screen.getByText('Mark a thread read')).toBeInTheDocument();
    expect(screen.getByText(/A Full Reset above deletes the seed company/)).toBeInTheDocument();
  });

  it('shows the invitation empty state (never absence-framed) before a request is loaded', () => {
    render(<RequestFastForwardPanel />);
    expect(screen.getByText('Load a request above to fast-forward it.')).toBeInTheDocument();
    expect(
      screen.getByText('Load a request above to mark one of its threads read.')
    ).toBeInTheDocument();
    expect(screen.queryByText(/^No /)).not.toBeInTheDocument();
  });

  it('inspects a request and renders its status, client contact, and track list', async () => {
    const user = userEvent.setup();
    render(<RequestFastForwardPanel />);

    await loadRequest(user);

    expect(mockInspect).toHaveBeenCalledWith({ requestId: 'req-1' });
    expect(screen.getByText('Dana Lee')).toBeInTheDocument();
    expect(screen.getByText('Sam Ortiz (proposal_submitted)')).toBeInTheDocument();
  });

  it('renders a role="alert" block when inspecting a request fails', async () => {
    const user = userEvent.setup();
    mockInspect.mockResolvedValue({ success: false, error: 'This request no longer exists.' });
    render(<RequestFastForwardPanel />);

    await user.type(screen.getByLabelText('Project request id'), 'gone');
    await user.click(screen.getByRole('button', { name: 'Inspect' }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('This request no longer exists.');
    });
  });

  it('U5 — shows "No run yet." once a request is loaded but before either card has run', async () => {
    const user = userEvent.setup();
    render(<RequestFastForwardPanel />);
    await loadRequest(user);

    expect(screen.getAllByText('No run yet.')).toHaveLength(2);
  });

  it('R4 — a closed request shows the refusal reason instead of an empty target picker', async () => {
    const user = userEvent.setup();
    mockInspect.mockResolvedValue({
      success: true,
      requestId: 'req-2',
      status: 'closed',
      clientContactName: 'Dana Lee',
      tracks: [],
    });
    render(<RequestFastForwardPanel />);

    await user.type(screen.getByLabelText('Project request id'), 'req-2');
    await user.click(screen.getByRole('button', { name: 'Inspect' }));

    // The refusal-copy render and the shared `isPending` flag settling are two separate commits
    // — keep every assertion that depends on either inside the SAME `waitFor` so it retries as a
    // unit instead of racing the trigger button's transient "Working…" label.
    await waitFor(() => {
      expect(
        screen.getByText(
          'This request is closed. Nothing can be fast-forwarded from a closed request.'
        )
      ).toBeInTheDocument();
      expect(screen.queryByRole('combobox', { name: 'Target status' })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Fast-forward' })).toBeDisabled();
    });
  });

  it('U2 — a non-closed target keeps the generic confirm copy and previews the steps it will run (U8)', async () => {
    const user = userEvent.setup();
    render(<RequestFastForwardPanel />);
    await loadRequest(user);

    await openSelectAndChoose(user, 'Target status', 'accepted');
    await user.click(screen.getByRole('button', { name: 'Fast-forward' }));

    expect(screen.getByText('Fast-forward this request?')).toBeInTheDocument();
    expect(screen.getByText(/Will run: accept/)).toBeInTheDocument();
    expect(mockFastForward).not.toHaveBeenCalled();
  });

  it('requires the AlertDialog confirm before calling fastForwardRequestAction, then reports the step list (with actor label, U3) + toast.success', async () => {
    const user = userEvent.setup();
    render(<RequestFastForwardPanel />);
    await loadRequest(user);

    await openSelectAndChoose(user, 'Target status', 'closed');

    // Clicking the card trigger opens the dialog — it must NOT call the action yet.
    await user.click(screen.getByRole('button', { name: 'Fast-forward' }));
    expect(mockFastForward).not.toHaveBeenCalled();

    // U2 — the terminal `closed` target gets distinct, higher-friction confirm copy.
    expect(screen.getByText('Close this request?')).toBeInTheDocument();

    mockFastForward.mockResolvedValue({
      success: true,
      from: 'proposal_submitted',
      to: 'closed',
      steps: [{ step: 'close', success: true, actorLabel: 'dev operator' }],
    });

    const confirmButton = await screen.findByRole('button', { name: 'Close request' });
    await user.click(confirmButton);

    await waitFor(() => {
      expect(mockFastForward).toHaveBeenCalledWith({
        requestId: 'req-1',
        target: 'closed',
        expertProfileId: undefined,
        relationshipId: undefined,
        closeReason: 'unfilled',
      });
    });

    await waitFor(
      () => {
        expect(screen.getByText('close ✓ (as dev operator)')).toBeInTheDocument();
        expect(mockToast.success).toHaveBeenCalled();
      },
      { timeout: 5000 }
    );
  });

  it('U1 — re-inspects the request after a successful fast-forward, so the pickers see fresh status/tracks', async () => {
    const user = userEvent.setup();
    render(<RequestFastForwardPanel />);
    await loadRequest(user);

    await openSelectAndChoose(user, 'Target status', 'closed');
    await user.click(screen.getByRole('button', { name: 'Fast-forward' }));

    mockFastForward.mockResolvedValue({
      success: true,
      from: 'proposal_submitted',
      to: 'closed',
      steps: [{ step: 'close', success: true, actorLabel: 'dev operator' }],
    });
    mockInspect.mockResolvedValue({
      success: true,
      requestId: 'req-1',
      status: 'closed',
      clientContactName: 'Dana Lee',
      tracks: [],
    });

    const confirmButton = await screen.findByRole('button', { name: 'Close request' });
    await user.click(confirmButton);

    await waitFor(() => {
      expect(mockInspect).toHaveBeenCalledTimes(2);
      expect(mockInspect).toHaveBeenNthCalledWith(2, { requestId: 'req-1' });
    });
  });

  it('renders a role="alert" block + toast.error when the fast-forward step refuses', async () => {
    const user = userEvent.setup();
    render(<RequestFastForwardPanel />);
    await loadRequest(user);

    await openSelectAndChoose(user, 'Target status', 'closed');

    mockFastForward.mockResolvedValue({
      success: false,
      error: 'This request is already at or past that status.',
      steps: [],
    });

    await user.click(screen.getByRole('button', { name: 'Fast-forward' }));
    const confirmButton = await screen.findByRole('button', { name: 'Close request' });
    await user.click(confirmButton);

    await waitFor(
      () => {
        expect(screen.getByRole('alert')).toHaveTextContent(
          'This request is already at or past that status.'
        );
        expect(mockToast.error).toHaveBeenCalledWith('Fast-forward failed', {
          description: 'This request is already at or past that status.',
        });
      },
      { timeout: 5000 }
    );

    // U1 — a refused step must NOT trigger a refresh; only success does.
    expect(mockInspect).toHaveBeenCalledTimes(1);
  });

  it('marks a thread read as the chosen party and shows the persisted watermark + toast.success', async () => {
    const user = userEvent.setup();
    render(<RequestFastForwardPanel />);
    await loadRequest(user);

    await openSelectAndChoose(user, 'Mark-read track', 'Sam Ortiz · proposal_submitted');

    mockMarkRead.mockResolvedValue({
      success: true,
      lastReadAtIso: '2026-09-15T00:00:00.000Z',
    });

    await user.click(screen.getByRole('button', { name: 'Mark read' }));
    const confirmButtons = await screen.findAllByRole('button', { name: 'Mark read' });
    await user.click(lastOrThrow(confirmButtons));

    await waitFor(() => {
      expect(mockMarkRead).toHaveBeenCalledWith({
        requestId: 'req-1',
        relationshipId: 'rel-1',
        side: 'client',
      });
    });

    await waitFor(
      () => {
        expect(screen.getByText('2026-09-15T00:00:00.000Z')).toBeInTheDocument();
        expect(mockToast.success).toHaveBeenCalled();
      },
      { timeout: 5000 }
    );
  });
});
