/**
 * BAL-239 dev seeder — IMPURE orchestrator.
 *
 * Loads the live taxonomy, runs the pure generators, performs scoped hard
 * deletes + inserts inside a transaction, and (for availability) runs the
 * BAL-243 resolver AFTER the transaction commits.
 *
 * TWO-PHASE (mandatory): the resolver opens its OWN reads on the global `db`
 * outside our transaction. Calling it inside would read stale (pre-insert) data
 * and risk a postgres-js pool deadlock — so we commit rules/consultations
 * FIRST, then loop experts and resolve.
 */
import {
  db,
  users,
  expertProfiles,
  expertCompetency,
  expertLanguages,
  expertIndustries,
  availabilityRules,
  consultations,
  workHistory,
  expertCertifications,
  referenceDataRepository,
  asc,
  eq,
  and,
  like,
  type NewUser,
  type NewExpertProfile,
  type NewExpertCompetency,
  type NewExpertLanguage,
  type NewExpertIndustry,
  type NewAvailabilityRule,
  type NewConsultation,
  type NewWorkHistory,
  type NewExpertCertification,
} from '@balo/db';
import { createLogger } from '@balo/shared/logging';
import { resolveAndCacheAvailability } from '../availability/resolve-and-cache.js';
import { generateExperts } from './expert-generator.js';
import { generateAvailabilityPlan } from './availability-generator.js';
import { truncateSeedData } from './truncate.js';
import {
  DEFAULT_EXPERT_COUNT,
  DEFAULT_SEED,
  SEED_EMAIL_DOMAIN,
  SEED_WORKOS_PREFIX,
} from './constants.js';
import type {
  GeneratedExpert,
  RefreshSummary,
  RegenerateSummary,
  ResetSummary,
  SeedTaxonomy,
} from './types.js';

const log = createLogger('seed-service');

export interface RegenerateOptions {
  count?: number;
  seed?: number;
  baselineNow?: Date;
}

export interface RefreshOptions {
  seed?: number;
  baselineNow?: Date;
}

export interface ResetOptions {
  count?: number;
  seed?: number;
  baselineNow?: Date;
}

/** Load the live reference taxonomy. Throws loudly if products are empty. */
async function loadTaxonomy(): Promise<SeedTaxonomy> {
  const vertical = await referenceDataRepository.getSalesforceVertical();
  const [grouped, supportTypes, languages, industries, certGroups] = await Promise.all([
    referenceDataRepository.getProductsByVertical(vertical.id),
    referenceDataRepository.getSupportTypes(vertical.id),
    referenceDataRepository.getLanguages(),
    referenceDataRepository.getIndustries(),
    referenceDataRepository.getCertificationsByVertical(vertical.id),
  ]);

  const products = grouped.flatMap((g) => g.products.map((p) => ({ id: p.id, name: p.name })));
  const certificationIds = certGroups.flatMap((g) => g.certifications.map((c) => c.id));

  return {
    verticalId: vertical.id,
    products,
    supportTypeIds: supportTypes.map((st) => st.id),
    languages: languages.map((l) => ({ id: l.id, name: l.name })),
    industries: industries.map((i) => ({ id: i.id, name: i.name })),
    certificationIds,
  };
}

