import { and, eq, inArray, isNull, type SQL } from 'drizzle-orm';
import { db } from '../../client';
import {
  consultations,
  engagements,
  meetingContexts,
  meetings,
  projectRequests,
  requestExpertRelationships,
  type Consultation,
  type ConsultationStatus,
  type Meeting,
  type MeetingContextType,
  type MeetingStatus,
} from '../../schema';
import type { DbExecutor } from './db-executor';

/**
 * THE CONSULTATION PROJECTION (BAL-428 decision, Option C) — the ONE module allowed to
 * write `consultations`.
 *
 * `consultations` is a READ MODEL of the meeting lifecycle: the availability resolver
 * subtracts its `confirmed` rows from an expert's open windows, and nothing else writes it.
 * BAL-418 shipped `meetings` and `consultations` as two independent records of the same
 * booked-slot fact, with a written ruling that whoever built the first booking path had to
 * reconcile them. This module IS that reconciliation.
 *
 * ⚠ CALLED FROM EXACTLY TWO PLACES, ALWAYS INSIDE AN EXISTING TRANSACTION:
 * `meetingsRepository` (`create` / `updateSchedule` / `cancel` / `softDelete`) and
 * `meetingContextsRepository.attach`. Every writer here takes a `DbExecutor` and NEVER
 * opens its own transaction — the projection must commit or roll back WITH the meeting
 * mutation that caused it, or the two tables can disagree at exactly the moment they
 * matter. A second writer anywhere else re-opens the drift this ticket closed; that is why
 * `consultationsRepository.create` was deleted rather than merely deprecated.
 *
 * THE EXPERT IS RESOLVED AT WRITE TIME, never stored on `meetings` (which deliberately has
 * no `expert_profile_id`) and never re-resolved on a later mutation. Resolution walks the
 * `meeting_contexts` polymorphic seam:
 *
 *   case / project_kickoff / package_session / retainer_checkin → `engagements.expert_profile_id`
 *   project_discovery                                            → `project_requests.expert_profile_id`
 *   admin                                                        → IGNORED (no expert exists)
 *   request_interaction                                          → `request_expert_relationships.expert_profile_id`
 *
 * ⚠ THE WALK IS EXHAUSTIVE OVER `meeting_context_type`, AND MUST STAY SO. Every label gets
 * an arm in BOTH `loadContextExperts` and `resolveOneContext`; there is no safe default,
 * because the fall-through arm treats a `context_id` as an `engagements.id`, and handing it
 * some other table's id is a silent misresolution or a misdiagnosed throw. An 8th label
 * must add an arm to both — `packages/db/src/invariants/meeting-context-type-labels.test.ts`
 * names this module in its sweep list for exactly that reason.
 *
 * ⚠ THE TWO HALVES ARE COUPLED THROUGH THE LOOKUP MAPS, AND THAT COUPLING IS THE ONLY
 * MECHANICAL GUARD AGAINST A HALF-ADD (BAL-283). `resolveOneContext` is now a `switch` whose
 * `default` assigns to `never`, so an 8th label with no arm THERE fails
 * `pnpm --filter api typecheck` (this module is inside `apps/api`'s program — `@balo/db`'s
 * exports point at raw `./src/*.ts` and the meetings route value-imports the barrel).
 * `loadContextExperts` is NOT typechecked by anything, so an arm added only to it, or only to
 * `resolveOneContext`, is caught at RUNTIME instead — by every arm answering from a map only
 * `loadContextExperts` can populate:
 *
 *   arm in `resolveOneContext` only → the map is empty → `MeetingContextUnresolvableError`
 *   arm in `loadContextExperts` only → falls through the switch → typecheck error, and at
 *                                      runtime `MeetingContextNotProjectableError`
 *
 * Both shapes are pinned in `consultation-projection.test.ts` (T1/T2). ⚠ The named invariant
 * test does NOT catch this: it imports `meetingContextTypeEnum` and asserts on `enumValues`
 * only — it never opens this module.
 *
 * A booking that cannot name EXACTLY ONE expert throws and the transaction rolls back.
 * Zero non-admin contexts resolves to `null`, which means NO projection row at all — an
 * internal Balo call must not occupy anybody's calendar.
 *
 * ⚠ THIS MODULE RESOLVES NO AUTHORIZATION. `context_id` has no FK and no RLS behind it
 * (see `schema/meeting-contexts.ts`), so a context id from another tenant resolves happily
 * to that tenant's expert. Every caller must already have checked `hasCapability` against
 * the context's owning party before a context id reaches `meetingsRepository`. Nothing here
 * is a substitute for that.
 */

// ── Typed errors ───────────────────────────────────────────────────────

/**
 * A `project_discovery` context whose `project_requests.expert_profile_id` is NULL. By the
 * `project_request_send_to_expert` CHECK, NULL there means `send_to='match'` — the request
 * has not been routed to anybody yet, so there is no calendar to book.
 *
 * Match mode is blocked TWICE, deliberately: by this typed error, and structurally by
 * `consultations.expert_profile_id` being NOT NULL. The typed error exists so the caller
 * gets a branchable reason instead of a raw `23502`.
 */
export class MatchModeDiscoveryNotBookableError extends Error {
  constructor(public readonly projectRequestId: string) {
    super(
      `Project request ${projectRequestId} is in match mode (no expert assigned) and cannot be booked`
    );
    this.name = 'MatchModeDiscoveryNotBookableError';
  }
}

