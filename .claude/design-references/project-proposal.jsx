import { useState } from 'react';

// ══════════════════════════════════════════════════════════════════
// A6 — Proposal build → review → (changes loop) → accept → kickoff
// Tri-lens (Expert / Client / Admin), responsive. Continuous with the
// request-detail reference (tokens / icons / Northwind CPQ example).
//
// Lifecycle (stage switcher): Build → Submitted → Changes requested
//   → Accepted → Kicked off.  "Review" is the client's lens on Submitted.
//
// Decisions encoded this revision:
//   · Pricing METHOD is the first input (mode switch — reshapes milestones + terms).
//   · Deliverables = structured MILESTONES; description is RICH TEXT (lists etc.),
//     sanitised on ingest.
//   · Payment TERMS are phase-based; UI ADAPTS to method (Fixed → % splits of a
//     total; T&M → deposit + billed-against-time).
//   · Terms = FIXED Balo standard terms (non-editable, acknowledged on accept)
//     + expert's optional ADDITIONAL terms as an attached supplement.
//   · Proposal-scoped FILE ATTACHMENTS (3rd file scope — on `proposals`, R2 +
//     ClamAV; NOT conversation files, NOT request documents).
//   · Message / Book-a-call kept but DEMOTED to a secondary back-channel
//     (the document is the main object now, not the conversation).
//   · CHANGES loop is a real status: client → changes_requested (structured note)
//     → expert revises → resubmits as a new VERSION (v2). Per-proposal &
//     INDEPENDENT — requesting changes on Priya doesn't pause Marcus.
//   · Acceptance = heaviest commit → strongest confirm friction.
//   · Kickoff coordination board: client / expert / admin each see all three.
//   · Forward seam (annotation only): acceptance materialises an *engagement*
//     through a seam a future embedded/retainer product shares.
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
  arrowLeft: (p) => <Icon {...p} d="M19 12H5M12 19l-7-7 7-7" />,
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
  trash: (p) => (
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
      <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
    </svg>
  ),
  star: (p) => (
    <Icon
      {...p}
      d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14l-5-4.87 6.91-1.01L12 2z"
    />
  ),
  chevLeft: (p) => <Icon {...p} d="M15 18l-6-6 6-6" />,
  chevRight: (p) => <Icon {...p} d="M9 18l6-6-6-6" />,
  chevDown: (p) => <Icon {...p} d="M6 9l6 6 6-6" />,
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
  edit: (p) => (
    <Icon
      {...p}
      d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"
    />
  ),
  clipboard: (p) => (
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
      <rect x="8" y="2" width="8" height="4" rx="1" />
      <path d="M16 4h2a2 2 0 012 2v14a2 2 0 01-2 2H6a2 2 0 01-2-2V6a2 2 0 012-2h2" />
      <path d="M9 12l2 2 4-4" />
    </svg>
  ),
  layers: (p) => <Icon {...p} d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />,
  hourglass: (p) => (
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
      <path d="M5 22h14M5 2h14M17 22v-4.172a2 2 0 00-.586-1.414L12 12l-4.414 4.414A2 2 0 007 17.828V22M7 2v4.172a2 2 0 00.586 1.414L12 12l4.414-4.414A2 2 0 0017 6.172V2" />
    </svg>
  ),
  briefcase: (p) => (
    <Icon
      {...p}
      d="M20 7H4a2 2 0 00-2 2v10a2 2 0 002 2h16a2 2 0 002-2V9a2 2 0 00-2-2zM16 21V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v16"
    />
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
  paperclip: (p) => (
    <Icon
      {...p}
      d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"
    />
  ),
  list: (p) => <Icon {...p} d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />,
  link: (p) => (
    <Icon
      {...p}
      d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"
    />
  ),
  rotate: (p) => (
    <Icon
      {...p}
      d="M23 4v6h-6M1 20v-6h6M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"
    />
  ),
  history: (p) => (
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
      <path d="M3 3v5h5" />
      <path d="M3.05 13A9 9 0 106 5.3L3 8" />
      <path d="M12 7v5l4 2" />
    </svg>
  ),
};

const keyframes = `
@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
@keyframes slideUp { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: translateY(0); } }
@keyframes scaleIn { from { opacity: 0; transform: scale(0.97); } to { opacity: 1; transform: scale(1); } }
@keyframes nudgePulse { 0%,100% { box-shadow: 0 2px 12px rgba(37,99,235,0.22); } 50% { box-shadow: 0 2px 20px rgba(37,99,235,0.40); } }
@keyframes backdropIn { from { opacity: 0; } to { opacity: 1; } }
@keyframes growBar { from { transform: scaleX(0); } to { transform: scaleX(1); } }
.balo-xscroll { overflow-x: auto; -webkit-overflow-scrolling: touch; scrollbar-width: none; flex-wrap: nowrap; }
.balo-xscroll::-webkit-scrollbar { display: none; }
.balo-rt { font-size: 13.5px; color: ${c.text}; line-height: 1.6; }
.balo-rt p { margin: 0 0 6px; }
.balo-rt ul { margin: 4px 0 6px; padding-left: 18px; }
.balo-rt li { margin: 2px 0; }
.balo-rt strong { font-weight: 700; }
`;
const slideUp = (d = 0) => ({ animation: `slideUp 0.4s ease-out ${d}s both` });
const fadeIn = (d = 0) => ({ animation: `fadeIn 0.35s ease-out ${d}s both` });
const scaleIn = (d = 0) => ({ animation: `scaleIn 0.3s ease-out ${d}s both` });

const STAGES = [
  { key: 'build', short: 'Build', sub: 'Expert composes the proposal' },
  { key: 'submitted', short: 'Submitted', sub: 'Client reviews & decides' },
  {
    key: 'changes_requested',
    short: 'Changes req.',
    sub: 'Client asked for changes — expert revises',
  },
  { key: 'accepted', short: 'Accepted', sub: 'Kickoff coordination' },
  { key: 'kickoff', short: 'Kicked off', sub: 'Live project' },
];
const ACTORS = [
  {
    key: 'expert',
    label: 'Expert',
    icon: I.shield,
    color: c.accent,
    sub: 'You — Priya, CPQ Specialist',
  },
  {
    key: 'client',
    label: 'Client',
    icon: I.user,
    color: c.primary,
    sub: 'Dana — RevOps Lead, Northwind Industrial',
  },
  { key: 'admin', label: 'Admin', icon: I.users, color: c.cyan, sub: 'Balo — kickoff gate' },
];
const fmt = (n) => 'A$' + n.toLocaleString('en-AU');

// ── Worked example ───────────────────────────────────────────────
const PRIYA = {
  id: 'priya',
  expert: 'Priya Nair',
  initials: 'PN',
  company: 'Independent',
  color: c.accent,
  rating: 4.9,
  version: 1,
  summary:
    "A staged Salesforce CPQ (Revenue Cloud) implementation to replace Northwind's legacy quoting tool — sandbox-first migration of ~1,200 price records, configurable bundles with tiered volume pricing, an approval matrix for non-standard discounts, and enablement for your 2-person admin team.",
  pricingMethod: 'fixed',
  total: 58000,
  timeline: '~10 weeks',
  milestones: [
    {
      title: 'Discovery & solution design',
      html: '<p>Workshops, current-state audit, and target CPQ architecture. Deliverables:</p><ul><li>Solution design document</li><li>Data migration plan (~1,200 records)</li><li>Risk register</li></ul>',
      accept: 'Signed-off design doc + migration plan.',
      value: 9000,
    },
    {
      title: 'Sandbox build & price-record migration',
      html: '<p>Configure bundles, tiered pricing, and the approval matrix; migrate records to sandbox and validate on a 50-SKU sample.</p>',
      accept: 'Sandbox passes validation on agreed SKU set.',
      value: 23000,
    },
    {
      title: 'UAT & production cutover',
      html: '<p>User acceptance testing, fixes, production deploy, and go-live support.</p>',
      accept: 'Production live; UAT sign-off.',
      value: 18000,
    },
    {
      title: 'Admin enablement & handover',
      html: '<p>Training for the 2-person admin team, runbooks, and 2 weeks hypercare.</p>',
      accept: 'Team trained; handover docs delivered.',
      value: 8000,
    },
  ],
  exclusions:
    'Salesforce Billing (CPQ standalone only). Net-new integrations beyond the existing ERP sync. Data cleansing of source records prior to migration.',
  terms: [
    { label: 'Upfront', pct: 30, when: 'On acceptance, before kickoff' },
    { label: 'On delivery', pct: 70, when: 'On production go-live & UAT sign-off' },
  ],
  attachments: [
    { name: 'Priya — additional terms.pdf', size: '120 KB', kind: 'terms' },
    { name: 'Reference: prior CPQ rollout (case study).pdf', size: '2.1 MB', kind: 'ref' },
  ],
};
const MARCUS = {
  id: 'marcus',
  expert: 'Marcus Lee',
  initials: 'ML',
  company: 'Lee Consulting',
  color: c.primary,
  rating: 4.8,
  version: 1,
  summary:
    'End-to-end Revenue Cloud CPQ rollout with a fixed-price migration. Emphasis on a clean approval-matrix design and a parallel-run cutover to de-risk go-live, with a heavier enablement block.',
  pricingMethod: 'fixed',
  total: 62000,
  timeline: '~12 weeks',
  milestones: [
    {
      title: 'Discovery & architecture',
      html: '<p>Requirements, CPQ data model, migration strategy.</p>',
      accept: 'Approved architecture.',
      value: 11000,
    },
    {
      title: 'Build & migrate',
      html: '<p>Bundles, pricing, approvals; full record migration with parallel-run validation.</p>',
      accept: 'Parallel run reconciles.',
      value: 27000,
    },
    {
      title: 'Cutover & hypercare',
      html: '<p>Go-live, 3 weeks hypercare.</p>',
      accept: 'Live + hypercare complete.',
      value: 14000,
    },
    {
      title: 'Enablement',
      html: '<p>Extended admin training + certification path.</p>',
      accept: 'Team certified.',
      value: 10000,
    },
  ],
  exclusions:
    'Salesforce Billing. Source-system data cleansing. Custom Lightning components beyond CPQ config.',
  terms: [
    { label: 'Upfront', pct: 25, when: 'On acceptance' },
    { label: 'On delivery', pct: 75, when: 'On go-live' },
  ],
  attachments: [{ name: 'Lee Consulting — MSA addendum.pdf', size: '98 KB', kind: 'terms' }],
};

