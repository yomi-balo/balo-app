import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { deriveDrawdownState, type DrawdownState } from '@balo/shared/credit';
import { MEETING_CALL_EVENTS, track } from '@/lib/analytics';
import { validateGrant, type ValidatedGrant } from '@/lib/meetings/validate-grant';
import { MeetingRouteContextProvider } from '@/lib/meetings/meeting-route-context';
import { END_MEETING_FAILED_COPY, type EndMeetingResult } from '@/lib/meetings/meeting-state';
import type {
  GetMeetingDrawdownResult,
  MeetingPanelRegistration,
} from '@/lib/meetings/meeting-panels';
import {
  CLIENT_WAITING_BODY,
  NEUTRAL_WAITING_COPY,
  UNKNOWN_WAITING_FACTS,
  waitingCopyFor,
} from '@/lib/meetings/waiting-copy';
import {
  dailySpies,
  dailyState,
  emitDailyEvent,
  installMediaStubs,
  resetDailyMock,
} from '@/test/mocks/daily';
import { CALL_ENDED_TITLE, CALL_LEFT_TITLE } from './meeting-notices';
import { SKIP_PREJOIN_STORAGE_KEY } from './prejoin';
import { MeetingFrame } from './meeting-frame-impl';

/**
 * BAL-435 — the frame's own state machine.
 *
 * ── ⚠⚠ WHY `left-meeting` IS THE FIRST THING THIS FILE FIRES ────────────────────────────────
 *
 * `exit()` and the `left-meeting` handler both used to do nothing but `setHasJoined(false)`,
 * which returned the frame to **PreJoin** — a live "Join now" button wired to `join()` with the
 * SAME still-valid token. A client-side eject revokes no token (`ban:true` is BAL-436's), so
 * "End for everyone" was undone by one click. Worse: `hasJoined` is a dependency of the
 * skip-prejoin effect, so anyone carrying the "Skip this next time" preference was silently
 * rejoined **within one render tick, with no interaction at all**, camera and microphone on,
 * while the host had already navigated away believing the call was over.
 *
 * The mock has always exposed `emitDailyEvent`; nothing fired it, which is exactly why the defect
 * shipped green.
 *
 * ── ⚠⚠ AND WHY THE WAITING COPY IS TESTED PER VIEWER (ruling R10) ───────────────────────────
 *
 * The stage hard-coded `absentParty="expert"` for every viewer, so an EXPERT alone in the room
 * read the CLIENT's "You won't be charged for waiting" — meaningless to the person being paid,
 * and the precise misreading BAL-134 says costs them a settlement they had already earned.
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

// BAL-134 — the end action's FAILURE arm is a toast, and it is the only voice that arm has.
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const RAW_GRANT = {
  roomUrl: 'https://balo.daily.co/balo-0f7b1c2d3e4f4a5b8c9d0e1f2a3b4c5d',
  token: 'daily.jwt.super.secret.value',
  isOwner: false,
  /**
   * BAL-134 / ADR-1049 (D3) — ⚠ THE END-AUTHORITY VERDICT, SEPARATE FROM `isOwner`. Defaulting
   * to `false` keeps "no end control" the fixture's baseline, so a test that wants one has to
   * ask for it — the same fail-closed posture the route context takes with `panels`.
   */
  canEndMeeting: false,
  expiresAt: '2026-09-02T11:00:00.000Z',
  participantId: 'u0f7b1c2d3e4f4a5b8c9d0e1f2a3b4c5d',
};

function grantFor(overrides: Partial<typeof RAW_GRANT> = {}): ValidatedGrant {
  const result = validateGrant({ ...RAW_GRANT, ...overrides });
  if (!result.ok) throw new Error('fixture grant must validate');
  return result.grant;
}

/**
 * BAL-436 — a panel registration whose actions resolve immediately with an empty roster.
 *
 * ⚠ THE PANELS THEMSELVES ARE TESTED IN THEIR OWN FILES. What this file holds is the FRAME's
 * half: registered means openable, the toggle closes, focus returns, and a terminal frame
 * closes the panel.
 */
function panelsFake(): MeetingPanelRegistration {
  return {
    joinLinkUrl: 'https://balo.test/join/m/0f7b1c2d-3e4f-4a5b-8c9d-0e1f2a3b4c5d',
    loadGuests: vi.fn().mockResolvedValue({
      success: true,
      data: { guests: [], canHost: false, participantCount: 2, participantCap: 10 },
    }),
    inviteGuests: vi.fn(),
    decideAdmission: vi.fn(),
    resendLink: vi.fn(),
    files: {
      list: vi.fn().mockResolvedValue({ success: true, files: [] }),
      requestUpload: vi.fn(),
      confirmUpload: vi.fn(),
      download: vi.fn(),
    },
    // BAL-403 — explicit `null`, matching the shipped "inert by default" registration. Without
    // this, the fixture's missing `balance` key is `undefined`, and `!== null` reads that as
    // registered — a false positive this ticket's own tests would otherwise fall into.
    balance: null,
  } as unknown as MeetingPanelRegistration;
}

const DRAWDOWN_NOW = new Date('2026-07-16T12:00:00.000Z');

/** BAL-403 — a `DrawdownState` built off the real projection, so the fixture stays honest. */
function drawdownStateFor(
  overrides: Partial<Parameters<typeof deriveDrawdownState>[0]> = {}
): DrawdownState {
  return deriveDrawdownState({
    status: 'active',
    connectedAt: new Date('2026-07-16T11:58:00.000Z'),
    clientRateMinorPerMinute: 450,
    effectiveCeilingMinor: 15000,
    graceBoundMinutes: 30,
    graceEnteredAt: null,
    balanceMinor: 45000,
    mandatePresent: true,
    lens: 'client',
    // BAL-412 — the billing floor in force + nothing drawn yet; unrelated to this panel's own
    // assertions.
    billingFloorMinutes: 15,
    minutesAlreadyDrawn: 0,
    now: DRAWDOWN_NOW,
    ...overrides,
  });
}

