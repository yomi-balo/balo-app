import React, { useEffect, useRef, useState } from 'react';
import {
  ArrowRight,
  Building2,
  CalendarClock,
  CalendarX,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleSlash,
  Clock,
  FileText,
  Mail,
  MoreVertical,
  Paperclip,
  Plus,
  RotateCcw,
  ShieldQuestion,
  UserPlus,
  Users,
  Video,
  X,
} from 'lucide-react';

/**
 * Balo — Consultation row actions (design reference, v4)
 *
 * SCOPE: the Consultations card on the case surface (`consultation-list.tsx`, BAL-421), plus —
 * from v2 — the `'upcoming'` arm of the nudge and the cancel dialog, and — from v3 — the first
 * view of the two reschedule pickers. Every other nudge kind is unchanged and appears only as
 * a dashed placeholder; so does the calendar itself.
 *
 * ── v4 (owner review, 2026-09-20) — Join is always in the nudge ─────────────────────────
 *  7. THE JOIN SLOT NEVER DISAPPEARS. Before the window: an INACTIVE countdown — "Join in 2
 *     days" · "Join tomorrow" · "Join in 3 hours" · "Join in 40 minutes". Inside it: "Join
 *     now", primary, with a pulse ring. Same place, same size, so the button is already where
 *     the eye will look for it. Reschedule stays beside it as the text button and still drops
 *     inside the window.
 *     ⚠ A DELIBERATE EXCEPTION TO "AN ABSENT ACTION BEATS A DEAD ONE", and the line is narrow:
 *     a control may render inactive ONLY if it becomes active ON ITS OWN and SAYS WHEN. A
 *     countdown qualifies. A Reschedule this viewer can never use still does not.
 *     ⚠⚠ THE CLOCK NOW OWNS THE WINDOW. `useUpcomingJoinClock` ticks only when `live`, and
 *     `live` itself arrives from the server with the page — so a page left open across the
 *     boundary never grows a Join. Invisible today; with a countdown it becomes a button that
 *     ticks down to zero and stays dead. The hook must tick ALWAYS, derive the state itself,
 *     and `router.refresh()` once on the crossing so the title, the body and the hidden
 *     Reschedule follow. The server stays the authority on the click (`assertMeetingJoinable`).
 *     ⚠ NOT `JoinMeetingButton` WITH A `disabled` PROP. Its "rendered ONLY inside the join
 *     window" invariant is pinned by the calendar's tests (`join-window.ts`). The countdown is
 *     its own element — `JoinCountdown` — in the same slot.
 *     ⚠ `aria-disabled`, NOT `disabled`, and no 40%-opacity text: "in 2 days" is information,
 *     so it stays focusable and at ≥4.5:1. The ticking label is NEVER a live region; ONE
 *     polite "You can join now." fires on the crossing. `aria-describedby` carries "Opens 15
 *     minutes before the start."
 *     ONE MOVING THING: the ring on Join. The title's red dot, which pulses today, goes still
 *     — two pulses side by side is noise. `prefers-reduced-motion` stops the ring.
 *     LABELS: one builder (`joinCountdownLabel` below) beside `joinAffordanceTimingLabel`, so
 *     Up next and the calendar can adopt the ladder without rewording it. Client-only,
 *     viewer-local CALENDAR days, so it agrees with the row's "Tomorrow at…". It counts to the
 *     START while the button opens 15 minutes earlier — only ever ready sooner than promised.
 *     ⚠ "Join now" replaces "Join call" here; whichever wins should win on every surface. MJ.
 *
 * ── v3 (owner review, 2026-09-20) — the reschedule pickers ──────────────────────────────
 *  4. A TIME IS NEVER SHOWN WITHOUT ITS LENGTH. A reschedule moves a booking, it never resizes
 *     it, so the length is known before the first option renders. Every option, picked time
 *     and confirm line shows the RANGE and the length: "Tue 22 Sept · 6:00 – 6:30 pm · 30 min".
 *     ⚠ This is a gap in the SHIPPED picker, not only in v2's stand-in.
 *     `availability-slots-panel.tsx` hides its duration label whenever the filter is not
 *     `'any'`, and a pinned reschedule is never `'any'` — so its rows read "9:00 PM" and
 *     nothing else. Rule for that panel: unpinned ⇒ "up to 60m", as today; PINNED
 *     (`fixedDurationMinutes`) ⇒ the actual range. The same goes for `RescheduleDialog`'s
 *     Currently / Moving to, `ProposeTimesDialog`'s picked list and `RescheduleProposalCard`'s
 *     options — ONE new `LocalDateTime` range variant covers all four. Upcoming ROWS carry the
 *     booked length too, in the slot held rows use for the actual one.
 *  5. SUGGESTED TIMES FIRST, "SEE MORE TIMES" FOR THE CALENDAR. Today the dialog opens on the
 *     month grid and a move costs five taps (day, slot, Continue, Confirm, Move). The first
 *     view is now up to four suggestions, and one tap lands on the existing confirm step.
 *     "See more times" opens `ExpertAvailabilityCalendar` exactly as shipped, and "Choose a
 *     different time" returns to whichever view the pick came from.
 *     DATA: `useExpertAvailability` — the hook the party card's strip already uses. No new
 *     endpoint. Keep slots with `maxDuration >= durationMinutes`.
 *     SELECTION: ONE PER DAY, the slot nearest the ORIGINAL time of day, for the next four
 *     days that have one (`suggestTimes` below is the whole rule). ⚠ NOT "the first N": on a
 *     15-minute grid that is 9:00 / 9:15 / 9:30 pm — three ways of saying the same evening,
 *     which is what the party card's strip shows today.
 *     No fitting suggestion, or availability not `ready` ⇒ open straight on the calendar, as
 *     shipped; it already owns its empty and error states.
 *     The expert's Propose dialog gets the same first view; there a pick ADDS to the ≤3 list.
 *  6. ⚠ `ProposeTimesDialog` DISMISSES WITH A BUTTON LABELLED "Cancel". On this surface that
 *     word means the consultation, and since v2 the dialog is reachable FROM the cancel
 *     confirmation. It reads "Keep this time" here.
 *
 * ── v2 (owner review, 2026-09-20) ───────────────────────────────────────────────────────
 *  1. A CANCELLED ROW HAS NO "View recap". There is nothing to recap and the row already says
 *     "Cancelled — nothing charged". ⚠ Do NOT re-gate the link on `state === 'held'` — that
 *     was the original bug (`consultation-list.tsx`): `missed_call`, `no_show_client` and
 *     `outcome_pending` keep theirs, because the not-held panel is where a no-show explains
 *     itself and its money. Null `recapHref` for `cancelled` in the CASE loader; `recapHrefOf`
 *     is shared, so check its other readers before touching the builder itself.
 *  2. CANCEL LEAVES THE NUDGE. The nudge is the loudest thing on the page and we are not
 *     promoting cancellation; the row menu is now the ONLY door to it, on every upcoming call
 *     including the next. With Cancel gone, Reschedule / Propose a new time drops from an
 *     outline button to a TEXT button — a boxed button under "nothing to do until then" argued
 *     with its own sentence. Inside the join window the nudge is Join and nothing else; Cancel
 *     stays on the row there ("free until scheduled start" is still true).
 *     ⚠⚠ SEQUENCING: Cancel may only leave the nudge in the SAME release as the row menu — on
 *     `case-surface-mobile` too — or there is no door to cancel at all.
 *     ⚠ WATCH NO-SHOWS. A cancel that is harder to find can become a no-show, which is worse
 *     for everyone. `booking_cancelled.hours_before_start` and the no-show rate, before and
 *     after, will say whether the door got too quiet.
 *  3. THE CANCEL DIALOG STOPS SELLING THE CANCEL. "Cancel consultation" is a red GHOST, not
 *     the filled primary. "Keep it" is unchanged and still takes initial focus. The copy LEADS
 *     with the alternative, and the alternative gets the dialog's only filled button —
 *     "Reschedule instead" (client) / "Propose a new time" (expert) — which swaps the dialog
 *     target to the existing picker for the SAME meeting. The free-to-cancel facts STAY but
 *     follow, stated conditionally ("If you do cancel…"): free is a promise, not a pitch, and
 *     dropping it would trade cancellations for support tickets and no-shows. No guilt, no
 *     countdown, no penalty framing. An absent alternative is absent: inside the join window
 *     or with a proposal outstanding there is no move button and no sentence about one.
 *     Destructive sits apart on the left at dialog width, and LAST when the footer stacks.
 *     Analytics: the abandon event gains `diverted_to: 'reschedule' | 'propose' | null`, and a
 *     "save" counts only when that reschedule COMPLETES — a filled button beside a quiet red
 *     one will collect some habit clicks. ⚠ New strings: MJ checkpoint.
 *
 * ── THE GAP THIS CLOSES ─────────────────────────────────────────────────────────────────
 * Reschedule / Propose a new time / Cancel exist only on the `'upcoming'` nudge, and all three
 * dialogs in `case-surface.tsx` are hard-wired to `view.nudge.meetingId`. Two holes follow:
 *   1. With more than one consultation booked, every upcoming call EXCEPT the next one cannot
 *      be moved or cancelled from anywhere on the page.
 *   2. While a reschedule proposal is outstanding the nudge is informational, the three
 *      dialogs are unmounted, and `RescheduleProposalCard` offers Accept / Keep my time /
 *      Withdraw only — so that consultation cannot be CANCELLED at all.
 * A per-row menu closes both, on EVERY upcoming call including the first — no special case
 * for the row the nudge also covers.
 *
 * ── WHAT IS NEW ─────────────────────────────────────────────────────────────────────────
 *  - A KEBAB ON UPCOMING ROWS ONLY (`scheduled`, `pending_reschedule`). Always visible, never
 *    hover-only. A held row's one action is already inline (View recap); a menu there would be
 *    a second door to the same room.
 *  - MENU, NOT INLINE LINKS. Three actions, one destructive, repeated per row, would outshout
 *    the recap links above them. One inline link per row stays the pattern.
 *  - ORDER: Invite a colleague · Reschedule | Propose a new time · ─── · Cancel consultation.
 *    The destructive group is always last and always behind a separator.
 *  - "CANCEL CONSULTATION", NEVER BARE "CANCEL". Inside a menu, "Cancel" reads as "close this
 *    menu". It is also the shipped dialog's own confirm label, so the action keeps one name
 *    from menu to dialog to toast. For the same reason nothing here dismisses with the word
 *    "Cancel" — the shipped dialog already says "Keep it".
 *  - AN ABSENT ACTION BEATS A DEAD ONE (§D7, same rule as the nudge). Items render only when
 *    their flag is true; nothing is ever disabled; no flags ⇒ no kebab at all. Toggle Lens to
 *    Colleague: an agency member who can read the case but holds neither capability sees rows
 *    with no trigger.
 *  - JOIN WINDOW MIRRORS THE NUDGE EXACTLY: inside it Reschedule / Propose drop and Cancel
 *    stays ("free until scheduled start"). The pill reads "Starting soon" there, so a menu
 *    with no Reschedule explains itself. Toggle Upcoming to Starting.
 *  - THE `scheduled` NOTE IS RETIRED. "Upcoming · join link in your calendar" repeats the
 *    pill, and BAL-567 already removed its twin from the nudge as redundant. The second line
 *    now carries GUEST STATE when there is any ("2 guests", which opens the same invite
 *    dialog), so an invitation is never invisible state behind a menu. Count only — emails
 *    never cross the party boundary (ADR-1044). ⚠ Copy change: MJ checkpoint.
 *  - NO JOIN ON THE ROW. Join lives in the nudge — always, from v4 — and only there. Two Join
 *    buttons on one page is one too many.
 *  - TRIGGER: 32px at rest widths, 44px when the column is narrow. `aria-label` carries the
 *    date and time — three identical "More actions" buttons are useless to a screen reader.
 *
 * ── WHAT IS NOT NEW — REUSE, DO NOT REBUILD ─────────────────────────────────────────────
 *  - `DropdownMenu` (shadcn/Radix) for the menu. The keyboard handling hand-rolled below only
 *    exists so this file behaves like it; Radix supplies it, plus collision-flipping for the
 *    last rows of a list that is newest-LAST (upcoming rows always sit at the bottom).
 *  - `RescheduleDialog` (BAL-409) and `ProposeTimesDialog` (BAL-411): the actions, the confirm
 *    step, the failure handling and the focus-follows-step rule AS SHIPPED; their target now
 *    comes from the row, and v3 changes their first view and their time labels (above).
 *  - `CancelConsultationDialog` (BAL-410) keeps its machinery — AlertDialog, exactly two
 *    dismiss paths, the async states, terminal-failure handling, the abandon latch. v2 changes
 *    its hierarchy and copy (above); the nudge strings are quoted from `case-nudge.tsx`.
 *  - Invite is `guest-invitation.jsx`'s case-surface Panel + `InviteComposer`, unchanged; a
 *    compact copy is inlined here. What this file adds is the ANCHOR: BAL-418 keys a guest to
 *    `meetings.id` and BAL-408's route is `POST /meetings/:meetingId/guests`, so the People
 *    card's button has nothing to anchor to once two calls are booked. The row does.
 *
 * ── VIEW-MODEL CHANGE (in the LOADER — never derived in a component) ─────────────────────
 *  `CaseConsultationRowView` gains, for upcoming rows only:
 *     canInvite · canReschedule · canProposeReschedule · canCancel   (capability-resolved
 *     per MEETING; today's `canProposeReschedule` / `canCancelConsultation` are per CASE and
 *     answer for the next meeting only) · guestCount · the booked duration and `live` that
 *     the dialogs already take from the nudge.
 *  The menu is built from those flags ALONE. Lens never decides availability (ADR-1029) —
 *  `resolveFlags` below STANDS IN FOR THE LOADER and is the only place `who` decides what is
 *  AVAILABLE; everywhere else it only picks copy. `case-surface.tsx` swaps its three booleans
 *  for one
 *  `{ kind, meetingId } | null` target that both the nudge and the row menu set; the dialogs'
 *  mount gate becomes "a target is set" instead of "the nudge is `'upcoming'`".
 *  `CancelConsultationDialog`'s `live` prop generalises to "can this meeting still be moved",
 *  so its "Reschedule instead" sentence also drops on a `pending_reschedule` row.
 *  Mobile stays pure composition: same flags, and whether `case-surface-mobile.jsx` renders
 *  them as a dropdown or a sheet is that reference's call.
 *
 * ⚠⚠ INVITE SHIPS SECOND. `case-people-card.tsx` withholds "Invite a colleague" on `main`
 * because `apps/web` has no seam that CREATES an invite and guest reads are inert. Both still
 * gate this menu item. Toggle Invite to Off for phase 1 — Reschedule/Propose + Cancel — which
 * is shippable today and is the part that fixes the two holes above.
 *
 * ⚠⚠ PROPOSALS ON A CALL THAT IS NOT NEXT. `RescheduleProposalCard` mounts off the ONE nudge.
 * If an expert proposes new times for the 7 pm call while the 6 pm call owns the nudge, the
 * client's row says "see above" and nothing is above. Either `selectCaseNudge` ranks an
 * outstanding proposal over a plain `'upcoming'` (live Join still first) — preferred, it is
 * the only item waiting on a person — or per-row Propose is limited to the next call in v1.
 * Decide before building the expert arm.
 *
 * ⚠ CANCEL WITH A PROPOSAL OUTSTANDING is newly reachable. The server guard is state-based so
 * it should pass, but the proposal must be voided in the same transaction as the cancel.
 *
 * ⚠ FOCUS AFTER CANCEL. Radix returns focus to the trigger, and a cancelled row has none.
 * Send it to the section heading instead of letting it fall to <body>.
 *
 * Carried decisions: newest last, sorted server-side; no money in any row; a cancelled
 * consultation is marked, never removed; gender-neutral copy; prospective copy names the
 * party. Pills and notes for non-upcoming states belong to the shipped component — the ones
 * here are dressing.
 */

