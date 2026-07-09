'use client';

/**
 * DESIGN REFERENCE — Domain-based join: ADMIN SETTINGS surface (BAL-347)
 * ---------------------------------------------------------------------------
 * Source of truth for CC. Self-mocks its data + actions so every state renders
 * standalone. This is the ADMIN's control panel for domain join — the counterpart
 * to the three onboarding/signup references:
 *   - onboarding-company-step.jsx  -> client AUTO-join interstitial (shipped, BAL-350)
 *   - domain-join-pending.jsx      -> client REQUEST-mode flow (ADR-1031)
 *   - expert-agency-step.jsx       -> expert/agency resolution (ADR-1034)
 *   - domain-join-admin.jsx        -> THIS FILE: the org admin's settings surface
 *
 * CAPABILITY GATE: this whole surface is only reachable by owners/admins holding
 * MANAGE_MEMBERS. The prototype IS that admin's view (we show the gate as a chip,
 * not as a locked/denied screen — a non-admin never routes here).
 *
 * PARTY-TYPE DIFFERENCE IS THE POINT (top-of-file segmented control swaps it):
 *   • COMPANY (ADR-1031) — three sections: Domains · Join mode (auto/request/off)
 *     · Join-request queue. Company membership is workspace access control, so a
 *     "request → approve" lifecycle legitimately exists.
 *   • AGENCY  (ADR-1034) — ONE section: Domains only. Membership is DETERMINED BY
 *     VERIFIED EMAIL. There is deliberately NO join-mode selector and NO request
 *     queue. Their absence is made explicit (an intentional note), not an accident.
 *
 * COPY CONVENTIONS (carried from the sibling refs):
 *   - Gender-neutral throughout.
 *   - Retrospective attribution: first time a person is named in the domain list we
 *     append "@ {party}" (which org they belong to — multi-membership is now allowed);
 *     later mentions of the same person are bare.
 *   - Decline is NEUTRAL in the requester-facing world; in this ADMIN log "Declined by
 *     {Name}" is a plain fact, never "rejected".
 *   - One emphasized action per surface: the gradient ShimmerButton appears exactly
 *     ONCE per view (Add domain). Row-level Approve/Decline/Remove are semantic,
 *     lower-emphasis controls (success-solid / ghost / destructive-text).
 *
 * FOUR ASYNC STATES: the harness "Data" control drives the two data-backed sections
 * (Domains, Join-request queue) through loading / empty / error / loaded. The queue's
 * optimistic Approve→rollback-on-error path is live in the loaded state (Marco fails).
 *
 * v1 REALITY: dormant like the rest of domain-join — no shared org can be reached
 * while every domain maps to a personal workspace. Built-not-live.
 *
 * REUSED VOCABULARY (verbatim from the siblings): T tokens, DM Sans import, balo-spin
 * keyframe, Spinner, ShimmerButton, GhostButton, ErrorBanner, the surface/border/radius
 * card styling. Admin-specific primitives added in the same style: SegmentedControl,
 * SectionCard, SourceBadge, DomainRow, DomainInput, ConfirmInline, ModeOption,
 * RequestRow, ResolvedRow.
 */

import React, { useState, useEffect, useRef, useMemo } from 'react';
import {
  Building2,
  Users,
  Globe,
  Plus,
  Trash2,
  Check,
  X,
  Clock,
  ChevronDown,
  ShieldCheck,
  Info,
  Sparkles,
  AlertTriangle,
  RotateCcw,
  UserPlus,
  Lock,
} from 'lucide-react';

/* Token shim — identical to the sibling references */
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
  warning: '#B45309', // local addition (T has no warning) — used only for the last-domain caution
  ring: 'rgba(37, 99, 235, 0.35)',
  radius: 12,
  font: "'DM Sans', ui-sans-serif, system-ui, -apple-system, sans-serif",
};

/* ── Mock parties + people (gender-neutral names) ─────────────────────────── */
const COMPANY = { name: 'Northwind' };
const AGENCY = { name: 'Lattice Consulting' };
const CURRENT_ADMIN = 'Riley Chen'; // the admin viewing this surface

/* Domains map to ONE owner per domain (single-owner rule). CLAIMED = owned by
   SOME OTHER org — we never name the other org (privacy). BLOCKED = freemail. */
const BLOCKED = new Set([
  'gmail.com',
  'yahoo.com',
  'outlook.com',
  'hotmail.com',
  'icloud.com',
  'proton.me',
]);
const CLAIMED = new Set(['acme.com', 'globex.io', 'initech.com']);

/* Seed data, keyed by party. Each domain carries source + attributor. */
const SEED = {
  company: {
    domains: [
      { id: 'd1', domain: 'northwind.com', source: 'auto', by: 'Jordan Ellis' },
      { id: 'd2', domain: 'northwind.io', source: 'admin', by: 'Jordan Ellis' },
      { id: 'd3', domain: 'northwind.co.uk', source: 'admin', by: 'Riley Chen' },
    ],
    mode: 'request', // this org chose request (why a queue exists). Platform DEFAULT is 'auto'.
    modeChangedBy: 'Jordan Ellis',
    modeChangedOn: 'Jul 3',
    pending: [
      {
        id: 'r1',
        order: 0,
        name: 'Priya Anand',
        email: 'priya.anand@northwind.com',
        when: 'Jul 7',
      },
      {
        id: 'r2',
        order: 1,
        name: 'Marco Reyes',
        email: 'marco@northwind.io',
        when: 'Jul 8',
        willFail: true,
      },
      { id: 'r3', order: 2, name: 'Dana Lund', email: 'dana.lund@northwind.com', when: 'Jul 9' },
    ],
    resolved: [
      {
        id: 'h1',
        name: 'Chris Vale',
        email: 'chris@northwind.com',
        outcome: 'approved',
        by: 'Jordan Ellis',
        when: 'Jul 2',
      },
      {
        id: 'h2',
        name: 'Robin Shaw',
        email: 'robin@northwind.io',
        outcome: 'declined',
        by: 'Riley Chen',
        when: 'Jul 1',
      },
    ],
  },
  agency: {
    domains: [
      { id: 'a1', domain: 'latticeconsulting.com', source: 'auto', by: 'Sam Okafor' },
      { id: 'a2', domain: 'lattice.co', source: 'admin', by: 'Sam Okafor' },
    ],
  },
};

