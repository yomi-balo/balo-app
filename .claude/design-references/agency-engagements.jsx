import { useEffect, useRef, useState } from 'react';

// ══════════════════════════════════════════════════════════════════
// BAL-631 — Agency lens on /projects
//
// Agency owners and admins (the MANAGE_ENGAGEMENT holder set) can already open
// their agency's engagements and run delivery there (BAL-626, ADR-1046). This is
// how they FIND them: a fourth lens on the Projects page, beside Client, Expert
// and Admin.
//
// Decisions (2026-10-29):
//   - A lens on /projects. Not a filter on the Expert lens (an owner who doesn't
//     deliver has no Expert lens) and not the dashboard track (BAL-602 answers
//     "whose move is it on YOUR projects").
//   - No notifications to agency owners or admins in v1.
//
// The lens is oversight, not an inbox: nothing on it is "Needs you", and the
// delivering expert's own Your move is unchanged. What's new on every row is WHO
// is delivering it.
//
// Scenarios (control bar): owner who also delivers, admin who doesn't deliver,
// agency member with role expert (no Agency lens), small or large agency,
// empty, mobile.
// The Build notes at the bottom are the spec for data, lens plumbing, analytics.
// ══════════════════════════════════════════════════════════════════

const c = {
  bg: '#F8FAFB',
  surface: '#FFFFFF',
  surfaceSubtle: '#F1F4F8',
  border: '#E0E4EB',
  borderSubtle: '#EAEFF5',
  text: '#111827',
  textSecondary: '#4B5563',
  textTertiary: '#6B7280',
  primary: '#2563EB',
  primaryText: '#1D4ED8',
  primaryLight: '#EFF6FF',
  primaryBorder: '#BFDBFE',
  accent: '#7C3AED',
  warning: '#D97706',
  warningText: '#B45309',
  warningLight: '#FFFBEB',
  warningBorder: '#FDE68A',
  success: '#059669',
  successText: '#047857',
  successLight: '#ECFDF5',
  successBorder: '#A7F3D0',
  cyan: '#0891B2',
  cyanText: '#0E7490',
  cyanLight: '#ECFEFF',
  cyanBorder: '#A5F3FC',
};

const FONT = "'Geist', ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
const MONO = "'Geist Mono', ui-monospace, SFMono-Regular, Menlo, monospace";

const css = `
@keyframes aeFade { from { opacity: 0; } to { opacity: 1; } }
.ae-focus:focus-visible { outline: 2px solid ${c.primary}; outline-offset: 2px; }
.ae-row { transition: background 0.15s; }
.ae-row:hover { background: ${c.surfaceSubtle}99; }
@media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
`;

// ── Icons (lucide shapes; the app uses lucide-react) ─────────────
const Svg = ({ size = 16, color = 'currentColor', style, children }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke={color}
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    style={style}
    aria-hidden="true"
    focusable="false"
  >
    {children}
  </svg>
);
const I = {
  user: (p) => (
    <Svg {...p}>
      <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </Svg>
  ),
  shield: (p) => (
    <Svg {...p}>
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </Svg>
  ),
  users: (p) => (
    <Svg {...p}>
      <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75" />
    </Svg>
  ),
  building: (p) => (
    <Svg {...p}>
      <rect x="4" y="2" width="16" height="20" rx="2" />
      <path d="M9 22v-4h6v4M8 6h.01M12 6h.01M16 6h.01M8 10h.01M12 10h.01M16 10h.01M8 14h.01M12 14h.01M16 14h.01" />
    </Svg>
  ),
  chevRight: (p) => (
    <Svg {...p}>
      <path d="M9 18l6-6-6-6" />
    </Svg>
  ),
  chevDown: (p) => (
    <Svg {...p}>
      <path d="M6 9l6 6 6-6" />
    </Svg>
  ),
  clock: (p) => (
    <Svg {...p}>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 6v6l4 2" />
    </Svg>
  ),
  alert: (p) => (
    <Svg {...p}>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 8v4M12 16h.01" />
    </Svg>
  ),
  activity: (p) => (
    <Svg {...p}>
      <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
    </Svg>
  ),
  briefcase: (p) => (
    <Svg {...p}>
      <rect x="2" y="7" width="20" height="14" rx="2" />
      <path d="M16 21V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v16" />
    </Svg>
  ),
  check: (p) => (
    <Svg {...p}>
      <path d="M20 6L9 17l-5-5" />
    </Svg>
  ),
  message: (p) => (
    <Svg {...p}>
      <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
    </Svg>
  ),
};

// ── Lens meta (mirrors lens-switch.tsx LENS_META, plus Agency) ───
const LENS_META = {
  client: { label: 'Client', icon: I.user, tone: c.primary },
  expert: { label: 'Expert', icon: I.shield, tone: c.accent },
  admin: { label: 'Admin', icon: I.users, tone: c.cyan },
  agency: { label: 'Agency', icon: I.building, tone: c.success },
};

// ── Delivery state chips — keyed on deliveryState, never nudgeLabel ──
const DELIVERY = {
  changes_requested: { label: 'Changes requested', color: c.warningText, bg: c.warningLight },
  pending_acceptance: { label: 'Awaiting client review', color: c.cyanText, bg: c.cyanLight },
  in_delivery: { label: 'In delivery', color: c.primaryText, bg: c.primaryLight },
  completed: { label: 'Completed', color: c.successText, bg: c.successLight },
  cancelled: { label: 'Cancelled', color: c.textSecondary, bg: c.surfaceSubtle },
};

// ── Scenario data ────────────────────────────────────────────────
const AGENCY = { name: 'Cloudline Partners' };

