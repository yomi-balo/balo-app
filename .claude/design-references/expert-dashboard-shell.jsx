import { useState, useEffect } from 'react';

// ── Design Tokens (shared across Balo) ───────────────────────────
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
  indigo: '#4F46E5',
  gradient: 'linear-gradient(135deg, #2563EB 0%, #7C3AED 100%)',
  gradientSubtle: 'linear-gradient(135deg, #EFF6FF 0%, #F5F3FF 100%)',
  gradientWarm: 'linear-gradient(135deg, #059669 0%, #0891B2 100%)',
};

const SECTION_COLORS = {
  primary: { text: '#2563EB', bg: 'rgba(37,99,235,0.1)' },
  violet: { text: '#7C3AED', bg: 'rgba(124,58,237,0.1)' },
  cyan: { text: '#0891B2', bg: 'rgba(8,145,178,0.1)' },
  amber: { text: '#D97706', bg: 'rgba(217,119,6,0.1)' },
  emerald: { text: '#059669', bg: 'rgba(5,150,105,0.1)' },
  pink: { text: '#DB2777', bg: 'rgba(219,39,119,0.1)' },
};

// ── Icons ────────────────────────────────────────────────────────
const Icon = ({ d, size = 16, color = 'currentColor', ...p }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke={color}
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    {...p}
  >
    <path d={d} />
  </svg>
);
const Icons = {
  check: (p) => <Icon {...p} d="M20 6L9 17l-5-5" />,
  home: (p) => (
    <svg
      width={p.size || 16}
      height={p.size || 16}
      viewBox="0 0 24 24"
      fill="none"
      stroke={p.color || 'currentColor'}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
      <polyline points="9 22 9 12 15 12 15 22" />
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
    >
      <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75" />
    </svg>
  ),
  dollarSign: (p) => <Icon {...p} d="M12 1v22M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6" />,
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
    >
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <path d="M16 2v4M8 2v4M3 10h18" />
    </svg>
  ),
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
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M12 6v6l4 2" />
    </svg>
  ),
  creditCard: (p) => (
    <svg
      width={p.size || 16}
      height={p.size || 16}
      viewBox="0 0 24 24"
      fill="none"
      stroke={p.color || 'currentColor'}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="1" y="4" width="22" height="16" rx="2" />
      <path d="M1 10h22" />
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
    >
      <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
    </svg>
  ),
  briefcase: (p) => (
    <Icon
      {...p}
      d="M20 7H4a2 2 0 00-2 2v10a2 2 0 002 2h16a2 2 0 002-2V9a2 2 0 00-2-2zM16 21V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v16"
    />
  ),
  settings: (p) => (
    <svg
      width={p.size || 16}
      height={p.size || 16}
      viewBox="0 0 24 24"
      fill="none"
      stroke={p.color || 'currentColor'}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z" />
    </svg>
  ),
  arrowRight: (p) => <Icon {...p} d="M5 12h14M12 5l7 7-7 7" />,
  arrowLeft: (p) => <Icon {...p} d="M19 12H5M12 19l-7-7 7-7" />,
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
    >
      <path d="M12 3v2m0 14v2m-7-9H3m18 0h-2m-1.636-6.364l-1.414 1.414M7.05 16.95l-1.414 1.414m0-12.728l1.414 1.414m9.9 9.9l1.414 1.414" />
      <circle cx="12" cy="12" r="4" />
    </svg>
  ),
  trendingUp: (p) => (
    <svg
      width={p.size || 16}
      height={p.size || 16}
      viewBox="0 0 24 24"
      fill="none"
      stroke={p.color || 'currentColor'}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="23 6 13.5 15.5 8.5 10.5 1 18" />
      <polyline points="17 6 23 6 23 12" />
    </svg>
  ),
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
    >
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
    </svg>
  ),
  shield: (p) => <Icon {...p} d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />,
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
    >
      <polygon points="23 7 16 12 23 17 23 7" />
      <rect x="1" y="5" width="15" height="14" rx="2" />
    </svg>
  ),
  bell: (p) => (
    <svg
      width={p.size || 16}
      height={p.size || 16}
      viewBox="0 0 24 24"
      fill="none"
      stroke={p.color || 'currentColor'}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 01-3.46 0" />
    </svg>
  ),
  search: (p) => (
    <svg
      width={p.size || 16}
      height={p.size || 16}
      viewBox="0 0 24 24"
      fill="none"
      stroke={p.color || 'currentColor'}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="11" cy="11" r="8" />
      <path d="M21 21l-4.35-4.35" />
    </svg>
  ),
  chevDown: (p) => <Icon {...p} d="M6 9l6 6 6-6" />,
};

