import React, { useState, useEffect, useRef } from 'react';
import {
  Wallet,
  Gift,
  CreditCard,
  FileText,
  Zap,
  Radio,
  Bell,
  Sparkles,
  ArrowRight,
  X,
  RotateCw,
  Info,
  Clock,
} from 'lucide-react';

/**
 * Purchase / Buy-Credits Screen — Design Reference (ADR-1040)  ·  v3
 * ----------------------------------------------------------------------------
 * Time-first top-up. The dark hero translates the amount into hours of expert
 * time and counts up live. Slider snaps to $100s, shifts colour as you push
 * right, and turns green at the $5,000 mark with encouraging copy.
 *
 * Rate: A$3/min (A$180/hr) — the real average. Time is an estimate; the actual
 * rate depends on the expert booked. Presentation-only, never used in math.
 * Promo codes validate when typed but are NOT advertised on-screen. Substance
 * (promo, mandate fork, funding gating, honest estimate, no "overdraft") intact.
 */

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
  green: '#059669',
  greenBg: '#ECFDF5',
  greenBorder: '#A7F3D0',
  red: '#B91C1C',
  redBg: '#FEF2F2',
  redBorder: '#FECACA',
  heroTop: '#0F1729',
  heroBot: '#1E293B',
};
const GRAD = `linear-gradient(135deg, ${T.primary} 0%, ${T.primaryTo} 100%)`;
const FONT = "'DM Sans', ui-sans-serif, system-ui, -apple-system, sans-serif";

const FX_USD = 0.642; // indicative daily display rate (mock)
const RATE_MIN = 300; // A$3.00/min average expert rate, minor units
const MIN_AMT = 30000,
  MAX_AMT = 1000000,
  GOAL = 500000; // $300 · $10,000 · $5,000
const STEP = 10000; // snap to nearest $100

const aud = (m) =>
  'A$' + (m / 100).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const audShort = (m) => 'A$' + Math.round(m / 100).toLocaleString('en-AU');
const usd = (m) => 'US$' + Math.round((m / 100) * FX_USD).toLocaleString('en-AU');
const TIERS = [30000, 100000, 500000];
const PROMOS = { NEWTOBALO: 2500, WELCOME50: 5000 };

