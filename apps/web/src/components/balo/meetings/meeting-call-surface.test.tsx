import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { toast } from 'sonner';
import { MEETING_CALL_EVENTS, track } from '@/lib/analytics';
import { JOIN_TEMPORARILY_UNAVAILABLE_TITLE, JOIN_UNAVAILABLE_TITLE } from '@/lib/meetings/lobby';
import { END_MEETING_FAILED_COPY } from '@/lib/meetings/meeting-state';
import { dailySpies, dailyState, installMediaStubs, resetDailyMock } from '@/test/mocks/daily';
import { MeetingCallSurface } from './meeting-call-surface';

/**
 * BAL-132 → ⚠⚠ **BAL-435: THE SEAM IS NOW THE CALL.**
 *
 * ── ⚠⚠ WHAT CHANGED IN THIS FILE, AND WHY ONE ASSERTION HAD TO GO ──────────────────────────
 *
 * BAL-132 shipped an assertion that this surface `renders IDENTICALLY for an owner and a
 * non-owner — this build gates nothing`. That was TRUE and CORRECT for a build whose whole body
 * was a "Connecting…" card. It is the exact OPPOSITE of this ticket's headline AC.
 *
 * ⚠ AND IT WOULD HAVE KEPT PASSING. Under `dynamic({ ssr: false })` a synchronous jsdom render
 * only ever produces the owner-agnostic `loading:` fallback, so the old assertion would have gone
 * green over the one behaviour BAL-435 exists to add — a gate reporting success precisely because
 * it was measuring the wrong frame. It is REPLACED below with its opposite, asserted against the
 * **MOUNTED** frame, and `leave-control.test.tsx` carries the detail of what differs.
 *
 * Everything else BAL-132 pinned survives, and the three that only ever saw the loading card are
 * now re-run against the mounted frame as well:
 *
 *   · the credential never reaches the text OR the markup  → kept, EXTENDED
 *   · `<output>`, never `role="status"` (S6819)            → kept
 *   · NO `aria-busy` anywhere                              → kept (and generalised by the
 *                                                             `meeting-call-no-lens-gate` invariant)
 *   · no accessibility violations                          → kept, EXTENDED
 *
 * ── ⚠ THE GRANT GATE ────────────────────────────────────────────────────────────────────────
 *
 * `validateGrant` runs at this seam, BEFORE the dynamic import resolves and BEFORE `DailyProvider`
 * mounts. `dailySpies.startCamera` is the proof: the frame calls it the instant it mounts, so
 * "never called" means the vendor SDK never saw a rejected grant at all — a stronger statement
 * than "the notice card rendered".
 */

vi.mock('@daily-co/daily-react', async () => {
  const { dailyReactModuleMock } = await import('@/test/mocks/daily');
  return dailyReactModuleMock();
});

vi.mock('motion/react', async () => {
  const { createMotionStub } = await import('@/test/motion-stub');
  return createMotionStub();
});

// jsdom has no `matchMedia`; the repo's convention (7 existing call sites) is to mock the hook.
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }));

// BAL-134 — a refused end speaks through a toast, and this bare mount refuses by construction.
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const PROPS = {
  roomUrl: 'https://balo.daily.co/balo-0f7b1c2d3e4f4a5b8c9d0e1f2a3b4c5d',
  token: 'daily.jwt.super.secret.value',
  isOwner: true,
  /**
   * BAL-134 / ADR-1049 (D3) — ⚠⚠ **THE SIXTH GRANT FIELD, AND THE ONE THE END CONTROL READS.**
   * It is a SEPARATE boolean from `isOwner` on purpose: `isOwner` is the only input to the Daily
   * `is_owner` token property, so widening it to cover the paying client would mint vendor-level
   * owner tokens for the client side. Every fixture below therefore sets the two independently.
   */
  canEndMeeting: true,
  expiresAt: '2026-09-02T11:00:00.000Z',
  participantId: 'u0f7b1c2d3e4f4a5b8c9d0e1f2a3b4c5d',
};

/**
 * Mount the surface and drive it all the way into the call.
 *
 * The frame opens on PreJoin (`hasJoined` is false), and PreJoin suppresses the top bar and the
 * toolbar — so the host controls do not exist until someone actually joins. Pressing "Join now"
 * is therefore part of reaching the state under test, not incidental setup.
 *
 * ⚠ TAKES AN OVERRIDE BAG, not a bare `isOwner`, because BAL-134 made the two host-shaped
 * booleans independent — several cases below need to vary one while pinning the other.
 */
