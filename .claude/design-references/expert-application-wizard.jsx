import { useState, useRef, useEffect, useCallback } from 'react';

// ── Design Tokens ────────────────────────────────────────────────
const c = {
  bg: '#F8FAFB',
  surface: '#FFFFFF',
  surfaceSubtle: '#F1F4F8',
  surfaceElevated: '#FFFFFF',
  border: '#E0E4EB',
  borderSubtle: '#EAEFF5',
  borderFocus: '#2563EB',
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
  gradient: 'linear-gradient(135deg, #2563EB 0%, #7C3AED 100%)',
  gradientSubtle: 'linear-gradient(135deg, #EFF6FF 0%, #F5F3FF 100%)',
};

// ── Icons (SVG) ──────────────────────────────────────────────────

const Icon = ({ d, size = 16, color = 'currentColor', ...props }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke={color}
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    {...props}
  >
    <path d={d} />
  </svg>
);

const Icons = {
  phone: (p) => (
    <Icon
      {...p}
      d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 16.92z"
    />
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
      <path d="M8.21 13.89L7 23l5-3 5 3-1.21-9.12" />
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
  check: (p) => <Icon {...p} d="M20 6L9 17l-5-5" />,
  x: (p) => <Icon {...p} d="M18 6L6 18M6 6l12 12" />,
  plus: (p) => <Icon {...p} d="M12 5v14M5 12h14" />,
  chevDown: (p) => <Icon {...p} d="M6 9l6 6 6-6" />,
  chevUp: (p) => <Icon {...p} d="M18 15l-6-6-6 6" />,
  arrowLeft: (p) => <Icon {...p} d="M19 12H5M12 19l-7-7 7-7" />,
  arrowRight: (p) => <Icon {...p} d="M5 12h14M12 5l7 7-7 7" />,
  wrench: (p) => (
    <Icon
      {...p}
      d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z"
    />
  ),
  building: (p) => (
    <Icon
      {...p}
      d="M6 22V4a2 2 0 012-2h8a2 2 0 012 2v18zM6 12H4a2 2 0 00-2 2v6a2 2 0 002 2h2M18 9h2a2 2 0 012 2v9a2 2 0 01-2 2h-2M10 6h4M10 10h4M10 14h4M10 18h4"
    />
  ),
  compass: (p) => (
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
      <polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76" />
    </svg>
  ),
  gradCap: (p) => (
    <Icon {...p} d="M22 10v6M2 10l10-5 10 5-10 5zM6 12v5c0 1.657 2.686 3 6 3s6-1.343 6-3v-5" />
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
  mail: (p) => (
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
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <path d="M22 7l-10 7L2 7" />
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
    >
      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
      <path d="M14 2v6h6M16 13H8M16 17H8M10 9H8" />
    </svg>
  ),
  shield: (p) => <Icon {...p} d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />,
  sparkle: (p) => (
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
  edit: (p) => (
    <Icon
      {...p}
      d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"
    />
  ),
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
      <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
    </svg>
  ),
  linkedin: (p) => (
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
      <path d="M16 8a6 6 0 016 6v7h-4v-7a2 2 0 00-2-2 2 2 0 00-2 2v7h-4v-7a6 6 0 016-6zM2 9h4v12H2zM4 6a2 2 0 100-4 2 2 0 000 4z" />
    </svg>
  ),
  info: (p) => (
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
      <path d="M12 16v-4M12 8h.01" />
    </svg>
  ),
  send: (p) => <Icon {...p} d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" />,
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
    >
      <path d="M16 4h2a2 2 0 012 2v14a2 2 0 01-2 2H6a2 2 0 01-2-2V6a2 2 0 012-2h2" />
      <rect x="8" y="2" width="8" height="4" rx="1" />
    </svg>
  ),
};

// ── Data ─────────────────────────────────────────────────────────

const STEPS = [
  { key: 'profile', label: 'Profile', icon: Icons.briefcase, color: c.primary },
  { key: 'products', label: 'Products', icon: Icons.sparkle, color: '#7C3AED' },
  { key: 'assessment', label: 'Assessment', icon: Icons.compass, color: '#0891B2' },
  { key: 'certs', label: 'Certifications', icon: Icons.award, color: '#D97706' },
  { key: 'history', label: 'History', icon: Icons.briefcase, color: '#059669' },
  { key: 'invite', label: 'Invite', icon: Icons.users, color: '#DB2777' },
  { key: 'terms', label: 'Terms', icon: Icons.shield, color: '#4F46E5' },
];

const SKILL_CATEGORIES = [
  { name: 'AI', skills: ['Agentforce'] },
  { name: 'Sales Cloud', skills: ['CPQ', 'Sales Cloud'] },
  {
    name: 'Service Cloud',
    skills: ['Digital Engagement', 'Field Service', 'Service Cloud', 'Voice'],
  },
  {
    name: 'Marketing Cloud',
    skills: ['Account Engagement', 'Engagement', 'Intelligence', 'Personalisation'],
  },
  {
    name: 'Platform',
    skills: ['AppExchange', 'Heroku', 'Hyperforce', 'Salesforce Platform', 'Security', 'Shield'],
  },
  { name: 'Commerce Cloud', skills: ['B2B Commerce', 'B2C Commerce', 'Order Management'] },
  { name: 'Tableau', skills: ['CRM Analytics', 'Tableau'] },
  { name: 'Mulesoft', skills: ['MuleSoft'] },
  {
    name: 'Industries',
    skills: ['Financial Services Cloud', 'Health Cloud', 'Manufacturing Cloud', 'Nonprofit Cloud'],
  },
];

const CERT_CATEGORIES = [
  {
    name: 'Administrator',
    certs: ['Administrator', 'Advanced Administrator', 'Platform App Builder'],
  },
  {
    name: 'Architect',
    certs: [
      'Application Architect',
      'Data Architect',
      'Technical Architect',
      'Integration Architect',
    ],
  },
  {
    name: 'Consultant',
    certs: ['Sales Cloud Consultant', 'Service Cloud Consultant', 'Data Cloud Consultant'],
  },
  {
    name: 'Developer',
    certs: ['Platform Developer I', 'Platform Developer II', 'JavaScript Developer I'],
  },
  { name: 'Tableau', certs: ['Tableau Desktop Specialist', 'Tableau Certified Data Analyst'] },
];

const INDUSTRIES = [
  'Agriculture & Mining',
  'Automotive',
  'Communications',
  'Consumer Goods',
  'Education',
  'Energy & Utilities',
  'Engineering',
  'Financial Services',
  'Healthcare & Life Sciences',
  'Manufacturing',
  'Media & Entertainment',
  'Non-profit',
  'Professional Services',
  'Public Sector & Government',
  'Retail',
  'Technology',
  'Transportation',
];

const LANGUAGES = [
  { name: 'English', flag: '🇬🇧', code: 'en' },
  { name: 'French', flag: '🇫🇷', code: 'fr' },
  { name: 'Spanish', flag: '🇪🇸', code: 'es' },
  { name: 'German', flag: '🇩🇪', code: 'de' },
  { name: 'Japanese', flag: '🇯🇵', code: 'ja' },
  { name: 'Chinese', flag: '🇨🇳', code: 'zh' },
  { name: 'Hindi', flag: '🇮🇳', code: 'hi' },
  { name: 'Portuguese', flag: '🇵🇹', code: 'pt' },
  { name: 'Arabic', flag: '🇸🇦', code: 'ar' },
];

const SUPPORT_TYPES = [
  {
    name: 'Technical Fix',
    icon: Icons.wrench,
    color: '#2563EB',
    desc: 'Troubleshooting & bug fixes',
  },
  {
    name: 'Architecture',
    icon: Icons.building,
    color: '#7C3AED',
    desc: 'System design & integrations',
  },
  { name: 'Strategy', icon: Icons.compass, color: '#0891B2', desc: 'Roadmap & best practices' },
  {
    name: 'Training',
    icon: Icons.gradCap,
    color: '#059669',
    desc: 'Enablement & knowledge transfer',
  },
];

const PROFICIENCY_LABELS = [
  'No Experience',
  'Very Limited',
  'Basic',
  'Limited',
  'Novice',
  'Intermediate',
  'Proficient',
  'Advanced',
  'Highly Experienced',
  'Expert',
  'Master',
];

const PROJECT_OPTS = [
  { value: '0', label: 'None' },
  { value: '1', label: '1 – 9' },
  { value: '10', label: '10 – 25' },
  { value: '26', label: '26 – 50' },
  { value: '50', label: '50+' },
];

// ── Animation Helpers ────────────────────────────────────────────

const fadeIn = { animation: 'fadeIn 0.35s ease-out forwards', opacity: 0 };
const slideUp = { animation: 'slideUp 0.4s ease-out forwards', opacity: 0 };
const slideInRight = { animation: 'slideInRight 0.3s ease-out forwards', opacity: 0 };
const scaleIn = { animation: 'scaleIn 0.2s ease-out forwards' };

const keyframes = `
@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
@keyframes slideUp { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: translateY(0); } }
@keyframes slideInRight { from { opacity: 0; transform: translateX(20px); } to { opacity: 1; transform: translateX(0); } }
@keyframes scaleIn { from { transform: scale(0.95); opacity: 0; } to { transform: scale(1); opacity: 1; } }
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.6; } }
@keyframes checkPop { 0% { transform: scale(0); } 60% { transform: scale(1.2); } 100% { transform: scale(1); } }
@keyframes shimmer { 0% { background-position: -200% 0; } 100% { background-position: 200% 0; } }
@keyframes confetti1 { 0% { transform: translateY(0) rotate(0); opacity:1; } 100% { transform: translateY(-80px) rotate(180deg); opacity:0; } }
@keyframes confetti2 { 0% { transform: translateY(0) rotate(0); opacity:1; } 100% { transform: translateY(-60px) rotate(-120deg) translateX(30px); opacity:0; } }
@keyframes confetti3 { 0% { transform: translateY(0) rotate(0); opacity:1; } 100% { transform: translateY(-70px) rotate(90deg) translateX(-25px); opacity:0; } }
input[type="range"] { -webkit-appearance: none; height: 6px; border-radius: 3px; background: ${c.border}; outline: none; }
input[type="range"]::-webkit-slider-thumb { -webkit-appearance: none; width: 20px; height: 20px; border-radius: 50%; cursor: pointer; border: 2px solid white; box-shadow: 0 1px 4px rgba(0,0,0,0.2); transition: transform 0.15s, box-shadow 0.15s; }
input[type="range"]::-webkit-slider-thumb:hover { transform: scale(1.2); box-shadow: 0 2px 8px rgba(0,0,0,0.25); }
input[type="range"]::-webkit-slider-thumb:active { transform: scale(1.1); }
`;

function stagger(i, base = 0.04) {
  return { animationDelay: `${i * base}s` };
}

// ── Micro Components ─────────────────────────────────────────────

function SectionLabel({ children, icon: IconComp, color }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
      {IconComp && (
        <div
          style={{
            width: 24,
            height: 24,
            borderRadius: 6,
            background: color ? `${color}15` : c.primaryLight,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <IconComp size={13} color={color || c.primary} />
        </div>
      )}
      <p
        style={{
          fontSize: 11,
          fontWeight: 650,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          color: color || c.textTertiary,
          margin: 0,
        }}
      >
        {children}
      </p>
    </div>
  );
}

function FieldLabel({ children, required }) {
  return (
    <label
      style={{ fontSize: 13, fontWeight: 550, color: c.text, display: 'block', marginBottom: 6 }}
    >
      {children}
      {required && <span style={{ color: c.error, marginLeft: 3 }}>*</span>}
    </label>
  );
}

function FieldHint({ children }) {
  return (
    <p style={{ fontSize: 12, color: c.textTertiary, marginTop: 5, lineHeight: 1.4 }}>{children}</p>
  );
}

function InputField({ placeholder, value, onChange, prefix, style: xs }) {
  return (
    <div style={{ display: 'flex', ...xs }}>
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
      <input
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        style={{
          width: '100%',
          padding: '10px 14px',
          fontSize: 14,
          border: `1px solid ${c.border}`,
          borderRadius: prefix ? '0 8px 8px 0' : 8,
          outline: 'none',
          color: c.text,
          background: c.surface,
          transition: 'border-color 0.2s, box-shadow 0.2s',
        }}
        onFocus={(e) => {
          e.target.style.borderColor = c.primary;
          e.target.style.boxShadow = `0 0 0 3px ${c.primaryGlow}`;
        }}
        onBlur={(e) => {
          e.target.style.borderColor = c.border;
          e.target.style.boxShadow = 'none';
        }}
      />
    </div>
  );
}

function SelectField({ value, onChange, options, placeholder }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      style={{
        width: '100%',
        padding: '10px 14px',
        fontSize: 14,
        border: `1px solid ${c.border}`,
        borderRadius: 8,
        outline: 'none',
        color: value ? c.text : c.textTertiary,
        background: c.surface,
        cursor: 'pointer',
        appearance: 'none',
        transition: 'border-color 0.2s, box-shadow 0.2s',
        backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' fill='none' stroke='%239CA3AF' stroke-width='2'%3E%3Cpath d='M2 4l4 4 4-4'/%3E%3C/svg%3E")`,
        backgroundRepeat: 'no-repeat',
        backgroundPosition: 'right 12px center',
      }}
      onFocus={(e) => {
        e.target.style.borderColor = c.primary;
        e.target.style.boxShadow = `0 0 0 3px ${c.primaryGlow}`;
      }}
      onBlur={(e) => {
        e.target.style.borderColor = c.border;
        e.target.style.boxShadow = 'none';
      }}
    >
      {placeholder && (
        <option value="" disabled>
          {placeholder}
        </option>
      )}
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

function Chip({ label, selected, onClick, animStyle }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        padding: '7px 15px',
        borderRadius: 20,
        fontSize: 13,
        fontWeight: 500,
        border: `1.5px solid ${selected ? c.primary : hover ? c.primaryBorder : c.border}`,
        background: selected ? c.primaryLight : hover ? `${c.primaryLight}60` : c.surface,
        color: selected ? c.primary : c.textSecondary,
        cursor: 'pointer',
        transition: 'all 0.18s ease',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        transform: hover && !selected ? 'translateY(-1px)' : 'none',
        boxShadow: hover ? '0 2px 8px rgba(0,0,0,0.04)' : 'none',
        ...animStyle,
      }}
    >
      {selected && (
        <span style={{ display: 'inline-flex', animation: 'checkPop 0.3s ease-out' }}>
          <Icons.check size={13} color={c.primary} />
        </span>
      )}
      {label}
    </button>
  );
}

