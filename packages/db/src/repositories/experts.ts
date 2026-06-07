import { eq, and, not, inArray, or, like, isNotNull, sql } from 'drizzle-orm';
import { createLogger } from '@balo/shared/logging';
import { db } from '../client';
import { consultationCountExpression } from './_shared/consultation-count';
import {
  expertProfiles,
  expertCompetency,
  expertCertifications,
  expertLanguages,
  expertIndustries,
  workHistory,
  type ExpertProfile,
  type ExpertCompetency,
  type ExpertCertification,
  type ExpertLanguage,
  type ExpertIndustry,
  type WorkHistory as WorkHistoryType,
} from '../schema';
import { generateBaseUsername, pickNextAvailable } from './username-utils';

const log = createLogger('experts-repository');

// ── Input types ──────────────────────────────────────────────────

interface CreateDraftInput {
  userId: string;
  verticalId: string;
  type: 'freelancer' | 'agency';
  firstName?: string | null;
  lastName?: string | null;
}

interface UpdateProfileInput {
  headline?: string | null;
  bio?: string | null;
  username?: string | null;
  websiteUrl?: string | null;
  yearStartedSalesforce?: number;
  projectCountMin?: number;
  projectLeadCountMin?: number;
  linkedinUrl?: string | null;
  trailheadUrl?: string | null;
  isSalesforceMvp?: boolean;
  isSalesforceCta?: boolean;
  isCertifiedTrainer?: boolean;
  searchable?: boolean;
  rateCents?: number;
}

interface SyncLanguageInput {
  languageId: string;
  proficiency: 'beginner' | 'intermediate' | 'advanced' | 'native';
}

interface CompetencyRatingInput {
  productId: string;
  supportTypeId: string;
  proficiency: number;
}

interface SyncCertInput {
  certificationId: string;
  earnedAt?: string; // ISO date string or empty
  expiresAt?: string; // ISO date string or empty
  credentialUrl?: string;
}

interface SyncWorkHistoryInput {
  role: string;
  company: string;
  startedAt: string; // ISO date string
  endedAt?: string; // ISO date string or empty
  isCurrent: boolean;
  responsibilities?: string;
}

// ── Output types ─────────────────────────────────────────────────

export interface ApplicationCompetencyWithRelations extends ExpertCompetency {
  product: { id: string; name: string };
  supportType: { id: string; name: string; slug: string };
}

export interface ApplicationCertWithRelations extends ExpertCertification {
  certification: { id: string; name: string };
}

export interface ApplicationLanguageWithRelations extends ExpertLanguage {
  language: { id: string; name: string; code: string; flagEmoji: string | null };
}

export interface ApplicationIndustryWithRelations extends ExpertIndustry {
  industry: { id: string; name: string; slug: string };
}

export interface ApplicationWithRelations {
  profile: ExpertProfile;
  competencies: ApplicationCompetencyWithRelations[];
  certifications: ApplicationCertWithRelations[];
  languages: ApplicationLanguageWithRelations[];
  industries: ApplicationIndustryWithRelations[];
  workHistory: WorkHistoryType[];
}

// ── Repository ───────────────────────────────────────────────────

