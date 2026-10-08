import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/*
 * BAL-593 — DESIGN REFERENCE: Balo staff edit an expert application on
 * /admin/applications/[profileId], during the interview and after approval.
 *
 * Extends the shipped BAL-549 page: application-sections.tsx (section order, read styling),
 * decision-controls.tsx (Approve / Decline) and the applicant's assessment-card.tsx (the rating
 * row). Hex values stand in for the page's semantic tokens (bg-card, border-border,
 * text-muted-foreground, solid --primary). Font: Geist.
 *
 * WHAT THIS PINS
 *  1. Edit mode is page-wide: one "Edit application" entry, one sticky save bar, one atomic
 *     "Save changes". Approve and Decline are hidden while editing.
 *  2. The rating row is AssessmentCard's row (icon + name, slider, value, level) plus the expert's
 *     self-rating: a marker on the track and a "Self n" column. The hatched span between the
 *     marker and the thumb is the difference.
 *  3. Read mode shows "Self 8 → 5" only where Balo's rating differs. A product staff added carries
 *     an "Added by Balo" badge and no self-rating.
 *  4. Removals are reversible until save (struck through, with Undo). Removing a product says what
 *     happens to its ratings.
 *  5. Every field changed in this edit gets a blue dot; the save bar counts the changes and lists
 *     them on demand.
 *  6. Approved: the save bar says that saving updates the live profile and search straight away.
 *  7. Declined: no edit affordance.
 *  8. Cancel with changes asks first; the destructive choice is the ghost red button.
 *  9. Work history and LinkedIn stay read-only (not in Decision 1).
 *
 * RULINGS (2026-10-08) THIS REFLECTS
 *  - Decision 4: approval locks certifications, ratings and products for the expert. On a live
 *    application those three sections carry "Locked for the expert" in read mode.
 *  - Decision 5: approved experts are reached from Lookup's drill-in, including those with no
 *    decision record (pre-BAL-549 approvals and Bubble imports): the "Approved, no record" state.
 *  - Decision 6: saving a live application emails the expert, and the save bar says so first.
 * Not shown here: the expert-side lock in settings, the Lookup link, the email itself.
 *
 * Copy is pending MJ. LEVELS stands in for proficiencyToLevel(). The dashed strip at the top
 * ("Design reference controls") is prototype-only and does not ship.
 */

// ── Tokens ───────────────────────────────────────────────────────

const t = {
  bg: '#F8FAFB',
  card: '#FFFFFF',
  muted: '#F1F4F8',
  border: '#E0E4EB',
  borderSoft: '#EAEFF5',
  fg: '#111827',
  fgMuted: '#5B6472',
  fgFaint: '#9CA3AF',
  primary: '#2563EB',
  primaryHover: '#1D4ED8',
  primarySoft: 'rgba(37,99,235,0.10)',
  success: '#059669',
  successSoft: 'rgba(5,150,105,0.08)',
  successLine: 'rgba(5,150,105,0.25)',
  warning: '#B45309',
  warningSoft: 'rgba(217,119,6,0.12)',
  warningLine: 'rgba(217,119,6,0.30)',
  gapLine: 'rgba(217,119,6,0.55)',
  gapFill: 'rgba(217,119,6,0.35)',
  destructive: '#DC2626',
  destructiveSoft: 'rgba(220,38,38,0.07)',
  destructiveLine: 'rgba(220,38,38,0.22)',
  shadow: '0 10px 30px rgba(17,24,39,0.12), 0 1px 3px rgba(17,24,39,0.08)',
  font: "'Geist', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif",
  mono: "'Geist Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
};

