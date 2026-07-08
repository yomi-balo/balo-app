'use client';

/**
 * DESIGN REFERENCE — Client-company REQUEST-mode join flow (BAL-346, scope A2)
 * ---------------------------------------------------------------------------
 * Source of truth for CC. Self-mocks its actions so every state renders standalone.
 *
 * SCOPE — CLIENT COMPANIES ONLY.
 * This file covers the request-mode lifecycle that exists ONLY on the client->company
 * side. Per ADR-1031, company join has three modes (auto / request / off); when a
 * company admin sets `request`, a client signing up with that domain FILES A REQUEST
 * and waits for admin approval. This is legitimate workspace access-control and
 * involves no earnings -- which is why the lifecycle exists here.
 *
 * DO NOT add agency screens here. Per ADR-1034 the expert->agency side is
 * DETERMINED BY EMAIL with NO request/approve lifecycle -- it lives entirely in
 * `.claude/design-references/expert-agency-step.jsx`. An earlier version of this
 * file mixed the two; that was wrong and has been removed. Three references now:
 *   - onboarding-company-step.jsx  -> client AUTO-join interstitial (shipped, BAL-350)
 *   - domain-join-pending.jsx      -> client REQUEST-mode flow (THIS FILE)
 *   - expert-agency-step.jsx       -> expert/agency resolution (ADR-1034)
 *
 * FLOW: resolving -> pending -> approved | declined ; inline write-error.
 *
 * COPY CONVENTIONS:
 *   - Prospective copy names the PARTY (the company), never individual admins.
 *   - Decline copy is NEUTRAL -- no admin named, no "rejected", routes to creation.
 *   - Waits are framed as helpful facts ("we'll email you"), never countdowns.
 *   - Gender-neutral throughout.
 *
 * v1 REALITY: dormant -- `matched` cannot fire while every domain maps to a personal
 * workspace. Built-not-live.
 *
 * REUSED VOCABULARY (identical to onboarding-company-step.jsx): <h1 ref tabIndex={-1}>
 * heading-focus, ShimmerButton, ProgressDots, Loader2 spinner, StepShell, ErrorBanner.
 * Standalone onboarding interstitial (no wizard dots).
 */

import React, { useState, useEffect, useRef } from 'react';

const T = {
  bg: '#F8FAFB',
  surface: '#FFFFFF',
  border: '#E0E4EB',
  fg: '#0F1729',
  muted: '#64748B',
  primary: '#2563EB',
  primaryTo: '#7C3AED',
  success: '#059669',
  destructive: '#DC2626',
  ring: 'rgba(37, 99, 235, 0.35)',
  radius: 12,
  font: "'DM Sans', ui-sans-serif, system-ui, -apple-system, sans-serif",
};

const COMPANY = { name: 'Northwind' };

/* Mock actions. Production:
 *   requestJoinCompanyAction(companyId)  -> files party_join_request (BAL-345); fails CLOSED
 *   (resolution arrives via notification/Ably, not polling -- the pending screen is where
 *    the user waits; the "preview approved/declined" links here are HARNESS-ONLY)
 */

