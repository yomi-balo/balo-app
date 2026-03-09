import { useState, useRef } from 'react';

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
  emerald: '#059669',
  gradient: 'linear-gradient(135deg, #2563EB 0%, #7C3AED 100%)',
  gradientSubtle: 'linear-gradient(135deg, #EFF6FF 0%, #F5F3FF 100%)',
  gradientWarm: 'linear-gradient(135deg, #059669 0%, #0891B2 100%)',
};

// ── Keyframes ────────────────────────────────────────────────────
const keyframes = `
@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
@keyframes slideUp { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: translateY(0); } }
@keyframes shimmer { 0%,100% { opacity: 0.4; } 50% { opacity: 0.7; } }
@keyframes popIn { 0% { transform: scale(0.85); opacity: 0; } 60% { transform: scale(1.05); } 100% { transform: scale(1); opacity: 1; } }
@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.5; } }
`;

// ── Icons ────────────────────────────────────────────────────────
const Icon = ({ d, size = 16, color = 'currentColor', strokeWidth = 2 }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke={color}
    strokeWidth={strokeWidth}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d={d} />
  </svg>
);
const Icons = {
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
  camera: (p) => (
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
      <path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z" />
      <circle cx="12" cy="13" r="4" />
    </svg>
  ),
  eye: (p) => (
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
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  ),
  link: (p) => (
    <Icon
      {...p}
      d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"
    />
  ),
  star: (p) => (
    <svg
      width={p.size || 16}
      height={p.size || 16}
      viewBox="0 0 24 24"
      fill={p.fill || 'none'}
      stroke={p.color || 'currentColor'}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
    </svg>
  ),
  check: (p) => <Icon {...p} d="M20 6L9 17l-5-5" />,
  x: (p) => <Icon {...p} d="M18 6L6 18M6 6l12 12" />,
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
    >
      <rect x="3" y="11" width="18" height="11" rx="2" />
      <path d="M7 11V7a5 5 0 0110 0v4" />
    </svg>
  ),
  upload: (p) => (
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
      <polyline points="16 16 12 12 8 16" />
      <line x1="12" y1="12" x2="12" y2="21" />
      <path d="M20.39 18.39A5 5 0 0018 9h-1.26A8 8 0 103 16.3" />
    </svg>
  ),
  briefcase: (p) => (
    <Icon
      {...p}
      d="M20 7H4a2 2 0 00-2 2v10a2 2 0 002 2h16a2 2 0 002-2V9a2 2 0 00-2-2zM16 21V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v16"
    />
  ),
  award: (p) => (
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
      <circle cx="12" cy="8" r="7" />
      <polyline points="8.21 13.89 7 23 12 20 17 23 15.79 13.88" />
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
    >
      <path d="M12 3v2m0 14v2m-7-9H3m18 0h-2m-1.636-6.364l-1.414 1.414M7.05 16.95l-1.414 1.414m0-12.728l1.414 1.414m9.9 9.9l1.414 1.414" />
      <circle cx="12" cy="12" r="4" />
    </svg>
  ),
  chevRight: (p) => <Icon {...p} d="M9 18l6-6-6-6" />,
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
  globe: (p) => (
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
      <path d="M2 12h20M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10A15.3 15.3 0 0112 2z" />
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
    >
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
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
    >
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6M10 11v6M14 11v6M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2" />
    </svg>
  ),
};

// ── Shared Components ────────────────────────────────────────────
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

function SectionLabel({ icon: IconComp, color, children }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 14 }}>
      <IconComp size={13} color={color || c.textTertiary} />
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

function CharCounter({ current, max, warn = 0.8 }) {
  const ratio = current / max;
  const color = ratio >= 1 ? c.error : ratio >= warn ? c.warning : c.textTertiary;
  return (
    <span
      style={{ fontSize: 11, color, fontVariantNumeric: 'tabular-nums', transition: 'color 0.2s' }}
    >
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
      <div>
        <span style={{ fontSize: 13, fontWeight: 600, color: c.text }}>{children}</span>
        {hint && <span style={{ fontSize: 12, color: c.textTertiary, marginLeft: 6 }}>{hint}</span>}
      </div>
      {counter}
    </div>
  );
}

