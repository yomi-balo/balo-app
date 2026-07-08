'use client';

/**
 * DESIGN REFERENCE — Onboarding "Company" step (reshaped BAL-350)
 * ---------------------------------------------------------------
 * Source of truth for CC. This is a *design prototype*, not production code:
 * it self-mocks the server action so all states are viewable in isolation.
 * The real step lives at:
 *   apps/web/src/app/(onboarding)/onboarding/_components/company-step.tsx
 * and slots into onboarding-wizard.tsx as a client-only step (see wizard notes
 * at the bottom of this file).
 *
 * WHY THIS EXISTS (context for the implementer)
 * - The workspace/company row already exists by the time onboarding runs. It was
 *   created (personal, firstName-derived name) in verifyEmailAction / signUpAction
 *   (email) OR the OAuth callback (Google/Microsoft). This step RESOLVES that
 *   workspace's real identity: rename it (create branch) or, when an actionable
 *   domain match exists, offer to JOIN the existing company instead (join branch).
 * - Path-independent by construction: every new user funnels through onboarding
 *   regardless of auth method, so email + OAuth are covered by the SAME surface.
 *   This is the whole reason we moved off the inline email-step field in PR #134.
 *
 * v1 REALITY: `matched` is DORMANT. Every party_domains row maps to a personal
 * workspace, so the shared stand-down predicate returns "not actionable" for
 * every corporate domain → the JOIN branch is unreachable in v1 and the CREATE
 * branch always shows. The join branch is built here so it lights up together
 * with the shared-org creation seam (same predicate the engine reads), but it is
 * behind `status === 'matched'`, which cannot occur yet. Do not delete it.
 *
 * REUSED VOCABULARY (match exactly — do not reinvent):
 * - Heading: <h1 ref tabIndex={-1}> focus pattern (wizard focuses it on step change)
 * - InputFloating, ShimmerButton, Form/FormField/FormItem/FormControl/FormMessage
 * - Loader2 spinner; motion/react enter/center/exit handled by the wizard, not here
 * - Analytics: ONBOARDING_EVENTS.STEP_VIEWED / STEP_COMPLETED + the BAL-350
 *   AUTH_EVENTS.SIGNUP_COMPANY_NAME_CAPTURED capture event
 *
 * The tokens below mirror the app's CSS variables so this file renders standalone.
 */

import React, { useState, useEffect, useRef, useMemo } from 'react';

/* ─────────────────────────────────────────────────────────────────────────
 * Standalone token shim (production uses Tailwind + CSS vars; these mirror them)
 * ──────────────────────────────────────────────────────────────────────── */
const T = {
  bg: '#F8FAFB',
  surface: '#FFFFFF',
  border: '#E0E4EB',
  fg: '#0F1729',
  muted: '#64748B',
  primary: '#2563EB',
  primaryTo: '#7C3AED',
  destructive: '#DC2626',
  ring: 'rgba(37, 99, 235, 0.35)',
  radius: 12,
  font: "'DM Sans', ui-sans-serif, system-ui, -apple-system, sans-serif",
};

/* ─────────────────────────────────────────────────────────────────────────
 * suggestCompanyNameFromEmail — SALVAGED from PR #134 (packages/shared/domains).
 * Pure prefill: founder@acme.com → "Acme"; jane@acme-corp.io → "Acme Corp";
 * freemail/blocked or unusable → "" (no "Gmail" prefill).
 * ──────────────────────────────────────────────────────────────────────── */
