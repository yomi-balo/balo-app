import { and, eq, ne, sql } from 'drizzle-orm';
import { db } from '../client';
import {
  availabilityRules,
  calendarConnections,
  expertPayoutDetails,
  expertProfiles,
  users,
  type CalendarCredentialStatus,
} from '../schema';
import { auditEventsRepository } from './audit-events';
import type { DbExecutor } from './_shared/db-executor';
import type {
  ExpertChecklistInputs,
  ExpertSearchabilitySource as SharedExpertSearchabilitySource,
} from '@balo/shared/experts';

/**
 * BAL-414 — the data layer behind "expert searchability must be revocable".
 *
 * `expert_profiles.searchable` gates BOTH discovery (`expert-search.ts`) AND the public
 * profile detail page (a non-searchable expert 404s). Before this ticket it was written in
 * exactly one place and only ever to `true`, so a provider-side calendar revocation left a
 * broken expert listed and bookable with no busy-time subtraction running.
 *
 * This module is THE ONLY WRITER OF `expert_profiles.searchable` OUTSIDE SEEDS, and the one
 * place the six checklist inputs are read. It owns two things and deliberately nothing else:
 *
 *   1. {@link expertSearchabilityRepository.loadInputs} — ONE round trip that returns every
 *      input the checklist derivation needs, with the soft-delete filters and the D4
 *      multi-connection semantics applied at the SQL layer where an integration test can pin
 *      them against real Postgres.
 *   2. {@link expertSearchabilityRepository.applySearchable} — a CONDITIONAL compare-and-set
 *      on the boolean plus, when and only when the row actually changed, one append-only
 *      `audit_events` row, both in ONE transaction.
 *
 * ⚠⚠ THE RULE IS NOT HERE. "What makes an expert complete" is a pure function over the shape
 * `loadInputs` returns, and it lives in `@balo/shared/experts` because BOTH apps need it
 * (`apps/api`'s credential-break trigger and `apps/web`'s dashboard read path). A second
 * definition of "complete" is exactly the failure mode this codebase keeps ADRs about — do not
 * re-derive any checklist item here, and do not add a `derive*` export to this file.
 *
 * ⚠ NO SCHEMA CHANGE, NO MIGRATION. Attribution rides the existing generic `audit_events`
 * table (BAL-344), whose `actor_user_id` is NULLABLE with the documented ADR-1030 system-actor
 * rationale — three of BAL-414's four triggers (provider revocation, probe heal, OAuth
 * callback) genuinely have no human actor. `expert_profiles` gains no attribution columns:
 * this is a HISTORY question ("how often does this expert fall out of search, and why"), which
 * two latest-value columns answer badly and `countByEntityAndAction` /
 * `findLatestByEntityAndAction` already answer for free.
 *
 * ⚠ NO RLS, matching every other table this module touches. Balo authenticates at the
 * application layer (WorkOS) and reaches these tables only through repositories on the admin
 * client. Unchanged by this ticket.
 */

// ── The checklist input shape ────────────────────────────────────

/**
 * One live (non-soft-deleted) calendar connection, reduced to what the `calendar` checklist
 * item needs.
 *
 * `credentialStatus` keeps its `CalendarCredentialStatus` union here — the vocabulary's single
 * home is `schema/calendar.ts`, and a typed column means a stale literal is a COMPILE ERROR
 * rather than a query that quietly matches zero rows. The shared rule widens it to `string`
 * because `@balo/shared` cannot import `@balo/db`; the narrower type assigns to the wider one,
 * so nothing is lost in either direction.
 */
export interface ExpertSearchabilityConnectionState {
  readonly id: string;
  readonly credentialStatus: CalendarCredentialStatus;
}

