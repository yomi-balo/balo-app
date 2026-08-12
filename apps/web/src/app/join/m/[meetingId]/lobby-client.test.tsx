import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock('motion/react', async () => {
  const { createMotionStub } = await import('@/test/motion-stub');
  return createMotionStub();
});

const mockClaim = vi.fn();
const mockPoll = vi.fn();
vi.mock('@/app/join/_actions/claim-lobby-place', () => ({
  claimLobbyPlaceAction: (...args: unknown[]) => mockClaim(...args),
}));
vi.mock('@/app/join/_actions/poll-guest-admission', () => ({
  pollGuestAdmissionAction: (...args: unknown[]) => mockPoll(...args),
}));

import { toast } from 'sonner';
import { LobbyClient } from './lobby-client';
import {
  JOIN_TEMPORARILY_UNAVAILABLE_TITLE,
  JOIN_UNAVAILABLE_TITLE,
  LOBBY_TOKEN_STORAGE_KEY,
  LOBBY_WAIT_STARTED_STORAGE_KEY,
} from '@/lib/meetings/lobby';

const MEETING_ID = '0f7b1c2d-3e4f-4a5b-8c9d-0e1f2a3b4c5d';
const LOBBY_TOKEN = 'z'.repeat(43);
const TOKEN_KEY = `${LOBBY_TOKEN_STORAGE_KEY}:${MEETING_ID}`;
const WAIT_KEY = `${LOBBY_WAIT_STARTED_STORAGE_KEY}:${MEETING_ID}`;

const GRANT = {
  roomUrl: 'https://balo.daily.co/balo-0f7b1c2d3e4f4a5b8c9d0e1f2a3b4c5d',
  token: 'daily.jwt.value',
  isOwner: false,
  expiresAt: '2026-09-02T11:00:00.000Z',
  participantId: 'g555555555555455585555555555555555',
};

/** A retryable poll failure (the transport case). */
const TRANSPORT_FAILURE = {
  success: false,
  retryable: true,
  status: 0,
  title: JOIN_UNAVAILABLE_TITLE,
};
/** A terminal poll failure (unknown / expired / revoked / DENIED token). */
const DEAD_TOKEN_FAILURE = {
  success: false,
  retryable: false,
  status: 404,
  title: JOIN_UNAVAILABLE_TITLE,
};

function renderLobby(): ReturnType<typeof render> {
  return render(<LobbyClient meetingId={MEETING_ID} />);
}

/**
 * Advance fake timers INSIDE `act`, so the state updates a poll causes are flushed the way
 * React expects. Without this every timer-driven test logs an `act(...)` warning — noise that
 * would eventually hide a real one.
 */
async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** Fill the form and submit it. */
async function identify(): Promise<void> {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText(/your name/i), 'Sam Rivera');
  await user.type(screen.getByLabelText(/your email/i), 'sam@cloudpeak.example');
  await user.click(screen.getByRole('button', { name: /ask to join/i }));
}

/** Put a resumable wait in storage, as a reload would find it. */
function seedWaiting(startedAt = Date.now()): void {
  globalThis.sessionStorage.setItem(TOKEN_KEY, LOBBY_TOKEN);
  globalThis.sessionStorage.setItem(WAIT_KEY, String(startedAt));
}

