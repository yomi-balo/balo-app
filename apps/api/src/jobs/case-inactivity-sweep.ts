import { Worker, type Job } from 'bullmq';
import {
  agenciesRepository,
  CaseAlreadyClosedError,
  caseEngagementsRepository,
  companiesRepository,
  conversationsRepository,
  expertsRepository,
  meetingContextsRepository,
  usersRepository,
  type CaseEngagementRow,
  type ConsultationTimestamps,
} from '@balo/db';
import {
  buildCaseClosedPayload,
  CASE_INACTIVITY_DAYS,
  isCaseInactive,
  summariseCaseCloseAnchors,
  type CaseInactivityInput,
} from '@balo/shared/engagements';
import { createLogger } from '@balo/shared/logging';
import { trackServer, RECAP_SERVER_EVENTS } from '@balo/analytics/server';
import { createRedisConnection } from '../lib/redis.js';
import { getQueue } from '../lib/queue.js';
import { notificationEvents } from '../notifications/publisher.js';
import { MEETING_TOKEN_TTL_AFTER_END_MS } from '../services/meetings/meeting-liveness.js';

/**
 * BAL-572 — the case-inactivity sweep: a single repeatable BullMQ job that, each tick, closes
 * every OPEN case whose 30-day inactivity clock has run out, with `close_reason: 'auto_inactive'`
 * and `closed_by_user_id: NULL` (ADR-1030's system-actor exemption — there is no auth surface
 * here, the sweep acts as the system).
 *
 * THE FIRST PRODUCTION CALLER of `@balo/shared/engagements`'s `isCaseInactive` — see that
 * module's own docblock for the rule (no upcoming consultation AND the anchor is ≥30 days old,
 * where the anchor is the LATEST of the case's creation, its last COMPLETED consultation, its
 * last booking, reschedule or cancellation, and its last chat activity — a message or file from
 * either party, in the case chat or uploaded during a case call).
 *
 * TICK: `caseEngagementsRepository.listOpenCreatedBefore(now − 30d)` (oldest first) →
 * `partition` (the seam (consultations + scheduling) + the chat read (messages, files, in-call
 * uploads) → `isCaseInactive` → the live-meeting exclusion) → the eligible set, capped at
 * `MAX_CASE_CLOSES_PER_TICK` oldest-first → per case: RE-CHECK (`partition`, one id) →
 * `close()` → `trackServer` → the post-commit notice.
 *
 * ⚠⚠ THE LIVE-MEETING EXCLUSION'S FLOOR. A meeting holds its case open while it is STILL
 * JOINABLE: `status NOT IN MEETING_CLOSED_TO_JOIN` AND `scheduled_end > now − TTL`, exactly
 * `assertMeetingJoinable`'s window. `TTL` is `MEETING_TOKEN_TTL_AFTER_END_MS`
 * (`services/meetings/meeting-liveness.ts`), IMPORTED, never re-declared — mint and this floor
 * must agree forever, or a case could close while the api would still admit a join to it. The
 * TTL must stay `>= LIFECYCLE_LOOKBACK_MS` (`meeting-lifecycle-sweep.ts`) so every meeting that
 * sweep still manages is covered; the test pins the inequality.
 *
 * ⚠⚠ CHECK-THEN-ACT, NOT AN IN-TRANSACTION RE-EVALUATION. The anchors and the exclusion are
 * re-read for each case just before `close()`, OUTSIDE its transaction, reusing `partition` with
 * a single-element array. An in-transaction re-read would gain nothing (the booking path takes
 * no lock `close()` would serialise against) and would push `isCaseInactive` policy into
 * `@balo/db`. ACCEPTED RESIDUAL, IN WRITING: a booking or join, or a message, file or scheduling
 * change, that commits between the re-read and `close()`'s commit — milliseconds on an hourly
 * tick. If it happens, the case closes with that activity on it; a booked meeting is refused by
 * `assertMeetingJoinable` (`engagement_not_active`), and a new case recovers it. In that window
 * the notice's rule sentence ("no consultations, bookings or messages for 30 days") may be false
 * for that one case — accepted on the same terms (milliseconds on an hourly tick, and a new case
 * recovers it). This is NOT an in-transaction re-evaluation and never should be.
 *
 * ⚠ A MAP MISS IN EITHER READ IS SKIPPED AND WARNED, NEVER DEFAULTED. Both
 * `consultationTimestampsForEngagements` and `latestChatActivityAtForEngagements` return an
 * entry for every requested id; an id either Map lacks is a BUG, not a gap. Constructing
 * all-null seam anchors — `lastCompletedConsultationAt`, `nextScheduledConsultationAt` and
 * `lastSchedulingActivityAt`, which has no Map of its own and rides the seam's entry — or a
 * `null` `lastChatActivityAt` for it would collapse the rule toward "created ≥ 30 days ago" and
 * could auto-close a case with a consultation yesterday, a booking tomorrow or a message this
 * morning. An all-null entry or a `null` chat value a read ACTUALLY RETURNS is legitimate (a case
 * with no activity anchors on its creation). The chat check is `=== undefined` — never `?? null`,
 * which is the default this forbids, and never a truthiness check, which would skip every
 * never-messaged case forever.
 *
 * ⚠ THE CLIENT `recipientId`. `companiesRepository.findOwnerUserIdByCompanyId`, the
 * non-throwing id-only read `auto-accept-sweep.ts` and `review-nudge-sweep.ts` already use. An
 * owner-miss (retainer / no live owner) publishes with `recipientId` ABSENT — the client rule
 * skips on its existing condition, the expert arm still delivers, and this logs a `warn`. It is
 * NOT a failure.
 *
 * ⚠ NO LIMIT ON `listOpenCreatedBefore`. That superset is oldest-first and includes
 * long-running ACTIVE cases; a LIMIT there would let those fill the window forever and starve
 * the inactive ones behind them. The batched seam, chat and exclusion reads chunk at
 * `CANDIDATE_CHUNK_SIZE`; closes per tick are capped at `MAX_CASE_CLOSES_PER_TICK`
 * (oldest first), and a `warn` fires when the cap fills — no silent caps. `CASE_INACTIVITY_SWEEP_CRON`
 * is offset to `:30` so it never coincides with the three `:00` sweeps; the cutoff is absolute,
 * so cadence only affects latency.
 *
 * ⚠ NEVER IMPORTS `../lib/review-token.js`. `auto_inactive` mints NO review token — the +24h /
 * +7d nudge (`review-nudge-sweep.ts`) mints its own, per reviewer, later.
 *
 * ⚠ ONCE-NESS COMES FROM `close()` BEING TERMINAL, NOT FROM BULLMQ DEDUP. There are no custom
 * job ids here — `notificationEvents.publish`'s `buildJobId` is the only one in this file, and
 * it dedups the NOTICE, not the close.
 */
