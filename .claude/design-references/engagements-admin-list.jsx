import { useState } from 'react';

// ══════════════════════════════════════════════════════════════════
// BAL-335 (D5) — ADMIN OVERSIGHT: active-engagements list + stalled flag
// Route: /(dashboard)/engagements   ·   Lane C of BAL-329 (Project Delivery)
//
// MJ's oversight surface — the one screen that answers "where is delivery
// right now?": which projects are in flight, which have gone quiet, and
// which are sitting in client review with money about to trigger. It is a
// PULL surface (no nudges in v1) and admin-only (no client/expert view).
//
// Sits alongside the pipeline board (the /projects admin lens): the pipeline
// ends at kickoff; THIS list begins at kickoff. Rows link to the engagement
// admin lens at /engagements/[id] (D4 — where cancel lives).
//
// Grounded in the SHIPPED admin lens (project-inbox-a7 → AdminDash):
//   · StatTiles-as-filters (the tiles ARE the filter control)
//   · the destructive "stalled" chip from the pipeline kanban
//   · the SectionLabel / EmptyState / ErrorState scaffolding
//   · the engagement vocabulary + copy rules from engagement-delivery.jsx
//
// DECISIONS THIS PROTOTYPE ENCODES
//   · FILTER = the five ticket statuses as clickable stat tiles
//       [ Active · In review · Stalled · Completed · Cancelled ]
//     DEFAULT = "in flight" (active + in review) — no single tile selected;
//     the two in-flight tiles carry an "included" tint so the composite
//     default reads at a glance. Click a tile to narrow; click again to
//     return to the in-flight default. (count_active / count_in_review /
//     count_stalled — the analytics props — are the first three tiles.)
//   · STALLED = no milestone activity in STALLED_AFTER_DAYS (14). Same
//     destructive pattern as the pipeline "Quiet N days" flag. A newly
//     kicked-off engagement measures quiet from activated_at (kickoff), so
//     a fresh project is never falsely stalled.
//   · IN REVIEW = pending_acceptance rows state the auto-accept date as a
//     HELPFUL FACT ("Auto-accepts 19 Jun"), never an adversarial countdown.
//     Prospective sub-copy names the PARTY ("Northwind can accept or request
//     changes until 19 Jun"). This is MJ seeing money about to move.
//   · COPY ATTRIBUTION (by tense, from BAL-329):
//       – PROSPECTIVE names the PARTY: client company ("Northwind …"),
//         expert's agency when agency-based, else the expert's own name.
//       – RETROSPECTIVE names the PERSON, "@ company/agency" on first
//         mention: "Accepted by Dana Whitfield @ Northwind Industrial",
//         "Cancelled by MJ Okonkwo @ Balo". Toggle "Agency expert" in the
//         control bar to verify independent vs agency attribution.
//     Gender-neutral throughout — names or roles, never pronouns.
//   · ONE emphasized action per surface: loaded → the next-best-action chip
//     in the header (chase stalled, else review in-review, else none — a
//     monitor surface earns no gradient button when nothing's urgent);
//     empty-filtered → "Clear filter"; empty-zero → "Go to pipeline";
//     error → "Retry".
//   · FIVE states, switchable in the control bar: loaded · loading · error ·
//     empty (filtered) · empty (true zero). The true-zero copy EXPLAINS how
//     engagements come to exist (they materialize when a client accepts a
//     proposal) — a bare "No engagements yet" would be a defect here.
// ══════════════════════════════════════════════════════════════════

const STALLED_AFTER_DAYS = 14; // no milestone activity in N days → stalled. Product-tunable; start at 14, get real signal, then tune (v2 may push an admin nudge). Mirrors QUIET_THRESHOLD_DAYS / AUTO_ACCEPT_DAYS — a named const, never a magic number.
const AUTO_ACCEPT_DAYS = 7; // client review window; auto-accept date = completion_requested_at + 7d. Snapshot of the D0 constant for the worked example.

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
  errorBorder: '#FECACA',
  cyan: '#0891B2',
  gradient: 'linear-gradient(135deg, #2563EB 0%, #7C3AED 100%)',
  gradientSubtle: 'linear-gradient(135deg, #EFF6FF 0%, #F5F3FF 100%)',
  gradientWarm: 'linear-gradient(135deg, #D97706 0%, #DC2626 100%)',
};