/** Insert one expert (user → profile → join rows) inside the transaction. */
async function insertExpert(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  expert: GeneratedExpert,
  verticalId: string,
  baselineNow: Date
): Promise<{
  competencies: number;
  languages: number;
  industries: number;
  workHistory: number;
  certifications: number;
}> {
  const userRow: NewUser = {
    workosId: expert.workosId,
    email: expert.email,
    emailVerified: true,
    firstName: expert.firstName,
    lastName: expert.lastName,
    activeMode: 'expert',
    timezone: expert.timezone,
    onboardingCompleted: true,
    status: 'active',
    createdAt: baselineNow,
    updatedAt: baselineNow,
  };
  const [insertedUser] = await tx.insert(users).values(userRow).returning({ id: users.id });
  const userId = insertedUser.id;

  const approvedAt = new Date(baselineNow.getTime() - expert.approvedOffsetMs);
  const profileRow: NewExpertProfile = {
    userId,
    verticalId,
    type: expert.type,
    headline: expert.headline,
    bio: expert.bio,
    username: expert.username,
    rateCents: expert.rateCents,
    availableForWork: true,
    searchable: true,
    yearStartedSalesforce: expert.yearStartedSalesforce,
    projectCountMin: expert.projectCountMin,
    projectLeadCountMin: expert.projectLeadCountMin,
    isSalesforceMvp: expert.isSalesforceMvp,
    isSalesforceCta: expert.isSalesforceCta,
    isCertifiedTrainer: expert.isCertifiedTrainer,
    applicationStatus: 'approved',
    submittedAt: approvedAt,
    approvedAt,
    timezone: expert.timezone,
    createdAt: baselineNow,
    updatedAt: baselineNow,
  };
  const [insertedProfile] = await tx
    .insert(expertProfiles)
    .values(profileRow)
    .returning({ id: expertProfiles.id });
  const expertProfileId = insertedProfile.id;

  if (expert.competencies.length > 0) {
    const competencyRows: NewExpertCompetency[] = expert.competencies.map((c) => ({
      expertProfileId,
      productId: c.productId,
      supportTypeId: c.supportTypeId,
      proficiency: c.proficiency,
    }));
    await tx.insert(expertCompetency).values(competencyRows);
  }

  if (expert.languages.length > 0) {
    const languageRows: NewExpertLanguage[] = expert.languages.map((l) => ({
      expertProfileId,
      languageId: l.languageId,
      proficiency: l.proficiency,
    }));
    await tx.insert(expertLanguages).values(languageRows);
  }

  if (expert.industryIds.length > 0) {
    const industryRows: NewExpertIndustry[] = expert.industryIds.map((industryId) => ({
      expertProfileId,
      industryId,
    }));
    await tx.insert(expertIndustries).values(industryRows);
  }

  if (expert.workHistory.length > 0) {
    const whRows: NewWorkHistory[] = expert.workHistory.map((w) => ({
      expertProfileId,
      role: w.role,
      company: w.company,
      // Date / Date|null → timestamptz columns.
      startedAt: w.startedAt,
      endedAt: w.endedAt,
      isCurrent: w.isCurrent,
      responsibilities: w.responsibilities,
      sortOrder: w.sortOrder,
    }));
    await tx.insert(workHistory).values(whRows);
  }

  if (expert.certifications.length > 0) {
    const certRows: NewExpertCertification[] = expert.certifications.map((c) => ({
      expertProfileId,
      certificationId: c.certificationId,
      // 'YYYY-MM-DD' string | null → date columns.
      earnedAt: c.earnedAt,
      expiresAt: c.expiresAt,
    }));
    await tx.insert(expertCertifications).values(certRows);
  }

  return {
    competencies: expert.competencies.length,
    languages: expert.languages.length,
    industries: expert.industryIds.length,
    workHistory: expert.workHistory.length,
    certifications: expert.certifications.length,
  };
}

/**
 * Wipe + regenerate all seed experts (destructive). Inserts users → profiles →
 * competencies/languages/industries inside a single transaction.
 */
export async function regenerateExperts(opts: RegenerateOptions = {}): Promise<RegenerateSummary> {
  const seed = opts.seed ?? DEFAULT_SEED;
  const count = opts.count ?? DEFAULT_EXPERT_COUNT;
  const baselineNow = opts.baselineNow ?? new Date();
  const startedAt = Date.now();

  log.info({ count, seed }, 'Seed: regenerate started');

  const taxonomy = await loadTaxonomy();
  const experts = generateExperts({ count, seed, taxonomy, baselineNow });

  let competenciesGenerated = 0;
  let languagesGenerated = 0;
  let industriesGenerated = 0;
  let workHistoryGenerated = 0;
  let certificationsGenerated = 0;

  await db.transaction(async (tx) => {
    await truncateSeedData(tx, 'experts');
    for (const expert of experts) {
      const counts = await insertExpert(tx, expert, taxonomy.verticalId, baselineNow);
      competenciesGenerated += counts.competencies;
      languagesGenerated += counts.languages;
      industriesGenerated += counts.industries;
      workHistoryGenerated += counts.workHistory;
      certificationsGenerated += counts.certifications;
    }
  });

  log.info(
    {
      expertsGenerated: experts.length,
      competenciesGenerated,
      languagesGenerated,
      industriesGenerated,
      workHistoryGenerated,
      certificationsGenerated,
      durationMs: Date.now() - startedAt,
    },
    'Seed: regenerate complete'
  );

  return {
    ok: true,
    expertsGenerated: experts.length,
    competenciesGenerated,
    languagesGenerated,
    industriesGenerated,
    workHistoryGenerated,
    certificationsGenerated,
    seedUsedRng: seed,
    baselineAt: baselineNow.toISOString(),
  };
}

