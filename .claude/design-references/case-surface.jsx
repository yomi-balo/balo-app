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
  Users,
  Star,
  MessageSquare,
  Clock,
  ChevronUp,
  ChevronRight,
  FileText,
  PlayCircle,
  Folder,
  Download,
} from 'lucide-react';

/**
 * Balo — Case surface (design reference, v6)
 *
 * A Case is an envelope for ad-hoc consultations on ONE issue (ADR-1045 §1).
 *
 * v6 changes:
 *  - JOIN BUTTON is brand blue with a pulse ring, NOT red. A red *dot* meaning
 *    "live" is a sound convention; a red *button* means destructive — and in Balo
 *    specifically, BAL-132's in-meeting UI already uses red for mic/camera-off and
 *    for Leave/End. A red Join would contradict the meaning it carries on the very
 *    next screen. The live dot stays red and small.
 *  - Conversation and Files are height-capped with internal scroll. An unbounded
 *    thread defeats the point of putting conversation first.
 *  - File rows are ACTIONS — presigned-GET downloads (BAL-423), hover reveals the
 *    download affordance.
 *  - Next-available slots are ACTIONS, not indicators. They are BAL-252's
 *    quick-pick entry point, ported into BAL-400: tapping opens the booking flow
 *    at the CONFIRM step, skipping the picker. From a case surface it is better
 *    still — the case already exists, so title/description are skipped and the
 *    attach is implied. Two taps to book.
 *    ⚠️ Slots can go stale between render and tap; confirm must re-validate
 *    (same soft-hold race BAL-411 handles).
 *  - Motion respects prefers-reduced-motion.
 *
 * Carried decisions:
 *  - NO empty state; a cancelled consultation is marked, never removed.
 *  - NO create-a-case flow — booking creates the case (BAL-400).
 *  - NO per-consultation cost in the row, and no running total on the client lens.
 *    Money lives on the recap (BAL-388/BAL-399), the receipt, and billing history.
 *  - "Mark resolved" is CLIENT-ONLY (BAL-417); the expert may only *ask*.
 *  - Resolved state still books — but that starts a NEW case, and says so.
 *
 * ⚠️ Messaging has NO schema, and a case-level Files view spans meeting files
 * (BAL-423) AND chat attachments (unbuilt). If those are built independently you
 * get two file models and this card becomes a merge. One file model, please.
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
@keyframes baloDot {
  0%, 100% { opacity: 1; }
  50%      { opacity: 0.35; }
}
.balo-join { animation: baloPulse 2s ease-out infinite; }
.balo-dot  { animation: baloDot 1.6s ease-in-out infinite; }
.balo-tap  { transition: background-color .12s ease, border-color .12s ease; }
.balo-tap:hover { background: #F7F8FA !important; border-color: #D8DCE3 !important; }
.balo-slot:hover { background: ${C.brandSoft} !important; border-color: ${C.brandLine} !important; }
.balo-file .balo-dl { opacity: 0; transition: opacity .12s ease; }
.balo-file:hover .balo-dl { opacity: 1; }
.balo-scroll { overflow-y: auto; overscroll-behavior: contain; }
.balo-scroll::-webkit-scrollbar { width: 8px; }
.balo-scroll::-webkit-scrollbar-thumb { background: #DFE3E8; border-radius: 99px; }
.balo-scroll::-webkit-scrollbar-track { background: transparent; }
@media (prefers-reduced-motion: reduce) {
  .balo-join, .balo-dot { animation: none; }
}
`;

const EXPERT = {
  name: 'Amara',
  full: 'Dr. Amara Okafor',
  agency: 'CloudPeak',
  initial: 'A',
  title: 'Salesforce Architect · Flow & Automation',
  rating: 4.9,
  reviews: 23,
  rate: 6.25,
};
const CLIENT = {
  name: 'Jordan',
  full: 'Jordan Lee',
  company: 'Northwind Industrial',
  initial: 'J',
};

const HELD = [
  {
    n: 1,
    at: '12 Jun',
    state: 'held',
    minutes: 12,
    floored: true,
    items: 2,
    rec: true,
    tx: true,
    files: 1,
  },
  { n: 2, at: '19 Jul', state: 'held', minutes: 45, items: 3, rec: true, tx: true, files: 2 },
  { n: 3, at: '24 Jul', state: 'cancelled' },
  { n: 4, at: '28 Jul', state: 'no_show', minutes: 15 },
];

const EARLIER = [
  {
    from: 'client',
    at: '12 Jun',
    body: 'Booked in for later today — I’ve pasted the error into the case description.',
  },
  {
    from: 'expert',
    at: '12 Jun',
    body: 'Got it. Have the debug log open when we start and we’ll trace it live.',
  },
  {
    from: 'client',
    at: '14 Jun',
    body: 'Tried the After-Save switch in sandbox. Better, but not gone.',
  },
];
const RECENT = [
  {
    from: 'expert',
    at: '13 Jun',
    body: 'Entry criteria is the culprit — it re-enters on its own update. Try the After-Save switch we talked through and send me the sandbox result.',
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
    body: 'Sorry about Tuesday — got pulled into a release. Free later this week?',
  },
];

/* assignee_party: 'client' | 'expert' | null (unassigned — where ai_extracted lands) */
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
  { name: 'flow-debug-13jun.txt', from: 'Conversation', size: '9 KB' },
  { name: 'org-metadata.xml', from: 'Consultation 1', size: '220 KB' },
];

