import React, { useEffect, useState } from 'react';
import {
  ArrowRight,
  Bell,
  CalendarClock,
  ChevronRight,
  CircleSlash,
  Clock,
  Loader2,
  MoreVertical,
  Phone,
  PhoneMissed,
  RotateCcw,
  Search,
  Star,
  Video,
  X,
} from 'lucide-react';

/**
 * Balo — Call now (design reference, v3)
 * File: `.claude/design-references/call-now.jsx`
 *
 * Either party on an OPEN case can call the other without a booking. v1 of this file was drawn
 * without reading the shipped references and is superseded entirely. This version is a PATCH on:
 *   case-surface.jsx (v6) · consultation-row-actions.jsx (v4) · top-nav-call-pill.jsx (v1)
 *   notification-arrival.jsx · waiting-state-patch.jsx
 * Anything those files own appears here only as a dashed placeholder.
 *
 * ── THE MODEL ────────────────────────────────────────────────────────────────────────────────
 *  A call-now is an UNSCHEDULED CONSULTATION on the case: a meeting whose start is "now".
 *  Its join window is therefore open the moment it exists, so every shipped join surface lights
 *  up for the other party with no new plumbing: the case nudge, the top-nav pill, Up next.
 *  The caller goes straight into the call room and waits there (`WaitingStage`), exactly as
 *  someone who "goes in early" does today. Nobody is auto-navigated anywhere.
 *
 * ── WHAT IS NEW ──────────────────────────────────────────────────────────────────────────────
 *  1. ENTRY: "Call now" in the rail party card. Client: under the Book-a-time strip, never above
 *     it — booking stays the primary path. Expert: on the client card. Not in the header, not in
 *     a kebab, never on a row (one inline link per row stays the pattern).
 *  2. CONFIRM dialog for the caller. The client's states the rate and the 15-minute minimum.
 *  3. `WaitingStage` variant `calling`, and its end state `no answer`.
 *  4. THE CALL TOAST: one surface for the callee, identical on every page INCLUDING the case.
 *     A persistent variant of `ArrivalToast` (anchored under the bell, same shell) with Join +
 *     "Not now". When the ring ends unanswered the SAME toast becomes "You missed a call from…"
 *     and stays until dismissed, called back, or the case is opened. It is just the unread
 *     `call` notification, so someone who was offline sees the identical toast on their next
 *     page load. It never navigates on its own.
 *  5. NO NEW NUDGE ARMS (owner, 2026-11-16 — v2 had three). The call is a meeting with an open
 *     join window, so the shipped live nudge and the top-nav pill show their ordinary Join for
 *     it; the pill gains one status string, "Calling now". ONE MOVING THING: while the toast is
 *     up its Join carries the ring and the nudge's and the pill's go static.
 *  6. Row dressing for an unscheduled consultation (one note line; no new row component).
 *
 * ── ⚠ WHERE THE TOAST DEPARTS FROM notification-arrival ──────────────────────────────────────
 *  · It does not time out (8 s there) and a missed call is never folded into the collapsed
 *    "3 updates" toast: it shows on its own and the other items wait in the bell.
 *  · Sticky = unread. Dismiss, Call back and visiting the case all mark the `call` notification
 *    read, which is what removes the toast on every tab. It also stays in the bell like any item.
 *  · Several missed calls: one toast. Same person ⇒ "2 missed calls from Sandy"; different
 *    people ⇒ the newest, with the rest in the bell.
 *  · "Call back" from another page opens the case with the confirm dialog up. That navigation
 *    is the person's own click.
 *  · "Not now" produces NO missed-call toast for the person who pressed it.
 *
 * ── WHAT IS NOT NEW — REUSE, DO NOT REBUILD ──────────────────────────────────────────────────
 *  · `JoinMeetingButton` for every Join here (toast, pill, nudge). EVERY Join goes straight to
 *    the call route `(call)/meetings/[meetingId]/call` — never to the case. ONE MOVING THING still holds:
 *    while the toast is up its Join carries the ring and the pill's goes static (`liveCue`).
 *  · Room, recap, end-of-call, settlement of a COMPLETED call: unchanged. A connected call-now is
 *    an ordinary consultation from the moment both are in, 15-minute minimum included.
 *  · Credit gate: `booking-inline-funding` as shipped, opened from the confirm (client calls) or
 *    from Join (expert calls). Drawn here as a stand-in.
 *  · Expert "can't make it": NOT in this file. `ProposeTimesDialog` and Cancel on the row already
 *    cover it; cancel already returns the hold. v1's parallel flow is withdrawn.
 *
 * ── ⚠⚠ RULES THE SHIPPED CLOCKS WOULD GET WRONG ─────────────────────────────────────────────
 *  A scheduled meeting has two behaviours that must NEVER fire for an unanswered call-now:
 *   a. NO NO-SHOW. Today the expert-present clock starts when the expert joins and settles a
 *      client no-show at the 15-minute floor. An expert who rings a client and waits would bill
 *      a client who never agreed to a call. On a call-now, waiting is never counted, for anyone.
 *   b. NO MISSED-CALL ALERT. Today a client waiting 5 minutes with no expert emails the Balo
 *      team. A client ringing an expert who doesn't pick up is not an incident.
 *  Billing exists only once BOTH have joined. An unanswered attempt ends in a new terminal
 *  state (`no_answer`) that charges nothing, pages nobody and has no recap.
 *
 * ── OTHER RULES ──────────────────────────────────────────────────────────────────────────────
 *  · Available while the case is OPEN. Not tied to a booking.
 *  · AN ABSENT ACTION BEATS A DEAD ONE. Call now is not rendered when: the case is closed; the
 *    expert has paused availability (client lens only — a paused expert can still ring out); the
 *    other party is already in a call (a quiet line says so); it is outside reasonable hours for
 *    an OFFLINE expert (a quiet line gives their local time).
 *  · Presence changes the client's confirm: online ⇒ "Call now" is the filled button; offline ⇒
 *    "Book a time" is, and "Call anyway" is the outline. Copy says "online", never "available".
 *  · Ring window: RING_SECONDS, or RING_SECONDS_OFFLINE when the callee is reached by SMS.
 *  · IN PLACE OF A BOOKING. If the case has a consultation booked for later TODAY, the client
 *    (caller or callee) may use the call in its place: ticked by default. It is a move of that
 *    same meeting to now — one row, same room, guests and join link, no new funding check — and it
 *    only takes effect when the call CONNECTS;
 *    an unanswered ring leaves the booking exactly where it was. Other days are never offered.
 *  · Fee concealment: rate and minimum render on the client lens only. No money in any row.
 *  · Names: the client sees the expert's first name; the expert sees the client COMPANY.
 *  · Nothing here dismisses with the word "Cancel".
 *  · Never rendered while staff are "viewing as" a user (mirrors the pill and the bell).
 *
 * ── ⚠ DEPENDENCIES ───────────────────────────────────────────────────────────────────────────
 *  · REALTIME. The bell polls every 30 s; a 45 s ring cannot ride on that. The incoming-call
 *    toast, the pill and the nudge need an Ably push (the follow-up notification-arrival defers).
 *  · A ring SOUND and a browser notification (permission asked on first use of Call now). The
 *    in-app toast only works if the tab is in front.
 *  · SMS to the callee when they are not active in the app (experts by default — see
 *    expert-phone-verification; clients only if opted in). Copy lives in the ticket's copy sheet.
 *
 * ── DECIDED (ADR-1058, 2026-11-16) ───────────────────────────────────────────────────────────
 *  · On the client side the person who booked the case is rung. Invited colleagues are not.
 *  · `no_answer` gets NO row — it was never a consultation. The callee gets the missed-call toast
 *    and a bell item; three unanswered rings must not be three rows.
 *  · Ring window: 45 s, or 120 s when the callee is reached by SMS.
 *  · An offline expert is only rung 8 am to 8 pm in their own time zone.
 *  · MONEY (ADR-1040 Amendment 8). Balo places no hold at booking. A call with no booking behind
 *    it runs the booking-time funding checks when the CLIENT commits (confirm, or Join when the
 *    expert calls), with the estimate at the 15-minute floor; a company with a card on file
 *    passes. A call taking the place of a same-day booking runs no check again.
 *  · Not offered while the client company has another live consultation.
 *
 * ── STILL OPEN ───────────────────────────────────────────────────────────────────────────────
 *  · The source of "online" presence (proposed: Ably presence on BAL-620's channel).
 *  · A phone layout. `case-surface-mobile.jsx` has none for any of this.
 *
 * ── ⚠ "HELD" → "COMPLETED" (owner, 2026-11-16; MJ sign-off) ─────────────────────────────────
 *  Internal testers read the "Held" pill as "blocked", and the product also says "credit held"
 *  for money. USER-FACING copy for a finished consultation is "Completed": the row pill here,
 *  and the case header's "N consultations held" (not drawn). The internal state name `held`
 *  does NOT change, and "credit held for…" keeps the word — that is the meaning people expect.
 *  This file must not reintroduce the old pill.
 *
 * ── NEW COPY (MJ sign-off) ───────────────────────────────────────────────────────────────────
 *  Every string in COPY below.
 */