// ── Animations ───────────────────────────────────────────────────
const keyframes = `
@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
@keyframes slideUp { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }
@keyframes slideInLeft { from { opacity: 0; transform: translateX(-16px); } to { opacity: 1; transform: translateX(0); } }
@keyframes scaleIn { from { transform: scale(0.95); opacity: 0; } to { transform: scale(1); opacity: 1; } }
@keyframes checkPop { 0% { transform: scale(0); } 60% { transform: scale(1.25); } 100% { transform: scale(1); } }
@keyframes progressFill { from { width: 0; } }
@keyframes confetti1 { 0% { transform: translateY(0) rotate(0); opacity:1; } 100% { transform: translateY(-100px) rotate(220deg) translateX(25px); opacity:0; } }
@keyframes confetti2 { 0% { transform: translateY(0) rotate(0); opacity:1; } 100% { transform: translateY(-80px) rotate(-160deg) translateX(-35px); opacity:0; } }
@keyframes confetti3 { 0% { transform: translateY(0) rotate(0); opacity:1; } 100% { transform: translateY(-90px) rotate(140deg) translateX(15px); opacity:0; } }
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
@keyframes shimmer { 0% { background-position: -200% 0; } 100% { background-position: 200% 0; } }
@keyframes numberPop { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
@keyframes dotPulse { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.3); } }
`;
const slideUp = { animation: 'slideUp 0.45s ease-out forwards', opacity: 0 };
const fadeIn = { animation: 'fadeIn 0.3s ease-out forwards', opacity: 0 };
const scaleIn = { animation: 'scaleIn 0.25s ease-out forwards' };
function stagger(i, base = 0.07) {
  return { animationDelay: `${i * base}s` };
}

// ── Shared Components ────────────────────────────────────────────

function Card({ children, style: xs, hover, onClick }) {
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
        transition: 'all 0.25s ease',
        cursor: onClick ? 'pointer' : undefined,
        ...xs,
      }}
    >
      {children}
    </div>
  );
}

function IconBadge({ icon: IconComp, color, size = 40, iconSize = 20, style: xs }) {
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.28,
        flexShrink: 0,
        background: `${color}12`,
        border: `1px solid ${color}25`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        ...xs,
      }}
    >
      <IconComp size={iconSize} color={color} />
    </div>
  );
}

// ── Checklist Data ───────────────────────────────────────────────

const CHECKLIST_ITEMS = [
  {
    key: 'profile',
    icon: Icons.user,
    color: SECTION_COLORS.primary.text,
    label: 'Complete your profile',
    desc: 'Add your photo, headline, and bio',
    tab: 'profile',
  },
  {
    key: 'rate',
    icon: Icons.dollarSign,
    color: SECTION_COLORS.emerald.text,
    label: 'Set your rate',
    desc: 'Choose your per-minute consulting rate',
    tab: 'rate',
  },
  {
    key: 'calendar',
    icon: Icons.calendar,
    color: SECTION_COLORS.violet.text,
    label: 'Connect calendar',
    desc: 'Sync to prevent double bookings',
    tab: 'schedule',
  },
  {
    key: 'availability',
    icon: Icons.clock,
    color: SECTION_COLORS.cyan.text,
    label: 'Set your availability',
    desc: "Tell clients when you're free",
    tab: 'schedule',
  },
  {
    key: 'payouts',
    icon: Icons.creditCard,
    color: SECTION_COLORS.amber.text,
    label: 'Set up payouts',
    desc: 'Connect Stripe to receive earnings',
    tab: 'payouts',
  },
];

// ══════════════════════════════════════════════════════════════════
// SIDEBAR
// ══════════════════════════════════════════════════════════════════

