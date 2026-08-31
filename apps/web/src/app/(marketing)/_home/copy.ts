import type { MarketingIconKey } from './icons';

/**
 * BAL-493 §1.2 / §20 — every placeholder string on the marketing home, as one typed const
 * module. Every business-copy item below is a PLACEHOLDER pending MJ (Marketing/Content) —
 * marked `TODO(MJ)` at the group level rather than on every single line, to keep the module
 * readable; see plan §20 open question 3 for the exhaustive checklist this mirrors.
 *
 * ⚠⚠ MONEY STRINGS (§13.5 / N3): the public rate is a "FROM" figure — the Balo fee is applied
 * at `DEFAULT_BALO_FEE_BPS` and is SESSION-grain, not expert-grain (`publicDisplayRatePerMinute`,
 * `@balo/shared/pricing`). Every money string below that stands in for "the rate a client pays"
 * reads `From A$…/min`, never an exact promise. The two illustrative RECEIPT/fragment figures
 * (`A$2.40/min`, `A$55.20`, `A$42.55`) are a worked EXAMPLE inside a mock session receipt, not a
 * claim about what any given visitor will pay — plan §13.5 sanctions both explicitly.
 *
 * ⚠ "Service fee included" is the ONLY fee/margin/commission language permitted ANYWHERE on
 * this surface (AC-8). The For-experts band (`expert-band-section.tsx`) carries NONE of it —
 * no fee, margin, cut, commission, earnings or payout language of any kind. Pinned by
 * `copy-invariants.test.ts`.
 */

export interface MarketingVertical {
  name: string;
  /** Hero typewriter phrases — cycles while the search field is empty. */
  phrases: readonly string[];
  /** Hero facet "Popular:" chip labels shown under the search bar (distinct from the bench). */
  chips: readonly string[];
}

/** TODO(MJ): the vertical is hardcoded to Salesforce for V1 — no vertical switcher yet. */
export const VERTICAL: MarketingVertical = {
  name: 'Salesforce',
  phrases: [
    'fix a broken Flow before lunch',
    'set up Data Cloud the right way',
    'get a second opinion on an Agentforce build',
    'untangle a MuleSoft integration',
    'review your org before go-live',
  ],
  chips: ['Agentforce', 'Data Cloud', 'CPQ', 'Sales Cloud', 'Service Cloud', 'MuleSoft', 'Tableau'],
};

export interface MarketingMetric {
  value: number;
  decimals?: number;
  prefix?: string;
  suffix?: string;
  label: string;
}

/** TODO(MJ): proof-band figures are placeholders pending real numbers. */
export const METRICS: readonly MarketingMetric[] = [
  { value: 1, prefix: 'Top ', suffix: '%', label: 'of applicants accepted' },
  { value: 4.9, decimals: 1, label: 'average session rating' },
  { value: 2, prefix: '< ', suffix: ' hrs', label: 'typical wait for a first session' },
  { value: 40, suffix: '+', label: 'countries with active experts' },
];

export interface MarketingWay {
  icon: MarketingIconKey;
  kicker: string;
  title: string;
  /** A "from" figure, never an exact promise (§13.5). */
  tag: string;
  linkLabel: string;
  body: string;
}

/**
 * TODO(MJ): body copy + the "From A$1.20/min" tag are placeholders pending real figures.
 *
 * TODO(MJ): the three `linkLabel`s are final wording candidates, not final wording.
 *
 * ⚠ EVERY `linkLabel` MUST DESCRIBE FINDING AN EXPERT. All three cards route to the same
 * `/experts` grid — there is no engagement-type filter param to route anywhere better (see
 * `ways-section.tsx`). The first build shipped "Post a project" and "Browse packages", which
 * promise an intake form and a catalogue that do not exist; the labels now say what actually
 * happens. The CARD TITLES (Consultations / Projects / Packages) carry the distinction, and
 * the labels stay distinct from one another so `marketing_home_cta_clicked{label}` can still
 * tell which card drove the click.
 */