export const expertsRepository = {
  /** Find expert profile by ID (used for checklist status) */
  async findProfileById(expertProfileId: string): Promise<ExpertProfile | undefined> {
    return db.query.expertProfiles.findFirst({
      where: eq(expertProfiles.id, expertProfileId),
    });
  },

  /**
   * Focused single-column read of an expert's timezone — used by the availability
   * resolver wire-up on every webhook + staleness cron run. Returns null if the
   * profile doesn't exist (so callers can short-circuit without throwing).
   */
  async findTimezone(expertProfileId: string): Promise<string | null> {
    const row = await db.query.expertProfiles.findFirst({
      where: eq(expertProfiles.id, expertProfileId),
      columns: { timezone: true },
    });
    return row?.timezone ?? null;
  },

  /** Find expert profile by username (for public profile page) */
  async findByUsername(username: string) {
    return db.query.expertProfiles.findFirst({
      where: eq(expertProfiles.username, username),
      with: {
        user: {
          columns: { id: true, firstName: true, lastName: true, avatarUrl: true },
        },
      },
    });
  },

  /**
   * Public profile read for /experts/[username]. Returns the full graph the
   * detail page renders. Visibility-gated: only approved + searchable profiles
   * are publicly visible — drafts/unapproved/non-searchable resolve to undefined
   * (→ 404). Username match is exact (the unique username index).
   */
  async findPublicProfileByUsername(username: string) {
    return db.query.expertProfiles.findFirst({
      where: and(
        eq(expertProfiles.username, username),
        eq(expertProfiles.searchable, true),
        isNotNull(expertProfiles.approvedAt)
      ),
      // Defense-in-depth: explicit allowlist of the ONLY top-level columns the
      // public view-model + page consume. Keeps sensitive columns
      // (stripeConnectId, cronofyUserId, cronofySyncStatus, internal flags) out
      // of the RSC by construction — not just by mapper discipline. If the
      // mapper/page later needs another column, the type narrows and typecheck
      // fails until it's added here (the safety mechanism working).
      columns: {
        id: true,
        username: true,
        agencyId: true,
        headline: true,
        bio: true,
        rateCents: true,
        yearStartedSalesforce: true,
        availableForWork: true,
      },
      // Real confirmed-consultation count for the hero "consultations" stat —
      // shared scalar subquery so the public read and search list never diverge.
      extras: {
        consultationCount: sql<number>`${consultationCountExpression}::int`.as(
          'consultation_count'
        ),
      },
      with: {
        user: {
          columns: {
            id: true,
            firstName: true,
            lastName: true,
            avatarUrl: true,
            country: true,
            countryCode: true,
            timezone: true,
          },
        },
        agency: { columns: { id: true, name: true, slug: true, logoUrl: true } },
        competencies: {
          with: {
            product: { columns: { id: true, name: true, slug: true } },
            supportType: { columns: { id: true, name: true, slug: true } },
          },
        },
        certifications: {
          with: { certification: { columns: { id: true, name: true, logoUrl: true } } },
        },
        languages: {
          with: { language: { columns: { id: true, name: true, code: true, flagEmoji: true } } },
        },
        industries: {
          with: { industry: { columns: { id: true, name: true, slug: true } } },
        },
        workHistory: {
          columns: {
            role: true,
            company: true,
            startedAt: true,
            endedAt: true,
            isCurrent: true,
            responsibilities: true,
            sortOrder: true,
          },
          orderBy: (wh, { asc }) => [asc(wh.sortOrder)],
        },
      },
    });
  },

  /** Check if a username is available, optionally excluding a specific profile */
  async checkUsernameAvailability(username: string, excludeProfileId?: string): Promise<boolean> {
    const conditions = [eq(expertProfiles.username, username)];
    if (excludeProfileId) {
      conditions.push(not(eq(expertProfiles.id, excludeProfileId)));
    }

    const existing = await db.query.expertProfiles.findFirst({
      where: and(...conditions),
      columns: { id: true },
    });

    return !existing;
  },

  /** Find profile with all relations needed for the settings page */
  async findProfileForSettings(expertProfileId: string) {
    return db.query.expertProfiles.findFirst({
      where: eq(expertProfiles.id, expertProfileId),
      with: {
        user: {
          columns: {
            id: true,
            firstName: true,
            lastName: true,
            avatarUrl: true,
            timezone: true,
            country: true,
            countryCode: true,
          },
        },
        languages: { with: { language: true } },
        industries: { with: { industry: true } },
        workHistory: { orderBy: (wh, { asc }) => [asc(wh.sortOrder)] },
        certifications: { with: { certification: true } },
        competencies: { with: { product: true, supportType: true } },
      },
    });
  },

  /** Find draft or submitted application for a user + vertical */
  async findApplicationByUserId(
    userId: string,
    verticalId: string
  ): Promise<ExpertProfile | undefined> {
    return db.query.expertProfiles.findFirst({
      where: and(eq(expertProfiles.userId, userId), eq(expertProfiles.verticalId, verticalId)),
    });
  },

  /** Find application with all related data */
  async findApplicationWithRelations(
    expertProfileId: string
  ): Promise<ApplicationWithRelations | undefined> {
    const profile = await db.query.expertProfiles.findFirst({
      where: eq(expertProfiles.id, expertProfileId),
      with: {
        competencies: { with: { product: true, supportType: true } },
        certifications: { with: { certification: true } },
        languages: { with: { language: true } },
        industries: { with: { industry: true } },
        workHistory: { orderBy: (wh, { asc }) => [asc(wh.sortOrder)] },
      },
    });

    if (!profile) return undefined;

    return {
      profile,
      competencies: profile.competencies as unknown as ApplicationCompetencyWithRelations[],
      certifications: profile.certifications as unknown as ApplicationCertWithRelations[],
      languages: profile.languages as unknown as ApplicationLanguageWithRelations[],
      industries: profile.industries as unknown as ApplicationIndustryWithRelations[],
      workHistory: profile.workHistory,
    };
  },

  /** Find all usernames that match a base or start with `base-` (for uniqueness suffix logic) */
  async findUsernamesWithPrefix(base: string): Promise<string[]> {
    // Escape SQL wildcard characters in the base to prevent unintended pattern matching
    const escapedBase = base
      .split('')
      .map((ch) => (ch === '%' || ch === '_' ? `\\${ch}` : ch))
      .join('');
    const rows = await db.query.expertProfiles.findMany({
      where: or(
        eq(expertProfiles.username, base),
        like(expertProfiles.username, `${escapedBase}-%`)
      ),
      columns: { username: true },
    });
    return rows.map((r) => r.username).filter((u): u is string => u !== null);
  },

  /** Create initial draft profile, auto-generating a username from first/last name */
  async createDraft(data: CreateDraftInput): Promise<ExpertProfile> {
    const base = generateBaseUsername(data.firstName, data.lastName);

    let username: string | null = null;
    if (base) {
      const existing = await this.findUsernamesWithPrefix(base);
      username = pickNextAvailable(base, existing);
    }

    const MAX_RETRIES = 3;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const [profile] = await db
          .insert(expertProfiles)
          .values({
            userId: data.userId,
            verticalId: data.verticalId,
            type: data.type,
            applicationStatus: 'draft',
            username,
          })
          .returning();
        return profile!;
      } catch (error: unknown) {
        const isUniqueViolation =
          error instanceof Error && error.message.includes('expert_profiles_username_idx');

        if (isUniqueViolation && username && attempt < MAX_RETRIES) {
          // Re-fetch existing usernames and pick the next available
          const existing = await this.findUsernamesWithPrefix(base!);
          username = pickNextAvailable(base!, existing);
          continue;
        }

        if (isUniqueViolation) {
          // Graceful degradation: insert without a username
          log.warn(
            { userId: data.userId, attemptedBase: base, attempt },
            'Username generation exhausted retries, inserting without username'
          );
          const [profile] = await db
            .insert(expertProfiles)
            .values({
              userId: data.userId,
              verticalId: data.verticalId,
              type: data.type,
              applicationStatus: 'draft',
              username: null,
            })
            .returning();
          return profile!;
        }

        throw error;
      }
    }

    // Unreachable, but satisfies TypeScript
    throw new Error('Failed to create draft profile');
  },

  /** Update profile scalar fields */
  async updateProfile(expertProfileId: string, data: UpdateProfileInput): Promise<void> {
    await db
      .update(expertProfiles)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(expertProfiles.id, expertProfileId));
  },

  /** Sync languages: delete all then reinsert (transaction) */
  async syncLanguages(expertProfileId: string, languages: SyncLanguageInput[]): Promise<void> {
    await db.transaction(async (tx) => {
      await tx.delete(expertLanguages).where(eq(expertLanguages.expertProfileId, expertProfileId));

      if (languages.length > 0) {
        await tx.insert(expertLanguages).values(
          languages.map((l) => ({
            expertProfileId,
            languageId: l.languageId,
            proficiency: l.proficiency,
          }))
        );
      }
    });
  },

  /** Sync industries: delete all then reinsert (transaction) */
  async syncIndustries(expertProfileId: string, industryIds: string[]): Promise<void> {
    await db.transaction(async (tx) => {
      await tx
        .delete(expertIndustries)
        .where(eq(expertIndustries.expertProfileId, expertProfileId));

      if (industryIds.length > 0) {
        await tx.insert(expertIndustries).values(
          industryIds.map((id) => ({
            expertProfileId,
            industryId: id,
          }))
        );
      }
    });
  },

  /**
   * Sync selected products / competencies (Step 2).
   *
   * - Deletes competencies NOT in the new set (and their proficiency rows).
   * - Inserts new competencies with proficiency=0 for each support type.
   * - Leaves existing competencies + proficiency untouched.
   */
  async syncProducts(
    expertProfileId: string,
    productIds: string[],
    supportTypeIds: string[]
  ): Promise<void> {
    await db.transaction(async (tx) => {
      // 1. Find existing competency rows for this profile
      const existing = await tx.query.expertCompetency.findMany({
        where: eq(expertCompetency.expertProfileId, expertProfileId),
      });

      const existingProductIds = new Set(existing.map((e) => e.productId));

      // 2. Delete competencies that are no longer selected
      const toRemoveProductIds = [...existingProductIds].filter((id) => !productIds.includes(id));
      if (toRemoveProductIds.length > 0) {
        await tx
          .delete(expertCompetency)
          .where(
            and(
              eq(expertCompetency.expertProfileId, expertProfileId),
              inArray(expertCompetency.productId, toRemoveProductIds)
            )
          );
      }

      // 3. Insert new competencies (not yet in DB) with proficiency=0
      const newProductIds = productIds.filter((id) => !existingProductIds.has(id));
      if (newProductIds.length > 0) {
        const rows = newProductIds.flatMap((productId) =>
          supportTypeIds.map((supportTypeId) => ({
            expertProfileId,
            productId,
            supportTypeId,
            proficiency: 0,
          }))
        );
        await tx.insert(expertCompetency).values(rows);
      }
    });
  },

  /** Update competency proficiency ratings (Step 3). Uses upsert via ON CONFLICT. */
  async updateCompetencyProficiency(
    expertProfileId: string,
    ratings: CompetencyRatingInput[]
  ): Promise<void> {
    if (ratings.length === 0) return;

    // Batch upsert: for each rating, update proficiency on conflict
    await db.transaction(async (tx) => {
      for (const rating of ratings) {
        await tx
          .insert(expertCompetency)
          .values({
            expertProfileId,
            productId: rating.productId,
            supportTypeId: rating.supportTypeId,
            proficiency: rating.proficiency,
          })
          .onConflictDoUpdate({
            target: [
              expertCompetency.expertProfileId,
              expertCompetency.productId,
              expertCompetency.supportTypeId,
            ],
            set: {
              proficiency: rating.proficiency,
              updatedAt: new Date(),
            },
          });
      }
    });
  },

  /** Sync certifications: delete all then reinsert */
  async syncCertifications(expertProfileId: string, certs: SyncCertInput[]): Promise<void> {
    await db.transaction(async (tx) => {
      await tx
        .delete(expertCertifications)
        .where(eq(expertCertifications.expertProfileId, expertProfileId));

      if (certs.length > 0) {
        await tx.insert(expertCertifications).values(
          certs.map((c) => ({
            expertProfileId,
            certificationId: c.certificationId,
            earnedAt: c.earnedAt || null,
            expiresAt: c.expiresAt || null,
            credentialUrl: c.credentialUrl || null,
          }))
        );
      }
    });
  },

  /** Sync work history: delete all then reinsert with sortOrder */
  async syncWorkHistory(expertProfileId: string, entries: SyncWorkHistoryInput[]): Promise<void> {
    await db.transaction(async (tx) => {
      await tx.delete(workHistory).where(eq(workHistory.expertProfileId, expertProfileId));

      if (entries.length > 0) {
        await tx.insert(workHistory).values(
          entries.map((e, index) => ({
            expertProfileId,
            role: e.role,
            company: e.company,
            startedAt: new Date(e.startedAt),
            endedAt: e.endedAt ? new Date(e.endedAt) : null,
            isCurrent: e.isCurrent,
            responsibilities: e.responsibilities || null,
            sortOrder: index,
          }))
        );
      }
    });
  },

  /** Submit application: transition from draft to submitted */
  async submitApplication(expertProfileId: string): Promise<ExpertProfile> {
    const [profile] = await db
      .update(expertProfiles)
      .set({
        applicationStatus: 'submitted',
        submittedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(eq(expertProfiles.id, expertProfileId), eq(expertProfiles.applicationStatus, 'draft'))
      )
      .returning();

    if (!profile) {
      throw new Error('Application not found or already submitted');
    }

    return profile;
  },

  /** Approve application: transition from submitted to approved, set approvedAt */
  async approveApplication(expertProfileId: string): Promise<ExpertProfile> {
    const [profile] = await db
      .update(expertProfiles)
      .set({
        applicationStatus: 'approved',
        approvedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(expertProfiles.id, expertProfileId),
          eq(expertProfiles.applicationStatus, 'submitted')
        )
      )
      .returning();

    if (!profile) {
      throw new Error('Application not found or not in submitted status');
    }

    return profile;
  },
};

export type ProfileSettingsData = NonNullable<
  Awaited<ReturnType<typeof expertsRepository.findProfileForSettings>>
>;

export type PublicExpertProfile = NonNullable<
  Awaited<ReturnType<typeof expertsRepository.findPublicProfileByUsername>>
>;