/**
 * The meeting's live contexts name TWO OR MORE different experts, so "whose calendar does
 * this block?" has no answer. Thrown from `create` (rolling back the whole meeting) and
 * from `attach` (rolling back just the attach, so an already-booked meeting cannot be
 * silently repointed at a second expert by widening its context set).
 */
export class MeetingExpertAmbiguousError extends Error {
  constructor(
    public readonly meetingId: string | null,
    public readonly expertProfileIds: readonly string[]
  ) {
    super(
      `Meeting ${meetingId ?? '(unsaved)'} resolves to ${expertProfileIds.length} experts (${expertProfileIds.join(', ')}); a booking must name exactly one`
    );
    this.name = 'MeetingExpertAmbiguousError';
  }
}

/**
 * THE GENERIC DEFENCE FOR A LABEL WITH NO PROJECTION RULE — a `meeting_context_type` value
 * that is REAL but that `resolveOneContext`'s switch does not answer for.
 *
 * ⚠ IT NO LONGER NAMES A PENDING OWNER, AND THAT IS THE POINT (BAL-283). This class was born
 * in BAL-413 as `request_interaction`'s answer, while whether a client↔candidate call should
 * occupy that candidate's calendar was still an unmade product ruling. **That ruling is now
 * made and shipped: it DOES block the slot** (BAL-283 Ruling 1, owner-ratified, recorded as an
 * ADR-1046 amendment), and `request_interaction` resolves through
 * `request_expert_relationships.expert_profile_id` like any other projected label. Every one
 * of the seven labels now has an arm, so nothing in the shipped enum reaches this class.
 *
 * WHAT IT IS FOR NOW: an 8th label. Both guards fire, and they are deliberately different:
 *   · TYPE-LEVEL — `resolveOneContext`'s `default` assigns `context.contextType` to `never`,
 *     so a new label with no arm fails `pnpm --filter api typecheck` at the switch itself.
 *   · RUNTIME — a label can still ARRIVE from a raw DB row that a cast let past the type
 *     (this module reads `meeting_contexts`, which has no FK and no RLS), so the throw stays.
 *
 * WHY IT IS NOT DELETED NOW THAT `request_interaction` PROJECTS. Deleting it would remove
 * `409 context_not_bookable` from `POST /meetings`'s error table and force the fall-through
 * to be `MeetingContextUnresolvableError` — an error whose message ("does not resolve to a
 * live row") would be a LIE about a row that exists and is perfectly live, and which would
 * roll back the whole `meetingsRepository.create` transaction with a misleading diagnosis.
 * That misdiagnosis is exactly what BAL-413 introduced this class to stop; the class outlives
 * the label that prompted it.
 *
 * WHY NOT `ignored`. That is the ONE outcome that is unsafe, for a new label as much as it
 * was for `request_interaction`: it would write a meeting with NO projection row, i.e. a
 * booking blocking nobody's calendar — precisely the double-booking BAL-428 exists to close.
 */
export class MeetingContextNotProjectableError extends Error {
  constructor(
    public readonly contextType: MeetingContextType,
    public readonly contextId: string
  ) {
    super(
      `Meeting context type '${contextType}' (${contextId}) has no consultation projection rule — add an arm to BOTH loadContextExperts and resolveOneContext in _shared/consultation-projection.ts, per ADR-1046`
    );
    this.name = 'MeetingContextNotProjectableError';
  }
}

/**
 * A context id that resolves to NOTHING live — no such engagement, or no such project
 * request, or one that is soft-deleted.
 *
 * ⚠ WHY THIS IS AN ERROR AND NOT A SHRUG. `meeting_contexts.context_id` has no FK (it is
 * polymorphic), so a wrong id does not raise `23503` — it succeeds silently. Treating an
 * unresolvable context as "no expert" would produce a live meeting with NO projection row:
 * a booking that blocks nobody's calendar, which is precisely the double-booking BAL-428
 * exists to close. It must fail loudly at write time instead.
 */
export class MeetingContextUnresolvableError extends Error {
  constructor(
    public readonly contextType: MeetingContextType,
    public readonly contextId: string
  ) {
    super(`Meeting context ${contextType}:${contextId} does not resolve to a live row`);
    this.name = 'MeetingContextUnresolvableError';
  }
}

// ── Resolution ─────────────────────────────────────────────────────────

/** The two fields of a context row this module needs — structurally a `MeetingContext`. */
export interface ProjectionContext {
  contextType: MeetingContextType;
  contextId: string | null;
}

/** Every outcome of walking a meeting's contexts. Only `resolved` is projectable. */
type ExpertResolution =
  | { kind: 'none' }
  | { kind: 'resolved'; expertProfileId: string }
  | { kind: 'match_mode'; projectRequestId: string }
  | { kind: 'ambiguous'; expertProfileIds: string[] }
  | { kind: 'unresolvable'; contextType: MeetingContextType; contextId: string }
  /** A real label with no projection rule — see `MeetingContextNotProjectableError`. */
  | { kind: 'not_projectable'; contextType: MeetingContextType; contextId: string };