// ── Icons (Lucide paths; matches the design-reference convention) ──
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
const Multi = ({ children, size = 16, color = 'currentColor', style: xs }) => (
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
    {children}
  </svg>
);
const I = {
  check: (p) => <Icon {...p} d="M20 6L9 17l-5-5" />,
  chevRight: (p) => <Icon {...p} d="M9 18l6-6-6-6" />,
  chevLeft: (p) => <Icon {...p} d="M15 18l-6-6 6-6" />,
  arrowRight: (p) => <Icon {...p} d="M5 12h14M12 5l7 7-7 7" />,
  plus: (p) => <Icon {...p} d="M12 5v14M5 12h14" />,
  clock: (p) => (
    <Multi {...p}>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 6v6l4 2" />
    </Multi>
  ),
  user: (p) => (
    <Multi {...p}>
      <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </Multi>
  ),
  building: (p) => (
    <Multi {...p}>
      <path d="M3 21h18M6 21V5a2 2 0 012-2h8a2 2 0 012 2v16" />
      <path d="M9 8h.01M15 8h.01M9 12h.01M15 12h.01M9 16h.01M15 16h.01" />
    </Multi>
  ),
  briefcase: (p) => (
    <Icon
      {...p}
      d="M20 7H4a2 2 0 00-2 2v10a2 2 0 002 2h16a2 2 0 002-2V9a2 2 0 00-2-2zM16 21V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v16"
    />
  ),
  flag: (p) => (
    <Multi {...p}>
      <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" />
      <path d="M4 22v-7" />
    </Multi>
  ),
  alertCircle: (p) => (
    <Multi {...p}>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 8v4M12 16h.01" />
    </Multi>
  ),
  alertTriangle: (p) => (
    <Multi {...p}>
      <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
      <path d="M12 9v4M12 17h.01" />
    </Multi>
  ),
  xCircle: (p) => (
    <Multi {...p}>
      <circle cx="12" cy="12" r="10" />
      <path d="M15 9l-6 6M9 9l6 6" />
    </Multi>
  ),
  coffee: (p) => (
    <Multi {...p}>
      <path d="M18 8h1a4 4 0 010 8h-1M2 8h16v9a4 4 0 01-4 4H6a4 4 0 01-4-4V8zM6 1v3M10 1v3M14 1v3" />
    </Multi>
  ),
  inbox: (p) => (
    <Multi {...p}>
      <polyline points="22 12 16 12 14 15 10 15 8 12 2 12" />
      <path d="M5.45 5.11L2 12v6a2 2 0 002 2h16a2 2 0 002-2v-6l-3.45-6.89A2 2 0 0016.76 4H7.24a2 2 0 00-1.79 1.11z" />
    </Multi>
  ),
  zap: (p) => <Icon {...p} d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />,
  rotate: (p) => (
    <Multi {...p}>
      <path d="M23 4v6h-6M1 20v-6h6" />
      <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
    </Multi>
  ),
  filter: (p) => <Icon {...p} d="M22 3H2l8 9.46V19l4 2v-8.54L22 3z" />,
  layers: (p) => (
    <Multi {...p}>
      <polygon points="12 2 2 7 12 12 22 7 12 2" />
      <polyline points="2 17 12 22 22 17" />
      <polyline points="2 12 12 17 22 12" />
    </Multi>
  ),
};

const keyframes = `
@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
@keyframes slideUp { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: translateY(0); } }
@keyframes dotPulse { 0%,100% { transform: scale(1); opacity: 1; } 50% { transform: scale(1.35); opacity: 0.7; } }
@keyframes shimmer { 0% { background-position: -420px 0; } 100% { background-position: 420px 0; } }
.balo-xscroll { overflow-x: auto; -webkit-overflow-scrolling: touch; scrollbar-width: none; flex-wrap: nowrap; }
.balo-xscroll::-webkit-scrollbar { display: none; }
`;
const slideUp = (d = 0) => ({ animation: `slideUp 0.4s ease-out ${d}s both` });
const fadeIn = (d = 0) => ({ animation: `fadeIn 0.35s ease-out ${d}s both` });

// ── Engagement status vocabulary (D0 enum) ───────────────────────
const STATUS = {
  active: { label: 'Active', color: c.primary, bg: c.primaryLight, border: c.primaryBorder },
  pending_acceptance: {
    label: 'In review',
    color: c.warning,
    bg: c.warningLight,
    border: c.warningBorder,
  },
  completed: { label: 'Completed', color: c.success, bg: c.successLight, border: c.successBorder },
  cancelled: {
    label: 'Cancelled',
    color: c.textTertiary,
    bg: c.surfaceSubtle,
    border: c.border,
  },
};

