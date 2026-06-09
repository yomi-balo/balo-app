import { useState, useMemo } from 'react';

// ══════════════════════════════════════════════════════════════════
// Project Request Detail — tri-lens prototype v2
//
// Evolution of v1. Two layout archetypes:
//   PARTICIPANT (client, expert): request is the page in Phase 1;
//     the CONVERSATION becomes the page in Phase 2, request demotes to
//     a bounded-scroll context panel on the right.
//   OBSERVER (admin): request stays the main stage throughout; admin
//     gets a health/activity panel, never participates in chat.
//
// Conversation (Phase 2) = tabs per expert.
//   · Stable tab order (by invite order) — never reorder.
//   · Auto-select freshest UNREAD thread on load; fall back to most
//     recent / last-viewed if all read.
//   · Unread dots on every other tab as ambient signal.
//   · Per-thread nudge pre-surfaces that thread's latest message.
//
// Desktop-first (matches existing references). Mobile reflow (request
// panel → collapsible header/tab) is a KNOWN divergence, flagged not built.
//
// "Always nudge": one privileged next step per cell. Low-stakes =
// frictionless/pulsing; committing = confirm beat; waiting = productive
// secondary, never a dead end.
// ══════════════════════════════════════════════════════════════════

const c = {
  bg: '#F8FAFB',
  surface: '#FFFFFF',
  surfaceSubtle: '#F1F4F8',
  border: '#E0E4EB',
  borderSubtle: '#EAEFF5',
  text: '#111827',
  textSecondary: '#4B5563',
  textTertiary: '#9CA3AF',
  primary: '#2563EB',
  primaryDark: '#1D4ED8',
  primaryLight: '#EFF6FF',
  primaryBorder: '#BFDBFE',
  primaryGlow: 'rgba(37,99,235,0.12)',
  accent: '#7C3AED',
  accentLight: '#F5F3FF',
  accentBorder: '#DDD6FE',
  success: '#059669',
  successLight: '#ECFDF5',
  successBorder: '#A7F3D0',
  warning: '#D97706',
  warningLight: '#FFFBEB',
  warningBorder: '#FDE68A',
  error: '#DC2626',
  errorLight: '#FEF2F2',
  cyan: '#0891B2',
  cyanLight: '#ECFEFF',
  emerald: '#059669',
  pink: '#DB2777',
  gradient: 'linear-gradient(135deg, #2563EB 0%, #7C3AED 100%)',
  gradientSubtle: 'linear-gradient(135deg, #EFF6FF 0%, #F5F3FF 100%)',
  gradientWarm: 'linear-gradient(135deg, #059669 0%, #0891B2 100%)',
};

const Icon = ({ d, size = 16, color = 'currentColor', style: xs }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke={color}
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    style={xs}
  >
    <path d={d} />
  </svg>
);
const I = {
  check: (p) => <Icon {...p} d="M20 6L9 17l-5-5" />,
  arrowRight: (p) => <Icon {...p} d="M5 12h14M12 5l7 7-7 7" />,
  clock: (p) => (
    <svg
      width={p.size || 16}
      height={p.size || 16}
      viewBox="0 0 24 24"
      fill="none"
      stroke={p.color || 'currentColor'}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={p.style}
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M12 6v6l4 2" />
    </svg>
  ),
  calendar: (p) => (
    <svg
      width={p.size || 16}
      height={p.size || 16}
      viewBox="0 0 24 24"
      fill="none"
      stroke={p.color || 'currentColor'}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={p.style}
    >
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <path d="M16 2v4M8 2v4M3 10h18" />
    </svg>
  ),
  messageSquare: (p) => (
    <svg
      width={p.size || 16}
      height={p.size || 16}
      viewBox="0 0 24 24"
      fill="none"
      stroke={p.color || 'currentColor'}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={p.style}
    >
      <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
    </svg>
  ),
  fileText: (p) => (
    <svg
      width={p.size || 16}
      height={p.size || 16}
      viewBox="0 0 24 24"
      fill="none"
      stroke={p.color || 'currentColor'}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={p.style}
    >
      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
      <path d="M14 2v6h6M16 13H8M16 17H8M10 9H8" />
    </svg>
  ),
  paperclip: (p) => (
    <Icon
      {...p}
      d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"
    />
  ),
  user: (p) => (
    <svg
      width={p.size || 16}
      height={p.size || 16}
      viewBox="0 0 24 24"
      fill="none"
      stroke={p.color || 'currentColor'}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={p.style}
    >
      <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>
  ),
  users: (p) => (
    <svg
      width={p.size || 16}
      height={p.size || 16}
      viewBox="0 0 24 24"
      fill="none"
      stroke={p.color || 'currentColor'}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={p.style}
    >
      <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75" />
    </svg>
  ),
  shield: (p) => <Icon {...p} d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />,
  sparkles: (p) => (
    <svg
      width={p.size || 16}
      height={p.size || 16}
      viewBox="0 0 24 24"
      fill="none"
      stroke={p.color || 'currentColor'}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={p.style}
    >
      <path d="M12 3v2m0 14v2m-7-9H3m18 0h-2m-1.636-6.364l-1.414 1.414M7.05 16.95l-1.414 1.414m0-12.728l1.414 1.414m9.9 9.9l1.414 1.414" />
      <circle cx="12" cy="12" r="4" />
    </svg>
  ),
  send: (p) => <Icon {...p} d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" />,
  video: (p) => (
    <svg
      width={p.size || 16}
      height={p.size || 16}
      viewBox="0 0 24 24"
      fill="none"
      stroke={p.color || 'currentColor'}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={p.style}
    >
      <polygon points="23 7 16 12 23 17 23 7" />
      <rect x="1" y="5" width="15" height="14" rx="2" />
    </svg>
  ),
  dollarSign: (p) => <Icon {...p} d="M12 1v22M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6" />,
  zap: (p) => (
    <svg
      width={p.size || 16}
      height={p.size || 16}
      viewBox="0 0 24 24"
      fill="none"
      stroke={p.color || 'currentColor'}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={p.style}
    >
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
    </svg>
  ),
  lock: (p) => (
    <svg
      width={p.size || 16}
      height={p.size || 16}
      viewBox="0 0 24 24"
      fill="none"
      stroke={p.color || 'currentColor'}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={p.style}
    >
      <rect x="3" y="11" width="18" height="11" rx="2" />
      <path d="M7 11V7a5 5 0 0110 0v4" />
    </svg>
  ),
  building: (p) => (
    <svg
      width={p.size || 16}
      height={p.size || 16}
      viewBox="0 0 24 24"
      fill="none"
      stroke={p.color || 'currentColor'}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={p.style}
    >
      <rect x="4" y="2" width="16" height="20" rx="2" />
      <path d="M9 22v-4h6v4M8 6h.01M16 6h.01M8 10h.01M16 10h.01M8 14h.01M16 14h.01" />
    </svg>
  ),
  plus: (p) => <Icon {...p} d="M12 5v14M5 12h14" />,
  briefcase: (p) => (
    <Icon
      {...p}
      d="M20 7H4a2 2 0 00-2 2v10a2 2 0 002 2h16a2 2 0 002-2V9a2 2 0 00-2-2zM16 21V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v16"
    />
  ),
  star: (p) => (
    <Icon
      {...p}
      d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14l-5-4.87 6.91-1.01L12 2z"
    />
  ),
  chevLeft: (p) => <Icon {...p} d="M15 18l-6-6 6-6" />,
  chevRight: (p) => <Icon {...p} d="M9 18l6-6-6-6" />,
  ellipsis: (p) => (
    <svg
      width={p.size || 16}
      height={p.size || 16}
      viewBox="0 0 24 24"
      fill={p.color || 'currentColor'}
      stroke="none"
      style={p.style}
    >
      <circle cx="12" cy="5" r="2" />
      <circle cx="12" cy="12" r="2" />
      <circle cx="12" cy="19" r="2" />
    </svg>
  ),
  alertCircle: (p) => (
    <svg
      width={p.size || 16}
      height={p.size || 16}
      viewBox="0 0 24 24"
      fill="none"
      stroke={p.color || 'currentColor'}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={p.style}
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M12 8v4M12 16h.01" />
    </svg>
  ),
  x: (p) => <Icon {...p} d="M18 6L6 18M6 6l12 12" />,
  activity: (p) => <Icon {...p} d="M22 12h-4l-3 9L9 3l-3 9H2" />,
};

const keyframes = `
@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
@keyframes slideUp { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: translateY(0); } }
@keyframes layoutFlip { from { opacity: 0; transform: scale(0.99); } to { opacity: 1; transform: scale(1); } }
@keyframes nudgePulse { 0%,100% { box-shadow: 0 2px 12px rgba(37,99,235,0.22); } 50% { box-shadow: 0 2px 20px rgba(37,99,235,0.40); } }
@keyframes dotPulse { 0%,100% { transform: scale(1); opacity: 1; } 50% { transform: scale(1.35); opacity: 0.7; } }
@keyframes sheetUp { from { transform: translateY(100%); } to { transform: translateY(0); } }
@keyframes backdropIn { from { opacity: 0; } to { opacity: 1; } }
.balo-xscroll { overflow-x: auto; -webkit-overflow-scrolling: touch; scrollbar-width: none; flex-wrap: nowrap; }
.balo-xscroll::-webkit-scrollbar { display: none; }
`;
const slideUp = (d = 0) => ({ animation: `slideUp 0.4s ease-out ${d}s both` });
const fadeIn = (d = 0) => ({ animation: `fadeIn 0.35s ease-out ${d}s both` });

// ── Status model ─────────────────────────────────────────────────
const STATUSES = [
  { key: 'requested', short: 'Requested' },
  { key: 'exploratory', short: 'Exploratory' },
  { key: 'experts_invited', short: 'Invited' },
  { key: 'eoi_submitted', short: 'EOIs In' },
  { key: 'proposal_requested', short: 'Prop. Req.' },
  { key: 'proposal_submitted', short: 'Proposals In' },
  { key: 'accepted', short: 'Accepted' },
  { key: 'kickoff_approved', short: 'Kickoff' },
];
const sIdx = (k) => STATUSES.findIndex((s) => s.key === k);
const PHASE2_FROM = sIdx('eoi_submitted'); // conversation becomes the page here