const RING_SECONDS = 45;
const RING_SECONDS_OFFLINE = 120;
const RATE = 6.25;
const FLOOR_MINUTES = 15;
const CASE_TITLE = 'Salesforce records duplicate cleanup';
const EXPERT = {
  first: 'Sandy',
  full: 'Sandy Langworth',
  title: 'Salesforce Architect · Data quality',
};
const CLIENT = { company: 'Northwind Industrial', booker: 'Jordan Lee' };
const BOOKED_AT = '4:00 pm';
const NOW_AT = '2:05 pm';

const money = (n) => `A$${n.toFixed(2)}`;
const RATE_LINE = `${money(RATE)}/min · ${FLOOR_MINUTES}-minute minimum`;
/** The other side's short name: the expert's first name, or the client COMPANY — never a person. */
const other = (who) => (who === 'client' ? EXPERT.first : CLIENT.company);

const COPY = {
  entry: 'Call now',
  busy: (n) => `${n} is in another call`,
  lateNight: (n) => `It’s 3:10 am for ${n} — book a time instead`,
  confirmTitle: (n) => `Call ${n} now?`,
  clientOnline: (n) =>
    `${n} is online. We’ll let them know you’re calling and you’ll wait in the call room. If ${n} doesn’t pick up, nothing is charged.`,
  clientOffline: (n) =>
    `${n} isn’t online right now. We’ll send a text, but they may not see it in time. If they don’t pick up, nothing is charged — booking a time is the surer way to talk.`,
  clientTerms: `${RATE_LINE}. The timer starts when you’re both in.`,
  expertConfirm: (n) =>
    `We’ll let ${n} know you’re calling. They see your rate before they join, and the timer starts when you’re both in. Waiting isn’t counted on an unscheduled call.`,
  inPlace: `Use this call in place of today’s ${BOOKED_AT} consultation`,
  inPlaceHint: 'No extra credit is needed for this call, and the later slot is released.',
  notNow: 'Not now',
  callAnyway: 'Call anyway',
  bookInstead: 'Book a time',
  callingTitle: (n) => `Calling ${n}`,
  callingClient: (n, sms) =>
    `${sms ? `We’ve texted ${n}` : `We’ve let ${n} know`}. Nothing is charged while you wait — the timer starts once you’re both in.`,
  callingExpert: (n) =>
    `We’ve let ${n} know. Waiting isn’t counted on an unscheduled call — the timer starts once you’re both in.`,
  stop: 'Stop calling',
  noAnswerTitle: (n) => `No answer from ${n}`,
  declinedTitle: (n) => `${n} can’t talk right now`,
  noAnswerClient: (n) => `Nothing was charged. ${n} will see that you called.`,
  noAnswerExpert: (n) => `Nothing was counted or charged. ${n} will see that you called.`,
  backToCase: 'Back to the case',
  incomingTitle: (n) => `${n} is calling`,
  incomingAbout: `About ${CASE_TITLE}.`,
  pillStatus: 'Calling now',
  missedTitle: (n) => `You missed a call from ${n}`,
  missedBody: `They tried to reach you at ${NOW_AT}.`,
  callBack: 'Call back',
  liveTitle: (n) => `Your call with ${n} is happening now`,
  rowNote: 'Unscheduled call',
  rowNoteMoved: `Started early — was booked for ${BOOKED_AT}`,
  fundTitle: 'Add credit to start this call',
  fundBody: `A call needs enough credit for the ${FLOOR_MINUTES}-minute minimum: ${money(RATE * FLOOR_MINUTES)}.`,
};

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
  good: '#12996B',
  goodInk: '#0C7A55',
  goodSoft: '#E7F6EF',
  goodLine: '#C6E9D9',
  warn: '#B25E09',
  warnSoft: '#FDF3E7',
  warnLine: '#F6E3CB',
  live: '#D6453D',
  star: '#F5A623',
  ink: '#0B0E13',
};
/* Room tokens, from balo-in-meeting-ui / waiting-state-patch. */
const R = {
  bg: '#0B0E13',
  stage: '#0F131C',
  line: 'rgba(255,255,255,0.08)',
  line2: 'rgba(255,255,255,0.14)',
  text: '#E8ECF3',
  sub: '#98A2B3',
  amber: '#E0A33E',
};

