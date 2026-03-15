import { useState } from 'react';

// ── Design Tokens ────────────────────────────────────────────────
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
  cyan: '#0891B2',
  emerald: '#059669',
  gradient: 'linear-gradient(135deg, #2563EB 0%, #7C3AED 100%)',
  gradientSubtle: 'linear-gradient(135deg, #EFF6FF 0%, #F5F3FF 100%)',
  gradientWarm: 'linear-gradient(135deg, #059669 0%, #0891B2 100%)',
};

const keyframes = `
@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
@keyframes slideUp { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: translateY(0); } }
@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }
@keyframes checkPop { 0% { transform: scale(0); } 60% { transform: scale(1.2); } 100% { transform: scale(1); } }
`;

// ── Icons ────────────────────────────────────────────────────────
const Svg = ({ children, size = 16, color = 'currentColor' }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke={color}
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    {children}
  </svg>
);
const Icons = {
  home: ({ size, color }) => (
    <Svg size={size} color={color}>
      <path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
      <polyline points="9 22 9 12 15 12 15 22" />
    </Svg>
  ),
  video: ({ size, color }) => (
    <Svg size={size} color={color}>
      <polygon points="23 7 16 12 23 17 23 7" />
      <rect x="1" y="5" width="15" height="14" rx="2" />
    </Svg>
  ),
  briefcase: ({ size, color }) => (
    <Svg size={size} color={color}>
      <path d="M20 7H4a2 2 0 00-2 2v10a2 2 0 002 2h16a2 2 0 002-2V9a2 2 0 00-2-2zM16 21V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v16" />
    </Svg>
  ),
  message: ({ size, color }) => (
    <Svg size={size} color={color}>
      <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
    </Svg>
  ),
  settings: ({ size, color }) => (
    <Svg size={size} color={color}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z" />
    </Svg>
  ),
  user: ({ size, color }) => (
    <Svg size={size} color={color}>
      <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </Svg>
  ),
  shield: ({ size, color }) => (
    <Svg size={size} color={color}>
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </Svg>
  ),
  award: ({ size, color }) => (
    <Svg size={size} color={color}>
      <circle cx="12" cy="8" r="7" />
      <polyline points="8.21 13.89 7 23 12 20 17 23 15.79 13.88" />
    </Svg>
  ),
  camera: ({ size, color }) => (
    <Svg size={size} color={color}>
      <path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z" />
      <circle cx="12" cy="13" r="4" />
    </Svg>
  ),
  dollar: ({ size, color }) => (
    <Svg size={size} color={color}>
      <line x1="12" y1="1" x2="12" y2="23" />
      <path d="M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6" />
    </Svg>
  ),
  calendar: ({ size, color }) => (
    <Svg size={size} color={color}>
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <path d="M16 2v4M8 2v4M3 10h18" />
    </Svg>
  ),
  credit: ({ size, color }) => (
    <Svg size={size} color={color}>
      <rect x="1" y="4" width="22" height="16" rx="2" />
      <path d="M1 10h22" />
    </Svg>
  ),
  check: ({ size, color }) => (
    <Svg size={size} color={color}>
      <path d="M20 6L9 17l-5-5" />
    </Svg>
  ),
  bell: ({ size, color }) => (
    <Svg size={size} color={color}>
      <path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 01-3.46 0" />
    </Svg>
  ),
  search: ({ size, color }) => (
    <Svg size={size} color={color}>
      <circle cx="11" cy="11" r="8" />
      <path d="M21 21l-4.35-4.35" />
    </Svg>
  ),
  star: ({ size, color, fill }) => (
    <Svg size={size} color={color}>
      <polygon
        points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"
        fill={fill || 'none'}
      />
    </Svg>
  ),
  lock: ({ size, color }) => (
    <Svg size={size} color={color}>
      <rect x="3" y="11" width="18" height="11" rx="2" />
      <path d="M7 11V7a5 5 0 0110 0v4" />
    </Svg>
  ),
  sparkles: ({ size, color }) => (
    <Svg size={size} color={color}>
      <path d="M12 3v2m0 14v2m-7-9H3m18 0h-2m-1.636-6.364l-1.414 1.414M7.05 16.95l-1.414 1.414m0-12.728l1.414 1.414m9.9 9.9l1.414 1.414" />
      <circle cx="12" cy="12" r="4" />
    </Svg>
  ),
  link: ({ size, color }) => (
    <Svg size={size} color={color}>
      <path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71" />
    </Svg>
  ),
  trending: ({ size, color }) => (
    <Svg size={size} color={color}>
      <polyline points="23 6 13.5 15.5 8.5 10.5 1 18" />
      <polyline points="17 6 23 6 23 12" />
    </Svg>
  ),
  eye: ({ size, color }) => (
    <Svg size={size} color={color}>
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </Svg>
  ),
  x: ({ size, color }) => (
    <Svg size={size} color={color}>
      <path d="M18 6L6 18M6 6l12 12" />
    </Svg>
  ),
  plus: ({ size, color }) => (
    <Svg size={size} color={color}>
      <path d="M12 5v14M5 12h14" />
    </Svg>
  ),
  globe: ({ size, color }) => (
    <Svg size={size} color={color}>
      <circle cx="12" cy="12" r="10" />
      <path d="M2 12h20M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10A15.3 15.3 0 0112 2z" />
    </Svg>
  ),
  upload: ({ size, color }) => (
    <Svg size={size} color={color}>
      <polyline points="16 16 12 12 8 16" />
      <line x1="12" y1="12" x2="12" y2="21" />
      <path d="M20.39 18.39A5 5 0 0018 9h-1.26A8 8 0 103 16.3" />
    </Svg>
  ),
  alertCircle: ({ size, color }) => (
    <Svg size={size} color={color}>
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </Svg>
  ),
  trash: ({ size, color }) => (
    <Svg size={size} color={color}>
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6M10 11v6M14 11v6M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2" />
    </Svg>
  ),
};

