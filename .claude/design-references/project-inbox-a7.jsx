import { useState } from 'react';

// ══════════════════════════════════════════════════════════════════
// A7 (VARIANT B) — Projects DASHBOARD  (tri-lens, responsive)
//
// Comparison variant to the inbox/list take. Different theory of the page:
//   Inbox  = "here's your ranked queue — work it top to bottom."
//   Dash   = "here's the state of your world at a glance — dive where it matters."
//
// Structure:
//   · STAT TILES — portfolio at a glance; tiles act as filters for the grid.
//   · "NEEDS YOUR ATTENTION" hero — needs-you items promoted to ACTION CARDS
//     (the inbox peek elevated: latest signal + the privileged CTA, no expand step).
//   · PORTFOLIO GRID — everything else as cards (stage chip + one-line status).
//   · ADMIN — stat tiles + triage hero cards + pipeline as a MINI KANBAN by
//     stage (the one place column-thinking earns its keep: "where is everything stuck").
// Same data & lens semantics as the inbox variant; only the layout theory differs.
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
  send: (p) => <Icon {...p} d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" />,
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
  chevRight: (p) => <Icon {...p} d="M9 18l6-6-6-6" />,
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
  plus: (p) => <Icon {...p} d="M12 5v14M5 12h14" />,
  inbox: (p) => (
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
      <polyline points="22 12 16 12 14 15 10 15 8 12 2 12" />
      <path d="M5.45 5.11L2 12v6a2 2 0 002 2h16a2 2 0 002-2v-6l-3.45-6.89A2 2 0 0016.76 4H7.24a2 2 0 00-1.79 1.11z" />
    </svg>
  ),
  coffee: (p) => (
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
      <path d="M18 8h1a4 4 0 010 8h-1M2 8h16v9a4 4 0 01-4 4H6a4 4 0 01-4-4V8zM6 1v3M10 1v3M14 1v3" />
    </svg>
  ),
};

const keyframes = `
@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
@keyframes slideUp { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: translateY(0); } }
@keyframes dotPulse { 0%,100% { transform: scale(1); opacity: 1; } 50% { transform: scale(1.35); opacity: 0.7; } }
@keyframes heroGlow { 0%,100% { box-shadow: 0 2px 14px rgba(37,99,235,0.14); } 50% { box-shadow: 0 4px 22px rgba(37,99,235,0.26); } }
.balo-xscroll { overflow-x: auto; -webkit-overflow-scrolling: touch; scrollbar-width: none; flex-wrap: nowrap; }
.balo-xscroll::-webkit-scrollbar { display: none; }
`;
const slideUp = (d = 0) => ({ animation: `slideUp 0.4s ease-out ${d}s both` });
const fadeIn = (d = 0) => ({ animation: `fadeIn 0.35s ease-out ${d}s both` });

const ACTORS = [
  {
    key: 'client',
    label: 'Client',
    icon: I.user,
    color: c.primary,
    sub: 'Dana — RevOps Lead, Northwind Industrial',
  },
  {
    key: 'expert',
    label: 'Expert',
    icon: I.shield,
    color: c.accent,
    sub: 'You — Priya, CPQ Specialist',
  },
  { key: 'admin', label: 'Admin', icon: I.users, color: c.cyan, sub: 'Balo — triage & pipeline' },
];

const STAGE = {
  requested: { label: 'Requested', color: c.textSecondary, bg: c.surfaceSubtle },
  invited: { label: 'Experts invited', color: c.primary, bg: c.primaryLight },
  eoi: { label: 'In conversation', color: c.accent, bg: c.accentLight },
  prop_req: { label: 'Proposal req.', color: c.warning, bg: c.warningLight },
  prop_in: { label: 'Proposals in', color: c.warning, bg: c.warningLight },
  accepted: { label: 'Accepted', color: c.emerald, bg: c.successLight },
  kicked: { label: 'Kicked off', color: c.success, bg: c.successLight },
};

