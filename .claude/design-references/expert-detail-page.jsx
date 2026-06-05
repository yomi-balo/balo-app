import { useState, useRef, useLayoutEffect, useEffect } from 'react';

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
  gold: '#F59E0B',
  goldSoft: '#FCD34D',
  // Public-profile hero (marketing-grade dark indigo)
  hero: '#1B1A44',
  heroDeep: '#13123A',
  heroSoft: '#2A2960',
  gradient: 'linear-gradient(135deg, #2563EB 0%, #7C3AED 100%)',
  gradientSubtle: 'linear-gradient(135deg, #EFF6FF 0%, #F5F3FF 100%)',
  gradientWarm: 'linear-gradient(135deg, #059669 0%, #0891B2 100%)',
};

const LEVELS = {
  Expert: { color: c.emerald, bg: c.successLight, border: c.successBorder },
  Advanced: { color: c.primary, bg: c.primaryLight, border: c.primaryBorder },
  Proficient: { color: c.cyan, bg: c.cyanLight, border: '#A5F3FC' },
};

// ── Icons (Lucide-style inline SVG) ──────────────────────────────
const Icon = ({ d, size = 16, color = 'currentColor', style: xs, ...p }) => (
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
    {...p}
  >
    <path d={d} />
  </svg>
);
const Icons = {
  check: (p) => <Icon {...p} d="M20 6L9 17l-5-5" />,
  arrowLeft: (p) => <Icon {...p} d="M19 12H5M12 19l-7-7 7-7" />,
  arrowRight: (p) => <Icon {...p} d="M5 12h14M12 5l7 7-7 7" />,
  chevRight: (p) => <Icon {...p} d="M9 18l6-6-6-6" />,
  chevLeft: (p) => <Icon {...p} d="M15 18l-6-6 6-6" />,
  chevDown: (p) => <Icon {...p} d="M6 9l6 6 6-6" />,
  x: (p) => <Icon {...p} d="M18 6L6 18M6 6l12 12" />,
  edit: (p) => (
    <Icon
      {...p}
      d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"
    />
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
      style={p.style}
    >
      <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
      <path d="M17 8l-5-5-5 5M12 3v12" />
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
      style={p.style}
    >
      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
      <path d="M14 2v6h6M16 13H8M16 17H8M10 9H8" />
    </svg>
  ),
  refresh: (p) => (
    <svg
      width={p.size || 16}
      height={p.size || 16}
      viewBox="0 0 24 24"
      fill="none"
      stroke={p.color || 'currentColor'}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={p.style}
    >
      <path d="M23 4v6h-6M1 20v-6h6" />
      <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
    </svg>
  ),
  plus: (p) => <Icon {...p} d="M12 5v14M5 12h14" />,
  mapPin: (p) => (
    <svg
      width={p.size || 16}
      height={p.size || 16}
      viewBox="0 0 24 24"
      fill="none"
      stroke={p.color || 'currentColor'}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={p.style}
    >
      <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z" />
      <circle cx="12" cy="10" r="3" />
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
      style={p.style}
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M2 12h20M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10A15.3 15.3 0 0112 2z" />
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
      style={p.style}
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M12 6v6l4 2" />
    </svg>
  ),
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
      style={p.style}
    >
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <path d="M16 2v4M8 2v4M3 10h18" />
    </svg>
  ),
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
      style={p.style}
    >
      <polygon points="23 7 16 12 23 17 23 7" />
      <rect x="1" y="5" width="15" height="14" rx="2" />
    </svg>
  ),
  briefcase: (p) => (
    <Icon
      {...p}
      d="M20 7H4a2 2 0 00-2 2v10a2 2 0 002 2h16a2 2 0 002-2V9a2 2 0 00-2-2zM16 21V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v16"
    />
  ),
  shield: (p) => <Icon {...p} d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />,
  shieldCheck: (p) => (
    <svg
      width={p.size || 16}
      height={p.size || 16}
      viewBox="0 0 24 24"
      fill="none"
      stroke={p.color || 'currentColor'}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={p.style}
    >
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      <path d="M9 12l2 2 4-4" />
    </svg>
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
      style={p.style}
    >
      <circle cx="12" cy="8" r="6" />
      <path d="M15.5 13.5L17 22l-5-3-5 3 1.5-8.5" />
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
      style={p.style}
    >
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
    </svg>
  ),
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
      style={p.style}
    >
      <path d="M12 3v2m0 14v2m-7-9H3m18 0h-2m-1.636-6.364l-1.414 1.414M7.05 16.95l-1.414 1.414m0-12.728l1.414 1.414m9.9 9.9l1.414 1.414" />
      <circle cx="12" cy="12" r="4" />
    </svg>
  ),
  messageCircle: (p) => (
    <svg
      width={p.size || 16}
      height={p.size || 16}
      viewBox="0 0 24 24"
      fill="none"
      stroke={p.color || 'currentColor'}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={p.style}
    >
      <path d="M21 11.5a8.38 8.38 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.38 8.38 0 01-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.38 8.38 0 013.8-.9h.5a8.48 8.48 0 018 8v.5z" />
    </svg>
  ),
  starFill: (p) => (
    <svg
      width={p.size || 16}
      height={p.size || 16}
      viewBox="0 0 24 24"
      fill={p.color || '#F59E0B'}
      stroke="none"
      style={p.style}
    >
      <path d="M12 17.27l-6.18 3.73 1.64-7.03L2 9.24l7.19-.61L12 2l2.81 6.63L22 9.24l-5.46 4.73 1.64 7.03z" />
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
      style={p.style}
    >
      <polyline points="23 6 13.5 15.5 8.5 10.5 1 18" />
      <polyline points="17 6 23 6 23 12" />
    </svg>
  ),
  share: (p) => (
    <svg
      width={p.size || 16}
      height={p.size || 16}
      viewBox="0 0 24 24"
      fill="none"
      stroke={p.color || 'currentColor'}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={p.style}
    >
      <circle cx="18" cy="5" r="3" />
      <circle cx="6" cy="12" r="3" />
      <circle cx="18" cy="19" r="3" />
      <path d="M8.59 13.51l6.83 3.98M15.41 6.51l-6.82 3.98" />
    </svg>
  ),
  heart: (p) => (
    <svg
      width={p.size || 16}
      height={p.size || 16}
      viewBox="0 0 24 24"
      fill="none"
      stroke={p.color || 'currentColor'}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={p.style}
    >
      <path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z" />
    </svg>
  ),
};

// ── Animations ───────────────────────────────────────────────────
const keyframes = `
@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
@keyframes slideUp { from { opacity: 0; transform: translateY(18px); } to { opacity: 1; transform: translateY(0); } }
@keyframes scaleIn { from { transform: scale(0.96); opacity: 0; } to { transform: scale(1); opacity: 1; } }
@keyframes barFill { from { width: 0; } }
@keyframes pulseDot { 0%,100% { box-shadow: 0 0 0 0 rgba(5,150,105,0.5); } 50% { box-shadow: 0 0 0 5px rgba(5,150,105,0); } }
@keyframes floatGlow { 0%,100% { transform: translate(0,0); } 50% { transform: translate(20px,-16px); } }
@keyframes slideInRight { from { transform: translateX(100%); } to { transform: translateX(0); } }
@keyframes slideUpSheet { from { transform: translateY(100%); } to { transform: translateY(0); } }
@keyframes spin { to { transform: rotate(360deg); } }
`;
const slideUp = (delay = 0) => ({ animation: `slideUp 0.5s ease-out ${delay}s both` });
const fadeIn = (delay = 0) => ({ animation: `fadeIn 0.4s ease-out ${delay}s both` });

// Viewport hook — lets inline-styled components respond to mobile widths
function useIsMobile(maxWidth = 820) {
  const query = `(max-width:${maxWidth}px)`;
  const [m, setM] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia(query).matches : false
  );
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setM(mq.matches);
    on();
    mq.addEventListener ? mq.addEventListener('change', on) : mq.addListener(on);
    return () => {
      mq.removeEventListener ? mq.removeEventListener('change', on) : mq.removeListener(on);
    };
  }, [query]);
  return m;
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

function SectionLabel({ children, icon: IconComp, color = c.textTertiary }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 16 }}>
      <IconComp size={14} color={color} />
      <span
        style={{
          fontSize: 11,
          fontWeight: 700,
          color,
          textTransform: 'uppercase',
          letterSpacing: '0.07em',
        }}
      >
        {children}
      </span>
    </div>
  );
}

function Badge({ children, color, bg, border }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '3px 10px',
        borderRadius: 20,
        fontSize: 12,
        fontWeight: 600,
        color,
        background: bg,
        border: `1px solid ${border}`,
      }}
    >
      {children}
    </span>
  );
}

function RatingStar({ rating, size = 16, empty = '#E2E6EC' }) {
  const pct = (rating / 5) * 100;
  return (
    <div style={{ position: 'relative', width: size, height: size, lineHeight: 0, flexShrink: 0 }}>
      <Icons.starFill size={size} color={empty} />
      <div style={{ position: 'absolute', inset: 0, width: `${pct}%`, overflow: 'hidden' }}>
        <Icons.starFill size={size} color={c.gold} />
      </div>
    </div>
  );
}

// Full 5-star row, filled to the rating (used on individual reviews)
function StarRow({ rating, size = 14, empty = '#E2E6EC', gap = 2 }) {
  const pct = (rating / 5) * 100;
  const row = (color) => (
    <div style={{ display: 'flex', gap }}>
      {[0, 1, 2, 3, 4].map((i) => (
        <Icons.starFill key={i} size={size} color={color} />
      ))}
    </div>
  );
  return (
    <div style={{ position: 'relative', display: 'inline-flex', lineHeight: 0 }}>
      {row(empty)}
      <div style={{ position: 'absolute', inset: 0, width: `${pct}%`, overflow: 'hidden' }}>
        {row(c.gold)}
      </div>
    </div>
  );
}

// ── Mock Data ────────────────────────────────────────────────────

const EXPERT = {
  name: 'Priya Raman',
  initials: 'PR',
  agency: { name: 'MIDCAI Consulting', initials: 'MC' },
  headline: 'Salesforce Technical Architect · CTA',
  location: 'Melbourne, Australia',
  languages: 'English, Tamil',
  rating: 4.9,
  reviews: 87,
  consultations: 340,
  years: 11,
  responseTime: '~2 hrs',
  rate: 9.5,
  online: true,
  bio: [
    'Multi-cloud Salesforce architect with over a decade designing and rescuing enterprise orgs. I specialise in untangling integration sprawl, migrating legacy automation to Flow, and getting RevOps teams the clean data model they should have had on day one.',
    'I work hands-on — expect direct answers, a screen share, and a plan you can actually ship. No filler, no jargon for its own sake.',
  ],
  work: [
    {
      role: 'Founder & Managing Director',
      company: 'MIDCAI Consulting',
      period: 'Apr 2025 — Present',
      length: 'Current',
      current: true,
      summary:
        "Founded MIDCAI to do consulting the way I always wished it was done — senior judgement on every engagement, no hand-offs to people who weren't in the room.",
      detail:
        'We architect Salesforce and Agentforce programs where strategy, technical reality, and what your team can actually run all meet.',
    },
    {
      role: 'Managing Director',
      company: 'Horizontal Digital',
      period: 'Apr 2020 — Apr 2025',
      length: '5 yrs',
      summary:
        'Built and led the Salesforce delivery practice — hiring, capability, the delivery model, and the culture that held it together as it scaled.',
      detail:
        'Grew it from a handful of consultants into a multi-cloud practice delivering enterprise programs across three continents.',
    },
    {
      role: 'Account Director',
      company: 'Appirio',
      period: 'Nov 2017 — Apr 2020',
      length: '2 yrs 5 mos',
      summary:
        'Owned delivery across ~25 consulting projects a year and multi-millions in revenue.',
      detail: 'Led a team of 110+ consultants across Sales, Service, and Platform engagements.',
    },
  ],
  certs: [
    'Certified Technical Architect (CTA)',
    'Application Architect',
    'System Architect',
    'Platform Developer II',
    'Integration Architect',
    'Sales Cloud Consultant',
    'Service Cloud Consultant',
    'Data Architect',
  ],
  skills: [
    { name: 'Apex & Triggers', level: 'Expert', pct: 95 },
    { name: 'Lightning Web Components', level: 'Expert', pct: 92 },
    { name: 'Flow & Automation', level: 'Expert', pct: 90 },
    { name: 'Sales Cloud', level: 'Expert', pct: 94 },
    { name: 'Integration & APIs', level: 'Advanced', pct: 88 },
    { name: 'Service Cloud', level: 'Advanced', pct: 85 },
    { name: 'Data Migration', level: 'Advanced', pct: 82 },
    { name: 'Experience Cloud', level: 'Proficient', pct: 74 },
  ],
  slots: ['Today · 3:00 PM', 'Tomorrow · 10:00 AM', 'Thu · 2:30 PM'],
};