// ── Worked data: the delivery portfolio after kickoff ────────────
// Continuous with A6/A7 — Northwind's CPQ is the anchor. Gender-neutral
// names throughout; a mix of agency-based and independent experts so both
// attribution modes are visible. `quietDays` measures from the last
// milestone activity (kickoff for a fresh project).
const ROWS = [
  {
    id: 'e-cpq',
    title: 'CPQ implementation — replace legacy quoting tool',
    client: 'Northwind Industrial',
    expert: 'Priya Nair',
    agency: 'CloudPeak', // agency-based expert (toggle "Agency expert" flips this one)
    status: 'active',
    pricing: 'fixed',
    priceCents: 5_800_000,
    done: 2,
    total: 4,
    kickoff: '12 Jun',
    lastActivity: '2h ago',
    quietDays: 0,
  },
  {
    id: 'e-svc',
    title: 'Service Cloud migration from Zendesk',
    client: 'Meridian Retail',
    expert: 'Tom Okafor',
    agency: null, // independent
    status: 'pending_acceptance',
    pricing: 'fixed',
    priceCents: 4_200_000,
    done: 5,
    total: 5,
    kickoff: '2 May',
    lastActivity: '3d ago',
    quietDays: 3,
    completionRequestedAt: '12 Jun',
    autoAcceptOn: '19 Jun', // completion_requested_at + AUTO_ACCEPT_DAYS
  },
  {
    id: 'e-exp',
    title: 'Experience Cloud patient portal',
    client: 'Harbour Health',
    expert: 'Marcus Lee',
    agency: 'Northstar Consulting',
    status: 'active',
    pricing: 'tm',
    rateCents: 21_000, // A$210/hr
    priceCents: 6_000_000, // T&M cap
    done: 1,
    total: 5,
    kickoff: '14 May',
    lastActivity: '18d ago',
    quietDays: 18, // → STALLED (> 14)
  },
  {
    id: 'e-rev',
    title: 'Revenue Cloud billing setup',
    client: 'Vector Logistics',
    expert: 'Sofia Alvarez',
    agency: null,
    status: 'pending_acceptance',
    pricing: 'fixed',
    priceCents: 3_600_000,
    done: 3,
    total: 3,
    kickoff: '28 Apr',
    lastActivity: '16d ago',
    quietDays: 16, // in review AND quiet → surfaces under both In review and Stalled
    completionRequestedAt: '21 May',
    autoAcceptOn: '28 May',
  },
  {
    id: 'e-shc',
    title: 'Sales Cloud health check — FY26 prep',
    client: 'Bright Foods',
    expert: 'Aisha Bello',
    agency: 'CloudPeak',
    status: 'completed',
    pricing: 'fixed',
    priceCents: 2_200_000,
    done: 3,
    total: 3,
    kickoff: '4 Apr',
    lastActivity: '3 Jun',
    quietDays: 34,
    acceptedBy: 'Sam Rivera',
    acceptedByCompany: 'Bright Foods',
    acceptedOn: '3 Jun',
    acceptanceMethod: 'client', // 'client' | 'auto'
  },
  {
    id: 'e-mkt',
    title: 'Marketing Cloud account audit',
    client: 'Pacific Retail Group',
    expert: 'Ravi Menon',
    agency: null,
    status: 'cancelled',
    pricing: 'fixed',
    priceCents: 3_100_000,
    done: 1,
    total: 4,
    kickoff: '9 Apr',
    lastActivity: '28 May',
    quietDays: 40,
    cancelledBy: 'MJ Okonkwo',
    cancelledByCompany: 'Balo',
    cancelledOn: '28 May',
    cancelReason:
      'Pacific Retail paused the programme after the acquisition — both parties agreed to stop at milestone 1.',
  },
];

const fmtMoney = (cents) => 'A$' + Math.round(cents / 100).toLocaleString('en-AU');
const isStalled = (r) =>
  (r.status === 'active' || r.status === 'pending_acceptance') && r.quietDays >= STALLED_AFTER_DAYS;
// Prospective attribution: the expert's agency when agency-based, else their own name.
const expertParty = (r, agencyMode) => (agencyMode && r.agency ? r.agency : r.expert);
// Retrospective first-mention: person "@ company/agency".
const expertPerson = (r, agencyMode) =>
  agencyMode && r.agency ? `${r.expert} @ ${r.agency}` : r.expert;

// ── Primitives (identical idiom to the shipped admin lens) ───────
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
function Btn({ children, icon: IC, variant = 'primary', onClick, style: xs, full, small }) {
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
        padding: small ? '7px 13px' : '9px 16px',
        borderRadius: 10,
        fontSize: small ? 12.5 : 13,
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
function SectionLabel({ icon: IC, color = c.textTertiary, children, right }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: 10,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {IC && <IC size={14} color={color} />}
        <span
          style={{
            fontSize: 12,
            fontWeight: 700,
            color,
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
          }}
        >
          {children}
        </span>
      </div>
      {right}
    </div>
  );
}
function StatusChip({ status }) {
  const s = STATUS[status];
  return (
    <Pill color={s.color} bg={s.bg} border={s.border} small>
      {s.label}
    </Pill>
  );
}
// The destructive stalled flag — same pattern as the pipeline "Quiet N days".
function StalledChip({ days }) {
  return (
    <Pill color={c.error} bg={c.errorLight} border={c.errorBorder} icon={I.alertTriangle} small>
      Quiet {days}d
    </Pill>
  );
}
// Compact N-of-M progress with a thin fill bar.
function Progress({ done, total }) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
      <span
        style={{
          fontVariantNumeric: 'tabular-nums',
          fontSize: 12,
          fontWeight: 650,
          color: c.textSecondary,
        }}
      >
        {done} of {total}
      </span>
      <span
        style={{
          width: 44,
          height: 5,
          borderRadius: 3,
          background: c.surfaceSubtle,
          overflow: 'hidden',
          display: 'inline-block',
        }}
      >
        <span
          style={{
            display: 'block',
            height: '100%',
            width: `${pct}%`,
            borderRadius: 3,
            background: done === total && total > 0 ? c.success : c.gradient,
          }}
        />
      </span>
    </span>
  );
}
const Dot = ({ color, pulse }) => (
  <span
    style={{
      width: 8,
      height: 8,
      borderRadius: '50%',
      flexShrink: 0,
      background: color,
      animation: pulse ? 'dotPulse 1.6s ease-in-out infinite' : 'none',
    }}
  />
);