/**
 * BAL-403 — `panelsFake()` plus a registered Balance slot whose poll resolves to `result` on
 * every call (a single fixed answer is enough: these tests only exercise the FIRST, immediate
 * read on mount, never the schedule).
 */
function panelsFakeWithBalance(result: GetMeetingDrawdownResult): MeetingPanelRegistration {
  return {
    ...panelsFake(),
    balance: { loadDrawdownState: vi.fn().mockResolvedValue(result) },
  } as unknown as MeetingPanelRegistration;
}

interface RouteOptions {
  readonly onExit?: (reason: string) => void;
  /** ⚠ ABSENT ⇒ THE SLOT IS UNREGISTERED, which is what both guest mounts read. */
  readonly panels?: MeetingPanelRegistration;
  readonly waiting?: {
    absentParty: 'expert' | 'client';
    counterpartyFirstName: string;
    scheduledStartLabel: string;
  } | null;
  /**
   * BAL-134 — ⚠ ABSENT ⇒ NO END ACTION IS WIRED, which is what both guest mounts read
   * structurally. The frame refuses to fall back to a local eject when this is `null`, so a
   * test that drives End must supply it.
   */
  readonly endMeeting?: (() => Promise<EndMeetingResult>) | null;
}

/**
 * The MEMBER mount: a route provider, with a destination and (optionally) a waiting subject.
 *
 * ⚠ THE SECOND ARGUMENT IS `canEndMeeting`, NOT `isOwner` — BAL-134 moved the End control onto
 * the second grant boolean, and `isOwner` (which mints the Daily owner token) gates nothing in
 * this frame beyond the `is_owner` analytics property.
 */
function renderMember(options: RouteOptions = {}, canEndMeeting = false): HTMLElement {
  return render(
    <MeetingRouteContextProvider
      meetingId="0f7b1c2d-3e4f-4a5b-8c9d-0e1f2a3b4c5d"
      viewerName="Dana Okoro"
      title="Salesforce flow review"
      backTo={{ label: 'Back to the case', href: '/consultations' }}
      contextNoun="case"
      waiting={options.waiting ?? null}
      onExit={options.onExit}
      panels={options.panels ?? null}
      endMeeting={options.endMeeting ?? null}
    >
      <MeetingFrame grant={grantFor({ canEndMeeting })} />
    </MeetingRouteContextProvider>
  ).container;
}

/** ⚠ THE GUEST MOUNT: no provider at all, so no destination and no waiting subject exist. */
function renderGuest(): HTMLElement {
  return render(<MeetingFrame grant={grantFor()} />).container;
}

async function join(): Promise<void> {
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Join now' }));
  await screen.findByRole('button', { name: 'Leave' });
}

beforeEach(() => {
  resetDailyMock();
  installMediaStubs();
  globalThis.localStorage.clear();
  vi.mocked(track).mockClear();
  vi.mocked(toast.error).mockClear();
});

describe('MeetingFrame — ⚠⚠ the terminal latch', () => {
  it('⚠⚠ an EJECT ends the frame — no PreJoin, and NO way back in', async () => {
    renderMember();
    await join();

    // Nobody asked to leave, so this is an eject or a destroyed room.
    act(() => emitDailyEvent('left-meeting', { action: 'left-meeting' }));

    expect(await screen.findByRole('heading', { name: CALL_ENDED_TITLE })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Join now' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Leave' })).toBeNull();
  });

  it('⚠⚠ routes the member out with `host_ended`, which is what BAL-389 renders', async () => {
    const onExit = vi.fn();
    renderMember({ onExit });
    await join();

    act(() => emitDailyEvent('left-meeting', { action: 'left-meeting' }));

    await waitFor(() => expect(onExit).toHaveBeenCalledWith('host_ended'));
  });

  it('⚠⚠ WITH "skip this next time" SET, an eject does NOT silently rejoin', async () => {
    // ⚠ THE EXACT DEFECT: `hasJoined` flips false on eject, every other guard in the skip effect
    // is clear, and `readSkipPrejoin()` is re-read from localStorage on each run — so the frame
    // rejoined with no user interaction, camera and mic on, into a call the host had ended.
    globalThis.localStorage.setItem(SKIP_PREJOIN_STORAGE_KEY, '1');
    renderMember();
    await screen.findByRole('button', { name: 'Leave' });
    expect(dailySpies.join).toHaveBeenCalledTimes(1);

    act(() => emitDailyEvent('left-meeting', { action: 'left-meeting' }));

    expect(await screen.findByRole('heading', { name: CALL_ENDED_TITLE })).toBeInTheDocument();
    // ⚠ ONE join, for the life of the frame. The one-shot ref is what makes that true.
    await waitFor(() => expect(dailySpies.join).toHaveBeenCalledTimes(1));
  });

  it('⚠⚠ a GUEST — who has no route to be sent to — still cannot rejoin', async () => {
    // On both guest mounts `route.onExit` is undefined, so before the latch a guest was
    // STRUCTURALLY unable to leave: Leave → PreJoin → Join now → Leave, forever.
    renderGuest();
    await join();

    await userEvent.setup().click(screen.getByRole('button', { name: 'Leave' }));

    expect(await screen.findByRole('heading', { name: CALL_LEFT_TITLE })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Join now' })).toBeNull();
  });

  it('⚠ distinguishes OUR OWN leave from an eject — the copy is not the same fact', async () => {
    renderGuest();
    await join();

    await userEvent.setup().click(screen.getByRole('button', { name: 'Leave' }));
    // Daily fires `left-meeting` for our own leave too; it must not be re-read as an eject.
    act(() => emitDailyEvent('left-meeting', { action: 'left-meeting' }));

    expect(screen.getByRole('heading', { name: CALL_LEFT_TITLE })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: CALL_ENDED_TITLE })).toBeNull();
  });

  it('⚠ emits exactly ONE `meeting_call_left`, however many times the event arrives', async () => {
    renderGuest();
    await join();

    await userEvent.setup().click(screen.getByRole('button', { name: 'Leave' }));
    act(() => emitDailyEvent('left-meeting', { action: 'left-meeting' }));
    act(() => emitDailyEvent('left-meeting', { action: 'left-meeting' }));

    const leftCalls = vi
      .mocked(track)
      .mock.calls.filter(([event]) => event === MEETING_CALL_EVENTS.LEFT);
    expect(leftCalls).toHaveLength(1);
  });
});

