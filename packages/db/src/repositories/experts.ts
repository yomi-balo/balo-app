import { eq, and, not, inArray, or, like, isNotNull, sql } from 'drizzle-orm';
import { createLogger } from '@balo/shared/logging';
import { type Database, db } from '../client';
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

/**
 * Either the base Drizzle client or an in-flight transaction handle. Lets a method
 * compose under a parent `db.transaction` (executor supplied) while still
 * self-wrapping when called standalone (executor omitted → defaults to `db`).
 * Matches the `DbTx` precedent in `proposal-milestones.ts` /
 * `proposal-payment-installments.ts`, extended to also accept the base client.
 */
type DbExecutor = Database | Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * True for a Postgres unique-violation (SQLSTATE `23505`); optionally for a
 * specific constraint / index name. postgres-js surfaces `.code` ('23505'), the
 * violated index on `.constraint_name`, and includes the index name in `.message`.
 * Structural narrowing — no `any`, no assertion. Used by both the repository (to
 * preserve the username-index retry loop while letting the user/vertical conflict
 * be swallowed by ON CONFLICT) and the action (to classify `error_code`).
 */
export function isUniqueViolation(error: unknown, constraintName?: string): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = 'code' in error ? error.code : undefined;
  const message = 'message' in error && typeof error.message === 'string' ? error.message : '';
  const constraint =
    'constraint_name' in error && typeof error.constraint_name === 'string'
      ? error.constraint_name
      : '';

  const isUnique = code === '23505' || message.includes('duplicate key value');
  if (!isUnique) return false;
  if (constraintName === undefined) return true;
  return constraint === constraintName || message.includes(constraintName);
}

// ── Private executor-threaded sync bodies ────────────────────────
// Each runs its delete-then-reinsert directly on the passed executor (a parent
// `tx` or a self-opened `tx`), so the public methods can either compose under one
// parent transaction or self-wrap for standalone atomicity.

async function syncLanguagesTx(
  exec: DbExecutor,
  expertProfileId: string,
  languages: SyncLanguageInput[]
): Promise<void> {
  await exec.delete(expertLanguages).where(eq(expertLanguages.expertProfileId, expertProfileId));

  if (languages.length > 0) {
    await exec.insert(expertLanguages).values(
      languages.map((l) => ({
        expertProfileId,
        languageId: l.languageId,
        proficiency: l.proficiency,
      }))
    );
  }
}

async function syncIndustriesTx(
  exec: DbExecutor,
  expertProfileId: string,
  industryIds: string[]
): Promise<void> {
  await exec.delete(expertIndustries).where(eq(expertIndustries.expertProfileId, expertProfileId));

  if (industryIds.length > 0) {
    await exec.insert(expertIndustries).values(
      industryIds.map((id) => ({
        expertProfileId,
        industryId: id,
      }))
    );
  }
}

async function syncCertificationsTx(
  exec: DbExecutor,
  expertProfileId: string,
  certs: SyncCertInput[]
): Promise<void> {
  await exec
    .delete(expertCertifications)
    .where(eq(expertCertifications.expertProfileId, expertProfileId));

  if (certs.length > 0) {
    await exec.insert(expertCertifications).values(
      certs.map((c) => ({
        expertProfileId,
        certificationId: c.certificationId,
        earnedAt: c.earnedAt || null,
        expiresAt: c.expiresAt || null,
        credentialUrl: c.credentialUrl || null,
      }))
    );
  }
}

/** Single draft lookup by the `(user_id, vertical_id)` unique key. */
async function findByUserVertical(
  exec: DbExecutor,
  userId: string,
  verticalId: string
): Promise<ExpertProfile | undefined> {
  return exec.query.expertProfiles.findFirst({
    where: and(eq(expertProfiles.userId, userId), eq(expertProfiles.verticalId, verticalId)),
  });
}

/**
 * Insert a draft idempotently on `(user_id, vertical_id)`. Returns the inserted
 * row, or — when the conflict was swallowed by `onConflictDoNothing` (a concurrent
 * / retried first-save won the race) — the adopted winner row. Throws only in the
 * pathological case where the conflict fired but no row is found on refetch. A
 * username-index collision is NOT the ON CONFLICT target, so it propagates as a
 * throw for the caller's retry loop.
 */
