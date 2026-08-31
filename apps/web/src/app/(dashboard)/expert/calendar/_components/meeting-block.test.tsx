import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { axe } from 'jest-axe';
import { render, screen, fireEvent } from '@/test/utils';
import { MeetingBlock } from './meeting-block';
import type { CalendarMeetingView } from '../_lib/calendar-view-types';

vi.mock('motion/react', async () => {
  const { createMotionStub } = await import('@/test/motion-stub');
  return createMotionStub();
});

/**
 * R5 — pins that the card body navigates through `next/link`, not a raw `<a href>`. In jsdom
 * `next/link` renders an ordinary anchor, so nothing else in this suite can tell the two apart;
 * the `data-next-link` marker is the only thing that fails if someone reverts to a plain anchor
 * (a full document reload on an in-app route).
 */
vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
  } & React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={href} data-next-link="true" {...rest}>
      {children}
    </a>
  ),
}));

/**
 * S1 — the Join affordance NAVIGATES rather than rendering an `href`, so the navigation itself is
 * what has to be asserted. jsdom's `Location` exposes `assign` as a NON-CONFIGURABLE own property
 * and cannot be spied; `globalThis.location` itself IS configurable, so the whole object is
 * swapped and restored — the same idiom as `case-conversation-panel.test.tsx`.
 */
const realLocation = globalThis.location;
let mockAssign: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockAssign = vi.fn();
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: { href: realLocation.href, origin: realLocation.origin, assign: mockAssign },
  });
});

afterEach(() => {
  Object.defineProperty(globalThis, 'location', { configurable: true, value: realLocation });
});

function meeting(overrides: Partial<CalendarMeetingView> = {}): CalendarMeetingView {
  return {
    meetingId: 'm-1',
    scheduledStart: '2026-08-24T09:00:00.000Z',
    scheduledEnd: '2026-08-24T09:30:00.000Z',
    contextType: 'case',
    href: '/cases/e1',
    joinUrl: 'https://balo.expert/join/m/m-1',
    counterpartyCompanyName: 'Northwind',
    ...overrides,
  };
}

const NOOP = (): void => {};

/** Every prop BUT `meeting`, at the values 11 of the 12 cases want. `now` is deliberately absent —
 *  BAL-511 lifted the three `now`-derived inputs into `WeekGrid` so this component can be
 *  `React.memo`'d on primitives. */
const BLOCK_DEFAULTS = {
  timezone: 'UTC',
  top: 0,
  height: 64,
  leftPercent: 0,
  widthPercent: 100,
  isPast: false,
  joinVisible: false,
  joinTimingLabel: null,
  onJoinClick: NOOP,
} as const;

function renderBlock(
  over: Partial<React.ComponentProps<typeof MeetingBlock>> = {}
): ReturnType<typeof render> {
  return render(<MeetingBlock meeting={meeting()} {...BLOCK_DEFAULTS} {...over} />);
}

