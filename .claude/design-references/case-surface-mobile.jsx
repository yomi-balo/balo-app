import React, { useState } from 'react';
import {
  Check,
  ArrowRight,
  UserPlus,
  CircleCheck,
  CircleSlash,
  Paperclip,
  Send,
  Sparkles,
  X,
  Video,
  CalendarClock,
  Star,
  ChevronUp,
  ChevronRight,
  ChevronDown,
  FileText,
  PlayCircle,
  Download,
  SlidersHorizontal,
} from 'lucide-react';

/**
 * Balo — Case surface, MOBILE (design reference)
 *
 * Companion to case-surface.jsx (desktop v6). Same model, different shape.
 *
 * WHY NOT A PERSISTENT BOTTOM SHEET:
 *  1. It collides with the composer. The conversation has a message input at the
 *     bottom; a peeking sheet and a text field fight for the same thumb zone, and
 *     the keyboard makes it worse. This is the failure mode of the pattern.
 *  2. It buries booking. On desktop the slots are visible with no interaction.
 *     Behind a sheet + a tab swipe, that is two gestures before a client can book
 *     — backwards for the primary action.
 *
 * WHAT IS HERE INSTEAD:
 *  - ONE scroll: header → expert strip (booking) → nudge → conversation →
 *    consultations. No internal scroll regions; on mobile they trap the page
 *    scroll, so the thread expands inline instead.
 *  - Action items / Files / People are REFERENCE, not flow — they move into a
 *    "Details" sheet opened deliberately from the header. Segmented tabs live
 *    INSIDE the sheet, which is fine once someone has committed to looking.
 *  - Booking stays out of the sheet as an always-visible strip: tap the strip for
 *    slots, tap a slot to land on confirm (BAL-252 quick-pick → BAL-400).
 *
 * Carried decisions: no empty state; no per-consultation cost in the row; client
 * closes and the expert only asks (BAL-417); resolved still books, as a NEW case.
 */

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

const CSS = `
@keyframes baloPulse {
  0%   { box-shadow: 0 0 0 0 rgba(37,99,235,0.40); }
  70%  { box-shadow: 0 0 0 9px rgba(37,99,235,0); }
  100% { box-shadow: 0 0 0 0 rgba(37,99,235,0); }
}
@keyframes baloDot { 0%,100% { opacity:1 } 50% { opacity:.35 } }
@keyframes baloSheet { from { transform: translateY(100%) } to { transform: translateY(0) } }
.balo-join { animation: baloPulse 2s ease-out infinite; }
.balo-dot { animation: baloDot 1.6s ease-in-out infinite; }
.balo-sheet { animation: baloSheet .22s cubic-bezier(.32,.72,0,1); }
@media (prefers-reduced-motion: reduce) {
  .balo-join, .balo-dot, .balo-sheet { animation: none; }
}
`;

const EXPERT = {
  name: 'Amara',
  full: 'Dr. Amara Okafor',
  agency: 'CloudPeak',
  initial: 'A',
  rating: 4.9,
  reviews: 23,
  rate: 6.25,
};
const CLIENT = { name: 'Jordan', company: 'Northwind Industrial', initial: 'J' };

const HELD = [
  { n: 1, at: '12 Jun', state: 'held', minutes: 12, floored: true, items: 2, rec: true, tx: true },
  { n: 2, at: '19 Jul', state: 'held', minutes: 45, items: 3, rec: true, tx: true, files: 2 },
  { n: 3, at: '24 Jul', state: 'cancelled' },
  { n: 4, at: '28 Jul', state: 'no_show', minutes: 15 },
];

const EARLIER = [
  {
    from: 'client',
    at: '12 Jun',
    body: 'Booked in for later today — error is in the case description.',
  },
  {
    from: 'expert',
    at: '12 Jun',
    body: 'Got it. Have the debug log open and we’ll trace it live.',
  },
];
const RECENT = [
  {
    from: 'expert',
    at: '13 Jun',
    body: 'Entry criteria is the culprit — it re-enters on its own update. Try the After-Save switch and send me the sandbox result.',
  },
  {
    from: 'client',
    at: '15 Jul',
    body: 'Still going. It survived the release but came back once the campaign flow was re-enabled.',
    attach: 'flow-debug-15jul.txt',
  },
  {
    from: 'client',
    at: '30 Jul',
    body: 'Sorry about Tuesday — got pulled into a release. Free this week?',
  },
];