async function insertDraftOrAdopt(
  exec: DbExecutor,
  data: CreateDraftInput,
  username: string | null
): Promise<ExpertProfile> {
  const [profile] = await exec
    .insert(expertProfiles)
    .values({
      userId: data.userId,
      verticalId: data.verticalId,
      type: data.type,
      applicationStatus: 'draft',
      username,
    })
    .onConflictDoNothing({ target: [expertProfiles.userId, expertProfiles.verticalId] })
    .returning();

  if (profile) return profile;

  const winner = await findByUserVertical(exec, data.userId, data.verticalId);
  if (winner) return winner;

  log.warn(
    { userId: data.userId, verticalId: data.verticalId },
    'findOrCreateDraft: ON CONFLICT swallowed insert but no row found on refetch'
  );
  throw new Error('Failed to find or create draft profile');
}

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

/**
 * Profile-step write shape passed to `saveProfileStep`. Scalars are optional (a
 * half-filled DRAFT may omit them); the junction arrays may be empty. The
 * languages/industries are ALWAYS sent (replace-all semantics) so an empty array
 * clears the set.
 */
export interface ProfileStepWrite {
  yearStartedSalesforce?: number;
  projectCountMin?: number;
  projectLeadCountMin?: number;
  linkedinUrl?: string | null;
  isSalesforceMvp?: boolean;
  isSalesforceCta?: boolean;
  isCertifiedTrainer?: boolean;
  languages: SyncLanguageInput[];
  industryIds: string[];
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
   * BAL-356: link an expert draft/profile to its payout agency by setting
   * `agency_id`. A single UPDATE — `expert_profiles` has no `deletedAt`, so only a
   * not-found guard applies (no soft-delete predicate). Executor-aware: the three
   * agency-resolution write paths (join / provision / solo) call this INSIDE their
   * `db.transaction`, so the link commits or rolls back with the agency + membership
   * writes. Throws when no row matches so the orchestrating tx rolls back rather
   * than silently linking a phantom profile.
   */
  async linkAgency(
    expertProfileId: string,
    agencyId: string,
    executor?: DbExecutor
  ): Promise<void> {
    const exec = executor ?? db;
    const [row] = await exec
      .update(expertProfiles)
      .set({ agencyId, updatedAt: new Date() })
      .where(eq(expertProfiles.id, expertProfileId))
      .returning({ id: expertProfiles.id });
    if (row === undefined) {
      throw new Error(`Expert profile not found: ${expertProfileId}`);
    }
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

  /**
   * Minimal lookup for the notification engine: the expert's underlying user id.
   * Used by the resolver to hydrate the `expert` recipient from an
   * `expertProfileId` (e.g. `project.request_submitted`). Returns undefined when
   * the profile doesn't exist so the resolver can short-circuit.
   */
  async findUserIdByProfileId(
    expertProfileId: string
  ): Promise<{ user: { id: string } } | undefined> {
    const row = await db.query.expertProfiles.findFirst({
      where: eq(expertProfiles.id, expertProfileId),
      columns: {},
      with: { user: { columns: { id: true } } },
    });
    return row ? { user: { id: row.user.id } } : undefined;
  },

  /**
   * Batch counterpart of `findUserIdByProfileId` for notification fan-out
   * (BAL-289): maps a set of `expertProfileId`s to their underlying user ids in
   * one query. Mirrors the single read's join shape (expert_profiles → user).
   * Unknown ids are silently skipped and the result is de-duplicated, so the
   * returned array may be shorter than `profileIds`. Returns `[]` without
   * touching the DB for empty input.
   *
   * Soft-deleted users are excluded: a deleted expert's user must never be
   * notified. `expert_profiles` has no `deletedAt`, so the filter is on the
   * joined USER row (`user.deletedAt IS NULL`).
   */
  async findUserIdsByProfileIds(profileIds: string[]): Promise<string[]> {
    if (profileIds.length === 0) return [];
    const rows = await db.query.expertProfiles.findMany({
      where: inArray(expertProfiles.id, profileIds),
      columns: {},
      with: { user: { columns: { id: true, deletedAt: true } } },
    });
    return [
      ...new Set(rows.filter((row) => row.user.deletedAt === null).map((row) => row.user.id)),
    ];
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

  /**
   * Create initial draft profile, auto-generating a username from first/last name.
   * Behaviour-preserving wrapper over `findOrCreateDraft` (kept for factories and
   * existing callers): `findOrCreateDraft` short-circuits to an existing
   * `(user_id, vertical_id)` row when present, and otherwise inserts idempotently —
   * so first-create is unchanged while a duplicate create no longer throws.
   */
  async createDraft(data: CreateDraftInput): Promise<ExpertProfile> {
    return this.findOrCreateDraft(data);
  },

  /**
   * Idempotent draft creation, safe under retries / orphans / concurrent
   * first-saves. Never throws on `expert_user_vertical_idx` (the
   * `(user_id, vertical_id)` unique index):
   *
   * 1. SELECT-existing-first short-circuit on `(user_id, vertical_id)` — adopts an
   *    orphan or prior draft with NO insert (so it never touches the username
   *    index). This is the dominant retry/idempotency path.
   * 2. Otherwise generate a username and `INSERT ... ON CONFLICT (user_id,
   *    vertical_id) DO NOTHING RETURNING`. A username-index collision is NOT the
   *    ON CONFLICT target, so it still throws → caught by the preserved MAX_RETRIES
   *    loop (re-pick next available username), with a final null-username fallback.
   * 3. If the insert returned no row (lost a `(user_id, vertical_id)` race — the
   *    conflict was swallowed), refetch and return the winner's row; if STILL none
   *    (pathological), log + throw so callers surface a generic failure.
   *
   * Accepts an optional executor so `saveProfileStep` can create the row INSIDE its
   * transaction (a later-step failure then rolls the row back too — no orphan).
   */
  async findOrCreateDraft(data: CreateDraftInput, executor?: DbExecutor): Promise<ExpertProfile> {
    const exec = executor ?? db;

    // 1. Short-circuit: adopt an existing (orphan / prior) draft.
    const existing = await findByUserVertical(exec, data.userId, data.verticalId);
    if (existing) return existing;

    // 2. Generate a username and insert idempotently on (user_id, vertical_id).
    const base = generateBaseUsername(data.firstName, data.lastName);
    let username =
      base === null ? null : pickNextAvailable(base, await this.findUsernamesWithPrefix(base));

    // Up to MAX_RETRIES username re-picks; if all collide, one final attempt with a
    // null username (graceful degradation, mirrors the prior createDraft behaviour).
    const MAX_RETRIES = 3;
    let usernameRetries = 0;
    for (;;) {
      try {
        return await insertDraftOrAdopt(exec, data, username);
      } catch (error: unknown) {
        // A (user_id, vertical_id) conflict is swallowed by onConflictDoNothing (not
        // thrown), so we never throw on `expert_user_vertical_idx`. The only retryable
        // throw is a username-index collision against a non-null username we set.
        if (base === null || username === null) throw error;
        if (!isUniqueViolation(error, 'expert_profiles_username_idx')) throw error;

        if (usernameRetries >= MAX_RETRIES) {
          // Exhausted re-picks: degrade to a null username and try once more.
          log.warn(
            { userId: data.userId, attemptedBase: base, attempts: usernameRetries },
            'Username generation exhausted retries, inserting without username'
          );
          username = null;
          continue;
        }
        usernameRetries++;
        username = pickNextAvailable(base, await this.findUsernamesWithPrefix(base));
      }
    }
  },

  /**
   * Load a profile row by id within a transaction. Used by `saveProfileStep` on the
   * existing-id path (ownership already verified by the caller). Throws if the row
   * is missing so the orchestrating transaction rolls back rather than writing
   * children for a phantom profile.
   */
  async loadProfileTx(tx: DbExecutor, expertProfileId: string): Promise<ExpertProfile> {
    const profile = await tx.query.expertProfiles.findFirst({
      where: eq(expertProfiles.id, expertProfileId),
    });
    if (!profile) {
      throw new Error('Expert profile not found');
    }
    return profile;
  },

  /**
   * Resolve the profile for `saveProfileStep` within the transaction: load by id
   * when provided (existing draft), else find-or-create from `draftInput`. Throws
   * when neither an id nor a `draftInput` is supplied.
   */
  async resolveProfileTx(
    tx: DbExecutor,
    expertProfileId: string | undefined,
    draftInput: CreateDraftInput | undefined
  ): Promise<ExpertProfile> {
    if (expertProfileId) {
      return this.loadProfileTx(tx, expertProfileId);
    }
    if (!draftInput) {
      throw new Error('saveProfileStep requires either an expertProfileId or a draftInput');
    }
    return this.findOrCreateDraft(draftInput, tx);
  },

  /**
   * Single-transaction profile-step orchestrator (BAL-298). Runs find-or-create +
   * `updateProfile` + `syncLanguages` + `syncIndustries` in ONE `db.transaction`.
   * When `expertProfileId` is omitted, the row is created INSIDE the same tx, so a
   * failure in any later step (e.g. an invalid industry FK) rolls the just-inserted
   * `expert_profiles` row back too — leaving NO orphan row and NO partial children.
   * When an id is provided, the row predates the tx and correctly survives (only
   * this step's child writes roll back). `draftInput` is required ONLY for the
   * create path (no id); pass it when `expertProfileId` is omitted. Returns the
   * resolved profile (full row when created; the loaded row when an id was provided).
   */
  async saveProfileStep(
    expertProfileId: string | undefined,
    draftInput: CreateDraftInput | undefined,
    data: ProfileStepWrite
  ): Promise<ExpertProfile> {
    return db.transaction(async (tx) => {
      const profile = await this.resolveProfileTx(tx, expertProfileId, draftInput);

      await this.updateProfile(
        profile.id,
        {
          yearStartedSalesforce: data.yearStartedSalesforce,
          projectCountMin: data.projectCountMin,
          projectLeadCountMin: data.projectLeadCountMin,
          linkedinUrl: data.linkedinUrl,
          isSalesforceMvp: data.isSalesforceMvp,
          isSalesforceCta: data.isSalesforceCta,
          isCertifiedTrainer: data.isCertifiedTrainer,
        },
        tx
      );
      await this.syncLanguages(profile.id, data.languages, tx);
      await this.syncIndustries(profile.id, data.industryIds, tx);

      return profile;
    });
  },

  /**
   * Single-transaction certifications-step orchestrator (BAL-298). Runs the
   * trailhead-URL `updateProfile` + `syncCertifications` in ONE `db.transaction` so
   * a half-applied certifications save can't occur — the same write-atomicity
   * principle as `saveProfileStep`. The row must already exist (the wizard always
   * saves the profile step first).
   */
  async saveCertificationsStep(
    expertProfileId: string,
    trailheadUrl: string | null,
    certs: SyncCertInput[]
  ): Promise<void> {
    await db.transaction(async (tx) => {
      await this.updateProfile(expertProfileId, { trailheadUrl }, tx);
      await this.syncCertifications(expertProfileId, certs, tx);
    });
  },

  /**
   * Update profile scalar fields. Executor-aware: composes under a parent
   * transaction when one is supplied (e.g. `saveProfileStep`), else uses the base
   * client. A single UPDATE is atomic on its own, so no standalone wrapping is
   * needed.
   */
  async updateProfile(
    expertProfileId: string,
    data: UpdateProfileInput,
    executor?: DbExecutor
  ): Promise<void> {
    const exec = executor ?? db;
    await exec
      .update(expertProfiles)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(expertProfiles.id, expertProfileId));
  },

  /**
   * Sync languages: delete all then reinsert. Executor-aware — runs inline on a
   * supplied parent transaction (one flat atomic unit with the rest of the
   * profile-step) and self-wraps in `db.transaction` when called standalone.
   */
  async syncLanguages(
    expertProfileId: string,
    languages: SyncLanguageInput[],
    executor?: DbExecutor
  ): Promise<void> {
    if (executor) {
      await syncLanguagesTx(executor, expertProfileId, languages);
      return;
    }
    await db.transaction((tx) => syncLanguagesTx(tx, expertProfileId, languages));
  },

  /**
   * Sync industries: delete all then reinsert. Executor-aware (see
   * `syncLanguages`).
   */
  async syncIndustries(
    expertProfileId: string,
    industryIds: string[],
    executor?: DbExecutor
  ): Promise<void> {
    if (executor) {
      await syncIndustriesTx(executor, expertProfileId, industryIds);
      return;
    }
    await db.transaction((tx) => syncIndustriesTx(tx, expertProfileId, industryIds));
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

  /**
   * Sync certifications: delete all then reinsert. Executor-aware so the
   * certifications step can run `updateProfile` (trailhead URL) + this sync inside
   * one transaction for write-atomicity, while standalone callers (settings) keep
   * self-wrapping.
   */
  async syncCertifications(
    expertProfileId: string,
    certs: SyncCertInput[],
    executor?: DbExecutor
  ): Promise<void> {
    if (executor) {
      await syncCertificationsTx(executor, expertProfileId, certs);
      return;
    }
    await db.transaction((tx) => syncCertificationsTx(tx, expertProfileId, certs));
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
