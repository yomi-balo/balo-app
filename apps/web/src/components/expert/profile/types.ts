import type { ProficiencyTone } from '@/lib/expert-profile/proficiency';

/** Section keys the StickyNav / scroll-spy operates on. */
export type ProfileSectionKey = 'about' | 'expertise' | 'quickstarts' | 'work' | 'reviews';

/** One deduped competency bar (max proficiency across the product's support types). */
export interface CompetencyView {
  /** Product id — stable React key (display names can collide). */
  id: string;
  name: string;
  /** 0–10 proficiency. */
  proficiency: number;
  /** Human level label derived from proficiency. */
  level: string;
  /** Semantic tone for the level badge. */
  tone: ProficiencyTone;
  /** Bar fill percentage (0–100). */
  pct: number;
}

export interface CertView {
  /** Certification id — stable React key (display names can collide). */
  id: string;
  name: string;
  logoUrl: string | null;
}

export interface LanguageView {
  name: string;
  flagEmoji: string | null;
}

export interface AgencyView {
  name: string;
  slug: string | null;
  logoUrl: string | null;
  initials: string;
}

export interface WorkHistoryView {
  role: string;
  company: string;
  /** e.g. "Apr 2025 — Present". */
  periodLabel: string;
  /** e.g. "5 yrs" / "2 yrs 5 mos" — empty string for the current role. */
  durationLabel: string;
  isCurrent: boolean;
  responsibilities: string | null;
}

/**
 * Pre-packaged, purchasable project request. Empty in v1 (BAL-255 owns the
 * package data model and fills this contract).
 */
export interface QuickStartSummary {
  id: string;
  title: string;
  /** Pre-formatted price, e.g. "A$450". */
  priceLabel: string;
  /** e.g. "1–2 days". */
  durationLabel: string;
  description: string;
}

/**
 * Fully serializable, presentation-ready view-model that crosses the
 * server→client boundary. No `Date` objects, no Drizzle rows — every date is
 * pre-formatted to a string by the mapper.
 */
export interface ExpertProfileView {
  expertId: string;
  /** Agency id for analytics, or null for a freelancer. */
  agencyId: string | null;
  /** Full display name (fallback "Salesforce Expert"). */
  name: string;
  /** First name for "{firstName}" copy (fallback "this expert"). */
  firstName: string;
  initials: string;
  headline: string | null;
  bio: string | null;
  /** R2 key OR http URL — resolved to a CDN URL server-side, not in the client. */
  avatarKey: string | null;
  countryCode: string | null;
  country: string | null;
  /**
   * CLIENT ALL-IN rate per minute, in dollars, **Balo service fee INCLUDED** — computed at
   * `DEFAULT_BALO_FEE_BPS` by `publicDisplayRatePerMinute` (`@balo/shared/pricing`) inside
   * `mapProfileToView`, NOT a bare `rate_cents / 100` (BAL-493 / D1: that published a rate
   * lower than the client is charged).
   *
   * ⚠ A **"FROM" FIGURE.** The fee is session/engagement grain — there is no per-expert fee
   * column — so a session opened at a non-default fee charges differently. Render it as
   * "From A$…/min", never as an exact promise.
   *
   * `null` when no rate is set; `0` stays `0`.
   */
  rate: number | null;
  /** Years of Salesforce experience, or null when unknown. */
  yearsExperience: number | null;
  /** Confirmed consultation count — 0 for everyone in v1. */
  consultationCount: number;
  certCount: number;
  availableForWork: boolean;
  /** Derived from the visibility gate (approved + searchable) — always true here. */
  baloVerified: boolean;
  /**
   * ALWAYS `false` — and after BAL-422 that is no longer because reviews are deferred.
   * Reviews exist and `ratingAverage` below is real data; `topRated` is a SEPARATE
   * EDITORIAL badge with no defined threshold, so `mapProfileToView` hardcodes `false`
   * rather than inventing a cutoff nobody decided. Same rationale as the one stated at
   * `mapProfileToView`; if the two ever disagree, that one is the authority.
   */
  topRated: boolean;
  /**
   * The expert's average rating (BAL-422), 1..5, or `null` for NO REVIEWS.
   *
   * ⚠ `null` IS NOT 0.0 and MUST NEVER RENDER AS ONE — the scale starts at 1, so a zero is a
   * fabricated rating, not a bad one. The hero stats strip OMITS the rating stat entirely
   * when this is null (matching `buildStats`' existing omit-don't-fabricate rule for
   * consultations / experience / certs), and the reviews section falls back to its
   * invitation empty state.
   *
   * ⚠ ALWAYS RENDERED WITH `ratingCount`. An average with no denominator overstates the
   * evidence — that pairing is a BAL-422 acceptance criterion, not a style preference.
   */
  ratingAverage: number | null;
  /**
   * ENGAGEMENTS REVIEWED — **not** review rows. A 5-person company reviewing one engagement
   * contributes 1, not 5 (one engagement, one vote). `0` whenever `ratingAverage` is null.
   *
   * ⚠ THIS IS WHY THE PUBLIC COPY SAYS "ENGAGEMENTS", NOT "REVIEWS". Saying "12 reviews"
   * when the number counts engagements would misstate the evidence in the other direction.
   */
  ratingCount: number;
  competencies: CompetencyView[];
  certifications: CertView[];
  languages: LanguageView[];
  /** Comma-joined language names, e.g. "English, Tamil". */
  languagesLabel: string;
  agency: AgencyView | null;
  workHistory: WorkHistoryView[];
}