async function renderJoined(overrides: Partial<typeof PROPS> = {}): Promise<HTMLElement> {
  const user = userEvent.setup();
  const { container } = render(<MeetingCallSurface {...PROPS} {...overrides} />);

  // ⚠ SCOPED WITH `within`, never with `screen`: a test that renders BOTH variants to compare
  // them has two "Leave" buttons in the document, and a `screen` query would throw on the
  // ambiguity rather than assert the difference.
  const scope = within(container);
  // ⚠ AN EXPLICIT TIMEOUT, because this waits on a REAL `next/dynamic` chunk resolving and then
  // on the join promise. Testing Library's 1000ms default is enough when this file runs alone
  // and NOT enough when the full suite saturates the worker pool — which shows up as a flake
  // that only ever reproduces in CI.
  const timeout = { timeout: 15_000 };
  await user.click(await scope.findByRole('button', { name: 'Join now' }, timeout));
  await scope.findByRole('button', { name: 'Leave' }, timeout);
  return container;
}

beforeEach(() => {
  resetDailyMock();
  installMediaStubs();
  globalThis.localStorage.clear();
  vi.mocked(track).mockClear();
  vi.mocked(toast.error).mockClear();
});

describe('MeetingCallSurface — the loading seam (BAL-132, still true)', () => {
  it('renders the Connecting state', () => {
    render(<MeetingCallSurface {...PROPS} />);

    expect(screen.getByText(/connecting/i)).toBeInTheDocument();
  });

  it('announces itself to assistive tech via <output>, not role="status"', () => {
    // ⚠ `<output>`, not `role="status"` — SonarCloud S6819 flags the ARIA role where a native
    // element exists.
    const { container } = render(<MeetingCallSurface {...PROPS} />);

    const region = container.querySelector('output');
    expect(region).not.toBeNull();
    expect(region?.textContent ?? '').toMatch(/you.?re in/i);
  });

  it('⚠⚠ carries NO aria-busy on the live region — it would SUPPRESS its own announcement', () => {
    // A hardcoded `aria-busy="true"` that never cleared told assistive tech to suppress this
    // region's announcements — so a screen-reader user was admitted to a call and heard
    // NOTHING. The decorative spinner wrapper is where a busy signal belongs.
    const { container } = render(<MeetingCallSurface {...PROPS} />);

    expect(container.querySelector('output')?.getAttribute('aria-busy')).toBeNull();
  });
});

describe('MeetingCallSurface — ⚠⚠ the credential never reaches the DOM, loading OR mounted', () => {
  it('⚠⚠ NEVER renders the Daily JWT, the room URL or the participant id (loading)', () => {
    // The token is a LIVE credential to a private room.
    const { container } = render(<MeetingCallSurface {...PROPS} />);
    const text = container.textContent ?? '';

    expect(text).not.toContain(PROPS.token);
    expect(text).not.toContain(PROPS.roomUrl);
    expect(text).not.toContain(PROPS.participantId);
  });

  it('⚠ puts nothing sensitive in the MARKUP either — not just the visible text (loading)', () => {
    // A credential in a `data-` attribute or a hidden input is just as leaked as one in a
    // paragraph, and is exactly the shape a "helpful" debugging attribute takes.
    const { container } = render(<MeetingCallSurface {...PROPS} />);

    expect(container.innerHTML).not.toContain(PROPS.token);
    expect(container.innerHTML).not.toContain(PROPS.roomUrl);
  });

  it('⚠⚠ EXTENDED — still holds once the whole frame is mounted and joined', async () => {
    const container = await renderJoined();

    // Text, markup and every attribute value in the live call surface.
    expect(container.textContent ?? '').not.toContain(PROPS.token);
    expect(container.innerHTML).not.toContain(PROPS.token);
    expect(container.innerHTML).not.toContain(PROPS.roomUrl);
    expect(container.innerHTML).not.toContain(PROPS.participantId);
  });

  it('⚠⚠ and never puts one in an analytics property either', async () => {
    await renderJoined();

    for (const [, properties] of vi.mocked(track).mock.calls) {
      const serialised = JSON.stringify(properties ?? {});
      expect(serialised).not.toContain(PROPS.token);
      expect(serialised).not.toContain(PROPS.roomUrl);
      expect(serialised).not.toContain(PROPS.participantId);
    }
  });

  it('hands the validated url and token to daily.join() and to nothing else', async () => {
    await renderJoined();

    expect(dailySpies.join).toHaveBeenCalledWith(
      expect.objectContaining({ url: PROPS.roomUrl, token: PROPS.token })
    );
  });

  it('⚠⚠ broadcasts NO userData — the participant id IS the raw Balo users.id', async () => {
    await renderJoined();

    // Decision-1 encodes `users.id` as `'u'` + 32 hex, and Daily SYNCS `userData` to every
    // participant in the room, including anonymous lobby guests. Nothing consumed it —
    // `meeting-presence.ts` states identity comes from the token claim and "never from Daily
    // userData" — so it was a second, needless channel for an internal identifier.
    const [joinArgs] = dailySpies.join.mock.calls.at(0) ?? [];
    expect(joinArgs).toBeDefined();
    expect(JSON.stringify(joinArgs ?? {})).not.toContain(PROPS.participantId);
    expect(Object.keys((joinArgs ?? {}) as Record<string, unknown>)).not.toContain('userData');
  });
});

