import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MEETING_CALL_EVENTS, track } from '@/lib/analytics';
import { validateGrant, type ValidatedGrant } from '@/lib/meetings/validate-grant';
import { MeetingRouteContextProvider } from '@/lib/meetings/meeting-route-context';
import type { MeetingPanelRegistration } from '@/lib/meetings/meeting-panels';
import {
  CLIENT_WAITING_BODY,
  NEUTRAL_WAITING_COPY,
  waitingCopyFor,
} from '@/lib/meetings/waiting-copy';
import { dailySpies, emitDailyEvent, installMediaStubs, resetDailyMock } from '@/test/mocks/daily';
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

const RAW_GRANT = {
  roomUrl: 'https://balo.daily.co/balo-0f7b1c2d3e4f4a5b8c9d0e1f2a3b4c5d',
  token: 'daily.jwt.super.secret.value',
  isOwner: false,
  expiresAt: '2026-09-02T11:00:00.000Z',
  participantId: 'u0f7b1c2d3e4f4a5b8c9d0e1f2a3b4c5d',
};

function grantFor(isOwner: boolean): ValidatedGrant {
  const result = validateGrant({ ...RAW_GRANT, isOwner });
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
}

/** The MEMBER mount: a route provider, with a destination and (optionally) a waiting subject. */
function renderMember(options: RouteOptions = {}, isOwner = false): HTMLElement {
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
    >
      <MeetingFrame grant={grantFor(isOwner)} />
    </MeetingRouteContextProvider>
  ).container;
}

/** ⚠ THE GUEST MOUNT: no provider at all, so no destination and no waiting subject exist. */
function renderGuest(): HTMLElement {
  return render(<MeetingFrame grant={grantFor(false)} />).container;
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

describe('MeetingFrame — the host end, and its pending state', () => {
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
    renderMember({}, true);
    await join();

    await user.click(screen.getByRole('button', { name: 'Leaving options' }));
    await user.click(await screen.findByRole('button', { name: 'End the call for everyone' }));
    await user.click(await screen.findByRole('button', { name: 'End for everyone' }));

    expect(await screen.findByRole('button', { name: 'Ending…' })).toBeDisabled();
    expect(dailySpies.updateParticipants).toHaveBeenCalledWith({ '*': { eject: true } });

    await act(async () => {
      releaseLeave();
    });

    expect(await screen.findByRole('heading', { name: CALL_ENDED_TITLE })).toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).toBeNull();
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
