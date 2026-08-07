import {
  meetingsRepository,
  type CreateMeetingInput,
  type CreatedMeeting,
  type MeetingMutationResult,
} from '@balo/db';
import type { FastifyBaseLogger } from 'fastify';
import { enqueueAvailabilityCacheRebuild } from '../../jobs/availability-cache.js';

/**
 * BAL-428 — THE MEETING-MUTATION SEAM: every write that can move an expert's
 * availability, paired with the cache rebuild that write obliges.
 *
 * ⚠ WHY THIS MODULE EXISTS AT ALL. `meetingsRepository.create` / `updateSchedule` /
 * `cancel` / `softDelete` each write the `consultations` projection the availability
 * resolver subtracts from, so the cached `earliest_available_at` for that expert is stale
 * the instant any of them commits. `@balo/db` CANNOT refresh it — the rebuild runs on a
 * BullMQ queue that lives only in `apps/api`, and the `repositories-never-notify`
 * invariant pins that dependency direction (a queue client reachable from `@balo/db`
 * would also be the `reference_balo_db_client_bundle_footgun` failure in `apps/web`). The
 * repository therefore RETURNS the `expertProfileId` and documents the caller's
 * obligation; this module is the one place that obligation is discharged.
 *
 * ⚠ A COROLLARY, ALREADY WRITTEN INTO `meetingsRepository`'s docblock and repeated here
 * because it is the thing a future contributor will get wrong: **a booking cannot be a
 * pure `apps/web` Server Action.** The queue exists only in `apps/api`, so a web action
 * calling `meetingsRepository.create` directly would commit a booking and leave every
 * expert-facing surface advertising a slot that is already taken. Booking goes through
 * here, behind an API route.
 *
 * ⚠ NO `try` / `catch` ANYWHERE IN THIS FILE, DELIBERATELY, for two separate reasons:
 *   1. `enqueueAvailabilityCacheRebuild` ALREADY swallows and logs its own Redis errors
 *      (see its docblock — a Redis hiccup must never fail the caller's mutation). A
 *      `catch` here would be a second, redundant handler around a call that cannot throw.
 *   2. The repository's TYPED errors — `MeetingExpertAmbiguousError`,
 *      `MatchModeDiscoveryNotBookableError`, `MeetingContextUnresolvableError`,
 *      `MeetingContextRequiredError`, `MeetingNotCancellableError` — MUST reach BAL-129's
 *      route intact so it can map each to its own status code. That route is the
 *      `log.error` boundary (CLAUDE.md: log where an error is turned into a user-facing
 *      message). Catching here would flatten five branchable reasons into one 500.
 *
 * ⚠ THIS MODULE RESOLVES NO AUTHORIZATION, AND THE OBLIGATION HAS **TWO DIFFERENT SHAPES**
 * — do not read the first one as covering all four functions.
 *
 *   1. `bookMeeting` is gated on the **CONTEXT ID**. `meeting_contexts.context_id` has no
 *      FK and no RLS behind it, so a context id from another tenant resolves happily to
 *      that tenant's expert (see `schema/meeting-contexts.ts`'s tenancy obligation). The
 *      caller must resolve the context's owning party and check `hasCapability` against it
 *      BEFORE a `contextId` reaches here.
 *
 *   2. `rescheduleMeeting` / `cancelMeeting` / `softDeleteMeeting` are gated on the
 *      **MEETING ID**, and that is a SEPARATE check the context-id rule does not imply.
 *      Each takes a bare `meetingId` and mutates whatever it names — there is no ownership
 *      predicate in the repository, and `meetings` deliberately carries no party column at
 *      all (ADR-1045 §2). So an unchecked id here is a direct IDOR: cancel or move ANY
 *      expert's booking, on any tenant, by guessing a uuid. The caller must load the
 *      meeting, resolve its owning party THROUGH the context seam, and check
 *      `hasCapability` — before calling. BAL-129/BAL-409/BAL-410/BAL-411 own those routes
 *      and inherit this obligation; it becomes live the moment the first one lands.
 *
 * Nothing in this module substitutes for either check.
 *
 * ⚠ ROUTES MUST NOT ECHO `err.message` FROM THE TYPED ERRORS BELOW. They embed raw uuids
 * (engagement ids, project-request ids, expert-profile ids) to make the SERVER log
 * actionable. Map each error to a status code and a fixed literal, the way `app.ts`'s error
 * handler does — do not pass the message to the client.
 *
 * ⚠ AND IT NOTIFIES NOTHING. Booking confirmations are BAL-129's, cancellations
 * BAL-410's, reschedules BAL-409/BAL-411's. Publishing from here would also fire on a dev
 * seed run, since the seeder is a live caller of `create` and `cancel`.
 *
 * TODAY'S CALLERS: the dev seeder (`services/seed/seed-service.ts`) reaches the same
 * repository methods directly, and BAL-129 is the first route. Everything here is a seam
 * shipped ahead of that route, exercised by
 * `services/availability/booking-availability.integration.test.ts`.
 */

