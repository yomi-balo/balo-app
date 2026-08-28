import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MeetingRouteContextProvider, useMeetingRoute } from './meeting-route-context';
import type { MeetingGuestPanelRegistration } from './meeting-panels';
import { LOBBY_TOKEN_STORAGE_KEY, LOBBY_WAIT_STARTED_STORAGE_KEY } from './lobby';

/**
 * BAL-445 §7 / G-NEW-2 — pins "mounting the provider on a guest route changes NOTHING except
 * `panels`". Both `join-control.tsx` and `lobby-client.tsx` now mount
 * `MeetingRouteContextProvider` with the EXACT prop set asserted here:
 * `meetingId={null}`, `viewerName={null}`, `title={null}`, `backTo={null}`,
 * `contextNoun="call"`, `waiting={null}`, and every other prop left at its documented default.
 *
 * ⚠⚠ CRITICAL-3 / F6 (fix-round-1) — THE ORIGINAL VERSION OF THIS FILE PROVED ONLY THE PROVIDER'S
 * OWN DEFAULTS, over hand-written literal props, which was never in doubt. It did NOT render
 * either guest mount, so it could not catch a regression in `join-control.tsx` or
 * `lobby-client.tsx` themselves — e.g. `title={meetingTitle}` sneaking in, or `waiting={null}`
 * being dropped. `join-control.test.tsx` never asserts this (its BAL-445 diff is `+hasChat=
 * {false}`), and neither does `m/[meetingId]/page.test.tsx`.
 *
 * Below, the REAL `JoinControl` and `LobbyClient` are driven to their `admitted` arm, with
 * `MeetingCallSurface` mocked to a `Probe` that reads `useMeetingRoute()` — so these tests fail
 * the moment either mount's provider props drift from the set above. The literal-props case
 * above stays as the baseline (the provider's own contract, independent of either mount).
 */

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

vi.mock('motion/react', async () => {
  const { createMotionStub } = await import('@/test/motion-stub');
  return createMotionStub();
});

// jsdom has no `matchMedia`; the repo's convention is to mock the hook, not stub `matchMedia`.
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }));

/**
 * ⚠ THE REAL `MeetingCallSurface` MOUNTS THE DAILY FRAME VIA `next/dynamic` (BAL-435) and is
 * irrelevant to what THIS file proves — which is the PROPS `MeetingRouteContextProvider` was
 * mounted with, not what renders inside it. Mocking the whole component to a context-reading
 * `Probe` sidesteps the real frame (and the `@daily-co/daily-react` double it would otherwise
 * need) entirely, rather than merely deferring it.
 */
vi.mock('@/components/balo/meetings/meeting-call-surface', () => ({
  MeetingCallSurface: () => <Probe />,
}));

const mockPoll = vi.fn();
vi.mock('@/app/join/_actions/poll-guest-admission', () => ({
  pollGuestAdmissionAction: (...args: unknown[]) => mockPoll(...args),
}));

const mockClaim = vi.fn();
vi.mock('@/app/join/_actions/claim-lobby-place', () => ({
  claimLobbyPlaceAction: (...args: unknown[]) => mockClaim(...args),
}));

import { JoinControl } from '@/app/join/[token]/join-control';
import { LobbyClient } from '@/app/join/m/[meetingId]/lobby-client';

const MEETING_ID = '0f7b1c2d-3e4f-4a5b-8c9d-0e1f2a3b4c5d';
const RAW_TOKEN = 'z'.repeat(43);
const LOBBY_TOKEN = 'y'.repeat(43);
const START_ISO = '2026-09-01T10:00:00.000Z';
const END_ISO = '2026-09-01T11:00:00.000Z';

const GRANT = {
  roomUrl: 'https://balo.daily.co/balo-0f7b1c2d3e4f4a5b8c9d0e1f2a3b4c5d',
  token: 'daily.jwt.value',
  isOwner: false,
  canEndMeeting: false,
  expiresAt: '2026-09-02T11:00:00.000Z',
  participantId: 'g0f7b1c2d3e4f4a5b8c9d0e1f2a3b4c5d',
};

const GUEST_PANELS: MeetingGuestPanelRegistration = {
  audience: 'guest',
  files: {
    list: async () => ({ success: true, files: [] }),
    download: async () => ({ success: true, url: 'https://example.com/f' }),
  },
  chat: null,
};