describe('MeetingFrame — ⚠⚠ the waiting stage names the right party (R10)', () => {
  it('a CLIENT viewer reads the client line — the timer has not started', async () => {
    renderMember({
      waiting: {
        absentParty: 'expert',
        counterpartyFirstName: 'Dana',
        scheduledStartLabel: '10:00 am',
      },
    });
    await join();

    expect(screen.getByText(CLIENT_WAITING_BODY)).toBeInTheDocument();
  });

  it('⚠⚠ an EXPERT viewer is NEVER shown the client billing promise', async () => {
    const container = renderMember({
      waiting: {
        absentParty: 'client',
        counterpartyFirstName: 'Northwind Industrial',
        scheduledStartLabel: '10:00 am',
      },
    });
    await join();

    const expected = waitingCopyFor('client', 'pre-start', {
      counterpartyFirstName: 'Northwind Industrial',
      scheduledStartLabel: '10:00 am',
      // ⚠ THE ROUTE PROVIDER'S DEFAULT: no mirror has landed in this render, so the frame passes
      // `UNKNOWN_WAITING_FACTS` down and the copy must be the one that claims the least.
      ...UNKNOWN_WAITING_FACTS,
    });
    expect(screen.getByText(expected.body)).toBeInTheDocument();
    expect(container.textContent ?? '').not.toContain(CLIENT_WAITING_BODY);
    expect(container.textContent ?? '').not.toMatch(/you won.?t be charged/i);
  });

  it('⚠⚠ a GUEST gets party-neutral copy — no clock, no placeholder literals', async () => {
    const container = renderGuest();
    await join();

    expect(screen.getByText(NEUTRAL_WAITING_COPY.body)).toBeInTheDocument();
    expect(container.textContent ?? '').not.toMatch(/your expert|the scheduled time/i);
    expect(container.textContent ?? '').not.toMatch(/charged|counted/i);
  });
});

describe('MeetingFrame — ⚠ the polite announcer (§16)', () => {
  it('announces the mute state, which nothing else on this surface says out loud', async () => {
    const container = renderMember();
    await join();

    await userEvent.setup().click(screen.getByRole('button', { name: 'Microphone' }));

    const region = container.querySelector('output[aria-live="polite"]');
    await waitFor(() => expect(region?.textContent).toBe('You are muted.'));
  });
});

describe('MeetingFrame — the skip-prejoin path', () => {
  it('⚠ reports `prejoin_skipped` from the DECISION, not from a pill that self-clears', async () => {
    // Reading the pill reported `false` on every join slower than the pill's own 4s life — i.e.
    // on exactly the slow joins this metric exists to measure.
    globalThis.localStorage.setItem(SKIP_PREJOIN_STORAGE_KEY, '1');
    renderMember();
    await screen.findByRole('button', { name: 'Leave' });

    const [, properties] =
      vi.mocked(track).mock.calls.find(([event]) => event === MEETING_CALL_EVENTS.JOINED) ?? [];
    expect(properties).toMatchObject({ prejoin_skipped: true });
  });

  it('⚠ the pill appears only once the join RESOLVES — never over "Ready to join?"', async () => {
    globalThis.localStorage.setItem(SKIP_PREJOIN_STORAGE_KEY, '1');
    renderMember();

    expect(await screen.findByText('Joined with your usual mic and camera.')).toBeInTheDocument();
    // The stage is up by then, so the pill's 4s "Change devices" undo is actually usable.
    expect(screen.getByRole('button', { name: 'Change devices' })).toBeInTheDocument();
  });
});

describe('MeetingFrame — PreJoin has a way out', () => {
  it('⚠ a MEMBER can leave the first screen without joining', async () => {
    renderMember();

    expect(await screen.findByRole('link', { name: 'Back to the case' })).toHaveAttribute(
      'href',
      '/consultations'
    );
  });

  it('⚠⚠ a GUEST is offered no link at all — they have no Balo destination', async () => {
    const container = renderGuest();

    await screen.findByRole('button', { name: 'Join now' });
    expect(container.querySelector('a')).toBeNull();
    expect(container.textContent ?? '').not.toMatch(/dashboard/i);
  });
});

/**
 * BAL-134 / ADR-1049 — ⚠⚠ **THE END IS A SERVER ACT NOW, AND THE LOCAL EJECT ONLY FOLLOWS IT.**
 *
 * BAL-435 shipped this as `updateParticipants({ '*': { eject: true } })` alone, and per the
 * `daily-co` skill's own trap list an eject revokes no token — so a disconnected participant
 * holding a live one could rejoin a room nothing had closed. The act is now
 * `POST /meetings/:meetingId/end`, and the eject exists purely so the other screens change
 * immediately rather than a round trip later. The ORDER is the safety property: ejecting
 * optimistically would throw everybody out of a call the server never ended.
 */
