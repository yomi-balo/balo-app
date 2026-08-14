/**
 * google-calendar-consent-explainer.jsx — DESIGN REFERENCE (BAL-462)
 * ─────────────────────────────────────────────────────────────────────────────
 * The Balo interstitial shown BEFORE we hand an expert to Google's OAuth consent
 * screen, plus the two recovery states after a partial grant.
 * Parent: BAL-397 (calendar connection UI). Backend half: BAL-456. Spike
 * evidence: BAL-393 / FINDINGS.md §"Phase 1 §P6". CC implements from this file.
 *
 * WHY THIS SCREEN EXISTS
 * Google's real consent screen (uploaded screenshot) shows granular per-scope
 * checkboxes, every one UNCHECKED by default, including "Select all". An expert
 * who clicks Continue without ticking grants nothing — the grant is rejected
 * server-side and bounces back to Balo's callback with
 * ?error=missing_required_permissions and no endUserAccountId. So job one is
 * behavioural: get both boxes ticked. Job two is trust: Google's own wording
 * ("see, edit, share and permanently delete all the calendars…") is alarming.
 *
 * THE TRUST THESIS (drives all copy)
 * Don't hide Google's scary text — translate it honestly. Balo reads WHEN you're
 * free or busy, never WHAT is in your events (no titles, guests, locations,
 * notes), and only ever writes the consultations you book. That's a promise
 * about how Balo USES the access, not a claim about what the token could do — so
 * the copy says "Balo only…", never "Balo can't…". The sees / never-sees ledger
 * and the free/busy strip make the promise visible instead of asserted.
 *
 * LAYOUT — light, split
 * Explanation on the LEFT (read first: one-line promise → ledger → free/busy
 * strip); instruction + CTA on the RIGHT action rail, so neither job buries the
 * other. Light to stay consistent in-product — Google's screen follows the
 * user's OS theme, so there's nothing to "match" by going dark. Geist throughout;
 * blue→violet gradient spent only on the single primary CTA.
 *
 * GOOGLE-SCOPED ON PURPOSE
 * Microsoft's consent has no unchecked-by-default failure, so there's no generic
 * screen — the Microsoft connect flow gets a lighter (or no) interstitial.
 *
 * DECIDED / OPEN
 * • BYOC is decided: the consent screen shows Balo's own branding ("Balo"), so
 *   there is no "Apiroc" variant. (Settles BAL-457's branding question.)
 * • OPEN — scopes (BAL-457): Google currently asks for TWO permissions; the
 *   second is the "permanently delete all calendars" line that does most of the
 *   scaring. If Apiroc works on calendar.events alone, that whole checkbox
 *   disappears — flip the "Scopes" control to see the payoff. Highest-leverage
 *   trust fix on this screen.
 * • The "How Balo protects your calendar data" link → the "Connecting your
 *   calendar" help article (Help Docs Tracker), covering data handling/retention,
 *   distinct from the ledger (which covers what's accessed). Could instead be an
 *   inline disclosure to avoid off-page navigation at the consent moment.
 *
 * Placeholder account is you@gmail.com — never ship a real address.
 */

import React, { useState } from 'react';
import {
  Calendar,
  Check,
  X,
  Clock,
  ShieldCheck,
  ArrowRight,
  ExternalLink,
  AlertCircle,
  RefreshCw,
  ChevronLeft,
  CheckSquare,
  Lock,
} from 'lucide-react';

/* ── tokens (light) ──────────────────────────────────────────────────────────── */
const T = {
  page: '#EEF1F7',
  card: '#FFFFFF',
  panel: '#F6F7FB',
  rail: '#F7F8FC',
  ink: '#0B1220',
  slate: '#475569',
  muted: '#94A3B8',
  line: '#E7EAF0',
  edge: '#DBE1EA',
  blue: '#2563EB',
  violet: '#7C3AED',
  emerald: '#059669',
  amber: '#D97706',
  grad: 'linear-gradient(135deg,#2563EB 0%,#7C3AED 100%)',
  busy: '#C7D2FE',
  busyEdge: '#A5B4FC',
};
const font = 'Geist, ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif';

