import React, { useState, useEffect, useRef } from 'react';
import {
  Wallet,
  Plus,
  Info,
  Clock,
  Gift,
  Radio,
  RotateCw,
  ChevronDown,
  ArrowUpRight,
} from 'lucide-react';

/**
 * Wallet / Balance Widget — Design Reference (ADR-1040, Client Credit System)
 * ---------------------------------------------------------------------------
 * The shared client-lens balance primitive. Embedded in the dashboard, the
 * purchase screen, in-session Case UI, and billing settings.
 *
 * Source of truth for CC. Every state is specced: healthy / low / zero /
 * stale-FX / promo-inclusive / in-consultation, plus loading + error.
 *
 * HARD BOUNDARY: client-lens only. Never renders on an expert/payout lens.
 * Currency: AUD is the real figure (matches invoice). The local figure is
 * rounded, indicative-only, presentation-layer — never used in any math.
 */

// ── Balo design tokens (unified visual language) ──────────────────────────
const T = {
  bg: '#F8FAFB',
  surface: '#FFFFFF',
  border: '#E0E4EB',
  borderSubtle: '#EAEFF5',
  ink: '#0F1729',
  ink2: '#1E293B',
  muted: '#64748B',
  faint: '#94A3B8',
  primary: '#2563EB',
  primaryTo: '#7C3AED',
  primaryLight: '#EFF6FF',
  primaryBorder: '#BFDBFE',
  amber: '#B45309',
  amberBg: '#FFFBEB',
  amberBorder: '#FDE68A',
  green: '#047857',
  greenBg: '#ECFDF5',
};
const GRAD = `linear-gradient(135deg, ${T.primary} 0%, ${T.primaryTo} 100%)`;
const FONT = "'DM Sans', ui-sans-serif, system-ui, -apple-system, sans-serif";

// Display-only indicative FX (mock daily cache). Rounded on display.
const FX = { USD: 0.642, GBP: 0.505, EUR: 0.592 };
const SYM = { USD: 'US$', GBP: '£', EUR: '€' };

const aud = (minor) =>
  'A$' +
  (minor / 100).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const indicative = (minor, ccy) =>
  '≈ ' + SYM[ccy] + Math.round((minor / 100) * FX[ccy]).toLocaleString('en-AU');

const DISCLOSURE = "Indicative only — you're charged in AUD; your bank sets the final rate.";

// ── Small pieces ──────────────────────────────────────────────────────────
function Eyebrow({ children, icon: Icon }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      {Icon && <Icon size={13} strokeWidth={2.4} style={{ color: T.faint }} />}
      <span
        style={{
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          color: T.faint,
        }}
      >
        {children}
      </span>
    </div>
  );
}

function Disclosure() {
  const [open, setOpen] = useState(false);
  return (
    <span
      style={{ position: 'relative', display: 'inline-flex' }}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label="How this estimate works"
        style={{
          border: 'none',
          background: 'none',
          padding: 0,
          cursor: 'pointer',
          display: 'inline-flex',
          color: T.faint,
        }}
      >
        <Info size={13} strokeWidth={2.2} />
      </button>
      {open && (
        <span
          role="tooltip"
          style={{
            position: 'absolute',
            bottom: '150%',
            left: '50%',
            transform: 'translateX(-50%)',
            width: 208,
            background: T.ink,
            color: '#E2E8F0',
            fontSize: 11.5,
            lineHeight: 1.45,
            padding: '9px 11px',
            borderRadius: 8,
            zIndex: 20,
            fontWeight: 500,
            boxShadow: '0 8px 24px rgba(15,23,41,0.28)',
          }}
        >
          {DISCLOSURE}
          <span
            style={{
              position: 'absolute',
              top: '100%',
              left: '50%',
              transform: 'translateX(-50%)',
              borderLeft: '5px solid transparent',
              borderRight: '5px solid transparent',
              borderTop: `5px solid ${T.ink}`,
            }}
          />
        </span>
      )}
    </span>
  );
}

function TopUpButton({ label = 'Top up', subtle = false, block = true }) {
  return (
    <button
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 7,
        width: block ? '100%' : 'auto',
        padding: '11px 16px',
        borderRadius: 10,
        cursor: 'pointer',
        fontFamily: FONT,
        fontSize: 14,
        fontWeight: 600,
        color: subtle ? T.primary : '#fff',
        background: subtle ? T.primaryLight : GRAD,
        border: subtle ? `1px solid ${T.primaryBorder}` : 'none',
        boxShadow: subtle ? 'none' : '0 1px 2px rgba(37,99,235,0.25)',
      }}
    >
      <Plus size={16} strokeWidth={2.6} /> {label}
    </button>
  );
}