function Spinner({ size = 16, style }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      style={{ animation: 'balo-spin 0.8s linear infinite', ...style }}
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}
function ShimmerButton({ children, onClick, disabled, variant = 'primary' }) {
  const [hover, setHover] = useState(false);
  const isPrimary = variant === 'primary';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        position: 'relative',
        height: 44,
        width: '100%',
        borderRadius: 10,
        border: isPrimary ? 'none' : `1px solid ${T.border}`,
        fontSize: 14,
        fontWeight: 600,
        fontFamily: T.font,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.6 : 1,
        color: isPrimary ? '#fff' : T.fg,
        background: isPrimary ? `linear-gradient(90deg, ${T.primary}, ${T.primaryTo})` : T.surface,
        overflow: 'hidden',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        transition: 'transform .15s, box-shadow .2s',
        transform: hover && !disabled ? 'translateY(-1px)' : 'none',
        boxShadow: hover && !disabled && isPrimary ? '0 8px 24px rgba(37,99,235,.25)' : 'none',
      }}
    >
      {isPrimary && !disabled && (
        <span
          aria-hidden
          style={{
            position: 'absolute',
            inset: 0,
            background:
              'linear-gradient(105deg, transparent 40%, rgba(255,255,255,0.18) 50%, transparent 60%)',
            transform: hover ? 'translateX(100%)' : 'translateX(-100%)',
            transition: 'transform .7s ease',
          }}
        />
      )}
      <span style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 8 }}>
        {children}
      </span>
    </button>
  );
}
function GhostButton({ children, onClick, disabled }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        height: 36,
        padding: '0 12px',
        borderRadius: 8,
        border: 'none',
        background: 'transparent',
        color: T.muted,
        fontSize: 13,
        fontWeight: 500,
        fontFamily: T.font,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {children}
    </button>
  );
}
function ProgressDots({ current, total }) {
  return (
    <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
      {Array.from({ length: total }).map((_, i) => {
        const active = i + 1 === current;
        const done = i + 1 < current;
        return (
          <div
            key={i}
            style={{
              width: active ? 22 : 7,
              height: 7,
              borderRadius: 99,
              background: active
                ? `linear-gradient(90deg, ${T.primary}, ${T.primaryTo})`
                : done
                  ? T.primary
                  : T.border,
              transition: 'all .3s ease',
            }}
          />
        );
      })}
    </div>
  );
}
function ErrorBanner({ children, id }) {
  return (
    <div
      id={id}
      role="alert"
      style={{
        marginTop: 16,
        padding: '10px 12px',
        borderRadius: 10,
        background: 'rgba(220,38,38,.06)',
        border: '1px solid rgba(220,38,38,.25)',
        color: T.destructive,
        fontSize: 13,
        fontFamily: T.font,
        textAlign: 'left',
      }}
    >
      {children}
    </div>
  );
}
function StepShell({ children }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: '100%' }}>
      <div
        style={{
          width: '100%',
          maxWidth: 480,
          background: T.surface,
          border: `1px solid ${T.border}`,
          borderRadius: 20,
          padding: '40px 32px',
          boxShadow: '0 1px 2px rgba(15,23,41,.04), 0 12px 32px rgba(15,23,41,.06)',
        }}
      >
        {children}
      </div>
    </div>
  );
}
const hStyle = {
  fontSize: 26,
  fontWeight: 600,
  color: T.fg,
  fontFamily: T.font,
  margin: 0,
  outline: 'none',
  letterSpacing: '-0.01em',
};
const pStyle = {
  color: T.muted,
  fontSize: 14.5,
  lineHeight: 1.6,
  fontFamily: T.font,
  margin: '14px auto 0',
  maxWidth: 400,
};

function Badge({ name, tone = 'primary' }) {
  const bg =
    tone === 'success'
      ? `linear-gradient(135deg, ${T.success}, #10B981)`
      : tone === 'muted'
        ? `linear-gradient(135deg, ${T.muted}, #94A3B8)`
        : `linear-gradient(135deg, ${T.primary}, ${T.primaryTo})`;
  return (
    <div
      aria-hidden
      style={{
        width: 56,
        height: 56,
        borderRadius: 14,
        margin: '0 auto 20px',
        display: 'grid',
        placeItems: 'center',
        color: '#fff',
        fontWeight: 700,
        fontSize: 22,
        fontFamily: T.font,
        background: bg,
      }}
    >
      {name.charAt(0)}
    </div>
  );
}

function NextSteps({ party }) {
  const rows = [
    party + "'s admins have been notified and will review your request.",
    "We'll email you the moment they respond -- no need to wait here.",
    'If they approve, you go straight in. If not, you can set up your own company.',
  ];
  return (
    <ul
      style={{
        listStyle: 'none',
        margin: '22px auto 0',
        padding: 0,
        maxWidth: 380,
        textAlign: 'left',
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      }}
    >
      {rows.map((r, i) => (
        <li key={i} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
          <span
            aria-hidden
            style={{
              flex: '0 0 auto',
              width: 20,
              height: 20,
              marginTop: 1,
              borderRadius: 99,
              background: 'rgba(37,99,235,.1)',
              color: T.primary,
              fontSize: 11,
              fontWeight: 700,
              display: 'grid',
              placeItems: 'center',
              fontFamily: T.font,
            }}
          >
            {i + 1}
          </span>
          <span style={{ color: T.fg, fontSize: 13.5, lineHeight: 1.5, fontFamily: T.font }}>
            {r}
          </span>
        </li>
      ))}
    </ul>
  );
}