// ── Stat tiles — the at-a-glance counts AND the filter control ───
function StatTiles({ tiles, filter, onPick, mobile }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: mobile ? '1fr 1fr' : `repeat(${tiles.length}, 1fr)`,
        gap: 10,
      }}
    >
      {tiles.map((t, i) => {
        const selected = filter === t.key;
        // "included" = part of the composite in-flight default (no single tile picked)
        const included = filter === 'flight' && (t.key === 'active' || t.key === 'in_review');
        const on = selected || included;
        return (
          <button
            key={t.key}
            onClick={() => onPick(selected ? 'flight' : t.key)}
            title={t.hint}
            style={{
              textAlign: 'left',
              padding: '14px 16px',
              borderRadius: 14,
              cursor: 'pointer',
              border: `1.5px solid ${on ? t.border : c.border}`,
              background: selected ? t.bgOn : included ? t.bgOn + '80' : c.surface,
              boxShadow: selected ? `0 0 0 3px ${t.glow}` : '0 1px 3px rgba(0,0,0,0.04)',
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
                color: t.count > 0 ? t.color : c.textTertiary,
                margin: 0,
                lineHeight: 1,
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {t.count}
            </p>
            <p style={{ fontSize: 11.5, color: c.textTertiary, margin: '4px 0 0' }}>{t.sub}</p>
          </button>
        );
      })}
    </div>
  );
}

