'use client';

/**
 * DESIGN REFERENCE — Party domains: customers read, Balo staff manage (BAL-594)
 * ---------------------------------------------------------------------------
 * Source of truth for CC. Self-mocks its data and actions so every state renders
 * standalone. Supersedes the DOMAINS section of domain-join-admin.jsx (BAL-347);
 * that file stays the reference for the company JOIN MODE and JOIN REQUESTS
 * sections, which this ticket does not touch.
 *
 * THE RULE (ADR-1031, edited 2026-10-12): a domain enters `party_domains` only by
 * verified-email capture at party creation, or by Balo staff. Company and agency
 * admins see their domains read-only. A typed-in domain proves no inbox control.
 *
 * FIVE SURFACES (harness switcher at the top — REVIEW AFFORDANCE ONLY, remove in
 * implementation):
 *   1. Company settings  — Domains card read-only. Join mode + Join requests render
 *                          exactly as domain-join-admin.jsx (shown here as stubs).
 *   2. Agency settings   — Expert Settings › Domains tab, read-only. The old lock
 *                          note (cited ADR-1034, explained company-only concepts) is gone.
 *   3. Solo expert       — NO Domains tab. A party with no active domains hides the
 *                          section (agencies: the whole tab). ADR-1034: never say
 *                          "agency" to a solo expert.
 *   4. Lookup drill-in   — company/agency drill-in gains a "Domains" link in the header's
 *                          right slot (beside Open / Application — the BAL-593 precedent).
 *   5. Staff domains page — add, remove, reassign, each with a required reason note.
 *
 * ⚠ DEVIATION FROM THE BAL-594 TEXT (needs the ticket updated): the ticket says "Domains
 * panel on the company and agency drill-ins in Lookup". The drill-in is READ-ONLY by
 * contract — lookup-drill-in.tsx: "NOTHING here mutates: no forms, no `action=`, no
 * write-shaped button". So the writes live on their own staff page and the drill-in only
 * links to it, exactly as BAL-593 did for application edits. Suggested route:
 * `/admin/domains/[partyType]/[partyId]`. Page gate: VIEW_PLATFORM_ADMIN (same as Lookup).
 * Write controls render only with the new MANAGE_PARTY_DOMAINS token, and every Server
 * Action re-checks it live. Harness toggle "Can manage domains" shows the read-only view.
 *
 * COPY CONVENTIONS
 *   - Gender-neutral. Sentence case. Typographic apostrophes in rendered copy.
 *   - Retrospective attribution names the person with "@ {party}" on first mention.
 *   - Customers never see staff names or reason notes: staff-added rows say "Added by Balo".
 *   - Staff see who did it, when, and the reason note.
 *   - One emphasized action per surface: solid --primary (settings/admin surfaces never use
 *     the marketing gradient). Remove is a destructive ghost; its confirm is destructive solid.
 *
 * STATES: harness "Data" control drives loading / error / loaded on the domain lists.
 * The add form is live: try acme.co.nz (owned by a company), globex.com (owned by an
 * agency), gmail.com (blocked), northwind.com (already on Northwind), anything else adds.
 *
 * NOTIFICATIONS (BAL-594): add / remove / reassign → owners + admins of each affected party,
 * in-app + email, no SMS. The page says who will be told before the button is pressed.
 * ANALYTICS: party_domain_added / party_domain_removed (source admin_added, partyType),
 * party_domain_reassigned (fromPartyType, toPartyType) — server-side.
 *
 * TOKENS: hexes are stand-ins; real tokens are OKLCH in globals.css. Font is Geist (the
 * repo is authoritative). Icons: lucide-react.
 */

import React, { useState, useRef } from 'react';
import {
  Building2,
  Users,
  Globe,
  Plus,
  Trash2,
  Check,
  AlertTriangle,
  RotateCcw,
  Info,
  ChevronLeft,
  User,
  DollarSign,
  Calendar,
  CreditCard,
  CircleCheck,
  ArrowRightLeft,
  Lock,
  Clock,
} from 'lucide-react';

/* ── Token shim ───────────────────────────────────────────────────────────── */
const T = {
  bg: '#F8FAFB',
  surface: '#FFFFFF',
  subtle: '#F6F8FB',
  track: '#EEF1F6',
  border: '#E0E4EB',
  borderSoft: '#EAEFF5',
  fg: '#0F1729',
  muted: '#64748B',
  faint: '#94A3B8',
  primary: '#2563EB',
  primarySoft: 'rgba(37,99,235,.08)',
  primaryLine: 'rgba(37,99,235,.22)',
  success: '#059669',
  successSoft: 'rgba(5,150,105,.08)',
  destructive: '#DC2626',
  destructiveSoft: 'rgba(220,38,38,.05)',
  destructiveLine: 'rgba(220,38,38,.25)',
  warning: '#B45309',
  warningBg: '#FFFBEB',
  warningLine: '#FCD9A0',
  font: "'Geist', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif",
};

/* ── Mock data (gender-neutral names) ─────────────────────────────────────── */
const STAFF_VIEWER = 'Morgan Lee'; // the Balo staff member using the staff page