const CSS = `
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.balo-join{position:relative}
@keyframes pingSlow{0%{box-shadow:0 0 0 0 currentColor;opacity:.5}70%,100%{box-shadow:0 0 0 8px currentColor;opacity:0}}
.balo-join-live::before{content:'';position:absolute;inset:0;border-radius:inherit;pointer-events:none;color:#2563EB;animation:pingSlow 1.8s cubic-bezier(0,0,0.2,1) infinite}
.balo-join-quiet{box-shadow:0 0 0 2px #2563EB}
@keyframes toastIn{from{opacity:0;transform:translateY(-10px)}to{opacity:1;transform:none}}
.toast-in{animation:toastIn .28s cubic-bezier(.2,.8,.2,1)}
.balo-tap{transition:background-color .12s ease,border-color .12s ease}
.balo-tap:hover{background:#F7F8FA !important;border-color:#D8DCE3 !important}
.balo-text-btn:hover{background:rgba(37,99,235,.08)}
.balo-focus:focus-visible{outline:2px solid #2563EB;outline-offset:2px}
@media (prefers-reduced-motion: reduce){
  .balo-join-live::before{animation:none;content:none}
  .balo-join-live{box-shadow:0 0 0 2px #2563EB}
  .toast-in,.animate-spin{animation:none}
}
`;

/* ── prototype chrome ─────────────────────────────────────────────────────────────────────── */

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
            aria-pressed={a}
            onClick={() => onChange(o.value)}
            className="rounded-md px-2.5 py-1 text-xs font-medium"
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
      <span className="text-xs font-medium" style={{ color: '#8A93A3' }}>
        {label}
      </span>
      {children}
    </div>
  );
}

function Placeholder({ children }) {
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

/* ── shared pieces (stand-ins for shipped components) ─────────────────────────────────────── */

/** `JoinMeetingButton` stand-in. Shape never varies; `size` is the call site's height. */
function JoinButton({ label = 'Join', liveCue = true, size, onJoin, ariaLabel }) {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      onClick={onJoin}
      className={[
        'balo-join balo-focus inline-flex shrink-0 items-center gap-1.5 rounded-md font-medium whitespace-nowrap text-white',
        size === 'row' ? 'px-4 text-sm' : 'px-3 text-xs',
        liveCue ? 'balo-join-live' : 'balo-join-quiet',
      ].join(' ')}
      // Heights mirror the call sites: `min-h-11` in the nudge and Up next, `h-8` in the nav.
      style={{ background: C.brand, height: size === 'row' ? 44 : 32 }}
    >
      <span
        aria-hidden="true"
        className="rounded-full"
        style={{ width: 7, height: 7, background: '#34D399' }}
      />
      {label}
    </button>
  );
}

function Btn({ variant = 'outline', grow, children, ...rest }) {
  const styles = {
    primary: { background: C.brand, color: '#fff', border: `1px solid ${C.brand}` },
    outline: { background: '#fff', color: C.text, border: `1px solid ${C.line}` },
  };
  return (
    <button
      type="button"
      {...rest}
      className={`balo-focus ${variant === 'outline' ? 'balo-tap' : ''} inline-flex items-center justify-center gap-2 rounded-lg px-3.5 text-sm font-medium whitespace-nowrap`}
      style={{ height: 36, flex: grow ? '1 1 auto' : undefined, ...styles[variant] }}
    >
      {children}
    </button>
  );
}

function TextBtn({ children, ...rest }) {
  return (
    <button
      type="button"
      {...rest}
      className="balo-text-btn balo-focus rounded-lg px-2.5 text-sm font-medium"
      style={{ height: 32, color: C.brand }}
    >
      {children}
    </button>
  );
}

