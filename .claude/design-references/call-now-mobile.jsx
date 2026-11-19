import React, { useState } from 'react';
import {
  ArrowRight,
  CalendarClock,
  ChevronDown,
  CircleSlash,
  Loader2,
  Phone,
  PhoneMissed,
  SlidersHorizontal,
  Star,
  Video,
  X,
} from 'lucide-react';

/**
 * Balo — Call now, MOBILE (design reference, v1)
 * File: `.claude/design-references/call-now-mobile.jsx`
 *
 * The phone layout for Call now (ADR-1058). A PATCH on `case-surface-mobile.jsx`, in the same way
 * `call-now.jsx` (v3) is a patch on the desktop case surface: anything the mobile case surface
 * already owns appears here as a dashed placeholder. Behaviour, rules, gates and money are
 * `call-now.jsx`'s header comment and are NOT restated here. This file only decides SHAPE.
 * Every string is `call-now.jsx`'s `COPY`; the few phone-only strings are marked NEW below.
 *
 * Covers BAL-651 (entry, confirm, calling state, rows) and BAL-653 (the call toast at phone width).
 *
 * ── THE FOUR PHONE DECISIONS ─────────────────────────────────────────────────────────────────
 *  1. ENTRY. The phone has no rail, so "Call now" lives in the party strip at the top of the
 *     scroll.
 *       · Client: an outline, icon-only phone button in the shipped expert strip, to the LEFT of
 *         the filled "Book" button. Book stays the filled, primary action. Icon-only because the
 *         strip cannot fit two labelled buttons and the expert's name; the accessible name is
 *         "Call {name} now".
 *       · Expert: the shipped mobile surface has NO strip on the expert lens. This adds one: the
 *         client company, the booker's name, and the same call button. Nothing else goes in it.
 *       · Presence is a dot on the expert's avatar plus the word "Online" in the meta line.
 *       · Absent beats dead: when Call now is unavailable the button is not rendered. `busy` and
 *         `outside_hours` get one quiet line under the strip; a paused expert gets nothing.
 *  2. CONFIRM is a bottom sheet (the shipped `balo-sheet` pattern from Details), not a centred
 *     dialog. Buttons are full-width and stacked, the filled one on top. Tapping the scrim or
 *     the close button is "Not now".
 *  3. CALLING is the call room's waiting stage at phone size: same content, actions full-width
 *     at the bottom of the stage. No new structure.
 *  4. THE CALL TOAST becomes a top banner, full width less the page gutter.
 *       · Ringing: a card with Join and "Not now" side by side, each 44px tall. Persistent for
 *         the ring window, no close button.
 *       · Missed: it COLLAPSES to a one-line bar — icon, "Missed call from {name}", "Call back",
 *         dismiss. Still sticky until dismissed, called back, or the case is opened. The desktop
 *         card would sit over the sticky case header indefinitely; one line does not.
 *       · While the banner is up the top-nav call pill is NOT rendered on a phone. There is no
 *         room for both, and the banner's Join is the one moving thing.
 *
 *  EVERY Join (banner, nudge) goes straight to the call route, never to the case.
 *
 * ── ALSO ─────────────────────────────────────────────────────────────────────────────────────
 *  · Consultation rows: the Call now note is one faint line under the date, where the shipped
 *    rows already put "Upcoming" and "Cancelled — nothing charged". No pill, no money.
 *  · The nudge gains nothing. A connected or ringing call shows the shipped "Join now" arm.
 *  · Funding: `booking-inline-funding`, as shipped, inside the same sheet. Not drawn.
 *  · Tap targets are 40px or more; Join and "Not now" are 44px.
 *  · Reduced motion: the ring and the sheet slide are dropped, as in the shipped file.
 *
 * ── ⚠ NOT VERIFIED ───────────────────────────────────────────────────────────────────────────
 *  · The mobile shell (`balo-nav-explorer.jsx`: bottom tabs, More sheet) was not read. The banner
 *    is drawn at the top of the viewport; where the bell lives on a phone, and whether the
 *    banner clears a top bar, must be checked against that reference.
 *  · The mobile in-meeting UI was not read. The calling stage assumes `WaitingStage` renders on
 *    a phone as it does on desktop.
 *
 * ── NEW COPY (MJ sign-off) ───────────────────────────────────────────────────────────────────
 *  · Accessible name on the entry button: "Call {name} now".
 *  · Missed bar, one line: "Missed call from {name}".
 */