const PARTIES = {
  company: {
    type: 'company',
    name: 'Northwind',
    members: 12,
    domains: [
      { id: 'n1', domain: 'northwind.com', source: 'auto', by: 'Jordan Ellis', on: '2 Jul 2026' },
      {
        id: 'n2',
        domain: 'northwind.co.nz',
        source: 'staff',
        by: 'Riley Chen',
        on: '3 Oct 2026',
        reason:
          'Jordan Ellis asked by email on 2 Oct to add the NZ office. Confirmed from a northwind.co.nz address.',
      },
    ],
  },
  agency: {
    type: 'agency',
    name: 'Lattice Consulting',
    members: 6,
    domains: [
      {
        id: 'l1',
        domain: 'latticeconsulting.com',
        source: 'auto',
        by: 'Sam Okafor',
        on: '18 Aug 2026',
      },
      {
        id: 'l2',
        domain: 'lattice.co.nz',
        source: 'staff',
        by: 'Riley Chen',
        on: '1 Oct 2026',
        reason:
          'Sam Okafor (owner) asked on a support call for the NZ team. Confirmed from a lattice.co.nz address.',
      },
    ],
  },
};

/* Domains owned by OTHER parties — staff may see who owns them (customers never do). */
const OTHER_OWNERS = {
  'acme.co.nz': {
    name: 'Acme NZ',
    type: 'company',
    members: 4,
    by: 'Taylor Brooks',
    on: '12 Aug 2026',
  },
  'globex.com': {
    name: 'Globex Partners',
    type: 'agency',
    members: 1,
    by: 'Avery Moss',
    on: '30 Sep 2026',
  },
};

const BLOCKED = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'yahoo.com',
  'icloud.com',
  'me.com',
  'proton.me',
  'protonmail.com',
  'aol.com',
]);

/* ── Primitives ───────────────────────────────────────────────────────────── */
function Spinner({ size = 15 }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      style={{ animation: 'pd-spin .8s linear infinite' }}
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity=".25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

const BUTTON_VARIANTS = {
  primary: { background: T.primary, color: '#fff', border: `1px solid ${T.primary}` },
  secondary: { background: T.surface, color: T.fg, border: `1px solid ${T.border}` },
  ghost: { background: 'transparent', color: T.muted, border: '1px solid transparent' },
  ghostDestructive: {
    background: 'transparent',
    color: T.destructive,
    border: '1px solid transparent',
  },
  destructive: { background: T.destructive, color: '#fff', border: `1px solid ${T.destructive}` },
};

function Button({ children, onClick, disabled, variant = 'primary', type = 'button' }) {
  const compact = variant === 'ghost' || variant === 'ghostDestructive';
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      style={{
        minHeight: 40,
        padding: compact ? '0 10px' : '0 16px',
        borderRadius: 10,
        fontFamily: T.font,
        fontSize: 13.5,
        fontWeight: 600,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 7,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.6 : 1,
        whiteSpace: 'nowrap',
        ...BUTTON_VARIANTS[variant],
      }}
    >
      {children}
    </button>
  );
}

function FieldError({ id, children }) {
  return (
    <p
      id={id}
      role="alert"
      style={{
        margin: '7px 0 0',
        fontSize: 12.5,
        lineHeight: 1.5,
        color: T.destructive,
        display: 'flex',
        gap: 6,
        alignItems: 'flex-start',
      }}
    >
      <AlertTriangle size={14} style={{ flex: '0 0 auto', marginTop: 2 }} aria-hidden="true" />
      <span>{children}</span>
    </p>
  );
}

function StatusLine({ children }) {
  if (!children) return null;
  return (
    <p
      style={{
        margin: 0,
        fontSize: 13,
        fontWeight: 500,
        color: T.success,
        display: 'flex',
        alignItems: 'flex-start',
        gap: 7,
        lineHeight: 1.5,
      }}
    >
      <Check size={15} style={{ flex: '0 0 auto', marginTop: 2 }} aria-hidden="true" />
      <span>{children}</span>
    </p>
  );
}

function Card({ children, dashed = false, style }) {
  return (
    <section
      style={{
        background: dashed ? 'transparent' : T.surface,
        border: `1px ${dashed ? 'dashed' : 'solid'} ${T.border}`,
        borderRadius: 16,
        padding: '22px 24px',
        boxShadow: dashed ? 'none' : '0 1px 2px rgba(15,23,41,.04)',
        animation: 'pd-rise .35s ease both',
        ...style,
      }}
    >
      {children}
    </section>
  );
}

function CardHeader({ title, description, right }) {
  return (
    <header
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: 16,
        marginBottom: 14,
      }}
    >
      <div style={{ minWidth: 0 }}>
        <h2
          style={{
            margin: 0,
            fontSize: 16,
            fontWeight: 600,
            color: T.fg,
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
              lineHeight: 1.55,
              maxWidth: 560,
            }}
          >
            {description}
          </p>
        )}
      </div>
      {right}
    </header>
  );
}

function DomainTile() {
  return (
    <span
      aria-hidden="true"
      style={{
        flex: '0 0 auto',
        width: 34,
        height: 34,
        borderRadius: 9,
        display: 'grid',
        placeItems: 'center',
        background: T.primarySoft,
        color: T.primary,
      }}
    >
      <Globe size={16} />
    </span>
  );
}

function SkeletonRows({ count = 2 }) {
  const bar = (w, h, bg) => ({
    height: h,
    width: w,
    borderRadius: 6,
    background: bg,
    animation: 'pd-pulse 1.3s ease-in-out infinite',
  });
  return (
    <div aria-busy="true" aria-label="Loading domains">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 0' }}>
          <div style={{ ...bar(34, 34, T.track), borderRadius: 9 }} />
          <div style={{ flex: 1 }}>
            <div style={bar('38%', 12, T.track)} />
            <div style={{ ...bar('64%', 10, '#F1F4F8'), marginTop: 8 }} />
          </div>
        </div>
      ))}
    </div>
  );
}