const PEOPLE = {
  jordan: { name: 'Jordan Reyes', initials: 'JR', hue: '#2563EB' },
  priya: { name: 'Priya Shah', initials: 'PS', hue: '#7C3AED' },
  marcus: { name: 'Marcus Lee', initials: 'ML', hue: '#0E7490' },
  aisha: { name: 'Aisha Bello', initials: 'AB', hue: '#B45309' },
  // Large agency only
  tomas: { name: 'Tomás Novak', initials: 'TN', hue: '#047857' },
  mei: { name: 'Mei Tanaka', initials: 'MT', hue: '#BE185D' },
  oliver: { name: 'Oliver Grant', initials: 'OG', hue: '#4338CA' },
  fatima: { name: 'Fatima Rahman', initials: 'FR', hue: '#0F766E' },
  liam: { name: "Liam O'Connor", initials: 'LO', hue: '#9333EA' },
  sofia: { name: 'Sofia Marquez', initials: 'SM', hue: '#C2410C' },
  daniel: { name: 'Daniel Kim', initials: 'DK', hue: '#1D4ED8' },
  hannah: { name: 'Hannah Clarke-Whitfield', initials: 'HC', hue: '#0E7490' },
  ravi: { name: 'Ravi Menon', initials: 'RM', hue: '#7C2D12' },
  chloe: { name: 'Chloe Dubois', initials: 'CD', hue: '#6D28D9' },
};

// Live engagements, already ranked: changes requested, awaiting client review,
// in delivery; most recent activity first within each.
const LIVE = [
  {
    id: 'e1',
    title: 'CPQ implementation to replace legacy quoting tool',
    client: 'Northwind Industrial',
    expert: 'priya',
    state: 'changes_requested',
    progress: '3 of 5 milestones',
    updated: '2 hours ago',
    note: "The bundle pricing rules don't cover the multi-year discount we agreed. Can you add it before we sign off milestone 3?",
  },
  {
    id: 'e2',
    title: 'Service Cloud migration from Zendesk',
    client: 'Harbour Health',
    expert: 'marcus',
    state: 'pending_acceptance',
    autoAccept: '4 Nov',
    updated: '1 day ago',
  },
  {
    id: 'e3',
    title: 'Experience Cloud patient portal',
    client: 'Harbour Health',
    expert: 'aisha',
    state: 'in_delivery',
    progress: '2 of 6 milestones',
    updated: '1 day ago',
  },
  {
    id: 'e4',
    title: 'Sales Cloud health check for FY26',
    client: 'Vector Logistics',
    expert: 'jordan',
    state: 'in_delivery',
    progress: '1 of 3 milestones',
    updated: '3 days ago',
  },
  {
    id: 'e5',
    title: 'Revenue Cloud billing setup',
    client: 'Bright Foods',
    expert: 'priya',
    state: 'in_delivery',
    progress: null,
    updated: '4 days ago',
  },
  {
    id: 'e6',
    title: 'Marketing Cloud journey rebuild',
    client: 'Pacific Retail Group',
    expert: 'marcus',
    state: 'in_delivery',
    progress: '0 of 4 milestones',
    updated: '5 days ago',
  },
];

const FINISHED = [
  {
    id: 'e7',
    title: 'Org merge after acquisition',
    client: 'Crestline Insurance',
    expert: 'aisha',
    state: 'completed',
    updated: '3 weeks ago',
  },
  {
    id: 'e8',
    title: 'Einstein Analytics dashboard build',
    client: 'Crestline Insurance',
    expert: 'priya',
    state: 'cancelled',
    updated: '2 months ago',
  },
];

// Large agency (14 experts): the same rows plus ten more experts, re-ranked.
const EXTRA_LIVE = [
  {
    id: 'x1',
    title: 'Data Cloud identity resolution',
    client: 'Lumen Telecom',
    expert: 'mei',
    state: 'changes_requested',
    progress: '1 of 3 milestones',
    updated: '5 hours ago',
    note: 'Can the match rules treat household accounts separately? Our call centre needs that view.',
  },
  {
    id: 'x2',
    title: 'Agentforce service agent pilot',
    client: 'Atlas Insurance',
    expert: 'fatima',
    state: 'pending_acceptance',
    autoAccept: '6 Nov',
    updated: '2 days ago',
  },
  {
    id: 'x3',
    title: 'Commerce Cloud B2B storefront',
    client: 'Kestrel Tools',
    expert: 'sofia',
    state: 'in_delivery',
    progress: '3 of 6 milestones',
    updated: '2 days ago',
  },
  {
    id: 'x4',
    title: 'Sales ops dashboards in CRM Analytics',
    client: 'Northwind Industrial',
    expert: 'daniel',
    state: 'in_delivery',
    progress: null,
    updated: '3 days ago',
  },
  {
    id: 'x5',
    title: 'Health Cloud care plans',
    client: 'Harbour Health',
    expert: 'hannah',
    state: 'in_delivery',
    progress: '0 of 3 milestones',
    updated: '4 days ago',
  },
  {
    id: 'x6',
    title: 'Sales Cloud territory model',
    client: 'Vector Logistics',
    expert: 'ravi',
    state: 'in_delivery',
    progress: '2 of 4 milestones',
    updated: '5 days ago',
  },
  {
    id: 'x7',
    title: 'Field Service rollout for technicians',
    client: 'Southgate Utilities',
    expert: 'tomas',
    state: 'in_delivery',
    progress: '2 of 5 milestones',
    updated: '6 days ago',
  },
  {
    id: 'x8',
    title: 'Nonprofit Cloud donor migration',
    client: 'Riverbend Foundation',
    expert: 'oliver',
    state: 'in_delivery',
    progress: '4 of 7 milestones',
    updated: '1 week ago',
  },
  {
    id: 'x9',
    title: 'Salesforce Shield rollout',
    client: 'Meridian Bank',
    expert: 'liam',
    state: 'in_delivery',
    progress: '1 of 2 milestones',
    updated: '1 week ago',
  },
  {
    id: 'x10',
    title: 'Account Engagement cleanup',
    client: 'Bright Foods',
    expert: 'chloe',
    state: 'in_delivery',
    progress: '1 of 2 milestones',
    updated: '1 week ago',
  },
  {
    id: 'x11',
    title: 'Scheduling optimisation, phase 2',
    client: 'Southgate Utilities',
    expert: 'tomas',
    state: 'in_delivery',
    progress: '0 of 3 milestones',
    updated: '2 weeks ago',
  },
];

