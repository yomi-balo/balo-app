import React, { useState, useEffect, useRef } from 'react';
import {
  Gift,
  Zap,
  Radio,
  Bell,
  Sparkles,
  ArrowRight,
  X,
  Info,
  Clock,
  CreditCard,
  Lock,
  Monitor,
  Smartphone,
  Tag,
  ChevronDown,
  Check,
} from 'lucide-react';

/**
 * Top-up — summary-rail layout · prototype
 * ----------------------------------------------------------------------------
 * Left column: everything the client decides or types — amount, promo, low-
 * balance mode, and the payment method. Right column: a sticky rail carrying
 * the hero (time figure), totals, and the Pay CTA, so the argument for paying
 * never scrolls away from the button that does it.
 *
 * Payment method is conditional. Returning clients see a saved-card row;
 * first-timers see the Stripe Payment Element (mocked here — the real one is
 * an iframe served from Stripe's domain). Promo is a quiet link until needed.
 * "Pay with" is gone: invoice/transfer doesn't exist yet, and one option isn't
 * a choice. On mobile the rail becomes a sticky pay bar.
 *
 * Rate A$3/min average — presentation-only, never used in math.
 * Font: Geist (repo). Gradient text guarded by @supports.
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
const FONT = "'Geist', ui-sans-serif, system-ui, -apple-system, sans-serif";
const SF = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif";

const RATE_MIN = 300;
const MIN_AMT = 30000,
  MAX_AMT = 1000000,
  GOAL = 500000,
  STEP = 10000;
const TIERS = [30000, 100000, 500000];
const PROMOS = { NEWTOBALO: 2500, WELCOME50: 5000 };
const SAVED = { brand: 'Visa', last4: '4242', exp: '08/28' };

const aud = (m) =>
  'A$' + (m / 100).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const audShort = (m) => 'A$' + Math.round(m / 100).toLocaleString('en-AU');

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
function useWidth() {
  const [w, setW] = useState(typeof window !== 'undefined' ? window.innerWidth : 1200);
  useEffect(() => {
    const f = () => setW(window.innerWidth);
    window.addEventListener('resize', f);
    return () => window.removeEventListener('resize', f);
  }, []);
  return w;
}

/* ---------- shared bits ---------- */

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
function Choice({ selected, onClick, children, style, goal }) {
  const bd = goal && selected ? T.green : selected ? T.primary : T.border;
  const bg = goal && selected ? T.greenBg : selected ? T.primaryLight : '#fff';
  return (
    <button
      onClick={onClick}
      style={{
        textAlign: 'left',
        fontFamily: FONT,
        cursor: 'pointer',
        background: bg,
        border: `1.5px solid ${bd}`,
        borderRadius: 12,
        padding: '13px 15px',
        transition: 'all .14s',
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
            right: 0,
            width: 216,
            background: '#000',
            color: '#E2E8F0',
            fontSize: 11.5,
            lineHeight: 1.45,
            padding: '9px 11px',
            borderRadius: 8,
            zIndex: 40,
            fontWeight: 500,
            fontFamily: FONT,
            boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
          }}
        >
          {text}
        </span>
      )}
    </span>
  );
}
const LinkBtn = ({ children, onClick, icon: Icon, muted }) => (
  <button
    onClick={onClick}
    style={{
      background: 'none',
      border: 'none',
      padding: 0,
      cursor: 'pointer',
      fontFamily: FONT,
      fontSize: 13,
      fontWeight: 600,
      color: muted ? T.muted : T.primary,
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
    }}
  >
    {Icon && <Icon size={14} strokeWidth={2.4} />}
    {children}
  </button>
);
const Mark = ({ bg, children }) => (
  <span
    style={{
      width: 28,
      height: 18,
      borderRadius: 3,
      background: bg,
      color: '#fff',
      fontSize: 7.5,
      fontWeight: 800,
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      flexShrink: 0,
      letterSpacing: '0.03em',
      fontFamily: SF,
    }}
  >
    {children}
  </span>
);
const McMark = () => (
  <span
    style={{
      width: 28,
      height: 18,
      borderRadius: 3,
      background: '#000',
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      flexShrink: 0,
    }}
  >
    <span
      style={{ width: 9, height: 9, borderRadius: 999, background: '#EB001B', marginRight: -3 }}
    />
    <span style={{ width: 9, height: 9, borderRadius: 999, background: '#F79E1B', opacity: 0.9 }} />
  </span>
);