function CompanyRequestFlow({ scenario, onDone }) {
  const party = COMPANY.name;
  const [phase, setPhase] = useState('resolving');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState(null);
  const headingRef = useRef(null);

  useEffect(() => {
    setBusy(false);
    setActionError(null);
    const initial = {
      'request sent -> pending': 'pending',
      approved: 'approved',
      declined: 'declined',
      'write error (retry)': 'pending',
      loading: 'resolving',
    }[scenario];
    setPhase(initial);
    if (scenario === 'write error (retry)') {
      setActionError(
        "We couldn't send your request just now. Nothing was changed -- please try again."
      );
    }
  }, [scenario]);

  useEffect(() => {
    if (phase !== 'resolving') {
      const t = setTimeout(() => headingRef.current && headingRef.current.focus(), 120);
      return () => clearTimeout(t);
    }
  }, [phase]);

  if (phase === 'resolving') {
    return (
      <StepShell>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 14,
            padding: '32px 0',
          }}
          aria-live="polite"
        >
          <span style={{ color: T.primary }}>
            <Spinner size={26} />
          </span>
          <p style={{ color: T.muted, fontSize: 14, fontFamily: T.font, margin: 0 }}>
            Sending your request...
          </p>
        </div>
      </StepShell>
    );
  }

  if (phase === 'pending') {
    return (
      <StepShell>
        <div style={{ textAlign: 'center' }}>
          <Badge name={party} />
          <h1 ref={headingRef} tabIndex={-1} style={hStyle}>
            Request sent to {party}
          </h1>
          <p style={pStyle}>
            Your request to join <strong style={{ color: T.fg }}>{party}</strong> is with their
            admins. There's nothing you need to do right now.
          </p>
          <NextSteps party={party} />
          {actionError && <ErrorBanner id="req-err">{actionError}</ErrorBanner>}
          <div style={{ marginTop: 28, maxWidth: 340, marginInline: 'auto' }}>
            <ShimmerButton onClick={() => onDone && onDone('explore')} disabled={busy}>
              {busy ? (
                <>
                  <Spinner /> Working...
                </>
              ) : (
                'Explore Balo while you wait'
              )}
            </ShimmerButton>
            <div style={{ marginTop: 10 }}>
              <ShimmerButton
                variant="secondary"
                onClick={() => onDone && onDone('create')}
                disabled={busy}
              >
                Set up my own company instead
              </ShimmerButton>
            </div>
          </div>
          <div style={{ marginTop: 20, display: 'flex', gap: 12, justifyContent: 'center' }}>
            <GhostButton onClick={() => setPhase('approved')}>&#9656; preview approved</GhostButton>
            <GhostButton onClick={() => setPhase('declined')}>&#9656; preview declined</GhostButton>
          </div>
        </div>
      </StepShell>
    );
  }

  if (phase === 'approved') {
    return (
      <StepShell>
        <div style={{ textAlign: 'center' }}>
          <Badge name={party} tone="success" />
          <h1 ref={headingRef} tabIndex={-1} style={hStyle}>
            You're in -- welcome to {party}
          </h1>
          <p style={pStyle}>
            {party}'s admins approved your request. You now share their workspace on Balo.
          </p>
          <div style={{ marginTop: 26, maxWidth: 340, marginInline: 'auto' }}>
            <ShimmerButton onClick={() => onDone && onDone('continue')}>
              Continue to {party}
            </ShimmerButton>
          </div>
        </div>
      </StepShell>
    );
  }

  return (
    <StepShell>
      <div style={{ textAlign: 'center' }}>
        <Badge name={party} tone="muted" />
        <h1 ref={headingRef} tabIndex={-1} style={hStyle}>
          Set up your own workspace
        </h1>
        <p style={pStyle}>
          {party}'s admins weren't able to add you this time. You can create your own company on
          Balo and get started right away.
        </p>
        <div style={{ marginTop: 26, maxWidth: 340, marginInline: 'auto' }}>
          <ShimmerButton onClick={() => onDone && onDone('create')}>
            Create my own company
          </ShimmerButton>
        </div>
      </div>
    </StepShell>
  );
}