function Badge({ children, variant = 'default' }) {
  const styles = {
    native: { bg: c.successLight, border: c.successBorder, color: c.success },
    advanced: { bg: c.primaryLight, border: c.primaryBorder, color: c.primary },
    intermediate: { bg: c.warningLight, border: c.warningBorder, color: c.warning },
    beginner: { bg: c.surfaceSubtle, border: c.border, color: c.textSecondary },
    default: { bg: c.surfaceSubtle, border: c.border, color: c.textSecondary },
  };
  const s = styles[variant] || styles.default;
  return (
    <span
      style={{
        padding: '3px 10px',
        borderRadius: 12,
        fontSize: 11,
        fontWeight: 600,
        background: s.bg,
        border: `1px solid ${s.border}`,
        color: s.color,
        textTransform: 'capitalize',
        transition: 'all 0.2s',
      }}
    >
      {children}
    </span>
  );
}

function CheckboxField({ checked, onChange, label, description }) {
  return (
    <label
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 12,
        cursor: 'pointer',
        padding: '10px 0',
      }}
    >
      <div
        onClick={(e) => {
          e.preventDefault();
          onChange(!checked);
        }}
        style={{
          width: 20,
          height: 20,
          borderRadius: 5,
          flexShrink: 0,
          marginTop: 1,
          border: `2px solid ${checked ? c.primary : c.border}`,
          background: checked ? c.primary : c.surface,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          transition: 'all 0.2s ease',
          cursor: 'pointer',
          boxShadow: checked ? `0 0 0 3px ${c.primaryGlow}` : 'none',
        }}
      >
        {checked && (
          <span style={{ animation: 'checkPop 0.25s ease-out' }}>
            <Icons.check size={13} color="white" />
          </span>
        )}
      </div>
      <div>
        <p style={{ fontSize: 14, fontWeight: 500, color: c.text, lineHeight: 1.3, margin: 0 }}>
          {label}
        </p>
        {description && (
          <p style={{ fontSize: 12, color: c.textTertiary, marginTop: 3, lineHeight: 1.4 }}>
            {description}
          </p>
        )}
      </div>
    </label>
  );
}