// ── The engagement row — the heart of the list ───────────────────
function EngagementRow({ row, index, last, mobile, agencyMode }) {
  const [h, setH] = useState(false);
  const stalled = isStalled(row);
  const pricing =
    row.pricing === 'fixed'
      ? `Fixed · ${fmtMoney(row.priceCents)}`
      : `T&M · ${fmtMoney(row.rateCents)}/hr · cap ${fmtMoney(row.priceCents)}`;

  // Status-specific fact line (retrospective attribution: person @ company).
  let factLine = null;
  if (row.status === 'pending_acceptance') {
    // Helpful fact — the date, framed as reassurance, never a countdown.
    factLine = (
      <span style={{ color: c.warning, fontWeight: 600 }}>
        Auto-accepts {row.autoAcceptOn}
        <span style={{ color: c.textTertiary, fontWeight: 400 }}>
          {' '}
          — {row.client} can accept or request changes until then
        </span>
      </span>
    );
  } else if (row.status === 'completed') {
    factLine =
      row.acceptanceMethod === 'auto' ? (
        <span style={{ color: c.textTertiary }}>Auto-accepted {row.acceptedOn}</span>
      ) : (
        <span style={{ color: c.textTertiary }}>
          Accepted by {row.acceptedBy} @ {row.acceptedByCompany} · {row.acceptedOn}
        </span>
      );
  } else if (row.status === 'cancelled') {
    factLine = (
      <span style={{ color: c.textTertiary }}>
        Cancelled by {row.cancelledBy} @ {row.cancelledByCompany} · {row.cancelledOn} —{' '}
        {row.cancelReason}
      </span>
    );
  } else if (stalled) {
    factLine = (
      <span style={{ color: c.error, fontWeight: 600 }}>
        No milestone activity in {row.quietDays} days
      </span>
    );
  }

  return (
    <a
      href={`/engagements/${row.id}`}
      onClick={(e) => e.preventDefault()}
      onMouseEnter={() => setH(true)}
      onMouseLeave={() => setH(false)}
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 12,
        padding: '15px 18px',
        borderBottom: last ? 'none' : `1px solid ${c.borderSubtle}`,
        background: h ? c.surfaceSubtle + '70' : 'transparent',
        cursor: 'pointer',
        textDecoration: 'none',
        transition: 'background 0.15s',
        ...fadeIn(0.06 + index * 0.03),
      }}
    >
      <div style={{ paddingTop: 4 }}>
        <Dot
          color={STATUS[row.status].color}
          pulse={row.status === 'active' || row.status === 'pending_acceptance'}
        />
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        {/* Line 1 — title + inline stalled flag */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <p
            style={{
              fontSize: 14,
              fontWeight: 700,
              color: c.text,
              margin: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: mobile ? 'normal' : 'nowrap',
              maxWidth: mobile ? '100%' : 460,
            }}
          >
            {row.title}
          </p>
          {stalled && <StalledChip days={row.quietDays} />}
        </div>

        {/* Line 2 — parties: client company + expert person (@ agency) */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            marginTop: 5,
            flexWrap: 'wrap',
          }}
        >
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <I.building size={12} color={c.textTertiary} />
            <span style={{ fontSize: 12.5, fontWeight: 600, color: c.textSecondary }}>
              {row.client}
            </span>
          </span>
          <span style={{ color: c.borderSubtle }}>·</span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <I.user size={12} color={c.textTertiary} />
            <span style={{ fontSize: 12.5, color: c.textSecondary }}>
              {expertPerson(row, agencyMode)}
            </span>
          </span>
        </div>

        {/* Line 3 — progress · pricing · kickoff */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            marginTop: 8,
            flexWrap: 'wrap',
          }}
        >
          <Progress done={row.done} total={row.total} />
          <span style={{ color: c.borderSubtle }}>·</span>
          <span
            style={{
              fontSize: 12,
              color: c.textSecondary,
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {pricing}
          </span>
          <span style={{ color: c.borderSubtle }}>·</span>
          <span style={{ fontSize: 12, color: c.textTertiary }}>Kicked off {row.kickoff}</span>
        </div>

        {/* Line 4 — status-specific fact (money about to move / who accepted / why cancelled) */}
        {factLine && <p style={{ fontSize: 12, margin: '8px 0 0', lineHeight: 1.5 }}>{factLine}</p>}
      </div>

      {/* Right rail — status chip + last activity + chevron */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-end',
          gap: 8,
          flexShrink: 0,
        }}
      >
        <StatusChip status={row.status} />
        {!mobile && (
          <span
            style={{
              fontSize: 11.5,
              color: c.textTertiary,
              whiteSpace: 'nowrap',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
            }}
          >
            <I.clock size={11} color={c.textTertiary} />
            {row.lastActivity}
          </span>
        )}
      </div>
      <I.chevRight size={16} color={c.textTertiary} style={{ flexShrink: 0, marginTop: 4 }} />
    </a>
  );
}

