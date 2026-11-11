/**
 * Balo — Top-nav call pill (design reference, v1)
 * File: `.claude/design-references/top-nav-call-pill.jsx`
 *
 * One affordance in `TopNav` (`components/layout/top-nav.tsx`) that lets a person join a call
 * that is about to start, or is running, from any page of the dashboard shell.
 *
 * ── WHERE ────────────────────────────────────────────────────────────────────────────────────
 *  · In `TopNav`, AFTER `<CommandPalette />` and BEFORE `{creditsChip}` / `<NotificationBell />`.
 *    `TopNav` is the one bar that is sticky on every breakpoint; the sidebar is replaced by
 *    `MobileTabBar` on phones, so a sidebar placement would miss mobile entirely.
 *  · The live call itself is `(call)/meetings/[meetingId]/call`, a route group with NO TopNav
 *    (`(call)/layout.tsx`), so the pill can never sit on top of the call it points at.
 *
 * ── WHEN IT RENDERS (one meeting = "the primary"; see SELECTION) ─────────────────────────────
 *  state            condition (all via `resolveUpNextRowTiming` → `calendarMeetingTiming`)    shows
 *  ─────────────────────────────────────────────────────────────────────────────────────────────
 *  nothing          no meeting inside the join window                                         —
 *  lead-in ⚑        OPTIONAL, owner to decide. start − now ≤ 15 min, window not yet open       still strip, NO button
 *  joinable         `joinVisible` (−3 min … scheduled end + 30 min, non-terminal, room ready) strip + Join, ping ring
 *  joinable, quiet  joinable AND (this page already renders a Join for the same meeting        strip + Join, STATIC ring
 *                   OR now ≥ scheduled end, i.e. the overrun grace)
 *  room setting up  `roomSettingUp` (window open, room not ready)                              strip + `RoomSettingUpSlot`
 *  hidden           the page is this meeting's own recap/end route (`/meetings/{id}`,          —
 *                   `/meetings/{id}/end`), OR the session is staff "viewing as" a user
 *
 *  ⚠ THE WINDOW IS 3 MINUTES, NOT 15. `CASE_JOIN_WINDOW_MINUTES = 3` (D16, BAL-474), enforced on
 *    the server by `assertMeetingJoinable`. Without the lead-in, the pill first appears 3 minutes
 *    before the start. ⚑ The lead-in row above is the proposal that answers that; it is a toggle
 *    in this prototype and is OFF unless the owner turns it on.
 *  ⚠ NO COUNTDOWN BUTTON IN THE NAV. Unlike the case nudge, the nav never renders an inactive
 *    control ("Join in 2 days"). The lead-in, if adopted, has no button at all — absent beats dead.
 *
 * ── SELECTION ────────────────────────────────────────────────────────────────────────────────
 *  · Candidates: every meeting whose window is open (joinable or room setting up), minus the one
 *    whose recap/end route is the current page.
 *  · Primary = the candidate with the LATEST `scheduledStart`. Back-to-back is the normal case
 *    that needs this: a 9:30 call in its overrun grace and a 10:00 call whose window just opened
 *    are both joinable at 9:58, and the 10:00 one is the one the person is heading to.
 *  · The rest go behind a "+N" button that opens a short list, each row with its own Join.
 *    The list's Joins are always STATIC — one moving thing.
 *
 * ── ONE MOVING THING ─────────────────────────────────────────────────────────────────────────
 *  The case nudge, the dashboard Up next row, and the calendar all render `JoinMeetingButton`,
 *  which carries the ADR-1053 ping ring unconditionally. On those pages the pill would be a second
 *  ring for the same call, so the pill goes STATIC (the reduced-motion ring) while any on-page
 *  `JoinMeetingButton` shows the same `joinUrl`. It stays in place — nav chrome does not appear
 *  and disappear per page. It also stays static in the overrun grace: the urgency is the start.
 *
 * ── REUSE MAP (nothing below is new except where marked NEW) ─────────────────────────────────
 *  · Button      `JoinMeetingButton` (components/balo/meetings) — 6th call site. NEW prop
 *                `liveCue?: boolean` (default true; false = the motion-reduce static ring), and
 *                NEW on-page registration of its `joinUrl` (opt out with `registerOnPage={false}`,
 *                which the pill's own instance passes). Its docblock anticipates exactly this:
 *                "add a prop and condition the cue on it rather than deleting it".
 *  · Not ready   `RoomSettingUpSlot` variant="button" label="short" (desktop), variant="chip" (phone).
 *  · Timing      `resolveUpNextRowTiming` (dashboard/_lib/up-next-presentation.ts) for
 *                `joinVisible` / `roomSettingUp` / `statusLine` / `joinTimingLabel`.
 *  · Copy        `UP_NEXT_JOIN` ("Join"), `upNextStartsIn(n)`, `UP_NEXT_HAPPENING_NOW`,
 *                `ROOM_SETTING_UP_SHORT_LABEL`, `joinAffordanceAriaLabel(name, timingLabel)`.
 *  · Clock       `useServerAnchoredClock(serverNowIso, JOIN_CLOCK_TICK_MS)` — the case nudge's
 *                30 s server-anchored clock, so the pill and the nudge flip on the same tick and
 *                a fast/slow device clock never decides liveness.
 *  · Rows        `selectUpNextRows` + `buildUpNextRowViews` → `UpNextRowView` (counterparty name,
 *                context type, `joinPath`, `href`). Those helpers move out of
 *                `dashboard/_lib/` into `lib/meetings/` so the layout can import them.
 *  · Look        `STRIP` below: a white bordered `rounded-lg` box; name `text-[13px]
 *                font-semibold`, status `text-xs font-medium text-muted-foreground`.
 *
 * ── PHONE (< sm) ─────────────────────────────────────────────────────────────────────────────
 *  Join only: green dot + "Join", visual h-9, ≥44px hit area via the button's own `after:`.
 *  "+N" stays (same list). Lead-in hidden. Room setting up = the hourglass chip.
 *
 * ── NEW COPY (MJ sign-off, flagged in the PR body; does not block the build) ─────────────────
 *  · announcement  "Your call with {name} is ready to join."  (sr-only, polite, once per meeting)
 *  · "+N" label    "{n} more call(s)"  (aria-label "Show {n} more call(s)")
 *  · list title    "Calls you can join"
 *
 * ── NOT TO DO ────────────────────────────────────────────────────────────────────────────────
 *  · Never an `<a href>` to the call route — the button and `location.assign` are the reason
 *    `JoinMeetingButton` exists (PostHog autocapture / Replay; see its docblock).
 *  · Never a second definition of the window, the grace, or "happening now".
 *  · Never announce on every tick; never a live region on the status text.
 *  · Never render while impersonating — mirrors the bell's passive posture (`impersonating`).
 *
 * `initial` deep-links a state — `{ scenario, page, lens, width, leadIn, motion, listOpen }`;
 * `motion` is 'device' (default, honours prefers-reduced-motion), 'force' or 'reduced'.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  Bell,
  Briefcase,
  CalendarClock,
  CalendarDays,
  ChevronRight,
  Hourglass,
  LayoutDashboard,
  MessageSquare,
  MoreHorizontal,
  Search,
  Settings,
  Video,
} from 'lucide-react';

// ── Product constants (mirrors of the real ones — never a second definition in the build) ────
const JOIN_WINDOW_MINUTES = 3; // CASE_JOIN_WINDOW_MINUTES (D16)
const OVERRUN_GRACE_MINUTES = 30; // MEETING_OVERRUN_GRACE_MINUTES
const LEAD_IN_MINUTES = 15; // ⚑ proposal only

const UP_NEXT_JOIN = 'Join';
const UP_NEXT_HAPPENING_NOW = 'Happening now';
const upNextStartsIn = (minutes) => `Starts in ${minutes} min`;
const ROOM_SETTING_UP_SHORT_LABEL = 'Setting up room';
const ROOM_SETTING_UP_LABEL = 'Setting up your call room';
const NAV_CALL_READY = (name) => `Your call with ${name} is ready to join.`; // NEW — MJ
const NAV_MORE_CALLS = (n) => `${n} more call${n === 1 ? '' : 's'}`; // NEW — MJ
const NAV_CALL_LIST_TITLE = 'Calls you can join'; // NEW — MJ

/** `joinAffordanceTimingLabel` — the aria suffix. */
function timingLabel(minutesToStart) {
  if (minutesToStart < 0) return 'in progress';
  if (minutesToStart === 0) return 'starting now';
  return `starting in ${minutesToStart} minute${minutesToStart === 1 ? '' : 's'}`;
}
/** `joinAffordanceAriaLabel` */
const joinAria = (name, label) => `Join ${name}'s meeting, ${label}`;

