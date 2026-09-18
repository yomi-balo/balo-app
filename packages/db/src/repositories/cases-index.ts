import {
  and,
  asc,
  eq,
  exists,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  notExists,
  or,
  sql,
  type SQL,
  type SQLWrapper,
} from 'drizzle-orm';
import { alias, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { db } from '../client';
import {
  actionItems,
  agencies,
  caseEngagementProducts,
  caseEngagements,
  companies,
  companyMembers,
  engagements,
  expertProfiles,
  meetingContexts,
  meetings,
  products,
  users,
  type ExpertProfile,
  type MeetingOutcome,
  type MeetingStatus,
} from '../schema';
import { caseHasLiveThread } from './_shared/case-thread';
import type { ActionItemAssigneeParty } from './action-items';
import type { CaseCloseReason } from './case-engagements';

/**
 * BAL-567 — THE READ MODEL BEHIND `/cases`, THE WORKSPACE'S CASE INDEX.
 *
 * One workspace's cases — a company's, or a delivering expert's — split into the OPEN list and
 * the RESOLVED list, with everything each card renders fetched in BATCHES over the whole page.
 * The query model is `upcoming-meetings.ts` (BAL-566): parent rows scoped BEFORE any
 * `meeting_contexts` join, explicit `select({...})` allow-lists, fail-closed caps. The LAYERING
 * model is `projects-inbox.ts`: the unread/thread join lives in the WEB view-model layer, never
 * here.
 *
 * ⚠⚠ NO AUTHORIZATION DECISION IS MADE HERE — WITH ONE DELIBERATE EXCEPTION. The caller resolves
 * the viewer's company-level `PARTICIPATE` (`resolveCompanyParticipation`, `@balo/shared/authz`)
 * BEFORE calling, and passes the SESSION's own `companyId` / `expertProfileId` — never a URL
 * param. Passing an arbitrary COMPANY id returns that company's cases.
 *
 * The exception is the EXPERT arm, which is SELF-VERIFYING (BAL-567 fix round, SEC-1): it also
 * requires the scope's `expertProfileId` to be owned by the scope's `viewerUserId`
 * ({@link expertProfileOwnedByViewer}), so a mismatched pair returns nothing rather than that
 * profile's case list. Defence in depth on the one path here where being wrong is an access bug
 * — not a substitute for the caller's own gate.
 *
 * ⚠⚠ "EVERY LISTED CASE MUST OPEN" IS ENFORCED BY THE PREDICATES, NOT BY HOPE. `/cases/[id]`
 * is gated by `resolveCaseAccess` → `authorizeEngagementConversation`, whose four non-identity
 * denials are all structural facts about the row. Each one has a predicate here:
 *
 *   · `no_engagement`  → `isNull(engagements.deletedAt)` + `engagement_type = 'case'`
 *   · the loader's case-type coherence check (`caseEngagementsRepository.findByEngagementId`)
 *                      → the INNER JOIN to a live `case_engagements` child
 *   · `no_thread`      → {@link caseHasLiveThread} (shared with BAL-566 — one definition)
 *   · side resolution  → the caller's already-resolved scope (see above), plus the
 *                        dual-membership exclusion on the expert arm (below)
 *
 * Dropping any one of them puts a card on the page that 404s when clicked.
 *
 * ⚠ THE DUAL-MEMBERSHIP EXCLUSION (expert arm only). `resolveSide` tries the CLIENT arm first,
 * so a viewer who is BOTH a live member of the booking company AND the delivering expert
 * resolves to `side: 'client'`. Listing that case in the EXPERT workspace would render a card
 * that opens on the other side. The expert arm therefore excludes any case whose company the
 * viewer is a live member of.
 *
 * ⚠ IT NEVER READS `consultations`. That table is the expert AVAILABILITY projection: it
 * carries no engagement id and no company column, so it cannot answer "which case is this".
 * The case↔meeting edge is `meeting_contexts (context_type = 'case', context_id =
 * engagements.id)`, which `meeting_context_reverse_idx` exists for.
 *
 * ⚠ IT DOES NOT USE `meetingContextsRepository.consultationTimestampsForEngagements`, and that
 * is a decision, not an oversight. That helper is a SECOND query over the same rows, its
 * "completed" anchor is credit-session-based, and it excludes `in_progress` by design — three
 * ways for this index to disagree with `deriveCaseConsultationState` on the case page.
 *
 * ⚠ NO MONEY, NO SECRETS, NO ADDRESSES. Not one projection here selects `expert_profiles.
 * rate_cents` / `stripe_connect_id` / `decline_note`, `engagements.balo_fee_bps`,
 * `case_engagements.booking_idempotency_key`, `meetings.join_url` / `daily_room_name`, or any
 * `users.email`. The allow-lists are the enforcement; `cases-index.integration.test.ts` pins
 * every returned key set exactly.
 *
 * ⚠ READ-ONLY, AND IT NEVER NOTIFIES — no writer lives here and nothing here publishes, queues
 * or emails (pinned by `invariants/repositories-never-notify.test.ts`).
 */

// ── Page sizes and caps ───────────────────────────────────────────────────────────────────────

/** The Open section's first page. */
export const CASES_INDEX_OPEN_PAGE_SIZE = 24;

/** The Resolved section's first page (and every "show more" after it). */
export const CASES_INDEX_RESOLVED_PAGE_SIZE = 20;

/**
 * The widest page either list will serve. A `limit` is caller-supplied and therefore
 * client-INFLUENCED; an unbounded one turns "show more" into a full-table export. Thrown, never
 * silently clamped — a clamp would make a caller bug invisible.
 */
export const MAX_CASES_INDEX_PAGE_SIZE = 50;

/**
 * Fail-closed cap on the trail read. Reaching it THROWS rather than returning a truncated trail:
 * the trail decides a card's state, and a silently cut one would show "no calls" for a case that
 * has six (the `upcoming-meetings.ts` precedent).
 */
export const MAX_CASES_INDEX_MEETING_ROWS = 4000;

export class CasesIndexPageSizeError extends Error {
  constructor(public readonly limit: number) {
    super(
      `cases-index: limit ${limit} is outside 1..${MAX_CASES_INDEX_PAGE_SIZE}, the range this read serves`
    );
    this.name = 'CasesIndexPageSizeError';
  }
}

export class CasesIndexMeetingCapExceededError extends Error {
  constructor(public readonly engagementCount: number) {
    super(
      `cases-index: ${engagementCount} cases carry at least ${MAX_CASES_INDEX_MEETING_ROWS} ` +
        `meeting rows, the maximum this read will serve`
    );
    this.name = 'CasesIndexMeetingCapExceededError';
  }
}

/**
 * Throws {@link CasesIndexMeetingCapExceededError} once the trail read's `LIMIT` was actually
 * REACHED. Pure, and exported for the test: seeding 4 000 meetings to prove a guard is a
 * ten-minute test that proves the same thing this call does (the `assertUpcomingRowCap`
 * precedent).
 */
export function assertCasesIndexMeetingCap(rowCount: number, engagementCount: number): void {
  if (rowCount < MAX_CASES_INDEX_MEETING_ROWS) return;
  throw new CasesIndexMeetingCapExceededError(engagementCount);
}

// ── Scope ─────────────────────────────────────────────────────────────────────────────────────

/**
 * WHICH workspace's cases. Resolved from the SESSION by the caller — `navWorkspaceTypeOf` picks
 * which arm, and that pick is a VIEW decision, never an authorization one (ADR-1029:
 * `activeMode` is not an authorization input).
 */
export type CasesIndexScope =
  | { readonly side: 'company'; readonly companyId: string }
  | {
      readonly side: 'expert';
      readonly expertProfileId: string;
      /**
       * The viewer. TWO jobs, both in `scopedLiveCases`: the dual-membership exclusion, and
       * (BAL-567 fix round) PROVING that this viewer owns `expertProfileId` at all. See the
       * module docblock.
       */
      readonly viewerUserId: string;
    };

/**
 * THE OPEN-LIST KEYSET CURSOR. All three parts are required because the ordering is
 * `(bucket ASC, sortRank ASC, engagements.id ASC)` and a keyset must carry every key it orders
 * on. `engagements.id` is a primary key, so the triple is TOTAL: no two rows tie and no row can
 * be skipped or repeated for want of a tiebreak.
 *
 * ⚠ `bucket` AND `sortRank` ARE DERIVED, NOT STORED. A case whose booking state CHANGES between
 * two pages (a call is booked, a booking is cancelled) can be skipped or repeated across a
 * "show more". That is inherent to ordering on mutable derived state; the alternative is a
 * materialised rank column, which this ticket does not budget. Documented, not fixed — the
 * `captureHealthRepository.listPage` precedent.
 */
export interface CasesIndexCursor {
  /** `0` = has an upcoming booking, `1` = none. */
  readonly bucket: number;
  /** Seconds since the epoch, NEGATED for the unbooked bucket — see {@link sortRankSql}. */
  readonly sortRank: number;
  readonly id: string;
}

/**
 * THE RESOLVED-LIST KEYSET CURSOR, ordered `(closed_at DESC, engagements.id ASC)`.
 *
 * ⚠ THE INSTANT TRAVELS AS `extract(epoch …)::double precision`, NOT AS AN ISO STRING, AND THAT
 * MATTERS. `closed_at` is `timestamptz` — MICROSECOND precision — while postgres-js hands
 * JavaScript a `Date`, which has only milliseconds. An ISO cursor would therefore compare a
 * TRUNCATED instant against untruncated rows, and the `id` tiebreak would never fire for the one
 * case it exists for: two closes inside the same millisecond, where the second row matches
 * neither `closed_at < cursor` nor `closed_at = cursor` and is silently SKIPPED. The float8
 * epoch round-trips exactly (PG emits shortest-exact float8 text; `parseFloat` reads it back to
 * the same double), so the comparison is total.
 */
export interface ResolvedCasesCursor {
  /** `extract(epoch from case_engagements.closed_at)::double precision`, from the row. */
  readonly closedAtEpoch: number;
  readonly id: string;
}

export interface CasesIndexPage<TRow> {
  readonly rows: readonly TRow[];
  readonly hasMore: boolean;
}

// ── Row shapes ────────────────────────────────────────────────────────────────────────────────

/**
 * The counterparty columns BOTH lists carry. NAME AND DISPLAY COLUMNS ONLY — the allow-list is
 * what makes `rate_cents` and `stripe_connect_id` structurally unreachable rather than merely
 * un-selected today.
 *
 * `expertFirstName` / `expertLastName` / `expertAvatarUrl` are `null` when the expert's USER row
 * is soft-deleted: the filter sits in the LEFT JOIN condition, so the case still lists (with the
 * web layer's "An expert" fallback) instead of vanishing.
 */
export interface CasesIndexCounterparty {
  readonly companyId: string;
  readonly companyName: string;
  readonly expertProfileId: string;
  readonly expertUserId: string;
  readonly expertFirstName: string | null;
  readonly expertLastName: string | null;
  readonly expertAvatarUrl: string | null;
  /** `null` until the expert claims one; the "Book again" href is hidden without it. */
  readonly expertUsername: string | null;
  readonly expertHeadline: string | null;
  readonly expertType: ExpertProfile['type'];
  /** `null` ⇒ an INDEPENDENT expert. Also the input to `actorHasExpertSideVisibility`. */
  readonly agencyId: string | null;
  readonly agencyName: string | null;
}

export interface CasesIndexCaseRow extends CasesIndexCounterparty {
  readonly engagementId: string;
  readonly title: string;
  /** The PARENT's `created_at` — the case's own clock (the child's is never read). */
  readonly createdAt: Date;
  /** Both `null` or both set (`case_engagement_resolution_request_paired`). */
  readonly resolutionRequestedAt: Date | null;
  readonly resolutionRequestedByUserId: string | null;
  /** The soonest `scheduled`/`waiting_for_participants`/`in_progress` call, or `null`. */
  readonly nextBookingAt: Date | null;
  /** The latest `ended` + `completed` call, anchored on `started_at` then `scheduled_start`. */
  readonly lastHeldAt: Date | null;
  /** Distinct `ended` + `completed` meetings — the "{n} held" figure. */
  readonly heldCount: number;
  /** Cursor material — see {@link CasesIndexCursor}. Not for display. */
  readonly bucket: number;
  /** Cursor material — see {@link CasesIndexCursor}. Not for display. */
  readonly sortRank: number;
}

export interface CasesIndexResolvedRow extends CasesIndexCounterparty {
  readonly engagementId: string;
  readonly title: string;
  /** NOT NULL on this list by construction (`closed_at IS NOT NULL` is the section predicate). */
  readonly closedAt: Date;
  /** `resolved` (a client closed it) or `auto_inactive` (the sweep did). */
  readonly closeReason: CaseCloseReason | null;
  readonly heldCount: number;
  /** Cursor material — see {@link ResolvedCasesCursor}. Not for display. */
  readonly closedAtEpoch: number;
}

/** One mark on a case's consultation trail. NEVER `join_url` / `daily_room_name`. */
export interface CasesIndexTrailMeeting {
  readonly meetingId: string;
  readonly scheduledStart: Date;
  readonly scheduledEnd: Date;
  readonly startedAt: Date | null;
  readonly status: MeetingStatus;
  readonly outcome: MeetingOutcome | null;
}

export interface CasesIndexProductTag {
  readonly productId: string;
  readonly name: string;
}

/** Open action items on one case, split by the side they were assigned to. */
export interface CasesIndexActionItemCounts {
  readonly client: number;
  readonly expert: number;
  /** `assignee_party IS NULL` — the column's own "unassigned" encoding. */
  readonly unassigned: number;
}

export interface CasesIndexCounts {
  readonly open: number;
  readonly resolved: number;
}

// ── Shared SQL ────────────────────────────────────────────────────────────────────────────────

/**
 * A call that is still going to happen (or is happening) — what "has an upcoming booking" means
 * for the leading sort key.
 *
 * ⚠ IT IS THE COMPLEMENT OF `MEETING_CLOSED_TO_JOIN`, restated positively because this rides a
 * `FILTER` clause rather than a `NOT IN`, and an exhaustive positive list is what a reader can
 * check against the enum. EXPORTED SO THE DRIFT GUARD CAN CHECK IT: a 6th `meeting_status` label
 * that nobody adds here would silently drop every meeting in it into the UNBOOKED bucket, which
 * is a wrong page, not an error. `cases-index.integration.test.ts` pins the complement.
 */
export const BOOKED_MEETING_STATUSES = [
  'scheduled',
  'waiting_for_participants',
  'in_progress',
] as const satisfies readonly MeetingStatus[];

/**
 * ⚠⚠ A TIMESTAMP THAT REACHES US THROUGH A RAW `sql` FRAGMENT IS OURS TO NARROW, NOT THE
 * DRIVER'S. `min(...)` / `max(...)` inside a `sql` template carries no Drizzle column decoder,
 * so postgres-js hands back the raw Postgres TEXT (`2026-09-18 04:18:54.88+00`) while the
 * TypeScript type cheerfully claims `Date` — memory `reference_jsonb_date_type_lie`, and the
 * exact shape `caseEngagementsRepository.listOpenForCompanyAndExpert` documents for its own
 * `coalesce(max(...))`. One parse, in one place, tolerant of both.
 */
function toDate(value: Date | string | null): Date | null {
  if (value === null) return null;
  return value instanceof Date ? value : new Date(value);
}

/** `cast(count(...) as int)` — `count` is bigint, which postgres-js hands back as a STRING. */
function countDistinctInt(column: SQLWrapper, filter: SQL): SQL<number> {
  return sql<number>`cast(count(distinct ${column}) filter (where ${filter}) as int)`;
}

/**
 * A HELD consultation: the meeting ran and completed. `cancelled`, `no_show_client` and
 * `missed_call` are all excluded, and so is an `ended` meeting whose `outcome` is still NULL.
 */
function heldMeetingFilter(): SQL {
  return sql`${eq(meetings.status, 'ended')} and ${eq(meetings.outcome, 'completed')}`;
}

/**
 * The two `engagements` party columns, STRUCTURALLY — so the predicate below can be applied to
 * the real table AND to `alias(engagements, …)`, whose `PgColumn` types carry a different
 * `tableName` and are therefore not assignable to `typeof engagements`.
 */
interface EngagementPartyColumns {
  readonly companyId: AnyPgColumn;
  readonly expertProfileId: AnyPgColumn;
}

/**
 * The scope's PARTY predicate on an `engagements` row (or an alias of one), WITHOUT the
 * dual-membership exclusion. Rides `engagement_company_idx` / `engagement_expert_idx`.
 */
function scopePartyPredicate(table: EngagementPartyColumns, scope: CasesIndexScope): SQL {
  return scope.side === 'company'
    ? eq(table.companyId, scope.companyId)
    : eq(table.expertProfileId, scope.expertProfileId);
}

/**
 * ⚠⚠ THE EXPERT ARM PROVES ITS OWN SCOPE (BAL-567 fix round, SEC-1). The company arm re-runs
 * `resolveCompanyParticipation` on every call; the expert arm had nothing equivalent — it took
 * the sealed session's `expertProfileId` on trust and never checked that the VIEWER owns it.
 * This `EXISTS` closes that asymmetry: a `(expertProfileId, viewerUserId)` pair that does not
 * name one `expert_profiles` row returns ZERO rows rather than that profile's whole case list.
 *
 * ⚠ DEFENCE IN DEPTH, NOT A KNOWN HOLE. `iron-session` seals are unforgeable and drift detection
 * already re-derives the session's expert profile, so no client can supply a mismatched pair
 * today. It is here because this is the ONE path in this repository where being wrong is an
 * ACCESS bug, the join costs a primary-key lookup, and the alternative is a comment asking the
 * next caller to be careful.
 *
 * ⚠ CORRELATED ON `engagements.expert_profile_id`, not on `scope.expertProfileId` — so it proves
 * ownership of the profile ON THE ROW rather than merely re-stating the scope. `scopePartyPredicate`
 * already pins the two together, which makes this a genuine second check rather than a tautology.
 *
 * ⚠ AN `EXISTS`, NOT A JOIN, because `scopedLiveCases` is shared with `countCasesForScope`, whose
 * FROM list is `engagements ⋈ case_engagements` ONLY. A bare `eq(expertProfiles.userId, …)` there
 * would reference a table that is not in scope and fail at runtime with `42P01`.
 *
 * ⚠ ALIASED, so the subquery's `expert_profiles` cannot shadow the OUTER one that
 * {@link selectCaseSection} joins for the counterparty columns.
 */
function expertProfileOwnedByViewer(expertProfileId: string, viewerUserId: string): SQL {
  const scopeExpertProfile = alias(expertProfiles, 'scope_expert_profile');
  return exists(
    db
      .select({ one: sql`1` })
      .from(scopeExpertProfile)
      .where(
        and(
          eq(scopeExpertProfile.id, engagements.expertProfileId),
          eq(scopeExpertProfile.id, expertProfileId),
          eq(scopeExpertProfile.userId, viewerUserId)
        )
      )
  );
}

/** Every case row of this scope, live, of the right type — the two lists' shared WHERE. */
function scopedLiveCases(scope: CasesIndexScope): SQL[] {
  const predicates: SQL[] = [
    // Enum literals at QUERY time are always safe — the house restriction is on index
    // predicates and CHECKs (the `ALTER TYPE … ADD VALUE` one-transaction hazard).
    eq(engagements.engagementType, 'case'),
    isNull(engagements.deletedAt),
    scopePartyPredicate(engagements, scope),
    caseHasLiveThread(),
  ];
  if (scope.side === 'expert') {
    predicates.push(expertProfileOwnedByViewer(scope.expertProfileId, scope.viewerUserId));
    // ⚠ THE DUAL-MEMBERSHIP EXCLUSION — see the module docblock. Served by `company_user_idx`
    // (unique on `(company_id, user_id)`). The soft-delete filter is what stops a REMOVED
    // member's stale row hiding a case from the expert who delivers it.
    predicates.push(
      notExists(
        db
          .select({ one: sql`1` })
          .from(companyMembers)
          .where(
            and(
              eq(companyMembers.companyId, engagements.companyId),
              eq(companyMembers.userId, scope.viewerUserId),
              isNull(companyMembers.deletedAt)
            )
          )
      )
    );
  }
  return predicates;
}

/**
 * THE PER-CASE MEETING AGGREGATE, as ONE grouped derived table rather than correlated scalar
 * subqueries — so `next_booking_at` / `last_held_at` become REAL columns the outer query can
 * filter, order and page on without re-evaluating anything.
 *
 * ⚠ IT IS BOUNDED BY THE SCOPE'S PARTY PREDICATE, NOT BY THE FULL SCOPE. The outer query applies
 * the full scope (including the dual-membership exclusion and the live-thread predicate) and the
 * join is on `engagements.id`, so a WIDER aggregate can only compute rows the outer query
 * discards. Bounding it at all is what keeps this from scanning every case on the platform.
 *
 * ⚠⚠ EVERY `sql(...).as('x')` ALIAS HERE MUST BE UNIQUE ACROSS THE OUTER QUERY'S FROM ITEMS.
 * Drizzle renders such a field as the BARE alias `"x"` — never `"agg"."x"` — so the outer query
 * resolves it against its own FROM list. `next_booking_at`, `last_held_at` and `held_count`
 * collide with no column of `engagements`, `case_engagements`, `expert_profiles`, `users`,
 * `agencies` or `companies`; a collision would fail at runtime with `42702 ambiguous column`.
 */
function caseMeetingAggregate(scope: CasesIndexScope) {
  const aggEngagements = alias(engagements, 'agg_engagements');
  return db
    .select({
      // A PLAIN column — Drizzle renders this one QUALIFIED (`"agg"."context_id"`).
      engagementId: meetingContexts.contextId,
      // ⚠ TYPED `Date | string | null` ON PURPOSE — see {@link toDate}. Claiming `Date` here
      // would be a lie the compiler would then help propagate.
      nextBookingAt: sql<
        Date | string | null
      >`min(${meetings.scheduledStart}) filter (where ${inArray(meetings.status, [
        ...BOOKED_MEETING_STATUSES,
      ])})`.as('next_booking_at'),
      lastHeldAt: sql<Date | string | null>`max(coalesce(${meetings.startedAt}, ${
        meetings.scheduledStart
      })) filter (where ${heldMeetingFilter()})`.as('last_held_at'),
      // DISTINCT MEETINGS, not context rows: a context row that outlived its meeting would
      // otherwise inflate a number the client reads as "3 consultations".
      heldCount: countDistinctInt(meetings.id, heldMeetingFilter()).as('held_count'),
    })
    .from(meetingContexts)
    .innerJoin(
      meetings,
      and(eq(meetings.id, meetingContexts.meetingId), isNull(meetings.deletedAt))
    )
    .innerJoin(
      aggEngagements,
      and(
        eq(aggEngagements.id, meetingContexts.contextId),
        eq(aggEngagements.engagementType, 'case'),
        isNull(aggEngagements.deletedAt),
        scopePartyPredicate(aggEngagements, scope)
      )
    )
    .where(and(eq(meetingContexts.contextType, 'case'), isNull(meetingContexts.deletedAt)))
    .groupBy(meetingContexts.contextId)
    .as('agg');
}

type CaseMeetingAggregate = ReturnType<typeof caseMeetingAggregate>;

/** `0` when the case has an upcoming booking, `1` when it has none — the leading sort key. */
function bucketSql(agg: CaseMeetingAggregate): SQL<number> {
  return sql<number>`(case when ${agg.nextBookingAt} is null then 1 else 0 end)`;
}

/**
 * THE ORDERING, STATED ONCE (the ticket's rule, entirely in SQL, so the featured case is row 1
 * of page 1 and "show more" cannot disagree with the first page):
 *
 *     ORDER BY bucket ASC, sort_rank ASC, engagements.id ASC
 *
 * · BOOKED cases sort first, SOONEST first — `sort_rank` is the booking's epoch, ascending.
 * · UNBOOKED cases follow, MOST RECENTLY ACTIVE first — `sort_rank` is the NEGATED epoch of
 *   `coalesce(last_held_at, created_at)`, so a plain ASC reproduces a DESC.
 *
 * ⚠⚠ DO NOT REUSE `caseEngagementsRepository.listOpenForCompanyAndExpert`'S ORDER. Its
 * `lastActivityAt` is `MAX(scheduled_start)` over ALL of a case's meetings, which puts a booking
 * six weeks out ABOVE a call happening today. That is the wrong answer for an index whose whole
 * job is "what is next".
 *
 * `extract(epoch …)` is cast to `double precision` so the value the cursor carries and the value
 * the keyset compares are the same IEEE-754 double (see {@link ResolvedCasesCursor} for why an
 * exact round-trip is load-bearing).
 */
function sortRankSql(agg: CaseMeetingAggregate): SQL<number> {
  return sql<number>`(case when ${agg.nextBookingAt} is null
      then -extract(epoch from coalesce(${agg.lastHeldAt}, ${engagements.createdAt}))
      else extract(epoch from ${agg.nextBookingAt}) end)::double precision`;
}

/** `closed_at` as an exactly-round-trippable float8 — see {@link ResolvedCasesCursor}. */
function closedAtEpochSql(): SQL<number> {
  return sql<number>`extract(epoch from ${caseEngagements.closedAt})::double precision`;
}

/** The counterparty allow-list, shared by both lists so the two can never drift apart. */
const COUNTERPARTY_COLUMNS = {
  companyId: engagements.companyId,
  companyName: companies.name,
  expertProfileId: expertProfiles.id,
  expertUserId: expertProfiles.userId,
  expertFirstName: users.firstName,
  expertLastName: users.lastName,
  expertAvatarUrl: users.avatarUrl,
  expertUsername: expertProfiles.username,
  expertHeadline: expertProfiles.headline,
  expertType: expertProfiles.type,
  agencyId: expertProfiles.agencyId,
  agencyName: agencies.name,
} as const;

/**
 * THE TWO LISTS' ONE QUERY. Open and Resolved ask the same question of the same six tables and
 * differ ONLY in their `closed_at` arm, their keyset and their ORDER BY — all three passed in —
 * so the joins, the soft-delete filters and the scope predicate are written ONCE and the two
 * sections cannot drift into disagreeing about which cases exist.
 *
 * ⚠ IT SELECTS THE UNION OF BOTH SECTIONS' COLUMNS, deliberately. Drizzle's builder cannot be
 * split across a function boundary with its selection generic intact (the chain loses
 * `innerJoin` the moment it is wrapped), so the choice was one query with a few always-null
 * columns per section, or two near-identical 20-line chains free to diverge. The public row
 * shapes are built explicitly by each caller, so nothing extra reaches a consumer.
 *
 * ⚠ THE SOFT-DELETE FILTERS SIT IN THE JOIN CONDITIONS, NOT IN `WHERE`. On an OUTER join, a
 * `WHERE users.deleted_at IS NULL` silently becomes an INNER join and drops the whole CASE when
 * the expert's user row is soft-deleted — the case must still list, with null names.
 */
function selectCaseSection(
  scope: CasesIndexScope,
  agg: CaseMeetingAggregate,
  input: { closedState: SQL; keyset: SQL | undefined; orderBy: SQL[]; limit: number }
) {
  return (
    db
      .select({
        engagementId: engagements.id,
        title: caseEngagements.title,
        createdAt: engagements.createdAt,
        resolutionRequestedAt: caseEngagements.resolutionRequestedAt,
        resolutionRequestedByUserId: caseEngagements.resolutionRequestedByUserId,
        ...COUNTERPARTY_COLUMNS,
        nextBookingAt: agg.nextBookingAt,
        lastHeldAt: agg.lastHeldAt,
        heldCount: sql<number>`coalesce(${agg.heldCount}, 0)`,
        bucket: bucketSql(agg).as('bucket'),
        sortRank: sortRankSql(agg).as('sort_rank'),
        closedAt: caseEngagements.closedAt,
        closeReason: caseEngagements.closeReason,
        closedAtEpoch: closedAtEpochSql().as('closed_at_epoch'),
      })
      .from(engagements)
      .innerJoin(
        caseEngagements,
        and(
          eq(caseEngagements.engagementId, engagements.id),
          isNull(caseEngagements.deletedAt),
          input.closedState
        )
      )
      // NOT NULL FKs on the supertype, so both are INNER. Neither `companies` nor `expert_profiles`
      // carries a `deleted_at` (verified) — there is no filter to forget on either.
      .innerJoin(companies, eq(companies.id, engagements.companyId))
      .innerJoin(expertProfiles, eq(expertProfiles.id, engagements.expertProfileId))
      .leftJoin(users, and(eq(users.id, expertProfiles.userId), isNull(users.deletedAt)))
      .leftJoin(agencies, eq(agencies.id, expertProfiles.agencyId))
      .leftJoin(agg, eq(agg.engagementId, engagements.id))
      .where(and(...scopedLiveCases(scope), input.keyset))
      .orderBy(...input.orderBy)
      .limit(input.limit + 1)
  );
}

/** The counterparty half of a section row, lifted once so both public shapes agree on it. */
function toCounterparty(row: CasesIndexCounterparty): CasesIndexCounterparty {
  return {
    companyId: row.companyId,
    companyName: row.companyName,
    expertProfileId: row.expertProfileId,
    expertUserId: row.expertUserId,
    expertFirstName: row.expertFirstName,
    expertLastName: row.expertLastName,
    expertAvatarUrl: row.expertAvatarUrl,
    expertUsername: row.expertUsername,
    expertHeadline: row.expertHeadline,
    expertType: row.expertType,
    agencyId: row.agencyId,
    agencyName: row.agencyName,
  };
}

function assertPageSize(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_CASES_INDEX_PAGE_SIZE) {
    throw new CasesIndexPageSizeError(limit);
  }
}