const RATE = 6.25;
const FLOOR_MINUTES = 15;
const CASE_TITLE = 'Flow interview stuck on a loop';
const EXPERT = { first: 'Amara', full: 'Dr. Amara Okafor', initial: 'A', rating: 4.9, reviews: 23 };
const CLIENT = { company: 'Northwind Industrial', booker: 'Jordan Lee', initial: 'N' };
const BOOKED_AT = '4:00 pm';
const NOW_AT = '2:05 pm';

const money = (n) => `A$${n.toFixed(2)}`;
const RATE_LINE = `${money(RATE)}/min · ${FLOOR_MINUTES}-minute minimum`;
const other = (who) => (who === 'client' ? EXPERT.first : CLIENT.company);

/* Verbatim from call-now.jsx's COPY, except the two marked NEW. */
const COPY = {
  entryLabel: (n) => `Call ${n} now`, // NEW — accessible name only
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
  entry: 'Call now',
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
  noAnswerClient: (n) => `Nothing was charged. ${n} will see that you called.`,
  noAnswerExpert: (n) => `Nothing was counted or charged. ${n} will see that you called.`,
  backToCase: 'Back to the case',
  incomingTitle: (n) => `${n} is calling`,
  incomingAbout: `About ${CASE_TITLE}.`,
  missedBar: (n) => `Missed call from ${n}`, // NEW — the one-line phone form
  callBack: 'Call back',
  rowNote: 'Unscheduled call',
  rowNoteMoved: `Started early — was booked for ${BOOKED_AT}`,
};

const C = {
  bg: '#EEF0F3',
  card: '#FFFFFF',
  line: '#E6E8EC',
  line2: '#F0F1F4',
  text: '#171A1F',
  sub: '#5B6472',
  faint: '#9AA1AD',
  brand: '#2563EB',
  brandSoft: '#F6F8FE',
  brandLine: '#E3EBFB',
  good: '#12996B',
  goodSoft: '#E7F6EF',
  warn: '#B25E09',
  warnSoft: '#FDF3E7',
  warnLine: '#F6E3CB',
  live: '#D6453D',
  star: '#F5A623',
  ink: '#0B0E13',
};
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
@keyframes baloPulse { 0% { box-shadow: 0 0 0 0 rgba(37,99,235,0.40); } 70% { box-shadow: 0 0 0 9px rgba(37,99,235,0); } 100% { box-shadow: 0 0 0 0 rgba(37,99,235,0); } }
@keyframes baloSheet { from { transform: translateY(100%) } to { transform: translateY(0) } }
@keyframes baloBanner { from { opacity: 0; transform: translateY(-10px) } to { opacity: 1; transform: none } }
.balo-join { animation: baloPulse 2s ease-out infinite; }
.balo-sheet { animation: baloSheet .22s cubic-bezier(.32,.72,0,1); }
.balo-banner { animation: baloBanner .24s cubic-bezier(.2,.8,.2,1); }
.balo-focus:focus-visible { outline: 2px solid #2563EB; outline-offset: 2px; }
@media (prefers-reduced-motion: reduce) { .balo-join, .balo-sheet, .balo-banner, .animate-spin { animation: none; } }
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
            className="rounded-md px-2.5 py-1 text-xs font-medium whitespace-nowrap"
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
      className="rounded-2xl px-3.5 py-3 text-xs leading-relaxed"
      style={{ border: '1px dashed #C9D0DB', color: C.sub }}
    >
      {children}
    </div>
  );
}

function Card({ children, pad = 'px-4 py-3.5' }) {
  return (
    <div
      className={`rounded-2xl ${pad}`}
      style={{ background: C.card, border: `1px solid ${C.line}` }}
    >
      {children}
    </div>
  );
}

/* ── 1. ENTRY: the party strip ────────────────────────────────────────────────────────────── */

