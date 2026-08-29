/**
 * BAL-239 dev seeder — IMPURE orchestrator.
 *
 * Loads the live taxonomy, runs the pure generators, performs scoped hard
 * deletes + inserts inside a transaction, and (for availability) runs the
 * BAL-243 resolver AFTER the transaction commits.
 *
 * ⚠ THREE-PHASE SINCE BAL-428 (it was two). Each boundary is mandatory for a DIFFERENT
 * reason, and collapsing either one breaks something:
 *
 *   1. TRUNCATE + RULES, in ONE transaction. Destructive, so it is atomic.
 *   2. BOOK THE CONSULTATIONS, OUTSIDE any transaction. `consultations` is now a READ
 *      MODEL of `meetings` with a NOT NULL `meeting_id`, so a seeded booking has to go
 *      through `meetingsRepository.create` — and that method opens its OWN
 *      `db.transaction`. Calling it from inside phase 1's transaction would take a SECOND
 *      connection from the pool and commit the booking independently of the truncate,
 *      which is neither atomic nor safe. Same for `caseEngagementsRepository.create`.
 *   3. RESOLVE per expert. The resolver opens its own reads on the global `db`; calling it
 *      earlier would read pre-insert data and risk a postgres-js pool deadlock.
 *
 * ⚠ THE SEEDER CALLS `meetingsRepository` DIRECTLY, NOT `services/meetings/
 * meeting-availability.ts`, AND THAT IS DELIBERATE. That service exists to enqueue a BullMQ
 * availability-cache rebuild post-commit — which is exactly what phase 3 does here instead,
 * synchronously and with the in-memory `busyBlocks` fixture that a queued job could not
 * reproduce. Routing the seeder through the service would fire ONE REDUNDANT REBUILD JOB PER
 * SEEDED FIXTURE (every `create` and every `cancel`, so it scales with the expert count),
 * each recomputing the cache WITHOUT the busy fixture and racing phase 3 to overwrite it.
 * The seeder is the one legitimate caller that discharges the post-commit obligation itself.
 */