function Modal({ title, onClose, children }) {
  return (
    <div
      className="flex items-start justify-center p-4"
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 50,
        background: 'rgba(11,14,19,0.45)',
        paddingTop: 72,
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="call-dialog-title"
        className="w-full rounded-3xl px-5 py-4"
        style={{
          maxWidth: 440,
          background: C.card,
          border: `1px solid ${C.line}`,
          boxShadow: '0 1px 2px rgba(16,20,28,0.04), 0 24px 60px rgba(16,20,28,0.18)',
        }}
      >
        <div className="mb-3 flex items-start justify-between gap-3">
          <h2 id="call-dialog-title" className="text-base font-semibold" style={{ color: C.text }}>
            {title}
          </h2>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="balo-focus flex shrink-0 items-center justify-center rounded-lg"
            style={{ width: 28, height: 28, color: C.icon }}
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

const PILL_TONES = {
  good: { background: C.goodSoft, color: C.goodInk, border: `1px solid ${C.goodLine}` },
  brand: { background: C.brandSoft, color: C.brand, border: `1px solid ${C.brandLine}` },
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

function Card({ children, labelledBy }) {
  return (
    <section
      aria-labelledby={labelledBy}
      className="rounded-3xl px-5 py-4"
      style={{ background: C.card, border: `1px solid ${C.line}` }}
    >
      {children}
    </section>
  );
}

/* ── NEW: the confirm ─────────────────────────────────────────────────────────────────────── */

function InPlaceChoice({ checked, onChange }) {
  return (
    <label
      className="mt-3 flex items-start gap-2.5 rounded-xl px-3 py-2.5"
      style={{ border: `1px solid ${C.line}` }}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5"
        style={{ width: 16, height: 16, accentColor: C.brand }}
      />
      <span>
        <span className="block text-sm" style={{ color: C.text }}>
          {COPY.inPlace}
        </span>
        <span className="block text-xs" style={{ color: C.sub }}>
          {COPY.inPlaceHint}
        </span>
      </span>
    </label>
  );
}

function ConfirmBody({ who, online, booked, replace, setReplace, onCall, onClose }) {
  const n = other(who);
  if (who === 'expert') {
    return (
      <>
        <p className="text-sm leading-relaxed" style={{ color: C.sub }}>
          {COPY.expertConfirm(n)}
        </p>
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <Btn onClick={onClose}>{COPY.notNow}</Btn>
          <Btn variant="primary" onClick={onCall}>
            <Phone size={14} aria-hidden="true" /> {COPY.entry}
          </Btn>
        </div>
      </>
    );
  }
  return (
    <>
      <p className="text-sm leading-relaxed" style={{ color: C.text }}>
        {online ? COPY.clientOnline(n) : COPY.clientOffline(n)}
      </p>
      <p className="mt-2 text-sm leading-relaxed" style={{ color: C.sub }}>
        {COPY.clientTerms}
      </p>
      {booked && <InPlaceChoice checked={replace} onChange={setReplace} />}
      <div className="mt-5 flex flex-wrap justify-end gap-2">
        {online ? (
          <>
            <Btn onClick={onClose}>{COPY.notNow}</Btn>
            <Btn variant="primary" onClick={onCall}>
              <Phone size={14} aria-hidden="true" /> {COPY.entry}
            </Btn>
          </>
        ) : (
          <>
            <Btn onClick={onCall}>
              <Phone size={14} aria-hidden="true" /> {COPY.callAnyway}
            </Btn>
            <Btn variant="primary" onClick={onClose}>
              {COPY.bookInstead}
            </Btn>
          </>
        )}
      </div>
    </>
  );
}

/* ── the case nudge: the shipped live arm only (stand-in) ─────────────────────────────────── */

function Nudge({ icon: Icon, live, title, body, children }) {
  return (
    <section
      className="flex items-start gap-3 rounded-2xl px-4 py-3.5"
      style={{ background: C.brandSoft, border: `1px solid ${live ? C.brand : C.brandLine}` }}
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
        <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1">{children}</div>
      </div>
    </section>
  );
}

/* ── the rail party card: shipped, plus the Call now entry ────────────────────────────────── */

function PresenceLine({ presence }) {
  if (presence !== 'online') return null;
  return (
    <span className="inline-flex items-center gap-1.5 text-xs" style={{ color: C.goodInk }}>
      <span
        aria-hidden="true"
        className="rounded-full"
        style={{ width: 7, height: 7, background: C.good }}
      />
      Online
    </span>
  );
}

function CallEntry({ who, presence, disabled, onCall }) {
  const n = other(who);
  // The expert can always ring out on an open case; these gates apply to the client lens only.
  if (who === 'client') {
    if (presence === 'paused') return null; // absent, and no explanation: pausing is private
    if (presence === 'busy' || presence === 'late') {
      return (
        <p
          className="mt-3 border-t pt-3 text-center text-xs"
          style={{ borderColor: C.line2, color: C.sub }}
        >
          {presence === 'busy' ? COPY.busy(n) : COPY.lateNight(n)}
        </p>
      );
    }
  }
  if (disabled) return null;
  return (
    <div className="mt-3 border-t pt-3" style={{ borderColor: C.line2 }}>
      <button
        type="button"
        onClick={onCall}
        className="balo-tap balo-focus flex w-full items-center justify-center gap-2 rounded-xl py-2 text-xs font-medium"
        style={{ background: '#fff', border: `1px solid ${C.line}`, color: C.text }}
      >
        <Phone size={13} aria-hidden="true" /> {COPY.entry}
      </button>
    </div>
  );
}

function PartyCard({ who, presence, callBusy, onCall }) {
  if (who === 'client') {
    return (
      <Card>
        <div className="flex items-start gap-3">
          <span
            className="flex shrink-0 items-center justify-center rounded-full font-semibold"
            style={{ width: 44, height: 44, background: '#E9EDFB', color: '#3B4E86' }}
          >
            S
          </span>
          <div className="min-w-0">
            <div className="text-sm font-semibold" style={{ color: C.text }}>
              {EXPERT.full}
            </div>
            <div className="mt-0.5 text-xs leading-snug" style={{ color: C.faint }}>
              {EXPERT.title}
            </div>
            <div
              className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs"
              style={{ color: C.sub }}
            >
              <span className="inline-flex items-center gap-1">
                <Star size={12} color={C.star} fill={C.star} aria-hidden="true" />
                <span className="font-medium" style={{ color: C.text }}>
                  4.9
                </span>
              </span>
              {/* NEW — presence. "Online", never "available". */}
              <PresenceLine presence={presence} />
            </div>
          </div>
        </div>
        <div className="mt-4 flex flex-col gap-1.5">
          <span className="text-xs font-medium" style={{ color: C.sub }}>
            Book a time
          </span>
          {['Tue 22 Sept, 10:00 am', 'Tue 22 Sept, 2:30 pm', 'Wed 23 Sept, 9:00 am'].map((s) => (
            <span
              key={s}
              className="flex items-center justify-between rounded-xl px-3 py-2 text-xs font-medium"
              style={{ border: `1px solid ${C.line}`, color: C.text }}
            >
              {s}
              <ChevronRight size={13} color={C.faint} aria-hidden="true" />
            </span>
          ))}
        </div>
        <div className="mt-2.5 text-center text-xs" style={{ color: C.faint }}>
          {RATE_LINE}
        </div>
        {/* NEW — under the booking strip, never above it. */}
        <CallEntry who={who} presence={presence} disabled={callBusy} onCall={onCall} />
      </Card>
    );
  }
  return (
    <Card>
      <div className="flex items-start gap-3">
        <span
          className="flex shrink-0 items-center justify-center rounded-full font-semibold"
          style={{ width: 44, height: 44, background: '#F1EFE9', color: '#7A6A4A' }}
        >
          N
        </span>
        <div className="min-w-0">
          <div className="text-sm font-semibold" style={{ color: C.text }}>
            {CLIENT.company}
          </div>
          <div className="mt-0.5 text-xs" style={{ color: C.faint }}>
            {CLIENT.booker}
          </div>
        </div>
      </div>
      <CallEntry who={who} presence={presence} disabled={callBusy} onCall={onCall} />
    </Card>
  );
}

/* ── the Consultations card: shipped rows, plus the unscheduled-call dressing ─────────────── */

function Row({ row, last }) {
  const upcoming = row.state === 'scheduled';
  const Icon = upcoming ? CalendarClock : Video;
  return (
    <li
      className="flex items-start gap-3 py-3"
      style={{ borderBottom: last ? 'none' : `1px solid ${C.line2}` }}
    >
      <span
        aria-hidden="true"
        className="mt-0.5 flex shrink-0 items-center justify-center rounded-lg"
        style={{ width: 28, height: 28, background: C.brandTile }}
      >
        <Icon size={14} color={C.brand} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-sm font-medium" style={{ color: C.text }}>
            {row.label}
          </span>
          {row.minutes && (
            <span className="text-xs" style={{ color: C.sub }}>
              {row.minutes} min
            </span>
          )}
          <Pill {...row.pill} />
        </div>
        {row.state === 'held' && (
          <div className="mt-1.5">
            <span
              className="inline-flex items-center gap-1 text-xs font-medium"
              style={{ color: C.brand }}
            >
              View recap <ArrowRight size={11} aria-hidden="true" />
            </span>
          </div>
        )}
        {/* NEW — the only thing that marks a row as a call-now. No pill of its own, no money. */}
        {row.note && (
          <p className="mt-0.5 text-xs" style={{ color: C.sub }}>
            {row.note}
          </p>
        )}
      </div>
      {upcoming && (
        <span
          className="flex shrink-0 items-center justify-center rounded-lg"
          style={{ width: 32, height: 32, color: C.icon }}
          title="Row menu — consultation-row-actions, unchanged"
        >
          <MoreVertical size={16} aria-hidden="true" />
        </span>
      )}
    </li>
  );
}

/* ── NEW: the call toast — ONE surface for the callee, on every page ──────────────────────── */

/**
 * `ArrivalToast` shell, anchored under the bell. Two modes, one element:
 *   ringing — PERSISTENT for the ring window. No timeout, no close button: "Not now" is the
 *             dismissal, and it tells the caller.
 *   missed  — the same toast, in place, once the ring ends unanswered. STICKY until the person
 *             dismisses it, calls back, or opens the case. It is simply the unread `call`
 *             notification: so someone who was offline gets the identical toast on their next
 *             page load, with no special path. Never navigates on its own.
 */
function CallToast({
  who,
  mode,
  hasBooking,
  replace,
  setReplace,
  onJoin,
  onDecline,
  onCallBack,
  onDismiss,
}) {
  const n = other(who);
  const missed = mode === 'missed';
  const Icon = missed ? PhoneMissed : Phone;
  return (
    <div
      role={missed ? 'status' : 'alertdialog'}
      aria-label={missed ? COPY.missedTitle(n) : COPY.incomingTitle(n)}
      className="toast-in"
      style={{
        position: 'absolute',
        top: 64,
        right: 24,
        width: 360,
        maxWidth: 'calc(100% - 32px)',
        padding: 14,
        background: '#fff',
        border: '1px solid #E0E4EB',
        borderRadius: 14,
        boxShadow: '0 12px 32px rgba(17,24,39,0.10), 0 2px 6px rgba(17,24,39,0.06)',
        zIndex: 25,
      }}
    >
      {missed && (
        <button
          type="button"
          aria-label="Dismiss"
          onClick={onDismiss}
          className="balo-focus flex items-center justify-center rounded-lg"
          style={{
            position: 'absolute',
            top: 10,
            right: 10,
            width: 26,
            height: 26,
            color: '#9CA3AF',
          }}
        >
          <X size={14} aria-hidden="true" />
        </button>
      )}
      <div className="flex items-start gap-3">
        <span
          className="flex shrink-0 items-center justify-center"
          style={{
            width: 36,
            height: 36,
            borderRadius: 11,
            background: missed ? C.warnSoft : '#EFF6FF',
            border: `1px solid ${missed ? C.warnLine : '#2563EB26'}`,
          }}
        >
          <Icon size={17} color={missed ? C.warn : C.brand} aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1" style={{ paddingRight: missed ? 22 : 0 }}>
          <p className="text-sm font-semibold" style={{ color: '#111827' }}>
            {missed ? COPY.missedTitle(n) : COPY.incomingTitle(n)}
          </p>
          <p className="mt-1 text-xs leading-relaxed" style={{ color: '#4B5563' }}>
            {missed
              ? COPY.missedBody
              : `${COPY.incomingAbout}${who === 'client' ? ` ${COPY.clientTerms}` : ''}`}
          </p>
          {!missed && who === 'client' && hasBooking && (
            <InPlaceChoice checked={replace} onChange={setReplace} />
          )}
          <div className="mt-3 flex items-center gap-2">
            {missed ? (
              <Btn onClick={onCallBack}>
                <Phone size={14} aria-hidden="true" /> {COPY.callBack}
              </Btn>
            ) : (
              <>
                <JoinButton onJoin={onJoin} ariaLabel={`Join ${n}'s call`} />
                <TextBtn onClick={onDecline}>{COPY.notNow}</TextBtn>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** The dashboard shell: TopNav stand-in, the page, and the toast over it. */
function Shell({ who, crumb, ringing, onJoin, toast, children }) {
  const n = other(who);
  return (
    <div
      className="relative overflow-hidden rounded-2xl"
      style={{ border: `1px solid ${C.line}`, background: C.bg, minHeight: 420 }}
    >
      <header className="flex h-14 items-center gap-3 border-b border-slate-200 bg-white px-6">
        <span className="text-sm font-semibold text-slate-900">{crumb}</span>
        <div className="flex-1" />
        <span className="hidden h-9 w-44 items-center gap-2 rounded-md border border-slate-200 px-3 text-xs text-slate-400 md:flex">
          <Search size={14} aria-hidden="true" /> Search…
        </span>
        {/* The shipped pill, one new status string. Static ring while the toast is up. */}
        {ringing && (
          <div
            className="inline-flex h-10 items-center gap-3 rounded-lg border border-slate-200 bg-white pr-1 pl-3"
            style={{ maxWidth: 300 }}
          >
            <span className="block min-w-0 leading-tight">
              <span className="block truncate text-xs font-semibold text-slate-900">{n}</span>
              <span className="block truncate text-xs font-medium text-slate-500">
                {COPY.pillStatus}
              </span>
            </span>
            <JoinButton liveCue={false} onJoin={onJoin} ariaLabel={`Join ${n}'s call`} />
          </div>
        )}
        {who === 'client' && (
          <span className="hidden h-8 items-center gap-1.5 rounded-full border border-slate-200 px-3 text-xs font-semibold text-slate-700 sm:inline-flex">
            A$1,240 <span className="font-normal text-slate-500">credit</span>
          </span>
        )}
        <span className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-slate-200 text-slate-500">
          <Bell size={16} aria-hidden="true" />
        </span>
      </header>
      <main className="p-4">{children}</main>
      {toast}
    </div>
  );
}

/* ── NEW: `WaitingStage` variant for the caller ───────────────────────────────────────────── */

function Room({ who, outcome, sms, ringLeft, onStop, onBack }) {
  const n = other(who);
  const done = outcome !== null;
  const title = !done
    ? COPY.callingTitle(n)
    : outcome === 'declined'
      ? COPY.declinedTitle(n)
      : COPY.noAnswerTitle(n);
  let body;
  if (!done) body = who === 'client' ? COPY.callingClient(n, sms) : COPY.callingExpert(n);
  else body = who === 'client' ? COPY.noAnswerClient(n) : COPY.noAnswerExpert(n);
  const Icon = done ? CircleSlash : Loader2;
  return (
    <div
      className="flex flex-col overflow-hidden"
      style={{ height: 440, background: R.bg, borderRadius: 20, border: `1px solid ${R.line}` }}
    >
      <div
        className="flex shrink-0 items-center justify-between px-4"
        style={{ height: 52, borderBottom: `1px solid ${R.line}` }}
      >
        <span className="truncate text-sm font-semibold" style={{ color: R.text }}>
          {CASE_TITLE}
        </span>
        <span
          className="rounded-md px-2 py-0.5 text-xs"
          style={{ background: 'rgba(255,255,255,0.06)', color: R.sub }}
        >
          Not started
        </span>
      </div>
      <div className="min-h-0 flex-1 p-3">
        <div
          className="flex h-full w-full flex-col items-center justify-center gap-5 rounded-2xl px-6 text-center"
          style={{ background: R.stage }}
        >
          <div className="relative">
            <div
              className="flex items-center justify-center font-semibold"
              style={{
                width: 72,
                height: 72,
                borderRadius: 72,
                background: '#7C3AED',
                color: '#fff',
                fontSize: 26,
              }}
            >
              {n.slice(0, 1)}
            </div>
            <span
              className="absolute -right-1 -bottom-1 flex items-center justify-center rounded-full"
              style={{ width: 26, height: 26, background: R.stage }}
            >
              <Icon
                size={18}
                color={done ? R.amber : C.brand}
                className={done ? '' : 'animate-spin'}
                aria-hidden="true"
              />
            </span>
          </div>
          <div>
            <div className="text-lg font-semibold" style={{ color: R.text }} role="status">
              {title}
            </div>
            <div className="mt-1 text-sm leading-relaxed" style={{ color: R.sub, maxWidth: 360 }}>
              {body}
            </div>
            {/* A quiet fact, not a countdown: one line, no live region on the number. */}
            {!done && (
              <div className="mt-2 text-xs" style={{ color: R.sub }}>
                We’ll keep trying for {ringLeft} more seconds.
              </div>
            )}
          </div>
          <div className="flex flex-wrap justify-center gap-2">
            {!done && (
              <button
                type="button"
                onClick={onStop}
                className="balo-focus rounded-xl px-4 py-2.5 text-sm font-medium"
                style={{
                  background: 'rgba(255,255,255,0.06)',
                  color: R.text,
                  border: `1px solid ${R.line2}`,
                }}
              >
                {COPY.stop}
              </button>
            )}
            {done && who === 'client' && (
              <button
                type="button"
                onClick={onBack}
                className="balo-focus rounded-xl px-4 py-2.5 text-sm font-medium text-white"
                style={{ background: C.brand }}
              >
                {COPY.bookInstead}
              </button>
            )}
            {done && (
              <button
                type="button"
                onClick={onBack}
                className="balo-focus rounded-xl px-4 py-2.5 text-sm font-medium"
                style={{
                  background: 'rgba(255,255,255,0.06)',
                  color: R.text,
                  border: `1px solid ${R.line2}`,
                }}
              >
                {COPY.backToCase}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Where every Join lands. The in-meeting UI itself is `balo-in-meeting-ui`, unchanged. */
function LiveRoom({ who, onEnd, onStepOut }) {
  const n = other(who);
  return (
    <div
      className="flex flex-col overflow-hidden"
      style={{ height: 440, background: R.bg, borderRadius: 20, border: `1px solid ${R.line}` }}
    >
      <div
        className="flex shrink-0 items-center justify-between px-4"
        style={{ height: 52, borderBottom: `1px solid ${R.line}` }}
      >
        <span className="truncate text-sm font-semibold" style={{ color: R.text }}>
          {CASE_TITLE}
        </span>
        <span
          className="rounded-md px-2 py-0.5 text-xs"
          style={{ background: 'rgba(47,191,113,0.16)', color: '#2FBF71' }}
        >
          00:12
        </span>
      </div>
      <div className="min-h-0 flex-1 p-3">
        <div
          className="flex h-full w-full flex-col items-center justify-center gap-4 rounded-2xl px-6 text-center"
          style={{ background: R.stage, border: `1px dashed ${R.line2}` }}
        >
          <div className="text-sm leading-relaxed" style={{ color: R.sub, maxWidth: 420 }}>
            <strong style={{ color: R.text }}>In-meeting UI</strong> with {n} —
            `(call)/meetings/[meetingId]/call`, as shipped, not drawn. Join from the toast, the pill
            and the nudge all arrive here directly.
          </div>
          <div className="flex flex-wrap justify-center gap-2">
            <button
              type="button"
              onClick={onEnd}
              className="balo-focus rounded-xl px-4 py-2.5 text-sm font-medium text-white"
              style={{ background: '#D6453D' }}
            >
              End call
            </button>
            <button
              type="button"
              onClick={onStepOut}
              className="balo-focus rounded-xl px-4 py-2.5 text-sm font-medium"
              style={{
                background: 'rgba(255,255,255,0.06)',
                color: R.text,
                border: `1px solid ${R.line2}`,
              }}
            >
              Prototype: step out to the case
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── the page ─────────────────────────────────────────────────────────────────────────────── */

const HELD = [
  {
    id: 'm1',
    state: 'held',
    label: '3 Sept',
    minutes: 29,
    pill: { text: 'Completed', tone: 'good' },
  },
  {
    id: 'm2',
    state: 'held',
    label: '9 Sept',
    minutes: 57,
    pill: { text: 'Completed', tone: 'good' },
  },
];

/** `initial` deep-links a state: { who, caller, stage, page, presence, booked, credit }. */
export default function CallNowPrototype({ initial = {} }) {
  const [who, setWho] = useState(initial.who || 'client');
  const [caller, setCaller] = useState(initial.caller || 'client');
  // idle | ringing | live | unanswered | held
  const [stage, setStage] = useState(initial.stage || 'idle');
  const [outcome, setOutcome] = useState(null); // null | timeout | declined
  const [page, setPage] = useState(initial.page || 'case');
  const [presence, setPresence] = useState(initial.presence || 'online');
  const [booked, setBooked] = useState(initial.booked || 'yes');
  const [credit, setCredit] = useState(initial.credit || 'ok');
  const [replace, setReplace] = useState(true);
  const [dialog, setDialog] = useState(null); // null | confirm | fund
  const [missedSeen, setMissedSeen] = useState(false);
  // Join always lands in the call room. `inRoom` false = the person has stepped back out to the case.
  const [inRoom, setInRoom] = useState((initial.stage || 'idle') === 'live');
  const [ringLeft, setRingLeft] = useState(RING_SECONDS);

  const iCall = who === caller;
  const n = other(who);
  const hasBooking = booked === 'yes';
  const sms = caller === 'client' && presence !== 'online';
  const moved = hasBooking && replace && (stage === 'live' || stage === 'held');

  useEffect(() => {
    if (stage !== 'ringing') return undefined;
    if (ringLeft <= 0) {
      setOutcome('timeout');
      setStage('unanswered');
      return undefined;
    }
    const t = setTimeout(() => setRingLeft((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [stage, ringLeft]);

  const reset = () => {
    setStage('idle');
    setOutcome(null);
    setDialog(null);
    setMissedSeen(false);
    setReplace(true);
    setInRoom(false);
  };

  /** The credit gate only ever faces the client, and never when the booking's hold is reused. */
  const needsFunding = credit === 'short' && !(hasBooking && replace);

  const startRing = () => {
    setDialog(null);
    setMissedSeen(false);
    setOutcome(null);
    setRingLeft(sms ? RING_SECONDS_OFFLINE : RING_SECONDS);
    setStage('ringing');
  };
  const openConfirm = () => {
    setCaller(who);
    setDialog('confirm');
  };
  const confirmCall = () => {
    if (who === 'client' && needsFunding) setDialog('fund');
    else startRing();
  };
  /** Every Join (toast, pill, nudge) is `JoinMeetingButton`: straight to the call route. */
  const goLive = () => {
    setDialog(null);
    setInRoom(true);
    setStage('live');
  };
  const join = () => {
    if (who === 'client' && !iCall && needsFunding) setDialog('fund');
    else goLive();
  };
  const decline = () => {
    setOutcome('declined');
    setStage('unanswered');
  };

  const showLiveRoom = stage === 'live' && inRoom;
  const showRoom = showLiveRoom || (iCall && (stage === 'ringing' || stage === 'unanswered'));
  const ringingForMe = !iCall && stage === 'ringing';
  const missedForMe = !iCall && stage === 'unanswered' && outcome === 'timeout' && !missedSeen;
  // The callee can be on any page; the caller and everyone at rest are shown on the case.
  const elsewhere = (ringingForMe || missedForMe) && page === 'elsewhere';

  /* rows: newest last */
  const rows = [...HELD];
  if (stage === 'live') {
    rows.push({
      id: 'now',
      state: 'live',
      label: `Today at ${NOW_AT}`,
      pill: { text: 'Happening now', tone: 'brand' },
      note: moved ? COPY.rowNoteMoved : COPY.rowNote,
    });
  }
  if (stage === 'held') {
    rows.push({
      id: 'now',
      state: 'held',
      label: `Today at ${NOW_AT}`,
      minutes: 22,
      pill: { text: 'Completed', tone: 'good' },
      note: moved ? COPY.rowNoteMoved : COPY.rowNote,
    });
  }
  if (hasBooking && !moved) {
    rows.push({
      id: 'm4',
      state: 'scheduled',
      label: `Today at ${BOOKED_AT}`,
      minutes: 30,
      pill: { text: 'Upcoming', tone: 'plain' },
    });
  }

  /* nudge: NO new arms. The call is a meeting with an open join window, so the shipped live
     nudge shows its ordinary Join for it. While the toast is up, that Join's ring is static. */
  let nudge;
  if (stage === 'live') {
    nudge = (
      <Nudge
        icon={Video}
        live
        title={COPY.liveTitle(n)}
        body="Join from here if you’ve stepped out of the call room."
      >
        <JoinButton size="row" label="Join now" onJoin={() => setInRoom(true)} />
      </Nudge>
    );
  } else if (stage === 'ringing' && !iCall) {
    nudge = (
      <Placeholder>
        Live nudge, as shipped — “Join now” for this call, with a STATIC ring while the toast is up.
        Nothing call-specific is added to the nudge: the toast is the ring, here as on every other
        page.
      </Placeholder>
    );
  } else {
    nudge = (
      <Placeholder>
        {hasBooking
          ? `Upcoming nudge — unchanged, not drawn (“Next consultation · Today, ${BOOKED_AT}”, Join countdown, Reschedule).`
          : 'Nothing-booked nudge — unchanged, not drawn.'}
      </Placeholder>
    );
  }

  let explain = 'Idle. Call now sits in the rail, under the booking strip on the client lens.';
  if (stage === 'ringing') {
    explain = iCall
      ? 'The caller waits in the call room. Nothing is counted or charged; no no-show, no ops alert.'
      : 'The callee gets the same toast under the bell on every page, the case included. The pill and the nudge show their ordinary Join with a static ring.';
  } else if (stage === 'unanswered') {
    explain = iCall
      ? 'Unanswered. Nothing charged, no row, no recap. If a booking was to be replaced, it has not moved.'
      : outcome === 'declined'
        ? 'The callee chose “Not now”, so there is no missed-call toast.'
        : 'The same toast turns into “You missed a call” and stays until dismissed. Someone who was offline gets it on their next page load. No navigation, no row.';
  } else if (stage === 'live') {
    explain = inRoom
      ? 'Join lands here, in the call room, from the toast, the pill or the nudge alike — never on the case. From here it is an ordinary consultation, 15-minute minimum included.'
      : 'Stepped out mid-call: the case shows the shipped live nudge and a “Happening now” row. Join goes back to the room.';
  } else if (stage === 'held') {
    explain =
      'Completed. One row; if it replaced the booking, the note says so and the 4:00 pm row is gone.';
  }

  return (
    <div
      className="flex w-full flex-col items-center gap-4 p-4"
      style={{
        background: C.bg,
        minHeight: '100vh',
        fontFamily:
          "'Geist', ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
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
            onChange={setWho}
            options={[
              { value: 'client', label: 'Client' },
              { value: 'expert', label: 'Expert' },
            ]}
          />
        </Ctl>
        <Ctl label="Caller">
          <Seg
            value={caller}
            onChange={(v) => {
              setCaller(v);
              setDialog(null);
            }}
            options={[
              { value: 'client', label: 'Client' },
              { value: 'expert', label: 'Expert' },
            ]}
          />
        </Ctl>
        <Ctl label="Stage">
          <Seg
            value={stage}
            onChange={(v) => {
              setDialog(null);
              setMissedSeen(false);
              if (v === 'ringing') startRing();
              else {
                setOutcome(v === 'unanswered' ? 'timeout' : null);
                setInRoom(v === 'live');
                setStage(v);
              }
            }}
            options={[
              { value: 'idle', label: 'Idle' },
              { value: 'ringing', label: 'Ringing' },
              { value: 'unanswered', label: 'No answer' },
              { value: 'live', label: 'Connected' },
              { value: 'held', label: 'Completed' },
            ]}
          />
        </Ctl>
        <Ctl label="Callee is on">
          <Seg
            value={page}
            onChange={setPage}
            options={[
              { value: 'case', label: 'The case' },
              { value: 'elsewhere', label: 'Another page' },
            ]}
          />
        </Ctl>
        <Ctl label="Expert">
          <Seg
            value={presence}
            onChange={setPresence}
            options={[
              { value: 'online', label: 'Online' },
              { value: 'offline', label: 'Offline' },
              { value: 'busy', label: 'In a call' },
              { value: 'paused', label: 'Paused' },
              { value: 'late', label: '3 am' },
            ]}
          />
        </Ctl>
        <Ctl label="Booked today">
          <Seg
            value={booked}
            onChange={setBooked}
            options={[
              { value: 'yes', label: 'Yes' },
              { value: 'no', label: 'No' },
            ]}
          />
        </Ctl>
        <Ctl label="Client credit">
          <Seg
            value={credit}
            onChange={setCredit}
            options={[
              { value: 'ok', label: 'Enough' },
              { value: 'short', label: 'Short' },
            ]}
          />
        </Ctl>
        <button
          type="button"
          onClick={reset}
          className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium"
          style={{ color: '#9AA2B0' }}
        >
          <RotateCcw size={12} aria-hidden="true" /> Reset
        </button>
      </div>

      <div className="relative w-full" style={{ maxWidth: 1000 }}>
        {showLiveRoom && (
          <LiveRoom
            who={who}
            onEnd={() => {
              setInRoom(false);
              setStage('held');
            }}
            onStepOut={() => setInRoom(false)}
          />
        )}

        {showRoom && !showLiveRoom && (
          <Room
            who={who}
            outcome={stage === 'unanswered' ? outcome : null}
            sms={sms}
            ringLeft={ringLeft}
            onStop={reset}
            onBack={reset}
          />
        )}

        {!showRoom && (
          <Shell
            who={who}
            crumb={elsewhere ? 'Messages' : `Cases  ›  ${CASE_TITLE}`}
            ringing={ringingForMe}
            onJoin={join}
            toast={
              ringingForMe || missedForMe ? (
                <CallToast
                  who={who}
                  mode={ringingForMe ? 'ringing' : 'missed'}
                  hasBooking={hasBooking}
                  replace={replace}
                  setReplace={setReplace}
                  onJoin={join}
                  onDecline={decline}
                  onCallBack={openConfirm}
                  onDismiss={() => setMissedSeen(true)}
                />
              ) : null
            }
          >
            {elsewhere ? (
              <Placeholder>Any other dashboard page — unchanged, not drawn.</Placeholder>
            ) : (
              <div className="flex flex-wrap items-start gap-3">
                <div className="flex flex-col gap-3" style={{ flex: '1 1 420px', minWidth: 0 }}>
                  {nudge}
                  <Card labelledBy="call-consultations">
                    <div className="mb-2.5 flex items-center justify-between gap-3">
                      <div className="flex items-center gap-2">
                        <Clock size={15} color={C.sub} aria-hidden="true" />
                        <h2
                          id="call-consultations"
                          className="text-sm font-semibold"
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
                      {rows.map((row, i) => (
                        <Row key={row.id} row={row} last={i === rows.length - 1} />
                      ))}
                    </ul>
                  </Card>
                  <Placeholder>Conversation card — unchanged, not drawn.</Placeholder>
                </div>
                <div className="flex flex-col gap-3" style={{ flex: '0 1 288px', minWidth: 264 }}>
                  <PartyCard
                    who={who}
                    presence={presence}
                    callBusy={stage === 'ringing' || stage === 'live'}
                    onCall={openConfirm}
                  />
                  <Placeholder>Action items, Files, People — unchanged, not drawn.</Placeholder>
                </div>
              </div>
            )}
          </Shell>
        )}

        {dialog === 'confirm' && (
          <Modal title={COPY.confirmTitle(n)} onClose={() => setDialog(null)}>
            <ConfirmBody
              who={who}
              online={presence === 'online'}
              booked={hasBooking}
              replace={replace}
              setReplace={setReplace}
              onCall={confirmCall}
              onClose={() => setDialog(null)}
            />
          </Modal>
        )}

        {dialog === 'fund' && (
          <Modal title={COPY.fundTitle} onClose={() => setDialog(null)}>
            <p className="text-sm leading-relaxed" style={{ color: C.sub }}>
              {COPY.fundBody}
            </p>
            <div className="mt-3">
              <Placeholder>
                <strong>booking-inline-funding</strong>, as shipped — not drawn. On success it
                continues to {iCall ? 'the call room' : 'Join'} without another step.
              </Placeholder>
            </div>
            <div className="mt-5 flex flex-wrap justify-end gap-2">
              {hasBooking && (
                <Btn
                  onClick={() => {
                    setReplace(true);
                    if (iCall) startRing();
                    else goLive();
                  }}
                >
                  Use today’s {BOOKED_AT} consultation instead
                </Btn>
              )}
              <Btn
                variant="primary"
                onClick={() => {
                  setCredit('ok');
                  setDialog(null);
                  if (iCall) startRing();
                  else goLive();
                }}
              >
                Add credit and continue
              </Btn>
            </div>
          </Modal>
        )}
      </div>

      <p className="max-w-2xl text-center text-xs leading-relaxed" style={{ color: '#6E7888' }}>
        {explain}
      </p>
      {stage === 'ringing' && (
        <button
          type="button"
          onClick={() => setRingLeft(0)}
          className="rounded-md px-2 py-1 text-xs font-medium"
          style={{ color: C.brand }}
        >
          Prototype: skip to no answer
        </button>
      )}
    </div>
  );
}