const ACTORS = [
  {
    key: 'client',
    label: 'Client',
    icon: I.user,
    color: c.primary,
    sub: 'Dana — RevOps Lead, Northwind Industrial',
    archetype: 'participant',
  },
  {
    key: 'expert',
    label: 'Expert',
    icon: I.shield,
    color: c.accent,
    sub: 'You — Priya, CPQ Specialist',
    archetype: 'participant',
  },
  {
    key: 'admin',
    label: 'Admin',
    icon: I.users,
    color: c.cyan,
    sub: 'Balo — MJ',
    archetype: 'observer',
  },
];

const PROPOSAL_CAP = 2;

// ── Worked example ───────────────────────────────────────────────
const REQUEST = {
  title: 'CPQ implementation to replace legacy quoting tool',
  client: 'Northwind Industrial',
  clientContact: 'Dana Whitfield',
  clientRole: 'RevOps Lead',
  posted: '3 days ago',
  budget: 'A$45,000 – A$70,000',
  timeline: 'Target go-live: end of Q3',
  products: ['Revenue Cloud (CPQ)', 'Sales Cloud'],
  tags: ['Implementation', 'Migration', 'Manufacturing'],
  // Description is RICH TEXT (authored in the request form, BAL-259). Stored/rendered as HTML.
  // SECURITY: sanitize on ingest (server-side) before persistence — never trust client-authored
  // markup at render time. Prototype renders via dangerouslySetInnerHTML to mirror the real path.
  descriptionHtml:
    "<p>We're a mid-market industrial parts manufacturer (≈220 staff) running quoting on a legacy on-prem tool that no longer integrates with our Sales Cloud org. Reps are re-keying line items by hand and discount approvals live in email threads nobody can audit.</p>" +
    '<p><strong>Must-have:</strong> an approval matrix tied to discount thresholds, live before our Q3 cutover.</p>' +
    '<p>In scope:</p>' +
    '<ul>' +
    '<li>Salesforce CPQ (Revenue Cloud) for configurable bundles &amp; tiered volume pricing</li>' +
    '<li>Migration of ~1,200 active product &amp; price records from the legacy system</li>' +
    '<li>Enablement for our 2-person admin team (no current CPQ experience)</li>' +
    '</ul>' +
    '<p>We care about documentation and handover as much as the build itself. Reference: <a href="#">current-state process doc</a> attached below.</p>',
  docs: [
    { name: 'Current-state quoting process.pdf', size: '1.4 MB' },
    { name: 'Product & price list (legacy export).xlsx', size: '320 KB' },
    { name: 'Discount approval matrix (draft).pdf', size: '210 KB' },
  ],
};

// Experts as conversation threads. Stable order = invite order.
// "lastActivity" higher = more recent. "unreadFor" = which lens has unread.
const THREADS = [
  {
    id: 'priya',
    name: 'Priya Nair',
    initials: 'PN',
    role: 'CPQ Specialist · 9 yrs',
    rating: 4.9,
    color: c.accent,
    self: true,
    invitedOrder: 1,
  },
  {
    id: 'marcus',
    name: 'Marcus Lee',
    initials: 'ML',
    role: 'Revenue Cloud Architect',
    rating: 4.8,
    color: c.primary,
    self: false,
    invitedOrder: 2,
  },
  {
    id: 'sofia',
    name: 'Sofia Almeida',
    initials: 'SA',
    role: 'Sales Cloud / CPQ',
    rating: 4.7,
    color: c.emerald,
    self: false,
    invitedOrder: 3,
  },
];

// Per-status thread state for the CLIENT lens (who has unread, latest msg, expert stage).
// Drives smart tab default + per-thread nudge.
function clientThreadState(status) {
  const i = sIdx(status);
  // Returns map id -> { stage, lastActivity, unread, lastMsg, lastFrom }
  if (i < sIdx('eoi_submitted')) return {};
  if (i === sIdx('eoi_submitted'))
    return {
      priya: {
        stage: 'EOI in',
        lastActivity: 2,
        unread: false,
        lastMsg:
          "I'd stage the migration in a sandbox first and validate price rules on ~50 SKUs. Want to grab 20 minutes this week?",
        lastFrom: 'Priya',
        files: [
          {
            name: 'Draft migration approach.pdf',
            size: '640 KB',
            from: 'Priya',
            when: 'yesterday',
          },
          {
            name: 'CPQ enablement plan (outline).docx',
            size: '88 KB',
            from: 'Priya',
            when: 'yesterday',
          },
        ],
      },
      marcus: {
        stage: 'EOI in',
        lastActivity: 3,
        unread: true,
        lastMsg:
          'Happy to help — quick Q: are you on Salesforce Billing too, or CPQ standalone? Changes the migration approach.',
        lastFrom: 'Marcus',
        files: [],
      },
      sofia: {
        stage: 'EOI in',
        lastActivity: 1,
        unread: false,
        lastMsg:
          "Hi Dana — I've delivered three CPQ rollouts in manufacturing. Keen to discuss the approval-matrix piece.",
        lastFrom: 'Sofia',
        files: [],
      },
    };
  if (i === sIdx('proposal_requested'))
    return {
      priya: {
        stage: 'Proposal requested',
        lastActivity: 2,
        unread: false,
        lastMsg: "Great — I'll have the proposal over within two days. Thanks Dana.",
        lastFrom: 'Priya',
        files: [
          {
            name: 'Draft migration approach.pdf',
            size: '640 KB',
            from: 'Priya',
            when: 'last week',
          },
          {
            name: 'CPQ enablement plan (outline).docx',
            size: '88 KB',
            from: 'Priya',
            when: 'last week',
          },
        ],
      },
      marcus: {
        stage: 'Proposal requested',
        lastActivity: 1,
        unread: false,
        lastMsg: 'On it. Will include a fixed-price migration option.',
        lastFrom: 'Marcus',
        files: [],
      },
      sofia: {
        stage: 'Not requested',
        lastActivity: 0,
        unread: false,
        lastMsg: null,
        lastFrom: null,
        files: [],
      },
    };
  if (i === sIdx('proposal_submitted'))
    return {
      priya: {
        stage: 'Proposal in',
        lastActivity: 3,
        unread: true,
        lastMsg:
          "Proposal submitted — A$58,000 across 4 milestones, 30% upfront. Let me know if you'd like to walk through it.",
        lastFrom: 'Priya',
        files: [
          {
            name: 'Draft migration approach.pdf',
            size: '640 KB',
            from: 'Priya',
            when: 'last week',
          },
          {
            name: 'CPQ enablement plan (outline).docx',
            size: '88 KB',
            from: 'Priya',
            when: 'last week',
          },
          {
            name: 'Proposal — Northwind CPQ.pdf',
            size: '1.1 MB',
            from: 'Priya',
            when: 'today',
            proposal: true,
          },
        ],
      },
      marcus: {
        stage: 'Proposal in',
        lastActivity: 2,
        unread: false,
        lastMsg: 'Submitted mine — A$62,000, fixed-price migration included.',
        lastFrom: 'Marcus',
        files: [
          {
            name: 'Proposal — Northwind (Lee).pdf',
            size: '920 KB',
            from: 'Marcus',
            when: 'today',
            proposal: true,
          },
        ],
      },
      sofia: {
        stage: 'Declined',
        lastActivity: 0,
        unread: false,
        lastMsg: null,
        lastFrom: null,
        files: [],
      },
    };
  if (i >= sIdx('accepted'))
    return {
      priya: {
        stage: i >= sIdx('kickoff_approved') ? 'Kicked off' : 'Accepted',
        lastActivity: 3,
        unread: false,
        lastMsg: "Brilliant — looking forward to getting started. I'll confirm payment terms now.",
        lastFrom: 'Priya',
        files: [
          {
            name: 'Draft migration approach.pdf',
            size: '640 KB',
            from: 'Priya',
            when: '2 weeks ago',
          },
          {
            name: 'Proposal — Northwind CPQ.pdf',
            size: '1.1 MB',
            from: 'Priya',
            when: '1 week ago',
            proposal: true,
          },
        ],
      },
      marcus: {
        stage: 'Not selected',
        lastActivity: 1,
        unread: false,
        lastMsg: 'No worries, thanks for considering me. Best of luck with the rollout.',
        lastFrom: 'Marcus',
        files: [
          {
            name: 'Proposal — Northwind (Lee).pdf',
            size: '920 KB',
            from: 'Marcus',
            when: '1 week ago',
            proposal: true,
          },
        ],
      },
      sofia: {
        stage: 'Declined',
        lastActivity: 0,
        unread: false,
        lastMsg: null,
        lastFrom: null,
        files: [],
      },
    };
  return {};
}

// ── Primitives ───────────────────────────────────────────────────
function Card({ children, style: xs, glow }) {
  return (
    <div
      style={{
        background: c.surface,
        borderRadius: 16,
        border: `1px solid ${glow ? c.primaryBorder : c.border}`,
        boxShadow: glow ? `0 4px 20px ${c.primaryGlow}` : '0 1px 3px rgba(0,0,0,0.04)',
        ...xs,
      }}
    >
      {children}
    </div>
  );
}
function SectionLabel({ children, icon: IC, color = c.textTertiary }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 12 }}>
      {IC && <IC size={13} color={color} />}
      <span
        style={{
          fontSize: 11,
          fontWeight: 700,
          color,
          textTransform: 'uppercase',
          letterSpacing: '0.07em',
        }}
      >
        {children}
      </span>
    </div>
  );
}
function Pill({
  children,
  color = c.textSecondary,
  bg = c.surfaceSubtle,
  border = c.borderSubtle,
  icon: IC,
}) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding: '3px 10px',
        borderRadius: 20,
        fontSize: 12,
        fontWeight: 600,
        color,
        background: bg,
        border: `1px solid ${border}`,
        whiteSpace: 'nowrap',
      }}
    >
      {IC && <IC size={11} color={color} />}
      {children}
    </span>
  );
}
function Avatar({ initials, color, size = 36 }) {
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.28,
        flexShrink: 0,
        background: `${color}15`,
        border: `1px solid ${color}30`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: size * 0.34,
        fontWeight: 700,
        color,
      }}
    >
      {initials}
    </div>
  );
}