// ── Shared components ────────────────────────────────────────────
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

function SectionLabel({ icon: I, color, children }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 14 }}>
      <I size={13} color={color || c.textTertiary} />
      <span
        style={{
          fontSize: 11,
          fontWeight: 700,
          color: color || c.textTertiary,
          textTransform: 'uppercase',
          letterSpacing: '0.07em',
        }}
      >
        {children}
      </span>
    </div>
  );
}

function CharCounter({ current, max }) {
  const r = current / max;
  const col = r >= 1 ? c.error : r >= 0.85 ? c.warning : c.textTertiary;
  return (
    <span style={{ fontSize: 11, color: col, fontVariantNumeric: 'tabular-nums' }}>
      {current}/{max}
    </span>
  );
}

function FieldLabel({ children, hint, counter }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: 7,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: c.text }}>{children}</span>
        {hint && <span style={{ fontSize: 11, color: c.textTertiary }}>{hint}</span>}
      </div>
      {counter}
    </div>
  );
}

function Input({ value, onChange, placeholder, prefix, disabled, maxLength }) {
  const [focused, setFocused] = useState(false);
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        border: `1px solid ${focused ? c.primary : c.border}`,
        borderRadius: 10,
        background: disabled ? c.surfaceSubtle : c.surface,
        boxShadow: focused ? `0 0 0 3px ${c.primaryGlow}` : 'none',
        transition: 'all 0.2s',
      }}
    >
      {prefix && (
        <span
          style={{
            padding: '0 8px 0 13px',
            fontSize: 13,
            color: c.textTertiary,
            userSelect: 'none',
          }}
        >
          {prefix}
        </span>
      )}
      <input
        value={value}
        onChange={(e) => onChange?.(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        maxLength={maxLength}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={{
          flex: 1,
          padding: prefix ? '10px 13px 10px 0' : '10px 13px',
          fontSize: 14,
          border: 'none',
          outline: 'none',
          background: 'transparent',
          color: disabled ? c.textTertiary : c.text,
          fontFamily: 'inherit',
        }}
      />
    </div>
  );
}

function Textarea({ value, onChange, placeholder, maxLength, rows = 5 }) {
  const [focused, setFocused] = useState(false);
  return (
    <textarea
      value={value}
      onChange={(e) => onChange?.(e.target.value)}
      placeholder={placeholder}
      maxLength={maxLength}
      rows={rows}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={{
        width: '100%',
        padding: '10px 13px',
        fontSize: 14,
        color: c.text,
        border: `1px solid ${focused ? c.primary : c.border}`,
        borderRadius: 10,
        boxShadow: focused ? `0 0 0 3px ${c.primaryGlow}` : 'none',
        outline: 'none',
        resize: 'none',
        lineHeight: 1.65,
        transition: 'all 0.2s',
        fontFamily: 'inherit',
        boxSizing: 'border-box',
      }}
    />
  );
}