function Sidebar({ page, setPage, completedItems }) {
  const done = completedItems.size;
  const allDone = done === 5;

  const topNav = [
    { key: 'dashboard', label: 'Dashboard', icon: Icons.home },
    { key: 'consultations', label: 'Consultations', icon: Icons.video },
    { key: 'projects', label: 'Projects', icon: Icons.briefcase },
    { key: 'messages', label: 'Messages', icon: Icons.messageSquare },
  ];

  const bottomNav = [
    { key: 'settings', label: 'Expert Settings', icon: Icons.settings },
    { key: 'account', label: 'Account', icon: Icons.user },
  ];

  return (
    <div
      style={{
        width: 240,
        background: c.surface,
        borderRight: `1px solid ${c.border}`,
        display: 'flex',
        flexDirection: 'column',
        flexShrink: 0,
        height: '100vh',
        position: 'sticky',
        top: 0,
      }}
    >
      {/* Logo */}
      <div style={{ padding: '20px 16px 24px', display: 'flex', alignItems: 'center', gap: 10 }}>
        <div
          style={{
            width: 32,
            height: 32,
            borderRadius: 9,
            background: c.gradient,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 14,
            fontWeight: 700,
            color: 'white',
            boxShadow: `0 2px 8px ${c.primaryGlow}`,
          }}
        >
          B
        </div>
        <span style={{ fontSize: 17, fontWeight: 700, color: c.text }}>Balo</span>
        <span
          style={{
            fontSize: 10,
            fontWeight: 650,
            padding: '2px 8px',
            borderRadius: 5,
            marginLeft: 'auto',
            background: c.successLight,
            color: c.success,
            border: `1px solid ${c.successBorder}`,
          }}
        >
          Expert
        </span>
      </div>

      {/* Search */}
      <div style={{ padding: '0 12px 16px' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '8px 12px',
            borderRadius: 8,
            background: c.surfaceSubtle,
            border: `1px solid ${c.borderSubtle}`,
            fontSize: 13,
            color: c.textTertiary,
            cursor: 'pointer',
          }}
        >
          <Icons.search size={14} color={c.textTertiary} />
          Search...
        </div>
      </div>

      {/* Top nav */}
      <div style={{ padding: '0 8px', flex: 1 }}>
        {topNav.map((item) => {
          const active = page === item.key;
          const NIcon = item.icon;
          return (
            <button
              key={item.key}
              onClick={() => setPage(item.key)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                width: '100%',
                padding: '9px 12px',
                borderRadius: 9,
                border: 'none',
                background: active ? c.primaryLight : 'transparent',
                color: active ? c.primary : c.textSecondary,
                cursor: 'pointer',
                fontSize: 13,
                fontWeight: active ? 600 : 500,
                transition: 'all 0.15s',
                textAlign: 'left',
                marginBottom: 2,
              }}
            >
              <NIcon size={17} color={active ? c.primary : c.textTertiary} />
              {item.label}
              {/* Notification dot for messages */}
              {item.key === 'messages' && (
                <span
                  style={{
                    marginLeft: 'auto',
                    width: 18,
                    height: 18,
                    borderRadius: '50%',
                    background: c.error,
                    color: 'white',
                    fontSize: 10,
                    fontWeight: 700,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  3
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Bottom nav — settings zone */}
      <div style={{ padding: '8px', borderTop: `1px solid ${c.borderSubtle}` }}>
        {bottomNav.map((item) => {
          const active = page === item.key;
          const NIcon = item.icon;
          const isSettings = item.key === 'settings';
          return (
            <button
              key={item.key}
              onClick={() => setPage(item.key)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                width: '100%',
                padding: '9px 12px',
                borderRadius: 9,
                border: 'none',
                background: active ? c.primaryLight : 'transparent',
                color: active ? c.primary : c.textTertiary,
                cursor: 'pointer',
                fontSize: 13,
                fontWeight: active ? 600 : 450,
                transition: 'all 0.15s',
                textAlign: 'left',
                marginBottom: 2,
              }}
            >
              <NIcon size={16} color={active ? c.primary : c.textTertiary} />
              {item.label}
              {/* Setup progress badge on Expert Settings */}
              {isSettings && !allDone && (
                <span
                  style={{
                    marginLeft: 'auto',
                    padding: '2px 8px',
                    borderRadius: 10,
                    fontSize: 10,
                    fontWeight: 650,
                    background: c.primaryLight,
                    color: c.primary,
                    border: `1px solid ${c.primaryBorder}`,
                  }}
                >
                  {done}/5
                </span>
              )}
              {isSettings && allDone && (
                <span style={{ marginLeft: 'auto', animation: 'checkPop 0.3s ease-out' }}>
                  <Icons.check size={14} color={c.success} />
                </span>
              )}
            </button>
          );
        })}

        {/* User pill */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '10px 12px',
            marginTop: 8,
            borderRadius: 9,
            cursor: 'pointer',
          }}
        >
          <div
            style={{
              width: 30,
              height: 30,
              borderRadius: 8,
              background: c.gradient,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 11,
              fontWeight: 700,
              color: 'white',
            }}
          >
            YJ
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <p
              style={{
                fontSize: 13,
                fontWeight: 600,
                color: c.text,
                margin: 0,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              Yomi Joseph
            </p>
            <p style={{ fontSize: 11, color: c.textTertiary, margin: 0 }}>Expert</p>
          </div>
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// TOP NAV BAR
// ══════════════════════════════════════════════════════════════════

function TopBar({ title }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '14px 32px',
        borderBottom: `1px solid ${c.borderSubtle}`,
        background: c.surface,
        position: 'sticky',
        top: 0,
        zIndex: 10,
      }}
    >
      <h1 style={{ fontSize: 16, fontWeight: 650, color: c.text, margin: 0 }}>{title}</h1>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <button
          style={{
            width: 36,
            height: 36,
            borderRadius: 10,
            border: `1px solid ${c.borderSubtle}`,
            background: c.surface,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            position: 'relative',
          }}
        >
          <Icons.bell size={17} color={c.textTertiary} />
          <span
            style={{
              position: 'absolute',
              top: -2,
              right: -2,
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: c.error,
              border: '2px solid white',
            }}
          />
        </button>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// SETUP CONTEXT BAR
// ══════════════════════════════════════════════════════════════════

function SetupContextBar({ completedItems, activeSetupStep, onBack }) {
  if (completedItems.size === 5) return null;

  const stepIndex = CHECKLIST_ITEMS.findIndex((i) => i.key === activeSetupStep);
  const item = CHECKLIST_ITEMS[stepIndex];
  if (!item) return null;

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 16,
        padding: '10px 20px',
        borderRadius: 12,
        margin: '0 0 24px',
        background: c.gradientSubtle,
        border: `1px solid ${c.accentBorder}40`,
        ...fadeIn,
      }}
    >
      <button
        onClick={onBack}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          fontSize: 13,
          fontWeight: 500,
          color: c.primary,
          padding: '4px 0',
          flexShrink: 0,
        }}
      >
        <Icons.arrowLeft size={14} color={c.primary} /> Dashboard
      </button>

      <div style={{ width: 1, height: 20, background: c.accentBorder, flexShrink: 0 }} />

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1 }}>
        <Icons.sparkles size={14} color={c.accent} />
        <span style={{ fontSize: 13, fontWeight: 600, color: c.accent }}>Getting Started</span>
        <span style={{ fontSize: 13, color: c.textTertiary }}>·</span>
        <span style={{ fontSize: 13, color: c.textSecondary }}>
          Step {stepIndex + 1} of 5 — {item.label}
        </span>
      </div>

      {/* Progress dots */}
      <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
        {CHECKLIST_ITEMS.map((ci, i) => (
          <div
            key={ci.key}
            style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: completedItems.has(i)
                ? c.gradient
                : i === stepIndex
                  ? c.accent
                  : c.border,
              transition: 'all 0.3s',
              boxShadow: i === stepIndex ? `0 0 0 3px ${c.accent}20` : 'none',
            }}
          />
        ))}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// GETTING STARTED CHECKLIST
