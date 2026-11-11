import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, within } from '@testing-library/react';

// ── Mocks ───────────────────────────────────────────────────────

let mockPathname = '/dashboard';
vi.mock('next/navigation', () => ({
  usePathname: () => mockPathname,
}));

vi.mock('@/components/layout/sidebar-context', () => ({
  useSidebar: () => ({ navContext: { workspaceType: 'company', capabilities: [] } }),
}));

const mockRefetch = vi.fn();
let mockData: NavCallsResponse | null = null;
const mockUseRoomSetupRefetch = vi.fn();
vi.mock('./use-nav-calls', () => ({
  useNavCalls: () => ({ data: mockData, refetch: mockRefetch }),
}));
vi.mock('@/lib/meetings/use-room-ready-refetch', () => ({
  useRoomReadyRefetch: (...args: unknown[]) => mockUseRoomSetupRefetch(...args),
}));

import { track, NAV_EVENTS } from '@/lib/analytics';
import { JoinMeetingButton } from '@/components/balo/meetings/join-meeting-button';
import { LiveJoinRegistryProvider } from '@/components/balo/meetings/live-join-registry';
import { ROOM_SETTING_UP_SHORT_LABEL } from '@/lib/meetings/room-setting-up-copy';
import type { NavCallsResponse, NavCallView } from '@/lib/meetings/nav-call-view-types';
import { NavCallPill } from './nav-call-pill';

// ── Fixtures ────────────────────────────────────────────────────

const MIN = 60_000;
const PING = 'motion-safe:before:animate-ping-slow';
const mockAssign = vi.fn();
const realLocation = globalThis.location;

let base = 0;

function call(
  id: string,
  startOffsetMin: number,
  overrides: Partial<NavCallView> = {}
): NavCallView {
  return {
    meetingId: id,
    contextType: 'case',
    title: 'A case',
    counterpartyName: 'Priya',
    counterpartyOrgLabel: null,
    scheduledStart: new Date(base + startOffsetMin * MIN).toISOString(),
    scheduledEnd: new Date(base + (startOffsetMin + 30) * MIN).toISOString(),
    status: 'scheduled',
    href: '/cases/eng-1',
    joinPath: `/meetings/${id}/call`,
    rescheduleProposalExpiresAt: null,
    roomReady: true,
    otherWorkspace: false,
    ...overrides,
  };
}

function setData(calls: NavCallView[], impersonating = false): void {
  mockData = { serverNowIso: new Date(base).toISOString(), impersonating, calls };
}

function renderPill(extra: React.ReactNode = null): ReturnType<typeof render> {
  return render(
    <LiveJoinRegistryProvider>
      {extra}
      <NavCallPill />
    </LiveJoinRegistryProvider>
  );
}

function pillJoin(): HTMLElement {
  return within(screen.getByTestId('nav-call-pill')).getByRole('button', { name: /^Join/ });
}

beforeEach(() => {
  base = Date.now();
  mockPathname = '/dashboard';
  mockData = null;
  vi.clearAllMocks();
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: { href: realLocation.href, origin: realLocation.origin, assign: mockAssign },
  });
});

afterEach(() => {
  vi.useRealTimers();
  Object.defineProperty(globalThis, 'location', { configurable: true, value: realLocation });
});

// ── Tests ───────────────────────────────────────────────────────

