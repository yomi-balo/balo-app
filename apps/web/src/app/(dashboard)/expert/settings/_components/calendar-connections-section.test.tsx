import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { track } from '@/lib/analytics';
import { CALENDAR_EVENTS } from '@balo/analytics/events';
import { toast } from 'sonner';
import type { CalendarConnection } from '../_types/calendar';

// ── Mocks ───────────────────────────────────────────────────────

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

let mockSearchParams = new URLSearchParams();
const mockReplace = vi.fn();
vi.mock('next/navigation', () => ({
  useSearchParams: () => mockSearchParams,
  useRouter: () => ({ replace: mockReplace }),
  usePathname: () => '/expert/settings',
}));

vi.mock('motion/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('motion/react')>();
  const MOTION_PROPS = new Set([
    'variants',
    'initial',
    'animate',
    'exit',
    'whileHover',
    'whileTap',
    'transition',
  ]);
  const filterMotion = (props: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(Object.entries(props).filter(([k]) => !MOTION_PROPS.has(k)));
  return {
    ...actual,
    motion: {
      div: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => (
        <div {...filterMotion(props)}>{children}</div>
      ),
    },
    useReducedMotion: () => true,
  };
});

const mockGetConnections = vi.fn();
vi.mock('../_actions/get-calendar-connections', () => ({
  getCalendarConnectionsAction: (...args: unknown[]) => mockGetConnections(...args),
}));

const mockInitiateConnect = vi.fn();
vi.mock('../_actions/initiate-calendar-connect', () => ({
  initiateCalendarConnectAction: (...args: unknown[]) => mockInitiateConnect(...args),
}));

const mockDisconnect = vi.fn();
vi.mock('../_actions/disconnect-calendar', () => ({
  disconnectCalendarAction: (...args: unknown[]) => mockDisconnect(...args),
}));

const mockToggleConflictCheck = vi.fn();
vi.mock('../_actions/toggle-conflict-check', () => ({
  toggleConflictCheckAction: (...args: unknown[]) => mockToggleConflictCheck(...args),
}));

const mockSetTargetCalendar = vi.fn();
vi.mock('../_actions/set-target-calendar', () => ({
  setTargetCalendarAction: (...args: unknown[]) => mockSetTargetCalendar(...args),
}));

const mockFixPermissions = vi.fn();
vi.mock('../_actions/fix-calendar-permissions', () => ({
  fixCalendarPermissionsAction: (...args: unknown[]) => mockFixPermissions(...args),
}));

/**
 * The "Where bookings go" `Select` is a Radix primitive whose open/close choreography is not
 * reliably drivable in JSDOM — the repo's established answer is to stub it and drive the
 * handler directly (see `schedule-tab.test.tsx`'s timezone combobox stub). The real panel keeps
 * its own test file; what THIS file is testing is the section's optimistic-update and
 * revert-on-failure logic, so the stub surfaces exactly two things: the currently-rendered
 * `targetCalendarId` (to observe the optimistic flip and the revert) and one button per
 * sub-calendar to trigger `onChange`.
 */
vi.mock('./calendar-target-calendar-panel', () => ({
  CalendarTargetCalendarPanel: ({
    connection,
    pending,
    disabled = false,
    onChange,
  }: {
    connection: { targetCalendarId: string | null; subCalendars: { id: string; name: string }[] };
    pending: boolean;
    disabled?: boolean;
    onChange: (id: string) => void;
  }) => (
    <div>
      <span data-testid="target-value">{connection.targetCalendarId ?? 'none'}</span>
      {connection.subCalendars.map((cal) => (
        <button
          key={cal.id}
          type="button"
          disabled={pending || disabled}
          onClick={() => onChange(cal.id)}
        >
          {`Book into ${cal.name}`}
        </button>
      ))}
    </div>
  ),
}));

import {
  CalendarConnectionsSection,
  mergeConnectionsByProvider,
  occupiesSlot,
} from './calendar-connections-section';

// ── Helpers ─────────────────────────────────────────────────────

