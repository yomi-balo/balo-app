import type { ProficiencyTone } from '@/lib/expert-profile/proficiency';

/** Section keys the StickyNav / scroll-spy operates on. */
export type ProfileSectionKey = 'about' | 'expertise' | 'quickstarts' | 'work' | 'reviews';

/** One deduped skill bar (max proficiency across the skill's support types). */
export interface SkillView {
  /** Skill id — stable React key (display names can collide). */
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
  /** Dollars per minute, or null when no rate is set. */
  rate: number | null;
  /** Years of Salesforce experience, or null when unknown. */
  yearsExperience: number | null;
  /** Confirmed consultation count — 0 for everyone in v1. */
  consultationCount: number;
  certCount: number;
  availableForWork: boolean;
  /** Derived from the visibility gate (approved + searchable) — always true here. */
  baloVerified: boolean;
  /** Reviews are deferred — always false in v1. */
  topRated: boolean;
  skills: SkillView[];
  certifications: CertView[];
  languages: LanguageView[];
  /** Comma-joined language names, e.g. "English, Tamil". */
  languagesLabel: string;
  agency: AgencyView | null;
  workHistory: WorkHistoryView[];
}
