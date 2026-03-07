import { eq, and, inArray } from 'drizzle-orm';
import { db } from '../client';
import {
  expertProfiles,
  expertSkills,
  expertCertifications,
  expertLanguages,
  expertIndustries,
  workHistory,
  type ExpertProfile,
  type ExpertSkill,
  type ExpertCertification,
  type ExpertLanguage,
  type ExpertIndustry,
  type WorkHistory as WorkHistoryType,
} from '../schema';

// ── Input types ──────────────────────────────────────────────────

interface CreateDraftInput {
  userId: string;
  verticalId: string;
  type: 'freelancer' | 'agency';
}

interface UpdateProfileInput {
  yearStartedSalesforce?: number;
  projectCountMin?: number;
  projectLeadCountMin?: number;
  linkedinUrl?: string | null;
  trailheadUrl?: string | null;
  isSalesforceMvp?: boolean;
  isSalesforceCta?: boolean;
  isCertifiedTrainer?: boolean;
  searchable?: boolean;
  hourlyRate?: number;
}

interface SyncLanguageInput {
  languageId: string;
  proficiency: 'beginner' | 'intermediate' | 'advanced' | 'native';
}

interface SkillRatingInput {
  skillId: string;
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

export interface ApplicationSkillWithRelations extends ExpertSkill {
  skill: { id: string; name: string };
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
  skills: ApplicationSkillWithRelations[];
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
        skills: { with: { skill: true, supportType: true } },
        certifications: { with: { certification: true } },
        languages: { with: { language: true } },
        industries: { with: { industry: true } },
        workHistory: { orderBy: (wh, { asc }) => [asc(wh.sortOrder)] },
      },
    });

    if (!profile) return undefined;

    return {
      profile,
      skills: profile.skills as unknown as ApplicationSkillWithRelations[],
      certifications: profile.certifications as unknown as ApplicationCertWithRelations[],
      languages: profile.languages as unknown as ApplicationLanguageWithRelations[],
      industries: profile.industries as unknown as ApplicationIndustryWithRelations[],
      workHistory: profile.workHistory,
    };
  },

  /** Create initial draft profile */
  async createDraft(data: CreateDraftInput): Promise<ExpertProfile> {
    const [profile] = await db
      .insert(expertProfiles)
      .values({
        userId: data.userId,
        verticalId: data.verticalId,
        type: data.type,
        applicationStatus: 'draft',
      })
      .returning();
    return profile!;
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
   * Sync selected skills (Step 2).
   *
   * - Deletes skills NOT in the new set (and their proficiency rows).
   * - Inserts new skills with proficiency=0 for each support type.
   * - Leaves existing skills + proficiency untouched.
   */
  async syncSkills(
    expertProfileId: string,
    skillIds: string[],
    supportTypeIds: string[]
  ): Promise<void> {
    await db.transaction(async (tx) => {
      // 1. Find existing skill rows for this profile
      const existing = await tx.query.expertSkills.findMany({
        where: eq(expertSkills.expertProfileId, expertProfileId),
      });

      const existingSkillIds = new Set(existing.map((e) => e.skillId));

      // 2. Delete skills that are no longer selected
      const toRemoveSkillIds = [...existingSkillIds].filter((id) => !skillIds.includes(id));
      if (toRemoveSkillIds.length > 0) {
        await tx
          .delete(expertSkills)
          .where(
            and(
              eq(expertSkills.expertProfileId, expertProfileId),
              inArray(expertSkills.skillId, toRemoveSkillIds)
            )
          );
      }

      // 3. Insert new skills (not yet in DB) with proficiency=0
      const newSkillIds = skillIds.filter((id) => !existingSkillIds.has(id));
      if (newSkillIds.length > 0) {
        const rows = newSkillIds.flatMap((skillId) =>
          supportTypeIds.map((supportTypeId) => ({
            expertProfileId,
            skillId,
            supportTypeId,
            proficiency: 0,
          }))
        );
        await tx.insert(expertSkills).values(rows);
      }
    });
  },

  /** Update skill proficiency ratings (Step 3). Uses upsert via ON CONFLICT. */
  async updateSkillProficiency(
    expertProfileId: string,
    ratings: SkillRatingInput[]
  ): Promise<void> {
    if (ratings.length === 0) return;

    // Batch upsert: for each rating, update proficiency on conflict
    await db.transaction(async (tx) => {
      for (const rating of ratings) {
        await tx
          .insert(expertSkills)
          .values({
            expertProfileId,
            skillId: rating.skillId,
            supportTypeId: rating.supportTypeId,
            proficiency: rating.proficiency,
          })
          .onConflictDoUpdate({
            target: [
              expertSkills.expertProfileId,
              expertSkills.skillId,
              expertSkills.supportTypeId,
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
};