// Rich-text renderer for the (sanitized) description HTML. Styles map to the design system.
// SECURITY: html is assumed ALREADY SANITIZED on ingest. Do not pass unsanitized client input here.
function RichText({ html, size = 13 }) {
  const styleId = 'balo-richtext-style';
  return (
    <>
      <style>{`
        .balo-rt { font-size: ${size}px; color: ${c.textSecondary}; line-height: 1.6; }
        .balo-rt > :first-child { margin-top: 0; }
        .balo-rt > :last-child { margin-bottom: 0; }
        .balo-rt p { margin: 0 0 10px; }
        .balo-rt strong { color: ${c.text}; font-weight: 700; }
        .balo-rt ul, .balo-rt ol { margin: 0 0 10px; padding-left: 20px; }
        .balo-rt li { margin: 0 0 4px; }
        .balo-rt li::marker { color: ${c.textTertiary}; }
        .balo-rt a { color: ${c.primary}; text-decoration: none; font-weight: 500; }
        .balo-rt a:hover { text-decoration: underline; }
        .balo-rt h1, .balo-rt h2, .balo-rt h3 { color: ${c.text}; font-weight: 700; margin: 0 0 8px; line-height: 1.3; }
        .balo-rt h3 { font-size: ${size + 1}px; }
      `}</style>
      <div className="balo-rt" dangerouslySetInnerHTML={{ __html: html }} />
    </>
  );
}

// Bottom sheet — mobile container for reference/menu content (Request details, Files, thread actions).
// Renders absolutely INSIDE the positioned phone frame so it stays contained to the device in preview.
// (Real impl: a portal'd sheet anchored to the viewport bottom.)
function BottomSheet({ open, onClose, title, children, maxHeight = '82%' }) {
  if (!open) return null;
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 60,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'flex-end',
      }}
    >
      <div
        onClick={onClose}
        style={{
          position: 'absolute',
          inset: 0,
          background: 'rgba(15,23,41,0.35)',
          animation: 'backdropIn 0.2s ease-out both',
        }}
      />
      <div
        style={{
          position: 'relative',
          background: c.surface,
          borderRadius: '20px 20px 0 0',
          boxShadow: '0 -8px 32px rgba(0,0,0,0.18)',
          maxHeight,
          display: 'flex',
          flexDirection: 'column',
          animation: 'sheetUp 0.28s cubic-bezier(0.32,0.72,0,1) both',
        }}
      >
        {/* Grab handle */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'center',
            padding: '10px 0 4px',
            flexShrink: 0,
          }}
        >
          <div style={{ width: 36, height: 4, borderRadius: 2, background: c.border }} />
        </div>
        {title && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '4px 18px 12px',
              borderBottom: `1px solid ${c.borderSubtle}`,
              flexShrink: 0,
            }}
          >
            <p style={{ fontSize: 15, fontWeight: 700, color: c.text, margin: 0 }}>{title}</p>
            <button
              onClick={onClose}
              style={{
                background: c.surfaceSubtle,
                border: 'none',
                borderRadius: 8,
                width: 30,
                height: 30,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
              }}
            >
              <I.x size={15} color={c.textSecondary} />
            </button>
          </div>
        )}
        <div style={{ overflowY: 'auto', padding: '14px 16px 22px', flex: 1 }}>{children}</div>
      </div>
    </div>
  );
}

// Action-sheet row (used inside the thread-actions bottom sheet)
function SheetAction({ icon: IC, label, sub, onClick, primary, color = c.primary }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        width: '100%',
        padding: '13px 14px',
        borderRadius: 12,
        border: `1px solid ${primary ? c.primaryBorder : c.borderSubtle}`,
        background: primary ? c.primaryLight : c.surface,
        cursor: 'pointer',
        textAlign: 'left',
        marginBottom: 8,
      }}
    >
      <div
        style={{
          width: 34,
          height: 34,
          borderRadius: 9,
          background: primary ? c.surface : `${color}12`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        <IC size={16} color={color} />
      </div>
      <div style={{ flex: 1 }}>
        <p
          style={{ fontSize: 14, fontWeight: 650, color: primary ? c.primary : c.text, margin: 0 }}
        >
          {label}
        </p>
        {sub && <p style={{ fontSize: 12, color: c.textTertiary, margin: '1px 0 0' }}>{sub}</p>}
      </div>
      <I.chevRight size={15} color={c.textTertiary} />
    </button>
  );
}

// ── Nudge bar (compact variant for in-thread use too) ────────────
function NudgeBar({
  variant = 'action',
  icon: IC,
  headline,
  sub,
  primary,
  secondary,
  placeholder,
  compact,
}) {
  const isWaiting = variant === 'waiting',
    isDone = variant === 'done',
    isCommit = variant === 'commit';
  const ac = isWaiting ? c.warning : isDone ? c.success : c.primary;
  const abg = isWaiting ? c.warningLight : isDone ? c.successLight : c.primaryLight;
  const abd = isWaiting ? c.warningBorder : isDone ? c.successBorder : c.primaryBorder;
  return (
    <Card glow={!isWaiting && !isDone} style={{ padding: 0, overflow: 'hidden', ...slideUp(0.04) }}>
      <div style={{ display: 'flex', alignItems: 'stretch' }}>
        <div
          style={{
            width: 4,
            background: isWaiting ? c.warning : isDone ? c.success : c.gradient,
            flexShrink: 0,
          }}
        />
        <div style={{ flex: 1, padding: compact ? '13px 16px' : '18px 22px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 3 }}>
            <div
              style={{
                width: 24,
                height: 24,
                borderRadius: 7,
                background: abg,
                border: `1px solid ${abd}`,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}
            >
              {isWaiting ? (
                <span
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: '50%',
                    background: c.warning,
                    animation: 'dotPulse 1.6s ease-in-out infinite',
                  }}
                />
              ) : (
                <IC size={13} color={ac} />
              )}
            </div>
            <span
              style={{
                fontSize: 10.5,
                fontWeight: 700,
                color: ac,
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
              }}
            >
              {isWaiting ? 'Waiting' : isDone ? 'Done' : 'Your next step'}
            </span>
          </div>
          <p
            style={{
              fontSize: compact ? 14 : 15,
              fontWeight: 650,
              color: c.text,
              margin: '0 0 2px 33px',
            }}
          >
            {headline}
          </p>
          {sub && (
            <p
              style={{
                fontSize: 13,
                color: c.textSecondary,
                margin: '0 0 0 33px',
                lineHeight: 1.5,
              }}
            >
              {sub}
            </p>
          )}
          {placeholder && (
            <div style={{ margin: '12px 0 0 33px', display: 'flex', gap: 8 }}>
              <div
                style={{
                  flex: 1,
                  padding: '10px 14px',
                  borderRadius: 10,
                  border: `1px solid ${c.border}`,
                  background: c.surfaceSubtle,
                  fontSize: 13,
                  color: c.textTertiary,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                }}
              >
                <span>
                  <span style={{ color: c.text, fontWeight: 500 }}>{placeholder.prefill}</span>
                  {placeholder.rest}
                </span>
                <kbd
                  style={{
                    fontSize: 10,
                    fontWeight: 600,
                    color: c.textTertiary,
                    background: c.surface,
                    border: `1px solid ${c.border}`,
                    borderRadius: 5,
                    padding: '2px 7px',
                  }}
                >
                  ↵ Enter
                </kbd>
              </div>
            </div>
          )}
          {(primary || secondary) && (
            <div
              style={{
                display: 'flex',
                gap: 10,
                alignItems: 'center',
                margin: '13px 0 0 33px',
                flexWrap: 'wrap',
              }}
            >
              {primary && (
                <button
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '9px 18px',
                    borderRadius: 10,
                    fontSize: 13.5,
                    fontWeight: 650,
                    border: 'none',
                    cursor: 'pointer',
                    color: 'white',
                    background: isWaiting ? c.warning : c.gradient,
                    boxShadow: `0 2px 12px ${c.primaryGlow}`,
                    animation:
                      !isCommit && !isWaiting ? 'nudgePulse 2.4s ease-in-out infinite' : 'none',
                  }}
                >
                  {primary.icon && <primary.icon size={15} color="white" />}
                  {primary.label}
                  {isCommit && (
                    <span style={{ fontSize: 11, fontWeight: 500, opacity: 0.85 }}>· confirm</span>
                  )}
                </button>
              )}
              {secondary && (
                <button
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 7,
                    padding: '9px 15px',
                    borderRadius: 10,
                    fontSize: 13,
                    fontWeight: 550,
                    border: `1px solid ${c.border}`,
                    background: c.surface,
                    cursor: 'pointer',
                    color: c.textSecondary,
                  }}
                >
                  {secondary.icon && <secondary.icon size={14} color={c.textSecondary} />}
                  {secondary.label}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}

// ── Status stepper ───────────────────────────────────────────────
function StatusStepper({ current, onPick }) {
  const ci = sIdx(current);
  return (
    <div
      className="balo-xscroll"
      style={{ display: 'flex', alignItems: 'center', padding: '4px 0' }}
    >
      {STATUSES.map((s, i) => {
        const done = i < ci,
          active = i === ci;
        return (
          <div key={s.key} style={{ display: 'flex', alignItems: 'center', flexShrink: 0 }}>
            <button
              onClick={() => onPick(s.key)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 7,
                padding: '6px 10px',
                borderRadius: 8,
                border: 'none',
                cursor: 'pointer',
                background: active ? c.primaryLight : 'transparent',
              }}
            >
              <div
                style={{
                  width: 20,
                  height: 20,
                  borderRadius: '50%',
                  flexShrink: 0,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  background: done ? c.gradient : active ? c.surface : c.surfaceSubtle,
                  border: active
                    ? `2px solid ${c.primary}`
                    : done
                      ? 'none'
                      : `1px solid ${c.border}`,
                  fontSize: 10,
                  fontWeight: 700,
                  color: done ? 'white' : active ? c.primary : c.textTertiary,
                }}
              >
                {done ? <I.check size={11} color="white" /> : i + 1}
              </div>
              <span
                style={{
                  fontSize: 12,
                  fontWeight: active ? 650 : 500,
                  color: active ? c.primary : done ? c.textSecondary : c.textTertiary,
                  whiteSpace: 'nowrap',
                }}
              >
                {s.short}
              </span>
            </button>
            {i < STATUSES.length - 1 && (
              <div
                style={{
                  width: 14,
                  height: 1.5,
                  background: i < ci ? c.primary : c.border,
                  flexShrink: 0,
                }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Request context — TWO renderings ─────────────────────────────
// full: Phase 1 hero (and admin main stage). compact: Phase 2 bounded-scroll panel.
function RequestContext({ lens, compact }) {
  // Client identity (company + named contact) is visible to experts on invite — decided deliberately;
  // revisit only if it leads to off-platform leakage. The only remaining rule is self-reference:
  // don't show the client their own identity as a "Contact" field.
  const showContact = lens !== 'client';
  if (compact) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14, ...slideUp(0.08) }}>
        {/* 1 — Request card: title + chips + description (only the description scrolls) */}
        <Card style={{ overflow: 'hidden' }}>
          <div style={{ padding: '14px 16px 10px', borderBottom: `1px solid ${c.borderSubtle}` }}>
            <SectionLabel icon={I.fileText} color={c.textTertiary}>
              The request
            </SectionLabel>
            <h2
              style={{
                fontSize: 15,
                fontWeight: 700,
                color: c.text,
                margin: '0 0 8px',
                lineHeight: 1.3,
              }}
            >
              {REQUEST.title}
            </h2>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {REQUEST.products.map((p) => (
                <Pill key={p} color={c.primary} bg={c.primaryLight} border={c.primaryBorder}>
                  {p}
                </Pill>
              ))}
            </div>
          </div>
          {/* ONLY the description is bounded-scroll — it's the one unbounded-length element */}
          <div style={{ maxHeight: 200, overflowY: 'auto', padding: '12px 16px' }}>
            <RichText html={REQUEST.descriptionHtml} size={13} />
          </div>
        </Card>

        {/* 2 — Details card: bounded, fully visible, no scroll */}
        <Card style={{ padding: '14px 16px' }}>
          <SectionLabel icon={I.building}>Details</SectionLabel>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5 }}>
              <span style={{ color: c.textTertiary }}>Budget</span>
              <span style={{ color: c.text, fontWeight: 600 }}>{REQUEST.budget}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5 }}>
              <span style={{ color: c.textTertiary }}>Timeline</span>
              <span style={{ color: c.text, fontWeight: 600 }}>{REQUEST.timeline}</span>
            </div>
            {showContact && (
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5 }}>
                <span style={{ color: c.textTertiary }}>Contact</span>
                <span style={{ color: c.text, fontWeight: 600 }}>{REQUEST.clientContact}</span>
              </div>
            )}
          </div>
        </Card>

        {/* 3 — Documents card: the client's request attachments, fully visible (never behind a scroll) */}
        <Card style={{ padding: '14px 16px' }}>
          <SectionLabel icon={I.paperclip}>Request documents</SectionLabel>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            {REQUEST.docs.map((d) => (
              <div
                key={d.name}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 9,
                  padding: '8px 10px',
                  borderRadius: 9,
                  border: `1px solid ${c.borderSubtle}`,
                  cursor: 'pointer',
                }}
              >
                <div
                  style={{
                    width: 26,
                    height: 26,
                    borderRadius: 7,
                    background: c.errorLight,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                  }}
                >
                  <I.fileText size={12} color={c.error} />
                </div>
                <span
                  style={{
                    flex: 1,
                    fontSize: 12.5,
                    color: c.text,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {d.name}
                </span>
                <span style={{ fontSize: 11, color: c.textTertiary, flexShrink: 0 }}>{d.size}</span>
              </div>
            ))}
          </div>
        </Card>
      </div>
    );
  }
  // FULL (Phase 1 / admin main stage)
  return (
    <Card style={{ padding: '22px 24px', ...slideUp(0) }}>
      <div
        style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}
      >
        {REQUEST.products.map((p) => (
          <Pill key={p} color={c.primary} bg={c.primaryLight} border={c.primaryBorder}>
            {p}
          </Pill>
        ))}
        {REQUEST.tags.map((t) => (
          <Pill key={t}>{t}</Pill>
        ))}
      </div>
      <h1 style={{ fontSize: 22, fontWeight: 700, color: c.text, margin: '0 0 6px' }}>
        {REQUEST.title}
      </h1>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 14,
          fontSize: 13,
          color: c.textSecondary,
          flexWrap: 'wrap',
        }}
      >
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <I.building size={13} color={c.textTertiary} />
          {REQUEST.client}
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <I.clock size={13} color={c.textTertiary} />
          Posted {REQUEST.posted}
        </span>
        {showContact && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <I.user size={13} color={c.textTertiary} />
            {REQUEST.clientContact} · {REQUEST.clientRole}
          </span>
        )}
      </div>
      <div style={{ margin: '16px 0 0' }}>
        <RichText html={REQUEST.descriptionHtml} size={14} />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, margin: '18px 0 0' }}>
        <div style={{ padding: '10px 14px', borderRadius: 10, background: c.surfaceSubtle }}>
          <p
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: c.textTertiary,
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              margin: 0,
            }}
          >
            Budget
          </p>
          <p style={{ fontSize: 14, fontWeight: 650, color: c.text, margin: '3px 0 0' }}>
            {REQUEST.budget}
          </p>
        </div>
        <div style={{ padding: '10px 14px', borderRadius: 10, background: c.surfaceSubtle }}>
          <p
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: c.textTertiary,
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              margin: 0,
            }}
          >
            Timeline
          </p>
          <p style={{ fontSize: 14, fontWeight: 650, color: c.text, margin: '3px 0 0' }}>
            {REQUEST.timeline}
          </p>
        </div>
      </div>
      <div style={{ margin: '16px 0 0' }}>
        <SectionLabel icon={I.paperclip}>Attached documents</SectionLabel>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {REQUEST.docs.map((d) => (
            <div
              key={d.name}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '9px 12px',
                borderRadius: 10,
                border: `1px solid ${c.borderSubtle}`,
                cursor: 'pointer',
              }}
            >
              <div
                style={{
                  width: 30,
                  height: 30,
                  borderRadius: 8,
                  background: c.errorLight,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                }}
              >
                <I.fileText size={14} color={c.error} />
              </div>
              <span style={{ flex: 1, fontSize: 13, fontWeight: 500, color: c.text }}>
                {d.name}
              </span>
              <span style={{ fontSize: 12, color: c.textTertiary }}>{d.size}</span>
            </div>
          ))}
        </div>
      </div>
    </Card>
  );
}

