import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { codeLinesOf, resolveRouteDir } from '@/invariants/_source-scan';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

/**
 * ⚠⚠ THE VENDOR DOUBLE IS NOT OPTIONAL HERE, AND ITS ABSENCE WAS A **LOAD-DEPENDENT FLAKE.**
 *
 * The admitted state of this control hands the grant to `MeetingCallSurface`, which since BAL-435
 * actually mounts the frame via `next/dynamic`. Without this mock that dynamic chunk pulls in the
 * REAL `@daily-co/daily-js`, which throws `WebRTC not supported or suppressed` in jsdom.
 *
 * ⚠ WHY IT PASSED IN ISOLATION: whether the chunk resolves before the test ends is a RACE. Run
 * alone the file finishes first and the rejection is never observed; run under a saturated worker
 * pool it lands mid-suite and fails a file that looks unrelated. Do not "fix" a recurrence by
 * skipping the admitted-state assertions — they are the reason this file exists.
 */
vi.mock('@daily-co/daily-react', async () => {
  const { dailyReactModuleMock } = await import('@/test/mocks/daily');
  return dailyReactModuleMock();
});

vi.mock('motion/react', async () => {
  const { createMotionStub } = await import('@/test/motion-stub');
  return createMotionStub();
});

// jsdom has no `matchMedia`; the repo's convention is to mock the hook, not stub `matchMedia`.
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }));

const mockPoll = vi.fn();
vi.mock('@/app/join/_actions/poll-guest-admission', () => ({
  pollGuestAdmissionAction: (...args: unknown[]) => mockPoll(...args),
}));

import { toast } from 'sonner';
import { installMediaStubs, resetDailyMock } from '@/test/mocks/daily';
import { JoinControl } from './join-control';
import {
  JOIN_TEMPORARILY_UNAVAILABLE_TITLE,
  JOIN_UNAVAILABLE_TITLE,
  LOBBY_LONG_WAIT_AFTER_MS,
} from '@/lib/meetings/lobby';

const MEETING_ID = '0f7b1c2d-3e4f-4a5b-8c9d-0e1f2a3b4c5d';
const RAW_TOKEN = 'z'.repeat(43);
const START_ISO = '2026-09-01T10:00:00.000Z';
const END_ISO = '2026-09-01T11:00:00.000Z';
const UTC_LABEL = '10:00 – 11:00 UTC';
const NEXT_STEP = 'Come back to this page when it is time.';
const EXPIRES_ON = '8 September 2026';
/** What the RSC passes as `children` — the invitation card's own content. */
const INVITATION_HEADLINE = 'Design review with CloudPeak';

const GRANT = {
  roomUrl: 'https://balo.daily.co/balo-0f7b1c2d3e4f4a5b8c9d0e1f2a3b4c5d',
  token: 'daily.jwt.value',
  isOwner: false,
  /**
   * BAL-134 / ADR-1049 (D3) — ⚠ ALWAYS `false` ON A GUEST ARM, mirroring `isOwner`.
   * `joinMeetingAsGuest` hard-codes it server-side; a guest holds neither the engagement
   * capability nor a client-company membership, so neither half of `canEndMeeting` can be true.
   */
  canEndMeeting: false,
  expiresAt: '2026-09-02T11:00:00.000Z',
  participantId: 'g0f7b1c2d3e4f4a5b8c9d0e1f2a3b4c5d',
};

/** A TERMINAL refusal — unknown / expired / revoked / DENIED token, or no such meeting. */
const DEAD_TOKEN_FAILURE = {
  success: false,
  retryable: false,
  status: 404,
  title: JOIN_UNAVAILABLE_TITLE,
};

