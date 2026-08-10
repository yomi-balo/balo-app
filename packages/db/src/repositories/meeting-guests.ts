import { and, asc, eq, gt, isNull, lt, ne, sql } from 'drizzle-orm';
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
  /** `pre_admitted` for an email invite; `pending` is BAL-132's lobby (no producer yet). */
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
  invitedById: string;
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
   * The participant-cap input (`MAX_MEETING_PARTICIPANTS`). A COUNT, so the cap check never
   * materialises rows — and index-only on `meeting_guest_meeting_live_idx`.
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
          isNull(meetingGuests.revokedAt)
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
   * `meeting_guest_admission_decided_pair` and `meeting_guest_admission_terminal_stamped`
   * require, and why the transition cannot be half-written.
   *
   * Returns `undefined` when the row is not `pending` (already decided, `pre_admitted`,
   * revoked, soft-deleted, or absent) — the caller maps that to `409 guest_not_pending`.
   * The `admission = 'pending'` predicate makes this a compare-and-set, so two racing hosts
   * cannot both record a decision.
   *
   * NO `audit_events` ROW — accepted ONLY for the inert window below, and NOT a standing
   * exemption. The decision is durably attributed on the row itself (`admission` +
   * `admission_decided_at` + `admitted_by_user_id`, held together by the two CHECKs), and the
   * compare-and-set makes the transition irreversible and once-only, so who/what/when is
   * already recorded.
   *
   * ⚠⚠ RULED 2026-08-10 (BAL-408 review, by the ticket owner): that is NOT sufficient, and
   * BAL-132 MUST add the `audit_events` write when it makes admit/deny reachable. Do not read
   * this docblock as a blessed deviation — ADR-1030 is deliberately NOT being amended. Two
   * reasons the on-row triple does not close it:
   *   1. `revoke` (below) and `createMany` (above) — the sibling acts in this same guest
   *      lifecycle, carrying the same shape of attribution columns — BOTH write
   *      `audit_events`. Admit/deny being the only silent transition is an inconsistency,
   *      not a design.
   *   2. An on-row triple is STATE, not HISTORY. An admin reconstructing a disputed call
   *      queries `audit_events`; an admission that never appears there is invisible to
   *      exactly the review that matters most.
   * Write it inside this transaction, matching `revoke`'s shape, distinguishing `admitted`
   * from `denied`.
   *
   * ⚠ INERT IN BAL-408: nothing produces an `admission = 'pending'` row. BAL-132 owns the
   * lobby (anonymous visitor → name capture → bot protection → share-link proof).
   */
  decideAdmission: async (
    input: DecideMeetingGuestAdmissionInput
  ): Promise<MeetingGuest | undefined> => {
    const [row] = await db
      .update(meetingGuests)
      .set({
        admission: input.decision,
        admissionDecidedAt: sql`now()`,
        admittedByUserId: input.deciderUserId,
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
    return row;
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
   * ⚠⚠ NO PRODUCTION CALLER IN BAL-408 — THIS IS THE WRITTEN D2 RESCHEDULE HAND-OFF, and it
   * ships now so the receiving tickets need no migration. `expires_at` is derived from the
   * MEETING (`scheduled_end + GUEST_TOKEN_TTL_AFTER_END_MS`), so a meeting moved more than
   * that TTL past its ORIGINAL end leaves already-issued links expiring BEFORE the call.
   * **BAL-409 / BAL-410 / BAL-411 must call this inside their reschedule transaction.**
   *
   * EXTEND-ONLY by construction (`expires_at < newExpiresAt`): moving a meeting EARLIER must
   * never silently shorten a window, because a shortened window is a revocation nobody
   * decided on — and revocation has its own attributed path (`revoke`).
   */
  extendExpiryForMeeting: async (meetingId: string, expiresAt: Date): Promise<number> => {
    const rows = await db
      .update(meetingGuests)
      .set({ expiresAt, updatedAt: sql`now()` })
      .where(
        and(
          eq(meetingGuests.meetingId, meetingId),
          isNull(meetingGuests.deletedAt),
          isNull(meetingGuests.revokedAt),
          lt(meetingGuests.expiresAt, expiresAt)
        )
      )
      .returning({ id: meetingGuests.id });
    return rows.length;
  },
};
