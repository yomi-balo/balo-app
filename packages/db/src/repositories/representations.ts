import { and, desc, eq, gt, isNull, isNotNull, lte, or } from 'drizzle-orm';
import { isRepresentableCapability, type Capability } from '@balo/shared/authz';
import { db } from '../client';
import { representations, type Representation, type RepresentationScope } from '../schema';
import type { DbExecutor } from './_shared/db-executor';
import { isUniqueViolation } from './experts';

/**
 * The (actor, company[, request]) triple a representation question is asked about.
 *
 * ⚠ `projectRequestId` MEANS TWO DIFFERENT THINGS IN TWO PLACES, DELIBERATELY. On a READ it
 * WIDENS — org grants ∪ this request's grants (`subjectGrainTerm`); in `grant()`'s uniqueness
 * lookup it is EXACT (`exactGrainTerm`) — a request grant is a different row from an org grant
 * and must never satisfy the other's partial-unique slot.
 */
export interface RepresentationSubject {
  actorUserId: string;
  companyId: string;
  projectRequestId?: string;
}

export interface GrantRepresentationInput {
  actorUserId: string;
  onBehalfOfCompanyId: string;
  scope: RepresentationScope;
  /** REQUIRED iff `scope === 'request'` — enforced here AND by the DB CHECK. */
  projectRequestId?: string;
  capabilities: readonly Capability[];
  /**
   * ATTRIBUTION ONLY. ⚠ Whether this user MAY grant is the CALLER'S question (ADR-1029), and
   * so is the no-escalation rule — *a granter may grant only capabilities they themselves
   * hold*. Neither is checked here; a gate inside a repository would be the deviation.
   */
  grantedByUserId: string;
  /** Omitted/null ⇒ no expiry. When present MUST be `> now`. */
  expiresAt?: Date | null;
}

export interface GrantRepresentationResult {
  representation: Representation;
  /**
   * `false` ⇒ an identical active grant already existed and was returned unchanged. Captured
   * now because BAL-314's deferred `representation_granted` analytics event must NOT fire on
   * an idempotent retry.
   */
  created: boolean;
}

export interface RevokeRepresentationInput {
  representationId: string;
  /**
   * ⚠ AN IDOR CONTAINMENT TERM, NOT A CONVENIENCE. `representationId` reaches a caller from a
   * request; this must be THE GATE'S company id, never the parsed request input. A foreign id,
   * an already-revoked one and one that never existed all resolve identically to `undefined`
   * (the `meetingRecordingsRepository.findInMeeting` rule).
   */
  onBehalfOfCompanyId: string;
  revokedByUserId: string;
}

/**
 * The requested capability set is empty, or carries a token outside
 * `REPRESENTABLE_CAPABILITIES`. Named so a future route branches on a TYPE rather than a
 * message, and so the rejected tokens can be reported without echoing the whole input.
 *
 * ⚠ THIS IS THE SECURITY GATE OF THIS TICKET. `capabilities` is jsonb: Postgres validates the
 * shape (non-empty array) and nothing else, so this check is the only thing standing between a
 * grant and `consume_credits` — a BASE member capability that draws down the customer's wallet.
 */
export class RepresentationCapabilityError extends Error {
  readonly rejected: string[];

  constructor(rejected: readonly string[]) {
    // ⚠ `String(...)`, NOT a bare `.join(', ')`. `rejected` is TYPED `readonly string[]` but
    // its members reach here from a caller-supplied array whose element type is only CLAIMED
    // (the input is `readonly Capability[]`, a compile-time assertion no runtime check backs).
    // A hostile array of objects would otherwise have its `toString` INVOKED while building a
    // message that Sentry and Pino then capture verbatim.
    const names = rejected.map((entry) => String(entry));
    super(
      names.length === 0
        ? 'A representation must carry at least one capability'
        : `Capabilities not representable: ${names.join(', ')}`
    );
    this.name = 'RepresentationCapabilityError';
    this.rejected = names;
  }
}

