'use client';

/**
 * DESIGN REFERENCE — Expert rate: enter per minute or per hour (Expert Settings › Rate)
 * ---------------------------------------------------------------------------
 * Source of truth for CC. SUPERSEDES the RatePage in expert-setup-pages.jsx, and is drawn
 * from the SHIPPED rate-tab.tsx layout (left-aligned header, single card), not the older
 * centred prototype. Self-mocks save so every state renders standalone.
 *
 * WHAT CHANGES vs rate-tab.tsx
 *   1. Unit toggle "Per minute" / "Per hour" in the card's header row (right of "Your Rate").
 *      Default: Per minute. The large input edits in the selected unit.
 *   2. The line under the input shows the OTHER unit. In hourly mode, when the hourly amount
 *      doesn't divide into whole cents per minute, the same line explains the rounding:
 *      "You're paid per minute, so this saves as A$3.34/minute (A$200.40/hour) take-home."
 *   3. Quick math box: REMOVED.
 *   4. Header description no longer says "per minute" (it is wrong in hourly mode).
 *   5. Input aria-label, max-rate message and save toast follow the selected unit.
 *   6. Input widens in hourly mode so "3000.00" fits.
 *   7. "What clients see" fee line: "Includes Balo's 20% service fee" (was 25%). Balo adds
 *      25% ON TOP of the expert's rate, which is 20% OF the client price (A$2.30 → A$2.875;
 *      the A$0.575 fee is 20% of A$2.875). "Includes" reads as a share of the price shown.
 *      New label SERVICE_FEE_SHARE_LABEL is derived from MARKUP_MULTIPLIER; MARKUP_LABEL
 *      ('25%') keeps its meaning and is not changed.
 *
 * WHAT DOES NOT CHANGE
 *   - Stored value: `expert_profiles.rate_cents`, whole cents PER MINUTE. Billing, holds,
 *     settlement and the client rate all read it. `saveRateAction({ ratePerMinuteCents })`
 *     is unchanged — the client converts before calling it.
 *   - "What clients see" amounts (it already shows per minute and per hour).
 *
 * THE ROUNDING RULE (decided 2026-10-12): per-minute cents = ceil(hourly cents / 60).
 * Only multiples of A$0.60/hour are exact. Round UP so the expert never earns less than
 * they typed: A$200/h → 334¢/min = A$200.40/h; A$100/h → 167¢ = A$100.20/h; A$150/h → 250¢
 * (exact); A$138/h → 230¢ (exact). Helper `perHourToPerMinuteCents` lives beside
 * `perMinuteToPerHour` in apps/web/src/lib/utils/currency.ts.
 *
 * TOGGLE SEMANTICS: switching units re-renders the input FROM the current cents value
 * (never from the typed text), so it can't change the rate or enable Save on its own.
 * A typed A$200/h shows as A$3.34/min, and switching back shows A$200.40/h — that's
 * honest: it is what gets saved.
 *
 * ANALYTICS: EXPERT_RATE_EVENTS.RATE_SAVED gains `input_unit` ('minute' | 'hour') and
 * `was_rounded` (boolean), alongside the existing `rate_per_minute_cents` and
 * `is_initial_setup`.
 *
 * TOKENS: hexes are stand-ins; real tokens are OKLCH in globals.css. Font Geist; the
 * rate digits keep the shipped `font-mono tabular-nums`. Harness controls are a review
 * affordance only — remove in implementation.
 */

import React, { useState } from 'react';
import { Check, DollarSign, Info, RotateCcw } from 'lucide-react';

/* ── Token shim ───────────────────────────────────────────────────────────── */
const T = {
  bg: '#F8FAFB',
  surface: '#FFFFFF',
  track: '#EEF1F6',
  border: '#E0E4EB',
  borderSoft: '#EAEFF5',
  fg: '#0F1729',
  muted: '#64748B',
  faint: '#94A3B8',
  primary: '#2563EB',
  emerald: '#059669',
  destructive: '#DC2626',
  font: "'Geist', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif",
  mono: "'Geist Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
};

