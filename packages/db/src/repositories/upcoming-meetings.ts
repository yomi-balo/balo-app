import {
  and,
  asc,
  eq,
  exists,
  gt,
  inArray,
  isNull,
  lt,
  notInArray,
  sql,
  type SQL,
} from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { MEETING_CLOSED_TO_JOIN, type MeetingContextTypeWithHolder } from '@balo/shared/meetings';
import { createLogger } from '@balo/shared/logging';
import { db } from '../client';
import {
  agencies,
  caseEngagements,
  engagements,
  expertProfiles,
  meetingContexts,
  meetings,
  projectEngagements,
  projectRequests,
  requestExpertRelationships,
  users,
  type MeetingStatus,
} from '../schema';
import {
  foldMeetingContextRows,
  meetingVenueReadySql,
  type FoldedCalendarMeeting,
  type RawMeetingContextRow,
} from './meetings';
// ⚠ EXTRACTED BY BAL-567, NOT COPIED. "This case has a live thread" now has ONE definition,
// shared with `cases-index.ts` — see that module's docblock.
import { caseHasLiveThread } from './_shared/case-thread';

/**
 * BAL-566 — THE COMPANY-WIDE READ BEHIND THE DASHBOARD "UP NEXT" CARD.
 *
 * Every upcoming meeting on a company's cases, project kickoffs, project requests (discovery
 * calls) and request relationships (intro calls), already folded to ONE primary context per
 * meeting — the company counterpart of `meetingsRepository.listCalendarForExpert`.
 *
 * ⚠ READ-ONLY, AND IT NEVER NOTIFIES. No writer lives here and nothing here publishes, queues
 * or emails — pinned by `invariants/repositories-never-notify.test.ts`.
 *
 * ⚠⚠ THE TENANCY SEAM. `meeting_contexts.context_id` has NO FK and NO RLS: it is polymorphic,
 * and `meetingContextsRepository.attach` documents that a caller may attach a LOWER-tier context
 * it owns beneath ANOTHER tenant's tier-100 primary. So this read never trusts a `context_id` to
 * name the company's own record. It runs in three steps:
 *
 *   1. ARMS — one query per context type, each STARTING FROM the parent rows the company owns
 *      (`engagements.company_id` / `project_requests.company_id`) and only THEN joining
 *      `meeting_contexts` on those parent ids. Each arm encodes its web gate's own predicates.
 *      This produces the company-visible contexts and the CANDIDATE meetings.
 *   2. FOLD INPUT — every live context row of each candidate meeting, keyed by `meeting_id`, fed
 *      to the SAME fold the expert calendar uses (`foldMeetingContextRows`). These rows are fold
 *      input ONLY: never returned, never logged by `context_id`, never used as a lookup key. Folding
 *      over ALL of a meeting's contexts (not just the visible ones) is what keeps the client and
 *      expert views in agreement on `ambiguous`.
 *   3. OWNERSHIP — a meeting is kept only when its fold WINNER is one of step 1's company-visible
 *      contexts. A forged lower-tier context under a foreign primary therefore folds to the
 *      foreign winner and is OMITTED; it can never put another tenant's meeting on this company's
 *      dashboard.
 *
 * ⚠ IT NEVER READS `consultations`. That table is the expert AVAILABILITY projection and carries
 * no company column; the ownership predicate here is the parent row's `company_id`, not the
 * projection (a BAL-567 constraint as well).
 *
 * ⚠ NO AUTHORIZATION DECISION IS MADE HERE. The caller resolves the viewer's company-level
 * `PARTICIPATE` (`resolveCompanyParticipation`, `@balo/shared/authz`) BEFORE calling, and passes
 * the session's own `companyId` — never a URL param.
 */

const logger = createLogger('upcoming-meetings-repository');

const MS_PER_DAY = 86_400_000;

/**
 * The widest range {@link upcomingMeetingsRepository.listForCompany} serves. The only caller's
 * window is 14 days + 2 hours (a 2h lookback for in-progress calls); 15 leaves headroom while a
 * wider request still names a caller bug. Thrown, never truncated — the calendar precedent.
 */
export const MAX_UPCOMING_RANGE_DAYS = 15;

/**
 * Per-arm context-row cap. FAIL-CLOSED: reaching it throws rather than returning a list whose
 * dropped rows could be the soonest meetings (an arm has no `ORDER BY`, so a `LIMIT` would cut
 * arbitrarily).
 */