interface ContextExpertMaps {
  /** `engagements.id` → `expert_profile_id` (NOT NULL on that table), live rows only. */
  engagementExperts: Map<string, string>;
  /** `project_requests.id` → `expert_profile_id` (NULLABLE = match mode), live rows only. */
  requestExperts: Map<string, string | null>;
  /**
   * `request_expert_relationships.id` → `expert_profile_id`, live rows only (BAL-283).
   *
   * ⚠ `string`, NOT `string | null` — `request_expert_relationships.expert_profile_id` is
   * NOT NULL (`schema/request-origination.ts`), so this label has NO match-mode equivalent
   * and `.get()` is the correct read here, unlike `requestExperts`'s deliberate `.has()`.
   */
  relationshipExperts: Map<string, string>;
}

interface ContextIdBuckets {
  engagementIds: Set<string>;
  requestIds: Set<string>;
  relationshipIds: Set<string>;
}

/** PURE. Sorts every context's id into the one table batch that can resolve it. */
function classifyContextIds(contexts: readonly ProjectionContext[]): ContextIdBuckets {
  const engagementIds = new Set<string>();
  const requestIds = new Set<string>();
  const relationshipIds = new Set<string>();
  for (const context of contexts) {
    // `admin` carries no subject, and the biconditional CHECK makes the two conditions
    // equivalent — both are spelled out so a reader does not have to know that.
    if (context.contextType === 'admin' || context.contextId === null) {
      continue;
    }
    // ⚠ EXPLICIT, and it must stay above the engagement `else`. A `request_interaction`
    // `context_id` is a `request_expert_relationships.id`; querying `engagements` with it
    // is a guaranteed miss that `resolveOneContext` would then have to diagnose as
    // "unresolvable". BAL-283 (Ruling 1) gave this label its OWN table — the id is queued
    // into its own batch below, and `resolveOneContext`'s matching arm reads THIS map.
    if (context.contextType === 'request_interaction') {
      relationshipIds.add(context.contextId);
      continue;
    }
    if (context.contextType === 'project_discovery') {
      requestIds.add(context.contextId);
    } else {
      engagementIds.add(context.contextId);
    }
  }
  return { engagementIds, requestIds, relationshipIds };
}

async function loadEngagementExperts(
  exec: DbExecutor,
  ids: ReadonlySet<string>
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (ids.size === 0) {
    return map;
  }
  const rows = await exec
    .select({ id: engagements.id, expertProfileId: engagements.expertProfileId })
    .from(engagements)
    .where(and(inArray(engagements.id, [...ids]), isNull(engagements.deletedAt)));
  for (const row of rows) {
    map.set(row.id, row.expertProfileId);
  }
  return map;
}

async function loadRequestExperts(
  exec: DbExecutor,
  ids: ReadonlySet<string>
): Promise<Map<string, string | null>> {
  const map = new Map<string, string | null>();
  if (ids.size === 0) {
    return map;
  }
  const rows = await exec
    .select({ id: projectRequests.id, expertProfileId: projectRequests.expertProfileId })
    .from(projectRequests)
    .where(and(inArray(projectRequests.id, [...ids]), isNull(projectRequests.deletedAt)));
  for (const row of rows) {
    map.set(row.id, row.expertProfileId);
  }
  return map;
}

/**
 * BAL-283 (Ruling 1) — a client↔candidate call DOES block the candidate's calendar, so the
 * relationship's own expert is loaded here exactly like the other two batches. Soft-deleted
 * relationships are excluded (the `drizzle-schema` soft-delete query rule), which is what makes
 * a withdrawn expert's stale context resolve `unresolvable` rather than book time on a calendar
 * the marketplace no longer offers.
 */
async function loadRelationshipExperts(
  exec: DbExecutor,
  ids: ReadonlySet<string>
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (ids.size === 0) {
    return map;
  }
  const rows = await exec
    .select({
      id: requestExpertRelationships.id,
      expertProfileId: requestExpertRelationships.expertProfileId,
    })
    .from(requestExpertRelationships)
    .where(
      and(
        inArray(requestExpertRelationships.id, [...ids]),
        isNull(requestExpertRelationships.deletedAt)
      )
    );
  for (const row of rows) {
    map.set(row.id, row.expertProfileId);
  }
  return map;
}

/**
 * BATCHED, DELIBERATELY: `findProjectionDrift` resolves many meetings at once, and a
 * per-context read would be a textbook N+1. ONE query PER TARGET TABLE for the whole context
 * set, never one per context — so the single-meeting writers pay THREE at most (BAL-283 added
 * the third), and zero for an admin-only meeting.
 */
async function loadContextExperts(
  exec: DbExecutor,
  contexts: readonly ProjectionContext[]
): Promise<ContextExpertMaps> {
  const { engagementIds, requestIds, relationshipIds } = classifyContextIds(contexts);
  const engagementExperts = await loadEngagementExperts(exec, engagementIds);
  const requestExperts = await loadRequestExperts(exec, requestIds);
  const relationshipExperts = await loadRelationshipExperts(exec, relationshipIds);
  return { engagementExperts, requestExperts, relationshipExperts };
}

/**
 * What ONE context row resolves to. `ignored` is the `admin` case; the two failure shapes
 * are borrowed from `ExpertResolution` rather than restated, so a caller can hand either
 * straight back without re-wrapping.
 */
