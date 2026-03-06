import { useState } from 'react';

// ── Design Tokens (shared with wizard) ───────────────────────────
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
  cyan: '#0891B2',
  cyanLight: '#ECFEFF',
  cyanBorder: '#A5F3FC',
  amber: '#D97706',
  amberLight: '#FFFBEB',
  amberBorder: '#FDE68A',
  emerald: '#059669',
  emeraldLight: '#ECFDF5',
  emeraldBorder: '#A7F3D0',
  gradient: 'linear-gradient(135deg, #2563EB 0%, #7C3AED 100%)',
  gradientSubtle: 'linear-gradient(135deg, #EFF6FF 0%, #F5F3FF 100%)',
};

// ── Section color map (shared with wizard) ───────────────────────
const SECTION_COLORS = {
  primary: { text: '#2563EB', bg: 'rgba(37,99,235,0.1)' },
  violet: { text: '#7C3AED', bg: 'rgba(124,58,237,0.1)' },
  cyan: { text: '#0891B2', bg: 'rgba(8,145,178,0.1)' },
  amber: { text: '#D97706', bg: 'rgba(217,119,6,0.1)' },
  emerald: { text: '#059669', bg: 'rgba(5,150,105,0.1)' },
  pink: { text: '#DB2777', bg: 'rgba(219,39,119,0.1)' },
  indigo: { text: '#4F46E5', bg: 'rgba(79,70,229,0.1)' },
};

// ── Icons (SVG — same as wizard) ─────────────────────────────────
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
  check: (p) => <Icon {...p} d="M20 6L9 17l-5-5" />,
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
  wrench: (p) => (
    <Icon
      {...p}
      d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z"
    />
  ),
  shield: (p) => <Icon {...p} d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />,
  externalLink: (p) => (
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
      <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6M15 3h6v6M10 14L21 3" />
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
  arrowLeft: (p) => <Icon {...p} d="M19 12H5M12 19l-7-7 7-7" />,
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
};

// ── Animations ───────────────────────────────────────────────────
const keyframes = `
@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
@keyframes slideUp { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: translateY(0); } }
@keyframes shimmerBg { 0% { background-position: -200% 0; } 100% { background-position: 200% 0; } }
`;
const slideUp = { animation: 'slideUp 0.4s ease-out forwards', opacity: 0 };
const fadeIn = { animation: 'fadeIn 0.35s ease-out forwards', opacity: 0 };
function stagger(i, base = 0.06) {
  return { animationDelay: `${i * base}s` };
}

// ── Mock Data ────────────────────────────────────────────────────
const MOCK = {
  submittedAt: 'March 4, 2026',
  email: 'ylinkz@gmail.com',
  phone: '+61 412 345 678',
  yearStarted: 2015,
  projectCount: '26 – 50',
  projectLead: '10 – 25',
  linkedin: 'yomi-joseph',
  languages: [
    { name: 'English', flag: '🇬🇧', proficiency: 'native' },
    { name: 'French', flag: '🇫🇷', proficiency: 'intermediate' },
  ],
  industries: [
    'Technology',
    'Financial Services',
    'Professional Services',
    'Healthcare & Life Sciences',
  ],
  distinctions: ['Salesforce MVP'],
  products: [
    { category: 'Sales Cloud', skills: ['CPQ', 'Sales Cloud'] },
    { category: 'Platform', skills: ['Salesforce Platform', 'Security'] },
    { category: 'Service Cloud', skills: ['Service Cloud'] },
  ],
  ratings: {
    CPQ: { 'Technical Fix': 8, Architecture: 6, Strategy: 7, Training: 4 },
    'Sales Cloud': { 'Technical Fix': 9, Architecture: 8, Strategy: 9, Training: 7 },
    'Salesforce Platform': { 'Technical Fix': 7, Architecture: 9, Strategy: 6, Training: 5 },
    Security: { 'Technical Fix': 6, Architecture: 8, Strategy: 5, Training: 3 },
    'Service Cloud': { 'Technical Fix': 7, Architecture: 6, Strategy: 8, Training: 6 },
  },
  certifications: [
    { name: 'Administrator', category: 'Administrator' },
    { name: 'Platform Developer I', category: 'Developer' },
    { name: 'Sales Cloud Consultant', category: 'Consultant' },
    { name: 'Data Architect', category: 'Architect' },
  ],
  trailhead: 'yomi-joseph',
  workHistory: [
    {
      role: 'Senior Salesforce Consultant',
      company: 'Deloitte Digital',
      start: 'Jan 2021',
      end: 'Present',
      isCurrent: true,
      responsibilities:
        'Lead architect for enterprise Sales Cloud implementations. Managed cross-functional teams of 8+ across multiple concurrent projects.',
    },
    {
      role: 'Salesforce Developer',
      company: 'Accenture',
      start: 'Mar 2017',
      end: 'Dec 2020',
      isCurrent: false,
      responsibilities:
        'Built custom Lightning components and Apex triggers for financial services clients. Migrated legacy Classic org to Lightning Experience.',
    },
  ],
};

