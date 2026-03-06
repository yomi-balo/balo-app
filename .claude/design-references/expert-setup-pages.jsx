import { useState, useEffect, useRef } from 'react';

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
  cyanBorder: '#A5F3FC',
  emerald: '#059669',
  pink: '#DB2777',
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
  arrowRight: (p) => <Icon {...p} d="M5 12h14M12 5l7 7-7 7" />,
  arrowUpRight: (p) => <Icon {...p} d="M7 17L17 7M7 7h10v10" />,
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
  image: (p) => (
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
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <path d="M21 15l-5-5L5 21" />
    </svg>
  ),
  link: (p) => <Icon {...p} d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71" />,
  shield: (p) => <Icon {...p} d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />,
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
  x: (p) => <Icon {...p} d="M18 6L6 18M6 6l12 12" />,
};

// ── Animations ───────────────────────────────────────────────────
const keyframes = `
@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
@keyframes slideUp { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }
@keyframes slideInLeft { from { opacity: 0; transform: translateX(-20px); } to { opacity: 1; transform: translateX(0); } }
@keyframes scaleIn { from { transform: scale(0.95); opacity: 0; } to { transform: scale(1); opacity: 1; } }
@keyframes checkPop { 0% { transform: scale(0); } 60% { transform: scale(1.25); } 100% { transform: scale(1); } }
@keyframes progressFill { from { width: 0; } }
@keyframes confetti1 { 0% { transform: translateY(0) rotate(0); opacity:1; } 100% { transform: translateY(-90px) rotate(200deg) translateX(20px); opacity:0; } }
@keyframes confetti2 { 0% { transform: translateY(0) rotate(0); opacity:1; } 100% { transform: translateY(-70px) rotate(-150deg) translateX(-30px); opacity:0; } }
@keyframes confetti3 { 0% { transform: translateY(0) rotate(0); opacity:1; } 100% { transform: translateY(-80px) rotate(120deg) translateX(15px); opacity:0; } }
@keyframes shimmer { 0% { background-position: -200% 0; } 100% { background-position: 200% 0; } }
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
@keyframes numberCountUp { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
`;
const slideUp = { animation: 'slideUp 0.45s ease-out forwards', opacity: 0 };
const fadeIn = { animation: 'fadeIn 0.3s ease-out forwards', opacity: 0 };
const scaleIn = { animation: 'scaleIn 0.25s ease-out forwards' };
function stagger(i, base = 0.07) {
  return { animationDelay: `${i * base}s` };
}

// ── Shared Components ────────────────────────────────────────────

function SectionLabel({ children, icon: IconComp, colorKey = 'primary' }) {
  const sc = SECTION_COLORS[colorKey];
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
      <div
        style={{
          width: 26,
          height: 26,
          borderRadius: 7,
          background: sc.bg,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <IconComp size={14} color={sc.text} />
      </div>
      <p
        style={{
          fontSize: 11,
          fontWeight: 650,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          color: sc.text,
          margin: 0,
        }}
      >
        {children}
      </p>
    </div>
  );
}

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

function IconBadge({ icon: IconComp, color, size = 40, iconSize = 20 }) {
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
      }}
    >
      <IconComp size={iconSize} color={color} />
    </div>
  );
}

function InputField({
  label,
  placeholder,
  value,
  onChange,
  prefix,
  hint,
  required,
  maxLength,
  rows,
  disabled,
  readOnly,
}) {
  const isTextarea = rows && rows > 1;
  const charCount = maxLength && value ? `${value.length}/${maxLength}` : null;
  return (
    <div>
      {label && (
        <label
          style={{
            fontSize: 13,
            fontWeight: 550,
            color: c.text,
            display: 'block',
            marginBottom: 6,
          }}
        >
          {label}
          {required && <span style={{ color: c.error, marginLeft: 3 }}>*</span>}
        </label>
      )}
      <div style={{ display: 'flex', position: 'relative' }}>
        {prefix && (
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              padding: '0 12px',
              background: c.surfaceSubtle,
              border: `1px solid ${c.border}`,
              borderRight: 'none',
              borderRadius: '8px 0 0 8px',
              fontSize: 13,
              color: c.textSecondary,
              whiteSpace: 'nowrap',
            }}
          >
            {prefix}
          </span>
        )}
        {isTextarea ? (
          <textarea
            value={value}
            onChange={onChange}
            placeholder={placeholder}
            rows={rows}
            maxLength={maxLength}
            disabled={disabled}
            readOnly={readOnly}
            style={{
              width: '100%',
              padding: '10px 14px',
              fontSize: 14,
              border: `1px solid ${c.border}`,
              borderRadius: 8,
              outline: 'none',
              color: disabled ? c.textTertiary : c.text,
              background: disabled ? c.surfaceSubtle : c.surface,
              resize: 'vertical',
              fontFamily: 'inherit',
              lineHeight: 1.6,
              transition: 'border-color 0.2s, box-shadow 0.2s',
              boxSizing: 'border-box',
            }}
            onFocus={(e) => {
              if (!disabled) {
                e.target.style.borderColor = c.primary;
                e.target.style.boxShadow = `0 0 0 3px ${c.primaryGlow}`;
              }
            }}
            onBlur={(e) => {
              e.target.style.borderColor = c.border;
              e.target.style.boxShadow = 'none';
            }}
          />
        ) : (
          <input
            value={value}
            onChange={onChange}
            placeholder={placeholder}
            maxLength={maxLength}
            disabled={disabled}
            readOnly={readOnly}
            style={{
              width: '100%',
              padding: '10px 14px',
              fontSize: 14,
              border: `1px solid ${c.border}`,
              borderRadius: prefix ? '0 8px 8px 0' : 8,
              outline: 'none',
              color: disabled ? c.textTertiary : c.text,
              background: disabled ? c.surfaceSubtle : c.surface,
              transition: 'border-color 0.2s, box-shadow 0.2s',
              boxSizing: 'border-box',
            }}
            onFocus={(e) => {
              if (!disabled) {
                e.target.style.borderColor = c.primary;
                e.target.style.boxShadow = `0 0 0 3px ${c.primaryGlow}`;
              }
            }}
            onBlur={(e) => {
              e.target.style.borderColor = c.border;
              e.target.style.boxShadow = 'none';
            }}
          />
        )}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4 }}>
        {hint && <p style={{ fontSize: 12, color: c.textTertiary, margin: 0 }}>{hint}</p>}
        {charCount && (
          <p style={{ fontSize: 11, color: c.textTertiary, margin: 0, marginLeft: 'auto' }}>
            {charCount}
          </p>
        )}
      </div>
    </div>
  );
}