// ── Same portfolio data as the inbox variant ─────────────────────
const CLIENT_ROWS = [
  {
    id: 'cpq',
    title: 'CPQ implementation to replace legacy quoting tool',
    stage: 'prop_in',
    needsYou: true,
    unread: true,
    updated: '2h ago',
    nudge: 'Review 2 proposals',
    signal: {
      from: 'Priya',
      msg: 'Proposal submitted — A$58,000 across 4 milestones, 30% upfront.',
    },
    meta: 'Priya + Marcus proposals in · Sofia talking',
  },
  {
    id: 'svc',
    title: 'Service Cloud migration from Zendesk',
    stage: 'eoi',
    needsYou: true,
    unread: true,
    updated: 'yesterday',
    nudge: 'Reply to Tom',
    signal: {
      from: 'Tom',
      msg: 'Are you keeping Zendesk Talk, or moving voice into Service Cloud too?',
    },
    meta: 'Tom talking · Aisha EOI in',
  },
  {
    id: 'mkt',
    title: 'Marketing Cloud account audit',
    stage: 'invited',
    needsYou: false,
    unread: false,
    updated: '3d ago',
    nudge: 'Waiting on experts',
    meta: '3 experts invited',
  },
  {
    id: 'fin',
    title: 'Sales Cloud health check — FY26 prep',
    stage: 'kicked',
    needsYou: false,
    unread: false,
    updated: '2w ago',
    nudge: 'Live project',
    meta: 'Ravi delivering',
  },
];
const EXPERT_ROWS = [
  {
    id: 'harbour',
    title: 'Experience Cloud patient portal',
    company: 'Harbour Health',
    stage: 'invited',
    needsYou: true,
    unread: true,
    updated: '1h ago',
    nudge: 'Submit your EOI',
    invite: true,
    chips: ['Experience Cloud', 'A$40–60k', 'Q1 start'],
    signal: {
      from: 'Balo',
      msg: 'Patient-facing portal for appointments and results. Existing org, no Experience Cloud yet.',
    },
  },
  {
    id: 'cpq',
    title: 'CPQ implementation',
    company: 'Northwind Industrial',
    stage: 'prop_req',
    needsYou: true,
    unread: false,
    updated: '2d ago',
    nudge: 'Build your proposal',
    signal: {
      from: 'Dana',
      msg: "We'd love a proposal from you — the sandbox-first approach landed well.",
    },
  },
  {
    id: 'vector',
    title: 'Sales Cloud + Maps territory redesign',
    company: 'Vector Logistics',
    stage: 'eoi',
    needsYou: false,
    unread: false,
    updated: '4d ago',
    nudge: 'Waiting on client',
    meta: 'Client reviewing your note',
  },
  {
    id: 'bright',
    title: 'CPQ rollout — phase 2 bundles',
    company: 'Bright Foods',
    stage: 'kicked',
    needsYou: false,
    unread: false,
    updated: '3w ago',
    nudge: 'Live project',
    meta: 'Delivery in progress',
  },
];
const ADMIN_TRIAGE = [
  {
    id: 't1',
    title: 'Einstein Analytics dashboard build',
    company: 'Crestline Insurance',
    raised: '2h ago',
    sla: 'ok',
  },
  {
    id: 't2',
    title: 'Org merge after acquisition',
    company: 'Pacific Retail Group',
    raised: '26h ago',
    sla: 'warn',
  },
];
// Kanban columns for the admin pipeline
const KANBAN = [
  {
    key: 'invited',
    label: 'Inviting',
    items: [
      {
        title: 'Marketing Cloud audit',
        company: 'Bright Foods',
        updated: '3d',
        stalled: 'No EOIs · 3d',
      },
      { title: 'Experience Cloud portal', company: 'Harbour Health', updated: '1h', stalled: null },
    ],
  },
  {
    key: 'eoi',
    label: 'Conversations',
    items: [
      {
        title: 'Service Cloud migration',
        company: 'Northwind Industrial',
        updated: '1d',
        stalled: null,
      },
    ],
  },
  {
    key: 'prop_in',
    label: 'Proposals',
    items: [
      {
        title: 'CPQ implementation',
        company: 'Northwind Industrial',
        updated: '2h',
        stalled: null,
      },
    ],
  },
  {
    key: 'accepted',
    label: 'Kickoff gate',
    items: [
      {
        title: 'Revenue Cloud billing setup',
        company: 'Vector Logistics',
        updated: '5h',
        stalled: 'Invoice unpaid · 4d',
      },
    ],
  },
];