const SLOTS = ['Tue 4 Aug, 09:00', 'Tue 4 Aug, 14:30', 'Wed 5 Aug, 11:00'];

const money = (n) => `A$${n.toFixed(2)}`;

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
      <span className="text-xs font-medium tracking-wide uppercase" style={{ color: '#5B6472' }}>
        {label}
      </span>
      {children}
    </div>
  );
}

function Card({ children }) {
  return (
    <div
      className="rounded-3xl px-5 py-4"
      style={{ background: C.card, border: `1px solid ${C.line}` }}
    >
      {children}
    </div>
  );
}

function SectionHead({ icon: Icon, title, meta }) {
  return (
    <div className="mb-2.5 flex items-baseline justify-between gap-3">
      <div className="flex items-center gap-2">
        <Icon size={15} color={C.sub} />
        <h2 className="text-sm font-semibold" style={{ color: C.text }}>
          {title}
        </h2>
      </div>
      {meta && (
        <span className="text-xs" style={{ color: C.faint }}>
          {meta}
        </span>
      )}
    </div>
  );
}

function Avatar({ who, size = 28 }) {
  const expert = who === 'expert';
  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-full font-semibold"
      style={{
        width: size,
        height: size,
        fontSize: size / 2.4,
        background: expert ? '#E9EDFB' : '#F1EFE9',
        color: expert ? '#3B4E86' : '#7A6A4A',
      }}
    >
      {expert ? EXPERT.initial : CLIENT.initial}
    </span>
  );
}

function Message({ m, client }) {
  const mine = client ? m.from === 'client' : m.from === 'expert';
  const who = m.from === 'expert' ? EXPERT : CLIENT;
  return (
    <div className="flex gap-2.5 py-2.5">
      <Avatar who={m.from} size={26} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-medium" style={{ color: C.text }}>
            {mine ? 'You' : who.name}
          </span>
          <span className="text-xs" style={{ color: C.faint }}>
            {m.at}
          </span>
        </div>
        <p className="mt-0.5 text-sm leading-relaxed" style={{ color: C.sub }}>
          {m.body}
        </p>
        {m.attach && (
          <button
            className="balo-tap mt-2 inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs"
            style={{ background: '#F7F8FA', border: `1px solid ${C.line}`, color: C.sub }}
          >
            <Paperclip size={12} /> {m.attach}
          </button>
        )}
      </div>
    </div>
  );
}

function Indicator({ icon: Icon, label }) {
  return (
    <span
      className="balo-tap inline-flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-0.5 text-xs"
      style={{ background: '#F5F6F8', color: C.sub, border: '1px solid transparent' }}
      title={label}
    >
      <Icon size={11} />
    </span>
  );
}

