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

// ONE cached-per-tag motion stub (`@/test/motion-stub`). Never hand-roll a bare `get` Proxy here:
// an uncached handler returns a NEW component TYPE on every property access, so React remounts the
// whole subtree on every re-render. Both cards below are `motion.div`s wrapping Radix Selects, and
// `isPending` flips back to false in a commit AFTER the one that opened the listbox — so the
// uncached mock tore the open Select down mid-interaction. That was the "unexplained" flake this
// file used to paper over with a 4-attempt retry.
vi.mock('motion/react', async () => {
  const { createMotionStub } = await import('@/test/motion-stub');
  return createMotionStub();
});

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

/** Type an id into the load row, inspect, and wait for a marker only that fixture renders. */
async function inspectId(
  user: ReturnType<typeof userEvent.setup>,
  requestId: string,
  settledMarker: string | RegExp
): Promise<void> {
  const input = screen.getByLabelText('Project request id');
  await user.clear(input);
  await user.type(input, requestId);
  await user.click(screen.getByRole('button', { name: 'Inspect' }));
  await waitFor(() => expect(screen.getByText(settledMarker)).toBeInTheDocument());
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
 * One click opens the listbox, one click takes the option. The 4-attempt retry this replaced was
 * never about Radix or CPU load — it survived the uncached `motion/react` mock remounting the card
 * out from under an open Select (see the `vi.mock` at the top). With the cached stub, a single
 * click is stable.
 */
async function openSelectAndChoose(
  user: ReturnType<typeof userEvent.setup>,
  comboboxName: string,
  optionName: string
): Promise<void> {
  await user.click(screen.getByRole('combobox', { name: comboboxName }));
  await user.click(await screen.findByRole('option', { name: optionName }));
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

  it('F1(a) — selecting a LAGGING track widens the target list to the steps that track still needs', async () => {
    const user = userEvent.setup();
    mockInspect.mockResolvedValue({
      success: true,
      requestId: 'req-3',
      status: 'proposal_submitted',
      clientContactName: 'Dana Lee',
      tracks: [
        {
          relationshipId: 'rel-1',
          expertProfileId: 'exp-1',
          expertName: 'Sam Ortiz',
          status: 'proposal_submitted',
        },
        {
          relationshipId: 'rel-2',
          expertProfileId: 'exp-2',
          expertName: 'Ade Nakamura',
          status: 'eoi_submitted',
        },
      ],
    });
    render(<RequestFastForwardPanel />);
    await inspectId(user, 'req-3', /Ade Nakamura \(eoi_submitted\)/);

    // REQUEST grain: the rollup is already `proposal_submitted`, so `proposal_requested` is past
    // and must not be offered — this is the pre-fix behaviour, and it is still correct here.
    await user.click(screen.getByRole('combobox', { name: 'Target status' }));
    expect(await screen.findByRole('option', { name: 'accepted' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'proposal_requested' })).not.toBeInTheDocument();
    await user.keyboard('{Escape}');

    // TRACK grain: the selected track is only at `eoi_submitted`, so `proposal_requested` is a
    // step it genuinely still needs — and the plan previewed is the track's, not the rollup's.
    await openSelectAndChoose(user, 'Track', 'Ade Nakamura · eoi_submitted');
    await openSelectAndChoose(user, 'Target status', 'proposal_requested');

    await user.click(screen.getByRole('button', { name: 'Fast-forward' }));
    expect(screen.getByText(/Will run: request_proposal/)).toBeInTheDocument();
  });

  it('F1(b) — "Invite a new expert" is reachable while a live track exists, and sends expertProfileId with NO relationshipId', async () => {
    const user = userEvent.setup();
    mockInspect.mockResolvedValue({
      success: true,
      requestId: 'req-4',
      status: 'eoi_submitted',
      clientContactName: 'Dana Lee',
      tracks: [
        {
          relationshipId: 'rel-1',
          expertProfileId: 'exp-1',
          expertName: 'Sam Ortiz',
          status: 'eoi_submitted',
        },
      ],
    });
    mockSearchExperts.mockResolvedValue({
      success: true,
      experts: [{ id: 'exp-9', name: 'Rio Vance', headline: null, avatarUrl: null }],
    });
    render(<RequestFastForwardPanel />);
    await inspectId(user, 'req-4', /Sam Ortiz \(eoi_submitted\)/);

    await openSelectAndChoose(user, 'Track to act on', 'Invite a new expert');

    await user.type(screen.getByLabelText('Expert to invite'), 'rio');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    await openSelectAndChoose(user, 'Expert', 'Rio Vance');

    await openSelectAndChoose(user, 'Target status', 'experts_invited');

    await user.click(screen.getByRole('button', { name: 'Fast-forward' }));
    const confirmButtons = await screen.findAllByRole('button', { name: 'Fast-forward' });
    await user.click(lastOrThrow(confirmButtons));

    // The `relationshipId` must be absent, not merely ignored: sending it would make the server
    // plan at TRACK grain and refuse the very second invite the operator asked for.
    await waitFor(() => {
      expect(mockFastForward).toHaveBeenCalledWith({
        requestId: 'req-4',
        target: 'experts_invited',
        expertProfileId: 'exp-9',
        relationshipId: undefined,
        closeReason: undefined,
      });
    });
  });

  it('F5 — a declined track is absent from the fast-forward Track picker, but still markable-read', async () => {
    const user = userEvent.setup();
    mockInspect.mockResolvedValue({
      success: true,
      requestId: 'req-6',
      status: 'proposal_submitted',
      clientContactName: 'Dana Lee',
      tracks: [
        {
          relationshipId: 'rel-1',
          expertProfileId: 'exp-1',
          expertName: 'Sam Ortiz',
          status: 'proposal_submitted',
        },
        {
          relationshipId: 'rel-2',
          expertProfileId: 'exp-2',
          expertName: 'Ade Nakamura',
          status: 'declined',
        },
      ],
    });
    render(<RequestFastForwardPanel />);
    await inspectId(user, 'req-6', /Ade Nakamura \(declined\)/);

    // The planner refuses a declined track outright, so offering it could only produce a refusal.
    await user.click(screen.getByRole('combobox', { name: 'Track' }));
    expect(
      await screen.findByRole('option', { name: 'Sam Ortiz · proposal_submitted' })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('option', { name: 'Ade Nakamura · declined' })
    ).not.toBeInTheDocument();
    await user.keyboard('{Escape}');

    // Mark-read is not a spine act — it reads every track, declined ones included.
    await user.click(screen.getByRole('combobox', { name: 'Mark-read track' }));
    expect(
      await screen.findByRole('option', { name: 'Ade Nakamura · declined' })
    ).toBeInTheDocument();
  });

  it('F5 — inspecting a DIFFERENT request clears the target picked for the previous one', async () => {
    const user = userEvent.setup();
    render(<RequestFastForwardPanel />);
    await loadRequest(user);

    await openSelectAndChoose(user, 'Target status', 'accepted');
    expect(screen.getByRole('combobox', { name: 'Target status' })).toHaveTextContent('accepted');

    mockInspect.mockResolvedValue({
      success: true,
      requestId: 'req-7',
      status: 'proposal_submitted',
      clientContactName: 'Dana Lee',
      tracks: [
        {
          relationshipId: 'rel-9',
          expertProfileId: 'exp-9',
          expertName: 'Lee Park',
          status: 'proposal_submitted',
        },
      ],
    });
    await inspectId(user, 'req-7', /Lee Park \(proposal_submitted\)/);

    // Cards are keyed by requestId — a stale pick from the PREVIOUS request must not survive and
    // travel to the server.
    expect(screen.getByRole('combobox', { name: 'Target status' })).toHaveTextContent(
      'Choose a target status'
    );
  });
});