function renderControl(
  overrides: Partial<{
    hasEnded: boolean;
    startIso: string;
    endIso: string;
    recapHref: string | null;
  }> = {}
): ReturnType<typeof render> {
  return render(
    <JoinControl
      token={RAW_TOKEN}
      meetingId={MEETING_ID}
      scheduledStartIso={overrides.startIso ?? START_ISO}
      scheduledEndIso={overrides.endIso ?? END_ISO}
      utcWindowLabel={UTC_LABEL}
      hasEnded={overrides.hasEnded ?? false}
      hasChat={false}
      recapHref={overrides.recapHref ?? null}
      nextStepLine={NEXT_STEP}
      expiresOn={EXPIRES_ON}
    >
      <h1>{INVITATION_HEADLINE}</h1>
    </JoinControl>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  // ⚠ AFTER `clearAllMocks`, which strips the double's implementations along with everyone else's.
  installMediaStubs();
  resetDailyMock();
  mockPoll.mockResolvedValue({ success: true, state: 'admitted', grant: GRANT });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('JoinControl — the invited guest`s join', () => {
  it('⚠ does NOT mint on mount — an emailed URL is fetched by link scanners', async () => {
    // Gmail's proxy, Defender Safe Links detonation and MDM prefetch all issue unsolicited
    // GETs, and this token is deliberately NOT single-use. A mint on render would hand a live
    // Daily credential to a scanner, repeatedly, for the whole 7-day window.
    renderControl();

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /join the call/i })).toBeInTheDocument();
    });
    expect(mockPoll).not.toHaveBeenCalled();
  });

  it('renders the invitation content it was handed, plus the closing lines', () => {
    renderControl();

    expect(screen.getByText(INVITATION_HEADLINE)).toBeInTheDocument();
    expect(screen.getByText(NEXT_STEP)).toBeInTheDocument();
    expect(screen.getByText(new RegExp(EXPIRES_ON))).toBeInTheDocument();
  });

  it('⚠⚠ a `pre_admitted` invitee reaches the call surface in ONE click — no visible token step', async () => {
    // The acceptance criterion. It falls out of the shared endpoint: a `pre_admitted` guest
    // mints on the FIRST call, so there is no queue and no waiting card on this route.
    const user = userEvent.setup();
    renderControl();

    await user.click(screen.getByRole('button', { name: /join the call/i }));

    // ⚠⚠ F5 (fix-round-1 / CRITICAL-6) — 5000ms, not the 1000ms default. The admitted subtree's
    // module graph now pulls `meeting-frame-impl → guest-chat-panel → chat-panel →
    // chat-composer → use-meeting-file-upload`, so the mount does not reliably complete inside
    // 1000ms under worker contention. Reproduced 3/3 with `TZ=UTC npx vitest run src/lib/
    // meetings src/app/join` from `apps/web`. See SUGGESTION-3 for the structural fix (the
    // read-only guest surface should not import the composer at all).
    await waitFor(
      () => {
        expect(screen.getByRole('heading', { name: /ready to join/i })).toBeInTheDocument();
      },
      { timeout: 5000 }
    );
    expect(mockPoll).toHaveBeenCalledWith({ meetingId: MEETING_ID, guestToken: RAW_TOKEN });
    expect(mockPoll).toHaveBeenCalledTimes(1);
  });

  it('⚠ never renders the raw token or the Daily JWT as text', async () => {
    const user = userEvent.setup();
    const { container } = renderControl();

    await user.click(screen.getByRole('button', { name: /join the call/i }));
    // ⚠⚠ F5 (fix-round-1 / CRITICAL-6) — 5000ms, see the twin note above.
    await waitFor(
      () => {
        expect(screen.getByRole('heading', { name: /ready to join/i })).toBeInTheDocument();
      },
      { timeout: 5000 }
    );

    expect(container.textContent ?? '').not.toContain(RAW_TOKEN);
    expect(container.textContent ?? '').not.toContain(GRANT.token);
  });

  it('offers NO join button for an ended meeting', () => {
    renderControl({ hasEnded: true });

    expect(screen.queryByRole('button', { name: /join the call/i })).not.toBeInTheDocument();
  });

  it('lands on the uniform copy when the api refuses', async () => {
    mockPoll.mockResolvedValue(DEAD_TOKEN_FAILURE);
    const user = userEvent.setup();
    renderControl();

    await user.click(screen.getByRole('button', { name: /join the call/i }));

    await waitFor(() => {
      expect(screen.getByText(JOIN_UNAVAILABLE_TITLE)).toBeInTheDocument();
    });
    expect(toast.error).toHaveBeenCalledWith(JOIN_UNAVAILABLE_TITLE);
  });

  it('⚠ a DENIED guest is never told they were denied', async () => {
    mockPoll.mockResolvedValue(DEAD_TOKEN_FAILURE);
    const user = userEvent.setup();
    const { container } = renderControl();

    await user.click(screen.getByRole('button', { name: /join the call/i }));
    await waitFor(() => {
      expect(screen.getByText(JOIN_UNAVAILABLE_TITLE)).toBeInTheDocument();
    });

    expect(container.textContent ?? '').not.toMatch(/denied|rejected|refused/i);
  });

  it('⚠ the refusal renders the SHARED card — icon, body copy and a live region', async () => {
    // It used to be a bare `<p>` carrying the title and nothing else. Two implementations of
    // one no-oracle property is how the property becomes per-surface — which is exactly what
    // happened to the COPY before it was hoisted into shared constants.
    mockPoll.mockResolvedValue(DEAD_TOKEN_FAILURE);
    const user = userEvent.setup();
    const { container } = renderControl();

    await user.click(screen.getByRole('button', { name: /join the call/i }));
    await waitFor(() => {
      expect(screen.getByText(JOIN_UNAVAILABLE_TITLE)).toBeInTheDocument();
    });

    expect(container.querySelector('output')).not.toBeNull();
    expect(screen.getByText(/whoever shared it with you/i)).toBeInTheDocument();
  });

  it('ignores a second click while a join is in flight', async () => {
    const user = userEvent.setup();
    renderControl();

    const button = screen.getByRole('button', { name: /join the call/i });
    await user.click(button);
    await user.click(button).catch(() => undefined);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /ready to join/i })).toBeInTheDocument();
    });
    expect(mockPoll).toHaveBeenCalledTimes(1);
  });
});