/**
 * `scope` and `projectRequestId` disagree. Backstops `representation_scope_request_paired`
 * with a message that names the incoherence instead of a raw `23514`.
 */
export class RepresentationScopeError extends Error {
  readonly scope: RepresentationScope;
  readonly projectRequestId: string | undefined;

  constructor(scope: RepresentationScope, projectRequestId: string | undefined) {
    super(`scope '${scope}' is incoherent with projectRequestId ${projectRequestId ?? '(absent)'}`);
    this.name = 'RepresentationScopeError';
    this.scope = scope;
    this.projectRequestId = projectRequestId;
  }
}

/**
 * `expiresAt` is at or before `now` — a grant that is born lapsed.
 *
 * ⚠ UN-CHECK-ABLE IN THE DATABASE. `now()` is not IMMUTABLE, so this cannot be a CHECK
 * constraint; the repository is the only place it can be refused.
 */
export class RepresentationExpiryError extends Error {
  readonly expiresAt: Date;
  readonly now: Date;

  constructor(expiresAt: Date, now: Date) {
    super(`expiresAt ${expiresAt.toISOString()} is not after ${now.toISOString()}`);
    this.name = 'RepresentationExpiryError';
    this.expiresAt = expiresAt;
    this.now = now;
  }
}

/**
 * An active grant already exists for this EXACT subject but DIFFERS from the one requested
 * (different capabilities, or a different expiry).
 *
 * ⚠ WHY THIS THROWS RATHER THAN RETURNING THE EXISTING ROW OR UPDATING IT. Returning the
 * stale row LIES IN BOTH DIRECTIONS — the caller who asked to narrow to `[participate]` gets
 * back a grant that still carries `manage_requests`, and the caller who asked to extend the
 * expiry believes it was extended. Silently UPDATING is worse: it lets `grant()` widen an
 * existing narrower grant with no revoke→re-grant trail, when `revoked_at` /
 * `revoked_by_user_id` exist precisely to record that a grant ended and who ended it. Fail
 * closed — the caller must `revoke()` then `grant()`, which leaves the record. Neither silent
 * option could be repaired later without a behaviour change; this throw can be relaxed
 * without one.
 *
 * `existingRepresentationId` is `null` only in the defensive case where the insert conflicted
 * yet no live row could be read back (a concurrent revoke between the two statements).
 */
export class RepresentationConflictError extends Error {
  readonly existingRepresentationId: string | null;

  constructor(existingRepresentationId: string | null) {
    super(
      existingRepresentationId === null
        ? 'A conflicting representation exists but could not be read back'
        : `A different active representation already exists: ${existingRepresentationId}`
    );
    this.name = 'RepresentationConflictError';
    this.existingRepresentationId = existingRepresentationId;
  }
}

/**
 * THE ACTIVE PREDICATE — restated ONCE: `status = 'active' AND deleted_at IS NULL AND
 * (expires_at IS NULL OR expires_at > $now)`. Every read composes it; no caller re-derives
 * what "active" means, because two definitions is two chances for one to drift.
 *
 * ⚠ THIS IS THE ENFORCEMENT, NOT A DERIVATION. Expiry is LAZY: a lapsed row keeps
 * `status = 'active'` in the column and only `grant()`'s `expireLapsedForSubject` step moves
 * it. The column REPORTS; this predicate REFUSES.
 *
 * ⚠ `gt`, NOT `gte`. At exactly `expires_at` the grant has lapsed.
 *
 * ⚠ `gt(col, now)` — a MAPPED comparison, never `sql`${col} > ${now}``: a `Date` inside a raw
 * `sql` template throws at bind time (memory `reference_date_in_raw_sql_template_throws`), a
 * failure typecheck cannot see.
 *
 * ⚠ `now` IS A CALLER OBLIGATION, AND IT IS THE ONLY THING ENFORCING EXPIRY. This predicate is
 * the WHOLE of expiry enforcement — the `status` column still says `active` on a lapsed row —
 * so a caller who supplies a past `now` reads a lapsed grant as live, and one who supplies a
 * far-future `now` silently deactivates every live grant. `now` MUST be SERVER-DERIVED at the
 * gate (`new Date()` in the Server Action / route handler), NEVER parsed from request input,
 * a query string, a header or a client-sent body — the same discipline as `revoke()`'s
 * `onBehalfOfCompanyId`. BAL-314 threading a client timestamp into `activeCapabilitiesFor`
 * would bypass expiry entirely, with no other check to catch it.
 */