/* ─────────────────────────────────────────────────────────────────────────
 * PRIMITIVES — copied verbatim from the sibling references
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

function ShimmerButton({ children, onClick, disabled, variant = 'primary', fullWidth = true }) {
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
        width: fullWidth ? '100%' : 'auto',
        padding: fullWidth ? 0 : '0 20px',
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
        whiteSpace: 'nowrap',
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

function GhostButton({ children, onClick, disabled, tone = 'muted' }) {
  const color = tone === 'destructive' ? T.destructive : tone === 'primary' ? T.primary : T.muted;
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
        color,
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

function ErrorBanner({ children, id }) {
  return (
    <div
      id={id}
      role="alert"
      style={{
        marginTop: 12,
        padding: '10px 12px',
        borderRadius: 10,
        background: 'rgba(220,38,38,.06)',
        border: '1px solid rgba(220,38,38,.25)',
        color: T.destructive,
        fontSize: 13,
        fontFamily: T.font,
        textAlign: 'left',
        display: 'flex',
        gap: 8,
        alignItems: 'flex-start',
      }}
    >
      <AlertTriangle size={15} style={{ flex: '0 0 auto', marginTop: 1 }} />
      <span>{children}</span>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────
 * ADMIN-SPECIFIC PRIMITIVES — same visual language, new to this surface
 * ──────────────────────────────────────────────────────────────────────── */

/* Segmented control — used for the party toggle (and the harness data toggle). */
function SegmentedControl({ options, value, onChange, size = 'md' }) {
  const pad = size === 'sm' ? '6px 12px' : '9px 16px';
  const fs = size === 'sm' ? 12.5 : 13.5;
  return (
    <div
      role="tablist"
      style={{
        display: 'inline-flex',
        padding: 4,
        borderRadius: 12,
        background: '#EEF1F6',
        border: `1px solid ${T.border}`,
        gap: 4,
      }}
    >
      {options.map((o) => {
        const active = o.value === value;
        const Icon = o.icon;
        return (
          <button
            key={o.value}
            role="tab"
            aria-selected={active}
            onClick={() => onChange(o.value)}
            style={{
              padding: pad,
              borderRadius: 9,
              border: 'none',
              cursor: 'pointer',
              fontFamily: T.font,
              fontSize: fs,
              fontWeight: 600,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 7,
              color: active ? T.fg : T.muted,
              background: active ? T.surface : 'transparent',
              boxShadow: active
                ? '0 1px 2px rgba(15,23,41,.08), 0 2px 6px rgba(15,23,41,.06)'
                : 'none',
              transition: 'all .2s ease',
            }}
          >
            {Icon && <Icon size={15} />}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/* Section card — the shared shell styling from StepShell, adapted to a full-width
   settings section with a title/description header. */
function SectionCard({ title, description, headerRight, index = 0, children }) {
  return (
    <section
      style={{
        width: '100%',
        background: T.surface,
        border: `1px solid ${T.border}`,
        borderRadius: 20,
        padding: '24px 26px',
        boxShadow: '0 1px 2px rgba(15,23,41,.04), 0 12px 32px rgba(15,23,41,.05)',
        animation: 'balo-rise .5s ease both',
        animationDelay: `${index * 80}ms`,
      }}
    >
      <header
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 16,
          marginBottom: 18,
        }}
      >
        <div>
          <h2
            style={{
              margin: 0,
              fontSize: 16.5,
              fontWeight: 600,
              color: T.fg,
              fontFamily: T.font,
              letterSpacing: '-0.01em',
            }}
          >
            {title}
          </h2>
          {description && (
            <p
              style={{
                margin: '5px 0 0',
                fontSize: 13,
                color: T.muted,
                fontFamily: T.font,
                lineHeight: 1.5,
              }}
            >
              {description}
            </p>
          )}
        </div>
        {headerRight}
      </header>
      {children}
    </section>
  );
}

function SourceBadge({ source }) {
  const isAuto = source === 'auto';
  const Icon = isAuto ? Sparkles : UserPlus;
  return (
    <span
      title={isAuto ? 'Captured automatically from a signup' : 'Added by an admin'}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding: '3px 9px',
        borderRadius: 99,
        fontSize: 11.5,
        fontWeight: 600,
        fontFamily: T.font,
        color: isAuto ? T.primary : T.muted,
        background: isAuto ? 'rgba(37,99,235,.09)' : 'rgba(100,116,139,.1)',
        border: `1px solid ${isAuto ? 'rgba(37,99,235,.18)' : 'rgba(100,116,139,.18)'}`,
        whiteSpace: 'nowrap',
      }}
    >
      <Icon size={12} />
      {isAuto ? 'Auto-captured' : 'Admin-added'}
    </span>
  );
}

function ConfirmInline({ message, caution, confirmLabel, onConfirm, onCancel, busy }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 14,
        flexWrap: 'wrap',
        padding: '12px 14px',
        borderRadius: 12,
        background: 'rgba(220,38,38,.05)',
        border: '1px solid rgba(220,38,38,.22)',
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 220, flex: 1 }}>
        <span style={{ fontSize: 13.5, color: T.fg, fontFamily: T.font, fontWeight: 500 }}>
          {message}
        </span>
        {caution && (
          <span
            style={{
              fontSize: 12.5,
              color: T.warning,
              fontFamily: T.font,
              display: 'inline-flex',
              gap: 5,
              alignItems: 'center',
            }}
          >
            <AlertTriangle size={13} /> {caution}
          </span>
        )}
      </div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <GhostButton onClick={onCancel} disabled={busy}>
          Keep
        </GhostButton>
        <button
          type="button"
          onClick={onConfirm}
          disabled={busy}
          style={{
            height: 36,
            padding: '0 14px',
            borderRadius: 8,
            border: 'none',
            cursor: busy ? 'not-allowed' : 'pointer',
            fontFamily: T.font,
            fontSize: 13,
            fontWeight: 600,
            color: '#fff',
            background: T.destructive,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
          }}
        >
          {busy ? <Spinner size={14} /> : <Trash2 size={14} />}
          {confirmLabel}
        </button>
      </div>
    </div>
  );
}