beforeEach(() => {
  vi.clearAllMocks();
  globalThis.sessionStorage.clear();
  mockClaim.mockResolvedValue({ success: true, lobbyToken: LOBBY_TOKEN });
  mockPoll.mockResolvedValue({ success: true, state: 'waiting' });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('LobbyClient — the identify state', () => {
  it('renders a labelled name and email form', () => {
    renderLobby();

    // ⚠ `getByLabelText` only resolves when `htmlFor` matches the control's `id` — so this
    // is also the accessibility assertion, not just a query.
    expect(screen.getByLabelText(/your name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/your email/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /ask to join/i })).toBeInTheDocument();
  });

  it('⚠ says NOTHING about the meeting — it does not know anything about it', () => {
    // The page performs zero database reads, so there is no title, no date, no counterparty
    // and no participant list to render. A future edit that adds one needs a NEW disclosure
    // decision, not a quiet repository call.
    const { container } = renderLobby();
    const text = container.textContent ?? '';

    expect(text).not.toContain(MEETING_ID);
    for (const forbidden of [/\bcancelled\b/i, /\bended\b/i, /\bexpert\b/i, /\bcompany\b/i]) {
      expect(text).not.toMatch(forbidden);
    }
  });

  it('⚠ explains WHY it wants an email, and associates the hint with the field', () => {
    // Asking a stranger for an address with no reason reads as marketing capture. The hint
    // discloses a fact about BALO'S PROCESS, never about the meeting — so the no-oracle rule
    // is untouched.
    renderLobby();
    const emailField = screen.getByLabelText(/your email/i);

    const describedBy = emailField.getAttribute('aria-describedby') ?? '';
    expect(describedBy).toContain('lobby-email-hint');
    expect(document.getElementById('lobby-email-hint')?.textContent ?? '').toMatch(
      /host sees this/i
    );
  });

  it('⚠ inputs are 16px on small screens — iOS Safari zooms below that and never zooms back', () => {
    // A forwarded meeting link opened on a phone is THE primary context for this surface.
    renderLobby();

    for (const field of [
      screen.getByLabelText(/your name/i),
      screen.getByLabelText(/your email/i),
    ]) {
      expect(field.className).toContain('text-base');
      expect(field.className).toContain('sm:text-[13.5px]');
    }
  });

  it('claims a place and moves to `waiting`, with a toast', async () => {
    renderLobby();
    await identify();

    await waitFor(() => {
      expect(screen.getByText(/waiting for someone to let you in/i)).toBeInTheDocument();
    });
    expect(mockClaim).toHaveBeenCalledWith({
      meetingId: MEETING_ID,
      name: 'Sam Rivera',
      email: 'sam@cloudpeak.example',
    });
    // ⚠ TOAST ON A USER-INITIATED MUTATION — CLAUDE.md's rule.
    expect(toast.success).toHaveBeenCalled();
  });

  it('⚠ mirrors the lobby token to sessionStorage, NEVER localStorage', async () => {
    renderLobby();
    await identify();

    await waitFor(() => {
      expect(globalThis.sessionStorage.getItem(TOKEN_KEY)).toBe(LOBBY_TOKEN);
    });
    // The credential must not outlive the tab — the same reason `/join/[token]` mints no
    // cookie. A shared machine must not keep a live queue place after the person leaves.
    expect(globalThis.localStorage.getItem(TOKEN_KEY)).toBeNull();
  });

  it('⚠ persists the WAIT-START instant too, so the back-off survives a reload', async () => {
    renderLobby();
    await identify();

    await waitFor(() => {
      expect(globalThis.sessionStorage.getItem(WAIT_KEY)).not.toBeNull();
    });
    const stored = Number.parseInt(globalThis.sessionStorage.getItem(WAIT_KEY) ?? '', 10);
    expect(Number.isFinite(stored)).toBe(true);
  });

  it('resumes a wait after a reload, from the stored token', () => {
    seedWaiting();

    renderLobby();

    expect(screen.getByText(/waiting for someone to let you in/i)).toBeInTheDocument();
  });
});

/**
 * ⚠⚠ THE VALIDATION ARM IS REACHABLE IN ORDINARY USE, AND MUST NOT BE TERMINAL. The browser's
 * own `required` accepts a whitespace-only name and `type="email"` accepts `a@b`; Zod rejects
 * both. Treating that as "this link isn't active" destroyed what the visitor typed and stranded
 * them on a dead end for a mistake fixable in one second.
 */
describe('⚠⚠ LobbyClient — a validation failure stays on the form', () => {
  const INVALID = {
    success: false,
    kind: 'invalid_input',
    error: 'Please enter your name and a valid email address.',
  };

  it('stays in `identify` and does NOT render the unavailable card', async () => {
    mockClaim.mockResolvedValue(INVALID);

    renderLobby();
    await identify();

    await waitFor(() => {
      expect(screen.getByText(INVALID.error)).toBeInTheDocument();
    });
    expect(screen.queryByText(JOIN_UNAVAILABLE_TITLE)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /ask to join/i })).toBeInTheDocument();
  });

  it('⚠ KEEPS the typed name and email — retyping them is the injury, not the error message', async () => {
    mockClaim.mockResolvedValue(INVALID);

    renderLobby();
    await identify();

    await waitFor(() => {
      expect(screen.getByText(INVALID.error)).toBeInTheDocument();
    });
    expect(screen.getByLabelText(/your name/i)).toHaveValue('Sam Rivera');
    expect(screen.getByLabelText(/your email/i)).toHaveValue('sam@cloudpeak.example');
  });

  it('⚠ associates the message with BOTH controls and marks them invalid', async () => {
    mockClaim.mockResolvedValue(INVALID);

    renderLobby();
    await identify();

    await waitFor(() => {
      expect(screen.getByText(INVALID.error)).toBeInTheDocument();
    });
    for (const field of [
      screen.getByLabelText(/your name/i),
      screen.getByLabelText(/your email/i),
    ]) {
      expect(field).toHaveAttribute('aria-invalid', 'true');
      expect(field.getAttribute('aria-describedby') ?? '').toContain('lobby-form-error');
    }
  });

  it('⚠ a TRANSPORT failure on submit toasts and stays on the form — it used to be silent', async () => {
    // No `.catch` meant a dropped connection stopped the spinner and did nothing else, on the
    // patchy-signal phone that is this surface's primary context.
    mockClaim.mockRejectedValue(new Error('network down'));

    renderLobby();
    await identify();

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(JOIN_UNAVAILABLE_TITLE);
    });
    expect(screen.getByRole('button', { name: /ask to join/i })).toBeInTheDocument();
    expect(screen.queryByText(JOIN_UNAVAILABLE_TITLE)).not.toBeInTheDocument();
  });
});