// ── Fixtures ─────────────────────────────────────────────────────────────────────────────────
const PARTIES = {
  client: {
    a: { name: 'Priya Sharma', context: 'Lead conversion flow is failing', kind: 'Consultation' },
    b: { name: 'Marcus Chen', context: 'CPQ rollout', kind: 'Project call' },
    workspace: 'Acme Logistics',
  },
  expert: {
    a: {
      name: 'Northwind Freight',
      context: 'Lead conversion flow is failing',
      kind: 'Consultation',
    },
    b: { name: 'Harbourside Dental', context: 'Service Cloud discovery', kind: 'Discovery call' },
    workspace: 'Expert workspace',
  },
};

/**
 * Each scenario places the calls relative to "now": `start` is minutes from now (negative =
 * already started). Durations are scheduled minutes.
 */
const SCENARIOS = {
  later: { label: 'In 2 hours', calls: [{ id: 'a', start: 120, duration: 30, room: true }] },
  lead: { label: 'In 12 min', calls: [{ id: 'a', start: 12, duration: 30, room: true }] },
  opens: { label: 'In 2 min', calls: [{ id: 'a', start: 2, duration: 30, room: true }] },
  now: {
    label: 'Running',
    calls: [{ id: 'a', start: -10, duration: 30, room: true, inProgress: true }],
  },
  grace: {
    label: 'Overrun',
    calls: [{ id: 'a', start: -38, duration: 30, room: true, inProgress: true }],
  },
  room: { label: 'Room not ready', calls: [{ id: 'a', start: 2, duration: 30, room: false }] },
  b2b: {
    label: 'Back-to-back',
    calls: [
      { id: 'b', start: -28, duration: 30, room: true, inProgress: true },
      { id: 'a', start: 2, duration: 30, room: true },
    ],
  },
};