// ── Per-thread nudge (client lens) ───────────────────────────────
function threadNudge(threadId, st, status) {
  const i = sIdx(status);
  const ts = st[threadId];
  if (!ts) return null;
  const name = THREADS.find((t) => t.id === threadId).name.split(' ')[0];
  if (i === sIdx('eoi_submitted')) {
    if (ts.unread)
      return {
        variant: 'action',
        icon: I.messageSquare,
        headline: `${name} asked a question — reply to keep momentum`,
        sub: ts.lastMsg,
        placeholder: { prefill: "We're on CPQ standalone for now", rest: ' — reply…' },
      };
    return {
      variant: 'action',
      icon: I.calendar,
      headline: `Meet ${name} — she's keen to help`,
      sub: 'A quick intro call is the fastest way to gauge fit. Meetings are free.',
      primary: { label: `Book a call with ${name}`, icon: I.calendar },
      secondary: { label: 'Reply by message', icon: I.messageSquare },
    };
  }
  if (i === sIdx('proposal_requested'))
    return {
      variant: 'waiting',
      icon: I.clock,
      headline: `${name} is preparing the proposal`,
      sub: ts.lastMsg,
      secondary: { label: 'Send a message', icon: I.messageSquare },
    };
  if (i === sIdx('proposal_submitted'))
    return {
      variant: 'commit',
      icon: I.check,
      headline: `${name}'s proposal is ready`,
      sub: ts.lastMsg,
      primary: { label: `Accept ${name}'s proposal`, icon: I.check },
      secondary: { label: 'View full proposal', icon: I.fileText },
    };
  if (i >= sIdx('accepted')) {
    if (ts.stage === 'Not selected')
      return {
        variant: 'done',
        icon: I.messageSquare,
        headline: `You didn't select ${name}`,
        sub: "They've been notified graciously. The conversation stays here for your records.",
      };
    return {
      variant: 'done',
      icon: I.zap,
      headline: `${name} is your expert`,
      sub: ts.lastMsg,
      primary: { label: 'Open project workspace', icon: I.briefcase },
    };
  }
  return null;
}