describe('NavCallPill — visibility', () => {
  it('renders only the empty status region while there is no data (loading or error)', () => {
    renderPill();
    expect(screen.queryByTestId('nav-call-pill')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  it('renders only the empty status region when impersonating', () => {
    setData([call('m-1', 1)], true);
    renderPill();
    expect(screen.queryByTestId('nav-call-pill')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  it('gives the pill a motion-safe fade-in entrance', () => {
    setData([call('m-1', 2)]);
    renderPill();
    expect(screen.getByTestId('nav-call-pill')).toHaveClass('motion-safe:animate-fade-in');
  });

  it('renders only the quiet status region when no call is inside its window', () => {
    setData([call('m-1', 20)]);
    renderPill();
    expect(screen.queryByTestId('nav-call-pill')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  it('shows the counterparty, the status line and a labelled Join when joinable', () => {
    setData([call('m-1', 2)]);
    renderPill();

    const pill = screen.getByTestId('nav-call-pill');
    expect(within(pill).getByText('Priya')).toBeInTheDocument();
    expect(within(pill).getByText(/^Starts in \d+ min$/)).toBeInTheDocument();
    expect(pillJoin()).toHaveAccessibleName(/^Join Priya's meeting, starting in \d+ minutes?$/);
    expect(pillJoin()).toHaveTextContent('Join');
  });

  it('falls back to the meeting type label when there is no counterparty name', () => {
    setData([call('m-1', 2, { counterpartyName: null })]);
    renderPill();
    expect(
      within(screen.getByTestId('nav-call-pill')).getByText('Consultation')
    ).toBeInTheDocument();
  });

  it('renders an un-linked name when the call has no href', () => {
    setData([call('m-1', 2, { href: null })]);
    renderPill();
    expect(within(screen.getByTestId('nav-call-pill')).queryByRole('link')).not.toBeInTheDocument();
  });

  it('hides the call whose own recap page is open and promotes the next', () => {
    mockPathname = '/meetings/m-late';
    setData([call('m-early', -20, { counterpartyName: 'Early' }), call('m-late', 1)]);
    renderPill();
    expect(within(screen.getByTestId('nav-call-pill')).getByText('Early')).toBeInTheDocument();
    expect(screen.queryByText('Priya')).not.toBeInTheDocument();
  });
});

describe('NavCallPill — shape', () => {
  it('has no rounded-full control: Join, the +N trigger and the room slot are rounded-md or square', () => {
    setData([call('m-1', 2), call('m-2', -10, { counterpartyName: 'Sam', roomReady: false })]);
    renderPill();

    const pill = screen.getByTestId('nav-call-pill');
    const controls = [
      ...within(pill).getAllByRole('button'),
      ...Array.from(pill.querySelectorAll('span')).filter((el) =>
        el.textContent?.includes(ROOM_SETTING_UP_SHORT_LABEL)
      ),
    ];
    for (const control of controls) {
      expect(control.className).not.toContain('rounded-full');
    }
    expect(within(pill).getByRole('button', { name: /^Show/ }).className).toContain('rounded-md');
  });

  it('the room-setting-up chip is rounded-md, never rounded-full', () => {
    setData([call('m-1', 1, { roomReady: false })]);
    renderPill();

    const chip = screen.getByTitle('Setting up your call room');
    expect(chip.className).toContain('rounded-md');
    expect(chip.className).not.toContain('rounded-full');
  });
});

describe('NavCallPill — one moving thing', () => {
  it('rings with the ping cue when nothing else on the page shows the same Join', () => {
    setData([call('m-1', 2)]);
    renderPill();
    expect(pillJoin().className).toContain(PING);
  });

  it('goes static (ring-2, no ping) while a page-level Join for the same meeting is mounted', () => {
    setData([call('m-1', 2)]);
    renderPill(
      <JoinMeetingButton joinUrl="/meetings/m-1/call" ariaLabel="Page join" onJoin={vi.fn()}>
        Join
      </JoinMeetingButton>
    );

    expect(pillJoin().className).not.toContain(PING);
    expect(pillJoin().className).toContain('ring-2');
  });

  it('keeps ringing when the page-level Join is for a different meeting', () => {
    setData([call('m-1', 2)]);
    renderPill(
      <JoinMeetingButton joinUrl="/meetings/other/call" ariaLabel="Page join" onJoin={vi.fn()}>
        Join
      </JoinMeetingButton>
    );
    expect(pillJoin().className).toContain(PING);
  });

  it('is static from the scheduled end onward (overrun grace)', () => {
    setData([call('m-1', -31)]);
    renderPill();

    expect(pillJoin().className).not.toContain(PING);
    expect(pillJoin().className).toContain('ring-2');
  });
});

describe('NavCallPill — the +N list', () => {
  beforeEach(() => {
    setData([
      call('m-now', 1, { counterpartyName: 'Priya' }),
      call('m-a', -10, { counterpartyName: 'Sam' }),
      call('m-b', -20, { counterpartyName: 'Lee', roomReady: false }),
    ]);
  });

  it('shows +N with an accessible label and no list until opened', () => {
    renderPill();
    const trigger = screen.getByRole('button', { name: 'Show 2 more calls' });
    expect(trigger).toHaveTextContent('+2');
    expect(screen.queryByText('Calls you can join')).not.toBeInTheDocument();
  });

  it('uses the singular for one other call', () => {
    setData([call('m-now', 1), call('m-a', -10, { counterpartyName: 'Sam' })]);
    renderPill();
    expect(screen.getByRole('button', { name: 'Show 1 more call' })).toBeInTheDocument();
  });

  it('opens a titled list with a Join per joinable row and the slot for a not-ready one', () => {
    renderPill();
    fireEvent.click(screen.getByRole('button', { name: 'Show 2 more calls' }));

    const list = screen.getByRole('dialog', { name: 'Calls you can join' });
    expect(within(list).getByText('Sam')).toBeInTheDocument();
    expect(within(list).getByText('Lee')).toBeInTheDocument();
    expect(within(list).getByText('Consultation, happening now')).toBeInTheDocument();
    expect(within(list).getAllByRole('button', { name: /^Join/ })).toHaveLength(1);
    expect(within(list).getByText(ROOM_SETTING_UP_SHORT_LABEL)).toBeInTheDocument();
  });

  it('tracks the open once, with the primary’s base and the count of others', () => {
    renderPill();
    fireEvent.click(screen.getByRole('button', { name: 'Show 2 more calls' }));

    expect(track).toHaveBeenCalledWith(
      NAV_EVENTS.CALL_LIST_OPENED,
      expect.objectContaining({
        meeting_type: 'case',
        count: 2,
        other_workspace: false,
        workspace_type: 'company',
      })
    );
    const opened = vi.mocked(track).mock.calls.filter(([e]) => e === NAV_EVENTS.CALL_LIST_OPENED);
    expect(opened).toHaveLength(1);
  });

  it('list Joins never ping, and joining from the list tracks source "list" with quiet true', () => {
    renderPill();
    fireEvent.click(screen.getByRole('button', { name: 'Show 2 more calls' }));

    const list = screen.getByRole('dialog', { name: 'Calls you can join' });
    const join = within(list).getByRole('button', { name: /^Join Sam's meeting/ });
    expect(join.className).not.toContain(PING);

    fireEvent.click(join);

    expect(track).toHaveBeenCalledWith(
      NAV_EVENTS.CALL_JOIN_CLICKED,
      expect.objectContaining({ source: 'list', quiet: true })
    );
    expect(mockAssign).toHaveBeenCalledWith('/meetings/m-a/call');
  });

  it('renders no list trigger when there are no other calls', () => {
    setData([call('m-now', 1)]);
    renderPill();
    expect(screen.queryByRole('button', { name: /^Show/ })).not.toBeInTheDocument();
  });
});

describe('NavCallPill — joining and analytics', () => {
  it('Join tracks source "pill" then navigates', () => {
    setData([call('m-1', 2)]);
    renderPill();

    fireEvent.click(pillJoin());

    expect(track).toHaveBeenCalledWith(NAV_EVENTS.CALL_JOIN_CLICKED, {
      meeting_type: 'case',
      minutes_to_start: 2,
      quiet: false,
      other_workspace: false,
      workspace_type: 'company',
      source: 'pill',
    });
    expect(mockAssign).toHaveBeenCalledWith('/meetings/m-1/call');
  });

  it('tracks the pill shown once per meeting, not once per render', () => {
    setData([call('m-1', 2)]);
    const { rerender } = renderPill();
    rerender(
      <LiveJoinRegistryProvider>
        <NavCallPill />
      </LiveJoinRegistryProvider>
    );

    const shown = vi.mocked(track).mock.calls.filter(([e]) => e === NAV_EVENTS.CALL_PILL_SHOWN);
    expect(shown).toHaveLength(1);
  });

  it('tracks a quiet pill as quiet: true', () => {
    setData([call('m-1', -31)]);
    renderPill();

    expect(track).toHaveBeenCalledWith(
      NAV_EVENTS.CALL_PILL_SHOWN,
      expect.objectContaining({ quiet: true })
    );
  });
});

describe('NavCallPill — room not ready', () => {
  it('shows the slot instead of Join and asks for the bounded refetch', () => {
    const notReady = call('m-1', 1, { roomReady: false });
    setData([notReady]);
    renderPill();

    const pill = screen.getByTestId('nav-call-pill');
    expect(within(pill).queryByRole('button', { name: /^Join/ })).not.toBeInTheDocument();
    expect(within(pill).getByText(ROOM_SETTING_UP_SHORT_LABEL)).toBeInTheDocument();
    expect(within(pill).getByText('Consultation')).toBeInTheDocument();
    expect(mockUseRoomSetupRefetch).toHaveBeenLastCalledWith(
      true,
      notReady.scheduledStart,
      mockRefetch
    );
  });

  it('keeps the refetch inactive when every call is joinable', () => {
    setData([call('m-1', 2)]);
    renderPill();
    expect(mockUseRoomSetupRefetch).toHaveBeenLastCalledWith(false, '', mockRefetch);
  });

  it('does not announce a call whose room is not ready', () => {
    setData([call('m-1', 1, { roomReady: false })]);
    renderPill();
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });
});

function rerenderPill(view: ReturnType<typeof render>): void {
  view.rerender(
    <LiveJoinRegistryProvider>
      <NavCallPill />
    </LiveJoinRegistryProvider>
  );
}

describe('NavCallPill — screen reader', () => {
  it('keeps the same status element in the DOM from before the data arrives', () => {
    const view = renderPill();
    const before = screen.getByRole('status');
    expect(before).toBeEmptyDOMElement();

    setData([call('m-1', 2)]);
    rerenderPill(view);

    expect(screen.getByRole('status')).toBe(before);
    expect(before).toHaveTextContent('Your call with Priya is ready to join.');
  });

  it('clears the announcement once the announced call is no longer the joinable primary', () => {
    setData([call('m-1', 2)]);
    const view = renderPill();
    expect(screen.getByRole('status')).toHaveTextContent('Your call with Priya is ready to join.');

    setData([call('m-1', 2, { roomReady: false })]);
    rerenderPill(view);

    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  it('does not re-announce a meeting that was already announced once this mount', () => {
    setData([call('m-1', 2)]);
    const view = renderPill();
    setData([call('m-1', 2, { roomReady: false })]);
    rerenderPill(view);
    setData([call('m-1', 2)]);
    rerenderPill(view);

    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  it('announces the call once across ticks and a refetch', async () => {
    vi.useFakeTimers({ now: base, toFake: ['setInterval', 'clearInterval', 'Date'] });
    setData([call('m-1', 2)]);
    const view = renderPill();

    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Your call with Priya is ready to join.');
    const mutations: MutationRecord[] = [];
    const observer = new MutationObserver((records) => mutations.push(...records));
    observer.observe(status, { childList: true, characterData: true, subtree: true });

    for (let tick = 0; tick < 3; tick += 1) {
      await act(async () => {
        vi.advanceTimersByTime(30_000);
      });
    }
    // A refetch lands a fresh object for the same meeting.
    setData([call('m-1', 2)]);
    view.rerender(
      <LiveJoinRegistryProvider>
        <NavCallPill />
      </LiveJoinRegistryProvider>
    );

    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.getByRole('status').textContent).toBe('Your call with Priya is ready to join.');
    expect([...mutations, ...observer.takeRecords()]).toHaveLength(0);
    observer.disconnect();
  });

  it('stays silent while the pill is quiet', () => {
    setData([call('m-1', -31)]);
    renderPill();
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  it('keeps the visible status line out of any live region', () => {
    setData([call('m-1', 2)]);
    renderPill();

    const statusLine = screen.getByText(/^Starts in \d+ min$/);
    expect(statusLine.closest('[aria-live]')).toBeNull();
    expect(statusLine.closest('[role="status"]')).toBeNull();
  });
});

describe('NavCallPill — privacy', () => {
  it('renders no link to the call route and no meeting id, open or closed', () => {
    setData([
      call('secret-meeting-id-1', 1),
      call('secret-meeting-id-2', -10, { counterpartyName: 'Sam' }),
    ]);
    const { container } = renderPill();

    expect(container.querySelector('a[href*="/call"]')).toBeNull();
    expect(container.innerHTML).not.toContain('secret-meeting-id');

    fireEvent.click(screen.getByRole('button', { name: 'Show 1 more call' }));
    const list = screen.getByRole('dialog', { name: 'Calls you can join' });

    expect(list.querySelector('a[href*="/call"]')).toBeNull();
    expect(list.innerHTML).not.toContain('secret-meeting-id');
    expect(document.body.innerHTML).not.toContain('secret-meeting-id');
  });
});