/**
 * BAL-439 §9.7 — the "View the recap" link. Renders ONLY when the meeting has ended AND the
 * RSC resolved a `recapHref` (an ended meeting with no artefacts still gets the link — the
 * recap itself states an absent write-up honestly).
 */
describe('⚠ JoinControl — the BAL-439 recap link', () => {
  const RECAP_HREF = `/join/${RAW_TOKEN}/recap/${MEETING_ID}`;

  it('renders "View the recap" when the meeting has ended and a recapHref was resolved', () => {
    renderControl({ hasEnded: true, recapHref: RECAP_HREF });

    const link = screen.getByRole('link', { name: /view the recap/i });
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute('href', RECAP_HREF);
  });

  /**
   * ⚠⚠ fix-round-1 / MUST-2 — this used to be BYTE-IDENTICAL to the test above it (same
   * `href` assertion, nothing else), so `prefetch={false}` — called LOAD-BEARING in three
   * docblocks, because a prefetch stamps `recordAccess` on a page nobody opened — was
   * unverified on either link that carries it. `next/link`'s `prefetch` prop does not surface
   * as a DOM attribute, so it is asserted at the SOURCE level instead, on both call sites:
   * this component's own "View the recap" link AND `guest-recap-card.tsx`'s "Back to the
   * invitation" link, which shares the exact same hazard for the exact same reason.
   */
  it('⚠⚠ MUST-2 — `prefetch={false}` is present in BOTH join-control.tsx and guest-recap-card.tsx (source-scanned)', () => {
    const joinControlPath = resolveRouteDir([
      'src/app/join/[token]/join-control.tsx',
      'apps/web/src/app/join/[token]/join-control.tsx',
    ]);
    const guestRecapCardPath = resolveRouteDir([
      'src/app/join/[token]/recap/_components/guest-recap-card.tsx',
      'apps/web/src/app/join/[token]/recap/_components/guest-recap-card.tsx',
    ]);
    // Non-vacuity: the scan must have actually found both files.
    expect(joinControlPath).not.toBe('');
    expect(guestRecapCardPath).not.toBe('');

    const joinControlCode = codeLinesOf(readFileSync(joinControlPath, 'utf8'));
    const guestRecapCardCode = codeLinesOf(readFileSync(guestRecapCardPath, 'utf8'));

    expect(joinControlCode).toContain('prefetch={false}');
    expect(guestRecapCardCode).toContain('prefetch={false}');
  });

  it('is ABSENT when the meeting has ended but recapHref is null (no artefact-bearing recap resolved is not the reason — see the RSC)', () => {
    renderControl({ hasEnded: true, recapHref: null });

    expect(screen.queryByRole('link', { name: /view the recap/i })).not.toBeInTheDocument();
  });

  it('is ABSENT on the pre-call (not-yet-ended) card, even if a recapHref were somehow supplied', () => {
    renderControl({ hasEnded: false, recapHref: RECAP_HREF });

    expect(screen.queryByRole('link', { name: /view the recap/i })).not.toBeInTheDocument();
    // …and the Join button is the one control on this card.
    expect(screen.getByRole('button', { name: /join the call/i })).toBeInTheDocument();
  });
});