// ── Conversation main stage (participant Phase 2) ────────────────
function ConversationStage({ lens, status, mobile }) {
  // Build active threads (those with state)
  const st = clientThreadState(status); // (expert lens reuses shape but only sees own thread)
  const activeThreads = THREADS.filter(
    (t) =>
      st[t.id] &&
      st[t.id].stage !== 'Invited' &&
      st[t.id].stage !== 'Not requested' &&
      !(lens === 'expert' && !t.self)
  );

  // Smart default: freshest UNREAD; fallback most-recent activity.
  const defaultTab = useMemo(() => {
    const unread = activeThreads
      .filter((t) => st[t.id]?.unread)
      .sort((a, b) => st[b.id].lastActivity - st[a.id].lastActivity);
    if (unread.length) return unread[0].id;
    const byRecent = [...activeThreads].sort(
      (a, b) => st[b.id].lastActivity - st[a.id].lastActivity
    );
    return byRecent[0]?.id;
  }, [status, lens]);

  const [tab, setTab] = useState(defaultTab);
  const [lastKey, setLastKey] = useState(`${lens}-${status}`);
  const [filesOpen, setFilesOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false); // mobile thread-action sheet
  const [composerFocused, setComposerFocused] = useState(false); // mobile: keyboard up → hide the action rail
  // reset when status/lens changes
  const tabKey = `${lens}-${status}`;
  if (lastKey !== tabKey) {
    setLastKey(tabKey);
    setTab(defaultTab);
    setFilesOpen(false);
    setMenuOpen(false);
    setComposerFocused(false);
  }

  const active = tab || defaultTab;
  const single = activeThreads.length === 1;
  const ts = st[active];
  const thread = THREADS.find((t) => t.id === active);
  const nudge = lens === 'client' ? threadNudge(active, st, status) : expertSelfNudge(status);
  const files = ts?.files || [];

  const callLabel = lens === 'expert' ? 'Propose times' : 'Book a call';
  const si = sIdx(status);
  const callAllowed =
    si < sIdx('kickoff_approved') && ts?.stage !== 'Not selected' && ts?.stage !== 'Declined';
  const showProposalAction = callAllowed;
  const proposalRequested = si >= sIdx('proposal_requested') && ts?.stage !== 'Not requested';
  const proposalSubmitted =
    si >= sIdx('proposal_submitted') &&
    (ts?.stage === 'Proposal in' || ts?.stage === 'Accepted' || ts?.stage === 'Kicked off');
  const nudgeIsProposal = !!(nudge && nudge.primary && /proposal/i.test(nudge.primary.label));
  const proposalLabel = lens === 'expert' ? 'Build proposal' : 'Request proposal';

  // ── Shared sub-renders ──
  const TabStrip = !single && (
    <div
      className="balo-xscroll"
      style={{
        display: 'flex',
        gap: 2,
        padding: mobile ? '6px 8px 0' : '8px 10px 0',
        borderBottom: `1px solid ${c.borderSubtle}`,
        background: c.surfaceSubtle,
        flexShrink: 0,
      }}
    >
      {activeThreads.map((t) => {
        const on = t.id === active;
        const u = st[t.id]?.unread;
        return (
          <button
            key={t.id}
            onClick={() => {
              setTab(t.id);
              setFilesOpen(false);
            }}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 7,
              padding: '9px 12px',
              borderRadius: '10px 10px 0 0',
              border: 'none',
              borderBottom: on ? `2px solid ${c.primary}` : '2px solid transparent',
              cursor: 'pointer',
              background: on ? c.surface : 'transparent',
              marginBottom: -1,
              flexShrink: 0,
              whiteSpace: 'nowrap',
            }}
          >
            <Avatar initials={t.initials} color={t.color} size={22} />
            <span
              style={{
                fontSize: 13,
                fontWeight: on ? 650 : 500,
                color: on ? c.text : c.textSecondary,
              }}
            >
              {t.name.split(' ')[0]}
            </span>
            {u && (
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  background: c.primary,
                  animation: 'dotPulse 1.6s ease-in-out infinite',
                }}
              />
            )}
          </button>
        );
      })}
    </div>
  );

  const FilesList =
    files.length === 0 ? (
      <div style={{ textAlign: 'center', padding: '32px 16px' }}>
        <div
          style={{
            width: 40,
            height: 40,
            borderRadius: 11,
            background: c.surfaceSubtle,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            margin: '0 auto 12px',
          }}
        >
          <I.paperclip size={18} color={c.textTertiary} />
        </div>
        <p style={{ fontSize: 13, fontWeight: 600, color: c.text, margin: 0 }}>
          No files shared yet
        </p>
        <p style={{ fontSize: 12, color: c.textTertiary, margin: '4px 0 0', lineHeight: 1.5 }}>
          Drop a file in the conversation and it'll show up here for both of you.
        </p>
      </div>
    ) : (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {files.map((f) => (
          <div
            key={f.name}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '10px 12px',
              borderRadius: 10,
              border: `1px solid ${f.proposal ? c.primaryBorder : c.borderSubtle}`,
              background: f.proposal ? c.primaryLight : c.surface,
              cursor: 'pointer',
            }}
          >
            <div
              style={{
                width: 32,
                height: 32,
                borderRadius: 8,
                background: f.proposal ? c.surface : c.errorLight,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}
            >
              <I.fileText size={15} color={f.proposal ? c.primary : c.error} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <p
                style={{
                  fontSize: 13,
                  fontWeight: 600,
                  color: c.text,
                  margin: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {f.name}
              </p>
              <p style={{ fontSize: 11, color: c.textTertiary, margin: '1px 0 0' }}>
                {f.from} · {f.when} · {f.size}
              </p>
            </div>
          </div>
        ))}
      </div>
    );

  const Messages = (
    <>
      <div
        style={{
          alignSelf: 'flex-start',
          maxWidth: '82%',
          padding: '9px 13px',
          borderRadius: '12px 12px 12px 4px',
          background: c.surfaceSubtle,
          fontSize: 13,
          color: c.text,
        }}
      >
        {lens === 'expert'
          ? "Hi Priya — thanks for your interest. Could you walk us through how you'd handle the 1,200-record price migration?"
          : `Hi ${thread.name.split(' ')[0]} — thanks for expressing interest.`}
      </div>
      {files.length > 0 && (
        <div style={{ alignSelf: lens === 'expert' ? 'flex-end' : 'flex-start', maxWidth: '82%' }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '10px 12px',
              borderRadius: lens === 'expert' ? '12px 12px 4px 12px' : '12px 12px 12px 4px',
              background: c.surface,
              border: `1px solid ${c.border}`,
              cursor: 'pointer',
            }}
          >
            <div
              style={{
                width: 32,
                height: 32,
                borderRadius: 8,
                background: c.errorLight,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}
            >
              <I.fileText size={15} color={c.error} />
            </div>
            <div style={{ minWidth: 0 }}>
              <p
                style={{
                  fontSize: 12.5,
                  fontWeight: 600,
                  color: c.text,
                  margin: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {files[0].name}
              </p>
              <p style={{ fontSize: 11, color: c.textTertiary, margin: '1px 0 0' }}>
                {files[0].size}
              </p>
            </div>
          </div>
        </div>
      )}
      {ts?.lastMsg && (
        <div
          style={{
            alignSelf: thread.self || lens === 'expert' ? 'flex-end' : 'flex-start',
            maxWidth: '82%',
            padding: '9px 13px',
            borderRadius:
              thread.self || lens === 'expert' ? '12px 12px 4px 12px' : '12px 12px 12px 4px',
            background: thread.self || lens === 'expert' ? c.primaryLight : c.surfaceSubtle,
            border: thread.self || lens === 'expert' ? `1px solid ${c.primaryBorder}` : 'none',
            fontSize: 13,
            color: c.text,
          }}
        >
          {ts.lastMsg}
        </div>
      )}
    </>
  );

  const Composer = (
    <div
      style={{
        display: 'flex',
        gap: 8,
        alignItems: 'center',
        padding: '12px 14px',
        borderTop: `1px solid ${c.borderSubtle}`,
        flexShrink: 0,
      }}
    >
      <button
        style={{
          width: 40,
          height: 40,
          borderRadius: 10,
          border: `1px solid ${c.border}`,
          background: c.surface,
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
        title="Attach a file"
      >
        <I.paperclip size={16} color={c.textSecondary} />
      </button>
      <input
        placeholder={`Message ${thread.name.split(' ')[0]}…`}
        onFocus={() => setComposerFocused(true)}
        onBlur={() => setComposerFocused(false)}
        style={{
          flex: 1,
          padding: '10px 14px',
          borderRadius: 10,
          border: `1px solid ${c.border}`,
          background: c.surface,
          fontSize: 13,
          color: c.text,
          outline: 'none',
          minWidth: 0,
        }}
      />
      <button
        style={{
          width: 40,
          height: 40,
          borderRadius: 10,
          border: 'none',
          background: c.gradient,
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        <I.send size={16} color="white" />
      </button>
    </div>
  );

  // ════════════════════ MOBILE ════════════════════
  // No thread header (the tab IS the identity — avoids the duplicate name).
  // Tabs ALWAYS shown (even single), with Files + ⋯ pinned to the strip row.
  // Primary commit action (Request/Build proposal) is SURFACED in a sticky action bar
  // above the composer — not buried in a menu. The bar COLLAPSES once nothing is
  // actionable (past acceptance → billing/kickoff is carried by the global nudge).
  if (mobile) {
    const pastAcceptance = si >= sIdx('accepted');
    // Proposal CTA for the sticky bar (null = passive/none)
    let proposalCta = null;
    if (!pastAcceptance) {
      if (lens === 'client' && !proposalRequested) proposalCta = { label: 'Request proposal' };
      else if (lens === 'expert' && proposalRequested && !proposalSubmitted)
        proposalCta = { label: 'Build proposal' };
      else if (lens === 'client' && proposalSubmitted) proposalCta = { label: 'View proposal' };
    }
    const showCall = callAllowed && !pastAcceptance;
    const showBar = !!proposalCta || showCall;
    const ctaQuiet = nudgeIsProposal; // defer to the nudge if it already pushes the proposal

    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          flex: 1,
          minHeight: 0,
          background: c.surface,
        }}
      >
        {/* Strip row: tabs (always, scrollable) + Files + ⋯ */}
        <div
          style={{
            display: 'flex',
            alignItems: 'stretch',
            borderBottom: `1px solid ${c.borderSubtle}`,
            background: c.surfaceSubtle,
            flexShrink: 0,
          }}
        >
          <div
            className="balo-xscroll"
            style={{
              display: 'flex',
              gap: 2,
              padding: '6px 6px 0',
              flex: 1,
              minWidth: 0,
              flexWrap: 'nowrap',
            }}
          >
            {activeThreads.map((t) => {
              const on = t.id === active;
              const u = st[t.id]?.unread;
              return (
                <button
                  key={t.id}
                  onClick={() => {
                    setTab(t.id);
                    setFilesOpen(false);
                  }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 7,
                    padding: '9px 12px',
                    borderRadius: '10px 10px 0 0',
                    border: 'none',
                    borderBottom: on ? `2px solid ${c.primary}` : '2px solid transparent',
                    cursor: 'pointer',
                    background: on ? c.surface : 'transparent',
                    marginBottom: -1,
                    flexShrink: 0,
                    whiteSpace: 'nowrap',
                  }}
                >
                  <Avatar initials={t.initials} color={t.color} size={22} />
                  <span
                    style={{
                      fontSize: 13,
                      fontWeight: on ? 650 : 500,
                      color: on ? c.text : c.textSecondary,
                    }}
                  >
                    {t.name.split(' ')[0]}
                    {t.self && on && (
                      <span style={{ fontSize: 10, color: c.accent, marginLeft: 4 }}>(you)</span>
                    )}
                  </span>
                  {u && (
                    <span
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: '50%',
                        background: c.primary,
                        animation: 'dotPulse 1.6s ease-in-out infinite',
                      }}
                    />
                  )}
                </button>
              );
            })}
          </div>
          {/* Pinned right: Files + overflow */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '0 8px',
              flexShrink: 0,
            }}
          >
            <button
              onClick={() => setFilesOpen(true)}
              style={{
                position: 'relative',
                width: 36,
                height: 36,
                borderRadius: 9,
                border: `1px solid ${c.border}`,
                background: c.surface,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <I.paperclip size={15} color={c.textSecondary} />
              {files.length > 0 && (
                <span
                  style={{
                    position: 'absolute',
                    top: -6,
                    right: -6,
                    minWidth: 16,
                    height: 16,
                    borderRadius: 8,
                    background: c.primary,
                    color: 'white',
                    fontSize: 10,
                    fontWeight: 700,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    padding: '0 4px',
                    border: '2px solid white',
                  }}
                >
                  {files.length}
                </span>
              )}
            </button>
            <button
              onClick={() => setMenuOpen(true)}
              style={{
                width: 36,
                height: 36,
                borderRadius: 9,
                border: `1px solid ${c.border}`,
                background: c.surface,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <I.ellipsis size={15} color={c.textSecondary} />
            </button>
          </div>
        </div>

        {/* Nudge — contextual action surface */}
        {nudge && (
          <div style={{ padding: '12px 12px 0', flexShrink: 0 }}>
            <NudgeBar {...nudge} compact />
          </div>
        )}

        {/* Messages (scroll) */}
        <div
          style={{
            flex: 1,
            minHeight: 0,
            padding: '14px 14px',
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
            overflowY: 'auto',
          }}
        >
          {Messages}
        </div>

        {Composer}

        {/* Action rail — BELOW the composer, anchored at the true bottom (thumb zone).
            Surfaces the primary commit action; collapses when nothing is actionable;
            and HIDES while the composer is focused (keyboard up — the rail isn't needed mid-typing). */}
        {showBar && !composerFocused && (
          <div
            style={{
              display: 'flex',
              gap: 8,
              alignItems: 'center',
              padding: '10px 14px',
              borderTop: `1px solid ${c.borderSubtle}`,
              background: c.surfaceSubtle,
              flexShrink: 0,
            }}
          >
            {showCall && (
              <button
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 7,
                  padding: '11px 14px',
                  borderRadius: 11,
                  border: `1px solid ${c.border}`,
                  background: c.surface,
                  cursor: 'pointer',
                  flexShrink: 0,
                }}
              >
                <I.calendar size={15} color={c.textSecondary} />
                <span style={{ fontSize: 13, fontWeight: 600, color: c.textSecondary }}>
                  {callLabel}
                </span>
              </button>
            )}
            {proposalCta && (
              <button
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 8,
                  padding: '12px 16px',
                  borderRadius: 11,
                  border: ctaQuiet ? `1px solid ${c.primaryBorder}` : 'none',
                  background: ctaQuiet ? c.primaryLight : c.gradient,
                  cursor: 'pointer',
                  flex: 1,
                  boxShadow: ctaQuiet ? 'none' : `0 2px 12px ${c.primaryGlow}`,
                }}
              >
                <I.fileText size={15} color={ctaQuiet ? c.primary : 'white'} />
                <span
                  style={{ fontSize: 14, fontWeight: 700, color: ctaQuiet ? c.primary : 'white' }}
                >
                  {proposalCta.label}
                </span>
              </button>
            )}
          </div>
        )}

        {/* Files bottom sheet */}
        <BottomSheet
          open={filesOpen}
          onClose={() => setFilesOpen(false)}
          title="Shared in this conversation"
        >
          {FilesList}
        </BottomSheet>

        {/* Overflow sheet — genuinely secondary only (primary actions now live in the sticky bar) */}
        <BottomSheet open={menuOpen} onClose={() => setMenuOpen(false)} title={thread.name}>
          <SheetAction
            icon={I.user}
            label={`View ${thread.name.split(' ')[0]}'s profile`}
            sub="Background, ratings, past work"
            color={c.accent}
            onClick={() => setMenuOpen(false)}
          />
          {lens === 'client' && proposalRequested && !proposalSubmitted && (
            <div
              style={{
                padding: '12px 14px',
                borderRadius: 12,
                background: c.warningLight,
                border: `1px solid ${c.warningBorder}`,
                marginTop: 8,
                display: 'flex',
                alignItems: 'center',
                gap: 10,
              }}
            >
              <I.clock size={15} color={c.warning} />
              <span style={{ fontSize: 13, fontWeight: 600, color: c.warning }}>
                Proposal requested — awaiting submission
              </span>
            </div>
          )}
        </BottomSheet>
      </div>
    );
  }

  // ════════════════════ DESKTOP ════════════════════
  return (
    <Card
      style={{
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 520,
        position: 'relative',
        ...{ animation: 'layoutFlip 0.4s ease-out both' },
      }}
    >
      {TabStrip}

      {/* Active thread header — name + Files pill + call + first-class proposal action */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '12px 16px',
          borderBottom: `1px solid ${c.borderSubtle}`,
        }}
      >
        <Avatar initials={thread.initials} color={thread.color} size={36} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <p style={{ fontSize: 14, fontWeight: 650, color: c.text, margin: 0 }}>
              {thread.name}
              {thread.self && (
                <span style={{ fontSize: 11, color: c.accent, marginLeft: 6 }}>(you)</span>
              )}
            </p>
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 3,
                fontSize: 11,
                color: c.textTertiary,
              }}
            >
              <I.star size={10} color={c.warning} />
              {thread.rating}
            </span>
          </div>
          <p
            style={{
              fontSize: 12,
              color: c.textTertiary,
              margin: '1px 0 0',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {thread.role}
          </p>
        </div>

        <button
          onClick={() => setFilesOpen((v) => !v)}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '7px 12px',
            borderRadius: 9,
            border: `1px solid ${filesOpen ? c.primaryBorder : c.border}`,
            background: filesOpen ? c.primaryLight : c.surface,
            cursor: 'pointer',
            flexShrink: 0,
          }}
        >
          <I.paperclip size={13} color={filesOpen ? c.primary : c.textSecondary} />
          <span
            style={{
              fontSize: 12.5,
              fontWeight: 600,
              color: filesOpen ? c.primary : c.textSecondary,
            }}
          >
            Files
          </span>
          {files.length > 0 && (
            <span
              style={{
                fontSize: 11,
                fontWeight: 700,
                color: filesOpen ? c.primary : c.textTertiary,
                background: filesOpen ? c.surface : c.surfaceSubtle,
                borderRadius: 10,
                padding: '1px 7px',
                minWidth: 18,
                textAlign: 'center',
              }}
            >
              {files.length}
            </span>
          )}
        </button>

        {callAllowed && (
          <button
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '7px 13px',
              borderRadius: 9,
              border: `1px solid ${c.border}`,
              background: c.surface,
              cursor: 'pointer',
              flexShrink: 0,
            }}
          >
            <I.calendar size={13} color={c.textSecondary} />
            <span style={{ fontSize: 12.5, fontWeight: 650, color: c.textSecondary }}>
              {callLabel}
            </span>
          </button>
        )}

        {showProposalAction &&
          (() => {
            if (lens === 'client' && proposalRequested && !proposalSubmitted)
              return (
                <Pill color={c.warning} bg={c.warningLight} border={c.warningBorder} icon={I.clock}>
                  Proposal requested
                </Pill>
              );
            if (lens === 'expert' && !proposalRequested)
              return <Pill color={c.textTertiary}>Awaiting proposal request</Pill>;
            if (proposalSubmitted)
              return (
                <button
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: '7px 13px',
                    borderRadius: 9,
                    border: `1px solid ${c.primaryBorder}`,
                    background: c.primaryLight,
                    cursor: 'pointer',
                    flexShrink: 0,
                  }}
                >
                  <I.fileText size={13} color={c.primary} />
                  <span style={{ fontSize: 12.5, fontWeight: 650, color: c.primary }}>
                    {lens === 'expert' ? 'View submitted' : 'View proposal'}
                  </span>
                </button>
              );
            const quiet = nudgeIsProposal;
            return (
              <button
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '8px 15px',
                  borderRadius: 9,
                  border: quiet ? `1px solid ${c.primaryBorder}` : 'none',
                  background: quiet ? c.primaryLight : c.gradient,
                  cursor: 'pointer',
                  flexShrink: 0,
                  boxShadow: quiet ? 'none' : `0 2px 10px ${c.primaryGlow}`,
                }}
              >
                <I.fileText size={14} color={quiet ? c.primary : 'white'} />
                <span style={{ fontSize: 13, fontWeight: 700, color: quiet ? c.primary : 'white' }}>
                  {proposalLabel}
                </span>
              </button>
            );
          })()}
      </div>

      {/* Files drawer — slides over the thread from the right */}
      {filesOpen && (
        <div
          style={{
            position: 'absolute',
            top: single ? 61 : 105,
            right: 0,
            bottom: 0,
            width: 320,
            background: c.surface,
            borderLeft: `1px solid ${c.border}`,
            boxShadow: '-8px 0 24px rgba(0,0,0,0.06)',
            zIndex: 5,
            display: 'flex',
            flexDirection: 'column',
            animation: 'fadeIn 0.2s ease-out both',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '14px 16px',
              borderBottom: `1px solid ${c.borderSubtle}`,
            }}
          >
            <SectionLabel icon={I.paperclip} color={c.primary}>
              Shared in this conversation
            </SectionLabel>
            <button
              onClick={() => setFilesOpen(false)}
              style={{
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                padding: 4,
                display: 'flex',
                marginTop: -8,
              }}
            >
              <I.x size={15} color={c.textTertiary} />
            </button>
          </div>
          <div style={{ flex: 1, overflowY: 'auto', padding: '10px 12px' }}>{FilesList}</div>
        </div>
      )}

      {nudge && (
        <div style={{ padding: '14px 18px 0' }}>
          <NudgeBar {...nudge} compact />
        </div>
      )}

      <div
        style={{
          flex: 1,
          padding: '16px 18px',
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
          overflowY: 'auto',
        }}
      >
        {Messages}
      </div>

      {Composer}
    </Card>
  );
}