/**
 * Every input the six checklist items are derived from.
 *
 * ⚠⚠ NOT A SECOND DEFINITION — a type ALIAS onto `ExpertChecklistInputs` in
 * `@balo/shared/experts` (BAL-414 §7 handoff, closed). That package owns the RULE; this one
 * owns the READ. Re-exported under this name purely so existing call sites (and this file's
 * own field-by-field construction below) keep reading naturally; there is exactly ONE
 * structural shape, defined once, in `@balo/shared/experts/checklist.ts`.
 *
 * `calendarConnections` here is still populated from {@link ExpertSearchabilityConnectionState}
 * (which keeps the typed `CalendarCredentialStatus` — `@balo/shared` cannot see that union, the
 * dependency direction is `@balo/db → @balo/shared`, never the reverse). The narrower type
 * assigns to the shared package's `string`-typed `credentialStatus`, so nothing is lost in
 * either direction.
 *
 * D4 — EVERY non-soft-deleted connection the expert holds, not "the expert's connection".
 * Connections are per-(expert, provider) since BAL-467, so the `calendar` item is defined over
 * the SET: at least one live connection whose credential is `ACTIVE`. Reducing this to one row
 * (the `findConnectionByExpertProfileId` shape, which returns the OLDEST live connection) would
 * read `calendar: false` for an expert holding an EXPIRED Google and a healthy Microsoft — and
 * under symmetric revocation that latent bug becomes a WRONGFUL DE-LISTING that also 404s their
 * public profile page.
 *
 * Both representations of "disconnected" are handled, and they are handled in different places
 * on purpose: a soft-deleted row is excluded HERE (it never reaches the rule), and an
 * `EXPIRED` / `REVOKED` / `SYNC_PENDING` row is included here and rejected by the rule.
 */
export type ExpertSearchabilityChecklistInputs = ExpertChecklistInputs;

/** What one checklist read returns: the rule's inputs, plus the two fields callers need. */
export interface ExpertSearchabilitySnapshot {
  readonly inputs: ExpertSearchabilityChecklistInputs;
  /** The committed value of `expert_profiles.searchable` at read time. */
  readonly currentSearchable: boolean;
  /** Returned so `apps/web`'s settings tabs need no second query for the same column. */
  readonly rateCents: number | null;
}

// ── The audit vocabulary ─────────────────────────────────────────

/**
 * Where a searchability transition came from. AUDIT METADATA ONLY — deliberately richer than,
 * and separate from, the analytics `trigger` property (which has two values derived from the
 * NEW boolean). Do not merge the two vocabularies.
 *
 * ⚠⚠ NOT A SECOND DEFINITION — a type ALIAS onto `ExpertSearchabilitySource` in
 * `@balo/shared/experts` (BAL-414 §7 handoff, closed). Re-exported under this name so existing
 * call sites keep reading naturally; there is exactly ONE union, defined once.
 */
export type ExpertSearchabilitySource = SharedExpertSearchabilitySource;

/** `audit_events.entity_type` for every row this module writes. */
export const EXPERT_SEARCHABILITY_AUDIT_ENTITY_TYPE = 'expert_profile';

/**
 * The two `audit_events.action` values, one per DIRECTION rather than one action carrying a
 * direction field — so "how many times has this expert been de-listed" is a single indexed
 * `countByEntityAndAction` read with no metadata scan.
 */
export const EXPERT_SEARCHABILITY_GRANTED_ACTION = 'expert_profile.searchability_granted';
export const EXPERT_SEARCHABILITY_REVOKED_ACTION = 'expert_profile.searchability_revoked';

// ── The write result ─────────────────────────────────────────────

/**
 * Whether the compare-and-set actually moved the row.
 *
 * ⚠⚠ EVERY DOWNSTREAM EFFECT GATES ON `changed`, NEVER ON A CALLER-SIDE "does it need a
 * write?" pre-check. That is what makes a retried BullMQ job, a re-rendered dashboard and a
 * stable state silent: no second audit row, no second notification, no second analytics event.
 */
export type ExpertSearchabilityWriteResult =
  | { readonly changed: false }
  | {
      readonly changed: true;
      /** `audit_events.id` — one transition, one uuid, so it doubles as a dedup key. */
      readonly auditEventId: string;
      readonly previousSearchable: boolean;
    };

