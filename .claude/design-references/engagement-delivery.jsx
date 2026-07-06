import { useState } from 'react';

// ══════════════════════════════════════════════════════════════════
// DELIVERY EPIC (BAL-329) — Engagement delivery workspace
// Route: /(dashboard)/engagements/[id]   ·   Tickets: BAL-330…336 + D7
//
// The page AFTER kickoff: the engagement is the durable object; the
// request is terminal at kickoff_approved. Continuous worked example
// with A6/A7: Northwind Industrial's CPQ implementation — Dana (client)
// ↔ Priya (expert), Fixed A$58,000, 4 milestones from proposal v3.
//
// Decisions this prototype encodes (see BAL-329):
//   · MILESTONES are expert-marked, no per-milestone client review:
//       pending → in_progress → completed  (+ delivery note; revert
//       is legal but loud). ONE emphasized action on the rail at a
//     time: gradient "Mark complete" when something's in progress,
//     else the next pending "Start" gets primary weight.
//   · ACCEPTANCE IS PROJECT-LEVEL (decided 2026-07-06): engagement
//     statuses are
//       active → pending_acceptance → completed   (+ cancelled)
//     Expert "marks project complete" (guard: ALL live milestones
//     completed — hard, no override) → engagement enters
//     pending_acceptance. Client then: ACCEPT (explicit, sticky),
//     REQUEST CHANGES (required note → back to active; dispute is a
//     loop, not a parked state), or do nothing → AUTO-ACCEPT after
//     7 days (config constant). Expert may withdraw the request.
//     The delivery plan LOCKS while the client reviews.
//   · Every completion-request notification — email AND in-app — must
//     state the review window and the auto-accept consequence.
//   · The final invoice trigger fires at `completed`, so it always
//     sits on explicit-or-auto client acceptance.
//   · Scope edits are DESCRIPTIVE ONLY — value locked post-snapshot.
//   · Admin cancels with a REQUIRED reason (from active OR
//     pending_acceptance).
//   · Retainer-safe: provenance is optional — toggle "Retainer".
//   · Completed banner: transition-only confetti; client next-step
//     CTAs (existing destinations; v2 review-request CTA slots into
//     the same row); admin gets "Ready to invoice: final installment".
//
//   · COPY ATTRIBUTION (two rules, by tense): PROSPECTIVE copy names
//     the PARTY — client company ("Northwind has 7 days"), and the
//     expert's agency when the expert is agency-based ("CloudPeak marks
//     each milestone"; independent experts keep their own name).
//     RETROSPECTIVE copy names the PERSON, "@ company/agency" on first
//     mention ("Accepted by Dana @ Northwind Industrial", "Priya @
//     CloudPeak has marked the project complete"). Toggle "Agency
//     expert" in the control bar to verify both modes.
//
// SIGNATURE ELEMENT: the milestone rail — one vertical spine whose
// connector fills with the gradient as milestones complete; the
// in-progress node breathes. The rail IS the status model.
// ══════════════════════════════════════════════════════════════════

const AUTO_ACCEPT_DAYS = 7; // config constant — tune at D0 review

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
  chevLeft: (p) => <Icon {...p} d="M15 18l-6-6 6-6" />,
  chevRight: (p) => <Icon {...p} d="M9 18l6-6-6-6" />,
  plus: (p) => <Icon {...p} d="M12 5v14M5 12h14" />,
  x: (p) => <Icon {...p} d="M18 6L6 18M6 6l12 12" />,
  shield: (p) => <Icon {...p} d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />,
  play: (p) => (
    <Multi {...p}>
      <polygon points="6 3 20 12 6 21 6 3" />
    </Multi>
  ),
  rotate: (p) => (
    <Multi {...p}>
      <path d="M3 12a9 9 0 109-9 9.75 9.75 0 00-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
    </Multi>
  ),
  edit: (p) => (
    <Multi {...p}>
      <path d="M17 3a2.85 2.83 0 114 4L7.5 20.5 2 22l1.5-5.5z" />
    </Multi>
  ),
  trash: (p) => (
    <Multi {...p}>
      <path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6" />
    </Multi>
  ),
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
  users: (p) => (
    <Multi {...p}>
      <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75" />
    </Multi>
  ),
  alertCircle: (p) => (
    <Multi {...p}>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 8v4M12 16h.01" />
    </Multi>
  ),
  fileText: (p) => (
    <Multi {...p}>
      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
      <path d="M14 2v6h6M16 13H8M16 17H8" />
    </Multi>
  ),
  flag: (p) => (
    <Multi {...p}>
      <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" />
      <line x1="4" y1="22" x2="4" y2="15" />
    </Multi>
  ),
  target: (p) => (
    <Multi {...p}>
      <circle cx="12" cy="12" r="10" />
      <circle cx="12" cy="12" r="6" />
      <circle cx="12" cy="12" r="2" />
    </Multi>
  ),
  dollar: (p) => (
    <Multi {...p}>
      <line x1="12" y1="1" x2="12" y2="23" />
      <path d="M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6" />
    </Multi>
  ),
  calendar: (p) => (
    <Multi {...p}>
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <line x1="16" y1="2" x2="16" y2="6" />
      <line x1="8" y1="2" x2="8" y2="6" />
      <line x1="3" y1="10" x2="21" y2="10" />
    </Multi>
  ),
  slash: (p) => (
    <Multi {...p}>
      <circle cx="12" cy="12" r="10" />
      <line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
    </Multi>
  ),
  layers: (p) => (
    <Multi {...p}>
      <polygon points="12 2 2 7 12 12 22 7 12 2" />
      <polyline points="2 17 12 22 22 17" />
      <polyline points="2 12 12 17 22 12" />
    </Multi>
  ),
  messageSquare: (p) => (
    <Multi {...p}>
      <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
    </Multi>
  ),
  thumbsUp: (p) => (
    <Multi {...p}>
      <path d="M14 9V5a3 3 0 00-3-3l-4 9v11h11.28a2 2 0 002-1.7l1.38-9a2 2 0 00-2-2.3zM7 22H4a2 2 0 01-2-2v-7a2 2 0 012-2h3" />
    </Multi>
  ),
};

const keyframes = `
@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
@keyframes slideUp { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: translateY(0); } }
@keyframes nodeBreathe { 0%,100% { box-shadow: 0 0 0 0 rgba(37,99,235,0.28); } 50% { box-shadow: 0 0 0 7px rgba(37,99,235,0); } }
@keyframes modalIn { from { opacity: 0; transform: translateY(10px) scale(0.98); } to { opacity: 1; transform: translateY(0) scale(1); } }
@keyframes confettiFall {
  0% { opacity: 1; transform: translateY(-10px) rotate(0deg); }
  100% { opacity: 0; transform: translateY(130px) rotate(320deg); }
}
@media (prefers-reduced-motion: reduce) {
  * { animation-duration: 0.01ms !important; animation-iteration-count: 1 !important; transition-duration: 0.01ms !important; }
}
`;
const slideUp = (d = 0) => ({ animation: `slideUp 0.4s ease-out ${d}s both` });
const fadeIn = (d = 0) => ({ animation: `fadeIn 0.35s ease-out ${d}s both` });

// ── Cast (same as A6/A7 references) ──────────────────────────────
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
  { key: 'admin', label: 'Admin', icon: I.users, color: c.cyan, sub: 'Balo — delivery oversight' },
];