/* ── signature: free/busy proof, glowing on dark ─────────────────────────── */
function FreeBusyProof() {
  const days = ['M', 'T', 'W', 'T', 'F'];
  const busy = [
    [
      [0.15, 0.18],
      [0.55, 0.22],
    ],
    [[0.35, 0.3]],
    [
      [0.1, 0.14],
      [0.4, 0.16],
      [0.7, 0.2],
    ],
    [[0.5, 0.34]],
    [[0.2, 0.24]],
  ];
  return (
    <div className="flex items-end gap-2" style={{ height: 84 }}>
      {days.map((d, i) => (
        <div key={i} className="flex flex-1 flex-col items-center gap-1.5">
          <div
            className="relative w-full rounded-md"
            style={{ height: 64, background: '#FFFFFF', border: `1px solid ${T.line}` }}
          >
            {busy[i].map(([top, h], j) => (
              <div
                key={j}
                className="absolute right-1 left-1 rounded-[3px]"
                style={{
                  top: `${top * 100}%`,
                  height: `${h * 100}%`,
                  background: T.busy,
                  border: `1px solid ${T.busyEdge}`,
                }}
              />
            ))}
          </div>
          <span className="text-[10px]" style={{ color: T.muted }}>
            {d}
          </span>
        </div>
      ))}
    </div>
  );
}

