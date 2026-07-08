'use client';

/**
 * DESIGN REFERENCE — Expert signup: agency resolution (ADR-1034) + client request-mode
 * ------------------------------------------------------------------------------------
 * Source of truth for CC. Self-mocks its actions so every state renders standalone.
 * Supersedes the agency portion of the earlier domain-join-pending prototype.
 *
 * WHAT CHANGED (ADR-1034 — https://app.notion.com/p/39745346cc7881bdba62ed08d0c7532d):
 *   Every expert belongs to exactly one AGENCY; a freelancer is an AGENCY OF ONE.
 *   There is no freelancer type and no "independent, in no agency" state.
 *   Membership is DETERMINED BY VERIFIED SIGNUP EMAIL — not chosen on a screen:
 *     • agency-domain + agency registered   → JOIN it (determined; no request/approve)
 *     • agency-domain + not yet registered  → PROVISION it; signer becomes OWNER
 *     • freemail / blocked domain           → SOLO AGENCY OF ONE (the independent path)
 *
 * CONSEQUENCES BAKED INTO THIS FILE:
 *   1. The agency side has NO request → pending → approve/decline lifecycle. Using the
 *      agency's email IS the belonging. So: no "Request to join", no pending screen,
 *      no approve/decline, no "This isn't my agency" escape hatch on the agency path.
 *      (Independence = sign up with a personal email — resolved at the front door.)
 *   2. The UI NEVER says "agency" to a SOLO expert. The entity is always an agency
 *      internally, but the word appears only when memberCount > 1 (or they've named it).
 *      The solo/freemail screen talks about "your expert profile", never "your agency".
 *   3. Earnings routing is stated PLAINLY on the agency-join screen: earnings go to the
 *      agency, which handles payout. No "your earnings stay your own" (that was wrong).
 *      Solo agency is still the payee of record (uniform payout path) — but we don't
 *      belabour that to a solo expert; we just don't imply a separate direct-pay model.
 *   4. Write errors are INLINE banners on the screen the user is on (matching BAL-350's
 *      save-error pattern), NOT a dedicated error screen. Writes fail CLOSED (retry),
 *      unlike the read-only resolve which fails open.
 *
 * NOTE — the CLIENT request-mode pending flow (request → pending → approved/declined)
 * is a SEPARATE surface that still exists for CLIENT COMPANIES only (ADR-1031 join
 * modes: auto/request/off apply to company membership, which does not involve earnings).
 * It is unchanged and lives in its own reference; this file is the EXPERT/AGENCY side.
 *
 * v1 REALITY: dormant — `matched` cannot fire while every domain maps to a personal
 * workspace. Built-not-live, same as the rest of domain-join.
 *
 * REUSED VOCABULARY (identical to onboarding-company-step.jsx): <h1 ref tabIndex={-1}>
 * heading-focus, ShimmerButton, ProgressDots, Loader2 spinner, StepShell, ErrorBanner.
 * These render inside the /expert/apply wizard (BAL-172), so they carry its progress dots.
 */

import React, { useState, useEffect, useRef } from 'react';

/* Token shim — identical to onboarding-company-step.jsx */
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

const AGENCY = { name: 'Lattice Consulting', memberCount: 12 };

/* ─────────────────────────────────────────────────────────────────────────
 * Mock resolve. Production: resolveExpertAgencyAction() — authenticated, read-only,
 * gated to partyType==='agency', reusing BAL-350's isBlockedDomain for freemail.
 * Returns:
 *   { kind: 'join',      agency }   agency-domain, agency registered → determined join
 *   { kind: 'provision', name }     agency-domain, not registered → provision + own
 *   { kind: 'solo' }                freemail/blocked → solo agency (independent path)
 * The JOIN and PROVISION writes fail CLOSED (retry inline). Fails open only to 'solo'
 * on a resolve error (never block signup; independent path is the safe default).
 * ──────────────────────────────────────────────────────────────────────── */

/* Primitives — copied verbatim from onboarding-company-step.jsx */
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
function StepShell({ children, dots }) {
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
      {dots && (
        <div style={{ marginTop: 26 }}>
          <ProgressDots current={dots.current} total={dots.total} />
        </div>
      )}
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

function Badge({ label, tone = 'primary' }) {
  const bg =
    tone === 'success'
      ? `linear-gradient(135deg, ${T.success}, #10B981)`
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
      {label}
    </div>
  );
}

/* Plain-fact earnings-routing note. Shown ONLY when joining/provisioning a real agency
   (count could be >1). NEVER shown on the solo path. */