type ContextResolution =
  | { kind: 'ignored' }
  | { kind: 'expert'; expertProfileId: string }
  | Extract<ExpertResolution, { kind: 'match_mode' | 'unresolvable' | 'not_projectable' }>;

/** PURE. Walk ONE context row to its expert, through whichever table its type names. */
/**
 * Deterministic ordering for a set of uuids destined for an error message.
 *
 * ⚠ THE COMPARATOR IS NOT OPTIONAL. A bare `.sort()` coerces every element to a string and
 * orders by UTF-16 code unit — SonarCloud rates that a RELIABILITY bug (`Provide a compare
 * function…`), and it is right to: the default is only ever accidentally correct, and the
 * habit is what silently mis-sorts the next array that holds numbers. These are uuids, so
 * `localeCompare` is stable and locale-independent for the hex+hyphen alphabet.
 *
 * Ordering matters at all only so `MeetingExpertAmbiguousError`'s message is REPRODUCIBLE:
 * the same two experts must render in the same order every time, or the same defect reads as
 * two different errors in logs and in test assertions.
 */
function sortIds(ids: string[]): string[] {
  return ids.sort((a, b) => a.localeCompare(b));
}

function resolveOneContext(context: ProjectionContext, maps: ContextExpertMaps): ContextResolution {
  // `admin` carries no subject, and the biconditional CHECK makes the two conditions
  // equivalent — both are spelled out so a reader does not have to know that. It stays a
  // guard ABOVE the switch rather than an arm inside it, because it is the one label whose
  // `contextId` is legally NULL and the switch below is written over a non-null id.
  if (context.contextType === 'admin' || context.contextId === null) {
    return { kind: 'ignored' };
  }
  const contextId = context.contextId;
  const unresolvable = {
    kind: 'unresolvable',
    contextType: context.contextType,
    contextId,
  } as const;

  switch (context.contextType) {
    case 'request_interaction': {
      // BAL-283 / Ruling 1 (owner-ratified) — a client↔candidate call DOES block the
      // candidate's calendar: "we should not care what event is in the expert calendar; all
      // we care about is, is that slot free or not". The id is a
      // `request_expert_relationships.id`, NEVER an `engagements.id`, and its expert comes
      // from the map `loadContextExperts` fills from that table — which is what makes a
      // half-added arm impossible to ship silently (see the module docblock).
      //
      // `get`, not `has`: `expert_profile_id` is NOT NULL there, so a missing key means no
      // LIVE relationship (absent or soft-deleted, i.e. a withdrawn expert) and there is no
      // match-mode third state to distinguish.
      const expertProfileId = maps.relationshipExperts.get(contextId);
      return expertProfileId === undefined ? unresolvable : { kind: 'expert', expertProfileId };
    }
    case 'project_discovery': {
      // `has` vs `get`, DELIBERATELY: the map stores `string | null`, so a MISSING key (no
      // such live request) and a PRESENT null one (match mode) are different outcomes that
      // `get` alone would flatten into one.
      if (!maps.requestExperts.has(contextId)) {
        return unresolvable;
      }
      const expertProfileId = maps.requestExperts.get(contextId) ?? null;
      return expertProfileId === null
        ? { kind: 'match_mode', projectRequestId: contextId }
        : { kind: 'expert', expertProfileId };
    }
    case 'case':
    case 'project_kickoff':
    case 'package_session':
    case 'retainer_checkin': {
      const expertProfileId = maps.engagementExperts.get(contextId);
      return expertProfileId === undefined ? unresolvable : { kind: 'expert', expertProfileId };
    }
    default: {
      // ⚠ TWO GUARDS, ONE ARM, AND BOTH ARE LOAD-BEARING.
      //   TYPE-LEVEL: `never` today, so an 8th `meeting_context_type` label fails
      //   `pnpm --filter api typecheck` RIGHT HERE — this module really is inside `apps/api`'s
      //   program (`@balo/db`'s exports point at raw `./src/*.ts`, and the meetings route
      //   value-imports the barrel), verified by probe. `@balo/db` has no typecheck script of
      //   its own, so this is the only compiler that sees it.
      //   RUNTIME: still a named, fail-closed throw, because a label can also ARRIVE from a
      //   raw DB row that a cast let past the type — `meeting_contexts` has no FK and no RLS.
      const unhandled: never = context.contextType;
      return { kind: 'not_projectable', contextType: unhandled, contextId };
    }
  }
}

/**
 * PURE. Given the pre-loaded lookup maps, decide which expert (if any) a context set names.
 * Split out from the DB read so the throwing write path and the reporting drift read share
 * ONE definition of the rules — a second copy is how the reconciliation report would start
 * disagreeing with the thing it is reconciling.
 *
 * FAILS FAST: the first unresolvable or match-mode context ends the walk. Ambiguity, by
 * contrast, can only be known after the WHOLE set is seen.
 */
function resolveExpert(
  contexts: readonly ProjectionContext[],
  maps: ContextExpertMaps
): ExpertResolution {
  const experts = new Set<string>();

  for (const context of contexts) {
    const resolved = resolveOneContext(context, maps);
    if (
      resolved.kind === 'unresolvable' ||
      resolved.kind === 'match_mode' ||
      resolved.kind === 'not_projectable'
    ) {
      return resolved;
    }
    if (resolved.kind === 'expert') {
      experts.add(resolved.expertProfileId);
    }
  }

  if (experts.size > 1) {
    return { kind: 'ambiguous', expertProfileIds: sortIds([...experts]) };
  }
  const [only] = [...experts];
  // `only` is undefined exactly when the set is empty (no non-admin context). At size 1 the
  // destructure is still typed as possibly-undefined under `noUncheckedIndexedAccess`, and a
  // `!` here would be the assertion the house rule forbids — so ONE ternary covers both.
  return only === undefined ? { kind: 'none' } : { kind: 'resolved', expertProfileId: only };
}