// ── Primitives ───────────────────────────────────────────────────
function Card({ children, style: xs, onClick, hover }) {
  const [h, setH] = useState(false);
  return (
    <div
      onClick={onClick}
      onMouseEnter={hover ? () => setH(true) : undefined}
      onMouseLeave={hover ? () => setH(false) : undefined}
      style={{
        background: c.surface,
        borderRadius: 16,
        border: `1px solid ${h ? c.primaryBorder : c.border}`,
        boxShadow: h ? `0 4px 20px ${c.primaryGlow}` : '0 1px 3px rgba(0,0,0,0.04)',
        transition: 'all 0.25s',
        cursor: onClick ? 'pointer' : undefined,
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
      <IC size={14} color={color} />
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
function Pill({ children, color = c.textSecondary, bg = c.surfaceSubtle, border, icon: IC }) {
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
        border: border ? `1px solid ${border}` : 'none',
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
        background: `${color}18`,
        border: `1px solid ${color}35`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        fontSize: size * 0.34,
        fontWeight: 700,
        color,
      }}
    >
      {initials}
    </div>
  );
}
function Btn({ children, icon: IC, variant = 'primary', onClick, style: xs, disabled, full }) {
  const [h, setH] = useState(false);
  const base = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    padding: '11px 20px',
    borderRadius: 11,
    fontSize: 14,
    fontWeight: 650,
    cursor: disabled ? 'not-allowed' : 'pointer',
    border: 'none',
    transition: 'all 0.2s',
    opacity: disabled ? 0.5 : 1,
    width: full ? '100%' : undefined,
  };
  const styles = {
    primary: {
      background: h && !disabled ? c.primaryDark : c.primary,
      color: 'white',
      boxShadow: `0 2px 10px ${c.primaryGlow}`,
    },
    gradient: {
      background: c.gradient,
      color: 'white',
      boxShadow: h && !disabled ? '0 4px 16px rgba(37,99,235,0.3)' : `0 2px 10px ${c.primaryGlow}`,
    },
    warm: {
      background: c.gradientWarm,
      color: 'white',
      boxShadow: '0 2px 12px rgba(5,150,105,0.25)',
    },
    ghost: {
      background: h ? c.surfaceSubtle : 'transparent',
      color: c.textSecondary,
      border: `1px solid ${c.border}`,
    },
    warn: {
      background: h ? c.warningLight : 'transparent',
      color: c.warning,
      border: `1px solid ${c.warningBorder}`,
    },
  };
  const ic = variant === 'ghost' ? c.textSecondary : variant === 'warn' ? c.warning : 'white';
  return (
    <button
      onClick={disabled ? undefined : onClick}
      onMouseEnter={() => setH(true)}
      onMouseLeave={() => setH(false)}
      disabled={disabled}
      style={{ ...base, ...styles[variant], ...xs }}
    >
      {IC && <IC size={15} color={ic} />}
      {children}
    </button>
  );
}
// Demoted back-channel — present, not first-class
function BackChannel({ name }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <button
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          padding: '8px 13px',
          borderRadius: 9,
          border: `1px solid ${c.border}`,
          background: c.surface,
          cursor: 'pointer',
          fontSize: 12.5,
          fontWeight: 600,
          color: c.textSecondary,
        }}
      >
        <I.messageSquare size={13} color={c.textSecondary} />
        Message {name}
      </button>
      <button
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          padding: '8px 13px',
          borderRadius: 9,
          border: `1px solid ${c.border}`,
          background: c.surface,
          cursor: 'pointer',
          fontSize: 12.5,
          fontWeight: 600,
          color: c.textSecondary,
        }}
      >
        <I.calendar size={13} color={c.textSecondary} />
        Book a call
      </button>
    </div>
  );
}

// ── Nudge ────────────────────────────────────────────────────────
function NudgeBar({
  variant = 'action',
  icon: IC = I.sparkles,
  headline,
  sub,
  primary,
  secondary,
}) {
  const tone = {
    action: { bg: c.gradientSubtle, border: c.primaryBorder, accent: c.primary, bar: c.gradient },
    waiting: { bg: c.warningLight, border: c.warningBorder, accent: c.warning, bar: c.warning },
    commit: { bg: c.surface, border: c.accentBorder, accent: c.accent, bar: c.gradient },
    done: { bg: c.successLight, border: c.successBorder, accent: c.success, bar: c.gradientWarm },
  }[variant];
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        padding: '16px 18px',
        borderRadius: 14,
        background: tone.bg,
        border: `1px solid ${tone.border}`,
        position: 'relative',
        overflow: 'hidden',
        ...(variant === 'commit' ? { animation: 'nudgePulse 2.6s ease-in-out infinite' } : {}),
      }}
    >
      <div
        style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 4, background: tone.bar }}
      />
      <div
        style={{
          width: 36,
          height: 36,
          borderRadius: 10,
          background: `${tone.accent}15`,
          border: `1px solid ${tone.accent}30`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
          marginLeft: 4,
        }}
      >
        <IC size={17} color={tone.accent} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <p style={{ fontSize: 14, fontWeight: 700, color: c.text, margin: 0 }}>{headline}</p>
        {sub && (
          <p style={{ fontSize: 12.5, color: c.textSecondary, margin: '2px 0 0', lineHeight: 1.5 }}>
            {sub}
          </p>
        )}
      </div>
      {(primary || secondary) && (
        <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
          {secondary && (
            <Btn
              variant="ghost"
              icon={secondary.icon}
              style={{ padding: '8px 14px', fontSize: 13 }}
            >
              {secondary.label}
            </Btn>
          )}
          {primary && (
            <Btn
              variant={variant === 'commit' ? 'gradient' : 'primary'}
              icon={primary.icon}
              style={{ padding: '9px 16px', fontSize: 13 }}
            >
              {primary.label}
            </Btn>
          )}
        </div>
      )}
    </div>
  );
}