export const WAYS: readonly MarketingWay[] = [
  {
    icon: 'video',
    kicker: 'By the minute',
    title: 'Consultations',
    tag: 'From A$1.20/min',
    linkLabel: 'Find an expert',
    body: 'Screen-share with an expert and fix it together. The clock runs only while you are both in the room, so a 20-minute problem costs 20 minutes.',
  },
  {
    icon: 'layers',
    kicker: 'Fixed scope',
    title: 'Projects',
    tag: 'Proposal in ~2 days',
    linkLabel: 'Find a project expert',
    body: 'Describe the outcome you need and get a proposal with milestones and a statement of work. You pay as each milestone lands.',
  },
  {
    icon: 'box',
    kicker: 'Set price',
    title: 'Packages',
    tag: 'Fixed price',
    linkLabel: 'Find a package expert',
    body: 'Org health checks, security reviews, migrations and more, defined up front at a set price, so you can start without a scoping call.',
  },
];

export interface MarketingStep {
  n: string;
  title: string;
  body: string;
}

/** The four-step sequence. Copy only — the accompanying product fragments render inline in
 * `how-it-works-section.tsx` (structural markup, not copy). */
export const STEPS: readonly MarketingStep[] = [
  {
    n: '01',
    title: 'Say what is going on',
    body: 'Type it the way you would tell a colleague. We map it to the right products and skills.',
  },
  {
    n: '02',
    title: 'Meet your match',
    body: 'See vetted experts ranked for your problem, with rates, availability and reviews up front.',
  },
  {
    n: '03',
    title: 'Book the time you need',
    body: 'Pick a slot that works and a duration you are comfortable with. Reschedule any time before it starts.',
  },
  {
    n: '04',
    title: 'Get it done, pay to the minute',
    body: 'Fix it live on a screen-share. When you leave, you are billed for the minutes used and nothing else.',
  },
];

/** The How-it-works "match" fragment's two illustrative candidate rows. */
export const HOW_IT_WORKS_MATCH_ROWS: readonly {
  id: string;
  name: string;
  meta: string;
  selected: boolean;
}[] = [
  { id: 'sample_tom', name: 'Tom Okafor', meta: 'Flow · From A$1.85/min', selected: true },
  { id: 'sample_sam', name: 'Sam Whitaker', meta: 'Admin · From A$1.20/min', selected: false },
];

export interface MarketingVettingCheck {
  icon: MarketingIconKey;
  title: string;
  body: string;
}

export const VETTING_CHECKS: readonly MarketingVettingCheck[] = [
  {
    icon: 'shield',
    title: 'Certifications verified',
    body: 'Checked against Salesforce records, not a CV.',
  },
  {
    icon: 'users',
    title: 'Technical interview',
    body: 'With a senior expert in the same discipline.',
  },
  { icon: 'video', title: 'Live scenario', body: 'A real org, a real problem, on the clock.' },
  {
    icon: 'star',
    title: 'Rated every session',
    body: 'Ratings stay visible. Standards stay high.',
  },
];

export interface MarketingPricePoint {
  title: string;
  body: string;
}

/** The first entry's title is the ONLY sanctioned fee-language string on the page (AC-8). */
export const PRICE_POINTS: readonly MarketingPricePoint[] = [
  {
    title: 'Service fee included',
    body: "The rate on an expert's profile already includes Balo's service fee. Nothing is added at checkout.",
  },
  {
    title: 'Billed to the minute',
    body: 'The session timer starts when you both join and stops when you leave. Twenty-three minutes costs twenty-three minutes.',
  },
  {
    title: 'Pay per session or top up credits',
    body: 'Add a card and pay as you go, or hold credits for your team and see spend in one place.',
  },
];

export const PRICE_NOS: readonly string[] = [
  'No retainer',
  'No minimum booking',
  'No day rate',
  'No contract',
];

/** The illustrative session receipt (Pricing section). A worked EXAMPLE, not a promise (§13.5). */
export const RECEIPT = {
  expertName: 'Priya Nair',
  sessionLabel: 'Data Cloud setup review',
  durationMinutes: 23,
  ratePerMinute: 'A$2.40 / min',
  total: 'A$55.20',
  footnote: 'Billed to the minute · a real session, illustrated',
};