describe('MeetingFrame — the host end, and its pending state', () => {
  /** Drive the confirm all the way through to the destructive button. */
  async function pressEndForEveryone(user: ReturnType<typeof userEvent.setup>): Promise<void> {
    await user.click(screen.getByRole('button', { name: 'Leaving options' }));
    await user.click(await screen.findByRole('button', { name: 'End the call for everyone' }));
    await user.click(await screen.findByRole('button', { name: 'End for everyone' }));
  }

  it('⚠ shows "Ending…" while the leave runs, then lands on the terminal card', async () => {
    // ⚠ `isEnding` used to be set true and false in the same synchronous block, so the pending
    // label was unreachable in production and the confirm dialog only ever went away because
    // navigation unmounted it.
    let releaseLeave = (): void => {};
    dailySpies.leave.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseLeave = () => resolve();
        })
    );
    const user = userEvent.setup();
    const endMeeting = vi
      .fn<() => Promise<EndMeetingResult>>()
      .mockResolvedValue({ success: true, alreadyEnded: false });
    renderMember({ endMeeting }, true);
    await join();

    await pressEndForEveryone(user);

    expect(await screen.findByRole('button', { name: 'Ending…' })).toBeDisabled();
    await waitFor(() => {
      expect(dailySpies.updateParticipants).toHaveBeenCalledWith({ '*': { eject: true } });
    });
    expect(endMeeting).toHaveBeenCalledTimes(1);

    await act(async () => {
      releaseLeave();
    });

    expect(await screen.findByRole('heading', { name: CALL_ENDED_TITLE })).toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('⚠⚠ `alreadyEnded` IS A SUCCESS (D10) — a lost race is not a red toast', async () => {
    // Two `canEndMeeting` holders can press End in the same instant; the server's transition is
    // a compare-and-set and the loser's `200` is the correct answer.
    const user = userEvent.setup();
    renderMember(
      { endMeeting: () => Promise.resolve({ success: true, alreadyEnded: true }) },
      true
    );
    await join();

    await pressEndForEveryone(user);

    expect(await screen.findByRole('heading', { name: CALL_ENDED_TITLE })).toBeInTheDocument();
    expect(vi.mocked(toast.error)).not.toHaveBeenCalled();
  });

  it('⚠⚠ A REFUSED END EJECTS NOBODY — the call is still running, and it says so', async () => {
    const user = userEvent.setup();
    renderMember(
      { endMeeting: () => Promise.resolve({ success: false, error: END_MEETING_FAILED_COPY }) },
      true
    );
    await join();

    await pressEndForEveryone(user);

    await waitFor(() => {
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith(END_MEETING_FAILED_COPY);
    });
    // ⚠ THE WHOLE POINT: no local teardown ran, so everyone is still in the call they are in.
    expect(dailySpies.updateParticipants).not.toHaveBeenCalled();
    expect(dailySpies.leave).not.toHaveBeenCalled();
    expect(screen.queryByRole('heading', { name: CALL_ENDED_TITLE })).toBeNull();
  });

  it('⚠⚠ NO WIRED END ACTION ⇒ NO FALLBACK EJECT — it must not re-create the old defect', async () => {
    // `route.endMeeting === null` is structurally true on both GUEST mounts and is a wiring bug
    // anywhere else. Falling back to the local-only eject would restore exactly the rejoinable
    // "ended" call BAL-134 removes.
    const user = userEvent.setup();
    renderMember({}, true);
    await join();

    await pressEndForEveryone(user);

    await waitFor(() => {
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith(END_MEETING_FAILED_COPY);
    });
    expect(dailySpies.updateParticipants).not.toHaveBeenCalled();
  });

  /**
   * BAL-134 — ⚠⚠ **THE SILENT NO-OP ARM.**
   *
   * `if (daily === null || !grant.canEndMeeting) return;` returned WITHOUT a toast, leaving the
   * confirm dialog open and its button live, while the sibling arm two lines below toasted for
   * exactly the same class of failure. From the person's side all three are one thing — "I asked
   * to end the call and it is still running" — so all three now say so.
   */
  it('⚠⚠ NO CALL OBJECT ⇒ IT SAYS SO — it does not fail silently under an open confirm', async () => {
    const user = userEvent.setup();
    const endMeeting = vi
      .fn<() => Promise<EndMeetingResult>>()
      .mockResolvedValue({ success: true, alreadyEnded: false });
    renderMember({ endMeeting }, true);
    await join();

    // The call object goes away mid-call — the guard's real-world shape. The mock reads the flag
    // on every render, so a HANDLED event is needed to force one; a blip and its recovery leave
    // no other visible state behind.
    dailyState.callObjectAbsent = true;
    act(() => emitDailyEvent('network-connection', { event: 'interrupted' }));
    act(() => emitDailyEvent('network-connection', { event: 'connected' }));

    await pressEndForEveryone(user);

    await waitFor(() => {
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith(END_MEETING_FAILED_COPY);
    });
    // ⚠ AND IT STILL DOES NOT HALF-END THE CALL.
    expect(endMeeting).not.toHaveBeenCalled();
    expect(dailySpies.updateParticipants).not.toHaveBeenCalled();
  });

  it('⚠⚠ WITHOUT canEndMeeting THE CONTROL IS ABSENT — nothing to press, nothing to refuse', async () => {
    const endMeeting = vi
      .fn<() => Promise<EndMeetingResult>>()
      .mockResolvedValue({ success: true, alreadyEnded: false });
    renderMember({ endMeeting });
    await join();

    expect(screen.queryByRole('button', { name: 'Leaving options' })).toBeNull();
    expect(endMeeting).not.toHaveBeenCalled();
  });
});