// Quick Starts: pre-packaged, purchasable project requests that feed the same
// pipeline as a custom project request. One type — no per-item color scheme.
const PACKAGES = [
  {
    icon: Icons.zap,
    title: 'Quick Config Review',
    price: 'A$450',
    dur: '1–2 days',
    desc: 'A focused 60-minute teardown of one area of your org with a prioritised action list you can run with the same day.',
    format: 'Live screen-share session + written summary',
    bestFor: 'Teams who want a fast expert opinion on one specific area.',
    deliverables: [
      'A recorded 60-minute screen-share teardown of the area you choose',
      'Prioritised list of issues ranked by impact and effort',
      'Concrete, actionable next steps you can run with immediately',
      'Written summary delivered within 1 business day',
    ],
  },
  {
    icon: Icons.shieldCheck,
    title: 'Org Health Check',
    price: 'A$1,200',
    dur: '~1 week',
    desc: 'End-to-end audit of your org — security, technical debt, automation overlap, and a prioritised remediation roadmap.',
    format: 'Async audit + a 30-minute findings call',
    bestFor: 'Orgs inheriting an instance or preparing to scale.',
    deliverables: [
      'Full audit across security, data model, automation, and technical debt',
      'Risk register with severity ratings',
      'Prioritised 90-day remediation roadmap',
      '30-minute walkthrough call to talk through the findings',
    ],
  },
  {
    icon: Icons.trendingUp,
    title: 'Flow Automation Sprint',
    price: 'A$2,800',
    dur: '2 weeks',
    desc: "Replace legacy Workflow Rules and Process Builder with consolidated, well-tested Flows that won't break at scale.",
    format: 'Hands-on build in your sandbox, deployed to production',
    bestFor: 'Teams retiring legacy automation before it breaks.',
    deliverables: [
      'Audit of existing Workflow Rules and Process Builder automations',
      'Consolidated, documented Flows replacing the legacy automation',
      'Test coverage and error-handling on every new Flow',
      'Handover doc + walkthrough session for your admin',
    ],
  },
  {
    icon: Icons.globe,
    title: 'Integration Architecture Review',
    price: 'A$3,500',
    dur: '~2 weeks',
    desc: 'Map every inbound and outbound integration, identify failure points, and design a resilient middleware pattern.',
    format: 'Async review + a 45-minute architecture call',
    bestFor: 'Orgs with growing integration sprawl.',
    deliverables: [
      'Inventory of every inbound and outbound integration',
      'Failure-point analysis with a clear data-flow diagram',
      'Recommended resilient middleware architecture',
      'Written report + 45-minute architecture review call',
    ],
  },
];

const REVIEWS = [
  {
    name: 'Sarah Mitchell',
    role: 'RevOps Lead · Northwind',
    initials: 'SM',
    color: c.primary,
    rating: 5,
    date: '2 weeks ago',
    quote:
      'Priya untangled an integration mess three consultants had given up on. Clear, fast, and she left us with documentation we actually use.',
  },
  {
    name: 'David Okonkwo',
    role: 'CTO · Brightpath',
    initials: 'DO',
    color: c.accent,
    rating: 5,
    date: '1 month ago',
    quote:
      "Booked 30 minutes expecting a quick answer, walked away with a full migration plan. Easily the best money we've spent on Salesforce help.",
  },
  {
    name: 'Lena Vasquez',
    role: 'Salesforce Admin · Coastline',
    initials: 'LV',
    color: c.emerald,
    rating: 4.5,
    date: '2 months ago',
    quote:
      "Patient, sharp, and didn't make me feel small for asking. Our Flow rebuild has had zero errors since.",
  },
];

const NAV_SECTIONS = [
  { key: 'about', label: 'About' },
  { key: 'expertise', label: 'Expertise' },
  { key: 'packages', label: 'Quick Starts' },
  { key: 'work', label: 'Work' },
  { key: 'reviews', label: 'Reviews' },
];

// ══════════════════════════════════════════════════════════════════
// HERO
// ══════════════════════════════════════════════════════════════════

// Illustrated portrait placeholder — the real headshot swaps straight in.
function HeroPortrait() {
  return (
    <svg
      viewBox="0 0 280 336"
      preserveAspectRatio="xMidYMid slice"
      style={{ width: '100%', height: '100%', display: 'block' }}
    >
      <defs>
        <linearGradient id="hpbg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#F6E7D6" />
          <stop offset="100%" stopColor="#E7CDB3" />
        </linearGradient>
        <linearGradient id="hpshirt" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#36313C" />
          <stop offset="100%" stopColor="#221F2A" />
        </linearGradient>
      </defs>
      <rect width="280" height="336" fill="url(#hpbg)" />
      <path d="M40 336 C46 264 92 246 140 246 C188 246 234 264 240 336 Z" fill="url(#hpshirt)" />
      <rect x="120" y="242" width="40" height="26" fill="#C99A78" />
      <rect x="124" y="228" width="32" height="28" rx="14" fill="#C99A78" />
      <ellipse cx="140" cy="166" rx="56" ry="62" fill="#D7A982" />
      <path
        d="M84 164 C82 116 104 96 140 96 C176 96 198 116 196 164 C196 146 178 134 140 134 C102 134 84 146 84 164 Z"
        fill="#2B221C"
      />
      <path d="M84 168 C80 146 88 128 100 122 C92 140 92 156 92 168 Z" fill="#2B221C" />
      <g stroke="#2B221C" strokeWidth="3" fill="none">
        <rect x="106" y="158" width="26" height="20" rx="7" />
        <rect x="148" y="158" width="26" height="20" rx="7" />
        <path d="M132 166 H148" />
        <path d="M106 164 L96 162 M174 164 L184 162" />
      </g>
      <path
        d="M126 196 Q140 208 154 196"
        stroke="#9E6B49"
        strokeWidth="3"
        fill="none"
        strokeLinecap="round"
      />
    </svg>
  );
}

function HeroStat({ value, label, sub }) {
  return (
    <div style={{ textAlign: 'left' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 5 }}>
        <span style={{ fontSize: 22, fontWeight: 700, color: '#FFFFFF', lineHeight: 1 }}>
          {value}
        </span>
        {sub && <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.55)' }}>{sub}</span>}
      </div>
      <p
        style={{
          fontSize: 11,
          color: 'rgba(255,255,255,0.55)',
          margin: '6px 0 0',
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          fontWeight: 600,
        }}
      >
        {label}
      </p>
    </div>
  );
}