/* ---------- left column sections ---------- */

function AmountSection({ amount, setAmount, credited }) {
  const pct = ((amount - MIN_AMT) / (MAX_AMT - MIN_AMT)) * 100;
  const hitGoal = amount >= GOAL;
  const p = Math.min(1, Math.max(0, (amount - MIN_AMT) / (GOAL - MIN_AMT)));
  const nearGoal = !hitGoal && amount >= 350000;
  const c1 = hitGoal ? '#059669' : lerpHex('#2563EB', '#0D9488', p * 0.7);
  const c2 = hitGoal ? '#10B981' : lerpHex('#7C3AED', '#10B981', p);
  return (
    <div>
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
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, marginTop: 14 }}>
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
  );
}

function PromoRow({ promo, setPromo }) {
  const [open, setOpen] = useState(false);
  const [val, setVal] = useState('');
  const [err, setErr] = useState('');
  useEffect(() => {
    if (promo || err) setOpen(true);
  }, [promo, err]);
  const apply = () => {
    const code = val.trim().toUpperCase();
    if (!code) {
      setErr('Enter a code first.');
      return;
    }
    if (PROMOS[code]) {
      setPromo({ code, minor: PROMOS[code] });
      setErr('');
      setVal('');
    } else {
      setErr("That code isn't valid. Check it and try again.");
    }
  };
  if (promo) {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 10,
          background: T.greenBg,
          border: `1px solid ${T.greenBorder}`,
          borderRadius: 11,
          padding: '11px 14px',
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
          <Gift size={15} strokeWidth={2.4} /> {promo.code} applied — {audShort(promo.minor)} bonus
          credit
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
    );
  }
  if (!open) {
    return (
      <div>
        <LinkBtn icon={Tag} onClick={() => setOpen(true)}>
          Have a promo code?
        </LinkBtn>
      </div>
    );
  }
  return (
    <div>
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          autoFocus
          value={val}
          onChange={(e) => {
            setVal(e.target.value);
            setErr('');
          }}
          placeholder="Enter your code"
          onKeyDown={(e) => e.key === 'Enter' && apply()}
          aria-label="Promo code"
          style={{
            flex: 1,
            minWidth: 0,
            fontFamily: FONT,
            fontSize: 14,
            fontWeight: 500,
            color: T.ink,
            padding: '11px 14px',
            borderRadius: 11,
            outline: 'none',
            border: `1.5px solid ${err ? T.redBorder : T.border}`,
            background: err ? T.redBg : '#fff',
            textTransform: 'uppercase',
          }}
        />
        <button
          onClick={apply}
          style={{
            fontFamily: FONT,
            fontSize: 14,
            fontWeight: 600,
            color: val.trim() ? T.primary : T.faint,
            background: val.trim() ? T.primaryLight : T.bg,
            border: `1px solid ${val.trim() ? T.primaryBorder : T.border}`,
            borderRadius: 11,
            padding: '0 16px',
            cursor: 'pointer',
          }}
        >
          Apply
        </button>
        <button
          onClick={() => {
            setOpen(false);
            setVal('');
            setErr('');
          }}
          aria-label="Close promo field"
          style={{
            border: 'none',
            background: 'none',
            cursor: 'pointer',
            color: T.faint,
            display: 'inline-flex',
            padding: '0 2px',
          }}
        >
          <X size={16} strokeWidth={2.4} />
        </button>
      </div>
      {err && (
        <div style={{ marginTop: 7, fontSize: 12.5, color: T.red, fontWeight: 500 }}>{err}</div>
      )}
    </div>
  );
}