// ══════════════════════════════════════════════════════════════════
// SIDEBAR (from dashboard shell)
// ══════════════════════════════════════════════════════════════════
function Sidebar({ activePage }) {
  const topNav = [
    { key: 'dashboard', label: 'Dashboard', icon: Icons.home },
    { key: 'consultations', label: 'Consultations', icon: Icons.video },
    { key: 'projects', label: 'Projects', icon: Icons.briefcase },
    { key: 'messages', label: 'Messages', icon: Icons.message },
  ];
  const bottomNav = [
    { key: 'settings', label: 'Expert Settings', icon: Icons.settings },
    { key: 'account', label: 'Account', icon: Icons.user },
  ];

  return (
    <div
      style={{
        width: 220,
        background: c.surface,
        borderRight: `1px solid ${c.border}`,
        display: 'flex',
        flexDirection: 'column',
        flexShrink: 0,
      }}
    >
      {/* Logo */}
      <div style={{ padding: '18px 14px 20px', display: 'flex', alignItems: 'center', gap: 9 }}>
        <div
          style={{
            width: 30,
            height: 30,
            borderRadius: 8,
            background: c.gradient,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 13,
            fontWeight: 700,
            color: 'white',
          }}
        >
          B
        </div>
        <span style={{ fontSize: 16, fontWeight: 700, color: c.text }}>Balo</span>
        <span
          style={{
            fontSize: 9,
            fontWeight: 700,
            padding: '2px 6px',
            borderRadius: 4,
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
      <div style={{ padding: '0 10px 14px' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 7,
            padding: '7px 10px',
            borderRadius: 7,
            background: c.surfaceSubtle,
            fontSize: 12,
            color: c.textTertiary,
          }}
        >
          <Icons.search size={13} color={c.textTertiary} /> Search…
        </div>
      </div>

      {/* Top nav */}
      <div style={{ padding: '0 7px', flex: 1 }}>
        {topNav.map(({ key, label, icon: I }) => {
          const active = activePage === key;
          return (
            <div
              key={key}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 9,
                padding: '8px 11px',
                borderRadius: 8,
                marginBottom: 1,
                background: active ? c.primaryLight : 'transparent',
                color: active ? c.primary : c.textSecondary,
                fontSize: 13,
                fontWeight: active ? 600 : 500,
                cursor: 'pointer',
              }}
            >
              <I size={15} color={active ? c.primary : c.textTertiary} />
              {label}
              {key === 'messages' && (
                <span
                  style={{
                    marginLeft: 'auto',
                    width: 17,
                    height: 17,
                    borderRadius: '50%',
                    background: c.error,
                    color: 'white',
                    fontSize: 9,
                    fontWeight: 700,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  3
                </span>
              )}
            </div>
          );
        })}
      </div>

      {/* Bottom nav */}
      <div style={{ padding: '7px', borderTop: `1px solid ${c.borderSubtle}` }}>
        {bottomNav.map(({ key, label, icon: I }) => {
          const active = activePage === key;
          return (
            <div
              key={key}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 9,
                padding: '8px 11px',
                borderRadius: 8,
                marginBottom: 1,
                background: active ? c.primaryLight : 'transparent',
                color: active ? c.primary : c.textTertiary,
                fontSize: 13,
                fontWeight: active ? 600 : 450,
                cursor: 'pointer',
              }}
            >
              <I size={14} color={active ? c.primary : c.textTertiary} />
              {label}
              {key === 'settings' && (
                <span
                  style={{
                    marginLeft: 'auto',
                    padding: '1px 7px',
                    borderRadius: 10,
                    fontSize: 9,
                    fontWeight: 700,
                    background: c.primaryLight,
                    color: c.primary,
                    border: `1px solid ${c.primaryBorder}`,
                  }}
                >
                  1/5
                </span>
              )}
            </div>
          );
        })}
        {/* User pill */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 9,
            padding: '9px 11px',
            marginTop: 6,
            cursor: 'pointer',
          }}
        >
          <div
            style={{
              width: 28,
              height: 28,
              borderRadius: 7,
              background: c.gradient,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 10,
              fontWeight: 700,
              color: 'white',
            }}
          >
            YJ
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <p style={{ fontSize: 12, fontWeight: 600, color: c.text, margin: 0 }}>Yomi Joseph</p>
            <p style={{ fontSize: 10, color: c.textTertiary, margin: 0 }}>Expert</p>
          </div>
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// TOP BAR
// ══════════════════════════════════════════════════════════════════
function TopBar({ title }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '13px 28px',
        borderBottom: `1px solid ${c.borderSubtle}`,
        background: c.surface,
      }}
    >
      <h1 style={{ fontSize: 15, fontWeight: 650, color: c.text, margin: 0 }}>{title}</h1>
      <button
        style={{
          width: 34,
          height: 34,
          borderRadius: 9,
          border: `1px solid ${c.borderSubtle}`,
          background: c.surface,
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          position: 'relative',
        }}
      >
        <Icons.bell size={16} color={c.textTertiary} />
        <span
          style={{
            position: 'absolute',
            top: -2,
            right: -2,
            width: 7,
            height: 7,
            borderRadius: '50%',
            background: c.error,
            border: '2px solid white',
          }}
        />
      </button>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// MAIN TABS — pill style (page-level)
