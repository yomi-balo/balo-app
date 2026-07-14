import React, { useState } from 'react';
import { Check, Star, ArrowRight, RotateCcw, Clock, ShieldCheck, PartyPopper } from 'lucide-react';

/**
 * Balo — End-of-call screen (design reference)
 *
 * Principle: this screen is THROWAWAY. People don't linger, and many will close
 * the tab or quit the browser and never see it. So nothing mission-critical lives
 * here — the receipt, the BAL-133 duration confirmation, the recap, action items,
 * and conversion CTAs all live on the recap + email/notifications.
 *
 * On here (all optional, all re-offered elsewhere):
 *  - at-a-glance duration
 *  - "safe to leave" reassurance (recap/receipt emailed)
 *  - opportunistic rating (re-asked on recap if skipped; not re-asked if given)
 *  - link onward (View recap when ready, else Back to the case)
 *  - Rejoin (accidental hang-up)
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
  good: '#12996B',
  goodSoft: '#E7F6EF',
};
const EXPERT = { name: 'Amara', full: 'Dr. Amara Okafor' };
const CLIENT = { name: 'Jordan', full: 'Jordan Lee' };

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

function Rating() {
  const [r, setR] = useState(0);
  const [hov, setHov] = useState(0);
  const [note, setNote] = useState('');
  const [saved, setSaved] = useState(false);

  if (saved) {
    return (
      <div className="flex items-center justify-center gap-2 text-sm" style={{ color: C.good }}>
        <Check size={16} /> Thanks — saved. You can add more on your recap.
      </div>
    );
  }
  return (
    <div className="flex flex-col items-center">
      <div className="mb-2 text-sm font-medium" style={{ color: C.text }}>
        How was your session with {EXPERT.name}?
      </div>
      <div className="flex items-center gap-1.5">
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            onMouseEnter={() => setHov(n)}
            onMouseLeave={() => setHov(0)}
            onClick={() => setR(n)}
          >
            <Star
              size={30}
              color={(hov || r) >= n ? '#F5A623' : C.line}
              fill={(hov || r) >= n ? '#F5A623' : 'none'}
            />
          </button>
        ))}
      </div>
      {r > 0 && (
        <div className="mt-3 w-full">
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            placeholder="Add a line? (Optional)"
            className="w-full resize-none rounded-xl px-3 py-2 text-sm outline-none"
            style={{ background: '#fff', border: `1px solid ${C.line}`, color: C.text }}
          />
          <button
            onClick={() => setSaved(true)}
            className="mt-2 w-full rounded-xl py-2 text-sm font-medium text-white"
            style={{ background: C.brand }}
          >
            Save review
          </button>
        </div>
      )}
    </div>
  );
}

export default function App() {
  const [lens, setLens] = useState('client');
  const [recap, setRecap] = useState('processing');
  const client = lens === 'client';
  const other = client ? EXPERT : CLIENT;
  const ready = recap === 'ready';

  return (
    <div
      className="flex w-full flex-col items-center gap-4 p-4"
      style={{
        background: C.bg,
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
        <Ctl label="Recap">
          <Seg
            value={recap}
            onChange={setRecap}
            options={[
              { value: 'processing', label: 'Processing' },
              { value: 'ready', label: 'Ready' },
            ]}
          />
        </Ctl>
      </div>

      {/* the screen */}
      <div className="flex w-full items-center justify-center" style={{ minHeight: 520 }}>
        <div
          className="flex w-full flex-col items-center rounded-3xl px-8 py-10 text-center"
          style={{
            maxWidth: 440,
            background: C.card,
            border: `1px solid ${C.line}`,
            boxShadow: '0 1px 2px rgba(16,20,28,0.04), 0 12px 40px rgba(16,20,28,0.06)',
          }}
        >
          <span
            className="mb-4 flex items-center justify-center rounded-full"
            style={{ width: 56, height: 56, background: C.goodSoft }}
          >
            <Check size={26} color={C.good} strokeWidth={2.5} />
          </span>

          <h1 className="text-xl font-semibold" style={{ color: C.text }}>
            {client ? 'Session complete' : 'Nice session'}
          </h1>
          <div className="mt-1.5 flex items-center gap-1.5 text-sm" style={{ color: C.sub }}>
            <Clock size={14} /> You spoke for 45 min with {other.name}
          </div>

          {/* safe-to-leave reassurance — the one thing that earns its place here */}
          <div
            className="mt-5 flex w-full items-start gap-2.5 rounded-2xl px-4 py-3 text-left"
            style={{ background: '#F6F8FE', border: '1px solid #E3EBFB' }}
          >
            <ShieldCheck size={16} color={C.brand} className="mt-0.5 shrink-0" />
            <span className="text-sm" style={{ color: '#33465F' }}>
              {client
                ? "Your recap and receipt are on the way — we'll email you when they're ready. Nothing else needed here."
                : "Your notes and payout summary are on the way — we'll email you when your recap is ready."}
            </span>
          </div>

          {/* opportunistic rating (client) */}
          {client && (
            <div className="mt-6 w-full pt-6" style={{ borderTop: `1px solid ${C.line2}` }}>
              <Rating />
            </div>
          )}

          {/* onward */}
          <div className="mt-6 flex w-full flex-col gap-2">
            <button
              className="flex w-full items-center justify-center gap-2 rounded-xl py-3 text-sm font-semibold text-white"
              style={{ background: C.brand }}
            >
              {ready ? (
                <>
                  View recap <ArrowRight size={16} />
                </>
              ) : (
                <>
                  Back to the case <ArrowRight size={16} />
                </>
              )}
            </button>
            {!ready && (
              <div className="text-xs" style={{ color: C.faint }}>
                Your recap is being prepared.
              </div>
            )}
          </div>

          {/* rejoin — small, for accidental leaves */}
          <button
            className="mt-5 inline-flex items-center gap-1.5 text-sm"
            style={{ color: C.sub }}
          >
            <RotateCcw size={14} /> Rejoin the session
          </button>
        </div>
      </div>

      <p className="text-xs" style={{ color: '#8A94A6' }}>
        Prototype · end-of-call — deliberately light; may never be seen, so nothing critical lives
        here.
      </p>
    </div>
  );
}
