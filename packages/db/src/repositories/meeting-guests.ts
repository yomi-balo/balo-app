import { and, asc, eq, gt, inArray, isNull, ne, sql } from 'drizzle-orm';
import { db } from '../client';
import { meetingGuests, meetings } from '../schema';
import type {
  GuestAccessScope,
  Meeting,
  MeetingGuest,
  MeetingGuestAdmission,
  MeetingGuestInviteChannel,
  MeetingParticipantParty,
  MeetingParticipationRole,
} from '../schema';
import { auditEventsRepository } from './audit-events';
import { extendGuestExpiryForMeetingTx } from './_shared/guest-expiry';

const ENTITY_TYPE = 'meeting_guest';

/** The two sides a guest can sit on — narrower than the reused three-label presence enum. */
export type MeetingGuestParty = Extract<MeetingParticipantParty, 'client' | 'expert'>;

/** The two terminal admission decisions a host can take. */
export type MeetingGuestAdmissionDecision = Extract<MeetingGuestAdmission, 'admitted' | 'denied'>;

/** One guest inside an invite batch. Every field is decided by the CALLER — see `createMany`. */
export interface CreateMeetingGuestInput {
  /**
   * ⚠ MUST ALREADY BE LOWERCASED AND TRIMMED. `@balo/db` never normalises input (the
   * `party_domains` / `proposal_share_links` convention), and
   * `meeting_guest_meeting_email_live_idx` matches the stored bytes — so a caller that
   * skips normalisation silently permits `Dana@x.com` alongside `dana@x.com`.
   */
  email: string;
  name: string | null;
  /** The domain snapshot backing the `accessScope` grant. Derived by the caller from `email`. */
  emailDomain: string | null;
  /** ⚠ DERIVED FROM THE ACTOR'S RESOLVED SIDE, never from request input. */
  party: MeetingGuestParty;
  participationRole: MeetingParticipationRole;
  /** ⚠ COMPUTED BY THE SERVICE at invite time; this is the stored record of the grant. */
  accessScope: GuestAccessScope;
  inviteChannel: MeetingGuestInviteChannel;
  /**
   * `pre_admitted` for an email invite. `pending` is the lobby queue — whose real producer
   * is `claimLobbyPlace` (BAL-132), not this batch insert.
   */
  admission: Extract<MeetingGuestAdmission, 'pre_admitted' | 'pending'>;
  /** SHA-256 hex of the raw token. ⚠ The RAW token is never passed here or persisted. */
  tokenHash: string;
  /** `meetings.scheduled_end + GUEST_TOKEN_TTL_AFTER_END_MS`. There is NO SQL default. */
  expiresAt: Date;
}

export interface CreateMeetingGuestsInput {
  meetingId: string;
  /** ATTRIBUTION — the person who invited. Stored on every row in the batch. */
  invitedById: string;
  guests: CreateMeetingGuestInput[];
}

export interface RevokeMeetingGuestInput {
  guestId: string;
  /** ATTRIBUTION — the person who removed them. */
  revokedByUserId: string;
}

export interface DecideMeetingGuestAdmissionInput {
  guestId: string;
  decision: MeetingGuestAdmissionDecision;
  /** ATTRIBUTION — the host who admitted or denied. */
  deciderUserId: string;
}

/**
 * BAL-436 — re-issue one guest's join credential. Every field is decided by the CALLER.
 *
 * ⚠ THERE IS NO `meetingId` HERE, unlike `findLiveById`, and that is deliberate rather than
 * an omission: the caller has ALREADY resolved this row through `findLiveById(meetingId, …)`
 * behind the tenancy gate, so re-scoping would be a second expression of a check that already
 * passed. The `id` predicate plus the two liveness predicates are what this statement needs.
 */
export interface RotateMeetingGuestTokenInput {
  /**
   * ⚠⚠ **THE TENANCY SCOPE, AND IT IS NOT OPTIONAL.** This platform has NO RLS — the `WHERE`
   * clause IS the boundary. A rotate keyed on `guestId` alone would mint a live credential
   * onto any guest row in the database given only its uuid, from any caller that reached this
   * method. It is contained TODAY only because `resendGuestJoinLink` happens to re-read the
   * row through the meeting-scoped `findLiveById` first — i.e. by a caller's discipline rather
   * than by this method's own shape. BAL-442's guest-facing arm inherits this primitive.
   */
  meetingId: string;
  guestId: string;
  /** SHA-256 hex of the NEW raw token. ⚠ The RAW token is never passed here or persisted. */
  tokenHash: string;
  /** `meetings.scheduled_end + GUEST_TOKEN_TTL_AFTER_END_MS`, recomputed by the caller. */
  expiresAt: Date;
  /** ATTRIBUTION — the host who re-sent the link. */
  rotatedByUserId: string;
}

/**
 * One anonymous LOBBY KNOCK (BAL-132, Decisions 3–6 + 10). Every field is decided by the
 * CALLER — this repository derives nothing from request input.
 *
 * ⚠ THERE IS NO `invitedById` HERE, AND THAT ABSENCE IS THE POINT. A self-claimed visitor
 * has no inviter, so the column is written NULL (migration 0064 relaxed its NOT NULL). The
 * invite path keeps `CreateMeetingGuestsInput.invitedById: string`, so only this method can
 * produce a null-inviter row.
 *
 * ⚠ `inviteChannel`, `admission` and `participationRole` are ABSENT TOO, on the same
 * reasoning inverted: they are not caller policy, they are what "self-claim" MEANS. The
 * method hardcodes `link` / `pending` / `guest`. A caller that could pass `email` or
 * `pre_admitted` here would be able to mint a trust-by-default participant with no inviter
 * — i.e. skip the admission queue entirely — which is the single control this whole table
 * exists to enforce. (A `delegate` is likewise unrepresentable: a delegate attends INSTEAD
 * of the booker, which is a thing only an inviter can decide.)
 */