// ══════════════════════════════════════════════════════════════════
function MainTabs({ activeTab, onTabChange }) {
  const tabs = [
    { key: 'profile', label: 'Profile', icon: Icons.user },
    { key: 'rate', label: 'Rate', icon: Icons.dollar },
    { key: 'schedule', label: 'Schedule', icon: Icons.calendar },
    { key: 'payouts', label: 'Payouts', icon: Icons.credit },
  ];

  return (
    <div
      style={{
        display: 'inline-flex',
        gap: 3,
        padding: 4,
        borderRadius: 12,
        background: c.surfaceSubtle,
        border: `1px solid ${c.borderSubtle}`,
      }}
    >
      {tabs.map(({ key, label, icon: I }) => {
        const active = activeTab === key;
        return (
          <button
            key={key}
            onClick={() => onTabChange(key)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 7,
              padding: '8px 17px',
              borderRadius: 8,
              fontSize: 13,
              fontWeight: 550,
              border: 'none',
              cursor: 'pointer',
              background: active ? c.surface : 'transparent',
              color: active ? c.text : c.textTertiary,
              boxShadow: active ? '0 1px 3px rgba(0,0,0,0.08)' : 'none',
              transition: 'all 0.18s',
            }}
          >
            <I size={14} color={active ? c.primary : c.textTertiary} />
            {label}
          </button>
        );
      })}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// SUB TABS — underline style (section-level, within Profile)
// ══════════════════════════════════════════════════════════════════
function SubTabs({ activeTab, onTabChange }) {
  const tabs = [
    { key: 'profile', label: 'Profile', icon: Icons.user },
    { key: 'expertise', label: 'Expertise', icon: Icons.shield },
    { key: 'workHistory', label: 'Work History', icon: Icons.briefcase },
    { key: 'certifications', label: 'Certifications', icon: Icons.award },
  ];

  return (
    <div
      style={{
        display: 'flex',
        gap: 0,
        borderBottom: `1px solid ${c.border}`,
        marginBottom: 28,
      }}
    >
      {tabs.map(({ key, label, icon: I }) => {
        const active = activeTab === key;
        return (
          <button
            key={key}
            onClick={() => onTabChange(key)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '10px 18px 9px',
              fontSize: 13,
              fontWeight: active ? 600 : 450,
              border: 'none',
              background: 'none',
              cursor: 'pointer',
              color: active ? c.primary : c.textTertiary,
              borderBottom: `2px solid ${active ? c.primary : 'transparent'}`,
              marginBottom: -1,
              transition: 'all 0.15s',
            }}
          >
            <I size={13} color={active ? c.primary : c.textTertiary} />
            {label}
          </button>
        );
      })}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// PHOTO UPLOAD
// ══════════════════════════════════════════════════════════════════
function PhotoUpload() {
  const [hover, setHover] = useState(false);
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 20, marginBottom: 26 }}>
      <div
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{ position: 'relative', flexShrink: 0, cursor: 'pointer' }}
      >
        <div
          style={{
            width: 80,
            height: 80,
            borderRadius: '50%',
            background: c.gradient,
            border: `2.5px solid ${hover ? c.primaryBorder : 'transparent'}`,
            boxShadow: hover ? `0 0 0 4px ${c.primaryGlow}` : 'none',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 22,
            fontWeight: 700,
            color: 'white',
            position: 'relative',
            overflow: 'hidden',
            transition: 'all 0.2s',
          }}
        >
          YJ
          <div
            style={{
              position: 'absolute',
              inset: 0,
              background: 'rgba(0,0,0,0.5)',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 3,
              opacity: hover ? 1 : 0,
              transition: 'opacity 0.2s',
            }}
          >
            <Icons.camera size={16} color="white" />
            <span style={{ fontSize: 8, color: 'white', fontWeight: 700 }}>CHANGE</span>
          </div>
        </div>
        <div
          style={{
            position: 'absolute',
            bottom: 2,
            right: 2,
            width: 14,
            height: 14,
            borderRadius: '50%',
            background: c.success,
            border: '2px solid white',
          }}
        />
      </div>
      <div style={{ flex: 1 }}>
        <p style={{ fontSize: 13, fontWeight: 600, color: c.text, margin: '0 0 4px' }}>
          Profile photo
        </p>
        <p style={{ fontSize: 12, color: c.textTertiary, margin: '0 0 12px', lineHeight: 1.5 }}>
          A professional headshot builds trust with clients. JPG or PNG, at least 400×400px.
        </p>
        <button
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '7px 13px',
            borderRadius: 8,
            fontSize: 12,
            fontWeight: 600,
            cursor: 'pointer',
            border: `1px solid ${c.border}`,
            background: c.surface,
            color: c.text,
          }}
        >
          <Icons.upload size={12} color={c.textSecondary} /> Upload photo
        </button>
      </div>
    </div>
  );
}

// ── Industry chips ───────────────────────────────────────────────
const INDUSTRIES = [
  'Financial Services',
  'Healthcare',
  'Retail & eCommerce',
  'Technology',
  'Education',
  'Government',
  'Real Estate',
];

function ChipPicker({ selected, onToggle }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
      {INDUSTRIES.map((opt) => {
        const on = selected.includes(opt);
        return (
          <button
            key={opt}
            onClick={() => onToggle(opt)}
            style={{
              padding: '5px 12px',
              borderRadius: 20,
              fontSize: 12,
              fontWeight: 550,
              cursor: 'pointer',
              transition: 'all 0.15s',
              border: 'none',
              background: on ? c.gradient : c.surfaceSubtle,
              color: on ? 'white' : c.textSecondary,
              boxShadow: on ? `0 2px 8px ${c.primaryGlow}` : 'none',
            }}
          >
            {opt}
          </button>
        );
      })}
    </div>
  );
}

// ── Language pill ────────────────────────────────────────────────
function LangPill({ name, flag, prof }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 7,
        padding: '5px 10px 5px 12px',
        borderRadius: 20,
        background: c.surfaceSubtle,
        border: `1px solid ${c.borderSubtle}`,
      }}
    >
      <span style={{ fontSize: 15 }}>{flag}</span>
      <span style={{ fontSize: 12, fontWeight: 600, color: c.text }}>{name}</span>
      <span style={{ fontSize: 11, color: c.textTertiary }}>· {prof}</span>
      <button
        style={{
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          padding: '0 0 0 2px',
          display: 'flex',
        }}
      >
        <Icons.x size={11} color={c.textTertiary} />
      </button>
    </span>
  );
}