// ══════════════════════════════════════════════════════════════════

function ChecklistItem({ item, complete, onClick, index }) {
  const [h, setH] = useState(false);
  const ItemIcon = item.icon;

  return (
    <div
      onClick={!complete ? onClick : undefined}
      onMouseEnter={() => setH(true)}
      onMouseLeave={() => setH(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        padding: '14px 16px',
        borderRadius: 12,
        cursor: complete ? 'default' : 'pointer',
        background: h && !complete ? `${item.color}06` : 'transparent',
        transition: 'all 0.2s',
        ...slideUp,
        ...stagger(index + 1),
      }}
    >
      {/* Completion circle */}
      <div
        style={{
          width: 30,
          height: 30,
          borderRadius: '50%',
          flexShrink: 0,
          background: complete ? c.gradient : c.surface,
          border: complete ? 'none' : `2px solid ${h ? item.color : c.border}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          boxShadow: complete ? `0 2px 8px ${c.primaryGlow}` : 'none',
          transition: 'all 0.3s',
        }}
      >
        {complete ? (
          <span style={{ animation: 'checkPop 0.3s ease-out' }}>
            <Icons.check size={14} color="white" />
          </span>
        ) : (
          <span
            style={{
              fontSize: 12,
              fontWeight: 650,
              color: h ? item.color : c.textTertiary,
              transition: 'color 0.2s',
            }}
          >
            {index + 1}
          </span>
        )}
      </div>

      {/* Icon badge */}
      <div
        style={{
          width: 34,
          height: 34,
          borderRadius: 9,
          flexShrink: 0,
          background: `${item.color}${complete ? '08' : '10'}`,
          border: `1px solid ${item.color}${complete ? '12' : '22'}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          opacity: complete ? 0.5 : 1,
          transition: 'all 0.3s',
        }}
      >
        <ItemIcon size={16} color={item.color} />
      </div>

      {/* Text */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <p
          style={{
            fontSize: 14,
            fontWeight: 600,
            margin: 0,
            color: complete ? c.textTertiary : c.text,
            textDecoration: complete ? 'line-through' : 'none',
            transition: 'all 0.3s',
          }}
        >
          {item.label}
        </p>
        <p style={{ fontSize: 12, color: c.textTertiary, margin: '2px 0 0' }}>{item.desc}</p>
      </div>

      {/* Arrow / check */}
      {!complete ? (
        <div
          style={{
            opacity: h ? 1 : 0,
            transform: h ? 'translateX(0)' : 'translateX(-4px)',
            transition: 'all 0.2s',
          }}
        >
          <Icons.arrowRight size={15} color={item.color} />
        </div>
      ) : (
        <span style={{ fontSize: 12, fontWeight: 600, color: c.success }}>Done</span>
      )}
    </div>
  );
}

function GettingStartedChecklist({ completedItems, onItemClick }) {
  const done = completedItems.size;
  const pct = (done / 5) * 100;
  const allDone = done === 5;

  // ── Celebration state ──
  if (allDone) {
    return (
      <Card
        style={{
          padding: '44px 32px',
          textAlign: 'center',
          position: 'relative',
          overflow: 'hidden',
          ...slideUp,
        }}
      >
        {[c.primary, c.accent, c.success, c.warning, c.pink, c.cyan, '#F59E0B'].map((color, i) => (
          <div
            key={i}
            style={{
              position: 'absolute',
              width: i % 2 === 0 ? 8 : 6,
              height: i % 2 === 0 ? 8 : 6,
              borderRadius: i % 3 === 0 ? 2 : '50%',
              background: color,
              top: '35%',
              left: `${10 + i * 12}%`,
              animation: `confetti${(i % 3) + 1} 1.6s ease-out ${i * 0.1}s forwards`,
              opacity: 0,
            }}
          />
        ))}
        <div
          style={{
            width: 76,
            height: 76,
            borderRadius: '50%',
            margin: '0 auto 22px',
            background: c.gradientWarm,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: '0 8px 32px rgba(5,150,105,0.3)',
            ...scaleIn,
          }}
        >
          <Icons.zap size={34} color="white" />
        </div>
        <h3
          style={{
            fontSize: 22,
            fontWeight: 700,
            color: c.text,
            margin: 0,
            ...slideUp,
            animationDelay: '0.1s',
          }}
        >
          You're live on the marketplace!
        </h3>
        <p
          style={{
            fontSize: 14,
            color: c.textSecondary,
            marginTop: 10,
            lineHeight: 1.6,
            maxWidth: 400,
            margin: '10px auto 0',
            ...slideUp,
            animationDelay: '0.15s',
          }}
        >
          Clients can now find and book you. Time to land your first consultation.
        </p>
        <button
          style={{
            marginTop: 24,
            padding: '11px 28px',
            borderRadius: 10,
            fontSize: 14,
            fontWeight: 650,
            border: 'none',
            background: c.gradientWarm,
            color: 'white',
            cursor: 'pointer',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            boxShadow: '0 2px 12px rgba(5,150,105,0.25)',
            ...slideUp,
            animationDelay: '0.2s',
          }}
        >
          <Icons.zap size={15} color="white" /> View your public profile
        </button>
      </Card>
    );
  }

  // ── Active checklist ──
  return (
    <Card style={{ overflow: 'hidden', ...slideUp }}>
      {/* Header */}
      <div
        style={{
          padding: '22px 24px 18px',
          background: c.gradientSubtle,
          borderBottom: `1px solid ${c.borderSubtle}`,
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div
              style={{
                width: 32,
                height: 32,
                borderRadius: 9,
                background: `${c.accent}12`,
                border: `1px solid ${c.accent}22`,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Icons.sparkles size={16} color={c.accent} />
            </div>
            <div>
              <h3 style={{ fontSize: 16, fontWeight: 700, color: c.text, margin: 0 }}>
                Getting Started
              </h3>
              <p style={{ fontSize: 12, color: c.textSecondary, margin: '2px 0 0' }}>
                Complete these steps to go live
              </p>
            </div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <p
              style={{
                fontSize: 26,
                fontWeight: 700,
                margin: 0,
                lineHeight: 1,
                background: c.gradient,
                WebkitBackgroundClip: 'text',
                WebkitTextFillColor: 'transparent',
              }}
            >
              {done}/5
            </p>
            <p style={{ fontSize: 11, color: c.textTertiary, margin: '4px 0 0' }}>complete</p>
          </div>
        </div>

        {/* Progress bar */}
        <div
          style={{
            marginTop: 14,
            height: 5,
            borderRadius: 3,
            background: 'rgba(255,255,255,0.7)',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              width: `${pct}%`,
              height: '100%',
              borderRadius: 3,
              background: c.gradient,
              transition: 'width 0.6s cubic-bezier(0.4, 0, 0.2, 1)',
              animation: 'progressFill 0.8s ease-out',
            }}
          />
        </div>
      </div>

      {/* Items */}
      <div style={{ padding: '6px 8px 10px' }}>
        {CHECKLIST_ITEMS.map((item, i) => (
          <ChecklistItem
            key={item.key}
            item={item}
            complete={completedItems.has(i)}
            onClick={() => onItemClick(item)}
            index={i}
          />
        ))}
      </div>
    </Card>
  );
}

// ══════════════════════════════════════════════════════════════════
// GHOST EMPTY STATES
// ══════════════════════════════════════════════════════════════════

function GhostConsultationRow({ delay }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '12px 0',
        borderBottom: `1px solid ${c.borderSubtle}`,
        opacity: 0.35,
        animationDelay: `${delay}s`,
      }}
    >
      {/* Time block */}
      <div style={{ width: 52, textAlign: 'center', flexShrink: 0 }}>
        <div
          style={{
            width: 44,
            height: 10,
            borderRadius: 4,
            background: c.border,
            margin: '0 auto 4px',
          }}
        />
        <div
          style={{
            width: 28,
            height: 8,
            borderRadius: 3,
            background: c.borderSubtle,
            margin: '0 auto',
          }}
        />
      </div>
      {/* Accent bar */}
      <div
        style={{ width: 3, height: 36, borderRadius: 2, background: c.primary, flexShrink: 0 }}
      />
      {/* Content */}
      <div style={{ flex: 1 }}>
        <div
          style={{
            width: '70%',
            height: 10,
            borderRadius: 4,
            background: c.border,
            marginBottom: 6,
          }}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <div
            style={{ width: 20, height: 20, borderRadius: '50%', background: c.surfaceSubtle }}
          />
          <div style={{ width: 80, height: 8, borderRadius: 3, background: c.borderSubtle }} />
        </div>
      </div>
      {/* Duration pill */}
      <div
        style={{
          width: 48,
          height: 22,
          borderRadius: 6,
          background: c.surfaceSubtle,
          flexShrink: 0,
        }}
      />
    </div>
  );
}

function GhostClientRow({ delay }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '10px 0',
        borderBottom: `1px solid ${c.borderSubtle}`,
        opacity: 0.35,
      }}
    >
      <div
        style={{
          width: 32,
          height: 32,
          borderRadius: '50%',
          background: c.surfaceSubtle,
          flexShrink: 0,
        }}
      />
      <div style={{ flex: 1 }}>
        <div
          style={{
            width: '60%',
            height: 10,
            borderRadius: 4,
            background: c.border,
            marginBottom: 5,
          }}
        />
        <div style={{ width: '40%', height: 8, borderRadius: 3, background: c.borderSubtle }} />
      </div>
      <div
        style={{ width: 56, height: 10, borderRadius: 4, background: c.border, flexShrink: 0 }}
      />
    </div>
  );
}