// ── Primitives ───────────────────────────────────────────────────
function Card({ children, style: xs, onClick }) {
  const [h, setH] = useState(false);
  return (
    <div
      onClick={onClick}
      onMouseEnter={onClick ? () => setH(true) : undefined}
      onMouseLeave={onClick ? () => setH(false) : undefined}
      style={{
        background: c.surface,
        borderRadius: 16,
        border: `1px solid ${h ? c.primaryBorder : c.border}`,
        boxShadow: h ? `0 4px 18px ${c.primaryGlow}` : '0 1px 3px rgba(0,0,0,0.04)',
        transition: 'all 0.22s',
        cursor: onClick ? 'pointer' : undefined,
        ...xs,
      }}
    >
      {children}
    </div>
  );
}
function Pill({
  children,
  color = c.textSecondary,
  bg = c.surfaceSubtle,
  border,
  icon: IC,
  small,
}) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding: small ? '2px 8px' : '3px 10px',
        borderRadius: 20,
        fontSize: small ? 11 : 12,
        fontWeight: 600,
        color,
        background: bg,
        border: border ? `1px solid ${border}` : 'none',
        whiteSpace: 'nowrap',
      }}
    >
      {IC && <IC size={small ? 10 : 11} color={color} />}
      {children}
    </span>
  );
}
function Btn({ children, icon: IC, variant = 'primary', onClick, style: xs, full }) {
  const [h, setH] = useState(false);
  const styles = {
    primary: {
      background: h ? c.primaryDark : c.primary,
      color: 'white',
      boxShadow: `0 2px 10px ${c.primaryGlow}`,
    },
    gradient: { background: c.gradient, color: 'white', boxShadow: `0 2px 10px ${c.primaryGlow}` },
    ghost: {
      background: h ? c.surfaceSubtle : 'transparent',
      color: c.textSecondary,
      border: `1px solid ${c.border}`,
    },
  };
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setH(true)}
      onMouseLeave={() => setH(false)}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 7,
        padding: '9px 16px',
        borderRadius: 10,
        fontSize: 13,
        fontWeight: 650,
        cursor: 'pointer',
        border: 'none',
        transition: 'all 0.2s',
        width: full ? '100%' : undefined,
        ...styles[variant],
        ...xs,
      }}
    >
      {IC && <IC size={14} color={variant === 'ghost' ? c.textSecondary : 'white'} />}
      {children}
    </button>
  );
}
function StageChip({ stage }) {
  const s = STAGE[stage];
  return (
    <Pill color={s.color} bg={s.bg} small>
      {s.label}
    </Pill>
  );
}

