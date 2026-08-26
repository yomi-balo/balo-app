/**
 * BAL-134 (§5.3) — THE PRESENCE WRITE SEAM. Every `meeting_presence` row this platform writes
 * is produced here, from a server-to-server observation of Daily.
 *
 * ⚠⚠ THE BROWSER WRITES NOTHING, EVER (D1). The ticket's Technical Notes and its acceptance
 * criterion conflicted — "participant join/leave events via the Call Object" versus "all timing
 * is server-authoritative; the client renders a mirror" — and THE AC WINS. A browser-reported
 * join/leave is a MONEY INPUT supplied by a party to the transaction: a client that lies
 * inflates `billableMs`, and a client that dies silently (tab killed, lid closed, network
 * death) never reports its leave and strands an open interval that `computeMeetingClocks` then
 * measures against `now` — the exact over-bill both `meeting_presence` and `resolveClockCeiling`
 * name as THE hazard. The Call Object's own `participant-joined` / `participant-left` events
 * stay UI-ONLY in `apps/web` and are never sent here;
 * `apps/web/src/invariants/join-link-never-writes.test.ts`'s posture is preserved.
 *
 * ── THE THREE PHASES, AND WHY THEY ARE SEPARATE FUNCTIONS ────────────────────────────────
 *
 * The webhook route is one `db.transaction` whose marker insert, effect and `processed_at`
 * stamp must commit or roll back TOGETHER — a marker committed without its effect would
 * permanently suppress the retry that would have applied it. So the work is split exactly as
 * `routes/stripe/webhook.ts` splits its own:
 *
 *   1. {@link resolvePresenceEffect} — READS ONLY, OUTSIDE the transaction. Resolves identity
 *      and derives `party`. Keeping the (potentially several) authorization reads out of the
 *      transaction is what keeps it short.
 *   2. {@link applyPresenceEffect} — the write, ON THE CALLER'S EXECUTOR.
 *   3. {@link reconcileMeetingStatus} — POST-COMMIT. Status transitions, `meeting_started`
 *      analytics and the best-effort notification cancels. Never inside the transaction:
 *      enqueuing to BullMQ or PostHog must not be undone by a rollback, and the transitions are
 *      compare-and-set anyway.
 *
 * ── ⚠⚠ `party` IS A BILLING INPUT AND IS DERIVED SERVER-SIDE, ALWAYS ─────────────────────
 *
 * `meeting_presence`'s own docblock states the obligation and assigns it here by name. It is
 * the ONLY thing keeping a Balo staffer from making a meeting billable: `observer` is excluded
 * from BOTH sides of the billable intersection, so an attendee recorded as `client` instead of
 * `observer` silently converts a `no_show_client` (nothing owed) into a fully billable call.
 * It is therefore NEVER read from Daily `userData`, NEVER from a join-link query parameter, and
 * NEVER from the guest row's own `party` column — see `presencePartyForGuest`, whose
 * non-optional `inviteChannel` argument is the enforcement.
 *
 * ⚠ AND `'expert'` MEANS THE **DELIVERING CONSULTANT**, NEVER MERELY "SOMEBODY ON THE EXPERT
 * SIDE". The two identity kinds now agree: `presencePartyForGuest` maps every expert-side GUEST
 * to `observer`, and {@link partyForUser} resolves the authenticated arm from DELIVERY IDENTITY
 * (`engagements.expert_profile_id → expert_profiles.userId`) rather than from the participation
 * gate's `MANAGE_ENGAGEMENT` holder set. Read that function's docblock before changing it — the
 * gate is both too wide and too narrow for this question, in ways that cost money in opposite
 * directions.
 */
import {
  creditSessionsRepository,
  meetingGuestsRepository,
  meetingPresenceRepository,
  meetingsRepository,
  type Meeting,
  type MeetingParticipantParty,
  type PresenceWindow,
} from '@balo/db';
import { MEETING_SERVER_EVENTS, SESSION_SERVER_EVENTS, trackServer } from '@balo/analytics/server';
import { createLogger } from '@balo/shared/logging';
import {
  parseDailyParticipantId,
  presencePartyForGuest,
  type DailyParticipantKind,
} from '@balo/shared/meetings';
import { MEETING_TOKEN_TTL_AFTER_END_MS } from './meeting-liveness.js';
import { authorizeMeetingParticipation } from './authorize-meeting-participation.js';
import { deliveringExpertProfileIdForMeeting, deliveringExpertUserId } from './delivering-party.js';
import { connectSessionAsSystem } from '../credit-session/connect-session.js';
import {
  clientAbsentKey,
  expertAbsentKey,
} from '../../notifications/scheduling/meeting-absence.js';
import { cancelScheduledNotification } from '../../notifications/scheduling/schedule.js';

