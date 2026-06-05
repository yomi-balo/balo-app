/**
 * Type contracts for the BAL-239 dev seeder.
 *
 * Type-only module (no runtime exports) — excluded from coverage by intent.
 */
import type { BusyBlock } from '../availability/types.js';

/** Availability behaviour buckets, assigned deterministically by expert index. */
export type Archetype = 'WIDE_OPEN' | 'SPARSE' | 'NEXT_WEEK' | 'TODAY_ONLY' | 'BOOKED_SOLID';

/** Rate band labels used for weighted per-minute-cents selection. */
export type RateBand = 'junior' | 'typical' | 'mid-high' | 'spec';

/** Live taxonomy snapshot read from the DB and fed into the pure generators. */
export interface SeedTaxonomy {
  verticalId: string;
  /** Flattened skills in seed.ts order — core clouds first. */
  skills: { id: string; name: string }[];
  /** Support-type ids (the 4 assessment dimensions). */
  supportTypeIds: string[];
  /** Language ids; index 0 is treated as English (always native). */
  languages: { id: string; name: string }[];
  /** Industry ids + names for headline rendering. */
  industries: { id: string; name: string }[];
  /** Certification ids from the seeded catalog (flattened like skills). */
  certificationIds: string[];
}

/**
 * Pre-insert work-history row. `startedAt`/`endedAt` are `Date` because
 * `work_history.started_at`/`ended_at` are TIMESTAMPTZ columns (Drizzle expects
 * Date objects).
 */
export interface GeneratedWorkHistory {
  role: string;
  company: string;
  startedAt: Date;
  endedAt: Date | null;
  isCurrent: boolean;
  responsibilities: string;
  sortOrder: number;
}

/**
 * Pre-insert certification link. `earnedAt`/`expiresAt` are ISO date STRINGS
 * (`'YYYY-MM-DD'`) because `expert_certifications.earned_at`/`expires_at` are
 * `date` columns (Drizzle expects strings, NOT Date objects).
 */
export interface GeneratedCertification {
  certificationId: string;
  earnedAt: string;
  expiresAt: string | null;
}

/** A single generated expert's full in-memory data model (pre-insert). */
export interface GeneratedExpert {
  /** Stable per-run index (0-based). NOT a DB id. */
  index: number;
  // users row
  workosId: string;
  email: string;
  firstName: string;
  lastName: string;
  timezone: string;
  // expert_profiles row
  type: 'freelancer' | 'agency';
  headline: string;
  bio: string;
  username: string;
  /** Per-minute rate in CENTS. */
  rateCents: number;
  rateBand: RateBand;
  yearStartedSalesforce: number;
  projectCountMin: number;
  projectLeadCountMin: number;
  isSalesforceMvp: boolean;
  isSalesforceCta: boolean;
  isCertifiedTrainer: boolean;
  approvedOffsetMs: number;
  // join rows
  skills: { skillId: string; supportTypeId: string; proficiency: number }[];
  languages: { languageId: string; proficiency: LanguageProficiency }[];
  industryIds: string[];
  workHistory: GeneratedWorkHistory[];
  certifications: GeneratedCertification[];
  // NOTE: rating / session_count are intentionally NOT generated here. There are
  // no `rating`/`session_count` columns on `expert_profiles`, so any generated
  // values would be dead (never persisted, never surfaced). Seeding them is
  // deferred to a future ticket that first adds the columns to expert_profiles.
}

export type LanguageProficiency = 'beginner' | 'intermediate' | 'advanced' | 'native';

/** A weekly recurring rule to insert (LOCAL wall-clock in the expert's tz). */
export interface NewRuleSeed {
  dayOfWeek: number;
  startTime: string;
  endTime: string;
}

/** A consultation row to insert. */
export interface NewConsultationSeed {
  startAt: Date;
  endAt: Date;
  status: 'confirmed' | 'cancelled';
}

/** Per-expert availability plan produced by the pure generator. */
export interface AvailabilityPlan {
  expertProfileId: string;
  index: number;
  archetype: Archetype;
  rules: NewRuleSeed[];
  /** Vendor free/busy fixture — in-memory resolver input, never persisted. */
  busyBlocks: BusyBlock[];
  consultations: NewConsultationSeed[];
}

// ── Route / service summaries ──────────────────────────────────────

export interface RegenerateSummary {
  ok: true;
  expertsGenerated: number;
  skillsGenerated: number;
  languagesGenerated: number;
  industriesGenerated: number;
  workHistoryGenerated: number;
  certificationsGenerated: number;
  seedUsedRng: number;
  baselineAt: string;
}

export interface RefreshSummary {
  ok: true;
  availabilityRulesGenerated: number;
  consultationsSeeded: number;
  consultationsCancelled: number;
  cacheRowsWritten: number;
  expertsWithEarliest: number;
  expertsNullEarliest: number;
  baselineAt: string;
  seedUsedRng: number;
}

export interface ResetSummary {
  ok: true;
  experts: RegenerateSummary;
  availability: RefreshSummary;
}
