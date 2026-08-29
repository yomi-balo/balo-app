import {
  InvalidSessionTransitionError,
  creditSessionsRepository,
  meetingContextsRepository,
  meetingGuestsRepository,
  meetingsRepository,
  type CancelMutationResult,
  type CreateMeetingInput,
  type CreatedMeeting,
  type Meeting,
  type MeetingMutationResult,
  type RescheduleMutationResult,
} from '@balo/db';
import {
  GUEST_TOKEN_TTL_AFTER_END_MS,
  dailyRoomNameForMeeting,
  selectPrimaryMeetingContext,
  sanitizeSelfDeclaredName,
} from '@balo/shared/meetings';
import type { FastifyBaseLogger } from 'fastify';
import { enqueueAvailabilityCacheRebuild } from '../../jobs/availability-cache.js';
import { enqueueMeetingCalendarAmend } from '../../jobs/meeting-calendar-amend.js';
import { notificationEvents } from '../../notifications/index.js';
import { dailyRoomTeardown } from '../daily/rooms.js';
import { formatExpiryDate, resolveMeetingTitle } from './guest-participation.js';

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
 * ⚠ THE RULE IS NARROWER THAN "NO `try`/`catch` ANYWHERE": **the TRANSACTIONAL mutation must
 * never be wrapped; the POST-COMMIT fan-out always must be.** Concretely:
 *   1. `meetingsRepository.create` / `updateSchedule` / `cancel` / `softDelete` — the
 *      transactional writes — are never caught here. `enqueueAvailabilityCacheRebuild`
 *      ALREADY swallows and logs its own Redis errors (see its docblock — a Redis hiccup
 *      must never fail the caller's mutation), so a `catch` around IT would be a second,
 *      redundant handler around a call that cannot throw. And the repository's TYPED
 *      errors — `MeetingExpertAmbiguousError`, `MatchModeDiscoveryNotBookableError`,
 *      `MeetingContextUnresolvableError`, `MeetingContextNotProjectableError`,
 *      `MeetingContextRequiredError`, `MeetingNotCancellableError` — MUST reach BAL-129's
 *      route intact so it can map each to its own status code. That route is the
 *      `log.error` boundary (CLAUDE.md: log where an error is turned into a user-facing
 *      message). Catching here would flatten six branchable reasons into one 500.
 *   2. Everything AFTER the mutation has already committed — `enqueueMeetingCalendarAmend`
 *      and `publishGuestRescheduledNotifications` (its reads INCLUDED, not just the
 *      per-guest publish) — IS wrapped, deliberately, for the opposite reason: a reschedule
 *      that already committed must not turn into a 500 because a later read or publish
 *      hiccupped. A user retrying a "failed" request that actually succeeded is worse than
 *      one missed notification, which the per-guest granularity below still isolates from
 *      its siblings.
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
 *      `hasCapability` — before calling. ⚠ THREE OF THE FOUR OBLIGATIONS ARE NOW DISCHARGED,
 *      each at its own route: `authorize-meeting-booking.ts` (BAL-129),
 *      `authorize-meeting-reschedule.ts` (BAL-409) and `authorize-meeting-cancel.ts` (BAL-410,
 *      three axes — see its docblock). `softDeleteMeeting` still has NO route and therefore no
 *      gate; the obligation stands for whoever gives it one. NONE of them "fixed" the
 *      repository, and none should.
 *
 * Nothing in this module substitutes for either check.
 *
 * ⚠ ROUTES MUST NOT ECHO `err.message` FROM THE TYPED ERRORS BELOW. They embed raw uuids
 * (engagement ids, project-request ids, expert-profile ids) to make the SERVER log
 * actionable. Map each error to a status code and a fixed literal, the way `app.ts`'s error
 * handler does — do not pass the message to the client.
 *
 * ⚠ AND IT NOTIFIES NOTHING — still true after BAL-410, and for exactly the stated reason.
 * Booking confirmations are **BAL-400's** (amended by BAL-129, which built the booking route and
 * deliberately publishes nothing — see below), reschedules BAL-409/BAL-411's, and cancellations
 * BAL-410's — whose `booking.cancelled` publish lives in the cancel ROUTE, not in `cancelMeeting`
 * below, precisely because publishing from here WOULD fire on a dev seed run: the seeder is a
 * live caller of both `create` and `cancel`.
 *
 * ⚠ THE `booking.confirmed` RULE IS A DOCUMENTED ORPHAN, AND IT IS BAL-400'S TO WIRE.
 * `apps/api/src/notifications/engine/rules.ts` already defines `'booking.confirmed'` with an
 * SMS rule (gated on `phoneVerifiedAt`) and an in-app rule (recipient `expert`), and
 * `rules.test.ts` exercises them — but NOTHING publishes the event anywhere in the repo.
 * BAL-129 left it that way on purpose: its route resolves a COMPANY and a CONTEXT ROW, while
 * the projection returns only an `expertProfileId` — no expert user id, no name, no timezone
 * — so publishing an event this route cannot populate would produce a broken email, not a
 * notification. The surface that knows enough to fire it is the booking UX. **BAL-400.**
 *
 * TODAY'S CALLERS: the dev seeder (`services/seed/seed-service.ts`) reaches the same
 * repository methods directly; BAL-129's `POST /meetings`
 * (`services/meetings/provision-meeting.ts` → `routes/meetings/`) was the first route, and is
 * LIVE as of BAL-400; BAL-409's `POST /meetings/:meetingId/reschedule` and BAL-410's
 * `POST /meetings/:meetingId/cancel` are the second and third. ⚠ `cancelMeeting` therefore has
 * PRODUCTION CALLERS now — any comment elsewhere in the repo still claiming otherwise is stale.
 * `softDeleteMeeting` remains route-less. Exercised by
 * `services/availability/booking-availability.integration.test.ts` and
 * `services/meetings/book-and-provision.integration.test.ts`.
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
 * BAL-409 — the post-commit guest fan-out for a reschedule: one `meeting.guest_rescheduled`
 * publish per ADMITTED guest, each in its OWN try/catch so one failure never blocks the rest
 * (or the response, which has already been sent by the time this runs). The reads that build
 * the fan-out are wrapped too — see B5/the file docblock: a post-commit read hiccup must
 * degrade to "logged, nothing sent", never a 500 for a reschedule that already committed.
 *
 * ⚠ FILTERED TO `admission IN ('admitted','pre_admitted')` — DELIBERATELY NARROWER THAN
 * `listLiveByMeeting`'s own contract (it filters `deleted_at`/`revoked_at` only, so it
 * INCLUDES `pending` lobby knocks). `POST /meetings/:meetingId/lobby` is PUBLIC and accepts a
 * self-declared name+email with no host approval — a `pending` row can be written by anyone
 * who guesses a meeting uuid. Emailing it the case/project title and both windows on every
 * reschedule would be an unauthenticated cross-party disclosure with no admission check ever
 * in the loop. Contrast the OTHER two callers of this finder, which gate on "live" on purpose
 * because they answer a different question: `inviteGuests` (`guest-participation.ts`) counts
 * `pending` rows because a queued knock still occupies a QUEUE SLOT, and the roster
 * (`apps/web/src/lib/meetings/guest-roster.ts`) SHOWS `pending` rows to the HOST, who is the
 * one person entitled to see and act on the queue. This fan-out talks to the GUEST, not the
 * host, about content the guest has not been vetted for — so it narrows to admitted seats.
 *
 * ⚠ NO `joinToken` — Balo stores only a hash; the raw token is unrecoverable and re-minting
 * one would be a `rotateToken`, i.e. a revocation nobody asked for. The copy says the
 * existing link still works, which is true because `updateSchedule`'s transaction already
 * extended its expiry.
 *
 * ⚠ `expiresOn` IS THE LINK'S REAL EXPIRY (`scheduledEnd + GUEST_TOKEN_TTL_AFTER_END_MS`), NOT
 * `scheduledEnd` itself — the same instant `updateSchedule`'s transaction actually writes to
 * `expires_at`, and the same one every other guest email passes. Passing `scheduledEnd` bare
 * would tell the guest their link dies on the day of the call, seven days early.
 *
 * ⚠ USES `resolveMeetingTitle` (`guest-participation.ts`), the GUEST-FACING title resolver —
 * NOT `resolveMeetingContextLabel`, which is member-only by its own docblock ("must never be
 * called from the guest or lobby arms"). This payload IS a guest arm.
 */
async function publishGuestRescheduledNotifications(
  meetingId: string,
  previousScheduledStart: Date,
  scheduledStart: Date,
  scheduledEnd: Date,
  rescheduleAuditId: string,
  log: FastifyBaseLogger
): Promise<void> {
  try {
    const liveGuests = await meetingGuestsRepository.listLiveByMeeting(meetingId);
    const guests = liveGuests.filter(
      (guest) => guest.admission === 'admitted' || guest.admission === 'pre_admitted'
    );
    if (guests.length === 0) return;

    const contexts = await meetingContextsRepository.listByMeeting(meetingId);
    const primary = selectPrimaryMeetingContext(contexts);
    // `resolveMeetingTitle` never throws; a missing/ambiguous primary context degrades to
    // a neutral label rather than blocking the fan-out — the meeting move already committed.
    const meetingTitle = primary.ok ? await resolveMeetingTitle(primary.context) : null;
    const expiresOn = formatExpiryDate(
      new Date(scheduledEnd.getTime() + GUEST_TOKEN_TTL_AFTER_END_MS)
    );

    for (const guest of guests) {
      try {
        await notificationEvents.publish('meeting.guest_rescheduled', {
          // ⚠ KEYED ON THE AUDIT ROW ID, NOT THE TARGET WINDOW. `publisher.ts` turns
          // `correlationId` into the BullMQ `jobId` (`${event}--${correlationId}`), and the
          // notification-events queue RETAINS 100 completed jobs — so a window-derived key
          // would silently drop this guest's email on a move BACK to a previously-used
          // window (A→B→C→B). Per (guest, move), not per (guest, destination).
          correlationId: `${guest.id}:${rescheduleAuditId}`,
          recipientEmail: guest.email,
          ...(guest.name === null ? {} : { guestName: sanitizeSelfDeclaredName(guest.name) }),
          meetingTitle: meetingTitle ?? 'the video call',
          previousScheduledStartIso: previousScheduledStart.toISOString(),
          scheduledStartIso: scheduledStart.toISOString(),
          scheduledEndIso: scheduledEnd.toISOString(),
          expiresOn,
        });
      } catch (error) {
        log.error(
          {
            meetingId,
            guestId: guest.id,
            error: error instanceof Error ? error.message : String(error),
          },
          'Failed to publish meeting.guest_rescheduled — the guest link itself still works'
        );
      }
    }
  } catch (error) {
    log.error(
      { meetingId, error: error instanceof Error ? error.message : String(error) },
      'Failed to fan out meeting.guest_rescheduled notifications — the reschedule already committed'
    );
  }
}

/**
 * RESCHEDULE: move the meeting and its projection together, then rebuild — the old window
 * must not stay advertised as booked, nor the new one as free.
 *
 * ── F-API-3 — DAILY JOIN TOKENS: NO ACTION HERE, AND THAT IS BY DESIGN (D2) ────────────────
 * A reschedule reuses the SAME Daily room by construction (`dailyRoomNameForMeeting` is a pure
 * function of `meetings.id`), and the room carries no `exp` to reconcile. Tokens are minted
 * STRICTLY ON DEMAND at join (`join-meeting.ts`), and each join recomputes
 * `expiresAtUnixFor(meeting.scheduledEnd)` off the CURRENT row — so the very next join after
 * this commits already mints against the new window with no code here. Pre-reschedule tokens
 * already handed out stay valid to OLD end + 24h, by design (ADR-1044 amendment 2026-08-08) —
 * held by exactly the same legitimate participants. Build no revocation cascade.
 *
 * ── POST-COMMIT (never inside `updateSchedule`'s transaction) ──────────────────────────────
 *   6. `afterMeetingMutation` — the availability-cache rebuild (already shared with every
 *      other mutator; not duplicated here).
 *   7. `enqueueMeetingCalendarAmend` — the retrying, converging Apiroc amend (§4). Enqueued
 *      with the WINDOW-SCOPED jobId, so a duplicate enqueue for the same target window is
 *      dropped and a second reschedule to a different window is never dropped.
 *   9. `publishGuestRescheduledNotifications` — one publish per live guest.
 * (`booking.rescheduled`, step 10, is published from `apps/web` AFTER this returns 200 — a
 * different process, never awaited here.)
 */
export async function rescheduleMeeting(
  meetingId: string,
  schedule: MeetingScheduleInput,
  actorUserId: string | null,
  log: FastifyBaseLogger
): Promise<RescheduleMutationResult> {
  const result = await afterMeetingMutation(
    await meetingsRepository.updateSchedule(meetingId, schedule, { actorUserId }),
    log
  );

  if (result.expertProfileId !== null) {
    await enqueueMeetingCalendarAmend(
      meetingId,
      result.expertProfileId,
      result.rescheduleAuditId
    ).catch((error: unknown) => {
      log.error(
        { meetingId, error: error instanceof Error ? error.message : String(error) },
        'Failed to enqueue meeting-calendar-amend job'
      );
    });
  }

  await publishGuestRescheduledNotifications(
    meetingId,
    result.previous.scheduledStart,
    result.meeting.scheduledStart,
    result.meeting.scheduledEnd,
    result.rescheduleAuditId,
    log
  );

  return result;
}

/**
 * BAL-410 — POST-COMMIT, BEST-EFFORT: cancel any live credit session bound to this meeting.
 * **THE MOST IMPORTANT LINE OF THE CANCEL PATH, and the one with nothing on screen to prove it
 * ran.**
 *
 * ⚠⚠ WHY IT IS NOT A NO-OP. Since BAL-466 / ADR-1052 a credit session opens at CLIENT
 * ADMISSION (`join-meeting.ts` → `openCaseSessionBestEffort`), with `durationSource: 'presence'`
 * and an ACTIVE HOLD — and admission does NOT change `meetings.status`
 * (`presence-writer.ts` writes the `scheduled → waiting_for_participants` flip, on real Daily
 * presence). `assertMeetingJoinable` has no early-join lower bound; the 15-minute gate is a UI
 * affordance. So a `status='scheduled'` meeting CAN already carry a `pending` presence session
 * holding live credit, and `meetingsRepository.cancel` accepts exactly that meeting.
 *
 * ⚠⚠ AND NOTHING ELSE WOULD EVER CLEAN IT UP. `findStalePending` excludes
 * `duration_source='presence'` (deliberately — BAL-412 F4); `findPresenceUnsettled` requires
 * `meetings.status='ended'`; and the lifecycle sweep scans only the three non-terminal statuses,
 * so cancelling REMOVES the meeting from the one actor that would have ended the session. The
 * hold would be stranded PERMANENTLY: the company's available balance is reduced forever, and
 * `open()`'s one-live-session-per-wallet gate then locks that company out of EVERY future Case
 * session. That is why this step runs BEFORE the vendor teardown, and why it has a durability
 * backstop (`findPendingForCancelledMeetings`, swept by `credit-session-meter-sweep.ts`) where
 * the vendor teardown deliberately has none.
 *
 * The hold release is a CONSEQUENCE of the session cancel, not a separate step:
 * `creditSessionsRepository.cancel` releases it under the wallet advisory lock it takes itself.
 * ⚠ THE CALLER MUST NOT TAKE THAT LOCK — there is exactly one lock site.
 *
 * Returns whether a hold actually moved `active → released`, so the caller's notification copy
 * cannot claim a release that did not happen. `false` is the OVERWHELMINGLY COMMON case (nobody
 * joined early) and is a first-class answer, never a zero-valued stub.
 *
 * Idempotent twice over: `findIdByMeetingId` filters `status <> 'cancelled'`, so a retry finds
 * nothing; and `cancel` returns early on an already-`cancelled` session.
 *
 * ⚠⚠ `memberId` IS THE SESSION'S **PLACER**, NEVER THE CANCELLING ACTOR (security LOW-3).
 * `credit_holds.member_id` is a COMPANY-SCOPED money row. On the expert and admin arms the
 * cancelling actor holds no membership in the wallet's company at all, so stamping them there
 * would write a foreign user id into that company's credit history AND destroy the attribution
 * of the member who actually placed the hold. Every sibling caller in `credit-sessions.ts`
 * passes `session.initiatingMemberId`; this matches them. The cancelling actor is not lost —
 * the `meeting.cancelled` audit row carries `actor_user_id` and `metadata.actorRole`, which is
 * where "who cancelled" belongs.
 *
 * ⚠ THE `findById` READ EXISTS ONLY FOR THAT. `findIdByMeetingId` is projected to `{ id }`
 * alone, deliberately and permanently (its own docblock argues the fee-concealment case for a
 * CLIENT-BOUND read path) — widening it to carry one more column would erode that for every
 * other caller. One extra PK read on the rare branch where a session actually exists is the
 * cheaper trade.
 */
async function releaseCreditHoldBestEffort(
  meetingId: string,
  log: FastifyBaseLogger
): Promise<boolean> {
  try {
    const existing = await creditSessionsRepository.findIdByMeetingId(meetingId);
    if (existing === undefined) {
      // The common path: the client never joined early, so no session was ever opened.
      return false;
    }
    const placer = await creditSessionsRepository.findById(existing.id);
    const session = await creditSessionsRepository.cancel(existing.id, {
      memberId: placer?.initiatingMemberId ?? null,
    });
    return session.holdId !== null;
  } catch (error) {
    if (error instanceof InvalidSessionTransitionError) {
      // ⚠⚠ STRUCTURALLY UNREACHABLE, AND LOUD BECAUSE OF IT. A session becomes `active` only
      // via `connect`, whose only production call sites require the meeting to be ALREADY
      // `in_progress`; this repository's CAS requires `scheduled`, and Postgres serialises the
      // two writes on the same row. So a metering session here is an INVARIANT VIOLATION to
      // investigate, not a state to recover: a metering session means the call is underway,
      // which is the NO-SHOW / SETTLEMENT path (BAL-412), not cancellation. We do NOT
      // special-case it and we do NOT force it — the backstop sweep will not touch a
      // non-`pending` row either.
      log.error(
        {
          meetingId,
          errorName: error.name,
          error: error.message,
        },
        'Credit session for a cancelled meeting was not pending — INVARIANT VIOLATION, not settled here (BAL-412 owns settlement)'
      );
      return false;
    }
    log.error(
      {
        meetingId,
        errorName: error instanceof Error ? error.name : 'unknown',
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      },
      'Credit session release failed after a cancellation — the backstop sweep will retry'
    );
    return false;
  }
}

/**
 * BAL-410 — POST-COMMIT, BEST-EFFORT: delete the Daily room so a cancelled booking does not
 * strand one at the vendor forever (`provision-meeting.ts`'s hazard (ii)).
 *
 * ⚠ BEST-EFFORT AND NON-FATAL, exactly like `end-meeting.ts`'s `tearDownRoom`: the meeting is
 * already `cancelled` in Postgres and `MEETING_CLOSED_TO_JOIN` already refuses a Balo-side
 * rejoin, so a vendor failure costs nothing that matters — it logs at `error` (the RATE is the
 * health signal) and the route still answers 200.
 *
 * ⚠ NO DURABILITY, DELIBERATELY, AND THE ASYMMETRY WITH THE HOLD RELEASE IS THE POINT. A
 * cancelled meeting is never revisited by `meeting-lifecycle-sweep`, so a failure here is
 * permanent — accepted, because the residual is vendor hygiene with no money and no ACCESS
 * implication (`MEETING_CLOSED_TO_JOIN` contains `'cancelled'`, and `meetingId` is not on
 * `openSessionBodySchema`, so no new session can be bound from the wire either). The stranded
 * HOLD has both, which is why only that one gets a backstop.
 */
async function tearDownRoomBestEffort(meeting: Meeting, log: FastifyBaseLogger): Promise<void> {
  const roomName = meeting.dailyRoomName;
  if (roomName === null) {
    // A `provisioned: false` meeting is a real `201` outcome of `POST /meetings`. Nothing to do.
    return;
  }

  // ⚠⚠ THE STAMPED NAME IS CHECKED AGAINST THE DERIVED ONE BEFORE ANYTHING IS DELETED — the
  // same guard `jobs/meeting-lifecycle-sweep.ts` applies, and it matters for the same reason:
  // the call is DESTRUCTIVE and irreversible. The name is a pure, injective function of
  // `meetings.id`, so there is exactly one correct value; a divergence means this row points at
  // SOMEBODY ELSE'S room, and deleting it would drop a call that is running. Refusing is free.
  const expected = dailyRoomNameForMeeting(meeting.id);
  if (roomName !== expected) {
    log.error(
      { meetingId: meeting.id, expected, stamped: roomName },
      'Stamped Daily room name disagrees with the derived one — REFUSING to delete a room this meeting may not own'
    );
    return;
  }

  try {
    // A vendor `404` is `'already_gone'`, an explicit SUCCESS value — Daily auto-deletes an
    // expiring room once the last participant leaves, so racing that is the NORMAL outcome.
    await dailyRoomTeardown.deleteRoom(roomName);
  } catch (error) {
    log.error(
      {
        meetingId: meeting.id,
        roomName,
        errorName: error instanceof Error ? error.name : 'unknown',
        error: error instanceof Error ? error.message : String(error),
      },
      'Daily room teardown failed after a cancellation — the meeting is still cancelled and rejoin is still refused Balo-side'
    );
  }
}

/** BAL-410 — what `cancelMeeting` answers: the repository result plus whether a hold moved. */
export interface CancelMeetingOutcome extends CancelMutationResult {
  /**
   * True IFF a credit hold actually moved `active → released`. `false` is the common case.
   * Load-bearing: the in-app copy must not claim a release that did not happen.
   */
  holdReleased: boolean;
}

/**
 * CANCEL: the only thing that FREES a booked slot. Throws `MeetingNotCancellableError`
 * when the meeting is not live-and-`scheduled`, which is precisely what stops a second
 * cancel from re-enqueuing a rebuild for a slot that was already freed.
 *
 * BAL-410's "free to cancel until the scheduled start" policy is NOT here and not in the
 * repository. Nor is it a wall-clock rule anywhere: it is delivered by the STATE guard
 * (`CANCELLABLE_MEETING_STATUSES`, shared with the route's `resolveCancelRefusal`), because the
 * first presence interval flips a joined meeting out of `scheduled`. See `cancellable.ts`.
 *
 * ── TRANSACTION, then THREE POST-COMMIT STEPS, IN THIS ORDER ───────────────────────────────
 *   0. `meetingsRepository.cancel` — NEVER wrapped. `MeetingNotCancellableError` must reach the
 *      route intact so it can map to its own 409 (this module's docblock, rule 1).
 *   1. `afterMeetingMutation` — the availability-cache rebuild, shared with every mutator.
 *   2. `releaseCreditHoldBestEffort` — THE MONEY. Wrapped, for the opposite reason (rule 2).
 *   3. `tearDownRoomBestEffort` — the vendor. Wrapped, same reason.
 *
 * ⚠⚠ MONEY FIRST, VENDOR SECOND — AND THE ORDER IS THE WHOLE ANSWER TO THE TICKET'S STATED
 * FAILURE MODE ("releases the hold but leaves the room live, or vice versa"). The two halves
 * are NOT symmetric:
 *   · crash AFTER step 2, before step 3 ⇒ hold released, room still live at Daily. HARMLESS:
 *     `MEETING_CLOSED_TO_JOIN` contains `'cancelled'` so nobody Balo-authenticated can rejoin,
 *     and `openSessionBodySchema` carries no `meetingId` so no new session can be bound from
 *     the wire. This is the residual `end-meeting.ts` already accepts.
 *   · crash AFTER step 3, before step 2 (the INVERTED order) ⇒ room gone, HOLD STRANDED
 *     FOREVER, and the company locked out of every future Case session. Severe and permanent.
 * Do not reorder these two.
 *
 * ⚠ IT PUBLISHES NOTHING, and that is deliberate rather than an omission. The dev seeder
 * (`services/seed/seed-service.ts`) is a live caller of this function, so publishing
 * `booking.cancelled` here would fire cancellation emails on every `pnpm db:seed`. The publish
 * lives in the ROUTE, which the seeder cannot reach — see `publish-booking-cancelled.ts`.
 */
export async function cancelMeeting(
  meetingId: string,
  actorUserId: string | null,
  actorRole: 'client' | 'expert' | 'admin' | 'system',
  log: FastifyBaseLogger
): Promise<CancelMeetingOutcome> {
  // Step 0 + 1. The transaction is NOT wrapped; the cache rebuild swallows its own Redis errors.
  const result = await afterMeetingMutation(
    await meetingsRepository.cancel(meetingId, { actorUserId, actorRole }),
    log
  );

  // Step 2 — THE MONEY. Before the vendor call; see the docblock. ⚠ It takes NO actor: the
  // hold's `member_id` records the PLACER, not whoever cancelled (security LOW-3).
  const holdReleased = await releaseCreditHoldBestEffort(meetingId, log);

  // Step 3 — the vendor. Best-effort, non-fatal, never able to roll back a committed cancel.
  await tearDownRoomBestEffort(result.meeting, log);

  return { ...result, holdReleased };
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