// ── LOADED — the full oversight list ─────────────────────────────
function LoadedList({ mobile, agencyMode }) {
  const [filter, setFilter] = useState('flight'); // default: active + in review

  const countActive = ROWS.filter((r) => r.status === 'active').length;
  const countInReview = ROWS.filter((r) => r.status === 'pending_acceptance').length;
  const countStalled = ROWS.filter(isStalled).length;
  const countCompleted = ROWS.filter((r) => r.status === 'completed').length;
  const countCancelled = ROWS.filter((r) => r.status === 'cancelled').length;

  const tiles = [
    {
      key: 'active',
      label: 'Active',
      count: countActive,
      icon: I.briefcase,
      color: c.primary,
      border: c.primaryBorder,
      bgOn: c.primaryLight,
      glow: c.primaryGlow,
      sub: 'Delivering',
      hint: 'Engagements in active delivery',
    },
    {
      key: 'in_review',
      label: 'In review',
      count: countInReview,
      icon: I.clock,
      color: c.warning,
      border: c.warningBorder,
      bgOn: c.warningLight,
      glow: 'rgba(217,119,6,0.14)',
      sub: 'Auto-accept pending',
      hint: 'Completion requested — client is reviewing',
    },
    {
      key: 'stalled',
      label: 'Stalled',
      count: countStalled,
      icon: I.alertTriangle,
      color: c.error,
      border: c.errorBorder,
      bgOn: c.errorLight,
      glow: 'rgba(220,38,38,0.14)',
      sub: `Quiet ${STALLED_AFTER_DAYS}+ days`,
      hint: `No milestone activity in ${STALLED_AFTER_DAYS}+ days`,
    },
    {
      key: 'completed',
      label: 'Completed',
      count: countCompleted,
      icon: I.check,
      color: c.success,
      border: c.successBorder,
      bgOn: c.successLight,
      glow: 'rgba(5,150,105,0.14)',
      sub: 'Accepted',
      hint: 'Accepted (by the client or auto)',
    },
    {
      key: 'cancelled',
      label: 'Cancelled',
      count: countCancelled,
      icon: I.xCircle,
      color: c.textSecondary,
      border: c.border,
      bgOn: c.surfaceSubtle,
      glow: 'rgba(0,0,0,0.05)',
      sub: 'Stopped',
      hint: 'Cancelled by an admin, with a recorded reason',
    },
  ];

  const match = (r) => {
    if (filter === 'flight') return r.status === 'active' || r.status === 'pending_acceptance';
    if (filter === 'stalled') return isStalled(r);
    if (filter === 'active') return r.status === 'active';
    if (filter === 'in_review') return r.status === 'pending_acceptance';
    return r.status === filter; // completed | cancelled
  };
  const rows = ROWS.filter(match);

  const filterLabel = {
    flight: 'In flight',
    active: 'Active',
    in_review: 'In review',
    stalled: 'Stalled',
    completed: 'Completed',
    cancelled: 'Cancelled',
  }[filter];
  const filterSub =
    filter === 'flight' ? 'Active + in review — what delivery is working on right now' : null;

  // ONE emphasized action: chase stalled first, else review in-review, else none.
  let nextBest = null;
  if (countStalled > 0)
    nextBest = { key: 'stalled', label: `Chase ${countStalled} stalled`, tone: 'warm' };
  else if (countInReview > 0)
    nextBest = { key: 'in_review', label: `${countInReview} in client review`, tone: 'amber' };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Header with the single emphasized next-best-action */}
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-end',
          justifyContent: 'space-between',
          gap: 12,
          flexWrap: 'wrap',
          ...slideUp(0),
        }}
      >
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 800, color: c.text, margin: 0 }}>Engagements</h1>
          <p style={{ fontSize: 13, color: c.textTertiary, margin: '3px 0 0' }}>
            Delivery oversight — what&rsquo;s in flight, in review, or gone quiet.
          </p>
        </div>
        {nextBest && (
          <button
            onClick={() => setFilter(nextBest.key)}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 7,
              padding: '9px 15px',
              borderRadius: 10,
              border: 'none',
              cursor: 'pointer',
              fontSize: 13,
              fontWeight: 650,
              color: 'white',
              background: nextBest.tone === 'warm' ? c.gradientWarm : c.warning,
              boxShadow: '0 2px 10px rgba(217,119,6,0.22)',
            }}
          >
            <I.zap size={14} color="white" />
            {nextBest.label}
            <I.arrowRight size={14} color="white" />
          </button>
        )}
      </div>

      <StatTiles tiles={tiles} filter={filter} onPick={setFilter} mobile={mobile} />

      <div>
        <SectionLabel
          icon={I.filter}
          right={
            filter !== 'flight' ? (
              <button
                onClick={() => setFilter('flight')}
                style={{
                  border: 'none',
                  background: 'transparent',
                  cursor: 'pointer',
                  fontSize: 12,
                  fontWeight: 600,
                  color: c.primary,
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                }}
              >
                <I.rotate size={12} color={c.primary} />
                Back to in flight
              </button>
            ) : null
          }
        >
          {filterLabel} · {rows.length}
        </SectionLabel>
        {filterSub && (
          <p style={{ fontSize: 12, color: c.textTertiary, margin: '-4px 0 10px' }}>{filterSub}</p>
        )}

        {rows.length > 0 ? (
          <Card style={{ overflow: 'hidden', ...slideUp(0.05) }}>
            {rows.map((r, i) => (
              <EngagementRow
                key={r.id}
                row={r}
                index={i}
                last={i === rows.length - 1}
                mobile={mobile}
                agencyMode={agencyMode}
              />
            ))}
          </Card>
        ) : (
          <FilteredEmpty
            filter={filter}
            filterLabel={filterLabel}
            onClear={() => setFilter('flight')}
          />
        )}
      </div>
    </div>
  );
}

