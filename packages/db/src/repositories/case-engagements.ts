import { and, asc, desc, eq, gt, isNotNull, isNull, lte, notExists, sql } from 'drizzle-orm';
import { db } from '../client';
import {
  caseEngagementProducts,
  caseEngagements,
  engagements,
  meetingContexts,
  meetings,
  reviews,
  type CaseEngagement,
  type Engagement,
} from '../schema';
import type { RatingNudgeCandidate } from './reviews';
import { partyMembershipsRepository } from './party-memberships';
import { conversationsRepository } from './conversations';
import { recordDeliveryAudit, recordEngagementCreated } from './_shared/delivery-audit';
import { insertEngagementRowTx, lockEngagementRowTx } from './_shared/engagement-supertype';

/**
 * The CASE engagement repository (BAL-417 / ADR-1045 §1). A Case is the per-minute
 * consultation engagement product: a title, a sanitised-HTML problem description, and
 * a client-close resolution lifecycle.
 *
 * ⚠ BAL-417 ships NO live case producer (D4). Everything here is exercisable only
 * through repository calls and integration tests; the booking surface (BAL-400) and
 * the case surface (BAL-421) are the first real callers.
 */

/** Reason a case was closed (schema-derived; NULL only while open). */
export type CaseCloseReason = NonNullable<CaseEngagement['closeReason']>;

/**
 * The FLAT case-engagement row: the supertype row plus every case-only column.
 * `status` is the 3-value universal union — a Case has NO sub-status.
 *
 * ⚠ `baloFeeBps` is OMITTED DELIBERATELY (D3). `credit_sessions.balo_fee_bps` is the
 * SSOT for a case's margin; `engagements.balo_fee_bps` on a case row sits at its bare
 * default having NEVER been charged. Surfacing it here would let a caller believe it
 * sets or reports case economics — and would put a raw margin into a projection that
 * BAL-421 will hand to a client surface. Making it unreachable is the mitigation.
 *
 * ⚠ `bookingIdempotencyKey` is OMITTED FOR THE SAME REASON (BAL-400). It is an opaque
 * server-minted token (`sha256(userId:nonce)`) whose only job is to make a retry re-enter
 * against the case that already exists. NO caller needs it handed back — the retry already
 * holds the value it passed in — so the narrowest thing that works is to keep it out of the
 * projection entirely, where it can never ride a case row onto a client surface. A test that
 * wants to assert persistence reads the `case_engagements` row directly.
 *
 * A pleasant side effect worth stating: because both new columns are stripped here, adding
 * them to the SCHEMA widened no consumer's view of a case. `CaseEngagementRow` is unchanged.
 *
 * `createdAt` is the PARENT's — the same clock `listOpenCreatedBefore` filters on, so
 * BAL-420 can feed it straight into `isCaseInactive` from `@balo/shared/engagements`.
 */
export type CaseEngagementRow = Omit<Engagement, 'baloFeeBps'> &
  Omit<
    CaseEngagement,
    | 'engagementId'
    | 'engagementType'
    | 'createdAt'
    | 'updatedAt'
    | 'deletedAt'
    | 'bookingIdempotencyKey'
  >;

/**
 * BAL-400 §2.5 — ONE of the client's OPEN cases with a given expert, as the booking flow's
 * "attach to an existing case" chooser needs it. NARROW BY DESIGN: a title, two clocks and
 * a count. No description (it is sanitised HTML destined for a different surface), no
 * company, no fee, no idempotency key.
 */
export interface OpenCaseForExpert {
  engagementId: string;
  title: string;
  /** The PARENT's `created_at` — the same clock every other case read uses. */
  createdAt: Date;
  /**
   * `MAX(meetings.scheduled_start)` over the case's LIVE meetings, falling back to
   * `createdAt` when the case has none. Drives the most-recent-activity ordering, so a case
   * that was just booked into sorts above one that has been quiet for a month.
   */
  lastActivityAt: Date;
  /** How many LIVE meetings this case has, of any status. `0` for a fresh case. */
  consultationCount: number;
}

/** BAL-400 §2.5 — {@link caseEngagementsRepository.listOpenForCompanyAndExpert}'s result. */
export interface OpenCasesForExpert {
  openCases: OpenCaseForExpert[];
  /**
   * How many cases this company has ALREADY RESOLVED with this expert. Drives the
   * "your last case with {Expert} is resolved — this starts a new one" note on the
   * `Book again` entry point WITHOUT the caller threading an `engagementId` through a URL,
   * so that note costs no new IDOR surface.
   *
   * ⚠ NOT capped by `limit` — `limit` bounds the OPEN list only.
   */
  resolvedCaseCount: number;
}

/**
 * Thrown when `closed_by_user_id` would not be a LIVE member of the case's
 * contracting company (`engagements.company_id`). This is a DATA-INTEGRITY
 * invariant — is the ROW COHERENT — not an authorization gate. The DELIVERING
 * EXPERT holds no membership in the client company, so the invariant is what makes
 * "the expert cannot close" structurally true rather than merely documented.
 *
 * ⚠ NOT a capability check. It resolves no capability token and compares no role.
 * The AUTHORIZATION rule — `hasCapability(actor, CAPABILITIES.PARTICIPATE,
 * { companyId })` — is BAL-421's, in the close server action.
 */
export class CaseCloserNotMemberError extends Error {
  constructor(
    public readonly engagementId: string,
    public readonly userId: string
  ) {
    super(`User ${userId} is not a live member of the company contracting case ${engagementId}`);
    this.name = 'CaseCloserNotMemberError';
  }
}