export interface ClaimLobbyPlaceInput {
  meetingId: string;
  /**
   * ⚠ MUST ALREADY BE LOWERCASED AND TRIMMED — the same contract
   * `CreateMeetingGuestInput.email` carries, and it is load-bearing HERE in a way it is not
   * there: `meeting_guest_meeting_email_live_idx` is the ONLY bound on one visitor spamming
   * N pending rows into a host's queue, and it matches the STORED BYTES. A caller that
   * skips normalisation turns the queue cap into a formality.
   */
  email: string;
  /** What the host reads in the queue. Self-declared, therefore never trusted for anything else. */
  name: string | null;
  /** The domain snapshot. Derived by the caller from `email`. */
  emailDomain: string | null;
  /**
   * ⚠ A PLACEHOLDER, NOT A RESOLVED SIDE (Decision 3 / A1.1). A bare meeting URL carries no
   * sharer identity, so there is no server-side signal for which side a knock is on; the
   * service passes `client` because `party` is NOT NULL and CHECK-narrowed to two labels.
   * **It must never anchor money.** `presencePartyForGuest` (`@balo/shared/meetings`) maps a
   * `link`-channel guest to presence `observer` regardless of what is stored here.
   */
  party: MeetingGuestParty;
  /** The grant record, computed by the service. `meeting` for a lobby knock. */
  accessScope: GuestAccessScope;
  /** SHA-256 hex of the raw token. ⚠ The RAW token is never passed here or persisted. */
  tokenHash: string;
  /** `meetings.scheduled_end + GUEST_TOKEN_TTL_AFTER_END_MS`. There is NO SQL default. */
  expiresAt: Date;
}

/** A resolved live token: the guest AND the meeting it lets them into, in one round trip. */
export interface MeetingGuestWithMeeting {
  guest: MeetingGuest;
  meeting: Meeting;
}

/**
 * The roster projection. ⚠ DELIBERATELY EXCLUDES `token_hash`, `expires_at`,
 * `access_count`, `last_accessed_at` and every revocation/admission ATTRIBUTION column —
 * none of those may leave `@balo/db` on a read path that can reach a route (memory
 * `reference_drizzle_with_hydration_leaks_secrets`).
 *
 * ⚠ `email` and `accessScope` ARE here, and they are NOT safe to hand to an arbitrary
 * viewer: the counterparty-concealment rule is that NAMES cross the party boundary and
 * EMAIL ADDRESSES NEVER (an `accessScope` of `engagement` encodes a domain match, i.e. a
 * fact about the address). The api route MUST pass every row through
 * `projectGuestForViewer` (`@balo/shared/meetings`) before serialising.
 */
export interface MeetingGuestPublic {
  id: string;
  meetingId: string;
  userId: string | null;
  email: string;
  emailDomain: string | null;
  name: string | null;
  party: MeetingParticipantParty;
  participationRole: MeetingParticipationRole;
  accessScope: GuestAccessScope;
  inviteChannel: MeetingGuestInviteChannel;
  admission: MeetingGuestAdmission;
  admissionDecidedAt: Date | null;
  /**
   * ⚠ NULL ON A SELF-CLAIMED LOBBY ROW (migration 0064). Every reader must branch — there
   * is no inviter to name for someone who let themselves into the queue.
   */
  invitedById: string | null;
  createdAt: Date;
}

const PUBLIC_COLUMNS = {
  id: meetingGuests.id,
  meetingId: meetingGuests.meetingId,
  userId: meetingGuests.userId,
  email: meetingGuests.email,
  emailDomain: meetingGuests.emailDomain,
  name: meetingGuests.name,
  party: meetingGuests.party,
  participationRole: meetingGuests.participationRole,
  accessScope: meetingGuests.accessScope,
  inviteChannel: meetingGuests.inviteChannel,
  admission: meetingGuests.admission,
  admissionDecidedAt: meetingGuests.admissionDecidedAt,
  invitedById: meetingGuests.invitedById,
  createdAt: meetingGuests.createdAt,
} as const;

/**
 * `meetingGuestsRepository` (BAL-408 / ADR-1044) — the store behind the guest participation
 * model and the `/join/{token}` magic-link landing.
 *
 * ⚠ THIS REPOSITORY NEVER HASHES A TOKEN, and no production file under `packages/db/src`
 * imports `node:crypto` for it (only the test factory does). `apps/api` mints the raw token
 * and its SHA-256 hex; only the HASH crosses into `@balo/db`. The reason is the Drizzle
 * query-logging hook in `client.ts`, which would capture a raw secret passed as a bind
 * parameter — verbatim the `review_invite_tokens` / `proposal_share_links` ruling. Do not
 * move hashing in here.
 *
 * ⚠ NO METHOD HERE AUTHORIZES ANYTHING. Resolving a token is an IDENTITY CLAIM; deciding
 * whether the caller may invite, remove, admit or deny is the api service's job, on two
 * axes (membership for the client side, ADR-1046's engagement axis for the expert side).
 */