export const CASE_INACTIVITY_SWEEP_QUEUE = 'case-inactivity-sweep';

/** Hourly, offset off the `:00` sweeps. The cutoff is absolute, so cadence only affects latency. */
export const CASE_INACTIVITY_SWEEP_CRON = '30 * * * *';

/**
 * Far under postgres-js's 65,535 bind limit. Applies to the seam, the chat read and the
 * exclusion read.
 */
export const CANDIDATE_CHUNK_SIZE = 500;

/**
 * Bounds the first-deploy burst (two emails plus two in-app notices per close). The remainder
 * closes on later ticks — see the module docblock's "NO LIMIT ON `listOpenCreatedBefore`"
 * paragraph.
 */
export const MAX_CASE_CLOSES_PER_TICK = 100;

/** The auto path has no acting user — a stable system distinct-id keeps PostHog from minting anon ids. */
export const SYSTEM_DISTINCT_ID = 'system:case-inactivity';

const DAY_MS = 24 * 60 * 60 * 1000;

const logger = createLogger('case-inactivity-sweep');

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorStack(error: unknown): string | undefined {
  return error instanceof Error ? error.stack : undefined;
}

/** Split `items` into chunks of at most `size`, preserving order. */
function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

/**
 * One batched read, chunked at `CANDIDATE_CHUNK_SIZE` and merged into one Map. Both anchor
 * reads (the seam and the chat read) go through it. An empty input issues no call at all:
 * chunking an empty array yields zero chunks.
 */