/** Thrown when close is attempted on an already-closed case (idempotency guard). */
export class CaseAlreadyClosedError extends Error {
  constructor(
    public readonly engagementId: string,
    public readonly closedAt: Date
  ) {
    super(`Case ${engagementId} was already closed at ${closedAt.toISOString()}`);
    this.name = 'CaseAlreadyClosedError';
  }
}

/**
 * The ONE place a parent + child pair becomes a flat case row. `baloFeeBps` is
 * stripped from the parent here — see `CaseEngagementRow`.
 *
 * EXPORTED FOR THE TEST FACTORY ONLY (`test/factories/case-engagement.factory.ts`).
 * The factory seeds its rows with raw inserts rather than through `create()` (it must
 * be able to force `createdAt`, `deletedAt` and a pre-closed child), so it needs THIS
 * fold. It must never re-implement the strip: a duplicated destructure is a copy that
 * keeps passing after the production one is deleted, which is precisely how a raw
 * margin (`baloFeeBps`) would start reaching a client surface unnoticed. Not in the
 * package barrel — `@balo/db` consumers get `CaseEngagementRow` from the repository
 * methods, never this.
 */
export function toCaseRow(parent: Engagement, child: CaseEngagement): CaseEngagementRow {
  const { baloFeeBps: _baloFeeBps, ...parentRest } = parent;
  const {
    engagementId: _engagementId,
    engagementType: _engagementType,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    deletedAt: _deletedAt,
    // BAL-400 — stripped for the same reason as `baloFeeBps`; see `CaseEngagementRow`.
    bookingIdempotencyKey: _bookingIdempotencyKey,
    ...childRest
  } = child;
  return { ...parentRest, ...childRest };
}

/**
 * Which way the resolution-request pair is being moved. A DISCRIMINATED UNION, not two
 * nullable columns, so a caller CANNOT express a half-set pair — see
 * {@link writeResolutionRequestTx}.
 */
type ResolutionRequestWrite =
  | { readonly kind: 'ask'; readonly userId: string }
  | { readonly kind: 'clear' };

/**
 * THE ONE STATEMENT THAT EVER WRITES `case_engagements.resolution_requested_*`, shared by
 * `requestResolution` (BAL-421, the ask) and `clearResolutionRequest` (BAL-388, the
 * dismissal). Extracted rather than mirrored, for two reasons that both matter:
 *
 * 1. ⚠⚠ IT MAKES THE PAIRED CHECK STRUCTURAL. `case_engagement_resolution_request_paired`
 *    is `(resolution_requested_at IS NULL) = (resolution_requested_by_user_id IS NULL)`, so
 *    writing one column alone is rejected 23514. With two hand-written UPDATEs, "always
 *    write both" is a CONVENTION restated in two docblocks that a third writer can miss.
 *    Here the two columns are computed together from ONE discriminant, so a half-set pair is
 *    not merely rejected by the database — it is UNREPRESENTABLE in the code that gets there.
 * 2. The two callers are otherwise line-for-line identical (same parent read, same WHERE,
 *    same refusals), which is a copy that keeps passing after one side's ordering discipline
 *    is broken — and a new-code duplication finding besides.
 *
 * ⚠⚠ THE PARENT IS READ **BEFORE** THE UPDATE, AND THE ORDER IS THE POINT. Reading it after
 * would let the write COMMIT while `undefined` came back — the caller then tells a user
 * "this case is no longer open" about a request that was in fact written. Reading first
 * means a soft-deleted or non-`case` parent short-circuits with NO write at all, so the
 * returned value and the persisted state can never disagree.
 *
 * REFUSES A CLOSED CASE (`closed_at IS NULL` in the WHERE) in BOTH directions — neither
 * asking whether a closed case is resolved nor dismissing a request on one is coherent, and
 * both would rewrite terminal history for no user-visible gain. Returns `undefined`; the
 * caller answers not-found.
 *
 * ⚠ NOT AN AUTHORIZATION GATE, in either direction — the same ruling as {@link close}. No
 * capability is resolved and no role is interpreted; this file imports NOTHING from
 * `@balo/shared/authz`, and a reviewer can check the ruling still holds by grepping it.
 * Capabilities are resolved at the call site (ADR-1029): `PARTICIPATE` on the membership
 * axis for the client's dismissal, `MANAGE_ENGAGEMENT` on the engagement axis (ADR-1046)
 * for the expert's ask.
 *
 * ⚠ NO AUDIT ROW, NO DOMAIN EVENT, in either direction (owner decision D-E). The two paired
 * columns ARE the attribution record.
 */
async function writeResolutionRequestTx(
  engagementId: string,
  write: ResolutionRequestWrite
): Promise<CaseEngagementRow | undefined> {
  return db.transaction(async (tx) => {
    const [parent] = await tx
      .select()
      .from(engagements)
      .where(
        and(
          eq(engagements.id, engagementId),
          eq(engagements.engagementType, 'case'),
          isNull(engagements.deletedAt)
        )
      )
      .limit(1);

    if (parent === undefined) {
      return undefined;
    }

    // BOTH COLUMNS, COMPUTED TOGETHER, IN ONE UPDATE. Never split this into two `set`s.
    const pair =
      write.kind === 'ask'
        ? { resolutionRequestedAt: new Date(), resolutionRequestedByUserId: write.userId }
        : { resolutionRequestedAt: null, resolutionRequestedByUserId: null };

    const [updatedChild] = await tx
      .update(caseEngagements)
      .set(pair)
      .where(
        and(
          eq(caseEngagements.engagementId, engagementId),
          isNull(caseEngagements.closedAt),
          isNull(caseEngagements.deletedAt)
        )
      )
      .returning();

    if (updatedChild === undefined) {
      return undefined;
    }

    return toCaseRow(parent, updatedChild);
  });
}