// ══════════════════════════════════════════════════════════════════
// MARKETPLACE PREVIEW CARD (right panel)
// ══════════════════════════════════════════════════════════════════
function MarketplacePreviewCard({ headline, bio }) {
  return (
    <div
      style={{
        borderRadius: 14,
        border: `1px solid ${c.border}`,
        boxShadow: '0 4px 20px rgba(0,0,0,0.07)',
        overflow: 'hidden',
        background: c.surface,
      }}
    >
      {/* Banner */}
      <div
        style={{
          height: 56,
          background: c.gradientSubtle,
          borderBottom: `1px solid ${c.borderSubtle}`,
          position: 'relative',
        }}
      >
        <div
          style={{
            position: 'absolute',
            top: 8,
            right: 10,
            padding: '2px 8px',
            borderRadius: 20,
            fontSize: 9,
            fontWeight: 700,
            background: 'white',
            color: c.primary,
            border: `1px solid ${c.primaryBorder}`,
          }}
        >
          Salesforce
        </div>
      </div>
      <div style={{ padding: '0 14px 14px' }}>
        {/* Avatar */}
        <div
          style={{
            marginTop: -22,
            marginBottom: 8,
            display: 'flex',
            alignItems: 'flex-end',
            justifyContent: 'space-between',
          }}
        >
          <div
            style={{
              width: 46,
              height: 46,
              borderRadius: '50%',
              background: c.gradient,
              border: '3px solid white',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 14,
              fontWeight: 700,
              color: 'white',
              boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
            }}
          >
            YJ
          </div>
          <div style={{ textAlign: 'right' }}>
            <span style={{ fontSize: 15, fontWeight: 700, color: c.text }}>A$3.50</span>
            <span style={{ fontSize: 10, color: c.textTertiary }}>/min</span>
          </div>
        </div>
        {/* Name */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 2 }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: c.text }}>Abayomi Joseph</span>
          <Icons.check size={12} color={c.success} />
        </div>
        {/* Headline */}
        <p
          style={{
            fontSize: 11,
            color: headline ? c.textSecondary : c.textTertiary,
            margin: '0 0 7px',
            lineHeight: 1.4,
            fontStyle: headline ? 'normal' : 'italic',
            minHeight: 16,
            animation: headline ? 'fadeIn 0.25s ease' : 'none',
          }}
        >
          {headline || 'Your headline will appear here…'}
        </p>
        {/* Stars */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 3, marginBottom: 8 }}>
          {[1, 2, 3, 4, 5].map((i) => (
            <Icons.star key={i} size={10} color="#F59E0B" fill="#F59E0B" />
          ))}
          <span style={{ fontSize: 10, fontWeight: 600, color: c.text }}>4.9</span>
          <span style={{ fontSize: 10, color: c.textTertiary }}>(47 reviews)</span>
        </div>
        {/* Bio snippet */}
        {bio && (
          <p
            style={{
              fontSize: 11,
              color: c.textSecondary,
              margin: '0 0 9px',
              lineHeight: 1.5,
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
              animation: 'fadeIn 0.25s ease',
            }}
          >
            {bio}
          </p>
        )}
        <button
          style={{
            width: '100%',
            padding: '8px',
            borderRadius: 8,
            fontSize: 12,
            fontWeight: 650,
            border: 'none',
            background: c.gradient,
            color: 'white',
            cursor: 'pointer',
          }}
        >
          Book a Consultation
        </button>
      </div>
    </div>
  );
}