/** NEW. Outline, icon-only, 40px. Never rendered when Call now is unavailable. */
function CallButton({ who, onCall }) {
  return (
    <button
      type="button"
      aria-label={COPY.entryLabel(other(who))}
      onClick={onCall}
      className="balo-focus flex shrink-0 items-center justify-center rounded-xl"
      style={{
        width: 40,
        height: 40,
        background: '#fff',
        border: `1px solid ${C.line}`,
        color: C.text,
      }}
    >
      <Phone size={16} aria-hidden="true" />
    </button>
  );
}

function PartyStrip({ who, presence, canCall, onCall }) {
  const n = other(who);
  const client = who === 'client';
  const online = presence === 'online';
  // Client-lens gates only. An expert can always ring out on an open case.
  const quiet =
    client && presence === 'busy'
      ? COPY.busy(n)
      : client && presence === 'late'
        ? COPY.lateNight(n)
        : null;
  return (
    <Card pad="px-3.5 py-3">
      <div className="flex items-center gap-2.5">
        <span className="relative shrink-0">
          <span
            className="flex items-center justify-center rounded-full font-semibold"
            style={{
              width: 38,
              height: 38,
              fontSize: 16,
              background: client ? '#E9EDFB' : '#F1EFE9',
              color: client ? '#3B4E86' : '#7A6A4A',
            }}
          >
            {client ? EXPERT.initial : CLIENT.initial}
          </span>
          {/* NEW — presence dot. Client lens only; "Online" is also said in words below. */}
          {client && online && (
            <span
              aria-hidden="true"
              className="absolute rounded-full"
              style={{
                right: -1,
                bottom: -1,
                width: 11,
                height: 11,
                background: C.good,
                border: '2px solid #fff',
              }}
            />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold" style={{ color: C.text }}>
            {client ? EXPERT.full : CLIENT.company}
          </div>
          {client ? (
            <div
              className="mt-0.5 flex items-center gap-1 truncate text-xs"
              style={{ color: C.faint }}
            >
              <Star size={11} color={C.star} fill={C.star} aria-hidden="true" />
              <span className="font-medium" style={{ color: C.text }}>
                {EXPERT.rating}
              </span>
              <span className="truncate">
                · {money(RATE)}/min{online ? ' · Online' : ''}
              </span>
            </div>
          ) : (
            <div className="mt-0.5 truncate text-xs" style={{ color: C.faint }}>
              {CLIENT.booker}
            </div>
          )}
        </div>
        {canCall && <CallButton who={who} onCall={onCall} />}
        {client && (
          <span
            className="flex shrink-0 items-center gap-1 rounded-xl px-3 text-xs font-semibold text-white"
            style={{ height: 40, background: C.brand }}
          >
            Book <ChevronDown size={13} aria-hidden="true" />
          </span>
        )}
      </div>
      {quiet && (
        <p
          className="mt-2.5 border-t pt-2.5 text-xs"
          style={{ borderColor: C.line2, color: C.sub }}
        >
          {quiet}
        </p>
      )}
    </Card>
  );
}

/* ── 2. CONFIRM: a bottom sheet ───────────────────────────────────────────────────────────── */

function SheetBtn({ primary, children, ...rest }) {
  return (
    <button
      type="button"
      {...rest}
      className="balo-focus inline-flex w-full items-center justify-center gap-2 rounded-xl text-sm font-semibold"
      style={{
        height: 44,
        background: primary ? C.brand : '#fff',
        color: primary ? '#fff' : C.text,
        border: `1px solid ${primary ? C.brand : C.line}`,
      }}
    >
      {children}
    </button>
  );
}

function InPlaceChoice({ checked, onChange }) {
  return (
    <label
      className="flex items-start gap-3 rounded-xl px-3 py-3"
      style={{ border: `1px solid ${C.line}`, minHeight: 44 }}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5"
        style={{ width: 18, height: 18, accentColor: C.brand }}
      />
      <span>
        <span className="block text-sm leading-snug" style={{ color: C.text }}>
          {COPY.inPlace}
        </span>
        <span className="mt-0.5 block text-xs leading-snug" style={{ color: C.sub }}>
          {COPY.inPlaceHint}
        </span>
      </span>
    </label>
  );
}

function ConfirmSheet({ who, online, booked, replace, setReplace, onCall, onClose }) {
  const n = other(who);
  const client = who === 'client';
  return (
    <>
      <div
        className="absolute inset-0"
        style={{ background: 'rgba(11,14,19,0.35)', zIndex: 30 }}
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="call-sheet-title"
        className="balo-sheet absolute right-0 bottom-0 left-0 rounded-t-3xl px-4 pt-2.5 pb-6"
        style={{ background: C.card, zIndex: 31 }}
      >
        <div
          className="mx-auto mb-3 rounded-full"
          style={{ width: 36, height: 4, background: '#DDE1E6' }}
        />
        <div className="flex items-start justify-between gap-3">
          <h2 id="call-sheet-title" className="text-base font-semibold" style={{ color: C.text }}>
            {COPY.confirmTitle(n)}
          </h2>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="balo-focus flex shrink-0 items-center justify-center rounded-lg"
            style={{ width: 32, height: 32, color: C.faint }}
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>
        <p className="mt-2 text-sm leading-relaxed" style={{ color: client ? C.text : C.sub }}>
          {client ? (online ? COPY.clientOnline(n) : COPY.clientOffline(n)) : COPY.expertConfirm(n)}
        </p>
        {client && (
          <p className="mt-2 text-sm leading-relaxed" style={{ color: C.sub }}>
            {COPY.clientTerms}
          </p>
        )}
        {client && booked && (
          <div className="mt-3">
            <InPlaceChoice checked={replace} onChange={setReplace} />
          </div>
        )}
        {/* Stacked, full width, the filled one on top. Offline: booking is the filled one. */}
        <div className="mt-4 flex flex-col gap-2">
          {client && !online ? (
            <>
              <SheetBtn primary onClick={onClose}>
                {COPY.bookInstead}
              </SheetBtn>
              <SheetBtn onClick={onCall}>
                <Phone size={15} aria-hidden="true" /> {COPY.callAnyway}
              </SheetBtn>
            </>
          ) : (
            <>
              <SheetBtn primary onClick={onCall}>
                <Phone size={15} aria-hidden="true" /> {COPY.entry}
              </SheetBtn>
              <SheetBtn onClick={onClose}>{COPY.notNow}</SheetBtn>
            </>
          )}
        </div>
      </div>
    </>
  );
}

/* ── 3. CALLING: the waiting stage at phone size ──────────────────────────────────────────── */

function CallingScreen({ who, done, sms, onStop, onBack }) {
  const n = other(who);
  const client = who === 'client';
  const Icon = done ? CircleSlash : Loader2;
  const body = done
    ? client
      ? COPY.noAnswerClient(n)
      : COPY.noAnswerExpert(n)
    : client
      ? COPY.callingClient(n, sms)
      : COPY.callingExpert(n);
  const roomBtn = {
    height: 44,
    background: 'rgba(255,255,255,0.06)',
    color: R.text,
    border: `1px solid ${R.line2}`,
  };
  return (
    <div className="flex h-full flex-col" style={{ background: R.bg }}>
      <div
        className="flex shrink-0 items-center justify-between px-4"
        style={{ height: 52, borderBottom: `1px solid ${R.line}` }}
      >
        <span className="truncate text-sm font-semibold" style={{ color: R.text }}>
          {CASE_TITLE}
        </span>
        <span
          className="shrink-0 rounded-md px-2 py-0.5 text-xs"
          style={{ background: 'rgba(255,255,255,0.06)', color: R.sub }}
        >
          Not started
        </span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col p-3">
        <div
          className="flex flex-1 flex-col items-center justify-center gap-5 rounded-2xl px-6 text-center"
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
              className="absolute flex items-center justify-center rounded-full"
              style={{ right: -4, bottom: -4, width: 26, height: 26, background: R.stage }}
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
              {done ? COPY.noAnswerTitle(n) : COPY.callingTitle(n)}
            </div>
            <div className="mt-1 text-sm leading-relaxed" style={{ color: R.sub }}>
              {body}
            </div>
            {!done && (
              <div className="mt-2 text-xs" style={{ color: R.sub }}>
                We’ll keep trying for {sms ? 120 : 45} seconds.
              </div>
            )}
          </div>
        </div>
        {/* Actions sit full-width under the stage, in the thumb zone. */}
        <div className="mt-3 flex shrink-0 flex-col gap-2">
          {!done && (
            <button
              type="button"
              onClick={onStop}
              className="balo-focus w-full rounded-xl text-sm font-medium"
              style={roomBtn}
            >
              {COPY.stop}
            </button>
          )}
          {done && client && (
            <button
              type="button"
              onClick={onBack}
              className="balo-focus w-full rounded-xl text-sm font-semibold text-white"
              style={{ height: 44, background: C.brand }}
            >
              {COPY.bookInstead}
            </button>
          )}
          {done && (
            <button
              type="button"
              onClick={onBack}
              className="balo-focus w-full rounded-xl text-sm font-medium"
              style={roomBtn}
            >
              {COPY.backToCase}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** Where every Join lands. The in-meeting UI itself is shipped and not drawn. */
function LiveRoom({ who, onEnd, onStepOut }) {
  return (
    <div className="flex h-full flex-col" style={{ background: R.bg }}>
      <div
        className="flex shrink-0 items-center justify-between px-4"
        style={{ height: 52, borderBottom: `1px solid ${R.line}` }}
      >
        <span className="truncate text-sm font-semibold" style={{ color: R.text }}>
          {CASE_TITLE}
        </span>
        <span
          className="shrink-0 rounded-md px-2 py-0.5 text-xs"
          style={{ background: 'rgba(47,191,113,0.16)', color: '#2FBF71' }}
        >
          00:12
        </span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col p-3">
        <div
          className="flex flex-1 items-center justify-center rounded-2xl px-6 text-center text-sm leading-relaxed"
          style={{ background: R.stage, border: `1px dashed ${R.line2}`, color: R.sub }}
        >
          In-meeting UI with {other(who)} — as shipped, not drawn. Join from the banner and the
          nudge both arrive here directly.
        </div>
        <div className="mt-3 flex shrink-0 flex-col gap-2">
          <button
            type="button"
            onClick={onEnd}
            className="balo-focus w-full rounded-xl text-sm font-semibold text-white"
            style={{ height: 44, background: C.live }}
          >
            End call
          </button>
          <button
            type="button"
            onClick={onStepOut}
            className="balo-focus w-full rounded-xl text-sm font-medium"
            style={{
              height: 44,
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
  );
}

/* ── 4. THE CALL TOAST at phone width ─────────────────────────────────────────────────────── */

const BANNER = {
  position: 'absolute',
  top: 8,
  left: 8,
  right: 8,
  zIndex: 25,
  background: '#fff',
  border: '1px solid #E0E4EB',
  boxShadow: '0 12px 32px rgba(17,24,39,0.12), 0 2px 6px rgba(17,24,39,0.06)',
};

/** Ringing: a card. Persistent, no close button — "Not now" is the dismissal. */
function RingingBanner({ who, booked, replace, setReplace, onJoin, onDecline }) {
  const n = other(who);
  const client = who === 'client';
  return (
    <div
      role="alertdialog"
      aria-label={COPY.incomingTitle(n)}
      className="balo-banner"
      style={{ ...BANNER, borderRadius: 18, padding: 14 }}
    >
      <div className="flex items-start gap-3">
        <span
          className="flex shrink-0 items-center justify-center"
          style={{
            width: 36,
            height: 36,
            borderRadius: 11,
            background: '#EFF6FF',
            border: '1px solid #2563EB26',
          }}
        >
          <Phone size={17} color={C.brand} aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold" style={{ color: '#111827' }}>
            {COPY.incomingTitle(n)}
          </p>
          <p className="mt-1 text-xs leading-relaxed" style={{ color: '#4B5563' }}>
            {COPY.incomingAbout}
            {client ? ` ${COPY.clientTerms}` : ''}
          </p>
        </div>
      </div>
      {client && booked && (
        <div className="mt-3">
          <InPlaceChoice checked={replace} onChange={setReplace} />
        </div>
      )}
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={onDecline}
          className="balo-focus flex-1 rounded-xl text-sm font-medium"
          style={{ height: 44, background: '#fff', border: `1px solid ${C.line}`, color: C.text }}
        >
          {COPY.notNow}
        </button>
        <button
          type="button"
          onClick={onJoin}
          aria-label={`Join ${n}'s call`}
          className="balo-join balo-focus inline-flex flex-1 items-center justify-center gap-1.5 rounded-xl text-sm font-semibold text-white"
          style={{ height: 44, background: C.brand }}
        >
          <span
            aria-hidden="true"
            className="rounded-full"
            style={{ width: 7, height: 7, background: '#34D399' }}
          />
          Join
        </button>
      </div>
    </div>
  );
}

/** Missed: ONE line. Sticky until dismissed, called back, or the case is opened. */
function MissedBar({ who, onCallBack, onDismiss }) {
  const n = other(who);
  return (
    <div
      role="status"
      className="balo-banner flex items-center gap-2 pr-1 pl-3"
      style={{ ...BANNER, borderRadius: 14, height: 48 }}
    >
      <PhoneMissed size={15} color={C.warn} className="shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate text-sm font-medium" style={{ color: '#111827' }}>
        {COPY.missedBar(n)}
      </span>
      <button
        type="button"
        onClick={onCallBack}
        className="balo-focus shrink-0 rounded-lg px-2.5 text-sm font-semibold"
        style={{ height: 40, color: C.brand }}
      >
        {COPY.callBack}
      </button>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={onDismiss}
        className="balo-focus flex shrink-0 items-center justify-center rounded-lg"
        style={{ width: 40, height: 40, color: C.faint }}
      >
        <X size={15} aria-hidden="true" />
      </button>
    </div>
  );
}

/* ── consultation rows: shipped shape, plus the note line ─────────────────────────────────── */

function Row({ row, last }) {
  const scheduled = row.state === 'scheduled';
  const Icon = scheduled ? CalendarClock : Video;
  return (
    <div
      className="flex items-start gap-2.5 py-2.5"
      style={{ borderBottom: last ? 'none' : `1px solid ${C.line2}` }}
    >
      <span
        className="mt-0.5 flex shrink-0 items-center justify-center rounded-lg"
        style={{ width: 26, height: 26, background: scheduled ? C.warnSoft : C.brandSoft }}
      >
        <Icon size={13} color={scheduled ? C.warn : C.brand} aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-sm font-medium" style={{ color: C.text }}>
            {row.at}
          </span>
          {row.minutes ? (
            <span className="text-xs" style={{ color: C.sub }}>
              {row.minutes} min
            </span>
          ) : null}
        </div>
        {row.state === 'held' && (
          <div className="mt-1">
            <span
              className="inline-flex items-center gap-1 text-xs font-medium"
              style={{ color: C.brand }}
            >
              Recap <ArrowRight size={10} aria-hidden="true" />
            </span>
          </div>
        )}
        {scheduled && (
          <div className="text-xs" style={{ color: C.faint }}>
            Upcoming
          </div>
        )}
        {row.state === 'live' && (
          <div className="flex items-center gap-1.5 text-xs" style={{ color: C.sub }}>
            <span
              aria-hidden="true"
              className="rounded-full"
              style={{ width: 6, height: 6, background: C.live }}
            />
            Happening now
          </div>
        )}
        {/* NEW — the only thing that marks a row as a Call now. */}
        {row.note && (
          <div className="mt-0.5 text-xs" style={{ color: C.faint }}>
            {row.note}
          </div>
        )}
      </div>
    </div>
  );
}

/* ── the page ─────────────────────────────────────────────────────────────────────────────── */

/** `initial` deep-links a state: { who, caller, stage, presence, booked }. */
export default function CallNowMobile({ initial = {} }) {
  const [who, setWho] = useState(initial.who || 'client');
  const [caller, setCaller] = useState(initial.caller || 'client');
  // idle | ringing | unanswered | live | held
  const [stage, setStage] = useState(initial.stage || 'idle');
  const [presence, setPresence] = useState(initial.presence || 'online');
  const [booked, setBooked] = useState(initial.booked || 'yes');
  const [replace, setReplace] = useState(true);
  const [sheet, setSheet] = useState(false);
  const [missedSeen, setMissedSeen] = useState(false);
  // Every Join lands in the call room. false = stepped back out to the case mid-call.
  const [inRoom, setInRoom] = useState((initial.stage || 'idle') === 'live');

  const iCall = who === caller;
  const client = who === 'client';
  const hasBooking = booked === 'yes';
  const sms = caller === 'client' && presence !== 'online';
  const moved = hasBooking && replace && (stage === 'live' || stage === 'held');
  const busy = stage === 'ringing' || stage === 'live';
  const canCall = !busy && (!client || presence === 'online' || presence === 'offline');

  const go = (s) => {
    setSheet(false);
    setMissedSeen(false);
    setInRoom(s === 'live');
    setStage(s);
  };
  const openConfirm = () => {
    setCaller(who);
    setSheet(true);
  };

  const showLiveRoom = stage === 'live' && inRoom;
  const showCalling = iCall && (stage === 'ringing' || stage === 'unanswered');
  const ringingForMe = !iCall && stage === 'ringing';
  const missedForMe = !iCall && stage === 'unanswered' && !missedSeen;

  const rows = [
    { id: 'm1', at: '12 Jun', state: 'held', minutes: 15 },
    { id: 'm2', at: '19 Jul', state: 'held', minutes: 45 },
  ];
  if (stage === 'live')
    rows.push({
      id: 'now',
      at: `Today, ${NOW_AT}`,
      state: 'live',
      note: moved ? COPY.rowNoteMoved : COPY.rowNote,
    });
  if (stage === 'held')
    rows.push({
      id: 'now',
      at: `Today, ${NOW_AT}`,
      state: 'held',
      minutes: 22,
      note: moved ? COPY.rowNoteMoved : COPY.rowNote,
    });
  if (hasBooking && !moved) rows.push({ id: 'm4', at: `Today, ${BOOKED_AT}`, state: 'scheduled' });

  let explain =
    'The call button sits in the party strip, left of Book. Tap it for the confirm sheet.';
  if (showCalling)
    explain =
      stage === 'ringing'
        ? 'The caller waits in the call room. Actions are full-width under the stage.'
        : 'Unanswered: nothing charged, no row. Back to an ordinary case.';
  else if (ringingForMe)
    explain =
      'Incoming: a top banner with Join and “Not now”, 44px each. The top-nav pill is not shown on a phone while it is up.';
  else if (missedForMe)
    explain =
      'Missed: the banner collapses to one line and stays until dismissed, called back, or the case is opened.';
  else if (showLiveRoom)
    explain =
      'Join lands here, in the call room, from the banner or the nudge alike — never on the case.';
  else if (stage === 'live')
    explain =
      'Connected, and stepped back out to the case: the shipped “Join now” nudge and a “Happening now” row.';
  else if (stage === 'held')
    explain = 'Finished: one row with a faint note line. No pill, no money.';

  return (
    <div
      className="flex w-full flex-col items-center gap-3 p-4"
      style={{
        background: '#DFE2E7',
        minHeight: '100vh',
        fontFamily: "'Geist', ui-sans-serif, system-ui, -apple-system, sans-serif",
      }}
    >
      <style>{CSS}</style>

      <div
        className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2 rounded-xl px-3 py-2.5"
        style={{ background: C.ink, maxWidth: 760 }}
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
              setSheet(false);
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
            onChange={go}
            options={[
              { value: 'idle', label: 'Idle' },
              { value: 'ringing', label: 'Ringing' },
              { value: 'unanswered', label: 'No answer' },
              { value: 'live', label: 'Connected' },
              { value: 'held', label: 'Finished' },
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
      </div>

      {/* phone */}
      <div
        className="relative overflow-hidden"
        style={{
          width: 390,
          maxWidth: '100%',
          height: 780,
          background: C.bg,
          borderRadius: 38,
          border: '10px solid #16181D',
        }}
      >
        {showLiveRoom ? (
          <LiveRoom who={who} onEnd={() => go('held')} onStepOut={() => setInRoom(false)} />
        ) : showCalling ? (
          <CallingScreen
            who={who}
            done={stage === 'unanswered'}
            sms={sms}
            onStop={() => go('idle')}
            onBack={() => go('idle')}
          />
        ) : (
          <div className="h-full overflow-y-auto pb-6" style={{ scrollbarWidth: 'none' }}>
            {/* sticky compact header — shipped, drawn for position only */}
            <div
              className="sticky top-0 z-10 px-4 pt-3 pb-2.5"
              style={{ background: 'rgba(238,240,243,0.92)', backdropFilter: 'blur(8px)' }}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <h1
                    className="truncate text-base leading-snug font-semibold"
                    style={{ color: C.text }}
                  >
                    {CASE_TITLE}
                  </h1>
                  <div
                    className="mt-0.5 flex items-center gap-1.5 text-xs"
                    style={{ color: C.faint }}
                  >
                    <span
                      className="rounded-full px-2 py-0.5 font-medium"
                      style={{ background: C.goodSoft, color: C.good }}
                    >
                      Open
                    </span>
                    <span>2 completed · opened 12 Jun</span>
                  </div>
                </div>
                <span
                  className="flex shrink-0 items-center gap-1.5 rounded-xl px-2.5 py-2 text-xs font-medium"
                  style={{ background: '#fff', border: `1px solid ${C.line}`, color: C.text }}
                >
                  <SlidersHorizontal size={13} aria-hidden="true" /> Details
                </span>
              </div>
            </div>

            <div className="flex flex-col gap-2.5 px-4">
              <PartyStrip who={who} presence={presence} canCall={canCall} onCall={openConfirm} />

              {stage === 'live' ? (
                <div
                  className="flex items-start gap-2.5 rounded-2xl px-3.5 py-3"
                  style={{ background: C.brandSoft, border: `1px solid ${C.brand}` }}
                >
                  <Video size={16} color={C.brand} className="mt-0.5 shrink-0" aria-hidden="true" />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold" style={{ color: C.text }}>
                      Your call with {other(who)} is happening now
                    </div>
                    <div className="mt-2.5">
                      <button
                        type="button"
                        onClick={() => setInRoom(true)}
                        className="balo-join balo-focus inline-flex items-center rounded-lg px-3.5 text-xs font-semibold text-white"
                        style={{ height: 40, background: C.brand }}
                      >
                        Join now
                      </button>
                    </div>
                  </div>
                </div>
              ) : (
                <Placeholder>Nudge — as shipped. It gains nothing for Call now.</Placeholder>
              )}

              <Placeholder>Conversation card — as shipped, not drawn.</Placeholder>

              <Card>
                <div className="mb-1 flex items-baseline justify-between">
                  <h2 className="text-sm font-semibold" style={{ color: C.text }}>
                    Consultations
                  </h2>
                  <span className="text-xs" style={{ color: C.faint }}>
                    {rows.length}
                  </span>
                </div>
                {rows.map((row, i) => (
                  <Row key={row.id} row={row} last={i === rows.length - 1} />
                ))}
              </Card>
            </div>
          </div>
        )}

        {ringingForMe && (
          <RingingBanner
            who={who}
            booked={hasBooking}
            replace={replace}
            setReplace={setReplace}
            onJoin={() => go('live')}
            onDecline={() => {
              setMissedSeen(true);
              setStage('unanswered');
            }}
          />
        )}
        {missedForMe && (
          <MissedBar who={who} onCallBack={openConfirm} onDismiss={() => setMissedSeen(true)} />
        )}

        {sheet && (
          <ConfirmSheet
            who={who}
            online={presence === 'online'}
            booked={hasBooking}
            replace={replace}
            setReplace={setReplace}
            onCall={() => go('ringing')}
            onClose={() => setSheet(false)}
          />
        )}
      </div>

      <p className="max-w-md text-center text-xs leading-relaxed" style={{ color: '#6B7482' }}>
        {explain}
      </p>
    </div>
  );
}