const SUPPORT_TYPES = [
  { name: 'Technical Fix', icon: Icons.wrench, color: '#2563EB' },
  { name: 'Architecture', icon: Icons.building, color: '#7C3AED' },
  { name: 'Strategy', icon: Icons.compass, color: '#0891B2' },
  { name: 'Training', icon: Icons.gradCap, color: '#059669' },
];

const PROFICIENCY_LABELS = [
  '—',
  'Very Limited',
  'Basic',
  'Limited',
  'Novice',
  'Intermediate',
  'Proficient',
  'Advanced',
  'Highly Exp.',
  'Expert',
  'Master',
];

const PROJECT_RANGE_MAP = { 0: 'None', 1: '1-9', 10: '10-25', 26: '26-50', 50: '50+' };

// ── Shared Components ────────────────────────────────────────────

function SectionLabel({ children, icon: IconComp, colorKey = 'primary' }) {
  const sc = SECTION_COLORS[colorKey] || SECTION_COLORS.primary;
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

function DataRow({ label, value, icon: IconComp }) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '10px 0',
      }}
    >
      <span
        style={{
          fontSize: 13,
          color: c.textSecondary,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}
      >
        {IconComp && <IconComp size={14} color={c.textTertiary} />}
        {label}
      </span>
      <span style={{ fontSize: 14, fontWeight: 500, color: c.text }}>{value}</span>
    </div>
  );
}

function Chip({ label, color }) {
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '6px 14px',
        borderRadius: 20,
        fontSize: 13,
        fontWeight: 500,
        background: color ? `${color}08` : c.surfaceSubtle,
        border: `1.5px solid ${color ? `${color}30` : c.border}`,
        color: color || c.textSecondary,
      }}
    >
      {label}
    </span>
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
      }}
    >
      {children}
    </span>
  );
}

function MiniBar({ value, max = 10, color }) {
  const pct = (value / max) * 100;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
      <div
        style={{
          flex: 1,
          height: 6,
          borderRadius: 3,
          background: c.border,
          overflow: 'hidden',
          minWidth: 60,
        }}
      >
        <div
          style={{
            width: `${pct}%`,
            height: '100%',
            borderRadius: 3,
            background: `linear-gradient(90deg, ${color}90, ${color})`,
            transition: 'width 0.3s ease',
          }}
        />
      </div>
      <span
        style={{
          fontSize: 12,
          fontWeight: 600,
          color: value > 0 ? color : c.textTertiary,
          minWidth: 24,
          textAlign: 'right',
        }}
      >
        {value}
      </span>
    </div>
  );
}

function Card({ children, style: extraStyle, hover }) {
  const [hovered, setHovered] = useState(false);
  return (
    <div
      onMouseEnter={hover ? () => setHovered(true) : undefined}
      onMouseLeave={hover ? () => setHovered(false) : undefined}
      style={{
        background: c.surface,
        borderRadius: 14,
        border: `1px solid ${hovered ? c.primaryBorder : c.border}`,
        transition: 'all 0.2s ease',
        boxShadow: hovered ? `0 4px 16px ${c.primaryGlow}` : 'none',
        ...extraStyle,
      }}
    >
      {children}
    </div>
  );
}

// ── Status Banner ────────────────────────────────────────────────