const C = {
  bg: '#EEF0F3',
  card: '#FFFFFF',
  line: '#E6E8EC',
  line2: '#F0F1F4',
  text: '#171A1F',
  sub: '#5B6472',
  faint: '#9AA1AD',
  icon: '#7A8291',
  brand: '#2563EB',
  brandSoft: '#F6F8FE',
  brandLine: '#E3EBFB',
  brandTile: '#EAF0FE',
  pendingFill: '#E9EEF8',
  good: '#12996B',
  goodInk: '#0C7A55',
  goodSoft: '#E7F6EF',
  goodLine: '#C6E9D9',
  warn: '#B25E09',
  warnSoft: '#FDF3E7',
  warnLine: '#F6E3CB',
  danger: '#C0352D',
  dangerSoft: '#FDF1F0',
  live: '#D6453D',
  ink: '#0B0E13',
};

const CSS = `
@keyframes baloMenuIn  { from { opacity: 0; transform: translateY(-4px) scale(.98); } to { opacity: 1; transform: none; } }
@keyframes baloFadeIn  { from { opacity: 0; } to { opacity: 1; } }
@keyframes baloToastIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
.balo-menu  { animation: baloMenuIn .12s ease-out; transform-origin: top right; }
.balo-scrim { animation: baloFadeIn .12s ease-out; }
.balo-toast { animation: baloToastIn .18s ease-out; }
.balo-kebab { color: ${C.icon}; transition: background-color .12s ease, color .12s ease; }
.balo-kebab:hover, .balo-kebab[aria-expanded="true"] { background: #F1F3F6; color: ${C.text}; }
.balo-item:hover, .balo-item:focus { background: #F4F5F7; outline: none; }
.balo-item-danger:hover, .balo-item-danger:focus { background: ${C.dangerSoft}; }
.balo-focus:focus-visible { outline: 2px solid ${C.brand}; outline-offset: 2px; }
.balo-tap { transition: background-color .12s ease, border-color .12s ease; }
.balo-tap:hover { background: #F7F8FA !important; border-color: #D8DCE3 !important; }
.balo-link:hover { text-decoration: underline; }
.balo-slot { transition: background-color .12s ease, border-color .12s ease; }
.balo-slot:hover { background: ${C.brandSoft}; border-color: ${C.brand} !important; }
.balo-text-btn { transition: background-color .12s ease; }
.balo-text-btn:hover { background: rgba(37,99,235,.08); }
.balo-ghost-danger { transition: background-color .12s ease; }
.balo-ghost-danger:hover { background: ${C.dangerSoft}; }
@keyframes baloPulse {
  0%   { box-shadow: 0 0 0 0 rgba(37,99,235,.40); }
  70%  { box-shadow: 0 0 0 9px rgba(37,99,235,0); }
  100% { box-shadow: 0 0 0 0 rgba(37,99,235,0); }
}
/* ONE moving thing when the window opens: the ring on Join. The title's red dot stays still. */
.balo-join { animation: baloPulse 2s ease-out infinite; }
.balo-join-pending { cursor: default; }
/* Footer stacks with the destructive action LAST; at dialog width it sits apart, on the left. */
.balo-dialog-actions, .balo-dialog-safe { display: flex; flex-direction: column-reverse; gap: 8px; }
@media (min-width: 560px) {
  .balo-dialog-actions { flex-direction: row; align-items: center; justify-content: space-between; }
  .balo-dialog-safe { flex-direction: row; }
  .balo-ghost-danger { margin-left: -14px; }
}
@media (prefers-reduced-motion: reduce) {
  .balo-menu, .balo-scrim, .balo-toast, .balo-join { animation: none; }
}
`;

const CASE_TITLE = 'Salesforce records duplicate cleanup';
const EXPERT = { first: 'Sandy', party: 'Sandy Langworth' };
const CLIENT = { company: 'Northwind Industrial', domain: 'northwind.com' };
const FREEMAIL = [
  'gmail.com',
  'outlook.com',
  'hotmail.com',
  'yahoo.com',
  'icloud.com',
  'proton.me',
];
const MAX_PARTICIPANTS = 10;

/** The other side's short name: the expert's first name, or the client COMPANY — never a person. */
const counterparty = (who) => (who === 'client' ? EXPERT.first : CLIENT.company);
/** Prospective copy names the PARTY (the agency, or an independent expert's own name). */
const partyLabel = (who) => (who === 'client' ? EXPERT.party : CLIENT.company);

