import React, { useState, useEffect, useRef } from 'react';
import {
  ShieldCheck,
  ChevronLeft,
  Loader2,
  Receipt,
  Wallet,
  Lock,
  Tag,
  X,
  Gift,
  Check,
  AlertTriangle,
  AlertCircle,
  ChevronDown,
  Monitor,
  Smartphone,
  UserPlus,
  Bold,
  Italic,
  List,
  Link2,
  Bell,
  Info,
} from 'lucide-react';

/**
 * Booking — inline funding on "Review & confirm" · prototype
 * ----------------------------------------------------------------------------
 * Today a funding refusal swaps Step 2 for FundingSetupPanel / BookingBalancePanel.
 * A manager's only way forward is /billing/top-up, which closes the dialog, and the
 * next open starts fresh, so the draft is lost. Here the same verdict
 * (assessCaseBookingFunding) is read as the step opens, and the remedy renders
 * inline between BillingLine and the footer. The form above it never unmounts.
 *
 * Scenarios = the verdict's refusal arms × the client's card state:
 *   setup    — no_wallet / no_mandate_insufficient_balance (BAL-478 posture: no figure)
 *   reserved — reserved_by_upcoming (D6.5: figure)
 *   hold     — account_on_hold (D6.1: figure; checked before the mandate, so no Pay after)
 *   member   — *_admins_notified (no MANAGE_BILLING)
 *
 * "Pay after the call" = card-backed mode: an active mandate passes the verdict's
 * mandate arm with no money moving now. No rate anywhere (D4c).
 *
 * NO SLOT HOLD (owner decision, Oct 2026): volume doesn't justify one. A time taken
 * mid-payment keeps the money and lands on the existing stale-slot banner.
 *
 * MEMBER DRAFT IS LOCAL ONLY (Oct 2026): "Save and finish later" keeps the typed fields
 * in this browser, not the database. No server draft table, and no case row (writing a
 * case opens a conversation thread with the expert, and the funding gate runs before any
 * write on purpose).
 * Tokens follow purchase-screen-2.jsx. Font: Geist (repo). Copy is placeholder for MJ
 * except the reserved/hold strings, which reuse copy v2.1.
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
  primaryLight: '#EFF6FF',
  primaryBorder: '#BFDBFE',
  infoTint: '#F5F9FF',
  green: '#059669',
  greenBg: '#ECFDF5',
  greenBorder: '#A7F3D0',
  red: '#B91C1C',
  redBg: '#FEF2F2',
  redBorder: '#FECACA',
  amber: '#B45309',
  amberBg: '#FFFBEB',
  amberBorder: '#FDE68A',
  backdrop: 'rgba(15,23,41,0.42)',
};
const FONT = "'Geist', ui-sans-serif, system-ui, -apple-system, sans-serif";
const SF = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif";

/* Mirrors @balo/shared: TOP_UP_LIMITS_MINOR, MIN_MEETING_MINUTES */
const TOP_UP = { min: 30000, max: 1000000, step: 10000 };
const MIN_MEETING_MINUTES = 15;
const TIERS = [30000, 100000, 500000];
const PROMOS = { NEWTOBALO: 2500, WELCOME50: 5000 };

const COMPANY = 'Northwind';
const SAVED = { brand: 'Visa', last4: '4242', exp: '08/28' };
const NEW_CARD = { brand: 'Mastercard', last4: '4444' };
const EXPERT = { name: 'Priya Natarajan', first: 'Priya', party: 'Northstar CRM', initials: 'PN' };
const DRAFT = {
  title: 'Flow errors since the Spring release',
  desc: 'Two record-triggered flows on Opportunity started failing intermittently after the upgrade. Looking for a second pair of eyes on the fault paths and bulkification before quarter end.',
};
const SLOTS = [
  { id: 's1', date: 'Tue 21 Oct', time: '2:30 pm', dur: 30 },
  { id: 's2', date: 'Wed 22 Oct', time: '10:00 am', dur: 30 },
  { id: 's3', date: 'Wed 22 Oct', time: '3:15 pm', dur: 30 },
  { id: 's4', date: 'Thu 23 Oct', time: '11:30 am', dur: 30 },
];

/**
 * `suggested` is server-computed: the smallest valid top-up (A$100 steps, A$300 floor)
 * that makes the verdict pass. On the setup arm it is never stated as a figure.
 */
const SCENARIOS = [
  {
    id: 'brand_new',
    label: 'Never topped up, no card',
    arm: 'setup',
    firstTime: true,
    saved: false,
    suggested: 30000,
    payAfter: true,
  },
  {
    id: 'low_saved',
    label: 'Low balance, card saved',
    arm: 'setup',
    firstTime: false,
    saved: true,
    suggested: 30000,
    payAfter: true,
  },
  {
    id: 'low_nocard',
    label: 'Low balance, no card',
    arm: 'setup',
    firstTime: false,
    saved: false,
    suggested: 30000,
    payAfter: true,
  },
  {
    id: 'reserved',
    label: 'Balance set aside',
    arm: 'reserved',
    saved: true,
    figure: 27500,
    reservedCount: 2,
    suggested: 30000,
    payAfter: true,
  },
  {
    id: 'hold',
    label: 'Account on hold',
    arm: 'hold',
    saved: true,
    figure: 41250,
    suggested: 50000,
    payAfter: false,
  },
  { id: 'member', label: 'Member, no billing access', arm: 'member' },
  { id: 'funded', label: 'Enough balance', arm: 'none' },
];

const OUTCOMES = [
  ['success', 'Succeeds'],
  ['declined', 'Card declined'],
  ['auth', 'Bank asks to verify'],
  ['slot_taken', 'Time gets taken'],
];

const aud = (m) =>
  'A$' + (m / 100).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const audShort = (m) => 'A$' + Math.round(m / 100).toLocaleString('en-AU');
const cardName = (c) => `${c.brand} •••• ${c.last4}`;

function fundingCopy(sc) {
  switch (sc.arm) {
    case 'setup':
      return sc.firstTime
        ? {
            heading: 'One setup step first',
            body: `Consultations are paid from ${COMPANY}'s balance. Top up now, or add a card and pay for the time used after each call.`,
          }
        : {
            heading: `${COMPANY}'s balance needs a top-up for this one`,
            body: 'Top up now, or let a card cover any time beyond the balance, charged after the call.',
          };
    case 'reserved':
      return {
        heading: `Part of ${COMPANY}'s balance is set aside for planned consultations`,
        body: `Part of ${COMPANY}'s balance is set aside for ${sc.reservedCount} upcoming consultations, so there isn't enough left to book this one. A top-up of ${aud(sc.figure)} or more would make room for it.`,
      };
    case 'hold':
      return {
        heading: 'One thing to settle first',
        body: `${COMPANY}'s balance needs a top-up of ${aud(sc.figure)} or more before new consultations can be booked. Consultations already booked aren't affected.`,
      };
    case 'member':
      return {
        heading: 'A billing admin needs to set this up',
        body: `Booking needs a payment method on file or enough credit in ${COMPANY}'s balance, and only billing admins can add either. Save this booking and we'll let them know. What you've typed stays on this device for when you come back.`,
      };
    default:
      return null;
  }
}