/* Attribution line for a domain row. Verb is source-aware for correctness; the
   first-mention "@ {party}" rule applies to the PERSON regardless of verb. */
function attributionText(row, firstMention, party) {
  const verb = row.source === 'auto' ? 'Captured from' : 'Added by';
  return `${verb} ${row.by}${firstMention ? ` @ ${party}` : ''}`;
}

function DomainRow({ row, firstMention, party, isLast, onRemove }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  if (confirming) {
    return (
      <div style={{ padding: '4px 0' }}>
        <ConfirmInline
          message={`Remove ${row.domain}?`}
          caution={
            isLast
              ? 'This is your last domain — removing it turns off join by domain entirely.'
              : "New signups on this domain won't be recognised."
          }
          confirmLabel="Remove"
          busy={busy}
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setBusy(true);
            setTimeout(() => onRemove(row.id), 500); // simulate write latency
          }}
        />
      </div>
    );
  }

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '12px 4px',
      }}
    >
      <span
        style={{
          flex: '0 0 auto',
          width: 34,
          height: 34,
          borderRadius: 9,
          display: 'grid',
          placeItems: 'center',
          background: 'rgba(37,99,235,.08)',
          color: T.primary,
        }}
      >
        <Globe size={16} />
      </span>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 14.5, fontWeight: 600, color: T.fg, fontFamily: T.font }}>
            {row.domain}
          </span>
          <SourceBadge source={row.source} />
        </div>
        <p style={{ margin: '3px 0 0', fontSize: 12.5, color: T.muted, fontFamily: T.font }}>
          {attributionText(row, firstMention, party)}
        </p>
      </div>
      <GhostButton tone="destructive" onClick={() => setConfirming(true)}>
        <Trash2 size={14} /> Remove
      </GhostButton>
    </div>
  );
}