const PAGES = {
  messages: { label: 'Messages', crumbs: ['Messages'] },
  dashboard: { label: 'Dashboard', crumbs: ['Dashboard'] },
  case: { label: 'This call’s case', crumbs: ['Cases', 'Lead conversion flow is failing'] },
  recap: { label: 'This call’s recap', crumbs: ['Meetings', 'Recap'] },
};

/** `resolveUpNextRowTiming` + the lead-in proposal, for one call at "now" (= 0). */
function timingOf(call, leadIn) {
  const minutesToStart = call.start;
  const end = call.start + call.duration;
  const windowOpen = minutesToStart <= JOIN_WINDOW_MINUTES && 0 < end + OVERRUN_GRACE_MINUTES;
  const joinVisible = windowOpen && call.room;
  const roomSettingUp = windowOpen && !call.room;
  const happeningNow = call.inProgress === true || minutesToStart <= 0;
  let statusLine = null;
  if (joinVisible)
    statusLine = happeningNow ? UP_NEXT_HAPPENING_NOW : upNextStartsIn(minutesToStart);
  else if (roomSettingUp) statusLine = ROOM_SETTING_UP_SHORT_LABEL;
  const inLeadIn = leadIn && !windowOpen && minutesToStart > 0 && minutesToStart <= LEAD_IN_MINUTES;
  if (inLeadIn) statusLine = upNextStartsIn(minutesToStart);
  return {
    windowOpen,
    joinVisible,
    roomSettingUp,
    inLeadIn,
    inGrace: end <= 0,
    statusLine,
    aria: joinVisible ? timingLabel(minutesToStart) : null,
  };
}

/** Which calls the current page itself shows a live `JoinMeetingButton` for. */
function pageJoinIds(page, calls) {
  if (page === 'dashboard') return calls.filter((c) => c.t.joinVisible).map((c) => c.id); // Up next lists them all
  if (page === 'case') return calls.filter((c) => c.id === 'a' && c.t.joinVisible).map((c) => c.id); // the nudge
  return [];
}

// ── Pieces ───────────────────────────────────────────────────────────────────────────────────

/**
 * THE STRIP — option A, owner's pick (2026-11-06). White, bordered, `rounded-lg`: the same
 * border as the search box and the bell beside it (`border-border bg-background`). No tinted
 * or green surface; green stays where it already lives in the app, the dot inside Join.
 * Urgency comes from Join alone. (Rejected: the green Up-next-row wash, a `bg-primary/5` tint,
 * and no container at all.)
 *
 * ⚠⚠ THE STRIP NEVER CHANGES THE BUTTON. Join is `JoinMeetingButton` in its default `Button`
 * shape — `rounded-md`, `bg-primary`, the emerald dot, the ping ring — exactly as on the case
 * nudge and Up next. Never `rounded-full`, never restyled for this surface. The ONLY difference
 * is height: the nudge and Up next pass `min-h-11` (44px); here it is `h-8` (32px) so it fits
 * the 56px bar, and the 44px tap target comes from the button's own `after:` area — the
 * week-grid chip's precedent in `JoinMeetingButton`'s docblock. Same rule for
 * `RoomSettingUpSlot` and "+N".
 */
const STRIP = {
  container: 'rounded-lg border border-slate-200 bg-white pr-1 pl-3',
  status: 'text-slate-500',
};

/**
 * `JoinMeetingButton` stand-in. `liveCue` false = the motion-reduce static ring, which is also
 * what every instance shows under `prefers-reduced-motion`. `size="row"` is the nudge / Up next
 * sizing (`min-h-11 px-4`); the nav uses the default (`h-8`). The shape never varies.
 */