// ── Completeness bar ─────────────────────────────────────────────
function CompletenessBar({ fields }) {
  const done = fields.filter((f) => f.done).length;
  const pct = Math.round((done / fields.length) * 100);
  const color = pct < 40 ? c.error : pct < 80 ? c.warning : c.success;
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 7 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: c.text }}>Profile completeness</span>
        <span style={{ fontSize: 12, fontWeight: 700, color }}>{pct}%</span>
      </div>
      <div style={{ height: 4, borderRadius: 2, background: c.surfaceSubtle }}>
        <div
          style={{
            width: `${pct}%`,
            height: '100%',
            borderRadius: 2,
            background: pct < 80 ? c.warning : c.gradientWarm,
            transition: 'width 0.5s ease',
          }}
        />
      </div>
      <div style={{ marginTop: 9, display: 'flex', flexDirection: 'column', gap: 5 }}>
        {fields.map((f) => (
          <div key={f.label} style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <div
              style={{
                width: 15,
                height: 15,
                borderRadius: '50%',
                flexShrink: 0,
                background: f.done ? c.gradient : c.surfaceSubtle,
                border: f.done ? 'none' : `1.5px solid ${c.border}`,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                transition: 'all 0.25s',
              }}
            >
              {f.done && <Icons.check size={8} color="white" />}
            </div>
            <span style={{ fontSize: 11, color: f.done ? c.textSecondary : c.textTertiary }}>
              {f.label}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// PROFILE SUB-TAB CONTENT
// ══════════════════════════════════════════════════════════════════
function ProfileSubTab({ profile, onChange }) {
  const [industries, setIndustries] = useState(['Financial Services', 'Technology']);
  const toggleIndustry = (ind) =>
    setIndustries((prev) => (prev.includes(ind) ? prev.filter((i) => i !== ind) : [...prev, ind]));

  const completenessFields = [
    { label: 'Profile photo', done: false },
    { label: 'Headline', done: profile.headline.length > 0 },
    { label: 'Bio (min 80 chars)', done: profile.bio.length >= 80 },
    { label: 'Username', done: profile.username.length >= 3 },
  ];

  return (
    <div
      style={{
        display: 'flex',
        gap: 24,
        alignItems: 'flex-start',
        animation: 'slideUp 0.3s ease both',
      }}
    >
      {/* Form — left */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 18 }}>
        {/* Photo + Identity */}
        <Card style={{ padding: '20px 22px' }}>
          <SectionLabel icon={Icons.camera} color={c.primary}>
            Photo
          </SectionLabel>
          <PhotoUpload />
          <div style={{ borderTop: `1px solid ${c.borderSubtle}`, paddingTop: 18, marginTop: 4 }}>
            <SectionLabel icon={Icons.user} color={c.primary}>
              Identity
            </SectionLabel>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div>
                <FieldLabel hint="· Read-only">Name</FieldLabel>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                  <Input value="Abayomi" disabled />
                  <Input value="Joseph" disabled />
                </div>
              </div>
              <div>
                <FieldLabel>Username</FieldLabel>
                <Input
                  value={profile.username}
                  onChange={(v) => onChange({ ...profile, username: v })}
                  placeholder="your-username"
                  prefix="balo.expert/@"
                  maxLength={50}
                />
                {profile.username.length >= 3 && (
                  <p
                    style={{
                      fontSize: 11,
                      color: c.success,
                      margin: '4px 0 0',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 4,
                    }}
                  >
                    <Icons.check size={11} color={c.success} />
                    balo.expert/@{profile.username} is available
                  </p>
                )}
              </div>
            </div>
          </div>
        </Card>

        {/* Headline + Bio */}
        <Card style={{ padding: '20px 22px' }}>
          <SectionLabel icon={Icons.sparkles} color={c.accent}>
            Public profile
          </SectionLabel>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div>
              <FieldLabel counter={<CharCounter current={profile.headline.length} max={100} />}>
                Headline
              </FieldLabel>
              <Input
                value={profile.headline}
                onChange={(v) => v.length <= 100 && onChange({ ...profile, headline: v })}
                placeholder="e.g. Salesforce Architect specialising in Sales Cloud & integrations"
                maxLength={100}
              />
              <p style={{ fontSize: 11, color: c.textTertiary, margin: '4px 0 0' }}>
                Shown under your name in search results and on your profile card.
              </p>
            </div>
            <div>
              <FieldLabel counter={<CharCounter current={profile.bio.length} max={1000} />}>
                Bio
              </FieldLabel>
              <Textarea
                value={profile.bio}
                onChange={(v) => v.length <= 1000 && onChange({ ...profile, bio: v })}
                placeholder="Tell clients about your experience, the problems you solve, and what makes you the right expert for them…"
                maxLength={1000}
                rows={4}
              />
            </div>
          </div>
        </Card>

        {/* Industries */}
        <Card style={{ padding: '20px 22px' }}>
          <SectionLabel icon={Icons.briefcase} color={c.cyan}>
            Industries
          </SectionLabel>
          <ChipPicker selected={industries} onToggle={toggleIndustry} />
        </Card>

        {/* Languages */}
        <Card style={{ padding: '20px 22px' }}>
          <SectionLabel icon={Icons.globe} color={c.emerald}>
            Languages
          </SectionLabel>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
            <LangPill name="English" flag="🇦🇺" prof="Native" />
            <LangPill name="Yoruba" flag="🇳🇬" prof="Conversational" />
          </div>
          <button
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 5,
              padding: '6px 13px',
              borderRadius: 8,
              fontSize: 12,
              fontWeight: 600,
              cursor: 'pointer',
              border: `1px dashed ${c.border}`,
              background: 'transparent',
              color: c.primary,
            }}
          >
            <Icons.plus size={13} color={c.primary} /> Add language
          </button>
        </Card>

        {/* Save row */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          <button
            style={{
              padding: '10px 18px',
              borderRadius: 10,
              fontSize: 13,
              fontWeight: 600,
              cursor: 'pointer',
              border: `1px solid ${c.border}`,
              background: 'transparent',
              color: c.textSecondary,
            }}
          >
            Reset changes
          </button>
          <button
            style={{
              padding: '10px 22px',
              borderRadius: 10,
              fontSize: 13,
              fontWeight: 650,
              cursor: 'pointer',
              border: 'none',
              background: c.gradient,
              color: 'white',
              boxShadow: `0 2px 10px ${c.primaryGlow}`,
            }}
          >
            Save profile
          </button>
        </div>
      </div>

      {/* Preview — right (sticky) */}
      <div
        style={{ width: 280, flexShrink: 0, position: 'sticky', top: 20, alignSelf: 'flex-start' }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            marginBottom: 12,
            padding: '6px 10px',
            borderRadius: 7,
            background: c.surfaceSubtle,
            border: `1px solid ${c.borderSubtle}`,
            width: 'fit-content',
          }}
        >
          <Icons.eye size={12} color={c.textTertiary} />
          <span
            style={{
              fontSize: 10,
              fontWeight: 700,
              color: c.textTertiary,
              textTransform: 'uppercase',
              letterSpacing: '0.07em',
            }}
          >
            Live preview
          </span>
          <div
            style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: c.success,
              animation: 'pulse 2s ease infinite',
            }}
          />
        </div>
        <MarketplacePreviewCard headline={profile.headline} bio={profile.bio} />
        <Card style={{ marginTop: 12, padding: '14px 16px' }}>
          <CompletenessBar fields={completenessFields} />
        </Card>
      </div>
    </div>
  );
}