const SCENARIOS = [
  'request sent -> pending',
  'approved',
  'declined',
  'write error (retry)',
  'loading',
];
const ctrlLabel = {
  fontSize: 11,
  fontWeight: 600,
  color: T.muted,
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
};
const selStyle = {
  height: 40,
  padding: '0 12px',
  borderRadius: 9,
  border: `1px solid ${T.border}`,
  background: T.surface,
  color: T.fg,
  fontSize: 13.5,
  fontFamily: T.font,
};
const cardDone = {
  textAlign: 'center',
  background: T.surface,
  border: `1px solid ${T.border}`,
  borderRadius: 20,
  padding: '40px 48px',
  boxShadow: '0 12px 32px rgba(15,23,41,.06)',
};

export default function Prototype() {
  const [scenario, setScenario] = useState(SCENARIOS[0]);
  const [nonce, setNonce] = useState(0);
  const [done, setDone] = useState(null);

  return (
    <div
      style={{
        minHeight: '100vh',
        background: T.bg,
        fontFamily: T.font,
        padding: '28px 16px 64px',
        color: T.fg,
      }}
    >
      <style>
        {"@keyframes balo-spin { to { transform: rotate(360deg); } } @import url('https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,600;9..40,700&display=swap'); * { box-sizing: border-box; } button:focus-visible { outline: 2px solid " +
          T.primary +
          '; outline-offset: 2px; }'}
      </style>

      <div
        style={{
          maxWidth: 900,
          margin: '0 auto 20px',
          background: T.surface,
          border: `1px solid ${T.border}`,
          borderRadius: 14,
          padding: 16,
          display: 'flex',
          flexWrap: 'wrap',
          gap: 16,
          alignItems: 'flex-end',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1, minWidth: 260 }}>
          <span style={ctrlLabel}>Request-mode state</span>
          <select
            value={scenario}
            onChange={(e) => {
              setScenario(e.target.value);
              setDone(null);
              setNonce((n) => n + 1);
            }}
            style={selStyle}
          >
            {SCENARIOS.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </div>
        <button
          onClick={() => {
            setDone(null);
            setNonce((n) => n + 1);
          }}
          style={{
            ...selStyle,
            cursor: 'pointer',
            fontWeight: 600,
            color: T.primary,
            borderColor: T.primary,
          }}
        >
          &#8635; Replay
        </button>
      </div>

      <p
        style={{
          maxWidth: 900,
          margin: '0 auto 20px',
          color: T.muted,
          fontSize: 12.5,
          textAlign: 'center',
        }}
      >
        CLIENT -&gt; company, request-mode only (ADR-1031 auto/request/off) &bull; expert/agency has
        NO request lifecycle -- see expert-agency-step.jsx &bull; dormant in v1
      </p>

      <div style={{ maxWidth: 900, margin: '0 auto', display: 'grid', placeItems: 'center' }}>
        {done ? (
          <div style={cardDone}>
            <div style={{ fontSize: 28, marginBottom: 8, color: T.primary }}>&rarr;</div>
            <h2 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>exit: {done}</h2>
            <p style={{ color: T.muted, fontSize: 13.5, marginTop: 8 }}>
              {done === 'create'
                ? 'routes into normal company creation (the onboarding company step)'
                : done === 'continue'
                  ? 'enters the company workspace'
                  : 'user leaves; an email brings them back on resolution'}
            </p>
            <button
              onClick={() => {
                setDone(null);
                setNonce((n) => n + 1);
              }}
              style={{ ...selStyle, marginTop: 16, cursor: 'pointer', color: T.primary }}
            >
              Run again
            </button>
          </div>
        ) : (
          <CompanyRequestFlow key={scenario + '-' + nonce} scenario={scenario} onDone={setDone} />
        )}
      </div>
    </div>
  );
}