describe('LobbyClient — polling', () => {
  it('polls on an interval while waiting, and stops on unmount', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    seedWaiting();

    const { unmount } = renderLobby();
    expect(mockPoll).not.toHaveBeenCalled();

    await advance(5_000);
    expect(mockPoll).toHaveBeenCalledTimes(1);
    expect(mockPoll).toHaveBeenCalledWith({ meetingId: MEETING_ID, guestToken: LOBBY_TOKEN });

    await advance(5_000);
    expect(mockPoll).toHaveBeenCalledTimes(2);

    unmount();
    await advance(30_000);
    // ⚠ No further calls after unmount — a leaked timer would keep hitting the rate limit
    // from a page nobody is looking at.
    expect(mockPoll).toHaveBeenCalledTimes(2);
  });

  it('⚠ BACKS OFF to 15s after two minutes — what keeps a patient guest inside the rate limit', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    seedWaiting();

    renderLobby();

    // Two minutes at 5s = 24 polls.
    await advance(120_000);
    const atBackoff = mockPoll.mock.calls.length;
    expect(atBackoff).toBeGreaterThanOrEqual(20);

    // The next 60s at the SLOW cadence must add ~4, not ~12.
    await advance(60_000);
    expect(mockPoll.mock.calls.length - atBackoff).toBeLessThanOrEqual(5);
  });

  it('⚠ a RESUMED wait keeps its back-off — the stored start instant is honoured', async () => {
    // Without the persisted timestamp every reload restarted the schedule at the FAST cadence,
    // spending exactly the budget the back-off exists to protect.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    seedWaiting(Date.now() - 600_000); // ten minutes ago

    renderLobby();

    await advance(60_000);
    // At the slow cadence a minute is ~4 polls; at the fast one it would be ~12.
    expect(mockPoll.mock.calls.length).toBeLessThanOrEqual(6);
  });

  it('⚠ shows NO toast on a poll tick', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    seedWaiting();

    renderLobby();
    await advance(20_000);

    // At one every five seconds this would be unusable. Only the submit toasts.
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('hands the grant to the call surface once admitted', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    seedWaiting();
    mockPoll.mockResolvedValue({ success: true, state: 'admitted', grant: GRANT });

    renderLobby();
    await advance(5_000);

    await waitFor(() => {
      expect(screen.getByText(/connecting/i)).toBeInTheDocument();
    });
  });

  it('⚠ clears the stored token once admitted — the credential is spent', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    seedWaiting();
    mockPoll.mockResolvedValue({ success: true, state: 'admitted', grant: GRANT });

    renderLobby();
    await advance(5_000);

    await waitFor(() => {
      expect(globalThis.sessionStorage.getItem(TOKEN_KEY)).toBeNull();
    });
  });

  it('⚠ never renders the Daily JWT as visible text', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    seedWaiting();
    mockPoll.mockResolvedValue({ success: true, state: 'admitted', grant: GRANT });

    const { container } = renderLobby();
    await advance(5_000);

    await waitFor(() => {
      expect(screen.getByText(/connecting/i)).toBeInTheDocument();
    });
    expect(container.textContent ?? '').not.toContain(GRANT.token);
    expect(container.textContent ?? '').not.toContain(LOBBY_TOKEN);
  });
});

