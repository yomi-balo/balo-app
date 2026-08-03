import React, { useState } from 'react';
import { Check, Star, ArrowRight, RotateCcw, Clock, ShieldCheck, CircleCheck } from 'lucide-react';

/**
 * Balo — End-of-call screen (design reference, updated for ADR-1045 / BAL-390 / BAL-417)
 *
 * Principle: this screen is THROWAWAY. People don't linger, and many will close
 * the tab or quit the browser and never see it. So nothing mission-critical lives
 * here — the receipt, the recap, action items, and conversion CTAs all live on the
 * recap + email/notifications.
 *
 * ONE QUALIFIED EXCEPTION: the case-resolution prompt. It is consequential and,
 * per BAL-400, not reversible — booking again after resolution starts a NEW case.
 * It is here anyway because most cases would otherwise never be closed
 * deliberately: the client stops booking, 30 days pass, the sweep closes it, and
 * the review email lands a month after the last consultation with poor recall.
 * Asking at the moment the client actually knows the answer is the whole point.
 * Because it is consequential, it gets a confirmation step — never a bare tap.
 *
 * ── ORDERING: RATE FIRST, THEN RESOLVE ─────────────────────────────────────
 * The rule is: the resolve prompt appears once a rating EXISTS (given just now, or
 * already on file). Reasons:
 *  - Rating is asked every consultation; resolve is asked rarely. Primary before
 *    conditional.
 *  - Rating is quick and revisable; resolve is consequential and one-way. Cheap
 *    ask before expensive one.
 *  - If the client rates AND resolves here, the review already exists, so
 *    BAL-390's fused close email omits its review block entirely — the best
 *    possible outcome, captured in context rather than chased by email.
 *  - If they never rate, resolve never shows here. Acceptable: the case surface
 *    keeps "Mark resolved" and the 30-day sweep is the backstop.
 *
 * ── THE THREE RATING STATES (BAL-390) ──────────────────────────────────────
 *  1. No rating yet     → ask.
 *  2. Existing rating ≥4 → display it, do NOT prompt.
 *  3. Existing rating <4 → display it and invite a revision.
 * The threshold is CONFIGURABLE, not hardcoded (`LOW_THRESHOLD` here stands in for
 * config). The review is an UPSERT on the single per-engagement review — submitting
 * again updates, never duplicates or rejects.
 *
 * Note the asymmetry is in the TRIGGER, not the copy: only sub-threshold ratings
 * are re-asked, but the wording is neutral ("Has that changed?") and the stars move
 * in both directions. A one-way ratchet in the copy would make the aggregate
 * meaningless faster than the trigger alone does.
 *
 * ── CONTEXT ─────────────────────────────────────────────────────────────
 * Resolve is CASE-CONTEXT ONLY. A project kickoff or discovery call has no case to
 * resolve, so the prompt is absent — not disabled. Copy follows the context too:
 * "consultation" for a case, "meeting" otherwise (BAL-132's "Back to {context}").
 *
 * REMOVED: the old "you can add more on your recap" saved-state copy. The recap no
 * longer independently re-asks per consultation — review is per-engagement and
 * fires once, at case close (ADR-1045 §4). Also removed: the BAL-133 duration
 * confirmation, deferred with the external-venue lane (ADR-1044).
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
  star: '#F5A623',
};

const EXPERT = { name: 'Amara', full: 'Dr. Amara Okafor' };
const CLIENT = { name: 'Jordan', full: 'Jordan Lee' };
const LOW_THRESHOLD = 4; // config, not a constant — BAL-390

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

function Stars({ value, onChange, hover, onHover, size = 30 }) {
  const readOnly = !onChange;
  return (
    <div className="flex items-center gap-1.5">
      {[1, 2, 3, 4, 5].map((n) => {
        const lit = (hover || value) >= n;
        const S = (
          <Star size={size} color={lit ? C.star : C.line} fill={lit ? C.star : 'none'} />
        );
        return readOnly ? (
          <span key={n}>{S}</span>
        ) : (
          <button
            key={n}
            onMouseEnter={() => onHover && onHover(n)}
            onMouseLeave={() => onHover && onHover(0)}
            onClick={() => onChange(n)}
          >
            {S}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Rating block — three states. Calls onSettled() as soon as a rating exists,
 * which is what reveals the resolve prompt.
 */
