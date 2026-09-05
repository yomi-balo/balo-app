import { useState } from 'react';

// ══════════════════════════════════════════════════════════════════
// (unfiled) — BALO ADMIN: HOME (pending actions) · CAPTURE HEALTH · LOOKUP
// Route: /(dashboard)/admin  ·  the D1 + D6 prototype from the admin-dashboard
// design session (2026-09-04). Technical directions: PR #273
// (docs/admin-dashboard-technical-directions.md). Tracker: Notion §9.
//
// PURPOSE — see the direction before the ADRs are written.
//   · D6 (where admin lives): a "Balo admin" nav group INSIDE the member shell,
//     rendered only for platform staff; /admin/* stays in the (dashboard) route
//     group (B-cheap). Mobile: reached from the More sheet. The shell drawn
//     here is a stand-in for the ADR-1053 shell (balo-nav-explorer.jsx) — only
//     the admin group's placement is the decision.
//   · D1 (pending-actions primitive): Home IS the admin_alerts queue. One open
//     row per (kind, entity); ordered by first_seen_at, NEVER last_seen;
//     evidence SNAPSHOTTED into the row (a pointer goes stale — 4.9's marker
//     re-arm). Kinds registered with a finder close themselves; kinds with no
//     row to re-check close with a note. The registry is visible on every row.
//   · THE HOME/HEALTH RULE: nothing is resolved on Home except a manual close.
//     "Open" deep-links to the owning surface. Health is the DETAIL lens — the
//     row's full state and the action (re-drive) live there. One primitive,
//     two lenses. Queues are NOT separate pages: the Marketplace tile IS the
//     applications / reviews / triage queue.
//   · D4 (re-drive as a first-class mutator): the confirm sheet says what the
//     reset does, what job id is enqueued, and that it is recorded under the
//     acting admin — and the cases differ (recording resets + clears
//     mux_asset_id; a recap re-run resets nothing; a Daily-side failure is not
//     recoverable at all).
//   · D5 (staff bundles): the Viewer toggle. super_admin holds everything;
//     admin (support) holds view / cancel / promo / resolve but NOT fees,
//     config or re-drive. Expert earnings + margin render only with
//     MANAGE_PLATFORM_FEES — the fee-concealment invariant, relaxed on the
//     admin serializer and nowhere else. A client member never sees the group.
//   · D3: Lookup's Timeline is the audit_events stream. Reads write nothing.
//
// DECISIONS THIS PROTOTYPE ENCODES
//   · FOUR groups as stat tiles (the house filter control): Marketplace ·
//     Money · Capture · Meetings & calendar. Default = all. The tile sub is
//     the OLDEST open age in that group — age is the v1 signal; severity
//     ordering is deliberately not designed yet.
//   · ROW = a sentence a person understands · the entity · the evidence line ·
//     first seen / seen N× · how it closes. Expand in place for the snapshot.
//   · HOW A ROW CLEARS: a finder kind clears when the next sweep tick no
//     longer finds its entity — the approve / pay / repair action never touches
//     admin_alerts (two sources of truth would drift; that is why there is no
//     `source` column either). Latency = one sweep interval, made legible as
//     "swept Ns ago". Finder kinds therefore have NO Close button (a manual
//     close would be re-raised next tick); the no-finder kinds close with a
//     note, which becomes resolved_by + resolution_note + an audit row.
//     Resolved rows are never reopened — a recurrence is a new row — so
//     "third episode this month" is a cheap read, not a column.
//     `occurrences` counts event-driven raises, not sweep ticks; shown only
//     when > 1.
//   · PAGINATION: Home has none — a load-more cap (50) on a keyset cursor over
//     (first_seen_at, id), plus a STORM rule: a finder returning more than a
//     threshold of new entities in one tick raises ONE row for the kind with
//     the count, per-entity rows resuming below it. Health pages properly
//     (default last 30 days, issues first, keyset in 25s, a date range
//     control — the one place a date filter belongs). Lookup caps at 20 and
//     says "refine"; the chips are the refinement.
//   · ONE emphasized action per surface: Home → the oldest item waiting;
//     Health → none (a monitor earns no gradient button); empty → explain what
//     lands here; error → Retry.
//   · COPY: gender-neutral; prospective names the party, retrospective names
//     the person "@ company". Ages are facts ("waiting 6d"), never countdowns.
//     Errors say what happened and that nothing was changed.
//   · LOOKUP HAS EXACTLY ONE FILTER — entity type (People · Companies &
//     agencies · Meetings · Sessions · Requests), shown only while searching,
//     with live counts. Ids and emails match the same box (session id, Stripe
//     PaymentIntent, promo code) — no separate field. An empty query shows
//     Recent, kept per person and NOT read from audit_events (reads write
//     nothing, D3). No status or date filters here: state is what Home's
//     tiles and Health are for; a Lookup that filters by state is a second
//     queue wearing a search box.
//   · STATIC TABS, INSTANT PANEL SWITCHES (ADR-1053 motion spec): no tab-level
//     layout animation; only row entrances fade.
//   · STATES: loaded · loading · error · empty, per panel, from the control bar.
//
// NOT IN THIS PROTOTYPE: impersonation (deferred, D4); config beyond the
// catalogue (BAL-398's closed branch has the Consultations card); severity;
// the drill-ins behind "Open" that already ship as lenses (engagement,
// request, request files) — Lookup shows the two tabs that are NEW
// (Timeline, Money) on the one entity type with no lens yet (credit session).
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
  errorBorder: '#FECACA',
  cyan: '#0891B2',
  cyanLight: '#ECFEFF',
  cyanBorder: '#A5F3FC',
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
  chevDown: (p) => <Icon {...p} d="M6 9l6 6 6-6" />,
  chevLeft: (p) => <Icon {...p} d="M15 18l-6-6 6-6" />,
  arrowRight: (p) => <Icon {...p} d="M5 12h14M12 5l7 7-7 7" />,
  x: (p) => <Icon {...p} d="M18 6L6 18M6 6l12 12" />,
  zap: (p) => <Icon {...p} d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />,
  filter: (p) => <Icon {...p} d="M22 3H2l8 9.46V19l4 2v-8.54L22 3z" />,
  activity: (p) => <Icon {...p} d="M22 12h-4l-3 9L9 3l-3 9H2" />,
  shield: (p) => <Icon {...p} d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />,
  home: (p) => (
    <Multi {...p}>
      <path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
      <path d="M9 22V12h6v10" />
    </Multi>
  ),
  search: (p) => (
    <Multi {...p}>
      <circle cx="11" cy="11" r="8" />
      <path d="M21 21l-4.35-4.35" />
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
  message: (p) => <Icon {...p} d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />,
  sliders: (p) => (
    <Icon {...p} d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6" />
  ),
  more: (p) => (
    <Multi {...p}>
      <circle cx="12" cy="12" r="1" />
      <circle cx="19" cy="12" r="1" />
      <circle cx="5" cy="12" r="1" />
    </Multi>
  ),
  film: (p) => (
    <Multi {...p}>
      <path d="M23 7l-7 5 7 5V7z" />
      <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
    </Multi>
  ),
  mic: (p) => (
    <Multi {...p}>
      <path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z" />
      <path d="M19 10v2a7 7 0 01-14 0v-2M12 19v4M8 23h8" />
    </Multi>
  ),
  fileText: (p) => (
    <Multi {...p}>
      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
      <path d="M14 2v6h6M16 13H8M16 17H8M10 9H8" />
    </Multi>
  ),
  rotate: (p) => (
    <Multi {...p}>
      <path d="M23 4v6h-6M1 20v-6h6" />
      <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
    </Multi>
  ),
  externalLink: (p) => (
    <Multi {...p}>
      <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" />
      <path d="M15 3h6v6M10 14L21 3" />
    </Multi>
  ),
  lock: (p) => (
    <Multi {...p}>
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0110 0v4" />
    </Multi>
  ),
  dollar: (p) => <Icon {...p} d="M12 1v22M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6" />,
  calendar: (p) => (
    <Multi {...p}>
      <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
      <path d="M16 2v4M8 2v4M3 10h18" />
    </Multi>
  ),
  creditCard: (p) => (
    <Multi {...p}>
      <rect x="1" y="4" width="22" height="16" rx="2" ry="2" />
      <path d="M1 10h22" />
    </Multi>
  ),
  star: (p) => (
    <Multi {...p}>
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
    </Multi>
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
  checkCircle: (p) => (
    <Multi {...p}>
      <path d="M22 11.08V12a10 10 0 11-5.93-9.14" />
      <path d="M22 4L12 14.01l-3-3" />
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
@keyframes toastIn { from { opacity: 0; transform: translate(-50%, 10px); } to { opacity: 1; transform: translate(-50%, 0); } }
.balo-xscroll { overflow-x: auto; -webkit-overflow-scrolling: touch; scrollbar-width: none; flex-wrap: nowrap; }
.balo-xscroll::-webkit-scrollbar { display: none; }
.balo-focus:focus-visible { outline: 2px solid #2563EB; outline-offset: 2px; }
@media (prefers-reduced-motion: reduce) { * { animation-duration: 0.001s !important; transition-duration: 0.001s !important; } }
`;
const slideUp = (d = 0) => ({ animation: `slideUp 0.4s ease-out ${d}s both` });
const fadeIn = (d = 0) => ({ animation: `fadeIn 0.35s ease-out ${d}s both` });

// ── Primitives (identical idiom to the shipped admin lenses) ─────
function Card({ children, style: xs, onClick, highlight }) {
  const [h, setH] = useState(false);
  return (
    <div
      onClick={onClick}
      onMouseEnter={onClick ? () => setH(true) : undefined}
      onMouseLeave={onClick ? () => setH(false) : undefined}
      style={{
        background: c.surface,
        borderRadius: 16,
        border: `1px solid ${h || highlight ? c.primaryBorder : c.border}`,
        boxShadow: highlight
          ? `0 0 0 3px ${c.primaryGlow}`
          : h
            ? `0 4px 18px ${c.primaryGlow}`
            : '0 1px 3px rgba(0,0,0,0.04)',
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
  pulse,
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
      {pulse && <Dot color={color} pulse />}
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
  small,
  disabled,
  title,
}) {
  const [h, setH] = useState(false);
  const hover = h && !disabled;
  const styles = {
    primary: {
      background: hover ? c.primaryDark : c.primary,
      color: 'white',
      boxShadow: `0 2px 10px ${c.primaryGlow}`,
    },
    gradient: { background: c.gradient, color: 'white', boxShadow: `0 2px 10px ${c.primaryGlow}` },
    warm: {
      background: c.gradientWarm,
      color: 'white',
      boxShadow: '0 2px 10px rgba(217,119,6,0.22)',
    },
    ghost: {
      background: hover ? c.surfaceSubtle : 'transparent',
      color: c.textSecondary,
      border: `1px solid ${c.border}`,
    },
  };
  const iconColor = variant === 'ghost' ? c.textSecondary : 'white';
  return (
    <button
      className="balo-focus"
      onClick={disabled ? undefined : onClick}
      onMouseEnter={() => setH(true)}
      onMouseLeave={() => setH(false)}
      disabled={disabled}
      title={title}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 7,
        padding: small ? '7px 13px' : '9px 16px',
        borderRadius: 10,
        fontSize: small ? 12.5 : 13,
        fontWeight: 650,
        cursor: disabled ? 'not-allowed' : 'pointer',
        border: 'none',
        transition: 'all 0.2s',
        width: full ? '100%' : undefined,
        opacity: disabled ? 0.45 : 1,
        ...styles[variant],
        ...xs,
      }}
    >
      {IC && <IC size={14} color={iconColor} />}
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
const Dot = ({ color, pulse }) => (
  <span
    style={{
      width: 8,
      height: 8,
      borderRadius: '50%',
      flexShrink: 0,
      background: color,
      display: 'inline-block',
      animation: pulse ? 'dotPulse 1.6s ease-in-out infinite' : 'none',
    }}
  />
);
const TextLink = ({ children, onClick, icon: IC, color = c.primary }) => (
  <button
    className="balo-focus"
    onClick={onClick}
    style={{
      border: 'none',
      background: 'transparent',
      cursor: 'pointer',
      fontSize: 12,
      fontWeight: 600,
      color,
      display: 'inline-flex',
      alignItems: 'center',
      gap: 4,
      padding: 0,
    }}
  >
    {IC && <IC size={12} color={color} />}
    {children}
  </button>
);
const PageHeader = ({ title, sub, right }) => (
  <div
    style={{
      display: 'flex',
      alignItems: 'flex-end',
      justifyContent: 'space-between',
      gap: 12,
      flexWrap: 'wrap',
    }}
  >
    <div>
      <h1 style={{ fontSize: 22, fontWeight: 800, color: c.text, margin: 0 }}>{title}</h1>
      <p style={{ fontSize: 13, color: c.textTertiary, margin: '3px 0 0' }}>{sub}</p>
    </div>
    {right}
  </div>
);

// ── Stat tiles — the at-a-glance counts AND the filter control ───
// Click a tile to narrow; click again to return to the default (all).
function StatTiles({ tiles, value, onPick, mobile }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: mobile ? '1fr 1fr' : `repeat(${tiles.length}, 1fr)`,
        gap: 10,
      }}
    >
      {tiles.map((t, i) => {
        const on = value === t.key;
        return (
          <button
            key={t.key}
            className="balo-focus"
            onClick={() => onPick(on ? null : t.key)}
            title={t.hint}
            style={{
              textAlign: 'left',
              padding: '14px 16px',
              borderRadius: 14,
              cursor: 'pointer',
              border: `1.5px solid ${on ? t.border : c.border}`,
              background: on ? t.bgOn : c.surface,
              boxShadow: on ? `0 0 0 3px ${t.glow}` : '0 1px 3px rgba(0,0,0,0.04)',
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

// ══════════════════════════════════════════════════════════════════
// MODEL — capabilities (D5), alert kinds (D1 registry), worked data
// ══════════════════════════════════════════════════════════════════

// D5 — platform capability tokens. Three enum roles stay; the BUNDLES differ.
// (On main today `admin` and `super_admin` share ONE array reference — the
// split below is the first change D5 asks for.)
const CAP = {
  VIEW_ADMIN: 'view_admin',
  MANAGE_PLATFORM_FEES: 'manage_platform_fees',
  MANAGE_PLATFORM_CONFIG: 'manage_platform_config',
  MANAGE_PROMO_CODES: 'manage_promo_codes',
  CANCEL_ANY_MEETING: 'cancel_any_meeting',
  REDRIVE_JOB: 'redrive_job',
  RESOLVE_ALERTS: 'resolve_alerts',
};
const BUNDLES = {
  super_admin: Object.values(CAP),
  admin: [CAP.VIEW_ADMIN, CAP.CANCEL_ANY_MEETING, CAP.MANAGE_PROMO_CODES, CAP.RESOLVE_ALERTS],
  user: [],
};
const PERSONAS = [
  { key: 'yomi', name: 'Yomi', role: 'super_admin', roleLabel: 'super_admin', workspace: 'Balo' },
  { key: 'adeeb', name: 'Adeeb', role: 'admin', roleLabel: 'admin · support', workspace: 'Balo' },
  {
    key: 'dana',
    name: 'Dana Whitfield',
    role: 'user',
    roleLabel: 'client member',
    workspace: 'Northwind Industrial',
  },
];
const can = (persona, cap) => BUNDLES[persona.role].includes(cap);
const isStaff = (persona) => can(persona, CAP.VIEW_ADMIN);

// The four queue groups — the tiles on Home.
const GROUPS = {
  marketplace: {
    label: 'Marketplace',
    color: c.primary,
    bgOn: c.primaryLight,
    border: c.primaryBorder,
    glow: c.primaryGlow,
    icon: I.users,
    hint: 'Applications, reviews, project triage',
  },
  money: {
    label: 'Money',
    color: c.warning,
    bgOn: c.warningLight,
    border: c.warningBorder,
    glow: 'rgba(217,119,6,0.14)',
    icon: I.dollar,
    hint: 'Receivables, reloads, disputes, payouts, unbilled sessions',
  },
  capture: {
    label: 'Capture',
    color: c.accent,
    bgOn: c.accentLight,
    border: c.accentBorder,
    glow: 'rgba(124,58,237,0.14)',
    icon: I.film,
    hint: 'Recording, transcription, recap',
  },
  meetings: {
    label: 'Meetings & calendar',
    color: c.cyan,
    bgOn: c.cyanLight,
    border: c.cyanBorder,
    glow: 'rgba(8,145,178,0.14)',
    icon: I.calendar,
    hint: 'Calendar sync, amends, cancellations',
  },
};

// D1 — the kind REGISTRY. `finder: true` = a sweep can re-detect the row
// signature, so the alert closes itself when the condition clears.
// `finder: false` = nothing to re-check (the refusal IS the absence of a row),
// so a person closes it with a note. No `source` column — this registration
// is the whole truth.
const KINDS = {
  'expert.application_pending': {
    group: 'marketplace',
    icon: I.user,
    finder: true,
    closes: 'Closes itself once the application is approved or rejected',
  },
  'review.published': {
    group: 'marketplace',
    icon: I.star,
    finder: false,
    closes: 'Closes with a note — keep or remove',
  },
  'project.request_unmatched': {
    group: 'marketplace',
    icon: I.briefcase,
    finder: true,
    closes: 'Closes itself once experts are invited or a meeting is requested',
  },
  'receivable.open': {
    group: 'money',
    icon: I.creditCard,
    finder: true,
    closes: 'Closes itself when the receivable clears',
  },
  'payout.due': {
    group: 'money',
    icon: I.dollar,
    finder: true,
    closes: 'Closes itself when the run is paid',
  },
  'session.open_refused': {
    group: 'money',
    icon: I.alertTriangle,
    finder: false,
    closes: 'No row to re-check — closes with a note once recovered or written off',
  },
  'topup.unresolved_pi': {
    group: 'money',
    icon: I.rotate,
    finder: true,
    closes: 'Closes itself when the reconcile finds the PaymentIntent',
  },
  'dispute.opened': {
    group: 'money',
    icon: I.flag,
    finder: true,
    closes: 'Closes itself when Stripe decides the dispute',
  },
  'recording.failed': {
    group: 'capture',
    icon: I.film,
    finder: true,
    closes: 'Closes itself when a playable recording exists',
  },
  'transcript_capture.withheld_source': {
    group: 'capture',
    icon: I.mic,
    finder: true,
    closes: 'Closes itself when the batch job answers or the source is released',
  },
  'transcript.failed': {
    group: 'capture',
    icon: I.fileText,
    finder: true,
    closes: 'Closes itself when the recap reaches ready',
  },
  'calendar.subscription_lapse': {
    group: 'meetings',
    icon: I.calendar,
    finder: true,
    closes: 'Closes itself when the subscriptions exist',
  },
  'calendar.amend_failed': {
    group: 'meetings',
    icon: I.calendar,
    finder: false,
    closes: 'No row to re-check — closes with a note after the amend is re-driven',
  },
  'meeting.cancelled_after_start': {
    group: 'meetings',
    icon: I.xCircle,
    finder: false,
    closes: 'Closes with a note once the presence record is checked',
  },
};
const ENTITY_ICON = {
  expert: I.user,
  company: I.building,
  meeting: I.film,
  request: I.briefcase,
  calendar: I.calendar,
  session: I.dollar,
  run: I.users,
  review: I.star,
};

// Worked queue: 14 open alerts across the four groups, ages spread so the
// ordering rule is visible. `ageMin` = minutes since first_seen_at.
// Names gender-neutral; parties named prospectively, people retrospectively.
const D = 1440;
const ALERTS = [
  {
    id: 'a-app',
    kind: 'expert.application_pending',
    title: 'Expert application waiting for review',
    entity: { type: 'expert', label: 'Priya Nair @ CloudPeak' },
    evidence:
      'Submitted 29 Aug · Salesforce CTA + 2 certs · 14 skills · applying as CloudPeak (agency)',
    ageMin: 6 * D + 120,
    seen: 1,
    target: { label: 'the application', href: '/admin/applications/priya-nair' },
    detail: [
      ['Profile', 'Complete — bio, skills matrix, work history, 3 industries'],
      ['Certifications', 'Salesforce CTA · Sales Cloud Consultant · CPQ Specialist'],
      ['Using Balo as', 'Client, pre-approval, since 29 Aug'],
      ['On approval', 'activeMode → expert · searchable stays off until setup completes'],
    ],
  },
  {
    id: 'a-recv',
    kind: 'receivable.open',
    title: 'Northwind Industrial owes A$62.40 from a failed overdraft settlement',
    entity: { type: 'company', label: 'Northwind Industrial' },
    evidence:
      'Card declined (insufficient funds) · consultation 12 Aug · expert already paid · account soft-held',
    ageMin: 5 * D + 300,
    seen: 1,
    target: { label: 'the company', href: '/admin/lookup?company=northwind' },
    detail: [
      ['Receivable', 'A$62.40 · opened 12 Aug · 3 charge attempts'],
      ['Last attempt', '2 Sep · card_declined · insufficient_funds'],
      ['Hold', 'No new Cases until cleared — derived from the open receivable'],
      ['Dunning', 'Reminder sent 19 Aug and 26 Aug to billing holders'],
    ],
    money: {
      client: 'A$168.75',
      expert: 'A$135.00',
      margin: 'A$33.75',
      markup: '25%',
      extra: ['Overdraft settled', 'A$62.40 — failed'],
    },
  },
  {
    id: 'a-pay',
    kind: 'payout.due',
    title: 'Payout run due — 6 experts, A$4,210 unpaid',
    entity: { type: 'run', label: 'Cycle ended 31 Aug' },
    evidence:
      '6 experts with unpaid earnings · 2 have unverified bank details · nothing paid yet this cycle',
    ageMin: 4 * D + 400,
    seen: 1,
    target: { label: 'expert payouts', href: '/admin/payouts' },
    detail: [
      ['Unpaid', 'A$4,210.00 across 6 experts'],
      ['Blocked', 'Marcus Lee, Ravi Menon — bank details not yet verified'],
      ['Method', 'Airwallex transfers · Pay now per expert or Bulk pay'],
      ['Last run', '15 Aug · 5 experts · A$3,880.00'],
    ],
  },
  {
    id: 'a-amend',
    kind: 'calendar.amend_failed',
    title: 'Expert calendar not updated after a client reschedule',
    entity: {
      type: 'meeting',
      label: 'Marketing audit review · Pacific Retail Group × Ravi Menon',
    },
    evidence:
      'Balo moved the meeting to 9 Sep 14:00 · the Apiroc amend never ran · Ravi Menon’s calendar still shows 5 Sep',
    ageMin: 4 * D + 60,
    seen: 1,
    target: { label: 'the meeting', href: '/cases/c-mkt/meetings/m-mkt' },
    detail: [
      ['Rescheduled by', 'Sam Rivera @ Pacific Retail Group · 31 Aug 09:12'],
      ['Balo record', '9 Sep 14:00–14:45 AEST — correct everywhere Balo renders it'],
      ['Vendor event', 'Still 5 Sep 11:00 on the expert’s Google Calendar'],
      [
        'Why',
        'meeting-calendar-amend was never enqueued (one-colon jobId) — fix landed, needs a re-drive',
      ],
    ],
  },
  {
    id: 'a-refused',
    kind: 'session.open_refused',
    title: 'Consultation delivered unbilled — the wallet was busy',
    entity: { type: 'session', label: 'Meridian Retail × Tom Okafor · 45 min' },
    evidence:
      'wallet_busy: another Meridian consultation held the wallet’s live-session slot · admission retried once, refused again · expert unpaid · no session row exists',
    ageMin: 3 * D + 240,
    seen: 2,
    target: { label: 'the meeting', href: '/cases/c-svc/meetings/m-svc-2' },
    detail: [
      ['Refusal', 'wallet_busy at admission · 1 Sep 10:02'],
      ['The other session', 'Meridian × Aisha Bello, live 09:45–10:30 on the same wallet'],
      ['Delivered', '45 min on Balo Video · both parties present'],
      [
        'Recovery',
        'Manual: credit adjustment against the client + expert accrual — neither has a surface yet',
      ],
    ],
    money: {
      client: 'A$168.75',
      expert: 'A$135.00',
      margin: 'A$33.75',
      markup: '25%',
      extra: ['Charged', 'Nothing — no credit session was opened'],
    },
  },
  {
    id: 'a-withheld',
    kind: 'transcript_capture.withheld_source',
    title: 'Daily source held for a transcription job that never answered',
    entity: { type: 'meeting', label: 'CPQ kickoff · Northwind Industrial × Priya Nair' },
    evidence:
      'Batch job submitted 3d ago · no job-finished or job-error webhook · recording is playable · storage cost, not correctness',
    ageMin: 3 * D + 30,
    seen: 1,
    target: { label: 'capture health', view: 'health', rowId: 'h-cpq' },
    detail: [
      ['Batch job', 'bp_7f3a… · submitted 1 Sep 11:58 · preset transcript'],
      [
        'Recording',
        'Ready on Mux · Daily source deliberately withheld while the job may still be downloading',
      ],
      [
        'If it never answers',
        'Delete the batch job by hand; cleanup releases the source on the next tick',
      ],
    ],
  },
  {
    id: 'a-rec',
    kind: 'recording.failed',
    title: 'Recording ingest failed at Mux — the Daily source is still there',
    entity: { type: 'meeting', label: 'Sales Cloud health check · Bright Foods × Aisha Bello' },
    evidence:
      'failed_stage mux_asset · the Mux asset errored · Daily source present, so the ingest can be re-driven',
    ageMin: 2 * D + 500,
    seen: 1,
    target: { label: 'capture health', view: 'health', rowId: 'h-shc' },
    detail: [
      ['Recording', '42 min · 28 Aug · segment 1 of 1'],
      ['Failure', 'mux_asset · video.asset.errored · invalid_input'],
      [
        'Re-drive',
        'Resets the row to source_ready, clears mux_asset_id, enqueues recording-ingest--<id>--redrive-<auditId>',
      ],
      ['Recap', 'Not started — waits on a playable recording'],
    ],
  },
  {
    id: 'a-unmatched',
    kind: 'project.request_unmatched',
    title: 'Project request has had no experts invited for 3 days',
    entity: { type: 'request', label: 'Experience Cloud patient portal, phase 2 · Harbour Health' },
    evidence:
      'Raised 1 Sep · no exploratory meeting requested · 0 experts invited · client is waiting',
    ageMin: 2 * D + 200,
    seen: 1,
    target: { label: 'the pipeline', href: '/projects?lens=admin' },
    detail: [
      ['Raised by', 'Jordan Mensah @ Harbour Health · 1 Sep 16:40'],
      ['Scope', 'Patient self-service, prescriptions, MyGov integration · fixed price preferred'],
      ['Next', 'Invite experts, or request an exploratory meeting with Harbour Health'],
    ],
  },
  {
    id: 'a-recap',
    kind: 'transcript.failed',
    title: 'Recap failed at the summary step',
    entity: { type: 'meeting', label: 'Revenue Cloud check-in · Vector Logistics × Sofia Alvarez' },
    evidence:
      'failed_stage summarize_extract · the model timed out 3 times · a files-only recap was published',
    ageMin: 1 * D + 180,
    seen: 1,
    target: { label: 'capture health', view: 'health', rowId: 'h-rev' },
    detail: [
      ['Transcript', 'Captured 3 Sep · 31 min · diarised, 2 speakers'],
      ['Failure', 'summarize_extract · timeout after 3 attempts'],
      ['Re-run', 'Idempotent — re-enqueue converges on the row as it is'],
      ['Parties see', 'The recap with files only; no summary, no action items'],
    ],
  },
  {
    id: 'a-cancel',
    kind: 'meeting.cancelled_after_start',
    title: 'Meeting cancelled free after it had started',
    entity: { type: 'meeting', label: 'Billing setup review · Vector Logistics × Sofia Alvarez' },
    evidence:
      'hours_before_start −0.4 · an expert presence row exists · the presence-derived guard may have missed a Daily webhook',
    ageMin: 720,
    seen: 1,
    target: { label: 'the meeting', href: '/cases/c-rev/meetings/m-rev-3' },
    detail: [
      ['Cancelled by', 'Dana Whitfield @ Vector Logistics · 3 Sep 14:24'],
      ['Presence', 'Sofia Alvarez joined 14:01 · no in_progress flip recorded'],
      ['Charged', 'Nothing — the guard read “not once started”'],
      ['Check', 'Daily webhook log for the room between 14:00 and 14:24'],
    ],
  },
  {
    id: 'a-lapse',
    kind: 'calendar.subscription_lapse',
    title: 'Marcus Lee’s calendar is connected but has no live subscriptions',
    entity: { type: 'calendar', label: 'Marcus Lee @ Northstar Consulting · Google Calendar' },
    evidence:
      'Monitor arm 3 · connection active since 2 Jun · 0 of 2 wanted sub-calendars subscribed · a reconcile has been enqueued',
    ageMin: 540,
    seen: 1,
    target: { label: 'the expert’s calendar', href: '/admin/lookup?expert=marcus-lee' },
    detail: [
      ['Wanted', 'Work · Personal (both conflict-checked)'],
      ['Live subscriptions', '0'],
      [
        'Self-heal',
        'Reconcile enqueued 07:00 UTC — this alert is never suppressed by a repair attempt',
      ],
      ['Effect', 'Availability may be stale until subscriptions exist'],
    ],
  },
  {
    id: 'a-dispute',
    kind: 'dispute.opened',
    title: 'Stripe dispute on a A$500 top-up',
    entity: { type: 'company', label: 'Bright Foods' },
    evidence:
      'Reason: product not received · evidence due 18 Sep · credits not reversed (never auto-reverse)',
    ageMin: 480,
    seen: 1,
    target: { label: 'the company', href: '/admin/lookup?company=bright-foods' },
    detail: [
      ['Charge', 'A$500.00 top-up · 20 Aug · pi_3Nq…'],
      ['Wallet', 'A$312.60 remaining of that top-up'],
      ['Stripe', 'Respond by 18 Sep with the consultation receipts'],
      ['Rule', 'Credits stay — reverse only on charge.refunded'],
    ],
  },
  {
    id: 'a-review',
    kind: 'review.published',
    title: 'A 2-star review was published on Tom Okafor’s profile',
    entity: { type: 'review', label: 'By Sam Rivera @ Meridian Retail' },
    evidence:
      '“Kept rescheduling, hard to reach between sessions” · auto-published, visible now · first review under 3 stars for this expert',
    ageMin: 360,
    seen: 1,
    target: { label: 'the review', href: '/experts/tom-okafor#reviews' },
    detail: [
      ['Engagement', 'Service Cloud migration check-in · 2 Sep'],
      ['Expert’s history', '11 reviews · 4.8 average before this one'],
      ['Options', 'Keep it, or remove it with a recorded reason'],
    ],
  },
  {
    id: 'a-topup',
    kind: 'topup.unresolved_pi',
    title: 'Auto top-up charged but the credit can’t be matched to a PaymentIntent',
    entity: { type: 'company', label: 'Harbour Health' },
    evidence:
      'Marker 41 min old · no PaymentIntent id stamped · read-only Stripe list scan inconclusive · reconcile alarms every minute',
    ageMin: 41,
    seen: 1,
    target: { label: 'the company', href: '/admin/lookup?company=harbour-health' },
    detail: [
      ['Wallet', 'cw_2c1… · Harbour Health · pending_topup_at 12:19'],
      [
        'Triggering entry',
        'le_9a44… — snapshotted here because the marker re-arms after 15 min and erases it',
      ],
      ['Stripe', 'Search by wallet id or metadata.idempotencyKey in the Dashboard'],
      ['Then', 'Credit adjustment (4.1) or refund; the next tick closes this'],
    ],
  },
];

const fmtAge = (m) =>
  m < 60 ? `${m}m` : m < D ? `${Math.round(m / 60)}h` : `${Math.round(m / D)}d`;

// ── Capture health: the three ladders hanging off one meeting ────
const TONE = {
  success: { color: c.success, bg: c.successLight, border: c.successBorder },
  error: { color: c.error, bg: c.errorLight, border: c.errorBorder },
  warning: { color: c.warning, bg: c.warningLight, border: c.warningBorder },
  primary: { color: c.primary, bg: c.primaryLight, border: c.primaryBorder },
  neutral: { color: c.textTertiary, bg: c.surfaceSubtle, border: c.border },
};
const LADDER = {
  rec: {
    ready: { label: 'Playable', tone: 'success' },
    failed: { label: 'Failed', tone: 'error' },
    ingesting: { label: 'Ingesting', tone: 'primary', pulse: true },
    source_ready: { label: 'Source ready', tone: 'warning' },
  },
  tx: {
    finished: { label: 'Transcribed', tone: 'success' },
    submitted: { label: 'In flight', tone: 'primary', pulse: true },
    withheld: { label: 'Source held', tone: 'warning' },
    failed: { label: 'Failed', tone: 'error' },
    pending: { label: 'After recording', tone: 'neutral' },
    na: { label: 'Not transcribed', tone: 'neutral' },
    none: { label: '—', tone: 'neutral' },
  },
  recap: {
    ready: { label: 'Ready', tone: 'success' },
    processing: { label: 'Processing', tone: 'primary', pulse: true },
    failed: { label: 'Failed', tone: 'error' },
    partial: { label: 'Ready · action items skipped', tone: 'warning' },
    none: { label: '—', tone: 'neutral' },
    na: { label: 'Not applicable', tone: 'neutral' },
  },
};
const HEALTH = [
  {
    id: 'h-shc',
    title: 'Sales Cloud health check',
    client: 'Bright Foods',
    expert: 'Aisha Bello',
    when: '28 Aug',
    mins: 42,
    context: 'case',
    rec: { s: 'failed', stage: 'mux_asset', note: 'Mux asset errored · Daily source present' },
    tx: { s: 'pending' },
    recap: { s: 'none' },
    action: 'recording-ingest',
  },
  {
    id: 'h-mkt',
    title: 'Marketing audit review',
    client: 'Pacific Retail Group',
    expert: 'Ravi Menon',
    when: '30 Aug',
    mins: 47,
    context: 'case',
    rec: {
      s: 'failed',
      stage: 'daily',
      note: 'recording.error ×5 — cap reached · no source ever existed',
    },
    tx: { s: 'none' },
    recap: { s: 'none' },
    action: 'unrecoverable',
  },
  {
    id: 'h-cpq',
    title: 'CPQ kickoff',
    client: 'Northwind Industrial',
    expert: 'Priya Nair',
    when: '1 Sep',
    mins: 55,
    context: 'project_kickoff',
    rec: { s: 'ready', note: 'Daily source held' },
    tx: { s: 'withheld', note: 'Submitted 3d ago · no webhook yet' },
    recap: { s: 'none' },
    action: 'waiting-daily',
  },
  {
    id: 'h-svc',
    title: 'Service Cloud migration check-in',
    client: 'Meridian Retail',
    expert: 'Tom Okafor',
    when: '2 Sep',
    mins: 20,
    context: 'case',
    rec: { s: 'ready' },
    tx: { s: 'finished' },
    recap: {
      s: 'partial',
      stage: 'extract_action_items',
      note: 'Engagement not active — recap published, action items skipped',
    },
    action: null,
  },
  {
    id: 'h-rev',
    title: 'Revenue Cloud check-in',
    client: 'Vector Logistics',
    expert: 'Sofia Alvarez',
    when: '3 Sep',
    mins: 31,
    context: 'case',
    rec: { s: 'ready' },
    tx: { s: 'finished' },
    recap: {
      s: 'failed',
      stage: 'summarize_extract',
      note: 'Model timed out ×3 · files-only recap published',
    },
    action: 'transcript-pipeline',
  },
  {
    id: 'h-disc',
    title: 'Experience Cloud discovery',
    client: 'Harbour Health',
    expert: 'Marcus Lee',
    when: '3 Sep',
    mins: 30,
    context: 'project_discovery',
    rec: { s: 'ready' },
    tx: { s: 'na', note: 'No engagement behind this meeting' },
    recap: { s: 'na' },
    action: null,
  },
  {
    id: 'h-mig',
    title: 'Data migration pairing',
    client: 'Northwind Industrial',
    expert: 'Priya Nair',
    when: '4 Sep',
    mins: 62,
    context: 'case',
    rec: { s: 'ingesting' },
    tx: { s: 'submitted', note: 'Batch job in flight' },
    recap: { s: 'none' },
    action: null,
  },
  {
    id: 'h-bill',
    title: 'Billing setup Q&A',
    client: 'Vector Logistics',
    expert: 'Sofia Alvarez',
    when: '4 Sep',
    mins: 15,
    context: 'case',
    rec: { s: 'ready' },
    tx: { s: 'finished' },
    recap: { s: 'ready' },
    action: null,
  },
];
const healthCategory = (r) =>
  r.rec.s === 'failed'
    ? 'recording'
    : r.tx.s === 'withheld' || r.tx.s === 'failed'
      ? 'transcription'
      : r.recap.s === 'failed' || r.recap.s === 'partial'
        ? 'recap'
        : 'healthy';

// D4 — the re-drive cases are NOT one mutator. Each sheet says exactly what
// changes, what is enqueued, and who it is recorded under.
const REDRIVE = {
  'recording-ingest': {
    cta: 'Re-drive ingest',
    title: 'Re-drive the recording ingest?',
    body: (r, p) =>
      `Resets “${r.title}” to source_ready, clears the errored Mux asset id, and enqueues recording-ingest--${r.id}--redrive-<auditId>. The Daily source is still present, so the ingest can run. Recorded as admin.redrive.recording-ingest by ${p.name} @ Balo.`,
    after: { rec: { s: 'ingesting', note: 'Re-driven just now' } },
    toast: 'Re-drive queued — recorded as admin.redrive.recording-ingest',
  },
  'transcript-pipeline': {
    cta: 'Re-run recap',
    title: 'Re-run the recap pipeline?',
    body: (r, p) =>
      `Re-enqueues the recap pipeline for “${r.title}”. Nothing is reset — the pipeline is idempotent and converges on the row as it is. Recorded as admin.redrive.transcript-pipeline by ${p.name} @ Balo.`,
    after: { recap: { s: 'processing', note: 'Re-run just now' } },
    toast: 'Re-run queued — recorded as admin.redrive.transcript-pipeline',
  },
  'waiting-daily': {
    note: 'Waiting on Daily — if the batch job never answers, delete it by hand and the source releases on the next tick',
  },
  unrecoverable: {
    note: 'Not recoverable — Daily never produced a source. The recap is files-only.',
  },
};

// ── Lookup: the support entry point + the two NEW drill-in tabs ──
const LOOKUP = [
  {
    id: 'co-north',
    type: 'company',
    icon: I.building,
    title: 'Northwind Industrial',
    sub: 'Client company · 6 members · wallet A$−62.40 · soft-held (open receivable)',
    hay: 'northwind industrial company client northwind.com.au',
    timeline: [
      ['company.billing_email_seeded', 'Seeded from Dana Whitfield’s first top-up', '3 Mar'],
      ['receivable.opened', 'A$62.40 · overdraft settlement failed', '12 Aug'],
      ['receivable.dunning_sent', 'Reminder to billing holders', '26 Aug'],
    ],
  },
  {
    id: 'u-dana',
    type: 'user',
    icon: I.user,
    title: 'Dana Whitfield',
    sub: 'Owner @ Northwind Industrial · client mode · joined 3 Mar',
    hay: 'dana whitfield northwind user owner dana@northwind.com.au',
    timeline: [
      ['user.welcome', 'Signed up via Google · WorkOS', '3 Mar'],
      [
        'company_member.role_changed',
        'member → owner, by Alex Chen @ Northwind Industrial',
        '9 Mar',
      ],
      ['session.opened', 'On behalf of Dana Whitfield — system-opened at admission', '12 Aug'],
    ],
  },
  {
    id: 's-0812',
    type: 'session',
    icon: I.dollar,
    title: 'Consultation · 12 Aug · 45 min',
    sub: 'Northwind Industrial × Tom Okafor · settled · overdraft settlement failed',
    hay: 'northwind consultation session tom okafor 12 aug credit cs_8f2a pi_3nq7',
    timeline: [
      [
        'session.opened',
        'System on behalf of Dana Whitfield @ Northwind Industrial · admission',
        '12 Aug 10:02',
      ],
      ['session.settled', 'A$168.75 all-in · 45 min at the snapshotted rate', '12 Aug 10:49'],
      ['settlement.failed', 'Off-session charge declined · insufficient_funds', '12 Aug 10:49'],
      ['receivable.opened', 'A$62.40 · expert paid in full', '12 Aug 10:49'],
    ],
    money: {
      client: 'A$168.75',
      expert: 'A$135.00',
      margin: 'A$33.75',
      markup: '25%',
      extra: ['Overdraft settled', 'A$62.40 — failed → receivable'],
    },
  },
  {
    id: 'm-cpq',
    type: 'meeting',
    icon: I.film,
    title: 'CPQ kickoff · 1 Sep',
    sub: 'Northwind Industrial × Priya Nair @ CloudPeak · 55 min · transcription source held',
    hay: 'northwind cpq kickoff meeting priya nair mt_5d1c',
    timeline: [
      ['meeting.booked', 'By Dana Whitfield @ Northwind Industrial', '25 Aug'],
      [
        'meeting.rescheduled',
        '29 Aug 10:00 → 1 Sep 11:00 · by Dana Whitfield @ Northwind Industrial',
        '27 Aug',
      ],
      ['recording.ready', 'Mux asset ready · 55 min', '1 Sep'],
    ],
  },
  {
    id: 'r-cpq',
    type: 'request',
    icon: I.briefcase,
    title: 'CPQ implementation — replace legacy quoting tool',
    sub: 'Project request · Northwind Industrial · kicked off 12 Jun · opens the existing admin lens',
    hay: 'northwind cpq implementation request project',
    timeline: [
      ['project_request.balo_fee_overridden', '25% → 20% · by Yomi @ Balo', '4 Jun'],
      ['project.kickoff_approved', 'By Dana Whitfield @ Northwind Industrial', '12 Jun'],
    ],
  },
  {
    id: 'x-priya',
    type: 'expert',
    icon: I.user,
    title: 'Priya Nair',
    sub: 'Expert @ CloudPeak · Salesforce CPQ, Sales Cloud · delivering Northwind Industrial’s CPQ implementation',
    hay: 'priya nair cloudpeak expert northwind priya@cloudpeak.io',
    timeline: [
      ['expert.approved', 'By MJ @ Balo', '14 Feb'],
      ['expert.searchability_restored', 'Calendar reconnected — searchable again', '20 Aug'],
    ],
  },
  {
    id: 'ag-cp',
    type: 'agency',
    icon: I.users,
    title: 'CloudPeak',
    sub: 'Agency · 4 experts · Priya Nair, Aisha Bello and 2 more',
    hay: 'cloudpeak agency priya aisha',
    timeline: [
      ['agency.provisioned', 'By Priya Nair', '2 Feb'],
      ['agency_member.joined', 'Aisha Bello · via domain', '18 Feb'],
    ],
  },
];
const TYPE_LABEL = {
  company: 'Company',
  user: 'User',
  expert: 'Expert',
  session: 'Credit session',
  meeting: 'Meeting',
  request: 'Project request',
  agency: 'Agency',
};
// The ONE Lookup filter. `null` types = everything.
const TYPE_FILTERS = [
  ['all', 'All', null],
  ['people', 'People', ['user', 'expert']],
  ['orgs', 'Companies & agencies', ['company', 'agency']],
  ['meetings', 'Meetings', ['meeting']],
  ['sessions', 'Sessions', ['session']],
  ['requests', 'Requests', ['request']],
];
// Recent — per person, kept outside audit_events (reads write nothing).
const RECENT_IDS = ['s-0812', 'co-north', 'm-cpq'];

// ══════════════════════════════════════════════════════════════════
// HOME — the pending-actions queue (D1). Nothing is resolved here except a
// manual close; "Open" deep-links to the owning surface.
// ══════════════════════════════════════════════════════════════════

// The money block — the ONE place fee concealment relaxes. Client all-in is
// staff-visible; expert earnings and margin need MANAGE_PLATFORM_FEES.
function MoneyBlock({ money, canSeeFees, compact }) {
  const rows = [
    ['Client all-in', money.client, true],
    money.extra ? [money.extra[0], money.extra[1], true] : null,
    ['Expert earnings', money.expert, canSeeFees],
    ['Balo margin', `${money.margin} (${money.markup} markup)`, canSeeFees],
  ].filter(Boolean);
  return (
    <div
      style={{
        borderRadius: 12,
        border: `1px solid ${c.warningBorder}`,
        background: c.warningLight + '80',
        padding: compact ? '10px 12px' : '12px 14px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
        <I.dollar size={12} color={c.warning} />
        <span
          style={{
            fontSize: 11,
            fontWeight: 700,
            color: c.warning,
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
          }}
        >
          Money
        </span>
        <span style={{ fontSize: 11, color: c.textTertiary }}>
          · from the rate snapshots on the row
        </span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', rowGap: 6, columnGap: 16 }}>
        {rows.map(([k, v, visible]) => (
          <div key={k} style={{ display: 'contents' }}>
            <span style={{ fontSize: 12.5, color: c.textSecondary }}>{k}</span>
            {visible ? (
              <span
                style={{
                  fontSize: 12.5,
                  fontWeight: 650,
                  color: c.text,
                  fontVariantNumeric: 'tabular-nums',
                  textAlign: 'right',
                }}
              >
                {v}
              </span>
            ) : (
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 5,
                  fontSize: 11.5,
                  color: c.textTertiary,
                  justifyContent: 'flex-end',
                }}
              >
                <I.lock size={11} color={c.textTertiary} />
                Needs fee visibility
              </span>
            )}
          </div>
        ))}
      </div>
      {!canSeeFees && (
        <p style={{ fontSize: 11, color: c.textTertiary, margin: '8px 0 0', lineHeight: 1.5 }}>
          Expert earnings and margin render only for holders of MANAGE_PLATFORM_FEES.
        </p>
      )}
    </div>
  );
}

// One queue row. Line 1 the sentence, line 2 the entity + evidence, line 3
// age / occurrences / how it closes. Expands in place for the snapshot.
function AlertRow({ a, index, last, expanded, onToggle, persona, onOpen, onClose, mobile }) {
  const [h, setH] = useState(false);
  const [closing, setClosing] = useState(false);
  const [note, setNote] = useState('');
  const k = KINDS[a.kind];
  const g = GROUPS[k.group];
  const EntityIcon = ENTITY_ICON[a.entity.type] || I.layers;
  const KindIcon = k.icon;
  const canResolve = can(persona, CAP.RESOLVE_ALERTS);

  return (
    <div
      style={{
        borderBottom: last ? 'none' : `1px solid ${c.borderSubtle}`,
        background: expanded ? c.primaryLight + '55' : h ? c.surfaceSubtle + '70' : 'transparent',
        transition: 'background 0.15s',
        ...fadeIn(0.06 + index * 0.03),
      }}
    >
      <div
        role="button"
        tabIndex={0}
        className="balo-focus"
        onClick={onToggle}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onToggle()}
        onMouseEnter={() => setH(true)}
        onMouseLeave={() => setH(false)}
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: 12,
          padding: '15px 18px',
          cursor: 'pointer',
        }}
      >
        <div
          style={{
            width: 30,
            height: 30,
            borderRadius: 9,
            background: g.bgOn,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
          }}
        >
          <KindIcon size={14} color={g.color} />
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{ fontSize: 14, fontWeight: 700, color: c.text, margin: 0, lineHeight: 1.35 }}>
            {a.title}
          </p>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              marginTop: 5,
              flexWrap: 'wrap',
            }}
          >
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
              <EntityIcon size={12} color={c.textTertiary} />
              <span style={{ fontSize: 12.5, fontWeight: 600, color: c.textSecondary }}>
                {a.entity.label}
              </span>
            </span>
          </div>
          <p style={{ fontSize: 12.5, color: c.textSecondary, margin: '5px 0 0', lineHeight: 1.5 }}>
            {a.evidence}
          </p>
          <p
            style={{
              fontSize: 11.5,
              color: c.textTertiary,
              margin: '7px 0 0',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              flexWrap: 'wrap',
            }}
          >
            <span>First seen {fmtAge(a.ageMin)} ago</span>
            {a.seen > 1 && (
              <>
                <span style={{ color: c.borderSubtle }}>·</span>
                <span>raised {a.seen}×</span>
              </>
            )}
            <span style={{ color: c.borderSubtle }}>·</span>
            {k.finder ? (
              <span
                style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: c.success }}
              >
                <I.rotate size={10} color={c.success} />
                {k.closes}
              </span>
            ) : (
              <span
                style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: c.warning }}
              >
                <I.user size={10} color={c.warning} />
                {k.closes}
              </span>
            )}
          </p>
        </div>

        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'flex-end',
            gap: 8,
            flexShrink: 0,
          }}
        >
          {!mobile && (
            <Pill color={g.color} bg={g.bgOn} border={g.border} small>
              {g.label}
            </Pill>
          )}
          <span
            style={{
              fontSize: 15,
              fontWeight: 800,
              color: a.ageMin >= 3 * D ? c.error : c.textSecondary,
              fontVariantNumeric: 'tabular-nums',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
            }}
          >
            <I.clock size={12} color={a.ageMin >= 3 * D ? c.error : c.textTertiary} />
            {fmtAge(a.ageMin)}
          </span>
        </div>
        <I.chevDown
          size={16}
          color={c.textTertiary}
          style={{
            flexShrink: 0,
            marginTop: 6,
            transform: expanded ? 'rotate(180deg)' : 'none',
            transition: 'transform 0.2s',
          }}
        />
      </div>

      {expanded && (
        <div style={{ padding: '0 18px 16px 60px', ...fadeIn(0) }}>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: mobile ? '1fr' : a.money ? '1.2fr 1fr' : '1fr',
              gap: 14,
            }}
          >
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: mobile ? '1fr' : '1fr 1fr',
                gap: '8px 18px',
              }}
            >
              {a.detail.map(([dk, dv]) => (
                <div key={dk}>
                  <p
                    style={{
                      fontSize: 11,
                      fontWeight: 700,
                      color: c.textTertiary,
                      margin: 0,
                      textTransform: 'uppercase',
                      letterSpacing: '0.04em',
                    }}
                  >
                    {dk}
                  </p>
                  <p style={{ fontSize: 12.5, color: c.text, margin: '2px 0 0', lineHeight: 1.5 }}>
                    {dv}
                  </p>
                </div>
              ))}
            </div>
            {a.money && (
              <MoneyBlock
                money={a.money}
                canSeeFees={can(persona, CAP.MANAGE_PLATFORM_FEES)}
                compact
              />
            )}
          </div>

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              marginTop: 14,
              flexWrap: 'wrap',
            }}
          >
            <Btn variant="primary" small icon={I.externalLink} onClick={() => onOpen(a)}>
              Open {a.target.label}
            </Btn>
            {!k.finder && !closing && (
              <Btn
                variant="ghost"
                small
                icon={I.check}
                disabled={!canResolve}
                title={canResolve ? undefined : 'Closing needs the resolve-alerts capability'}
                onClick={() => setClosing(true)}
              >
                Close with a note
              </Btn>
            )}
            {k.finder && (
              <span style={{ fontSize: 12, color: c.textTertiary }}>
                No manual close — a sweep closes this when the condition clears.
              </span>
            )}
          </div>

          {closing && (
            <div style={{ marginTop: 12, ...fadeIn(0) }}>
              <textarea
                className="balo-focus"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="What was done, and why this can close — this note is the audit row"
                rows={2}
                style={{
                  width: '100%',
                  boxSizing: 'border-box',
                  borderRadius: 10,
                  border: `1px solid ${c.border}`,
                  padding: '9px 12px',
                  fontSize: 13,
                  fontFamily: 'inherit',
                  resize: 'vertical',
                  color: c.text,
                }}
              />
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <Btn
                  variant="primary"
                  small
                  icon={I.check}
                  disabled={note.trim().length < 8}
                  onClick={() => onClose(a, note)}
                >
                  Close
                </Btn>
                <Btn variant="ghost" small onClick={() => setClosing(false)}>
                  Keep open
                </Btn>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function HomePanel({ persona, alerts, onOpen, onClose, mobile }) {
  const [filter, setFilter] = useState(null);
  const [expanded, setExpanded] = useState(null);

  const open = [...alerts].sort((a, b) => b.ageMin - a.ageMin); // oldest first — first_seen, never last_seen
  const rows = filter ? open.filter((a) => KINDS[a.kind].group === filter) : open;
  const manual = open.filter((a) => !KINDS[a.kind].finder).length;
  const oldest = open[0];

  const tiles = Object.entries(GROUPS).map(([key, g]) => {
    const inGroup = open.filter((a) => KINDS[a.kind].group === key);
    return {
      key,
      label: g.label,
      count: inGroup.length,
      sub: inGroup.length ? `oldest ${fmtAge(inGroup[0].ageMin)}` : 'nothing open',
      icon: g.icon,
      color: g.color,
      border: g.border,
      bgOn: g.bgOn,
      glow: g.glow,
      hint: g.hint,
    };
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <PageHeader
        title="Home"
        sub={`${open.length} open · ${manual} close with a note · oldest waiting ${oldest ? fmtAge(oldest.ageMin) : '—'}`}
        right={
          oldest && (
            <Btn
              variant="warm"
              icon={I.zap}
              onClick={() => {
                setFilter(null);
                setExpanded(oldest.id);
              }}
            >
              Waiting {fmtAge(oldest.ageMin)} · {oldest.entity.label.split(' @')[0].split(' ·')[0]}
              <I.arrowRight size={14} color="white" />
            </Btn>
          )
        }
      />

      <StatTiles tiles={tiles} value={filter} onPick={setFilter} mobile={mobile} />

      <div>
        <SectionLabel
          icon={I.filter}
          right={
            filter ? (
              <TextLink icon={I.rotate} onClick={() => setFilter(null)}>
                Back to all
              </TextLink>
            ) : (
              <span
                style={{
                  fontSize: 12,
                  color: c.textTertiary,
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 5,
                }}
              >
                Oldest first
                <span style={{ color: c.borderSubtle }}>·</span>
                <I.rotate size={11} color={c.textTertiary} />
                swept 40s ago
              </span>
            )
          }
        >
          {filter ? GROUPS[filter].label : 'Everything open'} · {rows.length}
        </SectionLabel>

        {rows.length > 0 ? (
          <Card style={{ overflow: 'hidden', ...slideUp(0.05) }}>
            {rows.map((a, i) => (
              <AlertRow
                key={a.id}
                a={a}
                index={i}
                last={i === rows.length - 1}
                expanded={expanded === a.id}
                onToggle={() => setExpanded(expanded === a.id ? null : a.id)}
                persona={persona}
                onOpen={onOpen}
                onClose={onClose}
                mobile={mobile}
              />
            ))}
          </Card>
        ) : filter ? (
          <FilteredEmpty group={filter} onClear={() => setFilter(null)} />
        ) : null}
      </div>
    </div>
  );
}

// Filtered-empty: framed as a good outcome; the ONE action clears the filter.
function FilteredEmpty({ group, onClear }) {
  const g = GROUPS[group];
  return (
    <Card style={{ padding: '44px 30px', textAlign: 'center', ...slideUp(0.05) }}>
      <div
        style={{
          width: 54,
          height: 54,
          borderRadius: 15,
          background: c.successLight,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          margin: '0 auto 15px',
        }}
      >
        <I.coffee size={23} color={c.success} />
      </div>
      <h3 style={{ fontSize: 17, fontWeight: 750, color: c.text, margin: 0 }}>
        Nothing open in {g.label.toLowerCase()}
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
        {g.hint} — every item has been actioned or closed itself.
      </p>
      <div style={{ marginTop: 18 }}>
        <Btn variant="primary" icon={I.rotate} onClick={onClear}>
          Back to all
        </Btn>
      </div>
    </Card>
  );
}

// ══════════════════════════════════════════════════════════════════
// CAPTURE HEALTH — the detail lens. Recording, transcription and recap are
// three state ladders hanging off one meeting; the action lives here (D4).
// ══════════════════════════════════════════════════════════════════
function LadderChip({ ladder, state }) {
  const s = LADDER[ladder][state.s] || LADDER[ladder].none;
  const t = TONE[s.tone];
  return (
    <div style={{ minWidth: 0 }}>
      <Pill color={t.color} bg={t.bg} border={t.border} small pulse={s.pulse}>
        {s.label}
        {state.stage && <span style={{ fontWeight: 500, opacity: 0.85 }}>· {state.stage}</span>}
      </Pill>
      {state.note && (
        <p style={{ fontSize: 11, color: c.textTertiary, margin: '4px 0 0', lineHeight: 1.45 }}>
          {state.note}
        </p>
      )}
    </div>
  );
}

function HealthRow({ r, index, last, highlight, persona, onRedrive, mobile }) {
  const canRedrive = can(persona, CAP.REDRIVE_JOB);
  const rd = r.action ? REDRIVE[r.action] : null;
  const ladders = (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: mobile ? '1fr' : '1fr 1fr 1fr',
        gap: mobile ? 8 : 12,
      }}
    >
      {[
        ['Recording', 'rec'],
        ['Transcription', 'tx'],
        ['Recap', 'recap'],
      ].map(([label, key]) => (
        <div key={key}>
          <p
            style={{
              fontSize: 10.5,
              fontWeight: 700,
              color: c.textTertiary,
              margin: '0 0 4px',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
            }}
          >
            {label}
          </p>
          <LadderChip ladder={key} state={r[key]} />
        </div>
      ))}
    </div>
  );
  const action = rd ? (
    rd.cta ? (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: mobile ? 'flex-start' : 'flex-end',
          gap: 5,
        }}
      >
        <Btn
          variant="primary"
          small
          icon={I.rotate}
          disabled={!canRedrive}
          title={canRedrive ? undefined : 'Re-drive needs an engineer (REDRIVE_JOB)'}
          onClick={() => onRedrive(r)}
        >
          {rd.cta}
        </Btn>
        {!canRedrive && (
          <span style={{ fontSize: 11, color: c.textTertiary }}>Needs an engineer</span>
        )}
      </div>
    ) : (
      <p
        style={{
          fontSize: 11.5,
          color: c.textTertiary,
          margin: 0,
          maxWidth: 220,
          lineHeight: 1.5,
          textAlign: mobile ? 'left' : 'right',
        }}
      >
        {rd.note}
      </p>
    )
  ) : null;

  return (
    <div
      id={`health-${r.id}`}
      style={{
        display: 'grid',
        gridTemplateColumns: mobile ? '1fr' : '1.15fr 2fr auto',
        gap: mobile ? 10 : 18,
        alignItems: 'start',
        padding: '15px 18px',
        borderBottom: last ? 'none' : `1px solid ${c.borderSubtle}`,
        background: highlight ? c.primaryLight + '70' : 'transparent',
        boxShadow: highlight ? `inset 3px 0 0 ${c.primary}` : 'none',
        ...fadeIn(0.06 + index * 0.03),
      }}
    >
      <div style={{ minWidth: 0 }}>
        <p style={{ fontSize: 14, fontWeight: 700, color: c.text, margin: 0 }}>{r.title}</p>
        <p style={{ fontSize: 12.5, color: c.textSecondary, margin: '4px 0 0' }}>
          {r.client} × {r.expert}
        </p>
        <p
          style={{
            fontSize: 11.5,
            color: c.textTertiary,
            margin: '4px 0 0',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {r.when} · {r.mins} min · {r.context.replace('_', ' ')}
        </p>
      </div>
      {ladders}
      <div style={{ minWidth: mobile ? 0 : 150 }}>{action}</div>
    </div>
  );
}

function HealthPanel({ persona, rows, highlightId, onRedrive, mobile }) {
  const [filter, setFilter] = useState(null);
  const cats = {
    recording: 'Recording issues',
    transcription: 'Transcription issues',
    recap: 'Recap issues',
    healthy: 'Healthy',
  };
  const tiles = Object.entries(cats).map(([key, label]) => {
    const n = rows.filter((r) => healthCategory(r) === key).length;
    const col =
      key === 'recap'
        ? {
            color: c.accent,
            border: c.accentBorder,
            bgOn: c.accentLight,
            glow: 'rgba(124,58,237,0.14)',
          }
        : key === 'healthy'
          ? {
              color: c.success,
              border: c.successBorder,
              bgOn: c.successLight,
              glow: 'rgba(5,150,105,0.14)',
            }
          : key === 'recording'
            ? {
                color: c.error,
                border: c.errorBorder,
                bgOn: c.errorLight,
                glow: 'rgba(220,38,38,0.14)',
              }
            : {
                color: c.warning,
                border: c.warningBorder,
                bgOn: c.warningLight,
                glow: 'rgba(217,119,6,0.14)',
              };
    return {
      key,
      label,
      count: n,
      sub: key === 'healthy' ? 'nothing to do' : n ? 'needs a look' : 'none',
      icon:
        key === 'recording'
          ? I.film
          : key === 'transcription'
            ? I.mic
            : key === 'recap'
              ? I.fileText
              : I.checkCircle,
      hint: label,
      ...col,
    };
  });
  const list = (filter ? rows.filter((r) => healthCategory(r) === filter) : rows)
    .slice()
    .sort((a, b) => {
      const rank = { recording: 0, transcription: 1, recap: 2, healthy: 3 };
      return rank[healthCategory(a)] - rank[healthCategory(b)];
    });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <PageHeader
        title="Capture health"
        sub="Every recorded consultation with its three pipelines — recording, transcription, recap. Re-drive lives here."
      />
      <StatTiles tiles={tiles} value={filter} onPick={setFilter} mobile={mobile} />
      <div>
        <SectionLabel
          icon={I.activity}
          right={
            filter ? (
              <TextLink icon={I.rotate} onClick={() => setFilter(null)}>
                Back to all
              </TextLink>
            ) : (
              <span style={{ fontSize: 12, color: c.textTertiary }}>Issues first</span>
            )
          }
        >
          {filter ? cats[filter] : 'All recorded consultations'} · {list.length}
        </SectionLabel>
        <Card style={{ overflow: 'hidden', ...slideUp(0.05) }}>
          {list.map((r, i) => (
            <HealthRow
              key={r.id}
              r={r}
              index={i}
              last={i === list.length - 1}
              highlight={highlightId === r.id}
              persona={persona}
              onRedrive={onRedrive}
              mobile={mobile}
            />
          ))}
        </Card>
      </div>
    </div>
  );
}

// The re-drive confirm sheet — says what changes, what is enqueued, and who
// it is recorded under. Cancel is the quiet action; confirm keeps the verb.
function RedriveSheet({ row, persona, onCancel, onConfirm, inset }) {
  const rd = REDRIVE[row.action];
  return (
    <div
      onClick={onCancel}
      style={{
        position: inset ? 'absolute' : 'fixed',
        inset: 0,
        background: 'rgba(17,24,39,0.45)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 60,
        padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: c.surface,
          borderRadius: 18,
          padding: 22,
          width: 460,
          maxWidth: '100%',
          boxShadow: '0 24px 60px rgba(0,0,0,0.25)',
          ...slideUp(0),
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
          <div
            style={{
              width: 36,
              height: 36,
              borderRadius: 10,
              background: c.primaryLight,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <I.rotate size={16} color={c.primary} />
          </div>
          <h3 style={{ fontSize: 16, fontWeight: 750, color: c.text, margin: 0 }}>{rd.title}</h3>
        </div>
        <p style={{ fontSize: 13, color: c.textSecondary, margin: 0, lineHeight: 1.65 }}>
          {rd.body(row, persona)}
        </p>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 18 }}>
          <Btn variant="ghost" onClick={onCancel}>
            Cancel
          </Btn>
          <Btn variant="primary" icon={I.rotate} onClick={onConfirm}>
            {rd.cta}
          </Btn>
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// LOOKUP — the support entry point. Search across entity types; the drill-in
// shows the two tabs that are NEW: Timeline (audit_events — reads write
// nothing, D3) and Money (the admin serializer, capability-gated).
// ══════════════════════════════════════════════════════════════════
function LookupPanel({ persona, mobile, initialQuery, onToast }) {
  const [q, setQ] = useState(initialQuery ?? 'northwind');
  const [typeKey, setTypeKey] = useState('all');
  const [selId, setSelId] = useState('s-0812');
  const [tab, setTab] = useState('timeline');
  const query = q.trim().toLowerCase();
  const searching = query.length > 0;
  const matches = searching
    ? LOOKUP.filter((e) => e.hay.includes(query))
    : LOOKUP.filter((e) => RECENT_IDS.includes(e.id));
  const activeTypes = TYPE_FILTERS.find(([k]) => k === typeKey)[2];
  const results = activeTypes ? matches.filter((e) => activeTypes.includes(e.type)) : matches;
  const sel = results.find((e) => e.id === selId) || null;
  const tabs = sel ? [['timeline', 'Timeline'], ...(sel.money ? [['money', 'Money']] : [])] : [];
  const typeLabel = TYPE_FILTERS.find(([k]) => k === typeKey)[1];

  // Type chips — only while searching; counts are live for this query.
  const chips = searching && (
    <div className="balo-xscroll" style={{ display: 'flex', gap: 6, ...fadeIn(0) }}>
      {TYPE_FILTERS.map(([key, label, ts]) => {
        const n = ts ? matches.filter((e) => ts.includes(e.type)).length : matches.length;
        const on = typeKey === key;
        const dead = n === 0 && !on;
        return (
          <button
            key={key}
            className="balo-focus"
            disabled={dead}
            onClick={() => setTypeKey(key)}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '6px 11px',
              borderRadius: 20,
              border: `1px solid ${on ? c.primaryBorder : c.border}`,
              background: on ? c.primaryLight : c.surface,
              color: on ? c.primary : dead ? c.textTertiary : c.textSecondary,
              fontSize: 12.5,
              fontWeight: on ? 650 : 500,
              cursor: dead ? 'default' : 'pointer',
              opacity: dead ? 0.55 : 1,
              whiteSpace: 'nowrap',
            }}
          >
            {label}
            <span
              style={{
                fontSize: 11,
                fontWeight: 700,
                fontVariantNumeric: 'tabular-nums',
                color: on ? c.primary : c.textTertiary,
              }}
            >
              {n}
            </span>
          </button>
        );
      })}
    </div>
  );

  const resultsList = (
    <Card style={{ overflow: 'hidden' }}>
      {results.length === 0 ? (
        <div style={{ padding: '30px 20px', textAlign: 'center' }}>
          <p style={{ fontSize: 14, fontWeight: 700, color: c.text, margin: 0 }}>
            {activeTypes
              ? `Nothing in ${typeLabel.toLowerCase()} for “${q}”`
              : `Nothing matches “${q}”`}
          </p>
          <p style={{ fontSize: 12.5, color: c.textSecondary, margin: '6px 0 0' }}>
            {activeTypes && matches.length > 0
              ? `${matches.length} in other types.`
              : 'Try a person, a company or agency, a meeting title, an email, or an id.'}
          </p>
          {activeTypes && matches.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <TextLink icon={I.rotate} onClick={() => setTypeKey('all')}>
                Show all types
              </TextLink>
            </div>
          )}
        </div>
      ) : (
        results.map((e, i) => {
          const on = sel && sel.id === e.id;
          const EI = e.icon;
          return (
            <div
              key={e.id}
              role="button"
              tabIndex={0}
              className="balo-focus"
              onClick={() => {
                setSelId(e.id);
                setTab('timeline');
              }}
              onKeyDown={(ev) => (ev.key === 'Enter' || ev.key === ' ') && setSelId(e.id)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                padding: '12px 16px',
                cursor: 'pointer',
                borderBottom: i === results.length - 1 ? 'none' : `1px solid ${c.borderSubtle}`,
                background: on ? c.primaryLight + '70' : 'transparent',
                boxShadow: on ? `inset 3px 0 0 ${c.primary}` : 'none',
                ...fadeIn(0.04 + i * 0.03),
              }}
            >
              <div
                style={{
                  width: 30,
                  height: 30,
                  borderRadius: 9,
                  background: c.surfaceSubtle,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                }}
              >
                <EI size={14} color={c.textSecondary} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <p style={{ fontSize: 13.5, fontWeight: 700, color: c.text, margin: 0 }}>
                  {e.title}
                </p>
                <p
                  style={{
                    fontSize: 12,
                    color: c.textSecondary,
                    margin: '2px 0 0',
                    lineHeight: 1.4,
                  }}
                >
                  {e.sub}
                </p>
              </div>
              <Pill small>{TYPE_LABEL[e.type]}</Pill>
              <I.chevRight size={14} color={c.textTertiary} />
            </div>
          );
        })
      )}
    </Card>
  );

  const drill = sel && (
    <Card style={{ overflow: 'hidden', ...fadeIn(0) }}>
      <div style={{ padding: '14px 16px', borderBottom: `1px solid ${c.borderSubtle}` }}>
        <div
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}
        >
          <div style={{ minWidth: 0 }}>
            <p
              style={{
                fontSize: 11,
                fontWeight: 700,
                color: c.textTertiary,
                margin: 0,
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
              }}
            >
              {TYPE_LABEL[sel.type]}
            </p>
            <p style={{ fontSize: 14.5, fontWeight: 750, color: c.text, margin: '2px 0 0' }}>
              {sel.title}
            </p>
          </div>
          <TextLink
            icon={I.externalLink}
            onClick={() => onToast(`Opens the full ${TYPE_LABEL[sel.type].toLowerCase()} view`)}
          >
            Open
          </TextLink>
        </div>
        <div style={{ display: 'flex', gap: 4, marginTop: 12 }}>
          {tabs.map(([key, label]) => {
            const on = tab === key;
            return (
              <button
                key={key}
                className="balo-focus"
                onClick={() => setTab(key)}
                style={{
                  padding: '6px 12px',
                  borderRadius: 8,
                  border: 'none',
                  cursor: 'pointer',
                  fontSize: 12.5,
                  fontWeight: on ? 650 : 500,
                  background: on ? c.primaryLight : 'transparent',
                  color: on ? c.primary : c.textSecondary,
                }}
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>
      <div style={{ padding: 16 }}>
        {tab === 'timeline' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
            {sel.timeline.map(([action, what, when], i) => (
              <div
                key={action + when}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '14px 1fr auto',
                  gap: 10,
                  alignItems: 'start',
                  paddingBottom: i === sel.timeline.length - 1 ? 0 : 12,
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    paddingTop: 5,
                  }}
                >
                  <Dot color={i === sel.timeline.length - 1 ? c.primary : c.border} />
                  {i !== sel.timeline.length - 1 && (
                    <span
                      style={{
                        width: 1,
                        flex: 1,
                        minHeight: 22,
                        background: c.borderSubtle,
                        marginTop: 4,
                      }}
                    />
                  )}
                </div>
                <div style={{ minWidth: 0 }}>
                  <p
                    style={{
                      fontSize: 12,
                      fontWeight: 700,
                      color: c.text,
                      margin: 0,
                      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                    }}
                  >
                    {action}
                  </p>
                  <p
                    style={{
                      fontSize: 12.5,
                      color: c.textSecondary,
                      margin: '2px 0 0',
                      lineHeight: 1.45,
                    }}
                  >
                    {what}
                  </p>
                </div>
                <span
                  style={{
                    fontSize: 11.5,
                    color: c.textTertiary,
                    whiteSpace: 'nowrap',
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  {when}
                </span>
              </div>
            ))}
            <p style={{ fontSize: 11, color: c.textTertiary, margin: '14px 0 0', lineHeight: 1.5 }}>
              From audit_events — every row was written in the same transaction as the change it
              records.
            </p>
          </div>
        )}
        {tab === 'money' && (
          <MoneyBlock money={sel.money} canSeeFees={can(persona, CAP.MANAGE_PLATFORM_FEES)} />
        )}
      </div>
    </Card>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <PageHeader
        title="Lookup"
        sub="Find a user, company, agency, expert, meeting or credit session — the support entry point."
      />
      <div style={{ position: 'relative', ...slideUp(0.03) }}>
        <I.search
          size={16}
          color={c.textTertiary}
          style={{ position: 'absolute', left: 14, top: 13 }}
        />
        <input
          className="balo-focus"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setSelId(null);
            setTypeKey('all');
          }}
          placeholder="Name, email, company, meeting, session id, PaymentIntent…"
          style={{
            width: '100%',
            boxSizing: 'border-box',
            padding: '11px 14px 11px 40px',
            borderRadius: 12,
            border: `1px solid ${c.border}`,
            fontSize: 14,
            fontFamily: 'inherit',
            background: c.surface,
            color: c.text,
          }}
        />
        <p style={{ fontSize: 11.5, color: c.textTertiary, margin: '6px 0 0 2px' }}>
          Ids work too — paste a session id, a Stripe PaymentIntent, or a promo code straight in.
        </p>
      </div>
      {chips}
      <div>
        <SectionLabel icon={searching ? I.filter : I.clock}>
          {searching
            ? `${typeKey === 'all' ? 'Results' : typeLabel} · ${results.length}`
            : 'Recent · opened by you'}
        </SectionLabel>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: mobile || !sel ? '1fr' : '1fr 1fr',
            gap: 16,
            alignItems: 'start',
          }}
        >
          {resultsList}
          {drill}
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// CONFIG & CATALOGUE — where the existing and planned config surfaces live.
// ══════════════════════════════════════════════════════════════════
function CataloguePanel({ persona, onToast }) {
  const rows = [
    {
      title: 'Platform config',
      sub: 'Consultations card — minimum length, availability look-ahead. Storage direction: keyed platform_settings (D2).',
      href: '/admin/config',
      cap: CAP.MANAGE_PLATFORM_CONFIG,
      status: ['Not on main yet', 'warning'],
      icon: I.sliders,
    },
    {
      title: 'Promo codes',
      sub: 'Mint, deactivate, track redemptions — the acquisition channel.',
      href: '/promo-codes',
      cap: CAP.MANAGE_PROMO_CODES,
      status: ['Shipped', 'success'],
      icon: I.zap,
    },
    {
      title: 'Engagements',
      sub: 'Delivery oversight — in flight, in review, gone quiet.',
      href: '/engagements',
      cap: null,
      status: ['Shipped', 'success'],
      icon: I.briefcase,
    },
    {
      title: 'Featured experts',
      sub: 'Ordered spotlight for the marketing home; consenting, publicly visible experts only.',
      href: '/admin/config/spotlight',
      cap: CAP.MANAGE_PLATFORM_CONFIG,
      status: ['Designed — BAL-493', 'neutral'],
      icon: I.star,
    },
    {
      title: 'Taxonomy',
      sub: 'Verticals, products, skills, certifications — adding a vertical is a data operation.',
      href: '/admin/taxonomy',
      cap: CAP.MANAGE_PLATFORM_CONFIG,
      status: ['Seeded, not editable', 'neutral'],
      icon: I.layers,
    },
  ];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <PageHeader
        title="Config & catalogue"
        sub="Platform knobs and the admin surfaces that already exist. Each write is audited; view is staff-wide."
      />
      <Card style={{ overflow: 'hidden', ...slideUp(0.05) }}>
        {rows.map((r, i) => {
          const gated = r.cap && !can(persona, r.cap);
          const t = TONE[r.status[1] === 'accent' ? 'primary' : r.status[1]];
          const RI = r.icon;
          return (
            <div
              key={r.title}
              role="button"
              tabIndex={0}
              className="balo-focus"
              onClick={() => onToast(`Opens ${r.href}${gated ? ' — view only for this role' : ''}`)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                padding: '14px 18px',
                cursor: 'pointer',
                borderBottom: i === rows.length - 1 ? 'none' : `1px solid ${c.borderSubtle}`,
                ...fadeIn(0.05 + i * 0.03),
              }}
            >
              <div
                style={{
                  width: 30,
                  height: 30,
                  borderRadius: 9,
                  background: c.surfaceSubtle,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                }}
              >
                <RI size={14} color={c.textSecondary} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <p style={{ fontSize: 14, fontWeight: 700, color: c.text, margin: 0 }}>{r.title}</p>
                <p
                  style={{
                    fontSize: 12.5,
                    color: c.textSecondary,
                    margin: '3px 0 0',
                    lineHeight: 1.45,
                  }}
                >
                  {r.sub}
                </p>
              </div>
              {gated && (
                <Pill small icon={I.lock}>
                  View only
                </Pill>
              )}
              <Pill color={t.color} bg={t.bg} border={t.border} small>
                {r.status[0]}
              </Pill>
              <I.chevRight size={14} color={c.textTertiary} />
            </div>
          );
        })}
      </Card>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// STATES — loading · error · empty, per panel
// ══════════════════════════════════════════════════════════════════
const PANEL_META = {
  home: { title: 'Home', sub: 'What needs a person — oldest first.' },
  health: { title: 'Capture health', sub: 'Every recorded consultation with its three pipelines.' },
  lookup: {
    title: 'Lookup',
    sub: 'Find a user, company, agency, expert, meeting or credit session.',
  },
  catalogue: {
    title: 'Config & catalogue',
    sub: 'Platform knobs and the admin surfaces that already exist.',
  },
};
function LoadingPanel({ view, mobile }) {
  const shimmer = {
    background: `linear-gradient(90deg, ${c.surfaceSubtle} 0px, #E9EEF5 220px, ${c.surfaceSubtle} 440px)`,
    backgroundSize: '840px 100%',
    animation: 'shimmer 1.3s linear infinite',
    borderRadius: 8,
  };
  const tiles = view === 'home' || view === 'health';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }} aria-busy="true">
      <div>
        <div style={{ ...shimmer, height: 24, width: 200, marginBottom: 8 }} />
        <div style={{ ...shimmer, height: 13, width: 320 }} />
      </div>
      {tiles && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: mobile ? '1fr 1fr' : 'repeat(4, 1fr)',
            gap: 10,
          }}
        >
          {[0, 1, 2, 3].map((k) => (
            <div key={k} style={{ ...shimmer, height: 82, borderRadius: 14 }} />
          ))}
        </div>
      )}
      {view === 'lookup' && <div style={{ ...shimmer, height: 44, borderRadius: 12 }} />}
      <div style={{ ...shimmer, height: 14, width: 130 }} />
      <Card style={{ overflow: 'hidden' }}>
        {[0, 1, 2, 3].map((k) => (
          <div
            key={k}
            style={{
              padding: '16px 18px',
              borderBottom: k === 3 ? 'none' : `1px solid ${c.borderSubtle}`,
              display: 'flex',
              gap: 12,
            }}
          >
            <div style={{ ...shimmer, width: 30, height: 30, borderRadius: 9 }} />
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
function ErrorPanel({ view }) {
  const m = PANEL_META[view];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <PageHeader title={m.title} sub={m.sub} />
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
          {m.title} didn&rsquo;t load
        </h3>
        <p
          style={{
            fontSize: 13,
            color: c.textSecondary,
            margin: '8px auto 0',
            maxWidth: 400,
            lineHeight: 1.6,
          }}
        >
          Something went wrong on our side — nothing was changed, and every alert is still recorded.
          Retry in a moment.
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
// True-zero empties EXPLAIN how items come to exist — a bare "nothing here"
// would be a defect on a queue.
function EmptyPanel({ view, onGo, mobile, persona }) {
  const m = PANEL_META[view];
  if (view === 'lookup')
    return (
      <LookupPanel persona={persona} mobile={mobile} initialQuery="zephyr" onToast={() => {}} />
    );
  if (view === 'catalogue') return <CataloguePanel persona={persona} onToast={() => {}} />;
  const copy =
    view === 'home'
      ? {
          icon: I.coffee,
          title: 'Nothing needs a person right now',
          body: 'Every open item has been actioned or closed itself. New ones land here the moment a sweep finds one — a failed recording, an overdue receivable, an application waiting on review.',
          cta: 'See capture health',
          go: 'health',
        }
      : {
          icon: I.film,
          title: 'No consultations recorded yet',
          body: 'Recording starts when the first Balo Video consultation goes in progress. Each one lands here with its recording, transcription and recap state, and anything that needs a hand raises an item on Home.',
          cta: 'Back to Home',
          go: 'home',
        };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <PageHeader title={m.title} sub={m.sub} />
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
          <copy.icon size={25} color={c.primary} />
        </div>
        <h3 style={{ fontSize: 18, fontWeight: 750, color: c.text, margin: 0 }}>{copy.title}</h3>
        <p
          style={{
            fontSize: 13.5,
            color: c.textSecondary,
            margin: '10px auto 0',
            maxWidth: 440,
            lineHeight: 1.65,
          }}
        >
          {copy.body}
        </p>
        <div style={{ marginTop: 20 }}>
          <Btn variant="primary" icon={I.arrowRight} onClick={() => onGo(copy.go)}>
            {copy.cta}
          </Btn>
        </div>
      </Card>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// SHELL — a stand-in for the ADR-1053 member shell. The decision drawn here
// is only WHERE the "Balo admin" group sits and WHO sees it (D6).
// ══════════════════════════════════════════════════════════════════
const MEMBER_NAV = [
  ['dash', 'Home', I.home],
  ['cases', 'Cases', I.activity],
  ['projects', 'Projects', I.briefcase],
  ['messages', 'Messages', I.message],
  ['settings', 'Settings', I.sliders],
];
const ADMIN_NAV = [
  ['home', 'Home', I.inbox],
  ['lookup', 'Lookup', I.search],
  ['health', 'Health', I.activity],
  ['catalogue', 'Config & catalogue', I.layers],
];

function NavItem({ icon: NI, label, active, onClick, badge }) {
  const [h, setH] = useState(false);
  return (
    <button
      className="balo-focus"
      onClick={onClick}
      onMouseEnter={() => setH(true)}
      onMouseLeave={() => setH(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        width: '100%',
        padding: '8px 10px',
        borderRadius: 9,
        border: 'none',
        cursor: 'pointer',
        background: active ? c.primaryLight : h ? c.surfaceSubtle : 'transparent',
        color: active ? c.primary : c.textSecondary,
        fontSize: 13,
        fontWeight: active ? 650 : 500,
        textAlign: 'left',
      }}
    >
      <NI size={15} color={active ? c.primary : c.textTertiary} />
      <span style={{ flex: 1 }}>{label}</span>
      {badge > 0 && (
        <span
          style={{
            fontSize: 11,
            fontWeight: 700,
            color: c.error,
            background: c.errorLight,
            borderRadius: 10,
            padding: '1px 7px',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {badge}
        </span>
      )}
    </button>
  );
}

function Sidebar({ persona, view, setView, openCount, adminActive }) {
  const staff = isStaff(persona);
  return (
    <aside
      style={{
        width: 232,
        flexShrink: 0,
        background: c.surface,
        borderRight: `1px solid ${c.border}`,
        display: 'flex',
        flexDirection: 'column',
        minHeight: '100%',
      }}
    >
      <div style={{ padding: '16px 14px 10px' }}>
        <button
          className="balo-focus"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            width: '100%',
            padding: '9px 10px',
            borderRadius: 11,
            border: `1px solid ${c.border}`,
            background: c.surface,
            cursor: 'pointer',
            textAlign: 'left',
          }}
        >
          <div
            style={{
              width: 28,
              height: 28,
              borderRadius: 8,
              background: c.gradient,
              color: 'white',
              fontSize: 12,
              fontWeight: 800,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            {persona.workspace[0]}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <p
              style={{
                fontSize: 13,
                fontWeight: 700,
                color: c.text,
                margin: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {persona.workspace}
            </p>
            <p style={{ fontSize: 11, color: c.textTertiary, margin: 0 }}>Client workspace</p>
          </div>
          <I.chevDown size={14} color={c.textTertiary} />
        </button>
      </div>
      <nav style={{ padding: '4px 10px', display: 'flex', flexDirection: 'column', gap: 2 }}>
        {MEMBER_NAV.map(([key, label, NI]) => (
          <NavItem
            key={key}
            icon={NI}
            label={label}
            active={!adminActive && key === 'dash'}
            onClick={() => setView(null)}
          />
        ))}
      </nav>
      {staff && (
        <div style={{ padding: '14px 10px 4px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '0 10px 8px' }}>
            <I.shield size={12} color={c.accent} />
            <span
              style={{
                fontSize: 11,
                fontWeight: 700,
                color: c.accent,
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
              }}
            >
              Balo admin
            </span>
          </div>
          <nav style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {ADMIN_NAV.map(([key, label, NI]) => (
              <NavItem
                key={key}
                icon={NI}
                label={label}
                active={adminActive && view === key}
                onClick={() => setView(key)}
                badge={key === 'home' ? openCount : 0}
              />
            ))}
          </nav>
        </div>
      )}
      <div
        style={{
          marginTop: 'auto',
          padding: 14,
          borderTop: `1px solid ${c.borderSubtle}`,
          display: 'flex',
          alignItems: 'center',
          gap: 10,
        }}
      >
        <div
          style={{
            width: 30,
            height: 30,
            borderRadius: '50%',
            background: c.surfaceSubtle,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 12,
            fontWeight: 700,
            color: c.textSecondary,
          }}
        >
          {persona.name[0]}
        </div>
        <div style={{ minWidth: 0 }}>
          <p style={{ fontSize: 12.5, fontWeight: 650, color: c.text, margin: 0 }}>
            {persona.name}
          </p>
          <p style={{ fontSize: 11, color: c.textTertiary, margin: 0 }}>{persona.roleLabel}</p>
        </div>
      </div>
    </aside>
  );
}

// The member dashboard stand-in — what a non-staff member (or a staff member
// on the member Home tab) sees. Not designed here.
function MemberHomeStandIn({ persona }) {
  const staff = isStaff(persona);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <PageHeader title="Home" sub={`${persona.workspace} — member dashboard`} />
      <Card style={{ padding: '40px 28px', textAlign: 'center', ...slideUp(0.05) }}>
        <div
          style={{
            width: 54,
            height: 54,
            borderRadius: 15,
            background: c.surfaceSubtle,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            margin: '0 auto 15px',
          }}
        >
          <I.home size={23} color={c.textSecondary} />
        </div>
        <h3 style={{ fontSize: 17, fontWeight: 750, color: c.text, margin: 0 }}>
          Member dashboard
        </h3>
        <p
          style={{
            fontSize: 13,
            color: c.textSecondary,
            margin: '8px auto 0',
            maxWidth: 420,
            lineHeight: 1.6,
          }}
        >
          {staff
            ? 'Stand-in for the ADR-1053 shell. A staff member is still a member of their own workspace — admin is a nav group they gain, not a workspace they switch to.'
            : 'Stand-in for the ADR-1053 shell. For a client member there is no admin group in the nav, and /admin redirects to /dashboard before any page code runs.'}
        </p>
      </Card>
    </div>
  );
}

// Mobile: bottom tabs + the More sheet (ADR-1053). Admin is reached from More.
function BottomTabs({ active, onPick }) {
  const tabs = [
    ['dash', 'Home', I.home],
    ['cases', 'Cases', I.activity],
    ['projects', 'Projects', I.briefcase],
    ['messages', 'Messages', I.message],
    ['more', 'More', I.more],
  ];
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(5, 1fr)',
        borderTop: `1px solid ${c.border}`,
        background: c.surface,
        padding: '6px 4px 10px',
      }}
    >
      {tabs.map(([key, label, TI]) => {
        const on = active === key;
        return (
          <button
            key={key}
            className="balo-focus"
            onClick={() => onPick(key)}
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 3,
              padding: '6px 2px',
              border: 'none',
              background: 'transparent',
              cursor: 'pointer',
              color: on ? c.primary : c.textTertiary,
              fontSize: 10.5,
              fontWeight: on ? 700 : 500,
            }}
          >
            <TI size={19} color={on ? c.primary : c.textTertiary} />
            {label}
          </button>
        );
      })}
    </div>
  );
}
function MoreSheet({ persona, onClose, onAdmin }) {
  const staff = isStaff(persona);
  const rows = [
    ['Settings', I.sliders, null],
    ['Help & support', I.message, null],
    ...(staff ? [['Balo admin', I.shield, onAdmin]] : []),
  ];
  return (
    <div
      onClick={onClose}
      style={{
        position: 'absolute',
        inset: 0,
        background: 'rgba(17,24,39,0.4)',
        display: 'flex',
        alignItems: 'flex-end',
        zIndex: 20,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%',
          background: c.surface,
          borderRadius: '18px 18px 0 0',
          padding: '10px 12px 22px',
          ...slideUp(0),
        }}
      >
        <div
          style={{
            width: 36,
            height: 4,
            borderRadius: 2,
            background: c.border,
            margin: '0 auto 12px',
          }}
        />
        {rows.map(([label, RI, go]) => (
          <button
            key={label}
            className="balo-focus"
            onClick={go || onClose}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              width: '100%',
              padding: '12px 10px',
              borderRadius: 10,
              border: 'none',
              background: 'transparent',
              cursor: 'pointer',
              textAlign: 'left',
              fontSize: 14,
              fontWeight: 600,
              color: label === 'Balo admin' ? c.accent : c.text,
            }}
          >
            <RI size={17} color={label === 'Balo admin' ? c.accent : c.textSecondary} />
            <span style={{ flex: 1 }}>{label}</span>
            <I.chevRight size={15} color={c.textTertiary} />
          </button>
        ))}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// CONTROL BAR + FRAME (prototype scaffolding — not part of the product)
// ══════════════════════════════════════════════════════════════════
const STATES = [
  { key: 'loaded', label: 'Loaded' },
  { key: 'loading', label: 'Loading' },
  { key: 'error', label: 'Error' },
  { key: 'empty', label: 'Empty' },
];
function Seg({ items, value, onPick }) {
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
      {items.map((it) => {
        const on = value === it.key;
        return (
          <button
            key={String(it.key)}
            className="balo-focus"
            onClick={() => onPick(it.key)}
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
}
const CtlLabel = ({ children }) => (
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
function ControlBar({ state, setState, personaKey, setPersonaKey, mobile, setMobile }) {
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
          maxWidth: 1240,
          margin: '0 auto',
          display: 'flex',
          alignItems: 'center',
          gap: 18,
          flexWrap: 'wrap',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <CtlLabel>State</CtlLabel>
          <div className="balo-xscroll" style={{ display: 'flex' }}>
            <Seg items={STATES} value={state} onPick={setState} />
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <CtlLabel>Viewer</CtlLabel>
          <Seg
            items={PERSONAS.map((p) => ({
              key: p.key,
              label: `${p.name.split(' ')[0]} · ${p.roleLabel}`,
            }))}
            value={personaKey}
            onPick={setPersonaKey}
          />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 'auto' }}>
          <CtlLabel>View</CtlLabel>
          <Seg
            items={[
              { key: false, label: 'Desktop' },
              { key: true, label: 'Mobile' },
            ]}
            value={mobile}
            onPick={setMobile}
          />
        </div>
      </div>
    </div>
  );
}

export default function BaloAdminHome() {
  const [state, setState] = useState('loaded');
  const [personaKey, setPersonaKey] = useState('yomi');
  const [mobile, setMobile] = useState(false);
  const [view, setView] = useState('home'); // null = member dashboard
  const [alerts, setAlerts] = useState(ALERTS);
  const [health, setHealth] = useState(HEALTH);
  const [highlight, setHighlight] = useState(null);
  const [redrive, setRedrive] = useState(null);
  const [toast, setToast] = useState(null);
  const [mobileTab, setMobileTab] = useState('dash');
  const [moreOpen, setMoreOpen] = useState(false);

  const persona = PERSONAS.find((p) => p.key === personaKey);
  const staff = isStaff(persona);
  const adminActive = staff && view !== null;

  const say = (msg) => {
    setToast(msg);
    setTimeout(() => setToast((t) => (t === msg ? null : t)), 3600);
  };
  const go = (v) => {
    setView(v);
    if (v !== 'health') setHighlight(null);
  };
  const openAlert = (a) => {
    if (a.target.view === 'health') {
      setHighlight(a.target.rowId);
      setView('health');
      return;
    }
    say(`Opens ${a.target.href}`);
  };
  const closeAlert = (a, note) => {
    setAlerts((prev) => prev.filter((x) => x.id !== a.id));
    say(
      `Closed by ${persona.name} @ Balo, just now — “${note.trim().slice(0, 48)}${note.trim().length > 48 ? '…' : ''}”`
    );
  };
  const confirmRedrive = () => {
    const rd = REDRIVE[redrive.action];
    setHealth((prev) =>
      prev.map((r) => (r.id === redrive.id ? { ...r, ...rd.after, action: null } : r))
    );
    setRedrive(null);
    say(rd.toast);
  };

  // The admin panel for the current view + data state. Panel switches are
  // instant — no tab-level layout animation (ADR-1053 motion spec).
  let panel;
  if (!staff || view === null) panel = <MemberHomeStandIn persona={persona} />;
  else if (state === 'loading') panel = <LoadingPanel view={view} mobile={mobile} />;
  else if (state === 'error') panel = <ErrorPanel view={view} />;
  else if (state === 'empty')
    panel = <EmptyPanel view={view} onGo={go} mobile={mobile} persona={persona} />;
  else if (view === 'home')
    panel = (
      <HomePanel
        persona={persona}
        alerts={alerts}
        onOpen={openAlert}
        onClose={closeAlert}
        mobile={mobile}
      />
    );
  else if (view === 'health')
    panel = (
      <HealthPanel
        persona={persona}
        rows={health}
        highlightId={highlight}
        onRedrive={setRedrive}
        mobile={mobile}
      />
    );
  else if (view === 'lookup')
    panel = <LookupPanel persona={persona} mobile={mobile} onToast={say} />;
  else panel = <CataloguePanel persona={persona} onToast={say} />;

  const toastEl = toast && (
    <div
      style={{
        position: 'fixed',
        left: '50%',
        bottom: 28,
        transform: 'translateX(-50%)',
        background: c.text,
        color: 'white',
        padding: '10px 16px',
        borderRadius: 12,
        fontSize: 13,
        fontWeight: 600,
        boxShadow: '0 10px 30px rgba(0,0,0,0.25)',
        zIndex: 70,
        maxWidth: 'calc(100% - 32px)',
        animation: 'toastIn 0.25s ease-out both',
      }}
    >
      {toast}
    </div>
  );

  const desktop = (
    <div style={{ maxWidth: 1240, margin: '0 auto', padding: '24px 28px 80px' }}>
      <div
        style={{
          display: 'flex',
          minHeight: 720,
          borderRadius: 18,
          border: `1px solid ${c.border}`,
          background: c.bg,
          overflow: 'hidden',
          boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
        }}
      >
        <Sidebar
          persona={persona}
          view={view}
          setView={go}
          openCount={alerts.length}
          adminActive={adminActive}
        />
        <main style={{ flex: 1, minWidth: 0, padding: '26px 30px 40px' }}>
          <div style={{ maxWidth: 940 }}>{panel}</div>
        </main>
      </div>
    </div>
  );

  const mobileAdmin = staff && mobileTab === 'admin';
  const phone = (
    <div style={{ padding: '24px 16px' }}>
      <div
        style={{
          width: 390,
          maxWidth: '100%',
          height: 780,
          margin: '0 auto',
          background: c.bg,
          borderRadius: 36,
          border: '10px solid #0F1729',
          boxShadow: '0 20px 60px rgba(0,0,0,0.25)',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          position: 'relative',
        }}
      >
        <div style={{ height: 26, background: '#0F1729', flexShrink: 0 }} />
        {mobileAdmin ? (
          <div
            style={{ background: c.surface, borderBottom: `1px solid ${c.border}`, flexShrink: 0 }}
          >
            <div
              style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px 6px' }}
            >
              <button
                className="balo-focus"
                onClick={() => setMobileTab('dash')}
                style={{
                  border: 'none',
                  background: 'transparent',
                  cursor: 'pointer',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 2,
                  color: c.primary,
                  fontSize: 13,
                  fontWeight: 600,
                  padding: 0,
                }}
              >
                <I.chevLeft size={16} color={c.primary} />
                Dashboard
              </button>
              <span
                style={{
                  marginLeft: 'auto',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  fontSize: 12,
                  fontWeight: 700,
                  color: c.accent,
                }}
              >
                <I.shield size={13} color={c.accent} />
                Balo admin
              </span>
            </div>
            <div
              className="balo-xscroll"
              style={{ display: 'flex', gap: 6, padding: '4px 12px 10px' }}
            >
              {ADMIN_NAV.map(([key, label]) => {
                const on = view === key;
                return (
                  <button
                    key={key}
                    className="balo-focus"
                    onClick={() => go(key)}
                    style={{
                      padding: '6px 12px',
                      borderRadius: 20,
                      border: `1px solid ${on ? c.primaryBorder : c.border}`,
                      background: on ? c.primaryLight : c.surface,
                      color: on ? c.primary : c.textSecondary,
                      fontSize: 12.5,
                      fontWeight: on ? 650 : 500,
                      cursor: 'pointer',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}
        <div style={{ flex: 1, overflowY: 'auto', padding: '16px 14px 28px' }}>
          {mobileAdmin ? panel : <MemberHomeStandIn persona={persona} />}
        </div>
        <BottomTabs
          active={mobileAdmin ? 'more' : mobileTab}
          onPick={(k) => {
            if (k === 'more') setMoreOpen(true);
            else setMobileTab(k);
          }}
        />
        {redrive && (
          <RedriveSheet
            row={redrive}
            persona={persona}
            onCancel={() => setRedrive(null)}
            onConfirm={confirmRedrive}
            inset
          />
        )}
        {moreOpen && (
          <MoreSheet
            persona={persona}
            onClose={() => setMoreOpen(false)}
            onAdmin={() => {
              setMoreOpen(false);
              setMobileTab('admin');
              if (view === null) setView('home');
            }}
          />
        )}
      </div>
    </div>
  );

  return (
    <div
      style={{
        minHeight: '100vh',
        background: c.bg,
        fontFamily: "'Geist', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      }}
    >
      <style>{keyframes}</style>
      <link
        href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700;800&display=swap"
        rel="stylesheet"
      />
      <ControlBar
        state={state}
        setState={setState}
        personaKey={personaKey}
        setPersonaKey={setPersonaKey}
        mobile={mobile}
        setMobile={setMobile}
      />
      {mobile ? phone : desktop}
      {redrive && !mobile && (
        <RedriveSheet
          row={redrive}
          persona={persona}
          onCancel={() => setRedrive(null)}
          onConfirm={confirmRedrive}
        />
      )}
      {toastEl}
    </div>
  );
}