/* ── Stand-ins for @/lib/constants/platform + @/lib/utils/currency ────────── */
const PLATFORM_PRICING = {
  CURRENCY_SYMBOL: 'A$',
  MARKUP_MULTIPLIER: 1.25,
  MARKUP_LABEL: '25%', // the markup ON the expert's rate — unchanged, still correct for that use
  MAX_RATE_DOLLARS: 50, // per minute — stand-in value
};
/** NEW — Balo's fee as a share of the CLIENT price, derived (never hardcoded): 1 - 1/1.25 = 20%. */
const SERVICE_FEE_SHARE_LABEL = `${Math.round((1 - 1 / PLATFORM_PRICING.MARKUP_MULTIPLIER) * 100)}%`;
const dollarsToCents = (d) => Math.round(d * 100);
const centsToDollars = (c) => c / 100;
const formatCurrency = (c) => `${PLATFORM_PRICING.CURRENCY_SYMBOL}${centsToDollars(c).toFixed(2)}`;
const calculateClientRate = (c) => Math.round(c * PLATFORM_PRICING.MARKUP_MULTIPLIER);
const perMinuteToPerHour = (c) => c * 60;
/** NEW — round UP so the expert never earns less than the hourly amount they typed. */
const perHourToPerMinuteCents = (perHourCents) => Math.ceil(perHourCents / 60);

/** The input's text for a stored per-minute cents value, in the given unit. */
function inputTextFor(cents, unit) {
  if (!cents) return '';
  const shown = unit === 'hour' ? perMinuteToPerHour(cents) : cents;
  return centsToDollars(shown).toFixed(2);
}