function JoinButton({ ariaLabel, liveCue = true, compact = false, size, onJoin }) {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      onClick={onJoin}
      data-join={liveCue ? 'live' : 'quiet'}
      className={[
        'balo-join inline-flex shrink-0 items-center gap-1.5 bg-blue-600 font-medium whitespace-nowrap text-white',
        'hover:bg-blue-700 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 focus-visible:outline-none',
        'rounded-md',
        size === 'row'
          ? 'min-h-11 px-4 text-sm'
          : compact
            ? 'h-9 px-3 text-[13px]'
            : 'h-8 px-3 text-[13px]',
        liveCue ? 'balo-join-live' : 'balo-join-quiet',
      ].join(' ')}
    >
      <span aria-hidden="true" className="size-[7px] rounded-full bg-emerald-400" />
      {UP_NEXT_JOIN}
    </button>
  );
}

function RoomSettingUpSlot({ variant, size }) {
  if (variant === 'chip') {
    return (
      <span
        title={ROOM_SETTING_UP_LABEL}
        className="inline-flex size-6 items-center justify-center rounded-full bg-slate-100 text-slate-500"
      >
        <Hourglass className="size-3" aria-hidden="true" />
        <span className="sr-only">{ROOM_SETTING_UP_LABEL}</span>
      </span>
    );
  }
  return (
    <span
      className={[
        'inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-slate-50 font-medium whitespace-nowrap text-slate-500',
        size === 'row' ? 'min-h-11 px-4 text-sm' : 'h-8 px-3 text-[13px]',
      ].join(' ')}
    >
      <Hourglass className="size-3.5" aria-hidden="true" />
      {ROOM_SETTING_UP_SHORT_LABEL}
    </span>
  );
}