/** Everything one transition needs to record itself. */
export interface ApplySearchableInput {
  readonly expertProfileId: string;
  readonly searchable: boolean;
  /** NULL for a system actor — the ADR-1030 exemption. See the module docblock. */
  readonly actorUserId: string | null;
  readonly source: ExpertSearchabilitySource;
  /**
   * The checklist keys that are currently `false`, recorded verbatim into the audit row so a
   * de-listing is explainable without re-deriving it. Typed `readonly string[]` because the
   * key vocabulary's single home is `@balo/shared/experts`; this module only serialises it.
   */
  readonly failingItems: readonly string[];
  /**
   * S2 (fix round 1) — audit-integrity metadata only, NEVER an authorization input. Set when
   * `actorUserId` is a staff member's id captured while impersonating, so the audit row does
   * not read as an ordinary self-attributed transition. Omitted (not merely `false`) when
   * absent, so every pre-existing caller's `row.metadata` assertion is untouched.
   */
  readonly actorImpersonating?: boolean;
}

// ── SQL fragments (correlated, so the whole read is ONE round trip) ──

/**
 * Every LIVE connection for the outer `expert_profiles` row, as JSON.
 *
 * `COALESCE(..., '[]'::json)` so an expert with no connections yields `[]` rather than NULL —
 * the rule takes an array, and a null-check at every call site is exactly the kind of thing
 * that gets forgotten in one of them. `ORDER BY created_at, id` mirrors
 * `listConnectionsByExpertProfileId`'s `OLDEST_LIVE_FIRST` so the array is deterministic
 * (`created_at` alone is not: it defaults to `now()`, which is TRANSACTION start time, so rows
 * written in one transaction share a byte-identical value).
 */
const liveCalendarConnectionsJson = sql<ExpertSearchabilityConnectionState[]>`COALESCE((
  SELECT json_agg(
           json_build_object(
             'id', ${calendarConnections.id},
             'credentialStatus', ${calendarConnections.credentialStatus}
           )
           ORDER BY ${calendarConnections.createdAt}, ${calendarConnections.id}
         )
  FROM ${calendarConnections}
  WHERE ${calendarConnections.expertProfileId} = ${expertProfiles.id}
    AND ${calendarConnections.deletedAt} IS NULL
), '[]'::json)`;

/**
 * ≥1 non-soft-deleted weekly rule. Semantics lifted verbatim from
 * `availabilityRulesRepository.hasActiveRules` — the table has no enabled/active column, so
 * "active" IS "not soft-deleted".
 */
const hasActiveAvailabilityRulesExpression = sql<boolean>`EXISTS (
  SELECT 1 FROM ${availabilityRules}
  WHERE ${availabilityRules.expertProfileId} = ${expertProfiles.id}
    AND ${availabilityRules.deletedAt} IS NULL
)`;

/** ≥1 non-soft-deleted payout row. Semantics lifted verbatim from `hasPayoutDetails`. */
const hasPayoutDetailsExpression = sql<boolean>`EXISTS (
  SELECT 1 FROM ${expertPayoutDetails}
  WHERE ${expertPayoutDetails.expertProfileId} = ${expertProfiles.id}
    AND ${expertPayoutDetails.deletedAt} IS NULL
)`;

// ── Repository ───────────────────────────────────────────────────