function ModesSection({ mode, setMode, reload, setReload, threshold, setThreshold }) {
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
  return (
    <div>
      <SectionLabel>When your balance runs low</SectionLabel>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
        {modes.map((m) => {
          const sel = mode === m.id;
          return (
            <Choice key={m.id} selected={sel} onClick={() => setMode(m.id)}>
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
                    <span style={{ fontSize: 14, fontWeight: 600, color: T.ink2 }}>{m.title}</span>
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
                </div>
              </div>
            </Choice>
          );
        })}
      </div>
      {mode === 'auto_topup' && (
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
                    set(Math.round((parseFloat(e.target.value.replace(/[^0-9.]/g, '')) || 0) * 100))
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
    </div>
  );
}

/* Stripe Payment Element — MOCK. The real thing is an iframe from Stripe's domain. */
function PaymentElementMock() {
  const label = { fontFamily: SF, fontSize: 14.5, color: '#30313d', marginBottom: 6 };
  const box = {
    width: '100%',
    height: 44,
    border: '1px solid #e6e6e6',
    borderRadius: 5,
    padding: '0 12px',
    fontSize: 16,
    fontFamily: SF,
    color: '#30313d',
    background: '#fff',
    boxShadow: '0 1px 1px rgba(0,0,0,.03), 0 3px 6px rgba(0,0,0,.02)',
    outline: 'none',
  };
  return (
    <div
      style={{
        position: 'relative',
        border: '1px dashed #A5B4FC',
        borderRadius: 12,
        padding: '18px 16px 16px',
        background: '#fff',
      }}
    >
      <div
        style={{
          position: 'absolute',
          top: -9,
          right: 12,
          fontSize: 10.5,
          fontWeight: 600,
          color: '#4F46E5',
          background: '#fff',
          padding: '0 6px',
          fontFamily: FONT,
        }}
      >
        Stripe Payment Element · iframe · mock
      </div>
      <div
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 8,
          border: '1px solid #0570de',
          boxShadow: '0 0 0 1px #0570de',
          borderRadius: 5,
          padding: '8px 14px',
          marginBottom: 16,
          background: '#fff',
        }}
      >
        <CreditCard size={16} style={{ color: '#0570de' }} />
        <span style={{ fontFamily: SF, fontSize: 14, color: '#0570de', fontWeight: 500 }}>
          Card
        </span>
      </div>
      <div style={label}>Card number</div>
      <div style={{ position: 'relative', marginBottom: 12 }}>
        <input className="pe-input" readOnly placeholder="1234 1234 1234 1234" style={box} />
        <div
          style={{
            position: 'absolute',
            right: 10,
            top: '50%',
            transform: 'translateY(-50%)',
            display: 'flex',
            gap: 4,
          }}
        >
          <Mark bg="#1A1F71">VISA</Mark>
          <McMark />
          <Mark bg="#006FCF">AMEX</Mark>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 12, marginBottom: 12 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={label}>Expiration date</div>
          <input className="pe-input" readOnly placeholder="MM / YY" style={box} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={label}>Security code</div>
          <input className="pe-input" readOnly placeholder="CVC" style={box} />
        </div>
      </div>
      <div style={label}>Country</div>
      <div
        style={{
          ...box,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <span>Australia</span>
        <ChevronDown size={16} style={{ color: '#6d6e78' }} />
      </div>
      <p
        style={{
          fontFamily: SF,
          fontSize: 13,
          color: '#6d6e78',
          lineHeight: 1.5,
          margin: '14px 0 0',
        }}
      >
        By providing your card information, you allow Balo to charge your card for future payments
        in accordance with their terms.
      </p>
    </div>
  );
}

function SavedCardRow({ onChange }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        border: `1.5px solid ${T.border}`,
        background: '#fff',
        borderRadius: 12,
        padding: '12px 14px',
      }}
    >
      <Mark bg="#1A1F71">VISA</Mark>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: T.ink2 }}>
          {SAVED.brand} •••• {SAVED.last4}
        </div>
        <div style={{ fontSize: 12, color: T.muted, fontWeight: 500, marginTop: 2 }}>
          Expires {SAVED.exp}
        </div>
      </div>
      <LinkBtn onClick={onChange}>Change</LinkBtn>
    </div>
  );
}

