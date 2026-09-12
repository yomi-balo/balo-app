import { and, asc, desc, eq, gt, gte, inArray, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  CAPTURE_HEALTH_RANK,
  type CaptureHealthCategory,
  type CaptureHealthFacts,
} from '@balo/shared/capture-health';
import { db } from '../client';
import {
  agencies,
  companies,
  consultations,
  engagements,
  expertProfiles,
  meetingContexts,
  meetingRecordings,
  meetings,
  projectRequests,
  requestExpertRelationships,
  transcripts,
  users,
  type MeetingContextType,
  type MeetingRecordingStatus,
  type MeetingStatus,
  type TranscriptStatus,
} from '../schema';

/**
 * `captureHealthRepository` (BAL-550) — THE READ BEHIND `/admin/health/capture`.
 *
 * ONE ROW PER MEETING (D8), because that is the only grain at which the three ladders coexist:
 * `meeting_recordings` is per SEGMENT (n per meeting, non-unique `(meeting_id, created_at)`),
 * `transcripts` anchors on `meeting_id` and carries no `meeting_recording_id`. The re-drive
 * ACTION stays segment-grain — it targets one `meeting_recordings.id` — but the ROW is a
 * meeting.
 *
 * ⚠ EVERY METHOD HERE READS. Rendering the ladders writes NOTHING — no sweep, no backfill, no
 * "while we are here" repair. The two mutations this lens can cause are
 * `meetingRecordingsRepository.reopenForIngestRedrive` and
 * `transcriptsRepository.claimRecapResume`, both behind a `super_admin` confirm sheet and an
 * audit row.
 *
 * ⚠ THE PARTY / CONTEXT JOIN LIVES HERE AND NOWHERE ELSE (D8: "keep the join minimal,
 * documented, and in ONE place"). `meeting_contexts` is polymorphic with NO foreign key, so
 * each of its three id-bearing arms has to be resolved by hand; doing that twice would be two
 * subtly different answers to "whose call was this".
 *
 * ⚠ NO TITLE IS PROJECTED. `meetings` HAS NO `title` COLUMN. The admin-alert finders already
 * derive `Consultation {d MMM}` from `scheduled_start`; the view layer REUSES that derivation
 * rather than inventing a second one, so this repository hands back `scheduledStart` and stops.
 *
 * ⚠ NO MONEY. Not a cent, not a fee, not a margin — this lens is about capture plumbing and a
 * money-shaped field here would be the first step to leaking the Balo fee onto a page that has
 * no business showing it.
 */

// ── Sanitisation ─────────────────────────────────────────────────────────────────────

/** Anything `http(s)://`-shaped, greedy to the next whitespace. The EXACT pattern
 *  `apps/api/src/lib/sanitize-error.ts` uses. One greedy quantifier over a negated class —
 *  linear, so no super-linear/ReDoS surface (SonarCloud S5852). */
const URL_PATTERN = /https?:\/\/\S+/g;

/**
 * ⚠⚠ THE VENDOR-TEXT BACKSTOP, APPLIED AT THE PROJECTION so no unsanitised vendor text can
 * cross into `apps/web`. A Mux `invalid_parameters` body ECHOES THE OFFENDING INPUT, which for
 * `assets.create` is the live Daily signed access link — `sanitize-error.ts`'s founding hazard.
 *
 * ⚠ WHY IT IS NOT AN IMPORT OF `sanitizedErrorMessage`. That module lives in `apps/api` and
 * VALUE-IMPORTS `@mux/mux-node` (it narrows on `Mux.APIError`); `@balo/db` is imported by the
 * web app, so pulling a vendor SDK in here is the client-bundle footgun
 * (`reference_balo_db_client_bundle_footgun`), and `apps/api` is not importable from a package
 * regardless. For a value ALREADY STORED IN A `text` COLUMN its `Mux.APIError` branch is
 * unreachable by construction, so `sanitizedErrorMessage` reduces EXACTLY to this URL
 * redaction — this is the same doctrine, not a weaker second one.
 *
 * ⚠ IT IS A BACKSTOP, NOT THE PRIMARY GUARD. Every writer of `failure_reason` /
 * `transcript_job_failure_reason` already sanitises at write time; this catches the rows
 * written before that shipped, and any future writer that forgets.
 */
function sanitizeStoredVendorText(value: string | null): string | null {
  return value === null ? null : value.replace(URL_PATTERN, '[redacted-url]');
}

// ── Public shapes ────────────────────────────────────────────────────────────────────

/** The read window over `meetings.scheduled_start`, HALF-OPEN: `[from, to)`. */
export interface CaptureHealthWindow {
  from: Date;
  to: Date;
}

/**
 * THE KEYSET CURSOR. All three parts are required because the ordering is
 * `(health_rank ASC, scheduled_start DESC, id DESC)` and a keyset must carry every key it
 * orders on.
 *
 * ⚠ `healthRank` IS DERIVED, NOT STORED — see {@link captureHealthRepository.listPage} for the
 * stability argument and the one accepted residual.
 */
export interface CaptureHealthCursor {
  healthRank: number;
  scheduledStart: Date;
  meetingId: string;
}