// ── Expertise sub-tab ────────────────────────────────────────────
function ExpertiseSubTab() {
  const products = [
    { name: 'Sales Cloud', color: '#0176D3', scores: [9, 8, 9, 7] },
    { name: 'Service Cloud', color: '#04AAA4', scores: [8, 7, 6, 9] },
    { name: 'Experience Cloud', color: '#7B5EA7', scores: [7, 6, 8, 5] },
  ];
  const dims = ['Configuration', 'Integration', 'Admin', 'Dev'];
  return (
    <div style={{ animation: 'slideUp 0.3s ease both' }}>
      <div
        style={{
          display: 'flex',
          gap: 10,
          padding: '13px 16px',
          borderRadius: 11,
          background: c.warningLight,
          border: `1px solid ${c.warningBorder}`,
          marginBottom: 20,
        }}
      >
        <Icons.lock size={15} color={c.warning} />
        <div>
          <p style={{ fontSize: 13, fontWeight: 700, color: c.warning, margin: 0 }}>
            Expertise locked after approval
          </p>
          <p style={{ fontSize: 12, color: c.warning, opacity: 0.8, margin: '3px 0 0' }}>
            Verified during onboarding.{' '}
            <span style={{ fontWeight: 600, textDecoration: 'underline', cursor: 'pointer' }}>
              Contact support
            </span>{' '}
            to request changes.
          </p>
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {products.map(({ name, color, scores }) => (
          <div
            key={name}
            style={{
              padding: '16px 18px',
              borderRadius: 12,
              border: `1px solid ${c.border}`,
              background: c.surface,
              opacity: 0.75,
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                marginBottom: 12,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                <div style={{ width: 7, height: 7, borderRadius: '50%', background: color }} />
                <span style={{ fontSize: 14, fontWeight: 650, color: c.text }}>{name}</span>
              </div>
              <span
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  padding: '2px 8px',
                  borderRadius: 5,
                  background: c.warningLight,
                  color: c.warning,
                  border: `1px solid ${c.warningBorder}`,
                }}
              >
                Locked
              </span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px 16px' }}>
              {dims.map((dim, i) => (
                <div key={dim}>
                  <div
                    style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}
                  >
                    <span style={{ fontSize: 10, color: c.textTertiary }}>{dim}</span>
                    <span style={{ fontSize: 10, fontWeight: 600, color: c.textTertiary }}>
                      {scores[i]}/10
                    </span>
                  </div>
                  <div style={{ height: 3, borderRadius: 2, background: c.surfaceSubtle }}>
                    <div
                      style={{
                        width: `${scores[i] * 10}%`,
                        height: '100%',
                        borderRadius: 2,
                        background: `${color}80`,
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div style={{ textAlign: 'center', marginTop: 18 }}>
        <button
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '9px 18px',
            borderRadius: 9,
            fontSize: 13,
            fontWeight: 600,
            cursor: 'pointer',
            border: `1px solid ${c.border}`,
            background: c.surface,
            color: c.textSecondary,
          }}
        >
          <Icons.alertCircle size={13} color={c.textTertiary} /> Request expertise changes
        </button>
      </div>
    </div>
  );
}

// ── Work History sub-tab ─────────────────────────────────────────
function WorkHistorySubTab() {
  const history = [
    {
      role: 'Senior Salesforce Architect',
      company: 'Telstra',
      period: 'Jan 2022 – Present',
      current: true,
    },
    {
      role: 'Salesforce Technical Lead',
      company: 'Deloitte Digital',
      period: 'Mar 2019 – Dec 2021',
    },
    { role: 'Salesforce Developer', company: 'MYOB', period: 'Jun 2017 – Feb 2019' },
  ];
  return (
    <div style={{ animation: 'slideUp 0.3s ease both' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 7, marginBottom: 12 }}>
        {history.map((h, i) => (
          <div
            key={i}
            style={{
              display: 'flex',
              gap: 11,
              padding: '12px 14px',
              borderRadius: 10,
              border: `1px solid ${c.borderSubtle}`,
              background: c.surface,
            }}
          >
            <div
              style={{
                width: 32,
                height: 32,
                borderRadius: 7,
                flexShrink: 0,
                background: c.surfaceSubtle,
                border: `1px solid ${c.border}`,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 11,
                fontWeight: 700,
                color: c.textSecondary,
              }}
            >
              {h.company[0]}
            </div>
            <div style={{ flex: 1 }}>
              <p style={{ fontSize: 13, fontWeight: 650, color: c.text, margin: 0 }}>{h.role}</p>
              <p style={{ fontSize: 12, color: c.textSecondary, margin: '1px 0 0' }}>{h.company}</p>
              <p style={{ fontSize: 11, color: c.textTertiary, margin: '1px 0 0' }}>
                {h.period}
                {h.current && (
                  <span style={{ color: c.success, fontWeight: 600, marginLeft: 5 }}>
                    · Current
                  </span>
                )}
              </p>
            </div>
            <button
              style={{
                padding: 5,
                borderRadius: 6,
                border: `1px solid ${c.border}`,
                background: 'none',
                cursor: 'pointer',
                display: 'flex',
                alignSelf: 'flex-start',
              }}
            >
              <Icons.trash size={12} color={c.textTertiary} />
            </button>
          </div>
        ))}
      </div>
      <button
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 7,
          width: '100%',
          justifyContent: 'center',
          padding: '10px',
          borderRadius: 10,
          fontSize: 13,
          fontWeight: 600,
          cursor: 'pointer',
          border: `1px dashed ${c.border}`,
          background: 'transparent',
          color: c.primary,
        }}
      >
        <Icons.plus size={14} color={c.primary} /> Add position
      </button>
    </div>
  );
}

// ── Certifications sub-tab ───────────────────────────────────────
function CertificationsSubTab() {
  const certs = [
    { name: 'Salesforce Administrator', category: 'Core', locked: true },
    { name: 'Platform Developer I', category: 'Developer', locked: true },
    { name: 'Sales Cloud Consultant', category: 'Consultant', locked: true },
    { name: 'Service Cloud Consultant', category: 'Consultant', locked: false },
  ];
  return (
    <div style={{ animation: 'slideUp 0.3s ease both' }}>
      <div
        style={{
          display: 'flex',
          gap: 8,
          padding: '11px 14px',
          borderRadius: 9,
          background: c.primaryLight,
          border: `1px solid ${c.primaryBorder}`,
          marginBottom: 14,
          fontSize: 12,
          color: c.primary,
        }}
      >
        <Icons.sparkles size={13} color={c.primary} />
        <span>Locked certifications were verified during onboarding. Add new ones anytime.</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 7, marginBottom: 14 }}>
        {certs.map((cert, i) => (
          <div
            key={i}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '9px 12px',
              borderRadius: 9,
              border: `1px solid ${c.borderSubtle}`,
            }}
          >
            <div
              style={{
                width: 28,
                height: 28,
                borderRadius: 6,
                flexShrink: 0,
                background: `${c.accent}10`,
                border: `1px solid ${c.accentBorder}`,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Icons.award size={13} color={c.accent} />
            </div>
            <div style={{ flex: 1 }}>
              <p
                style={{
                  fontSize: 12,
                  fontWeight: 650,
                  color: cert.locked ? c.textTertiary : c.text,
                  margin: 0,
                }}
              >
                {cert.name}
              </p>
              <p style={{ fontSize: 11, color: c.textTertiary, margin: 0 }}>{cert.category}</p>
            </div>
            {cert.locked ? (
              <span
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  padding: '2px 7px',
                  borderRadius: 5,
                  background: c.warningLight,
                  color: c.warning,
                  border: `1px solid ${c.warningBorder}`,
                }}
              >
                Locked
              </span>
            ) : (
              <button
                style={{
                  padding: 4,
                  borderRadius: 5,
                  border: `1px solid ${c.border}`,
                  background: 'none',
                  cursor: 'pointer',
                  display: 'flex',
                }}
              >
                <Icons.trash size={12} color={c.textTertiary} />
              </button>
            )}
          </div>
        ))}
      </div>
      <div style={{ marginBottom: 14 }}>
        <FieldLabel>Trailhead profile URL</FieldLabel>
        <Input value="https://trailhead.salesforce.com/en/users/abayomi" onChange={() => {}} />
      </div>
      <button
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 7,
          width: '100%',
          justifyContent: 'center',
          padding: '10px',
          borderRadius: 10,
          fontSize: 13,
          fontWeight: 600,
          cursor: 'pointer',
          border: `1px dashed ${c.border}`,
          background: 'transparent',
          color: c.primary,
        }}
      >
        <Icons.plus size={14} color={c.primary} /> Add certification
      </button>
    </div>
  );
}