function Input({ value, onChange, placeholder, style: xs, maxLength, disabled, prefix, suffix }) {
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
        overflow: 'hidden',
        ...xs,
      }}
    >
      {prefix && (
        <span
          style={{
            padding: '0 10px 0 14px',
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
          padding: prefix ? '10px 14px 10px 0' : '10px 14px',
          fontSize: 14,
          color: c.text,
          border: 'none',
          outline: 'none',
          background: 'transparent',
        }}
      />
      {suffix && (
        <span
          style={{
            padding: '0 14px 0 4px',
            fontSize: 13,
            color: c.textTertiary,
            userSelect: 'none',
          }}
        >
          {suffix}
        </span>
      )}
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
        padding: '10px 14px',
        fontSize: 14,
        color: c.text,
        border: `1px solid ${focused ? c.primary : c.border}`,
        borderRadius: 10,
        outline: 'none',
        resize: 'none',
        lineHeight: 1.6,
        boxShadow: focused ? `0 0 0 3px ${c.primaryGlow}` : 'none',
        transition: 'all 0.2s',
        fontFamily: 'inherit',
        background: c.surface,
        boxSizing: 'border-box',
      }}
    />
  );
}

// ── Photo Upload Zone ────────────────────────────────────────────
function PhotoUpload({ photo, onPhotoChange }) {
  const [hovering, setHovering] = useState(false);
  const [dragging, setDragging] = useState(false);

  const initials = 'YJ';

  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 24, marginBottom: 28 }}>
      {/* Avatar */}
      <div
        style={{ position: 'relative', flexShrink: 0 }}
        onMouseEnter={() => setHovering(true)}
        onMouseLeave={() => setHovering(false)}
      >
        <div
          style={{
            width: 88,
            height: 88,
            borderRadius: '50%',
            background: photo ? 'transparent' : c.gradient,
            border: dragging
              ? `2px dashed ${c.primary}`
              : `2px solid ${hovering ? c.primaryBorder : 'transparent'}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            position: 'relative',
            overflow: 'hidden',
            cursor: 'pointer',
            transition: 'all 0.2s',
            boxShadow: hovering ? `0 0 0 4px ${c.primaryGlow}` : 'none',
          }}
        >
          {photo ? (
            <img
              src={photo}
              alt="Profile"
              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
            />
          ) : (
            <span style={{ fontSize: 24, fontWeight: 700, color: 'white' }}>{initials}</span>
          )}

          {/* Hover overlay */}
          <div
            style={{
              position: 'absolute',
              inset: 0,
              background: 'rgba(0,0,0,0.5)',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 4,
              opacity: hovering ? 1 : 0,
              transition: 'opacity 0.2s',
            }}
          >
            <Icons.camera size={18} color="white" />
            <span style={{ fontSize: 10, color: 'white', fontWeight: 600 }}>Change</span>
          </div>
        </div>

        {/* Online indicator */}
        <div
          style={{
            position: 'absolute',
            bottom: 2,
            right: 2,
            width: 16,
            height: 16,
            borderRadius: '50%',
            background: c.success,
            border: '2px solid white',
          }}
        />
      </div>

      {/* Upload instructions */}
      <div style={{ flex: 1 }}>
        <p style={{ fontSize: 14, fontWeight: 600, color: c.text, margin: '0 0 4px' }}>
          Profile Photo
        </p>
        <p style={{ fontSize: 12, color: c.textTertiary, margin: '0 0 12px', lineHeight: 1.5 }}>
          A professional headshot helps clients feel confident booking you. JPG or PNG, at least
          400×400px.
        </p>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '7px 14px',
              borderRadius: 8,
              fontSize: 13,
              fontWeight: 600,
              cursor: 'pointer',
              border: `1px solid ${c.border}`,
              background: c.surface,
              color: c.text,
            }}
          >
            <Icons.upload size={13} color={c.textSecondary} />
            Upload photo
          </button>
          {photo && (
            <button
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '7px 14px',
                borderRadius: 8,
                fontSize: 13,
                fontWeight: 500,
                cursor: 'pointer',
                border: `1px solid ${c.borderSubtle}`,
                background: 'transparent',
                color: c.textTertiary,
              }}
            >
              Remove
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Chip Picker (Industries / Tags) ──────────────────────────────
const INDUSTRIES = [
  'Financial Services',
  'Healthcare',
  'Retail & eCommerce',
  'Manufacturing',
  'Technology',
  'Education',
  'Government',
  'Nonprofit',
  'Real Estate',
  'Media & Entertainment',
];

function ChipPicker({ label, selected, onToggle, options }) {
  return (
    <div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {options.map((opt) => {
          const active = selected.includes(opt);
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
                background: active ? c.gradient : c.surfaceSubtle,
                color: active ? 'white' : c.textSecondary,
                boxShadow: active ? `0 2px 8px ${c.primaryGlow}` : 'none',
              }}
            >
              {opt}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── Language Row ─────────────────────────────────────────────────
const LANG_PROFICIENCIES = ['Conversational', 'Professional', 'Native'];

function LanguageRow({ lang, proficiency, onRemove }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '8px 12px',
        borderRadius: 8,
        background: c.surfaceSubtle,
        border: `1px solid ${c.borderSubtle}`,
      }}
    >
      <span style={{ fontSize: 18 }}>{lang.flag}</span>
      <span style={{ fontSize: 13, fontWeight: 550, color: c.text, flex: 1 }}>{lang.name}</span>
      <span
        style={{
          fontSize: 11,
          padding: '2px 8px',
          borderRadius: 10,
          background: c.primaryLight,
          color: c.primary,
          fontWeight: 600,
        }}
      >
        {proficiency}
      </span>
      <button
        onClick={onRemove}
        style={{
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          padding: 2,
          display: 'flex',
        }}
      >
        <Icons.x size={13} color={c.textTertiary} />
      </button>
    </div>
  );
}

// ── Work History Card ────────────────────────────────────────────
function WorkHistoryCard({ role, company, period, current }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 12,
        padding: '14px 16px',
        borderRadius: 12,
        border: `1px solid ${c.border}`,
        background: c.surface,
        position: 'relative',
      }}
    >
      <div
        style={{
          width: 36,
          height: 36,
          borderRadius: 8,
          flexShrink: 0,
          background: c.surfaceSubtle,
          border: `1px solid ${c.border}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 13,
          fontWeight: 700,
          color: c.textSecondary,
        }}
      >
        {company[0]}
      </div>
      <div style={{ flex: 1 }}>
        <p style={{ fontSize: 14, fontWeight: 600, color: c.text, margin: 0 }}>{role}</p>
        <p style={{ fontSize: 12, color: c.textSecondary, margin: '2px 0' }}>{company}</p>
        <p style={{ fontSize: 11, color: c.textTertiary, margin: 0 }}>
          {period}
          {current && (
            <span style={{ marginLeft: 6, color: c.success, fontWeight: 600 }}>· Current</span>
          )}
        </p>
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <button
          style={{
            padding: 6,
            borderRadius: 6,
            border: `1px solid ${c.border}`,
            background: 'none',
            cursor: 'pointer',
            display: 'flex',
          }}
        >
          <Icons.briefcase size={13} color={c.textTertiary} />
        </button>
        <button
          style={{
            padding: 6,
            borderRadius: 6,
            border: `1px solid ${c.border}`,
            background: 'none',
            cursor: 'pointer',
            display: 'flex',
          }}
        >
          <Icons.trash size={13} color={c.textTertiary} />
        </button>
      </div>
    </div>
  );
}