function DomainInput({ existing, party, onAdd }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [justAdded, setJustAdded] = useState(false);
  const inputRef = useRef(null);

  function validate(input) {
    // lowercased + trimmed; strip protocol / @ / trailing path so paste is forgiving
    const cleaned = input
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/^@/, '')
      .replace(/\/.*$/, '');
    if (!cleaned) return { error: 'Enter a domain to add.' };
    const format = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
    if (!format.test(cleaned))
      return {
        error: `That doesn't look like a domain. Enter it like acme.com — no https:// or @.`,
      };
    if (BLOCKED.has(cleaned))
      return {
        error: `${cleaned} is a personal email provider, so teammates can't be recognised by it. Use a domain your organisation owns.`,
      };
    if (existing.some((d) => d.domain === cleaned))
      return { error: `${cleaned} is already on your list.` };
    if (CLAIMED.has(cleaned))
      return {
        error: `${cleaned} is already connected to another organisation on Balo. Each domain can belong to just one. If it should be yours, contact support to claim it.`,
      };
    return { value: cleaned };
  }

  function submit() {
    const result = validate(value);
    if (result.error) {
      setError(result.error);
      return;
    }
    setError(null);
    setBusy(true);
    setTimeout(() => {
      onAdd(result.value);
      setBusy(false);
      setValue('');
      setJustAdded(true);
      setTimeout(() => setJustAdded(false), 2200);
      inputRef.current && inputRef.current.focus();
    }, 550);
  }

  const hasError = Boolean(error);
  return (
    <div style={{ marginTop: 6 }}>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <div style={{ flex: 1, minWidth: 220, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <label
            htmlFor="add-domain"
            style={{ fontSize: 12, fontWeight: 600, color: T.muted, fontFamily: T.font }}
          >
            Add a domain
          </label>
          <input
            id="add-domain"
            ref={inputRef}
            value={value}
            placeholder="acme.com"
            spellCheck={false}
            autoCapitalize="none"
            onChange={(e) => {
              setValue(e.target.value.toLowerCase()); // always lowercase, live
              if (error) setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit();
            }}
            style={{
              height: 44,
              padding: '0 14px',
              borderRadius: 10,
              border: `1px solid ${hasError ? 'rgba(220,38,38,.55)' : T.border}`,
              background: T.surface,
              color: T.fg,
              fontSize: 14,
              fontFamily: T.font,
              outline: 'none',
              width: '100%',
              boxShadow: hasError ? '0 0 0 3px rgba(220,38,38,.12)' : 'none',
              transition: 'border-color .15s, box-shadow .15s',
            }}
          />
          <span style={{ fontSize: 11.5, color: T.muted, fontFamily: T.font }}>
            Domains are stored in lowercase. Demo: try{' '}
            <code style={{ fontFamily: 'ui-monospace, monospace' }}>acme.com</code> (claimed),{' '}
            <code style={{ fontFamily: 'ui-monospace, monospace' }}>gmail.com</code> (blocked), or{' '}
            <code style={{ fontFamily: 'ui-monospace, monospace' }}>nw.com</code> (ok).
          </span>
        </div>
        <div style={{ marginTop: 24 }}>
          {/* The ONE emphasized action on this surface */}
          <ShimmerButton onClick={submit} disabled={busy} fullWidth={false}>
            {busy ? (
              <>
                <Spinner /> Adding…
              </>
            ) : (
              <>
                <Plus size={16} /> Add domain
              </>
            )}
          </ShimmerButton>
        </div>
      </div>
      {hasError && <ErrorBanner id="add-domain-err">{error}</ErrorBanner>}
      {justAdded && (
        <div
          role="status"
          style={{
            marginTop: 12,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 7,
            fontSize: 13,
            color: T.success,
            fontFamily: T.font,
            fontWeight: 500,
          }}
        >
          <Check size={15} /> Domain added and recorded in your audit log.
        </div>
      )}
    </div>
  );
}

function ModeOption({ id, title, desc, selected, isDefault, onSelect }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex',
        gap: 12,
        alignItems: 'flex-start',
        textAlign: 'left',
        width: '100%',
        padding: '14px 16px',
        borderRadius: 12,
        cursor: 'pointer',
        fontFamily: T.font,
        border: `1px solid ${selected ? 'rgba(37,99,235,.55)' : T.border}`,
        background: selected ? 'rgba(37,99,235,.05)' : hover ? '#FAFBFD' : T.surface,
        boxShadow: selected ? '0 0 0 3px rgba(37,99,235,.1)' : 'none',
        transition: 'all .18s ease',
      }}
    >
      <span
        aria-hidden
        style={{
          flex: '0 0 auto',
          marginTop: 1,
          width: 18,
          height: 18,
          borderRadius: 99,
          border: `2px solid ${selected ? T.primary : T.border}`,
          display: 'grid',
          placeItems: 'center',
          transition: 'border-color .18s',
        }}
      >
        {selected && (
          <span style={{ width: 8, height: 8, borderRadius: 99, background: T.primary }} />
        )}
      </span>
      <span style={{ minWidth: 0 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: T.fg }}>{title}</span>
          {isDefault && (
            <span
              style={{
                fontSize: 10.5,
                fontWeight: 600,
                color: T.muted,
                background: 'rgba(100,116,139,.12)',
                borderRadius: 99,
                padding: '2px 7px',
                textTransform: 'uppercase',
                letterSpacing: '0.03em',
              }}
            >
              Default
            </span>
          )}
        </span>
        <span
          style={{
            display: 'block',
            marginTop: 3,
            fontSize: 12.5,
            color: T.muted,
            lineHeight: 1.5,
          }}
        >
          {desc}
        </span>
      </span>
    </button>
  );
}

function Avatar({ name, tone = 'primary' }) {
  const initials = name
    .split(' ')
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
  const bg =
    tone === 'success'
      ? `linear-gradient(135deg, ${T.success}, #10B981)`
      : `linear-gradient(135deg, ${T.primary}, ${T.primaryTo})`;
  return (
    <span
      aria-hidden
      style={{
        flex: '0 0 auto',
        width: 38,
        height: 38,
        borderRadius: 10,
        display: 'grid',
        placeItems: 'center',
        color: '#fff',
        fontWeight: 700,
        fontSize: 13.5,
        fontFamily: T.font,
        background: bg,
      }}
    >
      {initials}
    </span>
  );
}

function RequestRow({ req, error, onApprove, onDecline }) {
  const firstName = req.name.split(' ')[0];
  return (
    <div
      style={{
        padding: '4px 0',
        animation: error ? 'balo-shake .4s ease' : undefined,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <Avatar name={req.name} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 14.5, fontWeight: 600, color: T.fg, fontFamily: T.font }}>
            {req.name}
          </div>
          <div
            style={{
              fontSize: 12.5,
              color: T.muted,
              fontFamily: T.font,
              display: 'flex',
              gap: 8,
              flexWrap: 'wrap',
            }}
          >
            <span>{req.email}</span>
            <span aria-hidden>·</span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <Clock size={12} /> Requested {req.when}
            </span>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flex: '0 0 auto' }}>
          {/* Decline = ghost; Approve = semantic success-solid. Neither is the
              brand-emphasized gradient CTA (that is reserved for Add domain). */}
          <GhostButton onClick={() => onDecline(req)}>
            <X size={14} /> Decline
          </GhostButton>
          <button
            type="button"
            onClick={() => onApprove(req)}
            style={{
              height: 36,
              padding: '0 14px',
              borderRadius: 8,
              border: 'none',
              cursor: 'pointer',
              fontFamily: T.font,
              fontSize: 13,
              fontWeight: 600,
              color: '#fff',
              background: T.success,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            <Check size={14} /> Approve
          </button>
        </div>
      </div>
      {error && (
        <ErrorBanner id={`req-err-${req.id}`}>
          {`Couldn't approve — ${firstName} is still waiting. Nothing changed; try again.`}
        </ErrorBanner>
      )}
    </div>
  );
}