describe('MeetingCallSurface — ⚠⚠ REPLACES the BAL-132 "gates nothing" assertion', () => {
  it('⚠⚠ the MOUNTED frame DIFFERS by canEndMeeting — this build gates the end control', async () => {
    // ⚠ THE ASSERTION THIS TICKET EXISTS FOR. Its predecessor asserted `owner === guest`, which
    // was correct for a build with no host controls and would have passed VACUOUSLY here (jsdom
    // renders only the owner-agnostic `loading:` fallback synchronously).
    //
    // ⚠ BAL-134 CHANGED ITS SUBJECT FROM `isOwner` TO `canEndMeeting`, not its shape.
    const ender = await renderJoined();
    const enderMarkup = ender.innerHTML;
    // The end-authority holder gets the split control; everyone else gets one plain Leave button.
    expect(within(ender).getByRole('button', { name: 'Leaving options' })).toBeInTheDocument();

    const participant = await renderJoined({ canEndMeeting: false });

    expect(within(participant).queryByRole('button', { name: 'Leaving options' })).toBeNull();
    expect(participant.innerHTML).not.toBe(enderMarkup);
  });

  it('⚠⚠ a viewer without canEndMeeting has NO end-for-everyone anywhere in the frame', async () => {
    const container = await renderJoined({ canEndMeeting: false });

    expect(screen.queryByRole('button', { name: 'Leaving options' })).toBeNull();
    // Absent, not disabled. `leave-control.test.tsx` carries the exhaustive version.
    expect(container.textContent ?? '').not.toMatch(/end the call/i);
  });

  /**
   * BAL-134 / ADR-1049 (D3) — ⚠⚠ **THE TWO BOOLEANS ARE NOT INTERCHANGEABLE, IN EITHER
   * DIRECTION**, and this pair is what stops the "they're always the same, just merge them"
   * refactor that D3 exists to forbid.
   *
   * `isOwner` is `hasEngagementCapability(HOST_MEETINGS)` and is the ONE input to the Daily
   * `is_owner` token property; `canEndMeeting` is `isOwner || clientPrincipal`, composed
   * server-side in `authorize-end-meeting.ts`, and reaches a Daily token nowhere. A merge in
   * either direction is a real defect: merging INTO `isOwner` mints vendor-level owner tokens
   * (eject, recording control) for the paying side, and merging INTO `canEndMeeting` denies the
   * client principal the ability to stop their own per-minute spend.
   */
  it('⚠⚠ isOwner alone does NOT open the end control — the gate is canEndMeeting', async () => {
    const container = await renderJoined({ isOwner: true, canEndMeeting: false });

    expect(within(container).queryByRole('button', { name: 'Leaving options' })).toBeNull();
    expect(within(container).getByRole('button', { name: 'Leave' })).toBeInTheDocument();
  });

  it('⚠⚠ canEndMeeting alone DOES open it — the client principal is never an owner', async () => {
    // The client-principal arm: `CONSUME_CREDITS` on the booking company, no host capability and
    // therefore no Daily owner token. This actor may still stop the meter.
    const container = await renderJoined({ isOwner: false, canEndMeeting: true });

    expect(within(container).getByRole('button', { name: 'Leaving options' })).toBeInTheDocument();
  });

  /**
   * BAL-134 / ADR-1049 — ⚠⚠ **ENDING IS A SERVER ACT, AND THIS SEAM WIRES NO ROUTE CONTEXT.**
   *
   * BAL-435 asserted here that pressing End ejected everyone locally. That is no longer the act:
   * the eject revokes no token, so it left an "ended" call anybody could rejoin. End now calls
   * `POST /meetings/:meetingId/end` — which closes the presence intervals, writes `status='ended'`
   * and DELETES the Daily room — and the local eject runs ONLY on that call's success, purely for
   * immediacy.
   *
   * ⚠ THIS FILE MOUNTS THE SURFACE BARE, exactly as the two PUBLIC `/join/*` routes do, so
   * `route.endMeeting` is `null` STRUCTURALLY. The assertion that belongs here is therefore the
   * fail-closed one: no wired action ⇒ no local teardown. The full success/refusal/idempotent
   * pipeline lives in `meeting-frame-impl.test.tsx`, which mounts the provider.
   */
  it('⚠⚠ pressing End with NO wired action ejects NOBODY — it never falls back to a local eject', async () => {
    const user = userEvent.setup();
    await renderJoined();

    await user.click(screen.getByRole('button', { name: 'Leaving options' }));
    await user.click(await screen.findByRole('button', { name: 'End the call for everyone' }));
    await user.click(await screen.findByRole('button', { name: 'End for everyone' }));

    await waitFor(() => {
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith(END_MEETING_FAILED_COPY);
    });
    // ⚠ `updateParticipants` is SYNCHRONOUS in daily-js — it returns the call object, not a
    // promise. Awaiting it or chaining `.catch` would be a type error, not a robustness win.
    expect(dailySpies.updateParticipants).not.toHaveBeenCalled();
    expect(dailySpies.leave).not.toHaveBeenCalled();
  });

  it('⚠ a viewer without end authority can never trigger the eject, by any path', async () => {
    const user = userEvent.setup();
    await renderJoined({ canEndMeeting: false });

    await user.click(screen.getByRole('button', { name: 'Leave' }));

    expect(dailySpies.updateParticipants).not.toHaveBeenCalled();
    expect(dailySpies.leave).toHaveBeenCalled();
  });
});