describe('MeetingBlock — full mode', () => {
  it('renders as a link to the owning engagement with time, party and engagement type', () => {
    renderBlock();

    const link = screen.getByRole('link', { name: /9:00 – 9:30 AM, Case with Northwind/i });
    expect(link).toHaveAttribute('href', '/cases/e1');
    // R5 — an in-app route goes through `next/link`; a raw `<a href>` forced a full page reload.
    expect(link).toHaveAttribute('data-next-link', 'true');
    expect(screen.getByText('Northwind')).toBeInTheDocument();
    expect(screen.getByText('Case')).toBeInTheDocument();
  });

  // H12 + fix round 6 item 3. The invariant is unchanged — a non-navigable card must still carry
  // the SAME accessible name — only the element supplying the role changed, from
  // `<span role="group">` to `<article>` (a real element with an implicit role, per SonarCloud
  // S6819). The `aria-label`-on-a-bare-`<span>` regression H12 caught would fail this assertion
  // exactly as before: a bare span exposes no role, so `getByRole` finds nothing.
  it('when href is null, renders a non-link article carrying the same accessible name (H12: a real role, never aria-label on a bare span)', () => {
    renderBlock({ meeting: meeting({ href: null }) });

    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(
      screen.getByRole('article', { name: /9:00 – 9:30 AM, Case with Northwind/i })
    ).toBeInTheDocument();
  });

  it('the inline Join button renders when the parent reports joinVisible, fires onJoinClick with the meeting, and navigates to the tokenless lobby URL', () => {
    const onJoinClick = vi.fn();
    const imminent = meeting({
      scheduledStart: '2026-08-24T08:05:00.000Z',
      scheduledEnd: '2026-08-24T08:35:00.000Z',
    });
    renderBlock({
      meeting: imminent,
      joinVisible: true,
      joinTimingLabel: 'starting in 5 minutes',
      onJoinClick,
    });

    const joinButton = screen.getByRole('button', { name: /Join Northwind's meeting/i });
    fireEvent.click(joinButton);
    expect(onJoinClick).toHaveBeenCalledWith(imminent);
    // The URL is reached by NAVIGATING, not by being rendered.
    expect(mockAssign).toHaveBeenCalledWith('https://balo.expert/join/m/m-1');
  });

  /**
   * S1 — the security regression this replaces an `<a href>` to prevent. PostHog autocapture is
   * ON and ships `$elements[].attr__href` (which `sanitizeAnalyticsEvent` never walks), and
   * Sentry Session Replay records rrweb DOM snapshots whose default `maskAttributes` excludes
   * `href`. So an `href` here leaked `/join/m/{meetingId}` — sensitive-by-policy in
   * `SENSITIVE_PATH_PREFIXES` — to two external processors just by RENDERING, before any click.
   */
  it('renders NO element whose href contains /join/m/ — the lobby URL never enters the DOM (S1)', () => {
    const imminent = meeting({
      scheduledStart: '2026-08-24T08:05:00.000Z',
      scheduledEnd: '2026-08-24T08:35:00.000Z',
    });
    const { container } = renderBlock({
      meeting: imminent,
      joinVisible: true,
      joinTimingLabel: 'starting in 5 minutes',
    });

    const hrefs = [...container.querySelectorAll('[href]')].map((node) =>
      node.getAttribute('href')
    );
    expect(hrefs).not.toHaveLength(0); // the card body IS still a link — non-vacuous
    expect(hrefs.some((href) => href?.includes('/join/m/'))).toBe(false);
    expect(container.innerHTML).not.toContain('/join/m/');
  });

  it('A1 — the Join chip keeps its small visual but extends its hit area to the 44px minimum, and carries the live ping-ring cue', () => {
    const imminent = meeting({
      scheduledStart: '2026-08-24T08:05:00.000Z',
      scheduledEnd: '2026-08-24T08:35:00.000Z',
    });
    renderBlock({
      meeting: imminent,
      joinVisible: true,
      joinTimingLabel: 'starting in 5 minutes',
    });

    // 24px visual (`size="icon-xs"`) + 10px of transparent pseudo-element on every side = 44px.
    const joinButton = screen.getByRole('button', { name: /Join Northwind's meeting/i });
    expect(joinButton.className).toContain("after:content-['']");
    expect(joinButton.className).toContain('after:-inset-2.5');
    // BAL-511 / ADR-1053 — the ambient live-call ping ring, baked into JoinMeetingButton itself,
    // replacing the old whole-button animate-pulse.
    expect(joinButton.className).toContain('motion-safe:before:animate-ping-slow');
    expect(joinButton.className).toContain('motion-reduce:ring-2');
    expect(joinButton.className).toContain('motion-reduce:ring-primary');
    // ⚠ NO ALPHA MODIFIER. `toContain('motion-reduce:ring-primary')` alone also matches
    // `motion-reduce:ring-primary/40` — the pre-existing value that measures 1.47:1 in light
    // mode, below WCAG 1.4.11's 3:1 floor. This pins FULL opacity so re-adding an alpha fails.
    expect(joinButton.className).not.toContain('motion-reduce:ring-primary/');
    expect(joinButton.className).not.toContain('animate-pulse');
  });

  it('no Join affordance when the parent reports joinVisible=false', () => {
    const later = meeting({
      scheduledStart: '2026-08-24T09:00:00.000Z',
      scheduledEnd: '2026-08-24T09:30:00.000Z',
    });
    renderBlock({ meeting: later });

    expect(screen.queryByRole('button', { name: /Join/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Join/i })).not.toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const { container } = renderBlock();

    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('MeetingBlock — compact mode (H13: below 24px, no inline Join, Popover carries full detail)', () => {
  it('suppresses the inline Join button and truncates to time + party only', () => {
    const imminent = meeting({
      scheduledStart: '2026-08-24T08:05:00.000Z',
      scheduledEnd: '2026-08-24T08:20:00.000Z',
    });
    renderBlock({
      meeting: imminent,
      height: 16,
      joinVisible: true,
      joinTimingLabel: 'starting in 5 minutes',
    });

    // The full-mode inline Join control is gone...
    expect(
      screen.queryByRole('button', { name: /^Join Northwind's meeting/i })
    ).not.toBeInTheDocument();
    // ...but nothing about the meeting is actually unreachable: the info affordance opens a
    // Popover carrying the full time range, party, and a real Join action.
    expect(
      screen.getByRole('button', { name: /Details for Northwind's case/i })
    ).toBeInTheDocument();
  });

  it('A4 — the 14px info affordance keeps its visual but extends its hit area', () => {
    const compact = meeting({
      scheduledStart: '2026-08-24T09:00:00.000Z',
      scheduledEnd: '2026-08-24T09:15:00.000Z',
    });
    renderBlock({ meeting: compact, height: 16 });

    // Pseudo-element rather than `-m-3 p-3`: this button is ABSOLUTELY positioned, so negative
    // margins would drag the visual chip out of the card corner.
    const info = screen.getByRole('button', { name: /Details for Northwind's case/i });
    expect(info.className).toContain('h-3.5');
    expect(info.className).toContain('after:-inset-3');
    expect(info.className).toContain("after:content-['']");
  });

  it('the Popover reveals the full time range, party and a working Join action, carrying the same live cue (D2 net-new site)', () => {
    const onJoinClick = vi.fn();
    const imminent = meeting({
      scheduledStart: '2026-08-24T08:05:00.000Z',
      scheduledEnd: '2026-08-24T08:20:00.000Z',
    });
    renderBlock({
      meeting: imminent,
      height: 16,
      joinVisible: true,
      joinTimingLabel: 'starting in 5 minutes',
      onJoinClick,
    });

    fireEvent.click(screen.getByRole('button', { name: /Details for Northwind's case/i }));

    const joinButton = screen.getByRole('button', { name: /Join Northwind's meeting/i });
    fireEvent.click(joinButton);
    expect(onJoinClick).toHaveBeenCalledWith(imminent);
    expect(mockAssign).toHaveBeenCalledWith('https://balo.expert/join/m/m-1');
    // Same S1 rule inside the popover — the popover Join was the SECOND `<a href={joinUrl}>`.
    expect(document.body.innerHTML).not.toContain('/join/m/');
    // BAL-511 D2 — this popover instance had neither the old pulse nor a reduced-motion fallback;
    // it now inherits the same live cue as the other two sites, from JoinMeetingButton itself.
    expect(joinButton.className).toContain('motion-safe:before:animate-ping-slow');
    expect(joinButton.className).toContain('motion-reduce:ring-2');
    expect(joinButton.className).not.toContain('animate-pulse');
  });

  it('compact mode without an imminent meeting shows the info affordance but no Join action inside it', () => {
    const later = meeting({
      scheduledStart: '2026-08-24T09:00:00.000Z',
      scheduledEnd: '2026-08-24T09:15:00.000Z',
    });
    renderBlock({ meeting: later, height: 16 });

    fireEvent.click(screen.getByRole('button', { name: /Details for Northwind's case/i }));
    expect(
      screen.queryByRole('button', { name: /Join Northwind's meeting/i })
    ).not.toBeInTheDocument();
  });
});

describe('MeetingBlock — cross-midnight continuation fragment (H9)', () => {
  it('the accessible name notes it is a continuation', () => {
    renderBlock({ isContinuationFragment: true });

    expect(screen.getByRole('link', { name: /continued from yesterday/i })).toBeInTheDocument();
  });
});

/**
 * BAL-511 D1 — the structural half of the memo AC.
 * `calendar-shell-tick-stability.test.tsx` proves the OTHER half (that the props handed down by
 * the real tree are actually stable across a tick); neither is sufficient alone.
 */
describe('MeetingBlock — memoised (BAL-511)', () => {
  it('is memoised — the 60-second tick must not re-render every block on the grid', () => {
    expect((MeetingBlock as unknown as { $$typeof?: symbol }).$$typeof).toBe(
      Symbol.for('react.memo')
    );
  });

  it('the lifted isPast prop is what mutes a finished meeting', () => {
    const { container } = renderBlock({ isPast: true });
    expect(container.innerHTML).toContain('opacity-60');
    const fresh = renderBlock();
    expect(fresh.container.innerHTML).not.toContain('opacity-60');
  });

  it('the lifted joinTimingLabel is what the Join aria-label says', () => {
    const imminent = meeting({
      scheduledStart: '2026-08-24T08:00:00.000Z',
      scheduledEnd: '2026-08-24T08:30:00.000Z',
    });
    renderBlock({ meeting: imminent, joinVisible: true, joinTimingLabel: 'starting now' });
    expect(
      screen.getByRole('button', { name: "Join Northwind's meeting, starting now" })
    ).toBeInTheDocument();
  });
});