export const MAX_UPCOMING_CONTEXT_ROWS = 2000;

/** The four context types Up next lists — one arm each. Package/retainer contexts have no arm. */
export type UpcomingArm = 'case' | 'project_kickoff' | 'project_discovery' | 'request_interaction';

/** `toISOString` throws `RangeError` on an Invalid Date; the guard must still throw ITS error. */
function isoOrInvalid(date: Date): string {
  return Number.isFinite(date.getTime()) ? date.toISOString() : 'Invalid Date';
}

export class UpcomingMeetingsRangeTooWideError extends Error {
  constructor(rangeStart: Date, rangeEnd: Date) {
    super(
      `listForCompany: range ${isoOrInvalid(rangeStart)}..${isoOrInvalid(rangeEnd)} ` +
        `exceeds the maximum of ${MAX_UPCOMING_RANGE_DAYS} days`
    );
    this.name = 'UpcomingMeetingsRangeTooWideError';
  }
}

export class UpcomingMeetingsTooManyRowsError extends Error {
  constructor(companyId: string, arm: UpcomingArm, rowLimit: number) {
    super(
      `listForCompany: company ${companyId} has at least ${rowLimit} ${arm} context rows in the ` +
        `requested range, the maximum this read will serve`
    );
    this.name = 'UpcomingMeetingsTooManyRowsError';
  }
}

/** One context the company provably owns (step 1). Exported for the unit test only. */
export interface VisibleCompanyContext {
  readonly meetingId: string;
  readonly contextType: UpcomingArm;
  readonly contextId: string;
  /** Request-grain only (the link target), mirroring `ExpertCalendarMeeting.projectRequestId`. */
  readonly projectRequestId: string | null;
  /** The delivering or invited expert. `null` only for a match-routed discovery request. */
  readonly expertProfileId: string | null;
}

export interface CompanyUpcomingMeeting {
  readonly meetingId: string;
  readonly scheduledStart: Date;
  readonly scheduledEnd: Date;
  /** Never `ended` or `cancelled` (SQL: NOT IN `MEETING_CLOSED_TO_JOIN`). */
  readonly status: MeetingStatus;
  readonly contextType: MeetingContextTypeWithHolder;
  /** The fold winner, PROVEN to be one of the company's own contexts (step 3). */
  readonly contextId: string;
  readonly projectRequestId: string | null;
  readonly expertProfileId: string | null;
  /**
   * Always `true`: a meeting whose winner is not company-owned is OMITTED, never nulled. Present
   * so the row structurally satisfies the web layer's `hrefForMeeting` input (D6).
   */
  readonly owningRowFound: true;
  /** BAL-581 — the meeting's call room exists and is ours: `meetingVenueReadySql`, the pinned
   *  SQL twin of `isMeetingVenueReady`. A readiness BOOLEAN — this read selects no join
   *  credential (`daily_room_name` / `join_url`); the Join href is built from the meeting id. */
  readonly roomReady: boolean;
}

export interface UpcomingMeetingTitles {
  readonly caseTitleByEngagementId: ReadonlyMap<string, string>;
  /**
   * `null` = the kickoff has no linked request, or the linked request is soft-deleted. The KEY is
   * still present for every live project engagement; the web layer applies D8's fallback title.
   */
  readonly kickoffRequestTitleByEngagementId: ReadonlyMap<string, string | null>;
  readonly requestTitleById: ReadonlyMap<string, string>;
}

export interface ExpertPartyNames {
  readonly expertProfileId: string;
  readonly type: 'freelancer' | 'agency';
  /** `null` when unset, or when the expert's user row is soft-deleted. */
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly agencyName: string | null;
}

interface UpcomingRange {
  readonly rangeStart: Date;
  readonly rangeEnd: Date;
}

// ── Pure helpers (exported for `upcoming-meetings.test.ts`) ──────────────────────────────────

/** Throws {@link UpcomingMeetingsRangeTooWideError} for a non-finite span or one over the cap. */
export function assertUpcomingRange(rangeStart: Date, rangeEnd: Date): void {
  const spanMs = rangeEnd.getTime() - rangeStart.getTime();
  if (!Number.isFinite(spanMs) || spanMs > MAX_UPCOMING_RANGE_DAYS * MS_PER_DAY) {
    throw new UpcomingMeetingsRangeTooWideError(rangeStart, rangeEnd);
  }
}