describe('MeetingCallSurface — ⚠⚠ the grant gate runs BEFORE the vendor SDK exists', () => {
  const REJECTIONS: ReadonlyArray<{
    label: string;
    props: Partial<typeof PROPS>;
    reason: string;
  }> = [
    {
      label: 'an http room url',
      props: { roomUrl: 'http://balo.daily.co/x' },
      reason: 'url_scheme',
    },
    {
      label: 'a look-alike host',
      props: { roomUrl: 'https://evildaily.co/room' },
      reason: 'url_host',
    },
    {
      label: 'a subdomain-suffix impostor',
      props: { roomUrl: 'https://daily.co.evil.com/room' },
      reason: 'url_host',
    },
    { label: 'an unparseable url', props: { roomUrl: 'not-a-url' }, reason: 'url_parse' },
    {
      label: 'a bare uuid participant id',
      props: { participantId: '0f7b1c2d-3e4f-4a5b-8c9d-0e1f2a3b4c5d' },
      reason: 'participant_id',
    },
    { label: 'a nonsense expiry', props: { expiresAt: 'soon' }, reason: 'expires_at' },
    { label: 'an empty token', props: { token: '' }, reason: 'shape' },
  ];

  for (const { label, props, reason } of REJECTIONS) {
    it(`refuses ${label}, and the SDK is never reached`, async () => {
      render(<MeetingCallSurface {...PROPS} {...props} />);

      expect(screen.getByRole('heading', { name: JOIN_UNAVAILABLE_TITLE })).toBeInTheDocument();
      // ⚠ THE REAL PROOF. The frame calls `startCamera()` the instant it mounts, so this being
      // untouched means the dynamic import never resolved and Daily never saw the grant.
      await waitFor(() => {
        expect(dailySpies.startCamera).not.toHaveBeenCalled();
      });
      expect(dailySpies.join).not.toHaveBeenCalled();
      expect(screen.queryByText(/connecting/i)).toBeNull();
    });

    it(`observes ${label} as "${reason}" — a code, never the offending value`, () => {
      render(<MeetingCallSurface {...PROPS} {...props} />);

      expect(track).toHaveBeenCalledWith(MEETING_CALL_EVENTS.GRANT_REJECTED, { reason });
    });
  }

  it('⚠ says nothing about WHY — no parse error, no offending value, no retry', () => {
    const { container } = render(
      <MeetingCallSurface {...PROPS} roomUrl="https://evil.example/x" />
    );

    const text = container.textContent ?? '';
    expect(text).not.toContain('evil.example');
    expect(text).not.toMatch(/invalid|malformed|parse/i);
    expect(screen.queryByRole('button', { name: /try again|retry/i })).toBeNull();
  });

  it('⚠⚠ does NOT gate on an EXPIRED grant — eject_at_token_exp is false, so expiry ejects nobody', async () => {
    // An expiring token prevents a FRESH join; it does not end a call in progress. Refusing to
    // mount here would throw somebody out of a live conversation for no reason.
    render(<MeetingCallSurface {...PROPS} expiresAt="2020-01-01T00:00:00.000Z" />);

    expect(await screen.findByRole('button', { name: 'Join now' })).toBeInTheDocument();
  });

  it('a valid grant mounts the frame', async () => {
    render(<MeetingCallSurface {...PROPS} />);

    expect(await screen.findByRole('button', { name: 'Join now' })).toBeInTheDocument();
    expect(track).not.toHaveBeenCalledWith(MEETING_CALL_EVENTS.GRANT_REJECTED, expect.anything());
  });
});