const STATE_RANK = { changes_requested: 0, pending_acceptance: 1, in_delivery: 2 };
// Prototype-only recency from the relative label; the loader sorts on real timestamps.
function hoursAgo(label) {
  const [n, unit] = label.split(' ');
  const k = Number(n);
  if (unit.startsWith('hour')) return k;
  if (unit.startsWith('day')) return k * 24;
  if (unit.startsWith('week')) return k * 168;
  return k * 720;
}
const ranked = (rows) =>
  [...rows].sort(
    (a, b) => STATE_RANK[a.state] - STATE_RANK[b.state] || hoursAgo(a.updated) - hoursAgo(b.updated)
  );

const DATA = {
  small: { live: LIVE, finished: FINISHED },
  large: { live: ranked([...LIVE, ...EXTRA_LIVE]), finished: FINISHED },
};

const VIEWERS = {
  owner: {
    key: 'owner',
    control: 'Owner who delivers',
    caption: 'Jordan Reyes, owner of Cloudline Partners, who also delivers projects',
    selfId: 'jordan',
    lenses: ['client', 'expert', 'agency'],
    startLens: 'agency',
  },
  admin: {
    key: 'admin',
    control: "Admin who doesn't deliver",
    caption: 'Elena Morris, admin of Cloudline Partners, with no expert profile',
    selfId: null,
    lenses: ['client', 'agency'],
    startLens: 'agency',
  },
  member: {
    key: 'member',
    control: 'Agency expert',
    caption: 'Aisha Bello, agency role expert at Cloudline Partners',
    selfId: 'aisha',
    lenses: ['client', 'expert'],
    startLens: 'expert',
  },
};

const SUBTITLE = {
  client: 'Your project requests, from idea to kickoff.',
  expert: 'Your invitations and active engagements.',
  agency: `Projects ${AGENCY.name} experts are delivering for clients.`,
};

const LIST_LABEL = {
  all: 'All live projects',
  changes_requested: 'Changes requested',
  in_delivery: 'In delivery',
  pending_acceptance: 'Awaiting client review',
};

// Desktop list columns: project | delivered by | status | updated | chevron
const GRID = 'minmax(0, 1fr) 172px 196px 88px 16px';

// ── Primitives ───────────────────────────────────────────────────
function SectionLabel({ children }) {
  return (
    <span
      style={{
        fontSize: 11.5,
        fontWeight: 600,
        color: c.textTertiary,
        textTransform: 'uppercase',
        letterSpacing: '0.06em',
      }}
    >
      {children}
    </span>
  );
}

function Count({ children }) {
  return (
    <span
      style={{
        fontSize: 11.5,
        fontWeight: 600,
        color: c.textSecondary,
        background: c.surfaceSubtle,
        borderRadius: 999,
        padding: '1px 8px',
        fontVariantNumeric: 'tabular-nums',
      }}
    >
      {children}
    </span>
  );
}

function StateChip({ state }) {
  const d = DELIVERY[state];
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        padding: '2px 9px',
        borderRadius: 999,
        fontSize: 11.5,
        fontWeight: 600,
        color: d.color,
        background: d.bg,
        whiteSpace: 'nowrap',
      }}
    >
      {d.label}
    </span>
  );
}

function Avatar({ id, size = 28 }) {
  const p = PEOPLE[id];
  return (
    <span
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        background: `${p.hue}1A`,
        color: p.hue,
        fontSize: Math.round(size * 0.38),
        fontWeight: 600,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
      }}
      aria-hidden="true"
    >
      {p.initials}
    </span>
  );
}

function GhostButton({ children, onClick }) {
  return (
    <button
      type="button"
      className="ae-focus"
      onClick={onClick}
      style={{
        fontFamily: 'inherit',
        fontSize: 13,
        fontWeight: 600,
        color: c.textSecondary,
        background: c.surface,
        border: `1px solid ${c.border}`,
        borderRadius: 10,
        padding: '8px 14px',
        cursor: 'pointer',
      }}
    >
      {children}
    </button>
  );
}

function Card({ children, style }) {
  return (
    <div
      style={{
        background: c.surface,
        border: `1px solid ${c.border}`,
        borderRadius: 16,
        overflow: 'hidden',
        ...style,
      }}
    >
      {children}
    </div>
  );
}

function PrototypeNote({ children }) {
  return (
    <div
      style={{
        border: `1px dashed ${c.border}`,
        borderRadius: 12,
        padding: '12px 14px',
        fontSize: 12.5,
        lineHeight: 1.55,
        color: c.textSecondary,
        background: 'transparent',
      }}
    >
      <strong style={{ fontWeight: 600, color: c.text }}>Prototype note. </strong>
      {children}
    </div>
  );
}