// ── Standard terms block (fixed) + supplement note ───────────────
function TermsBlock({ p, editable }) {
  const supplement = p ? p.attachments.find((a) => a.kind === 'terms') : null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 11,
          padding: '13px 15px',
          borderRadius: 12,
          border: `1px solid ${c.borderSubtle}`,
          background: c.surfaceSubtle,
        }}
      >
        <div
          style={{
            width: 30,
            height: 30,
            borderRadius: 9,
            background: c.surface,
            border: `1px solid ${c.border}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
          }}
        >
          <I.lock size={14} color={c.textSecondary} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{ fontSize: 13.5, fontWeight: 650, color: c.text, margin: 0 }}>
            Balo standard terms apply
          </p>
          <p style={{ fontSize: 12, color: c.textTertiary, margin: '1px 0 0' }}>
            Platform engagement terms — IP, payment via Balo, disputes. Non-negotiable.
          </p>
        </div>
        <button
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            fontSize: 12.5,
            fontWeight: 600,
            color: c.primary,
            flexShrink: 0,
          }}
        >
          View
        </button>
      </div>
      {editable ? (
        <button
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '11px 14px',
            borderRadius: 11,
            border: `1px dashed ${c.border}`,
            background: 'transparent',
            cursor: 'pointer',
            color: c.textSecondary,
            fontSize: 13,
            fontWeight: 600,
            width: '100%',
            justifyContent: 'center',
          }}
        >
          <I.paperclip size={14} color={c.textSecondary} /> Attach your additional terms (optional
          supplement)
        </button>
      ) : supplement ? (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 11,
            padding: '11px 14px',
            borderRadius: 12,
            border: `1px solid ${c.borderSubtle}`,
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
          <div style={{ flex: 1, minWidth: 0 }}>
            <p style={{ fontSize: 13, fontWeight: 600, color: c.text, margin: 0 }}>
              {supplement.name}
            </p>
            <p style={{ fontSize: 11.5, color: c.textTertiary, margin: 0 }}>
              {p.expert}'s additional terms · {supplement.size}
            </p>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ── Attachments (proposal-scoped — distinct from conv files / request docs) ──
function Attachments({ items, editable }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {items.map((f) => (
        <div
          key={f.name}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 11,
            padding: '11px 14px',
            borderRadius: 12,
            border: `1px solid ${c.borderSubtle}`,
            background: c.surface,
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
            <p style={{ fontSize: 11.5, color: c.textTertiary, margin: 0 }}>{f.size}</p>
          </div>
          {editable && (
            <button
              style={{
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                padding: 4,
                display: 'flex',
                flexShrink: 0,
              }}
            >
              <I.x size={13} color={c.textTertiary} />
            </button>
          )}
        </div>
      ))}
      {editable && (
        <button
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '11px 14px',
            borderRadius: 11,
            border: `1px dashed ${c.border}`,
            background: 'transparent',
            cursor: 'pointer',
            color: c.primary,
            fontSize: 13,
            fontWeight: 600,
            width: '100%',
            justifyContent: 'center',
          }}
        >
          <I.paperclip size={14} color={c.primary} /> Attach a file
        </button>
      )}
    </div>
  );
}

// ── Mini rich-text field (composer) — toolbar signals TipTap intent ──
function RichTextField({ defaultHTML, placeholder }) {
  return (
    <div
      style={{
        border: `1px solid ${c.border}`,
        borderRadius: 9,
        overflow: 'hidden',
        background: c.surface,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 2,
          padding: '5px 7px',
          borderBottom: `1px solid ${c.borderSubtle}`,
          background: c.surfaceSubtle,
        }}
      >
        {[
          { t: 'B', bold: true },
          { t: 'I', italic: true },
        ].map((b) => (
          <button
            key={b.t}
            style={{
              width: 26,
              height: 26,
              borderRadius: 6,
              border: 'none',
              background: 'transparent',
              cursor: 'pointer',
              fontSize: 13,
              fontWeight: 700,
              fontStyle: b.italic ? 'italic' : 'normal',
              color: c.textSecondary,
            }}
          >
            {b.t}
          </button>
        ))}
        <div style={{ width: 1, height: 16, background: c.border, margin: '0 4px' }} />
        <button
          style={{
            width: 26,
            height: 26,
            borderRadius: 6,
            border: 'none',
            background: 'transparent',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <I.list size={14} color={c.textSecondary} />
        </button>
        <button
          style={{
            width: 26,
            height: 26,
            borderRadius: 6,
            border: 'none',
            background: 'transparent',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <I.link size={13} color={c.textSecondary} />
        </button>
      </div>
      <div
        className="balo-rt"
        style={{ padding: '10px 12px', minHeight: 54 }}
        dangerouslySetInnerHTML={{
          __html: defaultHTML || `<p style="color:${c.textTertiary}">${placeholder || ''}</p>`,
        }}
      />
    </div>
  );
}

// ── Overview field — FULL TipTap (slash commands + selection bubble menu).
// Controls are CONTEXTUAL, not a persistent toolbar: bubble menu on text
// selection, slash menu on "/" — resting state is clean prose.
// Height behaviour: fixed comfortable working height (internal scroll) while
// focused; COLLAPSES to ~3 lines on blur when content is long, with a
// "Show full overview" affordance. (Prototype demonstrates focus/blur;
// production = real TipTap with measured-height animation.)
function OverviewField({ defaultHTML }) {
  const [focused, setFocused] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const open = focused || expanded;
  return (
    <div>
      <div
        tabIndex={0}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          setExpanded(false);
        }}
        style={{
          border: `1px solid ${focused ? c.primary : c.border}`,
          borderRadius: 11,
          background: c.surface,
          cursor: 'text',
          position: 'relative',
          overflow: 'hidden',
          boxShadow: focused ? `0 0 0 3px ${c.primaryGlow}` : 'none',
          transition: 'all 0.25s',
        }}
      >
        <div
          className="balo-rt"
          style={{
            padding: '12px 14px',
            maxHeight: open ? 220 : 76,
            overflowY: open ? 'auto' : 'hidden',
            transition: 'max-height 0.3s ease',
          }}
          dangerouslySetInnerHTML={{ __html: defaultHTML }}
        />
        {/* Collapsed fade + affordance */}
        {!open && (
          <div
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              bottom: 0,
              height: 40,
              background: 'linear-gradient(transparent, white 75%)',
              display: 'flex',
              alignItems: 'flex-end',
              justifyContent: 'center',
              paddingBottom: 6,
            }}
          >
            <button
              onClick={(e) => {
                e.stopPropagation();
                setExpanded(true);
              }}
              style={{
                background: c.surface,
                border: `1px solid ${c.border}`,
                borderRadius: 14,
                padding: '3px 12px',
                fontSize: 11.5,
                fontWeight: 600,
                color: c.primary,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: 5,
              }}
            >
              <I.chevDown size={11} color={c.primary} /> Show full overview
            </button>
          </div>
        )}
        {/* Selection bubble menu — shown while focused to demonstrate the contextual pattern */}
        {focused && (
          <div
            style={{
              position: 'absolute',
              top: 8,
              right: 10,
              display: 'flex',
              gap: 2,
              padding: 3,
              borderRadius: 9,
              background: '#1F2937',
              boxShadow: '0 4px 14px rgba(0,0,0,0.25)',
              ...fadeIn(0),
            }}
          >
            {['B', 'I', 'H2'].map((t) => (
              <button
                key={t}
                style={{
                  minWidth: 24,
                  height: 24,
                  borderRadius: 6,
                  border: 'none',
                  background: 'transparent',
                  cursor: 'pointer',
                  fontSize: 11.5,
                  fontWeight: 700,
                  color: '#E5E7EB',
                  padding: '0 6px',
                }}
              >
                {t}
              </button>
            ))}
            <button
              style={{
                width: 24,
                height: 24,
                borderRadius: 6,
                border: 'none',
                background: 'transparent',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <I.list size={13} color="#E5E7EB" />
            </button>
          </div>
        )}
      </div>
      <p
        style={{
          fontSize: 11.5,
          color: c.textTertiary,
          margin: '6px 2px 0',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
        }}
      >
        <I.zap size={11} color={c.textTertiary} /> Type{' '}
        <code
          style={{ background: c.surfaceSubtle, borderRadius: 4, padding: '0 5px', fontSize: 11 }}
        >
          /
        </code>{' '}
        for headings, lists & more · select text to format · collapses when you click away
      </p>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// READ-ONLY PROPOSAL DOCUMENT
// ══════════════════════════════════════════════════════════════════
function ProposalDoc({ p, sectionIdPrefix }) {
  const isTM = p.pricingMethod === 'tm';
  const sid = (k) =>
    sectionIdPrefix ? { id: sectionIdPrefix + k, style: { scrollMarginTop: 80 } } : {};
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <Avatar initials={p.initials} color={p.color} size={44} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{ fontSize: 15, fontWeight: 700, color: c.text, margin: 0 }}>
            {p.expert}{' '}
            <span style={{ fontSize: 12, fontWeight: 500, color: c.textTertiary }}>
              · {p.company}
            </span>
          </p>
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              fontSize: 12,
              color: c.textTertiary,
            }}
          >
            <I.star size={11} color={c.warning} />
            {p.rating} · CPQ Specialist
          </span>
        </div>
        {p.version > 1 && (
          <Pill color={c.accent} bg={c.accentLight} border={c.accentBorder} icon={I.history}>
            v{p.version} · revised
          </Pill>
        )}
        <Pill color={p.color} bg={`${p.color}12`} border={`${p.color}30`}>
          {isTM ? 'Time & Materials' : 'Fixed price'}
        </Pill>
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'flex-end',
          justifyContent: 'space-between',
          gap: 12,
          padding: '16px 18px',
          borderRadius: 14,
          background: c.gradientSubtle,
          border: `1px solid ${c.borderSubtle}`,
        }}
      >
        <div>
          <p
            style={{
              fontSize: 11,
              fontWeight: 700,
              color: c.textTertiary,
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              margin: 0,
            }}
          >
            {isTM ? 'Estimated total' : 'Fixed price'}
          </p>
          <p
            style={{
              fontSize: 30,
              fontWeight: 800,
              color: c.text,
              margin: '2px 0 0',
              lineHeight: 1,
            }}
          >
            {fmt(p.total)}
            {isTM && (
              <span style={{ fontSize: 14, fontWeight: 600, color: c.textTertiary }}> est.</span>
            )}
          </p>
        </div>
        <div style={{ textAlign: 'right' }}>
          <p
            style={{
              fontSize: 11,
              fontWeight: 700,
              color: c.textTertiary,
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              margin: 0,
            }}
          >
            Est. timeframe
          </p>
          <p style={{ fontSize: 16, fontWeight: 700, color: c.text, margin: '2px 0 0' }}>
            {p.timeline}
          </p>
        </div>
      </div>

      <div {...sid('overview')}>
        <SectionLabel icon={I.fileText} color={c.primary}>
          Overview
        </SectionLabel>
        <p style={{ fontSize: 14, color: c.text, lineHeight: 1.65, margin: 0 }}>{p.summary}</p>
      </div>

      <div {...sid('milestones')}>
        <SectionLabel icon={I.layers} color={c.accent}>
          Milestones &amp; deliverables
        </SectionLabel>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {p.milestones.map((m, i) => (
            <div
              key={i}
              style={{
                display: 'flex',
                gap: 12,
                padding: '14px 16px',
                borderRadius: 12,
                border: `1px solid ${c.borderSubtle}`,
                background: c.surface,
              }}
            >
              <div
                style={{
                  width: 26,
                  height: 26,
                  borderRadius: 8,
                  background: c.accentLight,
                  color: c.accent,
                  fontSize: 13,
                  fontWeight: 700,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                }}
              >
                {i + 1}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                  <p style={{ fontSize: 14, fontWeight: 650, color: c.text, margin: 0 }}>
                    {m.title}
                  </p>
                  {!isTM && (
                    <p
                      style={{
                        fontSize: 14,
                        fontWeight: 700,
                        color: c.text,
                        margin: 0,
                        flexShrink: 0,
                      }}
                    >
                      {fmt(m.value)}
                    </p>
                  )}
                </div>
                <div
                  className="balo-rt"
                  style={{ margin: '5px 0 0', color: c.textSecondary }}
                  dangerouslySetInnerHTML={{ __html: m.html }}
                />
                <p
                  style={{
                    fontSize: 12,
                    color: c.textTertiary,
                    margin: '6px 0 0',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 5,
                  }}
                >
                  <I.check size={12} color={c.success} />
                  Done when: {m.accept}
                </p>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div {...sid('payment')}>
        <SectionLabel icon={I.dollarSign} color={c.emerald}>
          Payment terms
        </SectionLabel>
        {isTM ? (
          <div
            style={{
              padding: '14px 16px',
              borderRadius: 12,
              border: `1px solid ${c.borderSubtle}`,
            }}
          >
            <p style={{ fontSize: 13.5, color: c.text, margin: 0, lineHeight: 1.6 }}>
              <strong>A$6,000 deposit</strong> on acceptance, then{' '}
              <strong>billed against time</strong> at the agreed rate, invoiced monthly.{' '}
              {fmt(p.total)} is an estimate, not a cap.
            </p>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div
              style={{
                display: 'flex',
                borderRadius: 10,
                overflow: 'hidden',
                height: 38,
                border: `1px solid ${c.borderSubtle}`,
              }}
            >
              {p.terms.map((t, i) => (
                <div
                  key={i}
                  style={{
                    flex: t.pct,
                    background: i === 0 ? c.gradient : c.surfaceSubtle,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    transformOrigin: 'left',
                    animation: 'growBar 0.5s ease-out both',
                    animationDelay: `${i * 0.08}s`,
                  }}
                >
                  <span
                    style={{
                      fontSize: 12.5,
                      fontWeight: 700,
                      color: i === 0 ? 'white' : c.textSecondary,
                    }}
                  >
                    {t.pct}%
                  </span>
                </div>
              ))}
            </div>
            {p.terms.map((t, i) => (
              <div
                key={i}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 10,
                  padding: '8px 4px',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span
                    style={{
                      width: 10,
                      height: 10,
                      borderRadius: 3,
                      background: i === 0 ? c.primary : c.border,
                    }}
                  />
                  <span style={{ fontSize: 13.5, fontWeight: 600, color: c.text }}>
                    {t.label} — {fmt(Math.round((p.total * t.pct) / 100))}
                  </span>
                </div>
                <span style={{ fontSize: 12.5, color: c.textTertiary }}>{t.when}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div {...sid('terms')}>
        <SectionLabel icon={I.shield} color={c.cyan}>
          Terms
        </SectionLabel>
        <TermsBlock p={p} editable={false} />
      </div>

      <div>
        <SectionLabel icon={I.alertCircle} color={c.warning}>
          Not included
        </SectionLabel>
        <p style={{ fontSize: 13.5, color: c.textSecondary, lineHeight: 1.6, margin: 0 }}>
          {p.exclusions}
        </p>
      </div>

      {p.attachments.filter((a) => a.kind !== 'terms').length > 0 && (
        <div {...sid('attachments')}>
          <SectionLabel icon={I.paperclip} color={c.textSecondary}>
            Attachments
          </SectionLabel>
          <Attachments items={p.attachments.filter((a) => a.kind !== 'terms')} editable={false} />
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// EXPERT — COMPOSER (tabbed sections + sticky live summary card)
// Lens-split rationale: authoring wants FOCUS (one section at a time);
// the summary card keeps the WHOLE in view so tabs never fragment it.
// ══════════════════════════════════════════════════════════════════
const COMPOSER_TABS = [
  { key: 'overview', label: 'Overview', icon: I.fileText },
  { key: 'milestones', label: 'Milestones', icon: I.layers },
  { key: 'pricing', label: 'Payment & terms', icon: I.dollarSign },
  { key: 'attachments', label: 'Attachments', icon: I.paperclip },
];

function ComposerSummaryCard({
  method,
  total,
  milestones,
  terms,
  termsSum,
  timeframe,
  revise,
  mobile,
  asSheet,
}) {
  const isTM = method === 'tm';
  const issues = [];
  if (!isTM && termsSum !== 100) issues.push(`Payment terms ${termsSum}% — must total 100%`);
  if (milestones.some((m) => !m.title)) issues.push('A milestone is missing a title');
  const ready = issues.length === 0;
  const rows = [
    { k: 'Pricing', v: isTM ? 'Time & Materials' : 'Fixed price' },
    { k: isTM ? 'Estimate' : 'Total', v: fmt(total) + (isTM ? ' est.' : '') },
    { k: 'Milestones', v: `${milestones.length}` },
    { k: 'Timeframe', v: `~${timeframe} weeks` },
    { k: 'Terms', v: isTM ? 'Deposit + monthly' : terms.map((t) => `${t.pct}%`).join(' / ') },
  ];
  return (
    <Card style={{ padding: '18px 18px', position: asSheet ? 'static' : 'sticky', top: 76 }}>
      <SectionLabel icon={I.clipboard} color={c.primary}>
        Proposal at a glance
      </SectionLabel>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 9, marginBottom: 14 }}>
        {rows.map((r) => (
          <div key={r.k} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
            <span style={{ color: c.textTertiary }}>{r.k}</span>
            <span style={{ fontWeight: 650, color: c.text, textAlign: 'right' }}>{r.v}</span>
          </div>
        ))}
      </div>
      <div
        style={{
          padding: '10px 12px',
          borderRadius: 10,
          background: ready ? c.successLight : c.warningLight,
          border: `1px solid ${ready ? c.successBorder : c.warningBorder}`,
          marginBottom: 14,
        }}
      >
        {ready ? (
          <span
            style={{
              fontSize: 12.5,
              fontWeight: 600,
              color: c.success,
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            <I.check size={13} color={c.success} />
            Ready to submit
          </span>
        ) : (
          <div>
            {issues.map((iss) => (
              <p
                key={iss}
                style={{
                  fontSize: 12,
                  color: c.warning,
                  margin: '2px 0',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                }}
              >
                <I.alertCircle size={12} color={c.warning} />
                {iss}
              </p>
            ))}
          </div>
        )}
      </div>
      <Btn
        variant="gradient"
        icon={revise ? I.rotate : I.send}
        disabled={!ready}
        full
        style={{ marginBottom: 8 }}
      >
        {revise ? 'Resubmit as v2' : 'Submit to Dana'}
      </Btn>
      <div style={{ display: 'flex', justifyContent: 'center' }}>
        <span
          style={{
            fontSize: 11.5,
            color: c.textTertiary,
            display: 'flex',
            alignItems: 'center',
            gap: 5,
          }}
        >
          <I.check size={11} color={c.textTertiary} />
          Saved as draft
        </span>
      </div>
    </Card>
  );
}

function ProposalComposer({ mobile, revise }) {
  const [tab, setTab] = useState('overview');
  const [method, setMethod] = useState('fixed');
  const [milestones, setMilestones] = useState(PRIYA.milestones.map((m) => ({ ...m })));
  const [terms, setTerms] = useState([
    { label: 'Upfront', pct: 30 },
    { label: 'On delivery', pct: 70 },
  ]);
  const [timeframe, setTimeframe] = useState(10);
  const [summarySheet, setSummarySheet] = useState(false); // mobile bottom-sheet
  const isTM = method === 'tm';
  const total = milestones.reduce((s, m) => s + (Number(m.value) || 0), 0);
  const termsSum = terms.reduce((s, t) => s + (Number(t.pct) || 0), 0);
  const setM = (i, k, v) =>
    setMilestones((ms) => ms.map((m, j) => (j === i ? { ...m, [k]: v } : m)));
  const input = {
    width: '100%',
    padding: '9px 12px',
    borderRadius: 9,
    fontSize: 13.5,
    border: `1px solid ${c.border}`,
    outline: 'none',
    background: c.surface,
    color: c.text,
    boxSizing: 'border-box',
    fontFamily: 'inherit',
  };
  const lbl = { fontSize: 12.5, fontWeight: 600, color: c.text, display: 'block', marginBottom: 5 };

  // ── Tab panes ──
  const panes = {
    overview: (
      <div>
        <div style={{ marginBottom: 22 }}>
          <SectionLabel icon={I.fileText} color={c.primary}>
            Overview
          </SectionLabel>
          <OverviewField
            defaultHTML={`<p>${PRIYA.summary}</p><p><strong>Why this approach:</strong></p><ul><li>Sandbox-first removes go-live risk on the 1,200-record migration</li><li>Approval matrix designed with finance up front, not retrofitted</li><li>Enablement runs alongside UAT so your admins learn on real data</li></ul>`}
          />
        </div>
        {/* Pricing method lives HERE — it must be set before Milestones, because it
            determines their shape (value column) and how payment terms work. */}
        <div style={{ marginBottom: 22 }}>
          <SectionLabel icon={I.dollarSign} color={c.emerald}>
            Pricing method
          </SectionLabel>
          <div style={{ display: mobile ? 'block' : 'flex', gap: 10 }}>
            {[
              { k: 'fixed', t: 'Fixed price', d: 'One agreed total, split into payments' },
              { k: 'tm', t: 'Time & Materials', d: 'Billed against time at a rate' },
            ].map((opt) => {
              const on = method === opt.k;
              return (
                <button
                  key={opt.k}
                  onClick={() => setMethod(opt.k)}
                  style={{
                    flex: 1,
                    width: mobile ? '100%' : undefined,
                    marginBottom: mobile ? 8 : 0,
                    textAlign: 'left',
                    padding: '13px 15px',
                    borderRadius: 11,
                    cursor: 'pointer',
                    border: `1.5px solid ${on ? c.primary : c.border}`,
                    background: on ? c.primaryLight : c.surface,
                    boxShadow: on ? `0 0 0 3px ${c.primaryGlow}` : 'none',
                    transition: 'all 0.2s',
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      marginBottom: 2,
                    }}
                  >
                    <span
                      style={{ fontSize: 13.5, fontWeight: 700, color: on ? c.primary : c.text }}
                    >
                      {opt.t}
                    </span>
                    {on && (
                      <div
                        style={{
                          width: 18,
                          height: 18,
                          borderRadius: '50%',
                          background: c.gradient,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                        }}
                      >
                        <I.check size={11} color="white" />
                      </div>
                    )}
                  </div>
                  <span style={{ fontSize: 11.5, color: on ? c.primary : c.textTertiary }}>
                    {opt.d}
                  </span>
                </button>
              );
            })}
          </div>
          <p
            style={{
              fontSize: 11.5,
              color: c.textTertiary,
              margin: '10px 0 0',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            <I.alertCircle size={12} color={c.textTertiary} />
            Sets the shape of your milestones and payment terms in the next tabs.
          </p>
        </div>
        <div style={{ marginBottom: 22 }}>
          <SectionLabel icon={I.clock} color={c.cyan}>
            Estimated timeframe
          </SectionLabel>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 13, color: c.textTertiary }}>~</span>
            <input
              value={timeframe}
              onChange={(e) => setTimeframe(Number(e.target.value) || 0)}
              style={{ ...input, width: 72, textAlign: 'center', fontWeight: 700 }}
            />
            <span style={{ fontSize: 13.5, color: c.textSecondary, fontWeight: 600 }}>weeks</span>
            <span style={{ fontSize: 11.5, color: c.textTertiary, marginLeft: 8 }}>
              Duration, not a date — delivery dates are derived once kickoff sets a start.
            </span>
          </div>
        </div>
        <div>
          <SectionLabel icon={I.alertCircle} color={c.warning}>
            Not included (optional)
          </SectionLabel>
          <textarea
            defaultValue={PRIYA.exclusions}
            rows={2}
            style={{ ...input, resize: 'vertical', lineHeight: 1.5 }}
          />
        </div>
      </div>
    ),
    milestones: (
      <div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 12,
          }}
        >
          <SectionLabel icon={I.layers} color={c.accent}>
            Milestones &amp; deliverables
          </SectionLabel>
          <span style={{ fontSize: 11, color: c.textTertiary }}>Feeds invoicing</span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {milestones.map((m, i) => (
            <div
              key={i}
              style={{
                padding: 14,
                borderRadius: 12,
                border: `1px solid ${c.borderSubtle}`,
                background: c.surfaceSubtle,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                <div
                  style={{
                    width: 24,
                    height: 24,
                    borderRadius: 7,
                    background: c.accentLight,
                    color: c.accent,
                    fontSize: 12,
                    fontWeight: 700,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                  }}
                >
                  {i + 1}
                </div>
                <input
                  defaultValue={m.title}
                  placeholder="Milestone title"
                  onChange={(e) => setM(i, 'title', e.target.value)}
                  style={{ ...input, fontWeight: 600, flex: 1 }}
                />
                {!isTM && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                    <span style={{ fontSize: 13, color: c.textTertiary }}>A$</span>
                    <input
                      defaultValue={m.value}
                      onChange={(e) => setM(i, 'value', e.target.value)}
                      style={{ ...input, width: 80, fontWeight: 600 }}
                    />
                  </div>
                )}
                <button
                  style={{
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    padding: 6,
                    display: 'flex',
                    flexShrink: 0,
                  }}
                >
                  <I.trash size={15} color={c.textTertiary} />
                </button>
              </div>
              <div style={{ marginBottom: 8 }}>
                <RichTextField defaultHTML={m.html} />
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                <I.check size={13} color={c.success} />
                <input
                  defaultValue={m.accept}
                  placeholder="Acceptance — done when…"
                  style={{ ...input, fontSize: 12.5 }}
                />
              </div>
            </div>
          ))}
        </div>
        <button
          onClick={() =>
            setMilestones((m) => [...m, { title: '', html: '', accept: '', value: 0 }])
          }
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 7,
            marginTop: 10,
            padding: '10px 14px',
            borderRadius: 10,
            border: `1px dashed ${c.border}`,
            background: 'transparent',
            cursor: 'pointer',
            color: c.primary,
            fontSize: 13,
            fontWeight: 600,
            width: '100%',
            justifyContent: 'center',
          }}
        >
          <I.plus size={15} color={c.primary} /> Add milestone
        </button>
      </div>
    ),
    pricing: (
      <div>
        {/* Pricing method now lives in Overview (it shapes milestones); this tab is payment terms + Balo terms. */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '10px 14px',
            borderRadius: 10,
            background: c.surfaceSubtle,
            marginBottom: 18,
          }}
        >
          <I.dollarSign size={14} color={c.textSecondary} />
          <span style={{ fontSize: 12.5, color: c.textSecondary }}>
            Pricing method:{' '}
            <strong style={{ color: c.text }}>{isTM ? 'Time & Materials' : 'Fixed price'}</strong> —
            change it in the Overview tab.
          </span>
        </div>

        {/* Payment terms — adapts */}
        <div style={{ marginBottom: 22 }}>
          <SectionLabel icon={I.clock} color={c.cyan}>
            Payment terms
          </SectionLabel>
          {isTM ? (
            <div
              style={{
                padding: 16,
                borderRadius: 12,
                border: `1px solid ${c.borderSubtle}`,
                background: c.surfaceSubtle,
                ...fadeIn(0),
              }}
            >
              <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
                <div style={{ flex: 1, minWidth: 130 }}>
                  <label style={lbl}>Upfront deposit</label>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <span style={{ fontSize: 13, color: c.textTertiary }}>A$</span>
                    <input defaultValue="6,000" style={input} />
                  </div>
                </div>
                <div style={{ flex: 1, minWidth: 130 }}>
                  <label style={lbl}>Rate</label>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <span style={{ fontSize: 13, color: c.textTertiary }}>A$</span>
                    <input defaultValue="180" style={input} />
                    <span style={{ fontSize: 13, color: c.textTertiary, whiteSpace: 'nowrap' }}>
                      /hr
                    </span>
                  </div>
                </div>
                <div style={{ flex: 1, minWidth: 130 }}>
                  <label style={lbl}>Invoiced</label>
                  <select style={{ ...input, cursor: 'pointer' }}>
                    <option>Monthly</option>
                    <option>Fortnightly</option>
                  </select>
                </div>
              </div>
              <p
                style={{
                  fontSize: 12,
                  color: c.textTertiary,
                  margin: '12px 0 0',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                }}
              >
                <I.alertCircle size={13} color={c.textTertiary} />
                No fixed total — milestone estimate ({fmt(total)}) shown to the client as a guide,
                not a cap.
              </p>
            </div>
          ) : (
            <div style={{ ...fadeIn(0) }}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '10px 14px',
                  borderRadius: 10,
                  background: c.surfaceSubtle,
                  marginBottom: 10,
                }}
              >
                <span style={{ fontSize: 13, color: c.textSecondary }}>Total from milestones</span>
                <span style={{ fontSize: 16, fontWeight: 800, color: c.text }}>{fmt(total)}</span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {terms.map((t, i) => (
                  <div
                    key={i}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      padding: '10px 12px',
                      borderRadius: 10,
                      border: `1px solid ${c.borderSubtle}`,
                      background: c.surface,
                    }}
                  >
                    <input
                      defaultValue={t.label}
                      onChange={(e) =>
                        setTerms((ts) =>
                          ts.map((x, j) => (j === i ? { ...x, label: e.target.value } : x))
                        )
                      }
                      style={{ ...input, flex: 1, fontWeight: 600 }}
                    />
                    <div style={{ display: 'flex', alignItems: 'center', gap: 3, flexShrink: 0 }}>
                      <input
                        value={t.pct}
                        onChange={(e) =>
                          setTerms((ts) =>
                            ts.map((x, j) =>
                              j === i ? { ...x, pct: Number(e.target.value) || 0 } : x
                            )
                          )
                        }
                        style={{ ...input, width: 54, textAlign: 'right', fontWeight: 700 }}
                      />
                      <span style={{ fontSize: 13, color: c.textTertiary }}>%</span>
                    </div>
                    <span
                      style={{
                        fontSize: 13,
                        fontWeight: 600,
                        color: c.textSecondary,
                        width: 74,
                        textAlign: 'right',
                        flexShrink: 0,
                      }}
                    >
                      {fmt(Math.round((total * t.pct) / 100))}
                    </span>
                    {terms.length > 1 && (
                      <button
                        onClick={() => setTerms((ts) => ts.filter((_, j) => j !== i))}
                        style={{
                          background: 'none',
                          border: 'none',
                          cursor: 'pointer',
                          padding: 4,
                          display: 'flex',
                          flexShrink: 0,
                        }}
                      >
                        <I.x size={13} color={c.textTertiary} />
                      </button>
                    )}
                  </div>
                ))}
              </div>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  marginTop: 10,
                  flexWrap: 'wrap',
                  gap: 8,
                }}
              >
                <button
                  onClick={() => setTerms((ts) => [...ts, { label: 'Installment', pct: 0 }])}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: '8px 12px',
                    borderRadius: 9,
                    border: `1px dashed ${c.border}`,
                    background: 'transparent',
                    cursor: 'pointer',
                    color: c.primary,
                    fontSize: 12.5,
                    fontWeight: 600,
                  }}
                >
                  <I.plus size={13} color={c.primary} /> Add installment
                </button>
                <span
                  style={{
                    fontSize: 12.5,
                    fontWeight: 700,
                    color: termsSum === 100 ? c.success : c.error,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 5,
                  }}
                >
                  {termsSum === 100 ? (
                    <I.check size={13} color={c.success} />
                  ) : (
                    <I.alertCircle size={13} color={c.error} />
                  )}
                  {termsSum}% allocated{termsSum !== 100 ? ' — must total 100%' : ''}
                </span>
              </div>
            </div>
          )}
        </div>

        {/* Fixed Balo terms + supplement */}
        <div>
          <SectionLabel icon={I.shield} color={c.cyan}>
            Terms
          </SectionLabel>
          <TermsBlock p={null} editable={true} />
        </div>
      </div>
    ),
    attachments: (
      <div>
        <SectionLabel icon={I.paperclip} color={c.textSecondary}>
          Attachments (optional)
        </SectionLabel>
        <Attachments items={PRIYA.attachments.filter((a) => a.kind !== 'terms')} editable={true} />
      </div>
    ),
  };

  const TabStrip = (
    <div
      className="balo-xscroll"
      style={{
        display: 'flex',
        gap: 3,
        padding: 3,
        borderRadius: 11,
        background: c.surfaceSubtle,
        marginBottom: 16,
      }}
    >
      {COMPOSER_TABS.map((t) => {
        const on = tab === t.key;
        return (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 7,
              padding: '9px 14px',
              borderRadius: 8,
              fontSize: 13,
              fontWeight: on ? 650 : 500,
              border: 'none',
              cursor: 'pointer',
              background: on ? c.surface : 'transparent',
              color: on ? c.text : c.textTertiary,
              boxShadow: on ? '0 1px 3px rgba(0,0,0,0.08)' : 'none',
              whiteSpace: 'nowrap',
              flexShrink: 0,
            }}
          >
            <t.icon size={14} color={on ? c.primary : c.textTertiary} />
            {t.label}
          </button>
        );
      })}
    </div>
  );

  const nudge = revise ? (
    <NudgeBar
      variant="action"
      icon={I.rotate}
      headline="Revise your proposal — Dana requested changes"
      sub="Address the requests below and resubmit. Dana will see this as version 2."
    />
  ) : (
    <NudgeBar
      variant="action"
      icon={I.edit}
      headline="Build your proposal for Dana @ Northwind Industrial"
      sub="Dana requested this after your conversation. Work through the sections — the card keeps the whole proposal in view."
    />
  );

  const changesCard = revise && (
    <Card
      style={{
        padding: '16px 18px',
        border: `1px solid ${c.warningBorder}`,
        background: c.warningLight,
        marginTop: 16,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <I.clipboard size={15} color={c.warning} />
        <span style={{ fontSize: 13, fontWeight: 700, color: c.warning }}>
          Dana's requested changes
        </span>
        <Pill color={c.warning} bg="#FFFFFF" border={c.warningBorder}>
          re: Pricing
        </Pill>
      </div>
      <p style={{ fontSize: 13.5, color: c.text, margin: 0, lineHeight: 1.6 }}>
        "The approach looks great. Could we split milestone 2 so the migration validates in two
        passes, and is there any flex on the upfront — 20% would help our finance cycle?"
      </p>
    </Card>
  );

  // ── MOBILE: tab strip + collapsed summary bar (tap → bottom sheet) ──
  if (mobile) {
    const ready = (isTM || termsSum === 100) && !milestones.some((m) => !m.title);
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14, ...slideUp(0.05) }}>
        {nudge}
        {changesCard}
        {TabStrip}
        <Card style={{ padding: '18px 16px' }} key={tab}>
          <div style={{ ...fadeIn(0) }}>{panes[tab]}</div>
        </Card>
        {/* Collapsed summary bar */}
        <button
          onClick={() => setSummarySheet(true)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '12px 14px',
            borderRadius: 12,
            border: `1px solid ${ready ? c.successBorder : c.warningBorder}`,
            background: ready ? c.successLight : c.warningLight,
            cursor: 'pointer',
            textAlign: 'left',
          }}
        >
          {ready ? (
            <I.check size={15} color={c.success} />
          ) : (
            <I.alertCircle size={15} color={c.warning} />
          )}
          <span
            style={{ flex: 1, fontSize: 13, fontWeight: 650, color: ready ? c.success : c.warning }}
          >
            {fmt(total)}
            {isTM ? ' est.' : ''} · {milestones.length} milestones · ~{timeframe} wks
          </span>
          <span style={{ fontSize: 12, fontWeight: 600, color: c.textSecondary }}>Summary</span>
          <I.chevDown size={13} color={c.textSecondary} style={{ transform: 'rotate(180deg)' }} />
        </button>
        {summarySheet && (
          <div
            style={{
              position: 'fixed',
              inset: 0,
              zIndex: 70,
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'flex-end',
            }}
          >
            <div
              onClick={() => setSummarySheet(false)}
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
                background: c.bg,
                borderRadius: '20px 20px 0 0',
                padding: '10px 16px 24px',
                boxShadow: '0 -8px 32px rgba(0,0,0,0.18)',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'center', padding: '0 0 10px' }}>
                <div style={{ width: 36, height: 4, borderRadius: 2, background: c.border }} />
              </div>
              <ComposerSummaryCard
                method={method}
                total={total}
                milestones={milestones}
                terms={terms}
                termsSum={termsSum}
                timeframe={timeframe}
                revise={revise}
                mobile
                asSheet
              />
            </div>
          </div>
        )}
      </div>
    );
  }

  // ── DESKTOP: two-column — tabbed main + sticky summary card right ──
  return (
    <div style={{ ...slideUp(0.05) }}>
      {nudge}
      {changesCard}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0,1.9fr) minmax(0,1fr)',
          gap: 20,
          alignItems: 'start',
          marginTop: 16,
        }}
      >
        <div>
          {TabStrip}
          <Card style={{ padding: '24px 26px' }} key={tab}>
            <div style={{ ...fadeIn(0) }}>{panes[tab]}</div>
          </Card>
        </div>
        <ComposerSummaryCard
          method={method}
          total={total}
          milestones={milestones}
          terms={terms}
          termsSum={termsSum}
          timeframe={timeframe}
          revise={revise}
        />
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// CLIENT — REVIEW (continuous document + sticky summary/nav card)
// Lens-split rationale: DECIDING wants the whole document visible —
// nothing hidden behind a tab the client might not open before
// committing money. The card = at-a-glance summary + section nav
// (scroll-spy) + the decision actions, always reachable.
// ══════════════════════════════════════════════════════════════════
const REVIEW_SECTIONS = [
  { key: 'overview', label: 'Overview' },
  { key: 'milestones', label: 'Milestones' },
  { key: 'payment', label: 'Payment terms' },
  { key: 'terms', label: 'Terms' },
  { key: 'attachments', label: 'Attachments' },
];

function ReviewSummaryCard({ p, onAccept, onRequestChanges, asSheet }) {
  const isTM = p.pricingMethod === 'tm';
  const rows = [
    { k: 'Pricing', v: isTM ? 'Time & Materials' : 'Fixed price' },
    { k: isTM ? 'Estimate' : 'Total', v: fmt(p.total) + (isTM ? ' est.' : '') },
    { k: 'Milestones', v: `${p.milestones.length}` },
    { k: 'Timeframe', v: p.timeline },
    { k: 'Payment', v: isTM ? 'Deposit + monthly' : p.terms.map((t) => `${t.pct}%`).join(' / ') },
  ];
  return (
    <Card style={{ padding: '18px 18px', position: asSheet ? 'static' : 'sticky', top: 76 }}>
      {/* At-a-glance summary — the decision context, NOT navigation */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
        <Avatar initials={p.initials} color={p.color} size={34} />
        <div style={{ minWidth: 0 }}>
          <p style={{ fontSize: 13.5, fontWeight: 700, color: c.text, margin: 0 }}>
            {p.expert.split(' ')[0]}'s proposal{p.version > 1 ? ` · v${p.version}` : ''}
          </p>
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              fontSize: 11.5,
              color: c.textTertiary,
            }}
          >
            <I.star size={10} color={c.warning} />
            {p.rating} · {p.company}
          </span>
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 9, marginBottom: 16 }}>
        {rows.map((r) => (
          <div key={r.k} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
            <span style={{ color: c.textTertiary }}>{r.k}</span>
            <span style={{ fontWeight: 650, color: c.text, textAlign: 'right' }}>{r.v}</span>
          </div>
        ))}
      </div>
      {/* Decision actions — always reachable */}
      <Btn variant="gradient" icon={I.check} full style={{ marginBottom: 8 }} onClick={onAccept}>
        Accept this proposal
      </Btn>
      <Btn
        variant="warn"
        icon={I.rotate}
        full
        style={{ marginBottom: 12 }}
        onClick={onRequestChanges}
      >
        Request changes
      </Btn>
      <div style={{ display: 'flex', justifyContent: 'center' }}>
        <BackChannel name={p.expert.split(' ')[0]} />
      </div>
    </Card>
  );
}

function ProposalReview({ mobile, onAccept, statuses, onRequestChanges }) {
  const proposals = [PRIYA, MARCUS];
  const [active, setActive] = useState(0);
  const [activeSection, setActiveSection] = useState('overview');
  const p = proposals[active];
  const status = statuses[p.id]; // 'submitted' | 'changes_requested'

  // Prototype jump: set active + scroll the anchor into view.
  const jump = (key) => {
    setActiveSection(key);
    const el = typeof document !== 'undefined' && document.getElementById(`sec-${p.id}-${key}`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const switcher = (
    <div className="balo-xscroll" style={{ display: 'flex', gap: 8, paddingBottom: 2 }}>
      {proposals.map((pr, i) => {
        const on = i === active;
        const st = statuses[pr.id];
        return (
          <button
            key={pr.id}
            onClick={() => {
              setActive(i);
              setActiveSection('overview');
            }}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '10px 14px',
              borderRadius: 12,
              cursor: 'pointer',
              flexShrink: 0,
              border: `1.5px solid ${on ? pr.color : c.border}`,
              background: on ? `${pr.color}0C` : c.surface,
              boxShadow: on ? `0 2px 10px ${pr.color}1A` : 'none',
              transition: 'all 0.2s',
            }}
          >
            <Avatar initials={pr.initials} color={pr.color} size={30} />
            <div style={{ textAlign: 'left' }}>
              <p
                style={{
                  fontSize: 13.5,
                  fontWeight: 650,
                  color: on ? c.text : c.textSecondary,
                  margin: 0,
                }}
              >
                {pr.expert.split(' ')[0]}
              </p>
              <p style={{ fontSize: 11.5, color: c.textTertiary, margin: 0 }}>
                {fmt(pr.total)} · {pr.timeline}
              </p>
            </div>
            {st === 'changes_requested' && (
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  background: c.warning,
                  marginLeft: 2,
                }}
                title="Changes requested"
              />
            )}
          </button>
        );
      })}
    </div>
  );

  const awaitingRevision = (
    <Card style={{ padding: mobile ? '20px 16px' : '28px', textAlign: 'center' }}>
      <div
        style={{
          width: 48,
          height: 48,
          borderRadius: 13,
          background: c.warningLight,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          margin: '0 auto 14px',
        }}
      >
        <I.rotate size={22} color={c.warning} />
      </div>
      <h3 style={{ fontSize: 16, fontWeight: 650, color: c.text, margin: 0 }}>
        Changes requested from {p.expert.split(' ')[0]}
      </h3>
      <p
        style={{
          fontSize: 13.5,
          color: c.textSecondary,
          margin: '8px auto 0',
          maxWidth: 380,
          lineHeight: 1.6,
        }}
      >
        {p.expert.split(' ')[0]} is revising and will resubmit as v2. The other proposal is
        unaffected — you can still review or accept it.
      </p>
      <div style={{ display: 'flex', justifyContent: 'center', marginTop: 16 }}>
        <BackChannel name={p.expert.split(' ')[0]} />
      </div>
    </Card>
  );

  // The proposal as a CONTINUOUS document, with section anchors for the nav.
  const doc = <ProposalDoc p={p} sectionIdPrefix={`sec-${p.id}-`} />;

  // ── MOBILE: anchor strip + doc + bottom decision rail ──
  if (mobile) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14, ...slideUp(0.05) }}>
        <NudgeBar
          variant="action"
          icon={I.clipboard}
          headline={`You've received ${proposals.length} proposals`}
          sub="Read each in full, then accept — or ask for changes. Each is independent."
        />
        {switcher}
        {status === 'changes_requested' ? (
          awaitingRevision
        ) : (
          <>
            {/* Anchor strip (horizontal) */}
            <div className="balo-xscroll" style={{ display: 'flex', gap: 6 }}>
              {REVIEW_SECTIONS.map((s) => {
                const on = activeSection === s.key;
                return (
                  <button
                    key={s.key}
                    onClick={() => jump(s.key)}
                    style={{
                      padding: '7px 13px',
                      borderRadius: 18,
                      border: `1px solid ${on ? c.primaryBorder : c.border}`,
                      background: on ? c.primaryLight : c.surface,
                      cursor: 'pointer',
                      fontSize: 12,
                      fontWeight: 600,
                      color: on ? c.primary : c.textSecondary,
                      whiteSpace: 'nowrap',
                      flexShrink: 0,
                    }}
                  >
                    {s.label}
                  </button>
                );
              })}
            </div>
            <Card style={{ padding: '18px 16px' }} key={active}>
              <div style={{ ...fadeIn(0) }}>{doc}</div>
            </Card>
            {/* Decision rail */}
            <div style={{ display: 'flex', gap: 8 }}>
              <Btn
                variant="warn"
                icon={I.rotate}
                style={{ flexShrink: 0, padding: '11px 14px', fontSize: 13 }}
                onClick={() => onRequestChanges(p)}
              >
                Changes
              </Btn>
              <Btn
                variant="gradient"
                icon={I.check}
                style={{ flex: 1 }}
                onClick={() => onAccept(p)}
              >
                Accept this proposal
              </Btn>
            </div>
          </>
        )}
      </div>
    );
  }

  // ── DESKTOP: two-column — doc column (sticky nav on top) + summary card right ──
  return (
    <div style={{ ...slideUp(0.05) }}>
      <NudgeBar
        variant="action"
        icon={I.clipboard}
        headline={`You've received ${proposals.length} proposals`}
        sub="Read each one in full, then accept the expert you want — or ask for changes. Each proposal is handled independently."
      />
      <div style={{ margin: '16px 0 14px' }}>{switcher}</div>
      {status === 'changes_requested' ? (
        awaitingRevision
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(0,1.9fr) minmax(0,1fr)',
            gap: 20,
            alignItems: 'start',
          }}
        >
          <div>
            {/* Sticky section nav — stays pinned at the top of the document column
                while it scrolls. Prototype: click-to-jump + highlight; production
                adds IntersectionObserver scroll-spy for scroll-driven highlighting. */}
            <div
              className="balo-xscroll"
              style={{
                display: 'flex',
                gap: 6,
                padding: '8px 2px',
                position: 'sticky',
                top: 62,
                zIndex: 10,
                background: c.bg,
              }}
            >
              {REVIEW_SECTIONS.map((s) => {
                const on = activeSection === s.key;
                return (
                  <button
                    key={s.key}
                    onClick={() => jump(s.key)}
                    style={{
                      padding: '7px 14px',
                      borderRadius: 18,
                      border: `1px solid ${on ? c.primaryBorder : c.border}`,
                      background: on ? c.primaryLight : c.surface,
                      cursor: 'pointer',
                      fontSize: 12.5,
                      fontWeight: 600,
                      color: on ? c.primary : c.textSecondary,
                      whiteSpace: 'nowrap',
                      flexShrink: 0,
                      transition: 'all 0.15s',
                    }}
                  >
                    {s.label}
                  </button>
                );
              })}
            </div>
            <Card style={{ padding: '26px 28px', marginTop: 8 }} key={active}>
              <div style={{ ...fadeIn(0) }}>{doc}</div>
            </Card>
          </div>
          <ReviewSummaryCard
            p={p}
            onAccept={() => onAccept(p)}
            onRequestChanges={() => onRequestChanges(p)}
          />
        </div>
      )}
    </div>
  );
}