/** Throws {@link UpcomingMeetingsTooManyRowsError} once an arm's `LIMIT` was actually reached. */
export function assertUpcomingRowCap(rowCount: number, companyId: string, arm: UpcomingArm): void {
  if (rowCount < MAX_UPCOMING_CONTEXT_ROWS) return;
  throw new UpcomingMeetingsTooManyRowsError(companyId, arm, MAX_UPCOMING_CONTEXT_ROWS);
}

function visibleContextKey(meetingId: string, contextType: string, contextId: string): string {
  return `${meetingId}:${contextType}:${contextId}`;
}

export interface VisibleContextIndex {
  /** Keyed by `meetingId:contextType:contextId` — the exact triple step 3 must match. */
  readonly visibleByKey: ReadonlyMap<string, VisibleCompanyContext>;
  /** De-duplicated, in first-seen order. */
  readonly candidateMeetingIds: readonly string[];
}

/** Step 1 → the ownership index step 3 checks against, plus the candidate meetings for step 2. */
export function indexVisibleContexts(
  visible: readonly VisibleCompanyContext[]
): VisibleContextIndex {
  const visibleByKey = new Map<string, VisibleCompanyContext>();
  const candidates = new Set<string>();
  for (const context of visible) {
    visibleByKey.set(
      visibleContextKey(context.meetingId, context.contextType, context.contextId),
      context
    );
    candidates.add(context.meetingId);
  }
  return { visibleByKey, candidateMeetingIds: [...candidates] };
}

/**
 * STEP 3 — keep a folded meeting only when its WINNER is one of the company's own contexts. The
 * owner scalars come from the VISIBLE row, never from step 2. Order is the input order (step 2's
 * `scheduled_start, id` SQL order, preserved by the fold) — no JS sort.
 */
export function assembleCompanyUpcomingMeetings(
  folded: readonly FoldedCalendarMeeting[],
  visibleByKey: ReadonlyMap<string, VisibleCompanyContext>,
  companyId: string
): CompanyUpcomingMeeting[] {
  const result: CompanyUpcomingMeeting[] = [];
  for (const meeting of folded) {
    const owned = visibleByKey.get(
      visibleContextKey(meeting.meetingId, meeting.contextType, meeting.contextId)
    );
    if (owned === undefined) {
      // ⚠ NO `contextId` IN THIS LOG. The winner here is, by construction, NOT the company's own
      // record — it is another tenant's identifier, and a log line is an emission like any other.
      logger.warn(
        { meetingId: meeting.meetingId, companyId, contextType: meeting.contextType },
        'Meeting omitted from the company upcoming read: primary context is not owned by the company'
      );
      continue;
    }
    result.push({
      meetingId: meeting.meetingId,
      scheduledStart: meeting.scheduledStart,
      scheduledEnd: meeting.scheduledEnd,
      status: meeting.status,
      contextType: meeting.contextType,
      contextId: owned.contextId,
      projectRequestId: owned.projectRequestId,
      expertProfileId: owned.expertProfileId,
      owningRowFound: true,
      roomReady: meeting.roomReady,
    });
  }
  return result;
}

// ── Shared SQL predicates ─────────────────────────────────────────────────────────────────────

/** A LIVE `meeting_contexts` row of `contextType` naming `parentId` — the step-1 join condition. */
function liveContextOf(contextType: UpcomingArm, parentId: PgColumn): SQL | undefined {
  return and(
    eq(meetingContexts.contextType, contextType),
    eq(meetingContexts.contextId, parentId),
    isNull(meetingContexts.deletedAt)
  );
}

/**
 * A live, joinable meeting overlapping the half-open window. The terminal statuses come from the
 * SHARED `MEETING_CLOSED_TO_JOIN` set (D2) — never a hand-list. Overlap, not containment: a call
 * that started before `rangeStart` and is still running is listed, as on the calendar.
 */
function meetingInWindow(range: UpcomingRange): SQL[] {
  return [
    isNull(meetings.deletedAt),
    notInArray(meetings.status, [...MEETING_CLOSED_TO_JOIN]),
    lt(meetings.scheduledStart, range.rangeEnd),
    gt(meetings.scheduledEnd, range.rangeStart),
  ];
}

/** A live `case_engagements` child — `load-case.ts`'s `findByEngagementId` coherence check. */
function caseChildIsLive(): SQL {
  return exists(
    db
      .select({ one: sql`1` })
      .from(caseEngagements)
      .where(
        and(eq(caseEngagements.engagementId, engagements.id), isNull(caseEngagements.deletedAt))
      )
  );
}