async function batchedRead<V>(
  ids: readonly string[],
  read: (idChunk: string[]) => Promise<Map<string, V>>
): Promise<Map<string, V>> {
  const result = new Map<string, V>();
  for (const idChunk of chunk(ids, CANDIDATE_CHUNK_SIZE)) {
    for (const [id, value] of await read(idChunk)) {
      result.set(id, value);
    }
  }
  return result;
}

/** The two anchors whose sole holds are counted. */
type CountedAnchor = 'lastChatActivityAt' | 'lastSchedulingActivityAt';

/**
 * True when `input` — already ACTIVE — would be inactive with `key` nulled: that anchor ALONE
 * holds the case open. A case held by both counted anchors at once is held solely by neither.
 */
function heldSolelyBy(input: CaseInactivityInput, key: CountedAnchor): boolean {
  return isCaseInactive({ ...input, [key]: null });
}

/**
 * `isCaseInactive`'s input for one candidate, every anchor taken from its read's Map: creation
 * from the row; the completed, upcoming and scheduling anchors from the SAME seam entry; chat
 * from the chat read. A miss in EITHER Map is warned and returns `undefined` (skip) — see the
 * module docblock's Map-miss paragraph.
 */
function anchorInputFor(
  row: CaseEngagementRow,
  timestamps: ReadonlyMap<string, ConsultationTimestamps>,
  chat: ReadonlyMap<string, Date | null>,
  now: Date
): CaseInactivityInput | undefined {
  const entry = timestamps.get(row.id);
  if (entry === undefined) {
    logger.warn(
      { engagementId: row.id },
      'Case inactivity sweep: seam Map miss — candidate skipped, anchors never defaulted'
    );
    return undefined;
  }
  const lastChatActivityAt = chat.get(row.id);
  if (lastChatActivityAt === undefined) {
    logger.warn(
      { engagementId: row.id },
      'Case inactivity sweep: chat-activity Map miss — candidate skipped, lastChatActivityAt never defaulted'
    );
    return undefined;
  }
  return {
    now,
    caseCreatedAt: row.createdAt,
    lastCompletedConsultationAt: entry.lastCompletedConsultationAt,
    nextScheduledConsultationAt: entry.nextScheduledConsultationAt,
    lastSchedulingActivityAt: entry.lastSchedulingActivityAt,
    lastChatActivityAt,
  };
}

/** `evaluateAnchors`' answer: the rows inactive by anchors, plus the two sole-holder counters. */
interface AnchorEvaluation {
  inactiveRows: CaseEngagementRow[];
  heldByChatActivity: number;
  heldByRecentScheduling: number;
}

/**
 * `isCaseInactive` over every candidate. An ACTIVE case also feeds the two sole-holder counters
 * (`heldSolelyBy`): the ones that would be inactive with only their chat anchor, or only their
 * scheduling anchor, nulled.
 */
function evaluateAnchors(
  rows: readonly CaseEngagementRow[],
  timestamps: ReadonlyMap<string, ConsultationTimestamps>,
  chat: ReadonlyMap<string, Date | null>,
  now: Date
): AnchorEvaluation {
  const inactiveRows: CaseEngagementRow[] = [];
  let heldByChatActivity = 0;
  let heldByRecentScheduling = 0;
  for (const row of rows) {
    const input = anchorInputFor(row, timestamps, chat, now);
    if (input === undefined) {
      continue;
    }
    if (isCaseInactive(input)) {
      inactiveRows.push(row);
      continue;
    }
    if (heldSolelyBy(input, 'lastChatActivityAt')) {
      heldByChatActivity += 1;
    }
    if (heldSolelyBy(input, 'lastSchedulingActivityAt')) {
      heldByRecentScheduling += 1;
    }
  }
  return { inactiveRows, heldByChatActivity, heldByRecentScheduling };
}

/**
 * The live-meeting exclusion: drops every row that still has a JOINABLE `case` meeting (see the
 * module docblock's floor paragraph), batched at `CANDIDATE_CHUNK_SIZE`.
 */