// ── EMPTY (filtered) — a filter is on but nothing matches ────────
// Framed as a good outcome; the ONE action clears back to the default.
function FilteredEmpty({ filter, filterLabel, onClear }) {
  const copy = {
    stalled: {
      icon: I.coffee,
      iconBg: c.successLight,
      iconColor: c.success,
      title: 'Nothing has gone quiet',
      body: `No engagement has been silent for ${STALLED_AFTER_DAYS}+ days. Delivery is moving.`,
    },
    in_review: {
      icon: I.check,
      iconBg: c.successLight,
      iconColor: c.success,
      title: 'Nothing waiting on a client',
      body: 'No engagement is sitting in client review right now — no acceptance is about to trigger.',
    },
    completed: {
      icon: I.flag,
      iconBg: c.primaryLight,
      iconColor: c.primary,
      title: 'No completed engagements yet',
      body: 'When a client accepts a finished project — or it auto-accepts after the review window — it lands here.',
    },
    cancelled: {
      icon: I.check,
      iconBg: c.successLight,
      iconColor: c.success,
      title: 'Nothing cancelled',
      body: 'No engagement has been stopped. Cancellations show here with the reason on the record.',
    },
    active: {
      icon: I.inbox,
      iconBg: c.primaryLight,
      iconColor: c.primary,
      title: 'Nothing in active delivery',
      body: 'No engagement is mid-delivery right now.',
    },
  }[filter] || {
    icon: I.inbox,
    iconBg: c.surfaceSubtle,
    iconColor: c.textSecondary,
    title: `No ${filterLabel.toLowerCase()} engagements`,
    body: 'Nothing matches this filter right now.',
  };

  return (
    <Card style={{ padding: '44px 30px', textAlign: 'center', ...slideUp(0.05) }}>
      <div
        style={{
          width: 54,
          height: 54,
          borderRadius: 15,
          background: copy.iconBg,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          margin: '0 auto 15px',
        }}
      >
        <copy.icon size={23} color={copy.iconColor} />
      </div>
      <h3 style={{ fontSize: 17, fontWeight: 750, color: c.text, margin: 0 }}>{copy.title}</h3>
      <p
        style={{
          fontSize: 13,
          color: c.textSecondary,
          margin: '8px auto 0',
          maxWidth: 380,
          lineHeight: 1.6,
        }}
      >
        {copy.body}
      </p>
      <div style={{ marginTop: 18 }}>
        <Btn variant="primary" icon={I.rotate} onClick={onClear}>
          Back to in flight
        </Btn>
      </div>
    </Card>
  );
}

// ── EMPTY (true zero) — no engagements exist at all ──────────────
// MUST explain how engagements come to be — they materialize on acceptance.
function ZeroState() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div style={{ ...slideUp(0) }}>
        <h1 style={{ fontSize: 22, fontWeight: 800, color: c.text, margin: 0 }}>Engagements</h1>
        <p style={{ fontSize: 13, color: c.textTertiary, margin: '3px 0 0' }}>
          Delivery oversight — what&rsquo;s in flight, in review, or gone quiet.
        </p>
      </div>
      <Card style={{ padding: '52px 32px', textAlign: 'center', ...slideUp(0.05) }}>
        <div
          style={{
            width: 58,
            height: 58,
            borderRadius: 16,
            background: c.gradientSubtle,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            margin: '0 auto 16px',
          }}
        >
          <I.layers size={25} color={c.primary} />
        </div>
        <h3 style={{ fontSize: 18, fontWeight: 750, color: c.text, margin: 0 }}>
          No engagements in flight yet
        </h3>
        <p
          style={{
            fontSize: 13.5,
            color: c.textSecondary,
            margin: '10px auto 0',
            maxWidth: 440,
            lineHeight: 1.65,
          }}
        >
          An engagement is created the moment a client accepts a proposal — that&rsquo;s when a
          project kicks off and delivery begins. Approve a kickoff from the pipeline and the first
          one will appear here, with its milestones, value, and activity.
        </p>
        <div style={{ marginTop: 20 }}>
          <Btn variant="gradient" icon={I.arrowRight}>
            Go to the pipeline
          </Btn>
        </div>
      </Card>
    </div>
  );
}

// ── LOADING — skeleton mirroring the real layout ─────────────────
function LoadingList({ mobile }) {
  const shimmer = {
    background: `linear-gradient(90deg, ${c.surfaceSubtle} 0px, #E9EEF5 220px, ${c.surfaceSubtle} 440px)`,
    backgroundSize: '840px 100%',
    animation: 'shimmer 1.3s linear infinite',
    borderRadius: 8,
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }} aria-busy="true">
      <div>
        <div style={{ ...shimmer, height: 24, width: 200, marginBottom: 8 }} />
        <div style={{ ...shimmer, height: 13, width: 320 }} />
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: mobile ? '1fr 1fr' : 'repeat(5, 1fr)',
          gap: 10,
        }}
      >
        {[0, 1, 2, 3, 4].map((k) => (
          <div key={`t-${k}`} style={{ ...shimmer, height: 82, borderRadius: 14 }} />
        ))}
      </div>
      <div style={{ ...shimmer, height: 14, width: 130 }} />
      <Card style={{ overflow: 'hidden' }}>
        {[0, 1, 2, 3].map((k) => (
          <div
            key={`r-${k}`}
            style={{
              padding: '16px 18px',
              borderBottom: k === 3 ? 'none' : `1px solid ${c.borderSubtle}`,
              display: 'flex',
              gap: 12,
            }}
          >
            <div style={{ ...shimmer, width: 8, height: 8, borderRadius: '50%', marginTop: 4 }} />
            <div style={{ flex: 1 }}>
              <div style={{ ...shimmer, height: 14, width: '62%', marginBottom: 9 }} />
              <div style={{ ...shimmer, height: 12, width: '44%', marginBottom: 9 }} />
              <div style={{ ...shimmer, height: 11, width: '52%' }} />
            </div>
            <div style={{ ...shimmer, height: 20, width: 66, borderRadius: 20 }} />
          </div>
        ))}
      </Card>
    </div>
  );
}