function Hero() {
  const isMobile = useIsMobile();
  return (
    <div
      style={{
        background: `linear-gradient(160deg, ${c.heroSoft} 0%, ${c.hero} 45%, ${c.heroDeep} 100%)`,
        position: 'relative',
        overflow: 'hidden',
        paddingBottom: isMobile ? 64 : 88,
      }}
    >
      {/* Atmospheric glows */}
      <div
        style={{
          position: 'absolute',
          top: -120,
          right: -60,
          width: 380,
          height: 380,
          borderRadius: '50%',
          background: 'radial-gradient(circle, rgba(124,58,237,0.35) 0%, transparent 70%)',
          filter: 'blur(20px)',
          animation: 'floatGlow 14s ease-in-out infinite',
        }}
      />
      <div
        style={{
          position: 'absolute',
          bottom: -140,
          left: -40,
          width: 320,
          height: 320,
          borderRadius: '50%',
          background: 'radial-gradient(circle, rgba(37,99,235,0.30) 0%, transparent 70%)',
          filter: 'blur(20px)',
          animation: 'floatGlow 18s ease-in-out infinite reverse',
        }}
      />
      {/* Subtle grid texture */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          opacity: 0.4,
          backgroundImage: 'radial-gradient(rgba(255,255,255,0.06) 1px, transparent 1px)',
          backgroundSize: '22px 22px',
        }}
      />

      <div
        style={{
          position: 'relative',
          maxWidth: 1120,
          margin: '0 auto',
          padding: isMobile ? '0 20px' : '0 32px',
        }}
      >
        {/* Breadcrumb */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '20px 0 8px',
            ...fadeIn(0),
          }}
        >
          <button
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 7,
              background: 'rgba(255,255,255,0.08)',
              border: '1px solid rgba(255,255,255,0.14)',
              borderRadius: 9,
              padding: '7px 14px',
              color: 'rgba(255,255,255,0.85)',
              fontSize: 13,
              fontWeight: 500,
              cursor: 'pointer',
            }}
          >
            <Icons.arrowLeft size={14} color="rgba(255,255,255,0.85)" /> Browse experts
          </button>
          <div style={{ display: 'flex', gap: 8 }}>
            {[Icons.heart, Icons.share].map((I, i) => (
              <button
                key={i}
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: 9,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  background: 'rgba(255,255,255,0.08)',
                  border: '1px solid rgba(255,255,255,0.14)',
                  cursor: 'pointer',
                }}
              >
                <I size={16} color="rgba(255,255,255,0.8)" />
              </button>
            ))}
          </div>
        </div>

        {/* Identity — portrait height matches name + stats stack */}
        <div
          style={{
            display: 'flex',
            flexDirection: isMobile ? 'column' : 'row',
            gap: isMobile ? 22 : 40,
            alignItems: 'stretch',
            paddingTop: isMobile ? 16 : 24,
            ...slideUp(0.05),
          }}
        >
          {/* Portrait */}
          <div style={{ width: isMobile ? 150 : 250, flexShrink: 0, position: 'relative' }}>
            <div
              style={{
                width: '100%',
                aspectRatio: '7 / 8',
                borderRadius: 22,
                overflow: 'hidden',
                border: '3px solid rgba(255,255,255,0.14)',
                background: '#26223A',
                boxShadow: '0 22px 60px rgba(0,0,0,0.45)',
              }}
            >
              <HeroPortrait />
            </div>
            {EXPERT.online && (
              <div
                style={{
                  position: 'absolute',
                  bottom: 14,
                  right: 14,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 7,
                  padding: '5px 11px 5px 9px',
                  borderRadius: 999,
                  background: 'rgba(10,9,28,0.78)',
                  border: '1px solid rgba(110,231,183,0.35)',
                  backdropFilter: 'blur(6px)',
                }}
              >
                <span
                  style={{
                    width: 9,
                    height: 9,
                    borderRadius: '50%',
                    background: c.success,
                    animation: 'pulseDot 2s infinite',
                  }}
                />
                <span style={{ fontSize: 11.5, fontWeight: 650, color: '#6EE7B7' }}>Available</span>
              </div>
            )}
          </div>

          {/* Right column */}
          <div
            style={{
              flex: 1,
              minWidth: 0,
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'space-between',
              gap: isMobile ? 18 : 24,
            }}
          >
            {/* Name block */}
            <div style={{ minWidth: 0 }}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 16,
                  flexWrap: 'wrap',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                  <h1
                    style={{
                      fontSize: isMobile ? 27 : 38,
                      fontWeight: 700,
                      color: 'white',
                      margin: 0,
                      letterSpacing: '-0.025em',
                    }}
                  >
                    {EXPERT.name}
                  </h1>
                  <span
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 5,
                      padding: '4px 11px',
                      borderRadius: 20,
                      background: 'rgba(5,150,105,0.18)',
                      border: '1px solid rgba(5,150,105,0.4)',
                      fontSize: 12,
                      fontWeight: 650,
                      color: '#6EE7B7',
                    }}
                  >
                    <Icons.shieldCheck size={13} color="#6EE7B7" /> Balo Verified
                  </span>
                  <span
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 5,
                      padding: '4px 11px',
                      borderRadius: 20,
                      background: 'rgba(245,158,11,0.16)',
                      border: '1px solid rgba(245,158,11,0.38)',
                      fontSize: 12,
                      fontWeight: 650,
                      color: c.goldSoft,
                    }}
                  >
                    <Icons.award size={13} color={c.goldSoft} /> Top Rated
                  </span>
                </div>

                {/* Agency lockup */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
                  <div
                    style={{
                      width: 38,
                      height: 38,
                      borderRadius: 10,
                      flexShrink: 0,
                      background: 'rgba(255,255,255,0.1)',
                      border: '1px solid rgba(255,255,255,0.18)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: 13,
                      fontWeight: 700,
                      color: 'white',
                      letterSpacing: '0.02em',
                    }}
                  >
                    {EXPERT.agency.initials}
                  </div>
                  <div style={{ textAlign: isMobile ? 'left' : 'right' }}>
                    <p
                      style={{
                        fontSize: 10,
                        fontWeight: 650,
                        color: 'rgba(255,255,255,0.5)',
                        textTransform: 'uppercase',
                        letterSpacing: '0.1em',
                        margin: 0,
                      }}
                    >
                      Agency
                    </p>
                    <p
                      style={{
                        fontSize: 14,
                        fontWeight: 650,
                        color: 'rgba(255,255,255,0.92)',
                        margin: '2px 0 0',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {EXPERT.agency.name}
                    </p>
                  </div>
                </div>
              </div>
              <p
                style={{
                  fontSize: 16,
                  color: 'rgba(255,255,255,0.78)',
                  margin: '10px 0 0',
                  fontWeight: 500,
                }}
              >
                {EXPERT.headline}
              </p>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 18,
                  marginTop: 16,
                  flexWrap: 'wrap',
                }}
              >
                <span
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    fontSize: 13,
                    color: 'rgba(255,255,255,0.6)',
                  }}
                >
                  <Icons.mapPin size={14} color="rgba(255,255,255,0.6)" /> {EXPERT.location}
                </span>
                <span
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    fontSize: 13,
                    color: 'rgba(255,255,255,0.6)',
                  }}
                >
                  <Icons.globe size={14} color="rgba(255,255,255,0.6)" /> {EXPERT.languages}
                </span>
                <span
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    fontSize: 13,
                    color: 'rgba(255,255,255,0.6)',
                  }}
                >
                  <Icons.clock size={14} color="rgba(255,255,255,0.6)" /> Replies in{' '}
                  {EXPERT.responseTime}
                </span>
              </div>
            </div>

            {/* Stats strip — inside right column */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                flexWrap: 'wrap',
                gap: isMobile ? '16px 22px' : 26,
                padding: isMobile ? '14px 16px' : '18px 24px',
                borderRadius: 16,
                background: 'rgba(255,255,255,0.05)',
                border: '1px solid rgba(255,255,255,0.1)',
                backdropFilter: 'blur(8px)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                <RatingStar rating={EXPERT.rating} size={22} empty="rgba(255,255,255,0.2)" />
                <HeroStat value={EXPERT.rating} label={`${EXPERT.reviews} reviews`} />
              </div>
              {!isMobile && (
                <div
                  style={{ width: 1, alignSelf: 'stretch', background: 'rgba(255,255,255,0.12)' }}
                />
              )}
              <HeroStat value={`${EXPERT.consultations}+`} label="Consultations" />
              {!isMobile && (
                <div
                  style={{ width: 1, alignSelf: 'stretch', background: 'rgba(255,255,255,0.12)' }}
                />
              )}
              <HeroStat value={EXPERT.years} sub="yrs" label="Experience" />
              {!isMobile && (
                <div
                  style={{ width: 1, alignSelf: 'stretch', background: 'rgba(255,255,255,0.12)' }}
                />
              )}
              <HeroStat value={EXPERT.certs.length} label="Certs" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// IN-PAGE NAV
// ══════════════════════════════════════════════════════════════════

function StickyNav({ active, onJump }) {
  const isMobile = useIsMobile();
  return (
    <div
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 20,
        background: 'rgba(248,250,251,0.85)',
        backdropFilter: 'blur(10px)',
        borderBottom: `1px solid ${c.borderSubtle}`,
      }}
    >
      <div
        style={{
          maxWidth: 1120,
          margin: '0 auto',
          padding: isMobile ? '0 20px' : '0 32px',
          display: 'flex',
          gap: 4,
          overflowX: isMobile ? 'auto' : 'visible',
          WebkitOverflowScrolling: 'touch',
          scrollbarWidth: 'none',
        }}
      >
        {NAV_SECTIONS.map((s) => {
          const on = active === s.key;
          return (
            <button
              key={s.key}
              onClick={() => onJump(s.key)}
              style={{
                padding: '14px 4px',
                marginRight: isMobile ? 20 : 24,
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                fontSize: 14,
                fontWeight: on ? 650 : 500,
                color: on ? c.text : c.textTertiary,
                whiteSpace: 'nowrap',
                borderBottom: `2px solid ${on ? c.primary : 'transparent'}`,
                transition: 'all 0.2s',
              }}
            >
              {s.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// LEFT COLUMN SECTIONS
// ══════════════════════════════════════════════════════════════════

function AboutSection() {
  return (
    <Card style={{ padding: '26px 28px', ...slideUp(0.05) }}>
      <SectionLabel icon={Icons.sparkles} color={c.accent}>
        About
      </SectionLabel>
      {EXPERT.bio.map((p, i) => (
        <p
          key={i}
          style={{
            fontSize: 15,
            color: c.textSecondary,
            lineHeight: 1.7,
            margin: i === 0 ? 0 : '14px 0 0',
          }}
        >
          {p}
        </p>
      ))}
    </Card>
  );
}

function SkillBar({ skill, index }) {
  const lv = LEVELS[skill.level];
  return (
    <div style={{ ...slideUp(0.05 + index * 0.04) }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 7,
        }}
      >
        <span style={{ fontSize: 14, fontWeight: 550, color: c.text }}>{skill.name}</span>
        <span
          style={{
            fontSize: 11,
            fontWeight: 650,
            color: lv.color,
            background: lv.bg,
            border: `1px solid ${lv.border}`,
            padding: '2px 9px',
            borderRadius: 6,
          }}
        >
          {skill.level}
        </span>
      </div>
      <div style={{ height: 6, borderRadius: 4, background: c.surfaceSubtle, overflow: 'hidden' }}>
        <div
          style={{
            width: `${skill.pct}%`,
            height: '100%',
            borderRadius: 4,
            background: c.gradient,
            animation: 'barFill 1s cubic-bezier(0.4,0,0.2,1)',
          }}
        />
      </div>
    </div>
  );
}

function ExpertiseSection() {
  return (
    <Card style={{ padding: '26px 28px', ...slideUp(0.08) }}>
      <SectionLabel icon={Icons.trendingUp} color={c.primary}>
        Expertise
      </SectionLabel>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px 32px' }}>
        {EXPERT.skills.map((s, i) => (
          <SkillBar key={s.name} skill={s} index={i} />
        ))}
      </div>

      {/* Certifications */}
      <div style={{ marginTop: 28, paddingTop: 24, borderTop: `1px solid ${c.borderSubtle}` }}>
        <SectionLabel icon={Icons.award} color={c.warning}>
          Salesforce Certifications
        </SectionLabel>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {EXPERT.certs.map((cert, i) => (
            <span
              key={cert}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 7,
                padding: '8px 13px',
                borderRadius: 9,
                background: c.surfaceSubtle,
                border: `1px solid ${c.borderSubtle}`,
                fontSize: 13,
                fontWeight: 500,
                color: c.textSecondary,
                ...fadeIn(0.1 + i * 0.03),
              }}
            >
              <Icons.award size={13} color={c.warning} /> {cert}
            </span>
          ))}
        </div>
      </div>
    </Card>
  );
}

function PackageCard({ pkg, index, onOpen }) {
  const [h, setH] = useState(false);
  const PIcon = pkg.icon;
  const col = c.accent;
  return (
    <div
      onClick={onOpen}
      onMouseEnter={() => setH(true)}
      onMouseLeave={() => setH(false)}
      style={{
        display: 'flex',
        gap: 16,
        padding: '18px 20px',
        borderRadius: 14,
        cursor: 'pointer',
        border: `1px solid ${h ? col + '55' : c.border}`,
        background: c.surface,
        boxShadow: h ? `0 6px 22px ${col}1F` : '0 1px 3px rgba(27,26,68,0.05)',
        transition: 'all 0.22s',
        ...slideUp(0.05 + index * 0.06),
      }}
    >
      <div
        style={{
          width: 46,
          height: 46,
          borderRadius: 12,
          flexShrink: 0,
          background: `${col}12`,
          border: `1px solid ${col}25`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <PIcon size={22} color={col} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: 12,
          }}
        >
          <h4 style={{ fontSize: 15, fontWeight: 650, color: c.text, margin: 0 }}>{pkg.title}</h4>
          <span style={{ fontSize: 16, fontWeight: 700, color: c.text, flexShrink: 0 }}>
            {pkg.price}
          </span>
        </div>
        <p style={{ fontSize: 13, color: c.textSecondary, lineHeight: 1.55, margin: '8px 0 0' }}>
          {pkg.desc}
        </p>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 12 }}>
          <Icons.clock size={12} color={c.textTertiary} />
          <span style={{ fontSize: 12, color: c.textTertiary }}>{pkg.dur}</span>
          <span
            style={{
              marginLeft: 'auto',
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              fontSize: 13,
              fontWeight: 600,
              color: col,
              opacity: h ? 1 : 0.8,
              transition: 'all 0.2s',
            }}
          >
            View details <Icons.chevRight size={13} color={col} />
          </span>
        </div>
      </div>
    </div>
  );
}

function QuickStartDrawer({ pkg, onClose }) {
  const [view, setView] = useState('details'); // details | ask | asked | purchased
  const [msg, setMsg] = useState('');
  const col = c.accent;
  const first = EXPERT.name.split(' ')[0];
  const PIcon = pkg.icon;

  const HOW = [
    { t: 'Purchase', d: 'Secures your spot — it becomes a project instantly.' },
    { t: 'Share details', d: `A quick brief or access so ${first} can start.` },
    { t: `Delivered in ${pkg.dur}`, d: 'Everything under “What’s included”, done.' },
  ];
  const META = [
    { icon: Icons.clock, label: 'Timeframe', value: pkg.dur, color: c.primary },
    { icon: Icons.video, label: 'Format', value: pkg.format, color: c.cyan },
    { icon: Icons.award, label: 'Best for', value: pkg.bestFor, color: c.warning },
  ];
  const SUGGESTIONS = [
    'Can this be tailored to my org?',
    `What do you need from me to start?`,
    'Can you combine this with another package?',
  ];

  const SectionHead = ({ icon: Ic, color, children, first }) => (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 7,
        margin: first ? '0 0 12px' : '26px 0 12px',
      }}
    >
      <Ic size={14} color={color} />
      <span
        style={{
          fontSize: 11,
          fontWeight: 700,
          color,
          textTransform: 'uppercase',
          letterSpacing: '0.07em',
        }}
      >
        {children}
      </span>
    </div>
  );

  return (
    <Drawer onClose={onClose} width={500}>
      <DrawerHead onClose={onClose}>
        <span
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 7,
            fontSize: 12,
            fontWeight: 700,
            color: col,
            textTransform: 'uppercase',
            letterSpacing: '0.09em',
          }}
        >
          <Icons.zap size={14} color={col} /> Quick Start
        </span>
      </DrawerHead>

      <div style={{ flex: 1, overflowY: 'auto' }}>
        {/* ── DETAILS ───────────────────────────────────────── */}
        {view === 'details' && (
          <div>
            {/* Hero band */}
            <div
              style={{
                padding: '22px 24px',
                background: c.gradientSubtle,
                borderBottom: `1px solid ${c.borderSubtle}`,
              }}
            >
              <div style={{ display: 'flex', gap: 15, alignItems: 'center' }}>
                <div
                  style={{
                    width: 54,
                    height: 54,
                    borderRadius: 15,
                    flexShrink: 0,
                    background: 'white',
                    border: `1px solid ${col}25`,
                    boxShadow: `0 4px 14px ${col}1F`,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <PIcon size={26} color={col} />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <h3
                    style={{
                      fontSize: 20,
                      fontWeight: 700,
                      color: c.text,
                      margin: 0,
                      letterSpacing: '-0.01em',
                    }}
                  >
                    {pkg.title}
                  </h3>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginTop: 4 }}>
                    <span style={{ fontSize: 20, fontWeight: 700, color: c.text }}>
                      {pkg.price}
                    </span>
                    <span style={{ color: c.textTertiary }}>·</span>
                    <span
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 5,
                        fontSize: 13,
                        color: c.textSecondary,
                      }}
                    >
                      <Icons.clock size={13} color={c.textSecondary} /> {pkg.dur}
                    </span>
                  </div>
                </div>
              </div>
              <p
                style={{
                  fontSize: 14.5,
                  color: c.textSecondary,
                  lineHeight: 1.65,
                  margin: '16px 0 0',
                }}
              >
                {pkg.desc}
              </p>
            </div>

            {/* Body */}
            <div style={{ padding: '22px 24px' }}>
              {/* Delivered by */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  padding: '12px 14px',
                  borderRadius: 12,
                  border: `1px solid ${c.borderSubtle}`,
                  background: c.surfaceSubtle,
                }}
              >
                <div
                  style={{
                    width: 38,
                    height: 38,
                    borderRadius: 10,
                    background: c.gradient,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: 13,
                    fontWeight: 700,
                    color: 'white',
                    flexShrink: 0,
                  }}
                >
                  {EXPERT.initials}
                </div>
                <div>
                  <p style={{ fontSize: 13.5, fontWeight: 650, color: c.text, margin: 0 }}>
                    Delivered by {EXPERT.name}
                  </p>
                  <p style={{ fontSize: 12, color: c.textTertiary, margin: '1px 0 0' }}>
                    {EXPERT.headline}
                  </p>
                </div>
              </div>

              {/* What's included */}
              <SectionHead icon={Icons.check} color={c.emerald}>
                What's included
              </SectionHead>
              <div
                style={{
                  background: c.successLight,
                  border: `1px solid ${c.successBorder}`,
                  borderRadius: 12,
                  padding: '14px 16px',
                }}
              >
                {pkg.deliverables.map((d, i) => (
                  <div
                    key={i}
                    style={{
                      display: 'flex',
                      gap: 10,
                      alignItems: 'flex-start',
                      marginBottom: i < pkg.deliverables.length - 1 ? 11 : 0,
                    }}
                  >
                    <span
                      style={{
                        width: 18,
                        height: 18,
                        borderRadius: '50%',
                        background: c.emerald,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        flexShrink: 0,
                        marginTop: 1,
                      }}
                    >
                      <Icons.check size={11} color="white" />
                    </span>
                    <span style={{ fontSize: 13.5, color: c.text, lineHeight: 1.5 }}>{d}</span>
                  </div>
                ))}
              </div>

              {/* The details — colored attribute tiles */}
              <SectionHead icon={Icons.fileText} color={c.primary}>
                The details
              </SectionHead>
              <div
                style={{
                  border: `1px solid ${c.borderSubtle}`,
                  borderRadius: 12,
                  overflow: 'hidden',
                }}
              >
                {META.map((m, i) => {
                  const MIcon = m.icon;
                  return (
                    <div
                      key={i}
                      style={{
                        display: 'flex',
                        gap: 12,
                        padding: '13px 14px',
                        borderTop: i ? `1px solid ${c.borderSubtle}` : 'none',
                        alignItems: 'flex-start',
                      }}
                    >
                      <div
                        style={{
                          width: 30,
                          height: 30,
                          borderRadius: 9,
                          flexShrink: 0,
                          background: `${m.color}12`,
                          border: `1px solid ${m.color}25`,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                        }}
                      >
                        <MIcon size={15} color={m.color} />
                      </div>
                      <div style={{ paddingTop: 1 }}>
                        <p
                          style={{
                            fontSize: 11,
                            fontWeight: 700,
                            color: c.textTertiary,
                            textTransform: 'uppercase',
                            letterSpacing: '0.05em',
                            margin: 0,
                          }}
                        >
                          {m.label}
                        </p>
                        <p
                          style={{
                            fontSize: 13.5,
                            color: c.text,
                            margin: '2px 0 0',
                            lineHeight: 1.45,
                          }}
                        >
                          {m.value}
                        </p>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* How it works — connected track */}
              <SectionHead icon={Icons.sparkles} color={c.accent}>
                How it works
              </SectionHead>
              <div>
                {HOW.map((s, i) => (
                  <div key={i} style={{ display: 'flex', gap: 13, alignItems: 'stretch' }}>
                    <div
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        flexShrink: 0,
                      }}
                    >
                      <span
                        style={{
                          width: 26,
                          height: 26,
                          borderRadius: '50%',
                          flexShrink: 0,
                          background: `${col}12`,
                          color: col,
                          fontSize: 12,
                          fontWeight: 700,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          border: `1px solid ${col}30`,
                        }}
                      >
                        {i + 1}
                      </span>
                      {i < HOW.length - 1 && (
                        <div
                          style={{
                            width: 2,
                            flex: 1,
                            background: `${col}22`,
                            marginTop: 4,
                            minHeight: 14,
                          }}
                        />
                      )}
                    </div>
                    <div style={{ paddingBottom: i < HOW.length - 1 ? 14 : 0 }}>
                      <p style={{ fontSize: 13.5, fontWeight: 650, color: c.text, margin: 0 }}>
                        {s.t}
                      </p>
                      <p
                        style={{
                          fontSize: 12.5,
                          color: c.textTertiary,
                          margin: '2px 0 0',
                          lineHeight: 1.45,
                        }}
                      >
                        {s.d}
                      </p>
                    </div>
                  </div>
                ))}
              </div>

              {/* Ask a question */}
              <div
                style={{
                  marginTop: 16,
                  padding: '16px 18px',
                  borderRadius: 14,
                  border: `1px solid ${col}22`,
                  background: `${col}08`,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
                  <Icons.messageCircle size={18} color={col} />
                  <div style={{ flex: 1 }}>
                    <p style={{ fontSize: 14, fontWeight: 650, color: c.text, margin: 0 }}>
                      Questions, or need it tailored?
                    </p>
                    <p style={{ fontSize: 12.5, color: c.textSecondary, margin: '1px 0 0' }}>
                      Ask {first} before you buy — no obligation.
                    </p>
                  </div>
                </div>
                <button
                  onClick={() => setView('ask')}
                  style={{
                    width: '100%',
                    marginTop: 12,
                    padding: '10px',
                    borderRadius: 10,
                    cursor: 'pointer',
                    border: 'none',
                    background: 'white',
                    color: col,
                    fontSize: 13.5,
                    fontWeight: 650,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 7,
                    boxShadow: `0 1px 3px ${col}1A`,
                  }}
                >
                  <Icons.messageCircle size={15} color={col} /> Ask a question about this package
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ── ASK ───────────────────────────────────────────── */}
        {view === 'ask' && (
          <div style={{ padding: '22px 24px' }}>
            <button
              onClick={() => setView('details')}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 5,
                background: 'none',
                border: 'none',
                padding: 0,
                cursor: 'pointer',
                fontSize: 13,
                fontWeight: 600,
                color: c.primary,
              }}
            >
              <Icons.chevLeft size={14} color={c.primary} /> Back to package
            </button>
            <h3 style={{ fontSize: 19, fontWeight: 700, color: c.text, margin: '16px 0 0' }}>
              Ask {first} a question
            </h3>
            <p style={{ fontSize: 13, color: c.textTertiary, margin: '4px 0 0' }}>
              About: {pkg.title}
            </p>

            <p
              style={{
                fontSize: 12.5,
                fontWeight: 650,
                color: c.textSecondary,
                margin: '20px 0 10px',
              }}
            >
              Common questions
            </p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => setMsg(s)}
                  style={{
                    padding: '7px 12px',
                    borderRadius: 999,
                    cursor: 'pointer',
                    fontSize: 12.5,
                    fontWeight: 550,
                    textAlign: 'left',
                    border: `1px solid ${c.border}`,
                    background: c.surface,
                    color: c.textSecondary,
                  }}
                >
                  {s}
                </button>
              ))}
            </div>

            <textarea
              value={msg}
              onChange={(e) => setMsg(e.target.value)}
              rows={5}
              placeholder="Ask about scope, customisation, timing — anything."
              style={{
                width: '100%',
                marginTop: 16,
                padding: '12px',
                borderRadius: 10,
                border: `1px solid ${c.border}`,
                fontSize: 14,
                color: c.text,
                outline: 'none',
                resize: 'vertical',
                fontFamily: 'inherit',
                boxSizing: 'border-box',
              }}
            />
          </div>
        )}

        {/* ── ASKED ─────────────────────────────────────────── */}
        {view === 'asked' && (
          <div style={{ padding: '52px 32px', textAlign: 'center' }}>
            <div
              style={{
                width: 64,
                height: 64,
                borderRadius: '50%',
                margin: '0 auto 18px',
                background: `${col}15`,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Icons.messageCircle size={28} color={col} />
            </div>
            <h3 style={{ fontSize: 21, fontWeight: 700, color: c.text, margin: 0 }}>
              Message sent to {first}
            </h3>
            <p
              style={{
                fontSize: 14.5,
                color: c.textSecondary,
                margin: '10px auto 0',
                maxWidth: 320,
                lineHeight: 1.6,
              }}
            >
              {first} usually replies within {EXPERT.responseTime}. You'll get it in your messages
              and by email.
            </p>
            <button
              onClick={() => setView('details')}
              style={{
                marginTop: 22,
                padding: '11px 24px',
                borderRadius: 11,
                border: `1px solid ${c.border}`,
                background: c.surface,
                cursor: 'pointer',
                fontSize: 14,
                fontWeight: 600,
                color: c.textSecondary,
              }}
            >
              Back to package
            </button>
          </div>
        )}

        {/* ── PURCHASED ─────────────────────────────────────── */}
        {view === 'purchased' && (
          <div style={{ padding: '52px 32px', textAlign: 'center' }}>
            <div
              style={{
                width: 68,
                height: 68,
                borderRadius: '50%',
                margin: '0 auto 18px',
                background: c.gradientWarm,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                boxShadow: '0 8px 28px rgba(5,150,105,0.3)',
                animation: 'scaleIn 0.3s ease-out',
              }}
            >
              <Icons.check size={30} color="white" />
            </div>
            <h3 style={{ fontSize: 22, fontWeight: 700, color: c.text, margin: 0 }}>
              Project started!
            </h3>
            <p
              style={{
                fontSize: 15,
                color: c.textSecondary,
                margin: '10px auto 0',
                maxWidth: 330,
                lineHeight: 1.6,
              }}
            >
              “{pkg.title}” is now a project. Share any details and {first} will kick off — delivery
              in {pkg.dur}.
            </p>
            <button
              onClick={onClose}
              style={{
                marginTop: 24,
                padding: '12px 28px',
                borderRadius: 11,
                border: 'none',
                cursor: 'pointer',
                fontSize: 14,
                fontWeight: 650,
                color: 'white',
                background: c.gradient,
              }}
            >
              Done
            </button>
          </div>
        )}
      </div>

      {/* Footers */}
      {view === 'details' && (
        <div
          style={{
            padding: '16px 24px',
            borderTop: `1px solid ${c.borderSubtle}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 16,
            flexShrink: 0,
          }}
        >
          <div>
            <p style={{ fontSize: 18, fontWeight: 700, color: c.text, margin: 0 }}>{pkg.price}</p>
            <p style={{ fontSize: 11.5, color: c.textTertiary, margin: '1px 0 0' }}>
              one-time · becomes a project
            </p>
          </div>
          <button
            onClick={() => setView('purchased')}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '12px 24px',
              borderRadius: 11,
              border: 'none',
              cursor: 'pointer',
              fontSize: 14,
              fontWeight: 650,
              color: 'white',
              background: c.gradient,
              boxShadow: `0 2px 10px ${c.primaryGlow}`,
            }}
          >
            <Icons.zap size={16} color="white" /> Buy & start
          </button>
        </div>
      )}
      {view === 'ask' && (
        <div
          style={{
            padding: '16px 24px',
            borderTop: `1px solid ${c.borderSubtle}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 16,
            flexShrink: 0,
          }}
        >
          <button
            onClick={() => setView('details')}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '11px 16px',
              borderRadius: 11,
              border: `1px solid ${c.border}`,
              background: c.surface,
              cursor: 'pointer',
              fontSize: 14,
              fontWeight: 600,
              color: c.textSecondary,
            }}
          >
            <Icons.chevLeft size={15} color={c.textSecondary} /> Back
          </button>
          <button
            disabled={!msg.trim()}
            onClick={() => setView('asked')}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '11px 24px',
              borderRadius: 11,
              border: 'none',
              cursor: msg.trim() ? 'pointer' : 'default',
              fontSize: 14,
              fontWeight: 650,
              color: 'white',
              background: msg.trim() ? c.gradient : '#CBD5E1',
              boxShadow: msg.trim() ? `0 2px 10px ${c.primaryGlow}` : 'none',
              transition: 'all 0.2s',
            }}
          >
            <Icons.messageCircle size={15} color="white" /> Send
          </button>
        </div>
      )}
    </Drawer>
  );
}