async function excludeLiveMeetings(
  inactiveRows: readonly CaseEngagementRow[],
  now: Date
): Promise<{ eligible: CaseEngagementRow[]; heldByLiveMeeting: number }> {
  const floor = new Date(now.getTime() - MEETING_TOKEN_TTL_AFTER_END_MS);
  const held = new Set<string>();
  for (const idChunk of chunk(
    inactiveRows.map((row) => row.id),
    CANDIDATE_CHUNK_SIZE
  )) {
    const chunkHeld = await meetingContextsRepository.engagementIdsWithLiveCaseMeeting(
      idChunk,
      floor
    );
    for (const id of chunkHeld) {
      held.add(id);
    }
  }

  const eligible: CaseEngagementRow[] = [];
  let heldByLiveMeeting = 0;
  for (const row of inactiveRows) {
    if (held.has(row.id)) {
      heldByLiveMeeting += 1;
    } else {
      eligible.push(row);
    }
  }

  return { eligible, heldByLiveMeeting };
}

/** `partition`'s answer: the eligible set, plus the hold counters. */
interface PartitionResult {
  /**
   * Inactive by the seam (consultations + scheduling) + the chat read (messages, files, in-call
   * uploads) + `isCaseInactive`, AND not held by a live meeting.
   */
  eligible: CaseEngagementRow[];
  /**
   * Inactive by the seam (consultations + scheduling) + the chat read (messages, files, in-call
   * uploads) + `isCaseInactive`, BEFORE the live-meeting exclusion.
   */
  foundInactive: number;
  /**
   * Inactive by anchors, but held open because a `case` meeting is still joinable. A running or
   * joinable call's booking or reschedule is itself a scheduling anchor, so this fires only on a
   * joinable call whose latest booking or reschedule is ≥30 days old — a far-horizon booking, or
   * a stranded meeting. It reads ~0 in production, and ~0 is NOT evidence that the exclusion is
   * unused: it is `listOpenCreatedBefore`'s obligation (a), and the only guard against closing a
   * case mid-call on such a meeting.
   */
  heldByLiveMeeting: number;
  /**
   * Active, and would be inactive with ONLY `lastChatActivityAt` nulled — a message or file (case
   * chat or in-call upload) is the sole holder. A case held by both chat and scheduling counts in
   * neither counter.
   */
  heldByChatActivity: number;
  /**
   * Active, and would be inactive with ONLY `lastSchedulingActivityAt` nulled — a recent booking,
   * reschedule or cancellation is the sole holder. That includes a call running now: started and
   * not ended, it is neither upcoming nor completed, so its booking is what holds the case.
   */
  heldByRecentScheduling: number;
}

/**
 * Both anchor reads → `isCaseInactive` → the live-meeting exclusion — ONE function, shared by the
 * batch pass and the per-case re-check (same function, one id), so the re-check re-reads the
 * seam AND the chat read. NEVER constructs anchors for a Map miss in either read; such a row is
 * skipped and warned.
 *
 * The exclusion read only ever sees the subset already flagged inactive by anchors — a case the
 * anchors already hold open has no need to ask whether a meeting also holds it open.
 */
async function partition(rows: readonly CaseEngagementRow[], now: Date): Promise<PartitionResult> {
  if (rows.length === 0) {
    return {
      eligible: [],
      foundInactive: 0,
      heldByLiveMeeting: 0,
      heldByChatActivity: 0,
      heldByRecentScheduling: 0,
    };
  }

  const ids = rows.map((row) => row.id);
  const timestamps = await batchedRead(ids, (idChunk) =>
    meetingContextsRepository.consultationTimestampsForEngagements(idChunk, now)
  );
  const chat = await batchedRead(ids, (idChunk) =>
    conversationsRepository.latestChatActivityAtForEngagements(idChunk)
  );

  const { inactiveRows, heldByChatActivity, heldByRecentScheduling } = evaluateAnchors(
    rows,
    timestamps,
    chat,
    now
  );

  if (inactiveRows.length === 0) {
    return {
      eligible: [],
      foundInactive: 0,
      heldByLiveMeeting: 0,
      heldByChatActivity,
      heldByRecentScheduling,
    };
  }

  const { eligible, heldByLiveMeeting } = await excludeLiveMeetings(inactiveRows, now);

  return {
    eligible,
    foundInactive: inactiveRows.length,
    heldByLiveMeeting,
    heldByChatActivity,
    heldByRecentScheduling,
  };
}