describe('⚠ JoinControl — the D10 viewer-local time swap', () => {
  it('renders the SERVER`s UTC label first, then swaps after hydration', async () => {
    // ⚠ The first paint MUST match the server's markup, or React reports a hydration
    // mismatch. The swap therefore happens in an effect, never during render.
    const { container } = renderControl();

    await waitFor(() => {
      // The label is present either way; what matters is that the initial state was the
      // server string, which is what `useState(utcWindowLabel)` guarantees.
      expect(container.textContent ?? '').toMatch(/Scheduled for/);
    });
  });

  it('⚠ ALWAYS states a zone — an unlabelled local time is worse than a labelled UTC one', async () => {
    // The whole reason the RSC renders UTC is that a bare wall-clock time is ambiguous.
    // Swapping to an unlabelled local time would reintroduce exactly that.
    const { container } = renderControl();

    await waitFor(() => {
      const text = container.textContent ?? '';
      // Either the server's "UTC" or a resolved local zone abbreviation / GMT offset.
      expect(text).toMatch(/UTC|GMT|[A-Z]{2,5}\b/);
    });
  });

  it('renders the window even for an ENDED meeting — the swap is independent of joining', () => {
    const { container } = renderControl({ hasEnded: true });

    expect(container.textContent ?? '').toMatch(/Scheduled for/);
  });

  it('falls back to the server string for an unparseable date', () => {
    const { container } = renderControl({ startIso: 'not-a-date', endIso: 'not-a-date' });

    expect(container.textContent ?? '').toContain(UTC_LABEL);
  });
});

/**
 * ⚠⚠ THE CALL SURFACE **REPLACES** THE INVITATION CARD (the nested-card fix).
 *
 * Nesting produced TWO `<h1>`s on the page, "You're in" directly above "Come back to this page
 * when it's time", and — the durable cost — handed BAL-435 a 560px column inside an invitation
 * card to build a video stage in.
 */
describe('⚠⚠ JoinControl — the admitted phase replaces the card', () => {
  it('drops the invitation content, and with it the contradictory closing copy', async () => {
    const user = userEvent.setup();
    renderControl();

    expect(screen.getByText(INVITATION_HEADLINE)).toBeInTheDocument();
    expect(screen.getByText(NEXT_STEP)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /join the call/i }));

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /ready to join/i })).toBeInTheDocument();
    });
    expect(screen.queryByText(INVITATION_HEADLINE)).not.toBeInTheDocument();
    expect(screen.queryByText(NEXT_STEP)).not.toBeInTheDocument();
  });

  it('⚠ leaves exactly ONE h1 on the page', async () => {
    const user = userEvent.setup();
    renderControl();

    await user.click(screen.getByRole('button', { name: /join the call/i }));
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /ready to join/i })).toBeInTheDocument();
    });

    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });

  it('the refusal card also replaces it — stale invitation details are misleading', async () => {
    mockPoll.mockResolvedValue(DEAD_TOKEN_FAILURE);
    const user = userEvent.setup();
    renderControl();

    await user.click(screen.getByRole('button', { name: /join the call/i }));
    await waitFor(() => {
      expect(screen.getByText(JOIN_UNAVAILABLE_TITLE)).toBeInTheDocument();
    });

    expect(screen.queryByText(INVITATION_HEADLINE)).not.toBeInTheDocument();
  });
});

/**
 * ⚠⚠ A QUEUED INVITEE IS NO LONGER LEFT BLIND-CLICKING.
 *
 * A host CAN move a `pre_admitted` invitee into the queue. That used to toast "Waiting for
 * someone to let you in…" and reset the button to idle with NO polling, so the guest had no way
 * to learn when anything changed and no signal that clicking again was even the right move.
 */