// ── Lens switch (same control as lens-switch.tsx, with Agency) ───
function LensSwitch({ lenses, lens, onChange }) {
  if (lenses.length <= 1) return null;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <SectionLabel>Lens</SectionLabel>
      <div
        role="tablist"
        aria-label="Portfolio lens"
        style={{
          display: 'inline-flex',
          gap: 3,
          padding: 3,
          borderRadius: 10,
          background: c.surfaceSubtle,
        }}
      >
        {lenses.map((key) => {
          const meta = LENS_META[key];
          const on = key === lens;
          return (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={on}
              className="ae-focus"
              onClick={() => onChange(key)}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                minHeight: 36,
                padding: '6px 12px',
                borderRadius: 7,
                border: 'none',
                cursor: 'pointer',
                fontFamily: 'inherit',
                fontSize: 13,
                fontWeight: on ? 600 : 500,
                background: on ? c.surface : 'transparent',
                color: on ? meta.tone : c.textTertiary,
                boxShadow: on ? '0 1px 2px rgba(0,0,0,0.06)' : 'none',
              }}
            >
              <meta.icon size={14} color={on ? meta.tone : c.textTertiary} />
              {meta.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── State tiles (filter the list, like the participant lenses) ───
function Tiles({ tiles, active, onPick, mobile }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: mobile ? '1fr 1fr' : 'repeat(4, 1fr)',
        gap: 10,
      }}
    >
      {tiles.map((t) => {
        const on = active === t.key;
        return (
          <button
            key={t.key}
            type="button"
            className="ae-focus"
            aria-pressed={on}
            onClick={() => onPick(on ? 'all' : t.key)}
            style={{
              textAlign: 'left',
              padding: '14px 16px',
              borderRadius: 14,
              cursor: 'pointer',
              fontFamily: 'inherit',
              border: `1px solid ${on ? t.border : c.border}`,
              background: on ? t.bgOn : c.surface,
              transition: 'background 0.15s, border-color 0.15s',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 8 }}>
              <t.icon size={13} color={t.color} />
              <SectionLabel>{t.label}</SectionLabel>
            </div>
            <p
              style={{
                fontSize: 26,
                fontWeight: 700,
                margin: 0,
                lineHeight: 1,
                color: t.emphasize && t.count > 0 ? t.color : c.text,
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {t.count}
            </p>
            <p style={{ fontSize: 11.5, color: c.textTertiary, margin: '5px 0 0' }}>{t.sub}</p>
          </button>
        );
      })}
    </div>
  );
}

// ── "Delivered by" dropdown — one control on desktop and mobile ──
// shadcn `Select` in the app. Trigger shows the current choice and its count;
// options are Everyone, You, then everyone else by name.
function PersonOption({ id, label, count, on, onPick }) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={on}
      className="ae-focus ae-row"
      onClick={() => onPick(id)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        width: '100%',
        padding: '8px 8px',
        border: 'none',
        borderRadius: 8,
        background: on ? c.primaryLight : 'transparent',
        cursor: 'pointer',
        fontFamily: 'inherit',
        textAlign: 'left',
        opacity: count === 0 && !on ? 0.6 : 1,
      }}
    >
      {id === 'all' ? (
        <span
          style={{
            width: 24,
            height: 24,
            borderRadius: '50%',
            background: c.surfaceSubtle,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
          }}
        >
          <I.users size={13} color={c.textSecondary} />
        </span>
      ) : (
        <Avatar id={id} size={24} />
      )}
      <span
        style={{
          flex: 1,
          minWidth: 0,
          fontSize: 13,
          fontWeight: on ? 600 : 500,
          color: on ? c.primaryText : c.text,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {label}
      </span>
      <span style={{ fontSize: 12, color: c.textTertiary, fontVariantNumeric: 'tabular-nums' }}>
        {count}
      </span>
      <span style={{ width: 14, display: 'inline-flex' }}>
        {on && <I.check size={14} color={c.primary} />}
      </span>
    </button>
  );
}

function PersonFilter({ people, active, onPick, total, mobile }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const pick = (id) => {
    onPick(id);
    setOpen(false);
  };
  const current = people.find((p) => p.id === active);

  return (
    <div ref={ref} style={{ position: 'relative', width: mobile ? '100%' : undefined }}>
      <button
        type="button"
        className="ae-focus"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Delivered by: ${current ? current.name : 'Everyone'}`}
        onClick={() => setOpen((v) => !v)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          width: mobile ? '100%' : undefined,
          maxWidth: mobile ? undefined : 320,
          minHeight: 36,
          padding: '5px 10px 5px 12px',
          border: `1px solid ${current ? c.primaryBorder : c.border}`,
          borderRadius: 10,
          background: current ? c.primaryLight : c.surface,
          fontFamily: 'inherit',
          fontSize: 13,
          cursor: 'pointer',
          textAlign: 'left',
        }}
      >
        <span style={{ color: c.textSecondary, whiteSpace: 'nowrap' }}>Delivered by</span>
        {current && <Avatar id={current.id} size={20} />}
        <span
          style={{
            fontWeight: 600,
            color: current ? c.primaryText : c.text,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            minWidth: 0,
          }}
        >
          {current ? current.name : 'Everyone'}
        </span>
        <span style={{ color: c.textTertiary, fontVariantNumeric: 'tabular-nums' }}>
          {current ? current.count : total}
        </span>
        <I.chevDown
          size={14}
          color={c.textTertiary}
          style={{
            marginLeft: mobile ? 'auto' : 2,
            flexShrink: 0,
            transform: open ? 'rotate(180deg)' : 'none',
            transition: 'transform 0.2s',
          }}
        />
      </button>

      {open && (
        <div
          role="listbox"
          aria-label="Delivered by"
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            ...(mobile ? { left: 0, right: 0 } : { right: 0, width: 280 }),
            zIndex: 20,
            maxHeight: 320,
            overflowY: 'auto',
            background: c.surface,
            border: `1px solid ${c.border}`,
            borderRadius: 12,
            boxShadow: '0 10px 30px rgba(15,23,41,0.12)',
            padding: 6,
            animation: 'aeFade 0.12s ease-out both',
          }}
        >
          <PersonOption
            id="all"
            label="Everyone"
            count={total}
            on={active === 'all'}
            onPick={pick}
          />
          {people.map((p) => (
            <PersonOption
              key={p.id}
              id={p.id}
              label={p.name}
              count={p.count}
              on={active === p.id}
              onPick={pick}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Rows ─────────────────────────────────────────────────────────
function detailFor(row) {
  if (row.state === 'pending_acceptance') return `Auto-accepts ${row.autoAccept}`;
  return row.progress ?? null;
}

function NoteLine({ note }) {
  return (
    <p
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        margin: '7px 0 0',
        fontSize: 12,
        color: c.textSecondary,
        minWidth: 0,
      }}
    >
      <I.message size={12} color={c.warning} style={{ flexShrink: 0 }} />
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        “{note}”
      </span>
    </p>
  );
}

function ListHeader() {
  const cell = (label, align = 'left') => (
    <span
      style={{
        fontSize: 11,
        fontWeight: 600,
        color: c.textTertiary,
        textTransform: 'uppercase',
        letterSpacing: '0.06em',
        textAlign: align,
      }}
    >
      {label}
    </span>
  );
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: GRID,
        gap: 16,
        padding: '10px 18px',
        borderBottom: `1px solid ${c.borderSubtle}`,
        background: `${c.surfaceSubtle}80`,
      }}
    >
      {cell('Project')}
      {cell('Delivered by')}
      {cell('Status')}
      {cell('Updated', 'right')}
      <span />
    </div>
  );
}

function AgencyRow({ row, viewer, mobile, last, finished }) {
  const isSelf = row.expert === viewer.selfId;
  const name = isSelf ? 'You' : PEOPLE[row.expert].name;
  const detail = finished ? null : detailFor(row);
  const label = `${row.title} for ${row.client}, delivered by ${isSelf ? 'you' : PEOPLE[row.expert].name}, ${DELIVERY[row.state].label}`;
  const base = {
    textDecoration: 'none',
    color: 'inherit',
    borderBottom: last ? 'none' : `1px solid ${c.borderSubtle}`,
    opacity: finished ? 0.75 : 1,
  };

  if (mobile) {
    return (
      <a
        href={`/engagements/${row.id}?from=agency`}
        onClick={(e) => e.preventDefault()}
        aria-label={label}
        className="ae-focus ae-row"
        style={{
          ...base,
          display: 'flex',
          alignItems: 'flex-start',
          gap: 12,
          padding: '14px 14px',
        }}
      >
        <Avatar id={row.expert} size={32} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{ fontSize: 14, fontWeight: 600, margin: 0, lineHeight: 1.35 }}>{row.title}</p>
          <p style={{ fontSize: 12, color: c.textTertiary, margin: '2px 0 0' }}>{row.client}</p>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              flexWrap: 'wrap',
              gap: 8,
              marginTop: 8,
            }}
          >
            <StateChip state={row.state} />
            {detail && (
              <span
                style={{
                  fontSize: 11.5,
                  color: c.textTertiary,
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                {detail}
              </span>
            )}
          </div>
          {row.note && !finished && <NoteLine note={row.note} />}
          <div style={{ display: 'flex', gap: 10, marginTop: 7, fontSize: 11.5 }}>
            <span style={{ color: c.textSecondary }}>{name}</span>
            <span style={{ color: c.textTertiary }}>{row.updated}</span>
          </div>
        </div>
        <I.chevRight size={16} color={c.textTertiary} style={{ flexShrink: 0, marginTop: 2 }} />
      </a>
    );
  }

  return (
    <a
      href={`/engagements/${row.id}?from=agency`}
      onClick={(e) => e.preventDefault()}
      aria-label={label}
      className="ae-focus ae-row"
      style={{
        ...base,
        display: 'grid',
        gridTemplateColumns: GRID,
        alignItems: 'center',
        gap: 16,
        padding: '14px 18px',
      }}
    >
      <div style={{ minWidth: 0 }}>
        <p
          style={{
            fontSize: 14,
            fontWeight: 600,
            margin: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {row.title}
        </p>
        <p style={{ fontSize: 12, color: c.textTertiary, margin: '3px 0 0' }}>{row.client}</p>
        {row.note && !finished && <NoteLine note={row.note} />}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
        <Avatar id={row.expert} size={26} />
        <span
          style={{
            fontSize: 13,
            color: isSelf ? c.textSecondary : c.text,
            fontWeight: isSelf ? 600 : 500,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {name}
        </span>
      </div>
      <div>
        <StateChip state={row.state} />
        {detail && (
          <p
            style={{
              fontSize: 11.5,
              color: c.textTertiary,
              margin: '5px 0 0',
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {detail}
          </p>
        )}
      </div>
      <span
        style={{ fontSize: 12, color: c.textTertiary, textAlign: 'right', whiteSpace: 'nowrap' }}
      >
        {row.updated}
      </span>
      <I.chevRight size={16} color={c.textTertiary} />
    </a>
  );
}

function FinishedGroup({ rows, viewer, mobile }) {
  const [open, setOpen] = useState(false);
  // Purely retrospective: renders nothing when there is nothing to show.
  if (rows.length === 0) return null;
  return (
    <Card>
      <button
        type="button"
        className="ae-focus"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          width: '100%',
          padding: '12px 16px',
          border: 'none',
          background: 'transparent',
          cursor: 'pointer',
          fontFamily: 'inherit',
          textAlign: 'left',
        }}
      >
        <I.chevDown
          size={14}
          color={c.textTertiary}
          style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }}
        />
        <SectionLabel>Completed and cancelled</SectionLabel>
        <Count>{rows.length}</Count>
      </button>
      {open && (
        <div style={{ borderTop: `1px solid ${c.borderSubtle}` }}>
          {rows.map((r, i) => (
            <AgencyRow
              key={r.id}
              row={r}
              viewer={viewer}
              mobile={mobile}
              last={i === rows.length - 1}
              finished
            />
          ))}
        </div>
      )}
    </Card>
  );
}

// ── Empty and no-match states ────────────────────────────────────
function AgencyEmpty() {
  return (
    <Card style={{ padding: '48px 28px', textAlign: 'center' }}>
      <div
        style={{
          width: 52,
          height: 52,
          borderRadius: 14,
          background: c.successLight,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          margin: '0 auto 16px',
        }}
      >
        <I.building size={22} color={c.success} />
      </div>
      <h3 style={{ fontSize: 17, fontWeight: 700, margin: 0 }}>No live projects yet</h3>
      <p
        style={{
          fontSize: 13.5,
          color: c.textSecondary,
          margin: '8px auto 0',
          maxWidth: 400,
          lineHeight: 1.6,
        }}
      >
        When a client kicks off a project with a {AGENCY.name} expert, it shows up here. You can
        open any of them and step in on delivery.
      </p>
    </Card>
  );
}

function NoMatch({ onReset }) {
  return (
    <Card style={{ padding: '32px 20px', textAlign: 'center' }}>
      <p style={{ fontSize: 13.5, fontWeight: 600, margin: 0 }}>
        No live projects match these filters.
      </p>
      <div style={{ marginTop: 12 }}>
        <GhostButton onClick={onReset}>Show all</GhostButton>
      </div>
    </Card>
  );
}

// ══════════════════════════════════════════════════════════════════
// AGENCY LENS BODY
// ══════════════════════════════════════════════════════════════════
function AgencyView({ viewer, empty, mobile, size }) {
  const [tile, setTile] = useState('all');
  const [who, setWho] = useState('all');
  if (empty) return <AgencyEmpty />;
  const { live: liveRows, finished: finishedRows } = DATA[size];

  const count = (state) => liveRows.filter((r) => r.state === state).length;
  const liveExpertCount = new Set(liveRows.map((r) => r.expert)).size;

  const tiles = [
    {
      key: 'changes_requested',
      label: 'Changes requested',
      count: count('changes_requested'),
      icon: I.alert,
      color: c.warning,
      bgOn: c.warningLight,
      border: c.warningBorder,
      emphasize: true,
      sub: "Your agency's move",
    },
    {
      key: 'in_delivery',
      label: 'In delivery',
      count: count('in_delivery'),
      icon: I.activity,
      color: c.primary,
      bgOn: c.primaryLight,
      border: c.primaryBorder,
      sub: 'Work underway',
    },
    {
      key: 'pending_acceptance',
      label: 'Awaiting review',
      count: count('pending_acceptance'),
      icon: I.clock,
      color: c.cyan,
      bgOn: c.cyanLight,
      border: c.cyanBorder,
      sub: 'With the client',
    },
    {
      key: 'all',
      label: 'Live',
      count: liveRows.length,
      icon: I.briefcase,
      color: c.textSecondary,
      bgOn: c.surfaceSubtle,
      border: c.border,
      sub: `Across ${liveExpertCount} ${liveExpertCount === 1 ? 'expert' : 'experts'}`,
    },
  ];

  const byTile = tile === 'all' ? liveRows : liveRows.filter((r) => r.state === tile);
  const rows = who === 'all' ? byTile : byTile.filter((r) => r.expert === who);
  const finished = who === 'all' ? finishedRows : finishedRows.filter((r) => r.expert === who);

  // People come from the loaded rows (no member read). Counts follow the active tile.
  // Order: You first, then everyone else by name.
  const people = [...new Set([...liveRows, ...finishedRows].map((r) => r.expert))]
    .map((id) => ({
      id,
      self: id === viewer.selfId,
      name: id === viewer.selfId ? 'You' : PEOPLE[id].name,
      count: byTile.filter((r) => r.expert === id).length,
    }))
    .sort((a, b) => Number(b.self) - Number(a.self) || a.name.localeCompare(b.name));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <Tiles tiles={tiles} active={tile} onPick={setTile} mobile={mobile} />

      <section aria-label={LIST_LABEL[tile]}>
        <div
          style={{
            display: 'flex',
            flexDirection: mobile ? 'column' : 'row',
            alignItems: mobile ? 'stretch' : 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: 10,
            marginBottom: 10,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <SectionLabel>{LIST_LABEL[tile]}</SectionLabel>
            <Count>{rows.length}</Count>
          </div>
          <PersonFilter
            people={people}
            active={who}
            onPick={setWho}
            total={byTile.length}
            mobile={mobile}
          />
        </div>

        {rows.length > 0 ? (
          <Card>
            {!mobile && <ListHeader />}
            {rows.map((r, i) => (
              <AgencyRow
                key={r.id}
                row={r}
                viewer={viewer}
                mobile={mobile}
                last={i === rows.length - 1}
              />
            ))}
          </Card>
        ) : (
          <NoMatch
            onReset={() => {
              setTile('all');
              setWho('all');
            }}
          />
        )}
      </section>

      <FinishedGroup rows={finished} viewer={viewer} mobile={mobile} />
    </div>
  );
}

// ── Stand-in for the unchanged lenses ────────────────────────────
function LensStub({ lens, viewer }) {
  const meta = LENS_META[lens];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <Card style={{ padding: '36px 24px', textAlign: 'center' }}>
        <meta.icon size={22} color={meta.tone} />
        <p style={{ fontSize: 14, fontWeight: 600, margin: '10px 0 0' }}>
          The existing {meta.label} lens
        </p>
        <p style={{ fontSize: 12.5, color: c.textTertiary, margin: '4px 0 0' }}>
          BAL-631 does not change it.
        </p>
      </Card>
      {viewer.key === 'member' && (
        <PrototypeNote>
          Aisha holds agency role expert, which is outside the holder set, so there is no Agency
          lens. Her own projects stay on the Expert lens, as today.
        </PrototypeNote>
      )}
      {viewer.key === 'owner' && lens === 'expert' && (
        <PrototypeNote>
          Jordan's own project (Sales Cloud health check) stays here, and also appears on the Agency
          lens, where it reads "You".
        </PrototypeNote>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// PAGE
// ══════════════════════════════════════════════════════════════════
function ProjectsPage({ viewer, lens, onLens, empty, mobile, size }) {
  return (
    <div
      key={`${viewer.key}-${lens}-${empty}-${size}`}
      style={{ animation: 'aeFade 0.25s ease-out both' }}
    >
      <header
        style={{
          display: 'flex',
          flexDirection: mobile ? 'column' : 'row',
          alignItems: mobile ? 'flex-start' : 'flex-end',
          justifyContent: 'space-between',
          gap: 14,
          marginBottom: 20,
        }}
      >
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0, letterSpacing: '-0.01em' }}>
            Projects
          </h1>
          <p style={{ fontSize: 13, color: c.textSecondary, margin: '4px 0 0' }}>
            {SUBTITLE[lens]}
          </p>
        </div>
        <LensSwitch lenses={viewer.lenses} lens={lens} onChange={onLens} />
      </header>
      {lens === 'agency' ? (
        <AgencyView viewer={viewer} empty={empty} mobile={mobile} size={size} />
      ) : (
        <LensStub lens={lens} viewer={viewer} />
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// BUILD NOTES — the spec beside the picture
// ══════════════════════════════════════════════════════════════════
const NOTES = [
  {
    h: 'Who sees it',
    p: [
      'Agency owners and admins only: the `MANAGE_ENGAGEMENT` holder set that can open these pages (BAL-626). Never agency role `expert`. This is the act-axis holder set on purpose; do not widen it to `actorHasExpertSideVisibility` (ADR-1046 §7 any-member visibility is out of scope).',
    ],
  },
  {
    h: 'Lens plumbing',
    p: [
      "`PortfolioLens` is an alias of `RequestLens` today. Agency is a view, never a per-request authorization lens, so split the type (`RequestLens | 'agency'`) rather than adding `agency` to `RequestLens`.",
      '`SessionUser` carries no agency membership, so the page resolves the viewer’s holder status (one lookup) and passes it into `resolvePortfolioLens`, which stays pure. A `?lens=agency` the viewer isn’t allowed falls back silently, as today. `LENS_META` gains Agency (`Building2`, emerald).',
      'Default lens: add one rule before the client fallback. A holder with no expert profile defaults to Agency (Elena: her Client lens is her personal workspace and usually empty). Everyone else keeps today’s default.',
    ],
  },
  {
    h: 'Data',
    p: [
      'New `loadAgencyPortfolio`: project engagements whose expert profile belongs to the viewer’s agency, all four statuses. Live ones (`in_delivery`, `changes_requested`, `pending_acceptance`) are the list; completed and cancelled go to the collapsed group, the way `closedRows` works. Each row is a `PortfolioRowView` engagement row plus the delivering expert (profile id, name, avatar) and the client company.',
      'Rows never set `needsYou` and show no unread dot. The lens is oversight; the delivering expert’s own Your move and Expert lens are unchanged. `deriveEngagementRow` returns needs-you with `moveKind: delivery_changes` for an expert-lens `changes_requested`, so give it an agency lens (or map after) rather than reusing the expert result.',
      'The change note is the same value the expert lens carries in `delivery.changeRequestNote`; the auto-accept date is the existing `autoAcceptLabel`. No money on any row, same as every portfolio row. Group and filter on `deliveryState`, never `nudgeLabel`.',
    ],
  },
  {
    h: 'Order',
    p: [
      'Changes requested, then awaiting client review, then in delivery; most recent activity first within each.',
    ],
  },
  {
    h: 'Filters',
    p: [
      'State tiles filter the list. “Delivered by” is derived from the loaded rows, so there is no member read and an expert with no projects isn’t listed. Tiles and the dropdown combine; counts follow the active tile; the dropdown also applies to the completed group.',
      '“Delivered by” is one dropdown on desktop and mobile: shadcn `Select`, already in `components/ui`. The trigger shows the current choice and its count. Options are Everyone, You (when the viewer delivers), then everyone else by name, each with avatar and project count, dimmed at zero. Long names truncate. `Select`’s type-ahead covers finding a name; if an agency grows past about 30 experts, swap the content for `Command` to get a search box.',
    ],
  },
  {
    h: 'Navigation',
    p: [
      'Rows link to `/engagements/{id}?from=agency`. Add `agency` to `resolveEntry`’s whitelist, and send the workspace back link to `/projects?lens=agency` when `from=agency` (today it always goes to `/projects`).',
    ],
  },
  {
    h: 'States',
    p: [
      'Empty (no engagements at all): the invitation card, with no button, because there is no agency management page to send owners to yet. No match: one line and Show all. Completed group: renders nothing when empty. Load failure: the page’s existing `error.tsx`.',
    ],
  },
  {
    h: 'Analytics',
    p: [
      '`ProjectsInboxLens` gains `agency`, so lens switched, filter applied and row clicked cover it (filter values gain the three state keys). One new event, `INBOX_EXPERT_FILTER_APPLIED { lens, is_self, result_count }`, no ids. `WORKSPACE_VIEWED`’s `entry` gains `agency`.',
    ],
  },
  {
    h: 'Notifications',
    p: [
      'None (decided 2026-10-29). The delivering expert is the actor on every delivery event; this lens is where owners and admins look.',
    ],
  },
  {
    h: 'Help',
    p: [
      'A short how-to for agency owners and admins: where the Agency lens is, and what they can do from an agency project.',
    ],
  },
  {
    h: 'Not in this',
    p: [
      'Pre-kickoff work (invitations, interest, proposals to agency experts); money; experts with no projects; the dashboard track (BAL-602); any-member visibility (ADR-1046 §7). Assumes one agency per owner or admin; if a user can hold that role in two agencies, the lens needs an agency picker.',
    ],
  },
];

function Rich({ text }) {
  return text.split('`').map((part, i) =>
    i % 2 === 1 ? (
      <code
        key={i}
        style={{
          fontFamily: MONO,
          fontSize: '0.9em',
          background: c.surfaceSubtle,
          padding: '1px 5px',
          borderRadius: 5,
        }}
      >
        {part}
      </code>
    ) : (
      <span key={i}>{part}</span>
    )
  );
}

function BuildNotes() {
  return (
    <section
      aria-label="Build notes"
      style={{ maxWidth: 1000, margin: '0 auto', padding: '8px 28px 80px' }}
    >
      <Card style={{ padding: '24px 28px' }}>
        <h2 style={{ fontSize: 16, fontWeight: 700, margin: 0 }}>Build notes</h2>
        <p style={{ fontSize: 13, color: c.textTertiary, margin: '4px 0 18px' }}>
          The spec for BAL-631. CC implements from this; it does not invent layout or copy.
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {NOTES.map((n) => (
            <div key={n.h}>
              <h3 style={{ fontSize: 13.5, fontWeight: 600, margin: '0 0 4px' }}>{n.h}</h3>
              {n.p.map((para, i) => (
                <p
                  key={i}
                  style={{
                    fontSize: 13,
                    lineHeight: 1.6,
                    color: c.textSecondary,
                    margin: i === 0 ? 0 : '6px 0 0',
                    maxWidth: 760,
                  }}
                >
                  <Rich text={para} />
                </p>
              ))}
            </div>
          ))}
        </div>
      </Card>
    </section>
  );
}

// ══════════════════════════════════════════════════════════════════
// CONTROL BAR + MAIN
// ══════════════════════════════════════════════════════════════════
function Segmented({ label, options, value, onChange }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <SectionLabel>{label}</SectionLabel>
      <div
        style={{
          display: 'inline-flex',
          gap: 3,
          padding: 3,
          borderRadius: 10,
          background: c.surfaceSubtle,
          flexWrap: 'wrap',
        }}
      >
        {options.map((o) => {
          const on = value === o.value;
          return (
            <button
              key={String(o.value)}
              type="button"
              className="ae-focus"
              aria-pressed={on}
              onClick={() => onChange(o.value)}
              style={{
                padding: '6px 12px',
                borderRadius: 7,
                border: 'none',
                cursor: 'pointer',
                fontFamily: 'inherit',
                fontSize: 12.5,
                fontWeight: on ? 600 : 500,
                background: on ? c.surface : 'transparent',
                color: on ? c.text : c.textTertiary,
                boxShadow: on ? '0 1px 2px rgba(0,0,0,0.06)' : 'none',
              }}
            >
              {o.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ControlBar({
  viewerKey,
  setViewerKey,
  size,
  setSize,
  empty,
  setEmpty,
  mobile,
  setMobile,
}) {
  return (
    <div
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 30,
        background: c.surface,
        borderBottom: `1px solid ${c.border}`,
        padding: '10px 24px',
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
        <Segmented
          label="Viewer"
          value={viewerKey}
          onChange={setViewerKey}
          options={Object.values(VIEWERS).map((v) => ({ value: v.key, label: v.control }))}
        />
        <Segmented
          label="Agency"
          value={size}
          onChange={setSize}
          options={[
            { value: 'small', label: '4 experts' },
            { value: 'large', label: '14 experts' },
          ]}
        />
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
        <Segmented
          label="View"
          value={mobile}
          onChange={setMobile}
          options={[
            { value: false, label: 'Desktop' },
            { value: true, label: 'Mobile' },
          ]}
        />
      </div>
    </div>
  );
}

export default function AgencyEngagementsReference() {
  const [viewerKey, setViewerKey] = useState('owner');
  const [size, setSize] = useState('small');
  const [empty, setEmpty] = useState(false);
  const [mobile, setMobile] = useState(false);
  const [chosenLens, setChosenLens] = useState({});
  const viewer = VIEWERS[viewerKey];
  const lens = chosenLens[viewerKey] ?? viewer.startLens;
  const setLens = (next) => setChosenLens((prev) => ({ ...prev, [viewerKey]: next }));

  const page = (
    <ProjectsPage
      viewer={viewer}
      lens={lens}
      onLens={setLens}
      empty={empty}
      mobile={mobile}
      size={size}
    />
  );

  return (
    <div style={{ minHeight: '100vh', background: c.bg, fontFamily: FONT, color: c.text }}>
      <style>{css}</style>
      <link
        href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500&display=swap"
        rel="stylesheet"
      />
      <ControlBar
        viewerKey={viewerKey}
        setViewerKey={setViewerKey}
        size={size}
        setSize={setSize}
        empty={empty}
        setEmpty={setEmpty}
        mobile={mobile}
        setMobile={setMobile}
      />
      <div style={{ maxWidth: 1000, margin: '0 auto', padding: '16px 28px 0' }}>
        <p style={{ fontSize: 12, color: c.textTertiary, margin: 0 }}>
          Viewing as {viewer.caption}.
        </p>
      </div>
      {mobile ? (
        <div style={{ padding: '20px 16px 32px' }}>
          <div
            style={{
              width: 390,
              maxWidth: '100%',
              minHeight: 760,
              margin: '0 auto',
              background: c.bg,
              borderRadius: 36,
              border: '10px solid #0F1729',
              overflow: 'hidden',
            }}
          >
            <div style={{ height: 26, background: '#0F1729' }} />
            <div style={{ padding: '18px 14px 28px', maxHeight: 760, overflowY: 'auto' }}>
              {page}
            </div>
          </div>
        </div>
      ) : (
        <div style={{ maxWidth: 1000, margin: '0 auto', padding: '16px 28px 40px' }}>{page}</div>
      )}
      <BuildNotes />
    </div>
  );
}