/**
 * BAL-436 — ⚠⚠ THE SIDE-PANEL SLOT, AT THE FRAME.
 *
 * `panels === null` means NO toolbar buttons, NO More-sheet rows, NO seat chip, NO interactive
 * overflow tile and NO panel. Not disabled — ABSENT. Both GUEST mounts read `null`
 * STRUCTURALLY, because neither mounts the route context at all.
 */
describe('MeetingFrame — the side panel (BAL-436)', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'matchMedia', {
      writable: true,
      configurable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
    });
  });

  it('⚠⚠ THE GUEST MOUNT HAS NO SLOT AT ALL — structurally, with no check anywhere', async () => {
    renderGuest();
    await join();

    expect(screen.queryByRole('button', { name: 'People' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Files' })).toBeNull();
    expect(screen.queryByTestId('meeting-roster')).toBeNull();
    expect(screen.queryByTestId('meeting-side-panel')).toBeNull();
  });

  it('⚠ a MEMBER mount with NO registration is equally absent — the default is fail-closed', async () => {
    renderMember();
    await join();

    expect(screen.queryByRole('button', { name: 'People' })).toBeNull();
    expect(screen.queryByTestId('meeting-roster')).toBeNull();
  });

  it('opens the People panel from the toolbar', async () => {
    const user = userEvent.setup();
    renderMember({ panels: panelsFake() });
    await join();

    await user.click(screen.getByRole('button', { name: 'People' }));

    expect(await screen.findByRole('heading', { level: 2, name: 'People' })).toBeInTheDocument();
  });

  it('⚠⚠ RE-CLICKING THE OPEN BUTTON CLOSES IT, and focus returns to that button', async () => {
    const user = userEvent.setup();
    renderMember({ panels: panelsFake() });
    await join();

    const peopleButton = screen.getByRole('button', { name: 'People' });
    await user.click(peopleButton);
    await screen.findByRole('heading', { level: 2, name: 'People' });

    await user.click(peopleButton);

    expect(screen.queryByTestId('meeting-side-panel')).toBeNull();
    expect(peopleButton).toHaveFocus();
  });

  it('⚠ CLICKING THE OTHER BUTTON SWITCHES — one slot, no tab strip', async () => {
    const user = userEvent.setup();
    renderMember({ panels: panelsFake() });
    await join();

    await user.click(screen.getByRole('button', { name: 'People' }));
    await screen.findByRole('heading', { level: 2, name: 'People' });
    await user.click(screen.getByRole('button', { name: 'Files' }));

    expect(await screen.findByRole('heading', { level: 2, name: 'Files' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 2, name: 'People' })).toBeNull();
  });

  it('closes from the panel`s own X, returning focus to the opener', async () => {
    const user = userEvent.setup();
    renderMember({ panels: panelsFake() });
    await join();

    const peopleButton = screen.getByRole('button', { name: 'People' });
    await user.click(peopleButton);
    await user.click(await screen.findByRole('button', { name: 'Close people' }));

    expect(screen.queryByTestId('meeting-side-panel')).toBeNull();
    expect(peopleButton).toHaveFocus();
  });

  /**
   * ⚠⚠ THE CHIP MUST NOT WAIT FOR THE PANEL — DISCOVERY WAS CIRCULAR.
   *
   * While `PeoplePanel` was the seat count's only writer, the chip did not exist until People
   * had been opened once. The chip is ALSO the affordance for opening People, so the one
   * control that reveals the roster was hidden until the roster had been reached another way.
   * One read on `hasJoined` breaks the loop; it is a ONE-SHOT, never a poll.
   */
  it('⚠⚠ THE SEAT CHIP APPEARS ON JOIN — before People has ever been opened', async () => {
    const panels = panelsFake();
    renderMember({ panels });
    await join();

    expect(await screen.findByTestId('meeting-roster')).toHaveTextContent('2 of 10');
    // ⚠ EXACTLY ONE READ. A permanently-polling top bar would defeat the panel's own
    // "closed ⇒ paused" cadence bound.
    expect(vi.mocked(panels.loadGuests)).toHaveBeenCalledTimes(1);
  });

  it('⚠ THE SEAT CHIP SURVIVES THE PANEL CLOSING', async () => {
    const user = userEvent.setup();
    renderMember({ panels: panelsFake() });
    await join();

    const peopleButton = screen.getByRole('button', { name: 'People' });
    await user.click(peopleButton);
    expect(await screen.findByTestId('meeting-roster')).toHaveTextContent('2 of 10');

    await user.click(peopleButton);
    expect(screen.getByTestId('meeting-roster')).toHaveTextContent('2 of 10');
  });

  it('⚠ NO CHIP WHEN THE SLOT IS UNREGISTERED — both GUEST mounts, structurally', async () => {
    // ⚠ `panels` OMITTED ⇒ the context reads `null`, which is what both guest mounts get.
    renderMember();
    await join();

    expect(screen.queryByTestId('meeting-roster')).toBeNull();
  });

  it('⚠⚠ A TERMINAL FRAME CLOSES THE PANEL — no live roster on a call that has ended', async () => {
    const user = userEvent.setup();
    renderMember({ panels: panelsFake() });
    await join();

    await user.click(screen.getByRole('button', { name: 'People' }));
    await screen.findByRole('heading', { level: 2, name: 'People' });

    act(() => emitDailyEvent('left-meeting', { action: 'left-meeting' }));

    expect(await screen.findByRole('heading', { name: CALL_ENDED_TITLE })).toBeInTheDocument();
    expect(screen.queryByTestId('meeting-side-panel')).toBeNull();
  });
});

/**
 * BAL-403 — the Balance slot: registered-means-openable (same rule as People/Files), the
 * drawdown poll's immediate mount read, and the auto-open ladder. ⚠ SHIPS INERT — `panels.balance`
 * is `null` for every meeting today; these tests exercise the wiring with a fake registration.
 */
describe('MeetingFrame — the Balance slot (BAL-403)', () => {
  it('⚠ renders NO Balance control when the slot is unregistered (balance: null)', async () => {
    renderMember({ panels: panelsFake() });
    await join();

    expect(screen.queryByRole('button', { name: /balance/i })).toBeNull();
  });

  it('registered + healthy: the button is present, and nothing auto-opens', async () => {
    const panels = panelsFakeWithBalance({
      success: true,
      state: drawdownStateFor(),
      sessionId: 'sess-1',
    });
    renderMember({ panels });
    await join();

    expect(await screen.findByRole('button', { name: 'Balance' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 2, name: 'Balance' })).toBeNull();
  });

  it('⚠⚠ auto-opens on a FIRST escalation with no panel already open', async () => {
    const panels = panelsFakeWithBalance({
      success: true,
      state: drawdownStateFor({ balanceMinor: 3600 }), // 'low'
      sessionId: 'sess-1',
    });
    renderMember({ panels });
    await join();

    expect(await screen.findByRole('heading', { level: 2, name: 'Balance' })).toBeInTheDocument();
  });

  it('⚠⚠ an escalation while People is already open BADGES, never switches — and opening it clears the badge', async () => {
    const user = userEvent.setup();
    let resolveLoad: (result: GetMeetingDrawdownResult) => void = () => {};
    const load = vi.fn(
      () =>
        new Promise<GetMeetingDrawdownResult>((resolve) => {
          resolveLoad = resolve;
        })
    );
    const panels = {
      ...panelsFake(),
      balance: { loadDrawdownState: load },
    } as unknown as MeetingPanelRegistration;
    renderMember({ panels });
    await join();

    // Open People BEFORE the drawdown poll's first answer lands.
    await user.click(screen.getByRole('button', { name: 'People' }));
    await screen.findByRole('heading', { level: 2, name: 'People' });

    // Now let the poll resolve to an escalated key.
    act(() => {
      resolveLoad({
        success: true,
        state: drawdownStateFor({ balanceMinor: 3600 }),
        sessionId: 'sess-1',
      });
    });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Balance, needs attention' })).toBeInTheDocument();
    });
    // ⚠ RULE 3 — NEVER A SWITCH. People stays exactly where it was.
    expect(screen.getByRole('heading', { level: 2, name: 'People' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Balance, needs attention' }));

    expect(await screen.findByRole('heading', { level: 2, name: 'Balance' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Balance, needs attention' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Balance' })).toBeInTheDocument();
  });

  it('⚠⚠ W4 — an escalation that lands while Balance is ALREADY open (manually) is not a steal', async () => {
    const user = userEvent.setup();
    let resolveLoad: (result: GetMeetingDrawdownResult) => void = () => {};
    const load = vi.fn(
      () =>
        new Promise<GetMeetingDrawdownResult>((resolve) => {
          resolveLoad = resolve;
        })
    );
    const panels = {
      ...panelsFake(),
      balance: { loadDrawdownState: load },
    } as unknown as MeetingPanelRegistration;
    renderMember({ panels });
    await join();

    // Balance is registered from the RSC's verdict (structural), so the button is clickable
    // before the poll's first answer lands — open it manually, ahead of any escalation.
    await user.click(await screen.findByRole('button', { name: 'Balance' }));
    await screen.findByRole('heading', { level: 2, name: 'Balance' });

    // Now the poll's first answer is an escalation ('low') — but the panel is ALREADY open.
    act(() => {
      resolveLoad({
        success: true,
        state: drawdownStateFor({ balanceMinor: 3600 }),
        sessionId: 'sess-1',
      });
    });

    // The toolbar button must still say plain "Balance" — the person is already looking at it.
    await screen.findByRole('progressbar');
    expect(screen.queryByRole('button', { name: 'Balance, needs attention' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Balance' })).toBeInTheDocument();
  });
});

describe('MeetingFrame — the Balance slot, ⚠⚠ fix round 1 (W5 — auto-open focus/announce)', () => {
  it('a MANUAL open still focuses the Balance heading', async () => {
    const user = userEvent.setup();
    const panels = panelsFakeWithBalance({
      success: true,
      state: drawdownStateFor(),
      sessionId: 'sess-1',
    });
    renderMember({ panels });
    await join();

    await user.click(await screen.findByRole('button', { name: 'Balance' }));

    expect(await screen.findByRole('heading', { level: 2, name: 'Balance' })).toHaveFocus();
  });

  it('an AUTO-open does NOT steal focus, and announces through the §16 live region instead', async () => {
    const panels = panelsFakeWithBalance({
      success: true,
      state: drawdownStateFor({ balanceMinor: 3600 }), // 'low' — a first, panel-stealing escalation
      sessionId: 'sess-1',
    });
    const container = renderMember({ panels });
    await join();

    const heading = await screen.findByRole('heading', { level: 2, name: 'Balance' });
    expect(heading).not.toHaveFocus();

    const region = container.querySelector('output[aria-live="polite"]');
    await waitFor(() =>
      expect(region?.textContent).toBe(
        'Your balance needs attention. The Balance panel has opened.'
      )
    );
  });

  it('a BADGE escalation past low (e.g. grace) announces once too, without opening anything', async () => {
    let resolveLoad: (result: GetMeetingDrawdownResult) => void = () => {};
    const load = vi.fn(
      () =>
        new Promise<GetMeetingDrawdownResult>((resolve) => {
          resolveLoad = resolve;
        })
    );
    const panels = {
      ...panelsFake(),
      balance: { loadDrawdownState: load },
    } as unknown as MeetingPanelRegistration;
    const user = userEvent.setup();
    const container = renderMember({ panels });
    await join();

    await user.click(screen.getByRole('button', { name: 'People' }));
    await screen.findByRole('heading', { level: 2, name: 'People' });

    act(() => {
      resolveLoad({
        success: true,
        state: drawdownStateFor({
          status: 'grace',
          graceEnteredAt: DRAWDOWN_NOW,
          balanceMinor: -1000,
        }),
        sessionId: 'sess-1',
      });
    });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Balance, needs attention' })).toBeInTheDocument();
    });
    const region = container.querySelector('output[aria-live="polite"]');
    expect(region?.textContent).toBe('Your balance needs attention.');
  });
});

describe('MeetingFrame — the Balance slot, ⚠⚠ fix round 1 (C2 — retry)', () => {
  it('the error card\'s "Try again" button actually re-fetches', async () => {
    const user = userEvent.setup();
    // ⚠ A NON-RETRYABLE VERDICT, not a transport rejection — the poll reaches `status: 'error'`
    // after ONE tick only when the answer is a verdict; a transport blip alone would still read
    // `'loading'` until the failure cap.
    const load = vi.fn().mockResolvedValue({ success: false, error: 'boom', retryable: false });
    const panels = {
      ...panelsFake(),
      balance: { loadDrawdownState: load },
    } as unknown as MeetingPanelRegistration;
    renderMember({ panels });
    await join();

    await user.click(await screen.findByRole('button', { name: 'Balance' }));
    await screen.findByTestId('panel-error');
    expect(load).toHaveBeenCalledTimes(1);

    load.mockResolvedValueOnce({ success: true, state: drawdownStateFor(), sessionId: 'sess-1' });
    await user.click(screen.getByRole('button', { name: 'Try again' }));

    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    await screen.findByRole('progressbar');
  });
});

describe('MeetingFrame — the Balance slot, ⚠⚠ fix round 2 (R3 — the had-state-then-failed path)', () => {
  /**
   * ⚠⚠ THE EXACT GAP THE EXISTING C2 TEST DID NOT COVER — it passed only because ITS failure
   * arrived on the FIRST tick, before `hadStateRef.current` was ever set. This test drives a
   * REAL state in first, so the vanish-close effect's OTHER branch — the one that used to force
   * the panel shut on ANY `state: null`, this failure included — is what actually runs.
   *
   * ⚠ `{ success: false, retryable: false }` is NOT a membership denial — see
   * `resolve-in-call-drawdown.ts`'s docblock and `use-drawdown-poll.ts`'s `applyResult`. A
   * membership / audience denial folds into `{ success: true, state: null }` instead (the SAME
   * shape as a genuine vanish, on the `ready` arm covered by the next test below); THIS shape is
   * what `get-meeting-drawdown-state.ts` emits only when `enterCallAction` itself fails — an
   * expired session, or an invalid `meetingId`.
   *
   * `document.dispatchEvent(new Event('visibilitychange'))` is `useDrawdownPoll`'s OWN
   * "resume with an immediate fetch" path (see its module docblock and
   * `use-drawdown-poll.test.ts`'s visibility suite) — the same mechanism a real second poll tick
   * would use, without waiting on the real 30s/10s schedule.
   */
  it('a FAILURE (expired session / invalid meetingId) after a real state stays OPEN and renders the error card, rather than force-closing with no way back', async () => {
    const user = userEvent.setup();
    const load = vi
      .fn()
      .mockResolvedValueOnce({ success: true, state: drawdownStateFor(), sessionId: 'sess-1' })
      .mockResolvedValue({ success: false, error: 'boom', retryable: false });
    const panels = {
      ...panelsFake(),
      balance: { loadDrawdownState: load },
    } as unknown as MeetingPanelRegistration;
    renderMember({ panels });
    await join();

    await user.click(await screen.findByRole('button', { name: 'Balance' }));
    // ⚠ REAL DATA LANDS FIRST — this is what sets `hadStateRef.current = true`.
    await screen.findByRole('progressbar');
    expect(load).toHaveBeenCalledTimes(1);

    // The "next tick" — a mid-call failure (expired session / invalid meetingId), not a denial.
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));

    // ⚠⚠ THE REGRESSION: round 1 force-closed the panel here — no error card, no way back, and
    // clicking the (still-present) toolbar button re-opened onto the SAME close on the very next
    // render, because the effect re-ran on `panel` changing. The panel must stay OPEN.
    expect(screen.getByRole('heading', { level: 2, name: 'Balance' })).toBeInTheDocument();
    expect(await screen.findByTestId('panel-error')).toBeInTheDocument();

    // ⚠ AND THE RECOVERY PATH C2 SHIPPED IS ACTUALLY REACHABLE FROM HERE.
    load.mockResolvedValueOnce({ success: true, state: drawdownStateFor(), sessionId: 'sess-1' });
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(load).toHaveBeenCalledTimes(3));
    await screen.findByRole('progressbar');
  });

  it('a genuine VANISH (a success answering state: null) still auto-closes exactly as before', async () => {
    const user = userEvent.setup();
    const load = vi
      .fn()
      .mockResolvedValueOnce({ success: true, state: drawdownStateFor(), sessionId: 'sess-1' })
      .mockResolvedValue({ success: true, state: null });
    const panels = {
      ...panelsFake(),
      balance: { loadDrawdownState: load },
    } as unknown as MeetingPanelRegistration;
    renderMember({ panels });
    await join();

    await user.click(await screen.findByRole('button', { name: 'Balance' }));
    await screen.findByRole('progressbar');

    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));

    // The panel closes — `InCallBalancePanel` never needs to render the vanished case at all.
    await waitFor(() =>
      expect(screen.queryByRole('heading', { level: 2, name: 'Balance' })).toBeNull()
    );
  });

  /**
   * ⚠⚠ FIX ROUND 3 — THE GAP NEITHER R2 TEST ABOVE EXERCISED: what happens on a RE-OPEN after
   * the vanish-close fired. `hasBalance` never clears (the RSC registration is static for the
   * call), so the toolbar button survives the vanish — this drives the click and asserts the
   * panel actually opens and stays open, rendering `BalanceUnavailableCard`, instead of the
   * close effect re-firing on the very next commit and stranding the control dead forever.
   */
  it('⚠⚠ a RE-OPEN after a vanish-close opens the panel and renders the unavailable card, rather than force-closing again', async () => {
    const user = userEvent.setup();
    const load = vi
      .fn()
      .mockResolvedValueOnce({ success: true, state: drawdownStateFor(), sessionId: 'sess-1' })
      .mockResolvedValue({ success: true, state: null });
    const panels = {
      ...panelsFake(),
      balance: { loadDrawdownState: load },
    } as unknown as MeetingPanelRegistration;
    renderMember({ panels });
    await join();

    await user.click(await screen.findByRole('button', { name: 'Balance' }));
    await screen.findByRole('progressbar');

    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));

    // The first vanish still auto-closes exactly as before.
    await waitFor(() =>
      expect(screen.queryByRole('heading', { level: 2, name: 'Balance' })).toBeNull()
    );

    // The toolbar button is STILL PRESENT — `hasBalance` never clears on a vanish — and a
    // deliberate re-open must actually open the panel, not close it right back out.
    await user.click(screen.getByRole('button', { name: 'Balance' }));

    expect(await screen.findByRole('heading', { level: 2, name: 'Balance' })).toBeInTheDocument();
    expect(await screen.findByTestId('balance-panel-unavailable')).toBeInTheDocument();
  });
});