function PackagesSection() {
  const [active, setActive] = useState(null);
  const wrapRef = useRef(null);
  const [bleed, setBleed] = useState({ left: 0, width: 0 });

  useLayoutEffect(() => {
    const measure = () => {
      const el = wrapRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      setBleed({ left: -rect.left, width: document.documentElement.clientWidth });
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);

  return (
    <>
      <div ref={wrapRef} style={{ position: 'relative', ...slideUp(0.1) }}>
        {/* Full-bleed background bar — breaks out of the column to the viewport edges */}
        <div
          style={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            left: bleed.left,
            width: bleed.width,
            zIndex: 0,
            background: 'linear-gradient(135deg, #E2EAFB 0%, #EBE1FB 100%)',
            boxShadow: `0 10px 34px rgba(124,58,237,0.10)`,
          }}
        />

        {/* Content — stays within the column */}
        <div style={{ position: 'relative', zIndex: 1, padding: '28px 0' }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 12,
              marginBottom: 4,
              flexWrap: 'wrap',
            }}
          >
            <SectionLabel icon={Icons.zap} color={c.accent}>
              Quick Starts
            </SectionLabel>
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                fontSize: 11,
                fontWeight: 700,
                color: 'white',
                background: c.accent,
                border: 'none',
                padding: '4px 11px',
                borderRadius: 999,
                boxShadow: `0 2px 8px ${c.accent}3A`,
              }}
            >
              <Icons.sparkles size={12} color="white" /> Fastest way to start
            </span>
          </div>
          <p style={{ fontSize: 13, color: c.textSecondary, margin: '0 0 18px', lineHeight: 1.55 }}>
            Pre-packaged, fixed-price projects you can buy in a click. Need something custom? Start
            a project and {EXPERT.name.split(' ')[0]} will scope a proposal.
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {PACKAGES.map((p, i) => (
              <PackageCard key={p.title} pkg={p} index={i} onOpen={() => setActive(p)} />
            ))}
          </div>
        </div>
      </div>
      {active && <QuickStartDrawer pkg={active} onClose={() => setActive(null)} />}
    </>
  );
}