describe('MeetingCallSurface — accessibility', () => {
  it('has no accessibility violations (loading)', async () => {
    const { container } = render(<MeetingCallSurface {...PROPS} />);

    expect(await axe(container)).toHaveNoViolations();
  });

  it('has no accessibility violations (rejected grant)', async () => {
    const { container } = render(
      <MeetingCallSurface {...PROPS} roomUrl="https://evil.example/x" />
    );

    expect(await axe(container)).toHaveNoViolations();
  });

  it('⚠ EXTENDED — has no accessibility violations once mounted and joined', async () => {
    const container = await renderJoined();

    expect(await axe(container)).toHaveNoViolations();
  });

  it('⚠⚠ EXTENDED — carries NO aria-busy ANYWHERE in the mounted frame', async () => {
    const container = await renderJoined();

    expect(container.querySelectorAll('[aria-busy]')).toHaveLength(0);
  });

  it('⚠ renders exactly ONE <h1> in the joined state', async () => {
    const container = await renderJoined();

    expect(container.querySelectorAll('h1')).toHaveLength(1);
  });

  it('⚠ and exactly one in PreJoin too — the frame must never render two', async () => {
    const { container } = render(<MeetingCallSurface {...PROPS} />);

    await screen.findByRole('button', { name: 'Join now' });
    expect(container.querySelectorAll('h1')).toHaveLength(1);
  });
});

describe('MeetingCallSurface — the frame’s own states', () => {
  it('⚠ a failed join is FATAL and offers a retry, never a crash', async () => {
    dailyState.joinRejects = true;
    const user = userEvent.setup();
    render(<MeetingCallSurface {...PROPS} />);

    await user.click(await screen.findByRole('button', { name: 'Join now' }));

    expect(
      await screen.findByRole('heading', { name: JOIN_TEMPORARILY_UNAVAILABLE_TITLE })
    ).toBeInTheDocument();
    expect(track).toHaveBeenCalledWith(
      MEETING_CALL_EVENTS.ERROR,
      expect.objectContaining({ code: 'join_failed' })
    );
  });

  it('⚠ observes the failure by a CODE — never the vendor message, the token or the room url', async () => {
    dailyState.joinRejects = true;
    const user = userEvent.setup();
    render(<MeetingCallSurface {...PROPS} />);

    await user.click(await screen.findByRole('button', { name: 'Join now' }));
    await screen.findByRole('heading', { name: JOIN_TEMPORARILY_UNAVAILABLE_TITLE });

    const errorCalls = vi
      .mocked(track)
      .mock.calls.filter(([event]) => event === MEETING_CALL_EVENTS.ERROR);
    expect(errorCalls.length).toBeGreaterThan(0);
    for (const [, properties] of errorCalls) {
      expect(JSON.stringify(properties ?? {})).not.toContain('join failed');
    }
  });

  it('⚠ the empty stage is the WAITING state — you are here and nobody else is', async () => {
    await renderJoined();

    // ⚠ AND THE STAGE OWNS THE ONLY `<h1>` HERE. The top bar renders its title as a `<p>` in this
    // state; two `<h1>`s would give a screen-reader user two competing answers to "what is this".
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/waiting for/i);
  });

  it('⚠ ruling R4 — the clock says Live once joined, and shows no duration', async () => {
    const container = await renderJoined();

    expect(screen.getByText('Live')).toBeInTheDocument();
    expect(container.textContent ?? '').not.toMatch(/\d{2}:\d{2}/);
  });

  it('⚠ the roster chip is ABSENT while the count is unavailable — never a lone glyph', async () => {
    const container = await renderJoined();

    // The guests endpoint that produces the SEAT count belongs to BAL-436, so the count is `null`
    // on EVERY render today. A numberless, unclickable `Users` icon is not "a badge that renders
    // nothing" — it is a decoration that reads as a control that broke. No zero, no dash, no
    // glyph: the slot is simply not part of this call yet.
    expect(screen.queryByTestId('meeting-roster')).toBeNull();
    expect(container.textContent ?? '').not.toMatch(/of 10/i);
  });
});