export const expertSearchabilityRepository = {
  /**
   * ONE round of reads for the whole checklist — a single SELECT with correlated subqueries,
   * not a five-repository fan-out. Returns `undefined` when the profile is gone, or when its
   * user row is gone or soft-deleted.
   *
   * ⚠ EXPLICIT `columns:` PROJECTION, NOT A RELATIONAL `with:`. A relational hydrate would
   * pull the FULL joined `users` row — `workos_id`, `email`, `phone` — into a value that flows
   * into an RSC render tree. Exactly seven columns are selected, and
   * `expert-searchability.integration.test.ts` asserts the returned object has no `workosId`
   * or `email` key.
   *
   * ⚠ `expert_profiles` HAS NO `deleted_at` COLUMN (the table ends at the BAL-422 rating
   * roll-up). Do not add a soft-delete guard against it — it will not compile. Guard not-found
   * only, same shape as the `companies` table.
   *
   * ⚠⚠ S1 (fix round 1) — the `users` join NO LONGER filters `deleted_at`. It used to
   * (`isNull(users.deletedAt)`), which meant a soft-deleted user matched ZERO rows here,
   * `planSearchabilityReconciliation` read `null` ("profile missing"), and the reconciler wrote
   * nothing — the one class of expert that most obviously must be de-listed was structurally
   * unreachable by every trigger. `users.deletedAt` is now SELECTED and surfaced as
   * `userDeletedAt` on the returned inputs so `deriveExpertChecklist` can decide (S1: a
   * soft-deleted user forces `allComplete = false` outright), instead of the read silently
   * having "no opinion". A row with NO user at all (should not happen given the FK, but codified
   * defensively) still yields zero rows and the existing not-found `undefined` arm, unchanged.
   *
   * ⚠ THE USER IS RESOLVED FROM `expert_profiles.user_id`, not from a caller's session. This
   * is a deliberate, small behaviour change from the pre-BAL-414 web read path: the API
   * triggers have no session at all, and for a well-formed session the two are identical.
   *
   * ⚠ S4 (fix round 1) — a bare by-id read on a scoped table, with no RLS: the WHERE clause is
   * the ONLY thing that can carry a scope. The optional `scope.userId` param adds
   * `AND expert_profiles.user_id = :userId` so `apps/web`'s session-authenticated read path can
   * pass `session.user.id` and get an extra scoping term for free. API triggers (the
   * credential-break/probe/OAuth/disconnect sources) keep calling the unscoped form — their
   * `expertProfileId` already comes from a subject row (a `CalendarConnection`), not a caller-
   * supplied value, so there is no session to scope against.
   */
  async loadInputs(
    expertProfileId: string,
    executor?: DbExecutor,
    scope?: { readonly userId: string }
  ): Promise<ExpertSearchabilitySnapshot | undefined> {
    const exec = executor ?? db;

    const rows = await exec
      .select({
        headline: expertProfiles.headline,
        bio: expertProfiles.bio,
        rateCents: expertProfiles.rateCents,
        searchable: expertProfiles.searchable,
        avatarUrl: users.avatarUrl,
        phoneVerifiedAt: users.phoneVerifiedAt,
        userDeletedAt: users.deletedAt,
        calendarConnections: liveCalendarConnectionsJson,
        hasActiveAvailabilityRules: hasActiveAvailabilityRulesExpression,
        hasPayoutDetails: hasPayoutDetailsExpression,
      })
      .from(expertProfiles)
      // S1 — no longer `and(eq(...), isNull(users.deletedAt))`. A soft-deleted user must still
      // MATCH this join (so the row reaches the derivation and gets de-listed), not vanish into
      // the not-found arm.
      .innerJoin(users, eq(users.id, expertProfiles.userId))
      .where(
        scope
          ? and(eq(expertProfiles.id, expertProfileId), eq(expertProfiles.userId, scope.userId))
          : eq(expertProfiles.id, expertProfileId)
      )
      .limit(1);

    // `noUncheckedIndexedAccess`: destructure + guard, never `rows[0]!`.
    const [row] = rows;
    if (row === undefined) return undefined;

    return {
      inputs: {
        headline: row.headline,
        bio: row.bio,
        avatarUrl: row.avatarUrl,
        phoneVerifiedAt: row.phoneVerifiedAt,
        rateCents: row.rateCents,
        calendarConnections: row.calendarConnections,
        hasActiveAvailabilityRules: row.hasActiveAvailabilityRules,
        hasPayoutDetails: row.hasPayoutDetails,
        userDeletedAt: row.userDeletedAt,
      },
      currentSearchable: row.searchable,
      rateCents: row.rateCents,
    };
  },

  /**
   * THE ONLY WRITER OF `expert_profiles.searchable` OUTSIDE SEEDS. A conditional
   * compare-and-set plus, when and only when the row actually changed, one append-only
   * `audit_events` row — both in ONE transaction. Self-wraps in `db.transaction` when
   * `executor` is omitted; pass a `tx` to join a caller's transaction.
   *
   * ⚠⚠ THE UPDATE CARRIES THE VALUE PREDICATE, AND THAT IS NOT OPTIONAL:
   *
   *     UPDATE expert_profiles SET searchable = $1, updated_at = now()
   *      WHERE id = $2 AND searchable <> $1
   *  RETURNING id
   *
   * Two triggers now write this column (the API credential-break/repair paths and the web
   * dashboard read path). Under READ COMMITTED a concurrent UPDATE on the same row blocks on
   * the row lock and then RE-EVALUATES its predicate against the newly committed version — so
   * of two racers targeting the same value exactly one matches a row and the loser matches
   * zero. That is a compare-and-set, not a read-then-write, and it needs no advisory lock, no
   * `SELECT … FOR UPDATE` and no version column. It buys three things at once: no lost update,
   * idempotence (a retried job writes nothing and appends no second audit row), and no
   * notification spam (a stable state is silent forever).
   *
   * ⚠ THE RESIDUAL RACE, STATED HONESTLY. Two reconcilers can read DIFFERENT input snapshots
   * and compute OPPOSITE targets; both then legitimately "change" the row and the last writer
   * wins. This is a genuine TOCTOU and it is not eliminated here. It is bounded and
   * self-correcting: the credential-break path supplies its own post-flip status override so
   * it never computes a stale `calendar`, and whichever value is wrong is recomputed on the
   * next probe tick, dashboard render, or connect/disconnect. It CANNOT be proven in the
   * integration harness either way — that harness runs every test inside one transaction on a
   * `max: 1` pool, so genuine concurrency is inexpressible there. What the harness pins is the
   * single-writer semantics.
   *
   * ⚠ FORBIDDEN "FIXES", call these out in review: a retry-until-stable loop (that IS the
   * flapping write loop); an unconditional `updateProfile({ searchable })` (reintroduces both
   * the lost update and the notification spam); a debounce/cooldown table (new schema, new
   * failure mode, and a stable state is already silent).
   *
   * ⚠ NO PUBLISH HERE, EVER. A repository does not notify: a publish from inside
   * `db.transaction` fires BEFORE commit and does not roll back. The caller emits post-commit,
   * gated on `changed`.
   */
  async applySearchable(
    input: ApplySearchableInput,
    executor?: DbExecutor
  ): Promise<ExpertSearchabilityWriteResult> {
    if (executor !== undefined) return applySearchableTx(executor, input);
    return db.transaction((tx) => applySearchableTx(tx, input));
  },
};

