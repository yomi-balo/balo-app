import React, { useState } from 'react';
import { Loader2, UserPlus, Signal, Users, Clock, CircleCheck, CircleSlash } from 'lucide-react';

/**
 * Balo — Waiting state (design reference, PATCH for BAL-132 / BAL-134)
 *
 * Replaces `WaitingStage` in `.claude/design-references/balo-in-meeting-ui.jsx`
 * and fixes one line of `TopBar`. Everything else in that file stands.
 *
 * ── v2: THE CLOCK RULE CHANGED ────────────────────────────────────────────────
 * Decided 2026-07-31: **the clock starts when the EXPERT joins**, not at the
 * scheduled start. If the expert hasn't joined, nothing is counted for anyone.
 * Precisely, the expert-present clock starts at the LATER of the scheduled start
 * and the expert's actual join — arriving early earns nothing extra, and a 10:05
 * join means the no-show settles at 10:20 rather than 10:15.
 *
 * v1 of this patch said "counted from 10:00, the scheduled start". That is now
 * wrong and would have been a false promise to a late-joining expert.
 *
 * ── WHAT WAS WRONG IN THE SHIPPED REFERENCE ───────────────────────────────────
 * It tells the expert:
 *   "No waiting room — they'll drop straight in. The timer starts the moment
 *    they arrive."
 * That describes the BILLABLE timer, which is true but is the only thing they're
 * told — so it reads as *nothing is being counted while you wait*, which is
 * exactly the failure BAL-134 names: the expert leaves at minute eight and
 * forfeits a no-show settlement they had already earned.
 *
 * Two clocks (BAL-134):
 *   · billable       — expert AND ≥1 client-side participant both present
 *   · expert-present — from the expert's join; makes a no-show computable
 *
 * ── SECOND BUG, SAME SCREEN ───────────────────────────────────────────────────
 * `TopBar` computes `live` as ['oneOnOne','gallery','screenshare'].includes(stage),
 * so during `waiting` it renders "Not started" — contradicting the corrected copy
 * on the expert lens. Fixed: the expert sees the counted time in amber; the client
 * still sees "Not started", which is correct because nothing is being charged.
 *
 * ── THREE OUTCOMES, NOT TWO ───────────────────────────────────────────────────
 *   held        — both joined
 *   no_show     — expert waited the full block, client never came → floor billed
 *   missed_call — EXPERT never joined → nothing charged, hold released in full
 *
 * The missed-call path is new (BAL-412 / BAL-418) and gives the client lens its
 * own progression, which v1 didn't have. At 5 minutes past the scheduled start
 * with no expert, a high-priority EMAIL alert goes to Balo so someone can try to
 * salvage the call — the only window in which it can still be rescued.
 *
 * REGISTER (BAL-134): "a quiet fact, not a countdown to a payout." MJ checkpoint.
 *
 * ── STILL OPEN ────────────────────────────────────────────────────────────────
 * How long past the scheduled start does a meeting terminate as a missed call?
 * The alert is at 5 minutes; termination is a separate, unset threshold. The
 * client copy at that point is written to be honest without promising a rule that
 * doesn't exist yet.
 */

const C = {
  bg: '#0B0E13',
  stage: '#0F131C',
  line: 'rgba(255,255,255,0.08)',
  line2: 'rgba(255,255,255,0.14)',
  text: '#E8ECF3',
  sub: '#98A2B3',
  faint: '#68717F',
  brand: '#2563EB',
  good: '#2FBF71',
  amber: '#E0A33E',
  amberSoft: 'rgba(224,163,62,0.16)',
};

const PEOPLE = {
  expert: { name: 'Dr. Amara Okafor', initials: 'AO', hue: '#7C3AED' },
  client: { name: 'Jordan Lee', initials: 'JL', hue: '#0EA5E9' },
};

const START = '10:00';

/**
 * Two scenarios, because who is absent changes everything.
 *
 * clientLate — expert joined at 10:00, waiting for the client. Expert's clock runs.
 * expertLate — expert has NOT joined. Nothing counts. Client is waiting on nobody.
 */
const SCENARIOS = {
  clientLate: {
    label: 'Client is late',
    absent: 'client',
    phases: {
      early: { label: 'Before start', now: '09:57', counted: null },
      running: { label: 'Counting', now: '10:03', counted: '03:12' },
      near: { label: 'Near 15 min', now: '10:12', counted: '12:40' },
      settled: { label: 'No-show', now: '10:16', counted: '15:00' },
    },
  },
  expertLate: {
    label: 'Expert is late',
    absent: 'expert',
    phases: {
      early: { label: 'Just after start', now: '10:02', counted: null },
      running: { label: '5 min — alert', now: '10:05', counted: null },
      near: { label: 'Still nothing', now: '10:11', counted: null },
      settled: { label: 'Missed call', now: '10:20', counted: null },
    },
  },
};