/* ── the ledger that replaces v1's prose ─────────────────────────────────── */
function Ledger() {
  const sees = ['When you’re free or busy', 'The consultations you book'];
  const never = ['Event titles', 'Who’s invited', 'Locations & notes'];
  return (
    <div className="grid grid-cols-2 gap-3">
      <div
        className="rounded-xl p-3.5"
        style={{ background: T.rail, border: `1px solid ${T.line}` }}
      >
        <div className="mb-2.5 flex items-center gap-1.5">
          <span
            className="flex items-center justify-center rounded-full"
            style={{ width: 16, height: 16, background: 'rgba(5,150,105,.12)' }}
          >
            <Check size={11} style={{ color: T.emerald }} strokeWidth={3} />
          </span>
          <span
            className="text-[10.5px] font-bold tracking-wider uppercase"
            style={{ color: T.emerald }}
          >
            Balo sees
          </span>
        </div>
        <ul className="space-y-1.5">
          {sees.map((s) => (
            <li key={s} className="text-[12.5px] leading-snug" style={{ color: T.ink }}>
              {s}
            </li>
          ))}
        </ul>
      </div>
      <div
        className="rounded-xl p-3.5"
        style={{ background: T.rail, border: `1px solid ${T.line}` }}
      >
        <div className="mb-2.5 flex items-center gap-1.5">
          <span
            className="flex items-center justify-center rounded-full"
            style={{ width: 16, height: 16, background: 'rgba(148,163,184,.18)' }}
          >
            <X size={11} style={{ color: T.muted }} strokeWidth={3} />
          </span>
          <span
            className="text-[10.5px] font-bold tracking-wider uppercase"
            style={{ color: T.slate }}
          >
            Never sees
          </span>
        </div>
        <ul className="space-y-1.5">
          {never.map((s) => (
            <li key={s} className="text-[12.5px] leading-snug" style={{ color: T.slate }}>
              {s}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/* ── compact Google permission rows (pre-ticked = target state) ──────────── */
function GoogleRows({ eventsOnly }) {
  const rows = [
    { text: 'View and edit events on all of your calendars.' },
    {
      text: 'See, edit, share and permanently delete all the calendars you can access.',
      note: 'Standard Google wording — Balo never deletes or shares.',
    },
  ];
  const shown = eventsOnly ? rows.slice(0, 1) : rows;
  return (
    <div className="overflow-hidden rounded-lg" style={{ border: `1px solid ${T.edge}` }}>
      {shown.map((r, i) => (
        <div
          key={i}
          className="flex gap-2.5 px-3 py-2.5"
          style={{ borderTop: i ? `1px solid ${T.line}` : 'none', background: T.rail }}
        >
          <div
            className="mt-0.5 flex shrink-0 items-center justify-center rounded-[4px]"
            style={{ width: 16, height: 16, background: T.grad }}
          >
            <Check size={11} color="#fff" strokeWidth={3} />
          </div>
          <div>
            <p className="text-[12px] leading-snug" style={{ color: T.ink }}>
              {r.text}
            </p>
            {r.note && (
              <p className="mt-0.5 text-[11px] leading-snug" style={{ color: T.muted }}>
                {r.note}
              </p>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ── buttons ──────────────────────────────────────────────────────────────── */
function Primary({ children, icon: Icon = ArrowRight, full }) {
  return (
    <button
      className={`inline-flex h-11 items-center justify-center gap-2 rounded-xl px-4 text-[13.5px] font-semibold text-white transition-transform active:scale-[.99] ${full ? 'w-full' : ''}`}
      style={{ background: T.grad, boxShadow: '0 10px 26px -10px rgba(124,58,237,.7)' }}
    >
      {children}
      <Icon size={16} />
    </button>
  );
}
function Ghost({ children, full }) {
  return (
    <button
      className={`inline-flex h-11 items-center justify-center rounded-xl px-4 text-[13.5px] font-medium ${full ? 'w-full' : ''}`}
      style={{ color: T.slate, border: `1px solid ${T.edge}`, background: 'transparent' }}
    >
      {children}
    </button>
  );
}
function Brand() {
  return (
    <div className="flex items-center gap-2.5">
      <div
        className="flex items-center justify-center rounded-[9px]"
        style={{ width: 28, height: 28, background: T.grad }}
      >
        <Calendar size={15} color="#fff" />
      </div>
      <span className="text-[13px] font-semibold tracking-tight" style={{ color: T.ink }}>
        Balo
      </span>
    </div>
  );
}

function CardShell({ children, wide }) {
  return (
    <div
      className="w-full overflow-hidden rounded-2xl"
      style={{
        maxWidth: wide ? 720 : 460,
        background: T.card,
        border: `1px solid ${T.edge}`,
        boxShadow: '0 1px 2px rgba(11,18,32,.04), 0 30px 60px -30px rgba(11,18,32,.22)',
      }}
    >
      {children}
    </div>
  );
}

/* ── STATE 1 — pre-consent, split ────────────────────────────────────────── */
function PreConsent({ eventsOnly }) {
  return (
    <CardShell wide>
      <div className="grid md:grid-cols-[1fr_0.92fr]">
        {/* LEFT — explanation (read first) */}
        <div className="p-7" style={{ borderRight: `1px solid ${T.line}` }}>
          <div className="flex items-center justify-between">
            <Brand />
            <span className="text-[11px]" style={{ color: T.muted }}>
              Connect your calendar
            </span>
          </div>
          <h1
            className="mt-7 text-[27px] leading-[1.12] font-semibold tracking-tight"
            style={{ color: T.ink }}
          >
            We read your free/busy.
            <br />
            <span style={{ color: T.violet }}>Not</span> your events.
          </h1>
          <p className="mt-3 text-[13px] leading-relaxed" style={{ color: T.slate }}>
            So clients book you at times that actually work.
          </p>

          <div className="mt-6">
            <Ledger />
          </div>

          <div
            className="mt-6 rounded-xl p-4"
            style={{ background: T.rail, border: `1px solid ${T.line}` }}
          >
            <FreeBusyProof />
            <p className="mt-2.5 text-[11px]" style={{ color: T.muted }}>
              This is the view Balo gets — busy blocks, no titles.
            </p>
          </div>
        </div>

        {/* RIGHT — instruction + action rail */}
        <div className="flex flex-col p-7" style={{ background: T.panel }}>
          <div className="flex items-center gap-1.5">
            <CheckSquare size={14} style={{ color: T.violet }} />
            <span
              className="text-[10.5px] font-bold tracking-wider uppercase"
              style={{ color: T.violet }}
            >
              On Google’s next screen
            </span>
          </div>
          <p className="mt-2 text-[17px] leading-snug font-semibold" style={{ color: T.ink }}>
            Tick {eventsOnly ? 'the box' : 'both boxes'}, then choose{' '}
            <span style={{ color: T.violet }}>Continue</span>.
          </p>

          <div className="mt-4">
            <GoogleRows eventsOnly={eventsOnly} />
          </div>

          <div className="mt-auto pt-6">
            <div className="flex gap-2.5">
              <Primary>Continue to Google</Primary>
              <Ghost>Not now</Ghost>
            </div>
            {/* Links to the "How Balo uses your calendar data" help article (BAL-462 help doc). */}
            <button
              className="mt-3 inline-flex items-center gap-1.5 text-[11.5px]"
              style={{ color: T.muted }}
            >
              <Lock size={12} /> How Balo protects your calendar data
            </button>
          </div>
        </div>
      </div>
    </CardShell>
  );
}

/* ── STATE 2 — partial grant ─────────────────────────────────────────────── */
function PartialGrant({ eventsOnly }) {
  return (
    <CardShell>
      <div className="p-7">
        <Brand />
        <div
          className="mt-6 flex items-center justify-center rounded-xl"
          style={{ width: 40, height: 40, background: '#FEF3E2', border: '1px solid #FADFB4' }}
        >
          <AlertCircle size={19} style={{ color: T.amber }} />
        </div>
        <h1 className="mt-4 text-[20px] font-semibold tracking-tight" style={{ color: T.ink }}>
          Calendar access wasn’t granted
        </h1>
        <p className="mt-2.5 text-[13px] leading-relaxed" style={{ color: T.slate }}>
          Google needs {eventsOnly ? 'the box' : 'both boxes'} ticked before Balo can see your free
          times. Nothing was saved — Balo didn’t read anything.
        </p>
        <div
          className="mt-4 rounded-xl px-4 py-3 text-[12.5px] leading-snug"
          style={{ background: T.rail, border: `1px solid ${T.line}`, color: T.slate }}
        >
          <span className="font-semibold" style={{ color: T.ink }}>
            This time:{' '}
          </span>
          on Google’s screen, tick {eventsOnly ? 'the box' : 'every box (or “Select all”)'}, then
          Continue.
        </div>
        <div className="mt-6 flex gap-2.5">
          <Primary icon={RefreshCw}>Try again</Primary>
          <Ghost>Do this later</Ghost>
        </div>
      </div>
    </CardShell>
  );
}

/* ── STATE 3 — reconnect ─────────────────────────────────────────────────── */
function Reconnect() {
  const steps = [
    {
      t: 'Remove Balo’s access in your Google Account',
      b: 'Listed as “Balo” — this clears the partial grant.',
    },
    { t: 'Come back and reconnect', b: 'This time, tick both boxes before Continue.' },
  ];
  return (
    <CardShell>
      <div className="p-7">
        <button
          className="mb-3 inline-flex items-center gap-1 text-[12px]"
          style={{ color: T.muted }}
        >
          <ChevronLeft size={14} /> Calendar settings
        </button>
        <Brand />
        <h1 className="mt-5 text-[20px] font-semibold tracking-tight" style={{ color: T.ink }}>
          Reconnect your Google Calendar
        </h1>
        <p className="mt-2.5 text-[13px] leading-relaxed" style={{ color: T.slate }}>
          You’ve connected before, so Google won’t show the permission boxes again. Two quick steps:
        </p>
        <div className="mt-5 space-y-3.5">
          {steps.map((s, i) => (
            <div key={i} className="flex gap-3">
              <div
                className="flex shrink-0 items-center justify-center rounded-full text-[12px] font-bold text-white"
                style={{ width: 22, height: 22, background: T.grad }}
              >
                {i + 1}
              </div>
              <div className="pt-0.5">
                <p className="text-[13.5px] font-semibold" style={{ color: T.ink }}>
                  {s.t}
                </p>
                <p className="mt-0.5 text-[12.5px] leading-snug" style={{ color: T.slate }}>
                  {s.b}
                </p>
              </div>
            </div>
          ))}
        </div>
        <div className="mt-6 flex gap-2.5">
          <Primary icon={ExternalLink}>Open Google permissions</Primary>
          <Ghost>I’ve removed it — reconnect</Ghost>
        </div>
      </div>
    </CardShell>
  );
}

/* ── control strip + harness (shared with v1 for a fair compare) ─────────── */
function Seg({ options, value, onChange }) {
  return (
    <div className="inline-flex rounded-lg p-0.5" style={{ background: '#1B2436' }}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            onClick={() => onChange(o.value)}
            className="h-8 rounded-md px-3 text-[12px] font-medium"
            style={{
              color: on ? '#0B1220' : '#9FB0C9',
              background: on ? '#EAF0FB' : 'transparent',
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export default function GoogleConsentExplainer() {
  const [state, setState] = useState('pre');
  const [eventsOnly, setEventsOnly] = useState(false);

  return (
    <div style={{ fontFamily: font, background: T.page, minHeight: '100vh' }}>
      <div style={{ background: '#080B12', borderBottom: '1px solid #1B2436' }}>
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-6 gap-y-3 px-5 py-3">
          <div className="flex items-center gap-2">
            <span
              className="text-[11px] font-semibold tracking-wider uppercase"
              style={{ color: '#5C6B85' }}
            >
              State
            </span>
            <Seg
              value={state}
              onChange={setState}
              options={[
                { value: 'pre', label: 'Pre-consent' },
                { value: 'partial', label: 'Partial grant' },
                { value: 'reconnect', label: 'Reconnect' },
              ]}
            />
          </div>
          <div className="flex items-center gap-2">
            <span
              className="text-[11px] font-semibold tracking-wider uppercase"
              style={{ color: '#5C6B85' }}
            >
              Scopes
            </span>
            <Seg
              value={eventsOnly ? 'one' : 'both'}
              onChange={(v) => setEventsOnly(v === 'one')}
              options={[
                { value: 'both', label: 'Both (now)' },
                { value: 'one', label: 'Events-only' },
              ]}
            />
          </div>
          <span className="ml-auto text-[11px]" style={{ color: '#5C6B85' }}>
            BAL-462 · design reference
          </span>
        </div>
      </div>

      <div className="mx-auto flex max-w-5xl justify-center px-5 py-10">
        {state === 'pre' && <PreConsent eventsOnly={eventsOnly} />}
        {state === 'partial' && <PartialGrant eventsOnly={eventsOnly} />}
        {state === 'reconnect' && <Reconnect />}
      </div>
    </div>
  );
}