function SectionError({ what, onRetry }) {
  return (
    <div style={{ padding: '18px 0 6px' }}>
      <p
        style={{
          margin: 0,
          fontSize: 14,
          fontWeight: 600,
          color: T.fg,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <AlertTriangle size={16} color={T.destructive} aria-hidden="true" />
        {`Couldn’t load ${what}`}
      </p>
      <p style={{ margin: '4px 0 12px', fontSize: 13, color: T.muted }}>
        Nothing has changed. Try again in a moment.
      </p>
      <Button variant="secondary" onClick={onRetry}>
        <RotateCcw size={15} aria-hidden="true" /> Try again
      </Button>
    </div>
  );
}

function InfoNote({ icon: Icon = Info, tone = 'info', children }) {
  const isWarn = tone === 'warning';
  return (
    <div
      style={{
        display: 'flex',
        gap: 10,
        alignItems: 'flex-start',
        padding: '12px 14px',
        borderRadius: 12,
        background: isWarn ? T.warningBg : 'rgba(37,99,235,.045)',
        border: `1px solid ${isWarn ? T.warningLine : T.border}`,
      }}
    >
      <span style={{ color: isWarn ? T.warning : T.primary, flex: '0 0 auto', marginTop: 1 }}>
        <Icon size={16} aria-hidden="true" />
      </span>
      <div style={{ fontSize: 13, color: T.fg, lineHeight: 1.55, minWidth: 0 }}>{children}</div>
    </div>
  );
}

/* Review-only annotation. Never ships. */
function DesignNote({ children }) {
  return (
    <aside
      style={{
        padding: '10px 14px',
        borderRadius: 10,
        border: '1px dashed #E0A458',
        background: 'rgba(253,230,138,.18)',
        fontSize: 12.5,
        lineHeight: 1.55,
        color: '#7C4A12',
      }}
    >
      <strong style={{ fontWeight: 600 }}>Design note. </strong>
      {children}
    </aside>
  );
}

function TypePill({ type }) {
  const Icon = type === 'company' ? Building2 : Users;
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding: '2px 9px',
        borderRadius: 99,
        fontSize: 12,
        fontWeight: 600,
        color: T.muted,
        background: 'rgba(100,116,139,.1)',
        border: '1px solid rgba(100,116,139,.18)',
        whiteSpace: 'nowrap',
      }}
    >
      <Icon size={12} aria-hidden="true" />
      {type === 'company' ? 'Company' : 'Agency'}
    </span>
  );
}

const linkStyle = {
  color: T.primary,
  fontWeight: 600,
  textDecoration: 'none',
  borderBottom: `1px solid ${T.primaryLine}`,
};

const fieldLabel = {
  display: 'block',
  fontSize: 13,
  fontWeight: 600,
  color: T.fg,
  marginBottom: 6,
};

function inputStyle(hasError) {
  return {
    width: '100%',
    minHeight: 42,
    padding: '9px 13px',
    borderRadius: 10,
    border: `1px solid ${hasError ? 'rgba(220,38,38,.55)' : T.border}`,
    boxShadow: hasError ? '0 0 0 3px rgba(220,38,38,.1)' : 'none',
    background: T.surface,
    color: T.fg,
    fontSize: 14,
    fontFamily: T.font,
    lineHeight: 1.5,
    outline: 'none',
  };
}

/* ═════════════════════════════════════════════════════════════════════════
 * CUSTOMER SIDE — read-only
 * ════════════════════════════════════════════════════════════════════════ */

function customerAttribution(row, partyName, firstMention) {
  if (row.source === 'auto') {
    return `Added automatically when ${row.by}${firstMention ? ` @ ${partyName}` : ''} signed up`;
  }
  return 'Added by Balo'; // staff names and reason notes never reach customers
}