const HISTORY = [
  {
    id: 'm1',
    state: 'held',
    label: '3 Sept',
    abs: 'Thu, 3 Sept, 2:00 pm',
    at: 314,
    minutes: 29,
    recap: true,
    tx: true,
    files: 0,
    items: 3,
  },
  {
    id: 'm2',
    state: 'held',
    label: '9 Sept',
    abs: 'Wed, 9 Sept, 11:00 am',
    at: 911,
    minutes: 57,
    recap: true,
    tx: true,
    files: 1,
    items: 4,
  },
  // v2 — `recap` stands in for `recapHref !== null`. The loader nulls it for `cancelled` ONLY;
  // a missed call keeps its link, because that panel is where the no-show explains itself.
  { id: 'mC', state: 'cancelled', label: '11 Sept', abs: 'Fri, 11 Sept, 10:00 am', at: 1110 },
  {
    id: 'm3',
    state: 'missed_call',
    label: '15 Sept',
    abs: 'Tue, 15 Sept, 4:00 pm',
    at: 1516,
    recap: true,
  },
  // A `missed_call` that nobody client-side joined either — derived from presence, never
  // stored. Nobody was let down, so nobody is named, on either lens.
  {
    id: 'mN',
    state: 'nobody_joined',
    label: '17 Sept',
    abs: 'Thu, 17 Sept, 11:00 am',
    at: 1711,
    recap: true,
  },
  // BAL-581 — the call room was never ready — Balo's failure; nobody is named, on either lens.
  {
    id: 'mV',
    state: 'venue_unavailable',
    label: '19 Sept',
    abs: 'Sat, 19 Sept, 9:00 am',
    at: 1909,
    recap: true,
  },
];

const SEED_GUESTS = [
  { email: 'priya@northwind.com', name: 'Priya', party: 'client' },
  { email: 'tom@brightline.io', name: 'Tom', party: 'client' },
];

/* Times are (day of Sept 2026, minutes from midnight) so labels, ranges and sorting all come
   from one place. In production this is `LocalDateTime` plus ONE new range variant. */
const DAYS = { 19: 'Sat', 20: 'Sun', 21: 'Mon', 22: 'Tue', 23: 'Wed', 24: 'Thu', 25: 'Fri' };
const JOIN_WINDOW_MINUTES = 15; // CASE_JOIN_WINDOW_MINUTES

/* v4 — "now" is a control, not a constant. It is set as "the next call starts in …" and every
   clock-derived thing on the page reads it: the Join label, whether the window is open, and
   the Today / Tomorrow in the row labels. One clock, so they cannot disagree. */
const CLOCKS = {
  d2: { label: '2 days', minutes: 1783 + 1440 },
  d1: { label: 'Tomorrow', minutes: 1783 }, // Sun 20 Sept, 12:17 pm — the original screenshot
  h3: { label: '3 hours', minutes: 180 },
  m40: { label: '40 min', minutes: 40 },
};
const LIVE_MINUTES = 8; // the "Starting" scenario: window open, 8 minutes to go
const DEFAULT_NOW = 20 * 1440 + 737;
const BOOKED_MINUTES = 30;

const fmtTime = (min, withPeriod = true) => {
  const h24 = Math.floor(min / 60) % 24;
  const period = h24 < 12 ? 'am' : 'pm';
  const clock = `${h24 % 12 || 12}:${String(min % 60).padStart(2, '0')}`;
  return withPeriod ? `${clock} ${period}` : clock;
};
/** "10:00 – 10:30 am", and "11:45 am – 12:15 pm" when the range crosses noon. */
const fmtRange = (startMin, duration) => {
  const end = startMin + duration;
  const samePeriod = startMin % 1440 < 720 === end % 1440 < 720;
  return `${fmtTime(startMin, !samePeriod)} – ${fmtTime(end)}`;
};
const dayShort = (day) => `${DAYS[day]} ${day} Sept`;
const dayAbs = (day) => `${DAYS[day]}, ${day} Sept`;
const absLabel = (day, startMin) => `${dayAbs(day)}, ${fmtTime(startMin)}`;
/** v3 — the form every reschedule surface uses: a time is never shown without its length. */
const spanLabel = (t) => `${dayAbs(t.day)} · ${fmtRange(t.startMin, t.duration)}`;
const rowLabel = (day, startMin, today) => {
  if (day === today) return `Today at ${fmtTime(startMin)}`;
  if (day === today + 1) return `Tomorrow at ${fmtTime(startMin)}`;
  return `${dayShort(day)} at ${fmtTime(startMin)}`;
};

/**
 * v4 — THE LADDER. One builder, beside `joinAffordanceTimingLabel` in `join-window.ts`, so the
 * nudge, the dashboard's Up next and the calendar can never word it three ways.
 *   · window open            → "Join now"            (the ONLY active rung)
 *   · under an hour          → "Join in 40 minutes"
 *   · under a day            → "Join in 3 hours"     (nearest hour)
 *   · next calendar day      → "Join tomorrow"       ("in 1 day" is nobody's phrase)
 *   · later                  → "Join in 2 days"      (CALENDAR days, viewer-local — so it
 *                                                     agrees with the row's "Tomorrow at…")
 * It counts to the START while the button opens 15 minutes EARLIER, so the control is only
 * ever ready sooner than it promised. ⚠ CLIENT-ONLY, like every relative time here: the server
 * render carries a clock-free label and the effect swaps the countdown in (hydration rule).
 */
function joinCountdownLabel(startAbs, nowAbs) {
  const minutes = startAbs - nowAbs;
  if (minutes <= JOIN_WINDOW_MINUTES) return 'Join now';
  if (minutes < 60) return `Join in ${minutes} minutes`;
  if (minutes < 1440) {
    const hours = Math.round(minutes / 60);
    return `Join in ${hours} hour${hours === 1 ? '' : 's'}`;
  }
  const days = Math.floor(startAbs / 1440) - Math.floor(nowAbs / 1440);
  return days === 1 ? 'Join tomorrow' : `Join in ${days} days`;
}

/** The window is a function of the CLOCK — never a flag resolved once at page load (v4). */
const isLive = (row, nowAbs) => isUpcoming(row) && row.at - nowAbs <= JOIN_WINDOW_MINUTES;
const timeFields = (day, startMin) => ({
  day,
  startMin,
  abs: absLabel(day, startMin),
  at: day * 1440 + startMin,
});

const up = (id, day, startMin, extra) => ({
  id,
  state: 'scheduled',
  duration: BOOKED_MINUTES,
  guests: [],
  ...timeFields(day, startMin),
  ...extra,
});

const SIX = ['m4', 21, 18 * 60];
const SEVEN = ['m5', 21, 19 * 60];
const EIGHT = ['m6', 21, 20 * 60];

const SCENARIOS = {
  one: () => [up(...SIX)],
  three: () => [up(...SIX, { guests: SEED_GUESTS }), up(...SEVEN), up(...EIGHT)],
  // BAL-581 — `m4` carries `roomReady: false` so the live scenario also demonstrates the
  // "Setting up call room" pill (the venue repair job's own salvage window), not only a bare
  // "Starting soon".
  live: () => [up('m4', 20, 12 * 60 + 25, { roomReady: false }), up(...SEVEN)],
  proposed: () => [up(...SIX, { state: 'pending_reschedule' }), up(...SEVEN)],
  none: () => [],
};

/* What `useExpertAvailability` would return, already narrowed to slots long enough for the
   booked length. A 15-minute grid, as in production — note Monday evening. */
const AVAILABILITY = [
  [21, 21 * 60],
  [21, 21 * 60 + 15],
  [21, 21 * 60 + 30],
  [22, 10 * 60],
  [22, 14 * 60 + 30],
  [22, 18 * 60],
  [22, 18 * 60 + 15],
  [23, 9 * 60],
  [23, 17 * 60 + 45],
  [24, 18 * 60],
  [24, 18 * 60 + 30],
  [25, 11 * 60],
].map(([day, startMin]) => ({ id: `${day}-${startMin}`, day, startMin }));

const SUGGESTION_COUNT = 4;

/** Open slots, minus anything that would collide with another call still on the books. */
function openSlots(rows, movingId) {
  const busy = rows.filter((row) => isUpcoming(row) && row.id !== movingId);
  return AVAILABILITY.filter(
    (slot) =>
      !busy.some(
        (row) => row.day === slot.day && Math.abs(row.startMin - slot.startMin) < row.duration
      )
  );
}

/**
 * v3 — ONE PER DAY, the slot nearest the ORIGINAL time of day, for the next few days that have
 * one. ⚠ NOT "the first N": on a 15-minute grid that is 9:00 / 9:15 / 9:30 pm — three ways of
 * saying the same evening. Pure, client-side, over data the hook already fetched.
 */
function suggestTimes(slots, original, exclude = []) {
  const bestByDay = new Map();
  slots.forEach((slot) => {
    if (exclude.includes(slot.id)) return;
    if (slot.day === original.day && slot.startMin === original.startMin) return;
    const best = bestByDay.get(slot.day);
    const gap = Math.abs(slot.startMin - original.startMin);
    if (!best || gap < Math.abs(best.startMin - original.startMin)) bestByDay.set(slot.day, slot);
  });
  return [...bestByDay.values()].sort((a, b) => a.day - b.day).slice(0, SUGGESTION_COUNT);
}

const isUpcoming = (row) => row.state === 'scheduled' || row.state === 'pending_reschedule';

/**
 * ⚠ STANDS IN FOR THE LOADER. In production these four booleans arrive on the row, resolved
 * server-side per meeting by capability. No component ever runs this logic.
 */
function resolveFlags(row, who, inviteOn) {
  const none = {
    canInvite: false,
    canReschedule: false,
    canProposeReschedule: false,
    canCancel: false,
  };
  if (!isUpcoming(row) || who === 'colleague') return none;
  // Same two conditions the nudge applies: outside the join window, no proposal outstanding.
  const movable = row.state === 'scheduled' && !row.live;
  return {
    canInvite: inviteOn,
    canReschedule: who === 'client' && movable,
    canProposeReschedule: who === 'expert' && movable,
    canCancel: true,
  };
}