/** A live `project_engagements` child — `findWithMilestones` returns `undefined` without one. */
function projectChildIsLive(): SQL {
  return exists(
    db
      .select({ one: sql`1` })
      .from(projectEngagements)
      .where(
        and(
          eq(projectEngagements.engagementId, engagements.id),
          isNull(projectEngagements.deletedAt)
        )
      )
  );
}

// ── Step 1: the four arms ─────────────────────────────────────────────────────────────────────

interface EngagementGrainArm {
  readonly arm: 'case' | 'project_kickoff';
  readonly engagementType: 'case' | 'project';
  /** The arm's own gate predicates, each correlated on `engagements.id`. */
  readonly gatePredicates: () => SQL[];
}

/**
 * ⚠ The subtype child is required through a correlated `EXISTS` rather than an INNER JOIN. The
 * child's PK is `engagement_id`, so the two are row-for-row identical (a join cannot fan out);
 * `EXISTS` lets the case and kickoff arms share ONE query shape instead of two near-duplicates.
 */
const CASE_ARM: EngagementGrainArm = {
  arm: 'case',
  engagementType: 'case',
  gatePredicates: () => [caseChildIsLive(), caseHasLiveThread()],
};

const KICKOFF_ARM: EngagementGrainArm = {
  arm: 'project_kickoff',
  engagementType: 'project',
  gatePredicates: () => [projectChildIsLive()],
};

async function listEngagementGrainArm(
  companyId: string,
  range: UpcomingRange,
  spec: EngagementGrainArm
): Promise<VisibleCompanyContext[]> {
  const rows = await db
    .select({
      meetingId: meetings.id,
      engagementId: engagements.id,
      expertProfileId: engagements.expertProfileId,
    })
    .from(engagements)
    .innerJoin(meetingContexts, liveContextOf(spec.arm, engagements.id))
    .innerJoin(meetings, eq(meetings.id, meetingContexts.meetingId))
    .where(
      and(
        eq(engagements.companyId, companyId),
        eq(engagements.engagementType, spec.engagementType),
        isNull(engagements.deletedAt),
        ...spec.gatePredicates(),
        ...meetingInWindow(range)
      )
    )
    .limit(MAX_UPCOMING_CONTEXT_ROWS);
  assertUpcomingRowCap(rows.length, companyId, spec.arm);
  return rows.map((row) => ({
    meetingId: row.meetingId,
    contextType: spec.arm,
    contextId: row.engagementId,
    projectRequestId: null,
    expertProfileId: row.expertProfileId,
  }));
}

/** Discovery calls: `/projects/[requestId]`'s gate is a live request whose `company_id` matches. */
async function listDiscoveryArm(
  companyId: string,
  range: UpcomingRange
): Promise<VisibleCompanyContext[]> {
  const rows = await db
    .select({
      meetingId: meetings.id,
      projectRequestId: projectRequests.id,
      expertProfileId: projectRequests.expertProfileId,
    })
    .from(projectRequests)
    .innerJoin(meetingContexts, liveContextOf('project_discovery', projectRequests.id))
    .innerJoin(meetings, eq(meetings.id, meetingContexts.meetingId))
    .where(
      and(
        eq(projectRequests.companyId, companyId),
        isNull(projectRequests.deletedAt),
        ...meetingInWindow(range)
      )
    )
    .limit(MAX_UPCOMING_CONTEXT_ROWS);
  assertUpcomingRowCap(rows.length, companyId, 'project_discovery');
  return rows.map((row) => ({
    meetingId: row.meetingId,
    contextType: 'project_discovery',
    contextId: row.projectRequestId,
    projectRequestId: row.projectRequestId,
    expertProfileId: row.expertProfileId,
  }));
}

/**
 * Intro calls: the context names a RELATIONSHIP; the gate is its live request's `company_id`, and
 * the link target is that request's id (never the relationship id).
 */