function CustomerDomainsCard({ party, dataState, onRetry }) {
  const description =
    party.type === 'company'
      ? 'Email domains that identify your company. Teammates who sign up with a verified email on one of these can join, based on your join setting below.'
      : 'Email domains that identify your agency. Anyone who signs up with a verified email on one of these joins your team automatically.';

  let body;
  if (dataState === 'loading') {
    body = <SkeletonRows count={party.domains.length} />;
  } else if (dataState === 'error') {
    body = <SectionError what="your domains" onRetry={onRetry} />;
  } else {
    const seen = new Set();
    body = (
      <>
        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {party.domains.map((row, i) => {
            const firstMention = row.source === 'auto' && !seen.has(row.by);
            if (row.source === 'auto') seen.add(row.by);
            return (
              <li
                key={row.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  padding: '12px 0',
                  borderTop: i === 0 ? 'none' : `1px solid ${T.borderSoft}`,
                }}
              >
                <DomainTile />
                <div style={{ minWidth: 0 }}>
                  <div
                    style={{
                      fontSize: 14.5,
                      fontWeight: 600,
                      color: T.fg,
                      overflowWrap: 'anywhere',
                    }}
                  >
                    {row.domain}
                  </div>
                  <div style={{ fontSize: 12.5, color: T.muted, marginTop: 2 }}>
                    {customerAttribution(row, party.name, firstMention)}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
        <p
          style={{
            margin: '6px 0 0',
            paddingTop: 14,
            borderTop: `1px solid ${T.borderSoft}`,
            fontSize: 13,
            color: T.muted,
            lineHeight: 1.55,
          }}
        >
          Using more than one domain?{' '}
          <a href="mailto:support@balo.expert" style={linkStyle}>
            Contact Balo support
          </a>{' '}
          and we’ll add it for you.
        </p>
      </>
    );
  }

  return (
    <Card>
      <CardHeader title="Domains" description={description} />
      {body}
    </Card>
  );
}

function StubCard({ title, children }) {
  return (
    <Card dashed>
      <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600, color: T.muted }}>{title}</h2>
      <p style={{ margin: '4px 0 0', fontSize: 12.5, color: T.faint, lineHeight: 1.5 }}>
        {children}
      </p>
    </Card>
  );
}

function AppearingInSearch() {
  return (
    <p
      style={{
        margin: '0 0 18px',
        fontSize: 13.5,
        fontWeight: 500,
        color: '#15803D',
        display: 'flex',
        alignItems: 'center',
        gap: 7,
      }}
    >
      <CircleCheck size={16} aria-hidden="true" /> You’re appearing in search.
    </p>
  );
}

const EXPERT_TABS = [
  { key: 'profile', label: 'Profile', icon: User },
  { key: 'rate', label: 'Rate', icon: DollarSign },
  { key: 'schedule', label: 'Schedule', icon: Calendar },
  { key: 'payouts', label: 'Payouts', icon: CreditCard },
  { key: 'domains', label: 'Domains', icon: Globe },
];

function ExpertSettingsTabs({ showDomains, active }) {
  const tabs = showDomains ? EXPERT_TABS : EXPERT_TABS.filter((t) => t.key !== 'domains');
  return (
    <div
      role="tablist"
      aria-label="Expert settings"
      style={{
        display: 'inline-flex',
        flexWrap: 'wrap',
        gap: 4,
        padding: 4,
        borderRadius: 12,
        background: T.track,
        marginBottom: 22,
      }}
    >
      {tabs.map((t) => {
        const isActive = t.key === active;
        const Icon = t.icon;
        return (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={isActive}
            tabIndex={isActive ? 0 : -1}
            style={{
              minHeight: 40,
              padding: '0 14px',
              borderRadius: 9,
              border: 'none',
              fontFamily: T.font,
              fontSize: 13.5,
              fontWeight: isActive ? 600 : 500,
              color: isActive ? T.fg : T.muted,
              background: isActive ? T.surface : 'transparent',
              boxShadow: isActive
                ? '0 1px 2px rgba(15,23,41,.08), 0 2px 6px rgba(15,23,41,.05)'
                : 'none',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 7,
              cursor: 'default',
            }}
          >
            <Icon size={15} color={isActive ? T.primary : T.faint} aria-hidden="true" />
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

function CompanySettingsView({ dataState, onRetry }) {
  const party = PARTIES.company;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ marginBottom: 4 }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600, letterSpacing: '-0.01em' }}>
          Members &amp; access
        </h1>
        <p style={{ margin: '3px 0 0', fontSize: 13.5, color: T.muted }}>{party.name}</p>
      </div>
      <CustomerDomainsCard party={party} dataState={dataState} onRetry={onRetry} />
      <StubCard title="Join mode">Unchanged. Build from domain-join-admin.jsx (BAL-347).</StubCard>
      <StubCard title="Join requests">
        Unchanged. Build from domain-join-admin.jsx (BAL-347).
      </StubCard>
      <DesignNote>
        No add field, no Remove, no badge. The two sources read differently: the signup row names
        the person who signed up, the Balo row names no one. If the company has no active domains,
        the Domains card is not rendered at all.
      </DesignNote>
    </div>
  );
}

function AgencySettingsView({ dataState, onRetry }) {
  return (
    <div>
      <AppearingInSearch />
      <ExpertSettingsTabs showDomains active="domains" />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <CustomerDomainsCard party={PARTIES.agency} dataState={dataState} onRetry={onRetry} />
        <DesignNote>
          The lock note that used to sit under this card is deleted: it cited ADR-1034 and explained
          join modes and request approvals, which agency members never see. The card’s description
          now carries the one fact that matters.
        </DesignNote>
      </div>
    </div>
  );
}

function SoloExpertView() {
  return (
    <div>
      <AppearingInSearch />
      <ExpertSettingsTabs showDomains={false} active="profile" />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <StubCard title="Profile">Profile tab content, unchanged.</StubCard>
        <DesignNote>
          No Domains tab. This expert works independently: a freemail signup provisions a solo
          agency and never captures a domain, so the tab could only ever be empty, and it would say
          “agency” to someone who isn’t one. Rule: render the Domains tab only when the expert’s
          agency has at least one active domain.
        </DesignNote>
      </div>
    </div>
  );
}

/* ═════════════════════════════════════════════════════════════════════════
 * STAFF SIDE — Lookup drill-in link + the staff domains page
 * ════════════════════════════════════════════════════════════════════════ */

function DrillInMock({ partyKey, onOpenDomains }) {
  const party = PARTIES[partyKey];
  const staffRow = party.domains.find((d) => d.source === 'staff');
  const events = [
    {
      what: 'Domain added',
      detail: `${staffRow.domain}, by ${staffRow.by}`,
      when: staffRow.on,
    },
    {
      what: 'Member joined by domain',
      detail: partyKey === 'company' ? 'Casey Park' : 'Drew Hollis',
      when: '14 Sep 2026',
    },
    {
      what: partyKey === 'company' ? 'Company created' : 'Agency created',
      detail: `by ${party.domains[0].by}`,
      when: party.domains[0].on,
    },
  ];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div
        style={{
          background: T.surface,
          border: `1px solid ${T.border}`,
          borderRadius: 16,
          overflow: 'hidden',
          animation: 'pd-rise .35s ease both',
        }}
      >
        <div style={{ padding: 16, borderBottom: `1px solid ${T.borderSoft}` }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              justifyContent: 'space-between',
              gap: 12,
            }}
          >
            <div style={{ minWidth: 0 }}>
              {/* Existing drill-in eyebrow, kept as shipped (BAL-551). */}
              <p
                style={{
                  margin: 0,
                  fontSize: 11,
                  fontWeight: 700,
                  letterSpacing: '.04em',
                  textTransform: 'uppercase',
                  color: T.muted,
                }}
              >
                {partyKey === 'company' ? 'Company' : 'Agency'}
              </p>
              <p style={{ margin: '2px 0 0', fontSize: 14.5, fontWeight: 600 }}>{party.name}</p>
            </div>
            {/* NEW — header right slot, same style as Open / Application (BAL-593). */}
            <button
              type="button"
              onClick={onOpenDomains}
              style={{
                minHeight: 44,
                padding: '0 4px',
                border: 'none',
                background: 'transparent',
                color: T.primary,
                fontFamily: T.font,
                fontSize: 12.5,
                fontWeight: 600,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                cursor: 'pointer',
              }}
            >
              <Globe size={14} aria-hidden="true" /> Domains
            </button>
          </div>
          <p style={{ margin: '8px 0 0', fontSize: 12, color: T.muted }}>
            {`There’s no ${partyKey} page yet — what Balo has is above.`}
          </p>
        </div>
        <div style={{ padding: 16 }}>
          <p style={{ margin: 0, fontSize: 12, color: T.muted }}>{`${party.members} members`}</p>
          <h3 style={{ margin: '14px 0 8px', fontSize: 13, fontWeight: 600 }}>Timeline</h3>
          <ol style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {events.map((e, i) => (
              <li
                key={e.what}
                style={{
                  display: 'flex',
                  gap: 10,
                  padding: '9px 0',
                  borderTop: i === 0 ? 'none' : `1px solid ${T.borderSoft}`,
                }}
              >
                <Clock size={14} color={T.faint} style={{ marginTop: 2 }} aria-hidden="true" />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 500 }}>{e.what}</div>
                  <div style={{ fontSize: 12, color: T.muted }}>{e.detail}</div>
                </div>
                <span style={{ fontSize: 12, color: T.faint, whiteSpace: 'nowrap' }}>{e.when}</span>
              </li>
            ))}
          </ol>
        </div>
      </div>
      <DesignNote>
        The drill-in stays read-only. The new Domains link sits in the header’s right slot (where
        Open and Application already live) and goes to the staff domains page. Domain changes
        already show up in this Timeline, because each one writes an audit_events row with the
        reason note in its metadata.
      </DesignNote>
    </div>
  );
}