function StatusBanner() {
  return (
    <div
      style={{
        padding: '16px 24px',
        borderRadius: 14,
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        background: `linear-gradient(135deg, ${c.primaryLight}, ${c.accentLight})`,
        border: `1px solid ${c.primaryBorder}80`,
        ...slideUp,
      }}
    >
      <div
        style={{
          width: 40,
          height: 40,
          borderRadius: 10,
          flexShrink: 0,
          background: c.gradient,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          boxShadow: `0 2px 8px ${c.primaryGlow}`,
        }}
      >
        <Icons.clock size={20} color="white" />
      </div>
      <div>
        <p style={{ fontSize: 14, fontWeight: 600, color: c.text, margin: 0 }}>
          Application under review
        </p>
        <p style={{ fontSize: 13, color: c.textSecondary, margin: '3px 0 0', lineHeight: 1.5 }}>
          Submitted on {MOCK.submittedAt}. We'll email you at{' '}
          <strong style={{ color: c.text }}>{MOCK.email}</strong> within 2–3 business days.
        </p>
      </div>
    </div>
  );
}

// ── Section: Profile ─────────────────────────────────────────────

function ProfileSection() {
  return (
    <div style={{ ...slideUp, ...stagger(1) }}>
      <SectionLabel icon={Icons.phone} colorKey="primary">
        Contact & Experience
      </SectionLabel>
      <Card style={{ padding: '20px 24px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2px 32px' }}>
          <DataRow label="Phone" value={MOCK.phone} />
          <DataRow label="Year started" value={MOCK.yearStarted} />
          <DataRow label="Projects involved in" value={MOCK.projectCount} />
          <DataRow label="Projects as Lead" value={MOCK.projectLead} />
        </div>
        <div style={{ borderTop: `1px solid ${c.borderSubtle}`, marginTop: 8, paddingTop: 12 }}>
          <DataRow
            label="LinkedIn"
            icon={Icons.linkedin}
            value={
              <span
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  color: c.primary,
                  fontWeight: 500,
                }}
              >
                linkedin.com/in/{MOCK.linkedin}
                <Icons.externalLink size={12} color={c.primary} />
              </span>
            }
          />
        </div>
      </Card>
    </div>
  );
}

// ── Section: Languages ───────────────────────────────────────────

function LanguagesSection() {
  return (
    <div style={{ ...slideUp, ...stagger(2) }}>
      <SectionLabel icon={Icons.globe} colorKey="cyan">
        Languages
      </SectionLabel>
      <Card style={{ overflow: 'hidden' }}>
        {MOCK.languages.map((lang, i) => (
          <div
            key={lang.name}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              padding: '14px 20px',
              borderBottom: i < MOCK.languages.length - 1 ? `1px solid ${c.borderSubtle}` : 'none',
            }}
          >
            <span style={{ fontSize: 20, width: 28 }}>{lang.flag}</span>
            <span style={{ flex: 1, fontSize: 14, fontWeight: 500, color: c.text }}>
              {lang.name}
            </span>
            <Badge variant={lang.proficiency}>{lang.proficiency}</Badge>
          </div>
        ))}
      </Card>
    </div>
  );
}

// ── Section: Industries & Distinctions ───────────────────────────