function ConsultationRow({ c, client, last }) {
  const cancelled = c.state === 'cancelled';
  const scheduled = c.state === 'scheduled';
  const noShow = c.state === 'no_show';
  const Icon = cancelled ? CircleSlash : scheduled ? CalendarClock : Video;
  const accent = cancelled ? C.faint : scheduled ? C.warn : C.brand;

  return (
    <div
      className="flex items-start gap-3 py-3"
      style={{ borderBottom: last ? 'none' : `1px solid ${C.line2}` }}
    >
      <span
        className="mt-0.5 flex shrink-0 items-center justify-center rounded-lg"
        style={{
          width: 28,
          height: 28,
          background: cancelled ? '#F4F5F7' : scheduled ? C.warnSoft : C.brandSoft,
        }}
      >
        <Icon size={14} color={accent} />
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-sm font-medium" style={{ color: cancelled ? C.faint : C.text }}>
            {c.at}
          </span>
          {c.minutes ? (
            <span className="text-xs" style={{ color: C.sub }}>
              {c.minutes} min
            </span>
          ) : null}
          {c.floored && (
            <span className="text-xs" style={{ color: C.faint }}>
              · 15-min minimum
            </span>
          )}
        </div>

        {c.state === 'held' && (
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <span
              className="inline-flex cursor-pointer items-center gap-1 text-xs font-medium"
              style={{ color: C.brand }}
            >
              View recap <ArrowRight size={11} />
            </span>
            <span className="flex items-center gap-1">
              {c.rec && <Indicator icon={PlayCircle} label="Recording" />}
              {c.tx && <Indicator icon={FileText} label="Transcript" />}
              {c.files ? <Indicator icon={Paperclip} label={`${c.files} files`} /> : null}
            </span>
            {c.items ? (
              <span className="text-xs" style={{ color: C.faint }}>
                {c.items} action items
              </span>
            ) : null}
          </div>
        )}
        {cancelled && (
          <div className="mt-0.5 text-xs" style={{ color: C.faint }}>
            Cancelled — nothing charged
          </div>
        )}
        {noShow && (
          <div className="mt-0.5 text-xs" style={{ color: C.faint }}>
            {client
              ? `${EXPERT.name} waited — billed at the minimum`
              : 'Client didn’t join — settled at the minimum'}
          </div>
        )}
        {scheduled && (
          <div className="mt-0.5 text-xs" style={{ color: C.faint }}>
            Upcoming · join link in your calendar
          </div>
        )}
      </div>
    </div>
  );
}