/** Turn a resolution into the writers' contract: an expert id, `null`, or a typed throw. */
function expertOrThrow(resolution: ExpertResolution, meetingId: string | null): string | null {
  switch (resolution.kind) {
    case 'none':
      return null;
    case 'resolved':
      return resolution.expertProfileId;
    case 'match_mode':
      throw new MatchModeDiscoveryNotBookableError(resolution.projectRequestId);
    case 'ambiguous':
      throw new MeetingExpertAmbiguousError(meetingId, resolution.expertProfileIds);
    case 'unresolvable':
      throw new MeetingContextUnresolvableError(resolution.contextType, resolution.contextId);
    case 'not_projectable':
      throw new MeetingContextNotProjectableError(resolution.contextType, resolution.contextId);
  }
}

/**
 * THE RESOLVER. Which expert's calendar do these contexts block? `null` means "none, and
 * that is legal" (every context was `admin`). Anything else that is not exactly one expert
 * throws — see `expertOrThrow`.
 */
export async function resolveMeetingExpertTx(
  exec: DbExecutor,
  contexts: readonly ProjectionContext[],
  meetingId: string | null
): Promise<string | null> {
  const maps = await loadContextExperts(exec, contexts);
  return expertOrThrow(resolveExpert(contexts, maps), meetingId);
}

// ── Status mapping ─────────────────────────────────────────────────────

/**
 * The meeting lifecycle projected onto the two-value availability status.
 *
 * ONLY `cancelled` frees the slot. `ended` maps to `confirmed` DELIBERATELY: a delivered
 * consultation is a historical fact the expert's hero stat counts
 * (`_shared/consultation-count.ts` counts `confirmed` rows), and its window is in the past
 * so it can never block a future slot anyway.
 */
export function consultationStatusForMeeting(status: MeetingStatus): ConsultationStatus {
  return status === 'cancelled' ? 'cancelled' : 'confirmed';
}

// ── Writers (transaction-scoped, one per meeting mutation) ─────────────

/**
 * Project a NEWLY CREATED meeting. Returns the expert whose availability just changed, or
 * `null` for an admin-only meeting — in which case NO row is written at all (BAL-428 AC #5).
 *
 * Throws (rolling back the caller's transaction, and therefore the meeting itself) when the
 * contexts name no resolvable expert, more than one, or a match-mode project request.
 */
export async function projectNewMeetingTx(
  exec: DbExecutor,
  meeting: Meeting,
  contexts: readonly ProjectionContext[]
): Promise<string | null> {
  const expertProfileId = await resolveMeetingExpertTx(exec, contexts, meeting.id);
  if (expertProfileId === null) {
    return null;
  }

  await exec.insert(consultations).values({
    meetingId: meeting.id,
    expertProfileId,
    startAt: meeting.scheduledStart,
    endAt: meeting.scheduledEnd,
    status: consultationStatusForMeeting(meeting.status),
  });

  return expertProfileId;
}

/**
 * Move the projected window after a reschedule.
 *
 * ⚠ THE EXPERT IS READ FROM THE LIVE PROJECTION ROW AND NEVER RE-RESOLVED. Re-resolving
 * here would let an edit to the meeting's contexts silently REPOINT an existing booking at
 * a different expert — freeing a slot on one calendar and occupying another, with no
 * record that it happened. That divergence is drift for `findProjectionDrift` to REPORT,
 * not something a schedule mutator may quietly paper over.
 *
 * Returns `null` when there is no live projection row (an admin meeting), which is also
 * how the caller learns there is no availability cache to rebuild.
 */
export async function syncProjectionScheduleTx(
  exec: DbExecutor,
  meeting: Meeting
): Promise<string | null> {
  const [row] = await exec
    .update(consultations)
    .set({
      startAt: meeting.scheduledStart,
      endAt: meeting.scheduledEnd,
      updatedAt: new Date(),
    })
    .where(and(eq(consultations.meetingId, meeting.id), isNull(consultations.deletedAt)))
    .returning({ expertProfileId: consultations.expertProfileId });
  return row?.expertProfileId ?? null;
}

/**
 * Free the slot. The row is KEPT (status `cancelled`) rather than deleted so the booking
 * remains auditable and the `consultations_meeting_uq` partial unique still holds — and so
 * the resolver's `status = 'confirmed'` filter, not a row count, is what frees the window.
 */
export async function cancelProjectionTx(
  exec: DbExecutor,
  meetingId: string
): Promise<string | null> {
  const [row] = await exec
    .update(consultations)
    .set({ status: 'cancelled', updatedAt: new Date() })
    .where(and(eq(consultations.meetingId, meetingId), isNull(consultations.deletedAt)))
    .returning({ expertProfileId: consultations.expertProfileId });
  return row?.expertProfileId ?? null;
}

