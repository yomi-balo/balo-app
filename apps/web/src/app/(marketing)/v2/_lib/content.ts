/**
 * BAL-510 — /v2 preview sample data, lifted verbatim from the design ref
 * (`.claude/design-references/marketing-home-v2.jsx`). ALL PLACEHOLDER, none are
 * claims — see the ref's header comment for the full disclosure list.
 *
 * Pure data + two small pure helpers. No React, no app imports, no `@balo/db`
 * (not even a type import — this module has nothing to do with the real taxonomy).
 * Deletes with the rest of `(marketing)/v2/` when the preview is torn down.
 */

export interface VerticalConfig {
  name: string;
  /** Hero rotator: "For the ___" + entry. */
  rotator: string[];
  /** Ticker = product coverage in one line. */
  ticker: string[];
}

// ── Vertical config (ref :132-163) ─────────────────────────────────
export const VERTICAL: VerticalConfig = {
  name: 'Salesforce',
  rotator: [
    'Flow that broke on Friday.',
    'CPQ quote due tomorrow.',
    'Data Cloud rollout.',
    'Agentforce pilot.',
    'report nobody can build.',
  ],
  ticker: [
    'Sales Cloud',
    'Service Cloud',
    'Agentforce',
    'Data Cloud',
    'Revenue Cloud & CPQ',
    'Marketing Cloud',
    'Platform & Apex',
    'Experience Cloud',
    'Tableau',
    'Flow & Automation',
    'MuleSoft',
    'Field Service',
    'Account Engagement',
    'Commerce Cloud',
    'Financial Services Cloud',
    'Slack',
    'Health Cloud',
    'Nonprofit Cloud',
  ],
};

export interface FallbackTaxonomyGroup {
  group: string;
  items: string[];
}

/**
 * The ref's static `TAXONOMY` (ref :167-211) — mirrors the BAL-249 SearchComposer
 * taxonomy shape. Used by `toV2Taxonomy()` (`product-facet-model.ts`) ONLY when the
 * live taxonomy load returns no groups; every item gets `id: null` in that branch.
 */
export const FALLBACK_TAXONOMY: FallbackTaxonomyGroup[] = [
  { group: 'AI', items: ['Agentforce'] },
  { group: 'Data Cloud', items: ['Data Cloud'] },
  { group: 'Sales Cloud', items: ['CPQ', 'Sales Cloud'] },
  {
    group: 'Service Cloud',
    items: ['Digital Engagement', 'Field Service', 'Service Cloud', 'Voice'],
  },
  {
    group: 'Marketing Cloud',
    items: [
      'Account Engagement',
      'Engagement',
      'Intelligence',
      'Loyalty Management',
      'Personalisation',
    ],
  },
  { group: 'Slack', items: ['Slack'] },
  { group: 'Experience Cloud', items: ['Experience Cloud'] },
  { group: 'Commerce Cloud', items: ['B2B Commerce', 'B2C Commerce', 'Order Management'] },
  {
    group: 'Platform',
    items: ['AppExchange', 'Heroku', 'Hyperforce', 'Salesforce Platform', 'Security', 'Shield'],
  },
  { group: 'Tableau', items: ['CRM Analytics', 'Tableau'] },
  { group: 'MuleSoft', items: ['MuleSoft'] },
  {
    group: 'Industries',
    items: [
      'Communications Cloud',
      'Consumer Goods Cloud',
      'Education Cloud',
      'Energy & Utilities Cloud',
      'Financial Services Cloud',
      'Government Cloud',
      'Health Cloud',
      'Manufacturing Cloud',
      'Media Cloud',
      'Nonprofit Cloud',
      'OmniStudio',
    ],
  },
  { group: 'Net Zero Cloud', items: ['Net Zero Cloud'] },
];

/** Per-group chip cap before "+n more" (matches BAL-249). */
export const DENSE_CAP = 4;

// ── Avatar helpers (same hash + gradients as ExpertCard, BAL-214) ──
export const AVATAR_GRADIENTS: string[] = [
  'linear-gradient(135deg, #0F4C81 0%, #2a7fd4 100%)',
  'linear-gradient(135deg, #1e3a5f 0%, #0F4C81 100%)',
  'linear-gradient(135deg, #3b0764 0%, #7C3AED 100%)',
  'linear-gradient(135deg, #064e3b 0%, #059669 100%)',
  'linear-gradient(135deg, #7c2d12 0%, #ea580c 100%)',
  'linear-gradient(135deg, #1e1b4b 0%, #4F46E5 100%)',
];

const [FIRST_AVATAR_GRADIENT] = AVATAR_GRADIENTS;

export function avatarGradient(key: string): string {
  const index =
    key.split('').reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % AVATAR_GRADIENTS.length;
  return AVATAR_GRADIENTS[index] ?? FIRST_AVATAR_GRADIENT ?? '';
}

export function initials(name: string): string {
  return name
    .split(' ')
    .filter(Boolean)
    .map((w) => w.charAt(0))
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

// ── Sample data (ALL PLACEHOLDER — see ref header) ─────────────────
export const LIVE_COUNT = 38;
export const CLUSTER: string[] = [
  'Priya Nair',
  'Tom Okafor',
  'Mei-Ling Chao',
  'Diego Ferreira',
  'Zoe Adeyemi',
];

export interface SpotlightExpert {
  id: string;
  n: string;
  s: string;
  r: number;
}

// Spotlight — production renders REAL experts via ExpertCard (BAL-493).
export const EXPERTS: SpotlightExpert[] = [
  { id: 'usr_priya', n: 'Priya Nair', s: 'Data Cloud · Agentforce', r: 2.4 },
  { id: 'usr_tom', n: 'Tom Okafor', s: 'Sales Cloud · CPQ', r: 1.85 },
  { id: 'usr_amara', n: 'Amara Diallo', s: 'Financial Services Cloud', r: 2.55 },
];

export interface WayItem {
  name: string;
  desc: string;
  tag: string;
  href: string;
}

export const WAYS: WayItem[] = [
  { name: 'Consultations', desc: 'By the minute.', tag: 'From A$1.20/min', href: '#experts' },
  {
    name: 'Projects',
    desc: 'Scoped and milestoned, end to end.',
    tag: 'Fixed scope',
    href: '#experts',
  },
  {
    name: 'Packages',
    desc: 'A set price for a known outcome.',
    tag: 'Fixed price',
    href: '#experts',
  },
];

export interface StepItem {
  num: string;
  title: string;
  body: string;
}

export const STEPS: StepItem[] = [
  { num: '01', title: 'Describe it', body: 'A sentence is enough.' },
  { num: '02', title: 'Pick your expert', body: 'Vetted, rated, priced upfront.' },
  { num: '03', title: 'Get on a call', body: 'Screen-share. Fix it together. Done.' },
];

export interface QuoteContent {
  text: string;
  name: string;
  role: string;
}

export const QUOTE: QuoteContent = {
  text: 'We ask the small questions now instead of saving them up for a paid workshop.',
  name: 'Alex Rivera',
  role: 'Salesforce Admin · nonprofit',
};

export type FooterLink = readonly [label: string, href: string];

export const FOOTER_LINKS: FooterLink[] = [
  ['Find experts', '#experts'],
  ['How it works', '#how'],
  ['Pricing', '#pricing'],
  ['For experts', '#for-experts'],
  ['Privacy', '#'],
  ['Terms', '#'],
];