function ResolvedRow({ item }) {
  const approved = item.outcome === 'approved';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0' }}>
      <span
        aria-hidden
        style={{
          flex: '0 0 auto',
          width: 30,
          height: 30,
          borderRadius: 99,
          display: 'grid',
          placeItems: 'center',
          color: approved ? T.success : T.muted,
          background: approved ? 'rgba(5,150,105,.1)' : 'rgba(100,116,139,.12)',
        }}
      >
        {approved ? <Check size={15} /> : <X size={15} />}
      </span>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 13.5, color: T.fg, fontFamily: T.font, fontWeight: 500 }}>
          {item.name} <span style={{ color: T.muted, fontWeight: 400 }}>· {item.email}</span>
        </div>
        <div
          style={{
            fontSize: 12,
            color: T.muted,
            fontFamily: T.font,
            display: 'inline-flex',
            gap: 6,
            alignItems: 'center',
          }}
        >
          {item.pendingWrite ? (
            <>
              <Spinner size={12} style={{ color: T.muted }} /> Saving…
            </>
          ) : (
            `${approved ? 'Approved' : 'Declined'} by ${item.by} · ${item.when}`
          )}
        </div>
      </div>
    </div>
  );
}

/* Small skeleton row for loading states */
function SkeletonRows({ count = 3 }) {
  return (
    <div>
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 4px' }}
        >
          <div
            style={{
              width: 34,
              height: 34,
              borderRadius: 9,
              background: '#EEF1F6',
              animation: 'balo-pulse 1.3s ease-in-out infinite',
            }}
          />
          <div style={{ flex: 1 }}>
            <div
              style={{
                height: 12,
                width: '42%',
                borderRadius: 6,
                background: '#EEF1F6',
                animation: 'balo-pulse 1.3s ease-in-out infinite',
              }}
            />
            <div
              style={{
                height: 10,
                width: '62%',
                borderRadius: 6,
                marginTop: 8,
                background: '#F1F4F8',
                animation: 'balo-pulse 1.3s ease-in-out infinite',
              }}
            />
          </div>
          <div
            style={{
              width: 72,
              height: 26,
              borderRadius: 99,
              background: '#EEF1F6',
              animation: 'balo-pulse 1.3s ease-in-out infinite',
            }}
          />
        </div>
      ))}
    </div>
  );
}

function EmptyState({ icon: Icon, title, body, children }) {
  return (
    <div style={{ textAlign: 'center', padding: '26px 16px 8px' }}>
      <span
        aria-hidden
        style={{
          display: 'inline-grid',
          placeItems: 'center',
          width: 52,
          height: 52,
          borderRadius: 14,
          background: 'rgba(37,99,235,.08)',
          color: T.primary,
          marginBottom: 14,
        }}
      >
        <Icon size={24} />
      </span>
      <h3 style={{ margin: 0, fontSize: 15.5, fontWeight: 600, color: T.fg, fontFamily: T.font }}>
        {title}
      </h3>
      <p
        style={{
          margin: '6px auto 0',
          maxWidth: 380,
          fontSize: 13.5,
          color: T.muted,
          fontFamily: T.font,
          lineHeight: 1.55,
        }}
      >
        {body}
      </p>
      {children && <div style={{ marginTop: 16 }}>{children}</div>}
    </div>
  );
}

function SectionErrorState({ label, onRetry }) {
  return (
    <div style={{ textAlign: 'center', padding: '26px 16px 8px' }}>
      <span
        aria-hidden
        style={{
          display: 'inline-grid',
          placeItems: 'center',
          width: 52,
          height: 52,
          borderRadius: 14,
          background: 'rgba(220,38,38,.08)',
          color: T.destructive,
          marginBottom: 14,
        }}
      >
        <AlertTriangle size={24} />
      </span>
      <h3 style={{ margin: 0, fontSize: 15.5, fontWeight: 600, color: T.fg, fontFamily: T.font }}>
        {`We couldn't load ${label}`}
      </h3>
      <p
        style={{
          margin: '6px auto 0',
          maxWidth: 360,
          fontSize: 13.5,
          color: T.muted,
          fontFamily: T.font,
          lineHeight: 1.55,
        }}
      >
        This is usually temporary. Your settings are safe.
      </p>
      <div style={{ marginTop: 16, display: 'flex', justifyContent: 'center' }}>
        <ShimmerButton variant="secondary" fullWidth={false} onClick={onRetry}>
          <RotateCcw size={15} /> Try again
        </ShimmerButton>
      </div>
    </div>
  );
}