// ── Cert Card ────────────────────────────────────────────────────
function CertCard({ name, category, locked }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '10px 12px',
        borderRadius: 10,
        border: `1px solid ${c.border}`,
        background: locked ? c.surfaceSubtle : c.surface,
      }}
    >
      <div
        style={{
          width: 32,
          height: 32,
          borderRadius: 7,
          flexShrink: 0,
          background: `${c.accent}10`,
          border: `1px solid ${c.accentBorder}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Icons.award size={15} color={c.accent} />
      </div>
      <div style={{ flex: 1 }}>
        <p
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: locked ? c.textTertiary : c.text,
            margin: 0,
          }}
        >
          {name}
        </p>
        <p style={{ fontSize: 11, color: c.textTertiary, margin: '1px 0 0' }}>{category}</p>
      </div>
      {locked && (
        <span
          style={{
            fontSize: 10,
            fontWeight: 700,
            padding: '2px 8px',
            borderRadius: 6,
            background: c.warningLight,
            color: c.warning,
            border: `1px solid ${c.warningBorder}`,
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
          }}
        >
          Locked
        </span>
      )}
    </div>
  );
}

// ── Live Preview Card ─────────────────────────────────────────────
function MarketplacePreviewCard({
  photo,
  name,
  headline,
  bio,
  industries,
  rating,
  reviewCount,
  rate,
}) {
  const hasPhoto = !!photo;
  const hasHeadline = !!headline.trim();
  const hasBio = !!bio.trim();
  const isEmpty = !hasHeadline && !hasBio && industries.length === 0;

  return (
    <div
      style={{
        borderRadius: 14,
        border: `1px solid ${c.border}`,
        boxShadow: '0 4px 24px rgba(0,0,0,0.07)',
        overflow: 'hidden',
        background: c.surface,
        transition: 'all 0.3s ease',
      }}
    >
      {/* Card top — gradient banner */}
      <div
        style={{
          height: 64,
          background: c.gradientSubtle,
          borderBottom: `1px solid ${c.borderSubtle}`,
          position: 'relative',
        }}
      >
        {/* SF Logo badge */}
        <div
          style={{
            position: 'absolute',
            top: 10,
            right: 12,
            padding: '3px 10px',
            borderRadius: 20,
            fontSize: 10,
            fontWeight: 700,
            background: 'white',
            color: c.primary,
            border: `1px solid ${c.primaryBorder}`,
            boxShadow: '0 1px 4px rgba(0,0,0,0.06)',
          }}
        >
          Salesforce
        </div>
      </div>

      <div style={{ padding: '0 16px 16px' }}>
        {/* Avatar — overlaps banner */}
        <div
          style={{
            marginTop: -26,
            marginBottom: 10,
            display: 'flex',
            alignItems: 'flex-end',
            justifyContent: 'space-between',
          }}
        >
          <div
            style={{
              width: 52,
              height: 52,
              borderRadius: '50%',
              background: hasPhoto ? 'transparent' : c.gradient,
              border: '3px solid white',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 18,
              fontWeight: 700,
              color: 'white',
              overflow: 'hidden',
              boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
            }}
          >
            {hasPhoto ? (
              <img
                src={photo}
                alt=""
                style={{ width: '100%', height: '100%', objectFit: 'cover' }}
              />
            ) : (
              'YJ'
            )}
          </div>

          {/* Rate */}
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 17, fontWeight: 700, color: c.text }}>
              A${rate || '—'}
              <span style={{ fontSize: 11, fontWeight: 500, color: c.textTertiary }}>/min</span>
            </div>
          </div>
        </div>

        {/* Name + verified */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
          <p style={{ fontSize: 15, fontWeight: 700, color: c.text, margin: 0 }}>{name}</p>
          <Icons.check size={13} color={c.success} />
        </div>

        {/* Headline */}
        <p
          style={{
            fontSize: 12,
            color: hasHeadline ? c.textSecondary : c.textTertiary,
            margin: '0 0 8px',
            lineHeight: 1.4,
            animation: hasHeadline ? 'fadeIn 0.3s ease' : 'none',
            fontStyle: hasHeadline ? 'normal' : 'italic',
            minHeight: 18,
          }}
        >
          {hasHeadline ? headline : 'Your headline will appear here…'}
        </p>

        {/* Stars */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 10 }}>
          {[1, 2, 3, 4, 5].map((i) => (
            <Icons.star key={i} size={11} color="#F59E0B" fill="#F59E0B" />
          ))}
          <span style={{ fontSize: 11, fontWeight: 600, color: c.text }}>{rating}</span>
          <span style={{ fontSize: 11, color: c.textTertiary }}>({reviewCount} reviews)</span>
        </div>

        {/* Bio snippet */}
        {hasBio && (
          <p
            style={{
              fontSize: 11.5,
              color: c.textSecondary,
              margin: '0 0 10px',
              lineHeight: 1.55,
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
              animation: 'fadeIn 0.3s ease',
            }}
          >
            {bio}
          </p>
        )}

        {/* Industry chips */}
        {industries.length > 0 && (
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 5,
              marginBottom: 12,
              animation: 'fadeIn 0.3s ease',
            }}
          >
            {industries.slice(0, 3).map((ind) => (
              <span
                key={ind}
                style={{
                  fontSize: 10,
                  fontWeight: 600,
                  padding: '2px 8px',
                  borderRadius: 10,
                  background: c.surfaceSubtle,
                  color: c.textSecondary,
                  border: `1px solid ${c.borderSubtle}`,
                }}
              >
                {ind}
              </span>
            ))}
            {industries.length > 3 && (
              <span style={{ fontSize: 10, color: c.textTertiary }}>
                +{industries.length - 3} more
              </span>
            )}
          </div>
        )}

        {/* CTA */}
        <button
          style={{
            width: '100%',
            padding: '9px 0',
            borderRadius: 9,
            fontSize: 13,
            fontWeight: 650,
            border: 'none',
            background: c.gradient,
            color: 'white',
            cursor: 'pointer',
            boxShadow: `0 2px 8px ${c.primaryGlow}`,
          }}
        >
          Book a Consultation
        </button>
      </div>
    </div>
  );
}

// ── Profile Completeness ─────────────────────────────────────────
function CompletenessBar({ fields }) {
  const total = fields.length;
  const done = fields.filter((f) => f.done).length;
  const pct = Math.round((done / total) * 100);
  const color = pct < 40 ? c.error : pct < 80 ? c.warning : c.success;

  return (
    <div>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 8,
        }}
      >
        <span style={{ fontSize: 12, fontWeight: 600, color: c.text }}>Profile completeness</span>
        <span style={{ fontSize: 12, fontWeight: 700, color }}>{pct}%</span>
      </div>
      <div style={{ height: 4, borderRadius: 2, background: c.surfaceSubtle, overflow: 'hidden' }}>
        <div
          style={{
            width: `${pct}%`,
            height: '100%',
            borderRadius: 2,
            background: pct < 40 ? c.error : pct < 80 ? c.warning : c.gradientWarm,
            transition: 'width 0.5s cubic-bezier(0.4,0,0.2,1)',
          }}
        />
      </div>
      <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 5 }}>
        {fields.map((f) => (
          <div key={f.label} style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <div
              style={{
                width: 16,
                height: 16,
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
              {f.done && <Icons.check size={9} color="white" />}
            </div>
            <span
              style={{
                fontSize: 12,
                color: f.done ? c.textSecondary : c.textTertiary,
                transition: 'color 0.2s',
              }}
            >
              {f.label}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Expertise Tab ────────────────────────────────────────────────
function ExpertiseTab() {
  const skills = [
    { product: 'Sales Cloud', bars: [0.9, 0.85, 0.95, 0.7], color: '#0176D3' },
    { product: 'Service Cloud', bars: [0.8, 0.75, 0.6, 0.9], color: '#04AAA4' },
    { product: 'Experience Cloud', bars: [0.7, 0.65, 0.8, 0.55], color: '#7B5EA7' },
  ];
  const competencies = ['Configuration', 'Integration', 'Administration', 'Development'];

  return (
    <div style={{ animation: 'slideUp 0.3s ease both' }}>
      {/* Locked banner */}
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: 12,
          padding: '14px 18px',
          borderRadius: 12,
          background: c.warningLight,
          border: `1px solid ${c.warningBorder}`,
          marginBottom: 24,
        }}
      >
        <Icons.lock size={16} color={c.warning} style={{ marginTop: 1, flexShrink: 0 }} />
        <div>
          <p style={{ fontSize: 13, fontWeight: 700, color: c.warning, margin: 0 }}>
            Expertise is locked after approval
          </p>
          <p style={{ fontSize: 12, color: c.warning, margin: '3px 0 0', opacity: 0.8 }}>
            Your skills and certifications were verified by Balo during onboarding. To request
            changes,{' '}
            <span style={{ fontWeight: 600, textDecoration: 'underline', cursor: 'pointer' }}>
              contact support
            </span>
            .
          </p>
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {skills.map(({ product, bars, color }) => (
          <Card key={product} style={{ padding: '16px 20px', opacity: 0.8 }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                marginBottom: 12,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div
                  style={{
                    width: 28,
                    height: 28,
                    borderRadius: 7,
                    background: `${color}15`,
                    border: `1px solid ${color}30`,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Icons.shield size={13} color={color} />
                </div>
                <span style={{ fontSize: 14, fontWeight: 650, color: c.text }}>{product}</span>
              </div>
              <span
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  padding: '2px 8px',
                  borderRadius: 6,
                  background: c.warningLight,
                  color: c.warning,
                  border: `1px solid ${c.warningBorder}`,
                  textTransform: 'uppercase',
                }}
              >
                Locked
              </span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              {bars.map((val, i) => (
                <div key={i}>
                  <div
                    style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}
                  >
                    <span style={{ fontSize: 10, color: c.textTertiary }}>{competencies[i]}</span>
                    <span style={{ fontSize: 10, fontWeight: 600, color: c.textTertiary }}>
                      {Math.round(val * 10)}/10
                    </span>
                  </div>
                  <div
                    style={{
                      height: 4,
                      borderRadius: 2,
                      background: c.surfaceSubtle,
                      overflow: 'hidden',
                    }}
                  >
                    <div
                      style={{
                        width: `${val * 100}%`,
                        height: '100%',
                        borderRadius: 2,
                        background: `${color}60`,
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </Card>
        ))}
      </div>

      <div style={{ textAlign: 'center', marginTop: 20 }}>
        <button
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 7,
            padding: '9px 20px',
            borderRadius: 9,
            fontSize: 13,
            fontWeight: 600,
            cursor: 'pointer',
            border: `1px solid ${c.border}`,
            background: c.surface,
            color: c.textSecondary,
          }}
        >
          <Icons.alertCircle size={14} color={c.textTertiary} /> Request changes to expertise
        </button>
      </div>
    </div>
  );
}

// ── Work History Tab ─────────────────────────────────────────────
function WorkHistoryTab() {
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
      current: false,
    },
    {
      role: 'Salesforce Developer',
      company: 'MYOB',
      period: 'Jun 2017 – Feb 2019',
      current: false,
    },
  ];

  return (
    <div style={{ animation: 'slideUp 0.3s ease both' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 16 }}>
        {history.map((h, i) => (
          <WorkHistoryCard key={i} {...h} />
        ))}
      </div>
      <button
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '9px 18px',
          borderRadius: 10,
          fontSize: 13,
          fontWeight: 600,
          cursor: 'pointer',
          border: `1px dashed ${c.border}`,
          background: 'transparent',
          color: c.primary,
          width: '100%',
          justifyContent: 'center',
        }}
      >
        <Icons.plus size={14} color={c.primary} /> Add position
      </button>
    </div>
  );
}

// ── Certifications Tab ───────────────────────────────────────────
function CertificationsTab() {
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
          alignItems: 'flex-start',
          gap: 12,
          padding: '12px 16px',
          borderRadius: 10,
          background: c.primaryLight,
          border: `1px solid ${c.primaryBorder}`,
          marginBottom: 18,
          fontSize: 12,
          color: c.primary,
        }}
      >
        <Icons.sparkles size={14} color={c.primary} />
        <p style={{ margin: 0, lineHeight: 1.5 }}>
          Certifications with the <strong>Locked</strong> badge were verified during onboarding. You
          can add additional certifications anytime.
        </p>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
        {certs.map((cert, i) => (
          <CertCard key={i} {...cert} />
        ))}
      </div>

      <div style={{ marginBottom: 16 }}>
        <FieldLabel children="Trailhead URL" />
        <Input
          value="https://trailhead.salesforce.com/en/users/abayomi"
          prefix={<Icons.link size={13} color={c.textTertiary} />}
        />
      </div>

      <button
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '9px 18px',
          borderRadius: 10,
          fontSize: 13,
          fontWeight: 600,
          cursor: 'pointer',
          border: `1px dashed ${c.border}`,
          background: 'transparent',
          color: c.primary,
          width: '100%',
          justifyContent: 'center',
        }}
      >
        <Icons.plus size={14} color={c.primary} /> Add certification
      </button>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// PROFILE TAB
// ══════════════════════════════════════════════════════════════════
function ProfileTab({ profile, onChange }) {
  const [industries, setIndustries] = useState(['Financial Services', 'Technology']);
  const [languages] = useState([
    { name: 'English', code: 'EN', flag: '🇦🇺' },
    { name: 'Yoruba', code: 'YO', flag: '🇳🇬' },
  ]);

  const toggleIndustry = (ind) => {
    setIndustries((prev) => (prev.includes(ind) ? prev.filter((i) => i !== ind) : [...prev, ind]));
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 24,
        animation: 'slideUp 0.3s ease both',
      }}
    >
      {/* Photo upload */}
      <Card style={{ padding: '22px 24px' }}>
        <SectionLabel icon={Icons.camera} color={c.primary}>
          Photo
        </SectionLabel>
        <PhotoUpload
          photo={profile.photo}
          onPhotoChange={(p) => onChange({ ...profile, photo: p })}
        />
      </Card>

      {/* Identity fields */}
      <Card style={{ padding: '22px 24px' }}>
        <SectionLabel icon={Icons.user} color={c.primary}>
          Identity
        </SectionLabel>

        {/* Name (locked) */}
        <div style={{ marginBottom: 16 }}>
          <FieldLabel hint="· Read-only — contact support to change">Name</FieldLabel>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <Input value="Abayomi" disabled />
            <Input value="Joseph" disabled />
          </div>
        </div>

        {/* Username */}
        <div style={{ marginBottom: 0 }}>
          <FieldLabel>Username</FieldLabel>
          <Input
            value={profile.username}
            onChange={(v) => onChange({ ...profile, username: v })}
            placeholder="abayomi-joseph"
            prefix="balo.expert/@"
          />
          {profile.username && (
            <p
              style={{
                fontSize: 11,
                color: c.success,
                margin: '5px 0 0',
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
      </Card>

      {/* Headline & Bio */}
      <Card style={{ padding: '22px 24px' }}>
        <SectionLabel icon={Icons.sparkles} color={c.accent}>
          Public profile
        </SectionLabel>

        {/* Headline */}
        <div style={{ marginBottom: 18 }}>
          <FieldLabel counter={<CharCounter current={profile.headline.length} max={100} />}>
            Headline
          </FieldLabel>
          <Input
            value={profile.headline}
            onChange={(v) => v.length <= 100 && onChange({ ...profile, headline: v })}
            placeholder="e.g. Salesforce Architect specialising in Sales Cloud & integrations"
            maxLength={100}
          />
          <p style={{ fontSize: 11, color: c.textTertiary, margin: '5px 0 0' }}>
            Shown below your name in search results and on your profile card.
          </p>
        </div>

        {/* Bio */}
        <div>
          <FieldLabel counter={<CharCounter current={profile.bio.length} max={1000} />}>
            Bio
          </FieldLabel>
          <Textarea
            value={profile.bio}
            onChange={(v) => v.length <= 1000 && onChange({ ...profile, bio: v })}
            placeholder="Tell clients about your experience, the problems you solve, and what makes you the right consultant for them…"
            maxLength={1000}
            rows={5}
          />
        </div>
      </Card>

      {/* Industries */}
      <Card style={{ padding: '22px 24px' }}>
        <SectionLabel icon={Icons.briefcase} color={c.cyan}>
          Industries
        </SectionLabel>
        <ChipPicker options={INDUSTRIES} selected={industries} onToggle={toggleIndustry} />
      </Card>

      {/* Languages */}
      <Card style={{ padding: '22px 24px' }}>
        <SectionLabel icon={Icons.globe} color={c.emerald}>
          Languages
        </SectionLabel>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 }}>
          {languages.map((lang, i) => (
            <LanguageRow
              key={i}
              lang={lang}
              proficiency={i === 0 ? 'Native' : 'Conversational'}
              onRemove={() => {}}
            />
          ))}
        </div>
        <button
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 13,
            fontWeight: 600,
            color: c.primary,
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            padding: 0,
          }}
        >
          <Icons.plus size={14} color={c.primary} /> Add language
        </button>
      </Card>

      {/* Save row */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, paddingBottom: 8 }}>
        <button
          style={{
            padding: '10px 20px',
            borderRadius: 10,
            fontSize: 14,
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
            padding: '10px 24px',
            borderRadius: 10,
            fontSize: 14,
            fontWeight: 650,
            cursor: 'pointer',
            border: 'none',
            background: c.gradient,
            color: 'white',
            boxShadow: `0 2px 12px ${c.primaryGlow}`,
          }}
        >
          Save profile
        </button>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// PREVIEW PANEL
// ══════════════════════════════════════════════════════════════════
function PreviewPanel({ profile, tab }) {
  const completenessFields = [
    { label: 'Profile photo', done: !!profile.photo },
    { label: 'Headline', done: profile.headline.length > 0 },
    { label: 'Bio', done: profile.bio.length >= 80 },
    { label: 'Username', done: profile.username.length >= 3 },
  ];

  return (
    <div
      style={{ width: 300, flexShrink: 0, position: 'sticky', top: 24, alignSelf: 'flex-start' }}
    >
      {/* Preview label */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 7,
          marginBottom: 14,
          padding: '8px 12px',
          borderRadius: 8,
          background: c.surfaceSubtle,
          border: `1px solid ${c.borderSubtle}`,
          width: 'fit-content',
        }}
      >
        <Icons.eye size={13} color={c.textTertiary} />
        <span
          style={{
            fontSize: 11,
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

      {/* Marketplace card */}
      <MarketplacePreviewCard
        photo={profile.photo}
        name="Abayomi Joseph"
        headline={profile.headline}
        bio={profile.bio}
        industries={['Financial Services', 'Technology']}
        rating="4.9"
        reviewCount="47"
        rate="3.50"
      />

      {/* Profile URL preview */}
      {profile.username && (
        <div
          style={{
            marginTop: 12,
            padding: '10px 12px',
            borderRadius: 9,
            background: c.primaryLight,
            border: `1px solid ${c.primaryBorder}`,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            animation: 'fadeIn 0.3s ease',
          }}
        >
          <Icons.link size={13} color={c.primary} />
          <span style={{ fontSize: 12, color: c.primary, fontWeight: 500, wordBreak: 'break-all' }}>
            balo.expert/@{profile.username}
          </span>
        </div>
      )}

      {/* Completeness */}
      {tab === 'profile' && (
        <Card style={{ marginTop: 12, padding: '16px 18px' }}>
          <CompletenessBar fields={completenessFields} />
        </Card>
      )}

      {/* Search snippet preview */}
      {profile.headline && tab === 'profile' && (
        <div style={{ marginTop: 12 }}>
          <p
            style={{
              fontSize: 10,
              fontWeight: 700,
              color: c.textTertiary,
              textTransform: 'uppercase',
              letterSpacing: '0.07em',
              marginBottom: 8,
            }}
          >
            Search result snippet
          </p>
          <div
            style={{
              padding: '12px 14px',
              borderRadius: 10,
              background: c.surface,
              border: `1px solid ${c.border}`,
            }}
          >
            <p style={{ fontSize: 12, color: c.primary, fontWeight: 600, margin: 0 }}>
              Abayomi Joseph · Salesforce Expert
            </p>
            <p style={{ fontSize: 11, color: c.textTertiary, margin: '2px 0 4px' }}>
              balo.expert/@{profile.username || 'your-username'}
            </p>
            <p
              style={{
                fontSize: 11,
                color: c.textSecondary,
                margin: 0,
                lineHeight: 1.5,
                display: '-webkit-box',
                WebkitLineClamp: 2,
                WebkitBoxOrient: 'vertical',
                overflow: 'hidden',
              }}
            >
              {profile.headline}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ══════════════════════════════════════════════════════════════════
export default function ExpertProfilePage() {
  const [tab, setTab] = useState('profile');
  const [profile, setProfile] = useState({
    photo: null,
    username: 'abayomi-joseph',
    headline: 'Salesforce Architect specialising in Sales Cloud & end-to-end integrations',
    bio: "10+ years delivering Salesforce transformations for enterprise clients across financial services and telco. I help teams move fast without breaking things — whether that's a greenfield Sales Cloud deployment, a complex integration, or rescuing a troubled project.",
  });

  const tabs = [
    { key: 'profile', label: 'Profile', icon: Icons.user },
    { key: 'expertise', label: 'Expertise', icon: Icons.shield },
    { key: 'workHistory', label: 'Work History', icon: Icons.briefcase },
    { key: 'certifications', label: 'Certifications', icon: Icons.award },
  ];

  const showPreview = tab === 'profile';

  return (
    <div
      style={{
        minHeight: '100vh',
        background: c.bg,
        fontFamily: "'DM Sans', -apple-system, BlinkMacSystemFont, sans-serif",
        padding: '28px 36px',
      }}
    >
      <style>{keyframes}</style>
      <link
        href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap"
        rel="stylesheet"
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
          border: `1px solid ${c.borderSubtle}`,
        }}
      >
        {tabs.map((t) => {
          const active = tab === t.key;
          const TIcon = t.icon;
          return (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 7,
                padding: '8px 18px',
                borderRadius: 8,
                fontSize: 13,
                fontWeight: 550,
                border: 'none',
                cursor: 'pointer',
                background: active ? c.surface : 'transparent',
                color: active ? c.text : c.textTertiary,
                boxShadow: active ? '0 1px 3px rgba(0,0,0,0.08)' : 'none',
                transition: 'all 0.2s',
              }}
            >
              <TIcon size={14} color={active ? c.primary : c.textTertiary} />
              {t.label}
            </button>
          );
        })}
      </div>

      {/* Content */}
      <div style={{ display: 'flex', gap: 24, alignItems: 'flex-start' }}>
        {/* Form — left column */}
        <div style={{ flex: 1, minWidth: 0 }}>
          {tab === 'profile' && <ProfileTab profile={profile} onChange={setProfile} />}
          {tab === 'expertise' && <ExpertiseTab />}
          {tab === 'workHistory' && <WorkHistoryTab />}
          {tab === 'certifications' && <CertificationsTab />}
        </div>

        {/* Live preview — right column (profile tab only) */}
        {showPreview && <PreviewPanel profile={profile} tab={tab} />}
      </div>
    </div>
  );
}