/** Built from flags alone. Order is fixed; the destructive item is always last. */
function menuItems(flags) {
  const items = [];
  if (flags.canInvite) items.push({ key: 'invite', label: 'Invite a colleague', icon: UserPlus });
  if (flags.canReschedule)
    items.push({ key: 'reschedule', label: 'Reschedule', icon: CalendarClock });
  if (flags.canProposeReschedule)
    items.push({ key: 'propose', label: 'Propose a new time', icon: CalendarClock });
  if (flags.canCancel)
    items.push({ key: 'cancel', label: 'Cancel consultation', icon: CalendarX, destructive: true });
  return items;
}

function pillFor(row, who) {
  switch (row.state) {
    case 'held':
      return { text: 'Held', tone: 'good' };
    case 'missed_call':
      return who === 'client'
        ? { text: 'Expert didn’t join', tone: 'warn' }
        : { text: 'Didn’t start', tone: 'warn' };
    case 'nobody_joined':
      // Same words on every lens, and never `warn`: there is no absent party to flag.
      return { text: 'Nobody joined', tone: 'muted' };
    case 'venue_unavailable':
      // BAL-581 — Balo's own failure, never `warn`: there is no absent party to flag.
      return { text: 'Call room unavailable', tone: 'muted' };
    case 'pending_reschedule':
      return { text: 'New time suggested', tone: 'brand' };
    case 'cancelled':
      return { text: 'Cancelled', tone: 'muted' };
    default:
      // Inside the join window the pill says so — a menu with no Reschedule explains itself.
      // BAL-581 — a live row whose call room isn't ready yet says so, instead of promising a
      // Join that isn't there.
      if (row.live && row.roomReady === false) {
        return { text: 'Setting up call room', tone: 'plain' };
      }
      return row.live
        ? { text: 'Starting soon', tone: 'brand' }
        : { text: 'Upcoming', tone: 'plain' };
  }
}

/** Shipped strings, except `scheduled`, whose note is retired (see docblock). */
function noteFor(row, who) {
  switch (row.state) {
    case 'pending_reschedule':
      if (who === 'client') return `${counterparty(who)} suggested some new times — see above`;
      return who === 'expert'
        ? 'Waiting on a reply to your suggested times'
        : 'Waiting on a reply to the suggested times';
    case 'cancelled':
      return 'Cancelled — nothing charged';
    case 'missed_call':
      return who === 'client'
        ? `${counterparty(who)} wasn’t able to join`
        : 'The call didn’t start';
    case 'nobody_joined':
      return 'Neither side joined this call';
    case 'venue_unavailable':
      return "Our call room wasn't ready in time — this one's on us";
    default:
      return null;
  }
}

const scopeFor = (email) => {
  const domain = email.slice(email.lastIndexOf('@') + 1).toLowerCase();
  if (FREEMAIL.includes(domain)) return 'meeting';
  return domain === CLIENT.domain ? 'case' : 'meeting';
};

/* ── prototype chrome ─────────────────────────────────────────────────────────────────── */