// ── Stat tiles (clickable filters) ───────────────────────────────
function StatTiles({ tiles, active, onPick, mobile }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: mobile ? '1fr 1fr' : `repeat(${tiles.length}, 1fr)`,
        gap: 10,
      }}
    >
      {tiles.map((t, i) => {
        const on = active === t.key;
        return (
          <button
            key={t.key}
            onClick={() => onPick(on ? 'all' : t.key)}
            style={{
              textAlign: 'left',
              padding: '14px 16px',
              borderRadius: 14,
              cursor: 'pointer',
              border: `1.5px solid ${on ? t.border || c.primaryBorder : c.border}`,
              background: on ? t.bgOn || c.primaryLight : c.surface,
              boxShadow: on ? `0 0 0 3px ${c.primaryGlow}` : '0 1px 3px rgba(0,0,0,0.04)',
              transition: 'all 0.2s',
              ...slideUp(0.03 + i * 0.04),
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 6 }}>
              <t.icon size={13} color={t.color} />
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  color: c.textTertiary,
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                }}
              >
                {t.label}
              </span>
            </div>
            <p
              style={{
                fontSize: 26,
                fontWeight: 800,
                color: t.big ? t.color : c.text,
                margin: 0,
                lineHeight: 1,
              }}
            >
              {t.count}
            </p>
            {t.sub && (
              <p style={{ fontSize: 11.5, color: c.textTertiary, margin: '4px 0 0' }}>{t.sub}</p>
            )}
          </button>
        );
      })}
    </div>
  );
}

// ── Hero action card (needs-you, promoted) ───────────────────────
function HeroCard({ row, lens, index }) {
  return (
    <div
      style={{
        background: c.surface,
        borderRadius: 16,
        border: `1.5px solid ${c.primaryBorder}`,
        padding: '16px 18px',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        animation: `heroGlow 3s ease-in-out infinite, slideUp 0.4s ease-out ${0.08 + index * 0.06}s both`,
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          bottom: 0,
          width: 4,
          background: c.gradient,
        }}
      />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        {row.unread && (
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: c.primary,
              animation: 'dotPulse 1.6s ease-in-out infinite',
              flexShrink: 0,
            }}
          />
        )}
        <p
          style={{
            fontSize: 14.5,
            fontWeight: 700,
            color: c.text,
            margin: 0,
            flex: 1,
            minWidth: 0,
          }}
        >
          {row.title}
        </p>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        {row.company && <span style={{ fontSize: 12, color: c.textTertiary }}>{row.company}</span>}
        <StageChip stage={row.stage} />
        <span style={{ fontSize: 11.5, color: c.textTertiary }}>{row.updated}</span>
      </div>
      {row.chips && (
        <div className="balo-xscroll" style={{ display: 'flex', gap: 6 }}>
          {row.chips.map((ch) => (
            <Pill key={ch} small>
              {ch}
            </Pill>
          ))}
        </div>
      )}
      {row.signal && (
        <div style={{ padding: '9px 12px', borderRadius: 10, background: c.surfaceSubtle }}>
          <p style={{ fontSize: 12.5, color: c.text, margin: 0, lineHeight: 1.5 }}>
            <strong style={{ fontWeight: 650 }}>{row.signal.from}:</strong> {row.signal.msg}
          </p>
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, marginTop: 'auto' }}>
        <Btn variant="gradient" icon={I.zap} style={{ flex: 1 }}>
          {row.nudge}
        </Btn>
        <Btn variant="ghost" icon={I.chevRight} style={{ padding: '9px 12px' }} />
      </div>
    </div>
  );
}