// ── Worked example: the accepted CPQ proposal's milestones ───────
// engagement_milestones — snapshotted from proposal v3 at kickoff
// (BAL-330). Descriptive fields only; value locked post-snapshot.
const MS = {
  m1: {
    id: 'm1',
    title: 'Discovery & solution design',
    desc: 'Workshops with sales ops; approved architecture and CPQ data model; sandbox provisioned.',
    criteria: 'Design doc signed off by Dana; sandbox accessible to Northwind team.',
  },
  m2: {
    id: 'm2',
    title: 'Product catalogue & pricing rules',
    desc: 'Product and price book build, bundle configuration, discount schedules and validation rules.',
    criteria: 'Top 20 quote scenarios price correctly in sandbox against the FY26 price list.',
  },
  m3: {
    id: 'm3',
    title: 'Quote templates & approval workflows',
    desc: 'Branded quote output, approval matrix for non-standard discounts, DocuSign hookup.',
    criteria: 'End-to-end quote → approval → signed PDF demo accepted by sales leadership.',
  },
  m4: {
    id: 'm4',
    title: 'UAT, training & go-live',
    desc: 'UAT cycle with the sales team, training sessions, production cutover and 2-week hypercare.',
    criteria: 'Go-live complete; legacy quoting tool switched to read-only.',
  },
};
const seed = (over) =>
  Object.values(MS).map((m) => ({
    ...m,
    status: 'pending',
    startedAt: null,
    completedAt: null,
    note: '',
    ...(over[m.id] || {}),
  }));
const ALL_DONE = () =>
  seed({
    m1: {
      status: 'completed',
      startedAt: '16 Jun',
      completedAt: '30 Jun',
      note: 'Design doc + data model approved — in the shared drive.',
    },
    m2: {
      status: 'completed',
      startedAt: '1 Jul',
      completedAt: '18 Jul',
      note: 'All 20 scenarios pricing correctly. Bundle logic demo recording shared.',
    },
    m3: {
      status: 'completed',
      startedAt: '19 Jul',
      completedAt: '8 Aug',
      note: 'Approval matrix live; DocuSign connected in sandbox and prod.',
    },
    m4: {
      status: 'completed',
      startedAt: '9 Aug',
      completedAt: '21 Aug',
      note: 'Go-live done, hypercare wrapped. Legacy tool now read-only.',
    },
  });

// ── Scenarios — the states BAL-331 must render ───────────────────
// Engagement statuses: active | pending_acceptance | completed | cancelled
const SCENARIOS = {
  delivery: {
    label: 'In delivery',
    status: 'active',
    lastActivity: '2d ago',
    milestones: () =>
      seed({
        m1: {
          status: 'completed',
          startedAt: '16 Jun',
          completedAt: '30 Jun',
          note: 'Design doc + data model approved — in the shared drive. Sandbox is live; Northwind logins sent to Dana.',
        },
        m2: { status: 'in_progress', startedAt: '1 Jul' },
      }),
  },
  fresh: {
    label: 'Just kicked off · stalled',
    status: 'active',
    lastActivity: '16d ago',
    stalled: true,
    milestones: () => seed({}),
  },
  ready: {
    label: 'All milestones done',
    status: 'active',
    lastActivity: 'today',
    milestones: ALL_DONE,
  },
  review: {
    label: 'Awaiting client acceptance',
    status: 'pending_acceptance',
    requestedAt: '4 Jul',
    autoIn: '5 days',
    autoOn: '11 Jul',
    lastActivity: '2d ago',
    milestones: ALL_DONE,
  },
  completed: {
    label: 'Completed',
    status: 'completed',
    completedAt: '30 Aug 2026',
    acceptedBy: 'Dana',
    lastActivity: '30 Aug',
    milestones: ALL_DONE,
  },
  cancelled: {
    label: 'Cancelled',
    status: 'cancelled',
    cancelledBy: 'Balo',
    cancelledAt: '24 Jul 2026',
    reason:
      'Northwind paused the CPQ programme after the Pacific Retail acquisition — both parties agreed to stop at the end of milestone 1.',
    lastActivity: '24 Jul',
    milestones: () =>
      seed({
        m1: {
          status: 'completed',
          startedAt: '16 Jun',
          completedAt: '30 Jun',
          note: 'Design doc + data model approved — in the shared drive.',
        },
      }),
  },
  none: { label: 'No milestones', status: 'active', lastActivity: 'today', milestones: () => [] },
  error: { label: 'Error', status: 'error', milestones: () => [] },
};

const ENGAGEMENT = {
  title: 'CPQ implementation to replace legacy quoting tool',
  pricing: 'Fixed price',
  value: 'A$58,000',
  timeframe: '~10 weeks proposed',
  kicked: 'Kicked off 12 Jun',
  proposal: 'proposal v3',
};

// ── Primitives ───────────────────────────────────────────────────
function Card({ children, style: xs }) {
  return (
    <div
      style={{
        background: c.surface,
        borderRadius: 16,
        border: `1px solid ${c.border}`,
        boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
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
function Btn({
  children,
  icon: IC,
  variant = 'primary',
  onClick,
  style: xs,
  full,
  disabled,
  small,
}) {
  const [h, setH] = useState(false);
  const styles = {
    primary: {
      background: disabled ? c.border : h ? c.primaryDark : c.primary,
      color: disabled ? c.textTertiary : 'white',
      boxShadow: disabled ? 'none' : `0 2px 10px ${c.primaryGlow}`,
    },
    gradient: {
      background: disabled ? c.border : c.gradient,
      color: disabled ? c.textTertiary : 'white',
      boxShadow: disabled ? 'none' : `0 2px 10px ${c.primaryGlow}`,
      opacity: !disabled && h ? 0.92 : 1,
    },
    ghost: {
      background: h && !disabled ? c.surfaceSubtle : 'transparent',
      color: disabled ? c.textTertiary : c.textSecondary,
      border: `1px solid ${c.border}`,
    },
    danger: {
      background: h && !disabled ? c.errorLight : 'transparent',
      color: c.error,
      border: `1px solid ${c.errorBorder}`,
    },
    dangerSolid: {
      background: disabled ? c.border : h ? '#B91C1C' : c.error,
      color: disabled ? c.textTertiary : 'white',
    },
  };
  const iconColor =
    variant === 'ghost'
      ? disabled
        ? c.textTertiary
        : c.textSecondary
      : variant === 'danger'
        ? c.error
        : disabled
          ? c.textTertiary
          : 'white';
  return (
    <button
      onClick={disabled ? undefined : onClick}
      onMouseEnter={() => setH(true)}
      onMouseLeave={() => setH(false)}
      disabled={disabled}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 7,
        padding: small ? '7px 12px' : '9px 16px',
        borderRadius: 10,
        fontSize: small ? 12.5 : 13,
        fontWeight: 650,
        cursor: disabled ? 'not-allowed' : 'pointer',
        border: 'none',
        transition: 'all 0.2s',
        width: full ? '100%' : undefined,
        ...styles[variant],
        ...xs,
      }}
    >
      {IC && <IC size={small ? 13 : 14} color={iconColor} />}
      {children}
    </button>
  );
}
function IconBtn({ icon: IC, onClick, color = c.textTertiary, title }) {
  const [h, setH] = useState(false);
  return (
    <button
      onClick={onClick}
      title={title}
      onMouseEnter={() => setH(true)}
      onMouseLeave={() => setH(false)}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 28,
        height: 28,
        borderRadius: 8,
        border: 'none',
        cursor: 'pointer',
        background: h ? c.surfaceSubtle : 'transparent',
        transition: 'background 0.15s',
        flexShrink: 0,
      }}
    >
      <IC size={14} color={h ? c.textSecondary : color} />
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
function Field({ label, children, hint }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <label
        style={{
          display: 'block',
          fontSize: 12.5,
          fontWeight: 650,
          color: c.text,
          marginBottom: 6,
        }}
      >
        {label}
      </label>
      {children}
      {hint && (
        <p style={{ fontSize: 11.5, color: c.textTertiary, margin: '5px 0 0', lineHeight: 1.5 }}>
          {hint}
        </p>
      )}
    </div>
  );
}
const inputStyle = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '9px 12px',
  borderRadius: 10,
  border: `1px solid ${c.border}`,
  fontSize: 13.5,
  color: c.text,
  fontFamily: 'inherit',
  outline: 'none',
  background: c.surface,
  resize: 'vertical',
};

