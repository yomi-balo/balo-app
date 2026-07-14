import React, { useState, useEffect, useRef } from 'react';
import {
  Wallet,
  Users,
  Bell,
  Radio,
  Sparkles,
  Clock,
  ShieldCheck,
  Check,
  ArrowRight,
  Info,
  PauseCircle,
  RotateCw,
} from 'lucide-react';

/**
 * Member-Variant Wallet & In-Session — Design Reference (BAL-381, ADR-1040)
 * ----------------------------------------------------------------------------
 * The MEMBER lens (no billing.manage). Wallets are company-scoped: the
 * admin/owner manages, all members consume. So a member can SEE and SPEND the
 * shared team balance but cannot top up, set modes, or touch the card.
 *
 * Design bet: when "Top up" isn't the member's to press, the constructive
 * action is to NUDGE the billing.manage holder. Copy is team-framed ("your
 * team's balance", "your team's card"), never "top up". Grace still protects a
 * member's live session on the COMPANY mandate — they benefit without managing.
 *
 * "Overdraft" never appears. No manage affordance on any member surface.
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
const FX_USD = 0.642;
const ADMIN = 'Sam'; // resolves to the company's billing.manage holder(s)

const usd = (m) => 'US$' + Math.round((m / 100) * FX_USD).toLocaleString('en-AU');
const aud = (m) =>
  'A$' + (m / 100).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

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
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
        color: light ? 'rgba(255,255,255,0.55)' : T.faint,
      }}
    >
      {children}
    </span>
  </div>
);

// nudge button → "request sent" micro-state
function NudgeButton({ label, block, requested, onNudge, tone = 'primary' }) {
  if (requested) {
    return (
      <div
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 7,
          width: block ? '100%' : 'auto',
          justifyContent: 'center',
          padding: '11px 16px',
          borderRadius: 10,
          fontFamily: FONT,
          fontSize: 13.5,
          fontWeight: 600,
          color: T.green,
          background: T.greenBg,
          border: `1px solid ${T.greenBorder}`,
        }}
      >
        <Check size={15} strokeWidth={2.6} /> We let {ADMIN} know
      </div>
    );
  }
  const subtle = tone === 'subtle';
  return (
    <button
      onClick={onNudge}
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
        fontSize: 13.5,
        fontWeight: 600,
        color: subtle ? T.primary : '#fff',
        background: subtle ? T.primaryLight : GRAD,
        border: subtle ? `1px solid ${T.primaryBorder}` : 'none',
        boxShadow: subtle ? 'none' : '0 1px 3px rgba(37,99,235,0.28)',
      }}
    >
      <Bell size={15} strokeWidth={2.5} /> {label}
    </button>
  );
}

function Disclosure({ text }) {
  const [o, setO] = useState(false);
  return (
    <span
      style={{ position: 'relative', display: 'inline-flex' }}
      onMouseEnter={() => setO(true)}
      onMouseLeave={() => setO(false)}
    >
      <Info
        size={13}
        strokeWidth={2.2}
        style={{ color: T.faint, cursor: 'pointer' }}
        onClick={() => setO((v) => !v)}
      />
      {o && (
        <span
          style={{
            position: 'absolute',
            bottom: '150%',
            left: '50%',
            transform: 'translateX(-50%)',
            width: 200,
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
          {text}
        </span>
      )}
    </span>
  );
}

// ── MEMBER WALLET ────────────────────────────────────────────────────────
function MemberWallet({ state, requested, onNudge }) {
  const bal = { healthy: 134700, low: 1820, zero: 0 }[state];
  const isLow = state === 'low',
    isZero = state === 'zero';
  return (
    <div
      style={{
        fontFamily: FONT,
        width: '100%',
        maxWidth: 380,
        background: T.surface,
        border: `1px solid ${isLow ? T.amberBorder : T.border}`,
        borderRadius: 16,
        padding: 20,
        boxShadow: '0 1px 2px rgba(15,23,41,0.04), 0 6px 20px rgba(15,23,41,0.04)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <Eyebrow icon={Users}>Team balance</Eyebrow>
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

      <div
        style={{ marginTop: 14, display: 'flex', alignItems: 'baseline', gap: 9, flexWrap: 'wrap' }}
      >
        <span
          style={{
            fontSize: 32,
            fontWeight: 700,
            letterSpacing: '-0.02em',
            color: isZero ? T.faint : T.ink,
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {aud(bal)}
        </span>
        {!isZero && (
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              fontSize: 13.5,
              fontWeight: 500,
              color: T.muted,
            }}
          >
            \u2248 {usd(bal)}{' '}
            <Disclosure text="Indicative only \u2014 charged in AUD; your bank sets the final rate." />
          </span>
        )}
      </div>

      <div
        style={{ marginTop: 7, fontSize: 12.5, color: T.muted, fontWeight: 500, lineHeight: 1.5 }}
      >
        {isZero ? (
          <>Your team\u2019s balance is used up. Ask {ADMIN} to top up to start a consultation.</>
        ) : isLow ? (
          <>Shared across your team \u00b7 {ADMIN} manages top-ups.</>
        ) : (
          <>Shared across your team \u00b7 {ADMIN} manages top-ups.</>
        )}
      </div>

      <div style={{ marginTop: 16 }}>
        {isZero ? (
          <NudgeButton
            block
            label={`Ask ${ADMIN} to top up`}
            requested={requested}
            onNudge={onNudge}
          />
        ) : isLow ? (
          <NudgeButton
            block
            label={`Nudge ${ADMIN} to top up`}
            requested={requested}
            onNudge={onNudge}
            tone="subtle"
          />
        ) : (
          <div
            style={{
              fontSize: 12,
              color: T.faint,
              fontWeight: 500,
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            <ShieldCheck size={13} strokeWidth={2.2} style={{ color: T.green }} /> You can start a
            consultation anytime.
          </div>
        )}
      </div>
    </div>
  );
}

// ── MEMBER IN-SESSION ────────────────────────────────────────────────────
const SESS = {
  healthy: {
    elapsed: '00:42:10',
    paused: false,
    meter: { mode: 'balance', pct: 72, tone: 'blue', label: 'Team balance healthy' },
    tone: 'none',
  },
  low: {
    elapsed: '00:58:40',
    paused: false,
    meter: { mode: 'balance', pct: 9, tone: 'amber', label: 'Team balance running low' },
    tone: 'amber',
    title: 'Your team\u2019s balance is running low',
    body: `About 8 minutes left. Your session won\u2019t be interrupted \u2014 extra time settles to your team\u2019s card afterward. Want to let ${ADMIN} know?`,
    nudge: `Let ${ADMIN} know`,
    channels: ['in-app'],
  },
  grace: {
    elapsed: '01:04:00',
    paused: false,
    meter: { mode: 'grace', pct: 16, tone: 'grad', label: 'Keeping you going' },
    tone: 'keep',
    title: 'We\u2019re keeping you going',
    body: 'Your team\u2019s balance is used \u2014 no interruption. Extra time from here settles to your team\u2019s card afterward.',
    channels: ['in-app', 'sms'],
    sms: 'Your session continues past your team\u2019s balance \u2014 extra time settles to the team card afterward.',
  },
  near: {
    elapsed: '01:48:20',
    paused: false,
    meter: { mode: 'grace', pct: 82, tone: 'grad', label: 'Wrapping soon' },
    tone: 'amber',
    title: 'Coming up on a good place to wrap',
    body: `About 10 more minutes before we pause to settle up. Want ${ADMIN} to top up so you can keep going?`,
    nudge: `Ask ${ADMIN} to top up`,
    channels: ['in-app', 'sms'],
    sms: 'Your session is nearing the end of its extra time \u2014 ask your admin to top up to keep going.',
  },
  wrap: {
    elapsed: '01:54:00',
    paused: true,
    meter: { mode: 'grace', pct: 100, tone: 'grad', label: 'Paused' },
    tone: 'wrap',
    title: 'Let\u2019s pause here for now',
    body: `We\u2019ve reached the extra time we can cover this session. Ask ${ADMIN} to top up to pick right back up.`,
    nudge: `Ask ${ADMIN} to top up`,
    channels: ['in-app'],
  },
  end: {
    elapsed: '01:02:30',
    paused: true,
    meter: { mode: 'empty', pct: 0, tone: 'faint', label: 'Team balance used' },
    tone: 'wrap',
    title: 'Your team\u2019s balance is used up',
    body: `Ask ${ADMIN} to top up to keep going \u2014 your expert can pick right back up.`,
    nudge: `Ask ${ADMIN} to top up`,
    channels: ['in-app'],
  },
};
const TONE = {
  none: null,
  amber: { bg: T.amberBg, bd: T.amberBorder, icon: Wallet, grad: false },
  keep: { bg: T.primaryLight, bd: T.primaryBorder, icon: ShieldCheck, grad: true },
  wrap: { bg: '#F1F5F9', bd: T.border, icon: PauseCircle, grad: false },
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
            transition: 'width .5s, background .4s',
          }}
        />
      </div>
    </div>
  );
}

function MemberSession({ step, requested, onNudge }) {
  const tone = TONE[step.tone];
  const paused = step.paused;
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
      <div
        style={{
          position: 'relative',
          overflow: 'hidden',
          padding: '22px 24px 24px',
          background: `linear-gradient(160deg, ${T.heroTop}, ${T.heroBot})`,
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
          <span
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
          </span>
        </div>
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
            }}
          >
            {step.elapsed}
          </span>
        </div>
        <Meter meter={step.meter} />
      </div>

      <div style={{ padding: 22 }}>
        {tone ? (
          <div
            style={{
              borderRadius: 16,
              border: `1px solid ${tone.bd}`,
              background: tone.bg,
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
                  style={{ color: tone.grad ? '#fff' : T.ink2 }}
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
                {step.nudge && (
                  <div style={{ marginTop: 14 }}>
                    <NudgeButton
                      label={step.nudge}
                      requested={requested}
                      onNudge={onNudge}
                      tone={
                        step.tone === 'wrap' ||
                        (step.tone === 'amber' && step.meter.mode === 'empty')
                          ? 'primary'
                          : 'subtle'
                      }
                    />
                  </div>
                )}
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
                      }}
                    >
                      Notifies you
                    </span>
                    {step.channels.map((c) => (
                      <span
                        key={c}
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 4,
                          fontSize: 10.5,
                          fontWeight: 700,
                          textTransform: 'uppercase',
                          color: c === 'sms' ? T.primaryTo : T.muted,
                          background: c === 'sms' ? 'rgba(124,58,237,0.08)' : T.bg,
                          border: `1px solid ${c === 'sms' ? 'rgba(124,58,237,0.25)' : T.border}`,
                          padding: '2px 7px',
                          borderRadius: 999,
                        }}
                      >
                        {c === 'sms' ? 'SMS' : 'In-app'}
                      </span>
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
              You\u2019re all set \u2014 time draws from your team\u2019s balance as you talk.
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

// ── playground ────────────────────────────────────────────────────────────
export default function App() {
  const [view, setView] = useState('wallet');
  const [wState, setWState] = useState('healthy');
  const [mandate, setMandate] = useState(true);
  const [sIdx, setSIdx] = useState(0);
  const [requested, setRequested] = useState(false);

  useEffect(() => {
    setRequested(false);
  }, [view, wState, sIdx, mandate]);

  const seq = mandate ? ['healthy', 'low', 'grace', 'near', 'wrap'] : ['healthy', 'low', 'end'];
  const labels = mandate
    ? ['Healthy', 'Running low', 'Keep me going', 'Near wrap', 'Wrap']
    : ['Healthy', 'Running low', 'Balance used'];
  const sKey = seq[Math.min(sIdx, seq.length - 1)];
  const cur = Math.min(sIdx, seq.length - 1);

  const notes =
    view === 'wallet'
      ? [
          [
            'Team balance, not personal',
            'Framed as the shared company balance with who manages it named, so the member knows this isn\u2019t their wallet and knows who to ask.',
          ],
          [
            'No Top up \u2014 a nudge instead',
            "The member can\u2019t top up. Their action is to nudge the billing.manage holder; on send it confirms ('We let Sam know') and notifies the admin.",
          ],
          [
            'Consume, not manage',
            'No card, no modes, no settings on any member surface \u2014 they can start consultations and see the balance, nothing more.',
          ],
        ]
      : [
          [
            'Grace on the company mandate',
            "A member with no personal card still runs on grace, because it resolves against the COMPANY mandate. Copy says 'your team\u2019s card'.",
          ],
          [
            'Team-framed, no jargon',
            "Low/near/wrap read 'your team\u2019s balance', and the member\u2019s action is to nudge the admin \u2014 never 'top up'. 'Overdraft' never appears.",
          ],
          [
            'No card = warm wrap',
            "Toggle the mandate off: no grace, the session wraps warmly at the used-up balance with an 'ask Sam to top up' path.",
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
          <Eyebrow>BAL-381 \u00b7 ADR-1040 \u00b7 Design reference</Eyebrow>
          <h1
            style={{ margin: '8px 0 4px', fontSize: 24, fontWeight: 700, letterSpacing: '-0.02em' }}
          >
            Member-variant wallet &amp; in-session
          </h1>
          <p style={{ margin: 0, fontSize: 14.5, color: T.muted, lineHeight: 1.55, maxWidth: 660 }}>
            The member lens (no billing.manage): sees and spends the shared team balance, but
            can\u2019t top up. When the balance runs low, the member nudges the admin instead. Grace
            still protects a live session on the company mandate.
          </p>
        </div>

        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 14,
            alignItems: 'center',
            marginBottom: 22,
          }}
        >
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
              ['wallet', 'Wallet'],
              ['session', 'In session'],
            ].map(([v, l]) => (
              <button
                key={v}
                onClick={() => setView(v)}
                style={{
                  padding: '7px 14px',
                  borderRadius: 8,
                  cursor: 'pointer',
                  fontFamily: FONT,
                  fontSize: 13,
                  fontWeight: 600,
                  border: 'none',
                  color: view === v ? '#fff' : T.muted,
                  background: view === v ? T.ink : 'transparent',
                }}
              >
                {l}
              </button>
            ))}
          </div>

          {view === 'wallet' ? (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {[
                ['healthy', 'Healthy'],
                ['low', 'Low'],
                ['zero', 'Used up'],
              ].map(([k, l]) => (
                <button
                  key={k}
                  onClick={() => setWState(k)}
                  style={{
                    padding: '7px 13px',
                    borderRadius: 9,
                    cursor: 'pointer',
                    fontFamily: FONT,
                    fontSize: 13,
                    fontWeight: 600,
                    border: `1px solid ${wState === k ? T.primaryBorder : T.border}`,
                    color: wState === k ? T.primary : T.muted,
                    background: wState === k ? T.primaryLight : '#fff',
                  }}
                >
                  {l}
                </button>
              ))}
            </div>
          ) : (
            <>
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
                  ['Team card on file', true],
                  ['No card', false],
                ].map(([l, v]) => (
                  <button
                    key={String(v)}
                    onClick={() => {
                      setMandate(v);
                      setSIdx((i) => Math.min(i, (v ? 5 : 3) - 1));
                    }}
                    style={{
                      padding: '7px 12px',
                      borderRadius: 8,
                      cursor: 'pointer',
                      fontFamily: FONT,
                      fontSize: 12.5,
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
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
                {labels.map((l, i) => (
                  <React.Fragment key={l}>
                    <button
                      onClick={() => setSIdx(i)}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 7,
                        padding: '7px 11px',
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
                          width: 17,
                          height: 17,
                          borderRadius: 999,
                          display: 'inline-flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          fontSize: 10,
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
                      <ArrowRight size={12} strokeWidth={2.4} style={{ color: T.faint }} />
                    )}
                  </React.Fragment>
                ))}
              </div>
            </>
          )}
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns:
              view === 'wallet' ? 'minmax(0, 380px) 1fr' : 'minmax(0, 520px) 1fr',
            gap: 24,
            alignItems: 'start',
          }}
          className="stage"
        >
          <style>{`@media(max-width:780px){.stage{grid-template-columns:1fr !important}}`}</style>

          {view === 'wallet' ? (
            <MemberWallet state={wState} requested={requested} onNudge={() => setRequested(true)} />
          ) : (
            <MemberSession
              step={SESS[sKey]}
              requested={requested}
              onNudge={() => setRequested(true)}
            />
          )}

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
              "{ADMIN}" resolves to the company\u2019s billing.manage holder(s); the nudge routes
              through the notification engine to them. Try: press a nudge to see the "we let {ADMIN}{' '}
              know" confirmation.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