function fundedText(f) {
  return f.kind === 'topup'
    ? `${aud(f.credited)} added to ${COMPANY}'s balance with ${cardName(f.card)}.`
    : `${cardName(f.card)} covers time beyond ${COMPANY}'s balance, charged after each call.`;
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

function prefersReducedMotion() {
  return (
    typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  );
}

/* ---------- primitives ---------- */

function Btn({ children, onClick, variant = 'primary', disabled, busy, small, style }) {
  const v =
    variant === 'outline'
      ? { background: '#fff', color: T.ink2, border: `1px solid ${T.border}` }
      : { background: T.primary, color: '#fff', border: `1px solid ${T.primary}` };
  let cursor = 'pointer';
  if (busy) cursor = 'progress';
  else if (disabled) cursor = 'not-allowed';
  return (
    <button
      type="button"
      className={`btn btn-${variant}`}
      onClick={onClick}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      style={{
        fontFamily: FONT,
        fontSize: small ? 13 : 14,
        fontWeight: 600,
        height: small ? 32 : 40,
        padding: small ? '0 12px' : '0 16px',
        borderRadius: 10,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        whiteSpace: 'nowrap',
        cursor,
        opacity: disabled && !busy ? 0.5 : 1,
        transition: 'background .15s, border-color .15s',
        ...v,
        ...style,
      }}
    >
      {children}
    </button>
  );
}

const LinkBtn = ({ children, onClick, muted, disabled, icon: Icon }) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    style={{
      background: 'none',
      border: 'none',
      padding: 0,
      cursor: disabled ? 'default' : 'pointer',
      fontFamily: FONT,
      fontSize: 13,
      fontWeight: 600,
      color: muted ? T.muted : T.primary,
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      opacity: disabled ? 0.5 : 1,
    }}
  >
    {Icon && <Icon size={14} strokeWidth={2.4} />}
    {children}
  </button>
);

const FieldLabel = ({ children, id }) => (
  <div id={id} style={{ fontSize: 13.5, fontWeight: 600, color: T.ink2, marginBottom: 8 }}>
    {children}
  </div>
);

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

function Field({ label, required, optional, htmlFor, error, children }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <label htmlFor={htmlFor} style={{ fontSize: 14, fontWeight: 600, color: T.ink }}>
        {label}
        {required && <span style={{ color: T.red }}> *</span>}
        {optional && <span style={{ color: T.muted, fontWeight: 400 }}> (optional)</span>}
      </label>
      {children}
      {error && (
        <p role="alert" style={{ margin: 0, fontSize: 12, color: T.red }}>
          {error}
        </p>
      )}
    </div>
  );
}

/* ---------- existing booking chrome (unchanged, simplified) ---------- */

function DialogHeader({ step }) {
  const steps = [
    ['pick_time', 'Choose a time'],
    ['confirm', 'Review & confirm'],
  ];
  return (
    <div
      style={{
        borderBottom: `1px solid ${T.borderSubtle}`,
        background: '#fff',
        padding: '20px 24px 14px',
        flexShrink: 0,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span
          style={{
            width: 40,
            height: 40,
            borderRadius: 12,
            background: T.primaryLight,
            color: T.primary,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 14,
            fontWeight: 600,
            flexShrink: 0,
          }}
        >
          {EXPERT.initials}
        </span>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 14, fontWeight: 600, color: T.ink }}>{EXPERT.name}</span>
            <ShieldCheck size={14} color={T.green} aria-label="Verified by Balo" />
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              fontSize: 12,
              color: T.muted,
              marginTop: 1,
            }}
          >
            <span>@{EXPERT.party}</span>
            <span aria-hidden="true" style={{ opacity: 0.4 }}>
              ·
            </span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontWeight: 500 }}>
              <span style={{ width: 6, height: 6, borderRadius: 999, background: T.green }} />
              Available now
            </span>
          </div>
        </div>
      </div>
      <div style={{ marginTop: 14 }}>
        {step === 'booked' ? (
          <p style={{ margin: 0, fontSize: 14, fontWeight: 600, color: T.ink }}>
            Booking confirmed
          </p>
        ) : (
          <ol
            aria-label="Booking steps"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              margin: 0,
              padding: 0,
              listStyle: 'none',
            }}
          >
            {steps.map(([k, l], i) => (
              <li key={k} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {i > 0 && (
                  <span aria-hidden="true" style={{ width: 16, height: 1, background: T.border }} />
                )}
                <span
                  aria-current={k === step ? 'step' : undefined}
                  style={{
                    fontSize: 12,
                    fontWeight: 600,
                    color: k === step ? T.primary : 'rgba(100,116,139,0.6)',
                  }}
                >
                  {l}
                </span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

function EditorMock({ value, onChange, invalid }) {
  return (
    <div
      style={{
        border: `1px solid ${invalid ? T.redBorder : T.border}`,
        borderRadius: 10,
        overflow: 'hidden',
        background: '#fff',
      }}
    >
      <div
        style={{
          display: 'flex',
          gap: 2,
          padding: '6px 8px',
          borderBottom: `1px solid ${T.borderSubtle}`,
          background: T.bg,
        }}
      >
        {[Bold, Italic, List, Link2].map((I, i) => (
          <span
            key={i}
            aria-hidden="true"
            style={{
              width: 28,
              height: 26,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: T.muted,
              borderRadius: 6,
            }}
          >
            <I size={14} />
          </span>
        ))}
      </div>
      <textarea
        aria-label="What you'd like to discuss"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={4}
        style={{
          width: '100%',
          border: 'none',
          resize: 'vertical',
          padding: '10px 12px',
          fontFamily: FONT,
          fontSize: 14,
          color: T.ink,
          lineHeight: 1.55,
          outline: 'none',
          display: 'block',
        }}
      />
    </div>
  );
}

function ProductsMock() {
  return (
    <Field label="Salesforce products" optional>
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 6,
          alignItems: 'center',
          border: `1px solid ${T.border}`,
          borderRadius: 10,
          padding: '7px 10px 7px 8px',
          minHeight: 40,
        }}
      >
        {['Sales Cloud', 'Flow'].map((p) => (
          <span
            key={p}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              fontSize: 12.5,
              fontWeight: 600,
              color: T.primary,
              background: T.primaryLight,
              borderRadius: 999,
              padding: '3px 7px 3px 10px',
            }}
          >
            {p}
            <X size={12} aria-hidden="true" />
          </span>
        ))}
        <span style={{ fontSize: 13, color: T.faint, marginLeft: 4 }}>Filter products…</span>
        <ChevronDown size={16} color={T.faint} style={{ marginLeft: 'auto' }} aria-hidden="true" />
      </div>
    </Field>
  );
}

function BillingLine() {
  return (
    <p
      style={{
        margin: 0,
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        fontSize: 14,
        color: T.muted,
      }}
    >
      <Receipt size={14} aria-hidden="true" style={{ flexShrink: 0 }} />
      Charged only for time used · {MIN_MEETING_MINUTES}-minute minimum applies.
    </p>
  );
}