// ── Tail list row (lean, scannable — the unbounded "everything else") ──
// A list, not a grid: this section grows with every request ever raised, and a
// single left-aligned column scans far faster than a Z-pattern grid as it grows.
// Lean by design — these are the NOT-needs-you items; anything worth a peek is
// already promoted into the hero above.
function ListRow({ row, index, last, mobile }) {
  const [h, setH] = useState(false);
  return (
    <button
      onClick={() => {}}
      onMouseEnter={() => setH(true)}
      onMouseLeave={() => setH(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 11,
        width: '100%',
        padding: '13px 16px',
        border: 'none',
        borderBottom: last ? 'none' : `1px solid ${c.borderSubtle}`,
        background: h ? c.surfaceSubtle + '80' : 'transparent',
        cursor: 'pointer',
        textAlign: 'left',
        transition: 'background 0.15s',
        ...fadeIn(0.1 + index * 0.03),
      }}
    >
      {/* Unread/needs dot — keeps list rows consistent with their hero card */}
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          flexShrink: 0,
          background: row.unread ? c.primary : 'transparent',
          animation: row.unread ? 'dotPulse 1.6s ease-in-out infinite' : 'none',
        }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <p
          style={{
            fontSize: 13.5,
            fontWeight: row.needsYou ? 700 : 600,
            color: c.text,
            margin: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {row.title}
        </p>
        <div
          style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 3, flexWrap: 'wrap' }}
        >
          {row.company && (
            <span style={{ fontSize: 11.5, color: c.textTertiary }}>{row.company}</span>
          )}
          <StageChip stage={row.stage} />
          {mobile && <span style={{ fontSize: 11, color: c.textTertiary }}>{row.updated}</span>}
        </div>
      </div>
      {/* Needs-you rows get the gradient nudge chip; others get quiet status (desktop) */}
      {row.needsYou ? (
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            padding: '4px 11px',
            borderRadius: 20,
            fontSize: 11.5,
            fontWeight: 700,
            color: 'white',
            background: c.gradient,
            boxShadow: `0 2px 8px ${c.primaryGlow}`,
            whiteSpace: 'nowrap',
            flexShrink: 0,
          }}
        >
          <I.zap size={10} color="white" />
          {row.nudge}
        </span>
      ) : (
        !mobile && (
          <span
            style={{
              fontSize: 12,
              color: c.textTertiary,
              whiteSpace: 'nowrap',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
            }}
          >
            <I.clock size={11} color={c.textTertiary} />
            {row.meta || row.nudge}
          </span>
        )
      )}
      {!mobile && (
        <span
          style={{
            fontSize: 11.5,
            color: c.textTertiary,
            whiteSpace: 'nowrap',
            minWidth: 56,
            textAlign: 'right',
          }}
        >
          {row.updated}
        </span>
      )}
      <I.chevRight size={15} color={c.textTertiary} style={{ flexShrink: 0 }} />
    </button>
  );
}

// ── Empty states (same invitations as the inbox variant) ─────────
function EmptyState({ lens }) {
  if (lens === 'client')
    return (
      <Card style={{ padding: '52px 32px', textAlign: 'center', ...slideUp(0.05) }}>
        <div
          style={{
            width: 56,
            height: 56,
            borderRadius: 15,
            background: c.gradientSubtle,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            margin: '0 auto 16px',
          }}
        >
          <I.briefcase size={24} color={c.primary} />
        </div>
        <h3 style={{ fontSize: 18, fontWeight: 700, color: c.text, margin: 0 }}>
          Start your first project
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
          Tell us what you're trying to get done in Salesforce. Balo matches you with vetted experts
          — you talk to them, compare proposals, and pick who you work with.
        </p>
        <div style={{ marginTop: 20 }}>
          <Btn variant="gradient" icon={I.plus}>
            Raise a project request
          </Btn>
        </div>
      </Card>
    );
  if (lens === 'expert')
    return (
      <Card style={{ padding: '52px 32px', textAlign: 'center', ...slideUp(0.05) }}>
        <div
          style={{
            width: 56,
            height: 56,
            borderRadius: 15,
            background: c.accentLight,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            margin: '0 auto 16px',
          }}
        >
          <I.inbox size={24} color={c.accent} />
        </div>
        <h3 style={{ fontSize: 18, fontWeight: 700, color: c.text, margin: 0 }}>
          No project invitations yet
        </h3>
        <p
          style={{
            fontSize: 13.5,
            color: c.textSecondary,
            margin: '8px auto 0',
            maxWidth: 400,
            lineHeight: 1.6,
          }}
        >
          When Balo matches you to a client request, the invitation lands here. A complete profile
          gets you matched more often.
        </p>
        <div style={{ marginTop: 20 }}>
          <Btn variant="ghost" icon={I.user}>
            Review your expert profile
          </Btn>
        </div>
      </Card>
    );
  return (
    <Card style={{ padding: '52px 32px', textAlign: 'center', ...slideUp(0.05) }}>
      <div
        style={{
          width: 56,
          height: 56,
          borderRadius: 15,
          background: c.successLight,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          margin: '0 auto 16px',
        }}
      >
        <I.coffee size={24} color={c.success} />
      </div>
      <h3 style={{ fontSize: 18, fontWeight: 700, color: c.text, margin: 0 }}>Queue clear 🎉</h3>
      <p
        style={{
          fontSize: 13.5,
          color: c.textSecondary,
          margin: '8px auto 0',
          maxWidth: 360,
          lineHeight: 1.6,
        }}
      >
        Nothing to triage and no stalled requests.
      </p>
    </Card>
  );
}