function expertSelfNudge(status) {
  const i = sIdx(status);
  if (i === sIdx('eoi_submitted'))
    return {
      variant: 'action',
      icon: I.calendar,
      headline: 'Offer Dana a time to talk',
      sub: "Clients don't share calendars — propose a couple of times to get ahead of the other expert.",
      primary: { label: 'Propose meeting times', icon: I.calendar },
      secondary: { label: 'Send a message', icon: I.messageSquare },
    };
  if (i === sIdx('proposal_requested'))
    return {
      variant: 'action',
      icon: I.fileText,
      headline: 'Dana requested your proposal — build it',
      sub: "You're 1 of 2 asked to propose. Deliverables, exclusions, terms, payment schedule.",
      primary: { label: 'Build proposal', icon: I.fileText },
    };
  if (i === sIdx('proposal_submitted'))
    return {
      variant: 'waiting',
      icon: I.clock,
      headline: 'Your proposal is with Dana',
      sub: "She's reviewing yours alongside one other. Keep the conversation warm.",
      secondary: { label: 'Send a message', icon: I.messageSquare },
    };
  if (i === sIdx('accepted'))
    return {
      variant: 'action',
      icon: I.dollarSign,
      headline: 'Confirm payment terms for kickoff',
      sub: 'Dana accepted your proposal. Confirm 30% upfront so Balo can invoice and kick off.',
      primary: { label: 'Confirm payment terms', icon: I.check },
    };
  if (i >= sIdx('kickoff_approved'))
    return {
      variant: 'done',
      icon: I.zap,
      headline: 'Kicked off — time to deliver',
      sub: 'Milestones are in the workspace. Mark them done as you go.',
      primary: { label: 'Open workspace', icon: I.briefcase },
    };
  return null;
}