/**
 * ⚠⚠ THE BACK-OFF ONLY EXISTS IF TRANSIENT FAILURES KEEP THE LOOP ALIVE.
 *
 * The superseded version of this suite asserted that a poll failure lands on the unavailable
 * card — which PINNED THE BUG AS INTENDED BEHAVIOUR. A blip, a 429 and a 503 were
 * indistinguishable from a dead link, and going terminal stopped the scheduler, so the whole
 * 5s→15s design could never run past the first dropped packet.
 */
describe('⚠⚠ LobbyClient — a transient poll failure KEEPS POLLING', () => {
  it('does NOT go terminal on a transport failure, and polls again', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    seedWaiting();
    mockPoll.mockResolvedValueOnce(TRANSPORT_FAILURE);
    mockPoll.mockResolvedValue({ success: true, state: 'waiting' });

    renderLobby();
    await advance(5_000);

    // Still waiting — NOT the dead-link card.
    expect(screen.getByText(/waiting for someone to let you in/i)).toBeInTheDocument();
    expect(screen.queryByText(JOIN_UNAVAILABLE_TITLE)).not.toBeInTheDocument();

    await advance(5_000);
    expect(mockPoll.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('recovers: a blip followed by an admit still hands over the grant', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    seedWaiting();
    mockPoll.mockResolvedValueOnce(TRANSPORT_FAILURE);
    mockPoll.mockResolvedValue({ success: true, state: 'admitted', grant: GRANT });

    renderLobby();
    await advance(15_000);

    await waitFor(() => {
      expect(screen.getByText(/connecting/i)).toBeInTheDocument();
    });
  });

  it('honours a 429`s Retry-After instead of hammering the window it just hit', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    seedWaiting();
    mockPoll.mockResolvedValueOnce({
      success: false,
      retryable: true,
      status: 429,
      title: JOIN_UNAVAILABLE_TITLE,
      retryAfterSeconds: 30,
    });
    mockPoll.mockResolvedValue({ success: true, state: 'waiting' });

    renderLobby();
    await advance(5_000);
    expect(mockPoll).toHaveBeenCalledTimes(1);

    // The normal cadence would have fired again by now; the server asked for 30s.
    await advance(10_000);
    expect(mockPoll).toHaveBeenCalledTimes(1);

    await advance(25_000);
    expect(mockPoll.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('⚠ gives up after a BOUNDED run of failures — a dead endpoint must not poll forever', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    seedWaiting();
    mockPoll.mockResolvedValue(TRANSPORT_FAILURE);

    renderLobby();
    await advance(120_000);

    await waitFor(() => {
      expect(screen.getByText(JOIN_UNAVAILABLE_TITLE)).toBeInTheDocument();
    });
  });

  it('⚠ a TERMINAL failure (404) stops immediately — that one IS an answer', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    seedWaiting();
    mockPoll.mockResolvedValue(DEAD_TOKEN_FAILURE);

    renderLobby();
    await advance(5_000);

    await waitFor(() => {
      expect(screen.getByText(JOIN_UNAVAILABLE_TITLE)).toBeInTheDocument();
    });
    const callsAtFailure = mockPoll.mock.calls.length;
    await advance(60_000);
    expect(mockPoll.mock.calls.length).toBe(callsAtFailure);
  });

  it('⚠⚠ CLEARS the stored token on the terminal transition, so a reload cannot resurrect the wait', async () => {
    // Leaving it behind meant a refresh re-entered `waiting` from a token already known to be
    // dead: the page then lied for a full poll interval before flipping back — worst for the
    // DENIED guest, who is the person most likely to refresh.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    seedWaiting();
    mockPoll.mockResolvedValue(DEAD_TOKEN_FAILURE);

    renderLobby();
    await advance(5_000);

    await waitFor(() => {
      expect(screen.getByText(JOIN_UNAVAILABLE_TITLE)).toBeInTheDocument();
    });
    expect(globalThis.sessionStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(globalThis.sessionStorage.getItem(WAIT_KEY)).toBeNull();
  });
});

describe('LobbyClient — the long wait has an exit (UX)', () => {
  it('acknowledges a long wait and offers a way out', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    seedWaiting();

    renderLobby();
    expect(screen.queryByRole('button', { name: /leave the queue/i })).not.toBeInTheDocument();

    await advance(181_000);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /leave the queue/i })).toBeInTheDocument();
    });
    expect(screen.getByText(/taking a little longer/i)).toBeInTheDocument();
  });

  it('⚠ neither the line nor the button discloses anything about the meeting', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    seedWaiting();

    const { container } = renderLobby();
    await advance(181_000);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /leave the queue/i })).toBeInTheDocument();
    });
    const text = container.textContent ?? '';
    expect(text).not.toContain(MEETING_ID);
    for (const forbidden of [/denied/i, /cancelled/i, /\bfull\b/i, /\bended\b/i]) {
      expect(text).not.toMatch(forbidden);
    }
  });

  it('leaving clears the stored token and returns to the form', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    seedWaiting();

    renderLobby();
    await advance(181_000);

    const leave = await screen.findByRole('button', { name: /leave the queue/i });
    await act(async () => {
      leave.click();
    });

    expect(globalThis.sessionStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(screen.getByRole('button', { name: /ask to join/i })).toBeInTheDocument();
  });
});