/** Reads the context a real guest mount handed down and renders it as one deep-equal-able blob. */
function Probe(): React.JSX.Element {
  const route = useMeetingRoute();
  return (
    <pre data-testid="probe">
      {JSON.stringify({
        meetingId: route.meetingId,
        viewerName: route.viewerName,
        title: route.title,
        backTo: route.backTo,
        contextNoun: route.contextNoun,
        waiting: route.waiting,
        waitingPhase: route.waitingPhase,
        waitingFacts: route.waitingFacts,
        clock: route.clock,
        endMeeting: route.endMeeting === null,
        onExit: route.onExit === undefined,
        hasPanels: route.panels !== null,
        panelsAudience: route.panels?.audience ?? null,
      })}
    </pre>
  );
}

const EXPECTED_EMPTY_SHAPE = {
  meetingId: null,
  viewerName: null,
  title: null,
  backTo: null,
  contextNoun: 'call',
  waiting: null,
  waitingPhase: 'pre-start',
  waitingFacts: {
    noShowFloorMinutes: null,
    outcome: null,
    expertPresenceObserved: false,
  },
  clock: null,
  endMeeting: true,
  onExit: true,
  hasPanels: true,
  panelsAudience: 'guest',
};

function readProbe(): unknown {
  return JSON.parse(screen.getByTestId('probe').textContent ?? '{}');
}

describe("MeetingRouteContextProvider — the guest mount's prop set (baseline)", () => {
  it('deep-equals the EMPTY shape with only `panels` replaced', () => {
    render(
      <MeetingRouteContextProvider
        meetingId={null}
        viewerName={null}
        title={null}
        backTo={null}
        contextNoun="call"
        waiting={null}
        panels={GUEST_PANELS}
      >
        <Probe />
      </MeetingRouteContextProvider>
    );

    expect(readProbe()).toEqual(EXPECTED_EMPTY_SHAPE);
  });

  it('an UNMOUNTED provider (the pre-BAL-445 shape) reads the identical EMPTY defaults', () => {
    render(<Probe />);
    const parsed = readProbe() as Record<string, unknown>;
    expect(parsed.meetingId).toBeNull();
    expect(parsed.title).toBeNull();
    expect(parsed.backTo).toBeNull();
    expect(parsed.contextNoun).toBe('call');
    expect(parsed.waiting).toBeNull();
    expect(parsed.hasPanels).toBe(false);
  });
});

describe('JoinControl — the REAL admitted mount (CRITICAL-3 / F6)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPoll.mockResolvedValue({ success: true, state: 'admitted', grant: GRANT });
  });

  it('mounts MeetingRouteContextProvider with EXACTLY the empty shape plus the guest panels', async () => {
    const user = userEvent.setup();
    render(
      <JoinControl
        token={RAW_TOKEN}
        meetingId={MEETING_ID}
        scheduledStartIso={START_ISO}
        scheduledEndIso={END_ISO}
        utcWindowLabel="10:00 – 11:00 UTC"
        hasEnded={false}
        hasChat={false}
        recapHref={null}
        nextStepLine="Come back to this page when it is time."
        expiresOn="8 September 2026"
      >
        <h1>Design review with CloudPeak</h1>
      </JoinControl>
    );

    await user.click(screen.getByRole('button', { name: /join the call/i }));

    await waitFor(() => {
      expect(screen.getByTestId('probe')).toBeInTheDocument();
    });
    expect(readProbe()).toMatchObject({
      meetingId: null,
      viewerName: null,
      title: null,
      backTo: null,
      contextNoun: 'call',
      waiting: null,
      hasPanels: true,
      panelsAudience: 'guest',
    });
  });
});

describe('LobbyClient — the REAL admitted mount (CRITICAL-3 / F6)', () => {
  const TOKEN_KEY = `${LOBBY_TOKEN_STORAGE_KEY}:${MEETING_ID}`;
  const WAIT_KEY = `${LOBBY_WAIT_STARTED_STORAGE_KEY}:${MEETING_ID}`;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    globalThis.sessionStorage.clear();
    globalThis.sessionStorage.setItem(TOKEN_KEY, LOBBY_TOKEN);
    globalThis.sessionStorage.setItem(WAIT_KEY, String(Date.now()));
    mockClaim.mockResolvedValue({ success: true, lobbyToken: LOBBY_TOKEN });
    mockPoll.mockResolvedValue({ success: true, state: 'admitted', grant: GRANT });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('mounts MeetingRouteContextProvider with EXACTLY the empty shape plus the guest panels', async () => {
    render(<LobbyClient meetingId={MEETING_ID} />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    await waitFor(() => {
      expect(screen.getByTestId('probe')).toBeInTheDocument();
    });
    expect(readProbe()).toMatchObject({
      meetingId: null,
      viewerName: null,
      title: null,
      backTo: null,
      contextNoun: 'call',
      waiting: null,
      hasPanels: true,
      panelsAudience: 'guest',
    });
  });
});