function StaleBanner({ fundedVia, onChooseNewTime }) {
  let followUp = null;
  if (fundedVia?.kind === 'topup') {
    followUp = `Your top-up went through, so ${aud(fundedVia.credited)} is in ${COMPANY}'s balance for the next time you choose.`;
  } else if (fundedVia?.kind === 'payafter') {
    followUp = `${cardName(fundedVia.card)} is set up and ready for the next time you choose.`;
  }
  return (
    <div
      role="alert"
      style={{
        background: T.amberBg,
        border: `1px solid ${T.amberBorder}`,
        borderRadius: 10,
        padding: 12,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        flexWrap: 'wrap',
      }}
    >
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', minWidth: 200, flex: 1 }}>
        <AlertTriangle
          size={16}
          color={T.amber}
          style={{ flexShrink: 0, marginTop: 1 }}
          aria-hidden="true"
        />
        <div style={{ fontSize: 12.5, color: T.ink2, fontWeight: 500, lineHeight: 1.45 }}>
          This time was just booked by someone else.
          {followUp && (
            <span style={{ display: 'block', color: T.muted, marginTop: 2 }}>{followUp}</span>
          )}
        </div>
      </div>
      <Btn variant="outline" small onClick={onChooseNewTime}>
        Choose a new time
      </Btn>
    </div>
  );
}

/* ---------- the new part: inline funding ---------- */