/** ONE meeting's row: the meeting's own facts, the SQL rank, and the ladder inputs. */
export interface CaptureHealthMeetingRow {
  meetingId: string;
  scheduledStart: Date;
  scheduledEnd: Date;
  startedAt: Date | null;
  endedAt: Date | null;
  meetingStatus: MeetingStatus;
  /**
   * ⚠ THE ORDERING AUTHORITY — the SQL `CASE` (see {@link healthRankSql}), not a TS
   * derivation. `CAPTURE_HEALTH_RANK[deriveCaptureHealthCategory(facts)]` must equal this for
   * every row; `capture-health.integration.test.ts` asserts exactly that over every ladder
   * combination, which is the only thing keeping the two definitions in agreement.
   */
  healthRank: number;
  facts: CaptureHealthFacts;
}

/** One live recording segment, projected for the row's expanded detail + the re-drive target. */
export interface CaptureHealthRecordingDetail {
  id: string;
  meetingId: string;
  status: MeetingRecordingStatus;
  failedStage: string | null;
  /** ⚠ SANITISED at this projection — see {@link sanitizeStoredVendorText}. */
  failureReason: string | null;
  dailyRecordingId: string | null;
  muxAssetId: string | null;
  sourceDeletedAt: Date | null;
  transcriptJobId: string | null;
  transcriptJobSubmittedAt: Date | null;
  transcriptJobFinishedAt: Date | null;
  /** ⚠ SANITISED at this projection. */
  transcriptJobFailureReason: string | null;
  createdAt: Date;
  durationSeconds: number | null;
}

/**
 * The meeting's NEWEST live transcript.
 *
 * ⚠⚠ NEVER `canonical` AND NEVER `extracted_action_items` — both are multi-hundred-KB jsonb.
 * The `transcriptsRepository.findByMeetingId` projection doctrine, restated because this read
 * fans out over 25 meetings at once and a bare `select()` here is 25 of them.
 */
export interface CaptureHealthRecapDetail {
  id: string;
  meetingId: string;
  status: TranscriptStatus;
  failedStage: string | null;
  failureReason: string | null;
  recapReadyPublishedAt: Date | null;
  actionItemsExtractedAt: Date | null;
  createdAt: Date;
}

/**
 * WHO DELIVERED THE CALL, read from `consultations`.
 *
 * ⚠ `consultations` IS THE SHIPPED WRITE-TIME PROJECTION OF "whose call is this" —
 * `_shared/consultation-projection.ts` resolves the expert across all seven context labels at
 * booking time. Reading it is REUSE; re-walking `meeting_contexts` for the expert would be a
 * SECOND answer to a question the platform has already answered, and the two would drift.
 * Absent (no live consultation, a match-routed discovery, an `admin` meeting) ⇒ the view
 * renders `expert unavailable`, the literal `platform-lookup.ts` already ships.
 */
export interface CaptureHealthExpertDetail {
  meetingId: string;
  expertProfileId: string;
  firstName: string | null;
  lastName: string | null;
  /** NULL for an independent expert — NOT an error. */
  agencyName: string | null;
}

/** The CLIENT company plus the winning context label (see {@link CONTEXT_LABEL_PRECEDENCE}). */
export interface CaptureHealthPartyDetail {
  meetingId: string;
  contextType: MeetingContextType;
  /** NULL when the winning context names no company (an `admin` meeting, or a dangling
   *  polymorphic `context_id` — which has no FK and therefore no referential guarantee). */
  companyName: string | null;
}

/** Everything the page needs BESIDE the ladders, keyed by meeting id. */
export interface CaptureHealthDetails {
  /** Oldest segment first — the order the page numbers them in ("Segment 2 of 3"). */
  recordings: ReadonlyMap<string, CaptureHealthRecordingDetail[]>;
  /** Newest live transcript of ANY status — what the recap CHIP narrates. */
  recap: ReadonlyMap<string, CaptureHealthRecapDetail>;
  /**
   * Newest live transcript matching the RE-DRIVABLE predicate — `status = 'failed' AND
   * failed_stage IS NOT NULL`, the exact CAS of
   * {@link transcriptsRepository.claimRecapResume} and the exact predicate behind the
   * `anyFailed` fact the chip derives from.
   *
   * ⚠ IT IS A SECOND MAP OVER THE SAME ROWS, NOT A SECOND QUERY. The recap ladder is an
   * AGGREGATE over all of a meeting's live transcripts, so a meeting with an older `failed`
   * row and a newer `ready` one renders `failed` while {@link CaptureHealthDetails.recap}
   * names the `ready` one. Handing that id to the re-drive guarantees a `409 not_redrivable`.
   */
  recapFailed: ReadonlyMap<string, CaptureHealthRecapDetail>;
  expert: ReadonlyMap<string, CaptureHealthExpertDetail>;
  party: ReadonlyMap<string, CaptureHealthPartyDetail>;
}

/**
 * ONE precedence array, declared ONCE. Engagement-grain beats request-grain, so a kickoff
 * (which legitimately carries BOTH `project_discovery` and `project_kickoff`) reads as a
 * kickoff, while a pure discovery call reads as discovery — matching the design fixture.
 * Ties inside a label break on `created_at ASC, id ASC`, the finder ordering.
 */
const CONTEXT_LABEL_PRECEDENCE: readonly MeetingContextType[] = [
  'case',
  'project_kickoff',
  'package_session',
  'retainer_checkin',
  'project_discovery',
  'request_interaction',
  'admin',
];