/**
 * Stamp the projection when its meeting is soft-deleted. Leaving it live would keep a
 * deleted meeting occupying the expert's calendar with no way to see why — the same class
 * of bug as leaving `meeting_contexts` children live, documented at
 * `meetingsRepository.softDelete`.
 */
export async function softDeleteProjectionTx(
  exec: DbExecutor,
  meetingId: string,
  now: Date
): Promise<string | null> {
  const [row] = await exec
    .update(consultations)
    .set({ deletedAt: now, updatedAt: now })
    .where(and(eq(consultations.meetingId, meetingId), isNull(consultations.deletedAt)))
    .returning({ expertProfileId: consultations.expertProfileId });
  return row?.expertProfileId ?? null;
}

/**
 * THE `attach` GUARD — the second door into a booking's expert.
 *
 * `meetingsRepository.create` resolves the expert from the contexts it was given, but
 * `meetingContextsRepository.attach` can widen that set afterwards. Without this check, a
 * booked meeting could gain a context naming a DIFFERENT expert and the projection would
 * quietly keep pointing at the first one — a booking whose stated subject and whose blocked
 * calendar disagree.
 *
 * SCOPE, DELIBERATELY NARROW:
 *   - Runs ONLY when the meeting already HAS a live projection row. Attaching to a meeting
 *     that was never booked through this path (an admin meeting, or a raw fixture) is not
 *     this guard's business, and resolving there would make `attach` throw for callers that
 *     never asked for a booking.
 *   - It NEVER creates a projection row. `attach` is not a booking path; only
 *     `meetingsRepository.create` books. An attach that makes a previously-unbooked meeting
 *     resolvable therefore leaves the meeting unprojected — real drift, and
 *     `findProjectionDrift` reports it as `missing_projection` rather than this function
 *     inventing a booking nobody requested.
 *
 * ⚠⚠ THE ONE GAP, NAMED EXPLICITLY RATHER THAN CLOSED — READ BEFORE "TIGHTENING" THIS.
 *
 * When the widened live context set resolves to `null` (every live context is `admin`, or
 * there are none left) while a LIVE PROJECTION ROW EXISTS, this guard PASSES SILENTLY. It is
 * reachable: book with a `case` context → detach that context → attach an `admin` one. The
 * projection then still blocks the original expert while the meeting names nobody.
 *
 * THAT IS DELIBERATE, and the justification is `detach`'s, not a shrug (see
 * `meetingContextsRepository.detach`'s docblock, which this mirrors on purpose):
 *
 *   1. THE DRIFT ALREADY EXISTS BEFORE THE ATTACH. `resolved === null` here means zero
 *      non-admin live contexts, which is precisely the state `detach` leaves behind and
 *      which `findProjectionDrift` ALREADY reports as `expert_mismatch` (its
 *      `resolution.kind !== 'resolved'` branch). The attach does not create the divergence
 *      and does not widen it — it adds an `admin` row, which is ignored by every reader.
 *   2. THROWING WOULD MAKE `attach` REFUSE ON PRE-EXISTING DRIFT. The only meetings it could
 *      reject are ones ALREADY in that state, so the error would name the wrong operation
 *      and block the one cheap way to re-tag a broken booking back into shape. `attach` is a
 *      tagging operation; blocking or repairing a booking is `cancel`'s and `create`'s job.
 *
 * What this guard DOES still catch — and the reason it exists — is a widened set that names
 * a DIFFERENT single expert, or TWO experts. Those are new divergences the attach itself
 * introduces, and both throw `MeetingExpertAmbiguousError` below.
 *
 * ⚠ ITS SIBLING IS NOT FOLDED IN HERE, DELIBERATELY (BAL-469). `attach` also runs
 * `assertPrimaryContextUnchangedTx` (`../meeting-contexts.ts`), which refuses an insert that
 * REPOINTS the meeting's primary context — and therefore the company it names. Do NOT move
 * that check into this function to "keep the attach guards together": this one returns early
 * when the meeting has no live projection row, so an UNBOOKED meeting would inherit the early
 * return and be left entirely un-gated. Two guards, two scopes, one transaction.
 */
export async function assertProjectionExpertUnchangedTx(
  exec: DbExecutor,
  meetingId: string
): Promise<string | null> {
  const [projection] = await exec
    .select({ expertProfileId: consultations.expertProfileId })
    .from(consultations)
    .where(and(eq(consultations.meetingId, meetingId), isNull(consultations.deletedAt)))
    .limit(1);
  if (projection === undefined) {
    return null;
  }

  const liveContexts = await exec
    .select({
      contextType: meetingContexts.contextType,
      contextId: meetingContexts.contextId,
    })
    .from(meetingContexts)
    .where(and(eq(meetingContexts.meetingId, meetingId), isNull(meetingContexts.deletedAt)));

  // Throws `MeetingExpertAmbiguousError` itself when the widened set names two experts —
  // which is the common case this guard exists for.
  const resolved = await resolveMeetingExpertTx(exec, liveContexts, meetingId);
  if (resolved !== null && resolved !== projection.expertProfileId) {
    // The widened set resolves to ONE expert, but not the one already booked (e.g. the
    // original context was detached first). Same defect, same named error.
    throw new MeetingExpertAmbiguousError(
      meetingId,
      sortIds([projection.expertProfileId, resolved])
    );
  }
  return projection.expertProfileId;
}