function GhostConsultationsCard() {
  return (
    <Card style={{ overflow: 'hidden', position: 'relative' }}>
      <div style={{ padding: '18px 20px' }}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 12,
          }}
        >
          <p style={{ fontSize: 14, fontWeight: 650, color: c.text, margin: 0 }}>
            Upcoming Consultations
          </p>
          <span style={{ fontSize: 12, color: c.textTertiary }}>Today</span>
        </div>
        <GhostConsultationRow delay={0} />
        <GhostConsultationRow delay={0.05} />
        <GhostConsultationRow delay={0.1} />
      </div>
      {/* Overlay */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'rgba(255,255,255,0.7)',
          backdropFilter: 'blur(1px)',
        }}
      >
        <div style={{ textAlign: 'center' }}>
          <IconBadge
            icon={Icons.video}
            color={c.primary}
            size={44}
            iconSize={20}
            style={{ margin: '0 auto 10px' }}
          />
          <p style={{ fontSize: 13, fontWeight: 600, color: c.text, margin: 0 }}>
            Complete setup to receive bookings
          </p>
          <p style={{ fontSize: 12, color: c.textTertiary, margin: '4px 0 0' }}>
            Your upcoming sessions will appear here
          </p>
        </div>
      </div>
    </Card>
  );
}