const FREEMAIL = new Set([
  'gmail.com',
  'yahoo.com',
  'outlook.com',
  'hotmail.com',
  'icloud.com',
  'proton.me',
  'protonmail.com',
  'aol.com',
  'live.com',
  'msn.com',
]);
function extractEmailDomain(email) {
  const at = email.lastIndexOf('@');
  if (at < 0) return null;
  const d = email
    .slice(at + 1)
    .trim()
    .toLowerCase();
  return d.length > 0 ? d : null;
}
function isBlockedDomain(domain) {
  return domain === '' || FREEMAIL.has(domain);
}
function suggestCompanyNameFromEmail(email) {
  const domain = extractEmailDomain(email);
  if (domain === null || isBlockedDomain(domain)) return '';
  const [label] = domain.split('.');
  if (!label) return '';
  return label
    .split(/[-_]/)
    .filter((w) => w.length > 0)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/* ─────────────────────────────────────────────────────────────────────────
 * Mock server action. In production this is `resolveOnboardingCompanyAction()`
 * (a READ-ONLY, authenticated action — the user is signed in during onboarding,
 * unlike PR #134's pre-auth check, which removes the whole rate-limit concern).
 * It returns the EFFECTIVE status the step needs:
 *   { status: 'new',     suggestion?: string }  → CREATE branch (name/confirm)
 *   { status: 'blocked', suggestion: '' }        → CREATE branch, empty prefill
 *   { status: 'matched', company: {...} }        → JOIN branch (dormant in v1)
 * Fails open to { status: 'new' } so onboarding is never blocked.
 * ──────────────────────────────────────────────────────────────────────── */
const SCENARIOS = {
  'new (corporate)': async (email) => ({
    status: 'new',
    suggestion: suggestCompanyNameFromEmail(email),
  }),
  'blocked (freemail)': async () => ({ status: 'blocked', suggestion: '' }),
  'matched (DORMANT in v1)': async () => ({
    status: 'matched',
    company: { name: 'Northwind', memberCount: 42, joinMode: 'auto' },
  }),
  'slow check (1.5s)': async (email) => {
    await new Promise((r) => setTimeout(r, 1500));
    return { status: 'new', suggestion: suggestCompanyNameFromEmail(email) };
  },
  'check throws → fail open': async () => {
    throw new Error('resolve action failed');
  },
  'save error (rename fails)': async (email) => ({
    status: 'new',
    suggestion: suggestCompanyNameFromEmail(email),
    __saveWillFail: true,
  }),
};

/* ─────────────────────────────────────────────────────────────────────────
 * Primitive UI (mirrors balo-ui components; production swaps these for the real
 * InputFloating / ShimmerButton / Form primitives)
 * ──────────────────────────────────────────────────────────────────────── */
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

function FloatingInput({ label, value, onChange, error, disabled, autoFocus, id }) {
  const [focused, setFocused] = useState(false);
  const floated = focused || (value && value.length > 0);
  return (
    <div style={{ position: 'relative' }}>
      <input
        id={id}
        name="companyName"
        value={value}
        disabled={disabled}
        autoFocus={autoFocus}
        autoComplete="organization"
        aria-required="true"
        aria-invalid={!!error}
        aria-describedby={error ? `${id}-err` : `${id}-desc`}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={{
          width: '100%',
          height: 52,
          padding: '18px 14px 6px',
          fontSize: 15,
          fontFamily: T.font,
          color: T.fg,
          background: disabled ? '#F1F5F9' : T.surface,
          border: `1px solid ${error ? T.destructive : focused ? T.primary : T.border}`,
          borderRadius: T.radius,
          outline: 'none',
          boxShadow: focused ? `0 0 0 3px ${error ? 'rgba(220,38,38,.15)' : T.ring}` : 'none',
          transition: 'border-color .15s, box-shadow .15s',
          boxSizing: 'border-box',
        }}
      />
      <label
        htmlFor={id}
        style={{
          position: 'absolute',
          left: 14,
          top: floated ? 8 : 16,
          fontSize: floated ? 11 : 15,
          fontWeight: floated ? 600 : 400,
          letterSpacing: floated ? '0.02em' : 0,
          color: error ? T.destructive : floated ? (focused ? T.primary : T.muted) : T.muted,
          pointerEvents: 'none',
          transition: 'all .15s ease',
          fontFamily: T.font,
        }}
      >
        {label}
      </label>
    </div>
  );
}

function ShimmerButton({ children, onClick, disabled, variant = 'primary', type = 'button' }) {
  const [hover, setHover] = useState(false);
  const isPrimary = variant === 'primary';
  return (
    <button
      type={type}
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
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
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

/* ─────────────────────────────────────────────────────────────────────────
 * THE STEP — states as an explicit state machine:
 *   'resolving' → running resolveOnboardingCompanyAction (spinner)
 *   'create'    → status new|blocked: name-your-workspace form
 *   'join'      → status matched (DORMANT v1): confirm join existing company
 * Plus per-branch sub-states: required-error, saving, save-error.
 * ──────────────────────────────────────────────────────────────────────── */
function CompanyStep({ email, firstName, scenario, onComplete, onBack, stepNumber, totalSteps }) {
  const [phase, setPhase] = useState('resolving'); // resolving | create | join
  const [resolved, setResolved] = useState(null); // { status, suggestion?, company?, __saveWillFail? }
  const [name, setName] = useState('');
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState(null); // field-level required error
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState(null); // save/join failure banner
  const headingRef = useRef(null);

  // STEP_VIEWED analytics fire once on mount (mirrors every existing step).
  useEffect(() => {
    // track(ONBOARDING_EVENTS.STEP_VIEWED, { step: 'company', step_number: stepNumber })
  }, [stepNumber]);

  // Resolve on mount. Fail-open to CREATE branch so onboarding is never blocked.
  useEffect(() => {
    let live = true;
    setPhase('resolving');
    setActionError(null);
    (async () => {
      try {
        const res = await SCENARIOS[scenario](email);
        if (!live) return;
        setResolved(res);
        if (res.status === 'matched') {
          setPhase('join');
        } else {
          setPhase('create');
          if (!touched) setName(res.suggestion ?? '');
        }
      } catch {
        if (!live) return;
        // Fail open: behave as an unmatched corporate domain.
        setResolved({ status: 'new', suggestion: suggestCompanyNameFromEmail(email) });
        setPhase('create');
        if (!touched) setName(suggestCompanyNameFromEmail(email));
      }
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scenario, email]);

  // Focus the heading when the phase settles (wizard convention).
  useEffect(() => {
    if (phase !== 'resolving') {
      const t = setTimeout(() => headingRef.current?.focus(), 120);
      return () => clearTimeout(t);
    }
  }, [phase]);

  const trimmed = name.trim();

  function handleCreate() {
    if (trimmed === '') {
      setError('Enter a name for your workspace');
      return;
    }
    setError(null);
    setSaving(true);
    setActionError(null);
    // Mock the save: renameWorkspaceAction(trimmed) → completeOnboarding path
    setTimeout(() => {
      if (resolved?.__saveWillFail) {
        setSaving(false);
        setActionError("We couldn't save that just now. Please try again.");
        return;
      }
      // track(AUTH_EVENTS.SIGNUP_COMPANY_NAME_CAPTURED, {
      //   domain_type: resolved.status === 'blocked' ? 'blocked' : 'new' })
      // track(ONBOARDING_EVENTS.STEP_COMPLETED, { step: 'company', step_number })
      setSaving(false);
      onComplete({ branch: 'create', name: trimmed });
    }, 700);
  }

  function handleJoin() {
    setSaving(true);
    setActionError(null);
    setTimeout(() => {
      setSaving(false);
      onComplete({ branch: 'join', company: resolved.company.name });
    }, 700);
  }

  function handleCreateInstead() {
    // Escape hatch from the join branch — "This isn't my company / start my own".
    setPhase('create');
    setResolved((r) => ({ ...r, status: 'new' }));
    setName('');
    setTouched(true);
  }

  /* ── RESOLVING ──────────────────────────────────────────────────────── */
  if (phase === 'resolving') {
    return (
      <StepShell stepNumber={stepNumber} totalSteps={totalSteps}>
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
            Setting up your workspace&hellip;
          </p>
        </div>
      </StepShell>
    );
  }

  /* ── JOIN branch (status: matched — DORMANT in v1) ──────────────────── */
  if (phase === 'join' && resolved?.company) {
    const c = resolved.company;
    return (
      <StepShell stepNumber={stepNumber} totalSteps={totalSteps}>
        <div style={{ textAlign: 'center' }}>
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
              background: `linear-gradient(135deg, ${T.primary}, ${T.primaryTo})`,
            }}
          >
            {c.name.charAt(0)}
          </div>
          <h1 ref={headingRef} tabIndex={-1} style={hStyle}>
            Join {c.name}?
          </h1>
          <p style={pStyle}>
            {/* Prospective copy names the PARTY (company), per copy conventions. */}
            Your email domain is managed by <strong style={{ color: T.fg }}>{c.name}</strong>.{' '}
            You&apos;ll join their workspace with {c.memberCount} teammates already on Balo.
          </p>

          {actionError && <ErrorBanner id="join-err">{actionError}</ErrorBanner>}

          <div
            style={{
              marginTop: 28,
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
              maxWidth: 340,
              marginInline: 'auto',
            }}
          >
            <ShimmerButton onClick={handleJoin} disabled={saving}>
              {saving ? (
                <>
                  <Spinner /> Joining&hellip;
                </>
              ) : (
                `Join ${c.name}`
              )}
            </ShimmerButton>
            <ShimmerButton variant="secondary" onClick={handleCreateInstead} disabled={saving}>
              This isn&apos;t my company
            </ShimmerButton>
          </div>
        </div>
      </StepShell>
    );
  }

  /* ── CREATE branch (status: new | blocked) ──────────────────────────── */
  const isBlocked = resolved?.status === 'blocked';
  return (
    <StepShell stepNumber={stepNumber} totalSteps={totalSteps}>
      <div style={{ textAlign: 'center' }}>
        <h1 ref={headingRef} tabIndex={-1} style={hStyle}>
          Name your workspace
        </h1>
        <p style={pStyle}>
          {/* Warm, non-adversarial; helps the user recognise what this controls. */}
          This is how your company appears to consultants on Balo. You can change it anytime in
          settings.
        </p>

        <div style={{ marginTop: 28, maxWidth: 360, marginInline: 'auto', textAlign: 'left' }}>
          <FloatingInput
            id="companyName"
            label="Company name"
            value={name}
            disabled={saving}
            autoFocus
            onChange={(v) => {
              setName(v);
              setTouched(true);
              if (error) setError(null);
            }}
            error={error}
          />
          {error ? (
            <p
              id="companyName-err"
              style={{
                color: T.destructive,
                fontSize: 12.5,
                margin: '7px 2px 0',
                fontFamily: T.font,
              }}
            >
              {error}
            </p>
          ) : (
            <p
              id="companyName-desc"
              style={{ color: T.muted, fontSize: 12.5, margin: '7px 2px 0', fontFamily: T.font }}
            >
              {isBlocked
                ? 'Tell us your company or team name.'
                : 'We suggested this from your email — edit if it’s not right.'}
            </p>
          )}

          {actionError && <ErrorBanner id="create-err">{actionError}</ErrorBanner>}

          <div style={{ marginTop: 20 }}>
            <ShimmerButton type="submit" onClick={handleCreate} disabled={saving}>
              {saving ? (
                <>
                  <Spinner /> Saving&hellip;
                </>
              ) : (
                'Continue'
              )}
            </ShimmerButton>
          </div>
        </div>

        {onBack && (
          <div style={{ marginTop: 18 }}>
            <GhostButton onClick={onBack} disabled={saving}>
              ← Back
            </GhostButton>
          </div>
        )}
      </div>
    </StepShell>
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

function StepShell({ children, stepNumber, totalSteps }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: '100%' }}>
      <div
        style={{
          width: '100%',
          maxWidth: 460,
          background: T.surface,
          border: `1px solid ${T.border}`,
          borderRadius: 20,
          padding: '40px 32px',
          boxShadow: '0 1px 2px rgba(15,23,41,.04), 0 12px 32px rgba(15,23,41,.06)',
        }}
      >
        {children}
      </div>
      <div style={{ marginTop: 26 }}>
        <ProgressDots current={stepNumber} total={totalSteps} />
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────
 * PROTOTYPE HARNESS — scenario switcher + placement toggle. Not shipped.
 * ──────────────────────────────────────────────────────────────────────── */
export default function Prototype() {
  const [scenario, setScenario] = useState('new (corporate)');
  const [placement, setPlacement] = useState('after-intent'); // after-intent | before-intent
  const [email, setEmail] = useState('jane@acme-corp.io');
  const [done, setDone] = useState(null);
  const [nonce, setNonce] = useState(0);

  // Placement decides where the step sits and thus its number in the dots.
  // after-intent (client-only): Name? → Welcome → Timezone → Intent → COMPANY
  // before-intent (all users):  Name? → Welcome → Timezone → COMPANY → Intent
  const placements = useMemo(
    () => ({
      'after-intent': { stepNumber: 5, totalSteps: 5, note: 'Client-only, after Intent' },
      'before-intent': { stepNumber: 4, totalSteps: 5, note: 'All users, before Intent' },
    }),
    []
  );
  const p = placements[placement];

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
        button:focus-visible, input:focus-visible { outline: 2px solid ${T.primary}; outline-offset: 2px; }
      `}</style>

      {/* Control bar */}
      <div
        style={{
          maxWidth: 900,
          margin: '0 auto 26px',
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
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={ctrlLabel}>State / scenario</span>
          <select
            value={scenario}
            onChange={(e) => {
              setScenario(e.target.value);
              setDone(null);
              setNonce((n) => n + 1);
            }}
            style={selStyle}
          >
            {Object.keys(SCENARIOS).map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={ctrlLabel}>Placement</span>
          <select value={placement} onChange={(e) => setPlacement(e.target.value)} style={selStyle}>
            <option value="after-intent">After Intent (client-only) — recommended</option>
            <option value="before-intent">Before Intent (all users)</option>
          </select>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1, minWidth: 200 }}>
          <span style={ctrlLabel}>Signup email (drives prefill)</span>
          <input
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              setDone(null);
              setNonce((n) => n + 1);
            }}
            style={{ ...selStyle, cursor: 'text' }}
          />
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
        {p.note} • step {p.stepNumber} of {p.totalSteps} • matched branch is{' '}
        <strong>dormant in v1</strong> (unreachable until the shared-org seam ships)
      </p>

      {/* The step (or the completion state) */}
      <div style={{ maxWidth: 900, margin: '0 auto', display: 'grid', placeItems: 'center' }}>
        {done ? (
          <div style={{ ...cardDone }}>
            <div style={{ fontSize: 28, marginBottom: 8 }}>✓</div>
            <h2 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>
              {done.branch === 'join' ? `Joined ${done.company}` : `Workspace named “${done.name}”`}
            </h2>
            <p style={{ color: T.muted, fontSize: 13.5, marginTop: 8 }}>
              → proceeds to{' '}
              {placement === 'after-intent' ? 'dashboard (onboarding complete)' : 'Intent step'}
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
          <CompanyStep
            key={`${scenario}-${email}-${placement}-${nonce}`}
            email={email}
            firstName="Jane"
            scenario={scenario}
            stepNumber={p.stepNumber}
            totalSteps={p.totalSteps}
            onBack={placement === 'before-intent' ? () => {} : undefined}
            onComplete={setDone}
          />
        )}
      </div>
    </div>
  );
}

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