// ── ERROR — recoverable, nothing lost ────────────────────────────
function ErrorList() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div style={{ ...slideUp(0) }}>
        <h1 style={{ fontSize: 22, fontWeight: 800, color: c.text, margin: 0 }}>Engagements</h1>
        <p style={{ fontSize: 13, color: c.textTertiary, margin: '3px 0 0' }}>
          Delivery oversight — what&rsquo;s in flight, in review, or gone quiet.
        </p>
      </div>
      <Card style={{ padding: '46px 30px', textAlign: 'center', ...slideUp(0.05) }}>
        <div
          style={{
            width: 54,
            height: 54,
            borderRadius: 15,
            background: c.errorLight,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            margin: '0 auto 15px',
          }}
        >
          <I.alertCircle size={23} color={c.error} />
        </div>
        <h3 style={{ fontSize: 17, fontWeight: 750, color: c.text, margin: 0 }}>
          The engagements list didn&rsquo;t load
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
          Something went wrong on our side — no delivery data was changed. Retry in a moment.
        </p>
        <div style={{ marginTop: 18 }}>
          <Btn variant="primary" icon={I.rotate}>
            Retry
          </Btn>
        </div>
      </Card>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// CONTROL BAR + FRAME (prototype scaffolding — not part of the page)
// ══════════════════════════════════════════════════════════════════
const STATES = [
  { key: 'loaded', label: 'Loaded' },
  { key: 'loading', label: 'Loading' },
  { key: 'error', label: 'Error' },
  { key: 'empty_filter', label: 'Empty (filtered)' },
  { key: 'empty_zero', label: 'Empty (zero)' },
];

function ControlBar({ state, setState, mobile, setMobile, agencyMode, setAgencyMode }) {
  const seg = (items, val, set) => (
    <div
      style={{
        display: 'inline-flex',
        gap: 3,
        padding: 3,
        borderRadius: 10,
        background: c.surfaceSubtle,
      }}
    >
      {items.map((it) => {
        const on = val === it.key;
        return (
          <button
            key={it.key}
            onClick={() => set(it.key)}
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
            }}
          >
            {it.label}
          </button>
        );
      })}
    </div>
  );
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
            State
          </span>
          <div className="balo-xscroll" style={{ display: 'flex' }}>
            {seg(STATES, state, setState)}
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
            checked={agencyMode}
            onChange={(e) => setAgencyMode(e.target.checked)}
            style={{ accentColor: c.accent }}
          />
          Agency expert
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
          {seg(
            [
              { key: false, label: 'Desktop' },
              { key: true, label: 'Mobile' },
            ].map((v) => ({ key: v.key, label: v.label })),
            mobile,
            setMobile
          )}
        </div>
      </div>
    </div>
  );
}

export default function EngagementsAdminList() {
  const [state, setState] = useState('loaded');
  const [mobile, setMobile] = useState(false);
  const [agencyMode, setAgencyMode] = useState(true);

  const body =
    state === 'loading' ? (
      <LoadingList mobile={mobile} />
    ) : state === 'error' ? (
      <ErrorList />
    ) : state === 'empty_zero' ? (
      <ZeroState />
    ) : state === 'empty_filter' ? (
      <EmptyFilterDemo mobile={mobile} />
    ) : (
      <LoadedList mobile={mobile} agencyMode={agencyMode} />
    );

  const inner = <div key={`${state}-${mobile}-${agencyMode}`}>{body}</div>;

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
        state={state}
        setState={setState}
        mobile={mobile}
        setMobile={setMobile}
        agencyMode={agencyMode}
        setAgencyMode={setAgencyMode}
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

// Empty-filtered demo: force the "stalled" filter with a data set that has
// nothing stalled, so the reviewer can see the filtered-empty invitation.
function EmptyFilterDemo({ mobile }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div style={{ ...slideUp(0) }}>
        <h1 style={{ fontSize: 22, fontWeight: 800, color: c.text, margin: 0 }}>Engagements</h1>
        <p style={{ fontSize: 13, color: c.textTertiary, margin: '3px 0 0' }}>
          Delivery oversight — what&rsquo;s in flight, in review, or gone quiet.
        </p>
      </div>
      <div style={{ ...fadeIn(0.04) }}>
        <SectionLabel icon={I.filter}>Stalled · 0</SectionLabel>
        <FilteredEmpty filter="stalled" filterLabel="Stalled" onClear={() => {}} />
      </div>
      {!mobile && (
        <p style={{ fontSize: 11.5, color: c.textTertiary, textAlign: 'center', margin: 0 }}>
          (Prototype: this shows the filtered-empty invitation for the &ldquo;Stalled&rdquo;
          filter.)
        </p>
      )}
    </div>
  );
}