function Button({ children, variant = 'primary', onClick, disabled, style: xs }) {
  const [h, setH] = useState(false);
  const styles = {
    primary: {
      background: c.gradient,
      color: 'white',
      border: 'none',
      boxShadow: `0 2px 10px rgba(37,99,235,0.25)`,
    },
    secondary: {
      background: c.surface,
      color: c.text,
      border: `1px solid ${c.border}`,
    },
    ghost: {
      background: 'transparent',
      color: c.textSecondary,
      border: 'none',
    },
  };
  const s = styles[variant];
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      onMouseEnter={() => setH(true)}
      onMouseLeave={() => setH(false)}
      style={{
        padding: '10px 24px',
        borderRadius: 10,
        fontSize: 14,
        fontWeight: 600,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        transition: 'all 0.2s',
        transform: h && !disabled ? 'translateY(-1px)' : 'none',
        ...s,
        ...xs,
      }}
    >
      {children}
    </button>
  );
}

// ══════════════════════════════════════════════════════════════════
// PAGE 1: EXPERT DASHBOARD WITH GETTING STARTED CHECKLIST
// ══════════════════════════════════════════════════════════════════

function ChecklistItem({
  icon: IconComp,
  iconColor,
  label,
  description,
  complete,
  onClick,
  index,
}) {
  const [h, setH] = useState(false);
  return (
    <div
      onClick={!complete ? onClick : undefined}
      onMouseEnter={() => setH(true)}
      onMouseLeave={() => setH(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 16,
        padding: '16px 20px',
        borderRadius: 12,
        cursor: complete ? 'default' : 'pointer',
        background: h && !complete ? c.primaryLight + '40' : 'transparent',
        transition: 'all 0.2s',
        ...slideUp,
        ...stagger(index + 1),
      }}
    >
      {/* Checkbox circle */}
      <div
        style={{
          width: 32,
          height: 32,
          borderRadius: '50%',
          flexShrink: 0,
          background: complete ? c.gradient : c.surface,
          border: complete ? 'none' : `2px solid ${c.border}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          boxShadow: complete ? `0 2px 8px ${c.primaryGlow}` : 'none',
          transition: 'all 0.3s',
        }}
      >
        {complete ? (
          <span style={{ animation: 'checkPop 0.3s ease-out' }}>
            <Icons.check size={16} color="white" />
          </span>
        ) : (
          <span style={{ fontSize: 13, fontWeight: 600, color: c.textTertiary }}>{index + 1}</span>
        )}
      </div>

      {/* Icon badge */}
      <div
        style={{
          width: 36,
          height: 36,
          borderRadius: 10,
          flexShrink: 0,
          background: complete ? `${iconColor}08` : `${iconColor}12`,
          border: `1px solid ${complete ? `${iconColor}15` : `${iconColor}25`}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          opacity: complete ? 0.6 : 1,
          transition: 'all 0.3s',
        }}
      >
        <IconComp size={17} color={iconColor} />
      </div>

      {/* Text */}
      <div style={{ flex: 1 }}>
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
          {label}
        </p>
        <p style={{ fontSize: 12, color: c.textTertiary, margin: '2px 0 0' }}>{description}</p>
      </div>

      {/* Arrow */}
      {!complete && (
        <div
          style={{
            opacity: h ? 1 : 0.4,
            transition: 'opacity 0.2s',
            transform: h ? 'translateX(3px)' : 'none',
          }}
        >
          <Icons.arrowRight size={16} color={c.primary} />
        </div>
      )}
    </div>
  );
}