export interface MarketingPerk {
  icon: MarketingIconKey;
  title: string;
  body: string;
}

/**
 * The "For experts" band. ⚠⚠ NO fee/margin/cut/commission/earnings language anywhere in this
 * array — the band is the one place on the page that must carry ZERO of it (AC-8, pinned by
 * `copy-invariants.test.ts`'s stricter for-experts-only scan).
 */
export const PERKS: readonly MarketingPerk[] = [
  {
    icon: 'clock',
    title: 'Your rate, your hours',
    body: 'Set a per-minute rate and a weekly schedule. Change either whenever you like.',
  },
  {
    icon: 'users',
    title: 'Clients come pre-qualified',
    body: 'Every request is scoped before it reaches you, so sessions start with context, not discovery.',
  },
  {
    icon: 'banknote',
    title: 'Paid in your currency',
    body: 'Sessions and milestones pay out to your local account. No invoicing, no chasing.',
  },
  {
    icon: 'shield',
    title: 'Only the top 1% get in',
    body: 'Certification checks, a technical interview and a live scenario. A high bar, on purpose.',
  },
];

export interface MarketingQuote {
  quote: string;
  name: string;
  role: string;
  context: string;
}

/** TODO(MJ): all three testimonials are placeholders pending real, attributable quotes. */
export const QUOTES: readonly MarketingQuote[] = [
  {
    quote:
      'Our lead routing had been broken for a month and two agencies quoted a fortnight. It was fixed on a screen-share in 35 minutes.',
    name: 'Jordan Lee',
    role: 'RevOps Lead · mid-market SaaS',
    context: 'Consultation · 35 min · Sales Cloud',
  },
  {
    quote:
      'We ran a Data Cloud pilot as a Project. Proposal in two days, delivered in five weeks, milestone billing the whole way. Zero surprises.',
    name: 'Casey Morgan',
    role: 'Head of CRM · retail',
    context: 'Project · 5 weeks · Data Cloud',
  },
  {
    quote:
      'Paying by the minute changed how we use consultants. We ask the small questions now instead of saving them up for a paid workshop.',
    name: 'Alex Rivera',
    role: 'Salesforce Admin · nonprofit',
    context: 'Consultation · 18 min · Flow',
  },
];

export interface MarketingFooterLink {
  label: string;
  href: string;
}

export interface MarketingFooterColumn {
  heading: string;
  links: readonly MarketingFooterLink[];
}

/**
 * §13.2 — ship only links that resolve. The ref's remaining ~19 links (About, Careers, Contact,
 * Trust & security, Help centre, Blog, Status, Payouts, How vetting works, Expert help centre)
 * are preserved here, verbatim, as a TODO(MJ) rather than silently dropped:
 *
 * TODO(MJ): candidate future footer links, once the destinations exist —
 *   Company: About, Careers, Contact, Trust & security
 *   Resources: Help centre, Blog, Status
 *   Experts: How vetting works, Payouts, Expert help centre
 *   Legal: Privacy, Terms, Cookies (the bottom-bar `<nav aria-label="Legal">` is omitted
 *     entirely until these routes exist, rather than linking to them nowhere).
 */
export const FOOTER_COLUMNS: readonly MarketingFooterColumn[] = [
  {
    heading: 'Product',
    links: [
      { label: 'Find experts', href: '/experts' },
      { label: 'How it works', href: '/#how-it-works' },
      { label: 'Pricing', href: '/#pricing' },
    ],
  },
  {
    heading: 'Experts',
    links: [{ label: 'Apply to join', href: '/expert/apply' }],
  },
  {
    heading: 'Account',
    links: [
      { label: 'Log in', href: '/login' },
      { label: 'Create an account', href: '/signup' },
    ],
  },
];

/** §13.4 — the live-count pill's two data-dependent, honest copy variants. */
export function liveCountLabel(gated: boolean): string {
  return gated ? 'experts available now' : `vetted ${VERTICAL.name} experts`;
}