function liveRepresentation(now: Date) {
  return and(
    eq(representations.status, 'active'),
    isNull(representations.deletedAt),
    or(isNull(representations.expiresAt), gt(representations.expiresAt, now))
  );
}

/**
 * READ grain — WIDENING. An ORG grant satisfies a request-scoped question; a REQUEST grant
 * never satisfies an org-scoped one. That asymmetry is the escalation guard: a grant confined
 * to one request must not answer "may this actor act for the company at large?".
 *
 * The `or(...)` IS the "org grants UNION request grants" read — one index-friendly predicate,
 * no SQL `UNION`, no second query.
 */
function subjectGrainTerm(subject: RepresentationSubject) {
  return subject.projectRequestId === undefined
    ? isNull(representations.projectRequestId)
    : or(
        isNull(representations.projectRequestId),
        eq(representations.projectRequestId, subject.projectRequestId)
      );
}

/** WRITE grain — EXACT. Identifies the one row that owns a partial-unique slot. */
function exactGrainTerm(projectRequestId: string | undefined) {
  return projectRequestId === undefined
    ? isNull(representations.projectRequestId)
    : eq(representations.projectRequestId, projectRequestId);
}

/**
 * Dedupe + lexicographic sort. Makes the stored jsonb DETERMINISTIC, which is what lets
 * `grantMatches` be a plain positional array comparison rather than a set comparison, and what
 * makes `['manage_requests','participate','participate']` idempotent against a stored
 * `['manage_requests','participate']`.
 */
function normalizeCapabilities(input: readonly Capability[]): Capability[] {
  return [...new Set(input)].sort(compareCapabilities);
}

/** Explicit lexicographic comparator — `.sort()` with no comparator is a lint/Sonar smell. */
function compareCapabilities(a: Capability, b: Capability): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * What a ROW actually holds, coerced.
 *
 * ⚠ NOT MERELY DEFENSIVE TYPING. `capabilities` is jsonb and `$type<Capability[]>()` is a
 * compile-time claim Postgres does not enforce (memory `reference_jsonb_date_type_lie`); the
 * CHECK pins "a non-empty array" and nothing about the elements, and a row can arrive from a
 * script or a hand edit. Iterating a non-array would throw.
 *
 * ⚠ IT DOES NOT APPLY THE ALLOWLIST, DELIBERATELY — DO NOT "TIGHTEN" IT BY MOVING THE FILTER
 * IN HERE. `grantMatches` must see the row EXACTLY as stored: filtering here would let a
 * stored `['participate','consume_credits']` "match" a request for `['participate']` and be
 * handed back from `grant()` as an idempotent hit. The allowlist is applied ON TOP, at the two
 * READ boundaries that hand capabilities out — `activeCapabilitiesFor` and
 * `findActiveForActor` — and nowhere else.
 */
function storedCapabilities(value: unknown): Capability[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is Capability => typeof entry === 'string');
}

/**
 * Is the existing active grant the SAME grant the caller just asked for?
 *
 * `granted_by_user_id` is deliberately NOT compared — a different granter re-issuing the
 * identical grant is the same grant, and a retry from a second admin must stay idempotent.
 */