function GettingStartedCard({ completedItems, setPage }) {
  const total = 5;
  const done = completedItems.size;
  const pct = (done / total) * 100;
  const allDone = done === total;

  const ITEMS = [
    {
      icon: Icons.user,
      color: SECTION_COLORS.primary.text,
      label: 'Complete your profile',
      desc: 'Add your photo, headline, and bio',
      page: 'profile',
    },
    {
      icon: Icons.dollarSign,
      color: SECTION_COLORS.emerald.text,
      label: 'Set your rate',
      desc: 'Choose your per-minute consulting rate',
      page: 'rate',
    },
    {
      icon: Icons.calendar,
      color: SECTION_COLORS.violet.text,
      label: 'Connect calendar',
      desc: 'Sync your calendar to prevent double bookings',
      page: 'calendar',
    },
    {
      icon: Icons.clock,
      color: SECTION_COLORS.cyan.text,
      label: 'Set your availability',
      desc: "Tell clients when you're free for consultations",
      page: 'availability',
    },
    {
      icon: Icons.creditCard,
      color: SECTION_COLORS.amber.text,
      label: 'Set up payouts',
      desc: 'Connect Stripe to receive your earnings',
      page: 'payouts',
    },
  ];

  if (allDone) {
    return (
      <Card
        style={{
          padding: '40px 32px',
          textAlign: 'center',
          position: 'relative',
          overflow: 'hidden',
          ...slideUp,
        }}
      >
        {/* Confetti */}
        {[c.primary, c.accent, c.success, c.warning, c.pink].map((color, i) => (
          <div
            key={i}
            style={{
              position: 'absolute',
              width: 8,
              height: 8,
              borderRadius: i % 2 === 0 ? 2 : '50%',
              background: color,
              top: '40%',
              left: `${15 + i * 16}%`,
              animation: `confetti${(i % 3) + 1} 1.5s ease-out ${i * 0.12}s forwards`,
              opacity: 0,
            }}
          />
        ))}
        <div
          style={{
            width: 72,
            height: 72,
            borderRadius: '50%',
            margin: '0 auto 20px',
            background: c.gradientWarm,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: '0 8px 28px rgba(5,150,105,0.3)',
            ...scaleIn,
          }}
        >
          <Icons.sparkles size={32} color="white" />
        </div>
        <h3
          style={{
            fontSize: 20,
            fontWeight: 700,
            color: c.text,
            margin: 0,
            ...slideUp,
            animationDelay: '0.1s',
          }}
        >
          You're all set!
        </h3>
        <p
          style={{
            fontSize: 14,
            color: c.textSecondary,
            marginTop: 8,
            lineHeight: 1.6,
            ...slideUp,
            animationDelay: '0.15s',
          }}
        >
          Clients can now find and book you on the marketplace. Time to land your first
          consultation.
        </p>
        <button
          style={{
            marginTop: 20,
            padding: '10px 24px',
            borderRadius: 8,
            fontSize: 14,
            fontWeight: 600,
            border: 'none',
            background: c.gradientWarm,
            color: 'white',
            cursor: 'pointer',
            boxShadow: '0 2px 10px rgba(5,150,105,0.2)',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            ...slideUp,
            animationDelay: '0.2s',
          }}
        >
          <Icons.zap size={15} color="white" /> View your public profile
        </button>
      </Card>
    );
  }

  return (
    <Card style={{ overflow: 'hidden', ...slideUp }}>
      {/* Header with gradient accent bar */}
      <div
        style={{
          padding: '24px 28px 20px',
          background: c.gradientSubtle,
          borderBottom: `1px solid ${c.borderSubtle}`,
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
              <Icons.sparkles size={18} color={c.accent} />
              <h3 style={{ fontSize: 17, fontWeight: 700, color: c.text, margin: 0 }}>
                Getting Started
              </h3>
            </div>
            <p style={{ fontSize: 13, color: c.textSecondary, margin: 0, lineHeight: 1.5 }}>
              Complete these steps to go live on the marketplace.
            </p>
          </div>
          <div style={{ textAlign: 'right' }}>
            <p
              style={{ fontSize: 24, fontWeight: 700, color: c.primary, margin: 0, lineHeight: 1 }}
            >
              {done}/{total}
            </p>
            <p style={{ fontSize: 11, color: c.textTertiary, margin: '4px 0 0' }}>complete</p>
          </div>
        </div>

        {/* Progress bar */}
        <div
          style={{
            marginTop: 16,
            height: 6,
            borderRadius: 3,
            background: 'rgba(255,255,255,0.6)',
            overflow: 'hidden',
            backdropFilter: 'blur(4px)',
          }}
        >
          <div
            style={{
              width: `${pct}%`,
              height: '100%',
              borderRadius: 3,
              background: c.gradient,
              transition: 'width 0.6s ease',
              animation: 'progressFill 0.8s ease-out',
            }}
          />
        </div>
      </div>

      {/* Checklist items */}
      <div style={{ padding: '8px 8px 12px' }}>
        {ITEMS.map((item, i) => (
          <ChecklistItem
            key={item.label}
            icon={item.icon}
            iconColor={item.color}
            label={item.label}
            description={item.desc}
            complete={completedItems.has(i)}
            onClick={() => setPage(item.page)}
            index={i}
          />
        ))}
      </div>
    </Card>
  );
}

function MetricCard({ icon: IconComp, iconColor, label, value, sublabel, index }) {
  return (
    <Card
      style={{
        padding: '20px 22px',
        display: 'flex',
        alignItems: 'center',
        gap: 16,
        ...slideUp,
        ...stagger(index, 0.08),
      }}
      hover
    >
      <IconBadge icon={IconComp} color={iconColor} size={44} iconSize={20} />
      <div>
        <p
          style={{
            fontSize: 22,
            fontWeight: 700,
            color: c.text,
            margin: 0,
            lineHeight: 1,
            animation: 'numberCountUp 0.4s ease-out forwards',
          }}
        >
          {value}
        </p>
        <p style={{ fontSize: 12, color: c.textTertiary, margin: '4px 0 0' }}>{label}</p>
      </div>
      {sublabel && (
        <p
          style={{
            marginLeft: 'auto',
            fontSize: 11,
            fontWeight: 600,
            padding: '3px 10px',
            borderRadius: 12,
            background: c.successLight,
            color: c.success,
            border: `1px solid ${c.successBorder}`,
          }}
        >
          {sublabel}
        </p>
      )}
    </Card>
  );
}

function EmptyCard({ icon: IconComp, iconColor, title, subtitle }) {
  return (
    <Card style={{ padding: '36px 24px', textAlign: 'center' }}>
      <IconBadge
        icon={IconComp}
        color={iconColor}
        size={48}
        iconSize={22}
        style={{ margin: '0 auto 14px' }}
      />
      <p style={{ fontSize: 14, fontWeight: 600, color: c.text, margin: '14px 0 0' }}>{title}</p>
      <p style={{ fontSize: 13, color: c.textTertiary, margin: '4px 0 0' }}>{subtitle}</p>
    </Card>
  );
}

function DashboardPage({ completedItems, setPage, toggleItem }) {
  return (
    <div>
      <div style={{ marginBottom: 28, ...slideUp }}>
        <h1 style={{ fontSize: 24, fontWeight: 700, color: c.text, margin: 0 }}>
          Welcome back, Yomi
        </h1>
        <p style={{ fontSize: 14, color: c.textSecondary, marginTop: 4 }}>
          Here's what's happening with your expert account.
        </p>
      </div>

      <GettingStartedCard completedItems={completedItems} setPage={setPage} />

      {/* Metrics row */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16, marginTop: 24 }}>
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
          label="This cycle"
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

      {/* Bottom cards */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginTop: 24 }}>
        <div style={{ ...slideUp, ...stagger(6) }}>
          <p style={{ fontSize: 13, fontWeight: 600, color: c.text, marginBottom: 10 }}>
            Upcoming Consultations
          </p>
          <EmptyCard
            icon={Icons.calendar}
            iconColor={c.primary}
            title="No consultations yet"
            subtitle="They'll appear here once clients book you"
          />
        </div>
        <div style={{ ...slideUp, ...stagger(7) }}>
          <p style={{ fontSize: 13, fontWeight: 600, color: c.text, marginBottom: 10 }}>
            Top Clients
          </p>
          <EmptyCard
            icon={Icons.user}
            iconColor={c.accent}
            title="No clients yet"
            subtitle="Your top clients will appear after your first session"
          />
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// PAGE 2: EXPERT PROFILE
// ══════════════════════════════════════════════════════════════════

function ProfilePage() {
  const [tab, setTab] = useState('profile');
  const tabs = [
    { key: 'profile', label: 'Profile' },
    { key: 'expertise', label: 'Expertise' },
    { key: 'work', label: 'Work History' },
    { key: 'certs', label: 'Certifications' },
  ];

  return (
    <div>
      <div style={{ marginBottom: 28, ...slideUp }}>
        <h1 style={{ fontSize: 24, fontWeight: 700, color: c.text, margin: 0 }}>Expert Profile</h1>
        <p style={{ fontSize: 14, color: c.textSecondary, marginTop: 4 }}>
          Manage how clients see you on the marketplace.
        </p>
      </div>

      {/* Tab bar */}
      <div
        style={{
          display: 'flex',
          gap: 4,
          padding: 4,
          borderRadius: 12,
          background: c.surfaceSubtle,
          marginBottom: 28,
          width: 'fit-content',
          ...slideUp,
          animationDelay: '0.05s',
        }}
      >
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            style={{
              padding: '8px 20px',
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

      {tab === 'profile' && <ProfileTab />}
      {tab === 'expertise' && <ExpertiseTab />}
      {tab === 'work' && <WorkPlaceholder />}
      {tab === 'certs' && <CertsPlaceholder />}
    </div>
  );
}

function ProfileTab() {
  const [headline, setHeadline] = useState('Salesforce Admin Expert · 14× Certified');
  const [bio, setBio] = useState(
    'Passionate Salesforce consultant with over 10 years of experience helping enterprises transform their CRM operations. Specialized in Sales Cloud architecture and complex CPQ implementations.'
  );
  const [username, setUsername] = useState('yomi-joseph');

  return (
    <div style={{ maxWidth: 680 }}>
      {/* Photo upload */}
      <div style={{ ...slideUp, ...stagger(0) }}>
        <SectionLabel icon={Icons.camera} colorKey="primary">
          Profile Photo
        </SectionLabel>
        <div style={{ display: 'flex', alignItems: 'center', gap: 20, marginBottom: 8 }}>
          <div
            style={{
              width: 96,
              height: 96,
              borderRadius: 20,
              background: c.gradient,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 36,
              color: 'white',
              fontWeight: 700,
              boxShadow: `0 4px 16px ${c.primaryGlow}`,
            }}
          >
            YJ
          </div>
          <div>
            <button
              style={{
                padding: '8px 18px',
                borderRadius: 8,
                fontSize: 13,
                fontWeight: 600,
                border: `1px solid ${c.primaryBorder}`,
                background: c.primaryLight,
                color: c.primary,
                cursor: 'pointer',
                marginBottom: 6,
              }}
            >
              Upload photo
            </button>
            <p style={{ fontSize: 12, color: c.textTertiary, margin: 0 }}>
              JPG or PNG, max 5MB. 800×500 recommended.
            </p>
          </div>
        </div>
      </div>

      {/* Name + username */}
      <div style={{ marginTop: 32, ...slideUp, ...stagger(1) }}>
        <SectionLabel icon={Icons.user} colorKey="violet">
          Identity
        </SectionLabel>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <InputField
            label="First name"
            value="Yomi"
            required
            readOnly
            disabled
            hint="Contact support to change"
          />
          <InputField
            label="Last name"
            value="Joseph"
            required
            readOnly
            disabled
            hint="Contact support to change"
          />
        </div>
        <div style={{ marginTop: 16 }}>
          <InputField
            label="Username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            prefix="balo.expert/"
            required
            hint="This creates your public profile URL"
          />
        </div>
      </div>

      {/* Headline + bio */}
      <div style={{ marginTop: 32, ...slideUp, ...stagger(2) }}>
        <SectionLabel icon={Icons.sparkles} colorKey="amber">
          About You
        </SectionLabel>
        <InputField
          label="Headline"
          value={headline}
          onChange={(e) => setHeadline(e.target.value)}
          placeholder="e.g. Salesforce Admin Expert · 14× Certified"
          required
          maxLength={100}
          hint="A short tagline shown in search results"
        />
        <div style={{ marginTop: 16 }}>
          <InputField
            label="Bio"
            value={bio}
            onChange={(e) => setBio(e.target.value)}
            placeholder="Tell clients about your experience, approach, and what makes you unique..."
            required
            maxLength={1000}
            rows={5}
            hint="Displayed on your public profile"
          />
        </div>
      </div>

      {/* Actions */}
      <div style={{ display: 'flex', gap: 12, marginTop: 32, ...slideUp, ...stagger(3) }}>
        <Button>Save changes</Button>
        <Button variant="ghost">Reset</Button>
      </div>
    </div>
  );
}

function ExpertiseTab() {
  const skills = [
    { name: 'CPQ', ratings: { 'Technical Fix': 8, Architecture: 6, Strategy: 7, Training: 4 } },
    {
      name: 'Sales Cloud',
      ratings: { 'Technical Fix': 9, Architecture: 8, Strategy: 9, Training: 7 },
    },
    {
      name: 'Salesforce Platform',
      ratings: { 'Technical Fix': 7, Architecture: 9, Strategy: 6, Training: 5 },
    },
  ];
  const DIMS = [
    { name: 'Technical Fix', color: '#2563EB', icon: Icons.wrench },
    { name: 'Architecture', color: '#7C3AED', icon: Icons.globe },
    { name: 'Strategy', color: '#0891B2', icon: Icons.compass },
    { name: 'Training', color: '#059669', icon: Icons.gradCap },
  ];

  return (
    <div>
      {/* Locked banner */}
      <div
        style={{
          padding: '16px 20px',
          borderRadius: 12,
          marginBottom: 24,
          background: c.warningLight,
          border: `1px solid ${c.warningBorder}`,
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          ...slideUp,
        }}
      >
        <Icons.lock size={18} color={c.warning} />
        <div>
          <p style={{ fontSize: 14, fontWeight: 600, color: c.text, margin: 0 }}>
            Expertise is locked after approval
          </p>
          <p style={{ fontSize: 13, color: c.textSecondary, margin: '2px 0 0' }}>
            To request changes, email{' '}
            <strong style={{ color: c.primary }}>support@balo.expert</strong>
          </p>
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {skills.map((skill, si) => (
          <Card key={skill.name} style={{ padding: '20px 24px', ...slideUp, ...stagger(si + 1) }}>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: 16,
              }}
            >
              <p style={{ fontSize: 15, fontWeight: 600, color: c.text, margin: 0 }}>
                {skill.name}
              </p>
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  padding: '3px 10px',
                  borderRadius: 8,
                  background: c.surfaceSubtle,
                  color: c.textTertiary,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                }}
              >
                <Icons.lock size={10} color={c.textTertiary} /> Locked
              </span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px 24px' }}>
              {DIMS.map((dim) => {
                const val = skill.ratings[dim.name] || 0;
                const DIcon = dim.icon;
                return (
                  <div key={dim.name} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <div
                      style={{
                        width: 24,
                        height: 24,
                        borderRadius: 6,
                        flexShrink: 0,
                        background: `${dim.color}12`,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      <DIcon size={12} color={dim.color} />
                    </div>
                    <span style={{ fontSize: 12, color: c.textSecondary, minWidth: 72 }}>
                      {dim.name}
                    </span>
                    <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8 }}>
                      <div
                        style={{
                          flex: 1,
                          height: 6,
                          borderRadius: 3,
                          background: c.border,
                          overflow: 'hidden',
                        }}
                      >
                        <div
                          style={{
                            width: `${val * 10}%`,
                            height: '100%',
                            borderRadius: 3,
                            background: `linear-gradient(90deg, ${dim.color}90, ${dim.color})`,
                          }}
                        />
                      </div>
                      <span
                        style={{
                          fontSize: 12,
                          fontWeight: 600,
                          color: dim.color,
                          minWidth: 20,
                          textAlign: 'right',
                        }}
                      >
                        {val}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}

function WorkPlaceholder() {
  return (
    <div style={{ ...slideUp }}>
      <p style={{ fontSize: 13, color: c.textTertiary }}>
        Same UI as application Step 5 — editable work history cards. Reuse existing components.
      </p>
    </div>
  );
}

function CertsPlaceholder() {
  return (
    <div style={{ ...slideUp }}>
      <p style={{ fontSize: 13, color: c.textTertiary }}>
        Same UI as application Step 4 — editable certifications. Reuse existing components.
      </p>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// PAGE 3: RATE SETTING
// ══════════════════════════════════════════════════════════════════

function RatePage() {
  const [rate, setRate] = useState('2.00');
  const rateNum = parseFloat(rate) || 0;
  const clientRate = rateNum * 1.25;
  const hourlyExpert = rateNum * 60;
  const hourlyClient = clientRate * 60;

  return (
    <div style={{ maxWidth: 620, margin: '0 auto' }}>
      <div style={{ textAlign: 'center', marginBottom: 36, ...slideUp }}>
        <IconBadge
          icon={Icons.dollarSign}
          color={c.emerald}
          size={52}
          iconSize={24}
          style={{ margin: '0 auto 16px' }}
        />
        <h1 style={{ fontSize: 24, fontWeight: 700, color: c.text, margin: 0 }}>Set Your Rate</h1>
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
          This is your take-home amount per minute. Clients see a higher rate that includes Balo's
          service fee.
        </p>
      </div>

      {/* Rate input card */}
      <Card style={{ padding: '32px', ...slideUp, animationDelay: '0.1s' }}>
        <SectionLabel icon={Icons.dollarSign} colorKey="emerald">
          Your Rate
        </SectionLabel>

        {/* Main input */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            marginTop: 8,
          }}
        >
          <span style={{ fontSize: 32, fontWeight: 700, color: c.text }}>A$</span>
          <input
            value={rate}
            onChange={(e) => setRate(e.target.value)}
            type="number"
            step="0.10"
            min="0"
            style={{
              fontSize: 48,
              fontWeight: 700,
              color: c.text,
              width: 180,
              padding: '4px 0',
              border: 'none',
              borderBottom: `3px solid ${c.primary}`,
              outline: 'none',
              background: 'transparent',
              textAlign: 'center',
            }}
          />
          <span style={{ fontSize: 16, fontWeight: 500, color: c.textTertiary }}>/ minute</span>
        </div>

        {/* Hourly conversion */}
        <p style={{ fontSize: 14, color: c.textSecondary, marginTop: 12 }}>
          That's <strong style={{ color: c.text }}>A${hourlyExpert.toFixed(2)}/hour</strong>{' '}
          take-home
        </p>

        {/* Divider */}
        <div style={{ borderTop: `1px solid ${c.borderSubtle}`, margin: '24px 0' }} />

        {/* Client sees */}
        <div
          style={{
            padding: '20px 24px',
            borderRadius: 12,
            background: c.gradientSubtle,
            border: `1px solid ${c.accentBorder}40`,
          }}
        >
          <p
            style={{
              fontSize: 12,
              fontWeight: 600,
              color: c.accent,
              margin: '0 0 10px',
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
            }}
          >
            What clients see
          </p>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <div>
              <span style={{ fontSize: 28, fontWeight: 700, color: c.text }}>
                A${clientRate.toFixed(2)}
              </span>
              <span style={{ fontSize: 14, color: c.textTertiary, marginLeft: 4 }}>/ minute</span>
            </div>
            <span style={{ fontSize: 14, color: c.textSecondary }}>
              A${hourlyClient.toFixed(2)}/hour
            </span>
          </div>
          <p style={{ fontSize: 12, color: c.textTertiary, marginTop: 8 }}>
            Includes Balo's 25% service fee
          </p>
        </div>
      </Card>

      {/* Example box */}
      <div
        style={{
          marginTop: 20,
          padding: '16px 20px',
          borderRadius: 12,
          background: c.surfaceSubtle,
          border: `1px solid ${c.borderSubtle}`,
          display: 'flex',
          alignItems: 'flex-start',
          gap: 10,
          ...slideUp,
          animationDelay: '0.15s',
        }}
      >
        <Icons.zap size={16} color={c.primary} style={{ marginTop: 2, flexShrink: 0 }} />
        <p style={{ fontSize: 13, color: c.textSecondary, margin: 0, lineHeight: 1.6 }}>
          <strong style={{ color: c.text }}>Quick math:</strong> A 30-minute consultation earns you{' '}
          <strong style={{ color: c.emerald }}>A${(rateNum * 30).toFixed(2)}</strong>. The client
          pays A${(clientRate * 30).toFixed(2)}.
        </p>
      </div>

      <div style={{ marginTop: 28, textAlign: 'center', ...slideUp, animationDelay: '0.2s' }}>
        <Button>
          Save rate <Icons.check size={16} color="white" />
        </Button>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// PAGE 4: PAYOUTS
// ══════════════════════════════════════════════════════════════════

function PayoutsPage() {
  const [connected, setConnected] = useState(false);

  return (
    <div style={{ maxWidth: 620, margin: '0 auto' }}>
      <div style={{ textAlign: 'center', marginBottom: 36, ...slideUp }}>
        <IconBadge
          icon={Icons.creditCard}
          color={c.amber}
          size={52}
          iconSize={24}
          style={{ margin: '0 auto 16px' }}
        />
        <h1 style={{ fontSize: 24, fontWeight: 700, color: c.text, margin: 0 }}>Payouts</h1>
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
          Connect your Stripe account to receive earnings from consultations and projects.
        </p>
      </div>

      {!connected ? (
        <Card
          style={{ padding: '40px 32px', textAlign: 'center', ...slideUp, animationDelay: '0.1s' }}
        >
          {/* Stripe badge */}
          <div
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              padding: '6px 16px',
              borderRadius: 20,
              background: c.surfaceSubtle,
              marginBottom: 24,
            }}
          >
            <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#635BFF' }} />
            <span style={{ fontSize: 12, fontWeight: 600, color: c.textSecondary }}>
              Powered by Stripe
            </span>
          </div>

          <h3 style={{ fontSize: 18, fontWeight: 700, color: c.text, margin: '0 0 8px' }}>
            Set up your payout account
          </h3>
          <p
            style={{
              fontSize: 14,
              color: c.textSecondary,
              lineHeight: 1.6,
              maxWidth: 380,
              margin: '0 auto 28px',
            }}
          >
            Balo partners with Stripe to offer secure, reliable payouts. Your earnings are
            transferred on the 1st and 15th of each month.
          </p>

          <button
            onClick={() => setConnected(true)}
            style={{
              padding: '14px 36px',
              borderRadius: 10,
              fontSize: 15,
              fontWeight: 650,
              border: 'none',
              background: '#635BFF',
              color: 'white',
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              boxShadow: '0 4px 16px rgba(99,91,255,0.3)',
              transition: 'all 0.2s',
            }}
            onMouseEnter={(e) => (e.currentTarget.style.transform = 'translateY(-2px)')}
            onMouseLeave={(e) => (e.currentTarget.style.transform = 'none')}
          >
            Set up payouts <Icons.arrowRight size={16} color="white" />
          </button>

          <div
            style={{
              display: 'flex',
              justifyContent: 'center',
              gap: 24,
              marginTop: 28,
              paddingTop: 20,
              borderTop: `1px solid ${c.borderSubtle}`,
            }}
          >
            {[
              { icon: Icons.shield, label: 'Bank-level security' },
              { icon: Icons.zap, label: 'Instant transfers' },
              { icon: Icons.globe, label: '180+ countries' },
            ].map((item) => (
              <div key={item.label} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <item.icon size={14} color={c.textTertiary} />
                <span style={{ fontSize: 12, color: c.textTertiary }}>{item.label}</span>
              </div>
            ))}
          </div>
        </Card>
      ) : (
        <Card style={{ padding: '28px 32px', ...scaleIn }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 20 }}>
            <div
              style={{
                width: 44,
                height: 44,
                borderRadius: 12,
                background: c.successLight,
                border: `1px solid ${c.successBorder}`,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Icons.check size={22} color={c.success} />
            </div>
            <div>
              <p style={{ fontSize: 16, fontWeight: 700, color: c.text, margin: 0 }}>
                Payouts connected
              </p>
              <p style={{ fontSize: 13, color: c.textSecondary, margin: '2px 0 0' }}>
                Your Stripe account is active and ready to receive payouts.
              </p>
            </div>
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: 12,
              padding: '16px 0',
              borderTop: `1px solid ${c.borderSubtle}`,
            }}
          >
            <div>
              <p
                style={{
                  fontSize: 11,
                  color: c.textTertiary,
                  margin: '0 0 2px',
                  textTransform: 'uppercase',
                  letterSpacing: '0.06em',
                }}
              >
                Status
              </p>
              <p
                style={{
                  fontSize: 14,
                  fontWeight: 600,
                  color: c.success,
                  margin: 0,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                }}
              >
                <span
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: '50%',
                    background: c.success,
                    display: 'inline-block',
                  }}
                />
                Active
              </p>
            </div>
            <div>
              <p
                style={{
                  fontSize: 11,
                  color: c.textTertiary,
                  margin: '0 0 2px',
                  textTransform: 'uppercase',
                  letterSpacing: '0.06em',
                }}
              >
                Next payout
              </p>
              <p style={{ fontSize: 14, fontWeight: 600, color: c.text, margin: 0 }}>
                March 15, 2026
              </p>
            </div>
          </div>

          <button
            style={{
              marginTop: 16,
              padding: '10px 20px',
              borderRadius: 8,
              fontSize: 13,
              fontWeight: 600,
              border: `1px solid ${c.border}`,
              background: c.surface,
              color: c.text,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              transition: 'all 0.2s',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.borderColor = c.primaryBorder;
              e.currentTarget.style.color = c.primary;
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.borderColor = c.border;
              e.currentTarget.style.color = c.text;
            }}
          >
            Go to Stripe Dashboard <Icons.arrowUpRight size={14} />
          </button>
        </Card>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// PAGE 5: CALENDAR
// ══════════════════════════════════════════════════════════════════

function CalendarPage() {
  const [calendars, setCalendars] = useState([]);
  const addCalendar = () =>
    setCalendars([...calendars, { name: 'yomi@gmail.com', provider: 'Google', active: true }]);

  return (
    <div style={{ maxWidth: 620, margin: '0 auto' }}>
      <div style={{ textAlign: 'center', marginBottom: 36, ...slideUp }}>
        <IconBadge
          icon={Icons.calendar}
          color={SECTION_COLORS.violet.text}
          size={52}
          iconSize={24}
          style={{ margin: '0 auto 16px' }}
        />
        <h1 style={{ fontSize: 24, fontWeight: 700, color: c.text, margin: 0 }}>
          Connect Your Calendar
        </h1>
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
          Sync your calendars to prevent double bookings and let clients see your real availability.
        </p>
      </div>

      {calendars.length === 0 ? (
        <Card
          style={{ padding: '48px 32px', textAlign: 'center', ...slideUp, animationDelay: '0.1s' }}
        >
          <div
            style={{
              width: 56,
              height: 56,
              borderRadius: 14,
              margin: '0 auto 16px',
              background: c.gradientSubtle,
              border: `1px solid ${c.accentBorder}40`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Icons.calendar size={24} color={c.accent} />
          </div>
          <h3 style={{ fontSize: 16, fontWeight: 700, color: c.text, margin: '0 0 6px' }}>
            No calendars connected
          </h3>
          <p style={{ fontSize: 13, color: c.textTertiary, margin: '0 0 24px', lineHeight: 1.5 }}>
            Connect your Google, Microsoft, or Apple calendar to get started.
          </p>
          <button
            onClick={addCalendar}
            style={{
              padding: '12px 28px',
              borderRadius: 10,
              fontSize: 14,
              fontWeight: 650,
              border: 'none',
              background: c.gradient,
              color: 'white',
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              boxShadow: `0 2px 10px ${c.primaryGlow}`,
            }}
          >
            Connect calendar <Icons.arrowRight size={15} color="white" />
          </button>
        </Card>
      ) : (
        <div>
          {calendars.map((cal, i) => (
            <Card
              key={i}
              style={{
                padding: '18px 22px',
                marginBottom: 12,
                display: 'flex',
                alignItems: 'center',
                gap: 14,
                ...scaleIn,
              }}
            >
              <div
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: 10,
                  background: '#4285F410',
                  border: '1px solid #4285F425',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Icons.calendar size={17} color="#4285F4" />
              </div>
              <div style={{ flex: 1 }}>
                <p style={{ fontSize: 14, fontWeight: 600, color: c.text, margin: 0 }}>
                  {cal.name}
                </p>
                <p style={{ fontSize: 12, color: c.textTertiary, margin: '2px 0 0' }}>
                  {cal.provider} Calendar
                </p>
              </div>
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  padding: '3px 10px',
                  borderRadius: 8,
                  background: c.successLight,
                  color: c.success,
                }}
              >
                Connected
              </span>
            </Card>
          ))}
          <button
            onClick={addCalendar}
            style={{
              marginTop: 8,
              padding: '10px 20px',
              borderRadius: 8,
              fontSize: 13,
              fontWeight: 500,
              border: `1px solid ${c.primaryBorder}`,
              background: c.primaryLight,
              color: c.primary,
              cursor: 'pointer',
            }}
          >
            + Connect another
          </button>
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// PAGE 6: AVAILABILITY
// ══════════════════════════════════════════════════════════════════

function AvailabilityPage() {
  const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const [enabled, setEnabled] = useState({
    Monday: true,
    Tuesday: true,
    Wednesday: true,
    Thursday: true,
    Friday: true,
    Saturday: false,
    Sunday: false,
  });
  const [slots] = useState({
    Monday: [{ start: '09:00', end: '17:00' }],
    Tuesday: [{ start: '09:00', end: '17:00' }],
    Wednesday: [
      { start: '09:00', end: '12:00' },
      { start: '14:00', end: '17:00' },
    ],
    Thursday: [{ start: '09:00', end: '17:00' }],
    Friday: [{ start: '09:00', end: '15:00' }],
  });

  return (
    <div style={{ maxWidth: 680, margin: '0 auto' }}>
      <div style={{ marginBottom: 32, ...slideUp }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6 }}>
          <IconBadge icon={Icons.clock} color={c.cyan} size={40} iconSize={20} />
          <h1 style={{ fontSize: 24, fontWeight: 700, color: c.text, margin: 0 }}>
            Weekly Availability
          </h1>
        </div>
        <p style={{ fontSize: 14, color: c.textSecondary, marginLeft: 52 }}>
          Set when you're available for consultations.
        </p>
      </div>

      <div
        style={{
          padding: '10px 16px',
          borderRadius: 10,
          marginBottom: 24,
          background: c.surfaceSubtle,
          border: `1px solid ${c.borderSubtle}`,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          fontSize: 13,
          color: c.textSecondary,
          ...slideUp,
          animationDelay: '0.05s',
        }}
      >
        <Icons.globe size={14} color={c.textTertiary} />
        All times in <strong style={{ color: c.text }}>Australia/Melbourne (AEDT)</strong>
      </div>

      <Card style={{ overflow: 'hidden', ...slideUp, animationDelay: '0.1s' }}>
        {DAYS.map((day, i) => {
          const isOn = enabled[day];
          const daySlots = slots[day] || [];
          return (
            <div
              key={day}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 16,
                padding: '14px 20px',
                borderBottom: i < DAYS.length - 1 ? `1px solid ${c.borderSubtle}` : 'none',
                opacity: isOn ? 1 : 0.5,
                transition: 'opacity 0.2s',
              }}
            >
              {/* Toggle */}
              <div
                onClick={() => setEnabled({ ...enabled, [day]: !isOn })}
                style={{
                  width: 38,
                  height: 22,
                  borderRadius: 11,
                  cursor: 'pointer',
                  background: isOn ? c.primary : c.border,
                  padding: 2,
                  transition: 'background 0.2s',
                  display: 'flex',
                  alignItems: isOn ? undefined : undefined,
                }}
              >
                <div
                  style={{
                    width: 18,
                    height: 18,
                    borderRadius: '50%',
                    background: 'white',
                    boxShadow: '0 1px 3px rgba(0,0,0,0.15)',
                    transform: isOn ? 'translateX(16px)' : 'translateX(0)',
                    transition: 'transform 0.2s',
                  }}
                />
              </div>

              <span style={{ fontSize: 14, fontWeight: 600, color: c.text, width: 100 }}>
                {day}
              </span>

              {isOn ? (
                <div style={{ display: 'flex', gap: 12, flex: 1, flexWrap: 'wrap' }}>
                  {daySlots.map((slot, si) => (
                    <div
                      key={si}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6,
                        padding: '4px 12px',
                        borderRadius: 8,
                        background: c.primaryLight,
                        border: `1px solid ${c.primaryBorder}`,
                        fontSize: 13,
                        fontWeight: 500,
                        color: c.primary,
                      }}
                    >
                      {slot.start} – {slot.end}
                    </div>
                  ))}
                </div>
              ) : (
                <span style={{ fontSize: 13, color: c.textTertiary, fontStyle: 'italic' }}>
                  Unavailable
                </span>
              )}
            </div>
          );
        })}
      </Card>

      <div style={{ marginTop: 24, textAlign: 'center', ...slideUp, animationDelay: '0.2s' }}>
        <Button>Save availability</Button>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// MAIN APP — SIDEBAR NAV + PAGE ROUTER
// ══════════════════════════════════════════════════════════════════

const NAV_ITEMS = [
  { key: 'dashboard', label: 'Dashboard', icon: Icons.sparkles },
  { key: 'profile', label: 'Profile', icon: Icons.user },
  { key: 'rate', label: 'Rate', icon: Icons.dollarSign },
  { key: 'calendar', label: 'Calendar', icon: Icons.calendar },
  { key: 'availability', label: 'Availability', icon: Icons.clock },
  { key: 'payouts', label: 'Payouts', icon: Icons.creditCard },
];

export default function ExpertSetupApp() {
  const [page, setPage] = useState('dashboard');
  const [completedItems, setCompletedItems] = useState(new Set([0])); // profile started

  const toggleItem = (i) => {
    setCompletedItems((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  };

  // Auto-mark items as complete when visiting their page
  useEffect(() => {
    const pageToItem = { profile: 0, rate: 1, calendar: 2, availability: 3, payouts: 4 };
    if (pageToItem[page] !== undefined) {
      setCompletedItems((prev) => new Set([...prev, pageToItem[page]]));
    }
  }, [page]);

  return (
    <div
      style={{
        minHeight: '100vh',
        background: c.bg,
        fontFamily: "'DM Sans', -apple-system, BlinkMacSystemFont, sans-serif",
        display: 'flex',
      }}
    >
      <style>{keyframes}</style>
      <link
        href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap"
        rel="stylesheet"
      />

      {/* Sidebar */}
      <div
        style={{
          width: 220,
          background: c.surface,
          borderRight: `1px solid ${c.border}`,
          padding: '24px 12px',
          flexShrink: 0,
        }}
      >
        {/* Logo */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '0 8px',
            marginBottom: 32,
          }}
        >
          <div
            style={{
              width: 28,
              height: 28,
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
              fontSize: 10,
              fontWeight: 600,
              padding: '2px 6px',
              borderRadius: 4,
              background: c.successLight,
              color: c.success,
              border: `1px solid ${c.successBorder}`,
              marginLeft: 'auto',
            }}
          >
            Expert
          </span>
        </div>

        {/* Nav items */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {NAV_ITEMS.map((item) => {
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
                  padding: '9px 12px',
                  borderRadius: 8,
                  border: 'none',
                  background: active ? c.primaryLight : 'transparent',
                  color: active ? c.primary : c.textSecondary,
                  cursor: 'pointer',
                  fontSize: 13,
                  fontWeight: active ? 600 : 500,
                  transition: 'all 0.15s',
                  textAlign: 'left',
                }}
              >
                <NIcon size={16} color={active ? c.primary : c.textTertiary} />
                {item.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Main content */}
      <div style={{ flex: 1, padding: '32px 40px', overflow: 'auto' }} key={page}>
        {page === 'dashboard' && (
          <DashboardPage
            completedItems={completedItems}
            setPage={setPage}
            toggleItem={toggleItem}
          />
        )}
        {page === 'profile' && <ProfilePage />}
        {page === 'rate' && <RatePage />}
        {page === 'calendar' && <CalendarPage />}
        {page === 'availability' && <AvailabilityPage />}
        {page === 'payouts' && <PayoutsPage />}
      </div>
    </div>
  );
}