/* Shared normaliser: forgiving on paste, always lowercase. */
function normalizeDomain(input) {
  return input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/^.*@/, '')
    .replace(/[/?#].*$/, '');
}

const DOMAIN_FORMAT = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

function checkDomain(domain, party, existing) {
  if (!domain) return { error: 'Enter a domain to add.' };
  if (!DOMAIN_FORMAT.test(domain)) {
    return { error: 'Enter a domain like acme.co.nz, without https:// or @.' };
  }
  if (BLOCKED.has(domain)) {
    return {
      error: `${domain} is a personal email provider, so it can’t identify a company or agency.`,
    };
  }
  if (existing.some((d) => d.domain === domain)) {
    return { error: `${domain} is already on ${party.name}.` };
  }
  if (OTHER_OWNERS[domain]) return { owner: OTHER_OWNERS[domain] };
  return { ok: true };
}

function ReasonField({ id, value, onChange, error, autoFocus }) {
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;
  return (
    <div>
      <label htmlFor={id} style={fieldLabel}>
        Reason
      </label>
      <textarea
        id={id}
        rows={2}
        value={value}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Who asked, and how you confirmed they own it"
        aria-invalid={Boolean(error)}
        aria-describedby={error ? `${hintId} ${errorId}` : hintId}
        style={{ ...inputStyle(Boolean(error)), resize: 'vertical' }}
      />
      <p id={hintId} style={{ margin: '5px 0 0', fontSize: 12, color: T.muted }}>
        Saved to the audit log with your name. Customers never see it.
      </p>
      {error && <FieldError id={errorId}>{error}</FieldError>}
    </div>
  );
}

function StaffDomainRow({ row, party, first, firstMention, canManage, isLast, onRemove }) {
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState(null);
  const [busy, setBusy] = useState(false);

  const isAuto = row.source === 'auto';
  const meta = isAuto
    ? `Captured when ${row.by}${firstMention ? ` @ ${party.name}` : ''} signed up on ${row.on}`
    : `Added by ${row.by} on ${row.on}`;

  function confirmRemove() {
    if (!reason.trim()) {
      setReasonError('Add a reason so the audit log shows why this changed.');
      return;
    }
    setBusy(true);
    setTimeout(() => onRemove(row, reason.trim()), 500);
  }

  return (
    <li style={{ padding: '12px 0', borderTop: first ? 'none' : `1px solid ${T.borderSoft}` }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <DomainTile />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 14.5, fontWeight: 600, overflowWrap: 'anywhere' }}>
              {row.domain}
            </span>
            <span
              style={{
                fontSize: 11.5,
                fontWeight: 600,
                padding: '2px 8px',
                borderRadius: 99,
                color: isAuto ? T.primary : T.muted,
                background: isAuto ? T.primarySoft : 'rgba(100,116,139,.1)',
              }}
            >
              {isAuto ? 'From signup' : 'Added by Balo'}
            </span>
          </div>
          <div style={{ fontSize: 12.5, color: T.muted, marginTop: 3 }}>{meta}</div>
          {row.reason && (
            <p
              style={{
                margin: '6px 0 0',
                padding: '6px 10px',
                borderLeft: `2px solid ${T.border}`,
                fontSize: 12.5,
                lineHeight: 1.5,
                color: T.fg,
                background: T.subtle,
                borderRadius: '0 6px 6px 0',
              }}
            >
              {row.reason}
            </p>
          )}
        </div>
        {canManage && !confirming && (
          <Button variant="ghostDestructive" onClick={() => setConfirming(true)}>
            <Trash2 size={14} aria-hidden="true" /> Remove
          </Button>
        )}
      </div>

      {confirming && (
        <div
          style={{
            marginTop: 12,
            marginLeft: 46,
            padding: '14px 16px',
            borderRadius: 12,
            background: T.destructiveSoft,
            border: `1px solid ${T.destructiveLine}`,
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
          }}
        >
          <div>
            <p style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>
              {`Remove ${row.domain} from ${party.name}?`}
            </p>
            <p style={{ margin: '4px 0 0', fontSize: 13, color: T.muted, lineHeight: 1.55 }}>
              {isLast
                ? `This is ${party.name}’s last domain. After this, no one joins ${party.name} by email domain.`
                : `New signups with a ${row.domain} email won’t join ${party.name}. People already in ${party.name} stay.`}
            </p>
          </div>
          <ReasonField
            id={`remove-reason-${row.id}`}
            value={reason}
            autoFocus
            onChange={(v) => {
              setReason(v);
              if (reasonError) setReasonError(null);
            }}
            error={reasonError}
          />
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 12,
              flexWrap: 'wrap',
            }}
          >
            <span style={{ fontSize: 12.5, color: T.muted }}>
              {`Owners and admins of ${party.name} will be notified.`}
            </span>
            <div style={{ display: 'flex', gap: 6 }}>
              <Button variant="ghost" onClick={() => setConfirming(false)} disabled={busy}>
                Keep
              </Button>
              <Button variant="destructive" onClick={confirmRemove} disabled={busy}>
                {busy ? <Spinner /> : <Trash2 size={14} aria-hidden="true" />}
                Remove domain
              </Button>
            </div>
          </div>
        </div>
      )}
    </li>
  );
}

