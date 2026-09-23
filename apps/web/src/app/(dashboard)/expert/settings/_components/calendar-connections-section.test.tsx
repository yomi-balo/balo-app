import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
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
  buildAddMenuOptions,
  buildCalendarRows,
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

/** The card root — a `<section>` named by its "Calendars" heading. */
function getCard(): HTMLElement {
  return screen.getByRole('region', { name: 'Calendars' });
}

async function openAddMenu(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(await screen.findByRole('button', { name: /Add calendar/ }));
}

/** Connect a provider the only way the card offers it: through the Add calendar menu. */
async function pickFromAddMenu(
  user: ReturnType<typeof userEvent.setup>,
  provider: RegExp
): Promise<void> {
  await openAddMenu(user);
  await user.click(await screen.findByRole('menuitem', { name: provider }));
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

  // ── Card shell (always rendered) ─────────────────────────────

  it('renders ONE card, named by its "Calendars" heading, in every state', async () => {
    render(<CalendarConnectionsSection />);
    const card = getCard();
    expect(card.tagName).toBe('SECTION');
    expect(within(card).getByRole('heading', { level: 2, name: 'Calendars' })).toBeInTheDocument();
    await within(card).findByRole('button', { name: /Add calendar/ });
  });

  // ── Four surface states, all inside the card ──────────────────

  it('renders the loading skeleton inside the card, with no Add calendar menu yet', () => {
    mockGetConnections.mockReturnValue(new Promise(() => {})); // never resolves
    render(<CalendarConnectionsSection />);
    expect(within(getCard()).getByLabelText('Loading')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Add calendar/ })).not.toBeInTheDocument();
  });

  it('renders SectionError inside the card and retries on click when the fetch fails', async () => {
    mockGetConnections.mockResolvedValue({ ok: false, error: 'boom' });
    const user = userEvent.setup();
    render(<CalendarConnectionsSection />);

    const alert = await within(getCard()).findByRole('alert');
    expect(alert).toHaveTextContent("We couldn't load your calendars");
    expect(screen.queryByRole('button', { name: /Add calendar/ })).not.toBeInTheDocument();

    mockGetConnections.mockResolvedValue({ ok: true, connections: [] });
    await user.click(screen.getByRole('button', { name: /Try again/ }));
    expect(await within(getCard()).findByTestId('calendars-empty')).toBeInTheDocument();
  });

  it('shows ONE invitation pointing at Add calendar, and no provider rows, with zero connections', async () => {
    render(<CalendarConnectionsSection />);

    const empty = await within(getCard()).findByTestId('calendars-empty');
    expect(empty).toHaveTextContent(
      'Connect Google Calendar or Microsoft Outlook with Add calendar, and anything busy on it is hidden from clients automatically.'
    );
    expect(screen.queryAllByRole('listitem')).toHaveLength(0);
    expect(screen.queryByRole('button', { name: /^Connect / })).not.toBeInTheDocument();
    expect(screen.queryByText('Google Workspace or Gmail')).not.toBeInTheDocument();
    expect(screen.queryByText(/Not connected/i)).not.toBeInTheDocument();
    // The one way in stays available.
    expect(screen.getByRole('button', { name: /Add calendar/ })).toBeInTheDocument();
  });

  it('renders a row for a live connection and NO standalone row for the unconnected provider', async () => {
    mockGetConnections.mockResolvedValue({ ok: true, connections: [makeConnection()] });
    render(<CalendarConnectionsSection />);

    expect(await screen.findByText('yomi@gmail.com')).toBeInTheDocument();
    expect(screen.getByText('Connected')).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    expect(screen.queryByRole('heading', { name: 'Microsoft Outlook' })).not.toBeInTheDocument();
    expect(screen.queryByText('Microsoft 365 or Outlook.com')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Connect / })).not.toBeInTheDocument();
    expect(screen.queryByTestId('calendars-empty')).not.toBeInTheDocument();
  });

  it("shows the connected row's busy toggles and booking target with nothing to expand", async () => {
    mockGetConnections.mockResolvedValue({ ok: true, connections: [makeToggleableConnection()] });
    render(<CalendarConnectionsSection />);

    expect(await screen.findByRole('switch', { name: 'Block time from Team' })).toBeVisible();
    expect(screen.getByRole('group', { name: 'Busy calendars' })).toBeInTheDocument();
    expect(screen.getByTestId('target-value')).toHaveTextContent('cal-1');
  });

  it('renders exactly the two connection rows once both providers are connected', async () => {
    mockGetConnections.mockResolvedValue({
      ok: true,
      connections: [
        makeConnection(),
        makeConnection({ provider: 'microsoft', providerEmail: 'yomi@outlook.com' }),
      ],
    });
    render(<CalendarConnectionsSection />);

    await screen.findByText('yomi@outlook.com');
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: /^Connect / })).not.toBeInTheDocument();
  });

  it('renders one row per connection, so two accounts of one provider are two rows', async () => {
    mockGetConnections.mockResolvedValue({
      ok: true,
      connections: [makeConnection(), makeConnection({ providerEmail: 'yomi.work@gmail.com' })],
    });
    render(<CalendarConnectionsSection />);

    expect(await screen.findByText('yomi@gmail.com')).toBeInTheDocument();
    expect(screen.getByText('yomi.work@gmail.com')).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { level: 3, name: 'Google Calendar' })).toHaveLength(2);
    // Each row's booking-target picker still renders its own copy of the panel.
    expect(screen.getAllByTestId('target-value')).toHaveLength(2);
  });

  it('always renders the trust line and the iCloud line in the card footer', async () => {
    render(<CalendarConnectionsSection />);
    await findReady();
    const card = getCard();
    expect(
      await within(card).findByText(
        'Events on any connected calendar block that time from client bookings. We only read event times — details are never shared with clients.'
      )
    ).toBeInTheDocument();
    expect(within(card).getByText(/On iCloud\?/)).toBeInTheDocument();
  });

  // ── "Add calendar" menu ───────────────────────────────────────

  describe('Add calendar menu', () => {
    it('always lists both providers, each with its brand label', async () => {
      const user = userEvent.setup();
      render(<CalendarConnectionsSection />);
      await openAddMenu(user);

      const items = await screen.findAllByRole('menuitem');
      expect(items).toHaveLength(2);
      expect(items[0]).toHaveTextContent('Google Calendar');
      expect(items[1]).toHaveTextContent('Microsoft Outlook');
      for (const item of items) expect(item).not.toHaveAttribute('aria-disabled', 'true');
    });

    it('disables a provider that is already connected, and says so', async () => {
      mockGetConnections.mockResolvedValue({ ok: true, connections: [makeConnection()] });
      const user = userEvent.setup();
      render(<CalendarConnectionsSection />);
      await screen.findByText('yomi@gmail.com');
      await openAddMenu(user);

      const google = await screen.findByRole('menuitem', { name: /Google Calendar/ });
      expect(google).toHaveAttribute('aria-disabled', 'true');
      expect(google).toHaveTextContent('Connected');
      const microsoft = screen.getByRole('menuitem', { name: /Microsoft Outlook/ });
      expect(microsoft).not.toHaveAttribute('aria-disabled', 'true');
      expect(microsoft).not.toHaveTextContent('Connected');
    });

    it('disables a provider with an attempt in flight, naming the attempt rather than "Connected"', async () => {
      mockSearchParams = new URLSearchParams(
        'calendar_error=callback_failed&calendar_provider=google'
      );
      const user = userEvent.setup();
      render(<CalendarConnectionsSection />);
      await screen.findByText(/didn't finish/);
      await openAddMenu(user);

      const google = await screen.findByRole('menuitem', { name: /Google Calendar/ });
      expect(google).toHaveAttribute('aria-disabled', 'true');
      expect(google).toHaveTextContent("Didn't finish");
      expect(google).not.toHaveTextContent('Connected');
    });

    it('starts Google OAuth as a first connect when nothing is connected yet', async () => {
      const user = userEvent.setup();
      render(<CalendarConnectionsSection />);
      await openAddMenu(user);
      await user.click(await screen.findByRole('menuitem', { name: /Google Calendar/ }));

      await waitFor(() => expect(mockInitiateConnect).toHaveBeenCalledWith('google'));
      expect(track).toHaveBeenCalledWith(CALENDAR_EVENTS.CONNECT_INITIATED, {
        provider: 'google',
        source: 'first_connect',
      });
    });

    it('counts a connect beside an existing row as add_another', async () => {
      mockGetConnections.mockResolvedValue({
        ok: true,
        connections: [makeConnection({ provider: 'microsoft', providerEmail: 'yomi@outlook.com' })],
      });
      const user = userEvent.setup();
      render(<CalendarConnectionsSection />);
      await screen.findByText('yomi@outlook.com');
      await openAddMenu(user);
      await user.click(await screen.findByRole('menuitem', { name: /Google Calendar/ }));

      await waitFor(() =>
        expect(track).toHaveBeenCalledWith(CALENDAR_EVENTS.CONNECT_INITIATED, {
          provider: 'google',
          source: 'add_another',
        })
      );
    });

    it('routes Microsoft through the O365 guidance dialog, carrying the add_another source through Continue', async () => {
      mockGetConnections.mockResolvedValue({ ok: true, connections: [makeConnection()] });
      mockInitiateConnect.mockResolvedValue({
        success: true,
        connectUrl: 'https://vendor.example/o',
      });
      const user = userEvent.setup();
      render(<CalendarConnectionsSection />);
      await screen.findByText('yomi@gmail.com');
      await openAddMenu(user);
      await user.click(await screen.findByRole('menuitem', { name: /Microsoft Outlook/ }));

      expect(await screen.findByText('Connect Microsoft 365')).toBeInTheDocument();
      expect(track).toHaveBeenCalledWith(CALENDAR_EVENTS.O365_GUIDANCE_SHOWN, {});
      expect(mockInitiateConnect).not.toHaveBeenCalled();

      await user.click(screen.getByRole('button', { name: /Continue to Microsoft 365/ }));
      await waitFor(() => expect(mockInitiateConnect).toHaveBeenCalledWith('microsoft'));
      expect(track).toHaveBeenCalledWith(CALENDAR_EVENTS.CONNECT_INITIATED, {
        provider: 'microsoft',
        source: 'add_another',
      });
    });
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

  it('scrolls the card itself into view after consuming the OAuth callback', async () => {
    const scrollIntoView = vi.fn();
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scrollIntoView;
    try {
      mockSearchParams = new URLSearchParams('calendar_connected=true&calendar_provider=google');
      mockGetConnections.mockResolvedValue({ ok: true, connections: [makeConnection()] });
      render(<CalendarConnectionsSection />);

      await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1));
      expect(scrollIntoView.mock.contexts[0]).toBe(getCard());
      expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'auto', block: 'start' });
    } finally {
      Element.prototype.scrollIntoView = original;
    }
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
    // No transient was set for any specific provider — no attempt row, just the invitation.
    expect(await within(getCard()).findByTestId('calendars-empty')).toBeInTheDocument();
    expect(screen.queryAllByRole('listitem')).toHaveLength(0);
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

    await pickFromAddMenu(user, /Microsoft Outlook/);

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

    await pickFromAddMenu(user, /Microsoft Outlook/);
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

    await pickFromAddMenu(user, /Microsoft Outlook/);
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
  // `sectionState = 'loading'` and replaced the whole section (the card's rows and footer)
  // with the skeleton, undoing the optimistic removal on screen.
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

  describe('buildCalendarRows', () => {
    const google = makeConnection();
    const microsoft = makeConnection({ provider: 'microsoft', providerEmail: 'yomi@outlook.com' });

    it('has no rows when there is nothing connected and nothing in flight', () => {
      expect(buildCalendarRows([], {})).toEqual([]);
    });

    it('gives a connected provider a slot row with its derived state, in provider order', () => {
      const rows = buildCalendarRows([microsoft, google], {});
      expect(rows.map((row) => row.provider)).toEqual(['google', 'microsoft']);
      expect(rows[0]).toMatchObject({ slotState: 'connected', connection: google });
    });

    it('gives each of several same-provider connections its own row', () => {
      const work = makeConnection({ providerEmail: 'yomi.work@gmail.com' });
      const rows = buildCalendarRows([google, work], {});
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({ key: 'google-0', connection: google });
      expect(rows[1]).toMatchObject({ key: 'google-1', connection: work });
    });

    it('gives a slot-claiming attempt with no connection a connection-less slot row', () => {
      expect(buildCalendarRows([], { google: 'attempt_failed' })).toEqual([
        {
          key: 'google-0',
          provider: 'google',
          connection: undefined,
          slotState: 'attempt_failed',
        },
      ]);
    });

    it('lets an in-flight transient override the connection it sits on', () => {
      expect(buildCalendarRows([google], { google: 'connecting' })[0]).toMatchObject({
        slotState: 'connecting',
        connection: google,
      });
    });

    it('adds no row while only the O365 guidance modal is open', () => {
      expect(buildCalendarRows([], { microsoft: 'o365_guidance' })).toEqual([]);
    });
  });

  describe('buildAddMenuOptions', () => {
    it('lists both providers, enabled, when neither has a row', () => {
      expect(buildAddMenuOptions(buildCalendarRows([], {}))).toEqual([
        { provider: 'google', unavailableReason: null },
        { provider: 'microsoft', unavailableReason: null },
      ]);
    });

    it('marks a provider with a connection as Connected, whatever its credential state', () => {
      const expired = makeConnection({ credentialStatus: 'EXPIRED' });
      expect(buildAddMenuOptions(buildCalendarRows([expired], {}))).toEqual([
        { provider: 'google', unavailableReason: 'Connected' },
        { provider: 'microsoft', unavailableReason: null },
      ]);
    });

    it("names a connection-less attempt by its row's status", () => {
      expect(buildAddMenuOptions(buildCalendarRows([], { microsoft: 'o365_waiting' }))).toEqual([
        { provider: 'google', unavailableReason: null },
        { provider: 'microsoft', unavailableReason: 'Waiting on IT' },
      ]);
    });

    it('falls back to Connected for a connection-less slot whose state has no status words', () => {
      const idleSlot = {
        key: 'google-0',
        provider: 'google',
        connection: undefined,
        slotState: 'idle',
      } as const;
      expect(buildAddMenuOptions([idleSlot])).toEqual([
        { provider: 'google', unavailableReason: 'Connected' },
        { provider: 'microsoft', unavailableReason: null },
      ]);
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

  it('keeps the empty-state invitation mounted, and adds no row, while the guidance dialog is open', async () => {
    const user = userEvent.setup();
    render(<CalendarConnectionsSection />);

    await pickFromAddMenu(user, /Microsoft Outlook/);
    expect(await screen.findByText('Connect Microsoft 365')).toBeInTheDocument();

    // ⚠ BAL-397 — `o365_guidance` is a modal, not a slot. If it claimed one, a bodyless
    // Microsoft row would replace the invitation behind the overlay (and every connect source
    // would flip to add_another) until the dialog closed. The modal hides everything behind it
    // from the accessibility tree, hence `hidden: true`.
    const card = screen.getByRole('region', { name: 'Calendars', hidden: true });
    expect(within(card).getByTestId('calendars-empty')).toBeInTheDocument();
    expect(within(card).queryAllByRole('listitem', { hidden: true })).toHaveLength(0);
    expect(within(card).queryByText('Waiting for you')).not.toBeInTheDocument();
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