function EarningsNote({ agency }) {
  return (
    <div
      style={{
        marginTop: 18,
        padding: '12px 14px',
        borderRadius: 10,
        background: 'rgba(37,99,235,.05)',
        border: `1px solid ${T.border}`,
        maxWidth: 400,
        marginInline: 'auto',
        textAlign: 'left',
      }}
    >
      <p style={{ margin: 0, color: T.fg, fontSize: 13, lineHeight: 1.55, fontFamily: T.font }}>
        Earnings from your Balo work go to <strong>{agency}</strong>, who handle your payouts.
        You&apos;ll arrange those details with them directly.
      </p>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────
 * THE EXPERT/AGENCY SURFACE — one of three resolved outcomes + inline write states.
 * ──────────────────────────────────────────────────────────────────────── */
function ExpertAgencyStep({ scenario, onDone }) {
  // scenario ∈ 'join' | 'provision' | 'solo' | 'loading' | 'join write error'
  const [phase, setPhase] = useState('resolving'); // resolving | join | provision | solo
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState(null);
  const headingRef = useRef(null);
  const dots = { current: 2, total: 7 }; // renders inside /expert/apply

  useEffect(() => {
    setActionError(null);
    setBusy(false);
    const initial = {
      join: 'join',
      provision: 'provision',
      solo: 'solo',
      'join write error': 'join',
      loading: 'resolving',
    }[scenario];
    // 'join write error' starts on the join screen with a pre-tripped error after an attempt
    setPhase(initial);
    if (scenario === 'join write error') {
      // simulate: user already tried, write failed → banner present, button re-enabled
      setActionError(
        "We couldn't add you to Lattice Consulting just now. Nothing was changed — please try again."
      );
    }
  }, [scenario]);

  useEffect(() => {
    if (phase !== 'resolving') {
      const t = setTimeout(() => headingRef.current?.focus(), 120);
      return () => clearTimeout(t);
    }
  }, [phase]);

  function runWrite(next) {
    setBusy(true);
    setActionError(null);
    setTimeout(() => {
      setBusy(false);
      onDone?.(next);
    }, 700);
  }

  /* ── loading ─────────────────────────────────────────────────────────── */
  if (phase === 'resolving') {
    return (
      <StepShell dots={dots}>
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
            Setting up your expert profile&hellip;
          </p>
        </div>
      </StepShell>
    );
  }

  /* ── JOIN — agency exists, determined by email. Informational, not a decision. ── */
  if (phase === 'join') {
    return (
      <StepShell dots={dots}>
        <div style={{ textAlign: 'center' }}>
          <Badge label={AGENCY.name.charAt(0)} tone="success" />
          <h1 ref={headingRef} tabIndex={-1} style={hStyle}>
            You&apos;re joining {AGENCY.name}
          </h1>
          <p style={pStyle}>
            {/* Determined-by-email: stated as fact, no "Do you want to join?" */}
            You signed up with a <strong style={{ color: T.fg }}>{AGENCY.name}</strong> email, so
            you&apos;ll join their team on Balo — {AGENCY.memberCount} colleagues are already here.
            Next you&apos;ll set up your own expert profile.
          </p>
          <EarningsNote agency={AGENCY.name} />
          {actionError && <ErrorBanner id="join-err">{actionError}</ErrorBanner>}
          <div style={{ marginTop: 26, maxWidth: 340, marginInline: 'auto' }}>
            <ShimmerButton onClick={() => runWrite('join')} disabled={busy}>
              {busy ? (
                <>
                  <Spinner /> Joining&hellip;
                </>
              ) : (
                `Continue`
              )}
            </ShimmerButton>
          </div>
          {/* NO "this isn't my agency" escape hatch — independence is a personal-email
              decision made at the front door, not an opt-out here (ADR-1034). */}
          <p
            style={{
              marginTop: 16,
              fontSize: 12,
              color: T.muted,
              fontFamily: T.font,
              maxWidth: 360,
              marginInline: 'auto',
              lineHeight: 1.5,
            }}
          >
            Not part of {AGENCY.name}? Sign up with a personal email to work independently instead.
          </p>
        </div>
      </StepShell>
    );
  }

  /* ── PROVISION — agency domain, not registered. Signer becomes owner. ────── */
  if (phase === 'provision') {
    return (
      <StepShell dots={dots}>
        <div style={{ textAlign: 'center' }}>
          <Badge label="✦" />
          <h1 ref={headingRef} tabIndex={-1} style={hStyle}>
            Set up your team on Balo
          </h1>
          <p style={pStyle}>
            You&apos;re the first person from your organisation here. You&apos;ll set up your
            team&apos;s presence on Balo and become its owner — colleagues who sign up with the same
            email domain will join you automatically.
          </p>
          {/* Earnings note applies: they own the agency that receives earnings. Framed
              for an owner rather than a joiner. */}
          <div
            style={{
              marginTop: 18,
              padding: '12px 14px',
              borderRadius: 10,
              background: 'rgba(37,99,235,.05)',
              border: `1px solid ${T.border}`,
              maxWidth: 400,
              marginInline: 'auto',
              textAlign: 'left',
            }}
          >
            <p
              style={{ margin: 0, color: T.fg, fontSize: 13, lineHeight: 1.55, fontFamily: T.font }}
            >
              Earnings from your team&apos;s work on Balo are paid to your team, and you decide how
              they&apos;re shared. You can transfer ownership later.
            </p>
          </div>
          {actionError && <ErrorBanner id="prov-err">{actionError}</ErrorBanner>}
          <div style={{ marginTop: 26, maxWidth: 340, marginInline: 'auto' }}>
            <ShimmerButton onClick={() => runWrite('provision')} disabled={busy}>
              {busy ? (
                <>
                  <Spinner /> Setting up&hellip;
                </>
              ) : (
                'Continue'
              )}
            </ShimmerButton>
          </div>
        </div>
      </StepShell>
    );
  }

  /* ── SOLO — freemail/blocked. Independent path. NEVER says "agency". ─────── */
  return (
    <StepShell dots={dots}>
      <div style={{ textAlign: 'center' }}>
        <Badge label="✦" />
        <h1 ref={headingRef} tabIndex={-1} style={hStyle}>
          Let&apos;s set up your expert profile
        </h1>
        <p style={pStyle}>
          {/* Freemail = independent. The word "agency" MUST NOT appear here (ADR-1034).
              This person is a solo consultant; "agency of one" is internal only. */}
          You&apos;ll work on Balo as an independent expert. Next, you&apos;ll build your profile —
          your skills, experience, and rates — so clients can find and book you.
        </p>
        {/* NO earnings-routing note here: for a solo expert, earnings effectively come
            straight to them; surfacing "paid to your agency" would confuse. */}
        {actionError && <ErrorBanner id="solo-err">{actionError}</ErrorBanner>}
        <div style={{ marginTop: 26, maxWidth: 340, marginInline: 'auto' }}>
          <ShimmerButton onClick={() => runWrite('solo')} disabled={busy}>
            {busy ? (
              <>
                <Spinner /> Setting up&hellip;
              </>
            ) : (
              'Continue'
            )}
          </ShimmerButton>
        </div>
      </div>
    </StepShell>
  );
}

/* ─────────────────────────────────────────────────────────────────────────
 * HARNESS
 * ──────────────────────────────────────────────────────────────────────── */
const SCENARIOS = [
  'join', // agency exists → determined join
  'provision', // agency domain, not registered → provision + own
  'solo', // freemail/blocked → independent (never says "agency")
  'join write error', // inline banner on the join screen, retry in place
  'loading',
];
const LABELS = {
  join: 'join — agency registered (determined)',
  provision: 'provision — agency domain, not yet on Balo (owner)',
  solo: 'solo — freemail / independent (never says “agency”)',
  'join write error': 'join — write failed (inline retry)',
  loading: 'loading',
};
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
  const [scenario, setScenario] = useState('join');
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
      <style>{`
        @keyframes balo-spin { to { transform: rotate(360deg); } }
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,600;9..40,700&display=swap');
        * { box-sizing: border-box; }
        button:focus-visible { outline: 2px solid ${T.primary}; outline-offset: 2px; }
      `}</style>

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
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1, minWidth: 280 }}>
          <span style={ctrlLabel}>Expert signup outcome</span>
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
              <option key={s} value={s}>
                {LABELS[s]}
              </option>
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
          ↻ Replay
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
        Renders as a step inside <strong>/expert/apply</strong> (7-step wizard) • ADR-1034: every
        expert is an agency, freelancer = agency of one • determined by email,{' '}
        <strong>no request/approve lifecycle</strong> • dormant in v1
      </p>

      <div style={{ maxWidth: 900, margin: '0 auto', display: 'grid', placeItems: 'center' }}>
        {done ? (
          <div style={cardDone}>
            <div style={{ fontSize: 28, marginBottom: 8, color: T.primary }}>→</div>
            <h2 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>
              {done === 'join'
                ? `Joined ${AGENCY.name}`
                : done === 'provision'
                  ? 'Team created — you’re the owner'
                  : 'Independent expert profile started'}
            </h2>
            <p style={{ color: T.muted, fontSize: 13.5, marginTop: 8 }}>
              → continues to the next apply-wizard step (profile, skills, rates)
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
          <ExpertAgencyStep key={`${scenario}-${nonce}`} scenario={scenario} onDone={setDone} />
        )}
      </div>
    </div>
  );
}