// ── Placeholder for other main tabs ─────────────────────────────
function PlaceholderContent({ icon: I, label }) {
  return (
    <div
      style={{
        padding: '64px 40px',
        textAlign: 'center',
        borderRadius: 16,
        border: `1px dashed ${c.border}`,
        animation: 'slideUp 0.3s ease both',
      }}
    >
      <div
        style={{
          width: 44,
          height: 44,
          borderRadius: 11,
          margin: '0 auto 14px',
          background: c.surfaceSubtle,
          border: `1px solid ${c.border}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <I size={20} color={c.textTertiary} />
      </div>
      <p style={{ fontSize: 14, fontWeight: 600, color: c.text, margin: 0 }}>{label}</p>
      <p style={{ fontSize: 12, color: c.textTertiary, margin: '4px 0 0' }}>
        This tab is implemented by a separate ticket
      </p>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// MAIN APP
// ══════════════════════════════════════════════════════════════════
export default function ExpertSettingsWithSubTabs() {
  const [mainTab, setMainTab] = useState('profile');
  const [subTab, setSubTab] = useState('profile');
  const [profile, setProfile] = useState({
    username: 'abayomi-joseph',
    headline: 'Salesforce Architect specialising in Sales Cloud & end-to-end integrations',
    bio: '10+ years delivering Salesforce transformations for enterprise clients across financial services and telco. I help teams move fast without breaking things.',
  });

  return (
    <div
      style={{
        display: 'flex',
        height: '100vh',
        background: c.bg,
        fontFamily: "'DM Sans', -apple-system, BlinkMacSystemFont, sans-serif",
        overflow: 'hidden',
      }}
    >
      <style>{keyframes}</style>
      <link
        href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap"
        rel="stylesheet"
      />

      {/* Sidebar */}
      <Sidebar activePage="settings" />

      {/* Main area */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <TopBar title="Expert Settings" />

        {/* Scrollable content */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '24px 32px' }}>
          {/* ── PRIMARY TABS (pill) ── */}
          <div style={{ marginBottom: 28 }}>
            <MainTabs
              activeTab={mainTab}
              onTabChange={(t) => {
                setMainTab(t);
                setSubTab('profile');
              }}
            />
          </div>

          {/* ── PROFILE MAIN TAB ── */}
          {mainTab === 'profile' && (
            <div key="profile-main">
              {/* ── SECONDARY TABS (underline) ── */}
              <SubTabs activeTab={subTab} onTabChange={setSubTab} />

              {/* Sub-tab content */}
              <div key={subTab}>
                {subTab === 'profile' && <ProfileSubTab profile={profile} onChange={setProfile} />}
                {subTab === 'expertise' && <ExpertiseSubTab />}
                {subTab === 'workHistory' && <WorkHistorySubTab />}
                {subTab === 'certifications' && <CertificationsSubTab />}
              </div>
            </div>
          )}

          {/* ── OTHER MAIN TABS ── */}
          {mainTab === 'rate' && (
            <PlaceholderContent icon={Icons.dollar} label="Rate — BAL-193 (Done)" />
          )}
          {mainTab === 'schedule' && (
            <PlaceholderContent icon={Icons.calendar} label="Schedule — BAL-194 / BAL-195" />
          )}
          {mainTab === 'payouts' && (
            <PlaceholderContent icon={Icons.credit} label="Payouts — BAL-208 (Done)" />
          )}
        </div>
      </div>
    </div>
  );
}