function GhostClientsCard() {
  return (
    <Card style={{ overflow: 'hidden', position: 'relative' }}>
      <div style={{ padding: '18px 20px' }}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 12,
          }}
        >
          <p style={{ fontSize: 14, fontWeight: 650, color: c.text, margin: 0 }}>Top Clients</p>
          <span style={{ fontSize: 12, color: c.textTertiary }}>All time</span>
        </div>
        <GhostClientRow delay={0} />
        <GhostClientRow delay={0.05} />
        <GhostClientRow delay={0.1} />
      </div>
      {/* Overlay */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'rgba(255,255,255,0.7)',
          backdropFilter: 'blur(1px)',
        }}
      >
        <div style={{ textAlign: 'center' }}>
          <IconBadge
            icon={Icons.users}
            color={c.accent}
            size={44}
            iconSize={20}
            style={{ margin: '0 auto 10px' }}
          />
          <p style={{ fontSize: 13, fontWeight: 600, color: c.text, margin: 0 }}>
            Your top clients
          </p>
          <p style={{ fontSize: 12, color: c.textTertiary, margin: '4px 0 0' }}>
            Will appear after your first session
          </p>
        </div>
      </div>
    </Card>
  );
}

// ══════════════════════════════════════════════════════════════════
// METRIC CARDS
// ══════════════════════════════════════════════════════════════════

function MetricCard({ icon: IconComp, iconColor, label, value, trend, index }) {
  return (
    <Card
      style={{
        padding: '20px 22px',
        ...slideUp,
        ...stagger(index + 5, 0.08),
      }}
      hover
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <IconBadge icon={IconComp} color={iconColor} size={40} iconSize={18} />
        {trend && (
          <span
            style={{
              fontSize: 11,
              fontWeight: 600,
              padding: '2px 8px',
              borderRadius: 8,
              background: c.successLight,
              color: c.success,
              display: 'flex',
              alignItems: 'center',
              gap: 3,
            }}
          >
            <Icons.trendingUp size={10} color={c.success} /> {trend}
          </span>
        )}
      </div>
      <p
        style={{
          fontSize: 26,
          fontWeight: 700,
          color: c.text,
          margin: '14px 0 0',
          lineHeight: 1,
          animation: 'numberPop 0.4s ease-out forwards',
        }}
      >
        {value}
      </p>
      <p style={{ fontSize: 12, color: c.textTertiary, margin: '6px 0 0' }}>{label}</p>
    </Card>
  );
}