const log = createLogger('meeting-presence-writer');

/**
 * The repository's optional transaction executor, DERIVED from its own signature rather than
 * imported: `DbExecutor` lives in `@balo/db`'s internal `repositories/_shared/` and is not part
 * of the package's public surface. Deriving it keeps the two in lockstep with no new export —
 * the same trick `notifications/scheduling/schedule.ts` uses, and for the same reason.
 */
export type PresenceExecutor = NonNullable<Parameters<typeof meetingPresenceRepository.open>[1]>;

/** Whether the observation opens or closes an interval. */
export type PresenceAction = 'open' | 'close';

/** A resolved, ready-to-write presence observation. */
export interface PresenceEffect {
  readonly action: PresenceAction;
  readonly meetingId: string;
  /** ⚠ At most one is non-null (`meeting_presence_identity_not_both`); BOTH null is legal. */
  readonly userId: string | null;
  readonly meetingGuestId: string | null;
  /** ⚠ SERVER-DERIVED. See the module docblock. */
  readonly party: MeetingParticipantParty;
  /** The observed instant. ⚠ MAY BE AN INVALID DATE — the write seam rejects it, loudly. */
  readonly at: Date;
  /** BAL-134's R10 clamp, derived from the meeting row. */
  readonly window: PresenceWindow;
  /** For logging only — `'unknown'` is the fail-closed answer, not an error. */
  readonly identityKind: DailyParticipantKind | 'unknown';
}

/**
 * ⚠ THE R10 CLAMP, DERIVED FROM THE MEETING ROW AND SUPPLIED ON EVERY WRITE.
 *
 * `meetingPresenceRepository`'s `PresenceWindow` is OPT-IN by design — the repository resolves
 * no policy, because the upper bound is an `apps/api` constant and a repository that read it
 * would make every fixture subject to a number that can change. This function is the policy,
 * and the production path passes it on every single call.
 *
 *   · LOWER — `scheduled_start`. The ticket's rule verbatim: an expert arriving at 09:55 for a
 *     10:00 call is not credited for arriving early.
 *   · UPPER — `scheduled_end + MEETING_TOKEN_TTL_AFTER_END_MS`. **GENEROUS ON PURPOSE.** It
 *     exists to stop a nonsense timestamp (a `left_at` a day late), NOT to cap a long call: a
 *     legitimately over-running consultation must not be truncated into an UNDER-bill, and
 *     nothing terminates on `scheduled_end` (edge case 20). The settlement-side policy cap
 *     stays BAL-412's `effectiveCeilingMinor`.
 */
export function presenceWindowFor(meeting: Meeting): PresenceWindow {
  return {
    notBefore: meeting.scheduledStart,
    notAfter: new Date(meeting.scheduledEnd.getTime() + MEETING_TOKEN_TTL_AFTER_END_MS),
  };
}

/**
 * WHICH SIDE this authenticated user is on — DELIVERY IDENTITY for the expert arm, the
 * participation gate for the client arm.
 *
 * ⚠⚠ `party: 'expert'` IS THE DELIVERING CONSULTANT AND NOBODY ELSE. Read
 * `delivering-party.ts`'s header for the full argument; the short form is that
 * `authorizeMeetingParticipation`'s expert arm is `MANAGE_ENGAGEMENT`, whose holder set is the
 * delivering expert **plus their agency `owner`/`admin`** — the right ACT set and the wrong
 * BILLING set. Taking its `side` verbatim was wrong in BOTH directions at once:
 *
 *   · an agency owner who is not the consultant anchored `expertPresentMs`, disarmed the
 *     missed-call rule and started `billableMs` with nobody delivering — a direct contradiction
 *     of the AC ("an expert-side guest **or agency colleague** joining does not" start billing),
 *     and a disagreement with `presencePartyForGuest`, which already maps EVERY expert-side
 *     guest to `observer`. Two identity kinds, one money question, two answers;
 *   · a DENIAL made the delivering expert non-billable — `relationshipDeniesHosting` strips both
 *     engagement tokens after a decline, so the expert hosting a `project_discovery` call booked
 *     before that decline was recorded `observer`, `expertEverPresent` stayed false, and the
 *     missed-call rule DELETED THE DAILY ROOM WHILE BOTH PARTIES WERE ON IT.
 *
 * ⚠ THE ORDER IS DELIBERATE: delivery identity is checked FIRST, so a consultant who also holds
 * company membership on the buying side is still recorded as the person delivering. The gate is
 * consulted only to answer the client arm and to make the expert arm's rejection legible.
 *
 * ⚠ A DENIAL IS STILL `observer`, NOT AN ERROR. A Balo staffer with no membership and no host
 * capability really can be in the room (edge case 25) — present, never billable, never able to
 * end. Refusing to record them at all would lose a real attendance fact; recording them as a
 * party would make them billable.
 */