describe('LobbyClient — accessibility', () => {
  it('⚠⚠ the waiting card carries NO aria-busy — it SUPPRESSES the announcement it exists to make', async () => {
    // A hardcoded `aria-busy="true"` that never cleared meant a screen-reader user who
    // submitted the form heard NOTHING at all.
    renderLobby();
    await identify();

    const region = await screen.findByText(/waiting for someone to let you in/i);
    const output = region.closest('output');
    expect(output).not.toBeNull();
    expect(output?.getAttribute('aria-busy')).toBeNull();
  });

  it('⚠ moves focus to the new state`s heading, and does NOT steal it on first paint', async () => {
    renderLobby();
    // First paint: focus stays where the browser put it.
    expect(document.activeElement?.tagName).not.toBe('H1');

    await identify();

    await waitFor(() => {
      expect(screen.getByText(/waiting for someone to let you in/i)).toBeInTheDocument();
    });
    expect(document.activeElement?.tagName).toBe('H1');
  });
});

describe('⚠⚠ LobbyClient — ONE card for EVERY collapsed failure (the no-oracle property)', () => {
  /**
   * ⚠⚠ DRIVEN FROM GENUINELY DIFFERENT UPSTREAM SHAPES.
   *
   * The superseded version of this test looped over THREE IDENTICAL OBJECT LITERALS, so
   * `rendered.size === 1` held BY CONSTRUCTION and proved nothing whatsoever.
   *
   * ⚠ AND THE VERSION AFTER THAT STILL CARRIED ONE UNTRUE PATH. Its fourth entry was labelled
   * "a MALFORMED resumed token (rejected before any api call)" — but the action is FULLY
   * MOCKED here, so the poll action WAS called and the path was behaviourally identical to the
   * second (both `!retryable → 'unavailable'`, differing only in a status nothing read). The
   * label described a client-side guard that does not exist and must not: validating the token
   * shape in the component would be a second definition of the action's own Zod schema.
   *
   * So the paths are now labelled by what they ACTUALLY are, and each carries an
   * `expectsPoll` claim that is asserted — which is what makes the FIRST path genuinely
   * distinct rather than merely differently-arranged: a claim refusal never starts a poll at
   * all, because `fail()` clears the token before `useAdmissionPoll` could arm.
   */
  const PATHS = [
    {
      label: 'a CLAIM refusal (cancelled / ended / full / queue full / no such meeting)',
      arrange: () => {
        mockClaim.mockResolvedValue({
          success: false,
          kind: 'unavailable',
          error: JOIN_UNAVAILABLE_TITLE,
        });
      },
      act: identify,
      // ⚠ THE POLL NEVER RUNS on this path — no token was ever stored.
      expectsPoll: false,
    },
    {
      label: 'a TERMINAL 404 poll refusal (denied / revoked / expired / unknown token)',
      arrange: () => {
        seedWaiting();
        mockPoll.mockResolvedValue(DEAD_TOKEN_FAILURE);
      },
      act: () => advance(6_000),
      expectsPoll: true,
    },
    {
      label: 'an EXHAUSTED run of retryable 429 poll failures',
      arrange: () => {
        seedWaiting();
        mockPoll.mockResolvedValue({ ...TRANSPORT_FAILURE, status: 429 });
      },
      act: () => advance(150_000),
      expectsPoll: true,
    },
    {
      // ⚠ A DIFFERENT UPSTREAM LITERAL, not a different branch — and that is the point being
      // tested. `409 meeting_not_open_for_join` is a distinct api refusal with a distinct
      // meaning ("this meeting ended / was cancelled"), and it must render exactly what an
      // unknown token renders. Covering it is how we know the collapse is over OUTCOMES rather
      // than over one status code.
      label: 'a TERMINAL 409 poll refusal (the meeting is no longer open for join)',
      arrange: () => {
        seedWaiting();
        mockPoll.mockResolvedValue({
          success: false,
          retryable: false,
          status: 409,
          title: JOIN_UNAVAILABLE_TITLE,
        });
      },
      act: () => advance(6_000),
      expectsPoll: true,
    },
  ] as const;

  it('renders BYTE-IDENTICAL markup for every failing outcome', async () => {
    const rendered = new Set<string>();

    for (const path of PATHS) {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      vi.clearAllMocks();
      globalThis.sessionStorage.clear();
      mockClaim.mockResolvedValue({ success: true, lobbyToken: LOBBY_TOKEN });
      mockPoll.mockResolvedValue({ success: true, state: 'waiting' });
      path.arrange();

      const view = renderLobby();
      await path.act();
      await waitFor(() => {
        expect(screen.getByText(JOIN_UNAVAILABLE_TITLE)).toBeInTheDocument();
      });
      rendered.add(view.container.innerHTML);

      // ⚠ THE PER-PATH CLAIM, ASSERTED — this is what stops a "distinct" path being a relabel.
      expect(mockPoll.mock.calls.length > 0, path.label).toBe(path.expectsPoll);
      // ⚠ AND EVERY TERMINAL TRANSITION CLEARS THE CREDENTIAL, whichever path reached it.
      // Leaving it behind meant a reload resurrected a false "waiting" state.
      expect(globalThis.sessionStorage.getItem(TOKEN_KEY), path.label).toBeNull();

      view.unmount();
      vi.useRealTimers();
    }

    // Non-vacuity: four genuinely different paths were exercised…
    expect(PATHS.length).toBe(4);
    // …and they are not four copies of one arrangement.
    expect(new Set(PATHS.map((p) => p.label)).size).toBe(4);
    expect(rendered.size).toBe(1);
  });

  /**
   * ⚠ THE NEGATIVE CONTROL. Without it, "every failing outcome renders THIS card" is satisfied
   * just as well by a component that renders the card unconditionally. `invalid_input` is a
   * fact about the visitor's OWN typing — fixable in place, discloses nothing — so it must stay
   * on the form with the values intact and must NOT reach the terminal card.
   */
  it('⚠ an `invalid_input` refusal does NOT reach this card — it is not a failure of the link', async () => {
    mockClaim.mockResolvedValue({
      success: false,
      kind: 'invalid_input',
      error: 'Please enter your name and a valid email address.',
    });

    renderLobby();
    await identify();

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/valid email address/i);
    });
    expect(screen.queryByText(JOIN_UNAVAILABLE_TITLE)).not.toBeInTheDocument();
    // The form is still there, and so is what they typed.
    expect(screen.getByLabelText(/your name/i)).toHaveValue('Sam Rivera');
  });

  it('a claim failure toasts and lands on the unavailable card', async () => {
    mockClaim.mockResolvedValue({
      success: false,
      kind: 'unavailable',
      error: JOIN_UNAVAILABLE_TITLE,
    });

    renderLobby();
    await identify();

    await waitFor(() => {
      expect(screen.getByText(JOIN_UNAVAILABLE_TITLE)).toBeInTheDocument();
    });
    expect(toast.error).toHaveBeenCalledWith(JOIN_UNAVAILABLE_TITLE);
  });

  it('a TERMINAL poll failure lands on the unavailable card WITHOUT a toast', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    seedWaiting();
    mockPoll.mockResolvedValue(DEAD_TOKEN_FAILURE);

    renderLobby();
    await advance(5_000);

    await waitFor(() => {
      expect(screen.getByText(JOIN_UNAVAILABLE_TITLE)).toBeInTheDocument();
    });
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('⚠ the unavailable card names no reason — no "cancelled", no "denied", no "full"', async () => {
    mockClaim.mockResolvedValue({
      success: false,
      kind: 'unavailable',
      error: JOIN_UNAVAILABLE_TITLE,
    });

    const { container } = renderLobby();
    await identify();
    await waitFor(() => {
      expect(screen.getByText(JOIN_UNAVAILABLE_TITLE)).toBeInTheDocument();
    });

    const text = container.textContent ?? '';
    for (const forbidden of [/denied/i, /cancelled/i, /\bfull\b/i, /\bended\b/i, /rejected/i]) {
      expect(text).not.toMatch(forbidden);
    }
  });

  it('⚠ a 503 is the ONE un-collapsed outcome — an admitted guest is not told their link is dead', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    seedWaiting();
    mockPoll.mockResolvedValue({
      success: false,
      retryable: true,
      status: 503,
      title: JOIN_TEMPORARILY_UNAVAILABLE_TITLE,
    });

    renderLobby();
    await advance(150_000);

    await waitFor(() => {
      expect(screen.getByText(JOIN_TEMPORARILY_UNAVAILABLE_TITLE)).toBeInTheDocument();
    });
    // ⚠ AND IT STILL NAMES NOTHING about the meeting or the vendor.
    expect(screen.queryByText(MEETING_ID)).not.toBeInTheDocument();
  });
});