function MethodPicker({ method, setMethod, compact, busy }) {
  const opts = [
    {
      id: 'topup',
      title: 'Top up now',
      desc: `Add funds to ${COMPANY}'s balance. Each consultation draws from it.`,
    },
    {
      id: 'payafter',
      title: 'Pay after the call',
      desc: 'No charge now. Time beyond the balance is charged to a card after each call.',
    },
  ];
  return (
    <div
      role="radiogroup"
      aria-label="How to pay"
      style={{ display: 'grid', gridTemplateColumns: compact ? '1fr' : '1fr 1fr', gap: 10 }}
    >
      {opts.map((o) => {
        const on = method === o.id;
        return (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={busy}
            onClick={() => setMethod(o.id)}
            style={{
              textAlign: 'left',
              fontFamily: FONT,
              background: on ? T.primaryLight : '#fff',
              border: `1.5px solid ${on ? T.primary : T.border}`,
              borderRadius: 12,
              padding: '12px 14px',
              cursor: busy ? 'default' : 'pointer',
              display: 'flex',
              gap: 10,
              alignItems: 'flex-start',
              transition: 'border-color .14s, background .14s',
            }}
          >
            <span style={{ marginTop: 1 }}>
              <RadioDot on={on} />
            </span>
            <span>
              <span style={{ display: 'block', fontSize: 14, fontWeight: 600, color: T.ink2 }}>
                {o.title}
              </span>
              <span
                style={{
                  display: 'block',
                  marginTop: 3,
                  fontSize: 12.5,
                  color: T.muted,
                  lineHeight: 1.45,
                }}
              >
                {o.desc}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

function AmountPicker({
  chips,
  amount,
  setAmount,
  other,
  setOther,
  otherVal,
  setOtherVal,
  amountErr,
  showAmountErr,
  minNeeded,
  promo,
  effAmount,
  compact,
  busy,
}) {
  const chipStyle = (on) => ({
    fontFamily: FONT,
    cursor: busy ? 'default' : 'pointer',
    background: on ? T.primaryLight : '#fff',
    border: `1.5px solid ${on ? T.primary : T.border}`,
    borderRadius: 12,
    padding: '10px 6px',
    minHeight: 58,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    transition: 'border-color .14s, background .14s',
  });
  const errShown = showAmountErr && amountErr;
  return (
    <div>
      <FieldLabel id="amount-label">Amount</FieldLabel>
      <div
        role="radiogroup"
        aria-labelledby="amount-label"
        style={{
          display: 'grid',
          gridTemplateColumns: compact ? '1fr 1fr' : 'repeat(4, 1fr)',
          gap: 8,
        }}
      >
        {chips.map((c, i) => {
          const on = !other && amount === c;
          return (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={on}
              disabled={busy}
              onClick={() => {
                setOther(false);
                setAmount(c);
              }}
              style={chipStyle(on)}
            >
              <span
                style={{
                  fontSize: 15,
                  fontWeight: 700,
                  color: T.ink,
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                {audShort(c)}
              </span>
              {i === 0 && (
                <span
                  style={{
                    fontSize: 11,
                    fontWeight: 600,
                    marginTop: 2,
                    color: on ? T.primary : T.faint,
                  }}
                >
                  Minimum
                </span>
              )}
            </button>
          );
        })}
        <button
          type="button"
          role="radio"
          aria-checked={other}
          disabled={busy}
          onClick={() => setOther(true)}
          style={chipStyle(other)}
        >
          <span style={{ fontSize: 14, fontWeight: 600, color: other ? T.primary : T.ink2 }}>
            Other
          </span>
        </button>
      </div>
      {other && (
        <div style={{ marginTop: 10 }}>
          <div style={{ position: 'relative' }}>
            <span
              aria-hidden="true"
              style={{
                position: 'absolute',
                left: 12,
                top: '50%',
                transform: 'translateY(-50%)',
                fontSize: 14,
                fontWeight: 600,
                color: T.faint,
              }}
            >
              A$
            </span>
            <input
              autoFocus
              inputMode="numeric"
              aria-label="Top-up amount in Australian dollars"
              aria-invalid={errShown ? true : undefined}
              value={otherVal}
              disabled={busy}
              onChange={(e) => setOtherVal(e.target.value)}
              placeholder={String(minNeeded / 100)}
              style={{
                width: '100%',
                fontFamily: FONT,
                fontSize: 15,
                fontWeight: 600,
                color: T.ink,
                padding: '10px 12px 10px 36px',
                borderRadius: 10,
                border: `1.5px solid ${errShown ? T.redBorder : T.border}`,
                background: errShown ? T.redBg : '#fff',
                outline: 'none',
              }}
            />
          </div>
          <p
            style={{
              margin: '6px 0 0',
              fontSize: 12,
              fontWeight: 500,
              color: errShown ? T.red : T.muted,
            }}
          >
            {errShown
              ? amountErr
              : `Between ${audShort(minNeeded)} and ${audShort(TOP_UP.max)}, in A$100 steps.`}
          </p>
        </div>
      )}
      {promo && effAmount != null && (
        <p
          style={{
            margin: '10px 0 0',
            fontSize: 12.5,
            fontWeight: 600,
            color: T.green,
            display: 'flex',
            alignItems: 'center',
            gap: 6,
          }}
        >
          <Gift size={14} aria-hidden="true" /> Adds {aud(effAmount + promo.minor)} to {COMPANY}'s
          balance.
        </p>
      )}
    </div>
  );
}

/* Reused from purchase-screen-2.jsx (PromoRow) */
function PromoRow({ promo, setPromo, busy }) {
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
          padding: '10px 14px',
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
          <Gift size={15} strokeWidth={2.4} aria-hidden="true" /> {promo.code} applied —{' '}
          {audShort(promo.minor)} bonus credit
        </span>
        <button
          type="button"
          onClick={() => setPromo(null)}
          disabled={busy}
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
        <LinkBtn icon={Tag} disabled={busy} onClick={() => setOpen(true)}>
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
          disabled={busy}
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
            padding: '10px 14px',
            borderRadius: 11,
            outline: 'none',
            border: `1.5px solid ${err ? T.redBorder : T.border}`,
            background: err ? T.redBg : '#fff',
            textTransform: 'uppercase',
          }}
        />
        <button
          type="button"
          onClick={apply}
          disabled={busy}
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
          type="button"
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

/* Stripe Payment Element — MOCK. The real one is an iframe from Stripe's domain. */
function PaymentElementMock({ disabled }) {
  const label = { fontFamily: SF, fontSize: 14, color: '#30313d', marginBottom: 6 };
  const box = {
    width: '100%',
    height: 42,
    border: '1px solid #e6e6e6',
    borderRadius: 5,
    padding: '0 12px',
    fontSize: 15,
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
        padding: '18px 14px 14px',
        background: '#fff',
        opacity: disabled ? 0.6 : 1,
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
        Stripe Payment Element (mock)
      </div>
      <div style={label}>Card number</div>
      <div style={{ position: 'relative', marginBottom: 12 }}>
        <input
          className="pe-input"
          readOnly
          placeholder="1234 1234 1234 1234"
          style={box}
          aria-label="Card number (mock)"
        />
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
          <input
            className="pe-input"
            readOnly
            placeholder="MM / YY"
            style={box}
            aria-label="Expiration date (mock)"
          />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={label}>Security code</div>
          <input
            className="pe-input"
            readOnly
            placeholder="CVC"
            style={box}
            aria-label="Security code (mock)"
          />
        </div>
      </div>
      <div style={label}>Country</div>
      <div
        style={{ ...box, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
      >
        <span>Australia</span>
        <ChevronDown size={16} style={{ color: '#6d6e78' }} aria-hidden="true" />
      </div>
      <p
        style={{
          fontFamily: SF,
          fontSize: 12.5,
          color: '#6d6e78',
          lineHeight: 1.5,
          margin: '12px 0 0',
        }}
      >
        By providing your card information, you allow Balo to charge your card for future payments
        in accordance with their terms.
      </p>
    </div>
  );
}

function SavedCardRow({ onChange, disabled }) {
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
        flexWrap: 'wrap',
      }}
    >
      <Mark bg="#1A1F71">VISA</Mark>
      <div style={{ flex: 1, minWidth: 120 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: T.ink2 }}>{cardName(SAVED)}</div>
        <div style={{ fontSize: 12, color: T.muted, fontWeight: 500, marginTop: 2 }}>
          Expires {SAVED.exp}
        </div>
      </div>
      <LinkBtn onClick={onChange} disabled={disabled}>
        Use a different card
      </LinkBtn>
    </div>
  );
}

function PaymentPicker({ method, saved, cardOnFile, setUseNew, busy, payError }) {
  const cardText = cardOnFile ? cardName(SAVED) : 'this card';
  return (
    <div>
      <FieldLabel>
        {method === 'payafter' ? 'Card to charge after each call' : 'Pay with'}
      </FieldLabel>
      {cardOnFile ? (
        <SavedCardRow onChange={() => setUseNew(true)} disabled={busy} />
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
            <Lock size={12} strokeWidth={2.4} style={{ color: T.faint }} aria-hidden="true" />
            Entered directly with Stripe — Balo never sees your card number.
          </div>
          <PaymentElementMock disabled={busy} />
          {saved && (
            <div style={{ marginTop: 10 }}>
              <LinkBtn muted disabled={busy} onClick={() => setUseNew(false)}>
                Keep {cardName(SAVED)} instead
              </LinkBtn>
            </div>
          )}
        </>
      )}
      {method === 'payafter' && (
        <p
          style={{
            margin: '10px 0 0',
            fontSize: 12,
            color: T.muted,
            lineHeight: 1.5,
            display: 'flex',
            gap: 7,
            fontWeight: 500,
          }}
        >
          <Info
            size={13}
            strokeWidth={2.2}
            style={{ color: T.faint, flexShrink: 0, marginTop: 1 }}
            aria-hidden="true"
          />
          <span>
            By booking, you let Balo charge {cardText} for consultation time beyond {COMPANY}'s
            balance, after each call. Change or turn this off anytime in Billing settings.
          </span>
        </p>
      )}
      {payError && (
        <div
          role="alert"
          style={{
            marginTop: 10,
            display: 'flex',
            gap: 8,
            alignItems: 'flex-start',
            background: T.redBg,
            border: `1px solid ${T.redBorder}`,
            borderRadius: 10,
            padding: '10px 12px',
            fontSize: 13,
            color: T.red,
            fontWeight: 500,
            lineHeight: 1.45,
          }}
        >
          <AlertCircle size={16} style={{ flexShrink: 0, marginTop: 1 }} aria-hidden="true" />
          {payError}
        </div>
      )}
    </div>
  );
}

function FundingBlock(props) {
  const { sc, compact, busy, method, setMethod } = props;
  const copy = fundingCopy(sc);
  const isMember = sc.arm === 'member';
  return (
    <section
      data-funding
      className="fund-in"
      aria-labelledby="funding-heading"
      style={{
        border: `1px solid ${T.primaryBorder}`,
        borderRadius: 14,
        overflow: 'hidden',
        background: '#fff',
      }}
    >
      <div
        style={{
          background: T.infoTint,
          padding: '16px 18px',
          display: 'flex',
          gap: 12,
          alignItems: 'flex-start',
          borderBottom: isMember ? 'none' : `1px solid ${T.borderSubtle}`,
        }}
      >
        <span
          style={{
            width: 36,
            height: 36,
            borderRadius: 10,
            background: 'rgba(37,99,235,0.1)',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
          }}
        >
          <Wallet size={18} color={T.primary} aria-hidden="true" />
        </span>
        <div style={{ minWidth: 0 }}>
          <h3
            id="funding-heading"
            style={{ margin: 0, fontSize: 15, fontWeight: 600, color: T.ink, lineHeight: 1.35 }}
          >
            {copy.heading}
          </h3>
          <p style={{ margin: '4px 0 0', fontSize: 13.5, color: T.muted, lineHeight: 1.55 }}>
            {copy.body}
          </p>
        </div>
      </div>
      {!isMember && (
        <div
          style={{ padding: compact ? 16 : 18, display: 'flex', flexDirection: 'column', gap: 18 }}
        >
          {sc.payAfter && (
            <MethodPicker method={method} setMethod={setMethod} compact={compact} busy={busy} />
          )}
          {method === 'topup' && <AmountPicker {...props} />}
          {method === 'topup' && (
            <PromoRow promo={props.promo} setPromo={props.setPromo} busy={busy} />
          )}
          <PaymentPicker
            method={method}
            saved={!!sc.saved}
            cardOnFile={props.cardOnFile}
            setUseNew={props.setUseNew}
            busy={busy}
            payError={props.payError}
          />
        </div>
      )}
    </section>
  );
}

/* 3DS — MOCK. The real challenge is Stripe's own modal, opened by confirmPayment/confirmSetup. */
function AuthModal({ method, amount, onComplete, onFail }) {
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        background: T.backdrop,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
        zIndex: 30,
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="auth-title"
        style={{
          width: 340,
          maxWidth: '100%',
          background: '#fff',
          borderRadius: 14,
          padding: 20,
          boxShadow: '0 24px 60px rgba(15,23,41,0.3)',
          fontFamily: SF,
        }}
      >
        <div style={{ fontSize: 10.5, fontWeight: 600, color: '#4F46E5', fontFamily: FONT }}>
          Bank verification, Stripe 3D Secure (mock)
        </div>
        <h3
          id="auth-title"
          style={{ margin: '10px 0 6px', fontSize: 16, fontWeight: 600, color: '#30313d' }}
        >
          {method === 'payafter' ? 'Confirm this card' : 'Confirm this payment'}
        </h3>
        <p style={{ margin: 0, fontSize: 13.5, color: '#6d6e78', lineHeight: 1.5 }}>
          {method === 'payafter'
            ? "Your bank wants to confirm you're adding this card to Balo."
            : `Your bank wants to confirm a payment of ${aud(amount)} to Balo.`}
        </p>
        <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
          <Btn variant="outline" small onClick={onFail}>
            Fail
          </Btn>
          <Btn small onClick={onComplete}>
            Complete
          </Btn>
        </div>
      </div>
    </div>
  );
}

/* ---------- prototype chrome ---------- */

function Seg({ options, value, onChange }) {
  return (
    <div
      role="radiogroup"
      style={{
        display: 'inline-flex',
        flexWrap: 'wrap',
        gap: 4,
        background: '#fff',
        border: `1px solid ${T.border}`,
        borderRadius: 11,
        padding: 3,
      }}
    >
      {options.map(([k, l, Icon, disabled]) => {
        const on = value === k;
        return (
          <button
            key={k}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={disabled}
            onClick={() => onChange(k)}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '6px 11px',
              borderRadius: 8,
              cursor: disabled ? 'not-allowed' : 'pointer',
              opacity: disabled ? 0.4 : 1,
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

const Control = ({ label, children }) => (
  <div>
    <div style={{ fontSize: 12, fontWeight: 600, color: T.muted, marginBottom: 6 }}>{label}</div>
    {children}
  </div>
);

const BEHAVIOUR = [
  [
    'Fix it where it fails',
    'The refusal panels replaced this step and sent managers to /billing/top-up, which closed the dialog, so the next open started empty. Now the verdict is read as the step opens, and the fix sits under the form, right above the button. Nothing above it unmounts.',
  ],
  [
    'Two ways through, where both work',
    "Top up now, or Pay after the call (card-backed mode: an active mandate passes the verdict). Pay after is left out on a hold, because the hold is checked before the mandate and a card can't clear it.",
  ],
  [
    'Never topped up, no card',
    "Same block in first-time wording. No figure (BAL-478's posture), the Minimum chip pre-selected, and the Stripe element in place. Pay after needs no amount at all.",
  ],
  [
    'Card saved, no mandate',
    'One press either way: top up the saved card, or let it cover time after the call, with the consent spelled out.',
  ],
  [
    'Members get a way forward',
    "They can't top up, so they get Save and finish later. Billing admins are told, and what they typed is kept on this device. When they book with the same expert again, it's filled back in and they pick a new time.",
  ],
  [
    'When it goes wrong',
    'A decline or failed bank check keeps everything and says nothing was charged. The time is not held while they pay, so if someone else books it first, the money still lands and says so, the existing stale-slot banner shows, and the next time needs no payment.',
  ],
];

const TICKET = [
  [
    'Pre-flight verdict',
    'A new read-only action runs the same readSnapshot + assessCaseBookingFunding as enforceBookingFunding when the step opens and on any slot or company change, with no side effects: booking.funding_blocked fires only on a member Save or a submit-time refusal. Submit-time refusal codes render this block instead of the error_funding / error_balance phases. The gate stays the authority.',
  ],
  [
    'Reuse the top-up composer',
    'PaymentMethodSection, SavedCardRow, PromoField, PayAction and CardBrandMark from components/billing/top-up, driven by startPurchaseAction. Card-only with redirect: "if_required", so bank verification stays in Stripe\'s pop-up.',
  ],
  [
    'Pay, then book',
    'The webhook stays the only credit writer. Poll getTopUpCreditStatusAction (use-topup-credit-poll), then call bookConsultationAction with the same nonce. A poll timeout says the payment went through and keeps everything for another press.',
  ],
  [
    'Pay after = Keep me going',
    'Needs low_balance_mode keep_going AND an active mandate. A mandate alone passes the verdict, but walletAllowsOverdraftGrace is false, so the meter hard-stops at zero. Saved card: saveLowBalanceConfigAction + armSavedCardMandateAction. New card: startCardCaptureAction, confirmSetup, wait for the mandate, then save keep_going.',
  ],
  [
    'Active company only',
    "The top-up actions resolve the wallet from the session's company. A booking billed to another company keeps BookingBalancePanel's switch-and-top-up path, as do figures above TOP_UP_LIMITS_MINOR.max.",
  ],
  [
    'No slot hold',
    "Deliberately none at current volume, so don't add one. A slot_unavailable after funding keeps the credit (or the card setup), shows the stale-slot banner, and leaves the draft filled.",
  ],
  [
    'Draft: this browser only',
    'localStorage, keyed by user, expert and company: title, description, products, guests. Never the time. Written on a member\'s Save, and when a payment starts. On reopen with that expert, restore the fields, start on the time picker, and show a quiet "Filled in from your last visit" line with Clear. Cleared on booking or sign-out; expires after 7 days. No draft table and no case row: writeCase opens an expert conversation thread, and the gate runs before any write on purpose.',
  ],
  [
    'D4c and copy',
    'No rate anywhere; figures only on the reserved and hold arms, as today. Reserved and hold strings reuse copy v2.1. Everything else is placeholder for MJ.',
  ],
  [
    'Analytics',
    'booking_funding_shown {arm, can_manage_billing}, booking_funding_method_selected {method}, booking_funded {method, saved_card}, booking_funding_failed {reason}, booking_saved_for_later. No money figures.',
  ],
  [
    'Notifications',
    "No new events. booking.funding_blocked moves from the pre-check to the member's Save and submit-time refusals, so just viewing the step never pings admins.",
  ],
];

function NoteCard({ title, items }) {
  return (
    <div
      style={{
        background: '#fff',
        border: `1px solid ${T.borderSubtle}`,
        borderRadius: 14,
        padding: 18,
      }}
    >
      <h2 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: T.ink }}>{title}</h2>
      <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 14 }}>
        {items.map(([h, b]) => (
          <div key={h}>
            <div style={{ fontSize: 13, fontWeight: 700, color: T.ink2 }}>{h}</div>
            <div style={{ marginTop: 3, fontSize: 12.5, color: T.muted, lineHeight: 1.55 }}>
              {b}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&display=swap');
*{box-sizing:border-box}
@keyframes spin{to{transform:rotate(360deg)}}
.spin{animation:spin .9s linear infinite}
@keyframes fundIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
.fund-in{animation:fundIn .3s ease-out both}
.btn-primary:not(:disabled):hover{background:#1D4ED8!important;border-color:#1D4ED8!important}
.btn-outline:not(:disabled):hover{background:#F8FAFB!important}
.slot:hover{border-color:#BFDBFE!important}
button:focus-visible,input:focus-visible,textarea:focus-visible{outline:2px solid #2563EB!important;outline-offset:2px}
input::placeholder,textarea::placeholder{color:#94A3B8}
.pe-input::placeholder{color:#77787f}
@media (prefers-reduced-motion: reduce){.spin,.fund-in{animation:none}}
`;

/* ---------- app ---------- */

export default function BookingInlineFundingPrototype() {
  const width = useWidth();
  const [scenarioId, setScenarioId] = useState('brand_new');
  const [outcome, setOutcome] = useState('success');
  const [viewport, setViewport] = useState('desktop');
  const sc = SCENARIOS.find((s) => s.id === scenarioId);
  const mobile = viewport === 'mobile';
  const compact = mobile || width < 760;

  // Booking draft (BookingFlowDialog state — never reset by funding)
  const [title, setTitle] = useState(DRAFT.title);
  const [desc, setDesc] = useState(DRAFT.desc);
  const [showValidation, setShowValidation] = useState(false);
  const [slot, setSlot] = useState(SLOTS[0]);
  const [takenIds, setTakenIds] = useState([]);

  // Flow + funding
  const [phase, setPhase] = useState('confirm'); // confirm | pick_time | booked | saved
  const [status, setStatus] = useState('idle'); // idle | paying | auth | booking
  const [method, setMethod] = useState('topup'); // topup | payafter
  const [useNew, setUseNew] = useState(false);
  const [amount, setAmount] = useState(TOP_UP.min);
  const [other, setOther] = useState(false);
  const [otherVal, setOtherVal] = useState('');
  const [promo, setPromo] = useState(null);
  const [payError, setPayError] = useState('');
  const [fundedVia, setFundedVia] = useState(null);
  const [stale, setStale] = useState(false);
  const [slotTakenOnce, setSlotTakenOnce] = useState(false);

  const runRef = useRef(0);
  const timers = useRef([]);
  const scrollRef = useRef(null);
  const mounted = useRef(false);

  const wait = (ms) =>
    new Promise((resolve) => {
      timers.current.push(setTimeout(resolve, ms));
    });

  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  /** Clears one payment attempt and cancels anything in flight. Keeps the funding choices. */
  const resetRun = () => {
    runRef.current += 1;
    timers.current.forEach(clearTimeout);
    timers.current = [];
    setPhase('confirm');
    setStatus('idle');
    setPayError('');
    setFundedVia(null);
    setStale(false);
    setSlotTakenOnce(false);
    setTakenIds([]);
    setSlot(SLOTS[0]);
  };
  /** Scenario switch: a fresh confirm step for that funding state. */
  const resetFlow = () => {
    resetRun();
    setOutcome('success');
    setMethod('topup');
    setUseNew(false);
    setAmount(sc.suggested ?? TOP_UP.min);
    setOther(false);
    setOtherVal('');
    setPromo(null);
    setShowValidation(false);
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(resetFlow, [scenarioId]);

  /** The payment-result switcher runs the attempt straight away, so the result shows at once. */
  const [autoRun, setAutoRun] = useState(false);
  const runResult = (o) => {
    setOutcome(o);
    resetRun();
    setAutoRun(true);
  };

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [phase, stale]);

  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    const c = scrollRef.current;
    const el = c?.querySelector('[data-funding]');
    if (c && el) {
      c.scrollTo({
        top: Math.max(0, el.offsetTop - 140),
        behavior: prefersReducedMotion() ? 'auto' : 'smooth',
      });
    }
  }, [scenarioId, viewport]);

  // Derived
  const paysNow = ['setup', 'reserved', 'hold'].includes(sc.arm);
  const outcomeApplies = (k) => {
    if (sc.arm === 'member') return false;
    if (k === 'declined' || k === 'auth') return paysNow;
    return true;
  };
  let outcomeHint = 'Runs it in the dialog now. The pay button repeats the last one picked.';
  if (sc.arm === 'member') outcomeHint = "Members don't pay here, so there is nothing to run.";
  else if (!paysNow)
    outcomeHint = 'Nothing to pay in this scenario, so only the booking results apply.';
  const isMember = sc.arm === 'member';
  const needsFunding = sc.arm !== 'none' && fundedVia === null;
  const busy = status !== 'idle';
  const cardOnFile = !!sc.saved && !useNew;
  const card = cardOnFile ? SAVED : NEW_CARD;
  const minNeeded = sc.suggested ?? TOP_UP.min;
  const chips = sc.suggested ? [sc.suggested, ...TIERS.filter((t) => t > sc.suggested)] : [];

  const parsedOther = Math.round(parseFloat(otherVal.replace(/[^0-9.]/g, '')) * 100);
  let amountErr = '';
  if (other) {
    if (!otherVal.trim() || Number.isNaN(parsedOther)) amountErr = 'Enter an amount.';
    else if (parsedOther < minNeeded) amountErr = `Enter at least ${audShort(minNeeded)}.`;
    else if (parsedOther > TOP_UP.max)
      amountErr = `One top-up can be up to ${audShort(TOP_UP.max)}.`;
    else if (parsedOther % TOP_UP.step !== 0) amountErr = 'Use whole hundreds, like A$400.';
  }
  let effAmount = amount;
  if (other) effAmount = amountErr ? null : parsedOther;
  const showAmountErr = other && otherVal.trim() !== '';

  let ctaLabel = 'Confirm & book';
  if (status === 'paying') {
    if (method === 'topup') ctaLabel = 'Processing payment…';
    else ctaLabel = cardOnFile ? 'Setting up…' : 'Saving your card…';
  } else if (status === 'auth') ctaLabel = 'Waiting for your bank…';
  else if (status === 'booking') ctaLabel = 'Booking…';
  else if (needsFunding && isMember) ctaLabel = 'Save and finish later';
  else if (needsFunding && method === 'payafter')
    ctaLabel = cardOnFile ? 'Book and pay after the call' : 'Add card & book';
  else if (needsFunding)
    ctaLabel = effAmount == null ? 'Top up & book' : `Top up ${audShort(effAmount)} & book`;

  const ctaDisabled =
    busy || stale || (needsFunding && !isMember && method === 'topup' && effAmount == null);

  const buildFunding = () =>
    method === 'payafter'
      ? { kind: 'payafter', card }
      : { kind: 'topup', card, paid: effAmount, credited: effAmount + (promo ? promo.minor : 0) };

  const book = async (run, funding) => {
    setStatus('booking');
    await wait(900);
    if (run !== runRef.current) return;
    if (funding) setFundedVia(funding);
    if (outcome === 'slot_taken' && !slotTakenOnce) {
      setSlotTakenOnce(true);
      setTakenIds((ids) => [...ids, slot.id]);
      setStale(true);
      setStatus('idle');
      return;
    }
    setStatus('idle');
    setPhase('booked');
  };

  const submit = async () => {
    setShowValidation(true);
    if (!title.trim() || !desc.trim()) return;
    const run = runRef.current;
    setPayError('');
    if (needsFunding && isMember) {
      setPhase('saved');
      return;
    }
    if (!needsFunding) {
      await book(run, null);
      return;
    }
    setStatus('paying');
    await wait(1200);
    if (run !== runRef.current) return;
    if (outcome === 'declined') {
      setStatus('idle');
      setPayError(
        method === 'payafter'
          ? "This card couldn't be set up, and nothing was charged. Try a different card or check with your bank."
          : 'Your card was declined, so nothing was charged. Try a different card or check with your bank.'
      );
      return;
    }
    if (outcome === 'auth') {
      setStatus('auth');
      return;
    }
    await book(run, buildFunding());
  };

  const authComplete = async () => {
    const run = runRef.current;
    setStatus('paying');
    await wait(600);
    if (run !== runRef.current) return;
    await book(run, buildFunding());
  };
  const authFail = () => {
    setStatus('idle');
    setPayError(
      method === 'payafter'
        ? "Your bank didn't confirm the card, so it wasn't saved. Try again or use a different card."
        : "Your bank didn't confirm the payment, so nothing was charged. Try again or use a different card."
    );
  };

  useEffect(() => {
    if (!autoRun) return;
    setAutoRun(false);
    const c = scrollRef.current;
    if (c)
      c.scrollTo({ top: c.scrollHeight, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    submit().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRun]);

  const changeTime = () => {
    setStale(false);
    setPhase('pick_time');
  };
  const pickSlot = (s) => {
    setSlot(s);
    setStale(false);
    setPhase('confirm');
  };

  /* ----- views ----- */

  const titleInvalid = showValidation && !title.trim();
  const descInvalid = showValidation && !desc.trim();

  const confirmView = (
    <div
      style={{
        maxWidth: 640,
        margin: '0 auto',
        width: '100%',
        padding: mobile ? 20 : 24,
        display: 'flex',
        flexDirection: 'column',
        gap: 20,
      }}
    >
      {stale && <StaleBanner fundedVia={fundedVia} onChooseNewTime={changeTime} />}

      <div
        style={{
          border: `1px solid ${T.border}`,
          background: 'rgba(241,245,249,0.5)',
          borderRadius: 12,
          padding: 16,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
        }}
      >
        <div>
          <p style={{ margin: 0, fontSize: 14, fontWeight: 600, color: T.ink }}>
            {slot.date}, {slot.time}
          </p>
          <p style={{ margin: '2px 0 0', fontSize: 12, color: T.muted }}>
            {slot.dur}-minute consultation
          </p>
        </div>
        <button
          type="button"
          onClick={changeTime}
          disabled={busy}
          style={{
            background: 'none',
            border: 'none',
            padding: 0,
            cursor: busy ? 'default' : 'pointer',
            fontFamily: FONT,
            fontSize: 12,
            fontWeight: 600,
            color: T.primary,
            whiteSpace: 'nowrap',
          }}
        >
          See other times
        </button>
      </div>

      <Field
        label="Title"
        required
        htmlFor="booking-title"
        error={titleInvalid ? 'Give this a short title.' : ''}
      >
        <input
          id="booking-title"
          value={title}
          maxLength={160}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="In a few words, what's this about?"
          aria-invalid={titleInvalid || undefined}
          style={{
            width: '100%',
            fontFamily: FONT,
            fontSize: 14,
            color: T.ink,
            padding: '0 12px',
            height: 40,
            borderRadius: 10,
            border: `1px solid ${titleInvalid ? T.redBorder : T.border}`,
            background: '#fff',
            outline: 'none',
          }}
        />
      </Field>

      <Field
        label="Description"
        required
        error={descInvalid ? "Add a few words about what you'd like to discuss." : ''}
      >
        <EditorMock value={desc} onChange={setDesc} invalid={descInvalid} />
      </Field>

      <ProductsMock />

      <div>
        <LinkBtn icon={UserPlus}>Invite a colleague</LinkBtn>
      </div>

      <BillingLine />

      {fundedVia && (
        <div
          style={{
            display: 'flex',
            gap: 8,
            alignItems: 'flex-start',
            fontSize: 13.5,
            color: T.green,
            background: T.greenBg,
            border: `1px solid ${T.greenBorder}`,
            borderRadius: 10,
            padding: '10px 12px',
            fontWeight: 500,
            lineHeight: 1.45,
          }}
        >
          <Check size={16} style={{ flexShrink: 0, marginTop: 1 }} aria-hidden="true" />
          {fundedText(fundedVia)}
        </div>
      )}

      {needsFunding && (
        <FundingBlock
          sc={sc}
          compact={compact}
          busy={busy}
          method={method}
          setMethod={setMethod}
          chips={chips}
          amount={amount}
          setAmount={setAmount}
          other={other}
          setOther={setOther}
          otherVal={otherVal}
          setOtherVal={setOtherVal}
          amountErr={amountErr}
          showAmountErr={showAmountErr}
          minNeeded={minNeeded}
          promo={promo}
          setPromo={setPromo}
          effAmount={effAmount}
          cardOnFile={cardOnFile}
          setUseNew={setUseNew}
          payError={payError}
        />
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'flex', gap: 8 }}>
          <Btn variant="outline" onClick={changeTime} disabled={busy}>
            <ChevronLeft size={16} aria-hidden="true" /> Back
          </Btn>
          <Btn onClick={submit} disabled={ctaDisabled} busy={busy} style={{ flex: 1, minWidth: 0 }}>
            {busy && <Loader2 size={16} className="spin" aria-hidden="true" />}
            {ctaLabel}
          </Btn>
        </div>
        {needsFunding && !isMember && method === 'topup' && (
          <p style={{ margin: 0, fontSize: 12, color: T.faint, textAlign: 'center' }}>
            You'll be charged in AUD — your bank sets the final rate.
          </p>
        )}
        <p style={{ margin: 0, fontSize: 12, color: T.muted, textAlign: 'center' }}>
          Free to cancel until anyone joins the call.
        </p>
      </div>
    </div>
  );

  const available = SLOTS.filter((s) => !takenIds.includes(s.id));
  const takenSlot = SLOTS.find((s) => s.id === takenIds[0]);
  const pickView = (
    <div
      style={{
        maxWidth: 640,
        margin: '0 auto',
        padding: mobile ? 20 : 24,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      <p style={{ margin: '0 0 4px', fontSize: 13, color: T.muted, lineHeight: 1.5 }}>
        The availability calendar sits here, unchanged. What you typed on the next step is kept.
      </p>
      {takenSlot && (
        <p style={{ margin: '0 0 4px', fontSize: 12.5, color: T.faint }}>
          {takenSlot.date} at {takenSlot.time} was just booked, so it's no longer listed.
        </p>
      )}
      {available.map((s) => (
        <button
          key={s.id}
          type="button"
          className="slot"
          onClick={() => pickSlot(s)}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            padding: '14px 16px',
            borderRadius: 12,
            border: `1.5px solid ${s.id === slot.id ? T.primary : T.border}`,
            background: s.id === slot.id ? T.primaryLight : '#fff',
            cursor: 'pointer',
            fontFamily: FONT,
            textAlign: 'left',
          }}
        >
          <span style={{ fontSize: 14, fontWeight: 600, color: T.ink }}>
            {s.date} at {s.time}
          </span>
          <span style={{ fontSize: 12.5, color: T.muted }}>{s.dur} min</span>
        </button>
      ))}
    </div>
  );

  const resultShell = (icon, tileBg, heading, children) => (
    <div
      style={{
        maxWidth: 460,
        margin: '0 auto',
        padding: '44px 24px',
        textAlign: 'center',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 14,
      }}
    >
      <span
        style={{
          width: 56,
          height: 56,
          borderRadius: 16,
          background: tileBg,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {icon}
      </span>
      <h2
        style={{ margin: 0, fontSize: 20, fontWeight: 600, color: T.ink, letterSpacing: '-0.01em' }}
      >
        {heading}
      </h2>
      {children}
    </div>
  );

  const bookedView = resultShell(
    <Check size={26} color={T.green} strokeWidth={2.6} aria-hidden="true" />,
    T.greenBg,
    `You're booked with ${EXPERT.first}`,
    <>
      <p style={{ margin: 0, fontSize: 14, color: T.muted }}>
        {slot.date} at {slot.time}, {slot.dur}-minute consultation
      </p>
      {fundedVia && (
        <div
          style={{
            fontSize: 13,
            color: T.ink2,
            background: T.bg,
            border: `1px solid ${T.borderSubtle}`,
            borderRadius: 10,
            padding: '10px 14px',
            display: 'flex',
            gap: 8,
            alignItems: 'flex-start',
            textAlign: 'left',
            lineHeight: 1.45,
          }}
        >
          <Receipt
            size={15}
            color={T.muted}
            style={{ flexShrink: 0, marginTop: 2 }}
            aria-hidden="true"
          />
          {fundedText(fundedVia)}
        </div>
      )}
      <Btn onClick={resetRun} style={{ marginTop: 6 }}>
        Done
      </Btn>
      <p style={{ margin: 0, fontSize: 11.5, color: T.faint }}>
        Existing StepBooked, plus the receipt line.
      </p>
    </>
  );

  const savedView = resultShell(
    <Bell size={24} color={T.primary} aria-hidden="true" />,
    'rgba(37,99,235,0.1)',
    'Saved for later',
    <>
      <p style={{ margin: 0, fontSize: 14, color: T.muted, lineHeight: 1.55 }}>
        We've told {COMPANY}'s billing admins this booking is waiting on them. What you typed is
        saved on this device, so it'll be filled in when you book with {EXPERT.first} again.
      </p>
      <p style={{ margin: 0, fontSize: 13, color: T.faint, lineHeight: 1.5 }}>
        The time isn't held, so you'll choose one when you come back.
      </p>
      <Btn onClick={resetRun} style={{ marginTop: 6 }}>
        Done
      </Btn>
    </>
  );

  let body = confirmView;
  if (phase === 'pick_time') body = pickView;
  else if (phase === 'booked') body = bookedView;
  else if (phase === 'saved') body = savedView;

  let headerStep = 'confirm';
  if (phase === 'pick_time') headerStep = 'pick_time';
  else if (phase === 'booked') headerStep = 'booked';

  const surface = (
    <>
      <DialogHeader step={headerStep} />
      <div
        ref={scrollRef}
        style={{
          position: 'relative',
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          background: '#fff',
        }}
      >
        {body}
      </div>
      {status === 'auth' && (
        <AuthModal
          method={method}
          amount={effAmount}
          onComplete={() => {
            authComplete().catch(() => {});
          }}
          onFail={authFail}
        />
      )}
    </>
  );

  const frame = mobile ? (
    <div
      style={{
        width: 390,
        maxWidth: '100%',
        height: 800,
        margin: '0 auto',
        borderRadius: 32,
        border: `1px solid ${T.border}`,
        overflow: 'hidden',
        background: T.backdrop,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'flex-end',
        boxShadow: '0 1px 2px rgba(15,23,41,0.04), 0 18px 50px rgba(15,23,41,0.12)',
      }}
    >
      <div
        style={{
          position: 'relative',
          height: '94%',
          background: '#fff',
          borderRadius: '18px 18px 0 0',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {surface}
      </div>
    </div>
  ) : (
    <div
      style={{
        background: T.backdrop,
        borderRadius: 18,
        padding: width < 760 ? 10 : 28,
        display: 'flex',
        justifyContent: 'center',
      }}
    >
      <div
        style={{
          position: 'relative',
          width: 840,
          maxWidth: '100%',
          height: 820,
          background: '#fff',
          borderRadius: 14,
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: '0 24px 60px rgba(15,23,41,0.28)',
        }}
      >
        {surface}
      </div>
    </div>
  );

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
      <style>{CSS}</style>
      <div style={{ maxWidth: 980, margin: '0 auto' }}>
        <div style={{ marginBottom: 18 }}>
          <div style={{ fontSize: 12.5, fontWeight: 600, color: T.faint }}>
            Booking prototype: inline funding
          </div>
          <h1
            style={{ margin: '6px 0 4px', fontSize: 24, fontWeight: 700, letterSpacing: '-0.02em' }}
          >
            Fund the booking without leaving it
          </h1>
          <p style={{ margin: 0, fontSize: 14.5, color: T.muted, lineHeight: 1.55, maxWidth: 660 }}>
            The funding check moves from a full-step refusal panel to the bottom of Review &amp;
            confirm. Switch scenarios to see each funding state, and the payment outcome to see what
            happens when it goes wrong.
          </p>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 20 }}>
          <Control label="Scenario">
            <Seg
              value={scenarioId}
              onChange={setScenarioId}
              options={SCENARIOS.map((s) => [s.id, s.label])}
            />
          </Control>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            <Control label="Try a payment result">
              <Seg
                value={outcome}
                onChange={runResult}
                options={OUTCOMES.map(([k, l]) => [k, l, null, !outcomeApplies(k)])}
              />
              <div style={{ marginTop: 6, fontSize: 12, color: T.faint }}>{outcomeHint}</div>
            </Control>
            <Control label="View">
              <Seg
                value={viewport}
                onChange={setViewport}
                options={[
                  ['desktop', 'Desktop dialog', Monitor],
                  ['mobile', 'Mobile sheet', Smartphone],
                ]}
              />
            </Control>
          </div>
        </div>

        {frame}

        <div
          style={{
            marginTop: 24,
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
            gap: 16,
            alignItems: 'start',
          }}
        >
          <NoteCard title="How it behaves" items={BEHAVIOUR} />
          <NoteCard title="For the ticket" items={TICKET} />
        </div>
        <p style={{ margin: '14px 0 0', fontSize: 12, color: T.faint, lineHeight: 1.55 }}>
          Try: pick "Time gets taken", then choose a new time. The title and description are still
          there, and the next Confirm needs no payment. Promo codes: NEWTOBALO, WELCOME50.
        </p>
      </div>
    </div>
  );
}