async function listInteractionArm(
  companyId: string,
  range: UpcomingRange
): Promise<VisibleCompanyContext[]> {
  const rows = await db
    .select({
      meetingId: meetings.id,
      relationshipId: requestExpertRelationships.id,
      projectRequestId: projectRequests.id,
      expertProfileId: requestExpertRelationships.expertProfileId,
    })
    .from(requestExpertRelationships)
    .innerJoin(
      projectRequests,
      and(
        eq(projectRequests.id, requestExpertRelationships.projectRequestId),
        isNull(projectRequests.deletedAt)
      )
    )
    .innerJoin(meetingContexts, liveContextOf('request_interaction', requestExpertRelationships.id))
    .innerJoin(meetings, eq(meetings.id, meetingContexts.meetingId))
    .where(
      and(
        eq(projectRequests.companyId, companyId),
        isNull(requestExpertRelationships.deletedAt),
        ...meetingInWindow(range)
      )
    )
    .limit(MAX_UPCOMING_CONTEXT_ROWS);
  assertUpcomingRowCap(rows.length, companyId, 'request_interaction');
  return rows.map((row) => ({
    meetingId: row.meetingId,
    contextType: 'request_interaction',
    contextId: row.relationshipId,
    projectRequestId: row.projectRequestId,
    expertProfileId: row.expertProfileId,
  }));
}

// ── Step 2: every live context of the candidate meetings (fold input only) ───────────────────

/**
 * Keyed by `meeting_id` ONLY — no `context_id` is ever used as a lookup key here. `meetingInWindow`
 * is repeated so a meeting that closed between the two reads drops out. Bounded by the step-1
 * caps (candidates) × the few contexts a meeting carries (`meeting_context_unique_idx`).
 * Selects `roomReady` (the SQL twin's boolean), never the join credential.
 */
async function readAllLiveContexts(
  candidateMeetingIds: readonly string[],
  range: UpcomingRange
): Promise<RawMeetingContextRow[]> {
  return db
    .select({
      meetingId: meetings.id,
      scheduledStart: meetings.scheduledStart,
      scheduledEnd: meetings.scheduledEnd,
      status: meetings.status,
      contextType: meetingContexts.contextType,
      contextId: meetingContexts.contextId,
      roomReady: sql<boolean>`${meetingVenueReadySql}`,
    })
    .from(meetings)
    .innerJoin(
      meetingContexts,
      and(eq(meetingContexts.meetingId, meetings.id), isNull(meetingContexts.deletedAt))
    )
    .where(and(inArray(meetings.id, [...candidateMeetingIds]), ...meetingInWindow(range)))
    .orderBy(asc(meetings.scheduledStart), asc(meetings.id));
}

// ── Title reads (each called only with a non-empty id list) ────────────────────────────────────

async function readCaseTitles(
  engagementIds: readonly string[]
): Promise<Array<{ engagementId: string; title: string }>> {
  return db
    .select({ engagementId: caseEngagements.engagementId, title: caseEngagements.title })
    .from(caseEngagements)
    .innerJoin(engagements, eq(engagements.id, caseEngagements.engagementId))
    .where(
      and(
        inArray(caseEngagements.engagementId, [...engagementIds]),
        eq(engagements.engagementType, 'case'),
        isNull(engagements.deletedAt),
        isNull(caseEngagements.deletedAt)
      )
    );
}

/**
 * ⚠ The request's soft-delete filter sits in the LEFT JOIN condition, not WHERE: a WHERE filter
 * would drop the live ENGAGEMENT row too, and the web layer could no longer tell "no request
 * title" (fallback) from "not a live kickoff" (no row).
 */
async function readKickoffTitles(
  engagementIds: readonly string[]
): Promise<Array<{ engagementId: string; title: string | null }>> {
  return db
    .select({ engagementId: engagements.id, title: projectRequests.title })
    .from(engagements)
    .innerJoin(
      projectEngagements,
      and(eq(projectEngagements.engagementId, engagements.id), isNull(projectEngagements.deletedAt))
    )
    .leftJoin(
      projectRequests,
      and(
        eq(projectRequests.id, projectEngagements.projectRequestId),
        isNull(projectRequests.deletedAt)
      )
    )
    .where(
      and(
        inArray(engagements.id, [...engagementIds]),
        eq(engagements.engagementType, 'project'),
        isNull(engagements.deletedAt)
      )
    );
}

async function readRequestTitles(
  projectRequestIds: readonly string[]
): Promise<Array<{ id: string; title: string }>> {
  return db
    .select({ id: projectRequests.id, title: projectRequests.title })
    .from(projectRequests)
    .where(
      and(inArray(projectRequests.id, [...projectRequestIds]), isNull(projectRequests.deletedAt))
    );
}