function grantMatches(
  existing: Representation,
  capabilities: readonly Capability[],
  expiresAt: Date | null
): boolean {
  const stored = normalizeCapabilities(storedCapabilities(existing.capabilities));
  if (stored.length !== capabilities.length) return false;
  if (stored.some((capability, index) => capability !== capabilities[index])) return false;

  const storedExpiry = existing.expiresAt;
  if (storedExpiry === null) return expiresAt === null;
  return expiresAt !== null && storedExpiry.getTime() === expiresAt.getTime();
}

/**
 * The shared body of `expireLapsedForSubject`, threaded onto whatever executor the caller is
 * already inside — so `grant()` can run it as the FIRST statement of its own transaction
 * without opening a second one.
 *
 * ⚠ `lte(expires_at, now)` is the EXACT COMPLEMENT of the read's `gt(expires_at, now)`. The
 * two must stay complementary, or a row becomes both unreadable and un-sweepable.
 * ⚠ `revoked_at` / `revoked_by_user_id` stay NULL — nobody acted.
 */
async function expireLapsedForSubjectTx(
  subject: RepresentationSubject,
  now: Date,
  exec: DbExecutor
): Promise<number> {
  const rows = await exec
    .update(representations)
    .set({ status: 'expired', updatedAt: now })
    .where(
      and(
        eq(representations.actorUserId, subject.actorUserId),
        eq(representations.onBehalfOfCompanyId, subject.companyId),
        exactGrainTerm(subject.projectRequestId),
        eq(representations.status, 'active'),
        isNotNull(representations.expiresAt),
        lte(representations.expiresAt, now),
        isNull(representations.deletedAt)
      )
    )
    .returning({ id: representations.id });
  return rows.length;
}

/** The ONE live row owning a subject's EXACT partial-unique slot, if there is one. */
async function findActiveExactTx(
  subject: RepresentationSubject,
  now: Date,
  exec: DbExecutor
): Promise<Representation | undefined> {
  const [row] = await exec
    .select()
    .from(representations)
    .where(
      and(
        eq(representations.actorUserId, subject.actorUserId),
        eq(representations.onBehalfOfCompanyId, subject.companyId),
        exactGrainTerm(subject.projectRequestId),
        liveRepresentation(now)
      )
    )
    .limit(1);
  return row;
}

/**
 * `representationsRepository` (BAL-313 / ADR-1028 Phase 1) — the data-access layer for
 * act-on-behalf grants: "user A may act for company B, carrying capability set C, until D".
 *
 * ⚠ IT SHIPS INERT. Nothing in the product calls this yet — no UI, no Server Action, no API
 * route (BAL-314 is the first consumer), and `hasCapability` is untouched.
 *
 * ⚠ AUTHORIZATION IS THE CALLER'S (ADR-1029). Nothing here decides who may grant or revoke;
 * `revoke()`'s `onBehalfOfCompanyId` is a containment term the caller must source from ITS
 * GATE, not from request input. The one rule this file does enforce is the capability
 * ALLOWLIST (`REPRESENTABLE_CAPABILITIES`), because jsonb validates nothing and that gate has
 * nowhere else to live on the write path.
 *
 * POLICY-FREE BY CONSTRUCTION. `now` and `expiresAt` arrive from the CALLER (the
 * `rescheduleProposalsRepository` contract). This file knows how to move a grant between
 * states; it does not know how long a grant should live or who should hold one.
 *
 * Every method takes `exec: DbExecutor = db` as its LAST, DEFAULTED argument, so a caller can
 * write a grant and its own audit/outbox row in ONE transaction.
 *
 * Every read AND every write predicate filters `deleted_at IS NULL`.
 */