async function partyForUser(meetingId: string, userId: string): Promise<MeetingParticipantParty> {
  const authorized = await authorizeMeetingParticipation({ meetingId, userId });

  if (authorized.ok) {
    const delivering = await deliveringExpertUserId(authorized.expertProfileId);
    if (delivering === userId) {
      return 'expert';
    }
    if (authorized.side === 'client') {
      return 'client';
    }
    // An agency `owner`/`admin` sitting in on their colleague's consultation. They may ACT on
    // the meeting (that is `MANAGE_ENGAGEMENT`); they do not DELIVER it, so they bill nothing —
    // exactly the answer `presencePartyForGuest` gives their guest-identity equivalent.
    log.info(
      { meetingId, userId, side: authorized.side },
      'Expert-side actor is not the delivering consultant — recording presence as `observer`'
    );
    return 'observer';
  }

  // ⚠ THE MIRROR CASE. The gate denied, but the meeting's own context may still NAME this
  // person as its consultant — a declined request-grain relationship is exactly that shape.
  const delivering = await deliveringExpertUserId(
    await deliveringExpertProfileIdForMeeting(meetingId)
  );
  if (delivering === userId) {
    // ⚠ `error`, NOT `warn`. The participation gate and the booking disagree about who is
    // delivering this meeting, and the money reading follows the BOOKING. This is the only
    // place that disagreement is visible.
    log.error(
      { meetingId, userId },
      'Participation gate denied the DELIVERING expert of this meeting — recording presence as `expert` on the booking, and flagging the disagreement'
    );
    return 'expert';
  }
  return 'observer';
}

/**
 * WHICH SIDE this guest is on — through `presencePartyForGuest`, THE MONEY RULE.
 *
 * ⚠ NEVER FROM `guest.party` DIRECTLY. A `link`-channel row's `party` is a NOT-NULL PLACEHOLDER
 * (`claimLobbyPlace` stores `'client'` because the column demands something, not because a side
 * was resolved), and an expert-side guest is a COLLEAGUE rather than the delivering expert.
 * Both map to `observer`. The two-argument call is what makes missing this impossible: a
 * one-argument call does not compile.
 */
async function partyForGuest(meetingId: string, guestId: string): Promise<MeetingParticipantParty> {
  const guest = await meetingGuestsRepository.findLiveById(meetingId, guestId);
  if (guest === undefined) {
    return 'observer';
  }
  // ⚠ NARROWED BY GUARD, NEVER BY A CAST. `meeting_guests.party` shares the three-label
  // `meeting_participant_party` enum with `meeting_presence`, and only a DB CHECK keeps it to
  // `client | expert`. A stored `observer` cannot exist today — and if it ever did, the SAFE
  // reading is `observer` (bills nothing), which is exactly what a cast would have skipped past.
  if (guest.party === 'observer') {
    return 'observer';
  }
  return presencePartyForGuest({ party: guest.party, inviteChannel: guest.inviteChannel });
}

export interface ResolvePresenceEffectInput {
  readonly action: PresenceAction;
  readonly meeting: Meeting;
  /** The Daily `user_id` claim, or `null` when the vendor named no participant. */
  readonly participantId: string | null;
  readonly at: Date;
}

/**
 * PHASE 1 — resolve one observation into a ready-to-write effect. READS ONLY.
 *
 * ⚠ AN UNMAPPABLE PARTICIPANT ID IS A REAL ANSWER, NOT A FAILURE. `parseDailyParticipantId`
 * returns `null` for anything Balo did not mint — a bare uuid, an unknown tag, an anonymous
 * vendor id — and `meeting_presence` was explicitly designed to permit a NULL identity beside a
 * KNOWN `party` rather than force the writer to guess. A guess would anchor a billing clock on
 * the wrong person. Such a row is written `party: 'observer'` with BOTH identity columns null,
 * and is logged at `warn` because the RATE is a health signal even though each one is expected.
 */