/**
 * Post-commit: the client owner + the delivering expert's display fields, the sibling read →
 * `summariseCaseCloseAnchors`, and `buildCaseClosedPayload({ closeReason: 'auto_inactive',
 * reviewToken: undefined })` → ONE publish. Mirrors web's `publishCaseClosed`
 * (`apps/web/src/lib/cases/close-case-effects.ts`) read for read, sharing the same pure
 * assembly (`@balo/shared/engagements`) so the two publishers can never drift on copy.
 *
 * ⚠ OWNER-MISS IS NOT A FAILURE. `recipientId` is simply absent on the payload; the client
 * notification rule skips on its own condition and the expert arm is unaffected. A `warn` is
 * logged so a retainer/no-owner company is visible without being treated as broken.
 *
 * Throws on any read/publish failure — the caller counts that as `noticeFailed` and the close
 * itself stays intact (it already committed).
 */
async function sendNotice(closedRow: CaseEngagementRow, now: Date): Promise<void> {
  const recipientId = await companiesRepository.findOwnerUserIdByCompanyId(closedRow.companyId);
  if (recipientId === undefined) {
    logger.warn(
      { engagementId: closedRow.id, companyId: closedRow.companyId },
      'Case inactivity sweep: no live owner for company — client notice skipped, expert notice unaffected'
    );
  }

  const [company, profile] = await Promise.all([
    companiesRepository.findNameById(closedRow.companyId),
    expertsRepository.findDisplayProfileById(closedRow.expertProfileId),
  ]);
  const [expertUser, agency] = await Promise.all([
    profile === undefined
      ? Promise.resolve(undefined)
      : usersRepository.findDisplayById(profile.userId),
    profile?.agencyId == null
      ? Promise.resolve(undefined)
      : agenciesRepository.getSummaryById(profile.agencyId),
  ]);

  const siblings = await meetingContextsRepository.listMeetingsForContext('case', closedRow.id);
  const anchors = summariseCaseCloseAnchors(siblings);

  const payload = buildCaseClosedPayload({
    engagementId: closedRow.id,
    meetingId: anchors.anchorMeetingId,
    recipientId,
    expertProfileId: closedRow.expertProfileId,
    companyName: company?.name,
    expertProfileType: profile?.type,
    agencyName: agency?.name,
    expertFirstName: expertUser?.firstName,
    expertLastName: expertUser?.lastName,
    caseTitle: closedRow.title,
    closedAt: closedRow.closedAt ?? now,
    closeReason: 'auto_inactive',
    consultationCount: anchors.heldCount,
    reviewToken: undefined,
  });

  await notificationEvents.publish('engagement.case_closed', payload);
}

type CloseOutcome = 'closed' | 'alreadyClosed' | 'failed' | 'skippedOnRecheck';

/**
 * Close ONE case: re-check → `close()` → `trackServer` → the post-commit notice. Every failure
 * mode is isolated here so one bad row never aborts the tick.
 *
 * `CaseAlreadyClosedError` is a benign race (another tick, or a client closing it between the
 * batch read and this call) and counts as `alreadyClosed` — no publish, no track. Any OTHER
 * close error, and any error thrown while re-reading this one row's anchors (the seam and the
 * chat read) or its live-meeting exclusion, counts as `failed`, is logged at `error`, and the
 * loop continues. A notice failure never un-counts the close: `outcome` stays `'closed'` and
 * `noticeFailed` is reported separately. The re-check's own hold counters are ignored; only the
 * batch pass reports them.
 */