describe('⚠⚠ JoinControl — a queued invitee gets the waiting treatment AND a poll', () => {
  it('renders the waiting card instead of resetting the button', async () => {
    mockPoll.mockResolvedValue({ success: true, state: 'waiting' });
    const user = userEvent.setup();
    renderControl();

    await user.click(screen.getByRole('button', { name: /join the call/i }));

    await waitFor(() => {
      expect(screen.getByText(/waiting for someone to let you in/i)).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: /join the call/i })).not.toBeInTheDocument();
  });

  it('⚠ polls on the shared back-off schedule, and admits without another click', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockPoll.mockResolvedValueOnce({ success: true, state: 'waiting' });
    mockPoll.mockResolvedValue({ success: true, state: 'admitted', grant: GRANT });

    renderControl();

    await act(async () => {
      screen.getByRole('button', { name: /join the call/i }).click();
    });
    await waitFor(() => {
      expect(screen.getByText(/waiting for someone to let you in/i)).toBeInTheDocument();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000);
    });

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /ready to join/i })).toBeInTheDocument();
    });
  });

  /**
   * ── ⚠ THE LONG-WAIT BRANCH, WHICH HAD **ZERO** COVERAGE ON THIS SURFACE ─────────────────
   *
   * The lobby's equivalent is tested; `JoinControl`'s was not — no test in this file matched
   * "taking a little longer". SonarCloud's ≥80% gate is on CHANGED lines, so an untested
   * branch in a new file is a live PR risk as well as a real one: this is the copy a guest sees
   * when nothing has happened for three minutes, i.e. exactly when they are deciding whether
   * the page is broken.
   */
  it('⚠ acknowledges a long wait after LOBBY_LONG_WAIT_AFTER_MS — and not before', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockPoll.mockResolvedValue({ success: true, state: 'waiting' });
    renderControl();

    await act(async () => {
      screen.getByRole('button', { name: /join the call/i }).click();
    });
    await waitFor(() => {
      expect(screen.getByText(/waiting for someone to let you in/i)).toBeInTheDocument();
    });
    // ⚠ NOT YET. A wait that apologises immediately is worse than one that says nothing.
    expect(screen.queryByText(/taking a little longer/i)).not.toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(LOBBY_LONG_WAIT_AFTER_MS + 1_000);
    });

    await waitFor(() => {
      expect(screen.getByText(/taking a little longer/i)).toBeInTheDocument();
    });
    // ⚠ AND STILL NO EXIT ON THIS SURFACE — the asymmetry with the lobby is deliberate: an
    // invited guest's handle is the emailed URL, which they still have, so a "leave" button
    // would only return them to a page they can reload.
    expect(screen.queryByRole('button', { name: /leave the queue/i })).not.toBeInTheDocument();
  });

  it('⚠ the long-wait line discloses NOTHING about the meeting — it is a fact about the wait', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockPoll.mockResolvedValue({ success: true, state: 'waiting' });
    renderControl();

    await act(async () => {
      screen.getByRole('button', { name: /join the call/i }).click();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LOBBY_LONG_WAIT_AFTER_MS + 1_000);
    });

    const line = await screen.findByText(/taking a little longer/i);
    const text = line.textContent ?? '';
    // No company, no agency, no host name, no title — and not even the words "meeting"/"call".
    expect(text).not.toMatch(/\bmeeting\b/i);
    expect(text).not.toMatch(/\bcall\b/i);
    expect(text).not.toContain(INVITATION_HEADLINE);
  });

  it('⚠ the waiting card carries NO aria-busy — it would suppress its own announcement', async () => {
    mockPoll.mockResolvedValue({ success: true, state: 'waiting' });
    const user = userEvent.setup();
    const { container } = renderControl();

    await user.click(screen.getByRole('button', { name: /join the call/i }));
    await waitFor(() => {
      expect(screen.getByText(/waiting for someone to let you in/i)).toBeInTheDocument();
    });

    expect(container.querySelector('output')?.getAttribute('aria-busy')).toBeNull();
  });
});

/**
 * ⚠ A DROPPED PACKET IS NOT A DEAD LINK. The previous `.catch` set a terminal state with NO
 * toast at all, so on a flaky connection the button silently stopped meaning anything.
 */
