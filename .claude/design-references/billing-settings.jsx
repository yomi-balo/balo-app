import React, { useState } from 'react';
import {
  Wallet,
  Plus,
  Zap,
  Radio,
  Bell,
  CreditCard,
  Gift,
  Clock,
  ArrowDownLeft,
  ArrowUpRight,
  Info,
  RotateCw,
  Trash2,
  ShieldCheck,
  Receipt,
} from 'lucide-react';

/**
 * Billing / Low-Balance Settings — Design Reference (ADR-1040)
 * ----------------------------------------------------------------------------
 * The persistent-management surface. Client-lens. Where balance, low-balance
 * mode, the card-on-file mandate, and the ledger (as a plain activity
 * statement) all live between sessions.
 *
 * Fee boundary: consultation rows show the client all-in amount ONLY — never
 * the expert quote or Balo margin. Rolling expiry is framed warmly ("stays
 * active until …, any activity keeps it going"). "Overdraft" never appears;
 * settlement reads as "extra time settled to card".
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
  heroTop: '#0F1729',
  heroBot: '#1E293B',
};
const GRAD = `linear-gradient(135deg, ${T.primary} 0%, ${T.primaryTo} 100%)`;
const FONT = "'DM Sans', ui-sans-serif, system-ui, -apple-system, sans-serif";
const FX_USD = 0.642;
const aud = (m) =>
  'A$' + (m / 100).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const audShort = (m) => 'A$' + Math.round(m / 100).toLocaleString('en-AU');
const usd = (m) => 'US$' + Math.round((m / 100) * FX_USD).toLocaleString('en-AU');

// client-lens ledger (activity). consultation rows are all-in client amounts only.
const ACTIVITY = [
  {
    type: 'topup',
    date: '12 Jul',
    label: 'Top up',
    sub: 'Visa •••• 4242',
    amt: 100000,
    bal: 134700,
  },
  {
    type: 'consult',
    date: '10 Jul',
    label: 'Consultation — Jordan Ellis',
    sub: '45 min',
    amt: -13500,
    bal: 34700,
  },
  {
    type: 'settle',
    date: '8 Jul',
    label: 'Extra time settled to card',
    sub: '12 min past balance',
    amt: -3600,
    bal: 48200,
  },
  {
    type: 'promo',
    date: '5 Jul',
    label: 'Promo credit — WELCOME50',
    sub: 'Bonus',
    amt: 5000,
    bal: 51800,
  },
  {
    type: 'consult',
    date: '2 Jul',
    label: 'Consultation — Alex Rivera',
    sub: '30 min',
    amt: -9000,
    bal: 46800,
  },
  { type: 'topup', date: '1 Jul', label: 'Top up', sub: 'Visa •••• 4242', amt: 50000, bal: 55800 },
];
const ROW = {
  topup: { icon: ArrowDownLeft, fg: T.green },
  promo: { icon: Gift, fg: T.green },
  consult: { icon: Clock, fg: T.ink2 },
  settle: { icon: CreditCard, fg: T.ink2 },
};

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
const SectionLabel = ({ children, right }) => (
  <div
    style={{
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: 12,
    }}
  >
    <span style={{ fontSize: 13.5, fontWeight: 700, color: T.ink2 }}>{children}</span>
    {right}
  </div>
);
function Choice({ selected, disabled, onClick, children }) {
  return (
    <button
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      style={{
        textAlign: 'left',
        fontFamily: FONT,
        cursor: disabled ? 'not-allowed' : 'pointer',
        background: disabled ? T.bg : selected ? T.primaryLight : '#fff',
        border: `1.5px solid ${selected && !disabled ? T.primary : T.border}`,
        borderRadius: 12,
        padding: '13px 15px',
        transition: 'all .14s',
        opacity: disabled ? 0.6 : 1,
        width: '100%',
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

const card = {
  fontFamily: FONT,
  background: T.surface,
  border: `1px solid ${T.border}`,
  borderRadius: 18,
  boxShadow: '0 1px 2px rgba(15,23,41,0.04), 0 8px 26px rgba(15,23,41,0.05)',
  overflow: 'hidden',
};

export default function App() {
  const [state, setState] = useState('loaded'); // loaded | empty | loading | error
  const [hasCard, setHasCard] = useState(true);
  const [mode, setMode] = useState('keep_going');
  const [reload, setReload] = useState(30000);
  const [threshold, setThreshold] = useState(5000);

  const modes = [
    {
      id: 'auto_topup',
      icon: Zap,
      title: 'Auto top-up',
      mandate: true,
      desc: `Add ${audShort(reload)} whenever your balance drops below ${audShort(threshold)}.`,
    },
    {
      id: 'keep_going',
      icon: Radio,
      title: 'Keep me going',
      mandate: true,
      desc: "Don't interrupt sessions — settle any extra time to your card afterward.",
    },
    {
      id: 'notify_only',
      icon: Bell,
      title: 'Just notify me',
      mandate: false,
      desc: "Tell me when I'm running low. I'll top up myself.",
    },
  ];
  const needsMandate = mode === 'auto_topup' || mode === 'keep_going';

  // ── balance panel (dark, reuses wallet language) ──
  const Balance = () => (
    <div
      style={{
        ...card,
        position: 'relative',
        overflow: 'hidden',
        background: `linear-gradient(160deg, ${T.heroTop}, ${T.heroBot})`,
        border: 'none',
      }}
    >
      <div
        style={{
          position: 'absolute',
          width: 220,
          height: 220,
          borderRadius: '50%',
          background: 'radial-gradient(circle, rgba(37,99,235,0.4), transparent 68%)',
          top: -100,
          right: -50,
          filter: 'blur(6px)',
        }}
      />
      <div style={{ position: 'relative', padding: '22px 24px' }}>
        <Eyebrow icon={Wallet} light>
          Balance
        </Eyebrow>
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-end',
            justifyContent: 'space-between',
            marginTop: 12,
            flexWrap: 'wrap',
            gap: 12,
          }}
        >
          <div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 9 }}>
              <span
                style={{
                  fontSize: 34,
                  fontWeight: 700,
                  color: '#fff',
                  letterSpacing: '-0.02em',
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                A$1,347.00
              </span>
              <span style={{ fontSize: 13.5, fontWeight: 500, color: 'rgba(255,255,255,0.5)' }}>
                ≈ {usd(134700)}
              </span>
            </div>
            <div
              style={{
                marginTop: 7,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 12,
                fontWeight: 500,
                color: 'rgba(255,255,255,0.5)',
              }}
            >
              <ShieldCheck size={13} strokeWidth={2.2} /> Stays active until 12 Jul 2027 — any
              activity keeps it going.
            </div>
          </div>
          <button
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 7,
              padding: '11px 18px',
              borderRadius: 11,
              cursor: 'pointer',
              fontFamily: FONT,
              fontSize: 14,
              fontWeight: 600,
              color: '#fff',
              border: 'none',
              background: GRAD,
              boxShadow: '0 2px 10px rgba(37,99,235,0.4)',
            }}
          >
            <Plus size={16} strokeWidth={2.6} /> Top up
          </button>
        </div>
      </div>
    </div>
  );

  // ── activity ──
  const Activity = () => {
    if (state === 'empty') {
      return (
        <div style={{ ...card, padding: '40px 24px', textAlign: 'center' }}>
          <div
            style={{
              width: 46,
              height: 46,
              borderRadius: 14,
              margin: '0 auto',
              background: T.primaryLight,
              border: `1px solid ${T.primaryBorder}`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Receipt size={22} strokeWidth={2} style={{ color: T.primary }} />
          </div>
          <div style={{ marginTop: 14, fontSize: 15, fontWeight: 700, color: T.ink }}>
            No activity yet
          </div>
          <div
            style={{
              marginTop: 5,
              fontSize: 13.5,
              color: T.muted,
              fontWeight: 500,
              lineHeight: 1.5,
              maxWidth: 320,
              margin: '5px auto 0',
            }}
          >
            Your top-ups and consultations will show up here. Add credit to get started.
          </div>
          <button
            style={{
              marginTop: 16,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 7,
              padding: '10px 16px',
              borderRadius: 10,
              cursor: 'pointer',
              fontFamily: FONT,
              fontSize: 13.5,
              fontWeight: 600,
              color: '#fff',
              border: 'none',
              background: GRAD,
            }}
          >
            <Plus size={15} strokeWidth={2.6} /> Top up
          </button>
        </div>
      );
    }
    if (state === 'error') {
      return (
        <div style={{ ...card, padding: 24 }}>
          <div style={{ fontSize: 14.5, fontWeight: 500, color: T.ink2, lineHeight: 1.5 }}>
            We couldn't load your activity right now — your balance and history are safe. This is on
            our side.
          </div>
          <button
            style={{
              marginTop: 14,
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
    if (state === 'loading') {
      return (
        <div style={{ ...card, padding: 8 }}>
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px' }}
            >
              <div
                style={{ width: 34, height: 34, borderRadius: 10, background: T.borderSubtle }}
                className="shim"
              />
              <div style={{ flex: 1 }}>
                <div
                  style={{ width: '55%', height: 12, borderRadius: 6, background: T.borderSubtle }}
                  className="shim"
                />
                <div
                  style={{
                    width: '30%',
                    height: 10,
                    borderRadius: 6,
                    background: T.borderSubtle,
                    marginTop: 7,
                  }}
                  className="shim"
                />
              </div>
              <div
                style={{ width: 64, height: 14, borderRadius: 6, background: T.borderSubtle }}
                className="shim"
              />
            </div>
          ))}
        </div>
      );
    }
    return (
      <div style={card}>
        {ACTIVITY.map((r, i) => {
          const cfg = ROW[r.type];
          const pos = r.amt > 0;
          return (
            <div
              key={i}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 13,
                padding: '14px 18px',
                borderBottom: i < ACTIVITY.length - 1 ? `1px solid ${T.borderSubtle}` : 'none',
              }}
            >
              <div
                style={{
                  width: 34,
                  height: 34,
                  borderRadius: 10,
                  flexShrink: 0,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  background: pos ? T.greenBg : T.bg,
                  border: `1px solid ${pos ? T.greenBorder : T.border}`,
                }}
              >
                <cfg.icon size={16} strokeWidth={2.3} style={{ color: cfg.fg }} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    fontSize: 13.5,
                    fontWeight: 600,
                    color: T.ink,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {r.label}
                </div>
                <div style={{ fontSize: 12, color: T.faint, fontWeight: 500, marginTop: 1 }}>
                  {r.date} · {r.sub}
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div
                  style={{
                    fontSize: 14,
                    fontWeight: 700,
                    fontVariantNumeric: 'tabular-nums',
                    color: pos ? T.green : T.ink,
                  }}
                >
                  {pos ? '+' : '−'}
                  {aud(Math.abs(r.amt))}
                </div>
                <div style={{ fontSize: 11, color: T.faint, fontWeight: 500, marginTop: 1 }}>
                  {aud(r.bal)}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    );
  };

  const notes = [
    [
      'Client-lens ledger',
      'Activity is the append-only ledger, client-side only. Consultation rows show the all-in client amount and duration — never the expert quote or margin. Runs on the same fee-boundary mapper tests.',
    ],
    [
      'Plain settlement',
      "Grace settlement reads 'Extra time settled to card' with '12 min past balance' — honest and legible, no 'overdraft'.",
    ],
    [
      'Warm rolling expiry',
      "The balance panel states 'stays active until … any activity keeps it going' — a reassurance, not a countdown. Reminders only fire near true dormancy.",
    ],
    [
      'Card gates the modes',
      'Remove the card and the two mandate modes disable with a warm note. The mandate is a prerequisite for grace and auto top-up, surfaced here as a consequence, not a rule.',
    ],
    [
      'Empty state invites',
      "No activity → a ghost state that invites a first top-up, never a blank 'nothing here'.",
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
        *{box-sizing:border-box}
        @keyframes shimmer{0%{opacity:.55}50%{opacity:1}100%{opacity:.55}}
        .shim{animation:shimmer 1.3s ease-in-out infinite}
      `}</style>

      <div style={{ maxWidth: 1000, margin: '0 auto' }}>
        <div style={{ marginBottom: 20 }}>
          <Eyebrow>ADR-1040 · Design reference</Eyebrow>
          <h1
            style={{ margin: '8px 0 4px', fontSize: 24, fontWeight: 700, letterSpacing: '-0.02em' }}
          >
            Balance &amp; billing settings
          </h1>
          <p style={{ margin: 0, fontSize: 14.5, color: T.muted, lineHeight: 1.55, maxWidth: 660 }}>
            The persistent surface: balance, low-balance behaviour, card on file, and activity.
            Client-lens only — consultation charges never expose the expert quote or margin.
          </p>
        </div>

        {/* demo controls */}
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 14,
            alignItems: 'center',
            marginBottom: 22,
          }}
        >
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {[
              ['loaded', 'Loaded'],
              ['empty', 'Empty'],
              ['loading', 'Loading'],
              ['error', 'Error'],
            ].map(([k, l]) => (
              <button
                key={k}
                onClick={() => setState(k)}
                style={{
                  padding: '7px 13px',
                  borderRadius: 9,
                  cursor: 'pointer',
                  fontFamily: FONT,
                  fontSize: 13,
                  fontWeight: 600,
                  border: `1px solid ${state === k ? T.primaryBorder : T.border}`,
                  color: state === k ? T.primary : T.muted,
                  background: state === k ? T.primaryLight : '#fff',
                }}
              >
                {l}
              </button>
            ))}
          </div>
          <div
            style={{
              display: 'inline-flex',
              background: '#fff',
              border: `1px solid ${T.border}`,
              borderRadius: 11,
              padding: 4,
            }}
          >
            {[
              ['Card on file', true],
              ['No card', false],
            ].map(([l, v]) => (
              <button
                key={String(v)}
                onClick={() => setHasCard(v)}
                style={{
                  padding: '7px 13px',
                  borderRadius: 8,
                  cursor: 'pointer',
                  fontFamily: FONT,
                  fontSize: 13,
                  fontWeight: 600,
                  border: 'none',
                  color: hasCard === v ? '#fff' : T.muted,
                  background: hasCard === v ? T.ink : 'transparent',
                }}
              >
                {l}
              </button>
            ))}
          </div>
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(0, 600px) 1fr',
            gap: 24,
            alignItems: 'start',
          }}
          className="stage"
        >
          <style>{`@media(max-width:860px){.stage{grid-template-columns:1fr !important}}`}</style>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            <Balance />

            {/* low-balance behaviour */}
            <div>
              <SectionLabel>When your balance runs low</SectionLabel>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
                {modes.map((m) => {
                  const blocked = m.mandate && !hasCard;
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
              {mode === 'auto_topup' && hasCard && (
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
                    <label key={i} style={{ flex: 1, minWidth: 130 }}>
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
              {needsMandate && hasCard && (
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
                    Uses your saved card to cover time beyond your balance and automatic top-ups,
                    per the settings above. Change or turn off anytime.
                  </span>
                </div>
              )}
            </div>

            {/* payment method */}
            <div>
              <SectionLabel>Payment method</SectionLabel>
              {hasCard ? (
                <div
                  style={{
                    ...card,
                    padding: '14px 16px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 12,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <div
                      style={{
                        width: 40,
                        height: 28,
                        borderRadius: 6,
                        background: T.ink,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      <CreditCard size={16} strokeWidth={2.2} style={{ color: '#fff' }} />
                    </div>
                    <div>
                      <div style={{ fontSize: 13.5, fontWeight: 600, color: T.ink }}>
                        Visa •••• 4242
                      </div>
                      <div style={{ fontSize: 11.5, color: T.faint, fontWeight: 500 }}>
                        Expires 08/28
                      </div>
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button
                      style={{
                        padding: '8px 12px',
                        borderRadius: 9,
                        cursor: 'pointer',
                        fontFamily: FONT,
                        fontSize: 12.5,
                        fontWeight: 600,
                        color: T.ink2,
                        background: '#fff',
                        border: `1px solid ${T.border}`,
                      }}
                    >
                      Update
                    </button>
                    <button
                      onClick={() => setHasCard(false)}
                      aria-label="Remove card"
                      style={{
                        padding: '8px 10px',
                        borderRadius: 9,
                        cursor: 'pointer',
                        color: T.muted,
                        background: '#fff',
                        border: `1px solid ${T.border}`,
                        display: 'inline-flex',
                      }}
                    >
                      <Trash2 size={15} strokeWidth={2.2} />
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  onClick={() => setHasCard(true)}
                  style={{
                    ...card,
                    width: '100%',
                    padding: '16px',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 8,
                    fontFamily: FONT,
                    fontSize: 14,
                    fontWeight: 600,
                    color: T.primary,
                    background: '#fff',
                    border: `1.5px dashed ${T.primaryBorder}`,
                  }}
                >
                  <Plus size={16} strokeWidth={2.6} /> Add a card
                </button>
              )}
            </div>

            {/* activity */}
            <div>
              <SectionLabel
                right={
                  state === 'loaded' && (
                    <button
                      style={{
                        fontSize: 12.5,
                        fontWeight: 600,
                        color: T.primary,
                        background: 'none',
                        border: 'none',
                        cursor: 'pointer',
                      }}
                    >
                      Download statement
                    </button>
                  )
                }
              >
                Activity
              </SectionLabel>
              <Activity />
            </div>
          </div>

          <div
            style={{
              background: '#fff',
              border: `1px solid ${T.borderSubtle}`,
              borderRadius: 14,
              padding: 18,
            }}
          >
            <Eyebrow icon={Info}>Behaviour &amp; copy</Eyebrow>
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
              Try: remove the card to gate the mandate modes · switch Activity to Empty / Loading /
              Error.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