const card = { background: t.card, border: `1px solid ${t.border}`, borderRadius: 12 };
const emptyText = { margin: 0, fontSize: 12.5, color: t.fgMuted };
const catLabel = {
  margin: '0 0 8px',
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: t.fgMuted,
};

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@500;600&display=swap');
.bal-root *, .bal-root *::before, .bal-root *::after { box-sizing: border-box; }
.bal-root button, .bal-root input, .bal-root select { font-family: inherit; }
.bal-focus:focus-visible { outline: none; box-shadow: 0 0 0 3px rgba(37,99,235,0.35) !important; }
.bal-btn { transition: background-color .15s ease, border-color .15s ease, color .15s ease; }
.bal-btn:disabled { opacity: .5; cursor: not-allowed !important; }
.bal-btn-primary:hover:not(:disabled) { background: ${t.primaryHover} !important; border-color: ${t.primaryHover} !important; }
.bal-btn-outline:hover:not(:disabled), .bal-btn-ghost:hover:not(:disabled) { background: ${t.muted} !important; }
.bal-btn-danger:hover:not(:disabled) { background: ${t.destructiveSoft} !important; }
.bal-btn-dashed:hover:not(:disabled) { border-color: ${t.primary} !important; color: ${t.primary} !important; }
.bal-chip-x:hover:not(:disabled) { background: rgba(17,24,39,0.08) !important; }
.bal-input { height: 32px; padding: 0 10px; border: 1px solid ${t.border}; border-radius: 8px; background: ${t.card}; color: ${t.fg}; font-size: 14px; }
.bal-input:disabled { opacity: .6; }
.bal-option { display: flex; width: 100%; text-align: left; padding: 7px 10px; border: 0; border-radius: 6px; background: transparent; color: ${t.fg}; font-size: 13.5px; cursor: pointer; }
.bal-option:hover, .bal-option:focus-visible { background: ${t.muted}; outline: none; }
.bal-divide > * + * { border-top: 1px solid ${t.borderSoft}; }
.bal-grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 32px; }
.bal-rating-row { display: grid; grid-template-columns: 132px minmax(120px, 1fr) 22px 104px 52px 28px; align-items: center; gap: 12px; padding: 6px 0; }
.bal-range { -webkit-appearance: none; appearance: none; position: absolute; inset: 0; width: 100%; height: 28px; margin: 0; background: transparent; cursor: pointer; z-index: 2; }
.bal-range:disabled { cursor: not-allowed; }
.bal-range:focus { outline: none; }
.bal-range::-webkit-slider-runnable-track { height: 28px; background: transparent; }
.bal-range::-moz-range-track { height: 28px; background: transparent; }
.bal-range::-webkit-slider-thumb { -webkit-appearance: none; width: 16px; height: 16px; margin-top: 6px; border-radius: 50%; background: #fff; border: 2px solid ${t.primary}; box-shadow: 0 1px 3px rgba(17,24,39,0.25); }
.bal-range::-moz-range-thumb { width: 12px; height: 12px; border-radius: 50%; background: #fff; border: 2px solid ${t.primary}; box-shadow: 0 1px 3px rgba(17,24,39,0.25); }
.bal-range:focus-visible::-webkit-slider-thumb { box-shadow: 0 0 0 4px rgba(37,99,235,0.3); }
.bal-range:focus-visible::-moz-range-thumb { box-shadow: 0 0 0 4px rgba(37,99,235,0.3); }
@keyframes bal-spin { to { transform: rotate(360deg); } }
@keyframes bal-rise { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
@media (max-width: 640px) {
  .bal-grid-2 { grid-template-columns: 1fr; }
  .bal-rating-row { grid-template-columns: 1fr auto auto 28px; row-gap: 2px; }
  .bal-rating-row .bal-track-cell { grid-column: 1 / -1; grid-row: 2; }
  .bal-hide-sm { display: none !important; }
}
@media (prefers-reduced-motion: reduce) {
  .bal-root *, .bal-root *::before, .bal-root *::after { animation: none !important; transition: none !important; }
}
`;

// ── Icons (lucide paths) ─────────────────────────────────────────

const ICON_PATHS = {
  arrowLeft: (
    <>
      <path d="m12 19-7-7 7-7" />
      <path d="M19 12H5" />
    </>
  ),
  pencil: (
    <>
      <path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" />
      <path d="m15 5 4 4" />
    </>
  ),
  check: <path d="M20 6 9 17l-5-5" />,
  x: (
    <>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </>
  ),
  plus: (
    <>
      <path d="M5 12h14" />
      <path d="M12 5v14" />
    </>
  ),
  undo: (
    <>
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
    </>
  ),
  trash: (
    <>
      <path d="M3 6h18" />
      <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
      <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
    </>
  ),
  award: (
    <>
      <circle cx="12" cy="8" r="6" />
      <path d="M15.477 12.89 17 22l-5-3-5 3 1.523-9.11" />
    </>
  ),
  briefcase: (
    <>
      <path d="M16 20V4a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16" />
      <rect width="20" height="14" x="2" y="6" rx="2" />
    </>
  ),
  building: (
    <>
      <path d="M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18Z" />
      <path d="M6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2" />
      <path d="M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2" />
      <path d="M10 6h4" />
      <path d="M10 10h4" />
      <path d="M10 14h4" />
      <path d="M10 18h4" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" />
      <path d="M2 12h20" />
    </>
  ),
  sparkles: (
    <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" />
  ),
  gauge: (
    <>
      <path d="m12 14 4-4" />
      <path d="M3.34 19a10 10 0 1 1 17.32 0" />
    </>
  ),
  wrench: (
    <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
  ),
  compass: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="m16.24 7.76-1.804 5.411a2 2 0 0 1-1.265 1.265L7.76 16.24l1.804-5.411a2 2 0 0 1 1.265-1.265z" />
    </>
  ),
  gradCap: (
    <>
      <path d="M21.42 10.922a1 1 0 0 0-.019-1.838L12.83 5.18a2 2 0 0 0-1.66 0L2.6 9.08a1 1 0 0 0 0 1.832l8.57 3.908a2 2 0 0 0 1.66 0z" />
      <path d="M22 10v6" />
      <path d="M6 12.5V16a6 3 0 0 0 12 0v-3.5" />
    </>
  ),
  externalLink: (
    <>
      <path d="M15 3h6v6" />
      <path d="M10 14 21 3" />
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    </>
  ),
  loader: <path d="M21 12a9 9 0 1 1-6.219-8.56" />,
  search: (
    <>
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </>
  ),
  chevronDown: <path d="m6 9 6 6 6-6" />,
  lock: (
    <>
      <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 6v6l4 2" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 16v-4" />
      <path d="M12 8h.01" />
    </>
  ),
  alert: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 8v4" />
      <path d="M12 16h.01" />
    </>
  ),
};

function Icon({ name, size = 16, color = 'currentColor', style }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      style={{ flexShrink: 0, ...style }}
    >
      {ICON_PATHS[name]}
    </svg>
  );
}

// ── Reference data (mock) ────────────────────────────────────────

const APPLICANT = {
  label: 'Priya Nair @CloudPeak',
  firstName: 'Priya',
  email: 'priya@cloudpeak.com.au',
  agency: 'CloudPeak',
  waitingDays: 6,
  decider: 'Jordan Lee',
};

const SUPPORT_TYPES = [
  { id: 'technical-fix', name: 'Technical Fix', icon: 'wrench' },
  { id: 'architecture', name: 'Architecture', icon: 'building' },
  { id: 'strategy', name: 'Strategy', icon: 'compass' },
  { id: 'training', name: 'Training', icon: 'gradCap' },
];

// Stand-in for proficiencyToLevel() — the real labels come from the repo.
const LEVELS = [
  'Not rated',
  'Very limited',
  'Basic',
  'Limited',
  'Novice',
  'Intermediate',
  'Proficient',
  'Advanced',
  'Highly experienced',
  'Expert',
  'Master',
];

const PRODUCT_CATALOGUE = [
  {
    category: 'Sales Cloud',
    products: [
      { id: 'sales-cloud', name: 'Sales Cloud' },
      { id: 'cpq', name: 'CPQ' },
      { id: 'revenue-cloud', name: 'Revenue Cloud' },
    ],
  },
  {
    category: 'Platform',
    products: [
      { id: 'platform', name: 'Salesforce Platform' },
      { id: 'security', name: 'Security' },
      { id: 'flow', name: 'Flow' },
    ],
  },
  {
    category: 'Service Cloud',
    products: [
      { id: 'service-cloud', name: 'Service Cloud' },
      { id: 'field-service', name: 'Field Service' },
    ],
  },
  {
    category: 'Data & AI',
    products: [
      { id: 'data-cloud', name: 'Data Cloud' },
      { id: 'tableau', name: 'Tableau' },
      { id: 'agentforce', name: 'Agentforce' },
    ],
  },
  { category: 'Integration', products: [{ id: 'mulesoft', name: 'MuleSoft' }] },
];

const CERT_CATALOGUE = [
  {
    category: 'Administrator',
    certs: [
      { id: 'admin', name: 'Administrator' },
      { id: 'adv-admin', name: 'Advanced Administrator' },
      { id: 'app-builder', name: 'Platform App Builder' },
    ],
  },
  {
    category: 'Developer',
    certs: [
      { id: 'pd1', name: 'Platform Developer I' },
      { id: 'pd2', name: 'Platform Developer II' },
    ],
  },
  {
    category: 'Consultant',
    certs: [
      { id: 'sales-consultant', name: 'Sales Cloud Consultant' },
      { id: 'service-consultant', name: 'Service Cloud Consultant' },
      { id: 'experience-consultant', name: 'Experience Cloud Consultant' },
    ],
  },
  {
    category: 'Architect',
    certs: [
      { id: 'data-architect', name: 'Data Architect' },
      { id: 'app-architect', name: 'Application Architect' },
      { id: 'sharing-architect', name: 'Sharing and Visibility Architect' },
    ],
  },
  { category: 'Specialist', certs: [{ id: 'cpq-specialist', name: 'CPQ Specialist' }] },
];

const LANGUAGES = [
  { id: 'en', name: 'English', flag: '🇬🇧' },
  { id: 'fr', name: 'French', flag: '🇫🇷' },
  { id: 'es', name: 'Spanish', flag: '🇪🇸' },
  { id: 'hi', name: 'Hindi', flag: '🇮🇳' },
  { id: 'zh', name: 'Mandarin', flag: '🇨🇳' },
  { id: 'de', name: 'German', flag: '🇩🇪' },
  { id: 'ja', name: 'Japanese', flag: '🇯🇵' },
  { id: 'yo', name: 'Yoruba', flag: '🇳🇬' },
];
const LANGUAGE_LEVELS = ['beginner', 'intermediate', 'advanced', 'native'];

const INDUSTRIES = [
  { id: 'technology', name: 'Technology' },
  { id: 'financial-services', name: 'Financial Services' },
  { id: 'professional-services', name: 'Professional Services' },
  { id: 'healthcare', name: 'Healthcare & Life Sciences' },
  { id: 'retail', name: 'Retail' },
  { id: 'manufacturing', name: 'Manufacturing' },
  { id: 'education', name: 'Education' },
  { id: 'public-sector', name: 'Public Sector' },
  { id: 'non-profit', name: 'Non-profit' },
  { id: 'media', name: 'Media & Communications' },
];

const DISTINCTIONS = [
  { key: 'mvp', label: 'Salesforce MVP' },
  { key: 'cta', label: 'Salesforce CTA' },
  { key: 'trainer', label: 'Certified Trainer' },
];

const PROJECT_RANGES = [
  { value: 0, label: 'None' },
  { value: 1, label: '1–9' },
  { value: 10, label: '10–25' },
  { value: 26, label: '26–50' },
  { value: 50, label: '50+' },
];

const WORK_HISTORY = [
  {
    role: 'Senior Salesforce Consultant',
    company: 'Deloitte Digital',
    period: 'Jan 2021 — Present',
    current: true,
    text: 'Leads enterprise Sales Cloud and CPQ rollouts and runs a team of eight across concurrent projects.',
  },
  {
    role: 'Salesforce Developer',
    company: 'Accenture',
    period: 'Mar 2017 — Dec 2020',
    current: false,
    text: 'Built Lightning components and Apex for financial services clients; moved a legacy Classic org to Lightning.',
  },
];

const PRODUCTS = PRODUCT_CATALOGUE.flatMap((g) =>
  g.products.map((p) => ({ ...p, category: g.category }))
);
const PRODUCT_BY_ID = Object.fromEntries(PRODUCTS.map((p) => [p.id, p]));
const CERTS = CERT_CATALOGUE.flatMap((g) => g.certs.map((c) => ({ ...c, category: g.category })));
const CERT_BY_ID = Object.fromEntries(CERTS.map((c) => [c.id, c]));
const LANGUAGE_BY_ID = Object.fromEntries(LANGUAGES.map((l) => [l.id, l]));
const INDUSTRY_BY_ID = Object.fromEntries(INDUSTRIES.map((i) => [i.id, i]));

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const rangeLabel = (v) => PROJECT_RANGES.find((r) => r.value === v)?.label ?? '—';
const clone = (x) => JSON.parse(JSON.stringify(x));

// `self` is the expert's own rating (null = a product staff added); `balo` is `proficiency`.
const r = (self, balo = self) => ({ self, balo });

function makeApplication(status) {
  const approved = status === 'approved';
  const ratings = {
    'sales-cloud': { 'technical-fix': r(9), architecture: r(8), strategy: r(9), training: r(7) },
    cpq: {
      'technical-fix': r(8),
      architecture: r(6),
      strategy: r(7),
      training: approved ? r(4, 2) : r(4),
    },
    platform: { 'technical-fix': r(7), architecture: r(9), strategy: r(6), training: r(5) },
    security: {
      'technical-fix': r(6),
      architecture: approved ? r(8, 6) : r(8),
      strategy: r(5),
      training: r(3),
    },
    'service-cloud': { 'technical-fix': r(7), architecture: r(6), strategy: r(8), training: r(6) },
  };
  const products = ['sales-cloud', 'cpq', 'platform', 'security', 'service-cloud'];
  if (approved) {
    // An approved application that staff already corrected once: one product added in the interview.
    products.push('flow');
    ratings.flow = {
      'technical-fix': r(null, 6),
      architecture: r(null, 5),
      strategy: r(null, 4),
      training: r(null, 5),
    };
  }
  return {
    experience: { yearStarted: 2015, projectCountMin: 26, projectLeadCountMin: 10 },
    distinctions: { mvp: true, cta: false, trainer: false },
    linkedin: 'priya-nair',
    trailhead: 'priya-nair',
    languages: [
      { id: 'en', proficiency: 'native' },
      { id: 'fr', proficiency: 'intermediate' },
    ],
    industries: ['technology', 'financial-services', 'professional-services', 'healthcare'],
    products,
    ratings,
    certifications: ['admin', 'pd1', 'sales-consultant', 'data-architect'],
  };
}

// What the save bar lists — and, in the real action, roughly what the audit diff records.
function diffApplication(before, after) {
  const out = [];
  const add = (section, text) => out.push({ section, text });
  const b = before.experience;
  const a = after.experience;
  if (b.yearStarted !== a.yearStarted) {
    add('Experience', `Year started ${b.yearStarted} → ${a.yearStarted || '—'}`);
  }
  if (b.projectCountMin !== a.projectCountMin) {
    add(
      'Experience',
      `Projects involved in ${rangeLabel(b.projectCountMin)} → ${rangeLabel(a.projectCountMin)}`
    );
  }
  if (b.projectLeadCountMin !== a.projectLeadCountMin) {
    add(
      'Experience',
      `Projects as lead ${rangeLabel(b.projectLeadCountMin)} → ${rangeLabel(a.projectLeadCountMin)}`
    );
  }
  DISTINCTIONS.forEach((x) => {
    if (before.distinctions[x.key] !== after.distinctions[x.key]) {
      add('Experience', `${after.distinctions[x.key] ? 'Added' : 'Removed'} ${x.label}`);
    }
  });

  const bl = Object.fromEntries(before.languages.map((l) => [l.id, l.proficiency]));
  const al = Object.fromEntries(after.languages.map((l) => [l.id, l.proficiency]));
  Object.keys(al).forEach((id) => {
    const name = LANGUAGE_BY_ID[id].name;
    if (!(id in bl)) add('Languages', `Added ${name} (${al[id]})`);
    else if (bl[id] !== al[id]) add('Languages', `${name} ${bl[id]} → ${al[id]}`);
  });
  Object.keys(bl).forEach((id) => {
    if (!(id in al)) add('Languages', `Removed ${LANGUAGE_BY_ID[id].name}`);
  });

  after.industries.forEach((id) => {
    if (!before.industries.includes(id)) add('Industries', `Added ${INDUSTRY_BY_ID[id].name}`);
  });
  before.industries.forEach((id) => {
    if (!after.industries.includes(id)) add('Industries', `Removed ${INDUSTRY_BY_ID[id].name}`);
  });

  after.products.forEach((id) => {
    if (before.products.includes(id)) return;
    const values = SUPPORT_TYPES.map((st) => `${st.name} ${after.ratings[id][st.id].balo}`);
    add('Products', `Added ${PRODUCT_BY_ID[id].name} (${values.join(', ')})`);
  });
  before.products.forEach((id) => {
    if (!after.products.includes(id)) add('Products', `Removed ${PRODUCT_BY_ID[id].name}`);
  });
  after.products.forEach((id) => {
    if (!before.products.includes(id)) return;
    SUPPORT_TYPES.forEach((st) => {
      const was = before.ratings[id][st.id].balo;
      const now = after.ratings[id][st.id].balo;
      if (was !== now) add('Ratings', `${PRODUCT_BY_ID[id].name}, ${st.name} ${was} → ${now}`);
    });
  });

  after.certifications.forEach((id) => {
    if (!before.certifications.includes(id)) add('Certifications', `Added ${CERT_BY_ID[id].name}`);
  });
  before.certifications.forEach((id) => {
    if (!after.certifications.includes(id)) {
      add('Certifications', `Removed ${CERT_BY_ID[id].name}`);
    }
  });
  return out;
}

// ── Primitives ───────────────────────────────────────────────────

const BUTTON_VARIANTS = {
  primary: { background: t.primary, color: '#FFFFFF', border: `1px solid ${t.primary}` },
  outline: { background: t.card, color: t.fg, border: `1px solid ${t.border}` },
  ghost: { background: 'transparent', color: t.fg, border: '1px solid transparent' },
  danger: { background: 'transparent', color: t.destructive, border: '1px solid transparent' },
  dashed: { background: 'transparent', color: t.fgMuted, border: `1px dashed ${t.border}` },
};

function Button({
  variant = 'primary',
  size = 'md',
  icon,
  spin = false,
  children,
  buttonRef,
  ...rest
}) {
  const small = size === 'sm';
  return (
    <button
      type="button"
      ref={buttonRef}
      className={`bal-btn bal-focus bal-btn-${variant}`}
      style={{
        ...BUTTON_VARIANTS[variant],
        height: small ? 30 : 36,
        padding: small ? '0 10px' : '0 14px',
        borderRadius: 8,
        fontSize: small ? 13 : 14,
        fontWeight: 500,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      }}
      {...rest}
    >
      {icon && (
        <Icon
          name={icon}
          size={small ? 14 : 16}
          style={spin ? { animation: 'bal-spin .8s linear infinite' } : undefined}
        />
      )}
      {children}
    </button>
  );
}

function IconButton({ icon, label, onClick }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="bal-btn bal-focus bal-btn-ghost"
      style={{
        width: 28,
        height: 28,
        padding: 0,
        border: 0,
        borderRadius: 6,
        background: 'transparent',
        color: t.fgMuted,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'pointer',
      }}
    >
      <Icon name={icon} size={14} />
    </button>
  );
}

function Pill({ children, tone = 'neutral' }) {
  const tones = {
    neutral: { background: t.muted, color: t.fgMuted },
    primary: { background: t.primarySoft, color: t.primary },
    warning: { background: t.warningSoft, color: t.warning },
  };
  return (
    <span
      style={{
        ...tones[tone],
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        height: 22,
        padding: '0 8px',
        borderRadius: 999,
        fontSize: 11.5,
        fontWeight: 600,
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </span>
  );
}

function ChangedDot() {
  return (
    <span
      role="img"
      aria-label="Changed in this edit"
      title="Changed in this edit"
      style={{
        width: 6,
        height: 6,
        borderRadius: 3,
        background: t.primary,
        display: 'inline-block',
        flexShrink: 0,
      }}
    />
  );
}

// Decision 4 — tells staff why this page is the only place these sections can change.
function LockedPill() {
  return (
    <span title="Approval locked this section. Only Balo can change it, here.">
      <Pill>
        <Icon name="lock" size={11} />
        Locked for the expert
      </Pill>
    </span>
  );
}

function SectionHeading({ icon, children, aside }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        marginBottom: 12,
        minHeight: 30,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span
          style={{
            width: 26,
            height: 26,
            borderRadius: 7,
            background: t.muted,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Icon name={icon} size={14} color={t.fgMuted} />
        </span>
        <h3
          style={{
            margin: 0,
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            color: t.fgMuted,
          }}
        >
          {children}
        </h3>
      </div>
      {aside}
    </div>
  );
}

function Field({ label, htmlFor, changed, children }) {
  const Label = htmlFor ? 'label' : 'span';
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        minHeight: 40,
        fontSize: 14,
      }}
    >
      <Label
        htmlFor={htmlFor}
        style={{ color: t.fgMuted, display: 'inline-flex', alignItems: 'center', gap: 6 }}
      >
        {changed && <ChangedDot />}
        {label}
      </Label>
      <div style={{ color: t.fg, fontWeight: 500 }}>{children}</div>
    </div>
  );
}

function Chip({ children, tone = 'neutral', isNew = false, onRemove, removeLabel }) {
  const tones = {
    neutral: { background: t.muted, color: t.fg },
    primary: { background: t.primarySoft, color: t.primary },
  };
  return (
    <span
      style={{
        ...tones[tone],
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        height: 28,
        padding: onRemove ? '0 4px 0 12px' : '0 12px',
        borderRadius: 999,
        fontSize: 12.5,
        fontWeight: 500,
        boxShadow: isNew ? `inset 0 0 0 1.5px ${t.primary}` : 'none',
      }}
    >
      {children}
      {isNew && (
        <span style={{ fontSize: 10.5, fontWeight: 700, color: t.primary, marginLeft: 2 }}>
          New
        </span>
      )}
      {onRemove && (
        <button
          type="button"
          aria-label={removeLabel}
          title={removeLabel}
          onClick={onRemove}
          className="bal-focus bal-chip-x"
          style={{
            width: 20,
            height: 20,
            padding: 0,
            border: 0,
            borderRadius: 10,
            background: 'transparent',
            color: 'inherit',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
          }}
        >
          <Icon name="x" size={12} />
        </button>
      )}
    </span>
  );
}

function RemovedChip({ children, onUndo, undoLabel }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        height: 28,
        padding: '0 4px 0 12px',
        borderRadius: 999,
        border: `1px dashed ${t.border}`,
        color: t.fgFaint,
        fontSize: 12.5,
      }}
    >
      <s>{children}</s>
      <button
        type="button"
        onClick={onUndo}
        aria-label={undoLabel}
        className="bal-focus bal-chip-x"
        style={{
          height: 22,
          padding: '0 6px',
          border: 0,
          borderRadius: 6,
          background: 'transparent',
          color: t.primary,
          fontSize: 12,
          fontWeight: 600,
          cursor: 'pointer',
        }}
      >
        Undo
      </button>
    </span>
  );
}

function RemovedRow({ label, onUndo }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '10px 12px 10px 16px',
        minHeight: 52,
        background: t.bg,
      }}
    >
      <span style={{ flex: 1, fontSize: 14, color: t.fgFaint }}>
        <s>{label}</s>
        <span style={{ marginLeft: 8, fontSize: 12.5, color: t.fgMuted }}>
          Removed when you save
        </span>
      </span>
      <Button
        variant="ghost"
        size="sm"
        icon="undo"
        onClick={onUndo}
        aria-label={`Undo removing ${label}`}
      >
        Undo
      </Button>
    </div>
  );
}

// The searchable add-picker. In the app this is TaxonomyMultiSelect (or a Command popover).
function AddPicker({ label, groups, onPick }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const inputRef = useRef(null);
  const triggerRef = useRef(null);

  useEffect(() => {
    if (open) inputRef.current?.focus();
    else setQuery('');
  }, [open]);

  const close = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  const q = query.trim().toLowerCase();
  const filtered = groups
    .map((g) => ({ ...g, items: g.items.filter((i) => i.name.toLowerCase().includes(q)) }))
    .filter((g) => g.items.length > 0);

  return (
    <span style={{ position: 'relative', display: 'inline-block' }}>
      <Button
        variant="dashed"
        size="sm"
        icon="plus"
        buttonRef={triggerRef}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((o) => !o)}
      >
        {label}
      </Button>
      {open && (
        <>
          <div onClick={close} style={{ position: 'fixed', inset: 0, zIndex: 20 }} />
          <div
            role="dialog"
            aria-label={label}
            onKeyDown={(e) => {
              if (e.key === 'Escape') close();
            }}
            style={{
              ...card,
              position: 'absolute',
              right: 0,
              top: 'calc(100% + 6px)',
              zIndex: 30,
              width: 290,
              padding: 6,
              boxShadow: t.shadow,
              animation: 'bal-rise .15s ease-out',
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '4px 8px 8px',
                borderBottom: `1px solid ${t.borderSoft}`,
                marginBottom: 4,
              }}
            >
              <Icon name="search" size={14} color={t.fgFaint} />
              <input
                ref={inputRef}
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search"
                aria-label={`Search: ${label}`}
                style={{
                  flex: 1,
                  border: 0,
                  outline: 'none',
                  fontSize: 13.5,
                  color: t.fg,
                  background: 'transparent',
                  height: 26,
                }}
              />
            </div>
            <div style={{ maxHeight: 260, overflowY: 'auto' }}>
              {filtered.length === 0 && (
                <p style={{ ...emptyText, padding: '8px 10px' }}>
                  {q ? 'No matches.' : 'Everything is already on the application.'}
                </p>
              )}
              {filtered.map((g) => (
                <div key={g.heading ?? 'all'} style={{ padding: '2px 0' }}>
                  {g.heading && (
                    <p style={{ ...catLabel, margin: '6px 10px 2px', fontSize: 10.5 }}>
                      {g.heading}
                    </p>
                  )}
                  {g.items.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      className="bal-option"
                      onClick={() => {
                        onPick(item.id);
                        close();
                      }}
                    >
                      {item.name}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </span>
  );
}

// ── The rating track: Balo's thumb, the expert's marker, the difference between them ──

function RatingTrack({ value, self, onChange, label }) {
  const at = (v) => `calc(8px + (100% - 16px) * ${v / 10})`;
  const span = (v) => `calc((100% - 16px) * ${v / 10})`;
  const hasGap = self !== null && self !== value;
  const lo = hasGap ? Math.min(self, value) : value;
  const hi = hasGap ? Math.max(self, value) : value;
  const valueText = `${value}, ${LEVELS[value]}` + (self === null ? '' : `. Self-rating ${self}`);

  return (
    <div style={{ position: 'relative', height: 28 }}>
      <div
        style={{
          position: 'absolute',
          left: 8,
          right: 8,
          top: 11,
          height: 6,
          borderRadius: 3,
          background: t.muted,
          boxShadow: `inset 0 0 0 1px ${t.borderSoft}`,
        }}
      />
      {Array.from({ length: 11 }, (_, i) => (
        <span
          key={i}
          style={{
            position: 'absolute',
            top: 21,
            left: at(i),
            width: 1,
            height: 3,
            marginLeft: -0.5,
            background: t.border,
          }}
        />
      ))}
      <div
        style={{
          position: 'absolute',
          left: 8,
          top: 11,
          height: 6,
          width: span(value),
          borderRadius: 3,
          background: t.primary,
        }}
      />
      {hasGap && (
        <div
          style={{
            position: 'absolute',
            top: 9,
            height: 10,
            left: at(lo),
            width: span(hi - lo),
            borderRadius: 3,
            border: `1px solid ${t.gapLine}`,
            background: `repeating-linear-gradient(135deg, ${t.gapFill} 0 3px, transparent 3px 6px)`,
          }}
        />
      )}
      {self !== null && (
        <div
          title={`Self-rating ${self}`}
          style={{
            position: 'absolute',
            top: 5,
            left: at(self),
            width: 2,
            height: 18,
            marginLeft: -1,
            borderRadius: 1,
            background: t.fg,
            opacity: 0.55,
            zIndex: 1,
          }}
        />
      )}
      <input
        type="range"
        className="bal-range"
        min={0}
        max={10}
        step={1}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label={label}
        aria-valuetext={valueText}
      />
    </div>
  );
}

function RatingLegend() {
  const item = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    fontSize: 12,
    color: t.fgMuted,
  };
  return (
    <div aria-hidden="true" className="bal-hide-sm" style={{ display: 'flex', gap: 14 }}>
      <span style={item}>
        <span style={{ width: 14, height: 6, borderRadius: 3, background: t.primary }} />
        Balo’s rating
      </span>
      <span style={item}>
        <span style={{ width: 2, height: 12, borderRadius: 1, background: t.fg, opacity: 0.55 }} />
        Self-rating
      </span>
      <span style={item}>
        <span
          style={{
            width: 14,
            height: 8,
            borderRadius: 2,
            border: `1px solid ${t.gapLine}`,
            background: `repeating-linear-gradient(135deg, ${t.gapFill} 0 2px, transparent 2px 4px)`,
          }}
        />
        Difference
      </span>
    </div>
  );
}

function RatingRowEdit({ productName, supportType, rating, original, onChange }) {
  const { self, balo } = rating;
  const differs = self !== null && self !== balo;
  const changed = original !== null && original !== balo;
  return (
    <div className="bal-rating-row">
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 8,
          fontSize: 13.5,
          fontWeight: 500,
        }}
      >
        <Icon name={supportType.icon} size={15} color={t.fgMuted} />
        {supportType.name}
        {changed && <ChangedDot />}
      </span>
      <div className="bal-track-cell">
        <RatingTrack
          value={balo}
          self={self}
          onChange={onChange}
          label={`Balo’s ${supportType.name} rating for ${productName}`}
        />
      </div>
      <span
        style={{
          fontFamily: t.mono,
          fontSize: 14,
          fontWeight: 600,
          textAlign: 'right',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {balo}
      </span>
      <span className="bal-hide-sm" style={{ fontSize: 12, color: t.fgMuted }}>
        {LEVELS[balo]}
      </span>
      <span
        title={
          self === null
            ? 'Added by Balo, so there’s no self-rating'
            : `The expert rated themselves ${self}`
        }
        style={{
          fontSize: 12,
          fontWeight: differs ? 600 : 500,
          color: differs ? t.warning : t.fgFaint,
          whiteSpace: 'nowrap',
        }}
      >
        {self === null ? '—' : `Self ${self}`}
      </span>
      <span>
        {changed ? (
          <IconButton
            icon="undo"
            label={`Undo change to ${supportType.name} for ${productName}`}
            onClick={() => onChange(original)}
          />
        ) : null}
      </span>
    </div>
  );
}

function RatingRowRead({ supportType, rating }) {
  const { self, balo } = rating;
  const differs = self !== null && self !== balo;
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        gap: 12,
        fontSize: 13,
        minHeight: 24,
      }}
    >
      <span style={{ color: t.fgMuted }}>{supportType.name}</span>
      <span style={{ whiteSpace: 'nowrap' }}>
        {differs && (
          <span style={{ color: t.warning, fontSize: 12, fontWeight: 500, marginRight: 6 }}>
            Self {self} →
          </span>
        )}
        <span
          style={{
            fontFamily: t.mono,
            fontVariantNumeric: 'tabular-nums',
            fontWeight: 600,
            color: t.fg,
          }}
        >
          {balo}
        </span>
      </span>
    </div>
  );
}

function ProductRatingCard({ productId, ratings, originalRatings, editing, setRating, onRemove }) {
  const name = PRODUCT_BY_ID[productId].name;
  const staffAdded = SUPPORT_TYPES.every((st) => ratings[st.id].self === null);
  const adjusted = SUPPORT_TYPES.filter((st) => {
    const x = ratings[st.id];
    return x.self !== null && x.self !== x.balo;
  }).length;
  const changedHere =
    editing &&
    (originalRatings === null ||
      SUPPORT_TYPES.some((st) => originalRatings[st.id].balo !== ratings[st.id].balo));

  return (
    <div
      style={{
        ...card,
        padding: editing ? '12px 12px 6px 16px' : 16,
        boxShadow: changedHere ? `inset 3px 0 0 ${t.primary}` : 'none',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          marginBottom: editing ? 4 : 10,
          minHeight: 28,
        }}
      >
        <p style={{ margin: 0, fontSize: 14, fontWeight: 600, flex: 1 }}>{name}</p>
        {staffAdded && <Pill tone="primary">Added by Balo</Pill>}
        {!staffAdded && adjusted > 0 && <Pill tone="warning">{adjusted} adjusted</Pill>}
        {editing && (
          <Button
            variant="ghost"
            size="sm"
            icon="trash"
            onClick={onRemove}
            aria-label={`Remove ${name}`}
          >
            Remove
          </Button>
        )}
      </div>
      {editing ? (
        <div role="group" aria-label={`${name} ratings`} className="bal-divide">
          {SUPPORT_TYPES.map((st) => (
            <RatingRowEdit
              key={st.id}
              productName={name}
              supportType={st}
              rating={ratings[st.id]}
              original={originalRatings ? originalRatings[st.id].balo : null}
              onChange={(v) => setRating(productId, st.id, v)}
            />
          ))}
        </div>
      ) : (
        <div className="bal-grid-2" style={{ gap: '6px 24px' }}>
          {SUPPORT_TYPES.map((st) => (
            <RatingRowRead key={st.id} supportType={st} rating={ratings[st.id]} />
          ))}
        </div>
      )}
    </div>
  );
}

function RemovedProductCard({ name, onUndo }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '12px 12px 12px 16px',
        borderRadius: 12,
        border: `1px dashed ${t.border}`,
        background: t.bg,
      }}
    >
      <div style={{ flex: 1 }}>
        <p style={{ margin: 0, fontSize: 14, fontWeight: 600, color: t.fgFaint }}>
          <s>{name}</s>
        </p>
        <p style={{ margin: '2px 0 0', fontSize: 12.5, color: t.fgMuted }}>
          Its ratings are deleted when you save.
        </p>
      </div>
      <Button
        variant="ghost"
        size="sm"
        icon="undo"
        onClick={onUndo}
        aria-label={`Undo removing ${name}`}
      >
        Undo
      </Button>
    </div>
  );
}

// ── Sections ─────────────────────────────────────────────────────

function RangeSelect({ id, value, onChange }) {
  return (
    <select
      id={id}
      className="bal-input bal-focus"
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
    >
      {PROJECT_RANGES.map((range) => (
        <option key={range.value} value={range.value}>
          {range.label}
        </option>
      ))}
    </select>
  );
}

function ExperienceSection({ data, original, editing, update }) {
  const exp = data.experience;
  const changed = (key) => editing && exp[key] !== original.experience[key];
  return (
    <section>
      <SectionHeading icon="briefcase">Experience</SectionHeading>
      <div className="bal-grid-2" style={{ ...card, padding: '10px 20px' }}>
        <Field
          label="Year started"
          htmlFor={editing ? 'exp-year' : undefined}
          changed={changed('yearStarted')}
        >
          {editing ? (
            <input
              id="exp-year"
              type="number"
              inputMode="numeric"
              min={1999}
              max={2026}
              className="bal-input bal-focus"
              style={{ width: 92, textAlign: 'right' }}
              value={exp.yearStarted}
              onChange={(e) => {
                const v = e.target.value;
                update((d) => {
                  d.experience.yearStarted = v === '' ? '' : Number(v);
                });
              }}
            />
          ) : (
            exp.yearStarted || '—'
          )}
        </Field>
        <Field
          label="Projects involved in"
          htmlFor={editing ? 'exp-projects' : undefined}
          changed={changed('projectCountMin')}
        >
          {editing ? (
            <RangeSelect
              id="exp-projects"
              value={exp.projectCountMin}
              onChange={(v) =>
                update((d) => {
                  d.experience.projectCountMin = v;
                })
              }
            />
          ) : (
            rangeLabel(exp.projectCountMin)
          )}
        </Field>
        <Field
          label="Projects as lead"
          htmlFor={editing ? 'exp-lead' : undefined}
          changed={changed('projectLeadCountMin')}
        >
          {editing ? (
            <RangeSelect
              id="exp-lead"
              value={exp.projectLeadCountMin}
              onChange={(v) =>
                update((d) => {
                  d.experience.projectLeadCountMin = v;
                })
              }
            />
          ) : (
            rangeLabel(exp.projectLeadCountMin)
          )}
        </Field>
        <Field label="LinkedIn">
          <a
            href={`https://linkedin.com/in/${data.linkedin}`}
            target="_blank"
            rel="noopener noreferrer"
            className="bal-focus"
            style={{ color: t.primary, textDecoration: 'none', borderRadius: 4 }}
          >
            View profile
          </a>
        </Field>
      </div>
    </section>
  );
}

function LanguagesSection({ data, original, editing, update }) {
  const ids = data.languages.map((l) => l.id);
  const removed = editing ? original.languages.filter((l) => !ids.includes(l.id)) : [];
  if (!editing && data.languages.length === 0) return null;

  const addLanguage = (id) =>
    update((d) => {
      const before = original.languages.find((l) => l.id === id);
      d.languages.push({ id, proficiency: before ? before.proficiency : 'intermediate' });
    });
  const available = [
    {
      heading: null,
      items: LANGUAGES.filter((l) => !ids.includes(l.id)).map((l) => ({
        id: l.id,
        name: `${l.flag}  ${l.name}`,
      })),
    },
  ];

  return (
    <section>
      <SectionHeading
        icon="globe"
        aside={
          editing ? (
            <AddPicker label="Add language" groups={available} onPick={addLanguage} />
          ) : null
        }
      >
        Languages
      </SectionHeading>
      <div className="bal-divide" style={{ ...card, overflow: 'hidden' }}>
        {data.languages.map((l) => {
          const lang = LANGUAGE_BY_ID[l.id];
          const before = original.languages.find((o) => o.id === l.id);
          const isNew = editing && !before;
          return (
            <div
              key={l.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                padding: '10px 12px 10px 16px',
                minHeight: 52,
              }}
            >
              <span aria-hidden="true" style={{ width: 24, fontSize: 18 }}>
                {lang.flag}
              </span>
              <span style={{ flex: 1, fontSize: 14, fontWeight: 500 }}>{lang.name}</span>
              {isNew && <Pill tone="primary">New</Pill>}
              {editing ? (
                <>
                  {before && before.proficiency !== l.proficiency && <ChangedDot />}
                  <select
                    aria-label={`${lang.name} proficiency`}
                    className="bal-input bal-focus"
                    value={l.proficiency}
                    onChange={(e) => {
                      const v = e.target.value;
                      update((d) => {
                        d.languages.find((x) => x.id === l.id).proficiency = v;
                      });
                    }}
                  >
                    {LANGUAGE_LEVELS.map((lv) => (
                      <option key={lv} value={lv}>
                        {cap(lv)}
                      </option>
                    ))}
                  </select>
                  <IconButton
                    icon="x"
                    label={`Remove ${lang.name}`}
                    onClick={() =>
                      update((d) => {
                        d.languages = d.languages.filter((x) => x.id !== l.id);
                      })
                    }
                  />
                </>
              ) : (
                <Pill>{cap(l.proficiency)}</Pill>
              )}
            </div>
          );
        })}
        {removed.map((l) => (
          <RemovedRow
            key={l.id}
            label={LANGUAGE_BY_ID[l.id].name}
            onUndo={() => addLanguage(l.id)}
          />
        ))}
      </div>
    </section>
  );
}