const ACTION_ITEMS = [
  { text: 'Send the failing record’s debug log', party: 'client', done: true },
  { text: 'Switch the update to After-Save', party: 'client', done: false },
  { text: 'Confirm in the next deploy window', party: 'client', done: false },
  { text: 'Add entry criteria to stop re-entry', party: 'expert', done: true },
  { text: 'Share the Flow naming convention doc', party: 'expert', done: true },
  { text: 'Review the campaign flow interaction', party: null, done: false },
];

const FILES = [
  { name: 'flow-debug-15jul.txt', from: 'Conversation', size: '12 KB' },
  { name: 'entry-criteria.png', from: 'Consultation 2', size: '340 KB' },
  { name: 'naming-convention.pdf', from: 'Consultation 2', size: '1.1 MB' },
  { name: 'sandbox-result.csv', from: 'Consultation 1', size: '48 KB' },
];

const SLOTS = ['Tue 4 Aug, 09:00', 'Tue 4 Aug, 14:30', 'Wed 5 Aug, 11:00'];
const money = (n) => `A$${n.toFixed(2)}`;

function Seg({ options, value, onChange, dark }) {
  return (
    <div
      className="flex items-center gap-1 rounded-lg p-1"
      style={
        dark
          ? { background: '#0d1017', border: '1px solid rgba(255,255,255,0.08)' }
          : { background: '#F1F3F6' }
      }
    >
      {options.map((o) => {
        const a = o.value === value;
        return (
          <button
            key={o.value}
            onClick={() => onChange(o.value)}
            className="flex-1 rounded-md px-2.5 py-1 text-xs font-medium whitespace-nowrap"
            style={{
              background: a ? (dark ? C.brand : '#fff') : 'transparent',
              color: a ? (dark ? '#fff' : C.text) : dark ? '#9AA2B0' : C.sub,
              boxShadow: a && !dark ? '0 1px 2px rgba(16,20,28,0.10)' : 'none',
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function Avatar({ who, size = 26 }) {
  const e = who === 'expert';
  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-full font-semibold"
      style={{
        width: size,
        height: size,
        fontSize: size / 2.4,
        background: e ? '#E9EDFB' : '#F1EFE9',
        color: e ? '#3B4E86' : '#7A6A4A',
      }}
    >
      {e ? EXPERT.initial : CLIENT.initial}
    </span>
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

function Items({ label, items, muted }) {
  if (!items.length) return null;
  return (
    <div className="mb-4 last:mb-0">
      <div className="mb-2 text-xs font-medium" style={{ color: muted ? C.faint : C.sub }}>
        {label}
      </div>
      <div className="flex flex-col gap-2.5">
        {items.map((a, i) => (
          <div key={i} className="flex items-start gap-2.5">
            <span
              className="mt-0.5 flex shrink-0 items-center justify-center rounded"
              style={{
                width: 16,
                height: 16,
                background: a.done ? C.good : '#fff',
                border: a.done ? 'none' : `1.5px solid ${C.line}`,
              }}
            >
              {a.done && <Check size={10} color="#fff" strokeWidth={3.5} />}
            </span>
            <span
              className="text-sm leading-snug"
              style={{
                color: a.done ? C.faint : C.text,
                textDecoration: a.done ? 'line-through' : 'none',
              }}
            >
              {a.text}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function App() {
  const [lens, setLens] = useState('client');
  const [next, setNext] = useState('soon');
  const [sheet, setSheet] = useState(null);
  const [tab, setTab] = useState('items');
  const [expanded, setExpanded] = useState(false);
  const [slots, setSlots] = useState(false);
  const [asked, setAsked] = useState(true);

  const client = lens === 'client';
  const upcoming =
    next === 'none'
      ? null
      : {
          n: 5,
          at: next === 'soon' ? 'Today, 10:00' : 'Tue 4 Aug, 10:00',
          state: 'scheduled',
          soon: next === 'soon',
          proposal: next === 'proposed',
        };
  const consultations = upcoming ? [...HELD, upcoming] : HELD;
  const messages = expanded ? [...EARLIER, ...RECENT] : RECENT;
  const mine = client ? 'client' : 'expert';
  const theirs = client ? 'expert' : 'client';

  const nudge = (() => {
    if (upcoming && upcoming.proposal)
      return client
        ? {
            tone: 'warn',
            icon: CalendarClock,
            title: 'A new time is waiting on you',
            body: `${EXPERT.name} suggested three alternatives.`,
            slots: true,
          }
        : {
            tone: 'warn',
            icon: CalendarClock,
            title: `${CLIENT.name} hasn’t picked a time`,
            body: 'The original slot stays booked until they choose.',
            cta: 'Send a reminder',
            ghost: true,
          };
    if (upcoming && upcoming.soon)
      return {
        tone: 'brand',
        icon: Video,
        live: true,
        title: 'Starts in 8 minutes',
        body: client ? `${EXPERT.name} will join from here.` : `${CLIENT.name} is expecting you.`,
        cta: 'Join now',
        pulse: true,
      };
    if (upcoming)
      return {
        tone: 'brand',
        icon: CalendarClock,
        title: `Next · ${upcoming.at}`,
        body: client
          ? 'The join link is in your calendar. Nothing to do until then.'
          : `${CLIENT.name} is booked in.`,
        cta: 'Reschedule',
        ghost: true,
      };
    if (client && asked)
      return {
        tone: 'brand',
        icon: Sparkles,
        title: `${EXPERT.name} thinks this is sorted`,
        body: 'Closing wraps it up — you can always start a new one.',
        cta: 'Mark resolved',
        alt: 'Not yet',
      };
    return client
      ? {
          tone: 'brand',
          icon: Video,
          title: 'Nothing booked yet',
          body: `${EXPERT.name} has time this week.`,
          cta: 'Book a consultation',
        }
      : {
          tone: 'brand',
          icon: CalendarClock,
          title: 'Nothing booked',
          body: `${CLIENT.name} hasn’t booked a follow-up.`,
        };
  })();

  const warn = nudge?.tone === 'warn';
  const nBg = warn ? C.warnSoft : C.brandSoft;
  const nLine = warn ? C.warnLine : nudge?.live ? C.brand : C.brandLine;
  const nInk = warn ? C.warn : C.brand;

  return (
    <div
      className="flex w-full flex-col items-center gap-3 p-4"
      style={{
        background: '#DFE2E7',
        fontFamily: 'ui-sans-serif, system-ui, -apple-system, sans-serif',
      }}
    >
      <style>{CSS}</style>

      <div
        className="flex flex-wrap items-center justify-center gap-2 rounded-xl px-3 py-2.5"
        style={{ background: C.ink }}
      >
        <Seg
          dark
          value={lens}
          onChange={setLens}
          options={[
            { value: 'client', label: 'Client' },
            { value: 'expert', label: 'Expert' },
          ]}
        />
        <Seg
          dark
          value={next}
          onChange={setNext}
          options={[
            { value: 'booked', label: 'Booked' },
            { value: 'soon', label: 'Starting' },
            { value: 'proposed', label: 'New time' },
            { value: 'none', label: 'Nothing' },
          ]}
        />
      </div>

      {/* phone */}
      <div
        className="relative overflow-hidden"
        style={{
          width: 390,
          height: 780,
          background: C.bg,
          borderRadius: 38,
          border: `10px solid #16181D`,
          boxShadow: '0 24px 60px rgba(16,20,28,0.28)',
        }}
      >
        <div className="h-full overflow-y-auto pb-6" style={{ scrollbarWidth: 'none' }}>
          {/* sticky compact header */}
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
                  Flow interview stuck on a loop
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
                  <span>2 held · opened 12 Jun</span>
                </div>
              </div>
              <button
                onClick={() => setSheet('details')}
                className="flex shrink-0 items-center gap-1.5 rounded-xl px-2.5 py-2 text-xs font-medium"
                style={{ background: '#fff', border: `1px solid ${C.line}`, color: C.text }}
              >
                <SlidersHorizontal size={13} /> Details
              </button>
            </div>
          </div>

          <div className="flex flex-col gap-2.5 px-4">
            {/* booking strip — never behind a sheet */}
            {client && (
              <Card pad="px-3.5 py-3">
                <button
                  onClick={() => setSlots(!slots)}
                  className="flex w-full items-center gap-2.5 text-left"
                >
                  <Avatar who="expert" size={38} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-semibold" style={{ color: C.text }}>
                      {EXPERT.full}
                    </div>
                    <div
                      className="mt-0.5 flex items-center gap-1 text-xs"
                      style={{ color: C.faint }}
                    >
                      <Star size={11} color={C.star} fill={C.star} />
                      <span className="font-medium" style={{ color: C.text }}>
                        {EXPERT.rating}
                      </span>
                      <span>
                        ({EXPERT.reviews}) · {money(EXPERT.rate)}/min
                      </span>
                    </div>
                  </div>
                  <span
                    className="flex shrink-0 items-center gap-1 rounded-xl px-3 py-2 text-xs font-semibold text-white"
                    style={{ background: C.brand }}
                  >
                    Book {slots ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                  </span>
                </button>

                {slots && (
                  <div
                    className="mt-3 flex flex-col gap-1.5"
                    style={{ borderTop: `1px solid ${C.line2}`, paddingTop: 12 }}
                  >
                    {SLOTS.map((s) => (
                      <button
                        key={s}
                        className="flex items-center justify-between rounded-xl px-3 py-2.5 text-sm font-medium"
                        style={{ background: '#fff', border: `1px solid ${C.line}`, color: C.text }}
                      >
                        {s}
                        <ChevronRight size={14} color={C.faint} />
                      </button>
                    ))}
                    <button
                      className="mt-0.5 py-1.5 text-xs font-medium"
                      style={{ color: C.brand }}
                    >
                      See more times
                    </button>
                    <div className="text-center text-xs" style={{ color: C.faint }}>
                      15-minute minimum
                    </div>
                  </div>
                )}
              </Card>
            )}

            {/* nudge */}
            {nudge && (
              <div
                className="flex items-start gap-2.5 rounded-2xl px-3.5 py-3"
                style={{ background: nBg, border: `1px solid ${nLine}` }}
              >
                <nudge.icon size={16} color={nInk} className="mt-0.5 shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    {nudge.live && (
                      <span
                        className="balo-dot inline-block shrink-0 rounded-full"
                        style={{ width: 6, height: 6, background: C.live }}
                      />
                    )}
                    <div className="text-sm font-semibold" style={{ color: C.text }}>
                      {nudge.title}
                    </div>
                  </div>
                  <div className="mt-0.5 text-sm leading-snug" style={{ color: C.sub }}>
                    {nudge.body}
                  </div>

                  {nudge.slots && (
                    <div className="mt-2 flex flex-col gap-1.5">
                      {SLOTS.map((s) => (
                        <button
                          key={s}
                          className="rounded-lg px-3 py-2 text-left text-xs font-medium"
                          style={{
                            background: '#fff',
                            border: `1px solid ${C.warnLine}`,
                            color: C.text,
                          }}
                        >
                          {s}
                        </button>
                      ))}
                    </div>
                  )}
                  {nudge.cta && (
                    <div className="mt-2.5 flex items-center gap-2">
                      <button
                        className={`rounded-lg px-3.5 py-2 text-xs font-semibold ${nudge.pulse ? 'balo-join' : ''}`}
                        style={
                          nudge.ghost
                            ? { background: '#fff', border: `1px solid ${C.line}`, color: C.sub }
                            : { background: nInk, color: '#fff' }
                        }
                      >
                        {nudge.cta}
                      </button>
                      {nudge.alt && (
                        <button
                          onClick={() => setAsked(false)}
                          className="rounded-lg px-3 py-2 text-xs font-medium"
                          style={{
                            background: '#fff',
                            border: `1px solid ${C.line}`,
                            color: C.sub,
                          }}
                        >
                          {nudge.alt}
                        </button>
                      )}
                    </div>
                  )}
                </div>
                {nudge.alt && (
                  <button onClick={() => setAsked(false)} style={{ color: C.faint }}>
                    <X size={14} />
                  </button>
                )}
              </div>
            )}

            {/* conversation — expands inline, no scroll trap */}
            <Card>
              <div className="mb-2 flex items-baseline justify-between">
                <h2 className="text-sm font-semibold" style={{ color: C.text }}>
                  Conversation
                </h2>
                <span className="text-xs" style={{ color: C.faint }}>
                  Free
                </span>
              </div>
              {!expanded && (
                <button
                  onClick={() => setExpanded(true)}
                  className="mb-1 inline-flex items-center gap-1 text-xs font-medium"
                  style={{ color: C.brand }}
                >
                  <ChevronUp size={12} /> {EARLIER.length} earlier
                </button>
              )}
              <div style={{ borderTop: `1px solid ${C.line2}` }}>
                {messages.map((m, i) => {
                  const isMine = client ? m.from === 'client' : m.from === 'expert';
                  return (
                    <div key={i} className="flex gap-2.5 py-2.5">
                      <Avatar who={m.from} size={24} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline gap-1.5">
                          <span className="text-xs font-semibold" style={{ color: C.text }}>
                            {isMine ? 'You' : m.from === 'expert' ? EXPERT.name : CLIENT.name}
                          </span>
                          <span className="text-xs" style={{ color: C.faint }}>
                            {m.at}
                          </span>
                        </div>
                        <p className="mt-0.5 text-sm leading-relaxed" style={{ color: C.sub }}>
                          {m.body}
                        </p>
                        {m.attach && (
                          <div
                            className="mt-1.5 inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs"
                            style={{
                              background: '#F7F8FA',
                              border: `1px solid ${C.line}`,
                              color: C.sub,
                            }}
                          >
                            <Paperclip size={11} /> {m.attach}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
              <div
                className="mt-1.5 flex items-center gap-2 rounded-2xl px-3 py-2"
                style={{ background: '#FAFBFC', border: `1px solid ${C.line}` }}
              >
                <Paperclip size={15} color={C.faint} />
                <div className="flex-1 text-sm" style={{ color: C.faint }}>
                  Message {client ? EXPERT.name : CLIENT.name}…
                </div>
                <span
                  className="flex items-center justify-center rounded-lg"
                  style={{ width: 28, height: 28, background: C.brand, color: '#fff' }}
                >
                  <Send size={13} />
                </span>
              </div>
            </Card>

            {/* consultations */}
            <Card>
              <div className="mb-1 flex items-baseline justify-between">
                <h2 className="text-sm font-semibold" style={{ color: C.text }}>
                  Consultations
                </h2>
                <span className="text-xs" style={{ color: C.faint }}>
                  {consultations.length}
                </span>
              </div>
              {consultations.map((c, i) => {
                const cancelled = c.state === 'cancelled';
                const scheduled = c.state === 'scheduled';
                const Icon = cancelled ? CircleSlash : scheduled ? CalendarClock : Video;
                return (
                  <div
                    key={c.n}
                    className="flex items-start gap-2.5 py-2.5"
                    style={{
                      borderBottom:
                        i === consultations.length - 1 ? 'none' : `1px solid ${C.line2}`,
                    }}
                  >
                    <span
                      className="mt-0.5 flex shrink-0 items-center justify-center rounded-lg"
                      style={{
                        width: 26,
                        height: 26,
                        background: cancelled ? '#F4F5F7' : scheduled ? C.warnSoft : C.brandSoft,
                      }}
                    >
                      <Icon size={13} color={cancelled ? C.faint : scheduled ? C.warn : C.brand} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-baseline gap-x-2">
                        <span
                          className="text-sm font-medium"
                          style={{ color: cancelled ? C.faint : C.text }}
                        >
                          {c.at}
                        </span>
                        {c.minutes ? (
                          <span className="text-xs" style={{ color: C.sub }}>
                            {c.minutes} min
                          </span>
                        ) : null}
                      </div>
                      {c.state === 'held' && (
                        <div className="mt-1 flex flex-wrap items-center gap-2">
                          <span
                            className="inline-flex items-center gap-1 text-xs font-medium"
                            style={{ color: C.brand }}
                          >
                            Recap <ArrowRight size={10} />
                          </span>
                          {c.rec && <PlayCircle size={12} color={C.faint} />}
                          {c.tx && <FileText size={12} color={C.faint} />}
                          {c.items ? (
                            <span className="text-xs" style={{ color: C.faint }}>
                              {c.items} items
                            </span>
                          ) : null}
                        </div>
                      )}
                      {cancelled && (
                        <div className="text-xs" style={{ color: C.faint }}>
                          Cancelled — nothing charged
                        </div>
                      )}
                      {c.state === 'no_show' && (
                        <div className="text-xs" style={{ color: C.faint }}>
                          {client ? 'Billed at the minimum' : 'Settled at the minimum'}
                        </div>
                      )}
                      {scheduled && (
                        <div className="text-xs" style={{ color: C.faint }}>
                          Upcoming
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </Card>
          </div>
        </div>

        {/* details sheet */}
        {sheet && (
          <>
            <div
              className="absolute inset-0"
              style={{ background: 'rgba(11,14,19,0.35)' }}
              onClick={() => setSheet(null)}
            />
            <div
              className="balo-sheet absolute right-0 bottom-0 left-0 rounded-t-3xl px-4 pt-2.5 pb-6"
              style={{ background: C.card, maxHeight: '76%', overflowY: 'auto' }}
            >
              <div
                className="mx-auto mb-3 rounded-full"
                style={{ width: 36, height: 4, background: '#DDE1E6' }}
              />
              <Seg
                value={tab}
                onChange={setTab}
                options={[
                  { value: 'items', label: 'Action items' },
                  { value: 'files', label: 'Files' },
                  { value: 'people', label: 'People' },
                ]}
              />

              <div className="mt-4">
                {tab === 'items' && (
                  <>
                    <Items label="Yours" items={ACTION_ITEMS.filter((a) => a.party === mine)} />
                    <Items
                      label={`${client ? EXPERT.name : CLIENT.name}’s`}
                      items={ACTION_ITEMS.filter((a) => a.party === theirs)}
                    />
                    <Items
                      label="Unassigned"
                      muted
                      items={ACTION_ITEMS.filter((a) => a.party === null)}
                    />
                  </>
                )}

                {tab === 'files' && (
                  <div className="flex flex-col gap-1">
                    {FILES.map((f, i) => (
                      <button
                        key={i}
                        className="flex items-center gap-2.5 rounded-xl px-2 py-2.5 text-left"
                        style={{ border: `1px solid transparent` }}
                      >
                        <Paperclip size={14} color={C.faint} className="shrink-0" />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium" style={{ color: C.text }}>
                            {f.name}
                          </div>
                          <div className="text-xs" style={{ color: C.faint }}>
                            {f.from} · {f.size}
                          </div>
                        </div>
                        <Download size={15} color={C.sub} className="shrink-0" />
                      </button>
                    ))}
                  </div>
                )}

                {tab === 'people' && (
                  <div className="flex flex-col gap-3">
                    <div className="flex items-center gap-2.5">
                      <Avatar who={client ? 'client' : 'expert'} size={32} />
                      <div className="text-sm" style={{ color: C.text }}>
                        You
                      </div>
                    </div>
                    <div className="flex items-center gap-2.5">
                      <Avatar who={client ? 'expert' : 'client'} size={32} />
                      <div className="min-w-0">
                        <div className="text-sm" style={{ color: C.text }}>
                          {client ? EXPERT.full : CLIENT.name}
                        </div>
                        <div className="text-xs" style={{ color: C.faint }}>
                          {client ? EXPERT.agency : CLIENT.company}
                        </div>
                      </div>
                    </div>
                    <div className="text-xs leading-relaxed" style={{ color: C.faint }}>
                      Anyone invited sees this whole case, including past consultations.
                    </div>
                    <button
                      className="inline-flex items-center justify-center gap-2 rounded-xl py-2.5 text-sm font-medium"
                      style={{ background: '#fff', border: `1px solid ${C.line}`, color: C.text }}
                    >
                      <UserPlus size={14} /> Invite a colleague
                    </button>
                    {client && (
                      <button
                        className="inline-flex items-center justify-center gap-2 rounded-xl py-2.5 text-sm font-medium"
                        style={{ background: '#fff', border: `1px solid ${C.line}`, color: C.text }}
                      >
                        <CircleCheck size={14} /> Mark resolved
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </div>

      <p className="max-w-md text-center text-xs leading-relaxed" style={{ color: '#6B7482' }}>
        Prototype · case surface, mobile. Reference (items, files, people) is behind Details;
        booking stays on the page. Tap Details, or the expert strip for slots.
      </p>
    </div>
  );
}