// ── Admin observer layout ────────────────────────────────────────
function AdminHealthPanel({ status }) {
  const i = sIdx(status);
  const rows = THREADS.map((t) => {
    let state,
      color,
      flag = null;
    if (i < sIdx('experts_invited')) {
      state = 'Not invited';
      color = c.textTertiary;
    } else if (i === sIdx('experts_invited')) {
      state = 'Invited · awaiting EOI';
      color = c.warning;
      if (t.id === 'sofia') flag = 'Quiet 4 days';
    } else if (i === sIdx('eoi_submitted')) {
      state = t.id === 'sofia' ? 'No EOI yet' : 'EOI in · talking';
      color = t.id === 'sofia' ? c.warning : c.success;
      if (t.id === 'sofia') flag = 'Consider removing';
    } else if (i === sIdx('proposal_requested')) {
      state = t.id === 'sofia' ? 'Not requested' : 'Proposal requested';
      color = t.id === 'sofia' ? c.textTertiary : c.primary;
    } else if (i === sIdx('proposal_submitted')) {
      state = t.id === 'sofia' ? 'Declined' : 'Proposal in';
      color = t.id === 'sofia' ? c.textTertiary : c.primary;
    } else {
      state =
        t.id === 'priya'
          ? i >= sIdx('kickoff_approved')
            ? 'Kicked off'
            : 'Accepted'
          : t.id === 'marcus'
            ? 'Not selected'
            : 'Declined';
      color = t.id === 'priya' ? c.success : c.textTertiary;
    }
    return { t, state, color, flag };
  });
  return (
    <Card style={{ padding: '18px 20px', ...slideUp(0.08) }}>
      <SectionLabel icon={I.activity} color={c.cyan}>
        Pipeline health
      </SectionLabel>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {rows.map(({ t, state, color, flag }) => (
          <div
            key={t.id}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '10px 12px',
              borderRadius: 10,
              border: `1px solid ${flag ? c.warningBorder : c.borderSubtle}`,
              background: flag ? c.warningLight : c.surface,
            }}
          >
            <Avatar initials={t.initials} color={t.color} size={32} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <p style={{ fontSize: 13, fontWeight: 600, color: c.text, margin: 0 }}>{t.name}</p>
              <p style={{ fontSize: 11.5, color, margin: '1px 0 0', fontWeight: 500 }}>{state}</p>
            </div>
            {flag && (
              <Pill
                color={c.warning}
                bg={c.warningLight}
                border={c.warningBorder}
                icon={I.alertCircle}
              >
                {flag}
              </Pill>
            )}
            {i >= sIdx('experts_invited') && i < sIdx('proposal_requested') && (
              <button
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: 8,
                  border: `1px solid ${c.border}`,
                  background: c.surface,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                }}
              >
                <I.x size={13} color={c.textTertiary} />
              </button>
            )}
          </div>
        ))}
        {i >= sIdx('experts_invited') && i < sIdx('proposal_requested') && (
          <button
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 7,
              padding: '10px',
              borderRadius: 10,
              border: `1px dashed ${c.border}`,
              background: 'transparent',
              cursor: 'pointer',
              fontSize: 13,
              fontWeight: 550,
              color: c.textSecondary,
            }}
          >
            <I.plus size={14} color={c.textSecondary} />
            Invite another expert
          </button>
        )}
      </div>
    </Card>
  );
}

function adminNudge(status) {
  const i = sIdx(status);
  if (i === sIdx('requested'))
    return {
      variant: 'action',
      icon: I.sparkles,
      headline: 'Triage this new request',
      sub: "Northwind's brief looks detailed. Invite experts now, or request an exploratory call to sharpen scope first.",
      primary: { label: 'Invite experts', icon: I.users },
      secondary: { label: 'Request exploratory call', icon: I.calendar },
    };
  if (i === sIdx('exploratory'))
    return {
      variant: 'action',
      icon: I.calendar,
      headline: 'Exploratory call requested — awaiting client booking',
      sub: 'You asked Dana to book a scoping call (mocked for now). Once scope is clear, invite experts.',
      primary: { label: 'Invite experts', icon: I.users },
      secondary: { label: 'Mark call complete', icon: I.check },
    };
  if (i === sIdx('experts_invited'))
    return {
      variant: 'waiting',
      icon: I.clock,
      headline: '3 experts invited — awaiting EOIs',
      sub: "Sofia's gone quiet (4 days). Nudge her or invite an alternate.",
      secondary: { label: 'Invite another', icon: I.plus },
    };
  if (i === sIdx('eoi_submitted'))
    return {
      variant: 'waiting',
      icon: I.clock,
      headline: 'Client & experts are connecting',
      sub: "Priya and Marcus are talking to Dana. Sofia hasn't engaged — consider removing. Step back in at proposals.",
      secondary: { label: 'View activity', icon: I.messageSquare },
    };
  if (i === sIdx('proposal_requested'))
    return {
      variant: 'waiting',
      icon: I.clock,
      headline: 'Proposals requested from 2 experts (cap reached)',
      sub: "Awaiting Priya's and Marcus's submissions.",
    };
  if (i === sIdx('proposal_submitted'))
    return {
      variant: 'waiting',
      icon: I.clock,
      headline: 'Client is reviewing proposals',
      sub: 'Both in. Dana is deciding. The acceptance + kickoff chase lands with you next.',
    };
  if (i === sIdx('accepted'))
    return {
      variant: 'action',
      icon: I.dollarSign,
      headline: 'Chase upfront invoice, then approve kickoff',
      sub: "Dana accepted Priya's proposal (30% upfront, A$17,400). Confirm payment settled, then approve.",
      primary: { label: 'Approve for kickoff', icon: I.check },
      secondary: { label: 'View invoice status', icon: I.dollarSign },
    };
  return {
    variant: 'done',
    icon: I.zap,
    headline: 'Project kicked off',
    sub: "Northwind ↔ Priya is now a live project. It's left the request pipeline.",
  };
}

// ── Client/expert global nudge (Phase 1, or whole-request moves) ──
function participantGlobalNudge(lens, status) {
  const i = sIdx(status);
  if (lens === 'client') {
    if (i === sIdx('requested'))
      return {
        variant: 'waiting',
        icon: I.clock,
        headline: "We're reviewing your request",
        sub: 'Balo is checking your brief and lining up the right experts — usually within one business day. You can strengthen it while you wait.',
        secondary: { label: 'Add more detail', icon: I.plus },
      };
    if (i === sIdx('exploratory'))
      return {
        variant: 'action',
        icon: I.calendar,
        headline: 'Book your exploratory call with Balo',
        sub: 'A 20-min call helps us match you precisely. Pick a time that suits you.',
        primary: { label: 'Book exploratory call', icon: I.calendar },
      };
    if (i === sIdx('experts_invited'))
      return {
        variant: 'waiting',
        icon: I.clock,
        headline: 'Experts are reviewing your request',
        sub: "We've invited 3 specialists. You'll be notified the moment one expresses interest.",
        secondary: { label: 'Message Balo', icon: I.messageSquare },
      };
    if (i === sIdx('accepted'))
      return {
        variant: 'action',
        icon: I.fileText,
        headline: 'Add your billing details to start kickoff',
        sub: 'Almost there. We need company billing details to raise the first invoice — about a minute.',
        primary: { label: 'Add billing details', icon: I.arrowRight },
      };
  }
  if (lens === 'expert') {
    if (i < sIdx('experts_invited')) return null; // gated handled separately
    if (i === sIdx('experts_invited'))
      return {
        variant: 'action',
        icon: I.send,
        headline: "You're invited — submit your expression of interest",
        sub: "Balo thinks you're a strong fit for this CPQ migration. A short, specific EOI starts the conversation.",
        primary: { label: 'Write your EOI', icon: I.send },
        secondary: { label: 'Re-read the brief', icon: I.fileText },
      };
  }
  return null;
}

// ── Main ─────────────────────────────────────────────────────────
// ── Mobile body: Request Details bottom sheet for Phase 2 ────────
function MobileRequestSheet({ open, onClose, lens }) {
  return (
    <BottomSheet open={open} onClose={onClose} title="Request details">
      <RequestContext lens={lens} compact />
    </BottomSheet>
  );
}