/* ── Primitives ───────────────────────────────────────────────────────────── */
function UnitToggle({ unit, onChange }) {
  const options = [
    { value: 'minute', label: 'Per minute' },
    { value: 'hour', label: 'Per hour' },
  ];
  return (
    <div
      role="radiogroup"
      aria-label="Enter your rate"
      style={{ display: 'inline-flex', gap: 3, padding: 3, borderRadius: 10, background: T.track }}
    >
      {options.map((o) => {
        const active = o.value === unit;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(o.value)}
            style={{
              minHeight: 32,
              padding: '0 12px',
              borderRadius: 8,
              border: 'none',
              fontFamily: T.font,
              fontSize: 12.5,
              fontWeight: 600,
              color: active ? T.fg : T.muted,
              background: active ? T.surface : 'transparent',
              boxShadow: active ? '0 1px 2px rgba(15,23,41,.08)' : 'none',
              cursor: 'pointer',
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function DesignNote({ children }) {
  return (
    <aside
      style={{
        marginTop: 16,
        padding: '10px 14px',
        borderRadius: 10,
        border: '1px dashed #E0A458',
        background: 'rgba(253,230,138,.18)',
        fontSize: 12.5,
        lineHeight: 1.55,
        color: '#7C4A12',
      }}
    >
      <strong style={{ fontWeight: 600 }}>Design note. </strong>
      {children}
    </aside>
  );
}

/* ═════════════════════════════════════════════════════════════════════════
 * RATE TAB
 * ════════════════════════════════════════════════════════════════════════ */

function RateTab({ initialRateCents, initialUnit = 'minute' }) {
  const [unit, setUnit] = useState(initialUnit);
  const [rateInput, setRateInput] = useState(() => inputTextFor(initialRateCents, initialUnit));
  const [savedCents, setSavedCents] = useState(initialRateCents);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState(null);

  // All derived, as in rate-tab.tsx.
  const enteredDollars = parseFloat(rateInput) || 0;
  const enteredCents = dollarsToCents(enteredDollars);
  const rateCents = unit === 'hour' ? perHourToPerMinuteCents(enteredCents) : enteredCents;
  const hourlyCents = perMinuteToPerHour(rateCents);
  const wasRounded = unit === 'hour' && enteredCents > 0 && hourlyCents !== enteredCents;
  const clientRateCents = calculateClientRate(rateCents);

  const maxCents = PLATFORM_PRICING.MAX_RATE_DOLLARS * 100;
  const validationError =
    rateCents > maxCents
      ? unit === 'hour'
        ? `Max rate is ${formatCurrency(perMinuteToPerHour(maxCents))}/hour`
        : `Max rate is ${formatCurrency(maxCents)}/min`
      : rateInput !== '' && rateCents <= 0
        ? 'Rate must be greater than zero'
        : null;

  const isSaveDisabled =
    saving || rateCents <= 0 || rateCents === (savedCents ?? 0) || validationError !== null;

  function handleRateChange(e) {
    const value = e.target.value;
    if (value === '' || /^\d*\.?\d{0,2}$/.test(value)) setRateInput(value);
  }

  function handleUnitChange(next) {
    if (next === unit) return;
    // Re-render FROM cents, never from the typed text: a toggle can't change the rate.
    setRateInput(rateInput === '' ? '' : inputTextFor(rateCents, next));
    setUnit(next);
  }

  function handleSave() {
    if (isSaveDisabled) return;
    setSaving(true);
    // track(EXPERT_RATE_EVENTS.RATE_SAVED, { rate_per_minute_cents: rateCents,
    //   is_initial_setup: !savedCents, input_unit: unit, was_rounded: wasRounded });
    setTimeout(() => {
      setSavedCents(rateCents);
      setSaving(false);
      setToast(
        unit === 'hour'
          ? `Rate saved — ${formatCurrency(hourlyCents)}/hour`
          : `Rate saved — ${formatCurrency(rateCents)}/min`
      );
      setTimeout(() => setToast(null), 2600);
    }, 600);
  }

  // The line under the input: the other unit, or the rounding explanation.
  let conversion = null;
  if (rateCents > 0) {
    if (unit === 'minute') {
      conversion = (
        <>
          That’s <strong style={{ color: T.fg }}>{formatCurrency(hourlyCents)}/hour</strong>{' '}
          take-home
        </>
      );
    } else if (wasRounded) {
      conversion = (
        <>
          You’re paid per minute, so this saves as{' '}
          <strong style={{ color: T.fg }}>{formatCurrency(rateCents)}/minute</strong> (
          {formatCurrency(hourlyCents)}/hour) take-home
        </>
      );
    } else {
      conversion = (
        <>
          That’s <strong style={{ color: T.fg }}>{formatCurrency(rateCents)}/minute</strong>{' '}
          take-home
        </>
      );
    }
  }

  return (
    <div style={{ maxWidth: 620 }}>
      {/* Header — SettingsPageHeader, description no longer says "per minute" */}
      <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start', marginBottom: 32 }}>
        <span
          aria-hidden="true"
          style={{
            width: 40,
            height: 40,
            borderRadius: 11,
            flex: '0 0 auto',
            display: 'grid',
            placeItems: 'center',
            color: T.emerald,
            background: 'rgba(5,150,105,.08)',
            border: '1px solid rgba(5,150,105,.18)',
          }}
        >
          <DollarSign size={19} />
        </span>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600, letterSpacing: '-0.01em' }}>
            Set Your Rate
          </h1>
          <p style={{ margin: '4px 0 0', fontSize: 14, color: T.muted, lineHeight: 1.55 }}>
            This is your take-home rate. Clients see a higher rate that includes Balo’s service fee.
          </p>
        </div>
      </div>

      <section
        style={{
          background: T.surface,
          border: `1px solid ${T.border}`,
          borderRadius: 16,
          padding: 32,
          boxShadow: '0 1px 2px rgba(15,23,41,.04)',
        }}
      >
        {/* Card header row — NEW: unit toggle on the right */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            flexWrap: 'wrap',
          }}
        >
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              fontSize: 14,
              fontWeight: 600,
            }}
          >
            <DollarSign size={16} color={T.emerald} aria-hidden="true" /> Your Rate
          </span>
          <UnitToggle unit={unit} onChange={handleUnitChange} />
        </div>

        {/* Oversized input row */}
        <div
          style={{
            marginTop: 14,
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            flexWrap: 'wrap',
          }}
        >
          <span style={{ fontSize: 32, fontWeight: 600 }}>A$</span>
          <input
            type="text"
            inputMode="decimal"
            value={rateInput}
            onChange={handleRateChange}
            placeholder="0.00"
            aria-label={unit === 'hour' ? 'Rate per hour in dollars' : 'Rate per minute in dollars'}
            aria-describedby="rate-conversion"
            style={{
              width: unit === 'hour' ? 230 : 180,
              border: 'none',
              borderBottom: `3px solid ${T.primary}`,
              background: 'transparent',
              textAlign: 'center',
              fontFamily: T.mono,
              fontVariantNumeric: 'tabular-nums',
              fontSize: 48,
              fontWeight: 600,
              color: T.fg,
              outline: 'none',
              padding: '2px 0',
            }}
          />
          <span style={{ fontSize: 16, fontWeight: 500, color: T.muted }}>
            {unit === 'hour' ? '/ hour' : '/ minute'}
          </span>
        </div>

        {validationError && (
          <p role="alert" style={{ margin: '8px 0 0', fontSize: 14, color: T.destructive }}>
            {validationError}
          </p>
        )}

        <p
          id="rate-conversion"
          aria-live="polite"
          style={{
            margin: '12px 0 0',
            minHeight: 22,
            fontSize: 14,
            color: T.muted,
            lineHeight: 1.55,
            display: 'flex',
            gap: 7,
            alignItems: 'flex-start',
          }}
        >
          {wasRounded && (
            <Info
              size={15}
              color={T.primary}
              style={{ flex: '0 0 auto', marginTop: 3 }}
              aria-hidden="true"
            />
          )}
          <span>{conversion}</span>
        </p>

        <div style={{ height: 1, background: T.borderSoft, margin: '24px 0' }} />

        {/* What clients see — unchanged from rate-tab.tsx except the fee line */}
        <div
          style={{
            padding: 20,
            borderRadius: 12,
            border: '1px solid rgba(37,99,235,.15)',
            background: 'linear-gradient(135deg, rgba(37,99,235,.05), rgba(37,99,235,.10))',
          }}
        >
          <p
            style={{
              margin: 0,
              fontSize: 12,
              fontWeight: 600,
              letterSpacing: '.06em',
              textTransform: 'uppercase',
              color: T.primary,
            }}
          >
            What clients see
          </p>
          <div
            style={{
              marginTop: 10,
              display: 'flex',
              alignItems: 'baseline',
              justifyContent: 'space-between',
              gap: 12,
              flexWrap: 'wrap',
            }}
          >
            <div>
              <span style={{ fontSize: 28, fontWeight: 600 }}>
                {formatCurrency(clientRateCents)}
              </span>
              <span style={{ fontSize: 14, color: T.muted, marginLeft: 4 }}>/ minute</span>
            </div>
            <span style={{ fontSize: 14, color: T.muted }}>
              {formatCurrency(perMinuteToPerHour(clientRateCents))}/hour
            </span>
          </div>
          <p style={{ margin: '8px 0 0', fontSize: 12, color: T.muted }}>
            Includes Balo’s {SERVICE_FEE_SHARE_LABEL} service fee
          </p>
        </div>
      </section>

      {/* Quick math box — REMOVED. Save sits directly under the card. */}
      <div style={{ marginTop: 28, textAlign: 'center' }}>
        <button
          type="button"
          onClick={handleSave}
          disabled={isSaveDisabled}
          style={{
            minHeight: 44,
            padding: '0 22px',
            borderRadius: 10,
            border: 'none',
            background: T.primary,
            color: '#fff',
            fontFamily: T.font,
            fontSize: 14,
            fontWeight: 600,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            cursor: isSaveDisabled ? 'not-allowed' : 'pointer',
            opacity: isSaveDisabled ? 0.5 : 1,
          }}
        >
          {saving ? (
            'Saving...'
          ) : (
            <>
              Save rate <Check size={16} aria-hidden="true" />
            </>
          )}
        </button>
      </div>

      {toast && (
        <div
          role="status"
          style={{
            position: 'fixed',
            right: 24,
            bottom: 24,
            padding: '12px 16px',
            borderRadius: 10,
            background: T.surface,
            border: `1px solid ${T.border}`,
            boxShadow: '0 8px 24px rgba(15,23,41,.12)',
            fontSize: 13.5,
            fontWeight: 500,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <Check size={16} color={T.emerald} aria-hidden="true" /> {toast}
        </div>
      )}

      <DesignNote>
        Try A$200 per hour: it saves as A$3.34 per minute, which is A$200.40 an hour, and the line
        under the input says so before Save. A$150 and A$138 are exact, so no note. Switching units
        never enables Save; only a different saved rate does.
      </DesignNote>
    </div>
  );
}

/* ═════════════════════════════════════════════════════════════════════════
 * HARNESS — review affordance only, remove in implementation
 * ════════════════════════════════════════════════════════════════════════ */

const STARTS = [
  { value: 'unset', label: 'No rate yet', cents: null, unit: 'minute' },
  { value: 'saved', label: 'Saved A$2.30/min', cents: 230, unit: 'minute' },
  { value: 'hourly', label: 'Typing hourly', cents: 230, unit: 'hour' },
];

export default function ExpertRatePrototype() {
  const [start, setStart] = useState('saved');
  const [nonce, setNonce] = useState(0);
  const s = STARTS.find((x) => x.value === start);

  return (
    <div
      style={{
        minHeight: '100vh',
        background: T.bg,
        color: T.fg,
        fontFamily: T.font,
        padding: '24px 20px 80px',
      }}
    >
      <link
        rel="stylesheet"
        href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@500;600&display=swap"
      />
      <style>{`
        * { box-sizing: border-box; }
        button:focus-visible, input:focus-visible, select:focus-visible {
          outline: 2px solid ${T.primary};
          outline-offset: 2px;
        }
      `}</style>

      <div
        style={{
          maxWidth: 860,
          margin: '0 auto 24px',
          padding: 12,
          borderRadius: 12,
          border: `1px dashed ${T.border}`,
          background: T.surface,
          display: 'flex',
          gap: 12,
          alignItems: 'center',
          flexWrap: 'wrap',
          fontSize: 13,
        }}
      >
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontWeight: 600, color: T.muted }}>Start from</span>
          <select
            value={start}
            onChange={(e) => {
              setStart(e.target.value);
              setNonce((n) => n + 1);
            }}
            style={{
              minHeight: 34,
              padding: '0 8px',
              borderRadius: 8,
              border: `1px solid ${T.border}`,
              fontFamily: T.font,
              fontSize: 13,
            }}
          >
            {STARTS.map((x) => (
              <option key={x.value} value={x.value}>
                {x.label}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          onClick={() => setNonce((n) => n + 1)}
          style={{
            minHeight: 34,
            padding: '0 12px',
            borderRadius: 8,
            border: `1px solid ${T.border}`,
            background: T.surface,
            fontFamily: T.font,
            fontSize: 13,
            fontWeight: 600,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            cursor: 'pointer',
          }}
        >
          <RotateCcw size={14} aria-hidden="true" /> Reset
        </button>
      </div>

      <main style={{ maxWidth: 860, margin: '0 auto' }}>
        <RateTab key={`${start}-${nonce}`} initialRateCents={s.cents} initialUnit={s.unit} />
      </main>
    </div>
  );
}
