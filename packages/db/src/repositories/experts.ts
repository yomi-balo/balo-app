import {
  eq,
  and,
  asc,
  desc,
  gte,
  lte,
  not,
  inArray,
  or,
  like,
  isNotNull,
  isNull,
  sql,
  type SQL,
} from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { createLogger } from '@balo/shared/logging';
import { parseRatingAverage } from '@balo/shared/reviews';
import { type Database, db } from '../client';
import { auditEventsRepository } from './audit-events';
import { consultationCountExpression } from './_shared/consultation-count';
import {
  expertProfiles,
  expertCompetency,
  expertCertifications,
  expertLanguages,
  expertIndustries,
  workHistory,
  users,
  agencies,
  type ApplicationStatus,
  type ExpertDeclineReason,
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
  // CHEAP-3 (fix round 1) — deliberately NOT a field here. `expert_profiles.searchable` has
  // exactly ONE writer outside seeds:
  // `expertSearchabilityRepository.applySearchable`'s conditional compare-and-set
  // (`packages/db/src/repositories/expert-searchability.ts`) — the docblock there names the
  // forbidden "fixes" this field would have reopened. Removing it here makes the compiler
  // enforce the invariant instead of leaving it convention-only.
  rateCents?: number;
  // Calendar / booking-rule writes (BAL-234). `timezone` write is net-new here —
  // the schedule editor persists the expert's own tz alongside the booking rules.
  timezone?: string;
  bookingBufferBeforeMinutes?: number;
  bookingBufferAfterMinutes?: number;
  bookingMinimumNoticeMinutes?: number;
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

/**
 * BAL-549 — the applicant, NARROWED. Ten columns, and `workosId` is structurally absent: a bare
 * `with: { user: true }` would hydrate the identity-provider key, `emailVerified`,
 * `phoneVerifiedAt`, `platformRole` and `activeCompanyId` into a read that has no use for any of
 * them. Widen this interface only alongside the `columns` narrowing it mirrors.
 */
export interface ApplicationApplicant {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string;
  avatarUrl: string | null;
  phone: string | null;
  timezone: string | null;
  country: string | null;
  countryCode: string | null;
  deletedAt: Date | null;
}

/** BAL-549 — the agency an applicant is applying under. `stripeConnectId` is excluded. */
export interface ApplicationAgency {
  id: string;
  name: string;
  slug: string | null;
  logoUrl: string | null;
}

/**
 * BAL-549 FIX ROUND (F1) — THE APPLICANT-SAFE `expert_profiles` PROJECTION.
 *
 * ⚠⚠ THIS READ IS THE APPLICANT'S OWN (`(apply)/expert/apply/_actions/load-draft.ts` feeds it
 * straight into `expert-application-wizard.tsx`, a `'use client'` boundary, so every column on
 * it is serialised into the applicant's browser-visible RSC flight payload). Before the fix the
 * top-level select carried NO `columns:` at all, so `decline_note` — staff-only free text —
 * reached the declined applicant the decline email actively sends back to `/expert/apply`.
 *
 * OMITTED, AND WHY:
 *  - `declineNote` — staff-only. Its ONE read is {@link expertsRepository.findApplicationForStaffReview}.
 *  - `stripeConnectId` — a payments identifier no application surface renders (pre-existing
 *    over-hydration; the `agency` relation already excluded its own copy).
 *  - `searchVector` — a generated `tsvector`, never read through Drizzle.
 *
 * KEPT, AND WHY (each decision column earns its place on an applicant-facing read):
 *  - `applicationStatus` — `/expert/apply/page.tsx` routes on it; the staff page gates its
 *    controls on it.
 *  - `submittedAt` — the days-waiting derivation both staff surfaces render.
 *  - `approvedAt` — `deriveExpertChecklist` and the applicant's own success page read it.
 *  - `decidedAt` / `decidedByUserId` — the staff banner's "when" and "who". Both are facts about
 *    the applicant's OWN row (a timestamp and an opaque uuid), not staff-authored content.
 *  - `declineReason` — the CATEGORY, which the applicant already receives by email (D3).
 *
 * ⚠ `Omit<>` HERE IS A COMPLETENESS GUARD, NOT COSMETIC: if `APPLICATION_PROFILE_COLUMNS` misses
 * a column this type names, the query result stops being assignable and `tsc` fails.
 */
export type ApplicationProfile = Omit<
  ExpertProfile,
  'declineNote' | 'stripeConnectId' | 'searchVector'
>;

/**
 * BAL-549 FIX ROUND (F1) — the STAFF projection: every applicant-safe column PLUS the staff-only
 * `decline_note`. Returned by {@link expertsRepository.findApplicationForStaffReview} and by
 * nothing else, so the note has exactly one read site to gate and to test.
 */
export interface StaffApplicationWithRelations extends Omit<ApplicationWithRelations, 'profile'> {
  profile: ApplicationProfile & { declineNote: string | null };
}

export interface ApplicationWithRelations {
  /** BAL-549 FIX ROUND (F1) — an ALLOW-LISTED projection; never the bare row. */
  profile: ApplicationProfile;
  /** BAL-549 — the applicant. NARROWED columns; never `workosId`. */
  user: ApplicationApplicant;
  /** BAL-549 — the agency the applicant is applying under; `null` for an independent expert. */
  agency: ApplicationAgency | null;
  competencies: ApplicationCompetencyWithRelations[];
  certifications: ApplicationCertWithRelations[];
  languages: ApplicationLanguageWithRelations[];
  industries: ApplicationIndustryWithRelations[];
  workHistory: WorkHistoryType[];
}

/**
 * BAL-548 / ADR-1055 — one waiting application, projected for the pending-actions queue. See
 * {@link expertsRepository.listPendingApplicationsForAlerts}.
 *
 * `userFirstName`/`userLastName` are nullable because `users` allows it, not because the join
 * can miss (it is an INNER JOIN); the finder renders a fallback label.
 */
export interface PendingApplicationAlertRow {
  expertProfileId: string;
  userFirstName: string | null;
  userLastName: string | null;
  /** The agency the applicant is applying as, or null for an independent expert. */
  agencyName: string | null;
  submittedAt: Date;
  applicationStatus: 'submitted' | 'under_review';
}

// ── The application decision (BAL-549 / ADR-1030) ────────────────

/** The two `application_status` labels a pending application may hold (orchestrator D4). */
export const PENDING_APPLICATION_STATUSES = ['submitted', 'under_review'] as const;
export type PendingApplicationStatus = (typeof PENDING_APPLICATION_STATUSES)[number];

/**
 * BAL-549 — one application decision. SERVER-DERIVED throughout: `actorUserId` comes from the
 * session, `decision` from WHICH Server Action ran, and the applicant's user id is NOT here at
 * all — it is read from the LOCKED profile row inside the transaction (see `decideApplication`).
 */
export type DecideApplicationInput = { expertProfileId: string; actorUserId: string } & (
  | { decision: 'approve' }
  | { decision: 'decline'; reason: ExpertDeclineReason; note: string }
);

/**
 * BAL-549 — what one decision produced. Every field exists because the caller's POST-COMMIT
 * fan-out or its analytics needs it: this repository cannot notify
 * (`invariants/repositories-never-notify.test.ts`), so the obligation is discharged from the
 * Server Action.
 *
 * ⚠ `outcome` IS A DISCRIMINANT, NOT A THROW. `'not_pending'` and `'not_found'` are ordinary,
 * reachable states (two staffers open the same queue row; a queue row survives a decision until
 * the next sweep) and the UI must be able to say which. Only genuine integrity failures throw.
 */
export type DecideApplicationResult =
  | {
      outcome: 'decided';
      profile: ExpertProfile;
      /** The status held immediately before the decision — `'submitted'` or `'under_review'`. */
      previousStatus: PendingApplicationStatus;
      /**
       * The applicant's `users.id`, read from the LOCKED profile row — never from the caller.
       * Recipient of `expert.application_declined`; subject of the `activeMode` write.
       */
      applicantUserId: string;
      /** For the `days_waiting` analytics property and the inline outcome line. */
      submittedAt: Date | null;
      /**
       * The `expert_application.{approved,declined}` audit row id. A uuid, so COLON-FREE, and
       * unique per WRITE rather than per state — BullMQ silently no-ops an `add` whose jobId is
       * already in the retained completed set, so an `expertProfileId`-derived key would swallow
       * a genuine second event (orchestrator D5).
       */
      auditEventId: string;
    }
  | { outcome: 'not_pending'; currentStatus: ApplicationStatus }
  | { outcome: 'not_found' };

/** BAL-549 — the `/admin/applications` filter vocabulary. `declined` reads the stored `rejected`. */
export const APPLICATION_REVIEW_FILTERS = ['pending', 'approved', 'declined'] as const;
export type ApplicationReviewFilter = (typeof APPLICATION_REVIEW_FILTERS)[number];

/**
 * BAL-549 — one row of the `/admin/applications` list. A PROJECTION, not a row select:
 * `expert_profiles` carries no display name, and the list must never hydrate a full `users` row.
 *
 * ⚠ NO `declineNote`. The list is a scannable index; the note is read on the DETAIL page only,
 * which keeps the staff-only text on exactly one surface.
 */
export interface ApplicationReviewRow {
  expertProfileId: string;
  applicantUserId: string;
  firstName: string | null;
  lastName: string | null;
  email: string;
  /** The agency the applicant is applying under; `null` for an independent expert. */
  agencyName: string | null;
  applicationStatus: ApplicationStatus;
  submittedAt: Date | null;
  decidedAt: Date | null;
  decidedByFirstName: string | null;
  decidedByLastName: string | null;
  declineReason: ExpertDeclineReason | null;
}

export interface ApplicationReviewList {
  rows: ApplicationReviewRow[];
  /**
   * Chip counts. `pending` is EVERY pending application; `approved`/`declined` count only the
   * RECENTLY-DECIDED window (`decidedSince`) — an all-time approved count would be "every expert
   * ever" and would say nothing about throughput.
   *
   * ⚠ `approved` COUNTS ROWS WITH A `decided_at`, so it EXCLUDES every pre-BAL-549 approval
   * (which has `approved_at` but no `decided_at`). That is correct and intended: this list is a
   * decision log, and a decision with no recorded decider is not one this surface can render.
   */
  counts: Record<ApplicationReviewFilter, number>;
  /** True when `rows` filled the batch — the caller must say so rather than silently capping. */
  truncated: boolean;
}

/**
 * The per-filter status predicate, shared by the row read and its chip count so the two can
 * never drift. `declined` reads the STORED `'rejected'` label (orchestrator D2).
 */
function applicationReviewPredicate(
  filter: ApplicationReviewFilter,
  decidedSince: Date
): SQL<unknown> {
  if (filter === 'pending') {
    return inArray(expertProfiles.applicationStatus, [...PENDING_APPLICATION_STATUSES]);
  }
  // `and()` of two non-undefined terms is never undefined, but its TYPE admits it; the `??`
  // keeps the signature honest without an assertion.
  //
  // ⚠ THE FALLBACK IS `false`, NOT `true` (fix round, F3). It is unreachable today, but this is
  // a filter predicate on a staff surface: an unreachable fallback that widens a result set is
  // the wrong direction on an authorization-adjacent read. A predicate that somehow degrades
  // must return NOTHING, never EVERYTHING.
  return (
    and(
      eq(expertProfiles.applicationStatus, filter === 'approved' ? 'approved' : 'rejected'),
      gte(expertProfiles.decidedAt, decidedSince)
    ) ?? sql`false`
  );
}

/**
 * BAL-549 FIX ROUND (F1) — the allow-list behind {@link ApplicationProfile}.
 *
 * ⚠ `as const` IS LOAD-BEARING. Drizzle resolves a `columns` selection from LITERAL `true`s;
 * widening these to `boolean` makes every column vanish from the inferred result type.
 *
 * ⚠ ADDING A COLUMN TO `expert_profiles` DOES NOT ADD IT HERE. That is the point: a new
 * staff-only column is absent from every applicant-facing read until somebody names it.
 */
const APPLICATION_PROFILE_COLUMNS = {
  id: true,
  userId: true,
  verticalId: true,
  type: true,
  agencyId: true,
  headline: true,
  bio: true,
  username: true,
  rateCents: true,
  trailheadUrl: true,
  linkedinUrl: true,
  websiteUrl: true,
  availableForWork: true,
  searchable: true,
  skillsLocked: true,
  yearStartedSalesforce: true,
  projectCountMin: true,
  projectLeadCountMin: true,
  isSalesforceMvp: true,
  isSalesforceCta: true,
  isCertifiedTrainer: true,
  applicationStatus: true,
  submittedAt: true,
  decidedAt: true,
  decidedByUserId: true,
  declineReason: true,
  timezone: true,
  bookingBufferBeforeMinutes: true,
  bookingBufferAfterMinutes: true,
  bookingMinimumNoticeMinutes: true,
  ratingAverage: true,
  ratingCount: true,
  createdAt: true,
  updatedAt: true,
  approvedAt: true,
} as const;

// ── Repository ───────────────────────────────────────────────────

export const expertsRepository = {
  /** Find expert profile by ID (used for checklist status) */
  async findProfileById(expertProfileId: string): Promise<ExpertProfile | undefined> {
    return db.query.expertProfiles.findFirst({
      where: eq(expertProfiles.id, expertProfileId),
    });
  },

  /**
   * DISPLAY-ONLY hydration of ONE expert profile (BAL-388) — the EIGHT columns a party card
   * needs, and NOTHING else.
   *
   * ⚠⚠ THIS EXISTS TO KEEP `rateCents` OFF A CLIENT-BOUND RENDER PATH. `expert_profiles.rate_cents`
   * is the UN-MARKED-UP consultant rate; the client lens already carries the all-in charge, so a
   * payload holding both hands the client the Balo margin. `stripeConnectId` and
   * `cronofyUserId` are vendor identifiers with no display use at all. `findProfileById` returns
   * every one of them, and TypeScript will NOT catch a spread of the full row (excess-property
   * checking does not apply to spreads). Concealment is enforced by what the row CAN hold.
   *
   * ⚠ BAL-422 WIDENED SIX COLUMNS TO EIGHT — `ratingAverage` + `ratingCount` — AND THAT LIGHTS
   * UP THREE SURFACES AT ONCE, because they all reach the expert through this ONE method:
   * the BAL-421 case party card, the BAL-388 recap party card, and (through the shared
   * `resolve-counterparty.ts` that BAL-389 hoisted) the end-of-call screen. All three are
   * ACCEPTED and INTENDED; none is a leak. The two new columns are display aggregates a
   * client already sees on the expert's public card, so adding them does not weaken the
   * concealment rationale above — `rateCents` / `stripeConnectId` / `cronofyUserId` remain
   * structurally absent, which is still the whole reason this method exists.
   *
   * ⚠ `ratingAverage` IS PARSED HERE, NOT PASSED THROUGH. The column is `numeric(2,1)` and
   * Drizzle infers that as `string` (`'4.3'`, not `4.3`), so this returns `number | null` via
   * `parseRatingAverage` — the ONE parse (`@balo/shared/reviews`). Callers get a number they
   * can `.toFixed(1)`; nobody downstream re-parses or `Number()`s it.
   *
   * ⚠ NULL MEANS NO REVIEWS, NEVER 0.0. Every consumer null-gates on `ratingAverage` (never on
   * `ratingCount`), because 0.0 is unrepresentable on a 1..5 scale and must never render.
   */
  async findDisplayProfileById(expertProfileId: string): Promise<
    | {
        id: string;
        userId: string;
        agencyId: string | null;
        type: ExpertProfile['type'];
        headline: string | null;
        username: string | null;
        ratingAverage: number | null;
        ratingCount: number;
      }
    | undefined
  > {
    const [row] = await db
      .select({
        id: expertProfiles.id,
        userId: expertProfiles.userId,
        agencyId: expertProfiles.agencyId,
        type: expertProfiles.type,
        headline: expertProfiles.headline,
        username: expertProfiles.username,
        ratingAverage: expertProfiles.ratingAverage,
        ratingCount: expertProfiles.ratingCount,
      })
      .from(expertProfiles)
      .where(eq(expertProfiles.id, expertProfileId))
      .limit(1);
    if (row === undefined) {
      return undefined;
    }
    return { ...row, ratingAverage: parseRatingAverage(row.ratingAverage) };
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
   *
   * ⚠ THE SCOPED OVERLOAD (`scope.userId`) — BAL-498 fix round 3, S3. `expert_profiles` has no
   * RLS, so a bare by-id read trusts whatever id the caller supplies. Session-boundary callers
   * (the expert Calendar page's `resolveExpertScheduleTimezone`) pass `{ userId: session.user.id }`
   * to add an `AND expert_profiles.user_id = :userId` term — a no-op for a well-formed session,
   * and a fail-closed guard against a future caller passing an id it did not derive from the
   * session. Identical in shape to `expertSearchabilityRepository.loadInputs`'s S4 overload; the
   * system callers (webhook / cron) legitimately have no user and omit it.
   */
  async findTimezone(
    expertProfileId: string,
    scope?: { readonly userId: string }
  ): Promise<string | null> {
    const row = await db.query.expertProfiles.findFirst({
      where:
        scope === undefined
          ? eq(expertProfiles.id, expertProfileId)
          : and(eq(expertProfiles.id, expertProfileId), eq(expertProfiles.userId, scope.userId)),
      columns: { timezone: true },
    });
    return row?.timezone ?? null;
  },

  /**
   * The full set of resolver inputs owned by the expert — timezone + the three
   * booking rules, plus the owning `userId` — in one `columns:`-projected read
   * (never hydrate the whole row: it carries stripeConnectId / cronofyUserId /
   * PII the resolver must not see). Returns null if the profile doesn't exist
   * so the resolve-and-cache wire-up can short-circuit. Field names are the
   * resolver's own vocabulary (`bufferBeforeMinutes`, …), decoupled from the DB
   * column names.
   *
   * `userId` was added by BAL-416 fix round 1 (S1) so a caller can assert
   * `expertProfiles.userId === <session userId>` against an already-fetched
   * row instead of a second query — see `findOverrideConflicts`.
   */
  async findResolverSettings(expertProfileId: string): Promise<{
    userId: string;
    timezone: string;
    bufferBeforeMinutes: number;
    bufferAfterMinutes: number;
    minimumNoticeMinutes: number;
  } | null> {
    const row = await db.query.expertProfiles.findFirst({
      where: eq(expertProfiles.id, expertProfileId),
      columns: {
        userId: true,
        timezone: true,
        bookingBufferBeforeMinutes: true,
        bookingBufferAfterMinutes: true,
        bookingMinimumNoticeMinutes: true,
      },
    });
    if (!row) return null;
    return {
      userId: row.userId,
      timezone: row.timezone,
      bufferBeforeMinutes: row.bookingBufferBeforeMinutes,
      bufferAfterMinutes: row.bookingBufferAfterMinutes,
      minimumNoticeMinutes: row.bookingMinimumNoticeMinutes,
    };
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
   * belonging to a LIVE user are publicly visible — drafts/unapproved/
   * non-searchable/soft-deleted resolve to undefined (→ 404). Username match is
   * exact (the unique username index).
   *
   * ⚠ BAL-493 ADDED THE `users.deleted_at IS NULL` TERM. `isPubliclyVisible` (below) has
   * always carried it; this read did not, so a soft-deleted expert who was approved and
   * searchable at deletion time stayed reachable by username. Pre-existing and unreachable
   * in practice — until BAL-493 promoted this exact read to the PUBLIC FRONT PAGE's curated
   * spotlight. `expert_profiles` has no `deletedAt` of its own, so the term has to be on the
   * joined USER row, and a relational `findFirst` cannot join.
   *
   * ⚠⚠ IT IS A RAW `sql` EXISTS, NOT `exists(db.select()…)`, AND THAT IS NOT STYLE. The
   * relational query builder aliases the top-level table as `"expertProfiles"` (camelCase, the
   * JS key — see any query it logs). A Column embedded in a raw `sql` template is rendered
   * WITH that alias in scope; a nested `db.select().from(users).where(eq(…, expertProfiles.
   * userId))` is compiled as an independent query and emits the bare table name
   * `"expert_profiles"`, which is not in the outer FROM → Postgres 42P01, "invalid reference
   * to FROM-clause entry", on EVERY call. Typecheck and lint are both clean on that version;
   * only `experts.integration.test.ts` catches it. Use the same embedding
   * `consultationCountExpression` uses for its correlated `${expertProfiles.id}` below.
   *
   * ⚠ WHERE-CLAUSE ONLY. No schema change, no migration, and the `rateCents` projection
   * stays the RAW un-marked-up consultant rate — the D1 markup lives at the serializer, never
   * in `packages/db`.
   */
  async findPublicProfileByUsername(username: string) {
    return db.query.expertProfiles.findFirst({
      where: and(
        eq(expertProfiles.username, username),
        eq(expertProfiles.searchable, true),
        isNotNull(expertProfiles.approvedAt),
        sql`EXISTS (
          SELECT 1 FROM users u
          WHERE u.id = ${expertProfiles.userId} AND u.deleted_at IS NULL
        )`
      ),
      // Defense-in-depth: explicit allowlist of the ONLY top-level columns the
      // public view-model + page consume. Keeps sensitive columns
      // (stripeConnectId, cronofyUserId, cronofySyncStatus, internal flags) out
      // of the RSC by construction — not just by mapper discipline. If the
      // mapper/page later needs another column, the type narrows and typecheck
      // fails until it's added here (the safety mechanism working).
      // ⚠ BAL-422 added `ratingAverage` / `ratingCount` for the hero rating stat and the
      // aggregate-aware reviews section. `ratingAverage` is `numeric` ⇒ Drizzle hands back a
      // STRING here: a relational `columns:` allow-list cannot reshape or cast, so the parse
      // happens at the view boundary (`mapProfileToView` → `parseRatingAverage`), which is
      // still the ONE parse function — just called one layer out.
      columns: {
        id: true,
        username: true,
        agencyId: true,
        headline: true,
        bio: true,
        rateCents: true,
        yearStartedSalesforce: true,
        availableForWork: true,
        ratingAverage: true,
        ratingCount: true,
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

  /**
   * BAL-236 — is this profile publicly visible? Approved AND searchable, as
   * `findPublicProfileByUsername` (above) and `buildWhereConditions` (`expert-search.ts`) both
   * require. Do not write a fourth visibility rule.
   *
   * Deliberately the FIRST read the public availability route performs, so an enumeration probe
   * against a random uuid costs exactly one indexed PK lookup — no vendor round-trip, no
   * four-way fan-out.
   *
   * ⚠ `expert_profiles` has NO `deleted_at` — do NOT add a soft-delete predicate ON THIS TABLE.
   *
   * ⚠ THE OWNING `users` ROW'S SOFT DELETE IS FILTERED HERE. `searchable` is a profile column,
   * so a soft-deleted user whose profile still carries `searchable = true` would keep
   * publishing live calendar data — the complement of a real person's calendar, from a public
   * unauthenticated endpoint, after they asked to be deleted. Unreachable today
   * (`usersRepository.softDelete` has no application-code caller), which is exactly why it is
   * cheap to close ahead of account deletion shipping.
   *
   * ⚠ BAL-493 BROUGHT `findPublicProfileByUsername` INTO LINE (it now carries the same term via
   * a correlated `exists`), because that read is what the public front page's curated spotlight
   * calls. `buildWhereConditions` (`expert-search.ts`) is still WITHOUT it — the remaining
   * divergence, and the one whoever ships account deletion must close, alongside flipping
   * `searchable = false` in the deletion transaction.
   */
  async isPubliclyVisible(expertProfileId: string): Promise<boolean> {
    const rows = await db
      .select({ id: expertProfiles.id })
      .from(expertProfiles)
      .innerJoin(users, eq(users.id, expertProfiles.userId))
      .where(
        and(
          eq(expertProfiles.id, expertProfileId),
          eq(expertProfiles.searchable, true),
          isNotNull(expertProfiles.approvedAt),
          isNull(users.deletedAt)
        )
      )
      .limit(1);
    return rows.length > 0;
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

  /**
   * Find application with all related data.
   *
   * ⚠ BAL-549 WIDENED THIS BY TWO RELATIONS — `user` and `agency` — BOTH WITH AN EXPLICIT
   * `columns` NARROWING, NEVER `true`. A bare `with: { user: true }` hydrates the FULL `users`
   * row, including `workos_id`, `email_verified`, `phone_verified_at`, `platform_role` and
   * `active_company_id` — the identity-provider key and PII this read has no use for. `agency`
   * likewise excludes `stripe_connect_id`.
   *
   * ⚠ THE APPLICANT'S OWN PAGE ALSO READS THIS (`(apply)/expert/apply/_actions/load-submitted.ts`,
   * `load-draft.ts`, `save-draft.ts`, `submit-application.ts`). The widening is ADDITIVE and the
   * added columns are the applicant's own name/email/phone and their agency's public identity —
   * nothing a staff-only lens would carry. If a future column here is staff-only, it does NOT
   * belong on this read: add a separate staff projection.
   *
   * ⚠⚠ THE TOP-LEVEL SELECT IS ALLOW-LISTED TOO (BAL-549 FIX ROUND, F1) — see
   * `APPLICATION_PROFILE_COLUMNS` / {@link ApplicationProfile}. It previously had NO `columns:`,
   * which returned the bare row: `decline_note` and `stripe_connect_id` included. This read
   * feeds `load-draft.ts` → `expert-application-wizard.tsx` (`'use client'`), so the bare row
   * was serialised into the APPLICANT'S OWN browser payload — and a declined applicant is sent
   * to exactly that page by the decline email's CTA.
   *
   * ⚠ `decline_note` IS NOT ON THIS READ AT ALL. The staff review page reads it through
   * {@link expertsRepository.findApplicationForStaffReview}, which is the only method that
   * projects it. Pinned in `expert-application-decision.integration.test.ts` §7 — removing the
   * `columns:` allow-list turns that suite red.
   */
  async findApplicationWithRelations(
    expertProfileId: string
  ): Promise<ApplicationWithRelations | undefined> {
    const profile = await db.query.expertProfiles.findFirst({
      where: eq(expertProfiles.id, expertProfileId),
      columns: APPLICATION_PROFILE_COLUMNS,
      with: {
        user: {
          columns: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            avatarUrl: true,
            phone: true,
            timezone: true,
            country: true,
            countryCode: true,
            deletedAt: true,
          },
        },
        agency: {
          columns: { id: true, name: true, slug: true, logoUrl: true },
        },
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
      user: profile.user,
      agency: profile.agency,
      competencies: profile.competencies as unknown as ApplicationCompetencyWithRelations[],
      certifications: profile.certifications as unknown as ApplicationCertWithRelations[],
      languages: profile.languages as unknown as ApplicationLanguageWithRelations[],
      industries: profile.industries as unknown as ApplicationIndustryWithRelations[],
      workHistory: profile.workHistory,
    };
  },

  /**
   * BAL-549 FIX ROUND (F1) — THE STAFF READ. Everything
   * {@link expertsRepository.findApplicationWithRelations} returns, PLUS the staff-only
   * `decline_note`.
   *
   * ⚠ A SEPARATE METHOD, NOT A FLAG ON THE APPLICANT READ. A boolean parameter would put the
   * note one wrong argument away from the applicant's own page; a separate method makes the
   * staff column reachable only from a call site that names it. Its ONE caller is
   * `/admin/applications/[profileId]/page.tsx`, which renders the note behind
   * `REVIEW_EXPERT_APPLICATIONS` (never on the page's own `VIEW_PLATFORM_ADMIN` gate).
   *
   * ⚠ THE NOTE IS FETCHED BY ITS OWN ONE-COLUMN READ rather than by re-stating the relation
   * block with a wider allow-list — one definition of the relations, one definition of the
   * allow-list, and the staff column appears in exactly one `columns:` literal in this package.
   */
  async findApplicationForStaffReview(
    expertProfileId: string
  ): Promise<StaffApplicationWithRelations | undefined> {
    const [application, staffColumns] = await Promise.all([
      expertsRepository.findApplicationWithRelations(expertProfileId),
      db.query.expertProfiles.findFirst({
        where: eq(expertProfiles.id, expertProfileId),
        columns: { declineNote: true },
      }),
    ]);

    if (application === undefined) return undefined;

    return {
      ...application,
      profile: { ...application.profile, declineNote: staffColumns?.declineNote ?? null },
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
   *
   * ⚠⚠ THE `SET` IS AN EXPLICIT ALLOW-LIST, NOT `{ ...data }`, AND THAT IS A SECURITY
   * PROPERTY (BAL-422). It used to spread the argument, which meant {@link
   * UpdateProfileInput} was the ONLY thing keeping `rating_average` / `rating_count` out of
   * this generic writer — and a type cannot do that job: TypeScript's excess-property check
   * fires on OBJECT LITERALS ONLY, so any caller passing a VARIABLE that happens to carry
   * extra keys writes them straight through. Listing the columns means the two rating
   * columns keep EXACTLY ONE writer (`reviewsRepository.recomputeRatingAggregate`, under a
   * row lock) by construction rather than by discipline.
   *
   * The same holds for every other column not listed here — `agency_id`, `approved_at`,
   * `type`, `user_id` — each of which has its own dedicated writer for the same reason.
   *
   * ⚠ PARTIAL-UPDATE SEMANTICS ARE UNCHANGED. Drizzle's `mapUpdateSet` drops `undefined`
   * values before building the statement, so an absent field is still not written, while an
   * explicit `null` still clears a nullable column. `updatedAt` is always present, so the
   * SET can never be empty (which Drizzle would reject).
   *
   * ⚠ ADDING A FIELD TO {@link UpdateProfileInput} MEANS ADDING A LINE HERE. A field in the
   * interface but not in this list is silently ignored at runtime — the one failure mode
   * this shape introduces, and the reason the interface sits directly above with the same
   * ordering.
   */
  async updateProfile(
    expertProfileId: string,
    data: UpdateProfileInput,
    executor?: DbExecutor
  ): Promise<void> {
    const exec = executor ?? db;
    await exec
      .update(expertProfiles)
      .set({
        headline: data.headline,
        bio: data.bio,
        username: data.username,
        websiteUrl: data.websiteUrl,
        yearStartedSalesforce: data.yearStartedSalesforce,
        projectCountMin: data.projectCountMin,
        projectLeadCountMin: data.projectLeadCountMin,
        linkedinUrl: data.linkedinUrl,
        trailheadUrl: data.trailheadUrl,
        isSalesforceMvp: data.isSalesforceMvp,
        isSalesforceCta: data.isSalesforceCta,
        isCertifiedTrainer: data.isCertifiedTrainer,
        rateCents: data.rateCents,
        timezone: data.timezone,
        bookingBufferBeforeMinutes: data.bookingBufferBeforeMinutes,
        bookingBufferAfterMinutes: data.bookingBufferAfterMinutes,
        bookingMinimumNoticeMinutes: data.bookingMinimumNoticeMinutes,
        updatedAt: new Date(),
      })
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

  /**
   * BAL-549 / ADR-1030 — DECIDE AN EXPERT APPLICATION. ONE `db.transaction` that flips the
   * profile to its terminal status, stamps all four ADR-1030 floor columns, switches the
   * applicant's `active_mode` to `'expert'` on the APPROVE arm, and appends ONE
   * `expert_application.{approved,declined}` audit row. Modelled on
   * `projectRequestsRepository.close()` — the shipped "lock FOR UPDATE + write + audit row in
   * ONE transaction" precedent — scaled down.
   *
   * ⚠⚠ THIS REPLACES `approveApplication`, WHICH RAN AS TWO UNTRANSACTIONED CALLS WITH NO AUDIT
   * ROW (`admin-dev/_actions/approve-expert.ts`). A crash between them left an approved expert
   * stuck in the client workspace, with nothing recording who approved them. Both halves now
   * commit or roll back together.
   *
   * ⚠⚠ THE APPLICANT'S USER ID IS READ FROM THE LOCKED ROW, NEVER FROM THE CALLER. The deleted
   * action took `userId` as its SECOND ARGUMENT and wrote `active_mode` to whatever it was
   * handed — an IDOR: approve profile A while flipping user B into the expert workspace. There
   * is no parameter for it here, so the class is structurally unreachable.
   *
   * ⚠ BOTH PENDING LABELS ARE ACCEPTED (orchestrator D4). The deleted `approveApplication`
   * guarded on `'submitted'` ONLY, while the BAL-548 finder, the partial index and
   * `listPendingApplicationsForAlerts` all treat `('submitted','under_review')` as pending. A
   * queue row that cannot be actioned is exactly the bug this must not ship. `'under_review'`
   * has no writer today; that is latent, not dead.
   *
   * ⚠ THE STORED DECLINE LABEL IS `'rejected'`, AND EVERY SURFACE SAYS "DECLINED" — a
   * DELIBERATE, DOCUMENTED divergence (orchestrator D2). `'rejected'` shipped in migration
   * 0000's original `CREATE TYPE application_status` and already has readers
   * (`(apply)/expert/apply/review/page.tsx` redirects a declined applicant back to the wizard;
   * BAL-551's Lookup renders a sub-label). Changing the stored label would be a migration and a
   * data backfill to buy a synonym. The AUDIT ACTION and the NOTIFICATION EVENT are both named
   * `…declined`, against a `rejected` column, on purpose.
   *
   * ⚠ `approved_at` IS STILL WRITTEN ON THE APPROVE ARM, beside `decided_at`, with the SAME
   * `Date`. Four shipped readers depend on it (`findPublicProfileByUsername`,
   * `isPubliclyVisible`, `platform-lookup.ts`, `deriveExpertChecklist`) and searchability is out
   * of BAL-549's scope. It is NOT cleared on the decline arm — a declined application never had
   * one.
   *
   * ⚠ `decline_note` IS NOT COPIED INTO THE AUDIT ROW. The row records `hasNote: boolean` and
   * nothing more (the `project_request.closed` precedent) — the column is the note's ONLY home,
   * so a leak has exactly one place to happen and one place to be tested.
   *
   * ⚠ THIS REPOSITORY NOTIFIES NOBODY, and cannot
   * (`invariants/repositories-never-notify.test.ts`). The caller owns the POST-COMMIT publish of
   * `expert.application_declined`, using the returned `auditEventId` as half of its compound,
   * colon-free correlationId.
   *
   * LOCK ORDER: the profile row, then the user row, in that fixed order, so two concurrent
   * decisions on the same application queue rather than deadlock. Only the PROFILE row is taken
   * with an explicit `FOR UPDATE`; the user row is locked implicitly, by its own `UPDATE`, on
   * the approve arm only (fix round, F6 — the previous wording said "both are taken
   * `FOR UPDATE`", which over-claimed). Equivalent for ordering, and worth stating precisely:
   * on the DECLINE arm no user-row lock is taken at all, because no user row is written.
   *
   * Returns a DISCRIMINATED outcome; throws only on genuine integrity failure (the `UPDATE`
   * matching zero rows after the lock succeeded).
   */
  async decideApplication(input: DecideApplicationInput): Promise<DecideApplicationResult> {
    return db.transaction(async (tx) => {
      const now = new Date();

      // 1. Lock the profile row.
      const [current] = await tx
        .select()
        .from(expertProfiles)
        .where(eq(expertProfiles.id, input.expertProfileId))
        .for('update');

      if (current === undefined) return { outcome: 'not_found' };

      // 2. Refuse a non-pending application, for free — BOTH pending labels (D4).
      if (
        current.applicationStatus !== 'submitted' &&
        current.applicationStatus !== 'under_review'
      ) {
        return { outcome: 'not_pending', currentStatus: current.applicationStatus };
      }
      const previousStatus = current.applicationStatus;
      const applicantUserId = current.userId; // ← from the LOCKED ROW, never the caller

      // 3. The profile write. ONE statement, all four floor columns.
      const [updated] = await tx
        .update(expertProfiles)
        .set(
          input.decision === 'approve'
            ? {
                applicationStatus: 'approved',
                approvedAt: now,
                decidedAt: now,
                decidedByUserId: input.actorUserId,
                updatedAt: now,
              }
            : {
                applicationStatus: 'rejected',
                decidedAt: now,
                decidedByUserId: input.actorUserId,
                declineReason: input.reason,
                declineNote: input.note,
                updatedAt: now,
              }
        )
        .where(eq(expertProfiles.id, input.expertProfileId))
        .returning();

      if (updated === undefined) {
        throw new Error(`Failed to update expert profile: ${input.expertProfileId}`);
      }

      // 4. APPROVE ARM ONLY — put the new expert into the expert workspace.
      //    ⚠ `deleted_at IS NULL` guarded: this write is reachable from a request path, so it
      //    must never resurrect a soft-deleted user's row (`usersRepository.updateTimezone`'s
      //    rule). A soft-deleted applicant still gets the profile decision — there is nothing
      //    to un-decide — but no `users` write.
      if (input.decision === 'approve') {
        await tx
          .update(users)
          .set({ activeMode: 'expert', updatedAt: now })
          .where(and(eq(users.id, applicantUserId), isNull(users.deletedAt)));
      }

      // 5. The audit row, LAST — an audit row must never outlive a rolled-back decision.
      //
      // ⚠ FIXED METADATA CONTRACT. `audit_events` is APPEND-ONLY — no `updated_at`, no
      // backfill — so this shape is unrecoverable if wrong. Asserted key-by-key in
      // `expert-application-decision.integration.test.ts`.
      //
      // ⚠ `hasNote`, NEVER THE NOTE TEXT.
      const auditRow = await auditEventsRepository.record(
        {
          actorUserId: input.actorUserId,
          action:
            input.decision === 'approve'
              ? 'expert_application.approved'
              : 'expert_application.declined',
          entityType: 'expert_profile', // the `_shared/schedule-audit.ts` spelling
          entityId: input.expertProfileId,
          metadata: {
            previousStatus,
            applicantUserId,
            ...(input.decision === 'decline'
              ? { reason: input.reason, hasNote: input.note.length > 0 }
              : {}),
          },
        },
        tx
      );

      return {
        outcome: 'decided',
        profile: updated,
        previousStatus,
        applicantUserId,
        submittedAt: updated.submittedAt,
        auditEventId: auditRow.id,
      };
    });
  },

  /**
   * BAL-549 — the `/admin/applications` list read. ONE filter arm per call plus the three chip
   * counts, in one round trip's worth of queries.
   *
   * PENDING arm: `('submitted','under_review')`, OLDEST SUBMISSION FIRST — rides
   * `expert_profiles_pending_application_idx`. Same predicate as
   * `listPendingApplicationsForAlerts` so the list and the queue agree on WHICH applications are
   * pending (they deliberately disagree on how OLD each one is — see `applicationWaitingDays`'s
   * docblock in `@balo/shared/experts` and orchestrator O7).
   *
   * DECIDED arms: `decided_at >= decidedSince`, NEWEST FIRST — rides
   * `expert_profiles_decided_at_idx`.
   *
   * ⚠ `INNER JOIN users` for the applicant, with `deleted_at IS NULL` IN THE JOIN CONDITION: an
   * applicant whose user row was soft-deleted is not an application anybody can action, so
   * dropping the row is right. `LEFT JOIN agencies` for the agency (NULL = independent — the
   * shape, not a missing row) and `LEFT JOIN users AS decider` for attribution, whose filter
   * stays in the JOIN CONDITION so a soft-deleted DECIDER does not drop the parent row.
   *
   * ⚠ NO `deleted_at` FILTER ON `expert_profiles`, BECAUSE IT HAS NO SUCH COLUMN.
   *
   * ⚠ `limit` IS A BATCH BOUND THE CALLER MUST SURFACE WHEN IT FILLS (`truncated`). No silent
   * caps — the `listPendingApplicationsForAlerts` contract, verbatim.
   *
   * ⚠ THE THREE CHIP COUNTS ARE THREE SEPARATE `count(*)` SELECTS, EACH REUSING
   * `applicationReviewPredicate` — deliberately NOT one `GROUP BY`. A grouped count would have
   * to fold the `decidedSince` window into a conditional aggregate, which is exactly where the
   * window silently stops applying to one arm. Three indexed counts on a staff surface is not a
   * hot path; do not "optimise" this into a GROUP BY.
   */
  async listApplicationsForReview(input: {
    filter: ApplicationReviewFilter;
    decidedSince: Date;
    limit: number;
  }): Promise<ApplicationReviewList> {
    const decider = alias(users, 'decider');

    const rowsQuery = db
      .select({
        expertProfileId: expertProfiles.id,
        applicantUserId: users.id,
        firstName: users.firstName,
        lastName: users.lastName,
        email: users.email,
        agencyName: agencies.name,
        applicationStatus: expertProfiles.applicationStatus,
        submittedAt: expertProfiles.submittedAt,
        decidedAt: expertProfiles.decidedAt,
        decidedByFirstName: decider.firstName,
        decidedByLastName: decider.lastName,
        declineReason: expertProfiles.declineReason,
      })
      .from(expertProfiles)
      .innerJoin(users, and(eq(users.id, expertProfiles.userId), isNull(users.deletedAt)))
      .leftJoin(agencies, eq(agencies.id, expertProfiles.agencyId))
      .leftJoin(
        decider,
        and(eq(decider.id, expertProfiles.decidedByUserId), isNull(decider.deletedAt))
      )
      .where(applicationReviewPredicate(input.filter, input.decidedSince))
      .orderBy(
        ...(input.filter === 'pending'
          ? [asc(expertProfiles.submittedAt), asc(expertProfiles.id)]
          : [desc(expertProfiles.decidedAt), desc(expertProfiles.id)])
      )
      .limit(input.limit);

    const countFor = async (filter: ApplicationReviewFilter): Promise<number> => {
      const [row] = await db
        .select({ count: sql<number>`cast(count(*) as int)` })
        .from(expertProfiles)
        .innerJoin(users, and(eq(users.id, expertProfiles.userId), isNull(users.deletedAt)))
        .where(applicationReviewPredicate(filter, input.decidedSince));
      return row?.count ?? 0;
    };

    const [rows, pending, approved, declined] = await Promise.all([
      rowsQuery,
      countFor('pending'),
      countFor('approved'),
      countFor('declined'),
    ]);

    return {
      // ⚠ RE-PROJECTED FIELD BY FIELD, NOT SPREAD. `applicationStatus` and `declineReason`
      // already arrive typed by the schema (no `!`, no narrowing needed) — the explicit literal
      // exists so a later widening of the `select()` above cannot silently carry a new column,
      // `decline_note` above all, out of this list at RUNTIME while the declared type still
      // says it does not.
      rows: rows.map((row) => ({
        expertProfileId: row.expertProfileId,
        applicantUserId: row.applicantUserId,
        firstName: row.firstName,
        lastName: row.lastName,
        email: row.email,
        agencyName: row.agencyName,
        applicationStatus: row.applicationStatus,
        submittedAt: row.submittedAt,
        decidedAt: row.decidedAt,
        decidedByFirstName: row.decidedByFirstName,
        decidedByLastName: row.decidedByLastName,
        declineReason: row.declineReason,
      })),
      counts: { pending, approved, declined },
      truncated: rows.length === input.limit,
    };
  },

  /**
   * BAL-548 / ADR-1055 — the `expert.application_pending` finder read: applications that have
   * been waiting for a decision since before `submittedBefore`, OLDEST SUBMISSION FIRST.
   *
   * A PROJECTION, not a row select: the alert row has to read "Priya Nair (CloudPeak) applied
   * 6 days ago", and `expert_profiles` carries no display name. `INNER JOIN users` for the
   * person, `LEFT JOIN agencies` for the agency an agency-based applicant is applying under
   * (NULL for an independent expert — that is the shape, not a missing row).
   *
   * ⚠ `limit` IS A BATCH BOUND THE CALLER MUST WARN ABOUT WHEN IT FILLS. No silent caps — the
   * `calendarSubscriptionsRepository` monitor-arm contract, verbatim. A saturated batch on an
   * alerting query is itself the alarming reading.
   *
   * ⚠ NO `deleted_at` FILTER ON `expert_profiles`, BECAUSE IT HAS NO SUCH COLUMN — the table
   * spreads `...timestamps` only. `users` DOES have one, and its filter sits in the JOIN
   * CONDITION: an applicant whose user row was soft-deleted is not a pending application
   * anybody can action, so dropping the row is the right answer here (unlike the `LEFT JOIN`
   * attribution case, where the filter in the WHERE would wrongly drop the parent).
   *
   * ⚠ `'under_review'` HAS NO WRITER TODAY. The only transitions in this repository are
   * `draft → submitted → approved`. It is matched anyway because the kind's copy promises the
   * row closes "once the application is approved or rejected"; a triage state that starts being
   * written later must not silently drop those applications out of the queue.
   *
   * ⚠ NO CERTIFICATION COUNT. An aggregate join for one line of colour is a join too many on a
   * per-minute cron — the alert's job is to say an application is waiting, not to review it.
   *
   * Rides `expert_profiles_pending_application_idx`.
   */
  async listPendingApplicationsForAlerts(
    submittedBefore: Date,
    limit: number
  ): Promise<PendingApplicationAlertRow[]> {
    const rows = await db
      .select({
        expertProfileId: expertProfiles.id,
        userFirstName: users.firstName,
        userLastName: users.lastName,
        agencyName: agencies.name,
        submittedAt: expertProfiles.submittedAt,
        applicationStatus: expertProfiles.applicationStatus,
      })
      .from(expertProfiles)
      .innerJoin(users, and(eq(users.id, expertProfiles.userId), isNull(users.deletedAt)))
      .leftJoin(agencies, eq(agencies.id, expertProfiles.agencyId))
      .where(
        and(
          inArray(expertProfiles.applicationStatus, ['submitted', 'under_review']),
          isNotNull(expertProfiles.submittedAt),
          lte(expertProfiles.submittedAt, submittedBefore)
        )
      )
      .orderBy(asc(expertProfiles.submittedAt), asc(expertProfiles.id))
      .limit(limit);

    // `submitted_at` is nullable on the column but NOT NULL in this result set (the
    // `isNotNull` term above). Narrowed by filter + guard rather than by `!` —
    // `noUncheckedIndexedAccess` / the no-assertion house rule.
    return rows.flatMap((row) => {
      const { submittedAt, applicationStatus } = row;
      if (submittedAt === null) {
        return [];
      }
      if (applicationStatus !== 'submitted' && applicationStatus !== 'under_review') {
        return [];
      }
      return [{ ...row, submittedAt, applicationStatus }];
    });
  },
};

export type ProfileSettingsData = NonNullable<
  Awaited<ReturnType<typeof expertsRepository.findProfileForSettings>>
>;

export type PublicExpertProfile = NonNullable<
  Awaited<ReturnType<typeof expertsRepository.findPublicProfileByUsername>>
>;