function PaymentSection({ client, useNew, setUseNew, needsMandate }) {
  const showSaved = client === 'returning' && !useNew;
  return (
    <div>
      <SectionLabel>Payment method</SectionLabel>
      {showSaved ? (
        <SavedCardRow onChange={() => setUseNew(true)} />
      ) : (
        <>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 12,
              fontWeight: 500,
              color: T.muted,
              marginBottom: 10,
            }}
          >
            <Lock size={12} strokeWidth={2.4} style={{ color: T.faint }} />
            Entered directly with Stripe — Balo never sees your card number.
          </div>
          <PaymentElementMock />
          {client === 'returning' && (
            <div style={{ marginTop: 10 }}>
              <LinkBtn muted onClick={() => setUseNew(false)}>
                Keep {SAVED.brand} •••• {SAVED.last4} instead
              </LinkBtn>
            </div>
          )}
        </>
      )}
      {needsMandate && (
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
            {showSaved
              ? `You're letting Balo charge ${SAVED.brand} •••• ${SAVED.last4} for consultation time beyond your balance and for automatic top-ups, per your settings above. Change or turn this off anytime.`
              : 'This card will also cover consultation time beyond your balance and automatic top-ups, per your settings above. Change or turn this off anytime.'}
          </span>
        </div>
      )}
    </div>
  );
}

/* ---------- rail / hero / mobile bar ---------- */