function ReviewCard({ r, index }) {
  return (
    <div
      style={{
        padding: '18px 20px',
        borderRadius: 14,
        border: `1px solid ${c.borderSubtle}`,
        background: c.surface,
        ...slideUp(0.05 + index * 0.06),
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
        <div
          style={{
            width: 40,
            height: 40,
            borderRadius: 11,
            background: `${r.color}14`,
            border: `1px solid ${r.color}28`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 14,
            fontWeight: 700,
            color: r.color,
            flexShrink: 0,
          }}
        >
          {r.initials}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{ fontSize: 14, fontWeight: 650, color: c.text, margin: 0 }}>{r.name}</p>
          <p style={{ fontSize: 12, color: c.textTertiary, margin: '1px 0 0' }}>{r.role}</p>
        </div>
        <div style={{ textAlign: 'right' }}>
          <StarRow rating={r.rating} size={14} />
          <p style={{ fontSize: 11, color: c.textTertiary, margin: '4px 0 0' }}>{r.date}</p>
        </div>
      </div>
      <p
        style={{
          fontSize: 14,
          color: c.textSecondary,
          lineHeight: 1.6,
          margin: 0,
          fontStyle: 'italic',
        }}
      >
        “{r.quote}”
      </p>
    </div>
  );
}

function WorkItem({ w, last, index }) {
  const [open, setOpen] = useState(w.current);
  return (
    <div
      style={{ display: 'flex', gap: 18, alignItems: 'stretch', ...slideUp(0.05 + index * 0.06) }}
    >
      {/* Rail */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          flexShrink: 0,
          paddingTop: 18,
        }}
      >
        <div
          style={{
            width: 14,
            height: 14,
            borderRadius: '50%',
            flexShrink: 0,
            background: w.current ? c.accent : c.surface,
            border: `2.5px solid ${w.current ? c.accent : c.border}`,
            boxShadow: w.current ? `0 0 0 4px ${c.accent}1A` : 'none',
          }}
        />
        {!last && (
          <div
            style={{ width: 2, flex: 1, background: c.borderSubtle, marginTop: 4, minHeight: 24 }}
          />
        )}
      </div>

      {/* Card */}
      <div style={{ flex: 1, minWidth: 0, paddingBottom: last ? 0 : 14 }}>
        <div
          style={{
            background: c.surface,
            border: `1px solid ${c.border}`,
            borderRadius: 14,
            padding: '16px 18px',
            boxShadow: '0 1px 3px rgba(27,26,68,0.05)',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              justifyContent: 'space-between',
              gap: 12,
            }}
          >
            <div style={{ minWidth: 0 }}>
              <h4 style={{ fontSize: 16, fontWeight: 700, color: c.text, margin: 0 }}>{w.role}</h4>
              <p style={{ fontSize: 14, fontWeight: 650, color: c.primary, margin: '3px 0 0' }}>
                {w.company}
              </p>
              <p style={{ fontSize: 13, color: c.textTertiary, margin: '3px 0 0' }}>{w.period}</p>
            </div>
            {w.current ? (
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 5,
                  flexShrink: 0,
                  fontSize: 11.5,
                  fontWeight: 650,
                  color: c.success,
                  background: c.successLight,
                  border: `1px solid ${c.successBorder}`,
                  padding: '3px 10px',
                  borderRadius: 999,
                }}
              >
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: c.success }} />{' '}
                Current
              </span>
            ) : (
              <span
                style={{
                  flexShrink: 0,
                  fontSize: 11.5,
                  fontWeight: 600,
                  color: c.textTertiary,
                  background: c.surfaceSubtle,
                  border: `1px solid ${c.borderSubtle}`,
                  padding: '3px 10px',
                  borderRadius: 999,
                }}
              >
                {w.length}
              </span>
            )}
          </div>

          <p style={{ fontSize: 14, color: c.textSecondary, lineHeight: 1.65, margin: '12px 0 0' }}>
            {w.summary}
          </p>
          <div
            style={{
              maxHeight: open ? 160 : 0,
              overflow: 'hidden',
              transition: 'max-height 0.35s ease',
            }}
          >
            <p
              style={{ fontSize: 14, color: c.textSecondary, lineHeight: 1.65, margin: '10px 0 0' }}
            >
              {w.detail}
            </p>
          </div>
          <button
            onClick={() => setOpen(!open)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 5,
              marginTop: 12,
              background: 'none',
              border: 'none',
              padding: 0,
              cursor: 'pointer',
              fontSize: 13,
              fontWeight: 650,
              color: c.accent,
            }}
          >
            {open ? 'View less' : 'View more'}
            <Icons.chevDown
              size={14}
              color={c.accent}
              style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }}
            />
          </button>
        </div>
      </div>
    </div>
  );
}

function WorkSection() {
  const first = EXPERT.name.split(' ')[0];
  return (
    <Card style={{ padding: '26px 28px', ...slideUp(0.12) }}>
      <SectionLabel icon={Icons.briefcase} color={c.accent}>
        Work
      </SectionLabel>
      <h3
        style={{
          fontSize: 22,
          fontWeight: 700,
          color: c.text,
          margin: '0 0 22px',
          letterSpacing: '-0.02em',
        }}
      >
        How {first} got here
      </h3>
      <div>
        {EXPERT.work.map((w, i) => (
          <WorkItem key={i} w={w} index={i} last={i === EXPERT.work.length - 1} />
        ))}
      </div>
    </Card>
  );
}

function ReviewsSection() {
  return (
    <Card style={{ padding: '26px 28px', ...slideUp(0.12) }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 18,
        }}
      >
        <SectionLabel icon={Icons.messageCircle} color={c.pink}>
          Reviews
        </SectionLabel>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <RatingStar rating={EXPERT.rating} size={18} />
          <span style={{ fontSize: 14, fontWeight: 700, color: c.text }}>{EXPERT.rating}</span>
          <span style={{ fontSize: 13, color: c.textTertiary }}>· {EXPERT.reviews} reviews</span>
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {REVIEWS.map((r, i) => (
          <ReviewCard key={r.name} r={r} index={i} />
        ))}
      </div>
      <button
        style={{
          marginTop: 16,
          width: '100%',
          padding: '11px',
          borderRadius: 10,
          border: `1px solid ${c.border}`,
          background: c.surface,
          color: c.textSecondary,
          fontSize: 13,
          fontWeight: 600,
          cursor: 'pointer',
        }}
      >
        See all {EXPERT.reviews} reviews
      </button>
    </Card>
  );
}

// ══════════════════════════════════════════════════════════════════
// BOOKING SIDEBAR
// ══════════════════════════════════════════════════════════════════

// June 2026 grid (Mon-first), faithful to the live booking calendar
const JUNE = [
  [
    { d: 1, s: 'past' },
    { d: 2, s: 'past' },
    { d: 3, s: 'past' },
    { d: 4, s: 'today' },
    { d: 5, s: 'ok' },
    { d: 6, s: 'off' },
    { d: 7, s: 'off' },
  ],
  [
    { d: 8, s: 'ok' },
    { d: 9, s: 'ok' },
    { d: 10, s: 'ok' },
    { d: 11, s: 'ok' },
    { d: 12, s: 'ok' },
    { d: 13, s: 'off' },
    { d: 14, s: 'off' },
  ],
  [
    { d: 15, s: 'ok' },
    { d: 16, s: 'ok' },
    { d: 17, s: 'ok' },
    { d: 18, s: 'ok' },
    { d: 19, s: 'ok' },
    { d: 20, s: 'off' },
    { d: 21, s: 'off' },
  ],
  [
    { d: 22, s: 'ok' },
    { d: 23, s: 'ok' },
    { d: 24, s: 'ok' },
    { d: 25, s: 'ok' },
    { d: 26, s: 'ok' },
    { d: 27, s: 'off' },
    { d: 28, s: 'off' },
  ],
  [
    { d: 29, s: 'ok' },
    { d: 30, s: 'ok' },
    { d: 1, s: 'next' },
    { d: 2, s: 'next' },
    { d: 3, s: 'next' },
    { d: 4, s: 'off' },
    { d: 5, s: 'off' },
  ],
];
const DOW = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];
const ALL_SLOTS = [
  '9:00 AM',
  '9:30 AM',
  '10:00 AM',
  '11:00 AM',
  '1:00 PM',
  '2:30 PM',
  '3:00 PM',
  '3:30 PM',
  '5:00 PM',
  '5:30 PM',
  '6:00 PM',
  '6:30 PM',
  '7:00 PM',
  '7:30 PM',
];

// Surfaced quick-pick slots — clicking one jumps straight to Review (calendar skipped)
const QUICK_SLOTS = [
  { id: 'q1', dayLabel: 'Today', date: { d: 4, label: 'Thu 4 Jun' }, time: '3:00 PM' },
  { id: 'q2', dayLabel: 'Tomorrow', date: { d: 5, label: 'Fri 5 Jun' }, time: '10:00 AM' },
  { id: 'q3', dayLabel: 'Thu', date: { d: 11, label: 'Thu 11 Jun' }, time: '2:30 PM' },
];

const FLOW_STEPS = [
  { k: 'calendar', l: 'Choose a time' },
  { k: 'details', l: 'Review & confirm' },
];

// ── Shared right-hand Drawer shell (used by both booking + project flows) ──
function Drawer({ onClose, width = 480, children }) {
  const isMobile = useIsMobile();
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 100,
        background: 'rgba(17,18,40,0.4)',
        backdropFilter: 'blur(3px)',
        display: 'flex',
        justifyContent: isMobile ? 'stretch' : 'flex-end',
        alignItems: isMobile ? 'flex-end' : 'stretch',
        ...fadeIn(0),
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%',
          maxWidth: isMobile ? '100%' : width,
          height: isMobile ? 'auto' : '100vh',
          maxHeight: isMobile ? '92vh' : '100vh',
          background: c.surface,
          display: 'flex',
          flexDirection: 'column',
          borderRadius: isMobile ? '20px 20px 0 0' : 0,
          boxShadow: isMobile
            ? '0 -16px 50px rgba(17,18,40,0.28)'
            : '-24px 0 70px rgba(17,18,40,0.28)',
          animation: isMobile
            ? 'slideUpSheet 0.32s cubic-bezier(0.22,0.8,0.28,1)'
            : 'slideInRight 0.34s cubic-bezier(0.22,0.8,0.28,1)',
        }}
      >
        {children}
      </div>
    </div>
  );
}

function DrawerHead({ children, onClose }) {
  return (
    <div
      style={{
        padding: '16px 24px',
        borderBottom: `1px solid ${c.borderSubtle}`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexShrink: 0,
      }}
    >
      {children}
      <button
        onClick={onClose}
        style={{
          width: 36,
          height: 36,
          borderRadius: 10,
          border: `1px solid ${c.border}`,
          background: c.surface,
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        <Icons.x size={16} color={c.textSecondary} />
      </button>
    </div>
  );
}

// Generic stepper for a flow (array of {k,l} + current step key). Completed steps are clickable when onJump is provided.
function FlowStepper({ steps, current, onJump }) {
  const idx = Math.max(
    0,
    steps.findIndex((s) => s.k === current)
  );
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      {steps.map((s, i) => {
        const active = i === idx,
          done = i < idx;
        const clickable = onJump && i < idx;
        const inner = (
          <>
            <div
              style={{
                width: 22,
                height: 22,
                borderRadius: '50%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 11,
                fontWeight: 700,
                background: done ? c.gradient : active ? c.primaryLight : c.surfaceSubtle,
                color: done ? 'white' : active ? c.primary : c.textTertiary,
                border: active ? `1px solid ${c.primaryBorder}` : 'none',
              }}
            >
              {done ? <Icons.check size={12} color="white" /> : i + 1}
            </div>
            <span
              style={{
                fontSize: 13,
                fontWeight: active ? 650 : 500,
                color: active ? c.text : c.textTertiary,
                textDecoration: clickable ? 'underline' : 'none',
                textDecorationColor: c.border,
                textUnderlineOffset: 3,
              }}
            >
              {s.l}
            </span>
          </>
        );
        return (
          <div key={s.k} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {clickable ? (
              <button
                onClick={() => onJump(s.k)}
                title={`Back to ${s.l}`}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 7,
                  background: 'none',
                  border: 'none',
                  padding: 0,
                  cursor: 'pointer',
                }}
              >
                {inner}
              </button>
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>{inner}</div>
            )}
            {i < steps.length - 1 && <div style={{ width: 18, height: 1, background: c.border }} />}
          </div>
        );
      })}
    </div>
  );
}

function Stepper({ step }) {
  const idx = step === 'details' ? 1 : 0;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      {FLOW_STEPS.map((s, i) => {
        const active = i === idx,
          done = i < idx;
        return (
          <div key={s.k} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div
                style={{
                  width: 22,
                  height: 22,
                  borderRadius: '50%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 11,
                  fontWeight: 700,
                  background: done ? c.gradient : active ? c.primaryLight : c.surfaceSubtle,
                  color: done ? 'white' : active ? c.primary : c.textTertiary,
                  border: active ? `1px solid ${c.primaryBorder}` : 'none',
                }}
              >
                {done ? <Icons.check size={12} color="white" /> : i + 1}
              </div>
              <span
                style={{
                  fontSize: 13,
                  fontWeight: active ? 650 : 500,
                  color: active ? c.text : c.textTertiary,
                }}
              >
                {s.l}
              </span>
            </div>
            {i < FLOW_STEPS.length - 1 && (
              <div style={{ width: 24, height: 1, background: c.border }} />
            )}
          </div>
        );
      })}
    </div>
  );
}