function Modal({ title, onClose, children, footer, tone = 'default', mobile }) {
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 60,
        background: 'rgba(15,23,41,0.45)',
        display: 'flex',
        alignItems: mobile ? 'flex-end' : 'center',
        justifyContent: 'center',
        padding: mobile ? 0 : 24,
        animation: 'fadeIn 0.2s ease-out both',
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: c.surface,
          borderRadius: mobile ? '20px 20px 0 0' : 18,
          width: mobile ? '100%' : 460,
          maxWidth: '100%',
          maxHeight: '86vh',
          overflowY: 'auto',
          boxShadow: '0 24px 60px rgba(15,23,41,0.28)',
          animation: 'modalIn 0.25s ease-out both',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '16px 20px',
            borderBottom: `1px solid ${c.borderSubtle}`,
          }}
        >
          <h3
            style={{
              fontSize: 15.5,
              fontWeight: 750,
              color: tone === 'danger' ? c.error : c.text,
              margin: 0,
              flex: 1,
            }}
          >
            {title}
          </h3>
          <IconBtn icon={I.x} onClick={onClose} title="Close" />
        </div>
        <div style={{ padding: '18px 20px' }}>{children}</div>
        {footer && (
          <div
            style={{
              display: 'flex',
              gap: 10,
              justifyContent: 'flex-end',
              padding: '14px 20px',
              borderTop: `1px solid ${c.borderSubtle}`,
            }}
          >
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Milestone rail node ──────────────────────────────────────────
function RailNode({ status }) {
  if (status === 'completed')
    return (
      <div
        style={{
          width: 26,
          height: 26,
          borderRadius: '50%',
          background: c.gradient,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
          boxShadow: `0 2px 8px ${c.primaryGlow}`,
        }}
      >
        <I.check size={13} color="white" />
      </div>
    );
  if (status === 'in_progress')
    return (
      <div
        style={{
          width: 26,
          height: 26,
          borderRadius: '50%',
          background: c.surface,
          border: `2.5px solid ${c.primary}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
          animation: 'nodeBreathe 2.2s ease-in-out infinite',
        }}
      >
        <div style={{ width: 9, height: 9, borderRadius: '50%', background: c.primary }} />
      </div>
    );
  return (
    <div
      style={{
        width: 26,
        height: 26,
        borderRadius: '50%',
        background: c.surface,
        border: `2px solid ${c.border}`,
        flexShrink: 0,
      }}
    />
  );
}

const MS_STATUS = {
  pending: { label: 'Not started', color: c.textTertiary, bg: c.surfaceSubtle },
  in_progress: { label: 'In progress', color: c.primary, bg: c.primaryLight },
  completed: { label: 'Completed', color: c.success, bg: c.successLight },
};

// ── One milestone row on the rail ────────────────────────────────
function MilestoneRow({
  m,
  index,
  last,
  lens,
  active,
  nextId,
  onStart,
  onComplete,
  onRevert,
  onEdit,
  onRemove,
  mobile,
}) {
  const st = MS_STATUS[m.status];
  // Milestone mutations are expert-only and only while the engagement is
  // ACTIVE — the plan locks during client review (pending_acceptance).
  const expert = lens === 'expert' && active;
  return (
    <div style={{ display: 'flex', gap: mobile ? 12 : 16, ...slideUp(0.08 + index * 0.05) }}>
      {/* Rail: node + connector. Connector is gradient-filled once this
          milestone is completed — the signature progress device. */}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <RailNode status={m.status} />
        {!last && (
          <div
            style={{
              width: 2.5,
              flex: 1,
              minHeight: 28,
              borderRadius: 2,
              background: m.status === 'completed' ? c.gradient : c.borderSubtle,
              margin: '4px 0',
            }}
          />
        )}
      </div>
      <div style={{ flex: 1, minWidth: 0, paddingBottom: last ? 0 : 22 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, flexWrap: 'wrap' }}>
          <p
            style={{
              fontSize: 14.5,
              fontWeight: 700,
              color: m.status === 'pending' ? c.textSecondary : c.text,
              margin: 0,
              flex: 1,
              minWidth: 160,
            }}
          >
            {m.title}
          </p>
          <Pill small color={st.color} bg={st.bg}>
            {st.label}
          </Pill>
          {expert && (
            <span style={{ display: 'inline-flex', gap: 2 }}>
              <IconBtn icon={I.edit} title="Edit milestone" onClick={() => onEdit(m)} />
              <IconBtn icon={I.trash} title="Remove milestone" onClick={() => onRemove(m)} />
            </span>
          )}
        </div>
        {m.desc && (
          <p
            style={{ fontSize: 12.5, color: c.textSecondary, margin: '5px 0 0', lineHeight: 1.55 }}
          >
            {m.desc}
          </p>
        )}
        {m.criteria && (
          <p
            style={{
              fontSize: 11.5,
              color: c.textTertiary,
              margin: '6px 0 0',
              lineHeight: 1.5,
              display: 'flex',
              gap: 6,
            }}
          >
            <I.target size={12} color={c.textTertiary} style={{ flexShrink: 0, marginTop: 1 }} />
            <span>
              <strong style={{ fontWeight: 650, color: c.textSecondary }}>Done when:</strong>{' '}
              {m.criteria}
            </span>
          </p>
        )}
        {(m.startedAt || m.completedAt) && (
          <p style={{ fontSize: 11.5, color: c.textTertiary, margin: '7px 0 0' }}>
            {m.startedAt && <>Started {m.startedAt}</>}
            {m.completedAt && <> · Completed {m.completedAt} by Priya</>}
          </p>
        )}
        {/* Completion note — the trust artifact, visible to every lens */}
        {m.status === 'completed' && m.note && (
          <div
            style={{
              marginTop: 9,
              padding: '9px 12px',
              borderRadius: 10,
              background: c.successLight,
              border: `1px solid ${c.successBorder}`,
            }}
          >
            <p style={{ fontSize: 12.5, color: c.text, margin: 0, lineHeight: 1.55 }}>
              <strong style={{ fontWeight: 650, color: c.success }}>Delivered:</strong> {m.note}
            </p>
          </div>
        )}
        {/* Expert actions per status */}
        {expert && (
          <div style={{ display: 'flex', gap: 8, marginTop: 11, flexWrap: 'wrap' }}>
            {m.status === 'pending' && (
              <Btn
                small
                variant={m.id === nextId ? 'primary' : 'ghost'}
                icon={I.play}
                onClick={() => onStart(m)}
              >
                Start milestone
              </Btn>
            )}
            {m.status === 'in_progress' && (
              <Btn small variant="gradient" icon={I.check} onClick={() => onComplete(m)}>
                Mark complete
              </Btn>
            )}
            {m.status === 'completed' && (
              <Btn
                small
                variant="ghost"
                icon={I.rotate}
                onClick={() => onRevert(m)}
                style={{ border: 'none', padding: '5px 8px', fontSize: 11.5 }}
              >
                Move back to in progress
              </Btn>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Header (all lenses) ──────────────────────────────────────────
function Header({ lens, status, retainer, xp, mobile }) {
  const statusChip =
    status === 'active' ? (
      <Pill color={c.success} bg={c.successLight} border={c.successBorder} icon={I.layers}>
        Active
      </Pill>
    ) : status === 'pending_acceptance' ? (
      <Pill color={c.warning} bg={c.warningLight} border={c.warningBorder} icon={I.clock}>
        Awaiting client review
      </Pill>
    ) : status === 'completed' ? (
      <Pill color={c.success} bg={c.successLight} border={c.successBorder} icon={I.check}>
        Completed
      </Pill>
    ) : (
      <Pill color={c.error} bg={c.errorLight} border={c.errorBorder} icon={I.slash}>
        Cancelled
      </Pill>
    );
  const counterpart =
    lens === 'client'
      ? xp.clientHeader
      : lens === 'expert'
        ? 'For Northwind Industrial (Dana)'
        : xp.adminHeader;
  return (
    <div style={{ marginBottom: 20, ...slideUp(0) }}>
      <button
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 5,
          fontSize: 12.5,
          color: c.textTertiary,
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          padding: 0,
          marginBottom: 12,
          fontFamily: 'inherit',
        }}
      >
        <I.chevLeft size={14} color={c.textTertiary} /> Projects
      </button>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, flexWrap: 'wrap' }}>
        <h1
          style={{
            fontSize: mobile ? 19 : 22,
            fontWeight: 800,
            color: c.text,
            margin: 0,
            flex: 1,
            minWidth: 220,
            lineHeight: 1.3,
          }}
        >
          {ENGAGEMENT.title}
        </h1>
        {statusChip}
      </div>
      <p style={{ fontSize: 13, color: c.textSecondary, margin: '7px 0 0' }}>{counterpart}</p>
      {/* Snapshotted commercial terms — copied at kickoff, never re-read
          from the proposal. Same strip for every lens in v1. */}
      <div style={{ display: 'flex', gap: 7, marginTop: 12, flexWrap: 'wrap' }}>
        <Pill small icon={I.dollar}>
          {ENGAGEMENT.pricing} · {ENGAGEMENT.value}
        </Pill>
        <Pill small icon={I.clock}>
          {ENGAGEMENT.timeframe}
        </Pill>
        <Pill small icon={I.calendar}>
          {ENGAGEMENT.kicked}
        </Pill>
        {/* Provenance — OPTIONAL. Retainers have no source request; the
            strip simply omits the link (layout must not assume it). */}
        {!retainer && (
          <button
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              padding: '3px 10px',
              borderRadius: 20,
              fontSize: 11,
              fontWeight: 600,
              color: c.primary,
              background: c.primaryLight,
              border: `1px solid ${c.primaryBorder}`,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            <I.fileText size={10} color={c.primary} />
            From {ENGAGEMENT.proposal} · view request
            <I.chevRight size={10} color={c.primary} />
          </button>
        )}
      </div>
    </div>
  );
}

// ── Progress block ───────────────────────────────────────────────
function Progress({ done, total, lens, xp, mobile }) {
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);
  return (
    <Card
      style={{ padding: mobile ? '16px 16px' : '18px 22px', marginBottom: 18, ...slideUp(0.05) }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
        <p style={{ fontSize: 21, fontWeight: 800, color: c.text, margin: 0 }}>
          {done} of {total}
        </p>
        <p style={{ fontSize: 13, color: c.textSecondary, margin: 0 }}>milestones completed</p>
        <span style={{ marginLeft: 'auto', fontSize: 12.5, fontWeight: 700, color: c.primary }}>
          {pct}%
        </span>
      </div>
      <div
        style={{
          height: 8,
          borderRadius: 6,
          background: c.surfaceSubtle,
          marginTop: 12,
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            height: '100%',
            width: `${pct}%`,
            background: c.gradient,
            borderRadius: 6,
            transition: 'width 0.5s ease-out',
          }}
        />
      </div>
      {lens === 'client' && (
        <p style={{ fontSize: 12, color: c.textTertiary, margin: '10px 0 0', lineHeight: 1.5 }}>
          {xp.short} marks each milestone as it's delivered. When the whole project is done, you
          review it — accept, or request changes within {AUTO_ACCEPT_DAYS} days.
        </p>
      )}
    </Card>
  );
}

// ── Review banner (pending_acceptance) — the project-level gate ──
function ReviewBanner({ sc, lens, xp, onAccept, onChanges, onWithdraw }) {
  return (
    <div
      style={{
        padding: '16px 20px',
        borderRadius: 16,
        background: c.warningLight,
        border: `1.5px solid ${c.warningBorder}`,
        marginBottom: 18,
        display: 'flex',
        gap: 12,
        alignItems: 'flex-start',
        ...slideUp(0.03),
      }}
    >
      <div
        style={{
          width: 34,
          height: 34,
          borderRadius: 10,
          background: c.warning,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        <I.clock size={16} color="white" />
      </div>
      <div style={{ flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <p
            style={{
              fontSize: 14.5,
              fontWeight: 750,
              color: c.text,
              margin: 0,
              flex: 1,
              minWidth: 180,
            }}
          >
            {lens === 'client'
              ? `${xp.retroFirst} has marked the project complete`
              : "Completion requested — awaiting Northwind's review"}
          </p>
          <Pill small color={c.warning} bg={c.surface} border={c.warningBorder} icon={I.clock}>
            Auto-accepts in {sc.autoIn}
          </Pill>
        </div>
        <p style={{ fontSize: 12.5, color: c.textSecondary, margin: '5px 0 0', lineHeight: 1.55 }}>
          {lens === 'client'
            ? `Review the delivery plan below, then accept the project or request changes. If no one responds, the project is accepted automatically on ${sc.autoOn} so delivery isn't left hanging.`
            : lens === 'expert'
              ? `Requested ${sc.requestedAt}. Northwind has ${AUTO_ACCEPT_DAYS} days to accept or request changes — after that the project is accepted automatically. The delivery plan is locked while the project is in review.`
              : `Requested ${sc.requestedAt} by ${xp.retroFirst}. Auto-accepts ${sc.autoOn} unless Northwind responds. Final invoice raises once accepted.`}
        </p>
        {/* Client's decision — the project-level gate (D7). Accept is the
            emphasized action; changes is the loop back to active. */}
        {lens === 'client' && (
          <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
            <Btn small variant="gradient" icon={I.thumbsUp} onClick={onAccept}>
              Accept project
            </Btn>
            <Btn small variant="ghost" icon={I.messageSquare} onClick={onChanges}>
              Request changes
            </Btn>
          </div>
        )}
        {lens === 'expert' && (
          <div style={{ marginTop: 12 }}>
            <Btn small variant="ghost" icon={I.rotate} onClick={onWithdraw}>
              Withdraw request
            </Btn>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Change-request banner (back on active after a client decline) ─
function ChangesBanner({ note, lens }) {
  if (lens === 'client') return null;
  return (
    <div
      style={{
        padding: '13px 18px',
        borderRadius: 14,
        background: c.warningLight,
        border: `1px solid ${c.warningBorder}`,
        marginBottom: 18,
        display: 'flex',
        gap: 10,
        alignItems: 'flex-start',
        ...slideUp(0.03),
      }}
    >
      <I.messageSquare size={15} color={c.warning} style={{ flexShrink: 0, marginTop: 2 }} />
      <p style={{ fontSize: 12.5, color: c.text, margin: 0, lineHeight: 1.55 }}>
        <strong style={{ fontWeight: 650, color: c.warning }}>
          Dana requested changes before accepting:
        </strong>{' '}
        {note}
        {lens === 'expert' && (
          <span style={{ color: c.textSecondary }}>
            {' '}
            — fix it up and mark the project complete again when ready.
          </span>
        )}
      </p>
    </div>
  );
}

// ── Terminal banners ─────────────────────────────────────────────
// Celebration fires on the TRANSITION only (in-session accept) —
// revisits render the calm banner. One-shot, ~2s, brand colors, ends
// at opacity 0 so reduced-motion users just never see it.
function Confetti() {
  const colors = [c.primary, c.accent, c.success, c.warning];
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        overflow: 'hidden',
        pointerEvents: 'none',
        borderRadius: 16,
      }}
    >
      {Array.from({ length: 26 }).map((_, i) => (
        <span
          key={i}
          style={{
            position: 'absolute',
            top: -6,
            left: `${(i * 137) % 100}%`,
            width: i % 3 === 0 ? 8 : 6,
            height: i % 2 === 0 ? 10 : 6,
            borderRadius: i % 3 === 0 ? '50%' : 2,
            background: colors[i % colors.length],
            animation: `confettiFall ${1.4 + (i % 5) * 0.22}s ease-in ${(i % 7) * 0.09}s both`,
          }}
        />
      ))}
    </div>
  );
}
function CompletedBanner({ sc, lens, stats, xp, celebrate }) {
  const acceptedLine =
    sc.acceptedBy === 'auto'
      ? `accepted automatically on ${sc.completedAt} after the ${AUTO_ACCEPT_DAYS}-day review window`
      : `accepted by ${sc.acceptedBy} on ${sc.completedAt}`;
  return (
    <div
      style={{
        position: 'relative',
        padding: '16px 20px',
        borderRadius: 16,
        background: c.successLight,
        border: `1.5px solid ${c.successBorder}`,
        marginBottom: 18,
        display: 'flex',
        gap: 12,
        alignItems: 'flex-start',
        ...slideUp(0.03),
      }}
    >
      {celebrate && <Confetti />}
      <div
        style={{
          width: 34,
          height: 34,
          borderRadius: 10,
          background: c.success,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        <I.check size={17} color="white" />
      </div>
      <div style={{ flex: 1 }}>
        <p style={{ fontSize: 14.5, fontWeight: 750, color: c.text, margin: 0 }}>
          {lens === 'expert' ? 'Project delivered 🎉' : 'Project completed'}
        </p>
        <p style={{ fontSize: 12.5, color: c.textSecondary, margin: '4px 0 0', lineHeight: 1.55 }}>
          {lens === 'expert'
            ? `All ${stats.total} milestones delivered and the project ${acceptedLine}. Balo has been notified.`
            : lens === 'client'
              ? sc.acceptedBy === 'auto'
                ? `The project was ${acceptedLine}. Balo will be in touch about the final invoice.`
                : `You accepted the project on ${sc.completedAt}. Balo will be in touch about the final invoice.`
              : `Project ${acceptedLine} — ${stats.total} milestones delivered.`}
        </p>
        {/* Client next steps — v1 ships only affordances whose destinations
            already exist: new request (A1 flow) and Messages. The v2
            marketplace hooks slot into this same row: review-request CTA
            first, then rehire-Priya shortcut (BAL-329 flywheel). */}
        {lens === 'client' && (
          <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
            <Btn small variant="primary" icon={I.plus}>
              Start your next project
            </Btn>
            <Btn small variant="ghost" icon={I.messageSquare}>
              Message {xp.person}
            </Btn>
          </div>
        )}
        {/* The money seam (BAL-334/D7): `completed` IS the final-invoice
            trigger for MJ in payments v1 — and it now always carries
            explicit-or-auto client acceptance. */}
        {lens === 'admin' && (
          <div style={{ marginTop: 9 }}>
            <Pill
              small
              color={c.warning}
              bg={c.warningLight}
              border={c.warningBorder}
              icon={I.dollar}
            >
              Ready to invoice: final installment
            </Pill>
          </div>
        )}
      </div>
    </div>
  );
}
function CancelledBanner({ sc }) {
  return (
    <div
      style={{
        padding: '16px 20px',
        borderRadius: 16,
        background: c.errorLight,
        border: `1.5px solid ${c.errorBorder}`,
        marginBottom: 18,
        display: 'flex',
        gap: 12,
        alignItems: 'flex-start',
        ...slideUp(0.03),
      }}
    >
      <div
        style={{
          width: 34,
          height: 34,
          borderRadius: 10,
          background: c.error,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        <I.slash size={16} color="white" />
      </div>
      <div>
        <p style={{ fontSize: 14.5, fontWeight: 750, color: c.text, margin: 0 }}>
          Engagement cancelled
        </p>
        <p style={{ fontSize: 12.5, color: c.textSecondary, margin: '4px 0 0', lineHeight: 1.55 }}>
          Cancelled by {sc.cancelledBy} on {sc.cancelledAt}.
        </p>
        <p
          style={{
            fontSize: 12.5,
            color: c.textSecondary,
            margin: '7px 0 0',
            lineHeight: 1.55,
            fontStyle: 'italic',
          }}
        >
          "{sc.reason}"
        </p>
      </div>
    </div>
  );
}

// ── Admin oversight strip ────────────────────────────────────────
function AdminStrip({ sc, xp, onCancel, cancellable }) {
  return (
    <Card style={{ padding: '14px 18px', marginBottom: 18, ...slideUp(0.04) }}>
      <SectionLabel icon={I.users} color={c.cyan}>
        Oversight
      </SectionLabel>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <Pill small icon={I.clock}>
          Last delivery activity: {sc.lastActivity}
        </Pill>
        {sc.stalled && (
          <Pill small color={c.error} bg={c.errorLight} border={c.errorBorder} icon={I.alertCircle}>
            Stalled · quiet 16 days
          </Pill>
        )}
        {cancellable && (
          <span style={{ marginLeft: 'auto' }}>
            <Btn small variant="danger" icon={I.slash} onClick={onCancel}>
              Cancel engagement
            </Btn>
          </span>
        )}
      </div>
      {sc.stalled && (
        <p style={{ fontSize: 12, color: c.textSecondary, margin: '9px 0 0', lineHeight: 1.5 }}>
          Nothing has started since kickoff on 12 Jun. Worth a check-in with {xp.short} before
          Northwind asks.
        </p>
      )}
    </Card>
  );
}

// ── Empty state (zero milestones) — invitation, never absence ────
function NoMilestones({ lens, xp, onAdd }) {
  const copy = {
    expert: {
      title: 'Shape the delivery plan',
      body: 'Add your first milestone so Northwind can follow progress. When everything is delivered, you mark the project complete and Northwind reviews it as a whole.',
      cta: (
        <Btn variant="gradient" icon={I.plus} onClick={onAdd}>
          Add the first milestone
        </Btn>
      ),
      icon: I.flag,
      iconBg: c.gradientSubtle,
      iconColor: c.accent,
    },
    client: {
      title: `${xp.short} is shaping the delivery plan`,
      body: `Milestones appear here as ${xp.short} adds them, and you'll be notified as each one is delivered. When the whole project is marked complete, you review and accept it. Anything you want tracked as a milestone? Mention it in Messages.`,
      cta: null,
      icon: I.flag,
      iconBg: c.primaryLight,
      iconColor: c.primary,
    },
    admin: {
      title: 'No delivery plan yet',
      body: `The accepted proposal had no milestones, and ${xp.short} hasn't added any. The project can still be completed — but a nudge toward a visible plan keeps Northwind confident.`,
      cta: null,
      icon: I.flag,
      iconBg: c.surfaceSubtle,
      iconColor: c.textSecondary,
    },
  }[lens];
  return (
    <Card style={{ padding: '46px 30px', textAlign: 'center', ...slideUp(0.06) }}>
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
          maxWidth: 420,
          lineHeight: 1.6,
        }}
      >
        {copy.body}
      </p>
      {copy.cta && <div style={{ marginTop: 18 }}>{copy.cta}</div>}
    </Card>
  );
}

// ── Error state ──────────────────────────────────────────────────
function ErrorState() {
  return (
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
        This engagement didn't load
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
        Something went wrong on our side. Retry, or head back to Projects — nothing you've done here
        is lost.
      </p>
      <div style={{ display: 'flex', gap: 10, justifyContent: 'center', marginTop: 18 }}>
        <Btn variant="primary" icon={I.rotate}>
          Retry
        </Btn>
        <Btn variant="ghost" icon={I.chevLeft}>
          Back to Projects
        </Btn>
      </div>
    </Card>
  );
}

// ══════════════════════════════════════════════════════════════════
// MAIN WORKSPACE VIEW
// ══════════════════════════════════════════════════════════════════
function Workspace({ lens, scenarioKey, retainer, xp, mobile }) {
  const sc = SCENARIOS[scenarioKey];
  const [ms, setMs] = useState(() => sc.milestones());
  const [status, setStatus] = useState(sc.status);
  const [reviewMeta, setReviewMeta] = useState({
    requestedAt: sc.requestedAt,
    autoIn: sc.autoIn,
    autoOn: sc.autoOn,
  });
  const [completedMeta, setCompletedMeta] = useState({
    at: sc.completedAt,
    acceptedBy: sc.acceptedBy,
  });
  const [cancelMeta, setCancelMeta] = useState({
    by: sc.cancelledBy,
    at: sc.cancelledAt,
    reason: sc.reason,
  });
  const [changesNote, setChangesNote] = useState(''); // Dana's project-level change request
  const [modal, setModal] = useState(null); // {type, m?}
  const [note, setNote] = useState('');
  const [changeReq, setChangeReq] = useState('');
  const [form, setForm] = useState({ title: '', desc: '', criteria: '' });
  const [reason, setReason] = useState('');
  const [celebrate, setCelebrate] = useState(false);

  if (scenarioKey === 'error') return <ErrorState />;

  const active = status === 'active';
  const reviewing = status === 'pending_acceptance';
  const done = ms.filter((m) => m.status === 'completed').length;
  const allDone = ms.length > 0 && done === ms.length;
  // ONE emphasized action on the rail at a time: if a milestone is in
  // progress, its "Mark complete" is the only prominent button; otherwise
  // the NEXT pending milestone's "Start" gets primary weight.
  const hasInProgress = ms.some((m) => m.status === 'in_progress');
  const nextId = !hasInProgress ? (ms.find((m) => m.status === 'pending') || {}).id : null;
  const upd = (id, patch) => setMs((p) => p.map((m) => (m.id === id ? { ...m, ...patch } : m)));

  // ── Action handlers (mirror the D0 repo transition maps) ──
  const doStart = (m) => upd(m.id, { status: 'in_progress', startedAt: 'today' });
  const doComplete = () => {
    upd(modal.m.id, { status: 'completed', completedAt: 'today', note: note.trim() });
    setModal(null);
    setNote('');
  };
  const doRevert = () => {
    // Revert clears the completion record (completed_by/at + note) — BAL-330.
    upd(modal.m.id, { status: 'in_progress', completedAt: null, note: '' });
    setModal(null);
  };
  const doSaveMilestone = () => {
    if (!form.title.trim()) return;
    if (modal.m) upd(modal.m.id, { title: form.title, desc: form.desc, criteria: form.criteria });
    else
      setMs((p) => [
        ...p,
        {
          id: `new${p.length}`,
          title: form.title,
          desc: form.desc,
          criteria: form.criteria,
          status: 'pending',
          startedAt: null,
          completedAt: null,
          note: '',
        },
      ]);
    setModal(null);
    setForm({ title: '', desc: '', criteria: '' });
  };
  const doRemove = () => {
    // Soft delete — the completion guard counts live rows only (BAL-330/333).
    setMs((p) => p.filter((m) => m.id !== modal.m.id));
    setModal(null);
  };
  // ── Project-level acceptance loop (D7) ──
  const doRequestCompletion = () => {
    setStatus('pending_acceptance');
    setReviewMeta({ requestedAt: 'today', autoIn: `${AUTO_ACCEPT_DAYS} days`, autoOn: '13 Jul' });
    setChangesNote('');
    setModal(null);
  };
  const doWithdrawRequest = () => {
    setStatus('active');
    setModal(null);
  };
  const doAcceptProject = () => {
    setStatus('completed');
    setCompletedMeta({ at: 'today', acceptedBy: 'Dana' });
    setModal(null);
    setCelebrate(true);
    setTimeout(() => setCelebrate(false), 2600);
  };
  const doProjectChanges = () => {
    if (!changeReq.trim()) return;
    // Dispute is a loop, not a parked state: back to active with Dana's
    // note pinned until Priya re-requests completion.
    setStatus('active');
    setChangesNote(changeReq.trim());
    setModal(null);
    setChangeReq('');
  };
  const doCancel = () => {
    if (!reason.trim()) return;
    setStatus('cancelled');
    setCancelMeta({ by: 'Balo', at: 'today', reason: reason.trim() });
    setModal(null);
    setReason('');
  };
  const openEdit = (m) => {
    setForm({ title: m.title, desc: m.desc || '', criteria: m.criteria || '' });
    setModal({ type: 'edit', m });
  };
  const openAdd = () => {
    setForm({ title: '', desc: '', criteria: '' });
    setModal({ type: 'edit', m: null });
  };

  const remaining = ms.length - done;

  return (
    <div>
      <Header lens={lens} status={status} retainer={retainer} xp={xp} mobile={mobile} />

      {reviewing && (
        <ReviewBanner
          sc={{ ...sc, ...reviewMeta }}
          lens={lens}
          xp={xp}
          onAccept={() => setModal({ type: 'acceptProject' })}
          onChanges={() => {
            setChangeReq('');
            setModal({ type: 'projectChanges' });
          }}
          onWithdraw={() => setModal({ type: 'withdraw' })}
        />
      )}
      {active && changesNote && <ChangesBanner note={changesNote} lens={lens} />}
      {status === 'completed' && (
        <CompletedBanner
          sc={{ ...sc, completedAt: completedMeta.at, acceptedBy: completedMeta.acceptedBy }}
          lens={lens}
          stats={{ total: ms.length }}
          xp={xp}
          celebrate={celebrate}
        />
      )}
      {status === 'cancelled' && (
        <CancelledBanner
          sc={{
            ...sc,
            cancelledBy: cancelMeta.by,
            cancelledAt: cancelMeta.at,
            reason: cancelMeta.reason,
          }}
        />
      )}

      {/* Admin can cancel from active OR pending_acceptance */}
      {lens === 'admin' && status !== 'cancelled' && status !== 'completed' && (
        <AdminStrip
          sc={sc}
          xp={xp}
          cancellable={active || reviewing}
          onCancel={() => setModal({ type: 'cancel' })}
        />
      )}

      {ms.length > 0 && (
        <Progress done={done} total={ms.length} lens={lens} xp={xp} mobile={mobile} />
      )}

      {/* ── The delivery plan (milestone rail) ── */}
      {ms.length === 0 ? (
        <NoMilestones lens={lens} xp={xp} onAdd={openAdd} />
      ) : (
        <Card style={{ padding: mobile ? '18px 16px' : '22px 24px', ...slideUp(0.08) }}>
          <SectionLabel
            icon={I.flag}
            color={c.textTertiary}
            right={
              lens === 'expert' &&
              active && (
                <Btn
                  small
                  variant="ghost"
                  icon={I.plus}
                  onClick={openAdd}
                  style={{ padding: '6px 11px', fontSize: 12 }}
                >
                  Add milestone
                </Btn>
              )
            }
          >
            Delivery plan
          </SectionLabel>
          <div style={{ marginTop: 14 }}>
            {ms.map((m, i) => (
              <MilestoneRow
                key={m.id}
                m={m}
                index={i}
                last={i === ms.length - 1}
                lens={lens}
                active={active}
                nextId={nextId}
                mobile={mobile}
                onStart={doStart}
                onComplete={(mm) => {
                  setNote('');
                  setModal({ type: 'complete', m: mm });
                }}
                onRevert={(mm) => setModal({ type: 'revert', m: mm })}
                onEdit={openEdit}
                onRemove={(mm) => setModal({ type: 'remove', m: mm })}
              />
            ))}
          </div>
          {lens === 'expert' && active && (
            <p
              style={{ fontSize: 11.5, color: c.textTertiary, margin: '16px 0 0', lineHeight: 1.5 }}
            >
              Northwind and Balo are notified when you complete a milestone or change the plan. The
              project goes to Northwind for review as a whole when you mark it complete. Pricing is
              fixed from the accepted proposal — changes to price go through a new proposal.
            </p>
          )}
        </Card>
      )}

      {/* ── Mark project complete (expert, active) — sends for Dana's
             review; guard is ALL MILESTONES COMPLETED; the disabled
             state EXPLAINS (BAL-334) ── */}
      {lens === 'expert' && active && (
        <Card
          style={{ padding: mobile ? '16px 16px' : '18px 22px', marginTop: 18, ...slideUp(0.12) }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 200 }}>
              <p style={{ fontSize: 14, fontWeight: 750, color: c.text, margin: 0 }}>
                Finish the project
              </p>
              <p
                style={{
                  fontSize: 12.5,
                  color: c.textSecondary,
                  margin: '4px 0 0',
                  lineHeight: 1.5,
                }}
              >
                {ms.length === 0
                  ? "This project has no milestones — you can still send it for Northwind's review, but a visible plan builds trust."
                  : allDone
                    ? `Every milestone is delivered. Marking complete sends the project to Northwind for review — Northwind can accept or request changes within ${AUTO_ACCEPT_DAYS} days, after which it's accepted automatically.`
                    : `${remaining} of ${ms.length} milestone${remaining === 1 ? '' : 's'} still to complete before the project can be sent for Northwind's review.`}
              </p>
            </div>
            <Btn
              variant="gradient"
              icon={I.check}
              disabled={ms.length > 0 && !allDone}
              onClick={() => setModal({ type: 'requestCompletion' })}
            >
              Mark project complete
            </Btn>
          </div>
        </Card>
      )}

      {/* ══ Modals ══ */}
      {modal?.type === 'complete' && (
        <Modal
          mobile={mobile}
          title="Mark milestone complete"
          onClose={() => setModal(null)}
          footer={
            <>
              <Btn variant="ghost" onClick={() => setModal(null)}>
                Cancel
              </Btn>
              <Btn variant="gradient" icon={I.check} onClick={doComplete}>
                Mark complete
              </Btn>
            </>
          }
        >
          <p style={{ fontSize: 13, color: c.textSecondary, margin: '0 0 14px', lineHeight: 1.55 }}>
            <strong style={{ color: c.text, fontWeight: 650 }}>{modal.m.title}</strong> — Northwind
            and the Balo team will be notified.
          </p>
          <Field
            label="What was delivered? (optional)"
            hint="A link and a line goes a long way — this is what Northwind reviews against."
          >
            <textarea
              rows={3}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              style={inputStyle}
              placeholder="Link to the deliverable, a summary of what changed…"
            />
          </Field>
        </Modal>
      )}

      {modal?.type === 'revert' && (
        <Modal
          mobile={mobile}
          title="Move back to in progress"
          onClose={() => setModal(null)}
          footer={
            <>
              <Btn variant="ghost" onClick={() => setModal(null)}>
                Cancel
              </Btn>
              <Btn variant="primary" icon={I.rotate} onClick={doRevert}>
                Move back
              </Btn>
            </>
          }
        >
          <p style={{ fontSize: 13, color: c.textSecondary, margin: 0, lineHeight: 1.6 }}>
            <strong style={{ color: c.text, fontWeight: 650 }}>{modal.m.title}</strong> goes back to
            in progress and its completion record is cleared. Northwind and the Balo team will be
            notified — reverts are never silent.
          </p>
        </Modal>
      )}

      {modal?.type === 'edit' && (
        <Modal
          mobile={mobile}
          title={modal.m ? 'Edit milestone' : 'Add milestone'}
          onClose={() => setModal(null)}
          footer={
            <>
              <Btn variant="ghost" onClick={() => setModal(null)}>
                Cancel
              </Btn>
              <Btn
                variant="primary"
                icon={I.check}
                disabled={!form.title.trim()}
                onClick={doSaveMilestone}
              >
                {modal.m ? 'Save changes' : 'Add milestone'}
              </Btn>
            </>
          }
        >
          <Field label="Title">
            <input
              value={form.title}
              onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
              style={inputStyle}
              placeholder="e.g. Data migration dry-run"
            />
          </Field>
          <Field label="Description (optional)">
            <textarea
              rows={2}
              value={form.desc}
              onChange={(e) => setForm((f) => ({ ...f, desc: e.target.value }))}
              style={inputStyle}
              placeholder="What this milestone covers"
            />
          </Field>
          <Field
            label="Done when… (optional)"
            hint="The acceptance criteria Northwind can check against."
          >
            <textarea
              rows={2}
              value={form.criteria}
              onChange={(e) => setForm((f) => ({ ...f, criteria: e.target.value }))}
              style={inputStyle}
              placeholder="How you'll both know it's delivered"
            />
          </Field>
          {/* The D3 hard line, visible in the design: descriptive only. */}
          <div
            style={{
              padding: '9px 12px',
              borderRadius: 10,
              background: c.surfaceSubtle,
              display: 'flex',
              gap: 8,
            }}
          >
            <I.alertCircle
              size={13}
              color={c.textTertiary}
              style={{ flexShrink: 0, marginTop: 1 }}
            />
            <p style={{ fontSize: 11.5, color: c.textSecondary, margin: 0, lineHeight: 1.5 }}>
              Northwind is notified of plan changes. The project price can't change here — pricing
              changes go through a new proposal.
            </p>
          </div>
        </Modal>
      )}

      {modal?.type === 'remove' && (
        <Modal
          mobile={mobile}
          title="Remove milestone"
          tone={modal.m.status === 'completed' ? 'danger' : 'default'}
          onClose={() => setModal(null)}
          footer={
            <>
              <Btn variant="ghost" onClick={() => setModal(null)}>
                Keep it
              </Btn>
              <Btn variant="dangerSolid" icon={I.trash} onClick={doRemove}>
                Remove milestone
              </Btn>
            </>
          }
        >
          <p style={{ fontSize: 13, color: c.textSecondary, margin: 0, lineHeight: 1.6 }}>
            {modal.m.status === 'completed' ? (
              <>
                <strong style={{ color: c.error, fontWeight: 650 }}>
                  {modal.m.title} is already complete
                </strong>{' '}
                — removing it erases delivered work from the plan Northwind can see. Northwind will
                be notified of the change.
              </>
            ) : (
              <>
                <strong style={{ color: c.text, fontWeight: 650 }}>{modal.m.title}</strong> comes
                off the delivery plan. Northwind will be notified of the change.
              </>
            )}
          </p>
        </Modal>
      )}

      {modal?.type === 'requestCompletion' && (
        <Modal
          mobile={mobile}
          title="Mark project complete"
          onClose={() => setModal(null)}
          footer={
            <>
              <Btn variant="ghost" onClick={() => setModal(null)}>
                Not yet
              </Btn>
              <Btn variant="gradient" icon={I.check} onClick={doRequestCompletion}>
                Send for Northwind's review
              </Btn>
            </>
          }
        >
          <p style={{ fontSize: 13, color: c.textSecondary, margin: 0, lineHeight: 1.6 }}>
            {ms.length === 0 ? (
              <>
                This project has no milestones, so there's nothing blocking completion — but only
                send it if delivery is genuinely done.{' '}
              </>
            ) : (
              <>All {ms.length} milestones are delivered. </>
            )}
            Northwind reviews the whole project and can accept it or request changes within{' '}
            {AUTO_ACCEPT_DAYS} days — after that it's accepted automatically. The delivery plan is
            locked while the project is in review, and Balo raises the final invoice once accepted.
          </p>
        </Modal>
      )}

      {modal?.type === 'withdraw' && (
        <Modal
          mobile={mobile}
          title="Withdraw completion request"
          onClose={() => setModal(null)}
          footer={
            <>
              <Btn variant="ghost" onClick={() => setModal(null)}>
                Keep it under review
              </Btn>
              <Btn variant="primary" icon={I.rotate} onClick={doWithdrawRequest}>
                Withdraw request
              </Btn>
            </>
          }
        >
          <p style={{ fontSize: 13, color: c.textSecondary, margin: 0, lineHeight: 1.6 }}>
            The project goes back to active and Northwind's review is cancelled — Northwind and the
            Balo team will be notified. Mark it complete again when you're ready.
          </p>
        </Modal>
      )}

      {modal?.type === 'acceptProject' && (
        <Modal
          mobile={mobile}
          title="Accept this project"
          onClose={() => setModal(null)}
          footer={
            <>
              <Btn variant="ghost" onClick={() => setModal(null)}>
                Cancel
              </Btn>
              <Btn variant="gradient" icon={I.thumbsUp} onClick={doAcceptProject}>
                Accept project
              </Btn>
            </>
          }
        >
          <p style={{ fontSize: 13, color: c.textSecondary, margin: 0, lineHeight: 1.6 }}>
            Accepting confirms {xp.short} delivered the project as agreed — it can't be un-accepted
            afterwards, and Balo raises the final invoice from here. If something's not right,
            request changes instead. {xp.short} and the Balo team are notified.
          </p>
        </Modal>
      )}

      {modal?.type === 'projectChanges' && (
        <Modal
          mobile={mobile}
          title="Request changes"
          onClose={() => setModal(null)}
          footer={
            <>
              <Btn variant="ghost" onClick={() => setModal(null)}>
                Cancel
              </Btn>
              <Btn
                variant="primary"
                icon={I.messageSquare}
                disabled={!changeReq.trim()}
                onClick={doProjectChanges}
              >
                Send change request
              </Btn>
            </>
          }
        >
          <p style={{ fontSize: 13, color: c.textSecondary, margin: '0 0 14px', lineHeight: 1.6 }}>
            The project goes back to active with your note attached — {xp.short} and the Balo team
            are notified, and the project is marked complete again once it's fixed. The{' '}
            {AUTO_ACCEPT_DAYS}-day review window restarts then.
          </p>
          <Field
            label="What needs to change?"
            hint="Be specific — this is exactly what {xp.short} sees."
          >
            <textarea
              rows={3}
              value={changeReq}
              onChange={(e) => setChangeReq(e.target.value)}
              style={inputStyle}
              placeholder="What's missing or not working, against the delivery plan"
            />
          </Field>
        </Modal>
      )}

      {modal?.type === 'cancel' && (
        <Modal
          mobile={mobile}
          title="Cancel this engagement"
          tone="danger"
          onClose={() => setModal(null)}
          footer={
            <>
              <Btn variant="ghost" onClick={() => setModal(null)}>
                Keep engagement
              </Btn>
              <Btn
                variant="dangerSolid"
                icon={I.slash}
                disabled={!reason.trim()}
                onClick={doCancel}
              >
                Cancel engagement
              </Btn>
            </>
          }
        >
          <p style={{ fontSize: 13, color: c.textSecondary, margin: '0 0 14px', lineHeight: 1.6 }}>
            This ends delivery permanently — Northwind and {xp.short} are both notified, and the
            workspace locks. A reason is required; it's recorded and shown on the cancelled
            engagement.
          </p>
          <Field label="Reason">
            <textarea
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              style={inputStyle}
              placeholder="Why this engagement is being cancelled"
            />
          </Field>
        </Modal>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// CONTROL BAR + HARNESS
// ══════════════════════════════════════════════════════════════════
function Seg({ options, value, onChange }) {
  return (
    <div
      style={{
        display: 'inline-flex',
        gap: 3,
        padding: 3,
        borderRadius: 10,
        background: c.surfaceSubtle,
      }}
    >
      {options.map((o) => {
        const on = value === o.k;
        return (
          <button
            key={String(o.k)}
            onClick={() => onChange(o.k)}
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
              color: on ? o.color || c.text : c.textTertiary,
              boxShadow: on ? '0 1px 3px rgba(0,0,0,0.08)' : 'none',
              fontFamily: 'inherit',
            }}
          >
            {o.icon && <o.icon size={14} color={on ? o.color || c.text : c.textTertiary} />}
            {o.l}
          </button>
        );
      })}
    </div>
  );
}
function ControlLabel({ children }) {
  return (
    <span
      style={{
        fontSize: 11,
        fontWeight: 700,
        color: c.textTertiary,
        textTransform: 'uppercase',
        letterSpacing: '0.06em',
      }}
    >
      {children}
    </span>
  );
}

export default function EngagementDelivery() {
  const [actor, setActor] = useState('expert');
  const [scenario, setScenario] = useState('delivery');
  const [retainer, setRetainer] = useState(false);
  const [agency, setAgency] = useState(false);
  const [mobile, setMobile] = useState(false);
  const am = ACTORS.find((a) => a.key === actor);
  // Expert party strings — party vs person, per the attribution rules.
  const xp = agency
    ? {
        agency: true,
        short: 'CloudPeak',
        person: 'Priya',
        retroFirst: 'Priya @ CloudPeak',
        clientHeader: 'Delivered by CloudPeak Consulting (Priya Sharma, CPQ Specialist)',
        adminHeader: 'Northwind Industrial (Dana) ↔ CloudPeak Consulting (Priya)',
      }
    : {
        agency: false,
        short: 'Priya',
        person: 'Priya',
        retroFirst: 'Priya',
        clientHeader: 'Delivered by Priya Sharma — CPQ Specialist',
        adminHeader: 'Northwind Industrial (Dana) ↔ Priya Sharma',
      };

  const inner = (
    <div key={`${actor}-${scenario}-${retainer}-${agency}`}>
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
      <Workspace lens={actor} scenarioKey={scenario} retainer={retainer} xp={xp} mobile={mobile} />
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

      {/* ── Prototype control bar (not part of the product UI) ── */}
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
            <ControlLabel>Lens</ControlLabel>
            <Seg
              value={actor}
              onChange={setActor}
              options={ACTORS.map((a) => ({ k: a.key, l: a.label, icon: a.icon, color: a.color }))}
            />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <ControlLabel>Scenario</ControlLabel>
            <select
              value={scenario}
              onChange={(e) => setScenario(e.target.value)}
              style={{
                padding: '8px 10px',
                borderRadius: 10,
                border: `1px solid ${c.border}`,
                fontSize: 13,
                fontWeight: 600,
                color: c.text,
                background: c.surface,
                fontFamily: 'inherit',
                cursor: 'pointer',
              }}
            >
              {Object.entries(SCENARIOS).map(([k, s]) => (
                <option key={k} value={k}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 7,
              fontSize: 12.5,
              color: c.textSecondary,
              cursor: 'pointer',
            }}
          >
            <input
              type="checkbox"
              checked={retainer}
              onChange={(e) => setRetainer(e.target.checked)}
              style={{ accentColor: c.primary }}
            />
            Retainer (no source request)
          </label>
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 7,
              fontSize: 12.5,
              color: c.textSecondary,
              cursor: 'pointer',
            }}
          >
            <input
              type="checkbox"
              checked={agency}
              onChange={(e) => setAgency(e.target.checked)}
              style={{ accentColor: c.primary }}
            />
            Agency expert
          </label>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 'auto' }}>
            <ControlLabel>View</ControlLabel>
            <Seg
              value={mobile}
              onChange={setMobile}
              options={[
                { k: false, l: 'Desktop' },
                { k: true, l: 'Mobile' },
              ]}
            />
          </div>
        </div>
      </div>

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
        <div style={{ maxWidth: 860, margin: '0 auto', padding: '24px 28px 80px' }}>{inner}</div>
      )}
    </div>
  );
}