export async function resolvePresenceEffect(
  input: ResolvePresenceEffectInput
): Promise<PresenceEffect> {
  const { meeting, participantId, at, action } = input;
  const window = presenceWindowFor(meeting);
  const identity = participantId === null ? null : parseDailyParticipantId(participantId);

  if (identity === null) {
    log.warn(
      {
        meetingId: meeting.id,
        roomName: meeting.dailyRoomName,
        kind: 'unknown',
        action,
      },
      'Daily participant id could not be mapped — recording presence with NO identity as `observer`'
    );
    return {
      action,
      meetingId: meeting.id,
      userId: null,
      meetingGuestId: null,
      party: 'observer',
      at,
      window,
      identityKind: 'unknown',
    };
  }

  if (identity.kind === 'user') {
    return {
      action,
      meetingId: meeting.id,
      userId: identity.id,
      meetingGuestId: null,
      party: await partyForUser(meeting.id, identity.id),
      at,
      window,
      identityKind: 'user',
    };
  }

  return {
    action,
    meetingId: meeting.id,
    userId: null,
    meetingGuestId: identity.id,
    party: await partyForGuest(meeting.id, identity.id),
    at,
    window,
    identityKind: 'guest',
  };
}

/** One stored `meeting_presence` row, reduced to what a CLOSE needs. */
export interface StoredPresenceIdentity {
  readonly userId: string | null;
  readonly meetingGuestId: string | null;
  /** The party ALREADY on the row. ⚠ Carried for the log line only — see below. */
  readonly party: MeetingParticipantParty;
}

/**
 * Build the effect that CLOSES an interval Balo already has, straight from the stored row.
 *
 * ⚠⚠ A CLOSE DERIVES NO PARTY, AND THAT IS A CORRECTNESS POINT BEFORE IT IS A COST ONE.
 * `meetingPresenceRepository.close` matches on IDENTITY alone (`meeting_id` + the one non-null
 * identity column, `left_at IS NULL`); `party` never reaches the `WHERE` clause and never
 * reaches the `SET`. Re-deriving it would therefore change nothing about the write while
 * introducing a way for the close path to DISAGREE with the row it is closing — and the
 * derivation is not free: it runs the full participation gate (meeting → contexts → owning
 * party → membership → engagement axis) plus a delivery-identity read, per open interval, per
 * candidate, on a job that ticks every minute over a batch of up to 200.
 *
 * The stored `party` rides along purely so the "interval closed" log line stays informative.
 */
export function closePresenceEffectForRow(
  meeting: Meeting,
  row: StoredPresenceIdentity,
  at: Date
): PresenceEffect {
  return {
    action: 'close',
    meetingId: meeting.id,
    userId: row.userId,
    meetingGuestId: row.meetingGuestId,
    party: row.party,
    at,
    window: presenceWindowFor(meeting),
    identityKind: identityKindOf(row),
  };
}

/** For the log field only. Mirrors the `meeting_presence_identity_not_both` CHECK. */
function identityKindOf(row: StoredPresenceIdentity): DailyParticipantKind | 'unknown' {
  if (row.userId !== null) return 'user';
  return row.meetingGuestId === null ? 'unknown' : 'guest';
}

/** What {@link applyPresenceEffect} did. `'noop'` is a NORMAL outcome on both actions. */
export type PresenceWriteOutcome = 'opened' | 'closed' | 'noop' | 'invalid_timestamp';

/**
 * PHASE 2 — the write, on the caller's executor.
 *
 * ⚠⚠ AN INVALID TIMESTAMP IS CAUGHT HERE AND ANSWERED, NOT THROWN, and that is the whole point
 * of the `invalid_timestamp` outcome (edge case 22). `InvalidPresenceTimestampError` is the
 * obligation `computeMeetingClocks` assigns to BAL-134 BY NAME — but letting it escape would
 * roll back the webhook's transaction INCLUDING THE MARKER, so Daily would retry the same
 * un-writable body forever. Answering instead lets the marker commit with no effect, and the
 * route acks `200`: the body will never be writable, so a retry is pure noise.
 *
 * ⚠ `close()` RETURNING `undefined` IS `'noop'`, NEVER AN ERROR. A duplicate `participant.left`
 * matches zero rows (the repository's compare-and-set is FIRST-CLOSE-WINS, so a later write can
 * never extend `left_at` and therefore can never extend a billable span), and a `left` that
 * arrives BEFORE its `joined` finds nothing open. Both are expected transport conditions,
 * bounded by the sweep's reconciliation.
 */