function IndustriesDistinctionsSection({ data, original, editing, update }) {
  const removedIndustries = editing
    ? original.industries.filter((id) => !data.industries.includes(id))
    : [];
  const available = [
    { heading: null, items: INDUSTRIES.filter((i) => !data.industries.includes(i.id)) },
  ];
  const addIndustry = (id) =>
    update((d) => {
      d.industries.push(id);
    });
  const active = DISTINCTIONS.filter((x) => data.distinctions[x.key]);

  return (
    <section className="bal-grid-2" style={{ gap: 24 }}>
      <div>
        <SectionHeading
          icon="building"
          aside={
            editing ? (
              <AddPicker label="Add industry" groups={available} onPick={addIndustry} />
            ) : null
          }
        >
          Industries
        </SectionHeading>
        {data.industries.length === 0 && removedIndustries.length === 0 ? (
          <p style={emptyText}>None selected</p>
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {data.industries.map((id) => (
              <Chip
                key={id}
                isNew={editing && !original.industries.includes(id)}
                removeLabel={`Remove ${INDUSTRY_BY_ID[id].name}`}
                onRemove={
                  editing
                    ? () =>
                        update((d) => {
                          d.industries = d.industries.filter((x) => x !== id);
                        })
                    : undefined
                }
              >
                {INDUSTRY_BY_ID[id].name}
              </Chip>
            ))}
            {removedIndustries.map((id) => (
              <RemovedChip
                key={id}
                onUndo={() => addIndustry(id)}
                undoLabel={`Undo removing ${INDUSTRY_BY_ID[id].name}`}
              >
                {INDUSTRY_BY_ID[id].name}
              </RemovedChip>
            ))}
          </div>
        )}
      </div>

      <div>
        <SectionHeading icon="award">Distinctions</SectionHeading>
        {editing ? (
          <div
            role="group"
            aria-label="Distinctions"
            style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}
          >
            {DISTINCTIONS.map((x) => {
              const on = data.distinctions[x.key];
              const changed = on !== original.distinctions[x.key];
              return (
                <button
                  key={x.key}
                  type="button"
                  aria-pressed={on}
                  onClick={() =>
                    update((d) => {
                      d.distinctions[x.key] = !on;
                    })
                  }
                  className="bal-btn bal-focus"
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    height: 32,
                    padding: '0 12px',
                    borderRadius: 8,
                    fontSize: 12.5,
                    fontWeight: 600,
                    cursor: 'pointer',
                    background: on ? t.warningSoft : t.card,
                    color: on ? t.warning : t.fgMuted,
                    border: `1px solid ${on ? t.warningLine : t.border}`,
                  }}
                >
                  {changed && <ChangedDot />}
                  <Icon name={on ? 'check' : 'plus'} size={13} />
                  {x.label}
                </button>
              );
            })}
          </div>
        ) : active.length > 0 ? (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {active.map((x) => (
              <span
                key={x.key}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  height: 30,
                  padding: '0 12px',
                  borderRadius: 8,
                  fontSize: 12.5,
                  fontWeight: 600,
                  background: t.warningSoft,
                  color: t.warning,
                }}
              >
                <Icon name="award" size={14} />
                {x.label}
              </span>
            ))}
          </div>
        ) : (
          <p style={emptyText}>None selected</p>
        )}
      </div>
    </section>
  );
}