/** The "+N" button and its list. Every Join in the list is static — one moving thing. */
function MoreCalls({ calls, open, setOpen, compact, onJoin }) {
  const listId = useId();
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (event) => {
      if (ref.current && !ref.current.contains(event.target)) setOpen(false);
    };
    const onKey = (event) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, setOpen]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        aria-label={`Show ${NAV_MORE_CALLS(calls.length)}`}
        onClick={() => setOpen(!open)}
        className={[
          'relative inline-flex items-center justify-center text-xs font-semibold text-slate-700',
          'hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:outline-none',
          "after:absolute after:-inset-1.5 after:content-['']",
          'rounded-md',
          compact ? 'h-9 min-w-9 border border-slate-200 bg-white px-2' : 'h-8 min-w-8 px-1.5',
        ].join(' ')}
      >
        +{calls.length}
      </button>
      {open && (
        <div
          id={listId}
          role="dialog"
          aria-label={NAV_CALL_LIST_TITLE}
          className="absolute top-full right-0 z-50 mt-2 w-[300px] max-w-[calc(100vw-1.5rem)] rounded-xl border border-slate-200 bg-white p-1.5 shadow-[0_12px_32px_rgba(15,23,42,0.14)]"
        >
          <p className="px-2.5 pt-1.5 pb-1 text-xs font-semibold text-slate-500">
            {NAV_CALL_LIST_TITLE}
          </p>
          <ul>
            {calls.map((call) => (
              <li key={call.id} className="flex items-center gap-3 rounded-lg px-2.5 py-2">
                <a
                  href="#context"
                  className="min-w-0 flex-1 rounded focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:outline-none"
                >
                  <span className="block truncate text-[13px] font-semibold text-slate-900">
                    {call.party.name}
                  </span>
                  <span className="block truncate text-xs text-slate-500">
                    {call.party.kind}
                    {call.t.statusLine ? `, ${call.t.statusLine.toLowerCase()}` : ''}
                  </span>
                </a>
                {call.t.joinVisible ? (
                  <JoinButton
                    ariaLabel={joinAria(call.party.name, call.t.aria)}
                    liveCue={false}
                    onJoin={() => onJoin(call, 'list')}
                  />
                ) : (
                  <RoomSettingUpSlot variant="button" />
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Name over status — the one text block every style shares. */
function PartyText({ name, status, statusClassName }) {
  return (
    <span className="block min-w-0 leading-tight">
      <span className="block truncate text-[13px] font-semibold text-slate-900">{name}</span>
      <span className={['block truncate text-xs font-medium', statusClassName].join(' ')}>
        {status}
      </span>
    </span>
  );
}

/**
 * THE PILL. Desktop: the strip (name + status link, then Join, then "+N") in the chosen style.
 * Phone: Join (+N). Renders nothing when there is no primary.
 */
function CallPill({ primary, others, quiet, compact, listOpen, setListOpen, onJoin }) {
  if (!primary) return null;
  const { party, t } = primary;
  const style = STRIP;

  // ⚑ Lead-in (off unless the owner adopts it): the same container, no control. Hidden on phones.
  if (t.inLeadIn) {
    if (compact) return null;
    return (
      <a
        href="#context"
        data-pill="lead-in"
        className={[
          'hidden h-10 max-w-[260px] items-center gap-2.5 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:outline-none md:inline-flex',
          style.container,
          'pr-3',
        ].join(' ')}
      >
        <CalendarClock className="size-4 shrink-0 text-slate-500" aria-hidden="true" />
        <PartyText name={party.name} status={t.statusLine} statusClassName="text-slate-500" />
      </a>
    );
  }

  if (compact) {
    return (
      <div data-pill={t.joinVisible ? 'joinable' : 'room'} className="flex items-center gap-1.5">
        {t.joinVisible ? (
          <JoinButton
            compact
            ariaLabel={joinAria(party.name, t.aria)}
            liveCue={!quiet}
            onJoin={() => onJoin(primary, 'pill')}
          />
        ) : (
          <RoomSettingUpSlot variant="chip" />
        )}
        {others.length > 0 && (
          <MoreCalls calls={others} open={listOpen} setOpen={setListOpen} compact onJoin={onJoin} />
        )}
      </div>
    );
  }

  return (
    <div
      data-pill={t.joinVisible ? 'joinable' : 'room'}
      className={['inline-flex h-10 max-w-[340px] items-center gap-3', style.container].join(' ')}
    >
      <a
        href="#context"
        className="min-w-0 rounded focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:outline-none"
      >
        <PartyText
          name={party.name}
          status={t.joinVisible ? t.statusLine : party.kind}
          statusClassName={t.joinVisible ? style.status : 'text-slate-500'}
        />
      </a>
      {t.joinVisible ? (
        <JoinButton
          ariaLabel={joinAria(party.name, t.aria)}
          liveCue={!quiet}
          onJoin={() => onJoin(primary, 'pill')}
        />
      ) : (
        <RoomSettingUpSlot variant="button" />
      )}
      {others.length > 0 && (
        <MoreCalls calls={others} open={listOpen} setOpen={setListOpen} onJoin={onJoin} />
      )}
    </div>
  );
}

// ── Shell stand-ins (not part of the deliverable) ────────────────────────────────────────────
const NAV = [
  ['Dashboard', LayoutDashboard, 'dashboard'],
  ['Find experts', Search, null],
  ['Cases', Video, 'case'],
  ['Projects', Briefcase, null],
  ['Calendar', CalendarDays, null],
  ['Messages', MessageSquare, 'messages'],
];

function Sidebar({ page, workspace }) {
  return (
    <aside className="flex w-[232px] shrink-0 flex-col border-r border-slate-200 bg-white px-3 py-4">
      <div className="px-2 pb-4 text-[17px] font-bold tracking-tight text-slate-900">balo</div>
      <div className="mb-3 flex items-center gap-2 rounded-lg border border-slate-200 px-2.5 py-2">
        <span className="inline-flex size-6 items-center justify-center rounded-md bg-blue-50 text-[11px] font-bold text-blue-700">
          {workspace.slice(0, 1)}
        </span>
        <span className="truncate text-[13px] font-medium text-slate-800">{workspace}</span>
      </div>
      <nav className="flex flex-col gap-0.5">
        {NAV.map(([label, Icon, key]) => (
          <span
            key={label}
            className={[
              'flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13.5px] font-medium',
              key === page ? 'bg-slate-100 text-slate-900' : 'text-slate-600',
            ].join(' ')}
          >
            <Icon className="size-4" aria-hidden="true" />
            {label}
          </span>
        ))}
      </nav>
      <div className="mt-auto flex items-center gap-2.5 px-2.5 py-2 text-[13.5px] font-medium text-slate-600">
        <Settings className="size-4" aria-hidden="true" />
        Settings
      </div>
    </aside>
  );
}

function TopNav({ crumbs, compact, lens, pill }) {
  return (
    <header className="sticky top-0 z-40 border-b border-slate-200 bg-white/95">
      <div className={['flex h-14 items-center gap-3', compact ? 'px-4' : 'px-6'].join(' ')}>
        <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-[13.5px]">
          {crumbs.map((crumb, index) => (
            <span key={crumb} className="flex min-w-0 items-center gap-1.5">
              {index > 0 && (
                <ChevronRight className="size-3.5 shrink-0 text-slate-400" aria-hidden="true" />
              )}
              <span
                className={[
                  'truncate',
                  index === crumbs.length - 1 ? 'font-semibold text-slate-900' : 'text-slate-500',
                ].join(' ')}
              >
                {crumb}
              </span>
            </span>
          ))}
        </nav>
        <div className="flex-1" />
        {compact ? (
          <button
            type="button"
            aria-label="Search"
            className="inline-flex size-9 items-center justify-center rounded-md text-slate-500"
          >
            <Search className="size-4" aria-hidden="true" />
          </button>
        ) : (
          <span className="hidden h-9 w-52 items-center gap-2 rounded-md border border-slate-200 px-3 text-[13px] text-slate-400 lg:flex">
            <Search className="size-3.5" aria-hidden="true" />
            Search…
            <kbd className="ml-auto rounded border border-slate-200 px-1 text-[10.5px] text-slate-500">
              ⌘K
            </kbd>
          </span>
        )}
        {pill}
        {!compact && lens === 'client' && (
          <span className="hidden h-8 items-center gap-1.5 rounded-full border border-slate-200 px-3 text-[12.5px] font-semibold text-slate-700 sm:inline-flex">
            A$1,240
            <span className="font-normal text-slate-500">credit</span>
          </span>
        )}
        <button
          type="button"
          aria-label="Notifications"
          className="inline-flex size-9 items-center justify-center rounded-md border border-slate-200 text-slate-500"
        >
          <Bell className="size-4" aria-hidden="true" />
        </button>
      </div>
    </header>
  );
}

function PageBody({ page, calls, lens, compact }) {
  const a = calls.find((c) => c.id === 'a');
  if (page === 'dashboard') {
    return (
      <section className="rounded-xl border border-slate-200 bg-white p-4">
        <h2 className="text-[15px] font-semibold text-slate-900">Up next</h2>
        <p className="mb-3 text-[12.5px] text-slate-500">
          {lens === 'client'
            ? 'Meetings across Acme Logistics’s cases and projects'
            : 'Your meetings across cases and projects'}
        </p>
        {calls.map((call) => (
          <div
            key={call.id}
            className={[
              'flex items-center gap-3 py-3',
              call.t.joinVisible
                ? '-mx-1 mb-1.5 rounded-xl bg-emerald-50 px-3 ring-1 ring-emerald-200 ring-inset'
                : 'border-b border-slate-100 px-1',
            ].join(' ')}
          >
            <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-blue-50 text-blue-600">
              <Video className="size-[17px]" aria-hidden="true" />
            </span>
            <div className="min-w-0 flex-1">
              <span className="block text-xs font-semibold text-blue-600">{call.party.kind}</span>
              <span className="block truncate text-sm font-semibold text-slate-900">
                {call.party.context}
              </span>
              <span className="block truncate text-[12.5px] text-slate-500">{call.party.name}</span>
            </div>
            {!compact && call.t.statusLine && call.t.windowOpen && (
              <span className="text-xs font-semibold text-emerald-700">{call.t.statusLine}</span>
            )}
            {call.t.joinVisible && (
              <JoinButton size="row" ariaLabel={joinAria(call.party.name, call.t.aria)} />
            )}
            {call.t.roomSettingUp && <RoomSettingUpSlot variant="button" />}
          </div>
        ))}
        {calls.length === 0 && <p className="text-sm text-slate-500">Nothing booked</p>}
      </section>
    );
  }
  if (page === 'case' && a) {
    return (
      <section>
        <h1 className="mb-1 text-xl font-semibold text-slate-900">{a.party.context}</h1>
        <p className="mb-4 text-[13px] text-slate-500">Case with {a.party.name}</p>
        <div className="flex items-start gap-3 rounded-xl border border-slate-200 bg-blue-50/50 px-4 py-3.5">
          <Video size={17} className="mt-0.5 shrink-0 text-blue-600" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-slate-900">
              {a.t.windowOpen ? 'Your consultation is starting' : 'Next consultation'}
            </p>
            <p className="mt-0.5 text-sm text-slate-500">{a.party.name} will join from here.</p>
            <div className="mt-2.5">
              {a.t.joinVisible && (
                <JoinButton size="row" ariaLabel={joinAria(a.party.name, a.t.aria)} />
              )}
              {a.t.roomSettingUp && <RoomSettingUpSlot variant="button" size="row" />}
            </div>
          </div>
        </div>
      </section>
    );
  }
  if (page === 'recap' && a) {
    return (
      <section>
        <h1 className="mb-1 text-xl font-semibold text-slate-900">Call with {a.party.name}</h1>
        <p className="text-[13px] text-slate-500">The recap appears here once the call ends.</p>
      </section>
    );
  }
  return (
    <section className="rounded-xl border border-slate-200 bg-white">
      {['Northwind Freight', 'Priya Sharma', 'Harbourside Dental'].map((who, index) => (
        <div
          key={who}
          className="flex items-center gap-3 border-b border-slate-100 px-4 py-3 last:border-b-0"
        >
          <span className="inline-flex size-8 items-center justify-center rounded-full bg-slate-100 text-xs font-semibold text-slate-600">
            {who.slice(0, 1)}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13.5px] font-semibold text-slate-900">{who}</p>
            <p className="truncate text-[12.5px] text-slate-500">
              {
                [
                  'Sent the updated flow screenshot',
                  'Thanks — see you on the call',
                  'Can we move discovery?',
                ][index]
              }
            </p>
          </div>
        </div>
      ))}
    </section>
  );
}

function MobileTabBar() {
  return (
    <nav
      aria-label="Primary"
      className="sticky bottom-0 grid grid-cols-5 border-t border-slate-200 bg-white"
    >
      {[
        ['Home', LayoutDashboard],
        ['Cases', Video],
        ['Messages', MessageSquare],
        ['Calendar', CalendarDays],
        ['More', MoreHorizontal],
      ].map(([label, Icon]) => (
        <span
          key={label}
          className="flex flex-col items-center gap-0.5 py-2 text-[11px] font-medium text-slate-500"
        >
          <Icon className="size-5" aria-hidden="true" />
          {label}
        </span>
      ))}
    </nav>
  );
}

// ── Prototype controls ───────────────────────────────────────────────────────────────────────
function Seg({ label, value, onChange, options }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11px] font-semibold text-slate-500">{label}</span>
      <div
        role="group"
        aria-label={label}
        className="inline-flex flex-wrap rounded-lg bg-slate-100 p-0.5"
      >
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            aria-pressed={value === option.value}
            onClick={() => onChange(option.value)}
            className={[
              'rounded-md px-2.5 py-1 text-[12px] font-medium focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:outline-none',
              value === option.value ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600',
            ].join(' ')}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function explain(primary, quiet, hiddenForRecap, page) {
  if (hiddenForRecap && !primary)
    return 'Hidden: this page is the recap of the only call in its window.';
  if (!primary) return 'Nothing in the window, so the nav shows nothing.';
  if (hiddenForRecap)
    return 'This page is one call’s recap, so that call is left out; the other call still shows.';
  if (primary.t.inLeadIn)
    return '⚑ Lead-in (proposal): a still strip, no button, until the window opens 3 minutes before the start.';
  if (primary.t.roomSettingUp)
    return 'Window open, room not ready: the same non-interactive slot the nudge and Up next use.';
  if (quiet && primary.t.inGrace)
    return 'Joinable in the overrun grace: static ring — the urgency was the start.';
  if (quiet)
    return `Joinable, static ring: the ${page === 'dashboard' ? 'Up next row' : 'case nudge'} on this page already pulses for the same call.`;
  return 'Joinable: the pill is the only Join on this page, so it carries the ping ring.';
}

export default function TopNavCallPillPrototype({ initial = {} }) {
  const [scenario, setScenario] = useState(initial.scenario || 'opens');
  const [page, setPage] = useState(initial.page || 'messages');
  const [lens, setLens] = useState(initial.lens || 'client');
  const [width, setWidth] = useState(initial.width || 'wide');
  const [leadIn, setLeadIn] = useState(initial.leadIn || 'off');
  const [motion, setMotion] = useState(initial.motion || 'device');
  // The OS "Reduce motion" setting. With it on, the real Join is static too — say so on screen,
  // because otherwise a still button reads as a bug in the prototype.
  const [osReduced, setOsReduced] = useState(false);
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setOsReduced(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  const [listOpen, setListOpen] = useState(initial.listOpen === true);
  const [lastJoin, setLastJoin] = useState('');
  const compact = width === 'narrow';
  const parties = PARTIES[lens];

  const calls = useMemo(
    () =>
      SCENARIOS[scenario].calls.map((call) => ({
        ...call,
        party: parties[call.id],
        t: timingOf(call, leadIn === 'on'),
      })),
    [scenario, parties, leadIn]
  );

  // SELECTION — window-open calls, minus the one whose recap is this page; latest start wins.
  const hiddenId = page === 'recap' ? 'a' : null;
  const open = calls
    .filter((c) => c.t.windowOpen && c.id !== hiddenId)
    .sort((x, y) => y.start - x.start);
  const leadCandidate = calls.find((c) => c.t.inLeadIn && c.id !== hiddenId) || null;
  const primary = open[0] || leadCandidate;
  const others = open.slice(1);
  const onPage = pageJoinIds(page, calls);
  const quiet = primary !== null && (onPage.includes(primary.id) || primary.t.inGrace);
  const hiddenForRecap =
    hiddenId !== null && calls.some((c) => c.id === hiddenId && c.t.windowOpen);

  // One polite announcement per meeting, only when the pill is the page's own Join.
  const announced = useRef(new Set());
  const [announcement, setAnnouncement] = useState('');
  useEffect(() => {
    if (!primary || !primary.t.joinVisible || quiet) return;
    const key = `${lens}:${primary.id}`;
    if (announced.current.has(key)) return;
    announced.current.add(key);
    setAnnouncement(NAV_CALL_READY(primary.party.name));
  }, [primary, quiet, lens]);

  useEffect(() => setListOpen(initial.listOpen === true && others.length > 0), [scenario]); // eslint-disable-line react-hooks/exhaustive-deps

  const onJoin = useCallback((call, source) => {
    setLastJoin(`nav_call_join_clicked · ${call.party.name} · from ${source}`);
  }, []);

  const pill = (
    <CallPill
      primary={primary}
      others={others}
      quiet={quiet}
      compact={compact}
      listOpen={listOpen}
      setListOpen={setListOpen}
      onJoin={onJoin}
    />
  );

  return (
    <div
      className={[
        'min-h-screen bg-slate-50 p-4 font-sans text-slate-900 sm:p-6',
        motion === 'reduced' ? 'balo-reduced' : '',
        motion === 'device' ? 'balo-motion-device' : '',
      ].join(' ')}
    >
      <style>{CSS}</style>
      <div className="mx-auto mb-4 flex max-w-[1180px] flex-wrap gap-x-5 gap-y-3">
        <Seg
          label="Time"
          value={scenario}
          onChange={setScenario}
          options={Object.entries(SCENARIOS).map(([value, s]) => ({ value, label: s.label }))}
        />
        <Seg
          label="Page"
          value={page}
          onChange={setPage}
          options={Object.entries(PAGES).map(([value, p]) => ({ value, label: p.label }))}
        />
        <Seg
          label="Viewer"
          value={lens}
          onChange={setLens}
          options={[
            { value: 'client', label: 'Client' },
            { value: 'expert', label: 'Expert' },
          ]}
        />
        <Seg
          label="Width"
          value={width}
          onChange={setWidth}
          options={[
            { value: 'wide', label: 'Desktop' },
            { value: 'narrow', label: 'Phone' },
          ]}
        />
        <Seg
          label="⚑ Lead-in"
          value={leadIn}
          onChange={setLeadIn}
          options={[
            { value: 'off', label: 'Off' },
            { value: 'on', label: '15 min' },
          ]}
        />
        <Seg
          label="Motion"
          value={motion}
          onChange={setMotion}
          options={[
            { value: 'device', label: 'Follow device' },
            { value: 'force', label: 'Always on' },
            { value: 'reduced', label: 'Reduced' },
          ]}
        />
      </div>

      <div
        className={[
          'mx-auto overflow-hidden rounded-2xl border border-slate-200 bg-slate-50',
          compact ? 'w-[390px]' : 'max-w-[1180px]',
        ].join(' ')}
      >
        <div className="flex min-h-[460px]">
          {!compact && (
            <Sidebar page={page === 'recap' ? null : page} workspace={parties.workspace} />
          )}
          <div className="flex min-w-0 flex-1 flex-col">
            <TopNav crumbs={PAGES[page].crumbs} compact={compact} lens={lens} pill={pill} />
            <main className={['flex-1', compact ? 'p-4' : 'p-8'].join(' ')}>
              <PageBody page={page} calls={calls} lens={lens} compact={compact} />
            </main>
            {compact && <MobileTabBar />}
          </div>
        </div>
      </div>

      <p
        data-explain
        className="mx-auto mt-3 max-w-[1180px] text-[13px] text-slate-600"
        style={compact ? { maxWidth: 390 } : undefined}
      >
        {explain(primary, quiet, hiddenForRecap, page)}
        {motion === 'device' && osReduced && primary?.t.joinVisible && !quiet && (
          <span className="ml-1 font-semibold text-amber-700">
            Your device has Reduce Motion on, so the ring is static here — and in the real app, by
            design. Pick “Always on” to see the pulse.
          </span>
        )}
        {lastJoin && <span className="ml-2 text-slate-400">({lastJoin})</span>}
      </p>
      <span role="status" className="sr-only">
        {announcement}
      </span>
    </div>
  );
}

const CSS = `
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
/* The button is its own containing block — set here, not via a Tailwind class, so the ring can
   never resolve against some outer ancestor in a renderer without the utility. */
.balo-join { position: relative; }
/* ≥44px hit area, the button's own after: (call sites size it). */
.balo-join::after { content:''; position:absolute; inset:-6px; }
/* EXACT copy of globals.css \`--animate-ping-slow\` (BAL-511 / ADR-1053 'ambient live-call ping
   ring 1.8s'): a fixed 8px currentColor halo on ::before that fades from 0.5 opacity. */
@keyframes pingSlow {
  0%        { box-shadow: 0 0 0 0 currentColor;   opacity: .5; }
  70%, 100% { box-shadow: 0 0 0 8px currentColor; opacity: 0; }
}
.balo-join-live::before {
  content:''; position:absolute; inset:0; border-radius:inherit; pointer-events:none;
  color:#2563EB; animation: pingSlow 1.8s cubic-bezier(0,0,0.2,1) infinite;
}
/* Quiet = the motion-reduce presentation: a static ring, no halo. */
.balo-join-quiet { box-shadow: 0 0 0 2px #2563EB; }
/* Motion "Follow device": honour the OS setting, as the real \`motion-safe:\` utilities do. */
@media (prefers-reduced-motion: reduce) {
  .balo-motion-device .balo-join-live::before { animation: none; content: none; }
  .balo-motion-device .balo-join-live { box-shadow: 0 0 0 2px #2563EB; }
}
/* Motion "Reduced": force the reduced presentation whatever the device says. */
.balo-reduced .balo-join-live::before { animation: none; content: none; }
.balo-reduced .balo-join-live { box-shadow: 0 0 0 2px #2563EB; }
`;