function StepHeading({ icon: IconComp, iconColor, title, subtitle }) {
  return (
    <div style={slideUp}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6 }}>
        {IconComp && (
          <div
            style={{
              width: 36,
              height: 36,
              borderRadius: 10,
              background: `${iconColor}12`,
              border: `1px solid ${iconColor}25`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <IconComp size={18} color={iconColor} />
          </div>
        )}
        <h2
          style={{
            fontSize: 22,
            fontWeight: 680,
            color: c.text,
            margin: 0,
            letterSpacing: '-0.01em',
          }}
        >
          {title}
        </h2>
      </div>
      {subtitle && (
        <p
          style={{
            fontSize: 14,
            color: c.textSecondary,
            marginTop: 8,
            lineHeight: 1.6,
            marginLeft: 48,
          }}
        >
          {subtitle}
        </p>
      )}
    </div>
  );
}

function EmptyState({ icon: IconComp, iconColor, title, subtitle, action, onAction }) {
  return (
    <div
      style={{
        padding: '48px 24px',
        borderRadius: 16,
        textAlign: 'center',
        border: `2px dashed ${c.border}`,
        background: c.gradientSubtle,
        ...fadeIn,
      }}
    >
      <div
        style={{
          width: 56,
          height: 56,
          borderRadius: 14,
          margin: '0 auto 16px',
          background: `${iconColor}12`,
          border: `1px solid ${iconColor}20`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <IconComp size={24} color={iconColor} />
      </div>
      <p style={{ fontSize: 15, fontWeight: 600, color: c.text, margin: 0 }}>{title}</p>
      <p style={{ fontSize: 13, color: c.textTertiary, margin: '6px 0 0' }}>{subtitle}</p>
      {action && (
        <button
          onClick={onAction}
          style={{
            marginTop: 20,
            padding: '10px 24px',
            borderRadius: 8,
            fontSize: 14,
            fontWeight: 600,
            border: 'none',
            background: c.primary,
            color: 'white',
            cursor: 'pointer',
            transition: 'all 0.2s',
            boxShadow: `0 2px 8px ${c.primaryGlow}`,
          }}
          onMouseEnter={(e) => (e.target.style.transform = 'translateY(-1px)')}
          onMouseLeave={(e) => (e.target.style.transform = 'none')}
        >
          {action}
        </button>
      )}
    </div>
  );
}

// ── Progress Bar ─────────────────────────────────────────────────

function WizardProgress({ currentStep, completedSteps }) {
  return (
    <div style={{ padding: '0 0 36px' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          position: 'relative',
        }}
      >
        <div style={{ position: 'absolute', top: 17, left: 24, right: 24, display: 'flex' }}>
          {STEPS.slice(0, -1).map((_, i) => {
            const done = completedSteps.has(i);
            return (
              <div key={i} style={{ flex: 1, height: 2, background: c.border, overflow: 'hidden' }}>
                <div
                  style={{
                    height: '100%',
                    width: done ? '100%' : i === currentStep ? '50%' : '0%',
                    background: c.gradient,
                    transition: 'width 0.5s ease',
                  }}
                />
              </div>
            );
          })}
        </div>
        {STEPS.map((step, i) => {
          const isComplete = completedSteps.has(i);
          const isCurrent = i === currentStep;
          const StepIcon = step.icon;
          return (
            <div
              key={step.key}
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                position: 'relative',
                zIndex: 1,
                flex: 1,
              }}
            >
              <div
                style={{
                  width: 34,
                  height: 34,
                  borderRadius: '50%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  background: isComplete ? c.gradient : isCurrent ? c.surface : c.surface,
                  border: isComplete ? 'none' : `2px solid ${isCurrent ? c.primary : c.border}`,
                  boxShadow: isCurrent
                    ? `0 0 0 4px ${c.primaryGlow}`
                    : isComplete
                      ? '0 2px 6px rgba(37,99,235,0.25)'
                      : 'none',
                  transition: 'all 0.35s ease',
                }}
              >
                {isComplete ? (
                  <span style={{ animation: 'checkPop 0.3s ease-out' }}>
                    <Icons.check size={15} color="white" />
                  </span>
                ) : (
                  <span
                    style={{
                      fontSize: 12,
                      fontWeight: 600,
                      color: isCurrent ? c.primary : c.textTertiary,
                    }}
                  >
                    {i + 1}
                  </span>
                )}
              </div>
              <span
                style={{
                  fontSize: 11,
                  fontWeight: isCurrent ? 650 : 500,
                  marginTop: 8,
                  color: isCurrent ? c.text : isComplete ? c.primary : c.textTertiary,
                  transition: 'all 0.3s',
                }}
              >
                {step.label}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Step 1: Profile ──────────────────────────────────────────────

function StepProfile({ data, setData }) {
  const toggleIndustry = (ind) => {
    const curr = data.industries || [];
    setData({
      ...data,
      industries: curr.includes(ind) ? curr.filter((i) => i !== ind) : [...curr, ind],
    });
  };
  const addLang = (lang) => {
    if (!(data.languages || []).find((l) => l.code === lang.code)) {
      setData({
        ...data,
        languages: [...(data.languages || []), { ...lang, proficiency: 'intermediate' }],
      });
    }
  };
  const removeLang = (code) =>
    setData({ ...data, languages: (data.languages || []).filter((l) => l.code !== code) });
  const updateProf = (code, prof) =>
    setData({
      ...data,
      languages: (data.languages || []).map((l) =>
        l.code === code ? { ...l, proficiency: prof } : l
      ),
    });

  return (
    <div>
      <StepHeading
        icon={Icons.briefcase}
        iconColor={c.primary}
        title="Your Profile"
        subtitle="Tell us about your Salesforce journey. This takes about 10 minutes."
      />

      {/* Contact */}
      <div style={{ marginTop: 36, ...slideUp, animationDelay: '0.05s' }}>
        <SectionLabel icon={Icons.phone} color={c.primary}>
          Contact Information
        </SectionLabel>
        <div
          style={{ display: 'grid', gridTemplateColumns: '140px 1fr', gap: 12, alignItems: 'end' }}
        >
          <div>
            <FieldLabel>Country</FieldLabel>
            <SelectField
              value={data.countryCode || '+61'}
              onChange={(v) => setData({ ...data, countryCode: v })}
              options={[
                { value: '+61', label: '🇦🇺 +61' },
                { value: '+1', label: '🇺🇸 +1' },
                { value: '+44', label: '🇬🇧 +44' },
                { value: '+91', label: '🇮🇳 +91' },
              ]}
            />
          </div>
          <div>
            <FieldLabel required>Phone number</FieldLabel>
            <InputField
              placeholder="412 345 678"
              value={data.phone || ''}
              onChange={(e) => setData({ ...data, phone: e.target.value })}
            />
          </div>
        </div>
        <FieldHint>We'll only use this to contact you about your application.</FieldHint>
      </div>

      {/* Experience */}
      <div style={{ marginTop: 40, ...slideUp, animationDelay: '0.1s' }}>
        <SectionLabel icon={Icons.sparkle} color="#7C3AED">
          Salesforce Experience
        </SectionLabel>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <div>
            <FieldLabel required>Year started on Salesforce</FieldLabel>
            <SelectField
              value={data.yearStarted || ''}
              onChange={(v) => setData({ ...data, yearStarted: v })}
              placeholder="Select year"
              options={Array.from({ length: 26 }, (_, i) => 2026 - i).map((y) => ({
                value: String(y),
                label: String(y),
              }))}
            />
          </div>
          <div>
            <FieldLabel required>Projects involved in</FieldLabel>
            <SelectField
              value={data.projectCount || ''}
              onChange={(v) => setData({ ...data, projectCount: v })}
              placeholder="Select range"
              options={PROJECT_OPTS}
            />
          </div>
          <div>
            <FieldLabel required>Projects as Lead</FieldLabel>
            <SelectField
              value={data.projectLead || ''}
              onChange={(v) => setData({ ...data, projectLead: v })}
              placeholder="Select range"
              options={PROJECT_OPTS}
            />
          </div>
          <div>
            <FieldLabel>LinkedIn</FieldLabel>
            <InputField
              prefix="linkedin.com/in/"
              placeholder="your-profile"
              value={data.linkedin || ''}
              onChange={(e) => setData({ ...data, linkedin: e.target.value })}
            />
          </div>
        </div>
        <FieldHint>
          Projects as Lead = where you were the primary consultant or architect.
        </FieldHint>
      </div>

      {/* Languages */}
      <div style={{ marginTop: 40, ...slideUp, animationDelay: '0.15s' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <SectionLabel icon={Icons.globe} color="#0891B2">
            Languages
          </SectionLabel>
          <select
            onChange={(e) => {
              const l = LANGUAGES.find((x) => x.code === e.target.value);
              if (l) addLang(l);
              e.target.value = '';
            }}
            defaultValue=""
            style={{
              padding: '7px 14px',
              borderRadius: 8,
              fontSize: 13,
              fontWeight: 500,
              border: `1px solid ${c.primaryBorder}`,
              background: c.primaryLight,
              color: c.primary,
              cursor: 'pointer',
            }}
          >
            <option value="" disabled>
              + Add language
            </option>
            {LANGUAGES.filter((l) => !(data.languages || []).find((dl) => dl.code === l.code)).map(
              (l) => (
                <option key={l.code} value={l.code}>
                  {l.flag} {l.name}
                </option>
              )
            )}
          </select>
        </div>
        <p style={{ fontSize: 13, color: c.textSecondary, margin: '-6px 0 14px' }}>
          Languages you can consult in. Add at least one.
        </p>
        {(data.languages || []).length === 0 ? (
          <div
            style={{
              padding: '20px',
              borderRadius: 12,
              border: `2px dashed ${c.border}`,
              textAlign: 'center',
              color: c.textTertiary,
              fontSize: 13,
            }}
          >
            No languages added yet
          </div>
        ) : (
          <div style={{ border: `1px solid ${c.border}`, borderRadius: 12, overflow: 'hidden' }}>
            {(data.languages || []).map((lang, i) => (
              <div
                key={lang.code}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  padding: '12px 16px',
                  borderBottom:
                    i < data.languages.length - 1 ? `1px solid ${c.borderSubtle}` : 'none',
                  background: c.surface,
                  ...slideInRight,
                  ...stagger(i, 0.06),
                }}
              >
                <span style={{ fontSize: 18, width: 24 }}>{lang.flag}</span>
                <span style={{ flex: 1, fontSize: 14, fontWeight: 500, color: c.text }}>
                  {lang.name}
                </span>
                <select
                  value={lang.proficiency}
                  onChange={(e) => updateProf(lang.code, e.target.value)}
                  style={{
                    padding: '5px 10px',
                    borderRadius: 6,
                    fontSize: 13,
                    border: `1px solid ${c.border}`,
                    background: c.surface,
                    color: c.text,
                    cursor: 'pointer',
                  }}
                >
                  {['beginner', 'intermediate', 'advanced', 'native'].map((p) => (
                    <option key={p} value={p}>
                      {p.charAt(0).toUpperCase() + p.slice(1)}
                    </option>
                  ))}
                </select>
                <Badge variant={lang.proficiency}>{lang.proficiency}</Badge>
                <button
                  onClick={() => removeLang(lang.code)}
                  style={{
                    width: 28,
                    height: 28,
                    borderRadius: 6,
                    border: 'none',
                    background: 'transparent',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    transition: 'background 0.15s',
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = c.surfaceSubtle)}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                >
                  <Icons.x size={14} color={c.textTertiary} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Distinctions */}
      <div style={{ marginTop: 40, ...slideUp, animationDelay: '0.2s' }}>
        <div
          style={{
            background: c.gradientSubtle,
            borderRadius: 16,
            padding: '24px 28px',
            border: `1px solid ${c.accentBorder}40`,
          }}
        >
          <SectionLabel icon={Icons.award} color={c.accent}>
            Salesforce Distinctions
          </SectionLabel>
          <p style={{ fontSize: 12, color: c.textTertiary, marginTop: -6, marginBottom: 12 }}>
            Check any that apply — they'll be highlighted on your profile.
          </p>
          <CheckboxField
            checked={data.mvp}
            onChange={(v) => setData({ ...data, mvp: v })}
            label="Salesforce MVP"
            description="Recognized for outstanding community contributions"
          />
          <CheckboxField
            checked={data.cta}
            onChange={(v) => setData({ ...data, cta: v })}
            label="Salesforce CTA (Certified Technical Architect)"
            description="The highest Salesforce certification"
          />
          <CheckboxField
            checked={data.trainer}
            onChange={(v) => setData({ ...data, trainer: v })}
            label="Certified Salesforce Trainer"
            description="Authorized to deliver official Salesforce training"
          />
        </div>
      </div>

      {/* Industries */}
      <div style={{ marginTop: 40, ...slideUp, animationDelay: '0.25s' }}>
        <SectionLabel icon={Icons.building} color="#059669">
          Industry Expertise
        </SectionLabel>
        <p style={{ fontSize: 13, color: c.textSecondary, marginTop: -6, marginBottom: 16 }}>
          Select industries you have consulting experience in.
        </p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {INDUSTRIES.map((ind, i) => (
            <Chip
              key={ind}
              label={ind}
              selected={(data.industries || []).includes(ind)}
              onClick={() => toggleIndustry(ind)}
              animStyle={{ ...fadeIn, ...stagger(i, 0.02) }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Step 2: Products ─────────────────────────────────────────────

function StepProducts({ data, setData }) {
  const [search, setSearch] = useState('');
  const sel = data.products || [];
  const toggle = (n) =>
    setData({ ...data, products: sel.includes(n) ? sel.filter((p) => p !== n) : [...sel, n] });
  const filtered = SKILL_CATEGORIES.map((cat) => ({
    ...cat,
    skills: cat.skills.filter((s) => s.toLowerCase().includes(search.toLowerCase())),
  })).filter((cat) => cat.skills.length > 0);

  return (
    <div>
      <StepHeading
        icon={Icons.sparkle}
        iconColor="#7C3AED"
        title="Product Expertise"
        subtitle="Select the Salesforce products you have hands-on experience with."
      />

      {sel.length > 0 && (
        <div
          style={{
            marginTop: 24,
            paddingBottom: 20,
            borderBottom: `1px solid ${c.borderSubtle}`,
            ...fadeIn,
          }}
        >
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
            {sel.map((n, i) => (
              <span
                key={n}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '6px 12px',
                  borderRadius: 20,
                  fontSize: 13,
                  fontWeight: 500,
                  background: c.primaryLight,
                  color: c.primary,
                  border: `1px solid ${c.primaryBorder}`,
                  ...scaleIn,
                  ...stagger(i, 0.03),
                }}
              >
                {n}
                <button
                  onClick={() => toggle(n)}
                  style={{
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    color: c.primary,
                    padding: 0,
                    display: 'flex',
                  }}
                >
                  <Icons.x size={13} />
                </button>
              </span>
            ))}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{ fontSize: 12, color: c.textTertiary }}>
              {sel.length} product{sel.length !== 1 ? 's' : ''} selected
            </span>
            {sel.length >= 3 && (
              <span
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  color: c.success,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                }}
              >
                <Icons.check size={12} color={c.success} /> Great coverage
              </span>
            )}
          </div>
        </div>
      )}

      <div style={{ marginTop: 20, position: 'relative' }}>
        <span style={{ position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)' }}>
          <Icons.search size={16} color={c.textTertiary} />
        </span>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search products... e.g. Sales Cloud, CPQ"
          style={{
            width: '100%',
            padding: '12px 14px 12px 42px',
            fontSize: 14,
            border: `1px solid ${c.border}`,
            borderRadius: 10,
            outline: 'none',
            color: c.text,
            background: c.surface,
            boxSizing: 'border-box',
            transition: 'border-color 0.2s, box-shadow 0.2s',
          }}
          onFocus={(e) => {
            e.target.style.borderColor = c.primary;
            e.target.style.boxShadow = `0 0 0 3px ${c.primaryGlow}`;
          }}
          onBlur={(e) => {
            e.target.style.borderColor = c.border;
            e.target.style.boxShadow = 'none';
          }}
        />
      </div>
      <p style={{ fontSize: 12, color: c.textTertiary, marginTop: 8, fontStyle: 'italic' }}>
        Most experts select 3–8 products.
      </p>

      <div style={{ marginTop: 28 }}>
        {filtered.map((cat, ci) => (
          <div key={cat.name} style={{ marginBottom: 28, ...slideUp, ...stagger(ci, 0.06) }}>
            <p
              style={{
                fontSize: 11,
                fontWeight: 650,
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
                color: c.textTertiary,
                marginBottom: 10,
              }}
            >
              {cat.name}
            </p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {cat.skills.map((sk) => (
                <Chip key={sk} label={sk} selected={sel.includes(sk)} onClick={() => toggle(sk)} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Step 3: Assessment ───────────────────────────────────────────

function StepAssessment({ data, setData }) {
  const products = data.products || [];
  const ratings = data.ratings || {};
  const [expanded, setExpanded] = useState(products[0] || null);
  const setRating = (p, d, v) => setData({ ...data, ratings: { ...ratings, [`${p}::${d}`]: v } });
  const getRating = (p, d) => ratings[`${p}::${d}`] || 0;
  const getStatus = (p) => {
    const r = SUPPORT_TYPES.filter((st) => getRating(p, st.name) > 0).length;
    return { rated: r, complete: r > 0 };
  };
  const completedCount = products.filter((p) => getStatus(p).complete).length;

  return (
    <div>
      <StepHeading
        icon={Icons.compass}
        iconColor="#0891B2"
        title="Self-Assessment"
        subtitle="Rate your proficiency for each product across 4 support dimensions."
      />

      <div
        style={{
          marginTop: 24,
          padding: '14px 20px',
          borderRadius: 12,
          background:
            completedCount === products.length && products.length > 0
              ? c.successLight
              : c.surfaceSubtle,
          border: `1px solid ${completedCount === products.length && products.length > 0 ? c.successBorder : c.borderSubtle}`,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          transition: 'all 0.3s',
          ...fadeIn,
        }}
      >
        <span style={{ fontSize: 13, fontWeight: 500, color: c.text }}>
          {completedCount} of {products.length} products assessed
        </span>
        <div
          style={{
            width: 140,
            height: 6,
            borderRadius: 3,
            background: c.border,
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              width: `${products.length ? (completedCount / products.length) * 100 : 0}%`,
              height: '100%',
              borderRadius: 3,
              background:
                completedCount === products.length && products.length > 0 ? c.success : c.gradient,
              transition: 'width 0.5s ease',
            }}
          />
        </div>
      </div>

      <div style={{ marginTop: 20, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {products.map((product, pi) => {
          const status = getStatus(product);
          const isExp = expanded === product;
          return (
            <div
              key={product}
              style={{
                border: `1px solid ${isExp ? c.primaryBorder : c.border}`,
                borderRadius: 14,
                overflow: 'hidden',
                background: c.surface,
                transition: 'all 0.25s',
                boxShadow: isExp ? `0 4px 16px ${c.primaryGlow}` : 'none',
                ...slideUp,
                ...stagger(pi, 0.05),
              }}
            >
              <button
                onClick={() => setExpanded(isExp ? null : product)}
                style={{
                  width: '100%',
                  padding: '16px 20px',
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                }}
              >
                <span style={{ fontSize: 15, fontWeight: 600, color: c.text }}>{product}</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span
                    style={{
                      fontSize: 12,
                      fontWeight: 600,
                      padding: '3px 10px',
                      borderRadius: 12,
                      background: status.complete ? c.successLight : c.errorLight,
                      color: status.complete ? c.success : c.error,
                      display: 'flex',
                      alignItems: 'center',
                      gap: 4,
                    }}
                  >
                    {status.complete ? (
                      <>
                        <Icons.check size={11} /> Assessed
                      </>
                    ) : (
                      'To assess'
                    )}
                  </span>
                  <span
                    style={{
                      transition: 'transform 0.25s ease',
                      transform: isExp ? 'rotate(180deg)' : 'none',
                      display: 'flex',
                    }}
                  >
                    <Icons.chevDown size={16} color={c.textTertiary} />
                  </span>
                </div>
              </button>
              {isExp && (
                <div
                  style={{
                    padding: '4px 20px 20px',
                    borderTop: `1px solid ${c.borderSubtle}`,
                    ...fadeIn,
                  }}
                >
                  {SUPPORT_TYPES.map((st) => {
                    const val = getRating(product, st.name);
                    const StIcon = st.icon;
                    return (
                      <div key={st.name} style={{ marginTop: 20 }}>
                        <div
                          style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                            marginBottom: 10,
                          }}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                            <div
                              style={{
                                width: 28,
                                height: 28,
                                borderRadius: 7,
                                background: `${st.color}12`,
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                              }}
                            >
                              <StIcon size={14} color={st.color} />
                            </div>
                            <div>
                              <span style={{ fontSize: 13, fontWeight: 600, color: c.text }}>
                                {st.name}
                              </span>
                              <span style={{ fontSize: 12, color: c.textTertiary, marginLeft: 8 }}>
                                {st.desc}
                              </span>
                            </div>
                          </div>
                          <span
                            style={{
                              fontSize: 12,
                              fontWeight: 600,
                              padding: '3px 10px',
                              borderRadius: 8,
                              background: val > 0 ? `${st.color}10` : c.surfaceSubtle,
                              color: val > 0 ? st.color : c.textTertiary,
                              transition: 'all 0.2s',
                              minWidth: 80,
                              textAlign: 'center',
                            }}
                          >
                            {val}/10 · {PROFICIENCY_LABELS[val]}
                          </span>
                        </div>
                        <div style={{ position: 'relative' }}>
                          <div
                            style={{
                              position: 'absolute',
                              top: '50%',
                              left: 0,
                              right: 0,
                              height: 6,
                              borderRadius: 3,
                              background: c.border,
                              transform: 'translateY(-50%)',
                              overflow: 'hidden',
                            }}
                          >
                            <div
                              style={{
                                width: `${val * 10}%`,
                                height: '100%',
                                borderRadius: 3,
                                background: `linear-gradient(90deg, ${st.color}90, ${st.color})`,
                                transition: 'width 0.2s ease',
                              }}
                            />
                          </div>
                          <input
                            type="range"
                            min="0"
                            max="10"
                            value={val}
                            onChange={(e) => setRating(product, st.name, Number(e.target.value))}
                            style={{
                              width: '100%',
                              cursor: 'pointer',
                              position: 'relative',
                              zIndex: 2,
                              background: 'transparent',
                              height: 24,
                            }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Step 4: Certifications ───────────────────────────────────────

function StepCertifications({ data, setData }) {
  const sel = data.certs || [];
  const [showPicker, setShowPicker] = useState(false);
  const toggle = (n) =>
    setData({ ...data, certs: sel.includes(n) ? sel.filter((x) => x !== n) : [...sel, n] });

  return (
    <div style={{ maxWidth: 680, margin: '0 auto' }}>
      <StepHeading
        icon={Icons.award}
        iconColor="#D97706"
        title="Certifications"
        subtitle="Add your Salesforce certifications. Optional but builds trust."
      />

      <div style={{ marginTop: 32, ...slideUp, animationDelay: '0.05s' }}>
        <SectionLabel icon={Icons.globe} color="#0891B2">
          Trailhead Profile
        </SectionLabel>
        <div
          style={{
            padding: '14px 18px',
            borderRadius: 12,
            marginBottom: 14,
            background: `linear-gradient(135deg, ${c.primaryLight}, ${c.accentLight})`,
            border: `1px solid ${c.primaryBorder}80`,
            display: 'flex',
            alignItems: 'flex-start',
            gap: 10,
          }}
        >
          <Icons.info size={16} color={c.primary} style={{ marginTop: 1, flexShrink: 0 }} />
          <p style={{ fontSize: 13, color: c.primary, margin: 0, lineHeight: 1.5 }}>
            Adding your Trailhead profile speeds up review. Ensure your profile is public.
          </p>
        </div>
        <InputField
          prefix="trailblazer.me/id/"
          placeholder="your-username"
          value={data.trailhead || ''}
          onChange={(e) => setData({ ...data, trailhead: e.target.value })}
        />
      </div>

      <div style={{ marginTop: 36, ...slideUp, animationDelay: '0.1s' }}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 16,
          }}
        >
          <SectionLabel icon={Icons.award} color="#D97706">
            Your Certifications
          </SectionLabel>
          <button
            onClick={() => setShowPicker(!showPicker)}
            style={{
              padding: '8px 16px',
              borderRadius: 8,
              fontSize: 13,
              fontWeight: 500,
              border: `1px solid ${showPicker ? c.border : c.primaryBorder}`,
              background: showPicker ? c.surface : c.primaryLight,
              color: showPicker ? c.textSecondary : c.primary,
              cursor: 'pointer',
              transition: 'all 0.2s',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            {showPicker ? (
              <>
                <Icons.check size={13} /> Done
              </>
            ) : (
              <>
                <Icons.plus size={13} /> Add certifications
              </>
            )}
          </button>
        </div>

        {showPicker && (
          <div
            style={{
              marginBottom: 20,
              padding: 20,
              borderRadius: 14,
              border: `1px solid ${c.primaryBorder}`,
              background: c.primaryLight + '30',
              maxHeight: 380,
              overflowY: 'auto',
              ...scaleIn,
            }}
          >
            {CERT_CATEGORIES.map((cat, ci) => (
              <div key={cat.name} style={{ marginBottom: 20, ...fadeIn, ...stagger(ci, 0.05) }}>
                <p
                  style={{
                    fontSize: 11,
                    fontWeight: 650,
                    letterSpacing: '0.08em',
                    textTransform: 'uppercase',
                    color: c.textTertiary,
                    marginBottom: 8,
                  }}
                >
                  {cat.name}
                </p>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {cat.certs.map((cert) => (
                    <Chip
                      key={cert}
                      label={cert}
                      selected={sel.includes(cert)}
                      onClick={() => toggle(cert)}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        {sel.length === 0 && !showPicker ? (
          <EmptyState
            icon={Icons.award}
            iconColor="#D97706"
            title="No certifications added yet"
            subtitle="Certifications build credibility with clients"
            action="+ Add certifications"
            onAction={() => setShowPicker(true)}
          />
        ) : (
          sel.length > 0 && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              {sel.map((cert, i) => (
                <div
                  key={cert}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '14px 16px',
                    borderRadius: 12,
                    border: `1px solid ${c.border}`,
                    background: c.surface,
                    transition: 'all 0.2s',
                    ...scaleIn,
                    ...stagger(i, 0.04),
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.borderColor = c.primaryBorder;
                    e.currentTarget.style.boxShadow = `0 2px 8px ${c.primaryGlow}`;
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.borderColor = c.border;
                    e.currentTarget.style.boxShadow = 'none';
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <div
                      style={{
                        width: 28,
                        height: 28,
                        borderRadius: 7,
                        background: '#D9770615',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      <Icons.award size={14} color="#D97706" />
                    </div>
                    <span style={{ fontSize: 13, fontWeight: 500, color: c.text }}>{cert}</span>
                  </div>
                  <button
                    onClick={() => toggle(cert)}
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
                      transition: 'background 0.15s',
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = c.surfaceSubtle)}
                    onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                  >
                    <Icons.x size={14} color={c.textTertiary} />
                  </button>
                </div>
              ))}
            </div>
          )
        )}
      </div>
    </div>
  );
}

// ── Step 5: Work History ─────────────────────────────────────────

function StepWorkHistory({ data, setData }) {
  const entries = data.workHistory || [];
  const [showForm, setShowForm] = useState(false);
  const [editIdx, setEditIdx] = useState(null);
  const [form, setForm] = useState({
    role: '',
    company: '',
    startDate: '',
    endDate: '',
    isCurrent: false,
    responsibilities: '',
  });
  const reset = () => {
    setForm({
      role: '',
      company: '',
      startDate: '',
      endDate: '',
      isCurrent: false,
      responsibilities: '',
    });
    setEditIdx(null);
    setShowForm(false);
  };
  const save = () => {
    if (!form.role || !form.company || !form.startDate) return;
    const n = [...entries];
    if (editIdx !== null) n[editIdx] = form;
    else n.push(form);
    setData({ ...data, workHistory: n });
    reset();
  };
  const del = (i) => setData({ ...data, workHistory: entries.filter((_, j) => j !== i) });
  const edit = (i) => {
    setForm(entries[i]);
    setEditIdx(i);
    setShowForm(true);
  };

  return (
    <div style={{ maxWidth: 680, margin: '0 auto' }}>
      <StepHeading
        icon={Icons.briefcase}
        iconColor="#059669"
        title="Work History"
        subtitle="Add your relevant Salesforce experience. Optional."
      />
      <div style={{ marginTop: 28 }}>
        {entries.length === 0 && !showForm ? (
          <EmptyState
            icon={Icons.briefcase}
            iconColor="#059669"
            title="No work experience added yet"
            subtitle="Showcase your Salesforce career"
            action="+ Add experience"
            onAction={() => setShowForm(true)}
          />
        ) : (
          <>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {entries.map((e, i) => (
                <div
                  key={i}
                  style={{
                    padding: '18px 22px',
                    borderRadius: 14,
                    border: `1px solid ${c.border}`,
                    background: c.surface,
                    transition: 'all 0.2s',
                    ...slideUp,
                    ...stagger(i, 0.06),
                  }}
                  onMouseEnter={(ev) => {
                    ev.currentTarget.style.borderColor = c.primaryBorder;
                    ev.currentTarget.style.boxShadow = `0 2px 8px ${c.primaryGlow}`;
                  }}
                  onMouseLeave={(ev) => {
                    ev.currentTarget.style.borderColor = c.border;
                    ev.currentTarget.style.boxShadow = 'none';
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'flex-start',
                    }}
                  >
                    <div>
                      <p style={{ fontSize: 15, fontWeight: 600, color: c.text, margin: 0 }}>
                        {e.role}
                      </p>
                      <p style={{ fontSize: 14, color: c.textSecondary, margin: '3px 0 0' }}>
                        {e.company}
                      </p>
                      <p style={{ fontSize: 12, color: c.textTertiary, margin: '6px 0 0' }}>
                        {e.startDate} — {e.isCurrent ? 'Present' : e.endDate}
                      </p>
                    </div>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button
                        onClick={() => edit(i)}
                        style={{
                          width: 32,
                          height: 32,
                          borderRadius: 8,
                          border: 'none',
                          background: 'transparent',
                          cursor: 'pointer',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          transition: 'background 0.15s',
                        }}
                        onMouseEnter={(ev) => (ev.currentTarget.style.background = c.surfaceSubtle)}
                        onMouseLeave={(ev) => (ev.currentTarget.style.background = 'transparent')}
                      >
                        <Icons.edit size={15} color={c.textTertiary} />
                      </button>
                      <button
                        onClick={() => del(i)}
                        style={{
                          width: 32,
                          height: 32,
                          borderRadius: 8,
                          border: 'none',
                          background: 'transparent',
                          cursor: 'pointer',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          transition: 'background 0.15s',
                        }}
                        onMouseEnter={(ev) => (ev.currentTarget.style.background = c.errorLight)}
                        onMouseLeave={(ev) => (ev.currentTarget.style.background = 'transparent')}
                      >
                        <Icons.trash size={15} color={c.error} />
                      </button>
                    </div>
                  </div>
                  {e.responsibilities && (
                    <p
                      style={{
                        fontSize: 13,
                        color: c.textSecondary,
                        marginTop: 10,
                        lineHeight: 1.5,
                      }}
                    >
                      {e.responsibilities}
                    </p>
                  )}
                </div>
              ))}
            </div>
            {!showForm && (
              <button
                onClick={() => setShowForm(true)}
                style={{
                  marginTop: 16,
                  padding: '10px 20px',
                  borderRadius: 8,
                  fontSize: 13,
                  fontWeight: 500,
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
                  e.currentTarget.style.background = c.primaryLight;
                  e.currentTarget.style.color = c.primary;
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.borderColor = c.border;
                  e.currentTarget.style.background = c.surface;
                  e.currentTarget.style.color = c.text;
                }}
              >
                <Icons.plus size={14} /> Add another
              </button>
            )}
          </>
        )}

        {showForm && (
          <div
            style={{
              marginTop: 16,
              padding: 24,
              borderRadius: 16,
              border: `1px solid ${c.primaryBorder}`,
              background: `${c.primaryLight}40`,
              ...scaleIn,
            }}
          >
            <p style={{ fontSize: 14, fontWeight: 600, color: c.text, margin: '0 0 20px' }}>
              {editIdx !== null ? 'Edit experience' : 'Add experience'}
            </p>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
              <div>
                <FieldLabel required>Role</FieldLabel>
                <InputField
                  placeholder="Senior Salesforce Developer"
                  value={form.role}
                  onChange={(e) => setForm({ ...form, role: e.target.value })}
                />
              </div>
              <div>
                <FieldLabel required>Company</FieldLabel>
                <InputField
                  placeholder="ACME Corporation"
                  value={form.company}
                  onChange={(e) => setForm({ ...form, company: e.target.value })}
                />
              </div>
              <div>
                <FieldLabel required>Start date</FieldLabel>
                <input
                  type="month"
                  value={form.startDate}
                  onChange={(e) => setForm({ ...form, startDate: e.target.value })}
                  style={{
                    width: '100%',
                    padding: '10px 14px',
                    fontSize: 14,
                    border: `1px solid ${c.border}`,
                    borderRadius: 8,
                    color: c.text,
                    background: c.surface,
                    boxSizing: 'border-box',
                  }}
                />
              </div>
              <div>
                <FieldLabel>End date</FieldLabel>
                <input
                  type="month"
                  value={form.endDate}
                  onChange={(e) => setForm({ ...form, endDate: e.target.value })}
                  disabled={form.isCurrent}
                  style={{
                    width: '100%',
                    padding: '10px 14px',
                    fontSize: 14,
                    border: `1px solid ${c.border}`,
                    borderRadius: 8,
                    color: form.isCurrent ? c.textTertiary : c.text,
                    background: form.isCurrent ? c.surfaceSubtle : c.surface,
                    boxSizing: 'border-box',
                  }}
                />
                <div style={{ marginTop: 8 }}>
                  <CheckboxField
                    checked={form.isCurrent}
                    onChange={(v) => setForm({ ...form, isCurrent: v, endDate: '' })}
                    label="Currently in this role"
                  />
                </div>
              </div>
            </div>
            <div style={{ marginTop: 16 }}>
              <FieldLabel>Responsibilities</FieldLabel>
              <textarea
                placeholder="Brief description of your duties..."
                value={form.responsibilities}
                onChange={(e) => setForm({ ...form, responsibilities: e.target.value })}
                rows={3}
                style={{
                  width: '100%',
                  padding: '10px 14px',
                  fontSize: 14,
                  border: `1px solid ${c.border}`,
                  borderRadius: 8,
                  resize: 'vertical',
                  color: c.text,
                  fontFamily: 'inherit',
                  boxSizing: 'border-box',
                }}
              />
            </div>
            <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
              <button
                onClick={save}
                style={{
                  padding: '10px 24px',
                  borderRadius: 8,
                  fontSize: 14,
                  fontWeight: 600,
                  border: 'none',
                  background: c.primary,
                  color: 'white',
                  cursor: 'pointer',
                  transition: 'all 0.2s',
                  boxShadow: `0 2px 8px ${c.primaryGlow}`,
                }}
              >
                Save
              </button>
              <button
                onClick={reset}
                style={{
                  padding: '10px 20px',
                  borderRadius: 8,
                  fontSize: 14,
                  fontWeight: 500,
                  border: `1px solid ${c.border}`,
                  background: c.surface,
                  color: c.text,
                  cursor: 'pointer',
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Step 6: Invite ───────────────────────────────────────────────

function StepInvite({ data, setData }) {
  const [input, setInput] = useState('');
  const emails = data.inviteEmails || [];
  const add = () => {
    const cands = input
      .split(/[,\s]+/)
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.includes('@') && s.length > 3);
    setData({ ...data, inviteEmails: [...new Set([...emails, ...cands])] });
    setInput('');
  };
  const remove = (e) => setData({ ...data, inviteEmails: emails.filter((x) => x !== e) });

  return (
    <div style={{ maxWidth: 520, margin: '0 auto', textAlign: 'center', paddingTop: 24 }}>
      <div
        style={{
          width: 64,
          height: 64,
          borderRadius: 16,
          margin: '0 auto 20px',
          background: 'linear-gradient(135deg, #DB277715, #7C3AED15)',
          border: '1px solid #DB277725',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          ...slideUp,
        }}
      >
        <Icons.users size={28} color="#DB2777" />
      </div>
      <h2
        style={{
          fontSize: 22,
          fontWeight: 680,
          color: c.text,
          margin: 0,
          ...slideUp,
          animationDelay: '0.05s',
        }}
      >
        Invite Other Experts
      </h2>
      <p
        style={{
          fontSize: 14,
          color: c.textSecondary,
          marginTop: 8,
          lineHeight: 1.6,
          ...slideUp,
          animationDelay: '0.1s',
        }}
      >
        Know other Salesforce experts? Invite them to Balo. Completely optional.
      </p>

      <div style={{ marginTop: 32, textAlign: 'left', ...slideUp, animationDelay: '0.15s' }}>
        <FieldLabel>Email addresses</FieldLabel>
        <div style={{ display: 'flex', gap: 8 }}>
          <InputField
            placeholder="expert@company.com"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            style={{ flex: 1 }}
          />
          <button
            onClick={add}
            style={{
              padding: '10px 20px',
              borderRadius: 8,
              fontSize: 14,
              fontWeight: 500,
              border: `1px solid ${c.primaryBorder}`,
              background: c.primaryLight,
              color: c.primary,
              cursor: 'pointer',
              whiteSpace: 'nowrap',
              transition: 'all 0.2s',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            <Icons.send size={14} /> Add
          </button>
        </div>
        <FieldHint>Separate multiple emails with commas.</FieldHint>

        {emails.length > 0 && (
          <div
            style={{
              marginTop: 20,
              padding: 16,
              borderRadius: 12,
              background: c.surfaceSubtle,
              border: `1px solid ${c.borderSubtle}`,
              ...fadeIn,
            }}
          >
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {emails.map((email, i) => (
                <span
                  key={email}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: '5px 12px',
                    borderRadius: 20,
                    fontSize: 13,
                    background: c.surface,
                    border: `1px solid ${c.border}`,
                    color: c.text,
                    ...scaleIn,
                    ...stagger(i, 0.04),
                  }}
                >
                  <Icons.mail size={12} color={c.textTertiary} />
                  {email}
                  <button
                    onClick={() => remove(email)}
                    style={{
                      background: 'none',
                      border: 'none',
                      cursor: 'pointer',
                      display: 'flex',
                      padding: 0,
                    }}
                  >
                    <Icons.x size={12} color={c.textTertiary} />
                  </button>
                </span>
              ))}
            </div>
            <p style={{ fontSize: 12, color: c.textTertiary, marginTop: 10 }}>
              {emails.length} invitation{emails.length !== 1 ? 's' : ''} ready
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Step 7: Terms ────────────────────────────────────────────────

function StepTerms({ data, setData, onSubmit }) {
  const [scrolledBottom, setScrolledBottom] = useState(false);
  const handleScroll = (e) => {
    const { scrollTop, scrollHeight, clientHeight } = e.target;
    if (scrollHeight - scrollTop - clientHeight < 30) setScrolledBottom(true);
  };

  return (
    <div style={{ maxWidth: 680, margin: '0 auto' }}>
      <StepHeading
        icon={Icons.shield}
        iconColor="#4F46E5"
        title="Terms & Conditions"
        subtitle="Review and accept to submit your application."
      />

      {/* Summary */}
      <div
        style={{
          marginTop: 28,
          padding: '18px 22px',
          borderRadius: 14,
          background: c.gradientSubtle,
          border: `1px solid ${c.accentBorder}40`,
          ...slideUp,
          animationDelay: '0.05s',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
          <Icons.clipboard size={15} color={c.accent} />
          <p style={{ fontSize: 13, fontWeight: 650, color: c.text, margin: 0 }}>
            Application Summary
          </p>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 24px' }}>
          {[
            ['Products', `${(data.products || []).length} selected`],
            ['Certifications', `${(data.certs || []).length} added`],
            ['Work History', `${(data.workHistory || []).length} entries`],
            ['Languages', `${(data.languages || []).length} added`],
          ].map(([l, v]) => (
            <div key={l} style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ fontSize: 13, color: c.textSecondary }}>{l}</span>
              <span style={{ fontSize: 13, fontWeight: 500, color: c.text }}>{v}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Terms */}
      <div
        style={{
          marginTop: 24,
          borderRadius: 14,
          border: `1px solid ${c.border}`,
          overflow: 'hidden',
          ...slideUp,
          animationDelay: '0.1s',
        }}
      >
        <div
          style={{
            padding: '14px 20px',
            borderBottom: `1px solid ${c.borderSubtle}`,
            background: c.surfaceSubtle,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <Icons.fileText size={14} color={c.textSecondary} />
          <div>
            <p style={{ fontSize: 13, fontWeight: 600, color: c.text, margin: 0 }}>
              Balo Expert Terms and Conditions
            </p>
            <p style={{ fontSize: 11, color: c.textTertiary, margin: 0 }}>
              Last updated: February 2026
            </p>
          </div>
        </div>
        <div
          onScroll={handleScroll}
          style={{
            padding: 20,
            maxHeight: 260,
            overflowY: 'auto',
            fontSize: 13,
            lineHeight: 1.7,
            color: c.textSecondary,
          }}
        >
          <p>
            <strong style={{ color: c.text }}>1. Independent Contractor Status.</strong> You
            acknowledge that you are an independent contractor and not an employee of Balo.
          </p>
          <p>
            <strong style={{ color: c.text }}>2. Platform Usage.</strong> You agree to provide
            accurate information about your qualifications and experience.
          </p>
          <p>
            <strong style={{ color: c.text }}>3. Service Quality.</strong> You will provide
            professional consulting services to the best of your ability.
          </p>
          <p>
            <strong style={{ color: c.text }}>4. Payment & Fees.</strong> Balo collects payments on
            your behalf and remits earnings less a 25% platform fee via Stripe Connect.
          </p>
          <p>
            <strong style={{ color: c.text }}>5. Intellectual Property.</strong> You retain
            ownership of pre-existing IP. Work product is owned by the client unless otherwise
            agreed.
          </p>
          <p>
            <strong style={{ color: c.text }}>6. Confidentiality.</strong> You agree to maintain the
            confidentiality of client information.
          </p>
          <p>
            <strong style={{ color: c.text }}>7. Termination.</strong> Either party may terminate
            with 30 days written notice.
          </p>
        </div>
        {!scrolledBottom && (
          <div
            style={{
              padding: '10px 20px',
              background: c.surfaceSubtle,
              borderTop: `1px solid ${c.borderSubtle}`,
              textAlign: 'center',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 6,
            }}
          >
            <Icons.chevDown size={14} color={c.textTertiary} />
            <p style={{ fontSize: 12, color: c.textTertiary, margin: 0 }}>
              Scroll to read full terms
            </p>
          </div>
        )}
      </div>

      <div style={{ marginTop: 24, ...slideUp, animationDelay: '0.15s' }}>
        <CheckboxField
          checked={data.termsAccepted}
          onChange={(v) => setData({ ...data, termsAccepted: v })}
          label="I have read and agree to Balo's Expert Terms and Conditions"
        />
      </div>

      <div style={{ marginTop: 36, textAlign: 'center', ...slideUp, animationDelay: '0.2s' }}>
        <button
          onClick={onSubmit}
          disabled={!data.termsAccepted}
          style={{
            padding: '14px 48px',
            borderRadius: 12,
            fontSize: 16,
            fontWeight: 650,
            border: 'none',
            cursor: data.termsAccepted ? 'pointer' : 'not-allowed',
            background: data.termsAccepted ? c.gradient : c.border,
            color: data.termsAccepted ? 'white' : c.textTertiary,
            transition: 'all 0.3s ease',
            boxShadow: data.termsAccepted
              ? `0 4px 20px rgba(37,99,235,0.3), 0 2px 8px rgba(124,58,237,0.2)`
              : 'none',
            transform: data.termsAccepted ? 'none' : 'none',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
          }}
          onMouseEnter={(e) => {
            if (data.termsAccepted) e.currentTarget.style.transform = 'translateY(-2px)';
          }}
          onMouseLeave={(e) => (e.currentTarget.style.transform = 'none')}
        >
          Submit Application <Icons.arrowRight size={16} color="white" />
        </button>
        <p style={{ fontSize: 12, color: c.textTertiary, marginTop: 12 }}>
          We'll review your application within 5 business days.
        </p>
      </div>
    </div>
  );
}

// ── Success Page ─────────────────────────────────────────────────

function SuccessPage() {
  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: c.bg,
        fontFamily: "'DM Sans', -apple-system, sans-serif",
      }}
    >
      <div style={{ textAlign: 'center', maxWidth: 480, padding: 40, position: 'relative' }}>
        {/* Confetti-like particles */}
        {[c.primary, c.accent, '#059669', '#D97706', '#DB2777'].map((color, i) => (
          <div
            key={i}
            style={{
              position: 'absolute',
              width: 8,
              height: 8,
              borderRadius: 2,
              background: color,
              top: '30%',
              left: `${20 + i * 15}%`,
              animation: `confetti${(i % 3) + 1} 1.2s ease-out ${i * 0.1}s forwards`,
              opacity: 0,
            }}
          />
        ))}
        <div
          style={{
            width: 88,
            height: 88,
            borderRadius: '50%',
            margin: '0 auto 28px',
            background: c.gradient,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: `0 8px 32px rgba(37,99,235,0.3)`,
            ...scaleIn,
          }}
        >
          <span style={{ fontSize: 40 }}>🎉</span>
        </div>
        <h1
          style={{
            fontSize: 28,
            fontWeight: 700,
            color: c.text,
            margin: 0,
            ...slideUp,
            animationDelay: '0.1s',
          }}
        >
          Application Received!
        </h1>
        <p
          style={{
            fontSize: 15,
            color: c.textSecondary,
            marginTop: 14,
            lineHeight: 1.6,
            ...slideUp,
            animationDelay: '0.2s',
          }}
        >
          We'll review your application and reach out within 5 business days. In the meantime,
          explore the platform as a client.
        </p>
        <button
          style={{
            marginTop: 28,
            padding: '12px 32px',
            borderRadius: 10,
            fontSize: 15,
            fontWeight: 650,
            border: 'none',
            background: c.gradient,
            color: 'white',
            cursor: 'pointer',
            boxShadow: `0 4px 20px rgba(37,99,235,0.3)`,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            transition: 'transform 0.2s',
            ...slideUp,
            animationDelay: '0.3s',
          }}
          onMouseEnter={(e) => (e.currentTarget.style.transform = 'translateY(-2px)')}
          onMouseLeave={(e) => (e.currentTarget.style.transform = 'none')}
        >
          Explore as a Client <Icons.arrowRight size={16} color="white" />
        </button>
      </div>
    </div>
  );
}

// ── Main Wizard ──────────────────────────────────────────────────

export default function ExpertApplicationWizard() {
  const [step, setStep] = useState(0);
  const [completed, setCompleted] = useState(new Set());
  const [data, setData] = useState({
    countryCode: '+61',
    languages: [],
    industries: [],
    products: [],
    ratings: {},
    certs: [],
    workHistory: [],
    inviteEmails: [],
    termsAccepted: false,
  });
  const [submitted, setSubmitted] = useState(false);
  const [stepKey, setStepKey] = useState(0); // for re-triggering animations

  const goNext = () => {
    setCompleted((p) => new Set([...p, step]));
    if (step < STEPS.length - 1) {
      setStep(step + 1);
      setStepKey((k) => k + 1);
    }
  };
  const goPrev = () => {
    if (step > 0) {
      setStep(step - 1);
      setStepKey((k) => k + 1);
    }
  };

  if (submitted)
    return (
      <>
        <style>{keyframes}</style>
        <SuccessPage />
      </>
    );

  const comps = [
    <StepProfile data={data} setData={setData} />,
    <StepProducts data={data} setData={setData} />,
    <StepAssessment data={data} setData={setData} />,
    <StepCertifications data={data} setData={setData} />,
    <StepWorkHistory data={data} setData={setData} />,
    <StepInvite data={data} setData={setData} />,
    <StepTerms data={data} setData={setData} onSubmit={() => setSubmitted(true)} />,
  ];

  const isLast = step === STEPS.length - 1;
  const isOptional = [3, 4, 5].includes(step);

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
        href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap"
        rel="stylesheet"
      />

      <div style={{ maxWidth: 840, margin: '0 auto', padding: '32px 24px 120px' }}>
        <WizardProgress currentStep={step} completedSteps={completed} />
        <div key={stepKey}>{comps[step]}</div>
      </div>

      {!isLast && (
        <div
          style={{
            position: 'fixed',
            bottom: 0,
            left: 0,
            right: 0,
            background: 'rgba(255,255,255,0.92)',
            backdropFilter: 'blur(16px) saturate(180%)',
            borderTop: `1px solid ${c.borderSubtle}`,
            padding: '14px 24px',
          }}
        >
          <div
            style={{
              maxWidth: 840,
              margin: '0 auto',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}
          >
            <button
              onClick={goPrev}
              disabled={step === 0}
              style={{
                padding: '10px 22px',
                borderRadius: 8,
                fontSize: 14,
                fontWeight: 500,
                border: `1px solid ${c.border}`,
                background: c.surface,
                color: step === 0 ? c.textTertiary : c.text,
                cursor: step === 0 ? 'not-allowed' : 'pointer',
                opacity: step === 0 ? 0.5 : 1,
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                transition: 'all 0.2s',
              }}
            >
              <Icons.arrowLeft size={14} /> Previous
            </button>
            <div style={{ display: 'flex', gap: 10 }}>
              {isOptional && (
                <button
                  onClick={goNext}
                  style={{
                    padding: '10px 22px',
                    borderRadius: 8,
                    fontSize: 14,
                    fontWeight: 500,
                    border: `1px solid ${c.border}`,
                    background: c.surface,
                    color: c.textSecondary,
                    cursor: 'pointer',
                    transition: 'all 0.2s',
                  }}
                >
                  Skip
                </button>
              )}
              <button
                onClick={goNext}
                style={{
                  padding: '10px 28px',
                  borderRadius: 8,
                  fontSize: 14,
                  fontWeight: 650,
                  border: 'none',
                  background: c.gradient,
                  color: 'white',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  boxShadow: `0 2px 10px rgba(37,99,235,0.2)`,
                  transition: 'all 0.2s',
                }}
                onMouseEnter={(e) => (e.currentTarget.style.transform = 'translateY(-1px)')}
                onMouseLeave={(e) => (e.currentTarget.style.transform = 'none')}
              >
                Next <Icons.arrowRight size={14} />
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