// ── Reads ──────────────────────────────────────────────────────────────

/** The LIVE projection row for a meeting, if it has one. `undefined` for an admin meeting. */
export async function findProjectionForMeeting(
  meetingId: string
): Promise<Consultation | undefined> {
  const [row] = await db
    .select()
    .from(consultations)
    .where(and(eq(consultations.meetingId, meetingId), isNull(consultations.deletedAt)))
    .limit(1);
  return row;
}

// ── Reconciliation ─────────────────────────────────────────────────────

/** How a projection row and its meeting can disagree. */
export type ProjectionDriftKind =
  /** A live meeting resolves to an expert but has no live projection row. */
  | 'missing_projection'
  /** A live projection row whose meeting has been soft-deleted. */
  | 'orphaned_projection'
  /** `start_at`/`end_at` no longer equal `scheduled_start`/`scheduled_end`. */
  | 'window_mismatch'
  /** Cancelled-ness disagrees between the meeting and its projection. */
  | 'status_mismatch'
  /** The projected expert is not who the meeting's live contexts now resolve to. */
  | 'expert_mismatch';

export interface ProjectionDrift {
  meetingId: string;
  /** `null` for `missing_projection` — there is no row to name. */
  consultationId: string | null;
  kind: ProjectionDriftKind;
  /** Human-readable specifics, for the reconciliation report / test failure message. */
  detail: string;
}

/**
 * THE RECONCILIATION READ — "did availability and `meetings` ever disagree?", answered
 * rather than assumed. **SCOPED: `meetingIds` IS REQUIRED.**
 *
 * BAL-428 makes drift structurally hard (NOT NULL FK, one writer, one transaction), but not
 * impossible: `meeting_contexts` can be edited after a booking, a fixture or an old row can
 * predate the writer, and a hand-run UPDATE answers to nobody. This function is how that is
 * DETECTED instead of assumed away. It deliberately REPORTS rather than repairs — an
 * automatic repair would destroy the evidence of whatever produced the drift.
 *
 * ⚠ WHY `meetingIds` IS REQUIRED RATHER THAN AN OPTIONAL FILTER. Omitting it used to mean
 * "scan every live meeting and every live projection row in the database" — an unbounded
 * four-query table scan reachable by writing `findProjectionDrift()`, i.e. by forgetting an
 * argument. That is one autocomplete away from a web Server Action shipping a full-table
 * read on the request path. The unscoped scan still exists, but you now have to ASK for it
 * by name: `scanAllProjectionDrift()`.
 */
export async function findProjectionDrift(options: {
  meetingIds: readonly string[];
}): Promise<ProjectionDrift[]> {
  const { meetingIds } = options;
  if (meetingIds.length === 0) {
    return [];
  }
  return driftScan(inArray(meetings.id, [...meetingIds]));
}

/**
 * THE UNSCOPED RECONCILIATION SCAN — every live meeting, every live projection row.
 *
 * ⚠ A DIAGNOSTIC READ, NOT A HOT PATH, AND DELIBERATELY UGLY TO REACH BY ACCIDENT. Split
 * out from `findProjectionDrift` (whose `meetingIds` is now required) precisely so an
 * unbounded full-table read cannot be produced by omitting an argument. Its callers are the
 * scheduled reconciliation job (a FOLLOW-UP TICKET, deliberately not folded in here), this
 * ticket's integration test, and anyone debugging. Never call it from a request path.
 */
export async function scanAllProjectionDrift(): Promise<ProjectionDrift[]> {
  return driftScan(undefined);
}

/**
 * The scan itself, shared by both entry points so the scoped and unscoped reads can never
 * disagree about what counts as drift. `scoped` is the meeting-id predicate, or `undefined`
 * for the whole table — `and(...)` drops an `undefined` operand.
 */
async function driftScan(scoped: SQL | undefined): Promise<ProjectionDrift[]> {
  // PASS 1 walks the projection rows; PASS 2 walks the meetings. Neither subsumes the
  // other: pass 1 cannot see a meeting that projects NOTHING (there is no row to join
  // from), and pass 2 cannot see a projection whose meeting is soft-deleted (it filters
  // live meetings). Pass 2 needs pass 1's index, hence the sequencing.
  const { drift, projectionByMeeting } = await scanProjectionRows(scoped);
  drift.push(...(await scanLiveMeetings(scoped, projectionByMeeting)));
  return drift;
}

/** A live projection row, indexed by the meeting it projects. */
type ProjectionByMeeting = Map<string, Consultation>;

/**
 * PASS 1 — every LIVE projection row, compared against the meeting it claims to project
 * (live or not). Catches `orphaned_projection`, `window_mismatch` and `status_mismatch`,
 * and returns the index pass 2 needs so the two passes share ONE read of this table.
 */