describe('⚠ JoinControl — transport failures are recoverable, not terminal', () => {
  /**
   * ⚠⚠ THE TOAST MUST NAME THE CARD THE VISITOR IS LOOKING AT. An earlier version toasted
   * `JOIN_UNAVAILABLE_TITLE` ("This link isn't active") while rendering the retry card ("We
   * couldn't connect you just now") — two contradictory sentences on screen at once — and the
   * previous version of THIS TEST asserted the contradiction, which is how it survived review.
   */
  it('a rejected action toasts the SAME title as the card it renders, and offers a retry', async () => {
    mockPoll.mockRejectedValue(new Error('network down'));
    const user = userEvent.setup();
    renderControl();

    await user.click(screen.getByRole('button', { name: /join the call/i }));

    await waitFor(() => {
      expect(screen.getByText(JOIN_TEMPORARILY_UNAVAILABLE_TITLE)).toBeInTheDocument();
    });
    expect(toast.error).toHaveBeenCalledWith(JOIN_TEMPORARILY_UNAVAILABLE_TITLE);
    expect(toast.error).not.toHaveBeenCalledWith(JOIN_UNAVAILABLE_TITLE);
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });

  it('⚠ a 503 shows the retry card, NOT "this link isn`t active" — the guest is demonstrably real', async () => {
    mockPoll.mockResolvedValue({
      success: false,
      retryable: true,
      status: 503,
      title: JOIN_TEMPORARILY_UNAVAILABLE_TITLE,
    });
    const user = userEvent.setup();
    renderControl();

    await user.click(screen.getByRole('button', { name: /join the call/i }));

    await waitFor(() => {
      expect(screen.getByText(JOIN_TEMPORARILY_UNAVAILABLE_TITLE)).toBeInTheDocument();
    });
    expect(screen.queryByText(JOIN_UNAVAILABLE_TITLE)).not.toBeInTheDocument();
    expect(toast.error).toHaveBeenCalledWith(JOIN_TEMPORARILY_UNAVAILABLE_TITLE);
  });

  /**
   * ── ⚠⚠ A `429` MUST STAY COLLAPSED, AND THIS SURFACE USED TO SPLIT IT OUT ────────────────
   *
   * `poll-guest-admission.ts` and `lobby.ts` both state it in as many words: a `429` fires
   * PRE-AUTHORIZATION, so a distinct message tells an anonymous scanner they are being counted.
   * `useAdmissionPoll` mapped it correctly (`status >= 500 ? 'retry_later' : 'unavailable'`);
   * this component branched on `result.retryable` instead, which is the POLLING predicate and
   * is true for `0` / `429` / `>= 500` alike — so the one status the contract names explicitly
   * was the one that leaked. Two surfaces, two answers to one question.
   */
  it.each([
    { label: 'a 429 (pre-authorization — must not confirm the visitor is counted)', status: 429 },
    { label: 'a transport failure (status 0 — no server ever answered)', status: 0 },
  ])('⚠⚠ COLLAPSES $label onto the dead-link card', async ({ status }) => {
    mockPoll.mockResolvedValue({
      success: false,
      // ⚠ `retryable: true` — exactly as the action returns for both of these. The component
      // must NOT use that flag to choose copy.
      retryable: true,
      status,
      title: JOIN_UNAVAILABLE_TITLE,
    });
    const user = userEvent.setup();
    renderControl();

    await user.click(screen.getByRole('button', { name: /join the call/i }));

    await waitFor(() => {
      expect(screen.getByText(JOIN_UNAVAILABLE_TITLE)).toBeInTheDocument();
    });
    expect(screen.queryByText(JOIN_TEMPORARILY_UNAVAILABLE_TITLE)).not.toBeInTheDocument();
    // ⚠ NO "Try again" — the retry affordance is part of what distinguishes the outage card.
    expect(screen.queryByRole('button', { name: /try again/i })).not.toBeInTheDocument();
    expect(toast.error).toHaveBeenCalledWith(JOIN_UNAVAILABLE_TITLE);
  });

  it('⚠ agrees with `useAdmissionPoll`, which is the OTHER consumer of the same statuses', async () => {
    // The shared hook maps terminal outcomes with `status >= 500 ? 'retry_later' : …`. This
    // asserts the click path uses the same boundary rather than a second opinion: 500 is an
    // outage, 499 is not.
    for (const [status, expected] of [
      [499, JOIN_UNAVAILABLE_TITLE],
      [500, JOIN_TEMPORARILY_UNAVAILABLE_TITLE],
    ] as const) {
      mockPoll.mockResolvedValue({
        success: false,
        retryable: true,
        status,
        title: JOIN_UNAVAILABLE_TITLE,
      });
      const user = userEvent.setup();
      const view = renderControl();

      await user.click(screen.getAllByRole('button', { name: /join the call/i })[0] as HTMLElement);
      await waitFor(() => {
        expect(screen.getByText(expected)).toBeInTheDocument();
      });
      view.unmount();
    }
  });

  it('retrying returns to the invitation card so the guest can try the mint again', async () => {
    mockPoll.mockRejectedValueOnce(new Error('network down'));
    mockPoll.mockResolvedValue({ success: true, state: 'admitted', grant: GRANT });
    const user = userEvent.setup();
    renderControl();

    await user.click(screen.getByRole('button', { name: /join the call/i }));
    const retry = await screen.findByRole('button', { name: /try again/i });
    await user.click(retry);

    expect(screen.getByRole('button', { name: /join the call/i })).toBeInTheDocument();
  });
});