// Request-changes modal — structured note (section + text)
function ChangesModal({ p, onClose, onConfirm }) {
  const [note, setNote] = useState('');
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 80,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
      }}
    >
      <div
        onClick={onClose}
        style={{
          position: 'absolute',
          inset: 0,
          background: 'rgba(15,23,41,0.45)',
          animation: 'backdropIn 0.2s ease-out both',
        }}
      />
      <div
        style={{
          position: 'relative',
          width: '100%',
          maxWidth: 460,
          background: c.surface,
          borderRadius: 18,
          boxShadow: '0 24px 64px rgba(0,0,0,0.28)',
          overflow: 'hidden',
          ...scaleIn(0),
        }}
      >
        <div style={{ padding: '20px 24px 16px', borderBottom: `1px solid ${c.borderSubtle}` }}>
          <p style={{ fontSize: 16, fontWeight: 700, color: c.text, margin: 0 }}>
            Request changes from {p.expert.split(' ')[0]}
          </p>
          <p style={{ fontSize: 12.5, color: c.textSecondary, margin: '2px 0 0' }}>
            {p.expert.split(' ')[0]} will revise and resubmit as a new version. The other proposal
            isn't affected.
          </p>
        </div>
        <div style={{ padding: '18px 24px' }}>
          <label
            style={{
              fontSize: 12.5,
              fontWeight: 600,
              color: c.text,
              display: 'block',
              marginBottom: 6,
            }}
          >
            What should change? (optional section)
          </label>
          <select
            style={{
              width: '100%',
              padding: '9px 12px',
              borderRadius: 9,
              fontSize: 13.5,
              border: `1px solid ${c.border}`,
              outline: 'none',
              marginBottom: 12,
              cursor: 'pointer',
              background: c.surface,
              color: c.text,
            }}
          >
            <option>General</option>
            <option>Milestones / deliverables</option>
            <option>Pricing</option>
            <option>Payment terms</option>
            <option>Timeline</option>
          </select>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={4}
            placeholder="Tell Priya what you'd like changed…"
            style={{
              width: '100%',
              padding: '10px 12px',
              borderRadius: 9,
              fontSize: 13.5,
              border: `1px solid ${c.border}`,
              outline: 'none',
              resize: 'vertical',
              lineHeight: 1.55,
              boxSizing: 'border-box',
              fontFamily: 'inherit',
            }}
          />
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 16 }}>
            <Btn variant="ghost" onClick={onClose}>
              Cancel
            </Btn>
            <Btn variant="primary" icon={I.send} disabled={!note.trim()} onClick={onConfirm}>
              Send request
            </Btn>
          </div>
        </div>
      </div>
    </div>
  );
}