export const caseEngagementsRepository = {
  /**
   * Create a case: the supertype row (`engagementType: 'case'`) + the child, in ONE
   * transaction. `description` MUST already be sanitised HTML — the WEB caller
   * sanitises, `@balo/db` never does (D8; see the column docblock).
   *
   * A Case is `active` from creation, so `activatedAt` defaults to now exactly as the
   * project path does.
   *
   * NOTE the absent `baloFeeBps` parameter: see `CaseEngagementRow`. This path writes the
   * parent's column as `null` EXPLICITLY — the `engagement_balo_fee_bps_case_null` CHECK
   * requires it, and omitting it would fall through to the column DEFAULT (2500) and be
   * rejected 23514 rather than silently stored.
   *
   * Emits ONE `engagement.created` audit row in the SAME transaction (see
   * `recordEngagementCreated`), so a Case's trail starts at creation and not at close.
   *
   * ⚠ PROVISIONS THE CASE'S CONVERSATION IN THIS SAME TRANSACTION (BAL-424), anchored to the
   * SUPERTYPE id on the `engagement` label. This is what makes "a Case engagement has a
   * conversation with NO relationship row anywhere" true by construction rather than by
   * convention: a Case never passes through request origination, so there is nothing for the
   * old per-relationship model to key on.
   *
   * ⚠ WRITES THE CASE'S PRODUCT TAGS IN THIS SAME TRANSACTION (BAL-400). A case and the
   * taxonomy rows that say what it is ABOUT commit or roll back together — a half-tagged
   * case is not a state any reader should have to handle. That is also why there is no
   * `caseEngagementProductsRepository`: these rows have exactly one writer, here.
   *
   * CONTRACT — bare INSERT. Raw FK violation (23503) on an unknown `companyId` /
   * `expertProfileId` / `productIds` entry; CHECK (23514) on a blank `title` /
   * `description` or a malformed `bookingIdempotencyKey`; UNIQUE violation (23505) on a
   * `bookingIdempotencyKey` that a live case already holds.
   */
  async create(input: {
    companyId: string;
    expertProfileId: string;
    title: string;
    description: string;
    currency?: string;
    activatedAt?: Date;
    /**
     * The human who created the case, for the `engagement.created` audit row. OPTIONAL:
     * BAL-417 ships no live producer (D4), so every current caller is a test and there
     * is no actor to name — an omitted/`null` value is the ADR-1030 SYSTEM-ACTOR
     * ATTRIBUTION EXEMPTION (the same shape `createFromExtraction` uses), NOT a
     * fabricated one. BAL-400's booking surface should pass the booking user.
     */
    actorUserId?: string | null;
    /**
     * BAL-400 — the BOOKING-LEVEL idempotency key (a lowercase 64-char sha256 hex digest,
     * hashed SERVER-SIDE from the actor id and a stable client nonce). Stamped so a retry
     * after a failed meeting hop re-enters against THIS case instead of opening a second
     * one with the same title.
     *
     * ⚠ THE CALLER OWNS THE COLLISION, and deliberately so. This method does NOT use
     * `ON CONFLICT`: the arbiter `case_engagement_booking_idempotency_key_idx` is a PARTIAL
     * index, so a Drizzle `eq()` predicate there fails 42P10 at runtime (memory
     * `reference_pg_partial_index_arbiter_param_42p10`), and swallowing the conflict would
     * hand back a case the caller never inspected. A concurrent duplicate raises a bare
     * `23505`; the booking action catches it and re-reads via
     * {@link findByBookingIdempotencyKey}. THAT IS THE SAFE SHAPE — catch-and-reread, never
     * conflict-and-guess. (⚠ The link is UNQUALIFIED on purpose: a
     * `caseEngagementsRepository.x` reference from INSIDE this object literal makes the
     * literal reference its own initializer and TypeScript infers it as `any` — TS7022.)
     */
    bookingIdempotencyKey?: string | null;
    /**
     * BAL-400 — `products` taxonomy ids to tag this case with, written to
     * `case_engagement_products` inside this transaction. Empty/omitted writes no rows.
     *
     * DE-DUPLICATED IN PROCESS before insert. A multi-select can legitimately post the same
     * id twice, and the partial unique would turn that client artefact into a `23505` that
     * rolls the WHOLE case back. De-duplicating is the forgiving-in-what-you-accept side of
     * the contract; the unique index remains the guarantee.
     *
     * ⚠ AN UNKNOWN PRODUCT ID ROLLS THE WHOLE CASE BACK (23503 on the `restrict` FK). That
     * is correct: a case tagged with a product that does not exist is worse than no case,
     * and the caller is validating against a taxonomy it just rendered.
     */
    productIds?: readonly string[];
  }): Promise<CaseEngagementRow> {
    return db.transaction(async (tx) => {
      const parent = await insertEngagementRowTx(tx, {
        engagementType: 'case',
        companyId: input.companyId,
        expertProfileId: input.expertProfileId,
        currency: input.currency,
        // EXPLICIT NULL — see the `balo_fee_bps` docblock on `engagements`.
        baloFeeBps: null,
        activatedAt: input.activatedAt ?? new Date(),
      });

      const [child] = await tx
        .insert(caseEngagements)
        .values({
          engagementId: parent.id,
          title: input.title,
          description: input.description,
          bookingIdempotencyKey: input.bookingIdempotencyKey ?? null,
        })
        .returning();

      if (child === undefined) {
        throw new Error('Failed to create case engagement');
      }

      // BAL-400 — the product tags, on `tx`. De-duplicated (see the `productIds` docblock);
      // an empty set issues no statement at all rather than an INSERT with no VALUES.
      const productIds = [...new Set(input.productIds ?? [])];
      if (productIds.length > 0) {
        await tx
          .insert(caseEngagementProducts)
          .values(productIds.map((productId) => ({ engagementId: parent.id, productId })));
      }

      await recordEngagementCreated(tx, {
        engagementId: parent.id,
        engagementType: 'case',
        actorUserId: input.actorUserId ?? null,
      });

      // BAL-424 — the case's thread, anchored to the SUPERTYPE id. Same transaction: a case
      // that exists without a thread would be a case whose parties cannot talk.
      await conversationsRepository.ensureForContext(
        { contextType: 'engagement', contextId: parent.id },
        tx
      );

      return toCaseRow(parent, child);
    });
  },

  /** Live case by engagement id (parent + child, both `deleted_at IS NULL`). */
  async findByEngagementId(engagementId: string): Promise<CaseEngagementRow | undefined> {
    const [row] = await db
      .select({ parent: engagements, child: caseEngagements })
      .from(engagements)
      .innerJoin(caseEngagements, eq(caseEngagements.engagementId, engagements.id))
      .where(
        and(
          eq(engagements.id, engagementId),
          eq(engagements.engagementType, 'case'),
          isNull(engagements.deletedAt),
          isNull(caseEngagements.deletedAt)
        )
      )
      .limit(1);

    return row === undefined ? undefined : toCaseRow(row.parent, row.child);
  },

  /**
   * BAL-400 — THE IDEMPOTENT-REPLAY LOOKUP AT THE CASE GRAIN. The one live case created
   * under this booking key, or `undefined`. Rides
   * `case_engagement_booking_idempotency_key_idx`.
   *
   * ⚠⚠ ACTOR-SCOPED BY CONSTRUCTION, AND THAT IS WHY THIS TAKES NO `userId`. The stored key
   * is `sha256(userId:nonce)`, hashed SERVER-SIDE, so a key that resolves to a case can only
   * have been minted by that case's creator — cross-user collision is unreachable, not
   * merely unlikely. A RAW CLIENT-SUPPLIED KEY WOULD MAKE THIS AN IDOR: a stranger replaying
   * someone else's key would be handed their `engagementId`. Any future caller that wants to
   * key this on something the client chooses MUST add an ownership check in the same change.
   *
   * ⚠ THIS IS A LOOKUP, NOT AN AUTHORIZATION GATE — the same ruling as {@link close}. It
   * resolves no capability and interprets no role. The attach/booking server action still
   * gates on `CONSUME_CREDITS` over the returned `companyId` (ADR-1029).
   *
   * LIVE ROWS ONLY on BOTH parent and child, matching the index predicate: a soft-deleted
   * case neither answers a replay nor keeps its key locked.
   *
   * ⚠ THIS IS THE **CASE** GRAIN ONLY. The meeting the same submit books carries the SAME
   * key on `meetings.booking_idempotency_key`; `meetingsRepository.findByBookingIdempotencyKey`
   * answers that half. Both halves exist because the booking is two non-atomic hops.
   */
  async findByBookingIdempotencyKey(key: string): Promise<CaseEngagementRow | undefined> {
    const [row] = await db
      .select({ parent: engagements, child: caseEngagements })
      .from(engagements)
      .innerJoin(caseEngagements, eq(caseEngagements.engagementId, engagements.id))
      .where(
        and(
          eq(caseEngagements.bookingIdempotencyKey, key),
          eq(engagements.engagementType, 'case'),
          isNull(engagements.deletedAt),
          isNull(caseEngagements.deletedAt)
        )
      )
      .limit(1);

    return row === undefined ? undefined : toCaseRow(row.parent, row.child);
  },

  /**
   * BAL-400 §2.5 — the client's OPEN cases with THIS expert, plus how many they have already
   * resolved with them. Feeds the booking flow's "attach to an existing case" chooser.
   *
   * KEYED `(company_id, expert_profile_id, engagement_type='case', status='active')` with
   * `closed_at IS NULL` on the child and `deleted_at IS NULL` on both. ADR-1045 §5:
   * `engagements.expert_profile_id` is NOT NULL and there is exactly one expert per
   * engagement, so attach is offered ONLY for this expert's cases — there is no such thing
   * as a cross-expert case, and no arm of the chooser needs to handle one.
   *
   * ⚠ BOTH LIVENESS PREDICATES ARE REQUIRED AND NEITHER IMPLIES THE OTHER. `status='active'`
   * is the PARENT's coarse lifecycle; `closed_at IS NULL` is the CHILD's resolution state.
   * `close()` writes both in one transaction, but the inactivity sweep and any future
   * cancel path need not, and a case that is closed-but-still-active must never be offered
   * as an attach target.
   *
   * ⚠ NOT AN AUTHORIZATION GATE — the same ruling as every other method in this file. It
   * resolves no capability and interprets no role; the caller passes a `companyId` it has
   * ALREADY proven the actor holds `CONSUME_CREDITS` on (ADR-1029). Passing an arbitrary
   * `companyId` here returns that company's cases, so do not call it with an unvalidated
   * one.
   *
   * ⚠ THE SHIPPED AGGREGATE HELPER DOES NOT FIT, WHICH IS WHY THIS QUERY COMPUTES ITS OWN.
   * `meetingContextsRepository.consultationTimestampsForEngagements` answers
   * `lastCompletedConsultationAt` / `nextScheduledConsultationAt` — two anchors BAL-425's
   * inactivity rule needs, and NEITHER of which is `MAX(scheduled_start)` or a count. Using
   * it would mean a second round trip that returns the wrong two numbers. The join below is
   * the same `meeting_contexts` reverse edge (`context_type='case'`,
   * `context_id = engagement_id`) that `meeting_context_reverse_idx` exists for.
   *
   * ⚠ `consultationCount` COUNTS DISTINCT **LIVE MEETINGS**, not raw context rows. In
   * practice the two agree — `meetingsRepository.softDelete` stamps the meeting AND its
   * context rows in one transaction — but a context row that outlived its meeting would
   * inflate a number the client reads as "3 consultations", so the count is taken on the
   * side that is actually a consultation.
   *
   * ORDERING is most-recent-activity first and DETERMINISTIC on ties: `lastActivityAt DESC,
   * created_at DESC, engagement_id ASC`. A stable order matters because the UI shows the
   * first four and hides the rest behind "Show N more" — a wobbling order would move cards
   * under the cursor between renders.
   *
   * ⚠ NO INDEX WAS ADDED FOR THIS READ, DELIBERATELY (plan, "engagements index gap").
   * `engagements` carries `engagement_company_idx`, `engagement_expert_idx` and the
   * type-leading `engagement_type_status_created_idx`, but nothing on
   * `(company_id, expert_profile_id, status)`. The read is bounded by
   * `engagement_company_idx` to ONE company's engagements — a small set for every realistic
   * client — and runs once per booking, so a second `ALTER` on a hot table was not worth it.
   * If a seeded multi-thousand-row `engagements` ever shows a seq scan here, add
   * `index('engagement_company_expert_status_idx').on(companyId, expertProfileId, status)`
   * partial on `deleted_at IS NULL` rather than widening this query.
   */
  async listOpenForCompanyAndExpert(input: {
    companyId: string;
    expertProfileId: string;
    /** Bounds the OPEN list only, never `resolvedCaseCount`. The UI caps display at 4. */
    limit?: number;
  }): Promise<OpenCasesForExpert> {
    const limit = input.limit ?? 10;
    if (limit <= 0) {
      return { openCases: [], resolvedCaseCount: 0 };
    }

    // COALESCE so a case with no meetings still sorts by SOMETHING monotonic. Declared once
    // and used in both the projection and the ORDER BY so they cannot disagree.
    const lastActivityAt = sql<
      Date | string
    >`coalesce(max(${meetings.scheduledStart}), ${engagements.createdAt})`;

    const partyMatch = and(
      eq(engagements.engagementType, 'case'),
      eq(engagements.companyId, input.companyId),
      eq(engagements.expertProfileId, input.expertProfileId),
      isNull(engagements.deletedAt),
      isNull(caseEngagements.deletedAt)
    );

    const rows = await db
      .select({
        engagementId: engagements.id,
        title: caseEngagements.title,
        createdAt: engagements.createdAt,
        lastActivityAt,
        consultationCount: sql<number>`count(distinct ${meetings.id})::int`,
      })
      .from(engagements)
      .innerJoin(caseEngagements, eq(caseEngagements.engagementId, engagements.id))
      // The `meeting_contexts` reverse edge. LEFT so a case with no consultation yet — the
      // resting state D4b declares acceptable — still appears in the chooser.
      .leftJoin(
        meetingContexts,
        and(
          eq(meetingContexts.contextType, 'case'),
          eq(meetingContexts.contextId, engagements.id),
          isNull(meetingContexts.deletedAt)
        )
      )
      .leftJoin(
        meetings,
        and(eq(meetings.id, meetingContexts.meetingId), isNull(meetings.deletedAt))
      )
      .where(
        and(
          partyMatch,
          // Enum literals at QUERY time are always safe — the house restriction is on index
          // predicates and CHECKs.
          eq(engagements.status, 'active'),
          isNull(caseEngagements.closedAt)
        )
      )
      .groupBy(engagements.id, caseEngagements.title, engagements.createdAt)
      .orderBy(desc(lastActivityAt), desc(engagements.createdAt), asc(engagements.id))
      .limit(limit);

    const [resolved] = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(engagements)
      .innerJoin(caseEngagements, eq(caseEngagements.engagementId, engagements.id))
      .where(and(partyMatch, isNotNull(caseEngagements.closedAt)));

    return {
      openCases: rows.map((row) => ({
        engagementId: row.engagementId,
        title: row.title,
        createdAt: row.createdAt,
        // `coalesce(...)` reaches us through a raw `sql` fragment, so its runtime type is
        // OURS to narrow, not the driver's (memory `reference_jsonb_date_type_lie` — a type
        // that merely CLAIMS `Date` is how string timestamps leak into callers). NEVER null:
        // the COALESCE falls back to the NOT NULL `created_at`.
        lastActivityAt:
          row.lastActivityAt instanceof Date ? row.lastActivityAt : new Date(row.lastActivityAt),
        consultationCount: Number(row.consultationCount),
      })),
      resolvedCaseCount: Number(resolved?.total ?? 0),
    };
  },

  /**
   * Close a case. Discriminated union, mirroring `acceptCompletion`:
   *   - `{ reason: 'resolved', userId }` — a CLIENT-SIDE user closes. `userId` MUST be
   *     a LIVE member of `engagements.company_id` — the DATA-INTEGRITY invariant on
   *     `closed_by_user_id`. A non-member (including the delivering expert) fails
   *     closed → `CaseCloserNotMemberError`.
   *   - `{ reason: 'auto_inactive' }` — the BAL-420 sweep. Type-CANNOT supply a user;
   *     `closed_by_user_id` stays NULL (ADR-1030 system-actor exemption).
   *
   * ⚠ THIS IS NOT AN AUTHORIZATION GATE. No capability is resolved here and no role
   * is interpreted — the membership read's returned role string is deliberately
   * discarded. `hasCapability(actor, CAPABILITIES.PARTICIPATE, { companyId })` is
   * BAL-421's, in the close server action. This file imports NOTHING from
   * `@balo/shared/authz`; a reviewer can check the ruling still holds by grepping it.
   *
   * ONE transaction, ONE connection: `lockEngagementRowTx(tx, id, 'case')` → lock the
   * child FOR UPDATE → guard `closed_at IS NULL` → assert LIVE membership ON `tx` →
   * write child `{closedAt, closedByUserId, closeReason}` AND parent
   * `status = 'completed'` → `recordDeliveryAudit(tx, …)`.
   *
   * A Case's terminal state is `completed`, never `cancelled`.
   *
   * ⚠ BAL-390 CONTRACT — READ THIS BEFORE WIRING ANOTHER CALLER. This repository
   * CANNOT publish notification events: `@balo/db` depends only on `@balo/shared`,
   * `drizzle-orm` and `postgres`, so no publisher is reachable from here, and this file
   * deliberately imports nothing from the notifications tree. Closing a case IS the
   * terminal anchor for the review ask, so EVERY CALLER MUST, POST-COMMIT:
   *   1. mint a `review_invite_tokens` row for the resolved client-side reviewer, and
   *   2. publish `engagement.case_closed` carrying the RAW `reviewToken`, when that
   *      reviewer has not already rated the delivering expert.
   * BAL-388's `resolveCaseAction` (apps/web, the recap's `resolved` close) is the FIRST
   * caller and does both; copy its post-commit half. BAL-420's `auto_inactive` sweep is
   * the second, and mints NO token by design.
   *
   * The NUDGE half needs no caller wiring: `listClosedBetween` below starts matching the
   * moment `closed_at` is first stamped. It is NOT close-reason-blind, though — it reads
   * the `close_reason` written HERE and threads it to the +7d nudge copy, which says
   * "things went quiet … rather than leave it hanging" for `auto_inactive` and a neutral
   * "we closed the case out on {date}" for `resolved`, mirroring `CaseClosedEmail`. So
   * WRITE THE HONEST REASON: passing `auto_inactive` for a client-initiated close would
   * make the nudge assert inactivity about an action the client took themselves.
   */
  async close(
    input: { engagementId: string } & (
      | { reason: 'resolved'; userId: string }
      | { reason: 'auto_inactive' }
    )
  ): Promise<CaseEngagementRow> {
    return db.transaction(async (tx) => {
      // LOCK ORDER: parent → child. Never the reverse.
      const parent = await lockEngagementRowTx(tx, input.engagementId, 'case');

      const [child] = await tx
        .select()
        .from(caseEngagements)
        .where(
          and(
            eq(caseEngagements.engagementId, input.engagementId),
            isNull(caseEngagements.deletedAt)
          )
        )
        .for('update');

      if (child === undefined) {
        throw new Error(`Case engagement child row missing: ${input.engagementId}`);
      }
      if (child.closedAt !== null) {
        throw new CaseAlreadyClosedError(input.engagementId, child.closedAt);
      }

      let closedByUserId: string | null = null;
      if (input.reason === 'resolved') {
        // THE DATA-INTEGRITY INVARIANT: `closed_by_user_id` must be a LIVE member of
        // the contracting company. Read on `tx` — the SAME executor as the locks and
        // the write — so the check and the write are atomic (a second pooled
        // connection would miss this transaction's view and could block it while it
        // holds row locks).
        const role = await partyMembershipsRepository.getMemberRole(
          'company',
          parent.companyId,
          input.userId,
          tx
        );
        if (role === undefined) {
          throw new CaseCloserNotMemberError(input.engagementId, input.userId);
        }
        // ⚠ THE ROLE STRING IS DELIBERATELY DISCARDED. Presence of a LIVE membership is
        // the whole test. Do NOT reintroduce `roleHasCapability(role, …)`,
        // `CAPABILITIES.*`, or any `role ===` comparison here — any of those turns this
        // back into the authorization gate the owner ruled out. Capabilities are
        // resolved at the call site (ADR-1029), and the call site is BAL-421's server
        // action.
        closedByUserId = input.userId;
      }

      const closedAt = new Date();

      const [updatedChild] = await tx
        .update(caseEngagements)
        .set({ closedAt, closedByUserId, closeReason: input.reason })
        .where(eq(caseEngagements.engagementId, input.engagementId))
        .returning();

      if (updatedChild === undefined) {
        throw new Error(`Failed to close case: ${input.engagementId}`);
      }

      const [updatedParent] = await tx
        .update(engagements)
        .set({ status: 'completed' })
        .where(eq(engagements.id, input.engagementId))
        .returning();

      if (updatedParent === undefined) {
        throw new Error(`Failed to close case: ${input.engagementId}`);
      }

      await recordDeliveryAudit(tx, {
        actorUserId: closedByUserId,
        action: 'engagement.case_closed',
        entityType: 'engagement',
        entityId: input.engagementId,
        engagementId: input.engagementId,
        metadata: { close_reason: input.reason, from: 'active', to: 'completed' },
      });

      return toCaseRow(updatedParent, updatedChild);
    });
  },

  /**
   * WRITE a pending expert resolution REQUEST — the expert's "please confirm this is
   * resolved" ask, and the exact MIRROR of {@link clearResolutionRequest} (BAL-421). The
   * columns shipped INERT with BAL-417; this is their first and only writer.
   *
   * ⚠ BOTH PAIRED COLUMNS IN ONE UPDATE, AND THAT IS A CORRECTNESS CONSTRAINT RATHER THAN
   * TIDINESS. `case_engagement_resolution_request_paired` is
   * `(resolution_requested_at IS NULL) = (resolution_requested_by_user_id IS NULL)`, so
   * setting one alone is rejected 23514.
   *
   * ⚠ NOT AN AUTHORIZATION GATE — the same ruling as {@link close} and
   * {@link clearResolutionRequest}. No capability is resolved here and no role is
   * interpreted. `hasEngagementCapability(actor, MANAGE_ENGAGEMENT, { contextType: 'case',
   * contextId })` runs at the CALL SITE (ADR-1029 / ADR-1046), in BAL-421's server action.
   * This file imports NOTHING from `@balo/shared/authz`; a reviewer can check the ruling
   * still holds by grepping it.
   *
   * ⚠⚠ AND THEREFORE — DELIBERATELY — THERE IS **NO** MEMBERSHIP INVARIANT ON `userId`, WHICH
   * IS AN ASYMMETRY WITH {@link close}, NOT AN OVERSIGHT. `close` can assert its
   * data-integrity invariant (`closed_by_user_id` is a LIVE member of
   * `engagements.company_id`) because the subject is right there on the parent row, and
   * asserting it interprets no role. The expert-side equivalent — "the requester is the
   * delivering expert, or an owner/admin of their agency" — is NOT a row-coherence
   * question: it spans `expert_profiles` → `agencies` → `agency_members` and IS the
   * ADR-1046 `manage_engagement` holder rule, character for character. Encoding it here
   * would be a SECOND definition of an authorization rule living in the data layer, which
   * is precisely what ADR-1029 forbids. So the only guarantee this method makes about
   * `userId` is the FK: a non-existent user fails 23503. The holder set is the server
   * action's to enforce, and it is the only place that enforces it.
   *
   * ⚠ NO NOTIFICATION, NO DOMAIN EVENT, NO AUDIT ROW. Symmetric with the shipped dismiss
   * half (owner decision D-E): the ask renders as a banner on the case surface and nowhere
   * else, and the two paired columns ARE the attribution record — which is why there is no
   * `recordDeliveryAudit` call here either. Do not invent an event, payload, template or
   * rule for it.
   *
   * LAST-ASK-WINS (owner, 2026-08-12): the `WHERE` does NOT require the columns to be NULL,
   * so a re-ask OVERWRITES the timestamp and the actor. There is no cooldown column and no
   * migration for one. This is safe precisely BECAUSE nothing fires: the blast radius of a
   * re-ask is one banner reappearing, not a second email.
   *
   * DOES NOT TOUCH `status`, `closed_at` OR `close_reason` — asking whether a case is
   * resolved is not closing it. The case stays OPEN and stays a live inactivity-sweep
   * candidate.
   *
   * REFUSES A CLOSED CASE (`closed_at IS NULL` in the WHERE) — asking whether an already
   * closed case is resolved is incoherent, and would rewrite terminal history for no
   * user-visible gain. A closed case matches nothing and `undefined` comes back; the caller
   * answers not-found.
   *
   * The statement itself — the parent-read-BEFORE-update ordering, the paired write, the
   * closed/soft-deleted refusals — is {@link writeResolutionRequestTx}, shared verbatim with
   * the dismissal half rather than copied.
   */
  async requestResolution(input: {
    engagementId: string;
    userId: string;
  }): Promise<CaseEngagementRow | undefined> {
    return writeResolutionRequestTx(input.engagementId, { kind: 'ask', userId: input.userId });
  },

  /**
   * CLEAR a pending expert resolution REQUEST, leaving the case OPEN (BAL-388).
   *
   * ⚠ BOTH COLUMNS ARE NULLED IN ONE UPDATE, AND THAT IS A CORRECTNESS CONSTRAINT RATHER THAN
   * TIDINESS. `case_engagement_resolution_request_paired` is
   * `(resolution_requested_at IS NULL) = (resolution_requested_by_user_id IS NULL)`, so nulling
   * one column alone is rejected 23514.
   *
   * IDEMPOTENT BY CONSTRUCTION: the `WHERE` does NOT require a request to be present, so
   * dismissing twice is a no-op that still returns the row. A client who double-clicks
   * "Not yet" sees one outcome.
   *
   * REFUSES A CLOSED CASE (`closed_at IS NULL` in the WHERE) — clearing a request on a case
   * that is already closed would rewrite terminal history for no user-visible gain. A closed
   * case matches nothing and `undefined` comes back; the caller answers not-found.
   *
   * ⚠ NOT AN AUTHORIZATION GATE — the same ruling as {@link close}. No capability is resolved
   * here and no role is interpreted. `hasCapability(actor, CAPABILITIES.PARTICIPATE,
   * { companyId })` runs at the CALL SITE (ADR-1029), in BAL-388's dismiss server action.
   *
   * ⚠ NO NOTIFICATION, NO DOMAIN EVENT (owner decision D-E). Dismissal clears the request and
   * leaves the case open, silently. Do not invent an event, payload, template or rule for it.
   *
   * ⚠⚠ THE PARENT IS READ **BEFORE** THE UPDATE, AND THE ORDER IS THE POINT. Reading it after
   * would let the write COMMIT while `undefined` came back — the caller then tells a client
   * "this case is no longer open" about a request that was in fact cleared. Reading first means
   * a soft-deleted or non-`case` parent short-circuits with NO write at all, so the returned
   * value and the persisted state can never disagree.
   *
   * BAL-421: the statement is now {@link writeResolutionRequestTx}, shared with the ask half
   * (`requestResolution`). BEHAVIOUR IS UNCHANGED — every guarantee above is the extracted
   * function's, and this method's integration tests pass unmodified. That is the proof.
   */
  async clearResolutionRequest(input: {
    engagementId: string;
  }): Promise<CaseEngagementRow | undefined> {
    return writeResolutionRequestTx(input.engagementId, { kind: 'clear' });
  },

  /**
   * OPEN cases created on/before `cutoff`, oldest first — the SQL-EXPRESSIBLE HALF of
   * the 30-day inactivity rule. Rooted on `engagements`
   * (`engagement_type='case' AND status='active' AND deleted_at IS NULL AND
   * created_at <= cutoff`) INNER JOINed to `case_engagements`
   * (`closed_at IS NULL AND deleted_at IS NULL`), `ORDER BY engagements.created_at ASC`.
   * Rides `engagement_type_status_created_idx` + `case_engagement_open_idx`.
   *
   * ⚠ The cutoff is compared against the PARENT's `created_at` — the same value
   * `CaseEngagementRow.createdAt` exposes, so the set this selects and the set BAL-420
   * re-evaluates with `isCaseInactive` cannot diverge on two clocks.
   *
   * ⚠ This is a SUPERSET, not the rule: it is consultation-blind, because no FK links
   * a case to its consultations yet (`credit_sessions` has no `engagement_id`;
   * `consultations` is an availability stub — BAL-418's `meeting_contexts` is the
   * link). BAL-420 refines each row with `isCaseInactive()` from
   * `@balo/shared/engagements`, and MUST NOT run a sweep over this before BAL-418
   * lands. The caller computes `cutoff = now - CASE_INACTIVITY_DAYS` — the repo stays
   * policy-free (mirrors `listPendingAutoAccept(cutoff)`).
   */
  async listOpenCreatedBefore(cutoff: Date): Promise<CaseEngagementRow[]> {
    const rows = await db
      .select({ parent: engagements, child: caseEngagements })
      .from(engagements)
      .innerJoin(caseEngagements, eq(caseEngagements.engagementId, engagements.id))
      .where(
        and(
          eq(engagements.engagementType, 'case'),
          eq(engagements.status, 'active'),
          isNull(engagements.deletedAt),
          lte(engagements.createdAt, cutoff),
          isNull(caseEngagements.closedAt),
          isNull(caseEngagements.deletedAt)
        )
      )
      .orderBy(asc(engagements.createdAt));

    return rows.map((r) => toCaseRow(r.parent, r.child));
  },

  /**
   * BAL-390 — the CASE half of the rating-nudge candidate scan: live cases whose
   * `closed_at` falls in the HALF-OPEN band `(after, until]` and whose delivering expert
   * has not already been rated on that engagement. The exact contract, band semantics and
   * `NOT EXISTS` suppression as `projectEngagementsRepository.listAcceptedBetween` — the
   * two are deliberately shape-identical (both return `RatingNudgeCandidate[]`) so the
   * sweep queries both anchors every tick without branching. That includes the ratified
   * ENGAGEMENT-level suppression (no reviewer predicate): read that method's docblock, and
   * `review-nudge-sweep.ts`'s header, before changing this subquery.
   *
   * ⚠ THIS RETURNS `[]` TODAY, AND THAT IS EXPECTED (D5). `close()` has ZERO production
   * callers, so nothing stamps `closed_at` yet. DO NOT delete this method, its index, or
   * the sweep's call to it on the grounds that "it always returns empty" — it
   * SELF-ACTIVATES with zero code change the moment BAL-420/BAL-421 land, and the sweep's
   * unit test asserts both anchors are queried precisely to stop that deletion.
   *
   * CHILD-ROOTED so it rides `case_engagement_closed_at_idx`; both parent and child
   * `deleted_at` are guarded.
   */
  async listClosedBetween(after: Date, until: Date): Promise<RatingNudgeCandidate[]> {
    const rows = await db
      .select({
        engagementId: engagements.id,
        companyId: engagements.companyId,
        expertProfileId: engagements.expertProfileId,
        anchorAt: caseEngagements.closedAt,
        title: caseEngagements.title,
        // BAL-390 — carried so the +7d nudge can distinguish a deliberate `resolved`
        // close from an `auto_inactive` one instead of asserting "things went quiet"
        // over both. NULL only on a row that predates the CHECK, hence the ?? below.
        closeReason: caseEngagements.closeReason,
      })
      .from(caseEngagements)
      .innerJoin(engagements, eq(engagements.id, caseEngagements.engagementId))
      .where(
        and(
          gt(caseEngagements.closedAt, after),
          lte(caseEngagements.closedAt, until),
          isNull(caseEngagements.deletedAt),
          isNull(engagements.deletedAt),
          notExists(
            db
              .select({ one: sql`1` })
              .from(reviews)
              .where(
                and(
                  eq(reviews.engagementId, engagements.id),
                  eq(reviews.expertProfileId, engagements.expertProfileId),
                  isNull(reviews.deletedAt)
                )
              )
          )
        )
      )
      .orderBy(asc(caseEngagements.closedAt));

    return rows.flatMap((row) => {
      // `closed_at` is NULLABLE on the column, but the band predicate above cannot match
      // NULL — this guard exists to satisfy the type, never to filter.
      if (row.anchorAt === null) {
        return [];
      }
      return [
        {
          engagementId: row.engagementId,
          engagementKind: 'case' as const,
          companyId: row.companyId,
          expertProfileId: row.expertProfileId,
          anchorAt: row.anchorAt,
          title: row.title,
          // `close_reason` is NOT NULL for any closed row under
          // `case_engagement_close_coherent`, but the COLUMN is nullable, so a NULL
          // degrades to "reason unknown" and the nudge copy falls back to the
          // reason-blind wording rather than guessing.
          closeReason: row.closeReason ?? undefined,
        },
      ];
    });
  },
};