function takePage<TRow>(rows: TRow[], limit: number): CasesIndexPage<TRow> {
  const hasMore = rows.length > limit;
  return { rows: hasMore ? rows.slice(0, limit) : rows, hasMore };
}

// ── Grouping helper ───────────────────────────────────────────────────────────────────────────

function groupByEngagement<TRow extends { engagementId: string }, TValue>(
  rows: readonly TRow[],
  project: (row: TRow) => TValue
): Map<string, TValue[]> {
  const grouped = new Map<string, TValue[]>();
  for (const row of rows) {
    const existing = grouped.get(row.engagementId);
    if (existing === undefined) {
      grouped.set(row.engagementId, [project(row)]);
    } else {
      existing.push(project(row));
    }
  }
  return grouped;
}

export const casesIndexRepository = {
  /**
   * THE OPEN LIST — one query, one page, in the ordering {@link sortRankSql} documents.
   *
   * "Open" is `case_engagements.closed_at IS NULL`, and the Resolved list is its exact
   * complement, so the two partition the workspace's cases and {@link countCasesForScope}'s two
   * numbers necessarily sum to the whole. `engagements.status` is deliberately NOT a second
   * predicate: `close()` writes both columns in one transaction, but a case has no cancel path
   * (its terminal state is `completed`, never `cancelled`), so `closed_at` alone is a complete
   * partition — and adding `status` would let a half-written row fall out of BOTH sections.
   *
   * @param scope the SESSION's own company or expert profile — see the module docblock.
   * @throws CasesIndexPageSizeError when `limit` is outside `1..MAX_CASES_INDEX_PAGE_SIZE`.
   */
  async listOpenCases(
    scope: CasesIndexScope,
    input: { limit: number; after?: CasesIndexCursor }
  ): Promise<CasesIndexPage<CasesIndexCaseRow>> {
    assertPageSize(input.limit);
    const agg = caseMeetingAggregate(scope);
    const bucket = bucketSql(agg);
    const sortRank = sortRankSql(agg);
    const after = input.after;

    const rows = await selectCaseSection(scope, agg, {
      closedState: isNull(caseEngagements.closedAt),
      keyset:
        after === undefined
          ? undefined
          : or(
              gt(bucket, after.bucket),
              and(eq(bucket, after.bucket), gt(sortRank, after.sortRank)),
              and(
                eq(bucket, after.bucket),
                eq(sortRank, after.sortRank),
                gt(engagements.id, after.id)
              )
            ),
      orderBy: [asc(bucket), asc(sortRank), asc(engagements.id)],
      limit: input.limit,
    });

    return takePage(
      rows.map((row) => ({
        engagementId: row.engagementId,
        title: row.title,
        createdAt: row.createdAt,
        resolutionRequestedAt: row.resolutionRequestedAt,
        resolutionRequestedByUserId: row.resolutionRequestedByUserId,
        ...toCounterparty(row),
        nextBookingAt: toDate(row.nextBookingAt),
        lastHeldAt: toDate(row.lastHeldAt),
        heldCount: Number(row.heldCount),
        bucket: Number(row.bucket),
        sortRank: Number(row.sortRank),
      })),
      input.limit
    );
  },

  /**
   * THE RESOLVED LIST — the exact complement of {@link listOpenCases}, newest close first.
   * Rides `case_engagement_closed_at_idx` for the ordering once the scope has narrowed the set.
   *
   * @throws CasesIndexPageSizeError when `limit` is outside `1..MAX_CASES_INDEX_PAGE_SIZE`.
   */
  async listResolvedCases(
    scope: CasesIndexScope,
    input: { limit: number; after?: ResolvedCasesCursor }
  ): Promise<CasesIndexPage<CasesIndexResolvedRow>> {
    assertPageSize(input.limit);
    const agg = caseMeetingAggregate(scope);
    const closedAtEpoch = closedAtEpochSql();
    const after = input.after;

    const rows = await selectCaseSection(scope, agg, {
      closedState: isNotNull(caseEngagements.closedAt),
      keyset:
        after === undefined
          ? undefined
          : or(
              lt(closedAtEpoch, after.closedAtEpoch),
              and(eq(closedAtEpoch, after.closedAtEpoch), gt(engagements.id, after.id))
            ),
      orderBy: [sql`${caseEngagements.closedAt} desc`, asc(engagements.id)],
      limit: input.limit,
    });

    return takePage(
      rows.map((row) => {
        const { closedAt } = row;
        if (closedAt === null) {
          // Unreachable: `isNotNull(closed_at)` is the section predicate. An INTEGRITY
          // violation if it ever fires, so it throws rather than being narrowed away with a
          // `!` (memory `reference_sonar_nonnull_false_positive`).
          throw new Error(`cases-index: resolved case ${row.engagementId} has a null closed_at`);
        }
        return {
          engagementId: row.engagementId,
          title: row.title,
          ...toCounterparty(row),
          closedAt,
          closeReason: row.closeReason,
          heldCount: Number(row.heldCount),
          closedAtEpoch: Number(row.closedAtEpoch),
        };
      }),
      input.limit
    );
  },

  /**
   * The two section counts, in ONE query over the SAME population the two lists page. Feeds the
   * section headings and the `cases_index_viewed` properties.
   *
   * EXACT, never estimated: a count that says "about 12" is a count nobody trusts to be zero,
   * and the empty state turns on exactly that.
   */
  async countCasesForScope(scope: CasesIndexScope): Promise<CasesIndexCounts> {
    const [row] = await db
      .select({
        open: sql<number>`cast(count(*) filter (where ${caseEngagements.closedAt} is null) as int)`,
        resolved: sql<number>`cast(count(*) filter (where ${caseEngagements.closedAt} is not null) as int)`,
      })
      .from(engagements)
      .innerJoin(
        caseEngagements,
        and(eq(caseEngagements.engagementId, engagements.id), isNull(caseEngagements.deletedAt))
      )
      .where(and(...scopedLiveCases(scope)));

    // An aggregate with no GROUP BY returns EXACTLY ONE ROW even over an empty input, so this
    // fallback is unreachable — it exists because `noUncheckedIndexedAccess` is on and a `!`
    // here would be an assertion about the query, not a narrowing.
    if (row === undefined) return { open: 0, resolved: 0 };
    return { open: Number(row.open), resolved: Number(row.resolved) };
  },

  /**
   * THE CONSULTATION TRAIL for a whole page of cases — ONE read over
   * `meeting_contexts ⋈ meetings`, never one per card.
   *
   * Ordered `coalesce(started_at, scheduled_start) ASC, meetings.id ASC` — the SAME order
   * `deriveConsultationOrdinal` uses on the case page, so the two surfaces number a case's
   * consultations identically.
   *
   * ⚠ CALLER OBLIGATION: every id passed in MUST already have come out of {@link listOpenCases}
   * or {@link listResolvedCases}. This method adds NO scope predicate of its own —
   * `meeting_contexts.context_id` has no FK and no RLS, so an unverified id here reads another
   * tenant's meetings.
   *
   * Misses are simply ABSENT from the Map. `[]` in ⇒ empty Map with NO QUERY.
   *
   * @throws CasesIndexMeetingCapExceededError at {@link MAX_CASES_INDEX_MEETING_ROWS}.
   */
  async listCaseTrailMeetings(
    engagementIds: readonly string[]
  ): Promise<Map<string, CasesIndexTrailMeeting[]>> {
    if (engagementIds.length === 0) return new Map();

    const rows = await db
      .select({
        engagementId: meetingContexts.contextId,
        meetingId: meetings.id,
        scheduledStart: meetings.scheduledStart,
        scheduledEnd: meetings.scheduledEnd,
        startedAt: meetings.startedAt,
        status: meetings.status,
        outcome: meetings.outcome,
      })
      .from(meetingContexts)
      .innerJoin(
        meetings,
        and(eq(meetings.id, meetingContexts.meetingId), isNull(meetings.deletedAt))
      )
      .where(
        and(
          eq(meetingContexts.contextType, 'case'),
          inArray(meetingContexts.contextId, [...new Set(engagementIds)]),
          isNull(meetingContexts.deletedAt)
        )
      )
      .orderBy(
        sql`coalesce(${meetings.startedAt}, ${meetings.scheduledStart}) asc`,
        asc(meetings.id)
      )
      .limit(MAX_CASES_INDEX_MEETING_ROWS);

    assertCasesIndexMeetingCap(rows.length, engagementIds.length);

    return groupByEngagement(
      // `context_id` is nullable in the schema (NULL only for the `admin` label); the
      // `context_type = 'case'` filter makes a NULL here impossible, and the narrowing is a
      // destructure-and-guard rather than a `!`.
      rows.flatMap((row) =>
        row.engagementId === null ? [] : [{ ...row, engagementId: row.engagementId }]
      ),
      (row) => ({
        meetingId: row.meetingId,
        scheduledStart: row.scheduledStart,
        scheduledEnd: row.scheduledEnd,
        startedAt: row.startedAt,
        status: row.status,
        outcome: row.outcome,
      })
    );
  },

  /**
   * THE PRODUCT TAGS for a whole page of cases — `case_engagement_products ⋈ products`, ordered
   * `products.name ASC, product_id ASC` so a card's tags and its "+N" overflow are stable
   * between renders.
   *
   * ⚠ THIS IS `case_engagement_products`' FIRST READER. It had exactly one writer
   * (`caseEngagementsRepository.create`'s transaction) and no reader at all until now.
   *
   * ⚠ `products` CARRIES NO `deleted_at` (`...timestamps` only — deactivation is `is_active`),
   * so there is no soft-delete filter on that leg. The JUNCTION does, and it is filtered. A
   * de-activated product still renders: the tag records what the case was about.
   *
   * Same caller obligation as {@link listCaseTrailMeetings}. `[]` in ⇒ empty Map, NO QUERY.
   */
  async listCaseProductTags(
    engagementIds: readonly string[]
  ): Promise<Map<string, CasesIndexProductTag[]>> {
    if (engagementIds.length === 0) return new Map();

    const rows = await db
      .select({
        engagementId: caseEngagementProducts.engagementId,
        productId: products.id,
        name: products.name,
      })
      .from(caseEngagementProducts)
      .innerJoin(products, eq(products.id, caseEngagementProducts.productId))
      .where(
        and(
          inArray(caseEngagementProducts.engagementId, [...new Set(engagementIds)]),
          isNull(caseEngagementProducts.deletedAt)
        )
      )
      .orderBy(asc(products.name), asc(products.id));

    return groupByEngagement(rows, (row) => ({ productId: row.productId, name: row.name }));
  },

  /**
   * OPEN action items per case, split by assignee side — ONE grouped read. Rides
   * `action_item_engagement_status_idx`, whose schema comment already names this exact use
   * ("Open/done counts per engagement").
   *
   * ⚠ `actionItemsRepository` HAS NO BATCHED READ — `listByEngagement` is single-id and returns
   * FULL rows. This is a count, and it is batched, because the index must never fire a query per
   * card.
   *
   * Every requested id is present in the Map, at zero when the case has no open items: a
   * three-field zero literal reconstructed at each call site is three chances to get it wrong.
   *
   * Same caller obligation as {@link listCaseTrailMeetings}. `[]` in ⇒ empty Map, NO QUERY.
   */
  async countOpenActionItemsByParty(
    engagementIds: readonly string[]
  ): Promise<Map<string, CasesIndexActionItemCounts>> {
    const counts = new Map<string, CasesIndexActionItemCounts>();
    if (engagementIds.length === 0) return counts;

    const unique = [...new Set(engagementIds)];
    for (const id of unique) counts.set(id, { client: 0, expert: 0, unassigned: 0 });

    const rows = await db
      .select({
        engagementId: actionItems.engagementId,
        assigneeParty: actionItems.assigneeParty,
        total: sql<number>`cast(count(*) as int)`,
      })
      .from(actionItems)
      .where(
        and(
          inArray(actionItems.engagementId, unique),
          eq(actionItems.status, 'open'),
          isNull(actionItems.deletedAt)
        )
      )
      .groupBy(actionItems.engagementId, actionItems.assigneeParty);

    for (const row of rows) {
      const current = counts.get(row.engagementId);
      if (current === undefined) continue;
      counts.set(row.engagementId, addParty(current, row.assigneeParty, Number(row.total)));
    }
    return counts;
  },
};

/** Fold one `(assignee_party, count)` group into the three-field shape. NULL ⇒ unassigned. */
function addParty(
  counts: CasesIndexActionItemCounts,
  party: ActionItemAssigneeParty | null,
  total: number
): CasesIndexActionItemCounts {
  if (party === 'client') return { ...counts, client: counts.client + total };
  if (party === 'expert') return { ...counts, expert: counts.expert + total };
  return { ...counts, unassigned: counts.unassigned + total };
}