function ItemGroup({ label, items, muted }) {
  if (!items.length) return null;
  return (
    <div className="mb-3 last:mb-0">
      <div className="mb-1.5 text-xs font-medium" style={{ color: muted ? C.faint : C.sub }}>
        {label}
      </div>
      <div className="flex flex-col gap-1.5">
        {items.map((a, i) => (
          <div key={i} className="flex items-start gap-2">
            <span
              className="mt-0.5 flex shrink-0 items-center justify-center rounded"
              style={{
                width: 14,
                height: 14,
                background: a.done ? C.good : '#fff',
                border: a.done ? 'none' : `1.5px solid ${C.line}`,
              }}
            >
              {a.done && <Check size={9} color="#fff" strokeWidth={3.5} />}
            </span>
            <span
              className="text-xs leading-snug"
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
  const [state, setState] = useState('open');
  const [next, setNext] = useState('soon');
  const [asked, setAsked] = useState(true);
  const [expanded, setExpanded] = useState(false);

  const client = lens === 'client';
  const open = state === 'open';

  const upcoming =
    next === 'none'
      ? null
      : {
          n: 5,
          at: next === 'soon' ? 'Today, 10:00' : 'Tue 4 Aug, 10:00',
          state: 'scheduled',
          proposal: next === 'proposed',
          soon: next === 'soon',
        };
  const consultations = open && upcoming ? [...HELD, upcoming] : HELD;

  const mine = client ? 'client' : 'expert';
  const theirs = client ? 'expert' : 'client';
  const doneCount = ACTION_ITEMS.filter((a) => a.done).length;
  const messages = expanded ? [...EARLIER, ...RECENT] : RECENT;

  const nudge = (() => {
    if (!open) return null;

    if (upcoming && upcoming.proposal)
      return client
        ? {
            tone: 'warn',
            icon: CalendarClock,
            title: 'A new time is waiting on you',
            body: `${EXPERT.name} can’t make Tue 4 Aug and suggested three alternatives.`,
            slots: true,
          }
        : {
            tone: 'warn',
            icon: CalendarClock,
            title: `${CLIENT.name} hasn’t picked a new time yet`,
            body: 'The original slot stays booked until they choose.',
            cta: 'Send a reminder',
            ghost: true,
          };

    if (upcoming && upcoming.soon)
      return {
        tone: 'brand',
        icon: Video,
        live: true,
        title: 'Your consultation starts in 8 minutes',
        body: client
          ? `${EXPERT.name} will join from here. You can go in early — the timer starts when you’re both in.`
          : `${CLIENT.name} is expecting you. Their brief and the last recap are on this case.`,
        cta: 'Join now',
        pulse: true,
      };

    if (upcoming)
      return {
        tone: 'brand',
        icon: CalendarClock,
        title: `Next consultation · ${upcoming.at}`,
        body: client
          ? `Your call with ${EXPERT.name} is in 3 days. The join link is in your calendar and we’ll send a reminder — nothing to do until then.`
          : `${CLIENT.name} is booked in. Their brief and the last recap are on this case.`,
        cta: 'Reschedule',
        ghost: true,
      };

    if (client && asked)
      return {
        tone: 'brand',
        icon: Sparkles,
        title: `${EXPERT.name} thinks this one’s sorted`,
        body: 'If your issue is resolved, closing the case wraps it up — you can always start a new one.',
        cta: 'Yes, mark it resolved',
        alt: 'Not yet',
      };

    return client
      ? {
          tone: 'brand',
          icon: Video,
          title: 'Nothing booked yet',
          body: `Pick up where you left off — ${EXPERT.name} has time this week.`,
          cta: 'Book a consultation',
        }
      : {
          tone: 'brand',
          icon: MessageSquare,
          title: 'Nothing booked',
          body: `${CLIENT.name} hasn’t booked a follow-up. You can still reply on the case.`,
        };
  })();

  const warn = nudge?.tone === 'warn';
  const nudgeBg = warn ? C.warnSoft : C.brandSoft;
  const nudgeLine = warn ? C.warnLine : nudge?.live ? C.brand : C.brandLine;
  const nudgeInk = warn ? C.warn : C.brand;

  return (
    <div
      className="flex w-full flex-col items-center gap-4 p-4"
      style={{
        background: C.bg,
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
            value={lens}
            onChange={setLens}
            options={[
              { value: 'client', label: 'Client' },
              { value: 'expert', label: 'Expert' },
            ]}
          />
        </Ctl>
        <Ctl label="Case">
          <Seg
            value={state}
            onChange={setState}
            options={[
              { value: 'open', label: 'Open' },
              { value: 'resolved', label: 'Resolved' },
              { value: 'inactive', label: 'Auto-closed' },
            ]}
          />
        </Ctl>
        <Ctl label="Next">
          <Seg
            value={next}
            onChange={setNext}
            options={[
              { value: 'booked', label: 'Booked' },
              { value: 'soon', label: 'Starting' },
              { value: 'proposed', label: 'New time' },
              { value: 'none', label: 'Nothing' },
            ]}
          />
        </Ctl>
      </div>

      <div className="w-full" style={{ maxWidth: 1060 }}>
        {/* ── header ───────────────────────────────────────── */}
        <div
          className="rounded-3xl px-6 py-5"
          style={{
            background: C.card,
            border: `1px solid ${C.line}`,
            boxShadow: '0 1px 2px rgba(16,20,28,0.04), 0 12px 40px rgba(16,20,28,0.06)',
          }}
        >
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <h1 className="text-xl leading-snug font-semibold" style={{ color: C.text }}>
                Flow interview stuck on a record-triggered loop
              </h1>
              <div
                className="mt-1.5 flex flex-wrap items-center gap-x-2 text-xs"
                style={{ color: C.faint }}
              >
                <span>Opened 12 Jun</span>
                <span>·</span>
                <span>2 consultations held</span>
                <span>·</span>
                <span>{client ? EXPERT.agency : CLIENT.company}</span>
              </div>
            </div>
            <span
              className="shrink-0 rounded-full px-3 py-1 text-xs font-medium whitespace-nowrap"
              style={{ background: open ? C.goodSoft : '#EEF1F5', color: open ? C.good : C.sub }}
            >
              {open ? 'Open' : state === 'resolved' ? 'Resolved' : 'Closed — inactive'}
            </span>
          </div>

          <p className="mt-3 max-w-2xl text-sm leading-relaxed" style={{ color: C.sub }}>
            Our lead-conversion Flow fires a record-triggered update that re-enters itself on save,
            so the interview hangs and the record locks. Started after the summer release; needs to
            be stable before the September campaign.
          </p>

          {nudge && (
            <div
              className="mt-4 flex items-start gap-3 rounded-2xl px-4 py-3.5"
              style={{ background: nudgeBg, border: `1px solid ${nudgeLine}` }}
            >
              <nudge.icon size={17} color={nudgeInk} className="mt-0.5 shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  {nudge.live && (
                    <span
                      className="balo-dot inline-block shrink-0 rounded-full"
                      style={{ width: 7, height: 7, background: C.live }}
                    />
                  )}
                  <div className="text-sm font-semibold" style={{ color: C.text }}>
                    {nudge.title}
                  </div>
                </div>
                <div className="mt-0.5 text-sm leading-relaxed" style={{ color: C.sub }}>
                  {nudge.body}
                </div>

                {nudge.slots && (
                  <div className="mt-2.5 flex flex-wrap gap-1.5">
                    {SLOTS.map((s) => (
                      <button
                        key={s}
                        className="balo-tap rounded-lg px-2.5 py-1.5 text-xs font-medium"
                        style={{
                          background: '#fff',
                          border: `1px solid ${C.warnLine}`,
                          color: C.text,
                        }}
                      >
                        {s}
                      </button>
                    ))}
                    <button className="px-1.5 text-xs" style={{ color: C.sub }}>
                      Keep original
                    </button>
                  </div>
                )}

                {nudge.cta && (
                  <div className="mt-2.5 flex flex-wrap items-center gap-2">
                    <button
                      className={`rounded-lg px-3.5 py-2 text-xs font-semibold ${nudge.pulse ? 'balo-join' : ''}`}
                      style={
                        nudge.ghost
                          ? { background: '#fff', border: `1px solid ${C.line}`, color: C.sub }
                          : { background: nudgeInk, color: '#fff' }
                      }
                    >
                      {nudge.cta}
                    </button>
                    {nudge.alt && (
                      <button
                        onClick={() => setAsked(false)}
                        className="rounded-lg px-3 py-1.5 text-xs font-medium"
                        style={{ background: '#fff', border: `1px solid ${C.line}`, color: C.sub }}
                      >
                        {nudge.alt}
                      </button>
                    )}
                  </div>
                )}
              </div>
              {nudge.alt && (
                <button
                  onClick={() => setAsked(false)}
                  className="shrink-0"
                  style={{ color: C.faint }}
                >
                  <X size={15} />
                </button>
              )}
            </div>
          )}

          {!open && (
            <div
              className="mt-4 flex items-start gap-2.5 rounded-2xl px-4 py-3"
              style={{ background: '#F4F5F7', border: `1px solid ${C.line}` }}
            >
              <CircleCheck size={16} color={C.sub} className="mt-0.5 shrink-0" />
              <span className="text-sm" style={{ color: C.sub }}>
                {state === 'resolved'
                  ? 'Marked resolved on 30 Jul. Everything here stays available.'
                  : 'Closed automatically after 30 days without activity. Everything stays available.'}
              </span>
            </div>
          )}
        </div>

        {/* ── two columns, by wrap not breakpoint ──────────── */}
        <div className="mt-3 flex flex-wrap items-start gap-3">
          <div className="flex flex-col gap-3" style={{ flex: '1 1 420px', minWidth: 0 }}>
            <Card>
              <SectionHead icon={MessageSquare} title="Conversation" meta="Free — between calls" />

              {!expanded && (
                <button
                  onClick={() => setExpanded(true)}
                  className="mb-1 inline-flex items-center gap-1.5 text-xs font-medium"
                  style={{ color: C.brand }}
                >
                  <ChevronUp size={12} /> Show {EARLIER.length} earlier messages
                </button>
              )}

              <div
                className="balo-scroll"
                style={{ borderTop: `1px solid ${C.line2}`, maxHeight: 340 }}
              >
                {expanded && (
                  <div className="py-3 text-center text-xs" style={{ color: C.faint }}>
                    — start of the conversation —
                  </div>
                )}
                {messages.map((m, i) => (
                  <Message key={i} m={m} client={client} />
                ))}
              </div>

              {open ? (
                <div className="mt-2">
                  <div
                    className="flex items-end gap-2 rounded-2xl px-3 py-2.5"
                    style={{ background: '#FAFBFC', border: `1px solid ${C.line}` }}
                  >
                    <button style={{ color: C.faint }} className="pb-1">
                      <Paperclip size={16} />
                    </button>
                    <div className="flex-1 py-1 text-sm" style={{ color: C.faint }}>
                      {client ? `Ask ${EXPERT.name} something…` : `Reply to ${CLIENT.name}…`}
                    </div>
                    <button
                      className="flex items-center justify-center rounded-xl"
                      style={{ width: 32, height: 32, background: C.brand, color: '#fff' }}
                    >
                      <Send size={14} />
                    </button>
                  </div>
                  <div className="mt-2 text-xs" style={{ color: C.faint }}>
                    {client
                      ? 'Messages are free. Book a consultation when you need time on a call.'
                      : 'Messages are free and unbilled — only consultations are.'}
                  </div>
                </div>
              ) : (
                <div className="mt-3 text-xs" style={{ color: C.faint }}>
                  This case is closed, so the conversation is read-only.
                </div>
              )}
            </Card>

            <Card>
              <SectionHead
                icon={Clock}
                title="Consultations"
                meta={`${consultations.length} · newest last`}
              />
              {consultations.map((c, i) => (
                <ConsultationRow
                  key={c.n}
                  c={c}
                  client={client}
                  last={i === consultations.length - 1}
                />
              ))}
            </Card>
          </div>

          {/* ── rail ─────────────────────────────────────── */}
          <div className="flex flex-col gap-3" style={{ flex: '0 1 288px', minWidth: 264 }}>
            {client ? (
              <Card>
                <div className="flex items-start gap-3">
                  <Avatar who="expert" size={44} />
                  <div className="min-w-0">
                    <div className="text-sm font-semibold" style={{ color: C.text }}>
                      {EXPERT.full}
                    </div>
                    <div className="mt-0.5 text-xs leading-snug" style={{ color: C.faint }}>
                      {EXPERT.title}
                    </div>
                    <div
                      className="mt-1.5 flex items-center gap-1 text-xs"
                      style={{ color: C.sub }}
                    >
                      <Star size={12} color={C.star} fill={C.star} />
                      <span className="font-medium" style={{ color: C.text }}>
                        {EXPERT.rating}
                      </span>
                      <span style={{ color: C.faint }}>({EXPERT.reviews})</span>
                      <span style={{ color: C.faint }}>· {EXPERT.agency}</span>
                    </div>
                  </div>
                </div>

                {open ? (
                  <>
                    <div className="mt-4 flex flex-col gap-1.5">
                      <span className="text-xs font-medium" style={{ color: C.sub }}>
                        Book a time
                      </span>
                      {SLOTS.map((s) => (
                        <button
                          key={s}
                          className="balo-slot flex items-center justify-between rounded-xl px-3 py-2 text-left text-xs font-medium"
                          style={{
                            background: '#fff',
                            border: `1px solid ${C.line}`,
                            color: C.text,
                          }}
                        >
                          {s}
                          <ChevronRight size={13} color={C.faint} />
                        </button>
                      ))}
                    </div>
                    <button
                      className="balo-tap mt-2 w-full rounded-xl py-2 text-xs font-medium"
                      style={{ background: '#fff', border: `1px solid ${C.line}`, color: C.sub }}
                    >
                      See more times
                    </button>
                    <div className="mt-2.5 text-center text-xs" style={{ color: C.faint }}>
                      {money(EXPERT.rate)}/min · 15-minute minimum
                    </div>
                  </>
                ) : (
                  <>
                    <button
                      className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl py-2.5 text-sm font-semibold text-white"
                      style={{ background: C.brand }}
                    >
                      <Video size={15} /> Book with {EXPERT.name} again
                    </button>
                    <div
                      className="mt-2 text-center text-xs leading-relaxed"
                      style={{ color: C.faint }}
                    >
                      Starts a new case — this one stays as it is.
                    </div>
                  </>
                )}
              </Card>
            ) : (
              <Card>
                <div className="flex items-start gap-3">
                  <Avatar who="client" size={44} />
                  <div className="min-w-0">
                    <div className="text-sm font-semibold" style={{ color: C.text }}>
                      {CLIENT.full}
                    </div>
                    <div className="mt-0.5 text-xs" style={{ color: C.faint }}>
                      {CLIENT.company}
                    </div>
                  </div>
                </div>
                <div
                  className="mt-3.5 flex items-baseline justify-between border-t pt-3"
                  style={{ borderColor: C.line2 }}
                >
                  <span className="text-xs" style={{ color: C.faint }}>
                    Earned on this case
                  </span>
                  <span className="text-sm font-semibold" style={{ color: C.text }}>
                    {money(375)}
                  </span>
                </div>
              </Card>
            )}

            <Card>
              <SectionHead
                icon={CircleCheck}
                title="Action items"
                meta={`${doneCount}/${ACTION_ITEMS.length}`}
              />
              <ItemGroup label="Yours" items={ACTION_ITEMS.filter((a) => a.party === mine)} />
              <ItemGroup
                label={`${client ? EXPERT.name : CLIENT.name}’s`}
                items={ACTION_ITEMS.filter((a) => a.party === theirs)}
              />
              <ItemGroup
                label="Unassigned"
                muted
                items={ACTION_ITEMS.filter((a) => a.party === null)}
              />
            </Card>

            <Card>
              <SectionHead icon={Folder} title="Files" meta={`${FILES.length}`} />
              <div className="balo-scroll -mx-1.5" style={{ maxHeight: 168 }}>
                {FILES.map((f, i) => (
                  <button
                    key={i}
                    className="balo-file balo-tap flex w-full items-center gap-2 rounded-lg px-1.5 py-1.5 text-left"
                    style={{ border: '1px solid transparent' }}
                  >
                    <Paperclip size={12} color={C.faint} className="shrink-0" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-xs font-medium" style={{ color: C.text }}>
                        {f.name}
                      </div>
                      <div className="text-xs" style={{ color: C.faint }}>
                        {f.from} · {f.size}
                      </div>
                    </div>
                    <Download size={13} color={C.sub} className="balo-dl shrink-0" />
                  </button>
                ))}
              </div>
            </Card>

            <Card>
              <SectionHead icon={Users} title="People" />
              <div className="text-xs leading-relaxed" style={{ color: C.sub }}>
                {client ? `You · ${EXPERT.name}` : `You · ${CLIENT.name}`}
                <div className="mt-1" style={{ color: C.faint }}>
                  Anyone invited sees this whole case, including past consultations.
                </div>
              </div>
              {open && (
                <div className="mt-3 flex flex-col gap-2">
                  <button
                    className="balo-tap inline-flex items-center justify-center gap-2 rounded-xl py-2 text-xs font-medium"
                    style={{ background: '#fff', border: `1px solid ${C.line}`, color: C.text }}
                  >
                    <UserPlus size={13} /> Invite a colleague
                  </button>
                  {client ? (
                    <button
                      className="balo-tap inline-flex items-center justify-center gap-2 rounded-xl py-2 text-xs font-medium"
                      style={{ background: '#fff', border: `1px solid ${C.line}`, color: C.text }}
                    >
                      <CircleCheck size={13} /> Mark resolved
                    </button>
                  ) : (
                    !asked && (
                      <button
                        className="balo-tap inline-flex items-center justify-center gap-2 rounded-xl py-2 text-xs font-medium"
                        style={{ background: '#fff', border: `1px solid ${C.line}`, color: C.text }}
                      >
                        <CircleCheck size={13} /> Ask if it’s resolved
                      </button>
                    )
                  )}
                </div>
              )}
            </Card>
          </div>
        </div>
      </div>

      <p className="max-w-xl text-center text-xs leading-relaxed" style={{ color: '#8A94A6' }}>
        Prototype · case surface v6. Join is brand-blue with a pulse, not red — red means
        destructive in the in-meeting UI. Slots and files are actions, not indicators.
      </p>
    </div>
  );
}