export default function ProjectRequestDetailResponsive() {
  const [actor, setActor] = useState('client');
  const [status, setStatus] = useState('eoi_submitted');
  const [mobile, setMobile] = useState(false); // prototype viewport toggle (real impl: ~768px breakpoint)
  const [reqSheet, setReqSheet] = useState(false); // mobile Phase-2 request-details sheet
  const am = ACTORS.find((a) => a.key === actor);
  const i = sIdx(status);

  const isObserver = am.archetype === 'observer';
  const phase2 = i >= PHASE2_FROM;
  const expertGated = actor === 'expert' && i < sIdx('experts_invited');

  // ── Body content (shared logic, layout differs by `mobile`) ──
  const lensLine = (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        marginBottom: 16,
        flexWrap: 'wrap',
        ...fadeIn(0),
      }}
    >
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          fontSize: 12,
          color: c.textSecondary,
          padding: '5px 11px',
          borderRadius: 20,
          background: `${am.color}10`,
          border: `1px solid ${am.color}25`,
        }}
      >
        <am.icon size={12} color={am.color} />
        Viewing as <strong style={{ color: am.color, fontWeight: 650 }}>{am.label}</strong>
      </span>
      {!mobile && <span style={{ fontSize: 12, color: c.textTertiary }}>{am.sub}</span>}
      {!isObserver && (
        <span
          style={{
            fontSize: 11,
            color: c.textTertiary,
            marginLeft: 'auto',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
          }}
        >
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: phase2 ? c.accent : c.primary,
            }}
          />
          {phase2 ? 'Phase 2 — conversation' : 'Phase 1 — request'}
        </span>
      )}
    </div>
  );

  // ════════════════════ MOBILE LAYOUT ════════════════════
  if (mobile) {
    const PhoneFrame = ({ children }) => (
      <div
        style={{
          width: 390,
          height: 800,
          margin: '0 auto',
          background: c.bg,
          borderRadius: 36,
          border: `10px solid #0F1729`,
          boxShadow: '0 20px 60px rgba(0,0,0,0.25)',
          overflow: 'hidden',
          position: 'relative',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {/* status notch */}
        <div style={{ height: 28, background: '#0F1729', flexShrink: 0 }} />
        <div
          style={{
            flex: 1,
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
            position: 'relative',
            overflow: 'hidden',
          }}
        >
          {children}
        </div>
      </div>
    );

    let inner;
    if (isObserver) {
      // Admin: stacked scroll — nudge, request summary, health panel
      inner = (
        <div
          style={{ flex: 1, overflowY: 'auto', padding: '14px 14px 28px' }}
          key={`m-admin-${status}`}
        >
          {lensLine}
          <div style={{ marginBottom: 16 }}>
            <NudgeBar {...adminNudge(status)} compact />
          </div>
          <div style={{ marginBottom: 16 }}>
            <RequestContext lens="admin" compact />
          </div>
          {i >= sIdx('experts_invited') && <AdminHealthPanel status={status} />}
        </div>
      );
    } else if (expertGated) {
      inner = (
        <div
          style={{ flex: 1, overflowY: 'auto', padding: '14px 14px 28px' }}
          key={`m-gated-${status}`}
        >
          {lensLine}
          <div style={{ marginBottom: 16 }}>
            <NudgeBar
              variant="waiting"
              icon={I.lock}
              headline="Not yet visible to you"
              sub="This request is still with the client and Balo admin. You'll be notified by email if you're invited."
              compact
            />
          </div>
          <Card style={{ padding: '36px 24px', textAlign: 'center' }}>
            <div
              style={{
                width: 48,
                height: 48,
                borderRadius: 13,
                background: c.surfaceSubtle,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                margin: '0 auto 14px',
              }}
            >
              <I.lock size={22} color={c.textTertiary} />
            </div>
            <h3 style={{ fontSize: 16, fontWeight: 650, color: c.text, margin: 0 }}>
              Not open to experts yet
            </h3>
            <p style={{ fontSize: 13, color: c.textSecondary, margin: '8px 0 0', lineHeight: 1.6 }}>
              Balo is still scoping it with the client.
            </p>
          </Card>
        </div>
      );
    } else if (!phase2) {
      // Phase 1: request is the screen — single column scroll
      inner = (
        <div
          style={{ flex: 1, overflowY: 'auto', padding: '14px 14px 28px' }}
          key={`m-p1-${actor}-${status}`}
        >
          {lensLine}
          {participantGlobalNudge(actor, status) && (
            <div style={{ marginBottom: 16 }}>
              <NudgeBar {...participantGlobalNudge(actor, status)} compact />
            </div>
          )}
          <RequestContext lens={actor} compact />
        </div>
      );
    } else {
      // Phase 2: conversation is the screen. Slim request bar (→ sheet) + full-screen conversation.
      inner = (
        <div
          style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}
          key={`m-p2-${actor}-${status}`}
        >
          {/* optional whole-request global nudge (e.g. billing at accepted) — sits above the slim bar */}
          {participantGlobalNudge(actor, status) && (
            <div style={{ padding: '12px 12px 0', flexShrink: 0 }}>
              <NudgeBar {...participantGlobalNudge(actor, status)} compact />
            </div>
          )}
          {/* Slim request bar — orientation + tap to open details sheet */}
          <button
            onClick={() => setReqSheet(true)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              width: '100%',
              padding: '10px 14px',
              border: 'none',
              borderBottom: `1px solid ${c.borderSubtle}`,
              background: c.surface,
              cursor: 'pointer',
              textAlign: 'left',
              flexShrink: 0,
            }}
          >
            <div
              style={{
                width: 30,
                height: 30,
                borderRadius: 8,
                background: c.primaryLight,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}
            >
              <I.fileText size={14} color={c.primary} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <p
                style={{
                  fontSize: 11,
                  color: c.textTertiary,
                  margin: 0,
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                  fontWeight: 600,
                }}
              >
                Request
              </p>
              <p
                style={{
                  fontSize: 13,
                  fontWeight: 600,
                  color: c.text,
                  margin: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {REQUEST.title}
              </p>
            </div>
            <I.chevRight size={16} color={c.textTertiary} />
          </button>
          <ConversationStage lens={actor} status={status} mobile />
          <MobileRequestSheet open={reqSheet} onClose={() => setReqSheet(false)} lens={actor} />
        </div>
      );
    }

    return (
      <div
        style={{
          minHeight: '100vh',
          background: c.bg,
          fontFamily: "'DM Sans', -apple-system, BlinkMacSystemFont, sans-serif",
          paddingBottom: 40,
        }}
      >
        <style>{keyframes}</style>
        <link
          href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;650;700&display=swap"
          rel="stylesheet"
        />
        <ControlBar
          actor={actor}
          setActor={setActor}
          status={status}
          setStatus={setStatus}
          mobile={mobile}
          setMobile={setMobile}
        />
        <div style={{ padding: '24px 16px' }}>
          <PhoneFrame>{inner}</PhoneFrame>
        </div>
      </div>
    );
  }

  // ════════════════════ DESKTOP LAYOUT ════════════════════
  return (
    <div
      style={{
        minHeight: '100vh',
        background: c.bg,
        fontFamily: "'DM Sans', -apple-system, BlinkMacSystemFont, sans-serif",
      }}
    >
      <style>{keyframes}</style>
      <link
        href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;650;700&display=swap"
        rel="stylesheet"
      />
      <ControlBar
        actor={actor}
        setActor={setActor}
        status={status}
        setStatus={setStatus}
        mobile={mobile}
        setMobile={setMobile}
      />

      <div style={{ maxWidth: 1140, margin: '0 auto', padding: '24px 28px 80px' }}>
        {lensLine}

        {isObserver && (
          <div key={`admin-${status}`}>
            <div style={{ marginBottom: 18 }}>
              <NudgeBar {...adminNudge(status)} />
            </div>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'minmax(0,1.5fr) minmax(0,1fr)',
                gap: 20,
                alignItems: 'start',
              }}
            >
              <RequestContext lens="admin" />
              {i >= sIdx('experts_invited') && <AdminHealthPanel status={status} />}
            </div>
          </div>
        )}

        {!isObserver && expertGated && (
          <div key={`gated-${status}`}>
            <div style={{ marginBottom: 18 }}>
              <NudgeBar
                variant="waiting"
                icon={I.lock}
                headline="Not yet visible to you"
                sub="This request is still with the client and Balo admin. You'll be notified by email if you're invited to express interest."
              />
            </div>
            <Card style={{ padding: '48px 40px', textAlign: 'center', ...slideUp(0.1) }}>
              <div
                style={{
                  width: 52,
                  height: 52,
                  borderRadius: 14,
                  background: c.surfaceSubtle,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  margin: '0 auto 16px',
                }}
              >
                <I.lock size={24} color={c.textTertiary} />
              </div>
              <h3 style={{ fontSize: 17, fontWeight: 650, color: c.text, margin: 0 }}>
                This request isn't open to experts yet
              </h3>
              <p
                style={{
                  fontSize: 13,
                  color: c.textSecondary,
                  margin: '8px auto 0',
                  maxWidth: 380,
                  lineHeight: 1.6,
                }}
              >
                Balo is still scoping it with the client. If invited, you'll get an email with a
                direct link to express interest.
              </p>
            </Card>
          </div>
        )}

        {!isObserver && !expertGated && !phase2 && (
          <div key={`p1-${actor}-${status}`}>
            {participantGlobalNudge(actor, status) && (
              <div style={{ marginBottom: 18 }}>
                <NudgeBar {...participantGlobalNudge(actor, status)} />
              </div>
            )}
            <RequestContext lens={actor} />
          </div>
        )}

        {!isObserver && !expertGated && phase2 && (
          <div key={`p2-${actor}-${status}`}>
            {participantGlobalNudge(actor, status) && (
              <div style={{ marginBottom: 18 }}>
                <NudgeBar {...participantGlobalNudge(actor, status)} />
              </div>
            )}
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'minmax(0,1.7fr) minmax(0,1fr)',
                gap: 20,
                alignItems: 'start',
              }}
            >
              <ConversationStage lens={actor} status={status} />
              <RequestContext lens={actor} compact />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Control bar (prototype scaffolding — reviewer's tools, always desktop-styled) ──
function ControlBar({ actor, setActor, status, setStatus, mobile, setMobile }) {
  return (
    <div
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 20,
        background: c.surface,
        borderBottom: `1px solid ${c.border}`,
        padding: '12px 28px',
      }}
    >
      <div
        style={{
          maxWidth: 1140,
          margin: '0 auto',
          display: 'flex',
          alignItems: 'center',
          gap: 16,
          flexWrap: 'wrap',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span
            style={{
              fontSize: 11,
              fontWeight: 700,
              color: c.textTertiary,
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
            }}
          >
            Lens
          </span>
          <div
            style={{
              display: 'inline-flex',
              gap: 3,
              padding: 3,
              borderRadius: 10,
              background: c.surfaceSubtle,
            }}
          >
            {ACTORS.map((a) => {
              const on = actor === a.key;
              const AI = a.icon;
              return (
                <button
                  key={a.key}
                  onClick={() => setActor(a.key)}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: '7px 14px',
                    borderRadius: 7,
                    fontSize: 13,
                    fontWeight: on ? 650 : 500,
                    border: 'none',
                    cursor: 'pointer',
                    background: on ? c.surface : 'transparent',
                    color: on ? a.color : c.textTertiary,
                    boxShadow: on ? '0 1px 3px rgba(0,0,0,0.08)' : 'none',
                  }}
                >
                  <AI size={14} color={on ? a.color : c.textTertiary} />
                  {a.label}
                </button>
              );
            })}
          </div>
        </div>
        <div style={{ flex: 1, minWidth: 200 }}>
          <StatusStepper current={status} onPick={setStatus} />
        </div>
        {/* Viewport toggle */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span
            style={{
              fontSize: 11,
              fontWeight: 700,
              color: c.textTertiary,
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
            }}
          >
            View
          </span>
          <div
            style={{
              display: 'inline-flex',
              gap: 3,
              padding: 3,
              borderRadius: 10,
              background: c.surfaceSubtle,
            }}
          >
            {[
              { k: false, l: 'Desktop' },
              { k: true, l: 'Mobile' },
            ].map((v) => {
              const on = mobile === v.k;
              return (
                <button
                  key={v.l}
                  onClick={() => setMobile(v.k)}
                  style={{
                    padding: '7px 14px',
                    borderRadius: 7,
                    fontSize: 13,
                    fontWeight: on ? 650 : 500,
                    border: 'none',
                    cursor: 'pointer',
                    background: on ? c.surface : 'transparent',
                    color: on ? c.text : c.textTertiary,
                    boxShadow: on ? '0 1px 3px rgba(0,0,0,0.08)' : 'none',
                  }}
                >
                  {v.l}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
