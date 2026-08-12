import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/**
 * BAL-132 — **FOCUS MOVES TO THE CARD THAT ARRIVES, UNDER THE ORDERING THAT ACTUALLY SHIPS.**
 *
 * ── ⚠⚠ WHY THIS FILE EXISTS SEPARATELY FROM THE TWO COMPONENT SUITES ────────────────────
 *
 * `lobby-client.test.tsx` and `join-control.test.tsx` mock `motion/react` with the DEFAULT
 * stub, whose `AnimatePresence` is `({ children }) => children`. That mounts the incoming card
 * in the same commit as the state change — which is NOT what ships. Both surfaces wrap their
 * card in `<AnimatePresence mode="wait">`, and `mode="wait"` holds the OUTGOING child mounted
 * for the length of its exit (0.18s) and does not mount the incoming one until that finishes.
 *
 * Under the real ordering, the previous implementation — `useEffect(() => ref.current?.focus(),
 * [state])` — focused the heading that was ABOUT TO UNMOUNT, focus fell to `<body>`, and
 * nothing re-fired when the replacement mounted. **It was a no-op in every real browser and its
 * test passed anyway**, because the passthrough stub hid the entire problem. A `vi.mock` is
 * hoisted per FILE, so exercising the other ordering needs its own file — this one.
 *
 * ⚠ IT DRIVES BOTH SURFACES. The two share `useFocusOnTransition`, so a regression in the hook
 * breaks both; testing one and trusting the other is how the shared policy stops being shared.
 *
 * ⚠ AND IT ASSERTS THE **ADMITTED** TRANSITION, which is the one that matters most and the one
 * that moved focus nowhere at all until `MeetingCallSurface` gained its `headingRef` prop.
 */
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

vi.mock('motion/react', async () => {
  const { createMotionStub } = await import('@/test/motion-stub');
  // ⚠⚠ THE WHOLE POINT OF THIS FILE. See the module docblock.
  return createMotionStub({ animatePresenceMode: 'wait' });
});

const mockClaim = vi.fn();
const mockPoll = vi.fn();
vi.mock('@/app/join/_actions/claim-lobby-place', () => ({
  claimLobbyPlaceAction: (...args: unknown[]) => mockClaim(...args),
}));
vi.mock('@/app/join/_actions/poll-guest-admission', () => ({
  pollGuestAdmissionAction: (...args: unknown[]) => mockPoll(...args),
}));

import { LobbyClient } from './m/[meetingId]/lobby-client';
import { JoinControl } from './[token]/join-control';
import { JOIN_UNAVAILABLE_TITLE } from '@/lib/meetings/lobby';

const MEETING_ID = '0f7b1c2d-3e4f-4a5b-8c9d-0e1f2a3b4c5d';
const RAW_TOKEN = 'z'.repeat(43);
const LOBBY_TOKEN = 'z'.repeat(43);

const GRANT = {
  roomUrl: 'https://balo.daily.co/balo-0f7b1c2d3e4f4a5b8c9d0e1f2a3b4c5d',
  token: 'daily.jwt.value',
  isOwner: false,
  expiresAt: '2026-09-02T11:00:00.000Z',
  participantId: 'g555555555555455585555555555555555',
};

/** The focused element's tag, or the literal `BODY` when focus was dropped. */
function focusedTag(): string | undefined {
  return document.activeElement?.tagName;
}

/** The focused element's text, so a passing assertion names WHICH heading took focus. */
function focusedText(): string {
  return document.activeElement?.textContent ?? '';
}

beforeEach(() => {
  vi.clearAllMocks();
  globalThis.sessionStorage.clear();
  mockClaim.mockResolvedValue({ success: true, lobbyToken: LOBBY_TOKEN });
  mockPoll.mockResolvedValue({ success: true, state: 'waiting' });
});

afterEach(() => {
  vi.useRealTimers();
  globalThis.sessionStorage.clear();
});