// ══════════════════════════════════════════════════════════════════
// DASHBOARD PAGE
// ══════════════════════════════════════════════════════════════════

function DashboardPage({ completedItems, navigateToSettings }) {
  return (
    <div>
      <div style={{ marginBottom: 24, ...slideUp }}>
        <h2 style={{ fontSize: 22, fontWeight: 700, color: c.text, margin: 0 }}>
          Welcome back, Yomi
        </h2>
        <p style={{ fontSize: 14, color: c.textSecondary, marginTop: 4 }}>
          Here's what's happening with your expert account.
        </p>
      </div>

      <GettingStartedChecklist
        completedItems={completedItems}
        onItemClick={(item) => navigateToSettings(item.tab, item.key)}
      />

      {/* Metrics */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 14, marginTop: 20 }}>
        <MetricCard
          icon={Icons.dollarSign}
          iconColor={c.emerald}
          label="Total earnings"
          value="A$0.00"
          index={0}
        />
        <MetricCard
          icon={Icons.trendingUp}
          iconColor={c.primary}
          label="This payout cycle"
          value="A$0.00"
          index={1}
        />
        <MetricCard
          icon={Icons.clock}
          iconColor={c.accent}
          label="Pending transfer"
          value="A$0.00"
          index={2}
        />
      </div>

      {/* Ghost cards */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: 14,
          marginTop: 20,
          ...slideUp,
          ...stagger(8),
        }}
      >
        <GhostConsultationsCard />
        <GhostClientsCard />
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// EXPERT SETTINGS PAGE (TAB SHELL)
// ══════════════════════════════════════════════════════════════════