async function closeOne(
  row: CaseEngagementRow,
  now: Date,
  log: (message: string) => void
): Promise<{ outcome: CloseOutcome; noticeFailed: boolean }> {
  let recheck: PartitionResult;
  try {
    recheck = await partition([row], now);
  } catch (error) {
    logger.error(
      { engagementId: row.id, error: errorMessage(error), stack: errorStack(error) },
      'Case inactivity sweep: re-check failed'
    );
    log(`case inactivity sweep: re-check failed for engagement ${row.id}: ${errorMessage(error)}`);
    return { outcome: 'failed', noticeFailed: false };
  }
  if (recheck.eligible.length === 0) {
    return { outcome: 'skippedOnRecheck', noticeFailed: false };
  }

  let closedRow: CaseEngagementRow;
  try {
    closedRow = await caseEngagementsRepository.close({
      engagementId: row.id,
      reason: 'auto_inactive',
    });
  } catch (error) {
    if (error instanceof CaseAlreadyClosedError) {
      return { outcome: 'alreadyClosed', noticeFailed: false };
    }
    logger.error(
      { engagementId: row.id, error: errorMessage(error), stack: errorStack(error) },
      'Case inactivity sweep: close failed'
    );
    log(`case inactivity sweep: close failed for engagement ${row.id}: ${errorMessage(error)}`);
    return { outcome: 'failed', noticeFailed: false };
  }

  logger.info({ engagementId: row.id }, 'Case auto-closed for inactivity');

  trackServer(RECAP_SERVER_EVENTS.CASE_RESOLVED, {
    source: 'sweep',
    engagement_id: row.id,
    distinct_id: SYSTEM_DISTINCT_ID,
  });

  try {
    await sendNotice(closedRow, now);
  } catch (error) {
    logger.error(
      { engagementId: row.id, error: errorMessage(error), stack: errorStack(error) },
      'Case inactivity sweep: post-commit notice failed'
    );
    log(`case inactivity sweep: notice failed for engagement ${row.id}: ${errorMessage(error)}`);
    return { outcome: 'closed', noticeFailed: true };
  }

  return { outcome: 'closed', noticeFailed: false };
}

/** Per-run counters, mirrored to `job.log` and the structured summary log. */
export interface CaseInactivitySweepResult {
  /** Rows from `listOpenCreatedBefore` — the SQL-expressible superset, activity-blind. */
  candidates: number;
  /**
   * Inactive by the seam (consultations + scheduling) + the chat read (messages, files, in-call
   * uploads) + `isCaseInactive`, BEFORE the live-meeting exclusion.
   */
  foundInactive: number;
  /**
   * Inactive by anchors but held open by a still-joinable `case` meeting. Because a call's
   * booking or reschedule is itself a scheduling anchor, this fires only on a joinable call whose
   * latest booking or reschedule is ≥30 days old — a far-horizon booking, or a stranded meeting —
   * so it reads ~0 in production. ~0 is NOT evidence that the exclusion is unused; it is the only
   * guard against closing such a case mid-call.
   */
  heldByLiveMeeting: number;
  /**
   * Active only because of a message or file (case chat or in-call upload) — inactive with that
   * one anchor nulled. SOLE holders: a case also held by scheduling counts in neither counter.
   */
  heldByChatActivity: number;
  /**
   * Active only because of a recent booking, reschedule or cancellation — inactive with that one
   * anchor nulled. Includes a call running now (neither upcoming nor completed, so its booking is
   * the sole holder). SOLE holders: a case also held by chat counts in neither counter.
   */
  heldByRecentScheduling: number;
  /** Eligible in the batch pass, but no longer eligible at the per-case re-check. */
  skippedOnRecheck: number;
  /** Actually closed this tick (regardless of whether its notice also succeeded). */
  closed: number;
  /** `close()` found the case already closed — a benign race, no publish, no track. */
  alreadyClosed: number;
  /**
   * `close()` threw something other than `CaseAlreadyClosedError`, or the per-case re-check
   * (reading the anchors and the live-meeting exclusion for this one row) threw.
   */
  failed: number;
  /** Closed, but the post-commit notice (reads + publish) threw. */
  noticeFailed: number;
  /** Eligible cases past `MAX_CASE_CLOSES_PER_TICK` — left for a later tick. */
  deferred: number;
}

/**
 * The batch pass: the candidate superset (`listOpenCreatedBefore`), then `partition` over all of
 * it. A throw from any of its reads (the superset, the seam, the chat read or the exclusion)
 * aborts the tick before anything closes, so it fails closed. It is logged here at `error`, under
 * this module's context and mirrored to `job.log`, then RETHROWN so BullMQ still records the job
 * as failed. The worker has no `failed` listener, and a tick that throws never reaches the
 * summary log, so without this line a sweep that failed every hour would leave nothing in Axiom.
 */