function IndustriesSection() {
  return (
    <div style={{ ...slideUp, ...stagger(3) }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
        {/* Industries */}
        <div>
          <SectionLabel icon={Icons.building} colorKey="emerald">
            Industries
          </SectionLabel>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {MOCK.industries.map((ind) => (
              <Chip key={ind} label={ind} color={c.emerald} />
            ))}
          </div>
        </div>
        {/* Distinctions */}
        <div>
          <SectionLabel icon={Icons.award} colorKey="amber">
            Distinctions
          </SectionLabel>
          {MOCK.distinctions.length > 0 ? (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {MOCK.distinctions.map((d) => (
                <span
                  key={d}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '8px 16px',
                    borderRadius: 10,
                    fontSize: 13,
                    fontWeight: 600,
                    background: c.amberLight,
                    border: `1px solid ${c.amberBorder}`,
                    color: c.amber,
                  }}
                >
                  <Icons.award size={14} color={c.amber} /> {d}
                </span>
              ))}
            </div>
          ) : (
            <p style={{ fontSize: 13, color: c.textTertiary, margin: 0 }}>None selected</p>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Section: Products ────────────────────────────────────────────

function ProductsSection() {
  const totalProducts = MOCK.products.reduce((sum, cat) => sum + cat.skills.length, 0);
  return (
    <div style={{ ...slideUp, ...stagger(4) }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <SectionLabel icon={Icons.sparkle} colorKey="violet">
          Product Expertise
        </SectionLabel>
        <span
          style={{
            fontSize: 12,
            fontWeight: 600,
            padding: '4px 12px',
            borderRadius: 12,
            background: c.accentLight,
            color: c.accent,
            border: `1px solid ${c.accentBorder}`,
          }}
        >
          {totalProducts} products
        </span>
      </div>
      <Card style={{ padding: '20px 24px' }}>
        {MOCK.products.map((cat, ci) => (
          <div
            key={cat.category}
            style={{
              paddingBottom: ci < MOCK.products.length - 1 ? 16 : 0,
              marginBottom: ci < MOCK.products.length - 1 ? 16 : 0,
              borderBottom: ci < MOCK.products.length - 1 ? `1px solid ${c.borderSubtle}` : 'none',
            }}
          >
            <p
              style={{
                fontSize: 11,
                fontWeight: 650,
                letterSpacing: '0.06em',
                textTransform: 'uppercase',
                color: c.textTertiary,
                marginBottom: 10,
                marginTop: 0,
              }}
            >
              {cat.category}
            </p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {cat.skills.map((skill) => (
                <span
                  key={skill}
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
                  }}
                >
                  <Icons.check size={12} color={c.primary} /> {skill}
                </span>
              ))}
            </div>
          </div>
        ))}
      </Card>
    </div>
  );
}

// ── Section: Assessment ──────────────────────────────────────────

function AssessmentSection() {
  const products = Object.keys(MOCK.ratings);
  return (
    <div style={{ ...slideUp, ...stagger(5) }}>
      <SectionLabel icon={Icons.compass} colorKey="cyan">
        Self-Assessment
      </SectionLabel>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {products.map((product, pi) => {
          const productRatings = MOCK.ratings[product];
          return (
            <Card key={product} style={{ padding: '18px 22px' }} hover>
              <p style={{ fontSize: 15, fontWeight: 600, color: c.text, margin: '0 0 14px' }}>
                {product}
              </p>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px 24px' }}>
                {SUPPORT_TYPES.map((st) => {
                  const val = productRatings[st.name] || 0;
                  const StIcon = st.icon;
                  return (
                    <div key={st.name} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <div
                        style={{
                          width: 24,
                          height: 24,
                          borderRadius: 6,
                          flexShrink: 0,
                          background: `${st.color}12`,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                        }}
                      >
                        <StIcon size={12} color={st.color} />
                      </div>
                      <span
                        style={{
                          fontSize: 12,
                          color: c.textSecondary,
                          minWidth: 72,
                          flexShrink: 0,
                        }}
                      >
                        {st.name}
                      </span>
                      <div style={{ flex: 1 }}>
                        <MiniBar value={val} max={10} color={st.color} />
                      </div>
                    </div>
                  );
                })}
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

// ── Section: Certifications ──────────────────────────────────────

function CertificationsSection() {
  return (
    <div style={{ ...slideUp, ...stagger(6) }}>
      <SectionLabel icon={Icons.award} colorKey="amber">
        Certifications
      </SectionLabel>

      {/* Trailhead link */}
      {MOCK.trailhead && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '12px 18px',
            borderRadius: 10,
            background: c.surfaceSubtle,
            border: `1px solid ${c.borderSubtle}`,
            marginBottom: 16,
          }}
        >
          <Icons.globe size={16} color={c.cyan} />
          <span style={{ fontSize: 13, color: c.textSecondary }}>Trailhead:</span>
          <span
            style={{
              fontSize: 13,
              fontWeight: 500,
              color: c.primary,
              display: 'flex',
              alignItems: 'center',
              gap: 4,
            }}
          >
            trailblazer.me/id/{MOCK.trailhead}
            <Icons.externalLink size={12} color={c.primary} />
          </span>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        {MOCK.certifications.map((cert, i) => (
          <Card
            key={cert.name}
            style={{
              padding: '14px 18px',
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              ...fadeIn,
              ...stagger(i, 0.04),
            }}
            hover
          >
            <div
              style={{
                width: 32,
                height: 32,
                borderRadius: 8,
                flexShrink: 0,
                background: c.amberLight,
                border: `1px solid ${c.amberBorder}`,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Icons.award size={16} color={c.amber} />
            </div>
            <div>
              <p style={{ fontSize: 13, fontWeight: 600, color: c.text, margin: 0 }}>{cert.name}</p>
              <p style={{ fontSize: 11, color: c.textTertiary, margin: '2px 0 0' }}>
                {cert.category}
              </p>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}

// ── Section: Work History ────────────────────────────────────────

function WorkHistorySection() {
  return (
    <div style={{ ...slideUp, ...stagger(7) }}>
      <SectionLabel icon={Icons.briefcase} colorKey="emerald">
        Work History
      </SectionLabel>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {MOCK.workHistory.map((entry, i) => (
          <Card key={i} style={{ padding: '20px 24px' }} hover>
            <div
              style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}
            >
              <div>
                <p style={{ fontSize: 15, fontWeight: 600, color: c.text, margin: 0 }}>
                  {entry.role}
                </p>
                <p style={{ fontSize: 14, color: c.textSecondary, margin: '4px 0 0' }}>
                  {entry.company}
                </p>
              </div>
              {entry.isCurrent && (
                <span
                  style={{
                    padding: '3px 10px',
                    borderRadius: 12,
                    fontSize: 11,
                    fontWeight: 600,
                    background: c.successLight,
                    color: c.success,
                    border: `1px solid ${c.successBorder}`,
                  }}
                >
                  Current
                </span>
              )}
            </div>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                marginTop: 8,
                fontSize: 12,
                color: c.textTertiary,
              }}
            >
              <Icons.clock size={12} color={c.textTertiary} />
              {entry.start} — {entry.isCurrent ? 'Present' : entry.end}
            </div>
            {entry.responsibilities && (
              <p
                style={{
                  fontSize: 13,
                  color: c.textSecondary,
                  marginTop: 12,
                  lineHeight: 1.6,
                  paddingTop: 12,
                  borderTop: `1px solid ${c.borderSubtle}`,
                }}
              >
                {entry.responsibilities}
              </p>
            )}
          </Card>
        ))}
      </div>
    </div>
  );
}

// ── Main Page ────────────────────────────────────────────────────

export default function ApplicationReviewPage() {
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

      <div style={{ maxWidth: 780, margin: '0 auto', padding: '32px 24px 80px' }}>
        {/* Page header */}
        <div style={{ marginBottom: 32, ...slideUp }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
            <div
              style={{
                width: 40,
                height: 40,
                borderRadius: 11,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: `${SECTION_COLORS.indigo.bg}`,
                border: `1px solid ${SECTION_COLORS.indigo.text}25`,
              }}
            >
              <Icons.clipboard size={20} color={SECTION_COLORS.indigo.text} />
            </div>
            <h1
              style={{
                fontSize: 26,
                fontWeight: 700,
                color: c.text,
                margin: 0,
                letterSpacing: '-0.02em',
              }}
            >
              Your Application
            </h1>
          </div>
          <p style={{ fontSize: 14, color: c.textSecondary, marginLeft: 52, lineHeight: 1.5 }}>
            Here's a summary of your expert application. You'll be notified once it's reviewed.
          </p>
        </div>

        {/* Status banner */}
        <div style={{ marginBottom: 36 }}>
          <StatusBanner />
        </div>

        {/* Sections */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 36 }}>
          <ProfileSection />
          <LanguagesSection />
          <IndustriesSection />
          <ProductsSection />
          <AssessmentSection />
          <CertificationsSection />
          <WorkHistorySection />
        </div>

        {/* Back to dashboard */}
        <div style={{ marginTop: 48, textAlign: 'center', ...slideUp, ...stagger(8) }}>
          <button
            style={{
              padding: '12px 32px',
              borderRadius: 10,
              fontSize: 15,
              fontWeight: 600,
              border: `1px solid ${c.border}`,
              background: c.surface,
              color: c.text,
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              transition: 'all 0.2s',
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
            <Icons.arrowLeft size={16} /> Back to Dashboard
          </button>
        </div>
      </div>
    </div>
  );
}