/** The seed experts currently in the DB, in stable order, with their tz. */
async function loadSeedExperts(): Promise<{ id: string; index: number; timezone: string }[]> {
  const rows = await db
    .select({
      id: expertProfiles.id,
      timezone: expertProfiles.timezone,
      createdAt: expertProfiles.createdAt,
      email: users.email,
    })
    .from(expertProfiles)
    .innerJoin(users, eq(expertProfiles.userId, users.id))
    // Match the truncate predicate exactly: BOTH seed markers are required so a
    // partially-matching real dev user is never picked up. The seeder always
    // sets both, so genuine seed experts always match.
    .where(
      and(
        like(users.email, `%@${SEED_EMAIL_DOMAIN}`),
        like(users.workosId, `${SEED_WORKOS_PREFIX}%`)
      )
    )
    .orderBy(asc(expertProfiles.createdAt), asc(expertProfiles.id));

  // Re-derive a stable index from the deterministic email marker
  // (`expert{i}@…`) so archetype assignment matches the generation order even
  // when refresh runs independently of regenerate.
  return rows.map((row, fallbackIdx) => ({
    id: row.id,
    index: indexFromEmail(row.email) ?? fallbackIdx,
    timezone: row.timezone,
  }));
}

function indexFromEmail(email: string): number | null {
  const match = /^expert(\d+)@/.exec(email);
  if (!match) return null;
  const n = Number.parseInt(match[1], 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Refresh availability for all seed experts (destructive on rules/cache/
 * consultations). Seeds rules + consultations in a transaction, COMMITS, then
 * runs the resolver per expert with the in-memory busy fixture.
 */
export async function refreshAvailability(opts: RefreshOptions = {}): Promise<RefreshSummary> {
  const seed = opts.seed ?? DEFAULT_SEED;
  const baselineNow = opts.baselineNow ?? new Date();

  log.info({ baselineAt: baselineNow.toISOString(), seed }, 'Seed: refresh availability started');

  const experts = await loadSeedExperts();
  const plans = generateAvailabilityPlan({ experts, seed, baselineNow });

  let availabilityRulesGenerated = 0;
  let consultationsSeeded = 0;
  let consultationsCancelled = 0;

  // ── Phase 1: truncate + insert, then COMMIT ──────────────────────
  await db.transaction(async (tx) => {
    await truncateSeedData(tx, 'availability');

    for (const plan of plans) {
      if (plan.rules.length > 0) {
        const ruleRows: NewAvailabilityRule[] = plan.rules.map((r) => ({
          expertProfileId: plan.expertProfileId,
          dayOfWeek: r.dayOfWeek,
          startTime: r.startTime,
          endTime: r.endTime,
        }));
        await tx.insert(availabilityRules).values(ruleRows);
        availabilityRulesGenerated += ruleRows.length;
      }

      if (plan.consultations.length > 0) {
        const consultRows: NewConsultation[] = plan.consultations.map((c) => ({
          expertProfileId: plan.expertProfileId,
          startAt: c.startAt,
          endAt: c.endAt,
          status: c.status,
        }));
        await tx.insert(consultations).values(consultRows);
        for (const c of plan.consultations) {
          if (c.status === 'cancelled') consultationsCancelled += 1;
          else consultationsSeeded += 1;
        }
      }
    }
  });

  // ── Phase 2: resolve per expert AFTER commit ─────────────────────
  let cacheRowsWritten = 0;
  let expertsWithEarliest = 0;
  let expertsNullEarliest = 0;

  for (const plan of plans) {
    const { earliestAvailableAt } = await resolveAndCacheAvailability(plan.expertProfileId, {
      busyBlocks: plan.busyBlocks,
      now: baselineNow,
    });
    cacheRowsWritten += 1;
    if (earliestAvailableAt) expertsWithEarliest += 1;
    else expertsNullEarliest += 1;
  }

  log.info(
    {
      rules: availabilityRulesGenerated,
      consultations: consultationsSeeded,
      consultationsCancelled,
      cacheRows: cacheRowsWritten,
      expertsWithEarliest,
      expertsNullEarliest,
    },
    'Seed: refresh availability complete'
  );

  return {
    ok: true,
    availabilityRulesGenerated,
    consultationsSeeded,
    consultationsCancelled,
    cacheRowsWritten,
    expertsWithEarliest,
    expertsNullEarliest,
    baselineAt: baselineNow.toISOString(),
    seedUsedRng: seed,
  };
}

/** Full reset: regenerate experts then refresh availability with same inputs. */
export async function fullReset(opts: ResetOptions = {}): Promise<ResetSummary> {
  const seed = opts.seed ?? DEFAULT_SEED;
  const baselineNow = opts.baselineNow ?? new Date();
  const count = opts.count ?? DEFAULT_EXPERT_COUNT;

  const experts = await regenerateExperts({ count, seed, baselineNow });
  const availability = await refreshAvailability({ seed, baselineNow });

  return { ok: true, experts, availability };
}