function ConflictPanel({ domain, owner, party }) {
  const article = owner.type === 'company' ? 'a company' : 'an agency';
  const people = `${owner.members} ${owner.members === 1 ? 'member' : 'members'}`;
  return (
    <InfoNote icon={AlertTriangle} tone="warning">
      <p style={{ margin: 0, fontWeight: 600 }}>{`${domain} belongs to ${owner.name}`}</p>
      <p style={{ margin: '4px 0 0' }}>
        {`${owner.name} is ${article} with ${people}. The domain was captured when ${owner.by} @ ${owner.name} signed up on ${owner.on}.`}
      </p>
      <p style={{ margin: '6px 0 0' }}>
        {`Reassigning moves the domain, not the people. New signups with a ${domain} email will join ${party.name}; everyone already in ${owner.name} stays where they are.`}
      </p>
      <p style={{ margin: '8px 0 0' }}>
        <a href="#lookup" onClick={(e) => e.preventDefault()} style={linkStyle}>
          {`View ${owner.name} in Lookup`}
        </a>
      </p>
    </InfoNote>
  );
}

function AddDomainForm({ party, existing, onAdd }) {
  const [value, setValue] = useState('');
  const [reason, setReason] = useState('');
  const [domainError, setDomainError] = useState(null);
  const [reasonError, setReasonError] = useState(null);
  const [conflict, setConflict] = useState(null); // { domain, owner }
  const [busy, setBusy] = useState(false);
  const inputRef = useRef(null);

  function reset() {
    setValue('');
    setReason('');
    setConflict(null);
    setDomainError(null);
    setReasonError(null);
  }

  function submit(e) {
    e.preventDefault();
    const domain = normalizeDomain(value);
    const result = checkDomain(domain, party, existing);
    if (result.error) {
      setDomainError(result.error);
      setConflict(null);
      return;
    }
    if (result.owner && !conflict) {
      // First press surfaces the conflict; the button turns into Reassign.
      setConflict({ domain, owner: result.owner });
      return;
    }
    if (!reason.trim()) {
      setReasonError('Add a reason so the audit log shows why this changed.');
      return;
    }
    setBusy(true);
    setTimeout(() => {
      onAdd(domain, reason.trim(), conflict ? conflict.owner : null);
      setBusy(false);
      reset();
      if (inputRef.current) inputRef.current.focus();
    }, 650);
  }

  const notified = conflict
    ? `Owners and admins of ${conflict.owner.name} and ${party.name} will be notified.`
    : `Owners and admins of ${party.name} get an email and an in-app notice.`;

  return (
    <form
      onSubmit={submit}
      noValidate
      style={{ display: 'flex', flexDirection: 'column', gap: 16 }}
    >
      <div>
        <label htmlFor="staff-add-domain" style={fieldLabel}>
          Domain
        </label>
        <input
          id="staff-add-domain"
          ref={inputRef}
          value={value}
          placeholder="acme.co.nz"
          spellCheck={false}
          autoCapitalize="none"
          autoComplete="off"
          aria-invalid={Boolean(domainError)}
          aria-describedby={domainError ? 'staff-add-domain-error' : 'staff-add-domain-demo'}
          onChange={(e) => {
            setValue(e.target.value.toLowerCase());
            if (domainError) setDomainError(null);
            if (conflict) setConflict(null);
          }}
          style={inputStyle(Boolean(domainError))}
        />
        {domainError ? (
          <FieldError id="staff-add-domain-error">{domainError}</FieldError>
        ) : (
          <p
            id="staff-add-domain-demo"
            style={{ margin: '5px 0 0', fontSize: 11.5, color: T.faint }}
          >
            Demo only: acme.co.nz (owned by a company), globex.com (owned by an agency), gmail.com
            (blocked), anything else adds.
          </p>
        )}
      </div>

      {conflict && <ConflictPanel domain={conflict.domain} owner={conflict.owner} party={party} />}

      <ReasonField
        id="staff-add-reason"
        value={reason}
        onChange={(v) => {
          setReason(v);
          if (reasonError) setReasonError(null);
        }}
        error={reasonError}
      />

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          flexWrap: 'wrap',
        }}
      >
        <span style={{ fontSize: 12.5, color: T.muted }}>{notified}</span>
        <div style={{ display: 'flex', gap: 6 }}>
          {conflict && (
            <Button variant="ghost" onClick={() => setConflict(null)} disabled={busy}>
              Cancel
            </Button>
          )}
          {/* The one emphasized action on this page. */}
          <Button type="submit" variant="primary" disabled={busy}>
            {busy && <Spinner />}
            {!busy &&
              (conflict ? (
                <ArrowRightLeft size={15} aria-hidden="true" />
              ) : (
                <Plus size={15} aria-hidden="true" />
              ))}
            {conflict ? `Reassign to ${party.name}` : 'Add domain'}
          </Button>
        </div>
      </div>
    </form>
  );
}