export const upcomingMeetingsRepository = {
  /**
   * Every upcoming meeting across the company's cases, project kickoffs, discovery calls and intro
   * calls, one row per meeting, `scheduled_start ASC, meetings.id ASC`. See the module docblock
   * for the three-step tenancy discipline.
   *
   * @param input.companyId the SESSION's workspace company — the caller has already resolved the
   *   viewer's company-level `PARTICIPATE`.
   * @param input.rangeStart half-open UTC window start (overlap: `scheduled_end > rangeStart`).
   * @param input.rangeEnd half-open UTC window end (`scheduled_start < rangeEnd`). The span must
   *   not exceed {@link MAX_UPCOMING_RANGE_DAYS}.
   * @throws UpcomingMeetingsRangeTooWideError, UpcomingMeetingsTooManyRowsError
   */
  async listForCompany(input: {
    companyId: string;
    rangeStart: Date;
    rangeEnd: Date;
  }): Promise<CompanyUpcomingMeeting[]> {
    assertUpcomingRange(input.rangeStart, input.rangeEnd);
    const range: UpcomingRange = { rangeStart: input.rangeStart, rangeEnd: input.rangeEnd };

    // Step 1 — the company-visible contexts, one arm per context type.
    const arms = await Promise.all([
      listEngagementGrainArm(input.companyId, range, CASE_ARM),
      listEngagementGrainArm(input.companyId, range, KICKOFF_ARM),
      listDiscoveryArm(input.companyId, range),
      listInteractionArm(input.companyId, range),
    ]);
    const visible = arms.flat();
    if (visible.length === 0) return [];

    const { visibleByKey, candidateMeetingIds } = indexVisibleContexts(visible);

    // Step 2 — fold over EVERY live context of each candidate meeting.
    const rows = await readAllLiveContexts(candidateMeetingIds, range);
    const folded = foldMeetingContextRows(rows, (meetingId, reason) =>
      logger.warn(
        { meetingId, companyId: input.companyId, reason },
        'Meeting omitted from the company upcoming read: no usable primary context'
      )
    );

    // Step 3 — keep only meetings whose winner is the company's own context.
    return assembleCompanyUpcomingMeetings(folded, visibleByKey, input.companyId);
  },

  /**
   * Titles for Up next rows, at most three queries — each skipped (no query) when its id list is
   * empty (D8).
   *
   * ⚠ CALLER OBLIGATION: every id passed in MUST already be verified as belonging to the viewer's
   * own rows (a `listForCompany` result, or an `owningRowFound` expert calendar row). This method
   * adds NO scope predicate of its own.
   */
  async findTitles(input: {
    caseEngagementIds: readonly string[];
    kickoffEngagementIds: readonly string[];
    projectRequestIds: readonly string[];
  }): Promise<UpcomingMeetingTitles> {
    const [caseRows, kickoffRows, requestRows] = await Promise.all([
      input.caseEngagementIds.length === 0 ? [] : readCaseTitles(input.caseEngagementIds),
      input.kickoffEngagementIds.length === 0 ? [] : readKickoffTitles(input.kickoffEngagementIds),
      input.projectRequestIds.length === 0 ? [] : readRequestTitles(input.projectRequestIds),
    ]);
    return {
      caseTitleByEngagementId: new Map(caseRows.map((row) => [row.engagementId, row.title])),
      kickoffRequestTitleByEngagementId: new Map(
        kickoffRows.map((row) => [row.engagementId, row.title])
      ),
      requestTitleById: new Map(requestRows.map((row) => [row.id, row.title])),
    };
  },

  /**
   * The expert-side party NAMES for Up next counterparties (D7) — name columns only: no rate, no
   * email, no `workos_id`. `[]` in → `[]` out with no query.
   *
   * Neither `expert_profiles` nor `agencies` has a `deleted_at`; a soft-deleted USER keeps the row
   * with `null` names (the filter sits in the LEFT JOIN condition), so the web layer's
   * "An expert" fallback applies. Same caller obligation as {@link findTitles}.
   */
  async findExpertPartyNames(expertProfileIds: readonly string[]): Promise<ExpertPartyNames[]> {
    if (expertProfileIds.length === 0) return [];
    return db
      .select({
        expertProfileId: expertProfiles.id,
        type: expertProfiles.type,
        firstName: users.firstName,
        lastName: users.lastName,
        agencyName: agencies.name,
      })
      .from(expertProfiles)
      .leftJoin(users, and(eq(users.id, expertProfiles.userId), isNull(users.deletedAt)))
      .leftJoin(agencies, eq(agencies.id, expertProfiles.agencyId))
      .where(inArray(expertProfiles.id, [...new Set(expertProfileIds)]));
  },
};