function ExpertSettingsPage({ completedItems, activeSetupStep, onBack }) {
  const [tab, setTab] = useState(
    CHECKLIST_ITEMS.find((i) => i.key === activeSetupStep)?.tab || 'profile'
  );

  // Sync tab when setup step changes
  useEffect(() => {
    const item = CHECKLIST_ITEMS.find((i) => i.key === activeSetupStep);
    if (item) setTab(item.tab);
  }, [activeSetupStep]);

  const tabs = [
    { key: 'profile', label: 'Profile' },
    { key: 'expertise', label: 'Expertise' },
    { key: 'rate', label: 'Rate' },
    { key: 'schedule', label: 'Schedule' },
    { key: 'payouts', label: 'Payouts' },
  ];

  const tabContent = {
    profile: {
      icon: Icons.user,
      color: c.primary,
      title: 'Profile',
      desc: 'Manage how clients see you on the marketplace. Add your photo, headline, bio, and public profile URL.',
      task: 'BAL-192',
    },
    expertise: {
      icon: Icons.shield,
      color: c.accent,
      title: 'Expertise',
      desc: 'Your approved skills and self-assessment ratings. Locked after approval — contact support for changes.',
      task: 'BAL-192',
    },
    rate: {
      icon: Icons.dollarSign,
      color: c.emerald,
      title: 'Rate',
      desc: "Set your per-minute consulting rate. Clients see a higher rate that includes Balo's service fee.",
      task: 'BAL-193',
    },
    schedule: {
      icon: Icons.calendar,
      color: SECTION_COLORS.violet.text,
      title: 'Schedule',
      desc: 'Connect your calendars and set weekly availability for consultations.',
      task: 'BAL-194 / BAL-195',
    },
    payouts: {
      icon: Icons.creditCard,
      color: SECTION_COLORS.amber.text,
      title: 'Payouts',
      desc: 'Connect your Stripe account to receive earnings from consultations.',
      task: 'BAL-196',
    },
  };

  const content = tabContent[tab];
  const ContentIcon = content.icon;

  return (
    <div>
      {/* Context bar */}
      <SetupContextBar
        completedItems={completedItems}
        activeSetupStep={activeSetupStep}
        onBack={onBack}
      />

      {/* Pill tab bar */}
      <div
        style={{
          display: 'inline-flex',
          gap: 4,
          padding: 4,
          borderRadius: 12,
          background: c.surfaceSubtle,
          marginBottom: 28,
          ...slideUp,
          animationDelay: '0.05s',
        }}
      >
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            style={{
              padding: '8px 18px',
              borderRadius: 8,
              fontSize: 13,
              fontWeight: 550,
              border: 'none',
              cursor: 'pointer',
              background: tab === t.key ? c.surface : 'transparent',
              color: tab === t.key ? c.text : c.textTertiary,
              boxShadow: tab === t.key ? '0 1px 3px rgba(0,0,0,0.08)' : 'none',
              transition: 'all 0.2s',
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Tab content — placeholder showing what will be built */}
      <div style={{ ...slideUp, animationDelay: '0.1s' }} key={tab}>
        <Card style={{ padding: '48px 40px', textAlign: 'center' }}>
          <IconBadge
            icon={ContentIcon}
            color={content.color}
            size={56}
            iconSize={26}
            style={{ margin: '0 auto 18px' }}
          />
          <h3 style={{ fontSize: 20, fontWeight: 700, color: c.text, margin: 0 }}>
            {content.title}
          </h3>
          <p
            style={{
              fontSize: 14,
              color: c.textSecondary,
              marginTop: 8,
              lineHeight: 1.6,
              maxWidth: 440,
              margin: '8px auto 0',
            }}
          >
            {content.desc}
          </p>
          <div
            style={{
              marginTop: 24,
              padding: '10px 20px',
              borderRadius: 10,
              background: c.surfaceSubtle,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              fontSize: 13,
              color: c.textTertiary,
            }}
          >
            <Icons.briefcase size={14} color={c.textTertiary} />
            Implemented by {content.task}
          </div>
        </Card>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// PLACEHOLDER PAGES
// ══════════════════════════════════════════════════════════════════

function PlaceholderPage({ icon: IconComp, iconColor, title, subtitle }) {
  return (
    <div style={{ ...slideUp }}>
      <div style={{ marginBottom: 24 }}>
        <h2 style={{ fontSize: 22, fontWeight: 700, color: c.text, margin: 0 }}>{title}</h2>
        {subtitle && (
          <p style={{ fontSize: 14, color: c.textSecondary, marginTop: 4 }}>{subtitle}</p>
        )}
      </div>
      <Card style={{ padding: '64px 40px', textAlign: 'center' }}>
        <IconBadge
          icon={IconComp}
          color={iconColor}
          size={56}
          iconSize={26}
          style={{ margin: '0 auto 18px' }}
        />
        <p style={{ fontSize: 15, fontWeight: 600, color: c.text, margin: 0 }}>Coming soon</p>
        <p style={{ fontSize: 13, color: c.textTertiary, margin: '6px 0 0' }}>
          This feature is being built
        </p>
      </Card>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// MAIN APP
// ══════════════════════════════════════════════════════════════════

export default function ExpertDashboardShell() {
  const [page, setPage] = useState('dashboard');
  const [completedItems, setCompletedItems] = useState(new Set([0]));
  const [activeSetupStep, setActiveSetupStep] = useState(null);

  const navigateToSettings = (tab, setupKey) => {
    setActiveSetupStep(setupKey);
    setPage('settings');
  };

  const toggleItem = (index) => {
    setCompletedItems((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  // Auto-complete items when visiting settings tabs (simulating real behavior)
  useEffect(() => {
    if (page === 'settings' && activeSetupStep) {
      const idx = CHECKLIST_ITEMS.findIndex((i) => i.key === activeSetupStep);
      if (idx >= 0) {
        const timer = setTimeout(() => {
          setCompletedItems((prev) => new Set([...prev, idx]));
        }, 2000);
        return () => clearTimeout(timer);
      }
    }
  }, [page, activeSetupStep]);

  const pageTitle = {
    dashboard: 'Dashboard',
    consultations: 'Consultations',
    projects: 'Projects',
    messages: 'Messages',
    settings: 'Expert Settings',
    account: 'Account',
  };

  return (
    <div
      style={{
        display: 'flex',
        minHeight: '100vh',
        background: c.bg,
        fontFamily: "'DM Sans', -apple-system, BlinkMacSystemFont, sans-serif",
      }}
    >
      <style>{keyframes}</style>
      <link
        href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap"
        rel="stylesheet"
      />

      <Sidebar
        page={page}
        setPage={(p) => {
          setPage(p);
          setActiveSetupStep(null);
        }}
        completedItems={completedItems}
      />

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: '100vh' }}>
        <TopBar title={pageTitle[page] || 'Dashboard'} />

        <div
          style={{ flex: 1, padding: '28px 36px', overflow: 'auto' }}
          key={page + activeSetupStep}
        >
          {page === 'dashboard' && (
            <DashboardPage
              completedItems={completedItems}
              navigateToSettings={navigateToSettings}
            />
          )}
          {page === 'settings' && (
            <ExpertSettingsPage
              completedItems={completedItems}
              activeSetupStep={activeSetupStep}
              onBack={() => {
                setPage('dashboard');
                setActiveSetupStep(null);
              }}
            />
          )}
          {page === 'consultations' && (
            <PlaceholderPage
              icon={Icons.video}
              iconColor={c.primary}
              title="Consultations"
              subtitle="Your upcoming and past consultations."
            />
          )}
          {page === 'projects' && (
            <PlaceholderPage
              icon={Icons.briefcase}
              iconColor={c.accent}
              title="Projects"
              subtitle="Active and completed project engagements."
            />
          )}
          {page === 'messages' && (
            <PlaceholderPage
              icon={Icons.messageSquare}
              iconColor={c.cyan}
              title="Messages"
              subtitle="Conversations with your clients."
            />
          )}
          {page === 'account' && (
            <PlaceholderPage
              icon={Icons.user}
              iconColor={c.textSecondary}
              title="Account"
              subtitle="Manage your account settings and preferences."
            />
          )}
        </div>
      </div>
    </div>
  );
}