// Accept confirmation — heaviest friction
function AcceptConfirm({ p, onClose, onConfirm }) {
  const [ack, setAck] = useState(false);
  const up = p.terms[0];
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 80,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
      }}
    >
      <div
        onClick={onClose}
        style={{
          position: 'absolute',
          inset: 0,
          background: 'rgba(15,23,41,0.45)',
          animation: 'backdropIn 0.2s ease-out both',
        }}
      />
      <div
        style={{
          position: 'relative',
          width: '100%',
          maxWidth: 460,
          background: c.surface,
          borderRadius: 18,
          boxShadow: '0 24px 64px rgba(0,0,0,0.28)',
          overflow: 'hidden',
          ...scaleIn(0),
        }}
      >
        <div
          style={{
            padding: '22px 24px 18px',
            background: c.gradientSubtle,
            borderBottom: `1px solid ${c.borderSubtle}`,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
            <Avatar initials={p.initials} color={p.color} size={40} />
            <div>
              <p style={{ fontSize: 16, fontWeight: 700, color: c.text, margin: 0 }}>
                Accept {p.expert}'s proposal?
              </p>
              <p style={{ fontSize: 12.5, color: c.textSecondary, margin: '2px 0 0' }}>
                This starts the engagement and is binding.
              </p>
            </div>
          </div>
        </div>
        <div style={{ padding: '20px 24px' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 16 }}>
            {[
              [
                'Total',
                `${fmt(p.total)} · ${p.pricingMethod === 'tm' ? 'Time & Materials' : 'Fixed price'}`,
              ],
              [
                'Due now',
                `${fmt(Math.round((p.total * up.pct) / 100))} (${up.pct}% ${up.label.toLowerCase()})`,
              ],
              ['Then', `${fmt(p.total - Math.round((p.total * up.pct) / 100))} on delivery`],
            ].map(([k, v]) => (
              <div
                key={k}
                style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13.5 }}
              >
                <span style={{ color: c.textTertiary }}>{k}</span>
                <span style={{ fontWeight: 650, color: c.text }}>{v}</span>
              </div>
            ))}
          </div>
          <label
            style={{
              display: 'flex',
              gap: 10,
              alignItems: 'flex-start',
              cursor: 'pointer',
              padding: '12px 14px',
              borderRadius: 11,
              background: c.surfaceSubtle,
              marginBottom: 16,
            }}
          >
            <input
              type="checkbox"
              checked={ack}
              onChange={(e) => setAck(e.target.checked)}
              style={{ marginTop: 2, width: 16, height: 16, accentColor: c.primary }}
            />
            <span style={{ fontSize: 12.5, color: c.textSecondary, lineHeight: 1.5 }}>
              I agree to <strong>Balo's standard terms</strong> and {p.expert.split(' ')[0]}'s
              additional terms, and understand accepting commits Northwind to these terms. Balo will
              raise the upfront invoice and tell the other experts they weren't selected.
            </span>
          </label>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <Btn variant="ghost" onClick={onClose}>
              Cancel
            </Btn>
            <Btn variant="gradient" icon={I.check} disabled={!ack} onClick={onConfirm}>
              Confirm acceptance
            </Btn>
          </div>
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// SUBMITTED — read-only doc; lens-dependent framing + demoted back-channel
// ══════════════════════════════════════════════════════════════════
function SubmittedView({ lens, mobile }) {
  const nudge =
    lens === 'expert'
      ? {
          variant: 'waiting',
          icon: I.hourglass,
          headline: 'Proposal sent to Dana @ Northwind Industrial',
          sub: "She's reviewing it alongside one other. You'll be notified the moment she responds.",
        }
      : {
          variant: 'waiting',
          icon: I.clock,
          headline: '2 proposals submitted — client reviewing',
          sub: 'Priya (A$58k) and Marcus (A$62k) are in. No action until Dana accepts one or asks for changes.',
        };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, ...slideUp(0.05) }}>
      <NudgeBar {...nudge} />
      <Card style={{ padding: mobile ? '18px 16px' : '26px 28px' }}>
        <ProposalDoc p={PRIYA} />
      </Card>
      {lens === 'expert' && (
        <div style={{ display: 'flex', justifyContent: 'flex-start', padding: '0 2px' }}>
          <BackChannel name="Dana" />
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// KICKOFF COORDINATION BOARD
// ══════════════════════════════════════════════════════════════════
function KickoffBoard({ lens, approved, mobile }) {
  const tasks = [
    {
      party: 'client',
      icon: I.user,
      color: c.primary,
      label: 'Add billing details',
      done: true,
      owner: 'Client',
      note: 'Billing contact + PO captured',
    },
    {
      party: 'expert',
      icon: I.shield,
      color: c.accent,
      label: 'Confirm payment terms',
      done: true,
      owner: 'Expert',
      note: '30% upfront / 70% on delivery confirmed',
    },
    {
      party: 'admin',
      icon: I.users,
      color: c.cyan,
      label: 'Raise & settle upfront invoice',
      done: approved,
      owner: 'Admin',
      note: approved ? 'Upfront invoice paid — A$17,400' : 'Invoice sent — awaiting payment',
    },
  ];
  const doneCount = tasks.filter((t) => t.done).length;
  let nudge;
  if (approved)
    nudge = {
      variant: 'done',
      icon: I.zap,
      headline: 'Project kicked off 🎉',
      sub: "Northwind ↔ Priya is now a live project. It's left the request pipeline and entered delivery.",
    };
  else if (lens === 'admin')
    nudge = {
      variant: 'action',
      icon: I.dollarSign,
      headline: 'Client & expert ready — settle the invoice, then approve',
      sub: "Dana's billing is in and Priya confirmed terms. Confirm the A$17,400 upfront cleared, then approve.",
      primary: { label: 'Approve for kickoff', icon: I.check },
      secondary: { label: 'View invoice', icon: I.dollarSign },
    };
  else if (lens === 'expert')
    nudge = {
      variant: 'waiting',
      icon: I.clock,
      headline: "You're all set — Balo is finalising the invoice",
      sub: "Your terms are confirmed and Dana's billing is in. Kickoff is gated on the upfront invoice settling.",
    };
  else
    nudge = {
      variant: 'waiting',
      icon: I.clock,
      headline: 'Almost there — Balo is settling the upfront invoice',
      sub: 'Your billing is in and Priya confirmed terms. Once the invoice clears, the project kicks off.',
    };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, ...slideUp(0.05) }}>
      <NudgeBar {...nudge} />
      <Card style={{ padding: mobile ? '18px 16px' : '24px 26px' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 4,
          }}
        >
          <SectionLabel icon={I.clipboard} color={c.primary}>
            What's blocking kickoff
          </SectionLabel>
          <span
            style={{
              fontSize: 12,
              fontWeight: 700,
              color: doneCount === 3 ? c.success : c.textTertiary,
            }}
          >
            {doneCount}/3 ready
          </span>
        </div>
        <p style={{ fontSize: 12.5, color: c.textTertiary, margin: '0 0 16px' }}>
          Everyone sees the same checklist — so no one's left wondering who they're waiting on.
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {tasks.map((t) => {
            const mine = t.party === lens;
            return (
              <div
                key={t.party}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 13,
                  padding: '14px 16px',
                  borderRadius: 12,
                  border: `1px solid ${mine && !t.done ? c.primaryBorder : c.borderSubtle}`,
                  background: mine && !t.done ? c.primaryLight : c.surface,
                  boxShadow: mine && !t.done ? `0 0 0 3px ${c.primaryGlow}` : 'none',
                }}
              >
                <div
                  style={{
                    width: 28,
                    height: 28,
                    borderRadius: '50%',
                    flexShrink: 0,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    background: t.done ? c.gradientWarm : c.surfaceSubtle,
                    border: t.done ? 'none' : `2px solid ${c.border}`,
                  }}
                >
                  {t.done ? (
                    <I.check size={15} color="white" />
                  ) : (
                    <I.clock size={14} color={c.textTertiary} />
                  )}
                </div>
                <div
                  style={{
                    width: 30,
                    height: 30,
                    borderRadius: 9,
                    background: `${t.color}14`,
                    border: `1px solid ${t.color}28`,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                  }}
                >
                  <t.icon size={15} color={t.color} />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <p style={{ fontSize: 14, fontWeight: 650, color: c.text, margin: 0 }}>
                      {t.label}
                    </p>
                    {mine && (
                      <Pill color={c.primary} bg={c.primaryLight} border={c.primaryBorder}>
                        You
                      </Pill>
                    )}
                  </div>
                  <p style={{ fontSize: 12.5, color: c.textTertiary, margin: '2px 0 0' }}>
                    {t.owner} · {t.note}
                  </p>
                </div>
                {mine && !t.done && (
                  <Btn
                    variant="primary"
                    style={{ padding: '8px 14px', fontSize: 13, flexShrink: 0 }}
                  >
                    {t.party === 'admin' ? 'Approve' : 'Complete'}
                  </Btn>
                )}
                {!mine && !t.done && (
                  <span style={{ fontSize: 12, color: c.warning, fontWeight: 600, flexShrink: 0 }}>
                    Waiting
                  </span>
                )}
                {t.done && (
                  <span style={{ fontSize: 12, color: c.success, fontWeight: 600, flexShrink: 0 }}>
                    Done
                  </span>
                )}
              </div>
            );
          })}
        </div>
        {!approved && (
          <div
            style={{
              marginTop: 16,
              padding: '11px 14px',
              borderRadius: 10,
              background: c.surfaceSubtle,
              display: 'flex',
              gap: 9,
              alignItems: 'flex-start',
            }}
          >
            <I.layers size={14} color={c.textTertiary} style={{ marginTop: 1, flexShrink: 0 }} />
            <span style={{ fontSize: 11.5, color: c.textTertiary, lineHeight: 1.5 }}>
              On approval, acceptance materialises an <strong>engagement</strong> (the seam a future
              embedded/retainer product also writes through) — it doesn't simply flip this request
              to "done".
            </span>
          </div>
        )}
      </Card>
    </div>
  );
}