/* Note that makes an absence explicit (used for the agency panel). */
function InfoNote({ icon: Icon = Info, children }) {
  return (
    <div
      style={{
        display: 'flex',
        gap: 10,
        alignItems: 'flex-start',
        padding: '12px 14px',
        borderRadius: 12,
        background: 'rgba(37,99,235,.045)',
        border: `1px solid ${T.border}`,
      }}
    >
      <span style={{ color: T.primary, flex: '0 0 auto', marginTop: 1 }}>
        <Icon size={16} />
      </span>
      <p style={{ margin: 0, fontSize: 12.8, color: T.fg, fontFamily: T.font, lineHeight: 1.55 }}>
        {children}
      </p>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────
 * DOMAINS SECTION — shared by both party types (differs only in copy)
 * ──────────────────────────────────────────────────────────────────────── */
function DomainsSection({ party, partyName, dataState, index, onRetry }) {
  const [domains, setDomains] = useState(() =>
    dataState === 'empty' ? [] : SEED[party].domains.map((d) => ({ ...d }))
  );

  const emptyBody =
    party === 'company'
      ? "Add your company's email domain so teammates can join automatically."
      : "Add your agency's email domain so colleagues who sign up with it join your team automatically.";

  let body;
  if (dataState === 'loading') {
    body = <SkeletonRows count={3} />;
  } else if (dataState === 'error') {
    body = <SectionErrorState label="your domains" onRetry={onRetry} />;
  } else {
    // loaded or empty — both interactive (empty just starts with no rows)
    const seen = new Set();
    body = (
      <div>
        {domains.length === 0 ? (
          <EmptyState icon={Globe} title="No domains yet" body={emptyBody} />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {domains.map((d, i) => {
              const firstMention = !seen.has(d.by);
              seen.add(d.by);
              return (
                <div key={d.id} style={{ borderTop: i === 0 ? 'none' : `1px solid ${T.border}` }}>
                  <DomainRow
                    row={d}
                    firstMention={firstMention}
                    party={partyName}
                    isLast={domains.length === 1}
                    onRemove={(id) => setDomains((prev) => prev.filter((x) => x.id !== id))}
                  />
                </div>
              );
            })}
          </div>
        )}
        <div
          style={{
            marginTop: domains.length === 0 ? 4 : 18,
            paddingTop: 16,
            borderTop: `1px solid ${T.border}`,
          }}
        >
          <DomainInput
            existing={domains}
            party={partyName}
            onAdd={(domain) =>
              setDomains((prev) => [
                ...prev,
                { id: `new-${Date.now()}`, domain, source: 'admin', by: CURRENT_ADMIN },
              ])
            }
          />
        </div>
      </div>
    );
  }

  return (
    <SectionCard
      index={index}
      title="Domains"
      description={
        party === 'company'
          ? 'Email domains that identify your company. New signups on these can join by domain.'
          : 'Email domains that identify your agency. Anyone who signs up with one joins your team.'
      }
    >
      {body}
    </SectionCard>
  );
}

/* ─────────────────────────────────────────────────────────────────────────
 * JOIN MODE SECTION — company only
 * ──────────────────────────────────────────────────────────────────────── */
function JoinModeSection({ dataState, index, mode, setMode }) {
  const [savedNote, setSavedNote] = useState(false);
  const seed = SEED.company;

  function choose(next) {
    if (next === mode) return;
    setMode(next);
    setSavedNote(true);
    setTimeout(() => setSavedNote(false), 2600);
  }

  return (
    <SectionCard
      index={index}
      title="Join mode"
      description="How people with your domain become members. This choice is recorded in your audit log."
      headerRight={
        <span style={{ fontSize: 12, color: T.muted, fontFamily: T.font, whiteSpace: 'nowrap' }}>
          Last changed by {seed.modeChangedBy} · {seed.modeChangedOn}
        </span>
      }
    >
      {dataState === 'loading' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {Array.from({ length: 3 }).map((_, i) => (
            <div
              key={i}
              style={{
                height: 62,
                borderRadius: 12,
                background: '#F1F4F8',
                animation: 'balo-pulse 1.3s ease-in-out infinite',
              }}
            />
          ))}
        </div>
      ) : (
        <>
          <div
            role="radiogroup"
            aria-label="Join mode"
            style={{ display: 'flex', flexDirection: 'column', gap: 10 }}
          >
            <ModeOption
              id="auto"
              title="Automatic"
              isDefault
              desc="Anyone who signs up with a verified company domain joins right away."
              selected={mode === 'auto'}
              onSelect={() => choose('auto')}
            />
            <ModeOption
              id="request"
              title="Request to join"
              desc="People with your domain ask to join, and an admin approves each one below."
              selected={mode === 'request'}
              onSelect={() => choose('request')}
            />
            <ModeOption
              id="off"
              title="Off"
              desc="No one joins by domain. You add members yourself by invitation."
              selected={mode === 'off'}
              onSelect={() => choose('off')}
            />
          </div>
          {savedNote && (
            <div
              role="status"
              style={{
                marginTop: 14,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 7,
                fontSize: 13,
                color: T.success,
                fontFamily: T.font,
                fontWeight: 500,
              }}
            >
              <Check size={15} /> Saved — recorded in your audit log.
            </div>
          )}
        </>
      )}
    </SectionCard>
  );
}

/* ─────────────────────────────────────────────────────────────────────────
 * JOIN REQUEST QUEUE — company only (optimistic approve → rollback on error)
 * ──────────────────────────────────────────────────────────────────────── */
function QueueSection({ dataState, index, mode, onRetry }) {
  const [pending, setPending] = useState(() =>
    dataState === 'empty' ? [] : SEED.company.pending.map((r) => ({ ...r }))
  );
  const [resolved, setResolved] = useState(() =>
    dataState === 'empty' ? [] : SEED.company.resolved.map((r) => ({ ...r }))
  );
  const [rowError, setRowError] = useState({});
  const [showResolved, setShowResolved] = useState(false);

  function optimistic(req, outcome) {
    setRowError((e) => ({ ...e, [req.id]: null }));
    // optimistic: pull from pending, drop into resolved with a pending-write flag
    setPending((p) => p.filter((x) => x.id !== req.id));
    setResolved((r) => [
      {
        id: req.id,
        name: req.name,
        email: req.email,
        outcome,
        by: CURRENT_ADMIN,
        when: 'Just now',
        order: req.order,
        pendingWrite: true,
      },
      ...r,
    ]);
    setTimeout(() => {
      const fails = outcome === 'approved' && req.willFail; // deliberate single failure path
      if (fails) {
        // rollback: remove from resolved, restore to pending in original order, show error
        setResolved((r) => r.filter((x) => x.id !== req.id));
        setPending((p) => [...p, req].sort((a, b) => a.order - b.order));
        setRowError((e) => ({ ...e, [req.id]: true }));
      } else {
        // confirm the write
        setResolved((r) => r.map((x) => (x.id === req.id ? { ...x, pendingWrite: false } : x)));
      }
    }, 850);
  }

  let body;
  if (dataState === 'loading') {
    body = <SkeletonRows count={2} />;
  } else if (dataState === 'error') {
    body = <SectionErrorState label="join requests" onRetry={onRetry} />;
  } else {
    body = (
      <div>
        {mode !== 'request' && (pending.length > 0 || dataState === 'loaded') && (
          <div style={{ marginBottom: 14 }}>
            <InfoNote icon={Info}>
              Join mode is set to <strong>{mode === 'auto' ? 'Automatic' : 'Off'}</strong>, so new
              requests won&#39;t arrive. Any requests still waiting below need a decision.
            </InfoNote>
          </div>
        )}
        {pending.length === 0 ? (
          <EmptyState
            icon={Check}
            title="You're all caught up"
            body="No one is waiting to join right now. New requests will appear here for you to approve."
          />
        ) : (
          <div>
            {pending.map((req, i) => (
              <div key={req.id} style={{ borderTop: i === 0 ? 'none' : `1px solid ${T.border}` }}>
                <RequestRow
                  req={req}
                  error={rowError[req.id]}
                  onApprove={(r) => optimistic(r, 'approved')}
                  onDecline={(r) => optimistic(r, 'declined')}
                />
              </div>
            ))}
          </div>
        )}

        {resolved.length > 0 && (
          <div style={{ marginTop: 18, paddingTop: 14, borderTop: `1px solid ${T.border}` }}>
            <button
              type="button"
              onClick={() => setShowResolved((s) => !s)}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 7,
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                fontFamily: T.font,
                fontSize: 13,
                fontWeight: 600,
                color: T.muted,
                padding: 0,
              }}
            >
              <ChevronDown
                size={16}
                style={{
                  transform: showResolved ? 'rotate(0deg)' : 'rotate(-90deg)',
                  transition: 'transform .2s',
                }}
              />
              Resolved ({resolved.length})
            </button>
            {showResolved && (
              <div style={{ marginTop: 8 }}>
                {resolved.map((item) => (
                  <ResolvedRow key={item.id} item={item} />
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <SectionCard
      index={index}
      title="Join requests"
      description="People asking to join by domain. Approve to add them to your workspace."
      headerRight={
        dataState === 'loaded' && pending.length > 0 ? (
          <span
            style={{
              fontSize: 12,
              fontWeight: 700,
              color: T.primary,
              background: 'rgba(37,99,235,.1)',
              borderRadius: 99,
              padding: '3px 10px',
              fontFamily: T.font,
            }}
          >
            {pending.length} waiting
          </span>
        ) : null
      }
    >
      {body}
    </SectionCard>
  );
}

/* ─────────────────────────────────────────────────────────────────────────
 * PANELS
 * ──────────────────────────────────────────────────────────────────────── */
function CompanyPanel({ dataState, onRetry }) {
  const [mode, setMode] = useState(SEED.company.mode);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <DomainsSection
        party="company"
        partyName={COMPANY.name}
        dataState={dataState}
        index={0}
        onRetry={onRetry}
      />
      <JoinModeSection dataState={dataState} index={1} mode={mode} setMode={setMode} />
      <QueueSection dataState={dataState} index={2} mode={mode} onRetry={onRetry} />
    </div>
  );
}

function AgencyPanel({ dataState, onRetry }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <DomainsSection
        party="agency"
        partyName={AGENCY.name}
        dataState={dataState}
        index={0}
        onRetry={onRetry}
      />
      {/* The absence of join-mode + queue is INTENTIONAL — make it explicit. */}
      <div style={{ animation: 'balo-rise .5s ease both', animationDelay: '80ms' }}>
        <InfoNote icon={Lock}>
          Agencies don&#39;t use join modes or request approvals. Membership is decided by verified
          email (ADR&#8209;1034): sign up with an agency domain and you&#39;re in. Manage domains
          above — everything else is automatic.
        </InfoNote>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────
 * HARNESS
 * ──────────────────────────────────────────────────────────────────────── */
const PARTY_OPTIONS = [
  { value: 'company', label: 'Company', icon: Building2 },
  { value: 'agency', label: 'Agency', icon: Users },
];
const DATA_OPTIONS = ['loaded', 'loading', 'empty', 'error'];

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

export default function Prototype() {
  const [party, setParty] = useState('company');
  const [dataState, setDataState] = useState('loaded');
  const [nonce, setNonce] = useState(0);

  const partyName = party === 'company' ? COMPANY.name : AGENCY.name;
  const PartyIcon = party === 'company' ? Building2 : Users;

  // Auto-recover from the error state on "Try again": flip to loaded + remount.
  const retry = () => {
    setDataState('loaded');
    setNonce((n) => n + 1);
  };

  const panel = useMemo(
    () =>
      party === 'company' ? (
        <CompanyPanel key={`c-${dataState}-${nonce}`} dataState={dataState} onRetry={retry} />
      ) : (
        <AgencyPanel key={`a-${dataState}-${nonce}`} dataState={dataState} onRetry={retry} />
      ),
    [party, dataState, nonce] // eslint-disable-line react-hooks/exhaustive-deps
  );

  return (
    <div
      style={{
        minHeight: '100vh',
        background: T.bg,
        fontFamily: T.font,
        padding: '28px 16px 80px',
        color: T.fg,
      }}
    >
      <style>{`
        @keyframes balo-spin { to { transform: rotate(360deg); } }
        @keyframes balo-pulse { 0%,100% { opacity: 1; } 50% { opacity: .45; } }
        @keyframes balo-rise { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
        @keyframes balo-shake { 0%,100% { transform: translateX(0); } 20% { transform: translateX(-5px); } 40% { transform: translateX(5px); } 60% { transform: translateX(-3px); } 80% { transform: translateX(3px); } }
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,600;9..40,700&display=swap');
        * { box-sizing: border-box; }
        button:focus-visible, input:focus-visible { outline: 2px solid ${T.primary}; outline-offset: 2px; }
        code { font-size: 11px; padding: 1px 4px; border-radius: 4px; background: rgba(100,116,139,.12); }
        @media (prefers-reduced-motion: reduce) {
          *, *::before, *::after { animation-duration: .001ms !important; animation-iteration-count: 1 !important; transition-duration: .001ms !important; }
        }
      `}</style>

      {/* Harness controls */}
      <div
        style={{
          maxWidth: 760,
          margin: '0 auto 18px',
          background: T.surface,
          border: `1px solid ${T.border}`,
          borderRadius: 14,
          padding: 16,
          display: 'flex',
          flexWrap: 'wrap',
          gap: 18,
          alignItems: 'flex-end',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
          <span style={ctrlLabel}>Party type</span>
          <SegmentedControl
            options={PARTY_OPTIONS}
            value={party}
            onChange={(v) => {
              setParty(v);
              setNonce((n) => n + 1);
            }}
          />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 180 }}>
          <span style={ctrlLabel}>Data state (async sections)</span>
          <select
            value={dataState}
            onChange={(e) => {
              setDataState(e.target.value);
              setNonce((n) => n + 1);
            }}
            style={selStyle}
          >
            {DATA_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        <button
          onClick={() => setNonce((n) => n + 1)}
          style={{
            ...selStyle,
            cursor: 'pointer',
            fontWeight: 600,
            color: T.primary,
            borderColor: T.primary,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
          }}
        >
          <RotateCcw size={15} /> Replay
        </button>
      </div>

      <p
        style={{
          maxWidth: 760,
          margin: '0 auto 16px',
          color: T.muted,
          fontSize: 12.5,
          textAlign: 'center',
          lineHeight: 1.5,
        }}
      >
        Admin settings for domain-based join · <strong>Company</strong> = domains + mode + request
        queue (ADR&#8209;1031) · <strong>Agency</strong> = domains only, determined-by-email
        (ADR&#8209;1034) · dormant in v1
      </p>

      {/* Page header — party context + capability gate */}
      <div style={{ maxWidth: 760, margin: '0 auto 16px' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 16,
            flexWrap: 'wrap',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span
              aria-hidden
              style={{
                width: 44,
                height: 44,
                borderRadius: 12,
                display: 'grid',
                placeItems: 'center',
                color: '#fff',
                background: `linear-gradient(135deg, ${T.primary}, ${T.primaryTo})`,
              }}
            >
              <PartyIcon size={20} />
            </span>
            <div>
              <h1
                style={{
                  margin: 0,
                  fontSize: 22,
                  fontWeight: 600,
                  color: T.fg,
                  fontFamily: T.font,
                  letterSpacing: '-0.01em',
                }}
              >
                Members &amp; access
              </h1>
              <p style={{ margin: '2px 0 0', fontSize: 13, color: T.muted, fontFamily: T.font }}>
                {partyName} · {party === 'company' ? 'Company workspace' : 'Agency'}
              </p>
            </div>
          </div>
          <span
            title="You have the Manage members permission"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 7,
              padding: '7px 12px',
              borderRadius: 99,
              fontSize: 12.5,
              fontWeight: 600,
              color: T.primary,
              background: 'rgba(37,99,235,.08)',
              border: '1px solid rgba(37,99,235,.18)',
              fontFamily: T.font,
            }}
          >
            <ShieldCheck size={15} /> Admin · Manage members
          </span>
        </div>
        <p style={{ margin: '10px 0 0', fontSize: 12, color: T.muted, fontFamily: T.font }}>
          Only owners and admins with the Manage members permission can see this page.
        </p>
      </div>

      <div style={{ maxWidth: 760, margin: '0 auto' }}>{panel}</div>
    </div>
  );
}