describe('MeetingFrame — the Balance slot, ⚠⚠ fix round 2 (R5 — the badge re-arms)', () => {
  it('a SECOND escalation past the threshold, after a de-escalation, announces AGAIN', async () => {
    const user = userEvent.setup();
    // ⚠ TICK 1 IS DEFERRED, exactly like the existing W5 badge test above — People must be
    // OPEN before this answer lands, or an escalation into a `null` `openPanel` decides `'open'`
    // (rule 3) instead of `'badge'`, and the whole scenario tests the wrong branch.
    let resolveTick1: (result: GetMeetingDrawdownResult) => void = () => {};
    const load = vi.fn();
    load.mockImplementationOnce(
      () =>
        new Promise<GetMeetingDrawdownResult>((resolve) => {
          resolveTick1 = resolve;
        })
    );
    // Tick 2 — de-escalates all the way back to healthy (rank 0).
    load.mockResolvedValueOnce({ success: true, state: drawdownStateFor(), sessionId: 'sess-1' });
    // Tick 3+ — escalates again, past the threshold a SECOND time.
    load.mockResolvedValue({
      success: true,
      state: drawdownStateFor({
        status: 'wrapped',
        graceEnteredAt: null,
        mandatePresent: false,
        balanceMinor: 0,
      }),
      sessionId: 'sess-1',
    });
    const panels = {
      ...panelsFake(),
      balance: { loadDrawdownState: load },
    } as unknown as MeetingPanelRegistration;
    const container = renderMember({ panels });
    await join();

    // Keep People open throughout — every escalation is then a BADGE, never a steal or an open.
    await user.click(screen.getByRole('button', { name: 'People' }));
    await screen.findByRole('heading', { level: 2, name: 'People' });

    // Tick 1 lands now, escalating past the announce threshold — the FIRST announcement.
    act(() => {
      resolveTick1({
        success: true,
        state: drawdownStateFor({
          status: 'grace',
          graceEnteredAt: DRAWDOWN_NOW,
          balanceMinor: -1000,
        }),
        sessionId: 'sess-1',
      });
    });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Balance, needs attention' })).toBeInTheDocument();
    });
    const region = container.querySelector('output[aria-live="polite"]');
    expect(region?.textContent).toBe('Your balance needs attention.');

    // Tick 2 — de-escalates to healthy. Rank 0 never badges; no announcement, but the ref resets.
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));

    // Tick 3 — escalates again, past the threshold a second time.
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitFor(() => expect(load).toHaveBeenCalledTimes(3));

    // ⚠⚠ THE REGRESSION: round 1 never reset `announcedBadgeRef`, so this SECOND, more
    // severe escalation would leave the region's text UNCHANGED — a screen-reader user hears
    // about the first funding interruption and never the second. `announce()` re-writes an
    // UNCHANGED string with a trailing zero-width space precisely so a genuine re-announcement
    // is observable here: the region's `textContent` must have grown, not stayed identical.
    await waitFor(() => expect(region?.textContent).not.toBe('Your balance needs attention.'));
    // ⚠ AN ESCAPE, NEVER THE LITERAL CHARACTER — see `announce`'s own docblock in
    // `meeting-frame-impl.tsx`: an invisible code point pasted into source is unreviewable.
    expect(region?.textContent).toBe(`Your balance needs attention.${'\u200B'}`);
  });
});