function Seg({ options, value, onChange }) {
  return (
    <div
      className="flex items-center gap-1 rounded-lg p-1"
      style={{ background: '#0d1017', border: '1px solid rgba(255,255,255,0.08)' }}
    >
      {options.map((o) => {
        const a = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            className="rounded-md px-2.5 py-1 text-xs font-medium transition-colors"
            style={{ background: a ? C.brand : 'transparent', color: a ? '#fff' : '#9AA2B0' }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function Ctl({ label, children }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs font-medium tracking-wide uppercase" style={{ color: '#8A93A3' }}>
        {label}
      </span>
      {children}
    </div>
  );
}

/* ── the row ──────────────────────────────────────────────────────────────────────────── */

const PILL_TONES = {
  good: { background: C.goodSoft, color: C.goodInk, border: `1px solid ${C.goodLine}` },
  warn: { background: C.warnSoft, color: C.warn, border: `1px solid ${C.warnLine}` },
  brand: { background: C.brandSoft, color: C.brand, border: `1px solid ${C.brandLine}` },
  muted: { background: '#F4F5F7', color: C.sub, border: `1px solid ${C.line}` },
  plain: { background: '#fff', color: C.text, border: `1px solid ${C.line}` },
};

function Pill({ text, tone }) {
  return (
    <span
      className="rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap"
      style={PILL_TONES[tone]}
    >
      {text}
    </span>
  );
}

function Indicator({ icon: Icon, label }) {
  return (
    <span
      className="inline-flex items-center rounded-md px-1.5 py-0.5"
      style={{ background: '#F5F6F8', color: C.sub }}
    >
      <Icon size={11} aria-hidden="true" />
      <span className="sr-only">{label}</span>
    </span>
  );
}

function RowMenu({ id, label, items, via, compact, top, onChoose, onClose }) {
  const ref = useRef(null);

  // Radix behaviour: a keyboard open lands on the first item, a pointer open on the menu
  // itself — so a click never pre-highlights anything, least of all the destructive item.
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const first = node.querySelector('[role="menuitem"]');
    (via === 'keyboard' && first ? first : node).focus();
  }, [via]);

  const onKeyDown = (e) => {
    const nodes = Array.from(e.currentTarget.querySelectorAll('[role="menuitem"]'));
    const i = nodes.indexOf(document.activeElement);
    const go = (n) => {
      e.preventDefault();
      nodes[n].focus();
    };
    if (e.key === 'ArrowDown') go(i < 0 ? 0 : (i + 1) % nodes.length);
    else if (e.key === 'ArrowUp') go(i <= 0 ? nodes.length - 1 : i - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(nodes.length - 1);
    else if (e.key === 'Escape') {
      e.preventDefault();
      onClose(true);
    } else if (e.key === 'Tab') onClose(false);
  };

  const firstDanger = items.findIndex((item) => item.destructive);

  return (
    <div
      ref={ref}
      id={id}
      role="menu"
      aria-label={label}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="balo-menu absolute right-0 rounded-xl p-1 outline-none"
      style={{
        top,
        zIndex: 30,
        width: 224,
        background: '#fff',
        border: `1px solid ${C.line}`,
        boxShadow: '0 1px 2px rgba(16,20,28,0.06), 0 12px 32px rgba(16,20,28,0.12)',
      }}
    >
      {items.map((item, i) => (
        <React.Fragment key={item.key}>
          {i === firstDanger && i > 0 && (
            <div role="separator" className="my-1" style={{ height: 1, background: C.line2 }} />
          )}
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            onClick={() => onChoose(item.key)}
            className={`balo-item ${item.destructive ? 'balo-item-danger' : ''} flex w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-sm`}
            style={{ height: compact ? 44 : 36, color: item.destructive ? C.danger : C.text }}
          >
            <item.icon size={15} color={item.destructive ? C.danger : C.sub} aria-hidden="true" />
            {item.label}
          </button>
        </React.Fragment>
      ))}
    </div>
  );
}

function ConsultationRow({
  row,
  who,
  flags,
  today,
  last,
  compact,
  menu,
  onOpenMenu,
  onCloseMenu,
  onChoose,
  registerTrigger,
}) {
  const muted =
    row.state === 'cancelled' ||
    row.state === 'missed_call' ||
    row.state === 'nobody_joined' ||
    row.state === 'venue_unavailable';
  const upcoming = isUpcoming(row);
  const Icon = muted ? CircleSlash : upcoming ? CalendarClock : Video;
  const items = menuItems(flags);
  const open = menu !== null && menu.id === row.id;
  const note = noteFor(row, who);
  const guestCount = row.guests ? row.guests.length : 0;
  const guestText = `${guestCount} guest${guestCount === 1 ? '' : 's'}`;
  const size = compact ? 44 : 32;
  const menuLabel = `Actions for consultation on ${row.abs}`;

  return (
    <div
      className="flex items-start gap-3 py-3"
      style={{ borderBottom: last ? 'none' : `1px solid ${C.line2}` }}
    >
      <span
        aria-hidden="true"
        className="mt-0.5 flex shrink-0 items-center justify-center rounded-lg"
        style={{ width: 28, height: 28, background: muted ? '#F4F5F7' : C.brandTile }}
      >
        <Icon size={14} color={muted ? C.faint : C.brand} />
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-sm font-medium" style={{ color: muted ? C.sub : C.text }}>
            {row.label || rowLabel(row.day, row.startMin, today)}
          </span>
          {/* Held ⇒ the ACTUAL length. Upcoming ⇒ the BOOKED one (v3). Cancelled ⇒ neither. */}
          {row.minutes || (upcoming && row.duration) ? (
            <span className="text-xs" style={{ color: C.sub }}>
              {row.minutes || row.duration} min
            </span>
          ) : null}
          <Pill {...pillFor(row, who)} />
        </div>

        {row.recap && (
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <span
              className="balo-link inline-flex cursor-pointer items-center gap-1 text-xs font-medium"
              style={{ color: C.brand }}
            >
              View recap <ArrowRight size={11} aria-hidden="true" />
            </span>
            {row.state === 'held' && row.tx && (
              <Indicator icon={FileText} label="Transcript available" />
            )}
            {row.state === 'held' && row.files ? (
              <Indicator icon={Paperclip} label={`${row.files} files`} />
            ) : null}
            {row.state === 'held' && row.items ? (
              <span className="text-xs" style={{ color: C.sub }}>
                {row.items} action items
              </span>
            ) : null}
          </div>
        )}

        {/* Guest state takes the slot the retired `scheduled` note held. COUNT ONLY. */}
        {upcoming && guestCount > 0 && (
          <div className="mt-1.5">
            {flags.canInvite ? (
              <button
                type="button"
                onClick={() => onChoose(row, 'invite')}
                aria-label={`${guestText} invited to the consultation on ${row.abs} — manage`}
                className="balo-link balo-focus inline-flex items-center gap-1.5 rounded text-xs"
                style={{ color: C.sub }}
              >
                <Users size={12} aria-hidden="true" /> {guestText}
              </button>
            ) : (
              <span className="inline-flex items-center gap-1.5 text-xs" style={{ color: C.sub }}>
                <Users size={12} aria-hidden="true" /> {guestText}
              </span>
            )}
          </div>
        )}

        {note && (
          <p className="mt-0.5 text-xs" style={{ color: C.sub }}>
            {note}
          </p>
        )}
      </div>

      {/* An absent action beats a dead one: no flags ⇒ no trigger, never a disabled one. */}
      {items.length > 0 && (
        <div
          className="relative shrink-0"
          style={{ marginTop: compact ? -6 : 0, marginRight: compact ? -10 : -6 }}
        >
          <button
            ref={(node) => registerTrigger(row.id, node)}
            type="button"
            aria-haspopup="menu"
            aria-expanded={open}
            aria-controls={open ? `menu-${row.id}` : undefined}
            aria-label={menuLabel}
            onClick={(e) =>
              open
                ? onCloseMenu(false)
                : onOpenMenu(row.id, e.detail === 0 ? 'keyboard' : 'pointer')
            }
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown' && !open) {
                e.preventDefault();
                onOpenMenu(row.id, 'keyboard');
              }
            }}
            className="balo-kebab balo-focus relative flex items-center justify-center rounded-lg"
            style={{ width: size, height: size, zIndex: open ? 30 : 'auto' }}
          >
            <MoreVertical size={16} aria-hidden="true" />
          </button>

          {open && (
            <>
              <div
                aria-hidden="true"
                onClick={() => onCloseMenu(false)}
                style={{ position: 'fixed', inset: 0, zIndex: 20 }}
              />
              <RowMenu
                id={`menu-${row.id}`}
                label={menuLabel}
                items={items}
                via={menu.via}
                compact={compact}
                top={size + 4}
                onChoose={(key) => onChoose(row, key)}
                onClose={onCloseMenu}
              />
            </>
          )}
        </div>
      )}
    </div>
  );
}

/* ── dialogs: STAND-INS for shipped components (see docblock) ─────────────────────────── */

const Btn = React.forwardRef(function Btn(
  { variant = 'outline', grow = false, children, ...rest },
  ref
) {
  const styles = {
    primary: { background: C.brand, color: '#fff', border: `1px solid ${C.brand}` },
    outline: { background: '#fff', color: C.text, border: `1px solid ${C.line}` },
    // No inline background on the ghost, or the hover class could never paint over it.
    ghostDanger: { color: C.danger, border: '1px solid transparent' },
  };
  const hover = { outline: 'balo-tap', ghostDanger: 'balo-ghost-danger' }[variant] || '';
  return (
    <button
      ref={ref}
      type="button"
      data-variant={variant}
      {...rest}
      className={`balo-focus ${hover} rounded-lg px-3.5 text-sm font-medium whitespace-nowrap`}
      style={{
        height: 36,
        flex: grow ? '1 1 auto' : undefined,
        opacity: rest.disabled ? 0.45 : 1,
        ...styles[variant],
      }}
    >
      {children}
    </button>
  );
});

function StandIn({ children }) {
  return (
    <p
      data-standin="true"
      className="mt-4 rounded-xl px-3 py-2 text-xs leading-relaxed"
      style={{ border: '1px dashed #D3D8E0', color: C.sub, background: '#FAFBFC' }}
    >
      {children}
    </p>
  );
}

function Modal({ title, sub, alert, width = 440, onClose, children }) {
  const panel = useRef(null);

  useEffect(() => {
    const node = panel.current;
    const target = node ? node.querySelector('[data-autofocus]') : null;
    if (target || node) (target || node).focus();
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // Mount-only: the dialog is re-mounted per target, so `onClose` cannot go stale.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      className="balo-scrim flex items-start justify-center p-4"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 50,
        background: 'rgba(11,14,19,0.45)',
        paddingTop: '12vh',
      }}
      // An AlertDialog has exactly two ways out — ESC and "Keep it". No overlay dismiss.
      onMouseDown={(e) => {
        if (!alert && e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panel}
        role={alert ? 'alertdialog' : 'dialog'}
        aria-modal="true"
        aria-labelledby="balo-dialog-title"
        tabIndex={-1}
        className="w-full rounded-3xl px-5 py-4 outline-none"
        style={{
          maxWidth: alert ? 512 : width, // AlertDialogContent is max-w-lg; three labels need it
          background: C.card,
          border: `1px solid ${C.line}`,
          boxShadow: '0 1px 2px rgba(16,20,28,0.04), 0 24px 60px rgba(16,20,28,0.18)',
        }}
      >
        <div className="mb-3 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2
              id="balo-dialog-title"
              className="text-base font-semibold"
              style={{ color: C.text }}
            >
              {title}
            </h2>
            {sub && (
              <p className="mt-0.5 text-xs leading-relaxed" style={{ color: C.sub }}>
                {sub}
              </p>
            )}
          </div>
          {!alert && (
            <button
              type="button"
              aria-label="Close"
              onClick={onClose}
              className="balo-kebab balo-focus flex shrink-0 items-center justify-center rounded-lg"
              style={{ width: 28, height: 28 }}
            >
              <X size={16} aria-hidden="true" />
            </button>
          )}
        </div>
        {children}
      </div>
    </div>
  );
}

/**
 * v2 — CHANGES the shipped `CancelConsultationDialog` (BAL-410): hierarchy, copy, and a
 * move-instead button. Machinery untouched (see docblock).
 */
function CancelBody({ row, who, flags, onKeep, onConfirm, onMoveInstead }) {
  const client = who === 'client';
  const party = partyLabel(who);
  const pending = row.state === 'pending_reschedule';

  // Same flags as the menu. No flag ⇒ no button AND no sentence pointing at one.
  let move = null;
  if (flags.canReschedule) move = { kind: 'reschedule', label: 'Reschedule instead' };
  else if (flags.canProposeReschedule) move = { kind: 'propose', label: 'Propose a new time' };

  // The ALTERNATIVE leads.
  let lead = null;
  if (move && client) {
    lead = `If it’s the time that doesn’t work, you can move this consultation to another of ${party}’s open times instead.`;
  } else if (move) {
    lead = `If a different time would work, propose one instead — ${party} picks a new time, or keeps this one.`;
  } else if (pending && client) {
    lead = `${counterparty(who)} has suggested some new times above — picking one of those keeps the call.`;
  } else if (pending) {
    lead = 'Cancelling also withdraws the suggested times.';
  }

  // The facts FOLLOW, conditionally. Free is a promise, not a pitch — it stays, it just
  // stops being the opening line.
  // "If you DO cancel" only makes sense after an alternative has been offered.
  const ifCancel = lead ? 'If you do cancel' : 'If you cancel';
  const facts = client
    ? `${ifCancel}, nothing is charged and any credit held for the call goes back to your balance.`
    : `${ifCancel}, ${party} is told and the slot reopens on your calendar. Nothing is charged either way.`;

  return (
    <>
      {lead && (
        <p className="text-sm leading-relaxed" style={{ color: C.text }}>
          {lead}
        </p>
      )}
      <p className={`${lead ? 'mt-3 ' : ''}text-sm leading-relaxed`} style={{ color: C.sub }}>
        Scheduled for {row.abs}. {facts}
      </p>
      <div className="balo-dialog-actions mt-5">
        <Btn variant="ghostDanger" onClick={onConfirm}>
          Cancel consultation
        </Btn>
        <div className="balo-dialog-safe">
          <Btn data-autofocus onClick={onKeep}>
            Keep it
          </Btn>
          {move && (
            <Btn variant="primary" onClick={() => onMoveInstead(move.kind)}>
              {move.label}
            </Btn>
          )}
        </div>
      </div>
      <StandIn>
        <strong>Changed in v2</strong> — no longer BAL-410 as shipped. The confirm drops to a red
        ghost, the alternative leads and takes the only filled button, and the free-to-cancel facts
        follow instead of opening. “Keep it”, the two dismiss paths, the async states and the
        abandon latch are untouched.
      </StandIn>
    </>
  );
}

/* ── the pickers (v3). Suggested times are NEW. The calendar and the confirm step are the
      shipped ones, redrawn only as far as the flow needs them. ─────────────────────────── */

const MAX_OPTIONS = 3; // RESCHEDULE_PROPOSAL_MAX_OPTIONS

/** One open time. ALWAYS the range and the length — never a bare start. */
function SlotButton({ slot, duration, showDay, adds, onPick }) {
  const Trail = adds ? Plus : ChevronRight;
  return (
    <button
      type="button"
      data-slot={slot.id}
      // The visible label is two spans; spell the name out so it never reads "pm30 min".
      aria-label={`${showDay ? `${dayAbs(slot.day)}, ` : ''}${fmtRange(slot.startMin, duration)}, ${duration} minutes${adds ? ' — add' : ''}`}
      onClick={() => onPick(slot)}
      className="balo-slot balo-focus flex w-full flex-wrap items-center justify-between gap-x-3 rounded-lg px-3.5 py-2 text-left"
      style={{ minHeight: 44, border: `1px solid ${C.line}`, color: C.text }}
    >
      <span className="text-sm">
        {showDay && <span className="font-medium">{dayShort(slot.day)} · </span>}
        <span className={showDay ? '' : 'font-medium'}>{fmtRange(slot.startMin, duration)}</span>
      </span>
      <span className="inline-flex items-center gap-1.5 text-xs" style={{ color: C.sub }}>
        {duration} min
        <Trail size={14} color={C.icon} aria-hidden="true" />
      </span>
    </button>
  );
}

function SuggestedTimes({ slots, duration, adds, onPick, onSeeMore }) {
  return (
    <div>
      <p className="mb-2 text-xs font-medium" style={{ color: C.sub }}>
        Suggested times
      </p>
      <div className="flex flex-col gap-1.5">
        {slots.map((slot) => (
          <SlotButton
            key={slot.id}
            slot={slot}
            duration={duration}
            showDay
            adds={adds}
            onPick={onPick}
          />
        ))}
      </div>
      <button
        type="button"
        onClick={onSeeMore}
        className="balo-tap balo-focus mt-2 w-full rounded-lg text-sm font-medium"
        style={{ height: 40, background: '#fff', border: `1px solid ${C.line}`, color: C.text }}
      >
        See more times
      </button>
    </div>
  );
}

/** Where "See more times" lands. The real thing is `ExpertAvailabilityCalendar`, untouched. */
function CalendarStandIn({ slots, duration, adds, canGoBack, onBack, onPick }) {
  const days = [...new Set(slots.map((slot) => slot.day))];
  const [day, setDay] = useState(days[0]);
  const active = days.includes(day) ? day : days[0];
  const forDay = slots.filter((slot) => slot.day === active);

  return (
    <div>
      {canGoBack && (
        <button
          type="button"
          onClick={onBack}
          className="balo-text-btn balo-focus mb-2 inline-flex items-center gap-1 rounded-lg px-2.5 text-sm font-medium"
          style={{ height: 32, marginLeft: -10, color: C.brand }}
        >
          <ChevronLeft size={14} aria-hidden="true" /> Suggested times
        </button>
      )}
      <div data-standin="true" className="rounded-xl p-3" style={{ border: '1px dashed #C9D0DB' }}>
        <p className="mb-3 text-xs leading-relaxed" style={{ color: C.sub }}>
          <strong>ExpertAvailabilityCalendar</strong> (BAL-236), as shipped — month grid not drawn.
          The one change is the ROW: with the length pinned it shows the range, where today it shows
          a bare start time.
        </p>
        <div className="mb-3 flex flex-wrap gap-1.5" role="group" aria-label="Day">
          {days.map((d) => (
            <button
              key={d}
              type="button"
              aria-pressed={d === active}
              onClick={() => setDay(d)}
              className="balo-focus rounded-full px-3 text-xs font-medium"
              style={{
                height: 32,
                background: d === active ? C.brand : '#fff',
                color: d === active ? '#fff' : C.text,
                border: `1px solid ${d === active ? C.brand : C.line}`,
              }}
            >
              {DAYS[d]} {d}
            </button>
          ))}
        </div>
        <p className="text-sm font-semibold" style={{ color: C.text }}>
          {dayAbs(active)}
        </p>
        <p className="mb-2 text-xs" style={{ color: C.sub }}>
          {forDay.length} time{forDay.length === 1 ? '' : 's'} available · {duration} min each
        </p>
        <div className="flex flex-col gap-1.5">
          {forDay.map((slot) => (
            <SlotButton key={slot.id} slot={slot} duration={duration} adds={adds} onPick={onPick} />
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * `RescheduleDialog` (BAL-409). The confirm step is the shipped one with ranges added; the
 * suggested view in front of the calendar is new (v3).
 */
function RescheduleBody({ row, slots, initialView, onConfirm }) {
  const suggestions = suggestTimes(slots, row);
  // Nothing worth suggesting ⇒ open on the calendar, exactly as the dialog does today.
  const [view, setView] = useState(
    suggestions.length === 0 ? 'calendar' : initialView || 'suggested'
  );
  const [picked, setPicked] = useState(null);
  const anchor = useRef(null);
  const back = useRef(null);
  const moved = useRef(false);

  // Focus follows the step (the shipped N14(b) rule): whatever was just activated unmounts.
  useEffect(() => {
    if (!moved.current) {
      moved.current = true;
      return;
    }
    const node = picked ? back.current : anchor.current;
    if (node) node.focus();
  }, [picked, view]);

  if (picked) {
    return (
      <>
        <h3 className="mb-3 text-sm font-semibold" style={{ color: C.text }}>
          Confirm the new time
        </h3>
        <div
          className="mb-2 rounded-lg px-4 py-3"
          style={{ background: '#F7F8FA', border: `1px solid ${C.line}` }}
        >
          <p className="text-xs font-medium tracking-wide uppercase" style={{ color: C.sub }}>
            Currently
          </p>
          <p className="text-sm" style={{ color: C.text }}>
            {spanLabel(row)} · {row.duration} min
          </p>
        </div>
        <div
          className="mb-4 rounded-lg px-4 py-3"
          style={{ background: C.brandSoft, border: `1px solid ${C.brandLine}` }}
        >
          <p className="text-xs font-medium tracking-wide uppercase" style={{ color: C.brand }}>
            Moving to
          </p>
          <p className="text-sm font-semibold" style={{ color: C.brand }}>
            {spanLabel({ ...picked, duration: row.duration })} · {row.duration} min
          </p>
        </div>
        <p className="mb-4 text-sm leading-relaxed" style={{ color: C.sub }}>
          Same length, same link — nothing else about this consultation changes.
        </p>
        <div className="flex flex-wrap gap-2">
          <Btn ref={back} onClick={() => setPicked(null)}>
            Choose a different time
          </Btn>
          <Btn variant="primary" grow onClick={() => onConfirm(picked)}>
            Move consultation
          </Btn>
        </div>
      </>
    );
  }

  return (
    <>
      <p ref={anchor} tabIndex={-1} className="mb-3 text-sm outline-none" style={{ color: C.sub }}>
        Currently{' '}
        <span className="font-medium" style={{ color: C.text }}>
          {spanLabel(row)}
        </span>{' '}
        <span className="whitespace-nowrap">· {row.duration} min</span>
      </p>
      {view === 'suggested' ? (
        <SuggestedTimes
          slots={suggestions}
          duration={row.duration}
          onPick={setPicked}
          onSeeMore={() => setView('calendar')}
        />
      ) : (
        <CalendarStandIn
          slots={slots}
          duration={row.duration}
          canGoBack={suggestions.length > 0}
          onBack={() => setView('suggested')}
          onPick={setPicked}
        />
      )}
      <StandIn>
        <strong>Changed in v3</strong> — suggested times now sit in front of the calendar (one tap
        to the confirm step instead of four), and every time carries its range and length. The
        confirm step, the action and the failure handling are <strong>RescheduleDialog</strong>{' '}
        (BAL-409) as shipped; its target is this row’s meeting.
      </StandIn>
    </>
  );
}

/** `ProposeTimesDialog` (BAL-411): same first view, but a pick ADDS to the ≤3 list. */
function ProposeBody({ row, slots, initialView, onSend, onKeep }) {
  const [picked, setPicked] = useState([]);
  const [view, setView] = useState(initialView || 'suggested');
  const taken = picked.map((slot) => slot.id);
  const remaining = slots.filter((slot) => !taken.includes(slot.id));
  // A day already in the proposal leaves the suggestions: three options should be three
  // different days, not 6:00 and 6:15 on the same evening. The calendar still allows it.
  const pickedDays = picked.map((slot) => slot.day);
  const suggestions = suggestTimes(
    remaining.filter((slot) => !pickedDays.includes(slot.day)),
    row
  );
  const atMax = picked.length >= MAX_OPTIONS;
  const showCalendar = view === 'calendar' || suggestions.length === 0;
  const add = (slot) =>
    setPicked((prev) => [...prev, slot].sort((a, b) => a.day - b.day || a.startMin - b.startMin));

  let picker;
  if (atMax) {
    picker = (
      <p className="text-sm leading-relaxed" style={{ color: C.sub }}>
        You’ve picked the maximum of {MAX_OPTIONS} times. Remove one above to pick a different time.
      </p>
    );
  } else if (showCalendar) {
    picker = (
      <CalendarStandIn
        slots={remaining}
        duration={row.duration}
        adds
        canGoBack={suggestions.length > 0}
        onBack={() => setView('suggested')}
        onPick={add}
      />
    );
  } else {
    picker = (
      <SuggestedTimes
        slots={suggestions}
        duration={row.duration}
        adds
        onPick={add}
        onSeeMore={() => setView('calendar')}
      />
    );
  }

  return (
    <>
      {picked.length > 0 && (
        <ul
          className="mb-3 flex list-none flex-col gap-2"
          style={{ margin: '0 0 12px', padding: 0 }}
        >
          {picked.map((slot) => {
            const span = spanLabel({ ...slot, duration: row.duration });
            return (
              <li
                key={slot.id}
                data-picked={slot.id}
                className="flex items-center justify-between gap-2 rounded-lg px-3 py-2 text-sm"
                style={{ background: '#F7F8FA', border: `1px solid ${C.line}`, color: C.text }}
              >
                <span>
                  {span} · {row.duration} min
                </span>
                <button
                  type="button"
                  aria-label={`Remove ${span}`}
                  onClick={() => setPicked(picked.filter((x) => x.id !== slot.id))}
                  className="balo-kebab balo-focus flex shrink-0 items-center justify-center rounded-lg"
                  style={{ width: 32, height: 32 }}
                >
                  <X size={14} aria-hidden="true" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {picker}
      <div className="mt-4 flex flex-wrap gap-2">
        <Btn onClick={onKeep}>Keep this time</Btn>
        <Btn variant="primary" grow disabled={picked.length === 0} onClick={() => onSend(picked)}>
          {picked.length > 0 ? `Send proposal (${picked.length})` : 'Send proposal'}
        </Btn>
      </div>
      <StandIn>
        <strong>Changed in v3</strong> — same suggested-first view, ranges on every picked time, and
        the dismiss, shipped as “Cancel”, reads “Keep this time”: on this surface “Cancel” means the
        consultation, and since v2 this dialog is reachable from the cancel confirmation. The rest
        is <strong>ProposeTimesDialog</strong> (BAL-411) as shipped. ⚠ A proposal on a call that is
        not next still needs the nudge-priority decision.
      </StandIn>
    </>
  );
}

function ScopeBadge({ scope }) {
  const isCase = scope === 'case';
  const Icon = isCase ? Building2 : Video;
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap"
      style={{ background: isCase ? C.warnSoft : '#F1F3F6', color: isCase ? C.warn : C.sub }}
    >
      <Icon size={10} aria-hidden="true" />
      {isCase ? 'Whole case' : 'This call only'}
    </span>
  );
}

/** Compact copy of `guest-invitation.jsx`'s InviteComposer. That file is the source of truth. */
function InviteBody({ row, who, onSend }) {
  const party = who === 'client' ? 'client' : 'expert';
  const [draft, setDraft] = useState('');
  const [mine, setMine] = useState(row.guests.filter((g) => g.party === party));
  const theirs = row.guests.filter((g) => g.party !== party);

  const email = draft.trim().toLowerCase();
  const valid = /^\S+@\S+\.\S+$/.test(email);
  const draftScope = valid ? scopeFor(email) : null;
  const caseLevel = mine.filter((g) => scopeFor(g.email) === 'case');
  const total = 2 + mine.length + theirs.length;

  const add = () => {
    if (!valid || mine.some((g) => g.email === email) || total >= MAX_PARTICIPANTS) return;
    const name = email.split('@')[0];
    setMine([...mine, { email, name: name.charAt(0).toUpperCase() + name.slice(1), party }]);
    setDraft('');
  };

  return (
    <>
      <div
        className="flex items-center gap-2 rounded-xl px-3 py-2"
        style={{ background: '#FAFBFC', border: `1px solid ${C.line}` }}
      >
        <Mail size={15} color={C.faint} className="shrink-0" aria-hidden="true" />
        <input
          data-autofocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
          placeholder="Email address"
          aria-label="Email address"
          className="min-w-0 flex-1 bg-transparent text-sm outline-none"
          style={{ color: C.text }}
        />
        {draftScope && <ScopeBadge scope={draftScope} />}
        <button
          type="button"
          onClick={add}
          disabled={!valid}
          className="balo-focus shrink-0 rounded-lg px-2.5 py-1 text-xs font-semibold"
          style={{ background: valid ? C.brand : '#EDEFF2', color: valid ? '#fff' : C.sub }}
        >
          Add
        </button>
      </div>

      {draftScope === 'case' && (
        <div className="mt-1.5 flex items-start gap-1.5 px-1 text-xs" style={{ color: C.warn }}>
          <ShieldQuestion size={12} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span>
            Same company as {who === 'client' ? 'you' : CLIENT.company} — they’ll see this whole
            case, including consultations held before today.
          </span>
        </div>
      )}
      {draftScope === 'meeting' && (
        <div className="mt-1.5 px-1 text-xs" style={{ color: C.sub }}>
          Outside {CLIENT.company} — they’ll only see this call and its recap.
        </div>
      )}

      {mine.length > 0 && (
        <div className="mt-3 flex flex-col gap-1.5">
          {mine.map((g) => (
            <div
              key={g.email}
              className="flex items-center gap-2.5 rounded-xl px-2.5 py-2"
              style={{ background: '#fff', border: `1px solid ${C.line}` }}
            >
              <span className="min-w-0 flex-1 truncate text-sm" style={{ color: C.text }}>
                {g.email}
              </span>
              <ScopeBadge scope={scopeFor(g.email)} />
              <button
                type="button"
                aria-label={`Remove ${g.email}`}
                onClick={() => setMine(mine.filter((x) => x.email !== g.email))}
                className="balo-kebab balo-focus flex shrink-0 items-center justify-center rounded"
                style={{ width: 24, height: 24 }}
              >
                <X size={14} aria-hidden="true" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* ADR-1044: names cross the party boundary, email addresses never do. */}
      {theirs.length > 0 && (
        <p className="mt-3 text-xs leading-relaxed" style={{ color: C.sub }}>
          Also invited by {counterparty(who)}: {theirs.map((g) => g.name).join(', ')}.
        </p>
      )}

      {caseLevel.length > 0 && (
        <div
          className="mt-3 flex items-start gap-2 rounded-xl px-3 py-2.5"
          style={{ background: C.warnSoft, border: `1px solid ${C.warnLine}` }}
        >
          <ShieldQuestion size={14} color={C.warn} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span className="text-xs leading-relaxed" style={{ color: '#7A4A12' }}>
            {caseLevel.length === 1
              ? `${caseLevel[0].name} will be able to read every consultation in this case — recaps, transcripts and action items — including ones held before they were invited.`
              : `${caseLevel.length} people will be able to read every consultation in this case, including ones held before they were invited.`}
          </span>
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <span className="text-xs" style={{ color: C.sub }}>
          {total} of {MAX_PARTICIPANTS}
          {who === 'client' ? ' · guests don’t change what you pay' : ' in the call'}
        </span>
        <Btn variant="primary" onClick={() => onSend([...theirs, ...mine])}>
          Send invites
        </Btn>
      </div>
      <StandIn>
        Compact copy of <strong>guest-invitation.jsx</strong>’s case-surface panel. New here is only
        the anchor: the invite posts to <em>this row’s</em> meeting.
      </StandIn>
    </>
  );
}

/* ── the nudge: `'upcoming'` arm only (v2). Strings quoted from `case-nudge.tsx`. ──────── */

function NudgePlaceholder({ children }) {
  return (
    <div
      data-standin="true"
      className="rounded-2xl px-4 py-3 text-xs leading-relaxed"
      style={{ border: '1px dashed #C9D0DB', color: C.sub }}
    >
      {children}
    </div>
  );
}

function CaseNudge({ next, who, flags, nowAbs, compact, onMove }) {
  if (!next)
    return <NudgePlaceholder>Nothing-booked nudge — unchanged, not drawn.</NudgePlaceholder>;
  if (next.state === 'pending_reschedule') {
    return (
      <NudgePlaceholder>
        Proposal nudge + RescheduleProposalCard — unchanged, not drawn. Neither ever offered Cancel;
        for this call it now lives on its row below.
      </NudgePlaceholder>
    );
  }

  const client = who === 'client';
  const other = counterparty(who);
  const live = next.live;
  const joinLabel = joinCountdownLabel(next.at, nowAbs);

  // Announce the ONE moment that matters, once. The ticking label is never a live region.
  const wasLive = useRef(live);
  const [announcement, setAnnouncement] = useState('');
  useEffect(() => {
    if (live && !wasLive.current) setAnnouncement('You can join now.');
    if (!live) setAnnouncement('');
    wasLive.current = live;
  }, [live]);
  const Icon = live ? Video : CalendarClock;
  const title = live ? 'Your consultation starts in 8 minutes' : `Next consultation · ${next.abs}`;
  let body;
  if (client) {
    body = live
      ? `${other} will join from here. Go in when you’re ready — the timer starts when you’re both in.`
      : `Your call with ${other} is booked. Join from here when it’s time, and we’ll send a reminder — nothing to do until then.`;
  } else {
    body = live
      ? `${other} is expecting you. Their brief and the last recap are on this case.`
      : `${other} is booked in. Their brief and the last recap are on this case.`;
  }

  // The ONE move action, from the same per-meeting flags the row menu reads. ⚠ NO CANCEL HERE.
  let move = null;
  if (flags.canReschedule) move = { kind: 'reschedule', label: 'Reschedule' };
  else if (flags.canProposeReschedule) move = { kind: 'propose', label: 'Propose a new time' };

  return (
    <section
      aria-label="Next consultation"
      data-nudge="upcoming"
      className="flex items-start gap-3 rounded-2xl px-4 py-3.5"
      style={{ background: C.brandSoft, border: `1px solid ${C.brandLine}` }}
    >
      <Icon size={17} color={C.brand} className="mt-0.5 shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          {live && (
            <span
              aria-hidden="true"
              className="inline-block shrink-0 rounded-full"
              style={{ width: 7, height: 7, background: C.live }}
            />
          )}
          <p className="text-sm font-semibold" style={{ color: C.text }}>
            {title}
          </p>
        </div>
        <p className="mt-0.5 text-sm leading-relaxed" style={{ color: C.sub }}>
          {body}
        </p>

        {/* v4 — THE JOIN SLOT NEVER MOVES AND NEVER DISAPPEARS. Before the window it is a
            countdown that looks like the button it will become; inside it, the button. Same
            place, same size, so the eye already knows where to go. */}
        <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1">
          {live ? (
            <button
              type="button"
              data-join="active"
              data-variant="primary"
              className="balo-join balo-focus inline-flex items-center justify-center gap-2 rounded-lg px-4 text-sm font-medium whitespace-nowrap"
              style={{ height: 44, minWidth: 132, background: C.brand, color: '#fff' }}
            >
              <span
                aria-hidden="true"
                className="rounded-full"
                style={{ width: 7, height: 7, background: '#34D399' }}
              />
              {joinLabel}
            </button>
          ) : (
            // ⚠ `aria-disabled`, NOT `disabled`: it stays focusable and legible, because
            // "in 2 days" is information. ⚠ And NOT `JoinMeetingButton` with a prop — that
            // component's "rendered ONLY inside the join window" invariant is pinned by the
            // calendar's tests. This is its own element: `JoinCountdown`.
            <button
              type="button"
              data-join="pending"
              data-variant="pending"
              aria-disabled="true"
              aria-describedby="balo-join-hint"
              onClick={(event) => event.preventDefault()}
              className="balo-join-pending balo-focus inline-flex items-center justify-center gap-2 rounded-lg px-4 text-sm font-medium whitespace-nowrap"
              style={{ height: 44, minWidth: 132, background: C.pendingFill, color: C.sub }}
            >
              <Clock size={14} aria-hidden="true" />
              {joinLabel}
            </button>
          )}

          {/* A TEXT button: no box, no fill. Gone inside the window, as before. */}
          {!live && move && (
            <button
              type="button"
              data-variant="text"
              onClick={() => onMove(next, move.kind)}
              className="balo-text-btn balo-focus rounded-lg px-2.5 text-sm font-medium"
              style={{ height: compact ? 44 : 32, color: C.brand }}
            >
              {move.label}
            </button>
          )}
        </div>
        <span id="balo-join-hint" className="sr-only">
          Opens {JOIN_WINDOW_MINUTES} minutes before the start.
        </span>
        <span role="status" className="sr-only">
          {announcement}
        </span>
      </div>
    </section>
  );
}

/* ── the page ─────────────────────────────────────────────────────────────────────────── */

/**
 * `initial` deep-links a state — `{ who, scenario, clock, invite, width, openMenu, dialog }` — so
 * every combination can be rendered and checked without clicking. It has no product meaning.
 */
export default function App({ initial = {} }) {
  const [who, setWho] = useState(initial.who || 'client');
  const [scenario, setScenario] = useState(initial.scenario || 'three');
  const [invite, setInvite] = useState(initial.invite || 'on');
  const [width, setWidth] = useState(initial.width || 'wide');
  const [clock, setClock] = useState(initial.clock || 'd1');
  const [upcoming, setUpcoming] = useState(() => SCENARIOS[initial.scenario || 'three']());
  // The clock is pinned to the call that was next when the scenario was seeded, so cancelling
  // or moving that call changes the countdown — it does not drag "now" along with it.
  const [anchor, setAnchor] = useState(() => {
    const first = SCENARIOS[initial.scenario || 'three']()[0];
    return first ? first.at : null;
  });
  const [menu, setMenu] = useState(
    initial.openMenu ? { id: initial.openMenu, via: 'pointer' } : null
  );
  const [dialog, setDialog] = useState(initial.dialog || null);
  const [toast, setToast] = useState(null);
  const triggers = useRef({});
  const heading = useRef(null);
  const opener = useRef(null);

  useEffect(() => {
    if (!toast) return undefined;
    const timer = setTimeout(() => setToast(null), 3600);
    return () => clearTimeout(timer);
  }, [toast]);

  const compact = width === 'narrow';
  const untilStart = scenario === 'live' ? LIVE_MINUTES : CLOCKS[clock].minutes;
  const nowAbs = anchor === null ? DEFAULT_NOW : anchor - untilStart;
  const today = Math.floor(nowAbs / 1440);
  // ⚠ `live` is DERIVED from the clock on every render — see `isLive`.
  const timed = upcoming.map((row) => ({ ...row, live: isLive(row, nowAbs) }));
  const rows = [...HISTORY, ...timed];
  const target = dialog ? timed.find((row) => row.id === dialog.id) || null : null;
  const targetFlags = target ? resolveFlags(target, who, invite === 'on') : null;
  // `selectNextScheduled`'s stand-in: the first call that is still upcoming.
  const next = timed.find(isUpcoming) || null;
  const nextFlags = next ? resolveFlags(next, who, invite === 'on') : null;

  const seed = (next) => {
    const fresh = SCENARIOS[next]();
    setUpcoming(fresh);
    setAnchor(fresh[0] ? fresh[0].at : null);
    setMenu(null);
    setDialog(null);
    setToast(null);
  };

  // Focus goes back to whatever opened the dialog — the nudge's text button, a guest count —
  // if it still exists. A menu item never does, so that falls to the row's trigger, and a
  // cancelled row has no trigger, so that falls to the section heading.
  const focusBack = (id) => {
    requestAnimationFrame(() => {
      const from = opener.current;
      const node =
        (from && document.contains(from) ? from : null) || triggers.current[id] || heading.current;
      if (node) node.focus();
    });
  };

  const closeMenu = (returnFocus) => {
    const id = menu ? menu.id : null;
    setMenu(null);
    if (returnFocus && id) focusBack(id);
  };

  const choose = (row, kind) => {
    opener.current = document.activeElement;
    setMenu(null);
    setDialog({ kind, id: row.id });
  };

  const closeDialog = () => {
    const id = dialog ? dialog.id : null;
    setDialog(null);
    if (id) focusBack(id);
  };

  const patch = (id, change) =>
    setUpcoming((prev) =>
      prev.map((row) => (row.id === id ? { ...row, ...change } : row)).sort((a, b) => a.at - b.at)
    );

  const finish = (id, change, title, body) => {
    patch(id, change);
    setToast({ title, body });
    setDialog(null);
    focusBack(id);
  };

  return (
    <div
      className="flex w-full flex-col items-center gap-4 p-4"
      style={{
        background: C.bg,
        minHeight: '100vh',
        fontFamily: 'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
      }}
    >
      <style>{CSS}</style>

      <div
        className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-xl px-3 py-2.5"
        style={{ background: C.ink }}
      >
        <Ctl label="Lens">
          <Seg
            value={who}
            onChange={(next) => {
              setWho(next);
              setMenu(null);
              setDialog(null);
            }}
            options={[
              { value: 'client', label: 'Client' },
              { value: 'expert', label: 'Expert' },
              { value: 'colleague', label: 'Colleague' },
            ]}
          />
        </Ctl>
        <Ctl label="Upcoming">
          <Seg
            value={scenario}
            onChange={(next) => {
              setScenario(next);
              seed(next);
            }}
            options={[
              { value: 'one', label: 'One' },
              { value: 'three', label: 'Three' },
              { value: 'live', label: 'Starting' },
              { value: 'proposed', label: 'New time' },
              { value: 'none', label: 'None' },
            ]}
          />
        </Ctl>
        {scenario !== 'live' && (
          <Ctl label="Starts in">
            <Seg
              value={clock}
              onChange={setClock}
              options={Object.keys(CLOCKS).map((key) => ({ value: key, label: CLOCKS[key].label }))}
            />
          </Ctl>
        )}
        <Ctl label="Invite">
          <Seg
            value={invite}
            onChange={(next) => {
              setInvite(next);
              setMenu(null);
            }}
            options={[
              { value: 'on', label: 'On' },
              { value: 'off', label: 'Off' },
            ]}
          />
        </Ctl>
        <Ctl label="Column">
          <Seg
            value={width}
            onChange={setWidth}
            options={[
              { value: 'wide', label: 'Wide' },
              { value: 'narrow', label: 'Narrow' },
            ]}
          />
        </Ctl>
        <button
          type="button"
          onClick={() => seed(scenario)}
          className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium"
          style={{ color: '#9AA2B0' }}
        >
          <RotateCcw size={12} aria-hidden="true" /> Reset
        </button>
      </div>

      <div className="flex w-full flex-col gap-3" style={{ maxWidth: compact ? 360 : 720 }}>
        <CaseNudge
          next={next}
          who={who}
          flags={nextFlags}
          nowAbs={nowAbs}
          compact={compact}
          onMove={choose}
        />

        <section
          aria-labelledby="balo-consultations"
          className="rounded-3xl px-5 py-4"
          style={{ background: C.card, border: `1px solid ${C.line}` }}
        >
          <div className="mb-2.5 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Clock size={15} color={C.sub} aria-hidden="true" />
              <h2
                id="balo-consultations"
                ref={heading}
                tabIndex={-1}
                className="text-sm font-semibold outline-none"
                style={{ color: C.text }}
              >
                Consultations
              </h2>
            </div>
            <span className="text-xs" style={{ color: C.sub }}>
              {rows.length} · newest last
            </span>
          </div>

          <ul className="list-none" style={{ margin: 0, padding: 0 }}>
            {rows.map((row, index) => (
              <li key={row.id} data-row={row.id} data-state={row.state}>
                <ConsultationRow
                  row={row}
                  who={who}
                  flags={resolveFlags(row, who, invite === 'on')}
                  today={today}
                  last={index === rows.length - 1}
                  compact={compact}
                  menu={menu}
                  onOpenMenu={(id, via) => setMenu({ id, via })}
                  onCloseMenu={closeMenu}
                  onChoose={choose}
                  registerTrigger={(id, node) => {
                    if (node) triggers.current[id] = node;
                    else delete triggers.current[id];
                  }}
                />
              </li>
            ))}
          </ul>
        </section>
      </div>

      {target && dialog.kind === 'cancel' && (
        <Modal alert title="Cancel this consultation?" onClose={closeDialog}>
          <CancelBody
            row={target}
            who={who}
            flags={targetFlags}
            onKeep={closeDialog}
            // One dialog target: diverting is a swap of `kind`, same meeting.
            onMoveInstead={(kind) => setDialog({ kind, id: target.id })}
            onConfirm={() =>
              finish(
                target.id,
                { state: 'cancelled' },
                'Consultation cancelled',
                'Nothing was charged.'
              )
            }
          />
        </Modal>
      )}

      {target && dialog.kind === 'reschedule' && (
        <Modal
          title="Reschedule consultation"
          sub={`Pick a new time with the expert on ${CASE_TITLE} — same length, same link.`}
          width={560}
          onClose={closeDialog}
        >
          <RescheduleBody
            row={target}
            slots={openSlots(upcoming, target.id)}
            initialView={dialog.view}
            onConfirm={(slot) =>
              finish(
                target.id,
                timeFields(slot.day, slot.startMin),
                'Consultation moved',
                `New time: ${spanLabel({ ...slot, duration: target.duration })}`
              )
            }
          />
        </Modal>
      )}

      {target && dialog.kind === 'propose' && (
        <Modal
          title="Propose new times"
          sub={`Suggest up to ${MAX_OPTIONS} alternative times for ${CASE_TITLE}. Your client picks one, or keeps the original time — nothing moves until they answer.`}
          width={560}
          onClose={closeDialog}
        >
          <ProposeBody
            row={target}
            slots={openSlots(upcoming, target.id)}
            initialView={dialog.view}
            onKeep={closeDialog}
            onSend={(options) =>
              finish(
                target.id,
                { state: 'pending_reschedule' },
                options.length === 1 ? 'Time proposed' : `${options.length} times proposed`,
                'Your client can accept one, or keep the original time.'
              )
            }
          />
        </Modal>
      )}

      {target && dialog.kind === 'invite' && (
        <Modal
          title="Invite a colleague"
          sub={`${CASE_TITLE} · consultation on ${target.abs}`}
          onClose={closeDialog}
        >
          <InviteBody
            row={target}
            who={who}
            onSend={(guests) => finish(target.id, { guests }, 'Invites sent', null)}
          />
        </Modal>
      )}

      {toast && (
        <div
          role="status"
          aria-live="polite"
          className="balo-toast flex items-start gap-2.5 rounded-xl px-4 py-3"
          style={{
            position: 'fixed',
            right: 20,
            bottom: 20,
            zIndex: 60,
            maxWidth: 320,
            background: '#fff',
            border: `1px solid ${C.line}`,
            boxShadow: '0 12px 32px rgba(16,20,28,0.14)',
          }}
        >
          <span
            className="mt-0.5 flex shrink-0 items-center justify-center rounded-full"
            style={{ width: 16, height: 16, background: C.good }}
          >
            <Check size={10} color="#fff" strokeWidth={3.5} aria-hidden="true" />
          </span>
          <div>
            <div className="text-sm font-medium" style={{ color: C.text }}>
              {toast.title}
            </div>
            {toast.body && (
              <div className="text-xs" style={{ color: C.sub }}>
                {toast.body}
              </div>
            )}
          </div>
        </div>
      )}

      <p className="max-w-xl text-center text-xs leading-relaxed" style={{ color: '#6E7888' }}>
        Prototype · consultation row actions v4. Join is always in the nudge: a countdown until the
        window opens (try Starts in), then the pulsing button (Upcoming → Starting). Earlier:
        rescheduling opens on suggested times with every time showing its range; Cancel lives on the
        row; a cancelled row has no recap; the cancel dialog leads with moving the call.
      </p>
    </div>
  );
}
