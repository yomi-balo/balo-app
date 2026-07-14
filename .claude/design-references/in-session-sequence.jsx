import React, { useState } from 'react';
import {
  Radio,
  Wallet,
  Sparkles,
  Phone,
  MessageSquare,
  ArrowRight,
  Plus,
  Clock,
  ShieldCheck,
  PauseCircle,
  Info,
} from 'lucide-react';

/**
 * In-Session Case Sequence — Design Reference (ADR-1040)
 * ----------------------------------------------------------------------------
 * The hardest test of the warm-tone conventions. A per-minute consultation has
 * a ticking clock; the job is to guide healthy → running low → past balance →
 * wrap WITHOUT ever becoming a countdown.
 *
 * Design bet: no remaining-time HUD when there's plenty (only elapsed time,
 * normal for any call). Remaining surfaces ONLY when actionable, always inside
 * a framed, warm message. Grace = reassurance, not alarm (no red). The ceiling
 * is "a good place to wrap", not "limit reached".
 *
 * Client-lens. "Overdraft" never appears — "keep me going" is its client name.
 * SMS fires only on the urgent, time-sensitive transitions (entering grace,
 * approaching the wrap), per the notification conventions.
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
  amberFill: '#F59E0B',
  green: '#059669',
  greenBg: '#ECFDF5',
  greenBorder: '#A7F3D0',
  heroTop: '#0F1729',
  heroBot: '#1E293B',
};
const GRAD = `linear-gradient(135deg, ${T.primary} 0%, ${T.primaryTo} 100%)`;
const FONT = "'DM Sans', ui-sans-serif, system-ui, -apple-system, sans-serif";

// tone palettes for the notice card
const TONE = {
  none: null,
  amber: { fg: T.amber, bg: T.amberBg, bd: T.amberBorder, icon: Wallet },
  keep: { fg: T.primary, bg: T.primaryLight, bd: T.primaryBorder, icon: ShieldCheck, grad: true },
  wrap: { fg: T.ink2, bg: '#F1F5F9', bd: T.border, icon: PauseCircle },
};

// ── steps ──────────────────────────────────────────────────────────────
// meter.mode: "balance" (blue/amber fill) | "grace" (gradient fill toward ceiling) | "empty"
const GRACE = {
  healthy: {
    key: 'healthy',
    elapsed: '00:42:10',
    paused: false,
    meter: { mode: 'balance', pct: 72, tone: 'blue', label: 'Balance healthy' },
    tone: 'none',
  },
  low: {
    key: 'low',
    elapsed: '00:58:40',
    paused: false,
    meter: { mode: 'balance', pct: 9, tone: 'amber', label: 'Running low' },
    tone: 'amber',
    title: 'About 8 minutes of balance left',
    body: 'Want to top up so nothing interrupts you? You can also keep going — any extra time settles to your card when you wrap up.',
    primary: 'Top up',
    secondary: 'Keep going',
    channels: ['in-app'],
  },
  grace: {
    key: 'grace',
    elapsed: '01:04:00',
    paused: false,
    meter: { mode: 'grace', pct: 16, tone: 'grad', label: 'Keeping you going' },
    tone: 'keep',
    title: "We're keeping you going",
    body: "You've used your balance — no interruption. Extra time from here settles to your card afterward, and you've got room for about 50 more minutes.",
    primary: 'Top up',
    channels: ['in-app', 'sms'],
    sms: 'Your session continues past your balance — the extra time settles to your card afterward.',
  },
  near: {
    key: 'near',
    elapsed: '01:48:20',
    paused: false,
    meter: { mode: 'grace', pct: 82, tone: 'grad', label: 'Wrapping soon' },
    tone: 'amber',
    title: 'Coming up on a good place to wrap',
    body: "About 10 more minutes before we'll pause to settle up. Want to top up to keep going without a break?",
    primary: 'Top up to keep going',
    secondary: 'Dismiss',
    channels: ['in-app', 'sms'],
    sms: "You're nearing the end of this session's extra time — top up to keep going without a break.",
  },
  wrap: {
    key: 'wrap',
    elapsed: '01:54:00',
    paused: true,
    meter: { mode: 'grace', pct: 100, tone: 'grad', label: 'Paused' },
    tone: 'wrap',
    title: "Let's pause here for now",
    body: "We've reached the extra time we can cover this session. Top up to pick right back up — your expert can rejoin in a moment. We'll settle the extra time used to your card.",
    primary: 'Top up to continue',
    channels: ['in-app'],
  },
};
const NOMANDATE = {
  healthy: GRACE.healthy,
  low: {
    ...GRACE.low,
    secondary: null,
    body: "Top up so nothing interrupts your session — you're near the end of your balance.",
  },
  end: {
    key: 'end',
    elapsed: '01:02:30',
    paused: true,
    meter: { mode: 'empty', pct: 0, tone: 'faint', label: 'Balance used' },
    tone: 'wrap',
    title: "You're at the end of your balance",
    body: "Top up to keep going — your expert can pick right back up whenever you're ready.",
    primary: 'Top up to continue',
    channels: ['in-app'],
  },
};

// ── primitives ─────────────────────────────────────────────────────────
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
const ChannelChip = ({ kind }) => {
  const sms = kind === 'sms';
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        fontSize: 10.5,
        fontWeight: 700,
        letterSpacing: '0.02em',
        textTransform: 'uppercase',
        color: sms ? T.primaryTo : T.muted,
        background: sms ? 'rgba(124,58,237,0.08)' : T.bg,
        border: `1px solid ${sms ? 'rgba(124,58,237,0.25)' : T.border}`,
        padding: '2px 7px',
        borderRadius: 999,
      }}
    >
      {sms ? <MessageSquare size={10} strokeWidth={2.6} /> : <Phone size={10} strokeWidth={2.6} />}
      {sms ? 'SMS' : 'In-app'}
    </span>
  );
};

function Meter({ meter }) {
  const { mode, pct, tone, label } = meter;
  const fill =
    mode === 'grace'
      ? GRAD
      : tone === 'amber'
        ? T.amberFill
        : tone === 'faint'
          ? T.faint
          : '#60A5FA';
  const labelColor =
    mode === 'grace' ? '#DDD6FE' : tone === 'amber' ? '#FCD34D' : 'rgba(255,255,255,0.6)';
  return (
    <div style={{ marginTop: 16 }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 7,
        }}
      >
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 11.5,
            fontWeight: 600,
            color: labelColor,
          }}
        >
          {mode === 'grace' && <Sparkles size={12} strokeWidth={2.6} />} {label}
        </span>
        {mode === 'grace' && (
          <span style={{ fontSize: 10.5, fontWeight: 600, color: 'rgba(255,255,255,0.45)' }}>
            settles afterward
          </span>
        )}
      </div>
      <div
        style={{
          height: 6,
          borderRadius: 999,
          background: 'rgba(255,255,255,0.12)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            height: '100%',
            width: `${Math.max(3, pct)}%`,
            background: fill,
            borderRadius: 999,
            transition: 'width .5s ease, background .4s',
          }}
        />
      </div>
    </div>
  );
}

// ── consultation shell ─────────────────────────────────────────────────
function Session({ step }) {
  const paused = step.paused;
  const tone = TONE[step.tone];
  return (
    <div
      style={{
        fontFamily: FONT,
        background: T.surface,
        border: `1px solid ${T.border}`,
        borderRadius: 22,
        boxShadow: '0 1px 2px rgba(15,23,41,0.04), 0 18px 50px rgba(15,23,41,0.09)',
        overflow: 'hidden',
        maxWidth: 520,
        width: '100%',
      }}
    >
      {/* dark call stage */}
      <div
        style={{
          position: 'relative',
          overflow: 'hidden',
          padding: '22px 24px 24px',
          background: `linear-gradient(160deg, ${T.heroTop} 0%, ${T.heroBot} 100%)`,
          opacity: paused ? 0.92 : 1,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div
              style={{
                width: 46,
                height: 46,
                borderRadius: 14,
                background: GRAD,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 16,
                fontWeight: 700,
                color: '#fff',
                boxShadow: '0 4px 14px rgba(37,99,235,0.4)',
              }}
            >
              JE
            </div>
            <div>
              <div style={{ fontSize: 15.5, fontWeight: 700, color: '#fff' }}>Jordan Ellis</div>
              <div style={{ fontSize: 12, fontWeight: 500, color: 'rgba(255,255,255,0.55)' }}>
                Revenue Cloud specialist
              </div>
            </div>
          </div>
          <div
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 7,
              fontSize: 11.5,
              fontWeight: 700,
              color: paused ? 'rgba(255,255,255,0.7)' : '#6EE7B7',
              background: paused ? 'rgba(255,255,255,0.08)' : 'rgba(16,185,129,0.14)',
              border: `1px solid ${paused ? 'rgba(255,255,255,0.14)' : 'rgba(16,185,129,0.3)'}`,
              padding: '4px 10px',
              borderRadius: 999,
            }}
          >
            {paused ? (
              <PauseCircle size={12} strokeWidth={2.6} />
            ) : (
              <span
                className="live"
                style={{ width: 7, height: 7, borderRadius: 999, background: '#34D399' }}
              />
            )}
            {paused ? 'Paused' : 'In consultation'}
          </div>
        </div>

        {/* elapsed — neutral, expected; NOT a countdown */}
        <div style={{ marginTop: 18, display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: 'rgba(255,255,255,0.45)' }}>
            Session time
          </span>
          <span
            style={{
              fontSize: 20,
              fontWeight: 700,
              color: '#fff',
              fontVariantNumeric: 'tabular-nums',
              letterSpacing: '-0.01em',
            }}
          >
            {step.elapsed}
          </span>
        </div>

        <Meter meter={step.meter} />
      </div>

      {/* notice area */}
      <div style={{ padding: 22 }}>
        {tone ? (
          <div
            style={{
              borderRadius: 16,
              border: `1px solid ${tone.bd}`,
              background: tone.grad ? T.primaryLight : tone.bg,
              padding: 18,
              position: 'relative',
              overflow: 'hidden',
            }}
          >
            {tone.grad && (
              <div
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  right: 0,
                  height: 3,
                  background: GRAD,
                }}
              />
            )}
            <div style={{ display: 'flex', gap: 12 }}>
              <div
                style={{
                  width: 34,
                  height: 34,
                  borderRadius: 10,
                  flexShrink: 0,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  background: tone.grad ? GRAD : '#fff',
                  border: tone.grad ? 'none' : `1px solid ${tone.bd}`,
                }}
              >
                <tone.icon
                  size={17}
                  strokeWidth={2.3}
                  style={{ color: tone.grad ? '#fff' : tone.fg }}
                />
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 15, fontWeight: 700, color: T.ink }}>{step.title}</div>
                <div
                  style={{
                    marginTop: 5,
                    fontSize: 13.5,
                    color: T.ink2,
                    fontWeight: 500,
                    lineHeight: 1.5,
                  }}
                >
                  {step.body}
                </div>

                <div
                  style={{
                    marginTop: 14,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    flexWrap: 'wrap',
                  }}
                >
                  <button
                    style={{
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
                      boxShadow: '0 2px 8px rgba(37,99,235,0.28)',
                    }}
                  >
                    <Plus size={15} strokeWidth={2.6} /> {step.primary}
                  </button>
                  {step.secondary && (
                    <button
                      style={{
                        padding: '10px 14px',
                        borderRadius: 10,
                        cursor: 'pointer',
                        fontFamily: FONT,
                        fontSize: 13.5,
                        fontWeight: 600,
                        color: T.muted,
                        background: '#fff',
                        border: `1px solid ${T.border}`,
                      }}
                    >
                      {step.secondary}
                    </button>
                  )}
                </div>

                {step.channels && (
                  <div
                    style={{
                      marginTop: 14,
                      paddingTop: 12,
                      borderTop: `1px solid ${tone.grad ? T.primaryBorder : tone.bd}`,
                      display: 'flex',
                      alignItems: 'center',
                      gap: 7,
                      flexWrap: 'wrap',
                    }}
                  >
                    <span
                      style={{
                        fontSize: 10.5,
                        fontWeight: 600,
                        color: T.faint,
                        textTransform: 'uppercase',
                        letterSpacing: '0.06em',
                        marginRight: 2,
                      }}
                    >
                      Notifies
                    </span>
                    {step.channels.map((c) => (
                      <ChannelChip key={c} kind={c} />
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        ) : (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 9,
              padding: '4px 2px',
              color: T.muted,
            }}
          >
            <ShieldCheck size={15} strokeWidth={2.2} style={{ color: T.green }} />
            <span style={{ fontSize: 13, fontWeight: 500 }}>
              You're all set — time draws from your balance as you talk.
            </span>
          </div>
        )}

        {/* SMS preview */}
        {step.sms && (
          <div style={{ marginTop: 14, display: 'flex', gap: 10, alignItems: 'flex-start' }}>
            <div
              style={{
                width: 30,
                height: 30,
                borderRadius: 8,
                background: T.bg,
                border: `1px solid ${T.border}`,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}
            >
              <MessageSquare size={14} strokeWidth={2.3} style={{ color: T.primaryTo }} />
            </div>
            <div
              style={{
                flex: 1,
                background: T.bg,
                border: `1px solid ${T.borderSubtle}`,
                borderRadius: 12,
                borderTopLeftRadius: 3,
                padding: '10px 13px',
              }}
            >
              <div
                style={{
                  fontSize: 10.5,
                  fontWeight: 700,
                  color: T.faint,
                  textTransform: 'uppercase',
                  letterSpacing: '0.06em',
                  marginBottom: 3,
                }}
              >
                SMS · Balo
              </div>
              <div style={{ fontSize: 12.5, color: T.ink2, fontWeight: 500, lineHeight: 1.45 }}>
                {step.sms}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── playground ─────────────────────────────────────────────────────────
export default function App() {
  const [mandate, setMandate] = useState(true);
  const [idx, setIdx] = useState(0);

  const seq = mandate
    ? [GRACE.healthy, GRACE.low, GRACE.grace, GRACE.near, GRACE.wrap]
    : [NOMANDATE.healthy, NOMANDATE.low, NOMANDATE.end];
  const labels = mandate
    ? ['Healthy', 'Running low', 'Keep me going', 'Near wrap', 'Wrap']
    : ['Healthy', 'Running low', 'Balance used'];
  const step = seq[Math.min(idx, seq.length - 1)];
  const cur = Math.min(idx, seq.length - 1);

  const setBranch = (m) => {
    setMandate(m);
    setIdx((i) => Math.min(i, (m ? 5 : 3) - 1));
  };

  const notes = [
    [
      'No countdown when healthy',
      "The stage shows elapsed session time (normal for any call) — never a remaining-time HUD. Remaining surfaces only when it's actionable, inside a framed message.",
    ],
    [
      'Grace = reassurance',
      "Entering grace leads with 'we're keeping you going', a calm gradient (never red), and 'settles afterward' framing. The ceiling room is stated as a positive ('~50 more minutes').",
    ],
    [
      'Ceiling is a soft wrap',
      "At the ceiling the session pauses warmly — 'a good place to wrap', 'pick right back up' — not 'limit reached'. It's the one pause point, and it's at the ceiling, not at zero.",
    ],
    [
      'Channel discipline',
      'SMS fires only on entering grace and nearing the wrap — the urgent, time-sensitive moments. Routine states are in-app only. Everything routes through the notification engine.',
    ],
    [
      'No jargon, no card = no grace',
      "'Overdraft' never appears. Toggle the mandate off: with no card there's no grace — just a warm 'top up to keep going' at the end of balance.",
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
        @keyframes livePulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.4;transform:scale(.8)}}
        .live{display:inline-block;animation:livePulse 1.5s ease-in-out infinite}
        @media(prefers-reduced-motion:reduce){.live{animation:none}}
      `}</style>

      <div style={{ maxWidth: 980, margin: '0 auto' }}>
        <div style={{ marginBottom: 20 }}>
          <Eyebrow>ADR-1040 · Design reference</Eyebrow>
          <h1
            style={{ margin: '8px 0 4px', fontSize: 24, fontWeight: 700, letterSpacing: '-0.02em' }}
          >
            In-session Case sequence
          </h1>
          <p style={{ margin: 0, fontSize: 14.5, color: T.muted, lineHeight: 1.55, maxWidth: 660 }}>
            Guiding a live consultation from healthy through running low, past balance, to a warm
            wrap — without ever becoming a countdown. Step through the timeline; toggle the mandate
            to switch branches.
          </p>
        </div>

        {/* controls */}
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 16,
            alignItems: 'center',
            marginBottom: 22,
          }}
        >
          {/* mandate toggle */}
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
                onClick={() => setBranch(v)}
                style={{
                  padding: '7px 13px',
                  borderRadius: 8,
                  cursor: 'pointer',
                  fontFamily: FONT,
                  fontSize: 13,
                  fontWeight: 600,
                  border: 'none',
                  color: mandate === v ? '#fff' : T.muted,
                  background: mandate === v ? T.ink : 'transparent',
                }}
              >
                {l}
              </button>
            ))}
          </div>

          {/* stepper */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
            {labels.map((l, i) => (
              <React.Fragment key={l}>
                <button
                  onClick={() => setIdx(i)}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 7,
                    padding: '7px 12px',
                    borderRadius: 9,
                    cursor: 'pointer',
                    fontFamily: FONT,
                    fontSize: 12.5,
                    fontWeight: 600,
                    border: `1px solid ${i === cur ? T.primaryBorder : T.border}`,
                    color: i === cur ? T.primary : i < cur ? T.ink2 : T.faint,
                    background: i === cur ? T.primaryLight : '#fff',
                  }}
                >
                  <span
                    style={{
                      width: 18,
                      height: 18,
                      borderRadius: 999,
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: 10.5,
                      fontWeight: 700,
                      color: i <= cur ? '#fff' : T.faint,
                      background: i < cur ? T.green : i === cur ? T.primary : T.borderSubtle,
                    }}
                  >
                    {i + 1}
                  </span>
                  {l}
                </button>
                {i < labels.length - 1 && (
                  <ArrowRight size={13} strokeWidth={2.4} style={{ color: T.faint }} />
                )}
              </React.Fragment>
            ))}
          </div>
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(0, 520px) 1fr',
            gap: 24,
            alignItems: 'start',
          }}
          className="stage"
        >
          <style>{`@media(max-width:780px){.stage{grid-template-columns:1fr !important}}`}</style>
          <Session step={step} />
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
              Try: step through with a card on file to see the grace path and its SMS moments ·
              toggle to No card for the warm no-grace wrap.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