async function scanProjectionRows(
  scoped: SQL | undefined
): Promise<{ drift: ProjectionDrift[]; projectionByMeeting: ProjectionByMeeting }> {
  const projected = await db
    .select({ consultation: consultations, meeting: meetings })
    .from(consultations)
    .innerJoin(meetings, eq(meetings.id, consultations.meetingId))
    .where(and(isNull(consultations.deletedAt), scoped));

  const drift: ProjectionDrift[] = [];
  const projectionByMeeting: ProjectionByMeeting = new Map();

  for (const { consultation, meeting } of projected) {
    projectionByMeeting.set(meeting.id, consultation);

    if (meeting.deletedAt !== null) {
      drift.push({
        meetingId: meeting.id,
        consultationId: consultation.id,
        kind: 'orphaned_projection',
        detail: `meeting soft-deleted at ${meeting.deletedAt.toISOString()} but the projection is still live`,
      });
      continue; // every other comparison against a dead meeting is noise
    }
    if (
      consultation.startAt.getTime() !== meeting.scheduledStart.getTime() ||
      consultation.endAt.getTime() !== meeting.scheduledEnd.getTime()
    ) {
      drift.push({
        meetingId: meeting.id,
        consultationId: consultation.id,
        kind: 'window_mismatch',
        detail: `meeting [${meeting.scheduledStart.toISOString()}, ${meeting.scheduledEnd.toISOString()}) vs projection [${consultation.startAt.toISOString()}, ${consultation.endAt.toISOString()})`,
      });
    }
    const expected = consultationStatusForMeeting(meeting.status);
    if (consultation.status !== expected) {
      drift.push({
        meetingId: meeting.id,
        consultationId: consultation.id,
        kind: 'status_mismatch',
        detail: `meeting status '${meeting.status}' projects to '${expected}' but the row reads '${consultation.status}'`,
      });
    }
  }

  return { drift, projectionByMeeting };
}

/** Group live context rows by meeting, so the resolver runs once per meeting. */
function groupContextsByMeeting(
  contextRows: readonly (ProjectionContext & { meetingId: string })[]
): Map<string, ProjectionContext[]> {
  const byMeeting = new Map<string, ProjectionContext[]>();
  for (const row of contextRows) {
    const context = { contextType: row.contextType, contextId: row.contextId };
    const list = byMeeting.get(row.meetingId);
    if (list === undefined) {
      byMeeting.set(row.meetingId, [context]);
    } else {
      list.push(context);
    }
  }
  return byMeeting;
}

/**
 * PASS 2 — every LIVE meeting with its LIVE contexts, to catch a booking that projects
 * NOTHING (`missing_projection`) and a projection that names the wrong expert
 * (`expert_mismatch`).
 */
async function scanLiveMeetings(
  scoped: SQL | undefined,
  projectionByMeeting: ProjectionByMeeting
): Promise<ProjectionDrift[]> {
  const liveMeetings = await db
    .select({ id: meetings.id })
    .from(meetings)
    .where(and(isNull(meetings.deletedAt), scoped));
  if (liveMeetings.length === 0) {
    return [];
  }
  const liveMeetingIds = liveMeetings.map((row) => row.id);

  const contextRows = await db
    .select({
      meetingId: meetingContexts.meetingId,
      contextType: meetingContexts.contextType,
      contextId: meetingContexts.contextId,
    })
    .from(meetingContexts)
    .where(
      and(inArray(meetingContexts.meetingId, liveMeetingIds), isNull(meetingContexts.deletedAt))
    );

  const contextsByMeeting = groupContextsByMeeting(contextRows);
  // ONE batched lookup for every context of every scanned meeting — never per meeting.
  const maps = await loadContextExperts(db, contextRows);

  const drift: ProjectionDrift[] = [];
  for (const meetingId of liveMeetingIds) {
    const resolution = resolveExpert(contextsByMeeting.get(meetingId) ?? [], maps);
    const row = compareResolutionToProjection(
      meetingId,
      resolution,
      projectionByMeeting.get(meetingId)
    );
    if (row !== null) {
      drift.push(row);
    }
  }
  return drift;
}

/**
 * PURE. One live meeting's contexts vs its projection row (if any) → a drift row, or `null`
 * when the two agree.
 */
function compareResolutionToProjection(
  meetingId: string,
  resolution: ExpertResolution,
  projection: Consultation | undefined
): ProjectionDrift | null {
  if (projection === undefined) {
    // No projection row. That is CORRECT for an admin-only meeting, and only for that.
    return resolution.kind === 'none'
      ? null
      : {
          meetingId,
          consultationId: null,
          kind: 'missing_projection',
          detail: `contexts resolve to ${describeResolution(resolution)} but no live consultation row exists`,
        };
  }
  const agrees =
    resolution.kind === 'resolved' && resolution.expertProfileId === projection.expertProfileId;
  return agrees
    ? null
    : {
        meetingId,
        consultationId: projection.id,
        kind: 'expert_mismatch',
        detail: `projection blocks expert ${projection.expertProfileId} but contexts resolve to ${describeResolution(resolution)}`,
      };
}

/** Render any resolution outcome for a drift report, including the failure shapes. */
function describeResolution(resolution: ExpertResolution): string {
  switch (resolution.kind) {
    case 'none':
      return 'no expert (admin-only contexts)';
    case 'resolved':
      return `expert ${resolution.expertProfileId}`;
    case 'match_mode':
      return `a match-mode project request (${resolution.projectRequestId})`;
    case 'ambiguous':
      return `${resolution.expertProfileIds.length} experts (${resolution.expertProfileIds.join(', ')})`;
    case 'unresolvable':
      return `an unresolvable ${resolution.contextType} context (${resolution.contextId})`;
    case 'not_projectable':
      return `a ${resolution.contextType} context (${resolution.contextId}), which has no projection rule`;
  }
}