describe('⚠⚠ the anonymous lobby — focus under AnimatePresence mode="wait"', () => {
  async function identify(): Promise<void> {
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/your name/i), 'Sam Rivera');
    await user.type(screen.getByLabelText(/your email/i), 'sam@cloudpeak.example');
    await user.click(screen.getByRole('button', { name: /ask to join/i }));
  }

  it('⚠ does NOT steal focus on first paint — the form`s own autoFocus wins', () => {
    render(<LobbyClient meetingId={MEETING_ID} />);

    // The name field is `autoFocus`; the heading must not have taken it off the visitor.
    expect(focusedTag()).toBe('INPUT');
  });

  it('⚠⚠ focuses the WAITING heading once it actually mounts — not the one that is leaving', async () => {
    render(<LobbyClient meetingId={MEETING_ID} />);

    await identify();

    await waitFor(() => {
      expect(screen.getByText(/waiting for someone to let you in/i)).toBeInTheDocument();
    });
    // ⚠ THIS IS THE ASSERTION THE OLD IMPLEMENTATION FAILED: it focused the `identify`
    // heading during its exit, which then unmounted, leaving `document.activeElement` on
    // `<body>`. `BODY` here is the regression signature.
    await waitFor(() => {
      expect(focusedTag()).toBe('H1');
    });
    expect(focusedText()).toMatch(/waiting for someone to let you in/i);
  });

  it('⚠⚠ focuses the ADMITTED heading — the transition the guest actually waited for', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockPoll.mockResolvedValue({ success: true, state: 'admitted', grant: GRANT });
    render(<LobbyClient meetingId={MEETING_ID} />);

    await identify();
    // ⚠ INSIDE `act` — the poll tick this releases drives a state update.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000);
    });

    await waitFor(() => {
      expect(screen.getByText(/connecting/i)).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(focusedText()).toMatch(/connecting/i);
    });
  });

  it('focuses the failure heading too — a dead end must still announce itself', async () => {
    mockClaim.mockResolvedValue({
      success: false,
      kind: 'unavailable',
      error: JOIN_UNAVAILABLE_TITLE,
    });
    render(<LobbyClient meetingId={MEETING_ID} />);

    await identify();

    await waitFor(() => {
      expect(screen.getByText(JOIN_UNAVAILABLE_TITLE)).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(focusedText()).toBe(JOIN_UNAVAILABLE_TITLE);
    });
  });
});

describe('⚠⚠ the invited guest — focus under AnimatePresence mode="wait"', () => {
  function renderControl(): ReturnType<typeof render> {
    return render(
      <JoinControl
        token={RAW_TOKEN}
        meetingId={MEETING_ID}
        scheduledStartIso="2026-09-01T10:00:00.000Z"
        scheduledEndIso="2026-09-01T11:00:00.000Z"
        utcWindowLabel="10:00 – 11:00 UTC"
        hasEnded={false}
        nextStepLine="Come back to this page when it is time."
        expiresOn="8 September 2026"
      >
        <h1>Design review with CloudPeak</h1>
      </JoinControl>
    );
  }

  it('⚠ does NOT steal focus on first paint', () => {
    renderControl();

    expect(focusedTag()).toBe('BODY');
  });

  it('⚠⚠ focuses the ADMITTED heading, not the invitation card it replaced', async () => {
    mockPoll.mockResolvedValue({ success: true, state: 'admitted', grant: GRANT });
    const user = userEvent.setup();
    renderControl();

    await user.click(screen.getByRole('button', { name: /join the call/i }));

    await waitFor(() => {
      expect(screen.getByText(/connecting/i)).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(focusedText()).toMatch(/connecting/i);
    });
  });

  it('⚠ pressing Join does NOT move focus — `joining` renders the same card', async () => {
    // `joining` is a busy state on the SAME card (the `<motion.div>` reuses the `idle` key), so
    // treating it as a transition would yank focus off the button mid-press.
    let resolvePoll: ((value: unknown) => void) | undefined;
    mockPoll.mockReturnValue(
      new Promise((resolve) => {
        resolvePoll = resolve;
      })
    );
    const user = userEvent.setup();
    renderControl();

    const button = screen.getByRole('button', { name: /join the call/i });
    await user.click(button);

    expect(focusedTag()).toBe('BUTTON');
    expect(screen.getByRole('button', { name: /joining/i })).toBeDisabled();

    // ⚠ SETTLE THE PENDING ACTION INSIDE `act` — an update that lands after the test body has
    // returned is an un-acted state change, i.e. warning noise that eventually hides a real one.
    await act(async () => {
      resolvePoll?.({ success: true, state: 'waiting' });
    });
  });

  it('focuses the WAITING heading when a host moves an invitee back into the queue', async () => {
    mockPoll.mockResolvedValue({ success: true, state: 'waiting' });
    const user = userEvent.setup();
    renderControl();

    await user.click(screen.getByRole('button', { name: /join the call/i }));

    await waitFor(() => {
      expect(screen.getByText(/waiting for someone to let you in/i)).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(focusedText()).toMatch(/waiting for someone to let you in/i);
    });
  });
});