/** The window a meeting occupies. Mirrors `meetingsRepository.updateSchedule`'s input. */
export interface MeetingScheduleInput {
  scheduledStart: Date;
  scheduledEnd: Date;
}

/**
 * POST-COMMIT, AND ONLY POST-COMMIT: rebuild the availability cache for whichever expert
 * the mutation just moved.
 *
 * The `await` on the repository call happens at each CALL SITE, before the result reaches
 * this function — so a mutation that throws (a rolled-back booking) never gets here and
 * never enqueues a rebuild for a booking that does not exist.
 *
 * `expertProfileId === null` means there is genuinely nothing to rebuild: an admin
 * meeting, which projects no consultation row and occupies nobody's calendar. That id is
 * read from the LIVE PROJECTION ROW by the repository and is NEVER re-resolved here —
 * re-resolving would let a context edit silently repoint a booking at a different expert,
 * which is drift for `findProjectionDrift` to report, not something a caller may paper
 * over (see `_shared/consultation-projection.ts`).
 *
 * Factored into ONE helper rather than inlined four times: four near-identical
 * three-line bodies is exactly the shape SonarCloud's new-code duplication gate flags,
 * and it is also four independent places to forget the null check.
 */
async function afterMeetingMutation<T extends MeetingMutationResult>(
  result: T,
  log: FastifyBaseLogger
): Promise<T> {
  if (result.expertProfileId !== null) {
    await enqueueAvailabilityCacheRebuild(result.expertProfileId, log);
  }
  return result;
}

/**
 * BOOK a meeting: insert it, its context rows and its `consultations` projection in one
 * transaction, then rebuild the booked expert's availability cache.
 *
 * Throws (before any enqueue) when the contexts name no resolvable expert, more than one,
 * or a match-mode project request — see this module's docblock on why those propagate.
 */
export async function bookMeeting(
  input: CreateMeetingInput,
  log: FastifyBaseLogger
): Promise<CreatedMeeting> {
  return afterMeetingMutation(await meetingsRepository.create(input), log);
}

/**
 * RESCHEDULE: move the meeting and its projection together, then rebuild — the old window
 * must not stay advertised as booked, nor the new one as free.
 */
export async function rescheduleMeeting(
  meetingId: string,
  schedule: MeetingScheduleInput,
  log: FastifyBaseLogger
): Promise<MeetingMutationResult> {
  return afterMeetingMutation(await meetingsRepository.updateSchedule(meetingId, schedule), log);
}

/**
 * CANCEL: the only thing that FREES a booked slot. Throws `MeetingNotCancellableError`
 * when the meeting is not live-and-`scheduled`, which is precisely what stops a second
 * cancel from re-enqueuing a rebuild for a slot that was already freed.
 *
 * BAL-410's "free to cancel until the scheduled start" wall-clock policy is NOT here and
 * not in the repository — it belongs to the route that owns the product rule.
 */
export async function cancelMeeting(
  meetingId: string,
  log: FastifyBaseLogger
): Promise<MeetingMutationResult> {
  return afterMeetingMutation(await meetingsRepository.cancel(meetingId), log);
}

/**
 * SOFT-DELETE: stamps the meeting, its context rows and its projection, then rebuilds.
 * Throws `Meeting not found` when nothing live matched — a caller told "done" would
 * otherwise rebuild nobody's availability and believe the slot was freed.
 */
export async function softDeleteMeeting(
  meetingId: string,
  log: FastifyBaseLogger
): Promise<MeetingMutationResult> {
  return afterMeetingMutation(await meetingsRepository.softDelete(meetingId), log);
}
