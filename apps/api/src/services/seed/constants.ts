/**
 * Compact data tables + tunable constants for the BAL-239 dev seeder.
 *
 * Keeping every weight / band / pool here (architect principle #7) means the
 * pure generators read as data-driven transforms, and tests can import the
 * same constants to assert distributions without magic numbers.
 */
import type { Archetype, RateBand } from './types.js';

/** Documented default RNG seed (BAL-239). "Expert #34" is stable under this. */
export const DEFAULT_SEED = 20239;

/** Default number of experts to generate. */
export const DEFAULT_EXPERT_COUNT = 60;

/** Hard upper bound on a single regenerate (Zod-enforced at the route). */
export const MAX_EXPERT_COUNT = 500;

/** Seed-data scoping markers — used by truncation to identify seed rows. */
export const SEED_EMAIL_DOMAIN = 'seed.balo.dev';
export const SEED_WORKOS_PREFIX = 'seed_';

/** Per-minute-cents ceiling enforced by the rate editor (PLATFORM_PRICING). */
export const MAX_RATE_CENTS = 5000;

/**
 * Timezone spread — mostly Sydney, with a realistic international tail.
 * Weights are relative; the WeightedRng normalises them.
 */
export const TIMEZONE_WEIGHTS: { value: string; weight: number }[] = [
  { value: 'Australia/Sydney', weight: 50 },
  { value: 'Pacific/Auckland', weight: 12 },
  { value: 'Asia/Singapore', weight: 12 },
  { value: 'Europe/London', weight: 14 },
  { value: 'America/New_York', weight: 12 },
];

/** Expert type mix — agencies are not seeded as agency rows, agencyId stays null. */
export const EXPERT_TYPE_WEIGHTS: { value: 'freelancer' | 'agency'; weight: number }[] = [
  { value: 'freelancer', weight: 85 },
  { value: 'agency', weight: 15 },
];

/** Per-minute-cents rate bands. All bounds ≤ MAX_RATE_CENTS. */
export const RATE_BANDS: { band: RateBand; weight: number; min: number; max: number }[] = [
  { band: 'junior', weight: 5, min: 120, max: 180 },
  { band: 'typical', weight: 80, min: 300, max: 500 },
  { band: 'mid-high', weight: 10, min: 500, max: 800 },
  { band: 'spec', weight: 5, min: 1000, max: 1300 },
];

/** Project-count buckets (stored as the lower bound — schema comment). */
export const PROJECT_COUNT_BUCKETS = [0, 1, 10, 26, 50];

/**
 * Archetype cumulative thresholds (percent of population, 0..100). Bucketed via
 * `Math.floor((index / count) * 100)` so proportions are exact for any count.
 * For count=60 → WIDE_OPEN 24, SPARSE 12, NEXT_WEEK 9, TODAY_ONLY 9, BOOKED_SOLID 6.
 */
export const ARCHETYPE_THRESHOLDS: { archetype: Archetype; upTo: number }[] = [
  { archetype: 'WIDE_OPEN', upTo: 40 },
  { archetype: 'SPARSE', upTo: 60 },
  { archetype: 'NEXT_WEEK', upTo: 75 },
  { archetype: 'TODAY_ONLY', upTo: 90 },
  { archetype: 'BOOKED_SOLID', upTo: 100 },
];

/**
 * Product weight tiers by position in the flattened taxonomy (seed.ts orders
 * core clouds first). Indexes below `core` get weight 5, below `mid` weight 3,
 * the rest weight 1. Position-based so it never hardcodes product names.
 */
export const PRODUCT_TIER_BOUNDARIES = { core: 4, mid: 9 };
export const PRODUCT_TIER_WEIGHTS = { core: 5, mid: 3, niche: 1 };

/** Min/max distinct competencies per expert. */
export const COMPETENCY_COUNT_RANGE = { min: 3, max: 7 };

/** Fallback industry pool for headline rendering when industries aren't seeded. */
export const FALLBACK_INDUSTRIES = [
  'financial services',
  'healthcare',
  'retail',
  'manufacturing',
  'nonprofit',
  'education',
  'technology',
  'professional services',
];

/** Default availability window (LOCAL wall-clock) for WIDE_OPEN weekdays. */
export const DEFAULT_WINDOW = { start: '09:00', end: '17:00' };

/** Work-history generation tunables. */
export const WORK_HISTORY_COUNT_RANGE = { min: 2, max: 4 };
/** Open-ended current role: months since it started (walking back from baseline). */
export const CURRENT_ROLE_MONTHS_RANGE = { min: 8, max: 60 };
/** Duration of a closed (past) role in months. */
export const PAST_ROLE_MONTHS_RANGE = { min: 12, max: 60 };
/** Gap between consecutive roles in months. */
export const ROLE_GAP_MONTHS_RANGE = { min: 0, max: 4 };
export const WORK_ROLE_TITLES = [
  'Salesforce Consultant',
  'Senior Salesforce Consultant',
  'Salesforce Technical Architect',
  'Salesforce Solution Architect',
  'Lead Salesforce Developer',
  'Salesforce Practice Lead',
  'CRM Delivery Manager',
  'Principal Consultant',
] as const;
export const WORK_RESPONSIBILITY_SNIPPETS = [
  'Led end-to-end Sales Cloud and Service Cloud implementations.',
  'Designed scalable data models and integration architecture.',
  'Mentored junior consultants and ran solution-design workshops.',
  'Owned release management and CI/CD for managed packages.',
  'Partnered with stakeholders to translate process into requirements.',
  'Built Flow and Apex automation against enterprise SLAs.',
] as const;

/** Certification generation tunables. */
export const CERT_COUNT_RANGE = { min: 3, max: 8 };
/** How long ago a cert was earned, in months (date column). */
export const CERT_EARNED_MONTHS_AGO_RANGE = { min: 3, max: 72 };
export const CERT_HAS_EXPIRY_PROBABILITY = 0.5;
/** Future expiry window, in months ahead of baseline (date column). */
export const CERT_EXPIRY_MONTHS_AHEAD_RANGE = { min: 6, max: 30 };