function StaffDomainsPage({ partyKey, canManage, dataState, onRetry, onBack }) {
  const party = PARTIES[partyKey];
  const [domains, setDomains] = useState(() => party.domains.map((d) => ({ ...d })));
  const [status, setStatus] = useState(null);
  const PartyIcon = party.type === 'company' ? Building2 : Users;

  function handleRemove(row) {
    setDomains((prev) => prev.filter((d) => d.id !== row.id));
    setStatus(`${row.domain} removed from ${party.name}. Owners and admins have been notified.`);
  }

  function handleAdd(domain, reason, fromOwner) {
    setDomains((prev) => [
      ...prev,
      {
        id: `new-${Date.now()}`,
        domain,
        source: 'staff',
        by: `${STAFF_VIEWER} (you)`,
        on: 'today',
        reason,
      },
    ]);
    setStatus(
      fromOwner
        ? `${domain} moved from ${fromOwner.name} to ${party.name}. Owners and admins of both have been notified.`
        : `${domain} added to ${party.name}. Owners and admins have been notified.`
    );
  }

  const listDescription =
    party.type === 'company'
      ? `New signups with a verified email on one of these can join ${party.name}, based on its join setting.`
      : `New signups with a verified email on one of these join ${party.name} automatically.`;

  let list;
  if (dataState === 'loading') {
    list = <SkeletonRows count={2} />;
  } else if (dataState === 'error') {
    list = <SectionError what={`${party.name}’s domains`} onRetry={onRetry} />;
  } else if (domains.length === 0) {
    list = (
      <p style={{ margin: 0, fontSize: 13.5, color: T.muted, lineHeight: 1.55 }}>
        {`${party.name} has no domains, so no one joins it by email domain.`}
        {canManage ? ' Add one below if the customer asked for it.' : ''}
      </p>
    );
  } else {
    const seen = new Set();
    list = (
      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {domains.map((row, i) => {
          const firstMention = !seen.has(row.by);
          seen.add(row.by);
          return (
            <StaffDomainRow
              key={row.id}
              row={row}
              party={party}
              first={i === 0}
              firstMention={firstMention}
              canManage={canManage}
              isLast={domains.length === 1}
              onRemove={handleRemove}
            />
          );
        })}
      </ul>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <button
        type="button"
        onClick={onBack}
        style={{
          alignSelf: 'flex-start',
          minHeight: 36,
          padding: '0 6px 0 2px',
          border: 'none',
          background: 'transparent',
          color: T.muted,
          fontFamily: T.font,
          fontSize: 13,
          fontWeight: 500,
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          cursor: 'pointer',
        }}
      >
        <ChevronLeft size={16} aria-hidden="true" /> Back to Lookup
      </button>

      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <span
          aria-hidden="true"
          style={{
            width: 44,
            height: 44,
            borderRadius: 12,
            display: 'grid',
            placeItems: 'center',
            background: T.primarySoft,
            color: T.primary,
            flex: '0 0 auto',
          }}
        >
          <PartyIcon size={20} />
        </span>
        <div style={{ minWidth: 0 }}>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600, letterSpacing: '-0.01em' }}>
            {`${party.name} domains`}
          </h1>
          <div
            style={{
              marginTop: 4,
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              flexWrap: 'wrap',
              fontSize: 13,
              color: T.muted,
            }}
          >
            <TypePill type={party.type} />
            <span>{`${party.members} members`}</span>
          </div>
        </div>
      </div>

      <Card>
        <CardHeader title="Active domains" description={listDescription} />
        {list}
      </Card>

      <div aria-live="polite">
        <StatusLine>{status}</StatusLine>
      </div>

      {canManage ? (
        <Card>
          <CardHeader
            title="Add a domain"
            description="Use this when a customer asks for another domain, such as a second country’s. Confirm they own it first."
          />
          <AddDomainForm party={party} existing={domains} onAdd={handleAdd} />
        </Card>
      ) : (
        <InfoNote icon={Lock}>
          You can see these domains but not change them. Changing domains needs the Manage party
          domains permission.
        </InfoNote>
      )}

      <DesignNote>
        Prospective only: adding or reassigning a domain affects future signups, never existing
        members (accepted gap on BAL-594). The conflict panel says so in the moment it matters,
        rather than leaving staff to discover it later.
      </DesignNote>
    </div>
  );
}