function BookingDrawer({ onClose, startStep = 'calendar', preset = null }) {
  const [step, setStep] = useState(startStep);
  const [sel, setSel] = useState(preset?.date || { d: 4, label: 'Thu 4 Jun' });
  const [slot, setSlot] = useState(preset?.time || null);
  const [dur, setDur] = useState('30m');
  const [note, setNote] = useState('');

  const minutes = dur === '30m' ? 30 : 60;
  const estimate = (minutes * EXPERT.rate).toFixed(2);

  return (
    <Drawer onClose={onClose} width={480}>
      <DrawerHead onClose={onClose}>
        {step === 'done' ? (
          <h3 style={{ fontSize: 16, fontWeight: 700, color: c.text, margin: 0 }}>
            Booking confirmed
          </h3>
        ) : (
          <Stepper step={step} />
        )}
      </DrawerHead>

      <div style={{ flex: 1, overflowY: 'auto' }}>
        {/* ── STEP 1 · CALENDAR (stacked vertically) ─────────── */}
        {step === 'calendar' && (
          <div style={{ padding: '18px 24px 24px' }}>
            <p
              style={{
                fontSize: 13,
                color: c.textTertiary,
                margin: '0 0 18px',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
              }}
            >
              <Icons.globe size={13} color={c.textTertiary} /> Australia/Melbourne (GMT +10:00)
            </p>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                marginBottom: 14,
              }}
            >
              <span style={{ fontSize: 17, fontWeight: 700, color: c.text }}>
                June <span style={{ color: c.textTertiary, fontWeight: 500 }}>2026</span>
              </span>
              <div style={{ display: 'flex', gap: 6 }}>
                {[Icons.chevLeft, Icons.chevRight].map((Ic, i) => (
                  <button
                    key={i}
                    style={{
                      width: 30,
                      height: 30,
                      borderRadius: 8,
                      border: `1px solid ${c.border}`,
                      background: c.surface,
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <Ic size={14} color={c.textSecondary} />
                  </button>
                ))}
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 5 }}>
              {DOW.map((d) => (
                <div
                  key={d}
                  style={{
                    textAlign: 'center',
                    fontSize: 11,
                    fontWeight: 700,
                    color: c.textTertiary,
                    letterSpacing: '0.05em',
                    paddingBottom: 4,
                  }}
                >
                  {d}
                </div>
              ))}
              {JUNE.flat().map((cell, i) => {
                const disabled = cell.s === 'past' || cell.s === 'off';
                const muted = cell.s === 'next';
                const isSel = sel.d === cell.d && !disabled;
                return (
                  <button
                    key={i}
                    disabled={disabled}
                    onClick={() => {
                      setSel({ d: cell.d, label: `${cell.d} ${muted ? 'Jul' : 'Jun'}` });
                      setSlot(null);
                    }}
                    style={{
                      height: 42,
                      borderRadius: 9,
                      border: 'none',
                      fontSize: 14,
                      fontWeight: isSel ? 700 : 550,
                      cursor: disabled ? 'default' : 'pointer',
                      transition: 'all 0.15s',
                      background: isSel ? c.primary : 'transparent',
                      color: isSel
                        ? 'white'
                        : disabled
                          ? '#CBD2DC'
                          : muted
                            ? c.textTertiary
                            : c.text,
                      outline:
                        cell.s === 'today' && !isSel ? `1.5px solid ${c.primaryBorder}` : 'none',
                    }}
                  >
                    {cell.d}
                  </button>
                );
              })}
            </div>

            {/* Slots for selected day */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                margin: '22px 0 10px',
              }}
            >
              <span style={{ fontSize: 15, fontWeight: 700, color: c.text }}>{sel.label}</span>
              <select
                value={dur}
                onChange={(e) => setDur(e.target.value)}
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  color: c.textSecondary,
                  border: `1px solid ${c.border}`,
                  borderRadius: 8,
                  padding: '5px 8px',
                  background: c.surface,
                  cursor: 'pointer',
                }}
              >
                <option value="30m">30 min</option>
                <option value="60m">60 min</option>
              </select>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 8 }}>
              {ALL_SLOTS.map((s) => {
                const on = slot === s;
                return (
                  <button
                    key={s}
                    onClick={() => setSlot(s)}
                    style={{
                      padding: '9px 6px',
                      borderRadius: 9,
                      cursor: 'pointer',
                      fontSize: 13,
                      fontWeight: 600,
                      transition: 'all 0.15s',
                      border: `1px solid ${on ? c.primary : c.border}`,
                      background: on ? c.primaryLight : c.surface,
                      color: on ? c.primary : c.textSecondary,
                    }}
                  >
                    {s}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* ── STEP 2 · REVIEW & CONFIRM ─────────────────────── */}
        {step === 'details' && (
          <div style={{ padding: '20px 24px 24px' }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 14,
                padding: '16px 18px',
                borderRadius: 14,
                background: c.primaryLight,
                border: `1px solid ${c.primaryBorder}`,
              }}
            >
              <div
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: 12,
                  background: 'white',
                  border: `1px solid ${c.primaryBorder}`,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                }}
              >
                <Icons.calendar size={20} color={c.primary} />
              </div>
              <div style={{ flex: 1 }}>
                <p style={{ fontSize: 16, fontWeight: 700, color: c.text, margin: 0 }}>
                  {sel.label} · {slot}
                </p>
                <p style={{ fontSize: 13, color: c.textSecondary, margin: '2px 0 0' }}>
                  Video consultation with {EXPERT.name}
                </p>
              </div>
            </div>

            <button
              onClick={() => setStep('calendar')}
              style={{
                width: '100%',
                marginTop: 10,
                padding: '10px',
                borderRadius: 10,
                cursor: 'pointer',
                border: `1px solid ${c.border}`,
                background: c.surface,
                color: c.primary,
                fontSize: 13,
                fontWeight: 600,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 7,
              }}
            >
              <Icons.calendar size={14} color={c.primary} /> See other times available
            </button>

            <div style={{ marginTop: 22 }}>
              <p style={{ fontSize: 13, fontWeight: 650, color: c.text, margin: '0 0 8px' }}>
                Duration
              </p>
              <div style={{ display: 'flex', gap: 8 }}>
                {['30m', '60m'].map((d) => {
                  const on = dur === d;
                  return (
                    <button
                      key={d}
                      onClick={() => setDur(d)}
                      style={{
                        flex: 1,
                        padding: '10px',
                        borderRadius: 10,
                        cursor: 'pointer',
                        fontSize: 13.5,
                        fontWeight: 650,
                        transition: 'all 0.15s',
                        border: `1px solid ${on ? c.primary : c.border}`,
                        background: on ? c.primaryLight : c.surface,
                        color: on ? c.primary : c.textSecondary,
                      }}
                    >
                      {d === '30m' ? '30 minutes' : '60 minutes'}
                    </button>
                  );
                })}
              </div>
            </div>

            <div style={{ marginTop: 18 }}>
              <p style={{ fontSize: 13, fontWeight: 650, color: c.text, margin: '0 0 8px' }}>
                What would you like to cover?{' '}
                <span style={{ fontWeight: 500, color: c.textTertiary }}>(optional)</span>
              </p>
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={3}
                placeholder="A sentence or two helps the expert prepare…"
                style={{
                  width: '100%',
                  padding: '10px 12px',
                  borderRadius: 10,
                  border: `1px solid ${c.border}`,
                  fontSize: 14,
                  color: c.text,
                  outline: 'none',
                  resize: 'vertical',
                  fontFamily: 'inherit',
                  boxSizing: 'border-box',
                }}
              />
            </div>

            <div
              style={{
                marginTop: 18,
                padding: '14px 16px',
                borderRadius: 12,
                background: c.surfaceSubtle,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}
            >
              <div>
                <p style={{ fontSize: 14, fontWeight: 650, color: c.text, margin: 0 }}>
                  Estimated cost · {minutes} min
                </p>
                <p style={{ fontSize: 12, color: c.textTertiary, margin: '2px 0 0' }}>
                  Billed per minute — you only pay for time used
                </p>
              </div>
              <span style={{ fontSize: 20, fontWeight: 700, color: c.text }}>A${estimate}</span>
            </div>
          </div>
        )}

        {/* ── STEP 3 · CONFIRMED ────────────────────────────── */}
        {step === 'done' && (
          <div style={{ padding: '52px 32px', textAlign: 'center' }}>
            <div
              style={{
                width: 68,
                height: 68,
                borderRadius: '50%',
                margin: '0 auto 18px',
                background: c.gradientWarm,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                boxShadow: '0 8px 28px rgba(5,150,105,0.3)',
                animation: 'scaleIn 0.3s ease-out',
              }}
            >
              <Icons.check size={30} color="white" />
            </div>
            <h3 style={{ fontSize: 22, fontWeight: 700, color: c.text, margin: 0 }}>
              You're booked!
            </h3>
            <p
              style={{
                fontSize: 15,
                color: c.textSecondary,
                margin: '10px auto 0',
                maxWidth: 320,
                lineHeight: 1.6,
              }}
            >
              {sel.label} at {slot} · {minutes}-minute consultation with {EXPERT.name}. A calendar
              invite and reminders are on the way.
            </p>
            <button
              onClick={onClose}
              style={{
                marginTop: 24,
                padding: '12px 28px',
                borderRadius: 11,
                border: 'none',
                cursor: 'pointer',
                fontSize: 14,
                fontWeight: 650,
                color: 'white',
                background: c.gradient,
              }}
            >
              Done
            </button>
          </div>
        )}
      </div>

      {/* Footers */}
      {step === 'calendar' && (
        <div
          style={{
            padding: '16px 24px',
            borderTop: `1px solid ${c.borderSubtle}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 16,
            flexShrink: 0,
          }}
        >
          <span
            style={{
              fontSize: 13.5,
              color: slot ? c.text : c.textTertiary,
              fontWeight: slot ? 600 : 400,
            }}
          >
            {slot ? `${sel.label} · ${slot}` : 'Select a date and time'}
          </span>
          <button
            disabled={!slot}
            onClick={() => setStep('details')}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '11px 22px',
              borderRadius: 11,
              border: 'none',
              cursor: slot ? 'pointer' : 'default',
              fontSize: 14,
              fontWeight: 650,
              color: 'white',
              background: slot ? c.gradient : '#CBD5E1',
              boxShadow: slot ? `0 2px 10px ${c.primaryGlow}` : 'none',
              transition: 'all 0.2s',
            }}
          >
            Continue <Icons.arrowRight size={15} color="white" />
          </button>
        </div>
      )}
      {step === 'details' && (
        <div
          style={{
            padding: '16px 24px',
            borderTop: `1px solid ${c.borderSubtle}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 16,
            flexShrink: 0,
          }}
        >
          <button
            onClick={() => setStep('calendar')}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '11px 16px',
              borderRadius: 11,
              border: `1px solid ${c.border}`,
              background: c.surface,
              cursor: 'pointer',
              fontSize: 14,
              fontWeight: 600,
              color: c.textSecondary,
            }}
          >
            <Icons.chevLeft size={15} color={c.textSecondary} /> Back
          </button>
          <button
            onClick={() => setStep('done')}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '11px 24px',
              borderRadius: 11,
              border: 'none',
              cursor: 'pointer',
              fontSize: 14,
              fontWeight: 650,
              color: 'white',
              background: c.gradient,
              boxShadow: `0 2px 10px ${c.primaryGlow}`,
            }}
          >
            <Icons.video size={16} color="white" /> Confirm booking
          </button>
        </div>
      )}
    </Drawer>
  );
}

// ══════════════════════════════════════════════════════════════════
// PROJECT REQUEST FLOW
// ══════════════════════════════════════════════════════════════════

const PROJECT_PATHS = [
  {
    k: 'manual',
    icon: Icons.edit,
    color: c.primary,
    title: 'Describe it yourself',
    desc: 'A couple of sentences is all we need to capture your intent.',
  },
  {
    k: 'ai',
    icon: Icons.sparkles,
    color: c.accent,
    title: "Upload docs — we'll draft it",
    desc: 'Add an RFP, email, or notes. AI writes a short brief you approve.',
    badge: 'AI',
  },
];
const PROJECT_AREAS = [
  'Sales Cloud',
  'Service Cloud',
  'Data Cloud',
  'Integration',
  'Agentforce',
  'Flow & Automation',
  'Other',
];
const BUDGETS = ['< A$2k', 'A$2–5k', 'A$5–15k', 'A$15k+', 'Not sure'];
const TIMELINES = ['ASAP', '2–4 weeks', '1–3 months', 'Flexible'];
const SAMPLE_FILES = ['Project-RFP.pdf', 'Current-state-notes.docx', 'Integration-diagram.png'];

function FieldLabel({ children, optional, style: xs }) {
  return (
    <p style={{ fontSize: 13, fontWeight: 650, color: c.text, margin: '0 0 8px', ...xs }}>
      {children}
      {optional && <span style={{ fontWeight: 500, color: c.textTertiary }}> (optional)</span>}
    </p>
  );
}