export async function applyPresenceEffect(
  exec: PresenceExecutor,
  effect: PresenceEffect
): Promise<PresenceWriteOutcome> {
  const identity = { userId: effect.userId, meetingGuestId: effect.meetingGuestId };
  try {
    if (effect.action === 'open') {
      const row = await meetingPresenceRepository.open(
        {
          meetingId: effect.meetingId,
          ...identity,
          party: effect.party,
          joinedAt: effect.at,
          window: effect.window,
        },
        exec
      );
      log.info(
        {
          meetingId: effect.meetingId,
          party: effect.party,
          kind: effect.identityKind,
          clamped: row.joinedAt.getTime() !== effect.at.getTime(),
        },
        'Presence interval opened'
      );
      return 'opened';
    }

    const closed = await meetingPresenceRepository.close(
      {
        meetingId: effect.meetingId,
        ...identity,
        leftAt: effect.at,
        window: effect.window,
      },
      exec
    );
    if (closed === undefined) {
      return 'noop';
    }
    log.info(
      {
        meetingId: effect.meetingId,
        party: effect.party,
        kind: effect.identityKind,
        clamped: closed.leftAt !== null && closed.leftAt.getTime() !== effect.at.getTime(),
      },
      'Presence interval closed'
    );
    return 'closed';
  } catch (error) {
    if (error instanceof Error && error.name === 'InvalidPresenceTimestampError') {
      log.error(
        {
          meetingId: effect.meetingId,
          action: effect.action,
          kind: effect.identityKind,
          error: error.message,
          stack: error.stack,
        },
        'Daily webhook carried a non-finite timestamp — refusing the presence write and acking'
      );
      return 'invalid_timestamp';
    }
    throw error;
  }
}

/** What {@link reconcileMeetingStatus} moved the meeting to, or `null` for no transition. */
export type MeetingStatusTransition = 'waiting_for_participants' | 'in_progress' | null;

/**
 * PHASE 3 — POST-COMMIT. Move the meeting's status to match the room, and arm/disarm what
 * follows from that.
 *
 * Two transitions, both compare-and-set in `@balo/db`, so two webhooks racing on the same join
 * both call this and exactly one wins:
 *
 *   · the FIRST interval opening on a `scheduled` meeting → `waiting_for_participants`;
 *   · {expert present} ∧ {≥1 client-side present} → `in_progress`, stamping `started_at` and
 *     emitting `meeting_started`.
 *
 * ⚠ `observer` COUNTS TOWARDS NEITHER SIDE OF THE `in_progress` TEST. A Balo staffer joining a
 * room the expert is already in must not start the consultation clock.
 *
 * ⚠ THE NOTIFICATION CANCELS ARE AN OPTIMISATION, NOT THE MECHANISM (R11). A `claimed` row is
 * deliberately uncancellable and a cancel can always be missed, so both promises additionally
 * carry a registered FIRE-TIME RECHECK which is the actual authority. Both cancels are
 * therefore best-effort and non-fatal: a failure here must never fail a webhook that correctly
 * recorded presence.
 */