import {
  db,
  users,
  expertProfiles,
  expertCompetency,
  expertLanguages,
  expertIndustries,
  availabilityRules,
  companies,
  workHistory,
  expertCertifications,
  caseEngagementsRepository,
  meetingsRepository,
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
  SEED_COMPANY_NAME,
  SEED_COMPANY_SLUG,
  SEED_ENGAGEMENT_DESCRIPTION,
  seedEngagementTitle,
  SEED_EMAIL_DOMAIN,
  SEED_WORKOS_PREFIX,
} from './constants.js';
import type {
  AvailabilityPlan,
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
 * BAL-428 — the client company every seeded booking hangs off. Keyed on the UNIQUE
 * `companies.slug`, so a `refresh` that runs without a preceding `regenerate` adopts the
 * existing row instead of failing `23505` or minting a duplicate.
 *
 * The INSERT carries `onConflictDoNothing` on that unique rather than trusting the SELECT
 * above it: check-then-insert is a TOCTOU window, and two concurrent seed runs (two browser
 * tabs on the `/dev` panel is all it takes) would otherwise have one die on `23505`. With
 * the conflict clause the loser gets zero rows back and re-reads the winner's row — which is
 * why the fallback SELECT below is not redundant.
 *
 * ⚠ NO `company_members` ROW IS CREATED, DELIBERATELY, and it has a visible consequence.
 * Capability is derived from membership (ADR-1029), so NO user holds any capability on this
 * company: its seeded case engagements are invisible and unactionable in the client UI, and
 * `caseEngagementsRepository.close({ userId })` can never succeed for them
 * (`CaseCloserNotMemberError`). Acceptable because these fixtures exist ONLY to make a
 * meeting's expert resolvable for the availability projection — nobody is meant to act on
 * them. If a future fixture must be actionable, add the membership rows THEN, knowingly.
 *
 * `isPersonal: false` because this is a shared workspace standing in for a client org, not
 * one user's private space — and because `isPersonal` is the flag BAL-345's (inert) domain
 * auto-join keys off. No `domain` is set at all; see `SEED_COMPANY_SLUG`'s docblock.
 */
async function ensureSeedCompanyId(): Promise<string> {
  const [existing] = await db
    .select({ id: companies.id })
    .from(companies)
    .where(eq(companies.slug, SEED_COMPANY_SLUG))
    .limit(1);
  if (existing !== undefined) return existing.id;

  const [created] = await db
    .insert(companies)
    .values({ name: SEED_COMPANY_NAME, slug: SEED_COMPANY_SLUG, isPersonal: false })
    .onConflictDoNothing({ target: companies.slug })
    .returning({ id: companies.id });
  if (created !== undefined) return created.id;

  // Lost the race — a concurrent seed run committed first. Adopt its row.
  const [winner] = await db
    .select({ id: companies.id })
    .from(companies)
    .where(eq(companies.slug, SEED_COMPANY_SLUG))
    .limit(1);
  if (winner === undefined) {
    throw new Error('Seed: failed to create or adopt the seed company');
  }
  return winner.id;
}

/** What phase 2 actually wrote, for the summary the /dev panel renders. */
interface BookedSeedSlots {
  consultationsSeeded: number;
  consultationsCancelled: number;
}

/**
 * BAL-428 PHASE 2 — BOOK the generated slots as real meetings.
 *
 * Before BAL-428 this was one bulk `INSERT INTO consultations`. It cannot be any more:
 * `consultations` is a READ MODEL of the meeting lifecycle with a NOT NULL `meeting_id`,
 * and its ONLY writer is the projection driven from `meetingsRepository`. A seeded slot is
 * therefore a real booking graph — company → case engagement → meeting → `meeting_contexts`
 * row → projection — resolved through exactly the seam a production booking will use.
 *
 * ⚠ THAT IS THE POINT, NOT AN INCONVENIENCE. `meetingsRepository.create` still has no
 * production caller, so this seeder is the only thing in the repository that exercises the
 * new write path end to end. If expert resolution through the context seam breaks, `pnpm
 * db:seed` breaks — loudly, on a developer's machine, rather than silently in the first
 * booking.
 *
 * ONE case engagement per expert WITH slots (not per expert): an expert whose archetype
 * generated no consultations needs no engagement, and minting one would put an engagement
 * with no meetings on the /dev panel for no reason.
 *
 * A `cancelled` fixture is BOOKED FIRST, THEN CANCELLED — the same two steps a real
 * cancellation takes — so the projection ends up `status='cancelled'` via
 * `cancelProjectionTx` rather than being written cancelled from nothing. That is what makes
 * the seeder's booked-then-cancelled edge case a genuine rehearsal of BAL-410's path — which
 * has since SHIPPED, so this is now a rehearsal of a live route's repository half (the seeder
 * deliberately does NOT go through `cancelMeeting`: that would enqueue an availability rebuild
 * and, worse, a route-level publish would email real people on every `pnpm db:seed`).
 *
 * ⚠ RUNS OUTSIDE ANY TRANSACTION. Both repositories open their own; see the module
 * docblock. A failure part-way therefore leaves a partially-booked seed set, which the next
 * run truncates. That is acceptable for a dev seeder and is why the destructive part
 * (phase 1) is the part that stayed atomic.
 */
async function bookSeedConsultations(
  plans: AvailabilityPlan[],
  companyId: string
): Promise<BookedSeedSlots> {
  let consultationsSeeded = 0;
  let consultationsCancelled = 0;

  for (const plan of plans) {
    if (plan.consultations.length === 0) continue;

    // `CaseEngagementRow.id` IS the supertype `engagements.id` — the value
    // `meeting_contexts.context_id` must carry for a `case` context to resolve.
    const engagement = await caseEngagementsRepository.create({
      companyId,
      expertProfileId: plan.expertProfileId,
      title: seedEngagementTitle(plan.index),
      // Already-sanitised HTML: `@balo/db` never sanitises (BAL-417 D8), the caller does.
      description: SEED_ENGAGEMENT_DESCRIPTION,
      // No `actorUserId`: there is no human behind a seed run (the ADR-1030 system-actor
      // attribution exemption), and inventing one would be a fabricated attribution.
    });

    for (const slot of plan.consultations) {
      const created = await meetingsRepository.create({
        scheduledStart: slot.startAt,
        scheduledEnd: slot.endAt,
        contexts: [{ contextType: 'case', contextId: engagement.id }],
        // No `actorUserId`, for the same reason as the `caseEngagementsRepository.create`
        // above: no human is behind a seed run, so the `meeting.booked` audit row is
        // UNATTRIBUTED (the ADR-1030 system-actor exemption) rather than naming a fabricated
        // booker. `audit_events.actor_user_id` is a nullable FK, so this is representable.
      });

      if (created.expertProfileId !== plan.expertProfileId) {
        // Unreachable: the engagement was just created FOR this expert. Asserted anyway
        // because a silent mismatch here means the seeder blocked somebody else's calendar.
        throw new Error(
          `Seed: meeting ${created.meeting.id} booked ${created.expertProfileId ?? 'nobody'}, expected ${plan.expertProfileId}`
        );
      }

      if (slot.status === 'cancelled') {
        // ⚠ `{ actorUserId: null, actorRole: 'system' }` — the sanctioned ADR-1030 SYSTEM-ACTOR
        // ATTRIBUTION EXEMPTION (BAL-410). The seeder has no human to name, so the
        // `meeting.cancelled` audit row is written UNATTRIBUTED rather than with a fabricated
        // actor, exactly as `recordMeetingBooked` is called from this same seeder.
        await meetingsRepository.cancel(created.meeting.id, {
          actorUserId: null,
          actorRole: 'system',
        });
        consultationsCancelled += 1;
      } else {
        consultationsSeeded += 1;
      }
    }
  }

  return { consultationsSeeded, consultationsCancelled };
}

/**
 * Refresh availability for all seed experts (destructive on rules/cache/bookings). Seeds
 * rules in a transaction and COMMITS, books the consultations as meetings, then runs the
 * resolver per expert with the in-memory busy fixture. See the module docblock for why
 * those three phases cannot be merged.
 */
export async function refreshAvailability(opts: RefreshOptions = {}): Promise<RefreshSummary> {
  const seed = opts.seed ?? DEFAULT_SEED;
  const baselineNow = opts.baselineNow ?? new Date();

  log.info({ baselineAt: baselineNow.toISOString(), seed }, 'Seed: refresh availability started');

  const experts = await loadSeedExperts();
  const plans = generateAvailabilityPlan({ experts, seed, baselineNow });

  let availabilityRulesGenerated = 0;

  // ── Phase 1: truncate + insert rules, then COMMIT ────────────────
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
    }
  });

  // ── Phase 2: book the slots as meetings AFTER commit ─────────────
  const companyId = await ensureSeedCompanyId();
  const { consultationsSeeded, consultationsCancelled } = await bookSeedConsultations(
    plans,
    companyId
  );

  // ── Phase 3: resolve per expert AFTER the bookings commit ────────
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