// ── Request context strip ────────────────────────────────────────
function RequestStrip() {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '12px 16px',
        borderRadius: 12,
        background: c.surface,
        border: `1px solid ${c.borderSubtle}`,
        marginBottom: 18,
      }}
    >
      <div
        style={{
          width: 34,
          height: 34,
          borderRadius: 9,
          background: c.primaryLight,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        <I.briefcase size={16} color={c.primary} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <p
          style={{
            fontSize: 11,
            color: c.textTertiary,
            margin: 0,
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
            fontWeight: 700,
          }}
        >
          Proposal for request
        </p>
        <p
          style={{
            fontSize: 13.5,
            fontWeight: 650,
            color: c.text,
            margin: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          CPQ implementation to replace legacy quoting tool · Northwind Industrial
        </p>
      </div>
      <Pill color={c.textSecondary}>Revenue Cloud</Pill>
    </div>
  );
}

// ── Control bar ──────────────────────────────────────────────────
function ControlBar({ actor, setActor, stage, setStage, mobile, setMobile }) {
  return (
    <div
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 30,
        background: c.surface,
        borderBottom: `1px solid ${c.border}`,
        padding: '12px 24px',
      }}
    >
      <div
        style={{
          maxWidth: 1080,
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
              return (
                <button
                  key={a.key}
                  onClick={() => setActor(a.key)}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: '7px 13px',
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
                  <a.icon size={14} color={on ? a.color : c.textTertiary} />
                  {a.label}
                </button>
              );
            })}
          </div>
        </div>
        <div
          className="balo-xscroll"
          style={{
            display: 'flex',
            gap: 3,
            padding: 3,
            borderRadius: 10,
            background: c.surfaceSubtle,
            flex: 1,
            minWidth: 0,
          }}
        >
          {STAGES.map((s) => {
            const on = stage === s.key;
            return (
              <button
                key={s.key}
                onClick={() => setStage(s.key)}
                style={{
                  padding: '7px 12px',
                  borderRadius: 7,
                  fontSize: 12.5,
                  fontWeight: on ? 650 : 500,
                  border: 'none',
                  cursor: 'pointer',
                  background: on ? c.surface : 'transparent',
                  color: on ? c.text : c.textTertiary,
                  boxShadow: on ? '0 1px 3px rgba(0,0,0,0.08)' : 'none',
                  whiteSpace: 'nowrap',
                  flexShrink: 0,
                }}
              >
                {s.short}
              </button>
            );
          })}
        </div>
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
                    padding: '7px 13px',
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

// ══════════════════════════════════════════════════════════════════
// MAIN
// ══════════════════════════════════════════════════════════════════
export default function ProposalA6() {
  const [actor, setActor] = useState('expert');
  const [stage, setStage] = useState('build');
  const [mobile, setMobile] = useState(false);
  const [acceptModal, setAcceptModal] = useState(null);
  const [changesModal, setChangesModal] = useState(null);
  // Per-proposal status — INDEPENDENT
  const [statuses, setStatuses] = useState({ priya: 'submitted', marcus: 'submitted' });

  const am = ACTORS.find((a) => a.key === actor);

  function renderSurface() {
    if (stage === 'build') {
      if (actor === 'expert') return <ProposalComposer mobile={mobile} revise={false} />;
      const n =
        actor === 'client'
          ? {
              variant: 'waiting',
              icon: I.hourglass,
              headline: 'Priya is preparing your proposal',
              sub: "You asked Priya to put one together. You'll be notified the moment it lands.",
            }
          : {
              variant: 'waiting',
              icon: I.clock,
              headline: 'Experts are building proposals',
              sub: 'Priya and Marcus are drafting. No admin action until proposals are in.',
            };
      return <NudgeBar {...n} />;
    }
    if (stage === 'submitted') {
      if (actor === 'client')
        return (
          <ProposalReview
            mobile={mobile}
            statuses={statuses}
            onAccept={(p) => setAcceptModal(p)}
            onRequestChanges={(p) => setChangesModal(p)}
          />
        );
      return <SubmittedView lens={actor} mobile={mobile} />;
    }
    if (stage === 'changes_requested') {
      if (actor === 'expert') return <ProposalComposer mobile={mobile} revise={true} />;
      if (actor === 'client')
        return (
          <ProposalReview
            mobile={mobile}
            statuses={{ ...statuses, priya: 'changes_requested' }}
            onAccept={(p) => setAcceptModal(p)}
            onRequestChanges={(p) => setChangesModal(p)}
          />
        );
      return (
        <NudgeBar
          variant="waiting"
          icon={I.rotate}
          headline="Dana requested changes from Priya"
          sub="Priya is revising (→ v2). Marcus's proposal is unaffected and still in play. Step in once a proposal is accepted."
        />
      );
    }
    if (stage === 'accepted') return <KickoffBoard lens={actor} approved={false} mobile={mobile} />;
    if (stage === 'kickoff') return <KickoffBoard lens={actor} approved={true} mobile={mobile} />;
    return null;
  }

  const inner = (
    <div key={`${actor}-${stage}`}>
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
        <span
          style={{
            fontSize: 11,
            color: c.textTertiary,
            marginLeft: mobile ? 0 : 'auto',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
          }}
        >
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: c.accent }} />
          {STAGES.find((s) => s.key === stage).sub}
        </span>
      </div>
      <RequestStrip />
      {renderSurface()}
    </div>
  );

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
        href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;650;700;800&display=swap"
        rel="stylesheet"
      />
      <ControlBar
        actor={actor}
        setActor={setActor}
        stage={stage}
        setStage={setStage}
        mobile={mobile}
        setMobile={setMobile}
      />
      {mobile ? (
        <div style={{ padding: '24px 16px' }}>
          <div
            style={{
              width: 390,
              maxWidth: '100%',
              minHeight: 760,
              margin: '0 auto',
              background: c.bg,
              borderRadius: 36,
              border: '10px solid #0F1729',
              boxShadow: '0 20px 60px rgba(0,0,0,0.25)',
              overflow: 'hidden',
            }}
          >
            <div style={{ height: 26, background: '#0F1729' }} />
            <div style={{ padding: '18px 14px 28px', maxHeight: 760, overflowY: 'auto' }}>
              {inner}
            </div>
          </div>
        </div>
      ) : (
        <div style={{ maxWidth: 1080, margin: '0 auto', padding: '24px 28px 80px' }}>{inner}</div>
      )}
      {acceptModal && (
        <AcceptConfirm
          p={acceptModal}
          onClose={() => setAcceptModal(null)}
          onConfirm={() => {
            setAcceptModal(null);
            setStage('accepted');
          }}
        />
      )}
      {changesModal && (
        <ChangesModal
          p={changesModal}
          onClose={() => setChangesModal(null)}
          onConfirm={() => {
            setStatuses((s) => ({ ...s, [changesModal.id]: 'changes_requested' }));
            setChangesModal(null);
          }}
        />
      )}
    </div>
  );
}