function Seg({ options, value, onChange }) {
  return (
    <div
      className="flex items-center gap-1 rounded-lg p-1"
      style={{ background: '#0d1017', border: `1px solid ${C.line}` }}
    >
      {options.map((o) => {
        const a = o.value === value;
        return (
          <button
            key={o.value}
            onClick={() => onChange(o.value)}
            className="rounded-md px-2.5 py-1 text-xs font-medium transition-colors"
            style={{ background: a ? C.brand : 'transparent', color: a ? '#fff' : C.sub }}
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

function Avatar({ p, size = 72 }) {
  return (
    <div
      className="flex shrink-0 items-center justify-center font-semibold"
      style={{
        width: size,
        height: size,
        borderRadius: size,
        background: p.hue,
        color: '#fff',
        fontSize: size * 0.36,
      }}
    >
      {p.initials}
    </div>
  );
}

/** PATCH 1 — TopBar showed "Not started" while the expert's clock ran. */
function TopBar({ counted }) {
  return (
    <div
      className="flex shrink-0 items-center justify-between px-4"
      style={{ height: 52, borderBottom: `1px solid ${C.line}` }}
    >
      <div className="flex min-w-0 items-center gap-3">
        <span className="truncate text-sm font-semibold" style={{ color: C.text }}>
          Salesforce CPQ consultation
        </span>
        <span
          className="hidden shrink-0 items-center gap-1.5 rounded-md px-2 py-0.5 text-xs sm:flex"
          style={{
            background: counted ? C.amberSoft : 'rgba(255,255,255,0.06)',
            color: counted ? C.amber : C.sub,
          }}
        >
          {counted ? (
            <>
              <Clock size={11} /> {counted} counted
            </>
          ) : (
            <>Not started</>
          )}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <span className="flex items-center gap-1.5 px-2 py-1 text-xs" style={{ color: C.sub }}>
          <Signal size={15} color={C.good} /> <span className="hidden sm:inline">Strong</span>
        </span>
        <span
          className="flex items-center justify-center rounded-lg"
          style={{ width: 34, height: 34, color: C.sub }}
        >
          <Users size={18} />
        </span>
      </div>
    </div>
  );
}

/** PATCH 2 — WaitingStage, now aware of who is absent and how far the clock has run. */
function WaitingStage({ lens, scenario, phase }) {
  const s = SCENARIOS[scenario];
  const expertAbsent = s.absent === 'expert';
  const other = lens === 'client' ? PEOPLE.expert : PEOPLE.client;
  const firstName = other.name.split(' ').slice(-1)[0];
  const done = phase === 'settled';

  const title = (() => {
    if (!done) return `Waiting for ${firstName} to join`;
    if (expertAbsent)
      return lens === 'client' ? `${firstName} didn’t make it` : 'You missed this call';
    return lens === 'expert' ? `${firstName} didn’t join` : `Still waiting for ${firstName}`;
  })();

  const body = (() => {
    /* ── the client is the late one; the expert's clock is running ── */
    if (!expertAbsent) {
      if (lens === 'expert') {
        switch (phase) {
          case 'early':
            return `Due to start at ${START}. Your time starts counting the moment you join — there’s no waiting room for ${firstName}.`;
          case 'running':
            return `Your time is counted from when you joined. Nothing for you to do.`;
          case 'near':
            return `Still counting. If ${firstName} doesn’t arrive, this settles as a no-show at the 15-minute mark.`;
          case 'settled':
            return `Settled as a no-show at the 15-minute minimum. You’re free to leave — your recap and payout summary will be emailed.`;
          default:
            return '';
        }
      }
      return phase === 'settled'
        ? `You weren’t charged for the full booking, but the 15-minute minimum applied. Your receipt explains it.`
        : `The consultation timer starts once you’re both in. You won’t be charged for waiting.`;
    }

    /* ── the expert is the late one; nothing is counted at all ── */
    if (lens === 'client') {
      switch (phase) {
        case 'early':
          return `${firstName} hasn’t joined yet. Nothing is being charged — the timer only starts once they’re here.`;
        case 'running':
          return `Still no sign of ${firstName}. We’ve flagged this to the Balo team and someone is looking into it. You haven’t been charged.`;
        case 'near':
          return `We’re sorry — we’re still trying to reach ${firstName}. You haven’t been charged, and you won’t be.`;
        case 'settled':
          return `We’re sorry this didn’t happen. Nothing has been charged and your hold has been released. We’ll be in touch to get you rebooked.`;
        default:
          return '';
      }
    }
    /* expert lens, expert absent — only reachable if they join late and look back */
    return `You weren’t in this call. Nothing was counted and nothing was charged to ${PEOPLE.client.name.split(' ')[0]}.`;
  })();

  const Icon = done ? (expertAbsent ? CircleSlash : CircleCheck) : Loader2;

  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-5 px-6 text-center">
      <div className="relative">
        <Avatar p={other} />
        <span
          className="absolute -right-1 -bottom-1 flex items-center justify-center rounded-full"
          style={{ width: 26, height: 26, background: C.stage }}
        >
          <Icon size={18} color={done ? C.amber : C.brand} className={done ? '' : 'animate-spin'} />
        </span>
      </div>

      <div>
        <div className="text-lg font-semibold" style={{ color: C.text }}>
          {title}
        </div>
        <div className="mt-1 text-sm leading-relaxed" style={{ color: C.sub, maxWidth: 360 }}>
          {body}
        </div>
      </div>

      {!done && (
        <button
          className="flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium"
          style={{
            background: 'rgba(255,255,255,0.06)',
            color: C.text,
            border: `1px solid ${C.line2}`,
          }}
        >
          <UserPlus size={16} /> Invite someone else
        </button>
      )}
    </div>
  );
}

export default function App() {
  const [lens, setLens] = useState('expert');
  const [scenario, setScenario] = useState('clientLate');
  const [phase, setPhase] = useState('running');

  const s = SCENARIOS[scenario];
  const p = s.phases[phase];
  const counted = lens === 'expert' && s.absent === 'client' ? p.counted : null;
  const alerting = s.absent === 'expert' && (phase === 'running' || phase === 'near');

  return (
    <div
      className="flex w-full flex-col items-center gap-4 p-4"
      style={{
        background: '#EEF0F4',
        fontFamily: 'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
      }}
    >
      <div
        className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-xl px-3 py-2.5"
        style={{ background: '#0B0E13' }}
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
        <Ctl label="Who's late">
          <Seg
            value={scenario}
            onChange={(v) => {
              setScenario(v);
              setPhase('running');
            }}
            options={Object.entries(SCENARIOS).map(([k, v]) => ({ value: k, label: v.label }))}
          />
        </Ctl>
        <Ctl label="Clock">
          <Seg
            value={phase}
            onChange={setPhase}
            options={Object.entries(s.phases).map(([k, v]) => ({ value: k, label: v.label }))}
          />
        </Ctl>
      </div>

      <div
        className="relative flex flex-col overflow-hidden shadow-2xl"
        style={{
          width: '100%',
          maxWidth: 1120,
          height: 520,
          background: C.bg,
          borderRadius: 20,
          border: `1px solid ${C.line}`,
        }}
      >
        <TopBar counted={counted} />
        <div className="flex min-h-0 flex-1">
          <div className="min-w-0 flex-1 p-3">
            <div
              className="relative h-full w-full overflow-hidden rounded-2xl"
              style={{ background: C.stage }}
            >
              <WaitingStage lens={lens} scenario={scenario} phase={phase} />
            </div>
          </div>
        </div>
      </div>

      {/* what happens off-screen — the salvage path has no UI, so surface it here */}
      {alerting && (
        <div
          className="flex w-full items-center gap-2.5 rounded-xl px-4 py-2.5"
          style={{
            maxWidth: 1120,
            background: C.amberSoft,
            border: `1px solid rgba(224,163,62,0.35)`,
          }}
        >
          <Clock size={14} color={C.amber} className="shrink-0" />
          <span className="text-xs leading-relaxed" style={{ color: '#7A5312' }}>
            <strong>Off-screen:</strong> a high-priority email alert has gone to the Balo team so
            someone can try to reach {PEOPLE.expert.name.split(' ').slice(-1)[0]} or find cover. No
            customer-facing UI — it’s an operational alert, and it cancels if the expert joins
            first.
          </span>
        </div>
      )}

      <div className="max-w-2xl text-center">
        <p className="text-xs leading-relaxed" style={{ color: '#6B7482' }}>
          Prototype · patch for <strong>WaitingStage</strong> and one line of{' '}
          <strong>TopBar</strong> in <code>balo-in-meeting-ui.jsx</code>. The clock starts when the{' '}
          <em>expert</em> joins — switch <strong>Who’s late</strong> to Expert and nothing counts
          for anyone, on either lens.
        </p>
      </div>
    </div>
  );
}