// ══════════════════════════════════════════════════════════════════
// PARTICIPANT DASHBOARD (client / expert)
// ══════════════════════════════════════════════════════════════════
function ParticipantDash({ lens, empty, mobile }) {
  const [filter, setFilter] = useState('all');
  if (empty) return <EmptyState lens={lens} />;
  const rows = lens === 'client' ? CLIENT_ROWS : EXPERT_ROWS;
  const needs = rows.filter((r) => r.needsYou);
  const inProgress = rows.filter((r) => !r.needsYou && r.stage !== 'kicked');
  const kicked = rows.filter((r) => r.stage === 'kicked');

  const tiles = [
    {
      key: 'needs',
      label: 'Needs you',
      count: needs.length,
      icon: I.zap,
      color: c.primary,
      big: true,
      bgOn: c.primaryLight,
      border: c.primaryBorder,
      sub: 'Sorted first',
    },
    {
      key: 'progress',
      label: 'In progress',
      count: inProgress.length,
      icon: I.clock,
      color: c.warning,
      sub: 'Waiting on others',
    },
    {
      key: 'kicked',
      label: 'Kicked off',
      count: kicked.length,
      icon: I.check,
      color: c.success,
      sub: 'Live projects',
    },
    {
      key: 'all',
      label: 'Total',
      count: rows.length,
      icon: I.briefcase,
      color: c.textSecondary,
      sub: lens === 'client' ? 'Your requests' : 'Your engagements',
    },
  ];

  // The list is the COMPLETE portfolio, ranked needs-you-first. Tiles filter it.
  // (Needs-you items appear BOTH here, badged, AND in the hero spotlight above —
  //  promotion, not partition.)
  const ranked = [...needs, ...inProgress, ...kicked];
  const listRows =
    filter === 'needs'
      ? needs
      : filter === 'progress'
        ? inProgress
        : filter === 'kicked'
          ? kicked
          : ranked;
  const showHero = (filter === 'all' || filter === 'needs') && needs.length > 0;
  const listLabel =
    filter === 'kicked'
      ? 'Live projects'
      : filter === 'progress'
        ? 'In progress'
        : filter === 'needs'
          ? 'Needs you'
          : lens === 'client'
            ? 'All requests'
            : 'All engagements';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <StatTiles tiles={tiles} active={filter} onPick={setFilter} mobile={mobile} />

      {/* Needs-you HERO — spotlight on top; these items ALSO appear in the list below */}
      {showHero && (
        <div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              marginBottom: 10,
              ...fadeIn(0.06),
            }}
          >
            <I.zap size={15} color={c.primary} />
            <span
              style={{
                fontSize: 12,
                fontWeight: 700,
                color: c.primary,
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
              }}
            >
              Needs your attention
            </span>
          </div>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: mobile ? '1fr' : `repeat(${Math.min(needs.length, 2)}, 1fr)`,
              gap: 12,
            }}
          >
            {needs.map((r, i) => (
              <HeroCard key={r.id} row={r} lens={lens} index={i} />
            ))}
          </div>
        </div>
      )}

      {/* Full portfolio LIST — complete & scannable; needs-you rows badged + ranked first */}
      {listRows.length > 0 && (
        <div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: 10,
              ...fadeIn(0.1),
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span
                style={{
                  fontSize: 12,
                  fontWeight: 700,
                  color: c.textTertiary,
                  textTransform: 'uppercase',
                  letterSpacing: '0.06em',
                }}
              >
                {listLabel}
              </span>
              <Pill small>{listRows.length}</Pill>
            </div>
            {lens === 'client' && (
              <Btn variant="ghost" icon={I.plus} style={{ padding: '7px 13px', fontSize: 12.5 }}>
                New request
              </Btn>
            )}
          </div>
          <Card style={{ overflow: 'hidden' }}>
            {listRows.map((r, i) => (
              <ListRow
                key={r.id}
                row={r}
                index={i}
                last={i === listRows.length - 1}
                mobile={mobile}
              />
            ))}
          </Card>
        </div>
      )}
      {filter === 'needs' && needs.length === 0 && (
        <Card style={{ padding: '36px 20px', textAlign: 'center' }}>
          <p style={{ fontSize: 13.5, fontWeight: 600, color: c.text, margin: 0 }}>
            Nothing needs you right now
          </p>
          <p style={{ fontSize: 12.5, color: c.textTertiary, margin: '4px 0 0' }}>
            You're all caught up.
          </p>
        </Card>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// ADMIN DASHBOARD — tiles + triage hero + pipeline mini-kanban
// ══════════════════════════════════════════════════════════════════
function AdminDash({ empty, mobile }) {
  if (empty) return <EmptyState lens="admin" />;
  const stalled = KANBAN.flatMap((k) => k.items).filter((i) => i.stalled).length;
  const tiles = [
    {
      key: 'triage',
      label: 'Untriaged',
      count: ADMIN_TRIAGE.length,
      icon: I.zap,
      color: c.warning,
      big: true,
      bgOn: c.warningLight,
      border: c.warningBorder,
      sub: 'Oldest 26h',
    },
    {
      key: 'stalled',
      label: 'Stalled',
      count: stalled,
      icon: I.alertCircle,
      color: c.error,
      big: true,
      sub: 'Need a chase',
    },
    {
      key: 'pipeline',
      label: 'In pipeline',
      count: KANBAN.flatMap((k) => k.items).length,
      icon: I.briefcase,
      color: c.textSecondary,
      sub: 'Active requests',
    },
    {
      key: 'gate',
      label: 'Kickoff gate',
      count: 1,
      icon: I.clock,
      color: c.emerald,
      sub: 'Awaiting payment',
    },
  ];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <StatTiles tiles={tiles} active={null} onPick={() => {}} mobile={mobile} />

      {/* Triage hero */}
      <div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            marginBottom: 10,
            ...fadeIn(0.06),
          }}
        >
          <I.zap size={15} color={c.warning} />
          <span
            style={{
              fontSize: 12,
              fontWeight: 700,
              color: c.warning,
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
            }}
          >
            Needs triage
          </span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: mobile ? '1fr' : '1fr 1fr', gap: 12 }}>
          {ADMIN_TRIAGE.map((t, i) => (
            <div
              key={t.id}
              style={{
                background: c.surface,
                borderRadius: 16,
                border: `1.5px solid ${c.warningBorder}`,
                padding: '16px 18px',
                ...slideUp(0.08 + i * 0.05),
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <p style={{ fontSize: 14.5, fontWeight: 700, color: c.text, margin: 0, flex: 1 }}>
                  {t.title}
                </p>
                {t.sla === 'warn' && (
                  <Pill small color={c.error} bg={c.errorLight} icon={I.alertCircle}>
                    &gt;24h
                  </Pill>
                )}
              </div>
              <p style={{ fontSize: 12, color: c.textTertiary, margin: '0 0 12px' }}>
                {t.company} · raised {t.raised}
              </p>
              <div style={{ display: 'flex', gap: 8 }}>
                <Btn variant="primary" icon={I.users} style={{ flex: 1 }}>
                  Triage
                </Btn>
                <Btn variant="ghost" icon={I.fileText} style={{ padding: '9px 12px' }} />
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Pipeline mini-kanban — "where is everything stuck" */}
      <div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            marginBottom: 10,
            ...fadeIn(0.12),
          }}
        >
          <I.briefcase size={15} color={c.textSecondary} />
          <span
            style={{
              fontSize: 12,
              fontWeight: 700,
              color: c.textSecondary,
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
            }}
          >
            Pipeline by stage
          </span>
        </div>
        <div
          className="balo-xscroll"
          style={{ display: 'flex', gap: 12, alignItems: 'stretch', paddingBottom: 4 }}
        >
          {KANBAN.map((col, ci) => (
            <div
              key={col.key}
              style={{ minWidth: mobile ? 240 : 230, flex: 1, ...slideUp(0.14 + ci * 0.05) }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '0 4px 8px' }}>
                <StageChip stage={col.key} />
                <span style={{ fontSize: 11.5, fontWeight: 700, color: c.textTertiary }}>
                  {col.items.length}
                </span>
              </div>
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8,
                  padding: 8,
                  borderRadius: 14,
                  background: c.surfaceSubtle,
                  minHeight: 110,
                }}
              >
                {col.items.map((it) => (
                  <div
                    key={it.title}
                    style={{
                      background: c.surface,
                      borderRadius: 11,
                      border: `1px solid ${it.stalled ? '#FECACA' : c.borderSubtle}`,
                      padding: '11px 13px',
                      cursor: 'pointer',
                    }}
                  >
                    <p
                      style={{
                        fontSize: 13,
                        fontWeight: 650,
                        color: c.text,
                        margin: 0,
                        lineHeight: 1.35,
                      }}
                    >
                      {it.title}
                    </p>
                    <p style={{ fontSize: 11.5, color: c.textTertiary, margin: '3px 0 0' }}>
                      {it.company} · {it.updated}
                    </p>
                    {it.stalled && (
                      <div style={{ marginTop: 7 }}>
                        <Pill small color={c.error} bg={c.errorLight} icon={I.alertCircle}>
                          {it.stalled}
                        </Pill>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// CONTROL BAR + MAIN
// ══════════════════════════════════════════════════════════════════
function ControlBar({ actor, setActor, mobile, setMobile, empty, setEmpty }) {
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
          maxWidth: 1000,
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
        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 7,
            fontSize: 12.5,
            color: c.textSecondary,
            cursor: 'pointer',
            marginLeft: 'auto',
          }}
        >
          <input
            type="checkbox"
            checked={empty}
            onChange={(e) => setEmpty(e.target.checked)}
            style={{ accentColor: c.primary }}
          />
          Empty state
        </label>
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

export default function ProjectsA7() {
  const [actor, setActor] = useState('client');
  const [mobile, setMobile] = useState(false);
  const [empty, setEmpty] = useState(false);
  const am = ACTORS.find((a) => a.key === actor);

  const inner = (
    <div key={`${actor}-${empty}`}>
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
      </div>
      <div style={{ marginBottom: 18, ...slideUp(0) }}>
        <h1 style={{ fontSize: 22, fontWeight: 800, color: c.text, margin: 0 }}>Projects</h1>
        <p style={{ fontSize: 13, color: c.textTertiary, margin: '3px 0 0' }}>
          {actor === 'admin'
            ? 'Triage new requests and keep the pipeline moving.'
            : actor === 'expert'
              ? 'Your invitations and active engagements.'
              : 'Your project requests, from idea to kickoff.'}
        </p>
      </div>
      {actor === 'admin' ? (
        <AdminDash empty={empty} mobile={mobile} />
      ) : (
        <ParticipantDash lens={actor} empty={empty} mobile={mobile} />
      )}
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
        mobile={mobile}
        setMobile={setMobile}
        empty={empty}
        setEmpty={setEmpty}
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
        <div style={{ maxWidth: 1000, margin: '0 auto', padding: '24px 28px 80px' }}>{inner}</div>
      )}
    </div>
  );
}