const makeConnection = (overrides: Partial<CalendarConnection> = {}): CalendarConnection => ({
  provider: 'google',
  credentialStatus: 'ACTIVE',
  providerEmail: 'yomi@gmail.com',
  lastSyncedAt: '2026-04-09T00:00:00Z',
  targetCalendarId: 'cal-1',
  subCalendars: [
    { id: 'cal-1', name: 'Work', provider: 'google', primary: true, conflictChecking: true },
  ],
  ...overrides,
});

/** A connection carrying a NON-primary sub-calendar — the only kind whose Switch is operable
 *  (a primary calendar's conflict-check cannot be turned off, by API invariant). */
const makeToggleableConnection = (
  overrides: Partial<CalendarConnection> = {}
): CalendarConnection =>
  makeConnection({
    subCalendars: [
      { id: 'cal-1', name: 'Work', provider: 'google', primary: true, conflictChecking: true },
      { id: 'cal-2', name: 'Team', provider: 'google', primary: false, conflictChecking: false },
    ],
    ...overrides,
  });

function trackCallsFor(event: string): unknown[][] {
  return vi.mocked(track).mock.calls.filter((call) => call[0] === event);
}

async function findReady(): Promise<void> {
  await waitFor(() => expect(mockGetConnections).toHaveBeenCalled());
}

// ── Tests ───────────────────────────────────────────────────────