/**
 * The context labels whose `context_id` is an `engagements.id`. `hasEngagementContext` is
 * `bool_or` over exactly these — it is what makes transcription/recap `na` rather than broken
 * on a `match`-routed discovery or an `admin` meeting, because BAL-387's pipeline is
 * engagement-anchored (`transcripts.engagement_id` is NOT NULL).
 */
const ENGAGEMENT_CONTEXT_TYPES: readonly MeetingContextType[] = [
  'case',
  'project_kickoff',
  'package_session',
  'retainer_checkin',
];

/** Where a label sits in {@link CONTEXT_LABEL_PRECEDENCE}. An UNKNOWN label (an 8th enum
 *  value added without touching that array) sorts LAST rather than winning by accident. */
function contextPrecedenceOf(contextType: MeetingContextType): number {
  const index = CONTEXT_LABEL_PRECEDENCE.indexOf(contextType);
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

/** rank → category, derived from the ONE rank map so the two cannot drift. */
const CATEGORY_BY_RANK = new Map<number, CaptureHealthCategory>(
  Object.entries(CAPTURE_HEALTH_RANK).map(([category, rank]) => [
    rank,
    category as CaptureHealthCategory,
  ])
);

// ── The aggregates ───────────────────────────────────────────────────────────────────

/**
 * `coalesce(bool_or(p), false)`.
 *
 * ⚠ THE `coalesce` IS NOT DECORATION: `bool_or` over ZERO rows is NULL, and a NULL reaching TS
 * through a `sql<boolean>` cast would be a lie the type system cannot catch. Every aggregate
 * below therefore lands as a real `boolean`; the LEFT-joined ones are coalesced a SECOND time
 * at the outer select, where a missing join partner (a meeting with no transcript at all) also
 * produces NULL.
 */
function boolOr(predicate: SQL): SQL<boolean> {
  return sql<boolean>`coalesce(bool_or(${predicate}), false)`;
}

/** `cast(count(*) as int)` — `count` is bigint and postgres-js hands a bigint back as a
 *  STRING, which would silently become `"3"` in a `number` field. */
const countInt = sql<number>`cast(count(*) as int)`;

/**
 * ⚠⚠ EVERY ALIAS BELOW MUST BE GLOBALLY UNIQUE ACROSS THE THREE DERIVED TABLES, and this is
 * load-bearing, not tidiness. Drizzle renders an interpolated subquery field that was built
 * from `sql...as('x')` as the BARE alias `"x"` — never `"rec"."x"` — so the outer query
 * resolves it against its FROM items. Unique names resolve correctly; a duplicate would fail
 * at runtime with `42702 ambiguous column`. No alias may collide with a `meetings` column
 * name either. `capture-health.integration.test.ts` executes every one of these queries, so a
 * collision cannot ship silently.
 */
function recordingAggregate(bound: SQL, withheldBefore: Date) {
  return db
    .select({
      meetingId: meetingRecordings.meetingId,
      segmentCount: countInt.as('segment_count'),
      anyFailed: boolOr(eq(meetingRecordings.status, 'failed')).as('any_failed'),
      anySourceReady: boolOr(eq(meetingRecordings.status, 'source_ready')).as('any_source_ready'),
      anyIngesting: boolOr(eq(meetingRecordings.status, 'ingesting')).as('any_ingesting'),
      anyCapturing: boolOr(eq(meetingRecordings.status, 'recording')).as('any_capturing'),
      anyReady: boolOr(eq(meetingRecordings.status, 'ready')).as('any_ready'),
      // The three terms `reopenForIngestRedrive`'s CAS will apply, asked in advance so the page
      // never offers a button whose CAS is already guaranteed to match zero rows.
      anyRedrivableFailure: boolOr(
        sql`${eq(meetingRecordings.status, 'failed')} and ${meetingRecordings.sourceDeletedAt} is null and ${meetingRecordings.dailyRecordingId} is not null`
      ).as('any_redrivable_failure'),
      // ⚠ THE FOUR `transcript_job_*` COLUMNS LIVE ON `meeting_recordings`, NOT ON
      // `transcripts` — so the TRANSCRIPTION ladder is aggregated here, beside the RECORDING
      // ladder, and not in the recap aggregate below. Reading them from the wrong table is the
      // single easiest mistake to make on this feature.
      txAnyFailure: boolOr(sql`${meetingRecordings.transcriptJobFailureReason} is not null`).as(
        'tx_any_failure'
      ),
      txAnySubmitted: boolOr(sql`${meetingRecordings.transcriptJobSubmittedAt} is not null`).as(
        'tx_any_submitted'
      ),
      txAnyOpen: boolOr(
        sql`${meetingRecordings.transcriptJobSubmittedAt} is not null and ${meetingRecordings.transcriptJobFinishedAt} is null`
      ).as('tx_any_open'),
      // ⚠ ONE `withheldBefore` PER REQUEST, passed in by the caller and carried through every
      // load-more page, so page 2 ranks against the same instant page 1 did. `now()` here
      // instead would make the rank drift mid-pagination.
      txAnyWithheld: boolOr(
        sql`${meetingRecordings.transcriptJobSubmittedAt} is not null and ${meetingRecordings.transcriptJobFinishedAt} is null and ${meetingRecordings.transcriptJobSubmittedAt} <= ${withheldBefore.toISOString()}::timestamptz`
      ).as('tx_any_withheld'),
      txAnyFinished: boolOr(sql`${meetingRecordings.transcriptJobFinishedAt} is not null`).as(
        'tx_any_finished'
      ),
    })
    .from(meetingRecordings)
    .innerJoin(meetings, and(eq(meetings.id, meetingRecordings.meetingId), bound))
    .where(isNull(meetingRecordings.deletedAt))
    .groupBy(meetingRecordings.meetingId)
    .as('rec');
}

/**
 * The RECAP aggregate over `transcripts`.
 *
 * ⚠⚠ `any_recap_partial` (`status='ready' AND failed_stage IS NOT NULL`) IS NOT A FAILURE and
 * must never be folded into `any_recap_failed` (`status='failed' AND failed_stage IS NOT
 * NULL`). `recordStageSkip` stamps a stage on a DEGRADED-BUT-COMPLETED path, so a `ready` row
 * can legitimately carry one. Both predicates carry BOTH terms — dropping either is how a
 * skip becomes a phantom failure, or a failure becomes invisible.
 */
function recapAggregate(bound: SQL) {
  return db
    .select({
      meetingId: transcripts.meetingId,
      transcriptCount: countInt.as('transcript_count'),
      anyRecapFailed: boolOr(
        sql`${eq(transcripts.status, 'failed')} and ${transcripts.failedStage} is not null`
      ).as('any_recap_failed'),
      anyRecapPartial: boolOr(
        sql`${eq(transcripts.status, 'ready')} and ${transcripts.failedStage} is not null`
      ).as('any_recap_partial'),
      anyRecapProcessing: boolOr(eq(transcripts.status, 'processing')).as('any_recap_processing'),
      anyRecapReady: boolOr(
        sql`${eq(transcripts.status, 'ready')} and ${transcripts.failedStage} is null`
      ).as('any_recap_ready'),
    })
    .from(transcripts)
    .innerJoin(meetings, and(eq(meetings.id, transcripts.meetingId), bound))
    .where(isNull(transcripts.deletedAt))
    .groupBy(transcripts.meetingId)
    .as('tx');
}

/** "Does this meeting name an engagement at all?" — the only input to the two `na` branches. */
function engagementContextAggregate(bound: SQL) {
  return db
    .select({
      meetingId: meetingContexts.meetingId,
      hasEngagementContext: boolOr(
        inArray(meetingContexts.contextType, [...ENGAGEMENT_CONTEXT_TYPES])
      ).as('has_engagement_context'),
    })
    .from(meetingContexts)
    .innerJoin(meetings, and(eq(meetings.id, meetingContexts.meetingId), bound))
    .where(isNull(meetingContexts.deletedAt))
    .groupBy(meetingContexts.meetingId)
    .as('eng');
}

type RecordingAggregate = ReturnType<typeof recordingAggregate>;
type RecapAggregate = ReturnType<typeof recapAggregate>;

/**
 * ⚠⚠ THE RANK'S BRANCH VALUES ARE INLINE INTEGER LITERALS, **NEVER** BOUND PARAMETERS. Both
 * reasons below were real failures, caught by `capture-health.integration.test.ts` — neither a
 * typecheck nor a unit test can see either one:
 *
 *   1. **TYPE.** postgres-js sends every parameter UNTYPED, so `case when … then $1 … end`
 *      makes Postgres resolve the WHOLE expression as **text**. `health_rank` came back as the
 *      string `"3"`, the rank→category lookup in `countByCategory` missed every row, and — the
 *      silent one — the keyset `health_rank > $n` became a LEXICOGRAPHIC comparison that would
 *      mis-order the day a fifth rank made a two-digit value possible.
 *   2. **IDENTITY.** `countByCategory` groups by this expression while also selecting it.
 *      Postgres matches a GROUP BY expression to a SELECT expression SYNTACTICALLY, and a
 *      parameterised CASE renders with DIFFERENT parameter positions in the two clauses
 *      (`$1` in the select, `$5` in the group by) — so it is not the same expression and the
 *      query fails `42803 column "rec.any_failed" must appear in the GROUP BY clause`.
 *
 * `sql.raw` is safe here and only here: the value is a compile-time integer from the ONE rank
 * map, never anything a caller supplies.
 */
function rankLiteral(category: CaptureHealthCategory): SQL {
  return sql.raw(String(CAPTURE_HEALTH_RANK[category]));
}

/**
 * ⚠⚠ THE SQL HALF OF `deriveCaptureHealthCategory` (`@balo/shared/capture-health`).
 *
 * TWO DEFINITIONS EXIST BECAUSE ONE ORDERS AND COUNTS IN POSTGRES and the other renders in the
 * browser — a keyset cannot order on a value computed after the rows come back. They are held
 * in agreement MECHANICALLY by `capture-health.integration.test.ts`, which seeds every ladder
 * combination and asserts `CAPTURE_HEALTH_RANK[deriveCaptureHealthCategory(row.facts)] ===
 * row.healthRank` for EVERY row. NEVER EDIT ONE WITHOUT THE OTHER.
 *
 * The branches collapse the TS derivation exactly:
 *   · rank 1 ⇔ transcription ∈ {failed, withheld}. `failed` needs `txAnyFailure`; `withheld`
 *     needs `!txAnyFailure && txAnyWithheld` — so their union is the plain `OR` below.
 *   · rank 2 ⇔ recap ∈ {failed, partial}, by the same collapse.
 *
 * ⚠ ONE BUILDER, FOUR CONSUMERS — the outer SELECT, the keyset WHERE, the ORDER BY, and
 * `countByCategory`'s GROUP BY. Postgres cannot reference a SELECT alias from WHERE, so
 * `listPage` emits the expression more than once; it comes from HERE every time, never from a
 * hand-copied second CASE.
 *
 * ⚠ The `rec` terms need no outer `coalesce` (INNER-joined, always present); the `tx` terms do
 * (LEFT-joined — a meeting with no transcript row yields NULL).
 */
function healthRankSql(rec: RecordingAggregate, tx: RecapAggregate): SQL<number> {
  return sql<number>`case
    when ${rec.anyFailed} then ${rankLiteral('recording')}
    when ${rec.txAnyFailure} or ${rec.txAnyWithheld} then ${rankLiteral('transcription')}
    when coalesce(${tx.anyRecapFailed}, false) or coalesce(${tx.anyRecapPartial}, false) then ${rankLiteral('recap')}
    else ${rankLiteral('healthy')}
  end`;
}

/** The `meetings` population predicate shared by the outer read AND all three aggregates. */
function windowBound(window: CaptureHealthWindow): SQL {
  const bound = and(
    isNull(meetings.deletedAt),
    gte(meetings.scheduledStart, window.from),
    lt(meetings.scheduledStart, window.to)
  );
  if (bound === undefined) throw new Error('capture-health: window bound must not be empty');
  return bound;
}

/** The single-meeting bound behind the `?row=` deep link. NOT window-bounded, deliberately. */
function meetingBound(meetingId: string): SQL {
  const bound = and(isNull(meetings.deletedAt), eq(meetings.id, meetingId));
  if (bound === undefined) throw new Error('capture-health: meeting bound must not be empty');
  return bound;
}

interface RowQueryInput {
  bound: SQL;
  withheldBefore: Date;
  /** The category tile + the keyset, both of which must sit in WHERE (never on the alias). */
  filter?: SQL;
  limit: number;
}

/**
 * THE ONE ROW-SHAPED READ. `listPage` and `findByMeetingId` differ ONLY in their `bound`,
 * `filter` and `limit` — so they share this body rather than maintaining two projections that
 * would drift the moment a fact is added.
 */
async function selectRows(input: RowQueryInput): Promise<CaptureHealthMeetingRow[]> {
  const rec = recordingAggregate(input.bound, input.withheldBefore);
  const tx = recapAggregate(input.bound);
  const eng = engagementContextAggregate(input.bound);
  const rank = healthRankSql(rec, tx);

  const rows = await db
    .select({
      meetingId: meetings.id,
      scheduledStart: meetings.scheduledStart,
      scheduledEnd: meetings.scheduledEnd,
      startedAt: meetings.startedAt,
      endedAt: meetings.endedAt,
      meetingStatus: meetings.status,
      healthRank: rank.as('health_rank'),
      segmentCount: rec.segmentCount,
      anyFailed: rec.anyFailed,
      anySourceReady: rec.anySourceReady,
      anyIngesting: rec.anyIngesting,
      anyCapturing: rec.anyCapturing,
      anyReady: rec.anyReady,
      anyRedrivableFailure: rec.anyRedrivableFailure,
      txAnyFailure: rec.txAnyFailure,
      txAnySubmitted: rec.txAnySubmitted,
      txAnyOpen: rec.txAnyOpen,
      txAnyWithheld: rec.txAnyWithheld,
      txAnyFinished: rec.txAnyFinished,
      transcriptCount: sql<number>`coalesce(${tx.transcriptCount}, 0)`,
      anyRecapFailed: sql<boolean>`coalesce(${tx.anyRecapFailed}, false)`,
      anyRecapPartial: sql<boolean>`coalesce(${tx.anyRecapPartial}, false)`,
      anyRecapProcessing: sql<boolean>`coalesce(${tx.anyRecapProcessing}, false)`,
      anyRecapReady: sql<boolean>`coalesce(${tx.anyRecapReady}, false)`,
      hasEngagementContext: sql<boolean>`coalesce(${eng.hasEngagementContext}, false)`,
    })
    .from(meetings)
    // ⚠ INNER — this is what makes the population "every RECORDED consultation". A meeting
    // that never started recording is not a capture-health row at all, it is a meeting.
    .innerJoin(rec, eq(rec.meetingId, meetings.id))
    .leftJoin(tx, eq(tx.meetingId, meetings.id))
    .leftJoin(eng, eq(eng.meetingId, meetings.id))
    .where(and(input.bound, input.filter))
    .orderBy(asc(rank), desc(meetings.scheduledStart), desc(meetings.id))
    .limit(input.limit);

  return rows.map((row) => ({
    meetingId: row.meetingId,
    scheduledStart: row.scheduledStart,
    scheduledEnd: row.scheduledEnd,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    meetingStatus: row.meetingStatus,
    healthRank: row.healthRank,
    facts: {
      recording: {
        segmentCount: row.segmentCount,
        anyFailed: row.anyFailed,
        anySourceReady: row.anySourceReady,
        anyIngesting: row.anyIngesting,
        anyCapturing: row.anyCapturing,
        anyReady: row.anyReady,
        anyRedrivableFailure: row.anyRedrivableFailure,
      },
      transcription: {
        anyFailure: row.txAnyFailure,
        anySubmitted: row.txAnySubmitted,
        anyOpen: row.txAnyOpen,
        anyWithheld: row.txAnyWithheld,
        anyFinished: row.txAnyFinished,
      },
      recap: {
        transcriptCount: row.transcriptCount,
        anyFailed: row.anyRecapFailed,
        anyPartial: row.anyRecapPartial,
        anyProcessing: row.anyRecapProcessing,
        anyReady: row.anyRecapReady,
      },
      hasEngagementContext: row.hasEngagementContext,
    },
  }));
}

export const captureHealthRepository = {
  /**
   * THE WINDOWED KEYSET PAGE — the read the page is built on.
   *
   * ⚠⚠ THE ORDERING (D4: "state the chosen ordering explicitly"):
   *
   *     ORDER BY health_rank ASC, scheduled_start DESC, id DESC
   *     keyset:  health_rank > $rank
   *           OR (health_rank = $rank AND (scheduled_start < $start
   *               OR (scheduled_start = $start AND id < $id)))
   *
   * · **TOTAL** — `meetings.id` is the primary key, so no two rows tie on the full triple and
   *   no row can be skipped or repeated for want of a tiebreak.
   * · **"ISSUES FIRST" IS THE LEADING KEY**, reproducing the design's
   *   `sort((a,b) => rank[cat(a)] - rank[cat(b)])`, with newest-first inside each rank.
   * · **STABLE WITHIN ONE READ** — `health_rank` is a pure function of the row's own columns
   *   plus the single `withheldBefore` instant, which the caller pins ONCE per request and
   *   carries through every load-more page.
   *
   * ⚠ ACCEPTED RESIDUAL, DOCUMENTED NOT FIXED: a row whose health CHANGES between two pages (a
   * re-drive lands, a sweep resolves) can be skipped or repeated across a load-more. That is
   * inherent to ordering on mutable derived state and is acceptable on a staff lens; the only
   * alternative is a materialised rank column, a schema change this ticket does not budget.
   *
   * ⚠ The category filter is applied in WHERE against the rank EXPRESSION, never against the
   * `health_rank` select alias — Postgres cannot see a select alias from WHERE.
   */
  async listPage(input: {
    window: CaptureHealthWindow;
    category: CaptureHealthCategory | null;
    withheldBefore: Date;
    after?: CaptureHealthCursor;
    limit: number;
  }): Promise<{ rows: CaptureHealthMeetingRow[]; hasMore: boolean }> {
    const bound = windowBound(input.window);
    // ⚠ Rebuilt here (not shared with `selectRows`) because the rank must be the SAME
    // expression over the SAME aggregates the row query uses — the builders are pure, so two
    // calls produce identical SQL.
    const rank = healthRankSql(
      recordingAggregate(bound, input.withheldBefore),
      recapAggregate(bound)
    );

    const after = input.after;
    const filter = and(
      input.category === null ? undefined : eq(rank, CAPTURE_HEALTH_RANK[input.category]),
      after === undefined
        ? undefined
        : or(
            gt(rank, after.healthRank),
            and(eq(rank, after.healthRank), lt(meetings.scheduledStart, after.scheduledStart)),
            and(
              eq(rank, after.healthRank),
              eq(meetings.scheduledStart, after.scheduledStart),
              lt(meetings.id, after.meetingId)
            )
          )
    );

    const rows = await selectRows({
      bound,
      withheldBefore: input.withheldBefore,
      filter,
      limit: input.limit + 1,
    });
    const hasMore = rows.length > input.limit;
    return { rows: hasMore ? rows.slice(0, input.limit) : rows, hasMore };
  },

  /**
   * THE FOUR TILE COUNTS, EXACT (never estimated — a tile that says "about 12" is a tile
   * nobody trusts to be empty; the `adminAlertsRepository.countOpenByKind` argument).
   *
   * ⚠ IT COUNTS THE SAME POPULATION `listPage` PAGES — same window, same INNER join to the
   * recording aggregate, same rank builder — so the four tiles necessarily sum to the
   * unfiltered row count. The `eng` aggregate is NOT joined here because the rank does not read
   * it; adding it would change nothing but the plan.
   */
  async countByCategory(input: {
    window: CaptureHealthWindow;
    withheldBefore: Date;
  }): Promise<Record<CaptureHealthCategory, number>> {
    const bound = windowBound(input.window);
    const rec = recordingAggregate(bound, input.withheldBefore);
    const tx = recapAggregate(bound);
    const rank = healthRankSql(rec, tx);

    const rows = await db
      .select({ healthRank: rank.as('health_rank'), count: countInt })
      .from(meetings)
      .innerJoin(rec, eq(rec.meetingId, meetings.id))
      .leftJoin(tx, eq(tx.meetingId, meetings.id))
      .where(bound)
      .groupBy(rank);

    const counts: Record<CaptureHealthCategory, number> = {
      recording: 0,
      transcription: 0,
      recap: 0,
      healthy: 0,
    };
    for (const row of rows) {
      const category = CATEGORY_BY_RANK.get(row.healthRank);
      // A rank with no category is unreachable (the CASE emits exactly the four), but throwing
      // away a count silently would make the tiles disagree with the list.
      if (category === undefined) {
        throw new Error(`capture-health: unmapped health rank ${row.healthRank}`);
      }
      counts[category] = row.count;
    }
    return counts;
  },

  /**
   * ONE meeting, for the `?row=` deep link from the pending-actions queue.
   *
   * ⚠⚠ DELIBERATELY NOT WINDOW-BOUNDED. The queue links a meeting that may be months old or
   * outside the active tile; a deep link that silently resolves to nothing because of the
   * viewer's date filter is the bug this method exists to prevent. It still requires a LIVE
   * meeting with at least one LIVE recording segment — a link to something that was never
   * recorded has no row to show, and the page says so.
   */
  async findByMeetingId(input: {
    meetingId: string;
    withheldBefore: Date;
  }): Promise<CaptureHealthMeetingRow | undefined> {
    const [row] = await selectRows({
      bound: meetingBound(input.meetingId),
      withheldBefore: input.withheldBefore,
      limit: 1,
    });
    return row;
  },

  /**
   * THE PER-ROW DETAIL, for at most one page of meetings (≤25 ids) plus the pinned row.
   *
   * Four keyed reads, all bounded by the id list — never an N-query fan-out per row.
   *
   * ⚠ AN EMPTY LIST SHORT-CIRCUITS. `inArray` with an empty list is an error in some drivers
   * and a full scan in others, and neither is what a caller with no rows meant (the
   * `transcriptsRepository.findByMeetingIds` idiom).
   */
  async loadDetails(meetingIds: readonly string[]): Promise<CaptureHealthDetails> {
    const empty: CaptureHealthDetails = {
      recordings: new Map(),
      recap: new Map(),
      recapFailed: new Map(),
      expert: new Map(),
      party: new Map(),
    };
    if (meetingIds.length === 0) return empty;
    const ids = [...meetingIds];

    // D4's four self-joins onto `companies` / `project_requests` need distinct aliases, so
    // they are declared before the statement rather than inline.
    const engCo = alias(companies, 'eng_co');
    const reqCo = alias(companies, 'req_co');
    const relReq = alias(projectRequests, 'rel_req');
    const relCo = alias(companies, 'rel_co');

    const [recordingRows, recapRows, expertRows, partyRows] = await Promise.all([
      // D1 — every live segment, OLDEST FIRST (the order the page numbers them in).
      db
        .select({
          id: meetingRecordings.id,
          meetingId: meetingRecordings.meetingId,
          status: meetingRecordings.status,
          failedStage: meetingRecordings.failedStage,
          failureReason: meetingRecordings.failureReason,
          dailyRecordingId: meetingRecordings.dailyRecordingId,
          muxAssetId: meetingRecordings.muxAssetId,
          sourceDeletedAt: meetingRecordings.sourceDeletedAt,
          transcriptJobId: meetingRecordings.transcriptJobId,
          transcriptJobSubmittedAt: meetingRecordings.transcriptJobSubmittedAt,
          transcriptJobFinishedAt: meetingRecordings.transcriptJobFinishedAt,
          transcriptJobFailureReason: meetingRecordings.transcriptJobFailureReason,
          createdAt: meetingRecordings.createdAt,
          durationSeconds: meetingRecordings.durationSeconds,
        })
        .from(meetingRecordings)
        .where(and(inArray(meetingRecordings.meetingId, ids), isNull(meetingRecordings.deletedAt)))
        .orderBy(asc(meetingRecordings.createdAt), asc(meetingRecordings.id)),

      // D2 — NEWEST live transcript per meeting, folded first-wins in TS (the
      // `findByMeetingIds` idiom). ⚠ NEVER `canonical`, NEVER `extracted_action_items`.
      db
        .select({
          id: transcripts.id,
          meetingId: transcripts.meetingId,
          status: transcripts.status,
          failedStage: transcripts.failedStage,
          failureReason: transcripts.failureReason,
          recapReadyPublishedAt: transcripts.recapReadyPublishedAt,
          actionItemsExtractedAt: transcripts.actionItemsExtractedAt,
          createdAt: transcripts.createdAt,
        })
        .from(transcripts)
        .where(and(inArray(transcripts.meetingId, ids), isNull(transcripts.deletedAt)))
        .orderBy(desc(transcripts.createdAt), desc(transcripts.id)),

      // D3 — THE EXPERT, off the shipped `consultations` projection. `consultations_meeting_uq`
      // makes this at most one live row per meeting. ⚠ `expert_profiles` and `agencies` carry
      // NO `deleted_at` (unlike their member tables), so neither takes a soft-delete filter;
      // `users` does, and its filter sits in the JOIN CONDITION so a soft-deleted person leaves
      // the row with a null name instead of dropping the consultation entirely
      // (`reference_softdelete_join_filter_where_vs_join`).
      db
        .select({
          meetingId: consultations.meetingId,
          expertProfileId: consultations.expertProfileId,
          firstName: users.firstName,
          lastName: users.lastName,
          agencyName: agencies.name,
        })
        .from(consultations)
        .innerJoin(expertProfiles, eq(expertProfiles.id, consultations.expertProfileId))
        .leftJoin(users, and(eq(users.id, expertProfiles.userId), isNull(users.deletedAt)))
        .leftJoin(agencies, eq(agencies.id, expertProfiles.agencyId))
        .where(and(inArray(consultations.meetingId, ids), isNull(consultations.deletedAt))),

      // D4 — THE CLIENT COMPANY + THE CONTEXT LABEL, in ONE statement over the polymorphic
      // seam's three id-bearing arms. ⚠ `meeting_contexts.context_id` has NO foreign key, so
      // every arm is a LEFT JOIN whose miss is a legitimate answer (the wrong-typed arms MUST
      // miss — only one of the three can match a given label) and never an error.
      // ⚠ `companies` HAS NO `deleted_at` (memory `reference_companies_table_no_deleted_at`),
      // so it takes no filter; every other arm filters in its JOIN condition.
      db
        .select({
          meetingId: meetingContexts.meetingId,
          contextType: meetingContexts.contextType,
          createdAt: meetingContexts.createdAt,
          contextRowId: meetingContexts.id,
          companyName: sql<string | null>`coalesce(${engCo.name}, ${reqCo.name}, ${relCo.name})`.as(
            'company_name'
          ),
        })
        .from(meetingContexts)
        // `case` / `project_kickoff` / `package_session` / `retainer_checkin` → engagements.id
        .leftJoin(
          engagements,
          and(eq(engagements.id, meetingContexts.contextId), isNull(engagements.deletedAt))
        )
        .leftJoin(engCo, eq(engCo.id, engagements.companyId))
        // `project_discovery` → project_requests.id
        .leftJoin(
          projectRequests,
          and(eq(projectRequests.id, meetingContexts.contextId), isNull(projectRequests.deletedAt))
        )
        .leftJoin(reqCo, eq(reqCo.id, projectRequests.companyId))
        // `request_interaction` → request_expert_relationships.id → project_requests.id
        .leftJoin(
          requestExpertRelationships,
          and(
            eq(requestExpertRelationships.id, meetingContexts.contextId),
            isNull(requestExpertRelationships.deletedAt)
          )
        )
        .leftJoin(
          relReq,
          and(eq(relReq.id, requestExpertRelationships.projectRequestId), isNull(relReq.deletedAt))
        )
        .leftJoin(relCo, eq(relCo.id, relReq.companyId))
        .where(and(inArray(meetingContexts.meetingId, ids), isNull(meetingContexts.deletedAt)))
        .orderBy(asc(meetingContexts.createdAt), asc(meetingContexts.id)),
    ]);

    const recordings = new Map<string, CaptureHealthRecordingDetail[]>();
    for (const row of recordingRows) {
      const bucket = recordings.get(row.meetingId) ?? [];
      bucket.push({
        ...row,
        failureReason: sanitizeStoredVendorText(row.failureReason),
        transcriptJobFailureReason: sanitizeStoredVendorText(row.transcriptJobFailureReason),
      });
      recordings.set(row.meetingId, bucket);
    }

    // First row wins — the ORDER BY is newest-first, reproducing `findByMeetingId`'s `limit(1)`
    // exactly rather than approximating it. The second map re-walks the SAME rows under the
    // re-drivable predicate (see {@link CaptureHealthDetails.recapFailed}) — no second query.
    // ⚠ `failure_reason` IS SANITISED HERE, like both `meeting_recordings` reason columns: it
    // is vendor text (an LLM/provider error string), and this module's contract is that no
    // unsanitised vendor text crosses into `apps/web`. The view drops the field today; that is
    // not a reason for the projection to hand it over raw.
    const recap = new Map<string, CaptureHealthRecapDetail>();
    const recapFailed = new Map<string, CaptureHealthRecapDetail>();
    for (const raw of recapRows) {
      const row = { ...raw, failureReason: sanitizeStoredVendorText(raw.failureReason) };
      if (!recap.has(row.meetingId)) recap.set(row.meetingId, row);
      if (row.status === 'failed' && row.failedStage !== null && !recapFailed.has(row.meetingId)) {
        recapFailed.set(row.meetingId, row);
      }
    }

    const expert = new Map<string, CaptureHealthExpertDetail>();
    for (const row of expertRows) {
      expert.set(row.meetingId, row);
    }

    // ONE precedence pick per meeting: lowest index in CONTEXT_LABEL_PRECEDENCE wins, ties
    // broken by the query's `created_at ASC, id ASC` (so the first row seen wins a tie).
    const party = new Map<string, CaptureHealthPartyDetail>();
    for (const row of partyRows) {
      const incoming = contextPrecedenceOf(row.contextType);
      const current = party.get(row.meetingId);
      const currentRank =
        current === undefined ? Number.MAX_SAFE_INTEGER : contextPrecedenceOf(current.contextType);
      if (incoming < currentRank) {
        party.set(row.meetingId, {
          meetingId: row.meetingId,
          contextType: row.contextType,
          companyName: row.companyName,
        });
      }
    }

    return { recordings, recap, recapFailed, expert, party };
  },

  /**
   * TRUE-ZERO vs WINDOWED-ZERO — the empty state's whole question.
   *
   * An empty page means one of two very different things: nothing has EVER been recorded
   * ("recording starts when the first Balo Video consultation goes in progress"), or nothing
   * matched THIS window/tile ("Nothing in this window"). Guessing wrong tells a staff member
   * the platform is broken when it is merely quiet. `limit(1)`, so it stops at the first live
   * segment rather than counting.
   */
  async hasAnyRecording(): Promise<boolean> {
    const [row] = await db
      .select({ id: meetingRecordings.id })
      .from(meetingRecordings)
      .where(isNull(meetingRecordings.deletedAt))
      .limit(1);
    return row !== undefined;
  },
};