/* ═════════════════════════════════════════════════════════════════════════
 * HARNESS — review affordance only, remove in implementation
 * ════════════════════════════════════════════════════════════════════════ */

const SURFACES = [
  { value: 'company', label: 'Company settings' },
  { value: 'agency', label: 'Agency settings' },
  { value: 'solo', label: 'Solo expert' },
  { value: 'drillin', label: 'Lookup drill-in' },
  { value: 'staff', label: 'Staff domains page' },
];

function Segmented({ options, value, onChange, label }) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      style={{
        display: 'inline-flex',
        flexWrap: 'wrap',
        gap: 4,
        padding: 4,
        borderRadius: 11,
        background: T.track,
      }}
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(o.value)}
            style={{
              minHeight: 34,
              padding: '0 12px',
              borderRadius: 8,
              border: 'none',
              fontFamily: T.font,
              fontSize: 12.5,
              fontWeight: 600,
              color: active ? T.fg : T.muted,
              background: active ? T.surface : 'transparent',
              boxShadow: active ? '0 1px 2px rgba(15,23,41,.08)' : 'none',
              cursor: 'pointer',
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

const harnessLabel = { fontSize: 12, fontWeight: 600, color: T.muted };
const harnessSelect = {
  minHeight: 36,
  padding: '0 10px',
  borderRadius: 9,
  border: `1px solid ${T.border}`,
  background: T.surface,
  color: T.fg,
  fontFamily: T.font,
  fontSize: 13,
};

export default function PartyDomainsPrototype() {
  const [surface, setSurface] = useState('agency');
  const [partyKey, setPartyKey] = useState('company');
  const [canManage, setCanManage] = useState(true);
  const [dataState, setDataState] = useState('loaded');
  const [nonce, setNonce] = useState(0);

  const remount = () => setNonce((n) => n + 1);
  const retry = () => {
    setDataState('loaded');
    remount();
  };
  const isStaff = surface === 'drillin' || surface === 'staff';
  const usesData = surface === 'company' || surface === 'agency' || surface === 'staff';

  let content;
  if (surface === 'company') {
    content = <CompanySettingsView key={`c-${nonce}`} dataState={dataState} onRetry={retry} />;
  } else if (surface === 'agency') {
    content = <AgencySettingsView key={`a-${nonce}`} dataState={dataState} onRetry={retry} />;
  } else if (surface === 'solo') {
    content = <SoloExpertView key={`s-${nonce}`} />;
  } else if (surface === 'drillin') {
    content = (
      <DrillInMock
        key={`d-${partyKey}-${nonce}`}
        partyKey={partyKey}
        onOpenDomains={() => setSurface('staff')}
      />
    );
  } else {
    content = (
      <StaffDomainsPage
        key={`p-${partyKey}-${canManage}-${nonce}`}
        partyKey={partyKey}
        canManage={canManage}
        dataState={dataState}
        onRetry={retry}
        onBack={() => setSurface('drillin')}
      />
    );
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        background: T.bg,
        color: T.fg,
        fontFamily: T.font,
        padding: '24px 16px 80px',
      }}
    >
      <link
        rel="stylesheet"
        href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&display=swap"
      />
      <style>{`
        @keyframes pd-spin { to { transform: rotate(360deg); } }
        @keyframes pd-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .45; } }
        @keyframes pd-rise { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
        * { box-sizing: border-box; }
        button:focus-visible, input:focus-visible, textarea:focus-visible, select:focus-visible, a:focus-visible {
          outline: 2px solid ${T.primary};
          outline-offset: 2px;
        }
        @media (prefers-reduced-motion: reduce) {
          *, *::before, *::after { animation-duration: .001ms !important; animation-iteration-count: 1 !important; transition-duration: .001ms !important; }
        }
      `}</style>

      <div
        style={{
          maxWidth: 860,
          margin: '0 auto 22px',
          padding: 14,
          borderRadius: 14,
          border: `1px dashed ${T.border}`,
          background: T.surface,
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={harnessLabel}>Surface</span>
          <Segmented
            label="Surface"
            options={SURFACES}
            value={surface}
            onChange={(v) => {
              setSurface(v);
              remount();
            }}
          />
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'flex-end' }}>
          {isStaff && (
            <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span style={harnessLabel}>Party</span>
              <select
                value={partyKey}
                onChange={(e) => {
                  setPartyKey(e.target.value);
                  remount();
                }}
                style={harnessSelect}
              >
                <option value="company">Northwind (company)</option>
                <option value="agency">Lattice Consulting (agency)</option>
              </select>
            </label>
          )}
          {usesData && (
            <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span style={harnessLabel}>Data</span>
              <select
                value={dataState}
                onChange={(e) => {
                  setDataState(e.target.value);
                  remount();
                }}
                style={harnessSelect}
              >
                <option value="loaded">Loaded</option>
                <option value="loading">Loading</option>
                <option value="error">Error</option>
              </select>
            </label>
          )}
          {surface === 'staff' && (
            <label
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
                minHeight: 36,
                fontSize: 13,
                fontWeight: 500,
              }}
            >
              <input
                type="checkbox"
                checked={canManage}
                onChange={(e) => setCanManage(e.target.checked)}
              />
              Can manage domains
            </label>
          )}
          <Button variant="secondary" onClick={remount}>
            <RotateCcw size={14} aria-hidden="true" /> Reset
          </Button>
        </div>
      </div>

      <main style={{ maxWidth: 860, margin: '0 auto' }}>{content}</main>
    </div>
  );
}