function ChipRow({ options, value, onChange }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
      {options.map((o) => {
        const on = value === o;
        return (
          <button
            key={o}
            onClick={() => onChange(on ? null : o)}
            style={{
              padding: '7px 13px',
              borderRadius: 999,
              cursor: 'pointer',
              fontSize: 13,
              fontWeight: 600,
              transition: 'all 0.15s',
              border: `1px solid ${on ? c.primary : c.border}`,
              background: on ? c.primaryLight : c.surface,
              color: on ? c.primary : c.textSecondary,
            }}
          >
            {o}
          </button>
        );
      })}
    </div>
  );
}

function PathCard({ p, onClick }) {
  const [h, setH] = useState(false);
  const PIcon = p.icon;
  return (
    <button
      onMouseEnter={() => setH(true)}
      onMouseLeave={() => setH(false)}
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 15,
        padding: '18px 18px',
        borderRadius: 14,
        cursor: 'pointer',
        textAlign: 'left',
        width: '100%',
        border: `1px solid ${h ? p.color + '55' : c.border}`,
        background: h ? `${p.color}06` : c.surface,
        boxShadow: h ? `0 4px 18px ${p.color}1A` : 'none',
        transition: 'all 0.2s',
      }}
    >
      <div
        style={{
          width: 48,
          height: 48,
          borderRadius: 13,
          flexShrink: 0,
          background: `${p.color}12`,
          border: `1px solid ${p.color}25`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <PIcon size={22} color={p.color} />
      </div>
      <div style={{ flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <p style={{ fontSize: 15.5, fontWeight: 700, color: c.text, margin: 0 }}>{p.title}</p>
          {p.badge && (
            <span
              style={{
                fontSize: 10,
                fontWeight: 700,
                color: p.color,
                background: `${p.color}12`,
                border: `1px solid ${p.color}30`,
                padding: '2px 7px',
                borderRadius: 6,
                letterSpacing: '0.04em',
              }}
            >
              {p.badge}
            </span>
          )}
        </div>
        <p style={{ fontSize: 13, color: c.textSecondary, margin: '4px 0 0', lineHeight: 1.5 }}>
          {p.desc}
        </p>
      </div>
      <Icons.chevRight size={18} color={h ? p.color : c.textTertiary} />
    </button>
  );
}

function ProjectDrawer({ onClose }) {
  const [step, setStep] = useState('start'); // start | manual | ai | review | done
  const [path, setPath] = useState(null);
  const [title, setTitle] = useState('');
  const [desc, setDesc] = useState('');
  const [area, setArea] = useState(null);
  const [budget, setBudget] = useState(null);
  const [timeline, setTimeline] = useState(null);
  const [files, setFiles] = useState([]);
  const [generating, setGenerating] = useState(false);

  const steps =
    path === 'ai'
      ? [
          { k: 'start', l: 'Start' },
          { k: 'ai', l: 'Upload' },
          { k: 'review', l: 'Review' },
        ]
      : [
          { k: 'start', l: 'Start' },
          { k: 'manual', l: 'Describe' },
          { k: 'review', l: 'Review' },
        ];

  const addFile = () =>
    setFiles((prev) =>
      prev.length < SAMPLE_FILES.length ? [...prev, SAMPLE_FILES[prev.length]] : prev
    );
  const removeFile = (i) => setFiles((prev) => prev.filter((_, idx) => idx !== i));

  const generate = () => {
    setGenerating(true);
    setStep('ai');
    setTimeout(() => {
      setTitle('Salesforce ↔ NetSuite integration rebuild');
      setDesc(
        'Replace the brittle point-to-point sync between Salesforce and NetSuite with a resilient middleware pattern. Fix duplicate-record creation on the Order object, add retry logic and error alerting, and document the end-to-end data flow for the internal admin team.'
      );
      setArea('Integration');
      setTimeline('2–4 weeks');
      setGenerating(false);
      setStep('review');
    }, 1700);
  };

  const reviewValid = title.trim() && desc.trim();
  const inputStyle = {
    width: '100%',
    padding: '10px 12px',
    borderRadius: 10,
    border: `1px solid ${c.border}`,
    fontSize: 14,
    color: c.text,
    outline: 'none',
    fontFamily: 'inherit',
    boxSizing: 'border-box',
  };

  return (
    <Drawer onClose={onClose} width={520}>
      <DrawerHead onClose={onClose}>
        {step === 'done' ? (
          <h3 style={{ fontSize: 16, fontWeight: 700, color: c.text, margin: 0 }}>Request sent</h3>
        ) : (
          <FlowStepper steps={steps} current={step} onJump={setStep} />
        )}
      </DrawerHead>

      <div style={{ flex: 1, overflowY: 'auto' }}>
        {/* ── START · path fork ─────────────────────────────── */}
        {step === 'start' && (
          <div style={{ padding: '24px' }}>
            <h3
              style={{
                fontSize: 21,
                fontWeight: 700,
                color: c.text,
                margin: 0,
                letterSpacing: '-0.01em',
              }}
            >
              Start a project with {EXPERT.name}
            </h3>
            <p
              style={{
                fontSize: 14,
                color: c.textSecondary,
                margin: '8px 0 22px',
                lineHeight: 1.6,
              }}
            >
              Tell us what you need and {EXPERT.name.split(' ')[0]} replies with a scoped proposal.
              Pick how you'd like to begin — both take a minute or two.
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {PROJECT_PATHS.map((p) => (
                <PathCard
                  key={p.k}
                  p={p}
                  onClick={() => {
                    setPath(p.k);
                    setStep(p.k);
                  }}
                />
              ))}
            </div>
          </div>
        )}

        {/* ── MANUAL · lean form ────────────────────────────── */}
        {step === 'manual' && (
          <div style={{ padding: '24px' }}>
            <button
              onClick={() => setStep('start')}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 5,
                background: 'none',
                border: 'none',
                padding: 0,
                marginBottom: 18,
                cursor: 'pointer',
                fontSize: 13,
                fontWeight: 600,
                color: c.primary,
              }}
            >
              <Icons.chevLeft size={14} color={c.primary} /> Change entry method
            </button>
            <FieldLabel>Project title</FieldLabel>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Rebuild our lead routing in Flow"
              style={inputStyle}
            />

            <FieldLabel style={{ marginTop: 18 }}>What do you need?</FieldLabel>
            <textarea
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
              rows={5}
              placeholder="Describe the problem or the outcome you're after — a rough sketch is fine."
              style={{ ...inputStyle, resize: 'vertical' }}
            />
            <p style={{ fontSize: 12, color: c.textTertiary, margin: '6px 0 0', lineHeight: 1.5 }}>
              Keep it as short as you like — you can refine it with the expert later.
            </p>

            <FieldLabel optional style={{ marginTop: 20 }}>
              Focus area
            </FieldLabel>
            <ChipRow options={PROJECT_AREAS} value={area} onChange={setArea} />

            <div
              style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, marginTop: 20 }}
            >
              <div>
                <FieldLabel optional>Budget</FieldLabel>
                <ChipRow options={BUDGETS} value={budget} onChange={setBudget} />
              </div>
              <div>
                <FieldLabel optional>Timeline</FieldLabel>
                <ChipRow options={TIMELINES} value={timeline} onChange={setTimeline} />
              </div>
            </div>
          </div>
        )}

        {/* ── AI · upload + generate ────────────────────────── */}
        {step === 'ai' && (
          <div style={{ padding: '24px' }}>
            {generating ? (
              <div style={{ padding: '48px 12px', textAlign: 'center' }}>
                <div
                  style={{
                    width: 44,
                    height: 44,
                    margin: '0 auto 18px',
                    borderRadius: '50%',
                    border: `3px solid ${c.borderSubtle}`,
                    borderTopColor: c.accent,
                    animation: 'spin 0.8s linear infinite',
                  }}
                />
                <p style={{ fontSize: 16, fontWeight: 700, color: c.text, margin: 0 }}>
                  Reading your documents…
                </p>
                <p style={{ fontSize: 13.5, color: c.textSecondary, margin: '6px 0 0' }}>
                  Drafting a short project brief you can edit and approve.
                </p>
              </div>
            ) : (
              <>
                <button
                  onClick={() => setStep('start')}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 5,
                    background: 'none',
                    border: 'none',
                    padding: 0,
                    marginBottom: 18,
                    cursor: 'pointer',
                    fontSize: 13,
                    fontWeight: 600,
                    color: c.primary,
                  }}
                >
                  <Icons.chevLeft size={14} color={c.primary} /> Change entry method
                </button>
                <h3 style={{ fontSize: 19, fontWeight: 700, color: c.text, margin: 0 }}>
                  Upload your project docs
                </h3>
                <p
                  style={{
                    fontSize: 14,
                    color: c.textSecondary,
                    margin: '8px 0 18px',
                    lineHeight: 1.6,
                  }}
                >
                  RFPs, requirement docs, email threads, screenshots — we'll read them and draft a
                  short brief for you to approve.
                </p>
                <button
                  onClick={addFile}
                  style={{
                    width: '100%',
                    padding: '28px 16px',
                    borderRadius: 14,
                    cursor: 'pointer',
                    textAlign: 'center',
                    border: `1.5px dashed ${c.accentBorder}`,
                    background: c.accentLight,
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    gap: 8,
                  }}
                >
                  <div
                    style={{
                      width: 44,
                      height: 44,
                      borderRadius: 12,
                      background: 'white',
                      border: `1px solid ${c.accentBorder}`,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <Icons.upload size={20} color={c.accent} />
                  </div>
                  <span style={{ fontSize: 14, fontWeight: 650, color: c.accent }}>
                    Browse files
                  </span>
                  <span style={{ fontSize: 12.5, color: c.textTertiary }}>
                    or drag and drop · PDF, DOCX, images
                  </span>
                </button>

                {files.length > 0 && (
                  <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {files.map((f, i) => (
                      <div
                        key={i}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 11,
                          padding: '10px 13px',
                          borderRadius: 10,
                          border: `1px solid ${c.border}`,
                          background: c.surface,
                        }}
                      >
                        <Icons.fileText size={17} color={c.accent} />
                        <span style={{ flex: 1, fontSize: 13.5, fontWeight: 550, color: c.text }}>
                          {f}
                        </span>
                        <button
                          onClick={() => removeFile(i)}
                          style={{
                            background: 'none',
                            border: 'none',
                            cursor: 'pointer',
                            padding: 2,
                            display: 'flex',
                          }}
                        >
                          <Icons.x size={14} color={c.textTertiary} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* ── REVIEW · shared convergence (editable) ────────── */}
        {step === 'review' && (
          <div style={{ padding: '24px' }}>
            {path === 'ai' && (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '10px 14px',
                  borderRadius: 11,
                  background: c.accentLight,
                  border: `1px solid ${c.accentBorder}`,
                  marginBottom: 18,
                }}
              >
                <Icons.sparkles size={15} color={c.accent} />
                <span style={{ flex: 1, fontSize: 13, fontWeight: 600, color: c.accent }}>
                  AI-drafted from your documents — edit anything below
                </span>
                <button
                  onClick={generate}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 5,
                    background: 'white',
                    border: `1px solid ${c.accentBorder}`,
                    borderRadius: 8,
                    padding: '5px 10px',
                    cursor: 'pointer',
                    fontSize: 12.5,
                    fontWeight: 600,
                    color: c.accent,
                  }}
                >
                  <Icons.refresh size={12} color={c.accent} /> Regenerate
                </button>
              </div>
            )}

            <FieldLabel>Project title</FieldLabel>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Give your project a title"
              style={inputStyle}
            />

            <FieldLabel style={{ marginTop: 18 }}>Brief</FieldLabel>
            <textarea
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
              rows={6}
              placeholder="What you need from the expert"
              style={{ ...inputStyle, resize: 'vertical' }}
            />

            <FieldLabel optional style={{ marginTop: 20 }}>
              Focus area
            </FieldLabel>
            <ChipRow options={PROJECT_AREAS} value={area} onChange={setArea} />

            <div
              style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, marginTop: 20 }}
            >
              <div>
                <FieldLabel optional>Budget</FieldLabel>
                <ChipRow options={BUDGETS} value={budget} onChange={setBudget} />
              </div>
              <div>
                <FieldLabel optional>Timeline</FieldLabel>
                <ChipRow options={TIMELINES} value={timeline} onChange={setTimeline} />
              </div>
            </div>

            {path === 'ai' && files.length > 0 && (
              <div style={{ marginTop: 20 }}>
                <FieldLabel>Attached</FieldLabel>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {files.map((f, i) => (
                    <span
                      key={i}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 6,
                        padding: '6px 11px',
                        borderRadius: 8,
                        background: c.surfaceSubtle,
                        border: `1px solid ${c.borderSubtle}`,
                        fontSize: 12.5,
                        color: c.textSecondary,
                      }}
                    >
                      <Icons.fileText size={13} color={c.textTertiary} /> {f}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── DONE ──────────────────────────────────────────── */}
        {step === 'done' && (
          <div style={{ padding: '52px 32px', textAlign: 'center' }}>
            <div
              style={{
                width: 68,
                height: 68,
                borderRadius: '50%',
                margin: '0 auto 18px',
                background: c.gradient,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                boxShadow: `0 8px 28px ${c.primaryGlow}`,
                animation: 'scaleIn 0.3s ease-out',
              }}
            >
              <Icons.check size={30} color="white" />
            </div>
            <h3 style={{ fontSize: 22, fontWeight: 700, color: c.text, margin: 0 }}>
              Request sent to {EXPERT.name.split(' ')[0]}
            </h3>
            <p
              style={{
                fontSize: 15,
                color: c.textSecondary,
                margin: '10px auto 0',
                maxWidth: 340,
                lineHeight: 1.6,
              }}
            >
              {EXPERT.name.split(' ')[0]} will review your brief and reply with a scoped proposal,
              usually within a day. We'll email you and notify you in-app.
            </p>
            <button
              onClick={onClose}
              style={{
                marginTop: 24,
                padding: '12px 28px',
                borderRadius: 11,
                border: 'none',
                cursor: 'pointer',
                fontSize: 14,
                fontWeight: 650,
                color: 'white',
                background: c.gradient,
              }}
            >
              Done
            </button>
          </div>
        )}
      </div>

      {/* Footers */}
      {step === 'manual' && (
        <div
          style={{
            padding: '16px 24px',
            borderTop: `1px solid ${c.borderSubtle}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 16,
            flexShrink: 0,
          }}
        >
          <button
            onClick={() => setStep('start')}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '11px 16px',
              borderRadius: 11,
              border: `1px solid ${c.border}`,
              background: c.surface,
              cursor: 'pointer',
              fontSize: 14,
              fontWeight: 600,
              color: c.textSecondary,
            }}
          >
            <Icons.chevLeft size={15} color={c.textSecondary} /> Back
          </button>
          <button
            disabled={!reviewValid}
            onClick={() => setStep('review')}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '11px 24px',
              borderRadius: 11,
              border: 'none',
              cursor: reviewValid ? 'pointer' : 'default',
              fontSize: 14,
              fontWeight: 650,
              color: 'white',
              background: reviewValid ? c.gradient : '#CBD5E1',
              boxShadow: reviewValid ? `0 2px 10px ${c.primaryGlow}` : 'none',
              transition: 'all 0.2s',
            }}
          >
            Review <Icons.arrowRight size={15} color="white" />
          </button>
        </div>
      )}
      {step === 'ai' && !generating && (
        <div
          style={{
            padding: '16px 24px',
            borderTop: `1px solid ${c.borderSubtle}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 16,
            flexShrink: 0,
          }}
        >
          <button
            onClick={() => setStep('start')}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '11px 16px',
              borderRadius: 11,
              border: `1px solid ${c.border}`,
              background: c.surface,
              cursor: 'pointer',
              fontSize: 14,
              fontWeight: 600,
              color: c.textSecondary,
            }}
          >
            <Icons.chevLeft size={15} color={c.textSecondary} /> Back
          </button>
          <button
            disabled={!files.length}
            onClick={generate}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '11px 24px',
              borderRadius: 11,
              border: 'none',
              cursor: files.length ? 'pointer' : 'default',
              fontSize: 14,
              fontWeight: 650,
              color: 'white',
              background: files.length ? c.gradient : '#CBD5E1',
              boxShadow: files.length ? `0 2px 10px ${c.primaryGlow}` : 'none',
              transition: 'all 0.2s',
            }}
          >
            <Icons.sparkles size={15} color="white" /> Generate brief
          </button>
        </div>
      )}
      {step === 'review' && (
        <div
          style={{
            padding: '16px 24px',
            borderTop: `1px solid ${c.borderSubtle}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 16,
            flexShrink: 0,
          }}
        >
          <button
            onClick={() => setStep(path)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '11px 16px',
              borderRadius: 11,
              border: `1px solid ${c.border}`,
              background: c.surface,
              cursor: 'pointer',
              fontSize: 14,
              fontWeight: 600,
              color: c.textSecondary,
            }}
          >
            <Icons.chevLeft size={15} color={c.textSecondary} /> Back
          </button>
          <button
            disabled={!reviewValid}
            onClick={() => setStep('done')}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '11px 24px',
              borderRadius: 11,
              border: 'none',
              cursor: reviewValid ? 'pointer' : 'default',
              fontSize: 14,
              fontWeight: 650,
              color: 'white',
              background: reviewValid ? c.gradient : '#CBD5E1',
              boxShadow: reviewValid ? `0 2px 10px ${c.primaryGlow}` : 'none',
              transition: 'all 0.2s',
            }}
          >
            <Icons.briefcase size={15} color="white" /> Submit request
          </button>
        </div>
      )}
    </Drawer>
  );
}

function BookingCard() {
  const isMobile = useIsMobile();
  const [pHover, setPHover] = useState(false);
  const [sHover, setSHover] = useState(false);
  const [flowOpen, setFlowOpen] = useState(false);
  const [flowStart, setFlowStart] = useState('calendar');
  const [preset, setPreset] = useState(null);
  const [projectOpen, setProjectOpen] = useState(false);
  const openReview = (qs) => {
    setPreset({ date: qs.date, time: qs.time });
    setFlowStart('details');
    setFlowOpen(true);
  };
  const openCalendar = () => {
    setPreset(null);
    setFlowStart('calendar');
    setFlowOpen(true);
  };
  return (
    <>
      <div
        style={{
          position: isMobile ? 'relative' : 'sticky',
          top: isMobile ? 'auto' : 80,
          zIndex: 30,
          order: isMobile ? -1 : 0,
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
          ...slideUp(0.1),
        }}
      >
        <Card
          style={{
            padding: 0,
            overflow: 'hidden',
            marginTop: isMobile ? 0 : -72,
            boxShadow: '0 12px 40px rgba(27,26,68,0.18)',
          }}
        >
          {/* Rate header */}
          <div
            style={{
              padding: '22px 24px 20px',
              background: c.gradientSubtle,
              borderBottom: `1px solid ${c.borderSubtle}`,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
              <span
                style={{ fontSize: 32, fontWeight: 700, color: c.text, letterSpacing: '-0.02em' }}
              >
                A${EXPERT.rate.toFixed(2)}
              </span>
              <span style={{ fontSize: 15, fontWeight: 600, color: c.textTertiary }}>/ min</span>
            </div>
            <p style={{ fontSize: 13, color: c.textSecondary, margin: '6px 0 0' }}>
              Pay only for the minutes you use · incl. service fee
            </p>
          </div>

          <div style={{ padding: '20px 24px 24px' }}>
            {/* Availability */}
            <div style={{ marginBottom: 18 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 10 }}>
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    background: c.success,
                    animation: 'pulseDot 2s infinite',
                  }}
                />
                <span style={{ fontSize: 13, fontWeight: 600, color: c.text }}>Next available</span>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {QUICK_SLOTS.map((qs) => (
                  <button
                    key={qs.id}
                    onClick={() => openReview(qs)}
                    style={{
                      padding: '8px 12px',
                      borderRadius: 9,
                      cursor: 'pointer',
                      fontSize: 12.5,
                      fontWeight: 600,
                      transition: 'all 0.15s',
                      border: `1px solid ${c.border}`,
                      background: c.surface,
                      color: c.textSecondary,
                    }}
                  >
                    {qs.dayLabel} · {qs.time}
                  </button>
                ))}
              </div>
              <button
                onClick={openCalendar}
                style={{
                  width: '100%',
                  marginTop: 10,
                  padding: '9px',
                  borderRadius: 9,
                  cursor: 'pointer',
                  border: `1px dashed ${c.primaryBorder}`,
                  background: c.primaryLight,
                  color: c.primary,
                  fontSize: 12.5,
                  fontWeight: 650,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 7,
                }}
              >
                <Icons.calendar size={14} color={c.primary} /> See all available times
              </button>
            </div>

            {/* Primary CTA */}
            <button
              onClick={openCalendar}
              onMouseEnter={() => setPHover(true)}
              onMouseLeave={() => setPHover(false)}
              style={{
                width: '100%',
                padding: '13px',
                borderRadius: 11,
                border: 'none',
                cursor: 'pointer',
                background: c.gradient,
                color: 'white',
                fontSize: 15,
                fontWeight: 650,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
                boxShadow: pHover ? `0 8px 24px ${c.primaryGlow}` : `0 2px 10px ${c.primaryGlow}`,
                transform: pHover ? 'translateY(-1px)' : 'none',
                transition: 'all 0.2s',
              }}
            >
              <Icons.video size={17} color="white" /> Book a consultation
            </button>

            {/* Divider */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '16px 0' }}>
              <div style={{ flex: 1, height: 1, background: c.borderSubtle }} />
              <span style={{ fontSize: 12, color: c.textTertiary, fontWeight: 500 }}>or</span>
              <div style={{ flex: 1, height: 1, background: c.borderSubtle }} />
            </div>

            {/* Secondary CTA — project (80% of revenue) */}
            <button
              onClick={() => setProjectOpen(true)}
              onMouseEnter={() => setSHover(true)}
              onMouseLeave={() => setSHover(false)}
              style={{
                width: '100%',
                padding: '13px 14px',
                borderRadius: 11,
                cursor: 'pointer',
                textAlign: 'left',
                border: `1px solid ${sHover ? c.accentBorder : c.border}`,
                background: sHover ? c.accentLight : c.surface,
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                transition: 'all 0.2s',
              }}
            >
              <div
                style={{
                  width: 38,
                  height: 38,
                  borderRadius: 10,
                  background: `${c.accent}12`,
                  border: `1px solid ${c.accent}22`,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                }}
              >
                <Icons.briefcase size={18} color={c.accent} />
              </div>
              <div style={{ flex: 1 }}>
                <p style={{ fontSize: 14, fontWeight: 650, color: c.text, margin: 0 }}>
                  Start a project
                </p>
                <p style={{ fontSize: 12, color: c.textTertiary, margin: '1px 0 0' }}>
                  Get a scoped proposal for larger work
                </p>
              </div>
              <Icons.chevRight size={16} color={sHover ? c.accent : c.textTertiary} />
            </button>

            {/* Message link */}
            <button
              style={{
                width: '100%',
                marginTop: 12,
                padding: '10px',
                borderRadius: 10,
                border: 'none',
                background: 'transparent',
                color: c.textSecondary,
                fontSize: 13,
                fontWeight: 600,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 7,
              }}
            >
              <Icons.messageCircle size={15} color={c.textSecondary} /> Send a message first
            </button>
          </div>
        </Card>

        {/* Trust card */}
        <Card style={{ padding: '16px 20px' }}>
          {[
            {
              icon: Icons.shieldCheck,
              color: c.success,
              text: 'Identity & certifications verified by Balo',
            },
            { icon: Icons.zap, color: c.warning, text: 'Replies within ~2 hours, on average' },
            { icon: Icons.heart, color: c.pink, text: 'Money-back if your session falls short' },
          ].map((t, i) => {
            const TIcon = t.icon;
            return (
              <div
                key={i}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 11,
                  padding: i === 0 ? '0 0 11px' : '11px 0',
                  borderBottom: i < 2 ? `1px solid ${c.borderSubtle}` : 'none',
                }}
              >
                <TIcon size={15} color={t.color} />
                <span style={{ fontSize: 13, color: c.textSecondary }}>{t.text}</span>
              </div>
            );
          })}
        </Card>
      </div>
      {flowOpen && (
        <BookingDrawer onClose={() => setFlowOpen(false)} startStep={flowStart} preset={preset} />
      )}
      {projectOpen && <ProjectDrawer onClose={() => setProjectOpen(false)} />}
    </>
  );
}

// ══════════════════════════════════════════════════════════════════
// MAIN PAGE
// ══════════════════════════════════════════════════════════════════

export default function ExpertDetailPage() {
  const [activeNav, setActiveNav] = useState('about');
  const isMobile = useIsMobile();
  const refs = {
    about: useRef(null),
    expertise: useRef(null),
    packages: useRef(null),
    work: useRef(null),
    reviews: useRef(null),
  };

  const jump = (key) => {
    setActiveNav(key);
    refs[key]?.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

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

      <Hero />
      <StickyNav active={activeNav} onJump={jump} />

      <div
        style={{
          maxWidth: 1120,
          margin: '0 auto',
          padding: isMobile ? '0 20px 48px' : '0 32px 64px',
        }}
      >
        <div
          style={
            isMobile
              ? { display: 'flex', flexDirection: 'column', gap: 16, paddingTop: 20 }
              : {
                  display: 'grid',
                  gridTemplateColumns: 'minmax(0,1fr) 360px',
                  gap: 28,
                  alignItems: 'start',
                }
          }
        >
          {/* LEFT */}
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 16,
              paddingTop: isMobile ? 0 : 28,
            }}
          >
            <div ref={refs.about} style={{ scrollMarginTop: 72 }}>
              <AboutSection />
            </div>
            <div ref={refs.expertise} style={{ scrollMarginTop: 72 }}>
              <ExpertiseSection />
            </div>
            <div ref={refs.packages} style={{ scrollMarginTop: 72 }}>
              <PackagesSection />
            </div>
            <div ref={refs.work} style={{ scrollMarginTop: 72 }}>
              <WorkSection />
            </div>
            <div ref={refs.reviews} style={{ scrollMarginTop: 72 }}>
              <ReviewsSection />
            </div>
          </div>

          {/* RIGHT */}
          <BookingCard />
        </div>
      </div>
    </div>
  );
}