/**
 * The conditional flip + its audit row, on one executor. Extracted so the self-wrapping and
 * the compose-under-a-caller's-tx arms run byte-identical bodies.
 */
async function applySearchableTx(
  exec: DbExecutor,
  input: ApplySearchableInput
): Promise<ExpertSearchabilityWriteResult> {
  const updated = await exec
    .update(expertProfiles)
    .set({ searchable: input.searchable, updatedAt: new Date() })
    .where(
      and(
        eq(expertProfiles.id, input.expertProfileId),
        // `ne` is not in @balo/db's drizzle re-export list — imported from 'drizzle-orm' directly.
        ne(expertProfiles.searchable, input.searchable)
      )
    )
    .returning({ id: expertProfiles.id });

  // `noUncheckedIndexedAccess`: destructure + guard. Zero rows means the row already held the
  // target value (or does not exist) — either way there is nothing to record and nothing to
  // announce.
  const [row] = updated;
  if (row === undefined) return { changed: false };

  // The predicate above guarantees the committed value we replaced was the opposite one, so
  // this is exact rather than a snapshot the caller read earlier and might have raced.
  const previousSearchable = !input.searchable;

  const auditEvent = await auditEventsRepository.record(
    {
      actorUserId: input.actorUserId,
      action: input.searchable
        ? EXPERT_SEARCHABILITY_GRANTED_ACTION
        : EXPERT_SEARCHABILITY_REVOKED_ACTION,
      entityType: EXPERT_SEARCHABILITY_AUDIT_ENTITY_TYPE,
      entityId: input.expertProfileId,
      metadata: {
        source: input.source,
        failingItems: [...input.failingItems],
        previousSearchable,
        // S2 — omitted entirely unless `true`, so every pre-existing `row.metadata` assertion
        // (a `toEqual` on exactly {source, failingItems, previousSearchable}) is untouched.
        ...(input.actorImpersonating ? { actorImpersonating: true } : {}),
      },
    },
    exec
  );

  return { changed: true, auditEventId: auditEvent.id, previousSearchable };
}