export const representationsRepository = {
  /**
   * Find-or-create the active grant for one subject. Idempotent by construction.
   *
   * ⚠ `expireLapsedForSubject` RUNS FIRST, INSIDE THIS TRANSACTION, AND IT IS NOT AN
   * OPTIMISATION. Neither partial unique can mention `now()` (not IMMUTABLE), so a LAPSED
   * grant still occupies the subject's slot with `status = 'active'`. Without this statement,
   * re-granting after an expiry would fail `23505` FOREVER.
   *
   * ⚠ INSERT-FIRST, AND NO `ON CONFLICT` ANYWHERE. Three reasons, the third decisive:
   *   1. Two partial uniques ⇒ two arbiters ⇒ a scope branch inside the insert, each
   *      restating `status = 'active'` with the literal INLINED in raw `sql`; a Drizzle `eq()`
   *      there emits a bind `$n` that Postgres's plan-time predicate-implication proof can
   *      never match, failing `42P10` at runtime with typecheck green (memory
   *      `reference_pg_partial_index_arbiter_param_42p10`).
   *   2. `DO NOTHING` returns zero rows on conflict, so "it already existed" needs the
   *      follow-up read anyway — the clause would buy nothing.
   *   3. It would be UNTESTABLE. With a pre-`SELECT`, an `ON CONFLICT` clause fires only in a
   *      real concurrent race, and the integration harness is one transaction on a `max:1`
   *      pool where concurrency is inexpressible (memory
   *      `reference_db_integration_harness_no_concurrency`). A `42P10` arbiter bug would ship
   *      green. Insert-first makes the ORDINARY "grant twice" test the conflict-path test.
   *
   * ⚠ THE NESTED `tx.transaction` IS LOAD-BEARING, NOT DECORATION. A raw `23505` ABORTS the
   * ambient transaction and every later statement answers `25P02` — step (d)'s read could not
   * run, and this repository would be untestable under the harness (memory
   * `reference_caught_23505_aborts_test_transaction`). Drizzle compiles a nested
   * `transaction()` into `SAVEPOINT` + `ROLLBACK TO SAVEPOINT`, which contains the violation
   * and leaves `tx` healthy. Never catch a bare `23505` without one.
   *
   * Throws {@link RepresentationConflictError} when an active grant for the same EXACT subject
   * exists but differs — see that class for why silence would be the worse answer.
   */
  async grant(
    input: GrantRepresentationInput,
    now: Date,
    exec: DbExecutor = db
  ): Promise<GrantRepresentationResult> {
    // ── PURE VALIDATION, BEFORE ANY STATEMENT (validate-before-write). ──
    const capabilities = normalizeCapabilities(input.capabilities);
    if (capabilities.length === 0) {
      throw new RepresentationCapabilityError([]);
    }
    const rejected = capabilities.filter((capability) => !isRepresentableCapability(capability));
    if (rejected.length > 0) {
      throw new RepresentationCapabilityError(rejected);
    }
    if ((input.scope === 'request') !== (input.projectRequestId !== undefined)) {
      throw new RepresentationScopeError(input.scope, input.projectRequestId);
    }
    const expiresAt = input.expiresAt ?? null;
    if (expiresAt !== null && expiresAt.getTime() <= now.getTime()) {
      throw new RepresentationExpiryError(expiresAt, now);
    }

    const subject: RepresentationSubject = {
      actorUserId: input.actorUserId,
      companyId: input.onBehalfOfCompanyId,
      projectRequestId: input.projectRequestId,
    };

    return exec.transaction(async (tx) => {
      await expireLapsedForSubjectTx(subject, now, tx);

      let inserted: Representation | undefined;
      try {
        inserted = await tx.transaction(async (inner) => {
          const [row] = await inner
            .insert(representations)
            .values({
              actorUserId: input.actorUserId,
              onBehalfOfCompanyId: input.onBehalfOfCompanyId,
              scope: input.scope,
              projectRequestId: input.projectRequestId ?? null,
              capabilities,
              grantedByUserId: input.grantedByUserId,
              expiresAt,
            })
            .returning();
          if (row === undefined) {
            throw new Error('representation insert returned no row');
          }
          return row;
        });
      } catch (error) {
        if (
          !isUniqueViolation(error, 'representation_active_org_idx') &&
          !isUniqueViolation(error, 'representation_active_request_idx')
        ) {
          throw error;
        }
        // The SAVEPOINT rolled back; `tx` is healthy and every statement below still runs.
        inserted = undefined;
      }

      if (inserted !== undefined) {
        return { representation: inserted, created: true };
      }

      const existing = await findActiveExactTx(subject, now, tx);
      if (existing === undefined) {
        throw new RepresentationConflictError(null);
      }
      if (!grantMatches(existing, capabilities, expiresAt)) {
        throw new RepresentationConflictError(existing.id);
      }
      return { representation: existing, created: false };
    });
  },

  /**
   * Mark every LAPSED-but-`active` grant for ONE subject `expired`, returning how many moved.
   * Zero is the normal case.
   *
   * ⚠ THIS IS THE PARTIAL UNIQUES' MISSING HALF, NOT A SWEEP. It runs as the first statement
   * of `grant()`'s transaction and nowhere else — there is no job, no cron and no background
   * pass over this table. Expiry stays LAZY; this exists only to free the slot for the next
   * grant. Exported in its own right so the write path can be driven — and asserted —
   * directly (the `expireStaleForMeeting` precedent).
   *
   * ⚠ EXACT GRAIN — `subject.projectRequestId` DOES NOT WIDEN HERE, unlike on a read. This
   * uses `exactGrainTerm`, so `{ actorUserId, companyId }` (no request id) sweeps ONLY the
   * ORG-grain row and leaves that actor's lapsed REQUEST-grain rows untouched; each
   * request-grain lapse must be swept by passing that request's own id. Correct for the one
   * job this has — freeing the ONE partial-unique slot `grant()` is about to insert into —
   * and wrong for anything shaped like "expire everything stale for this actor". Do not read
   * the name as a sweep; see `subjectGrainTerm` vs `exactGrainTerm` for the asymmetry.
   */
  async expireLapsedForSubject(
    subject: RepresentationSubject,
    now: Date,
    exec: DbExecutor = db
  ): Promise<number> {
    return expireLapsedForSubjectTx(subject, now, exec);
  },

  /**
   * End one grant. ONE conditional `UPDATE … RETURNING` — the CAS IS the serialisation point,
   * so the double-revoke race is closed by the database rather than by a read-then-write.
   *
   * `undefined` ⇒ already revoked or expired, soft-deleted, another company's, or never
   * existed. ⚠ NOT AN ERROR — it is the LOSER'S ANSWER, and every caller maps all four cases
   * to ONE wire literal (the `rescheduleProposalsRepository.decline` contract). Distinguishing
   * them would leak the existence of another company's grant.
   *
   * ⚠ NOT GUARDED ON EXPIRY, DELIBERATELY — the ONE intended asymmetry with
   * `liveRepresentation`. Revoking a lapsed-but-`status='active'` grant must SUCCEED: it is
   * the explicit termination of something the column still calls active, and refusing would
   * leave the row un-endable until some later `grant()` happened to sweep it.
   *
   * Writes NO `deleted_at` — revoke is a `status` transition, not a soft delete.
   */
  async revoke(
    input: RevokeRepresentationInput,
    now: Date,
    exec: DbExecutor = db
  ): Promise<Representation | undefined> {
    const [row] = await exec
      .update(representations)
      .set({
        status: 'revoked',
        revokedAt: now,
        revokedByUserId: input.revokedByUserId,
        updatedAt: now,
      })
      .where(
        and(
          eq(representations.id, input.representationId),
          eq(representations.onBehalfOfCompanyId, input.onBehalfOfCompanyId),
          eq(representations.status, 'active'),
          isNull(representations.deletedAt)
        )
      )
      .returning();
    return row;
  },

  /**
   * Every LIVE grant this actor holds, across ALL companies and BOTH grains, newest first.
   *
   * BAL-314's "which companies may I act for?" read. Full rows — uuids, enums and timestamps
   * only, no PII — so no projection is needed here; the caller narrows at the web boundary.
   *
   * ⚠ `capabilities` IS RE-FILTERED THROUGH THE ALLOWLIST BEFORE IT LEAVES, exactly as
   * `activeCapabilitiesFor` does, and for exactly the same reasons: `$type<Capability[]>()` is
   * a compile-time claim Postgres does not enforce, a row can arrive from a seed, a test
   * factory or a hand edit carrying `consume_credits`, and NARROWING
   * `REPRESENTABLE_CAPABILITIES` later must take effect immediately rather than waiting for a
   * backfill. Returning the raw jsonb here would hand a caller an un-representable token with
   * the full blessing of the `Capability[]` type. The two reads must never disagree about what
   * a stored row grants.
   *
   * ⚠ THE FILTER IS APPLIED HERE, AT THE BOUNDARY — NEVER INSIDE `storedCapabilities`. See
   * that function: `grantMatches` must compare the row EXACTLY as stored, or a stored
   * `['participate','consume_credits']` would compare equal to a request for `['participate']`
   * and be handed back from `grant()` as an idempotent hit.
   *
   * ⚠ `now` MUST BE SERVER-DERIVED — see {@link liveRepresentation}. It is the only thing
   * making a lapsed grant read inactive.
   */
  async findActiveForActor(
    actorUserId: string,
    now: Date,
    exec: DbExecutor = db
  ): Promise<Representation[]> {
    const rows = await exec
      .select()
      .from(representations)
      .where(and(eq(representations.actorUserId, actorUserId), liveRepresentation(now)))
      .orderBy(desc(representations.createdAt));

    return rows.map((row) => ({
      ...row,
      capabilities: storedCapabilities(row.capabilities).filter(isRepresentableCapability),
    }));
  },

  /**
   * The capabilities this actor may exercise for this company right now — the union of the
   * subject's live org grant and, when a request is named, that request's live grant.
   * `[]` when there is no grant: FAIL CLOSED, never `undefined`.
   *
   * ⚠ PROJECTION ONLY — `select({ capabilities })`, never a full-row or relational `with:`
   * hydration, which pulls whole rows including secrets and PII (memory
   * `reference_drizzle_with_hydration_leaks_secrets`).
   *
   * ⚠ THE READ-SIDE ALLOWLIST FILTER IS NOT BELT-AND-BRACES. `$type<Capability[]>()` is a
   * compile-time claim Postgres does not enforce; rows can be written by a script or a hand
   * edit; and NARROWING `REPRESENTABLE_CAPABILITIES` later must take effect immediately on
   * stored rows rather than waiting for a backfill. `findActiveForActor` applies the SAME
   * filter — the two reads must never disagree about what a stored row grants.
   *
   * ⚠ `now` MUST BE SERVER-DERIVED — see {@link liveRepresentation}. It is the only thing
   * making a lapsed grant read inactive, so a client-supplied timestamp threaded in here
   * bypasses expiry outright.
   *
   * Shaped for BAL-314 without a rewrite: an input OBJECT (new fields stay additive), a plain
   * `async` return (`apps/web/src/lib/authz/index.ts` is already `server-only`, already
   * `async` and already does a live `@balo/db` read, so no synchronous constraint exists), and
   * the WIDENING grain term so one call answers with or without a request id.
   * ⚠ DO NOT modify `hasCapability` or any of its call sites from here — that is BAL-314's.
   */
  async activeCapabilitiesFor(
    subject: RepresentationSubject,
    now: Date,
    exec: DbExecutor = db
  ): Promise<Capability[]> {
    const rows = await exec
      .select({ capabilities: representations.capabilities })
      .from(representations)
      .where(
        and(
          eq(representations.actorUserId, subject.actorUserId),
          eq(representations.onBehalfOfCompanyId, subject.companyId),
          subjectGrainTerm(subject),
          liveRepresentation(now)
        )
      );

    const granted = new Set<Capability>();
    for (const row of rows) {
      for (const capability of storedCapabilities(row.capabilities)) {
        if (isRepresentableCapability(capability)) granted.add(capability);
      }
    }
    return normalizeCapabilities([...granted]);
  },
};