export const meetingGuestsRepository = {
  /**
   * Insert a whole invite batch in ONE transaction, with one immutable
   * `meeting_guest.invited` audit row per guest, so the rows and their audit trail commit
   * or roll back together.
   *
   * A duplicate live `(meeting_id, party, email)` raises `23505` on
   * `meeting_guest_meeting_email_live_idx` — the caller maps it to `guest_already_invited`
   * rather than pre-checking, because a pre-check races under READ COMMITTED.
   *
   * ⚠ THE KEY IS PARTY-SCOPED SO THAT 23505 CANNOT ANSWER A QUESTION ABOUT THE OTHER SIDE.
   * A collision is only ever with a row the caller's own party already owns; see the index's
   * comment in `schema/guests.ts` for why a cross-party 409 would be an email-existence
   * oracle.
   *
   * ⚠ The audit metadata records the GRANT (who, what scope, which side) and NEVER the
   * token hash. The hash is the only secret-adjacent value on the row and an audit row is
   * a durable, widely-readable record.
   */
  createMany: async (input: CreateMeetingGuestsInput): Promise<MeetingGuest[]> => {
    if (input.guests.length === 0) {
      return [];
    }

    return db.transaction(async (tx) => {
      const rows = await tx
        .insert(meetingGuests)
        .values(
          input.guests.map((guest) => ({
            meetingId: input.meetingId,
            invitedById: input.invitedById,
            email: guest.email,
            name: guest.name,
            emailDomain: guest.emailDomain,
            party: guest.party,
            participationRole: guest.participationRole,
            accessScope: guest.accessScope,
            inviteChannel: guest.inviteChannel,
            admission: guest.admission,
            tokenHash: guest.tokenHash,
            expiresAt: guest.expiresAt,
          }))
        )
        .returning();

      if (rows.length !== input.guests.length) {
        throw new Error('meeting_guests insert returned an unexpected row count');
      }

      for (const row of rows) {
        await auditEventsRepository.record(
          {
            actorUserId: input.invitedById,
            action: 'meeting_guest.invited',
            entityType: ENTITY_TYPE,
            entityId: row.id,
            metadata: {
              meetingId: row.meetingId,
              email: row.email,
              party: row.party,
              participationRole: row.participationRole,
              accessScope: row.accessScope,
              inviteChannel: row.inviteChannel,
            },
          },
          tx
        );
      }

      return rows;
    });
  },

  /**
   * Resolve a token hash to its guest AND meeting — but ONLY if the guest is currently
   * usable and the meeting is still joinable.
   *
   * ⚠ RETURNS `undefined` IDENTICALLY, AND THAT UNIFORMITY IS THE CONTRACT — for a WRONG,
   * EXPIRED, REVOKED, SOFT-DELETED or DENIED token, and for a token whose meeting is
   * SOFT-DELETED or CANCELLED. The landing renders ONE identical "link is no longer active"
   * card for every one of them, so the response is never an oracle for whether a token ever
   * existed. Verbatim the `review_invite_tokens` / `proposal_share_links` contract.
   *
   * ⚠ AN `ended` MEETING STILL RESOLVES, deliberately, and the asymmetry with the MUTATION
   * gate (which refuses `ended`) is intentional: an ended meeting's link is the guest's only
   * handle on the recap BAL-388 will attach to it, whereas inviting someone to a call that
   * already happened is meaningless. Both directions are pinned by tests — do not "tidy"
   * either one into agreeing with the other.
   *
   * Rides the NON-PARTIAL unique `meeting_guest_token_hash_idx`.
   */
  findLiveByTokenHash: async (tokenHash: string): Promise<MeetingGuestWithMeeting | undefined> => {
    const [row] = await db
      .select({ guest: meetingGuests, meeting: meetings })
      .from(meetingGuests)
      .innerJoin(meetings, eq(meetings.id, meetingGuests.meetingId))
      .where(
        and(
          eq(meetingGuests.tokenHash, tokenHash),
          isNull(meetingGuests.deletedAt),
          isNull(meetingGuests.revokedAt),
          gt(meetingGuests.expiresAt, sql`now()`),
          ne(meetingGuests.admission, 'denied'),
          isNull(meetings.deletedAt),
          ne(meetings.status, 'cancelled')
        )
      );
    return row;
  },

  /**
   * The LIVE roster for a meeting, oldest first. NEVER projects `token_hash` — see
   * `MeetingGuestPublic`, and pass every row through `projectGuestForViewer` before it
   * reaches a viewer of the other party. Rides `meeting_guest_meeting_live_idx`.
   */
  listLiveByMeeting: async (meetingId: string): Promise<MeetingGuestPublic[]> => {
    return db
      .select(PUBLIC_COLUMNS)
      .from(meetingGuests)
      .where(
        and(
          eq(meetingGuests.meetingId, meetingId),
          isNull(meetingGuests.deletedAt),
          isNull(meetingGuests.revokedAt)
        )
      )
      .orderBy(asc(meetingGuests.createdAt), asc(meetingGuests.id));
  },

  /**
   * The participant-cap input (`MAX_MEETING_PARTICIPANTS`): guests who HOLD A SEAT. A COUNT,
   * so the cap check never materialises rows — and index-only on
   * `meeting_guest_meeting_live_idx`.
   *
   * ── ⚠⚠ WHAT COUNTS AS A SEAT, AND WHY THE PREDICATE IS NARROWER THAN "LIVE" (BAL-132) ───
   *
   * An earlier version filtered ONLY `deleted_at` / `revoked_at`, which was correct while
   * `pre_admitted` was the only admission any writer could produce. BAL-132's lobby makes
   * `pending` and `denied` reachable, and under the old predicate BOTH consumed capacity
   * permanently:
   *
   *   · a DENIED knock kept its seat forever — at the time, `decideAdmission` stamped
   *     `admission` and `admission_decided_at` and NOT `revoked_at`, so the row stayed "live"
   *     for this count. (It stamps `revoked_at` on a denial NOW — see that method — which
   *     means this exclusion is belt AND braces rather than the only thing holding;
   *     `admission IN (…)` remains the rule that MEANS it, and `revoked_at IS NULL` alone
   *     would still count a `pending` row.)
   *   · a PENDING knock consumed a seat before any host had agreed to give it one;
   *   · an EXPIRED row kept its seat, because the count ignored `expires_at`.
   *
   * The consequence was NOT confined to the lobby: `inviteGuests` shares this counter, so ten
   * anonymous knocks from one address would have left the HOST unable to invite anyone by
   * email, with no way to clear it — denying them did not help. Hence the three extra
   * predicates. **`admission IN ('pre_admitted','admitted')` is the positive form of the
   * rule**: a seat is held by somebody who is trusted by default or whom a host has said yes
   * to. Waiting is not holding, and being refused is not holding.
   *
   * ⚠ THE ANONYMOUS QUEUE IS BOUNDED SEPARATELY, by {@link countPendingLobbyKnocks}, NOT by
   * widening this one back out. Two different resources with two different limits: seats in
   * the room, and slots in the admit/deny panel.
   *
   * ⚠ REVOKED/SOFT-DELETED ROWS ARE **ALSO** EXCLUDED (unchanged) — `revoke` stamps both, so
   * a removed guest frees their seat immediately. A DENIAL stamps `revoked_at` too (but not
   * `deleted_at`), so it is excluded twice over.
   *
   * ⚠ THE CAP IS A PRODUCT NUMBER, NOT A SAFETY PROPERTY, AND THIS COUNT IS UNSYNCHRONISED
   * WITH THE INSERT — stated plainly because an earlier version of this note claimed the
   * opposite. The service calls this on its OWN connection and then calls `createMany`,
   * which opens a SEPARATE transaction; nothing serialises the two. Two inviters at 9/10
   * therefore both read 9 and both commit, and the meeting ends up at 11.
   *
   * That is ACCEPTED, not overlooked: the cap exists so the invite composer can say
   * "{n} of 10" and refuse the obvious 11th, and Daily is not being asked to enforce it
   * either (`rooms.ts` posts no `max_participants`). Do NOT invent an advisory lock, and do
   * NOT re-add a claim that the count is transactional with the write — the only honest
   * ways to make it true would be to move the cap constant into `@balo/db` (a new
   * dependency direction, and a second definition of a product number) or to lock the
   * meeting row on every invite.
   */
  countLiveByMeeting: async (meetingId: string): Promise<number> => {
    const [row] = await db
      .select({ count: sql<number>`cast(count(*) as int)` })
      .from(meetingGuests)
      .where(
        and(
          eq(meetingGuests.meetingId, meetingId),
          isNull(meetingGuests.deletedAt),
          isNull(meetingGuests.revokedAt),
          // ⚠ A SEAT IS HELD ONLY BY A TRUSTED-BY-DEFAULT INVITEE OR AN ADMITTED GUEST.
          // `pending` has not been given one yet; `denied` never will be.
          inArray(meetingGuests.admission, ['pre_admitted', 'admitted']),
          // ⚠ AND AN EXPIRED HANDLE HOLDS NOTHING. `findLiveByTokenHash` already refuses to
          // resolve one, so counting it would reserve a seat nobody can occupy.
          gt(meetingGuests.expiresAt, sql`now()`)
        )
      );
    return row?.count ?? 0;
  },

  /**
   * How many ANONYMOUS KNOCKS are queued on this meeting, awaiting an admit/deny (BAL-132).
   *
   * ⚠⚠ A SECOND, SEPARATE RESOURCE FROM {@link countLiveByMeeting}, AND THAT SEPARATION IS
   * THE POINT. Before this existed the knock queue and the participant roster shared one
   * counter, so filling the queue from a forwarded URL also exhausted the HOST's ability to
   * invite anybody by email. Seats and queue slots are now bounded independently: a flood of
   * knocks can make the queue refuse further knocks, and can do nothing else.
   *
   * ⚠ SCOPED TO `invite_channel = 'link'`, NOT TO `pending` ALONE. `claimLobbyPlace` is the
   * only writer that produces a `pending` LINK row, so this counts exactly the anonymous
   * self-claim queue and cannot be inflated (or starved) by a future email-channel feature
   * that legitimately wants a pending state of its own.
   *
   * ⚠ A DENY FREES A SLOT IMMEDIATELY — `decideAdmission` moves `admission` off `pending` and,
   * on a denial, stamps `revoked_at` in the SAME statement, so the row drops out of this
   * predicate twice over, with no second write and no sweep. So does an admit (the guest now
   * holds a seat instead), a revoke, and the passage of `expires_at`.
   *
   * Unsynchronised with the insert for the same reason `countLiveByMeeting` is; the queue
   * bound is a spam control, not a safety property.
   */
  countPendingLobbyKnocks: async (meetingId: string): Promise<number> => {
    const [row] = await db
      .select({ count: sql<number>`cast(count(*) as int)` })
      .from(meetingGuests)
      .where(
        and(
          eq(meetingGuests.meetingId, meetingId),
          isNull(meetingGuests.deletedAt),
          isNull(meetingGuests.revokedAt),
          eq(meetingGuests.admission, 'pending'),
          eq(meetingGuests.inviteChannel, 'link'),
          gt(meetingGuests.expiresAt, sql`now()`)
        )
      );
    return row?.count ?? 0;
  },

  /**
   * One LIVE guest, scoped by meeting. The `meetingId` argument is NOT redundant: it is the
   * tenancy scope the caller has already been authorized for, so a guest id belonging to a
   * different meeting resolves to `undefined` rather than to someone else's row.
   */
  findLiveById: async (meetingId: string, guestId: string): Promise<MeetingGuest | undefined> => {
    const [row] = await db
      .select()
      .from(meetingGuests)
      .where(
        and(
          eq(meetingGuests.id, guestId),
          eq(meetingGuests.meetingId, meetingId),
          isNull(meetingGuests.deletedAt),
          isNull(meetingGuests.revokedAt)
        )
      );
    return row;
  },

  /**
   * Remove a guest: stamp `revoked_at` + `revoked_by_user_id` + `deleted_at` in ONE
   * transaction and append a `meeting_guest.removed` audit row.
   *
   * Revocation is IMMEDIATE AND TOTAL — every read path re-checks `revoked_at IS NULL`, so
   * a link already in an inbox stops resolving on the next click. Both stamps vacate
   * `meeting_guest_meeting_email_live_idx`, which is what makes the same person
   * RE-INVITABLE with a fresh token (the `reference_softdelete_nonpartial_unique_recreate`
   * regression, covered by an integration test).
   *
   * Idempotent: returns `undefined` when the guest was missing, already revoked or already
   * soft-deleted — and then writes NO audit row.
   */
  revoke: async (input: RevokeMeetingGuestInput): Promise<MeetingGuest | undefined> => {
    return db.transaction(async (tx) => {
      const [row] = await tx
        .update(meetingGuests)
        .set({
          revokedAt: sql`now()`,
          revokedByUserId: input.revokedByUserId,
          deletedAt: sql`now()`,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(meetingGuests.id, input.guestId),
            isNull(meetingGuests.deletedAt),
            isNull(meetingGuests.revokedAt)
          )
        )
        .returning();

      if (row === undefined) {
        return undefined;
      }

      await auditEventsRepository.record(
        {
          actorUserId: input.revokedByUserId,
          action: 'meeting_guest.removed',
          entityType: ENTITY_TYPE,
          entityId: row.id,
          metadata: { meetingId: row.meetingId, party: row.party },
        },
        tx
      );

      return row;
    });
  },

  /**
   * `pending` → `admitted` | `denied`, stamping `admission_decided_at` and
   * `admitted_by_user_id` in the SAME statement — which is what
   * `meeting_guest_admission_terminal_stamped` and `meeting_guest_admission_attributed`
   * require, and why the transition cannot be half-written.
   *
   * (⚠ An earlier version of this docblock named a CHECK `meeting_guest_admission_decided_pair`.
   * NO SUCH CONSTRAINT HAS EVER EXISTED — it appeared in prose only, in no migration SQL.
   * The two named above are the real pair; see `schema/guests.ts`.)
   *
   * Returns `undefined` when the row is not `pending` (already decided, `pre_admitted`,
   * revoked, soft-deleted, or absent) — the caller maps that to `409 guest_not_pending`.
   * The `admission = 'pending'` predicate makes this a compare-and-set, so two racing hosts
   * cannot both record a decision. ⚠ THAT PREDICATE MUST STAY INSIDE THE TRANSACTION AND
   * INSIDE THE `UPDATE`'s OWN `WHERE`: hoisting it into a read-then-write would reintroduce
   * exactly the double-decision race it exists to close.
   *
   * ── THE ADR-1030 AUDIT OBLIGATION, DISCHARGED (BAL-132) ────────────────────────────────
   * BAL-408 shipped this transition with NO `audit_events` row, accepted ONLY for the window
   * in which nothing could produce a `pending` guest, and the ticket owner RULED on
   * 2026-08-10 that BAL-132 must close it when it makes admit/deny reachable. It is closed
   * here: the update and a `meeting_guest.admitted` / `meeting_guest.denied` row now commit
   * or roll back TOGETHER, matching `revoke`'s shape and distinguishing the two decisions.
   * ADR-1030 was deliberately NOT amended — the deviation is ended, not blessed.
   *
   * Two things that ruling turned on, restated so nobody "simplifies" them back out:
   *   1. `createMany` and `revoke` — the sibling acts in this same guest lifecycle — both
   *      write `audit_events`. Admit/deny being the only silent transition was an
   *      inconsistency, not a design.
   *   2. The on-row triple (`admission` + `admission_decided_at` + `admitted_by_user_id`) is
   *      STATE, not HISTORY. An admin reconstructing a disputed call queries `audit_events`.
   *
   * ⚠ THE NO-OP WRITES NO AUDIT ROW. `undefined` is returned BEFORE the audit call, exactly
   * as `revoke` does: a durable record of a transition that did not happen is worse than
   * none, and it would make the loser of a two-host race indistinguishable from the winner.
   *
   * ⚠ The audit metadata NEVER carries `token_hash` — same rule as `createMany`.
   *
   * ── ⚠⚠ A DENIAL ALSO STAMPS `revoked_at`, AND THAT IS THE WHOLE POINT OF THIS BLOCK ─────
   *
   * An earlier cut stamped ONLY `admission` / `admission_decided_at` / `admitted_by_user_id`,
   * and the residual it left was documented as "the visitor is locked out until the row is
   * denied, revoked or expires". **THAT SENTENCE WAS FALSE IN TWO OF ITS THREE CLAUSES.**
   * `meeting_guest_meeting_email_live_idx` is partial on
   * `deleted_at IS NULL AND revoked_at IS NULL` and on NOTHING ELSE — it has no `admission`
   * predicate and no `expires_at` predicate, and **expiry does not vacate a unique index at
   * all**. So a denied (or still-pending) row held that `(meeting, party, email)` slot
   * FOREVER, and three things followed, all of them newly reachable because BAL-132 is the
   * first producer of `pending` / `link` rows:
   *
   *   1. A host who denied `alice@acme.com` and then tried to invite Alice PROPERLY got
   *      `23505` → `409 guest_already_invited` — an answer that was simply untrue, with no
   *      recovery path anywhere in the product.
   *   2. `claimLobbyPlace` writes the placeholder `party: 'client'`, so a knock lands in the
   *      CLIENT-side slot — and `removeGuest`'s same-party rule means an EXPERT-side host
   *      could not clear it at all. The one person with `host_meetings` was the one person
   *      who could not undo it.
   *   3. Anyone holding a meeting uuid could therefore burn any guessed address's client-side
   *      invite slot permanently. A griefing primitive, not merely an untidy state.
   *
   * Stamping `revoked_at` (+ its `revoked_by_user_id` attribution, which
   * `meeting_guest_revocation_attributed` permits and in fact requires to be paired this way)
   * drops the row out of that partial index the instant a host says no, so the address is
   * re-invitable and re-knockable immediately.
   *
   * ⚠ NO READ PATH CHANGES SHAPE. `findLiveByTokenHash` already excluded `denied` AND
   * `revoked_at IS NOT NULL`, and `countLiveByMeeting` already excluded both — so the denied
   * bearer's own token was already dead and their seat already freed. This adds nothing to
   * what a denied person can do.
   *
   * ⚠⚠ IT DOES CHANGE ONE READ, AND THE CONSEQUENCE IS ACCEPTED RATHER THAN OVERLOOKED: a
   * denied row now drops out of `listLiveByMeeting`, so **BAL-436's panel will not show
   * denied entries in the roster**. The durable record is the `meeting_guest.denied`
   * `audit_events` row written two statements below, which is where a disputed decision is
   * reconstructed from anyway (see the STATE-not-HISTORY note above). A roster that keeps
   * refused strangers visible forever is noise; an invite gate that can never be cleared is a
   * defect. This trades the first for the second deliberately.
   *
   * ⚠ AND IT IS **NOT** A SOFT DELETE. `deleted_at` stays NULL, unlike `revoke`, so the two
   * are still distinguishable on the row itself:
   *   · REMOVED  → `deleted_at IS NOT NULL AND revoked_at IS NOT NULL`
   *   · DENIED   → `deleted_at IS NULL     AND revoked_at IS NOT NULL AND admission='denied'`
   *
   * ⚠ DENIAL IS STILL NOT A DURABLE IDENTITY BAN (Decision 10, already accepted). A denied
   * person CAN now re-knock with the same address, exactly as they could always re-knock with
   * a different one. That is consistent with the shipped design, not a regression from it: a
   * bare link plus a self-declared address cannot support an identity ban, and the property
   * that actually matters is untouched — the room is `privacy: 'private'`, so a second knock
   * still mints nothing without a second explicit host admit.
   */
  decideAdmission: async (
    input: DecideMeetingGuestAdmissionInput
  ): Promise<MeetingGuest | undefined> => {
    const isDenial = input.decision === 'denied';
    return db.transaction(async (tx) => {
      const [row] = await tx
        .update(meetingGuests)
        .set({
          admission: input.decision,
          admissionDecidedAt: sql`now()`,
          admittedByUserId: input.deciderUserId,
          // ⚠⚠ ONLY ON A DENIAL, and it is what vacates
          // `meeting_guest_meeting_email_live_idx` so the address stays invitable. See the
          // docblock — an admit must NOT stamp this, because an admitted guest holds a seat
          // and every "live" read is predicated on `revoked_at IS NULL`.
          ...(isDenial ? { revokedAt: sql`now()`, revokedByUserId: input.deciderUserId } : {}),
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(meetingGuests.id, input.guestId),
            eq(meetingGuests.admission, 'pending'),
            isNull(meetingGuests.deletedAt),
            isNull(meetingGuests.revokedAt)
          )
        )
        .returning();

      if (row === undefined) {
        return undefined;
      }

      await auditEventsRepository.record(
        {
          actorUserId: input.deciderUserId,
          action: input.decision === 'admitted' ? 'meeting_guest.admitted' : 'meeting_guest.denied',
          entityType: ENTITY_TYPE,
          entityId: row.id,
          metadata: {
            meetingId: row.meetingId,
            party: row.party,
            decision: row.admission,
            inviteChannel: row.inviteChannel,
          },
        },
        tx
      );

      return row;
    });
  },

  /**
   * ONE ANONYMOUS LOBBY KNOCK — **INSERT-ONLY** (BAL-132, Decisions 5, 6 and 10). The first
   * producer of `invite_channel = 'link'` AND of `admission = 'pending'` on the platform.
   *
   * Writes a row with a NULL `invited_by_id` (nobody invited them), `invite_channel = 'link'`
   * (the enum label already means exactly this — "the link was forwarded or shared, hence the
   * waiting-to-join queue"), `admission = 'pending'`, `participation_role = 'guest'`, and
   * `admission_decided_at` left NULL — which `meeting_guest_admission_terminal_stamped`
   * requires for a non-terminal admission, both directions.
   *
   * ── THE `ON CONFLICT` ARBITER IS A PARTIAL INDEX, AND THAT IS THE RISKIEST LINE HERE ────
   * `meeting_guest_meeting_email_live_idx` is PARTIAL
   * (`deleted_at IS NULL AND revoked_at IS NULL`), so the arbiter predicate must MATCH IT
   * EXACTLY or Postgres cannot infer the index and raises
   * `42P10 there is no unique or exclusion constraint matching the ON CONFLICT specification`
   * (memory `reference_pg_partial_index_arbiter_param_42p10`).
   *
   * ⚠ IT IS WRITTEN AS RAW `sql`, NOT AS DRIZZLE `isNull()` CALLS, AND THAT IS DELIBERATE
   * EVEN THOUGH BOTH WOULD WORK TODAY. `isNull()` emits no bind parameter, so today's
   * two-clause predicate would happen to infer. The moment anyone adds a LITERAL to that
   * index predicate, the Drizzle form starts emitting a `$n` — and an arbiter containing a
   * bind parameter can never match a partial index, so the failure would arrive as a runtime
   * 42P10 on a path CI reaches only through this one test. Matching `conversations.ts`'s
   * `ensureForContext` precedent costs nothing and stays correct through that change.
   *
   * ── ⚠⚠ IT NEVER TOUCHES AN INCUMBENT ROW. `DO NOTHING`, NOT `DO UPDATE` (BAL-132 fix) ──
   *
   * The first cut rotated a live `pending` row's `token_hash`, `name` and `expires_at` so
   * that the same person reloading the lobby would not 409 or spawn a second queue entry.
   * **That was a credential-hijack primitive**, and it is removed.
   *
   * A knock carries NO proof of identity — only a meeting id, a self-declared name and a
   * self-declared address. So "the same person reloading" and "a stranger who guessed a
   * colleague's address" are THE SAME REQUEST, byte for byte, and any rule that serves the
   * first necessarily serves the second. Rotation therefore let a stranger:
   *   1. silently INVALIDATE the incumbent's live token (their poll starts answering
   *      `meeting_not_found`, i.e. "this link isn't active", while they are still queued), and
   *   2. INHERIT that queue position under a name and address of the stranger's choosing —
   *      which the host's admit/deny panel would then show as the incumbent.
   *
   * `onConflictDoNothing` closes both: the incumbent row is left BYTE-IDENTICAL for every
   * admission state, this method returns `undefined`, and the service maps that to the same
   * uniform `meeting_not_found` it answers for a cancelled meeting or a full room.
   *
   * ⚠ THE ARBITER IS STILL REQUIRED, AND IS STILL RAW `sql`, for exactly the 42P10 reason
   * above. `onConflictDoNothing`'s `where` key IS the arbiter predicate (there is no second
   * `setWhere` to confuse it with, because there is no `SET`).
   *
   * ── ⚠ THE TWO RESIDUALS THIS LEAVES, STATED RATHER THAN HIDDEN ─────────────────────────
   *
   *   1. **A (meeting, email) EXISTENCE ORACLE REMAINS.** A caller who knows a meeting id
   *      learns, from success-vs-refusal, whether an address already has a live guest row on
   *      that meeting. It is strictly NARROWER than before (`pending`, `admitted`,
   *      `pre_admitted` and `denied` are now ONE outcome rather than two), and it is bounded
   *      by the route's per-visitor and per-meeting windows — but it is not closed. Closing it
   *      needs a decoy-token design whose failure surfaces one poll later, which is a worse
   *      answer for the legitimate visitor and only moves the oracle.
   *   2. **A VISITOR WHO LOSES THEIR TOKEN CANNOT RE-ENTER THE QUEUE WITH THAT ADDRESS WHILE
   *      THE ROW REMAINS LIVE.** `sessionStorage` survives a reload, so this needs the TAB to
   *      be closed. They then see the uniform "this link isn't active" card until something
   *      VACATES `meeting_guest_meeting_email_live_idx`.
   *
   *      ⚠⚠ AND "SOMETHING" IS AN EXACT, SHORT LIST — **`revoked_at` OR `deleted_at` BECOMING
   *      NON-NULL, AND NOTHING ELSE.** That index is partial on those two columns only. It has
   *      NO `admission` predicate and NO `expires_at` predicate, so:
   *        · a host DENY vacates it (that method stamps `revoked_at` — see `decideAdmission`);
   *        · a host REMOVE vacates it (`revoke` stamps both);
   *        · **`expires_at` PASSING DOES NOT.** Expiry does not vacate a unique index at all.
   *          An earlier version of this note listed expiry alongside the other two, which was
   *          simply wrong and made the residual look bounded when it was not.
   *      So a row that is neither denied nor removed holds the slot until one of a host's two
   *      explicit acts, indefinitely. An ADMITTED row holds it for the life of the meeting, by
   *      design — they are in the room.
   *
   *      That is a real product cost, accepted here because the alternative is the hijack
   *      above; a proper fix (an emailed re-entry link) is its own ticket, its own rate limit
   *      and its own non-enumerating response.
   *
   * ⚠ NEVER SOFT-DELETE-AND-REINSERT to work around either residual. `token_hash` carries a
   * NON-PARTIAL unique (`meeting_guest_token_hash_idx`), and vacating the live slot to insert
   * afresh walks straight into `reference_softdelete_nonpartial_unique_recreate` on the OTHER
   * index. (A genuinely REVOKED or soft-deleted row DOES vacate the partial unique, so it is
   * re-claimable as a fresh INSERT — that is the intended behaviour, not the hazard.)
   *
   * ── DENIAL IS NOT A DURABLE BAN, AND THAT IS ACCEPTED (Decision 10) ────────────────────
   * A denied person can re-knock under a DIFFERENT email and get a fresh `pending` row. The
   * property that matters is unaffected: the Daily room is `privacy: 'private'`, so nobody
   * enters without an explicit host admit producing a token mint. Denial declines THIS
   * ATTEMPT; a bare link plus a self-declared address cannot support an identity ban. Do not
   * read this as a hole.
   *
   * ── THE AUDIT ROW ──────────────────────────────────────────────────────────────────────
   * One `meeting_guest.self_claimed` row per successful call, with a NULL `actorUserId` —
   * the column is nullable and there genuinely is no actor. This keeps the guest lifecycle
   * fully audited now that `createMany`, `revoke` and `decideAdmission` all are. Insert-only
   * means it is now exactly ONE audit row per guest row, so a second one on the same
   * `entity_id` is a bug rather than a signal.
   */
  claimLobbyPlace: async (input: ClaimLobbyPlaceInput): Promise<MeetingGuest | undefined> => {
    return db.transaction(async (tx) => {
      const [row] = await tx
        .insert(meetingGuests)
        .values({
          meetingId: input.meetingId,
          // ⚠ NULL BY CONSTRUCTION — a knock has no inviter. See `ClaimLobbyPlaceInput`.
          invitedById: null,
          email: input.email,
          name: input.name,
          emailDomain: input.emailDomain,
          party: input.party,
          participationRole: 'guest',
          accessScope: input.accessScope,
          inviteChannel: 'link',
          admission: 'pending',
          tokenHash: input.tokenHash,
          expiresAt: input.expiresAt,
        })
        .onConflictDoNothing({
          target: [meetingGuests.meetingId, meetingGuests.party, meetingGuests.email],
          // ⚠ THE ARBITER. Must match `meeting_guest_meeting_email_live_idx`'s predicate
          // EXACTLY, and must stay raw `sql` — see the docblock's 42P10 note.
          where: sql`${meetingGuests.deletedAt} IS NULL AND ${meetingGuests.revokedAt} IS NULL`,
        })
        .returning();

      if (row === undefined) {
        return undefined;
      }

      await auditEventsRepository.record(
        {
          // ⚠ NULL — an anonymous visitor is not an actor. The column permits it.
          actorUserId: null,
          action: 'meeting_guest.self_claimed',
          entityType: ENTITY_TYPE,
          entityId: row.id,
          metadata: {
            meetingId: row.meetingId,
            email: row.email,
            party: row.party,
            participationRole: row.participationRole,
            accessScope: row.accessScope,
            inviteChannel: row.inviteChannel,
          },
        },
        tx
      );

      return row;
    });
  },

  /**
   * Stamp an access: bump `access_count`, set `last_accessed_at`.
   *
   * ⚠ Called on the landing AFTER EVERY BAIL-OUT — i.e. only once the row is known to be
   * live — so a scanner hitting a revoked link records nothing.
   *
   * ⚠ SCANNER-INFLATED (Gmail's image proxy, Safe Links detonation). A coarse LIVENESS
   * signal, never "human opens" — which is why no PostHog event fires from this method.
   */
  recordAccess: async (guestId: string): Promise<void> => {
    await db
      .update(meetingGuests)
      .set({
        lastAccessedAt: sql`now()`,
        accessCount: sql`${meetingGuests.accessCount} + 1`,
        updatedAt: sql`now()`,
      })
      .where(eq(meetingGuests.id, guestId));
  },

  /**
   * Push every LIVE guest link on a meeting out to a LATER expiry, returning how many rows
   * moved.
   *
   * ⚠ THE BAL-409 HAND-OFF IS NOW DISCHARGED — this delegates to the tx-scoped
   * `extendGuestExpiryForMeetingTx` (`_shared/guest-expiry.ts`), bound to the base `db`, while
   * `meetingsRepository.updateSchedule` calls the SAME underlying writer on its own `tx`.
   *
   * ⚠ THE BEHAVIOUR IS NARROWED, NOT PRESERVED. The shared writer added an
   * `admission IN ('admitted','pre_admitted')` filter this method did not previously have, so a
   * standalone caller no longer extends never-admitted (`pending`) lobby handles, nor revives
   * already-expired ones. That is the intended fix — an expired `pending` handle silently
   * pushed back to `newEnd + TTL` was a working lobby token restored for someone no host ever
   * admitted — but it IS a change to a shipped public method, not a refactor. `expires_at` is derived from the MEETING
   * (`scheduled_end + GUEST_TOKEN_TTL_AFTER_END_MS`), so a meeting moved more than that TTL past
   * its ORIGINAL end leaves already-issued links expiring BEFORE the call.
   *
   * EXTEND-ONLY by construction (`expires_at < newExpiresAt`): moving a meeting EARLIER must
   * never silently shorten a window, because a shortened window is a revocation nobody
   * decided on — and revocation has its own attributed path (`revoke`).
   */
  extendExpiryForMeeting: async (meetingId: string, expiresAt: Date): Promise<number> => {
    return extendGuestExpiryForMeetingTx(db, meetingId, expiresAt);
  },

  /**
   * BAL-436 — ROTATE one live guest's join credential: replace `token_hash`, refresh
   * `expires_at`, and append a `meeting_guest.link_resent` audit row, all in ONE transaction.
   *
   * ⚠⚠ **ROTATION INVALIDATES THE PREVIOUS CREDENTIAL, AND THAT IS THE POINT.** A host
   * re-sends precisely because the previous link is believed lost — forwarded to the wrong
   * address, buried in a spam folder, or pasted somewhere. Leaving the old hash live would
   * mean two working credentials on one row, i.e. a second hijack surface opened by the very
   * act of trying to rescue somebody. `findLiveByTokenHash` resolves on the hash, so the old
   * link stops resolving on the next click, exactly as `revoke` does.
   *
   * ⚠ THE RAW TOKEN NEVER REACHES THIS LAYER. Only the SHA-256 hex arrives, for the reason
   * `createMany`'s contract states: the Drizzle query-logging hook in `client.ts` sees every
   * bind parameter, so a raw secret passed here would be captured in the logs. `apps/api`'s
   * `mintGuestInviteToken` / `hashGuestToken` own the mint.
   *
   * ⚠ `expiresAt` IS DERIVED BY THE CALLER FROM THE **MEETING**, never from the mint instant
   * — the same rule as `createMany`, and the reason `meeting_guests.expires_at` has no SQL
   * default. It is NOT extend-only here (unlike `extendExpiryForMeeting`): a rotation replaces
   * the whole credential, so the new window is simply the window the meeting implies.
   *
   * ── ⚠⚠ THE `WHERE` CLAUSE IS THE WHOLE BOUNDARY, AND IT CARRIES ALL FOUR PREDICATES ─────
   *
   * This platform has NO RLS, so a credential-minting UPDATE is contained by its own `WHERE`
   * and by nothing else. All four narrowing facts are therefore IN the statement rather than
   * re-read in front of it:
   *
   *   · `meeting_id` — the TENANCY scope. Without it, any guest row in the database is
   *     rotatable given only its uuid.
   *   · `deleted_at IS NULL` / `revoked_at IS NULL` — LIVE rows only. Re-minting onto a row
   *     somebody deliberately switched off would undo a revocation silently.
   *   · `invite_channel = 'link'` — an `email` invitee has an inviter and a
   *     remove-then-re-invite path that records attribution; rotating theirs here bypasses it.
   *   · `admission = 'admitted'` — a `pending` knock has not been let in AT ALL, so a
   *     "re-send" would mint a credential for somebody nobody admitted, which is the single
   *     control the queue exists to be.
   *
   * ⚠ **ATOMIC, NOT RE-READ.** The service checks the same shape in front of this call for the
   * sake of a precise error literal (`guest_link_not_resendable` vs `guest_not_found`), but
   * that check is a COURTESY, not the gate: between the read and the write a concurrent revoke
   * or admit-reversal could land, and a caller that forgets the read entirely (BAL-442's guest
   * self-service arm is the one being written against this) still cannot widen the shape.
   * ⚠ DO NOT "SIMPLIFY" THIS BACK TO `eq(id)` ON THE ARGUMENT THAT THE SERVICE ALREADY
   * CHECKED — that is precisely the argument that leaves an unguarded primitive behind.
   *
   * ⚠ `undefined` therefore means "no row matched ALL FOUR", and the caller cannot tell which
   * failed from this method alone. That is why the service's own pre-read exists.
   *
   * ⚠ THE AUDIT METADATA NEVER CARRIES `token_hash` — the same rule as `createMany` and
   * `decideAdmission`. Ids and labels only.
   */
  rotateToken: async (input: RotateMeetingGuestTokenInput): Promise<MeetingGuest | undefined> => {
    return db.transaction(async (tx) => {
      const [row] = await tx
        .update(meetingGuests)
        .set({
          tokenHash: input.tokenHash,
          expiresAt: input.expiresAt,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(meetingGuests.id, input.guestId),
            // ⚠ TENANCY, IN THE STATEMENT. See the docblock — there is no RLS behind this.
            eq(meetingGuests.meetingId, input.meetingId),
            isNull(meetingGuests.deletedAt),
            isNull(meetingGuests.revokedAt),
            // ⚠ THE NARROW SHAPE, ATOMIC RATHER THAN RE-READ.
            eq(meetingGuests.inviteChannel, 'link'),
            eq(meetingGuests.admission, 'admitted')
          )
        )
        .returning();

      if (row === undefined) {
        return undefined;
      }

      await auditEventsRepository.record(
        {
          actorUserId: input.rotatedByUserId,
          action: 'meeting_guest.link_resent',
          entityType: ENTITY_TYPE,
          entityId: row.id,
          metadata: {
            meetingId: row.meetingId,
            party: row.party,
            inviteChannel: row.inviteChannel,
          },
        },
        tx
      );

      return row;
    });
  },
};