// minor $ -> "5 hr 33 min" at A$3/min
function timeStr(minor) {
  const mins = Math.round(minor / RATE_MIN);
  const h = Math.floor(mins / 60),
    m = mins % 60;
  if (h <= 0) return `${m} min`;
  if (m === 0) return `${h} hr`;
  return `${h} hr ${m} min`;
}
function lerpHex(a, b, t) {
  const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16));
  const pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16));
  const r = pa.map((v, i) => Math.round(v + (pb[i] - v) * t));
  return `rgb(${r[0]},${r[1]},${r[2]})`;
}
function useEased(target, ms = 500) {
  const [v, setV] = useState(target);
  const ref = useRef({ from: target, to: target, start: 0 });
  useEffect(() => {
    ref.current = { from: v, to: target, start: performance.now() };
    let raf;
    const tick = (now) => {
      const { from, to, start } = ref.current;
      const t = Math.min(1, (now - start) / ms);
      const e = 1 - Math.pow(1 - t, 3);
      setV(from + (to - from) * e);
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target]); // eslint-disable-line
  return v;
}

const Eyebrow = ({ children, icon: Icon, light }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
    {Icon && (
      <Icon
        size={13}
        strokeWidth={2.4}
        style={{ color: light ? 'rgba(255,255,255,0.5)' : T.faint }}
      />
    )}
    <span
      style={{
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: '0.09em',
        textTransform: 'uppercase',
        color: light ? 'rgba(255,255,255,0.55)' : T.faint,
      }}
    >
      {children}
    </span>
  </div>
);
const SectionLabel = ({ children }) => (
  <div style={{ fontSize: 13.5, fontWeight: 700, color: T.ink2, marginBottom: 10 }}>{children}</div>
);
function Choice({ selected, disabled, onClick, children, style, goal }) {
  const bd = goal && selected ? T.green : selected && !disabled ? T.primary : T.border;
  const bg = disabled ? T.bg : goal && selected ? T.greenBg : selected ? T.primaryLight : '#fff';
  return (
    <button
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      style={{
        textAlign: 'left',
        fontFamily: FONT,
        cursor: disabled ? 'not-allowed' : 'pointer',
        background: bg,
        border: `1.5px solid ${bd}`,
        borderRadius: 12,
        padding: '13px 15px',
        transition: 'all .14s',
        opacity: disabled ? 0.6 : 1,
        width: '100%',
        ...style,
      }}
    >
      {children}
    </button>
  );
}
const RadioDot = ({ on }) => (
  <span
    style={{
      width: 18,
      height: 18,
      borderRadius: 999,
      flexShrink: 0,
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      border: `2px solid ${on ? T.primary : T.border}`,
      background: on ? T.primary : '#fff',
    }}
  >
    {on && <span style={{ width: 7, height: 7, borderRadius: 999, background: '#fff' }} />}
  </span>
);
function Tip({ text, light }) {
  const [o, setO] = useState(false);
  return (
    <span
      style={{ position: 'relative', display: 'inline-flex' }}
      onMouseEnter={() => setO(true)}
      onMouseLeave={() => setO(false)}
    >
      <button
        onClick={() => setO((v) => !v)}
        aria-label="More info"
        style={{
          border: 'none',
          background: 'none',
          padding: 0,
          cursor: 'pointer',
          display: 'inline-flex',
          color: light ? 'rgba(255,255,255,0.6)' : T.faint,
        }}
      >
        <Info size={13} strokeWidth={2.2} />
      </button>
      {o && (
        <span
          role="tooltip"
          style={{
            position: 'absolute',
            bottom: '150%',
            left: '50%',
            transform: 'translateX(-50%)',
            width: 216,
            background: '#000',
            color: '#E2E8F0',
            fontSize: 11.5,
            lineHeight: 1.45,
            padding: '9px 11px',
            borderRadius: 8,
            zIndex: 40,
            fontWeight: 500,
            boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
          }}
        >
          {text}
        </span>
      )}
    </span>
  );
}

export default function App() {
  const [screen, setScreen] = useState('loaded');
  const [funding, setFunding] = useState('card');
  const [amount, setAmount] = useState(100000);
  const [mode, setMode] = useState('keep_going');
  const [reload, setReload] = useState(30000);
  const [threshold, setThreshold] = useState(5000);
  const [promoIn, setPromoIn] = useState('');
  const [promo, setPromo] = useState(null);
  const [promoErr, setPromoErr] = useState('');

  const promoMinor = promo ? promo.minor : 0;
  const credited = amount + promoMinor;
  const shown = useEased(credited);
  const shownPay = useEased(amount);
  const needsMandate = mode === 'auto_topup' || mode === 'keep_going';
  const mandateBlocked = needsMandate && funding === 'invoice';
  const pct = ((amount - MIN_AMT) / (MAX_AMT - MIN_AMT)) * 100;

  // slider colour: shifts blue→teal→green as you push right; locks green at goal
  const hitGoal = amount >= GOAL;
  const p = Math.min(1, Math.max(0, (amount - MIN_AMT) / (GOAL - MIN_AMT)));
  const nearGoal = !hitGoal && amount >= 350000;
  const c1 = hitGoal ? '#059669' : lerpHex('#2563EB', '#0D9488', p * 0.7);
  const c2 = hitGoal ? '#10B981' : lerpHex('#7C3AED', '#10B981', p);

  const applyPromo = () => {
    const code = promoIn.trim().toUpperCase();
    if (!code) return;
    if (PROMOS[code]) {
      setPromo({ code, minor: PROMOS[code] });
      setPromoErr('');
      setPromoIn('');
    } else {
      setPromoErr("That code isn't valid. Check it and try again.");
      setPromo(null);
    }
  };

  const modes = [
    {
      id: 'auto_topup',
      icon: Zap,
      title: 'Auto top-up',
      desc: `Add ${audShort(reload)} whenever your balance drops below ${audShort(threshold)}.`,
    },
    {
      id: 'keep_going',
      icon: Radio,
      title: 'Keep me going',
      desc: "Don't interrupt sessions — settle any extra time to your card afterward.",
    },
    {
      id: 'notify_only',
      icon: Bell,
      title: 'Just notify me',
      desc: "Tell me when I'm running low. I'll top up myself.",
    },
  ];

  const shell = {
    fontFamily: FONT,
    background: T.surface,
    border: `1px solid ${T.border}`,
    borderRadius: 22,
    boxShadow: '0 1px 2px rgba(15,23,41,0.04), 0 18px 50px rgba(15,23,41,0.09)',
    overflow: 'hidden',
    maxWidth: 540,
    width: '100%',
  };

  const heroGrad = hitGoal
    ? 'linear-gradient(120deg,#fff 20%,#A7F3D0 58%,#6EE7B7 100%)'
    : 'linear-gradient(120deg,#fff 20%,#BFDBFE 60%,#DDD6FE 100%)';

  const Screen = () => {
    if (screen === 'loading') {
      const bar = (w, h, mt = 0, dark) => (
        <div
          style={{
            width: w,
            height: h,
            marginTop: mt,
            borderRadius: 8,
            background: dark
              ? 'rgba(255,255,255,0.08)'
              : `linear-gradient(90deg, ${T.borderSubtle} 25%, #F1F5F9 50%, ${T.borderSubtle} 75%)`,
            backgroundSize: '200% 100%',
            animation: 'shimmer 1.3s ease-in-out infinite',
          }}
        />
      );
      return (
        <div style={shell}>
          <div
            style={{
              background: `linear-gradient(160deg, ${T.heroTop}, ${T.heroBot})`,
              padding: 28,
            }}
          >
            {bar(110, 12, 0, true)} {bar(230, 44, 16, true)} {bar(150, 14, 14, true)}
          </div>
          <div style={{ padding: 24 }}>
            {bar('100%', 56)} {bar('100%', 120, 16)} {bar('100%', 50, 16)}
          </div>
        </div>
      );
    }
    if (screen === 'error') {
      return (
        <div style={shell}>
          <div style={{ padding: 30 }}>
            <Eyebrow icon={Wallet}>Top up</Eyebrow>
            <div
              style={{
                marginTop: 14,
                fontSize: 15.5,
                fontWeight: 500,
                color: T.ink2,
                lineHeight: 1.55,
              }}
            >
              We couldn't load the top-up options. Your balance and saved details are safe — this is
              on our side.
            </div>
            <button
              style={{
                marginTop: 18,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 7,
                padding: '10px 15px',
                borderRadius: 11,
                cursor: 'pointer',
                fontFamily: FONT,
                fontSize: 14,
                fontWeight: 600,
                color: T.ink2,
                background: '#fff',
                border: `1px solid ${T.border}`,
              }}
            >
              <RotateCw size={15} strokeWidth={2.4} /> Retry
            </button>
          </div>
        </div>
      );
    }

    return (
      <div style={shell}>
        {/* DARK HERO */}
        <div
          style={{
            position: 'relative',
            overflow: 'hidden',
            background: `linear-gradient(160deg, ${T.heroTop} 0%, ${T.heroBot} 100%)`,
            padding: '26px 28px 30px',
          }}
        >
          <div
            className="glow g1"
            style={{
              position: 'absolute',
              width: 260,
              height: 260,
              borderRadius: '50%',
              background: `radial-gradient(circle, ${hitGoal ? 'rgba(16,185,129,0.4)' : 'rgba(37,99,235,0.45)'}, transparent 68%)`,
              top: -110,
              right: -60,
              filter: 'blur(6px)',
              transition: 'background .5s',
            }}
          />
          <div
            className="glow g2"
            style={{
              position: 'absolute',
              width: 220,
              height: 220,
              borderRadius: '50%',
              background: `radial-gradient(circle, ${hitGoal ? 'rgba(52,211,153,0.34)' : 'rgba(124,58,237,0.4)'}, transparent 68%)`,
              bottom: -120,
              left: -40,
              filter: 'blur(6px)',
              transition: 'background .5s',
            }}
          />
          <div style={{ position: 'relative' }}>
            <Eyebrow icon={Sparkles} light>
              Your top-up buys
            </Eyebrow>
            <div
              style={{
                display: 'flex',
                alignItems: 'baseline',
                gap: 10,
                marginTop: 12,
                flexWrap: 'wrap',
              }}
            >
              <span
                style={{
                  fontSize: 44,
                  fontWeight: 700,
                  letterSpacing: '-0.03em',
                  lineHeight: 1,
                  background: heroGrad,
                  WebkitBackgroundClip: 'text',
                  backgroundClip: 'text',
                  WebkitTextFillColor: 'transparent',
                  fontVariantNumeric: 'tabular-nums',
                  transition: 'background .4s',
                }}
              >
                ≈ {timeStr(shown)}
              </span>
              <span
                style={{
                  fontSize: 14,
                  fontWeight: 600,
                  color: 'rgba(255,255,255,0.6)',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 5,
                }}
              >
                of expert time{' '}
                <Tip
                  light
                  text="An estimate at the average expert rate of A$3/min. Your actual time depends on the expert you book."
                />
              </span>
            </div>
            <div
              style={{
                marginTop: 10,
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                flexWrap: 'wrap',
              }}
            >
              <span
                style={{
                  fontSize: 15,
                  fontWeight: 600,
                  color: '#fff',
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                {aud(shownPay)}
              </span>
              {funding === 'card' && (
                <span style={{ fontSize: 13, fontWeight: 500, color: 'rgba(255,255,255,0.5)' }}>
                  ≈ {usd(amount)}
                </span>
              )}
              {promo && (
                <span
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 5,
                    fontSize: 12,
                    fontWeight: 700,
                    color: '#6EE7B7',
                    background: 'rgba(16,185,129,0.14)',
                    border: '1px solid rgba(16,185,129,0.3)',
                    padding: '2px 8px',
                    borderRadius: 999,
                  }}
                >
                  <Gift size={12} strokeWidth={2.6} /> +{audShort(promo.minor)} promo
                </span>
              )}
            </div>
          </div>
        </div>

        {/* amount: slider + quick picks */}
        <div style={{ padding: '22px 24px 6px' }}>
          <SectionLabel>Choose an amount</SectionLabel>
          <input
            className={`amt-range${hitGoal ? ' goal' : ''}`}
            type="range"
            min={MIN_AMT}
            max={MAX_AMT}
            step={STEP}
            value={amount}
            onChange={(e) => setAmount(parseInt(e.target.value, 10))}
            aria-label="Top-up amount"
            style={{
              width: '100%',
              backgroundColor: T.border,
              backgroundImage: `linear-gradient(90deg, ${c1}, ${c2})`,
              backgroundRepeat: 'no-repeat',
              backgroundSize: `${pct}% 100%`,
            }}
          />
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              marginTop: 6,
              fontSize: 11,
              fontWeight: 600,
              color: T.faint,
            }}
          >
            <span>{audShort(MIN_AMT)}</span>
            <span>{audShort(MAX_AMT)}</span>
          </div>

          {/* encouraging / congratulatory caption */}
          <div style={{ marginTop: 10, minHeight: 20 }}>
            {hitGoal ? (
              <div
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 7,
                  fontSize: 12.5,
                  fontWeight: 600,
                  color: T.green,
                  background: T.greenBg,
                  border: `1px solid ${T.greenBorder}`,
                  padding: '6px 11px',
                  borderRadius: 9,
                }}
              >
                <Sparkles size={14} strokeWidth={2.5} /> Nice — {timeStr(credited)} of expert time,
                ready whenever you need it.
              </div>
            ) : (
              <div style={{ fontSize: 12.5, fontWeight: 500, color: nearGoal ? T.ink2 : T.faint }}>
                {nearGoal
                  ? 'Almost there — a little more unlocks your biggest block of time →'
                  : 'Slide right — the more you add, the more expert time on tap →'}
              </div>
            )}
          </div>

          <div
            style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, marginTop: 14 }}
          >
            {TIERS.map((t) => {
              const g = t === GOAL;
              return (
                <Choice
                  key={t}
                  selected={amount === t}
                  goal={g}
                  onClick={() => setAmount(t)}
                  style={{ textAlign: 'center', padding: '12px 6px' }}
                >
                  <div style={{ fontSize: 16, fontWeight: 700, color: T.ink }}>{audShort(t)}</div>
                  <div
                    style={{
                      fontSize: 11,
                      fontWeight: 600,
                      marginTop: 3,
                      color: amount === t ? (g ? T.green : T.primary) : T.faint,
                    }}
                  >
                    ~{timeStr(t)}
                  </div>
                </Choice>
              );
            })}
          </div>
        </div>

        <div
          style={{ padding: '16px 24px 24px', display: 'flex', flexDirection: 'column', gap: 20 }}
        >
          {/* promo (no code hints) */}
          <div>
            <SectionLabel>Promo code</SectionLabel>
            {promo ? (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 10,
                  background: T.greenBg,
                  border: `1px solid ${T.greenBorder}`,
                  borderRadius: 11,
                  padding: '12px 14px',
                }}
              >
                <span
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 8,
                    fontSize: 13.5,
                    fontWeight: 600,
                    color: T.green,
                  }}
                >
                  <Gift size={15} strokeWidth={2.4} /> {promo.code} applied —{' '}
                  {audShort(promo.minor)} bonus credit
                </span>
                <button
                  onClick={() => setPromo(null)}
                  aria-label="Remove promo"
                  style={{
                    border: 'none',
                    background: 'none',
                    cursor: 'pointer',
                    color: T.green,
                    display: 'inline-flex',
                  }}
                >
                  <X size={16} strokeWidth={2.4} />
                </button>
              </div>
            ) : (
              <>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    value={promoIn}
                    onChange={(e) => {
                      setPromoIn(e.target.value);
                      setPromoErr('');
                    }}
                    placeholder="Have a code? Enter it here"
                    onKeyDown={(e) => e.key === 'Enter' && applyPromo()}
                    style={{
                      flex: 1,
                      fontFamily: FONT,
                      fontSize: 14,
                      fontWeight: 500,
                      color: T.ink,
                      padding: '12px 14px',
                      borderRadius: 11,
                      outline: 'none',
                      border: `1.5px solid ${promoErr ? T.redBorder : T.border}`,
                      background: promoErr ? T.redBg : '#fff',
                      textTransform: 'uppercase',
                    }}
                  />
                  <button
                    onClick={applyPromo}
                    style={{
                      fontFamily: FONT,
                      fontSize: 14,
                      fontWeight: 600,
                      color: promoIn.trim() ? T.primary : T.faint,
                      background: promoIn.trim() ? T.primaryLight : T.bg,
                      border: `1px solid ${promoIn.trim() ? T.primaryBorder : T.border}`,
                      borderRadius: 11,
                      padding: '0 18px',
                      cursor: promoIn.trim() ? 'pointer' : 'default',
                    }}
                  >
                    Apply
                  </button>
                </div>
                {promoErr && (
                  <div style={{ marginTop: 7, fontSize: 12.5, color: T.red, fontWeight: 500 }}>
                    {promoErr}
                  </div>
                )}
              </>
            )}
          </div>

          {/* funding */}
          <div>
            <SectionLabel>Pay with</SectionLabel>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <Choice selected={funding === 'card'} onClick={() => setFunding('card')}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                  <CreditCard
                    size={17}
                    strokeWidth={2.2}
                    style={{ color: funding === 'card' ? T.primary : T.muted }}
                  />
                  <span style={{ fontSize: 14, fontWeight: 600, color: T.ink2 }}>Card</span>
                </div>
              </Choice>
              <Choice selected={funding === 'invoice'} onClick={() => setFunding('invoice')}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                  <FileText
                    size={17}
                    strokeWidth={2.2}
                    style={{ color: funding === 'invoice' ? T.primary : T.muted }}
                  />
                  <span style={{ fontSize: 14, fontWeight: 600, color: T.ink2 }}>
                    Invoice / transfer
                  </span>
                </div>
              </Choice>
            </div>
          </div>

          {/* modes */}
          <div>
            <SectionLabel>When your balance runs low</SectionLabel>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
              {modes.map((m) => {
                const blocked =
                  (m.id === 'auto_topup' || m.id === 'keep_going') && funding === 'invoice';
                const sel = mode === m.id && !blocked;
                return (
                  <Choice
                    key={m.id}
                    selected={sel}
                    disabled={blocked}
                    onClick={() => setMode(m.id)}
                  >
                    <div style={{ display: 'flex', gap: 11, alignItems: 'flex-start' }}>
                      <div style={{ marginTop: 1 }}>
                        <RadioDot on={sel} />
                      </div>
                      <div style={{ flex: 1 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                          <m.icon
                            size={15}
                            strokeWidth={2.3}
                            style={{ color: sel ? T.primary : T.muted }}
                          />
                          <span style={{ fontSize: 14, fontWeight: 600, color: T.ink2 }}>
                            {m.title}
                          </span>
                        </div>
                        <div
                          style={{
                            marginTop: 3,
                            fontSize: 12.5,
                            color: T.muted,
                            fontWeight: 500,
                            lineHeight: 1.45,
                          }}
                        >
                          {m.desc}
                        </div>
                        {blocked && (
                          <div
                            style={{
                              marginTop: 6,
                              fontSize: 11.5,
                              color: T.amber,
                              fontWeight: 600,
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: 5,
                              background: T.amberBg,
                              border: `1px solid ${T.amberBorder}`,
                              padding: '3px 8px',
                              borderRadius: 7,
                            }}
                          >
                            Add a card to use this
                          </div>
                        )}
                      </div>
                    </div>
                  </Choice>
                );
              })}
            </div>

            {mode === 'auto_topup' && !mandateBlocked && (
              <div
                style={{
                  marginTop: 10,
                  display: 'flex',
                  gap: 10,
                  flexWrap: 'wrap',
                  background: T.bg,
                  border: `1px solid ${T.borderSubtle}`,
                  borderRadius: 11,
                  padding: 12,
                }}
              >
                {[
                  ['Add', reload, setReload],
                  ['When below', threshold, setThreshold],
                ].map(([lbl, val, set], i) => (
                  <label key={i} style={{ flex: 1, minWidth: 120 }}>
                    <span
                      style={{
                        fontSize: 11,
                        fontWeight: 700,
                        color: T.faint,
                        textTransform: 'uppercase',
                        letterSpacing: '0.06em',
                      }}
                    >
                      {lbl}
                    </span>
                    <div style={{ position: 'relative', marginTop: 5 }}>
                      <span
                        style={{
                          position: 'absolute',
                          left: 11,
                          top: '50%',
                          transform: 'translateY(-50%)',
                          fontSize: 13,
                          fontWeight: 600,
                          color: T.faint,
                        }}
                      >
                        A$
                      </span>
                      <input
                        value={(val / 100).toString()}
                        inputMode="decimal"
                        onChange={(e) =>
                          set(
                            Math.round(
                              (parseFloat(e.target.value.replace(/[^0-9.]/g, '')) || 0) * 100
                            )
                          )
                        }
                        style={{
                          width: '100%',
                          fontFamily: FONT,
                          fontSize: 13.5,
                          fontWeight: 600,
                          color: T.ink,
                          padding: '9px 11px 9px 30px',
                          borderRadius: 9,
                          border: `1px solid ${T.border}`,
                          outline: 'none',
                          background: '#fff',
                        }}
                      />
                    </div>
                  </label>
                ))}
              </div>
            )}

            {needsMandate && funding === 'card' && (
              <div
                style={{
                  marginTop: 10,
                  fontSize: 11.5,
                  color: T.muted,
                  fontWeight: 500,
                  lineHeight: 1.5,
                  display: 'flex',
                  gap: 7,
                }}
              >
                <Info
                  size={13}
                  strokeWidth={2.2}
                  style={{ color: T.faint, flexShrink: 0, marginTop: 1 }}
                />
                <span>
                  You're letting Balo charge this card for consultation time beyond your balance and
                  for automatic top-ups, per your settings above. Change or turn this off anytime.
                </span>
              </div>
            )}
          </div>
        </div>

        {/* pay */}
        <div
          style={{
            padding: '18px 24px 22px',
            borderTop: `1px solid ${T.borderSubtle}`,
            background: '#FCFDFE',
          }}
        >
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'baseline',
              marginBottom: 13,
            }}
          >
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 13,
                fontWeight: 600,
                color: T.muted,
              }}
            >
              <Clock size={13} strokeWidth={2.3} /> Buys ≈ {timeStr(credited)}
            </span>
            <span style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
              <span
                style={{
                  fontSize: 21,
                  fontWeight: 700,
                  color: T.ink,
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                {aud(amount)}
              </span>
              {funding === 'card' && (
                <span style={{ fontSize: 12.5, color: T.muted, fontWeight: 500 }}>
                  ≈ {usd(amount)}
                </span>
              )}
            </span>
          </div>
          <button
            style={{
              width: '100%',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              padding: '15px 18px',
              borderRadius: 13,
              cursor: 'pointer',
              fontFamily: FONT,
              fontSize: 15,
              fontWeight: 600,
              color: '#fff',
              border: 'none',
              background: GRAD,
              boxShadow: '0 3px 12px rgba(37,99,235,0.32)',
            }}
          >
            {funding === 'invoice' ? (
              'Request invoice'
            ) : (
              <>
                Pay {aud(amount)} <ArrowRight size={17} strokeWidth={2.6} />
              </>
            )}
          </button>
          {funding === 'card' && (
            <div
              style={{
                marginTop: 9,
                fontSize: 11.5,
                color: T.faint,
                fontWeight: 500,
                textAlign: 'center',
                lineHeight: 1.45,
              }}
            >
              You'll be charged approximately {usd(amount)} in your local currency — the final
              amount is set at payment.
            </div>
          )}
        </div>
      </div>
    );
  };

  const notes = [
    [
      'Time is the hero',
      'Hours with an expert, not abstract credit. The dark hero counts up live as you drag or pick a tier.',
    ],
    [
      'Slider reward',
      "Snaps to $100s across $300–$10,000. The fill shifts blue→teal→green as you push right and turns green at $5,000 with a warm 'nice choice' line — encouraging, not a hard sell.",
    ],
    [
      'Honest estimate',
      "Time uses the A$3/min average with an explicit tooltip; real time depends on the expert booked. Both time and '≈ US$' are presentation-only, never used in math.",
    ],
    [
      'Promo, unadvertised',
      "The field validates real codes but no codes are hinted on-screen — so only people who have one enter one. Bonus credit lifts the hero's hours; internally ring-fenced from overdraft settlement.",
    ],
    [
      'Mandate fork',
      "'Auto top-up' + 'Keep me going' capture one off-session card mandate. Invoice/transfer disables them with a warm note. 'Overdraft' never appears.",
    ],
  ];

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
        @keyframes shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}
        @keyframes float1{0%,100%{transform:translate(0,0)}50%{transform:translate(-16px,14px)}}
        @keyframes float2{0%,100%{transform:translate(0,0)}50%{transform:translate(14px,-12px)}}
        .glow.g1{animation:float1 9s ease-in-out infinite}
        .glow.g2{animation:float2 11s ease-in-out infinite}
        *{box-sizing:border-box}
        input::placeholder{color:${T.faint};text-transform:none}
        .amt-range{-webkit-appearance:none;appearance:none;height:9px;border-radius:999px;cursor:pointer;outline:none;}
        .amt-range::-webkit-slider-thumb{-webkit-appearance:none;width:22px;height:22px;border-radius:999px;
          background:linear-gradient(135deg,${T.primary},${T.primaryTo});border:3px solid #fff;cursor:grab;
          box-shadow:0 2px 10px rgba(37,99,235,0.5);transition:box-shadow .2s;}
        .amt-range.goal::-webkit-slider-thumb{background:linear-gradient(135deg,#059669,#10B981);
          box-shadow:0 0 0 4px rgba(16,185,129,0.18),0 2px 12px rgba(5,150,105,0.55);}
        .amt-range::-webkit-slider-thumb:active{cursor:grabbing;transform:scale(1.08);}
        .amt-range::-moz-range-thumb{width:20px;height:20px;border-radius:999px;
          background:linear-gradient(135deg,${T.primary},${T.primaryTo});border:3px solid #fff;cursor:grab;
          box-shadow:0 2px 10px rgba(37,99,235,0.5);}
        .amt-range.goal::-moz-range-thumb{background:linear-gradient(135deg,#059669,#10B981);
          box-shadow:0 0 0 4px rgba(16,185,129,0.18),0 2px 12px rgba(5,150,105,0.55);}
        @media(prefers-reduced-motion:reduce){.glow{animation:none!important}}
      `}</style>

      <div style={{ maxWidth: 980, margin: '0 auto' }}>
        <div style={{ marginBottom: 20 }}>
          <Eyebrow>ADR-1040 · Design reference</Eyebrow>
          <h1
            style={{ margin: '8px 0 4px', fontSize: 24, fontWeight: 700, letterSpacing: '-0.02em' }}
          >
            Purchase / buy credits
          </h1>
          <p style={{ margin: 0, fontSize: 14.5, color: T.muted, lineHeight: 1.55, maxWidth: 640 }}>
            Time-first top-up at A$3/min. Drag the slider (snaps to $100s) or pick a tier — the
            hours count up, and crossing $5,000 turns it green.
          </p>
        </div>

        <div style={{ display: 'flex', gap: 8, marginBottom: 20, flexWrap: 'wrap' }}>
          {[
            ['loaded', 'Loaded'],
            ['loading', 'Loading'],
            ['error', 'Error'],
          ].map(([k, l]) => (
            <button
              key={k}
              onClick={() => setScreen(k)}
              style={{
                padding: '7px 13px',
                borderRadius: 9,
                cursor: 'pointer',
                fontFamily: FONT,
                fontSize: 13,
                fontWeight: 600,
                border: `1px solid ${screen === k ? T.primaryBorder : T.border}`,
                color: screen === k ? T.primary : T.muted,
                background: screen === k ? T.primaryLight : '#fff',
              }}
            >
              {l}
            </button>
          ))}
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(0, 540px) 1fr',
            gap: 24,
            alignItems: 'start',
          }}
          className="stage"
        >
          <style>{`@media(max-width:780px){.stage{grid-template-columns:1fr !important}}`}</style>
          <Screen />
          <div
            style={{
              background: '#fff',
              border: `1px solid ${T.borderSubtle}`,
              borderRadius: 14,
              padding: 18,
            }}
          >
            <Eyebrow icon={Sparkles}>Behaviour &amp; copy</Eyebrow>
            <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 14 }}>
              {notes.map(([h, b], i) => (
                <div key={i}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: T.ink2 }}>{h}</div>
                  <div
                    style={{
                      marginTop: 3,
                      fontSize: 12.5,
                      color: T.muted,
                      fontWeight: 500,
                      lineHeight: 1.5,
                    }}
                  >
                    {b}
                  </div>
                </div>
              ))}
            </div>
            <div
              style={{
                marginTop: 16,
                paddingTop: 14,
                borderTop: `1px solid ${T.borderSubtle}`,
                fontSize: 11.5,
                color: T.faint,
                fontWeight: 500,
                lineHeight: 1.5,
              }}
            >
              Try: drag toward $5,000 and watch the fill turn green · switch to Invoice to disable
              the card-only modes.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
