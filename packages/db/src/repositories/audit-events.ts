import { and, asc, desc, eq, gte, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { db } from '../client';
import {
  agencies,
  agencyMembers,
  auditEvents,
  companies,
  companyMembers,
  users,
  type AuditEvent,
} from '../schema';
import type { DbExecutor } from './_shared/db-executor';
import type { EngagementType } from './_shared/engagement-supertype';

/** Input for one immutable audit row. `metadata` is optional structured context. */
export interface RecordAuditInput {
  actorUserId: string | null;
  action: string; // e.g. 'party_domain.captured'
  entityType: string; // e.g. 'party_domain'
  entityId: string;
  metadata?: Record<string, unknown> | null;
}

// ── BAL-555 — the Timeline reader ─────────────────────────────────────────────────────

/** Exclusive backward cursor: the OLDEST row of the page already shown. */
export interface AuditTrailCursor {
  /**
   * ⚠⚠ FULL MICROSECOND PRECISION, EXACTLY AS POSTGRES PRINTS IT
   * (`created_at::text`, e.g. `'2026-09-11 10:00:00.083951+00'`) — NEVER a JS `Date` and NEVER
   * the product of `.toISOString()`. `audit_events.created_at` is `transaction_timestamp()`,
   * genuinely microsecond-precision, but a JS `Date` is millisecond-precision only. Round-
   * tripping it through one truncates `.083951` to `.083`; the row-value predicate below then
   * compares the TRUE `created_at` of every row in that same-millisecond cluster (`.083951`)
   * against the TRUNCATED cursor (`.083`), which is always FALSE, so the whole cluster is
   * silently dropped from the older page (BAL-555 — this is BAL-426 residual 2's entire reason
   * for existing).
   *
   * Treat this as an OPAQUE, Postgres-parseable STRING end to end: never parse it into a
   * `Date` on the cursor path, never re-derive it from one. `AuditTrailRow.createdAt` is a
   * SEPARATE `Date` read from the SAME column, for DISPLAY ONLY, where millisecond precision is
   * fine — do NOT "simplify" the two back into one; that reintroduces this bug silently.
   */
  readonly createdAtPrecise: string;
  /** ⚠ A JS NUMBER (`bigint('seq', { mode: 'number' })`, schema/audit-events.ts). NEVER stringify it. */
  readonly seq: number;
}

/** One audit row plus the ACTOR FACTS a retrospective attribution needs. No composed copy here. */
export interface AuditTrailRow {
  readonly id: string;
  readonly action: string;
  readonly createdAt: Date;
  readonly seq: number;
  readonly metadata: unknown;
  readonly actorUserId: string | null;
  readonly actorFirstName: string | null;
  readonly actorLastName: string | null;
  /** `users.platformRole`; null iff there is no actor (the ADR-1030 system-actor exemption). */
  readonly actorPlatformRole: 'user' | 'admin' | 'super_admin' | null;
  /** Oldest LIVE company membership name for a non-staff actor, else null. */
  readonly actorCompanyName: string | null;
  /** Oldest LIVE agency membership name for a non-staff actor, else null. */
  readonly actorAgencyName: string | null;
}

export interface ListTrailForEntityInput {
  readonly entityType: string;
  readonly entityId: string;
  readonly limit: number;
  readonly before?: AuditTrailCursor;
  /**
   * ⚠⚠ THE CALLER'S ASSERTION THAT IT HAS ALREADY RESOLVED
   * `PLATFORM_CAPABILITIES.VIEW_PLATFORM_ADMIN` (ADR-1029 / ADR-1035). Literal `true`, not
   * `boolean`, so writing the word is a deliberate act at every call site — the exact shape
   * `PlatformLookupSearchInput.authorizedPlatformStaff` uses (`platform-lookup.ts`).
   * This is a CROSS-TENANT read of any entity's trail; `audit-trail-reader-single-caller.test.ts`
   * pins that exactly one module calls it.
   */
  readonly authorizedPlatformStaff: true;
}

export interface AuditTrailPage {
  /** ASCENDING (oldest first) — read DESC, reversed here. See `listTrailForEntity`. */
  readonly rows: readonly AuditTrailRow[];
  readonly hasEarlier: boolean;
  /** The cursor to pass as `before` for the previous (older) page; null when `hasEarlier` is false. */
  readonly earlierCursor: AuditTrailCursor | null;
}

/**
 * BAL-426 residual 2 — the keyset predicate, a ROW-VALUE comparison in the SAME direction as
 * the ORDER BY. Exported (not inlined) so `audit-events.test.ts` can render it with `PgDialect`
 * and pin the generated SQL verbatim; a comment cannot hold this shape.
 *
 * ⚠⚠ THE TWO WAYS TO GET THIS WRONG, BOTH SILENT:
 *   · `and(lt(createdAt, x), lt(seq, y))` is simply WRONG — it drops every row that is older
 *     but carries a HIGHER seq, and no test that pages a tie-free trail ever notices.
 *   · the expanded `or(lt(createdAt,x), and(eq(createdAt,x), lt(seq,y)))` form is EQUIVALENT
 *     but easy to mis-nest; `audit-trail-ordering.test.ts` bans any Drizzle scalar comparison
 *     on `auditEvents.seq` precisely so nobody reaches for it here. (The working precedent for
 *     the expanded shape is `conversations.ts`; check the semantics against it, write the
 *     row-value form.)
 *
 * ⚠⚠ `cursor.createdAtPrecise` IS INTERPOLATED VERBATIM — NEVER THROUGH A JS `Date`, AND NEVER
 * VIA `.toISOString()`. See {@link AuditTrailCursor.createdAtPrecise} for why: a `Date` (and
 * therefore `.toISOString()`, which reads one) is millisecond-precision only, while
 * `created_at` carries genuine microsecond precision, and truncating it here silently drops an
 * entire same-millisecond cluster from the older page (BAL-555, closing BAL-426 residual 2's
 * remaining gap). This is still a BOUND PARAMETER — drizzle's `sql` tag parameterizes every
 * `${}` interpolation — never string concatenation.
 *
 * A bare `Date` interpolated into a raw `sql` template bypasses the column's timestamptz mapper
 * and reaches postgres-js's `bytes.str`, which throws *"Received an instance of Date"* AT BIND
 * TIME (memory `reference_date_in_raw_sql_template_throws`) — one more reason the value here
 * must already be a string before it reaches this function. `pnpm typecheck` is green either
 * way — only an integration run catches either defect, which is why
 * `audit-events.integration.test.ts` must exercise the cursor path against real Postgres.
 *
 * `::bigint` on `seq` is explicit rather than relying on Postgres inferring an untyped
 * parameter inside a row comparison.
 */
export function auditTrailKeysetBefore(cursor: AuditTrailCursor): SQL {
  return sql`(${auditEvents.createdAt}, ${auditEvents.seq}) < (${cursor.createdAtPrecise}::timestamptz, ${cursor.seq}::bigint)`;
}

/**
 * The `platform-lookup.ts` E1-shaped batched follow-up: one live company membership plus one
 * live agency membership per matched actor, over the DISTINCT non-null actor ids of the page
 * only (≤ page size). Both halves short-circuit to an empty Map on empty input, so an empty
 * `inArray` — a SQL error — is unreachable. Kept PRIVATE to this file: it is used by one
 * reader, and a `_shared/` file would be a new file under `repositories/` with its own
 * coverage obligation for no reuse.
 */
async function loadActorOrgNames(
  userIds: readonly string[]
): Promise<Map<string, { companyName: string | null; agencyName: string | null }>> {
  if (userIds.length === 0) return new Map();

  const [companyRows, agencyRows] = await Promise.all([
    db
      .select({ userId: companyMembers.userId, companyName: companies.name })
      .from(companyMembers)
      .innerJoin(companies, eq(companies.id, companyMembers.companyId))
      .where(and(isNull(companyMembers.deletedAt), inArray(companyMembers.userId, [...userIds])))
      .orderBy(asc(companyMembers.joinedAt), asc(companyMembers.id)),
    db
      .select({ userId: agencyMembers.userId, agencyName: agencies.name })
      .from(agencyMembers)
      .innerJoin(agencies, eq(agencies.id, agencyMembers.agencyId))
      .where(and(isNull(agencyMembers.deletedAt), inArray(agencyMembers.userId, [...userIds])))
      .orderBy(asc(agencyMembers.joinedAt), asc(agencyMembers.id)),
  ]);

  const byUser = new Map<string, { companyName: string | null; agencyName: string | null }>();
  for (const row of companyRows) {
    if (!byUser.has(row.userId)) {
      byUser.set(row.userId, { companyName: row.companyName, agencyName: null });
    }
  }
  for (const row of agencyRows) {
    const existing = byUser.get(row.userId);
    if (existing === undefined) {
      byUser.set(row.userId, { companyName: null, agencyName: row.agencyName });
    } else if (existing.agencyName === null) {
      byUser.set(row.userId, { ...existing, agencyName: row.agencyName });
    }
  }
  return byUser;
}

export const auditEventsRepository = {
  /**
   * Append one immutable audit row. Takes an executor so it participates in the
   * CALLER'S `db.transaction` — the audit row and the change it records commit or
   * roll back together. Pass the base `db` for standalone use.
   */
  record: async (input: RecordAuditInput, exec: DbExecutor): Promise<AuditEvent> => {
    const [row] = await exec
      .insert(auditEvents)
      .values({
        actorUserId: input.actorUserId,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId,
        metadata: input.metadata ?? null,
      })
      .returning();
    if (row === undefined) {
      throw new Error('audit_events insert returned no row');
    }
    return row;
  },

  /**
   * Count the immutable audit rows for one entity + action — the indexed
   * "how many times has X happened to this entity" read. Rides
   * `audit_events_entity_idx` (entity_type, entity_id) with the `action` filter
   * applied on top; no JSON/metadata scan (the engagement id IS `entity_id` for
   * engagement-level rows, not only inside `metadata`). Used by BAL-334 to derive
   * `review_cycle` (the number of prior `engagement.completion_requested` rows for
   * an engagement) AFTER the request commits. Standalone read → uses the base `db`.
   */
  countByEntityAndAction: async (input: {
    entityType: string;
    entityId: string;
    action: string;
  }): Promise<number> => {
    const [row] = await db
      .select({ count: sql<number>`cast(count(*) as int)` })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.entityType, input.entityType),
          eq(auditEvents.entityId, input.entityId),
          eq(auditEvents.action, input.action)
        )
      );
    return row?.count ?? 0;
  },

  /**
   * BAL-400 (S6) — how many rows ONE ACTOR has appended for ONE ACTION since `since`. The
   * append-only log doubles as a durable, infrastructure-free rate-limit counter for write
   * paths that live in `apps/web`, where `apps/api`'s Redis limiter is unreachable (there is
   * no Redis client, and no `REDIS_URL`, in the Next app).
   *
   * ⚠ IT IS A COUNTER, NOT A RESERVATION. It cannot be atomic against a concurrent burst the
   * way a Redis `INCR` is: two simultaneous requests can both read `n` and both proceed. That
   * is accepted — the target is the SCRIPTED loop (thousands of rows), not the two-request
   * race, and the alternative is standing up Redis in `apps/web` for one cap.
   *
   * Rides `audit_events_actor_idx` (`actor_user_id`) with the `action` + `created_at` filters
   * applied on top; one actor's audit history is small enough that no composite index is
   * warranted. `actorUserId` is required here — a `null`-actor (system) row is never rate
   * limited, so a `NULL` argument would be meaningless rather than merely useless.
   *
   * ⚠ N2 (reverify round 3) — `action: 'engagement.created'` is TYPE-AGNOSTIC BY DESIGN
   * (`_shared/delivery-audit.ts`): it fires for BOTH a case create and a project kickoff, with
   * the concrete product distinguished only by `metadata.engagement_type`. A caller that counts
   * `'engagement.created'` WITHOUT `engagementType` is therefore counting BOTH products against
   * ONE shared budget — that was BAL-400's original bug (a burst of approved project kickoffs
   * could exhaust a client's case-booking budget with no case involved). Pass `engagementType`
   * whenever the count is meant to gate one product's write path; only omit it when a budget is
   * deliberately meant to span both (no current caller does this).
   *
   * The `engagementType` filter reads `metadata->>'engagement_type'` via a raw `->>` (jsonb →
   * text) comparison — there is no index on `metadata`, but this still rides
   * `audit_events_actor_idx` first (actor + action + created_at narrow the row set to "one
   * actor's recent history" before the jsonb comparison ever runs), so the extra predicate is
   * cheap.
   */
  countByActorAndActionSince: async (input: {
    actorUserId: string;
    action: string;
    since: Date;
    engagementType?: EngagementType;
  }): Promise<number> => {
    const [row] = await db
      .select({ count: sql<number>`cast(count(*) as int)` })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.actorUserId, input.actorUserId),
          eq(auditEvents.action, input.action),
          gte(auditEvents.createdAt, input.since),
          input.engagementType === undefined
            ? undefined
            : sql`${auditEvents.metadata} ->> 'engagement_type' = ${input.engagementType}`
        )
      );
    return row?.count ?? 0;
  },

  /**
   * The MOST-RECENT audit row for one entity + action (BAL-347) — powers the
   * "Last changed by {Name} · {date}" header on the join-mode card. Returns the
   * actor id + timestamp (the caller batch-hydrates the name), or `undefined` when
   * the action has never occurred.
   *
   * Rides `audit_events_entity_idx` (entity_type, entity_id) with the `action` filter + a
   * `created_at DESC, seq DESC LIMIT 1`.
   *
   * ⚠ BAL-426 — BOTH KEYS DESCEND, AND THAT IS NOT COSMETIC. The trail contract is
   * "`created_at` then `seq`, both in the SAME direction". `created_at` is the TRANSACTION
   * timestamp, so two rows of the same entity + action written in one `db.transaction` tie on
   * it; before `seq` this function had no tiebreaker whatsoever and Postgres was free to return
   * either row, so "the most recent" was already arbitrary for a tie. Writing
   * `desc(createdAt), asc(seq)` — or pasting in the ascending `(created_at, seq)` form the ticket
   * quotes — returns the EARLIEST row of that tie and inverts this function. `asc` here is a bug,
   * not a style choice.
   *
   * ⚠ BAL-540 widened this by exactly ONE column, `metadata` — additive; every existing
   * caller (BAL-347's team page) already ignores extra fields. `request-detail-view.ts`'s
   * `deriveClosedSummary` is the first reader: it needs the `project_request.closed` audit
   * row's `metadata.counts` (tracksDeclined/proposalsWithdrawn/meetingsCancelled) to render
   * the `ClosedBanner` without a second bespoke query. `metadata` is `unknown` here — this
   * repository has no per-action metadata schema; the caller narrows it.
   */
  findLatestByEntityAndAction: async (input: {
    entityType: string;
    entityId: string;
    action: string;
  }): Promise<{ actorUserId: string | null; createdAt: Date; metadata: unknown } | undefined> => {
    const [row] = await db
      .select({
        actorUserId: auditEvents.actorUserId,
        createdAt: auditEvents.createdAt,
        metadata: auditEvents.metadata,
      })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.entityType, input.entityType),
          eq(auditEvents.entityId, input.entityId),
          eq(auditEvents.action, input.action)
        )
      )
      .orderBy(desc(auditEvents.createdAt), desc(auditEvents.seq))
      .limit(1);
    return row;
  },

  /**
   * BAL-555 — the Lookup Timeline reader: one entity's `audit_events` rows, keyset-paginated
   * BACKWARDS from newest, batched with the actor facts a retrospective attribution needs.
   *
   * ORDERING CONTRACT (docblock addition 1/4): `created_at` THEN `seq`, BOTH DESCENDING here
   * (see `schema/audit-events.ts`'s `seq` docblock) — `asc` is a bug, not a style choice, and
   * `audit-trail-ordering.test.ts` fences both the same-direction pairing and any scalar
   * comparison on `seq` outside {@link auditTrailKeysetBefore}.
   *
   * NO SUPPORTING INDEX (docblock addition 2/4): `audit_events_entity_idx` is
   * `(entity_type, entity_id)` only — not `(entity_type, entity_id, created_at, seq)`. The
   * row-value cursor is still correct; it just sorts after the index filter. Fine at
   * per-entity row counts. One line, not a migration (out of scope).
   *
   * PRE-`0088` ROWS CARRY AN ARBITRARY `seq` (docblock addition 3/4) — physical scan order,
   * because migration `0088_bal426_audit_events_seq.sql` deliberately records no boundary
   * (acceptable pre-launch). The Timeline therefore makes no ordinal claim it cannot support:
   * no numbering, no "first/last/then" copy. Rows sharing one `created_at` instant render
   * under ONE visible timestamp as one change (which is what ADR-1030 says `created_at`
   * means). `seq` GAPS ARE EXPECTED AND CORRECT (docblock addition 4/4) — nothing here derives
   * a count from `max(seq)`.
   *
   * `engagement_milestone` ROWS ARE NOT UNIONED IN. They are keyed by MILESTONE id, so an
   * engagement's Timeline shows `engagement_milestone.reordered` (written with
   * `entityType: 'engagement'`) but not `added`/`completed`/`edited`/`removed`/`started`/
   * `reverted` — those are keyed by the milestone's own id. Unioning them needs a second read
   * to resolve the engagement's milestone ids; deliberately v1-out-of-scope (orchestrator
   * ruling R2).
   *
   * ⚠ NO `isNull(users.deletedAt)` GUARD on the actor join, DELIBERATELY — the one place in
   * this package a soft-delete guard is ABSENT on purpose. `actor_user_id` is ON DELETE
   * RESTRICT precisely so ADR-1030 attribution survives; a soft-deleted actor must still be
   * named, not blanked.
   */
  listTrailForEntity: async (input: ListTrailForEntityInput): Promise<AuditTrailPage> => {
    const rows = await db
      .select({
        id: auditEvents.id,
        action: auditEvents.action,
        createdAt: auditEvents.createdAt,
        /**
         * BAL-555 — the CURSOR-ONLY companion to `createdAt` above, read from the SAME column
         * via a raw `::text` cast so it carries FULL microsecond precision (postgres-js parses
         * a plain `timestamptz` select into a millisecond-precision JS `Date`, which is exactly
         * the truncation that silently drops rows — see `AuditTrailCursor.createdAtPrecise`).
         * `createdAt` above stays a `Date` and is used for DISPLAY ONLY; this field is used ONLY
         * to build `earlierCursor` below. Do not collapse these into one — that reintroduces the
         * bug this projection exists to close.
         */
        createdAtPrecise: sql<string>`${auditEvents.createdAt}::text`,
        seq: auditEvents.seq,
        metadata: auditEvents.metadata,
        actorUserId: auditEvents.actorUserId,
        actorFirstName: users.firstName,
        actorLastName: users.lastName,
        actorPlatformRole: users.platformRole,
      })
      .from(auditEvents)
      // ⚠ NO `isNull(users.deletedAt)` GUARD, DELIBERATELY — see the docblock above.
      .leftJoin(users, eq(users.id, auditEvents.actorUserId))
      .where(
        and(
          eq(auditEvents.entityType, input.entityType),
          eq(auditEvents.entityId, input.entityId),
          input.before === undefined ? undefined : auditTrailKeysetBefore(input.before)
        )
      )
      // ⚠ BAL-426 residual 1 — WRITTEN LITERALLY, never spread and never via the relational
      // `orderBy:` key, so `audit-trail-ordering.test.ts`'s extractor SEES it.
      .orderBy(desc(auditEvents.createdAt), desc(auditEvents.seq))
      .limit(input.limit + 1);

    const hasEarlier = rows.length > input.limit;
    const page = hasEarlier ? rows.slice(0, input.limit) : rows;
    page.reverse(); // newest-first → chronological ascending

    const [oldest] = page;
    const earlierCursor: AuditTrailCursor | null =
      hasEarlier && oldest !== undefined
        ? { createdAtPrecise: oldest.createdAtPrecise, seq: oldest.seq }
        : null;

    const actorIds = [
      ...new Set(page.map((row) => row.actorUserId).filter((id): id is string => id !== null)),
    ];
    const orgNames = await loadActorOrgNames(actorIds);

    return {
      rows: page.map((row) => {
        const org = row.actorUserId === null ? undefined : orgNames.get(row.actorUserId);
        return {
          id: row.id,
          action: row.action,
          createdAt: row.createdAt,
          seq: row.seq,
          metadata: row.metadata,
          actorUserId: row.actorUserId,
          actorFirstName: row.actorFirstName,
          actorLastName: row.actorLastName,
          actorPlatformRole: row.actorPlatformRole,
          actorCompanyName: org?.companyName ?? null,
          actorAgencyName: org?.agencyName ?? null,
        };
      }),
      hasEarlier,
      earlierCursor,
    };
  },
};