async function readBatch(
  now: Date,
  log: (message: string) => void
): Promise<PartitionResult & { candidates: number }> {
  try {
    const cutoff = new Date(now.getTime() - CASE_INACTIVITY_DAYS * DAY_MS);
    const rows = await caseEngagementsRepository.listOpenCreatedBefore(cutoff);
    const partitioned = await partition(rows, now);
    return { ...partitioned, candidates: rows.length };
  } catch (error) {
    logger.error(
      { error: errorMessage(error), stack: errorStack(error) },
      'Case inactivity sweep: batch read failed — tick aborted, nothing closed'
    );
    log(
      `case inactivity sweep: batch read failed — tick aborted, nothing closed: ${errorMessage(error)}`
    );
    throw error;
  }
}

/**
 * The sweep body (exported for unit testing without a Redis-backed Worker). See the module
 * docblock for the full tick and the rulings it encodes.
 */
export async function runCaseInactivitySweep(
  now: Date,
  log: (message: string) => void = () => {}
): Promise<CaseInactivitySweepResult> {
  const {
    candidates,
    eligible,
    foundInactive,
    heldByLiveMeeting,
    heldByChatActivity,
    heldByRecentScheduling,
  } = await readBatch(now, log);

  let toProcess = eligible;
  let deferred = 0;
  if (eligible.length > MAX_CASE_CLOSES_PER_TICK) {
    deferred = eligible.length - MAX_CASE_CLOSES_PER_TICK;
    toProcess = eligible.slice(0, MAX_CASE_CLOSES_PER_TICK);
    logger.warn(
      { eligible: eligible.length, cap: MAX_CASE_CLOSES_PER_TICK, deferred },
      'Case inactivity sweep: cap filled — remainder deferred to a later tick'
    );
    log(`case inactivity sweep: cap filled — ${deferred} case(s) deferred to a later tick`);
  }

  let skippedOnRecheck = 0;
  let closed = 0;
  let alreadyClosed = 0;
  let failed = 0;
  let noticeFailed = 0;

  for (const row of toProcess) {
    const outcome = await closeOne(row, now, log);
    switch (outcome.outcome) {
      case 'closed':
        closed += 1;
        break;
      case 'alreadyClosed':
        alreadyClosed += 1;
        break;
      case 'failed':
        failed += 1;
        break;
      case 'skippedOnRecheck':
        skippedOnRecheck += 1;
        break;
    }
    if (outcome.noticeFailed) {
      noticeFailed += 1;
    }
  }

  const result: CaseInactivitySweepResult = {
    candidates,
    foundInactive,
    heldByLiveMeeting,
    heldByChatActivity,
    heldByRecentScheduling,
    skippedOnRecheck,
    closed,
    alreadyClosed,
    failed,
    noticeFailed,
    deferred,
  };

  logger.info(result, 'Case inactivity sweep complete');
  log(
    `case inactivity sweep: ${result.candidates} candidates, ${result.foundInactive} inactive, ` +
      `${result.heldByLiveMeeting} held by live meeting, ${result.heldByChatActivity} held by ` +
      `chat activity, ${result.heldByRecentScheduling} held by recent scheduling, ` +
      `${result.skippedOnRecheck} skipped on ` +
      `recheck, ${result.closed} closed, ${result.alreadyClosed} already closed, ` +
      `${result.failed} failed, ${result.noticeFailed} notice failed, ${result.deferred} deferred`
  );

  return result;
}

/** Start the case-inactivity sweep worker. */
export function startCaseInactivitySweepWorker(): Worker {
  return new Worker(
    CASE_INACTIVITY_SWEEP_QUEUE,
    async (job: Job) => {
      await runCaseInactivitySweep(new Date(), (m) => job.log(m));
    },
    {
      connection: createRedisConnection(),
      concurrency: 1,
    }
  );
}

/** Register the repeatable case-inactivity sweep (hourly, offset to `:30`). */
export async function registerCaseInactivitySweepCron(): Promise<void> {
  const queue = getQueue(CASE_INACTIVITY_SWEEP_QUEUE);
  await queue.add(
    'sweep',
    {},
    {
      repeat: { pattern: CASE_INACTIVITY_SWEEP_CRON },
      removeOnComplete: true,
    }
  );
}