function ProductsSection({ data, original, editing, locked, onAdd, onRemove }) {
  const visible = (id) => data.products.includes(id) || (editing && original.products.includes(id));
  const groups = PRODUCT_CATALOGUE.map((g) => ({
    category: g.category,
    items: g.products.filter((p) => visible(p.id)),
  })).filter((g) => g.items.length > 0);
  const available = PRODUCT_CATALOGUE.map((g) => ({
    heading: g.category,
    items: g.products.filter((p) => !data.products.includes(p.id)),
  })).filter((g) => g.items.length > 0);
  const removedCount = editing
    ? original.products.filter((id) => !data.products.includes(id)).length
    : 0;

  return (
    <section>
      <SectionHeading
        icon="sparkles"
        aside={
          editing ? (
            <AddPicker label="Add product" groups={available} onPick={onAdd} />
          ) : (
            <span
              style={{
                display: 'inline-flex',
                gap: 6,
                flexWrap: 'wrap',
                justifyContent: 'flex-end',
              }}
            >
              {locked && <LockedPill />}
              <Pill tone="primary">{data.products.length} products</Pill>
            </span>
          )
        }
      >
        Product expertise
      </SectionHeading>
      <div style={{ ...card, padding: 20 }}>
        {groups.length === 0 && <p style={emptyText}>No products</p>}
        {groups.map((g, i) => (
          <div key={g.category} style={{ marginTop: i === 0 ? 0 : 16 }}>
            <p style={catLabel}>{g.category}</p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {g.items.map((p) =>
                data.products.includes(p.id) ? (
                  <Chip
                    key={p.id}
                    tone="primary"
                    isNew={editing && !original.products.includes(p.id)}
                    removeLabel={`Remove ${p.name}`}
                    onRemove={editing ? () => onRemove(p.id) : undefined}
                  >
                    {p.name}
                  </Chip>
                ) : (
                  <RemovedChip
                    key={p.id}
                    onUndo={() => onAdd(p.id)}
                    undoLabel={`Undo removing ${p.name}`}
                  >
                    {p.name}
                  </RemovedChip>
                )
              )}
            </div>
          </div>
        ))}
        {removedCount > 0 && (
          <p
            style={{
              display: 'flex',
              gap: 8,
              alignItems: 'flex-start',
              margin: '16px 0 0',
              paddingTop: 12,
              borderTop: `1px solid ${t.borderSoft}`,
              fontSize: 12.5,
              color: t.fgMuted,
              lineHeight: 1.5,
            }}
          >
            <Icon name="info" size={14} style={{ marginTop: 2 }} />
            Removing a product deletes its ratings when you save. The expert’s self-ratings stay in
            the audit record.
          </p>
        )}
      </div>
    </section>
  );
}

