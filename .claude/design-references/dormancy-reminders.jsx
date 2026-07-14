import React, { useState } from 'react';
import {
  Wallet,
  Clock,
  Sparkles,
  ArrowRight,
  Bell,
  Mail,
  MessageCircle,
  Info,
  Calendar,
} from 'lucide-react';

/**
 * Dormancy / Expiry Reminders — Design Reference (ADR-1040)
 * ----------------------------------------------------------------------------
 * The most delicate copy in the system: reminders about a client's own money.
 * Rolling expiry means reminders are DORMANCY nudges, not deadline countdowns —
 * framed around availability and the value sitting there, never "expires in N
 * days" / "hurry". Any consultation or top-up resets the clock, so the humane
 * outcome is that people use their balance rather than lose it.
 *
 * Channels: in-app + email at 60 and 30 days pre-expiry, and on expiry.
 * Gender-neutral throughout. Warm, factual, never countdown-led.
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
  emailBg: '#EEF2F7',
};
const GRAD = `linear-gradient(135deg, ${T.primary} 0%, ${T.primaryTo} 100%)`;
const FONT = "'DM Sans', ui-sans-serif, system-ui, -apple-system, sans-serif";

const TEMPLATES = {
  d60: {
    label: '60 days',
    icon: Wallet,
    tone: 'calm',
    subject: 'Your Balo balance is here whenever you need it',
    heading: 'Your balance is still here',
    body: [
      "It's been a little while since your last consultation. Your balance of A$347.00 is still here, ready whenever a Salesforce question comes up.",
      'It stays available until 12 July 2027 — any consultation or top-up keeps it going.',
    ],
    cta: 'Find an expert',
    inapp: {
      title: 'Your balance is still here',
      body: 'A$347.00, available until 12 Jul 2027. Any activity keeps it going.',
      cta: 'Find an expert',
    },
    channels: ['in-app', 'email'],
  },
  d30: {
    label: '30 days',
    icon: Calendar,
    tone: 'calm',
    subject: 'A good time to put your Balo balance to use',
    heading: 'Your balance stays available until 12 July 2027',
    body: [
      'Your Balo balance of A$347.00 is still here for you.',
      "If there's a question you've been meaning to run past an expert, now's a nice time — and any consultation or top-up keeps your balance going.",
    ],
    cta: 'Start a consultation',
    inapp: {
      title: 'Your balance stays available until 12 Jul',
      body: 'A$347.00 is still here. A good time to put it to use.',
      cta: 'Start a consultation',
    },
    channels: ['in-app', 'email'],
  },
  expired: {
    label: 'Expired',
    icon: Clock,
    tone: 'soft',
    subject: 'About your Balo balance',
    heading: 'Your balance reached its expiry date',
    body: [
      'Your Balo balance reached its expiry date on 12 July 2027.',
      "If you'd like to pick back up, you can add credit and book a consultation anytime. And if you have any questions about your balance, just reply to this email — a real person will help.",
    ],
    cta: 'Add credit',
    inapp: {
      title: 'About your balance',
      body: 'Your balance reached its expiry date. Add credit to pick back up anytime.',
      cta: 'Add credit',
    },
    channels: ['in-app', 'email'],
  },
};

const Eyebrow = ({ children, icon: Icon }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
    {Icon && <Icon size={13} strokeWidth={2.4} style={{ color: T.faint }} />}
    <span
      style={{
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: '0.09em',
        textTransform: 'uppercase',
        color: T.faint,
      }}
    >
      {children}
    </span>
  </div>
);
const Wordmark = () => (
  <span
    style={{
      fontSize: 19,
      fontWeight: 700,
      letterSpacing: '-0.02em',
      background: GRAD,
      WebkitBackgroundClip: 'text',
      backgroundClip: 'text',
      WebkitTextFillColor: 'transparent',
    }}
  >
    balo
  </span>
);
const ChannelChip = ({ kind }) => {
  const email = kind === 'email';
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
        color: T.muted,
        background: T.bg,
        border: `1px solid ${T.border}`,
        padding: '2px 7px',
        borderRadius: 999,
      }}
    >
      {email ? <Mail size={10} strokeWidth={2.6} /> : <Bell size={10} strokeWidth={2.6} />}
      {email ? 'Email' : 'In-app'}
    </span>
  );
};

// ── email render ──
function EmailView({ tpl }) {
  const soft = tpl.tone === 'soft';
  return (
    <div
      style={{
        background: T.emailBg,
        borderRadius: 18,
        padding: '26px 20px',
        border: `1px solid ${T.border}`,
      }}
    >
      {/* subject line chrome */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          marginBottom: 16,
          padding: '0 4px',
        }}
      >
        <div
          style={{
            width: 30,
            height: 30,
            borderRadius: 8,
            background: '#fff',
            border: `1px solid ${T.border}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Mail size={15} strokeWidth={2.2} style={{ color: T.muted }} />
        </div>
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              fontSize: 12.5,
              fontWeight: 700,
              color: T.ink,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {tpl.subject}
          </div>
          <div style={{ fontSize: 11, color: T.faint, fontWeight: 500 }}>
            Balo · hello@balo.expert
          </div>
        </div>
      </div>

      {/* the email card */}
      <div
        style={{
          maxWidth: 440,
          margin: '0 auto',
          background: '#fff',
          borderRadius: 16,
          overflow: 'hidden',
          boxShadow: '0 1px 2px rgba(15,23,41,0.04), 0 12px 34px rgba(15,23,41,0.08)',
        }}
      >
        <div style={{ padding: '22px 28px 0' }}>
          <Wordmark />
        </div>
        <div style={{ padding: '20px 28px 28px' }}>
          <div
            style={{
              width: 52,
              height: 52,
              borderRadius: 15,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: soft ? T.bg : T.primaryLight,
              border: `1px solid ${soft ? T.border : T.primaryBorder}`,
            }}
          >
            <tpl.icon size={24} strokeWidth={2} style={{ color: soft ? T.muted : T.primary }} />
          </div>
          <h2
            style={{
              margin: '18px 0 0',
              fontSize: 20,
              fontWeight: 700,
              color: T.ink,
              letterSpacing: '-0.02em',
              lineHeight: 1.25,
            }}
          >
            {tpl.heading}
          </h2>
          <div
            style={{
              marginTop: 12,
              fontSize: 14.5,
              color: T.ink2,
              fontWeight: 500,
              lineHeight: 1.6,
            }}
          >
            <p style={{ margin: '0 0 12px' }}>Hi Priya,</p>
            {tpl.body.map((p, i) => (
              <p key={i} style={{ margin: '0 0 12px' }}>
                {p}
              </p>
            ))}
          </div>
          <a
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              marginTop: 6,
              padding: '12px 20px',
              borderRadius: 11,
              cursor: 'pointer',
              fontSize: 14.5,
              fontWeight: 600,
              color: '#fff',
              textDecoration: 'none',
              background: GRAD,
              boxShadow: '0 2px 10px rgba(37,99,235,0.3)',
            }}
          >
            {tpl.cta} <ArrowRight size={16} strokeWidth={2.6} />
          </a>
        </div>
        <div
          style={{
            padding: '16px 28px',
            borderTop: `1px solid ${T.borderSubtle}`,
            background: '#FCFDFE',
          }}
        >
          <div style={{ fontSize: 11.5, color: T.faint, fontWeight: 500, lineHeight: 1.5 }}>
            You're receiving this because you have a Balo account.{' '}
            <span style={{ color: T.muted, textDecoration: 'underline' }}>
              Manage email preferences
            </span>
            .
          </div>
        </div>
      </div>
    </div>
  );
}

// ── in-app render ──
function InAppView({ tpl }) {
  const soft = tpl.tone === 'soft';
  return (
    <div
      style={{
        background: T.bg,
        borderRadius: 18,
        padding: 28,
        border: `1px solid ${T.border}`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: 260,
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 380,
          background: '#fff',
          borderRadius: 15,
          border: `1px solid ${T.border}`,
          boxShadow: '0 1px 2px rgba(15,23,41,0.04), 0 10px 28px rgba(15,23,41,0.07)',
          padding: 18,
        }}
      >
        <div style={{ display: 'flex', gap: 13 }}>
          <div
            style={{
              width: 40,
              height: 40,
              borderRadius: 11,
              flexShrink: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: soft ? T.bg : T.primaryLight,
              border: `1px solid ${soft ? T.border : T.primaryBorder}`,
            }}
          >
            <tpl.icon size={19} strokeWidth={2.1} style={{ color: soft ? T.muted : T.primary }} />
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 14.5, fontWeight: 700, color: T.ink, lineHeight: 1.3 }}>
              {tpl.inapp.title}
            </div>
            <div
              style={{
                marginTop: 4,
                fontSize: 13,
                color: T.muted,
                fontWeight: 500,
                lineHeight: 1.5,
              }}
            >
              {tpl.inapp.body}
            </div>
            <button
              style={{
                marginTop: 12,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 7,
                padding: '9px 15px',
                borderRadius: 10,
                cursor: 'pointer',
                fontFamily: FONT,
                fontSize: 13,
                fontWeight: 600,
                color: '#fff',
                border: 'none',
                background: GRAD,
                boxShadow: '0 2px 8px rgba(37,99,235,0.26)',
              }}
            >
              {tpl.inapp.cta} <ArrowRight size={14} strokeWidth={2.6} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const [key, setKey] = useState('d60');
  const [chan, setChan] = useState('email');
  const tpl = TEMPLATES[key];

  const notes = [
    [
      'Dormancy, not deadline',
      "Rolling expiry means these fire on inactivity, not a looming date. Copy leads with 'still here' and states the date as a fact — never 'expires in N days' or any urgency.",
    ],
    [
      "Use it, don't lose it — literally",
      'Each reminder notes that any consultation or top-up keeps the balance going. Acting resets the clock, so the nudge points at the outcome that helps the client.',
    ],
    [
      'Expiry stays gentle',
      "The expired notice is soft-toned (no red, no alarm icon), states the fact plainly, and offers a human ('just reply — a real person will help') — important while the legality is under counsel review.",
    ],
    [
      'Warm + neutral',
      "Gender-neutral throughout, first-name greeting, plain verbs. The CTA moves toward value (find an expert / start a consultation), not 'spend before you lose it'.",
    ],
    [
      'Both channels',
      'In-app + email at 60 and 30 days and on expiry — all through the notification engine, idempotent on retries.',
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
      `}</style>

      <div style={{ maxWidth: 980, margin: '0 auto' }}>
        <div style={{ marginBottom: 20 }}>
          <Eyebrow>ADR-1040 · Design reference</Eyebrow>
          <h1
            style={{ margin: '8px 0 4px', fontSize: 24, fontWeight: 700, letterSpacing: '-0.02em' }}
          >
            Dormancy &amp; expiry reminders
          </h1>
          <p style={{ margin: 0, fontSize: 14.5, color: T.muted, lineHeight: 1.55, maxWidth: 660 }}>
            Reminders about a client's own money — warm, factual, never a countdown. Switch template
            and channel to compare the 60-day, 30-day, and expired copy in email and in-app form.
          </p>
        </div>

        {/* controls */}
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
            {Object.entries(TEMPLATES).map(([k, t]) => (
              <button
                key={k}
                onClick={() => setKey(k)}
                style={{
                  padding: '7px 14px',
                  borderRadius: 9,
                  cursor: 'pointer',
                  fontFamily: FONT,
                  fontSize: 13,
                  fontWeight: 600,
                  border: `1px solid ${key === k ? T.primaryBorder : T.border}`,
                  color: key === k ? T.primary : T.muted,
                  background: key === k ? T.primaryLight : '#fff',
                }}
              >
                {t.label}
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
              ['email', 'Email', Mail],
              ['inapp', 'In-app', Bell],
            ].map(([v, l, Icon]) => (
              <button
                key={v}
                onClick={() => setChan(v)}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '7px 13px',
                  borderRadius: 8,
                  cursor: 'pointer',
                  fontFamily: FONT,
                  fontSize: 13,
                  fontWeight: 600,
                  border: 'none',
                  color: chan === v ? '#fff' : T.muted,
                  background: chan === v ? T.ink : 'transparent',
                }}
              >
                <Icon size={13} strokeWidth={2.4} /> {l}
              </button>
            ))}
          </div>
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(0, 560px) 1fr',
            gap: 24,
            alignItems: 'start',
          }}
          className="stage"
        >
          <style>{`@media(max-width:820px){.stage{grid-template-columns:1fr !important}}`}</style>

          {chan === 'email' ? <EmailView tpl={tpl} /> : <InAppView tpl={tpl} />}

          <div
            style={{
              background: '#fff',
              border: `1px solid ${T.borderSubtle}`,
              borderRadius: 14,
              padding: 18,
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                marginBottom: 4,
              }}
            >
              <Eyebrow icon={Info}>Behaviour &amp; copy</Eyebrow>
              <div style={{ display: 'flex', gap: 6 }}>
                {tpl.channels.map((c) => (
                  <ChannelChip key={c} kind={c} />
                ))}
              </div>
            </div>
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
              Note: the expired-balance copy is provisional pending the counsel review flagged in
              ADR-1040 on monetary-balance expiry.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