export async function reconcileMeetingStatus(
  meeting: Meeting,
  now: Date
): Promise<MeetingStatusTransition> {
  const open = await meetingPresenceRepository.listOpen(meeting.id);
  const expertPresent = open.some((row) => row.party === 'expert');
  const clientPresent = open.some((row) => row.party === 'client');

  await cancelAbsenceReminders({ meetingId: meeting.id, expertPresent, clientPresent });

  if (expertPresent && clientPresent) {
    const started = await meetingsRepository.markInProgress(meeting.id, now);
    if (started === undefined) {
      return null;
    }
    log.info(
      { meetingId: meeting.id, from: meeting.status, to: 'in_progress', trigger: 'presence' },
      'Meeting status transition'
    );
    trackServer(MEETING_SERVER_EVENTS.MEETING_STARTED, {
      meeting_id: meeting.id,
      seconds_from_scheduled_start: Math.round(
        (now.getTime() - meeting.scheduledStart.getTime()) / 1000
      ),
      participant_count: open.length,
      // ⚠ THE MEETING ID, NOT A USER ID. There is no acting human on a system-observed
      // transition, and `trackServer` promotes `distinct_id` to PostHog's `distinctId` — the
      // same non-user shape `guest_joined` already uses with `meeting_guests.id`.
      distinct_id: meeting.id,
    });

    // ⚠⚠ BAL-466 (D6) — CONNECT THE CREDIT SESSION. This is the ORDINARY connect seam: the
    //    moment an expert and a client side are both in the room. `markInProgress` is a
    //    compare-and-set, so exactly ONE racing caller reaches this line per meeting.
    //
    //    ⚠ BEST-EFFORT AND NON-FATAL, the same posture as `cancelAbsenceReminders` above and
    //    `settleBestEffort` in `end-meeting.ts`: the meeting is already `in_progress` in
    //    Postgres, so a connect fault must never fail the Daily webhook (Daily would retry the
    //    delivery and re-drive a transition that has already happened). The meter sweep cannot
    //    recover this one, so it is an `error`, not a `warn`.
    //
    //    ⚠⚠ G3 (second review round) — NOT THE ONLY CONNECT SITE. When a CLIENT-invited GUEST
    //    (counted in `clientPresent` above) is co-present with the expert BEFORE any client
    //    MEMBER exists, this CAS fires here and finds no session to connect — the session does
    //    not exist until a client member later joins and opens it. `join-meeting.ts`'s
    //    `openCaseSessionBestEffort` covers exactly that ordering via
    //    `connectIfMeetingAlreadyInProgress`, checking the meeting's status at that later
    //    admission. The two never race each other: this CAS only ever fires ONCE per meeting.
    await connectSessionBestEffort(meeting.id, now);

    return 'in_progress';
  }

  if (open.length > 0) {
    const waiting = await meetingsRepository.markWaitingForParticipants(meeting.id);
    if (waiting === undefined) {
      return null;
    }
    log.info(
      {
        meetingId: meeting.id,
        from: 'scheduled',
        to: 'waiting_for_participants',
        trigger: 'presence',
      },
      'Meeting status transition'
    );
    return 'waiting_for_participants';
  }

  return null;
}

/**
 * BAL-466 (D6) — connect this meeting's credit session, if it has one.
 *
 * ⚠ INERT FOR EVERY MEETING WITHOUT ONE — `findIdByMeetingId` answers `undefined` for every
 * intro call, discovery call and unfunded Case, and this returns after ONE indexed read.
 *
 * ⚠ A SESSION THAT NEVER CONNECTS IS NOT BROKEN. `SETTLE_FROM_PRESENCE_FROM` includes
 * `pending` precisely so a client no-show settles correctly, and `findStalePending` excludes
 * `duration_source='presence'` so nothing cancels it. A failure here costs the LIVE meter and
 * the in-call ladder for that call, never the settlement.
 */
async function connectSessionBestEffort(meetingId: string, now: Date): Promise<void> {
  try {
    const found = await creditSessionsRepository.findIdByMeetingId(meetingId);
    if (found === undefined) return;

    const session = await connectSessionAsSystem(found.id, { now });

    // BAL-466 (D7) — `session_started` fires HERE, server-side, at the real connect seam.
    trackServer(SESSION_SERVER_EVENTS.SESSION_STARTED, {
      session_id: session.id,
      meeting_id: meetingId,
      expert_profile_id: session.expertProfileId,
      // ⚠ THE MARKED-UP CLIENT RATE — never `expertRateMinorPerMinute` and never `baloFeeBps`.
      rate_per_minute_minor: session.clientRateMinorPerMinute,
      // ⚠ = company_id. There is no acting human on a system-observed transition.
      distinct_id: session.companyId,
    });
  } catch (error) {
    log.error(
      {
        meetingId,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      },
      'Credit session could not be connected at co-presence — the call is not metering'
    );
  }
}

/**
 * Best-effort disarm of the two absence promises. ⚠ NEVER FATAL — see
 * {@link reconcileMeetingStatus}'s last paragraph. Wrapped as ONE helper rather than two
 * try/catch blocks so the "cancel is an optimisation" reasoning has a single home.
 */
async function cancelAbsenceReminders(input: {
  meetingId: string;
  expertPresent: boolean;
  clientPresent: boolean;
}): Promise<void> {
  const keys: string[] = [];
  if (input.expertPresent) {
    keys.push(expertAbsentKey(input.meetingId));
  }
  if (input.clientPresent) {
    keys.push(clientAbsentKey(input.meetingId));
  }

  for (const key of keys) {
    try {
      await cancelScheduledNotification(key);
    } catch (error) {
      log.warn(
        {
          meetingId: input.meetingId,
          key,
          error: error instanceof Error ? error.message : String(error),
        },
        'Best-effort absence-reminder cancel failed — the fire-time recheck remains the authority'
      );
    }
  }
}