describe('CalendarConnectionsSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchParams = new URLSearchParams();
    mockGetConnections.mockResolvedValue({ ok: true, connections: [] });
    mockInitiateConnect.mockResolvedValue({ success: false, error: 'Failed to initiate' });
    mockToggleConflictCheck.mockResolvedValue({ success: true });
    mockSetTargetCalendar.mockResolvedValue({ success: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Header (always rendered) ─────────────────────────────────

  it('renders the Calendar heading and description regardless of state', async () => {
    render(<CalendarConnectionsSection />);
    expect(screen.getByText('Calendar')).toBeInTheDocument();
    expect(
      screen.getByText(/Connect a calendar to keep your availability accurate/)
    ).toBeInTheDocument();
    await screen.findByText('Connect your calendar');
  });

  // ── Four surface states ───────────────────────────────────────

  it('renders the loading skeleton before the fetch resolves', () => {
    mockGetConnections.mockReturnValue(new Promise(() => {})); // never resolves
    render(<CalendarConnectionsSection />);
    expect(screen.getByLabelText('Loading')).toBeInTheDocument();
  });

  it('renders SectionError and retries on click when the fetch fails', async () => {
    mockGetConnections.mockResolvedValue({ ok: false, error: 'boom' });
    const user = userEvent.setup();
    render(<CalendarConnectionsSection />);

    expect(await screen.findByText("We couldn't load your calendars")).toBeInTheDocument();

    mockGetConnections.mockResolvedValue({ ok: true, connections: [] });
    await user.click(screen.getByRole('button', { name: /Try again/ }));
    expect(await screen.findByText('Connect your calendar')).toBeInTheDocument();
  });

  it('renders the empty-state hero with both provider cards when there are zero connections', async () => {
    render(<CalendarConnectionsSection />);
    expect(await screen.findByText('Connect your calendar')).toBeInTheDocument();
    expect(screen.getByText('Google Calendar')).toBeInTheDocument();
    expect(screen.getByText('Microsoft Outlook')).toBeInTheDocument();
  });

  it('renders a card for a live connection, and offers "Connect another" for the remaining provider', async () => {
    mockGetConnections.mockResolvedValue({ ok: true, connections: [makeConnection()] });
    render(<CalendarConnectionsSection />);

    expect(await screen.findByText('yomi@gmail.com')).toBeInTheDocument();
    expect(screen.queryByText('Connect your calendar')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Connect Microsoft Outlook/ })).toBeInTheDocument();
  });

  it('offers no "Connect another" CTA once both providers are connected', async () => {
    mockGetConnections.mockResolvedValue({
      ok: true,
      connections: [
        makeConnection(),
        makeConnection({ provider: 'microsoft', providerEmail: 'yomi@outlook.com' }),
      ],
    });
    render(<CalendarConnectionsSection />);

    await screen.findByText('yomi@outlook.com');
    expect(
      screen.queryByRole('button', { name: /Connect Microsoft Outlook/ })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Connect Google Calendar/ })
    ).not.toBeInTheDocument();
  });

  it('always renders the Apple note and trust row in the ready state', async () => {
    render(<CalendarConnectionsSection />);
    await findReady();
    expect(await screen.findByText(/On iCloud\?/)).toBeInTheDocument();
    expect(screen.getByText('We only read your event times')).toBeInTheDocument();
  });

  // ── Callback params ───────────────────────────────────────────

  it('shows a success toast and clears the URL params on calendar_connected=true', async () => {
    mockSearchParams = new URLSearchParams(
      'calendar_connected=true&calendar_status=ACTIVE&calendar_provider=google'
    );
    mockGetConnections.mockResolvedValue({ ok: true, connections: [makeConnection()] });
    render(<CalendarConnectionsSection />);

    // BAL-397 fix round — the provider LABEL alone. `PROVIDER_META.google.label` is already
    // "Google Calendar", so appending the word produced "Google Calendar calendar connected".
    // This assertion previously PINNED the stutter.
    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('Google Calendar connected');
    });
    expect(mockReplace).toHaveBeenCalledWith('/expert/settings?tab=schedule', { scroll: false });
  });

  // BAL-397 fix round, CRITICAL — `router.replace` changes the URL, so the `[searchParams]`
  // effect re-runs. Without the one-shot fetch guard that second run called `fetchConnections()`
  // again, and its `setSectionState('loading')` tore the just-rendered card back down to the
  // skeleton: card → skeleton → card, on the single most important path in the ticket.
  it('fetches exactly once on an OAuth return, and never re-shows the skeleton after the URL is cleaned', async () => {
    mockSearchParams = new URLSearchParams(
      'calendar_connected=true&calendar_status=ACTIVE&calendar_provider=google'
    );
    mockGetConnections.mockResolvedValue({ ok: true, connections: [makeConnection()] });
    const { rerender } = render(<CalendarConnectionsSection />);

    await screen.findByText('yomi@gmail.com');
    expect(mockGetConnections).toHaveBeenCalledTimes(1);

    // Simulate what `router.replace` really does: a new searchParams instance with the
    // callback params gone, then a re-render — which re-runs the effect.
    mockSearchParams = new URLSearchParams('tab=schedule');
    rerender(<CalendarConnectionsSection />);

    await waitFor(() => expect(mockGetConnections).toHaveBeenCalledTimes(1));
    expect(screen.queryByLabelText('Loading')).not.toBeInTheDocument();
    expect(screen.getByText('yomi@gmail.com')).toBeInTheDocument();
  });

  it('shows a warning toast when calendar_connected=true carries SYNC_PENDING', async () => {
    mockSearchParams = new URLSearchParams(
      'calendar_connected=true&calendar_status=SYNC_PENDING&calendar_provider=google'
    );
    mockGetConnections.mockResolvedValue({
      ok: true,
      connections: [makeConnection({ credentialStatus: 'SYNC_PENDING', subCalendars: [] })],
    });
    render(<CalendarConnectionsSection />);

    await waitFor(() => {
      expect(toast.warning).toHaveBeenCalledWith(
        "Connected — we're still setting up this calendar."
      );
    });
  });

  it('enters o365_waiting for calendar_error=o365_admin_approval — the array still loads underneath', async () => {
    mockSearchParams = new URLSearchParams(
      'calendar_error=o365_admin_approval&calendar_provider=microsoft'
    );
    render(<CalendarConnectionsSection />);

    expect(await screen.findByText('Your IT admin needs to take action')).toBeInTheDocument();
  });

  it('sets attempt_failed for a generic callback error when the provider has no connection row', async () => {
    mockSearchParams = new URLSearchParams(
      'calendar_error=callback_failed&calendar_provider=google'
    );
    render(<CalendarConnectionsSection />);

    expect(await screen.findByText(/didn't finish/)).toBeInTheDocument();
  });

  it('leaves an existing row alone and toasts on a generic callback error when the provider DOES have a connection', async () => {
    mockSearchParams = new URLSearchParams(
      'calendar_error=callback_failed&calendar_provider=google'
    );
    mockGetConnections.mockResolvedValue({ ok: true, connections: [makeConnection()] });
    render(<CalendarConnectionsSection />);

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("That sign-in didn't finish — nothing changed.");
    });
    expect(await screen.findByText('yomi@gmail.com')).toBeInTheDocument();
    expect(screen.getByText('Connected')).toBeInTheDocument();
  });

  // BAL-396 fix round, Finding 2 — pinned regression.
  it('ignores an unallowlisted calendar_provider value instead of casting it through', async () => {
    mockSearchParams = new URLSearchParams(
      'calendar_error=callback_failed&calendar_provider=%22%3E%3Cscript%3E'
    );
    render(<CalendarConnectionsSection />);

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("That sign-in didn't finish — nothing changed.");
    });
    // No transient was set for any specific provider — the empty hero still renders.
    expect(await screen.findByText('Connect your calendar')).toBeInTheDocument();
  });

  it('treats a tampered calendar_status as absent rather than casting it', async () => {
    mockSearchParams = new URLSearchParams(
      'calendar_connected=true&calendar_status=hacked&calendar_provider=google'
    );
    render(<CalendarConnectionsSection />);

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('Google Calendar connected');
    });
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it('consumes callback params exactly once (does not re-toast on a rerender with the same params)', async () => {
    mockSearchParams = new URLSearchParams('calendar_connected=true&calendar_provider=google');
    const { rerender } = render(<CalendarConnectionsSection />);
    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1));

    rerender(<CalendarConnectionsSection />);
    expect(mockReplace).toHaveBeenCalledTimes(1);
  });

  // ── Fix permissions provider correctness (regression: BAL-396 Finding 6) ─────

  it('fixes permissions for the correct (Microsoft) provider on a SYNC_PENDING connection with zero sub-calendars', async () => {
    mockGetConnections.mockResolvedValue({
      ok: true,
      connections: [
        makeConnection({
          provider: 'microsoft',
          credentialStatus: 'SYNC_PENDING',
          subCalendars: [],
        }),
      ],
    });
    mockFixPermissions.mockResolvedValue({ success: true, relinkUrl: 'https://vendor.example/x' });
    const user = userEvent.setup();
    render(<CalendarConnectionsSection />);

    await user.click(await screen.findByRole('button', { name: /Fix permissions/ }));
    expect(mockFixPermissions).toHaveBeenCalledWith('microsoft');
  });

  // ── O365 guidance intercept ───────────────────────────────────

  it('intercepts the first Microsoft connect with the guidance dialog — no OAuth yet', async () => {
    const user = userEvent.setup();
    render(<CalendarConnectionsSection />);

    await screen.findByText('Connect your calendar');
    await user.click(screen.getAllByRole('button', { name: 'Connect' })[1]!);

    expect(await screen.findByText('Connect Microsoft 365')).toBeInTheDocument();
    expect(mockInitiateConnect).not.toHaveBeenCalled();
  });

  it('starts OAuth after "Continue to Microsoft 365"', async () => {
    mockInitiateConnect.mockResolvedValue({
      success: true,
      connectUrl: 'https://vendor.example/o',
    });
    const user = userEvent.setup();
    render(<CalendarConnectionsSection />);

    await screen.findByText('Connect your calendar');
    await user.click(screen.getAllByRole('button', { name: 'Connect' })[1]!);
    await user.click(await screen.findByRole('button', { name: /Continue to Microsoft 365/ }));

    await waitFor(() => {
      expect(mockInitiateConnect).toHaveBeenCalledWith('microsoft');
    });
    expect(track).toHaveBeenCalledWith(CALENDAR_EVENTS.O365_GUIDANCE_CONTINUED, {});
  });

  it('skips the guidance dialog on retry from attempt_failed for Microsoft', async () => {
    mockInitiateConnect.mockResolvedValue({ success: false, error: 'nope' });
    const user = userEvent.setup();
    render(<CalendarConnectionsSection />);

    await screen.findByText('Connect your calendar');
    await user.click(screen.getAllByRole('button', { name: 'Connect' })[1]!);
    await user.click(await screen.findByRole('button', { name: /Continue to Microsoft 365/ }));

    // First attempt fails -> attempt_failed
    expect(await screen.findByText(/didn't finish/)).toBeInTheDocument();
    vi.clearAllMocks();
    mockInitiateConnect.mockResolvedValue({ success: false, error: 'nope again' });

    await user.click(screen.getByRole('button', { name: /Try again/ }));

    // Direct retry — no guidance dialog shown again.
    expect(screen.queryByText('Connect Microsoft 365')).not.toBeInTheDocument();
    await waitFor(() => expect(mockInitiateConnect).toHaveBeenCalledWith('microsoft'));
  });

  // ── Disconnect wiring ─────────────────────────────────────────

  it('disconnects a connection through the confirm dialog and refetches on success', async () => {
    mockGetConnections.mockResolvedValue({ ok: true, connections: [makeConnection()] });
    mockDisconnect.mockResolvedValue({ success: true });
    const user = userEvent.setup();
    render(<CalendarConnectionsSection />);

    await screen.findByText('yomi@gmail.com');
    await user.click(screen.getByRole('button', { name: 'Options for Google Calendar' }));
    await user.click(await screen.findByRole('menuitem', { name: /Disconnect/ }));
    await user.click(await screen.findByRole('button', { name: 'Disconnect' }));

    await waitFor(() => {
      expect(mockDisconnect).toHaveBeenCalledWith({ provider: 'google' });
    });
    expect(toast.success).toHaveBeenCalledWith('Google Calendar disconnected');
  });

  // BAL-397 fix round — the reconciliation refetch is SILENT. A loud one set
  // `sectionState = 'loading'` and replaced the whole section (Apple note, trust row, the
  // surviving provider's card) with the skeleton, undoing the optimistic removal on screen.
  it('never flashes the skeleton over the optimistic removal when disconnect succeeds', async () => {
    mockGetConnections.mockResolvedValue({
      ok: true,
      connections: [
        makeConnection(),
        makeConnection({ provider: 'microsoft', providerEmail: 'yomi@outlook.com' }),
      ],
    });
    mockDisconnect.mockResolvedValue({ success: true });
    const user = userEvent.setup();
    render(<CalendarConnectionsSection />);

    await screen.findByText('yomi@gmail.com');
    mockGetConnections.mockResolvedValue({
      ok: true,
      connections: [makeConnection({ provider: 'microsoft', providerEmail: 'yomi@outlook.com' })],
    });

    await user.click(screen.getByRole('button', { name: 'Options for Google Calendar' }));
    await user.click(await screen.findByRole('menuitem', { name: /Disconnect/ }));
    await user.click(await screen.findByRole('button', { name: 'Disconnect' }));

    await waitFor(() => expect(mockDisconnect).toHaveBeenCalled());
    expect(screen.queryByLabelText('Loading')).not.toBeInTheDocument();
    // The surviving card never left the screen.
    expect(screen.getByText('yomi@outlook.com')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('yomi@gmail.com')).not.toBeInTheDocument());
  });

  it('restores the row and toasts an error when disconnect fails', async () => {
    mockGetConnections.mockResolvedValue({ ok: true, connections: [makeConnection()] });
    mockDisconnect.mockResolvedValue({ success: false, error: 'server said no' });
    const user = userEvent.setup();
    render(<CalendarConnectionsSection />);

    await screen.findByText('yomi@gmail.com');
    await user.click(screen.getByRole('button', { name: 'Options for Google Calendar' }));
    await user.click(await screen.findByRole('menuitem', { name: /Disconnect/ }));
    await user.click(await screen.findByRole('button', { name: 'Disconnect' }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('server said no');
    });
    expect(await screen.findByText('yomi@gmail.com')).toBeInTheDocument();
  });

  // ── Optimistic update + revert-on-failure (plan §12.2) ────────
  //
  // `handleToggleBusy` and `handleChangeTarget` are the most delicate ~90 lines in the ticket —
  // capture-before-await, revert-on-failure, `id`-keyed toast dedupe, pending-set add/remove —
  // and until this block they had ZERO behavioural coverage in any test file: both actions were
  // mocked and then never asserted on.

  describe('optimistic busy toggle', () => {
    it('flips the switch before the action resolves, and calls the action with the connection provider', async () => {
      mockGetConnections.mockResolvedValue({
        ok: true,
        connections: [makeToggleableConnection()],
      });
      let resolveToggle: (value: { success: boolean }) => void = () => {};
      mockToggleConflictCheck.mockReturnValue(
        new Promise<{ success: boolean }>((resolve) => {
          resolveToggle = resolve;
        })
      );
      const user = userEvent.setup();
      render(<CalendarConnectionsSection />);

      const toggle = await screen.findByRole('switch', { name: 'Block time from Team' });
      expect(toggle).not.toBeChecked();
      await user.click(toggle);

      // Optimistic: checked while the mutation is STILL in flight.
      await waitFor(() => expect(toggle).toBeChecked());
      expect(mockToggleConflictCheck).toHaveBeenCalledWith({
        subCalendarId: 'cal-2',
        conflictChecking: true,
        provider: 'google',
      });

      resolveToggle({ success: true });
      await waitFor(() =>
        expect(toast.success).toHaveBeenCalledWith('Blocking time from Team', {
          id: 'busy-cal-2',
        })
      );
      expect(toggle).toBeChecked();
    });

    it('reverts the switch and toasts an error when the action fails', async () => {
      mockGetConnections.mockResolvedValue({
        ok: true,
        connections: [makeToggleableConnection()],
      });
      mockToggleConflictCheck.mockResolvedValue({ success: false, error: 'nope' });
      const user = userEvent.setup();
      render(<CalendarConnectionsSection />);

      const toggle = await screen.findByRole('switch', { name: 'Block time from Team' });
      await user.click(toggle);

      await waitFor(() => expect(toast.error).toHaveBeenCalledWith('nope', { id: 'busy-cal-2' }));
      expect(toggle).not.toBeChecked();
    });

    it('reverts to the PRE-CLICK value, not to a hardcoded false, when turning a checked row OFF', async () => {
      mockGetConnections.mockResolvedValue({
        ok: true,
        connections: [
          makeToggleableConnection({
            subCalendars: [
              {
                id: 'cal-2',
                name: 'Team',
                provider: 'google',
                primary: false,
                conflictChecking: true,
              },
            ],
          }),
        ],
      });
      mockToggleConflictCheck.mockResolvedValue({ success: false });
      const user = userEvent.setup();
      render(<CalendarConnectionsSection />);

      const toggle = await screen.findByRole('switch', { name: 'Block time from Team' });
      expect(toggle).toBeChecked();
      await user.click(toggle);

      await waitFor(() => expect(toast.error).toHaveBeenCalled());
      expect(toggle).toBeChecked();
    });
  });

  describe('optimistic target-calendar select', () => {
    it('moves the target before the action resolves', async () => {
      mockGetConnections.mockResolvedValue({
        ok: true,
        connections: [makeToggleableConnection()],
      });
      let resolveSet: (value: { success: boolean }) => void = () => {};
      mockSetTargetCalendar.mockReturnValue(
        new Promise<{ success: boolean }>((resolve) => {
          resolveSet = resolve;
        })
      );
      const user = userEvent.setup();
      render(<CalendarConnectionsSection />);

      await screen.findByText('yomi@gmail.com');
      expect(screen.getByTestId('target-value')).toHaveTextContent('cal-1');

      await user.click(screen.getByRole('button', { name: 'Book into Team' }));

      await waitFor(() => expect(screen.getByTestId('target-value')).toHaveTextContent('cal-2'));
      expect(mockSetTargetCalendar).toHaveBeenCalledWith({
        targetCalendarId: 'cal-2',
        provider: 'google',
      });

      resolveSet({ success: true });
      await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Bookings will go to Team'));
    });

    it('reverts to the previous target and toasts an error when the action fails', async () => {
      mockGetConnections.mockResolvedValue({
        ok: true,
        connections: [makeToggleableConnection()],
      });
      mockSetTargetCalendar.mockResolvedValue({ success: false, error: 'server said no' });
      const user = userEvent.setup();
      render(<CalendarConnectionsSection />);

      await screen.findByText('yomi@gmail.com');
      await user.click(screen.getByRole('button', { name: 'Book into Team' }));

      await waitFor(() => expect(toast.error).toHaveBeenCalledWith('server said no'));
      expect(screen.getByTestId('target-value')).toHaveTextContent('cal-1');
    });
  });

  // ── The poll merge (plan §12.1) ───────────────────────────────

  describe('poll merge', () => {
    it('merges the tick, and toasts + tracks the SYNC_PENDING → ACTIVE edge EXACTLY ONCE', async () => {
      vi.useFakeTimers();
      mockGetConnections.mockResolvedValue({
        ok: true,
        connections: [makeConnection({ credentialStatus: 'SYNC_PENDING', subCalendars: [] })],
      });
      render(<CalendarConnectionsSection />);
      await vi.advanceTimersByTimeAsync(0);

      mockGetConnections.mockResolvedValue({
        ok: true,
        connections: [makeConnection({ credentialStatus: 'ACTIVE' })],
      });
      await vi.advanceTimersByTimeAsync(5_000);

      // ⚠ THE COUNT IS THE POINT (BAL-397 fix round, CRITICAL). The edge detection used to run
      // inside the `setConnections` updater, which React double-invokes under StrictMode — so
      // both the toast and `SYNC_PENDING_RESOLVED`, the metric that tells us whether Apiroc
      // provisioning self-heals, silently fired twice per edge.
      expect(toast.success).toHaveBeenCalledWith('Google Calendar is ready');
      expect(toast.success).toHaveBeenCalledTimes(1);
      expect(trackCallsFor(CALENDAR_EVENTS.SYNC_PENDING_RESOLVED)).toHaveLength(1);

      // A second tick with the SAME active row is no longer an edge — no re-toast.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(toast.success).toHaveBeenCalledTimes(1);
      expect(trackCallsFor(CALENDAR_EVENTS.SYNC_PENDING_RESOLVED)).toHaveLength(1);
    });

    it('toasts the loss of access on a SYNC_PENDING → EXPIRED edge', async () => {
      vi.useFakeTimers();
      mockGetConnections.mockResolvedValue({
        ok: true,
        connections: [makeConnection({ credentialStatus: 'SYNC_PENDING', subCalendars: [] })],
      });
      render(<CalendarConnectionsSection />);
      await vi.advanceTimersByTimeAsync(0);

      mockGetConnections.mockResolvedValue({
        ok: true,
        connections: [makeConnection({ credentialStatus: 'EXPIRED' })],
      });
      await vi.advanceTimersByTimeAsync(5_000);

      expect(toast.error).toHaveBeenCalledWith('We lost access to your Google Calendar.');
      expect(toast.error).toHaveBeenCalledTimes(1);
    });

    // BAL-397 fix round — the merge used to be a UNION seeded from `prev`, so it could never
    // SHRINK: a connection disconnected or revoked in another tab survived every poll forever.
    it('DROPS a provider the tick no longer returns', async () => {
      vi.useFakeTimers();
      mockGetConnections.mockResolvedValue({
        ok: true,
        connections: [
          makeConnection(),
          makeConnection({
            provider: 'microsoft',
            providerEmail: 'yomi@outlook.com',
            credentialStatus: 'SYNC_PENDING',
            subCalendars: [],
          }),
        ],
      });
      render(<CalendarConnectionsSection />);
      await vi.advanceTimersByTimeAsync(0);
      expect(screen.getByText('yomi@gmail.com')).toBeInTheDocument();

      // Google was disconnected in another tab — the server no longer returns it.
      mockGetConnections.mockResolvedValue({
        ok: true,
        connections: [
          makeConnection({
            provider: 'microsoft',
            providerEmail: 'yomi@outlook.com',
            credentialStatus: 'ACTIVE',
          }),
        ],
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });

      expect(screen.queryByText('yomi@gmail.com')).not.toBeInTheDocument();
      expect(screen.getByText('yomi@outlook.com')).toBeInTheDocument();
    });
  });

  /**
   * The merge's two halves, unit-tested directly. The "carried over" half is only reachable
   * through the UI while a mutation is genuinely in flight AND a poll tick lands in the same
   * window — a race that is not honestly expressible with fake timers plus `userEvent`, so it
   * is pinned here instead of pantomimed there.
   */
  describe('mergeConnectionsByProvider', () => {
    const google = makeConnection();
    const microsoft = makeConnection({ provider: 'microsoft', providerEmail: 'yomi@outlook.com' });
    const NONE: ReadonlySet<'google' | 'microsoft'> = new Set();

    it('takes the tick as authoritative — an updated row replaces the local one', () => {
      const updated = makeConnection({ credentialStatus: 'EXPIRED' });
      expect(mergeConnectionsByProvider([google], [updated], NONE)).toEqual([updated]);
    });

    it('SHRINKS: a provider absent from the tick and not skipped is dropped', () => {
      expect(mergeConnectionsByProvider([google, microsoft], [microsoft], NONE)).toEqual([
        microsoft,
      ]);
    });

    it('CARRIES OVER: a provider absent from the tick because it is SKIPPED keeps its local row', () => {
      // The local row here is the OPTIMISTIC one — carrying it over is what stops a concurrent
      // tick from reverting a mutation the expert can already see on screen.
      const optimistic = makeConnection({ targetCalendarId: 'cal-optimistic' });
      expect(
        mergeConnectionsByProvider([optimistic, microsoft], [microsoft], new Set(['google']))
      ).toEqual([microsoft, optimistic]);
    });

    it('prefers the tick over a skipped provider that the tick DID return', () => {
      const fresh = makeConnection({ credentialStatus: 'EXPIRED' });
      expect(mergeConnectionsByProvider([google], [fresh], new Set(['google']))).toEqual([fresh]);
    });

    it('is empty when the tick is empty and nothing is skipped', () => {
      expect(mergeConnectionsByProvider([google, microsoft], [], NONE)).toEqual([]);
    });
  });

  describe('occupiesSlot', () => {
    it.each(['connecting', 'o365_waiting', 'attempt_failed'] as const)(
      '%s claims a provider card',
      (transient) => {
        expect(occupiesSlot(transient)).toBe(true);
      }
    );

    it('o365_guidance does NOT — it is a modal, not a card', () => {
      expect(occupiesSlot('o365_guidance')).toBe(false);
    });

    it('no transient claims nothing', () => {
      expect(occupiesSlot(undefined)).toBe(false);
    });
  });

  // ── O365 guidance is a MODAL, not a slot (plan §4.3) ──────────

  it('keeps the hero and both provider cards mounted while the guidance dialog is open', async () => {
    const user = userEvent.setup();
    render(<CalendarConnectionsSection />);

    await screen.findByText('Connect your calendar');
    await user.click(screen.getAllByRole('button', { name: 'Connect' })[1]!);
    expect(await screen.findByText('Connect Microsoft 365')).toBeInTheDocument();

    // ⚠ BAL-397 fix round — `o365_guidance` used to claim a provider SLOT, so opening the
    // dialog flipped `showHero` to false: the hero and both provider cards unmounted behind
    // the overlay and were replaced by a bodyless Microsoft card plus a dashed "Connect Google
    // Calendar" CTA. Cancelling reinstated the hero. Pure thrash.
    expect(screen.getByText('Connect your calendar')).toBeInTheDocument();
    expect(screen.getByText('Google Calendar')).toBeInTheDocument();
    expect(screen.getByText('Microsoft Outlook')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Connect another calendar/ })
    ).not.toBeInTheDocument();
  });

  // ── T17 — O365 waiting retry goes straight to OAuth (plan §12.1, "Explicitly preserved") ──

  it('retries Microsoft directly from the o365_waiting notice — no guidance loop, and no forged CONTINUED', async () => {
    mockSearchParams = new URLSearchParams(
      'calendar_error=o365_admin_approval&calendar_provider=microsoft'
    );
    mockInitiateConnect.mockResolvedValue({ success: false, error: 'still waiting' });
    const user = userEvent.setup();
    render(<CalendarConnectionsSection />);

    await screen.findByText('Your IT admin needs to take action');
    await user.click(screen.getByRole('button', { name: /Try connecting again/ }));

    expect(screen.queryByText('Connect Microsoft 365')).not.toBeInTheDocument();
    await waitFor(() => expect(mockInitiateConnect).toHaveBeenCalledWith('microsoft'));
    expect(track).toHaveBeenCalledWith(CALENDAR_EVENTS.O365_WAITING_TRY_AGAIN, {});
    // The guidance funnel is not forked: a CONTINUED with no preceding SHOWN never fires.
    expect(trackCallsFor(CALENDAR_EVENTS.O365_GUIDANCE_CONTINUED)).toHaveLength(0);
    expect(trackCallsFor(CALENDAR_EVENTS.O365_GUIDANCE_SHOWN)).toHaveLength(0);
  });
});