function RatingBlock({ existing, onSettled }) {
  const [r, setR] = useState(existing || 0);
  const [hov, setHov] = useState(0);
  const [note, setNote] = useState('');
  const [justSaved, setJustSaved] = useState(false);
  const [revising, setRevising] = useState(false);

  const isLow = existing != null && existing < LOW_THRESHOLD;
  const isHigh = existing != null && existing >= LOW_THRESHOLD;

  // State 2 — existing ≥ threshold: display, do not prompt.
  if (isHigh && !revising) {
    return (
      <div className="flex flex-col items-center">
        <div className="mb-2 text-sm" style={{ color: C.sub }}>
          You rated {EXPERT.name}
        </div>
        <Stars value={existing} size={24} />
        <button
          onClick={() => setRevising(true)}
          className="mt-2 text-xs"
          style={{ color: C.faint }}
        >
          Change
        </button>
      </div>
    );
  }

  // Saved just now.
  if (justSaved) {
    return (
      <div className="flex flex-col items-center gap-2">
        <div className="flex items-center gap-2 text-sm" style={{ color: C.good }}>
          <Check size={16} /> Thanks — saved.
        </div>
        <Stars value={r} size={20} />
      </div>
    );
  }

  // State 1 (none) and State 3 (low, invite revision).
  return (
    <div className="flex w-full flex-col items-center">
      {isLow && !revising ? (
        <>
          <div className="mb-1.5 text-sm" style={{ color: C.sub }}>
            You rated {EXPERT.name} after your last consultation
          </div>
          <Stars value={existing} size={22} />
          <div className="mt-3 text-sm font-medium" style={{ color: C.text }}>
            Has that changed?
          </div>
          <button
            onClick={() => setRevising(true)}
            className="mt-2 rounded-xl px-4 py-2 text-sm font-medium"
            style={{ background: '#fff', border: `1px solid ${C.line}`, color: C.text }}
          >
            Update my rating
          </button>
        </>
      ) : (
        <>
          <div className="mb-2 text-sm font-medium" style={{ color: C.text }}>
            {existing != null
              ? `How was this one with ${EXPERT.name}?`
              : `How was your consultation with ${EXPERT.name}?`}
          </div>
          <Stars value={r} onChange={setR} hover={hov} onHover={setHov} />
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
                onClick={() => {
                  setJustSaved(true);
                  onSettled();
                }}
                className="mt-2 w-full rounded-xl py-2 text-sm font-medium text-white"
                style={{ background: C.brand }}
              >
                {existing != null ? 'Update review' : 'Save review'}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** Resolve prompt — consequential, so it confirms before closing. */
function ResolvePrompt({ rated }) {
  const [step, setStep] = useState('ask'); // ask | confirm | done

  if (step === 'done') {
    return (
      <div
        className="flex w-full items-start gap-2.5 rounded-2xl px-4 py-3 text-left"
        style={{ background: C.goodSoft, border: `1px solid #CDEBDC` }}
      >
        <CircleCheck size={16} color={C.good} className="mt-0.5 shrink-0" />
        <span className="text-sm" style={{ color: '#1B5C42' }}>
          Case closed. {rated ? 'Your review is saved, so nothing else to do.' : 'We’ll email you a short review request.'}
        </span>
      </div>
    );
  }

  if (step === 'confirm') {
    return (
      <div
        className="flex w-full flex-col gap-2.5 rounded-2xl px-4 py-3 text-left"
        style={{ background: C.brandSoft, border: `1px solid ${C.brandLine}` }}
      >
        <span className="text-sm" style={{ color: '#33465F' }}>
          This closes the case. Everything stays available, and booking again starts a new one.
        </span>
        <div className="flex gap-2">
          <button
            onClick={() => setStep('done')}
            className="rounded-lg px-3 py-1.5 text-xs font-semibold text-white"
            style={{ background: C.brand }}
          >
            Close the case
          </button>
          <button
            onClick={() => setStep('ask')}
            className="rounded-lg px-3 py-1.5 text-xs font-medium"
            style={{ background: '#fff', border: `1px solid ${C.line}`, color: C.sub }}
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex w-full flex-col items-center">
      <div className="text-sm font-medium" style={{ color: C.text }}>
        Is this issue resolved?
      </div>
      <div className="mt-2 flex gap-2">
        <button
          onClick={() => setStep('confirm')}
          className="rounded-xl px-4 py-2 text-sm font-medium"
          style={{ background: '#fff', border: `1px solid ${C.line}`, color: C.text }}
        >
          Yes, it’s sorted
        </button>
        <button
          className="rounded-xl px-4 py-2 text-sm font-medium"
          style={{ background: 'transparent', color: C.sub }}
        >
          Not yet
        </button>
      </div>
    </div>
  );
}

export default function App() {
  const [lens, setLens] = useState('client');
  const [context, setContext] = useState('case');
  const [rating, setRating] = useState('none');
  const [recap, setRecap] = useState('processing');
  const [settled, setSettled] = useState(false);

  const client = lens === 'client';
  const isCase = context === 'case';
  const other = client ? EXPERT : CLIENT;
  const ready = recap === 'ready';
  const existing = rating === 'none' ? null : rating === 'high' ? 5 : 3;

  // Resolve shows once a rating exists — given just now, or already on file.
  const ratingExists = existing != null || settled;
  const showResolve = client && isCase && ratingExists;

  const noun = isCase ? 'consultation' : 'meeting';

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
        <Ctl label="Context">
          <Seg
            value={context}
            onChange={setContext}
            options={[
              { value: 'case', label: 'Case' },
              { value: 'kickoff', label: 'Project' },
            ]}
          />
        </Ctl>
        <Ctl label="Rating">
          <Seg
            value={rating}
            onChange={(v) => {
              setRating(v);
              setSettled(false);
            }}
            options={[
              { value: 'none', label: 'New' },
              { value: 'high', label: 'Rated 5' },
              { value: 'low', label: 'Rated 3' },
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
      <div className="flex w-full items-center justify-center" style={{ minHeight: 560 }}>
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
            {client ? `${isCase ? 'Consultation' : 'Meeting'} complete` : 'Nice session'}
          </h1>
          <div className="mt-1.5 flex items-center gap-1.5 text-sm" style={{ color: C.sub }}>
            <Clock size={14} /> You spoke for 45 min with {other.name}
          </div>

          {/* safe-to-leave reassurance — the one thing that earns its place here */}
          <div
            className="mt-5 flex w-full items-start gap-2.5 rounded-2xl px-4 py-3 text-left"
            style={{ background: C.brandSoft, border: `1px solid ${C.brandLine}` }}
          >
            <ShieldCheck size={16} color={C.brand} className="mt-0.5 shrink-0" />
            <span className="text-sm" style={{ color: '#33465F' }}>
              {client
                ? `Your recap${isCase ? ' and receipt are' : ' is'} on the way — we'll email you when ${isCase ? "they're" : "it's"} ready. Nothing else needed here.`
                : "Your notes and payout summary are on the way — we'll email you when your recap is ready."}
            </span>
          </div>

          {/* rating (client only) */}
          {client && (
            <div className="mt-6 w-full pt-6" style={{ borderTop: `1px solid ${C.line2}` }}>
              <RatingBlock existing={existing} onSettled={() => setSettled(true)} />
            </div>
          )}

          {/* resolve — case context only, and only once a rating exists */}
          {showResolve && (
            <div className="mt-6 w-full pt-6" style={{ borderTop: `1px solid ${C.line2}` }}>
              <ResolvePrompt rated={ratingExists} />
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
                  Back to the {isCase ? 'case' : 'project'} <ArrowRight size={16} />
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
          <button className="mt-5 inline-flex items-center gap-1.5 text-sm" style={{ color: C.sub }}>
            <RotateCcw size={14} /> Rejoin the {noun}
          </button>
        </div>
      </div>

      <p className="max-w-md text-center text-xs leading-relaxed" style={{ color: '#8A94A6' }}>
        Prototype · end-of-call. Rate first, then resolve — the resolve prompt appears once a rating
        exists, and confirms before closing. Toggle <strong>Rating</strong> and{' '}
        <strong>Context</strong> to walk the states.
      </p>
    </div>
  );
}