// ── The widget primitive ──────────────────────────────────────────────────
function WalletWidget({ state, ccy, balanceMinor, promoMinor, ratePerMin, liveMinor }) {
  const showIndicative = ccy !== 'AUD' && state !== 'stale';
  const bal = state === 'session' ? liveMinor : balanceMinor;

  // shell
  const cardBase = {
    fontFamily: FONT,
    width: '100%',
    maxWidth: 380,
    background: T.surface,
    border: `1px solid ${T.border}`,
    borderRadius: 16,
    padding: 20,
    boxShadow: '0 1px 2px rgba(15,23,41,0.04), 0 6px 20px rgba(15,23,41,0.04)',
    position: 'relative',
    overflow: 'hidden',
  };

  // ── loading skeleton
  if (state === 'loading') {
    const bar = (w, h) => (
      <div
        style={{
          width: w,
          height: h,
          borderRadius: 6,
          background: `linear-gradient(90deg, ${T.borderSubtle} 25%, #F1F5F9 50%, ${T.borderSubtle} 75%)`,
          backgroundSize: '200% 100%',
          animation: 'shimmer 1.3s ease-in-out infinite',
        }}
      />
    );
    return (
      <div style={cardBase}>
        <style>{`@keyframes shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}`}</style>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {bar(64, 12)} {bar(150, 34)} {bar('100%', 42)}
        </div>
      </div>
    );
  }

  // ── error
  if (state === 'error') {
    return (
      <div style={cardBase}>
        <Eyebrow icon={Wallet}>Wallet</Eyebrow>
        <div
          style={{ marginTop: 14, color: T.ink2, fontSize: 14.5, fontWeight: 500, lineHeight: 1.5 }}
        >
          Balance didn't load. Nothing's wrong with your credit — this is on our side.
        </div>
        <button
          style={{
            marginTop: 16,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 7,
            padding: '9px 14px',
            borderRadius: 10,
            cursor: 'pointer',
            fontFamily: FONT,
            fontSize: 13.5,
            fontWeight: 600,
            color: T.ink2,
            background: '#fff',
            border: `1px solid ${T.border}`,
          }}
        >
          <RotateCw size={14} strokeWidth={2.4} /> Retry
        </button>
      </div>
    );
  }

  const isLow = state === 'low';
  const isZero = state === 'zero';
  const isSession = state === 'session';

  return (
    <div
      style={{
        ...cardBase,
        borderColor: isLow ? T.amberBorder : isSession ? T.primaryBorder : T.border,
      }}
    >
      {/* accent hairline for live session */}
      {isSession && (
        <div
          style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 3, background: GRAD }}
        />
      )}

      {/* header row */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <Eyebrow icon={Wallet}>Wallet</Eyebrow>
        {isSession && (
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 11.5,
              fontWeight: 700,
              color: T.primary,
              background: T.primaryLight,
              border: `1px solid ${T.primaryBorder}`,
              padding: '3px 9px',
              borderRadius: 999,
            }}
          >
            <Radio size={11} strokeWidth={2.6} className="pulse" /> In consultation
          </span>
        )}
        {isLow && (
          <span
            style={{
              fontSize: 11.5,
              fontWeight: 700,
              color: T.amber,
              background: T.amberBg,
              border: `1px solid ${T.amberBorder}`,
              padding: '3px 9px',
              borderRadius: 999,
            }}
          >
            Running low
          </span>
        )}
      </div>

      {/* balance */}
      <div style={{ marginTop: 14 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
          <span
            style={{
              fontSize: 34,
              fontWeight: 700,
              letterSpacing: '-0.02em',
              color: isZero ? T.faint : T.ink,
              fontVariantNumeric: 'tabular-nums',
              transition: 'color .2s',
            }}
          >
            {aud(bal)}
          </span>
          {showIndicative && (
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                fontSize: 14,
                fontWeight: 500,
                color: T.muted,
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {indicative(bal, ccy)} <Disclosure />
            </span>
          )}
        </div>

        {/* secondary lines */}
        {isSession && (
          <div style={{ marginTop: 6, fontSize: 13, color: T.muted, fontWeight: 500 }}>
            {aud(ratePerMin)}/min · counts down as you talk
          </div>
        )}
        {state === 'promo' && (
          <div
            style={{
              marginTop: 8,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 12.5,
              fontWeight: 600,
              color: T.green,
              background: T.greenBg,
              padding: '4px 9px',
              borderRadius: 8,
            }}
          >
            <Gift size={13} strokeWidth={2.4} /> Includes {aud(promoMinor)} promo credit
          </div>
        )}
        {isZero && (
          <div
            style={{ marginTop: 6, fontSize: 14, color: T.ink2, fontWeight: 500, lineHeight: 1.5 }}
          >
            Top up to start a consultation.
          </div>
        )}
      </div>

      {/* action */}
      <div style={{ marginTop: 18 }}>
        {isSession ? (
          <div
            style={{
              fontSize: 12.5,
              color: T.faint,
              fontWeight: 500,
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            <Clock size={13} strokeWidth={2.2} /> We'll give you a heads-up before it runs out.
          </div>
        ) : isZero ? (
          <TopUpButton label="Top up" />
        ) : isLow ? (
          <TopUpButton label="Top up" />
        ) : (
          <TopUpButton label="Top up" subtle />
        )}
      </div>
    </div>
  );
}

// ── Annotation (doubles as the CC spec per state) ─────────────────────────
const NOTES = {
  healthy: [
    'Resting, funded.',
    'AUD primary + rounded indicative secondary. Top-up is the quiet secondary style — present but not shouting.',
  ],
  low: [
    "Balance below the client's top-up threshold (default A$20).",
    "Amber, not red. 'Running low' — a fact, not a countdown. Top-up promotes to the primary style.",
  ],
  zero: [
    'No spendable balance.',
    "Invitation, not absence: 'Top up to start a consultation.' Never 'No balance / Nothing here.'",
  ],
  stale: [
    'Display FX cache >48h old.',
    'Indicative secondary is hidden — AUD shown alone. The real figure never waits on the FX feed. No error shown to the client.',
  ],
  promo: [
    'Wallet includes promotional credit.',
    'Promo shown as a subtle inclusion, not a separate wallet. Internally ring-fenced from overdraft auto-settlement (never auto-charge a card to cover promo that ran out).',
  ],
  session: [
    'Widget embedded during a live Case.',
    "'In consultation' pill, per-minute rate, live countdown. Warm pre-zero reassurance — no ticking clock, no 'overdraft'.",
  ],
  loading: ['Async fetch in flight.', 'Skeleton shimmer. Never blocks the surface behind it.'],
  error: [
    'Balance fetch failed.',
    "Reassure (credit is safe), own it (our side), offer Retry. No apology-spiral, no vague 'something went wrong'.",
  ],
};

// ── Playground ────────────────────────────────────────────────────────────
export default function App() {
  const [state, setState] = useState('healthy');
  const [ccy, setCcy] = useState('USD'); // region-auto default (outside GBP/EUR/USD → USD)
  const [live, setLive] = useState(4820);
  const timer = useRef(null);

  useEffect(() => {
    if (state === 'session') {
      timer.current = setInterval(() => setLive((v) => (v <= 0 ? 4820 : v - 15)), 220);
      return () => clearInterval(timer.current);
    }
    setLive(4820);
  }, [state]);

  const data =
    {
      healthy: { balanceMinor: 34700 },
      low: { balanceMinor: 1820 },
      zero: { balanceMinor: 0 },
      stale: { balanceMinor: 34700 },
      promo: { balanceMinor: 39700, promoMinor: 5000 },
      session: { balanceMinor: 4820, ratePerMin: 450, liveMinor: live },
      loading: {},
      error: {},
    }[state] || {};

  const states = [
    ['healthy', 'Healthy'],
    ['low', 'Low'],
    ['zero', 'Zero'],
    ['stale', 'Stale FX'],
    ['promo', 'Promo'],
    ['session', 'In consultation'],
    ['loading', 'Loading'],
    ['error', 'Error'],
  ];

  const tab = (active) => ({
    padding: '7px 13px',
    borderRadius: 9,
    cursor: 'pointer',
    fontFamily: FONT,
    fontSize: 13,
    fontWeight: 600,
    border: `1px solid ${active ? T.primaryBorder : T.border}`,
    color: active ? T.primary : T.muted,
    background: active ? T.primaryLight : '#fff',
    transition: 'all .15s',
  });

  const ccyDisabled = state === 'stale' || state === 'loading' || state === 'error';

  return (
    <div
      style={{
        fontFamily: FONT,
        background: T.bg,
        minHeight: '100vh',
        padding: '28px 20px',
        color: T.ink,
      }}
    >
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,600;9..40,700&display=swap');
        .pulse{animation:pulse 1.4s ease-in-out infinite}
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}
        *{box-sizing:border-box}
        select{-webkit-appearance:none;appearance:none}
      `}</style>

      <div style={{ maxWidth: 860, margin: '0 auto' }}>
        {/* header */}
        <div style={{ marginBottom: 20 }}>
          <Eyebrow>ADR-1040 · Design reference</Eyebrow>
          <h1
            style={{ margin: '8px 0 4px', fontSize: 24, fontWeight: 700, letterSpacing: '-0.02em' }}
          >
            Wallet / balance widget
          </h1>
          <p style={{ margin: 0, fontSize: 14.5, color: T.muted, lineHeight: 1.55, maxWidth: 620 }}>
            The shared client-lens balance primitive — reused on the dashboard, purchase screen,
            in-session Case UI, and billing settings. Client-lens only; never rendered on an expert
            view.
          </p>
        </div>

        {/* controls */}
        <div
          style={{
            background: '#fff',
            border: `1px solid ${T.border}`,
            borderRadius: 14,
            padding: 16,
            marginBottom: 20,
          }}
        >
          <div style={{ marginBottom: 10 }}>
            <Eyebrow>State</Eyebrow>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 16 }}>
            {states.map(([k, label]) => (
              <button key={k} style={tab(state === k)} onClick={() => setState(k)}>
                {label}
              </button>
            ))}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <Eyebrow>Indicative currency</Eyebrow>
            <div style={{ position: 'relative' }}>
              <select
                value={ccy}
                disabled={ccyDisabled}
                onChange={(e) => setCcy(e.target.value)}
                style={{
                  fontFamily: FONT,
                  fontSize: 13,
                  fontWeight: 600,
                  color: ccyDisabled ? T.faint : T.ink2,
                  background: ccyDisabled ? T.bg : '#fff',
                  border: `1px solid ${T.border}`,
                  borderRadius: 9,
                  padding: '7px 30px 7px 12px',
                  cursor: ccyDisabled ? 'not-allowed' : 'pointer',
                }}
              >
                <option value="USD">Auto (USD)</option>
                <option value="GBP">GBP</option>
                <option value="EUR">EUR</option>
                <option value="AUD">Hide — AUD only</option>
              </select>
              <ChevronDown
                size={15}
                strokeWidth={2.4}
                style={{
                  position: 'absolute',
                  right: 9,
                  top: '50%',
                  transform: 'translateY(-50%)',
                  color: T.faint,
                  pointerEvents: 'none',
                }}
              />
            </div>
            {ccyDisabled && state === 'stale' && (
              <span style={{ fontSize: 12, color: T.faint, fontWeight: 500 }}>
                Hidden automatically — rate &gt; 48h old
              </span>
            )}
          </div>
        </div>

        {/* stage */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(280px, 360px) 1fr',
            gap: 20,
            alignItems: 'start',
          }}
          className="stage"
        >
          <style>{`@media(max-width:680px){.stage{grid-template-columns:1fr !important}}`}</style>

          <WalletWidget state={state} ccy={ccy} {...data} />

          <div
            style={{
              background: '#fff',
              border: `1px solid ${T.borderSubtle}`,
              borderRadius: 14,
              padding: 18,
              alignSelf: 'stretch',
            }}
          >
            <Eyebrow icon={ArrowUpRight}>Behaviour &amp; copy</Eyebrow>
            <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
              {(NOTES[state] || []).map((n, i) => (
                <p
                  key={i}
                  style={{
                    margin: 0,
                    fontSize: 13.5,
                    lineHeight: 1.55,
                    color: i === 0 ? T.ink2 : T.muted,
                    fontWeight: i === 0 ? 600 : 500,
                  }}
                >
                  {n}
                </p>
              ))}
            </div>
            <div
              style={{
                marginTop: 16,
                paddingTop: 14,
                borderTop: `1px solid ${T.borderSubtle}`,
                fontSize: 12,
                color: T.faint,
                lineHeight: 1.5,
                fontWeight: 500,
              }}
            >
              AUD is the real figure and matches the invoice. The local figure is rounded,
              indicative-only, and never enters any calculation.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