function Hero({ shown, hitGoal, amount, promo, compact, radius }) {
  const heroGrad = hitGoal
    ? 'linear-gradient(120deg,#fff 20%,#A7F3D0 58%,#6EE7B7 100%)'
    : 'linear-gradient(120deg,#fff 20%,#BFDBFE 60%,#DDD6FE 100%)';
  return (
    <div
      style={{
        position: 'relative',
        overflow: 'hidden',
        background: `linear-gradient(160deg, ${T.heroTop} 0%, ${T.heroBot} 100%)`,
        padding: compact ? '16px 18px 18px' : '22px 22px 24px',
        borderRadius: radius || 0,
      }}
    >
      <div
        className="glow g1"
        style={{
          position: 'absolute',
          width: 220,
          height: 220,
          borderRadius: '50%',
          background: `radial-gradient(circle, ${hitGoal ? 'rgba(16,185,129,0.4)' : 'rgba(37,99,235,0.45)'}, transparent 68%)`,
          top: -100,
          right: -60,
          filter: 'blur(6px)',
          transition: 'background .5s',
        }}
      />
      <div
        className="glow g2"
        style={{
          position: 'absolute',
          width: 180,
          height: 180,
          borderRadius: '50%',
          background: `radial-gradient(circle, ${hitGoal ? 'rgba(52,211,153,0.34)' : 'rgba(124,58,237,0.4)'}, transparent 68%)`,
          bottom: -100,
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
            gap: 8,
            marginTop: compact ? 8 : 12,
            flexWrap: 'wrap',
          }}
        >
          <span
            className="grad-text"
            style={{
              '--g': heroGrad,
              fontSize: compact ? 28 : 36,
              fontWeight: 700,
              letterSpacing: '-0.03em',
              lineHeight: 1,
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            ≈ {timeStr(shown)}
          </span>
          <span
            style={{
              fontSize: 13,
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
        {compact && (
          <div
            style={{
              marginTop: 8,
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              flexWrap: 'wrap',
            }}
          >
            <span
              style={{
                fontSize: 14,
                fontWeight: 600,
                color: '#fff',
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {aud(amount)}
            </span>
            {promo && <PromoPill promo={promo} />}
          </div>
        )}
      </div>
    </div>
  );
}
const PromoPill = ({ promo }) => (
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
);

const Line = ({ label, value, strong, green, icon: Icon }) => (
  <div
    style={{
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'baseline',
      gap: 12,
      fontSize: 13.5,
      padding: '5px 0',
    }}
  >
    <span
      style={{
        color: T.muted,
        fontWeight: 500,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
      }}
    >
      {Icon && <Icon size={13} strokeWidth={2.3} />}
      {label}
    </span>
    <span
      style={{
        fontWeight: strong ? 700 : 600,
        fontSize: strong ? 15 : 13.5,
        color: green ? T.green : T.ink,
        fontVariantNumeric: 'tabular-nums',
        textAlign: 'right',
      }}
    >
      {value}
    </span>
  </div>
);

const PayButton = ({ amount, compact }) => (
  <button
    style={{
      width: compact ? undefined : '100%',
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      padding: compact ? '12px 18px' : '14px 18px',
      borderRadius: 13,
      cursor: 'pointer',
      fontFamily: FONT,
      fontSize: 15,
      fontWeight: 600,
      color: '#fff',
      border: 'none',
      background: GRAD,
      boxShadow: '0 3px 12px rgba(37,99,235,0.32)',
      whiteSpace: 'nowrap',
    }}
  >
    Pay {aud(amount)} <ArrowRight size={17} strokeWidth={2.6} />
  </button>
);

function SummaryRail({ amount, credited, shown, hitGoal, promo, payingWith }) {
  return (
    <div
      style={{
        fontFamily: FONT,
        background: T.surface,
        border: `1px solid ${T.border}`,
        borderRadius: 20,
        boxShadow: '0 1px 2px rgba(15,23,41,0.04), 0 18px 50px rgba(15,23,41,0.09)',
        overflow: 'hidden',
      }}
    >
      <Hero shown={shown} hitGoal={hitGoal} amount={amount} promo={promo} />
      <div style={{ padding: '14px 20px 20px' }}>
        <Line label="Top-up" value={aud(amount)} />
        {promo && <Line label={`${promo.code} bonus`} value={'+' + aud(promo.minor)} green />}
        {promo && <Line label="Credited to wallet" value={aud(credited)} strong />}
        <Line icon={CreditCard} label="Paying with" value={payingWith} />
        <div style={{ height: 1, background: T.borderSubtle, margin: '10px 0 14px' }} />
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 12.5,
            fontWeight: 600,
            color: T.muted,
            marginBottom: 12,
          }}
        >
          <Clock size={13} strokeWidth={2.3} /> Buys ≈ {timeStr(credited)}
        </div>
        <PayButton amount={amount} />
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
          You'll be charged in AUD — your bank sets the final rate.
        </div>
      </div>
    </div>
  );
}

function MobileBar({ amount, credited, radius }) {
  return (
    <div
      style={{
        position: 'sticky',
        bottom: 0,
        marginTop: 'auto',
        background: 'rgba(255,255,255,0.96)',
        backdropFilter: 'blur(8px)',
        WebkitBackdropFilter: 'blur(8px)',
        borderTop: `1px solid ${T.border}`,
        padding: '12px 16px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        borderRadius: radius || 0,
        fontFamily: FONT,
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div
          style={{
            fontSize: 11.5,
            color: T.muted,
            fontWeight: 600,
            display: 'flex',
            alignItems: 'center',
            gap: 5,
          }}
        >
          <Clock size={12} strokeWidth={2.3} /> Buys ≈ {timeStr(credited)}
        </div>
        <div
          style={{
            fontSize: 18,
            fontWeight: 700,
            color: T.ink,
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {aud(amount)}
        </div>
      </div>
      <PayButton amount={amount} compact />
    </div>
  );
}

function PhoneFrame({ children }) {
  return (
    <div
      style={{
        width: 390,
        maxWidth: '100%',
        margin: '0 auto',
        border: `1px solid ${T.border}`,
        borderRadius: 30,
        background: T.bg,
        boxShadow: '0 1px 2px rgba(15,23,41,0.04), 0 18px 50px rgba(15,23,41,0.09)',
        overflow: 'hidden',
      }}
    >
      <div style={{ height: 760, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
        {children}
      </div>
    </div>
  );
}

function Seg({ options, value, onChange }) {
  return (
    <div
      style={{
        display: 'inline-flex',
        gap: 4,
        background: '#fff',
        border: `1px solid ${T.border}`,
        borderRadius: 11,
        padding: 3,
      }}
    >
      {options.map(([k, l, Icon]) => {
        const on = value === k;
        return (
          <button
            key={k}
            onClick={() => onChange(k)}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '6px 11px',
              borderRadius: 8,
              cursor: 'pointer',
              fontFamily: FONT,
              fontSize: 13,
              fontWeight: 600,
              border: 'none',
              color: on ? T.primary : T.muted,
              background: on ? T.primaryLight : 'transparent',
            }}
          >
            {Icon && <Icon size={14} strokeWidth={2.3} />}
            {l}
          </button>
        );
      })}
    </div>
  );
}

/* ---------- app ---------- */

export default function App() {
  const [client, setClient] = useState('returning');
  const [viewport, setViewport] = useState('desktop');
  const width = useWidth();
  const frame = viewport === 'mobile';
  const stack = frame || width < 900;

  const [amount, setAmount] = useState(100000);
  const [mode, setMode] = useState('notify_only');
  const [reload, setReload] = useState(30000);
  const [threshold, setThreshold] = useState(5000);
  const [promo, setPromo] = useState(null);
  const [useNew, setUseNew] = useState(false);
  useEffect(() => {
    setUseNew(false);
  }, [client]);

  const credited = amount + (promo ? promo.minor : 0);
  const shown = useEased(credited);
  const hitGoal = amount >= GOAL;
  const needsMandate = mode !== 'notify_only';
  const showSaved = client === 'returning' && !useNew;
  const payingWith = showSaved ? `${SAVED.brand} •••• ${SAVED.last4}` : 'New card';

  const left = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
      <AmountSection amount={amount} setAmount={setAmount} credited={credited} />
      <PromoRow promo={promo} setPromo={setPromo} />
      <ModesSection
        mode={mode}
        setMode={setMode}
        reload={reload}
        setReload={setReload}
        threshold={threshold}
        setThreshold={setThreshold}
      />
      <PaymentSection
        client={client}
        useNew={useNew}
        setUseNew={setUseNew}
        needsMandate={needsMandate}
      />
    </div>
  );

  const card = {
    fontFamily: FONT,
    background: T.surface,
    border: `1px solid ${T.border}`,
    borderRadius: 20,
    boxShadow: '0 1px 2px rgba(15,23,41,0.04), 0 18px 50px rgba(15,23,41,0.09)',
  };

  let stage;
  if (frame) {
    stage = (
      <PhoneFrame>
        <Hero compact shown={shown} hitGoal={hitGoal} amount={amount} promo={promo} />
        <div style={{ padding: '18px 16px 24px', fontFamily: FONT }}>{left}</div>
        <MobileBar amount={amount} credited={credited} />
      </PhoneFrame>
    );
  } else if (stack) {
    stage = (
      <div style={card}>
        <Hero
          compact
          shown={shown}
          hitGoal={hitGoal}
          amount={amount}
          promo={promo}
          radius="20px 20px 0 0"
        />
        <div style={{ padding: '18px 20px 24px' }}>{left}</div>
        <MobileBar amount={amount} credited={credited} radius="0 0 20px 20px" />
      </div>
    );
  } else {
    stage = (
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1fr) 340px',
          gap: 24,
          alignItems: 'start',
        }}
      >
        <div style={{ ...card, padding: 24 }}>{left}</div>
        <div style={{ position: 'sticky', top: 20 }}>
          <SummaryRail
            amount={amount}
            credited={credited}
            shown={shown}
            hitGoal={hitGoal}
            promo={promo}
            payingWith={payingWith}
          />
        </div>
      </div>
    );
  }

  const notes = [
    [
      'The rail carries the argument',
      'Hero and Pay button stay in view the whole way down. The left column can be as long as first-time card capture needs — nobody arrives at Pay having scrolled past the reason to pay.',
    ],
    [
      'Payment method is conditional',
      'Card on file → one saved-card row. No card → the Stripe Payment Element. "Change" swaps to the element in place; "Keep •••• 4242 instead" swaps back. Same page, one decision surface.',
    ],
    [
      'Promo is a link until it matters',
      'Opens on click, stays open on apply, and opens itself on error so a collapsed field can never hide a problem.',
    ],
    [
      'No "Pay with"',
      "One option isn't a choice. Modes never disable — every path is card, so every mode is always available.",
    ],
    [
      'Mobile: rail becomes a pay bar',
      'Compact hero at the top scrolls away; the sticky bar keeps time, amount, and Pay at the thumb. If this lives in a full-screen sheet (like booking), the bar is the sheet footer.',
    ],
    [
      'Gradient text is guarded',
      '@supports gates background-clip:text; unsupported browsers get plain white. This is the fix for the blank hero figure in the current build.',
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
        @import url('https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&display=swap');
        *{box-sizing:border-box}
        .grad-text{color:#fff}
        @supports((-webkit-background-clip:text) or (background-clip:text)){
          .grad-text{background-image:var(--g);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}
        }
        @keyframes float1{0%,100%{transform:translate(0,0)}50%{transform:translate(-16px,14px)}}
        @keyframes float2{0%,100%{transform:translate(0,0)}50%{transform:translate(14px,-12px)}}
        .glow.g1{animation:float1 9s ease-in-out infinite}
        .glow.g2{animation:float2 11s ease-in-out infinite}
        @media(prefers-reduced-motion:reduce){.glow{animation:none!important}}
        input::placeholder{color:${T.faint};text-transform:none}
        .pe-input::placeholder{color:#77787f}
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
      `}</style>

      <div style={{ maxWidth: 980, margin: '0 auto' }}>
        <div style={{ marginBottom: 18 }}>
          <Eyebrow>Top-up · summary-rail prototype</Eyebrow>
          <h1
            style={{ margin: '8px 0 4px', fontSize: 24, fontWeight: 700, letterSpacing: '-0.02em' }}
          >
            Decide on the left, confirm on the right
          </h1>
          <p style={{ margin: 0, fontSize: 14.5, color: T.muted, lineHeight: 1.55, maxWidth: 640 }}>
            Input column left, sticky summary rail right. Toggle the client state to see the payment
            method switch between a saved card and the Stripe element.
          </p>
        </div>

        <div
          style={{
            display: 'flex',
            gap: 10,
            marginBottom: 20,
            flexWrap: 'wrap',
            alignItems: 'center',
          }}
        >
          <Seg
            value={client}
            onChange={setClient}
            options={[
              ['returning', 'Card on file', Check],
              ['new', 'No card yet', CreditCard],
            ]}
          />
          <Seg
            value={viewport}
            onChange={setViewport}
            options={[
              ['desktop', 'Desktop', Monitor],
              ['mobile', 'Mobile', Smartphone],
            ]}
          />
          {!frame && width < 900 && (
            <span style={{ fontSize: 12, color: T.faint, fontWeight: 500 }}>
              Widen the panel past 900px to see two columns.
            </span>
          )}
        </div>

        {stage}

        <div
          style={{
            marginTop: 24,
            background: '#fff',
            border: `1px solid ${T.borderSubtle}`,
            borderRadius: 14,
            padding: 18,
          }}
        >
          <Eyebrow icon={Sparkles}>What changed and why</Eyebrow>
          <div
            style={{
              marginTop: 12,
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
              gap: 16,
            }}
          >
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
            Try: switch to "No card yet" and scroll — the rail stays put · click "Change" on the
            saved card · type NEWTOBALO in the promo field · drag past A$5,000.
          </div>
        </div>
      </div>
    </div>
  );
}