function RatingsSection({ data, original, editing, locked, setRating, onAdd, onRemove }) {
  const ids = PRODUCTS.map((p) => p.id).filter(
    (id) => data.products.includes(id) || (editing && original.products.includes(id))
  );
  if (ids.length === 0) return null;
  const anyAdjusted = data.products.some((id) =>
    SUPPORT_TYPES.some((st) => {
      const x = data.ratings[id][st.id];
      return x.self !== null && x.self !== x.balo;
    })
  );

  return (
    <section>
      <SectionHeading
        icon="gauge"
        aside={editing ? <RatingLegend /> : locked ? <LockedPill /> : null}
      >
        Ratings (0–10)
      </SectionHeading>
      {!editing && anyAdjusted && (
        <p style={{ margin: '-4px 0 12px', fontSize: 12.5, color: t.fgMuted, lineHeight: 1.5 }}>
          “Self 8 → 5” means the expert rated themselves 8 and Balo set 5. Search and the public
          profile use Balo’s rating.
        </p>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {ids.map((id) =>
          data.products.includes(id) ? (
            <ProductRatingCard
              key={id}
              productId={id}
              ratings={data.ratings[id]}
              originalRatings={original.products.includes(id) ? original.ratings[id] : null}
              editing={editing}
              setRating={setRating}
              onRemove={() => onRemove(id)}
            />
          ) : (
            <RemovedProductCard key={id} name={PRODUCT_BY_ID[id].name} onUndo={() => onAdd(id)} />
          )
        )}
      </div>
    </section>
  );
}

function CertificationsSection({ data, original, editing, locked, update }) {
  const shown = CERTS.filter(
    (c) => data.certifications.includes(c.id) || (editing && original.certifications.includes(c.id))
  );
  const available = CERT_CATALOGUE.map((g) => ({
    heading: g.category,
    items: g.certs.filter((c) => !data.certifications.includes(c.id)),
  })).filter((g) => g.items.length > 0);
  const add = (id) =>
    update((d) => {
      d.certifications.push(id);
    });
  const remove = (id) =>
    update((d) => {
      d.certifications = d.certifications.filter((x) => x !== id);
    });

  return (
    <section>
      <SectionHeading
        icon="award"
        aside={
          editing ? (
            <AddPicker label="Add certification" groups={available} onPick={add} />
          ) : locked ? (
            <LockedPill />
          ) : null
        }
      >
        Certifications
      </SectionHeading>
      <a
        href={`https://trailblazer.me/id/${data.trailhead}`}
        target="_blank"
        rel="noopener noreferrer"
        className="bal-focus"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          marginBottom: 12,
          fontSize: 12.5,
          fontWeight: 500,
          color: t.primary,
          textDecoration: 'none',
          borderRadius: 4,
        }}
      >
        {editing ? 'Check against Trailhead' : 'Trailhead profile'}
        <Icon name="externalLink" size={12} />
      </a>
      <div className="bal-grid-2" style={{ gap: 8 }}>
        {shown.map((c) => {
          const present = data.certifications.includes(c.id);
          const isNew = editing && present && !original.certifications.includes(c.id);
          return (
            <div
              key={c.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                minHeight: 58,
                padding: '10px 8px 10px 14px',
                borderRadius: 12,
                background: present ? t.card : t.bg,
                border: `1px ${present ? 'solid' : 'dashed'} ${t.border}`,
                boxShadow: isNew ? `inset 0 0 0 1px ${t.primary}` : 'none',
              }}
            >
              <Icon name="award" size={16} color={present ? '#D97706' : t.fgFaint} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <p
                  style={{
                    margin: 0,
                    fontSize: 13.5,
                    fontWeight: 600,
                    color: present ? t.fg : t.fgFaint,
                  }}
                >
                  {present ? c.name : <s>{c.name}</s>}
                </p>
                <p style={{ margin: '1px 0 0', fontSize: 11.5, color: t.fgMuted }}>
                  {present ? c.category : 'Removed when you save'}
                </p>
              </div>
              {isNew && <Pill tone="primary">New</Pill>}
              {editing &&
                (present ? (
                  <IconButton icon="x" label={`Remove ${c.name}`} onClick={() => remove(c.id)} />
                ) : (
                  <Button
                    variant="ghost"
                    size="sm"
                    icon="undo"
                    onClick={() => add(c.id)}
                    aria-label={`Undo removing ${c.name}`}
                  >
                    Undo
                  </Button>
                ))}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function WorkHistorySection({ editing }) {
  return (
    <section style={{ opacity: editing ? 0.7 : 1 }}>
      <SectionHeading
        icon="briefcase"
        aside={
          editing ? <span style={{ fontSize: 12, color: t.fgMuted }}>Not editable here</span> : null
        }
      >
        Work history
      </SectionHeading>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {WORK_HISTORY.map((w) => (
          <div key={w.company} style={{ ...card, padding: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
              <div>
                <p style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>{w.role}</p>
                <p style={{ margin: '2px 0 0', fontSize: 14, color: t.fgMuted }}>{w.company}</p>
              </div>
              {w.current && (
                <span
                  style={{
                    alignSelf: 'flex-start',
                    padding: '2px 10px',
                    borderRadius: 999,
                    fontSize: 11,
                    fontWeight: 600,
                    background: t.successSoft,
                    color: t.success,
                  }}
                >
                  Current
                </span>
              )}
            </div>
            <p
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                margin: '8px 0 0',
                fontSize: 12,
                color: t.fgMuted,
              }}
            >
              <Icon name="clock" size={12} />
              {w.period}
            </p>
            <p
              style={{
                margin: '12px 0 0',
                paddingTop: 12,
                borderTop: `1px solid ${t.borderSoft}`,
                fontSize: 13,
                lineHeight: 1.6,
              }}
            >
              {w.text}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}

// ── Page chrome ──────────────────────────────────────────────────

function DecisionBanner({ status }) {
  if (status === 'pending') return null;
  const approved = status === 'approved' || status === 'legacy';
  return (
    <div
      role="status"
      style={{
        display: 'flex',
        gap: 12,
        alignItems: 'flex-start',
        marginTop: 20,
        padding: '14px 16px',
        borderRadius: 12,
        background: approved ? t.successSoft : t.destructiveSoft,
        border: `1px solid ${approved ? t.successLine : t.destructiveLine}`,
      }}
    >
      <Icon
        name={approved ? 'check' : 'x'}
        color={approved ? t.success : t.destructive}
        style={{ marginTop: 2 }}
      />
      <div>
        <p style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>
          {status === 'legacy'
            ? 'Approved, no decision record'
            : approved
              ? `Approved by ${APPLICANT.decider} on 3 Oct 2026`
              : `Declined by ${APPLICANT.decider} on 2 Oct 2026`}
        </p>
        {status === 'legacy' && (
          <p style={{ margin: '2px 0 0', fontSize: 13, color: t.fgMuted }}>
            Approved before decisions were logged, or imported from Bubble.
          </p>
        )}
        {!approved && (
          <p style={{ margin: '2px 0 0', fontSize: 13, color: t.fgMuted }}>
            Reason: Experience depth
          </p>
        )}
      </div>
    </div>
  );
}

function SaveBar({ changes, saving, live, open, onToggle, onCancel, onSave }) {
  const n = changes.length;
  return (
    <div style={{ position: 'sticky', bottom: 16, zIndex: 15, marginTop: 28 }}>
      {open && n > 0 && (
        <div
          id="bal-changes"
          style={{
            ...card,
            boxShadow: t.shadow,
            padding: '12px 16px',
            marginBottom: 8,
            maxHeight: 240,
            overflowY: 'auto',
            animation: 'bal-rise .15s ease-out',
          }}
        >
          <p style={{ ...catLabel, marginBottom: 6 }}>Changes in this edit</p>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {changes.map((c, i) => (
              <li
                key={`${c.section}-${i}`}
                style={{
                  display: 'flex',
                  gap: 12,
                  padding: '4px 0',
                  fontSize: 13,
                  lineHeight: 1.45,
                }}
              >
                <span style={{ color: t.fgMuted, minWidth: 96, flexShrink: 0 }}>{c.section}</span>
                <span>{c.text}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div
        style={{
          ...card,
          boxShadow: t.shadow,
          padding: '10px 12px 10px 16px',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          flexWrap: 'wrap',
        }}
      >
        <div style={{ flex: 1, minWidth: 220 }}>
          {n === 0 ? (
            <span style={{ fontSize: 14, color: t.fgMuted }}>No changes yet</span>
          ) : (
            <button
              type="button"
              aria-expanded={open}
              aria-controls="bal-changes"
              onClick={onToggle}
              className="bal-focus"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '4px 6px',
                margin: '0 -6px',
                border: 0,
                borderRadius: 6,
                background: 'transparent',
                color: t.fg,
                fontSize: 14,
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              {n} {n === 1 ? 'change' : 'changes'}
              <Icon
                name="chevronDown"
                size={14}
                style={{
                  transform: open ? 'rotate(180deg)' : 'none',
                  transition: 'transform .15s',
                }}
              />
            </button>
          )}
          {live && (
            <p
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 6,
                margin: '2px 0 0',
                fontSize: 12.5,
                color: t.fgMuted,
                lineHeight: 1.45,
              }}
            >
              <Icon name="info" size={13} style={{ marginTop: 2 }} />
              {APPLICANT.firstName} is live on Balo. Saving updates their public profile and search
              results straight away, and emails {APPLICANT.firstName} that Balo updated their
              expertise.
            </p>
          )}
        </div>
        <Button variant="ghost" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button
          variant="primary"
          icon={saving ? 'loader' : 'check'}
          spin={saving}
          onClick={onSave}
          disabled={n === 0 || saving}
        >
          {saving ? 'Saving…' : 'Save changes'}
        </Button>
      </div>
    </div>
  );
}

function DiscardDialog({ count, onKeep, onDiscard }) {
  const keepRef = useRef(null);
  useEffect(() => {
    keepRef.current?.focus();
    const onKey = (e) => {
      if (e.key === 'Escape') onKeep();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onKeep]);

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 50,
        padding: 16,
        background: 'rgba(17,24,39,0.4)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="bal-discard-title"
        aria-describedby="bal-discard-body"
        style={{
          ...card,
          width: '100%',
          maxWidth: 420,
          padding: 24,
          boxShadow: t.shadow,
          animation: 'bal-rise .15s ease-out',
        }}
      >
        <h2 id="bal-discard-title" style={{ margin: 0, fontSize: 17, fontWeight: 600 }}>
          Discard {count} {count === 1 ? 'change' : 'changes'}?
        </h2>
        <p
          id="bal-discard-body"
          style={{ margin: '8px 0 0', fontSize: 14, color: t.fgMuted, lineHeight: 1.5 }}
        >
          Your edits to {APPLICANT.firstName}’s application won’t be saved.
        </p>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 20 }}>
          <Button variant="danger" onClick={onDiscard}>
            Discard changes
          </Button>
          <Button variant="primary" buttonRef={keepRef} onClick={onKeep}>
            Keep editing
          </Button>
        </div>
      </div>
    </div>
  );
}

function Toast({ toast, raised }) {
  if (!toast) return null;
  const icon = { success: 'check', error: 'alert', info: 'info' }[toast.kind];
  const color = { success: t.success, error: t.destructive, info: t.primary }[toast.kind];
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        ...card,
        position: 'fixed',
        right: 20,
        bottom: raised ? 100 : 20,
        zIndex: 60,
        maxWidth: 360,
        padding: '12px 14px',
        display: 'flex',
        gap: 10,
        alignItems: 'flex-start',
        boxShadow: t.shadow,
        animation: 'bal-rise .2s ease-out',
      }}
    >
      <Icon name={icon} color={color} style={{ marginTop: 2 }} />
      <p style={{ margin: 0, fontSize: 14, lineHeight: 1.45 }}>{toast.text}</p>
    </div>
  );
}

function Segmented({ label, value, options, onChange }) {
  return (
    <div
      role="group"
      aria-label={label}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}
    >
      <span>{label}</span>
      <span style={{ display: 'inline-flex', padding: 2, borderRadius: 8, background: t.muted }}>
        {options.map(([v, text]) => (
          <button
            key={v}
            type="button"
            aria-pressed={value === v}
            onClick={() => onChange(v)}
            className="bal-focus"
            style={{
              height: 26,
              padding: '0 10px',
              border: 0,
              borderRadius: 6,
              fontSize: 12.5,
              fontWeight: 500,
              cursor: 'pointer',
              background: value === v ? t.card : 'transparent',
              color: value === v ? t.fg : t.fgMuted,
              boxShadow: value === v ? '0 1px 2px rgba(17,24,39,0.12)' : 'none',
            }}
          >
            {text}
          </button>
        ))}
      </span>
    </div>
  );
}

function PrototypeControls({ status, onStatus, outcome, onOutcome }) {
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: '8px 20px',
        marginBottom: 28,
        padding: '10px 14px',
        border: `1px dashed ${t.border}`,
        borderRadius: 12,
        background: t.card,
        fontSize: 12.5,
        color: t.fgMuted,
      }}
    >
      <span style={{ fontWeight: 600, color: t.fg }}>Design reference controls</span>
      <Segmented
        label="Application"
        value={status}
        onChange={onStatus}
        options={[
          ['pending', 'Pending'],
          ['approved', 'Approved'],
          ['legacy', 'Approved, no record'],
          ['declined', 'Declined'],
        ]}
      />
      <Segmented
        label="Save result"
        value={outcome}
        onChange={onOutcome}
        options={[
          ['success', 'Saves'],
          ['refused', 'Declined meanwhile'],
          ['error', 'Fails'],
        ]}
      />
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────

export default function ApplicationStaffEdit() {
  const [status, setStatus] = useState('pending');
  const [outcome, setOutcome] = useState('success');
  const [saved, setSaved] = useState(() => makeApplication('pending'));
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [changesOpen, setChangesOpen] = useState(false);
  const [toast, setToast] = useState(null);
  const toastTimer = useRef(null);
  const saveTimer = useRef(null);

  const editing = draft !== null;
  const live = status === 'approved' || status === 'legacy';
  const data = draft ?? saved;
  const changes = useMemo(() => (draft ? diffApplication(saved, draft) : []), [saved, draft]);

  useEffect(
    () => () => {
      clearTimeout(toastTimer.current);
      clearTimeout(saveTimer.current);
    },
    []
  );

  // The real page also guards in-app navigation (router) while changes are unsaved.
  useEffect(() => {
    if (!editing || changes.length === 0) return undefined;
    const guard = (e) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [editing, changes.length]);

  const showToast = (kind, text) => {
    clearTimeout(toastTimer.current);
    setToast({ kind, text });
    toastTimer.current = setTimeout(() => setToast(null), 4500);
  };

  const update = (fn) =>
    setDraft((d) => {
      const next = clone(d);
      fn(next);
      return next;
    });

  const setRating = (productId, supportTypeId, value) =>
    update((d) => {
      d.ratings[productId][supportTypeId].balo = value;
    });

  const addProduct = (productId) =>
    update((d) => {
      if (!d.products.includes(productId)) d.products.push(productId);
      if (!d.ratings[productId]) {
        d.ratings[productId] = saved.ratings[productId]
          ? clone(saved.ratings[productId])
          : Object.fromEntries(SUPPORT_TYPES.map((st) => [st.id, { self: null, balo: 0 }]));
      }
    });

  const removeProduct = (productId) =>
    update((d) => {
      d.products = d.products.filter((x) => x !== productId);
    });

  const changeStatus = (next) => {
    clearTimeout(saveTimer.current);
    setStatus(next);
    setSaved(makeApplication(next));
    setDraft(null);
    setSaving(false);
    setDiscardOpen(false);
    setChangesOpen(false);
  };

  const startEdit = () => {
    setDraft(clone(saved));
    setChangesOpen(false);
  };

  const cancel = () => {
    if (changes.length > 0) setDiscardOpen(true);
    else setDraft(null);
  };

  // Stable, so the dialog's focus/Escape effect runs once per open rather than on every render.
  const keepEditing = useCallback(() => setDiscardOpen(false), []);

  const discard = () => {
    setDiscardOpen(false);
    setChangesOpen(false);
    setDraft(null);
  };

  const save = () => {
    if (!editing || saving || changes.length === 0) return;
    setSaving(true);
    saveTimer.current = setTimeout(() => {
      setSaving(false);
      if (outcome === 'success') {
        const next = clone(draft);
        Object.keys(next.ratings).forEach((id) => {
          if (!next.products.includes(id)) delete next.ratings[id];
        });
        setSaved(next);
        setDraft(null);
        setChangesOpen(false);
        showToast(
          'success',
          live
            ? `Changes saved. ${APPLICANT.firstName}’s profile is updated and they’ve been emailed.`
            : 'Changes saved'
        );
      } else if (outcome === 'refused') {
        setDraft(null);
        setChangesOpen(false);
        setStatus('declined');
        showToast(
          'error',
          `${APPLICANT.firstName}’s application was declined while you were editing. Nothing was saved.`
        );
      } else {
        showToast('error', 'Couldn’t save the changes. Nothing was written, so try again.');
      }
    }, 900);
  };

  const sectionProps = { data, original: saved, editing, update };

  return (
    <div
      className="bal-root"
      style={{ minHeight: '100vh', background: t.bg, color: t.fg, fontFamily: t.font }}
    >
      <style>{CSS}</style>
      <main style={{ maxWidth: 768, margin: '0 auto', padding: '24px 20px 48px' }}>
        <PrototypeControls
          status={status}
          onStatus={changeStatus}
          outcome={outcome}
          onOutcome={setOutcome}
        />

        <a
          href="#applications"
          onClick={(e) => e.preventDefault()}
          className="bal-focus"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            minHeight: 44,
            marginLeft: -4,
            padding: '0 4px',
            borderRadius: 8,
            fontSize: 14,
            color: t.fgMuted,
            textDecoration: 'none',
          }}
        >
          <Icon name="arrowLeft" size={16} />
          Back to applications
        </a>

        <header
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: 16,
            marginTop: 8,
          }}
        >
          <div>
            <h2 style={{ margin: 0, fontSize: 24, fontWeight: 600, letterSpacing: '-0.01em' }}>
              {APPLICANT.label}
            </h2>
            <p style={{ margin: '4px 0 0', fontSize: 14, color: t.fgMuted }}>
              {APPLICANT.email} · {APPLICANT.agency}
              {status === 'pending' && ` · Waiting ${APPLICANT.waitingDays} days`}
            </p>
          </div>

          {editing ? (
            <div style={{ textAlign: 'right', maxWidth: 260 }}>
              <Pill tone="primary">
                <Icon name="pencil" size={12} />
                Editing
              </Pill>
              {status === 'pending' && (
                <p style={{ margin: '6px 0 0', fontSize: 12.5, color: t.fgMuted, lineHeight: 1.4 }}>
                  Approve and Decline come back when you save or cancel.
                </p>
              )}
            </div>
          ) : (
            status !== 'declined' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <Button variant="outline" icon="pencil" onClick={startEdit}>
                  Edit application
                </Button>
                {status === 'pending' && (
                  <>
                    <Button
                      variant="primary"
                      icon="check"
                      onClick={() =>
                        showToast('info', 'Approve opens the existing confirm dialog (BAL-549).')
                      }
                    >
                      Approve
                    </Button>
                    <Button
                      variant="ghost"
                      icon="x"
                      onClick={() =>
                        showToast('info', 'Decline opens the existing decline sheet (BAL-549).')
                      }
                    >
                      Decline
                    </Button>
                  </>
                )}
              </div>
            )
          )}
        </header>

        <DecisionBanner status={status} />

        <fieldset
          disabled={saving}
          style={{ border: 0, padding: 0, margin: '28px 0 0', minWidth: 0 }}
        >
          <legend
            style={{
              position: 'absolute',
              width: 1,
              height: 1,
              overflow: 'hidden',
              clip: 'rect(0 0 0 0)',
            }}
          >
            Application
          </legend>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
            <ExperienceSection {...sectionProps} />
            <LanguagesSection {...sectionProps} />
            <IndustriesDistinctionsSection {...sectionProps} />
            <ProductsSection
              data={data}
              original={saved}
              editing={editing}
              locked={live}
              onAdd={addProduct}
              onRemove={removeProduct}
            />
            <RatingsSection
              data={data}
              original={saved}
              editing={editing}
              locked={live}
              setRating={setRating}
              onAdd={addProduct}
              onRemove={removeProduct}
            />
            <CertificationsSection {...sectionProps} locked={live} />
            <WorkHistorySection editing={editing} />
          </div>
        </fieldset>

        {editing && (
          <SaveBar
            changes={changes}
            saving={saving}
            live={live}
            open={changesOpen}
            onToggle={() => setChangesOpen((o) => !o)}
            onCancel={cancel}
            onSave={save}
          />
        )}
      </main>

      {discardOpen && (
        <DiscardDialog count={changes.length} onKeep={keepEditing} onDiscard={discard} />
      )}
      <Toast toast={toast} raised={editing} />
    </div>
  );
}
