import {
  pgTable,
  uuid,
  integer,
  text,
  timestamp,
  index,
  uniqueIndex,
  check,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import {
  meetingParticipantPartyEnum,
  meetingParticipationRoleEnum,
  guestAccessScopeEnum,
  meetingGuestInviteChannelEnum,
  meetingGuestAdmissionEnum,
} from './enums';
import { meetings } from './meetings';
import { users } from './users';
import { timestamps, softDelete } from './helpers';

/**
 * meeting_guests (BAL-408 / ADR-1044) — a first-class PARTICIPANT of one meeting who is
 * not (yet) a Balo user: a client-side colleague, a client-side DELEGATE attending instead
 * of the booker, or an expert-side colleague. Anchored to `meetings.id`, never to a case,
 * a request or a `credit_session` — the meeting is the participation grain, and the
 * ENGAGEMENT-wide grant is a property of the row (`access_scope`), not of the anchor.
 *
 * ── BAL-418'S HAND-OFF, DISCHARGED (read this before touching the two uniques) ─────────
 * BAL-418 assigned this ticket: "adding `deleted_at` under the existing NON-PARTIAL
 * `access_token` UNIQUE instantiates `reference_softdelete_nonpartial_unique_recreate` …
 * fixing it means making THAT index PARTIAL". The literal instruction DISSOLVED, because
 * `access_token` is gone (see below) and its index with it. The HAZARD is real and is
 * closed — but on a DIFFERENT index, and the split is load-bearing:
 *
 *   · `meeting_guest_token_hash_idx` (token_hash)         → NON-PARTIAL, deliberately.
 *   · `meeting_guest_meeting_email_live_idx` (meeting,email) → PARTIAL, deliberately.
 *
 * The rationale for each sits on the index itself. Do not "harmonise" them.
 *
 * ── WHAT WAS DROPPED ───────────────────────────────────────────────────────────────────
 * `access_token` (PLAINTEXT bearer credential) is REPLACED by `token_hash`. Every other
 * token surface on the platform — `proposal_share_links` (BAL-386), `review_invite_tokens`
 * (BAL-390) — persists only a SHA-256 hex digest of a ≥256-bit random token, and a
 * plaintext credential in a widely-readable table is the one shape a compromised read
 * turns straight into meeting access. Redefined in place rather than expand-contract:
 * pre-launch, migration 0056 ran `DELETE FROM "meeting_guests"`, there is exactly one live
 * consumer (`apps/web/src/app/admin-dev/_actions/delete-user.ts`) and its columns are kept.
 *
 * ── THE TOKEN IS AN IDENTITY CLAIM, NOT AN AUTHORIZATION GRANT ─────────────────────────
 * Resolving `token_hash` tells the landing WHO the visitor claims to be. Every action taken
 * through it re-reads this row's LIVE state (`deleted_at IS NULL`, `revoked_at IS NULL`,
 * `expires_at > now()`, `admission <> 'denied'`) AND the meeting's own state, so revocation
 * is immediate and total.
 *
 * ⚠ NOT SINGLE-USE, and the reasoning is this feature's own, not an analogy. A JOIN link is
 * presented MORE THAN ONCE BY DESIGN — desktop then phone, again from the calendar
 * reminder, and above all a REJOIN AFTER A NETWORK DROP mid-call (`meeting_presence` is
 * built around rejoins). Burning it on first use would lock a guest out of the call they
 * were invited to, mid-call, with no self-service recovery. `access_count` /
 * `last_accessed_at` give the audit trail single-use would have given, without the lockout.
 *
 * ⚠ HASHING STAYS IN THE CALLER. `apps/api` mints (raw + hash) and hands `@balo/db` only
 * the hash; the RAW token is returned ONCE and is never persisted, never logged, never
 * recoverable. The reason is the Drizzle query-logging hook in `client.ts`, which would
 * capture a raw secret passed as a bind parameter — verbatim the `review_invite_tokens`
 * ruling. Do not move hashing in here.
 *
 * ⚠ KNOWN LIMITATION — RESCHEDULE, AND ITS HAND-OFF, NOW DISCHARGED FOR THE CLIENT SIDE.
 * `expires_at` is derived from the MEETING (`scheduled_end` + 7d) at invite time, so it has
 * NO SQL default (unlike BAL-386/390's `now() + 30 days`). If a meeting is later moved more
 * than 7 days past its ORIGINAL end, an already-issued guest link expires before the call.
 * **BAL-409 (client-initiated reschedule) now calls
 * `meetingGuestsRepository.extendExpiryForMeeting` — via the tx-scoped
 * `extendGuestExpiryForMeetingTx` — inside `meetingsRepository.updateSchedule`'s own
 * transaction.** BAL-411 (expert-side propose-and-wait) still owes the same call on its own
 * write path when it lands.
 *
 * ── FOUR STRUCTURAL GUARANTEES AN EXPERT-SIDE GUEST IS NOT A CO-DELIVERER ──────────────
 * (multi-expert delivery is DEFERRED — ADR-1045 §5's future `engagement_experts` — not
 * merely unbuilt, so a back door here would pre-empt a decision nobody has made)
 *   1. THIS TABLE CARRIES NO `expert_profile_id` AND MUST NEVER GAIN ONE — enforced by
 *      `invariants/meeting-guests-no-expert-profile-column.test.ts`, not by this prose.
 *   2. The engagement resolver reads NO participant table: `hasEngagementCapability`
 *      resolves delivery identity through `engagements.expert_profile_id` /
 *      `project_requests.expert_profile_id` only, so an expert-side guest can never hold
 *      `host_meetings` or `manage_engagement`.
 *   3. Payout and settlement resolve the expert from `engagements.expert_profile_id`,
 *      never from a participant list.
 *   4. ⚠ THE MONEY RULE. An expert-side guest must be written to `meeting_presence` as
 *      `party='observer'`, NEVER `'expert'` — `computeMeetingClocks` derives
 *      `expertPresentMs` (and anchors `billableMs`) from `party='expert'` rows as
 *      GAP-INCLUSIVE SPANS, so an agency colleague sitting in for the whole hour while the
 *      delivering expert is present 10→20 would bill the client for the GUEST's time. The
 *      mapping is data, not prose: `presencePartyForGuest` in `@balo/shared/meetings`.
 *      See the write contract on `meeting_presence`.
 *
 * ── `party` REUSES `meeting_participant_party` (three labels), CONSTRAINED TO TWO ───────
 * `meeting_guest_party_two_sided` limits it to `client | expert`. A narrow two-label enum
 * would need `ALTER TYPE … ADD VALUE` the first time a Balo staffer or a third party needs
 * a guest row, and that migration inherits the one-transaction hazard; RELAXING A CHECK has
 * no such hazard. It also keeps ONE vocabulary across `meeting_guests.party` and
 * `meeting_presence.party`, which is what lets the D7 mapping helper share an input and
 * output type.
 *
 * ⚠ `party` IS NEVER A REQUEST FIELD. The invite service derives it from the ACTOR's
 * resolved side (membership axis for the client side, engagement axis for the expert side).
 * That single decision is the load-bearing anti-cross-party control — a client-side member
 * cannot mint an expert-side participant, and vice versa.
 *
 * ── `access_scope`: THE GRANT IS RECORDED HERE; THE READ IS ENFORCED BY BAL-388 ─────────
 * Computed at INVITE time and STORED (never resolved at read time): the whole mitigation
 * for a retrospective grant is INFORMED CONSENT, and a later `party_domains` change must
 * not silently widen or narrow a grant the inviter agreed to in different terms. `email` +
 * `email_domain` are the evidence half of that record. **BAL-388 must call
 * `guestMayReadMeeting` (`@balo/shared/meetings`) to enforce it** — nothing in this PR does.
 *
 * NO RLS — matches `meetings` / `meeting_contexts` / `meeting_presence` and the credit
 * precedents: Balo auths with WorkOS + iron-session, not Supabase Auth, so `auth.uid()` is
 * meaningless and authorization lives in the application layer (ADR-1029).
 */
export const meetingGuests = pgTable(
  'meeting_guests',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    // BAL-418: real FK. CASCADE — a guest invitation dies with its meeting.
    meetingId: uuid('meeting_id')
      .notNull()
      .references(() => meetings.id, { onDelete: 'cascade' }),

    /**
     * The Balo user this guest turned out to be, when one exists. NULL for the ordinary
     * case (a guest is by definition not-yet-a-user).
     *
     * ⚠ FK left at NO ACTION, unchanged from BAL-418 and deliberately NOT `restrict`:
     * this is a SUBJECT pointer, not an ATTRIBUTION column, so ADR-1030's actor-FK
     * convention does not govern it. `admin-dev/_actions/delete-user.ts` NULLs it before
     * hard-deleting a user, which is the contract that keeps that operator action working.
     */
    userId: uuid('user_id').references(() => users.id),

    /**
     * The invited address. Stored ALREADY-LOWERCASED BY THE CALLER — `@balo/db` never
     * normalises input (the `party_domains` / `proposal_share_links` /
     * `expert_referral_invites` convention), and the partial unique below matches on the
     * canonicalised value, so a caller that skips it silently permits a duplicate invite.
     */
    email: text('email').notNull(),
    name: text('name'),

    /** WHICH SIDE. CHECK-narrowed to `client | expert`; derived from the actor, never sent. */
    party: meetingParticipantPartyEnum('party').notNull(),

    /** Alongside (`guest`) or instead of the booker (`delegate`). No default — every writer states it. */
    participationRole: meetingParticipationRoleEnum('participation_role').notNull(),

    /** What they may read AFTERWARDS. Computed at invite time, stored as the grant record. */
    accessScope: guestAccessScopeEnum('access_scope').notNull(),

    /** How they reached the meeting. Orthogonal to `admission`. */
    inviteChannel: meetingGuestInviteChannelEnum('invite_channel').notNull(),

    /**
     * The admit/deny lifecycle. `pending`'s FIRST PRODUCER is BAL-132's
     * `meetingGuestsRepository.claimLobbyPlace` (a self-claimed lobby knock); the invite
     * path still only ever writes `pre_admitted`.
     */
    admission: meetingGuestAdmissionEnum('admission').notNull(),

    /**
     * ATTRIBUTION — who invited them. `restrict` per ADR-1030 (the `proposal_share_links`
     * / `expert_referral_invites` treatment): the actor must survive their own departure.
     *
     * ⚠ BEHAVIOUR CHANGE FROM BAL-418, which left this at NO ACTION.
     * `admin-dev/_actions/delete-user.ts` already HARD-DELETES guests by `invited_by_id`
     * BEFORE deleting the user, which satisfies `restrict` — but the two NEW attribution
     * FKs below do NOT have that treatment for free, and that file was patched in this same
     * PR to NULL them. See the note on `revoked_by_user_id`.
     *
     * ⚠⚠ NULLABLE SINCE MIGRATION 0064 (BAL-132, Decision 4). A SELF-CLAIMED LOBBY ROW HAS
     * NO INVITER, AND THERE IS NO HONEST NON-NULL VALUE. Attributing a knock to the
     * delivering expert or to a synthetic system user would put a LIE in the one column
     * whose entire purpose is attribution — and `CreateMeetingGuestsInput.invitedById` is
     * still `string` (required), so the INVITE path structurally cannot produce a null.
     * `meetingGuestsRepository.claimLobbyPlace` is the ONLY writer that leaves it NULL, and
     * it pairs the null with `invite_channel = 'link'` + `admission = 'pending'`.
     *
     * ⚠ THE PAIRING IS ENFORCED BY THE DATABASE, NOT ONLY BY THE WRITE PATH. Migration 0064
     * relaxes the NOT NULL **and** adds the one-directional CHECK
     * `meeting_guest_self_claimed_is_link` (`invited_by_id IS NOT NULL OR
     * invite_channel = 'link'`) — see its docblock in the CHECKs block below, including why
     * it must NEVER be tightened into a biconditional. Both statements are pure widenings
     * that admit every pre-existing row, so neither depends on the integration harness for
     * its safety argument (memory `reference_db_migrations_tested_against_empty_db` — the
     * harness migrates an EMPTY container, so a retro-validating `ADD CONSTRAINT` that could
     * actually reject a row would be green in CI and red on Railway; this one cannot).
     *
     * ⚠ NO RIPPLE IN `admin-dev/_actions/delete-user.ts`. A self-claimed row names no
     * inviter, so its `delete(... WHERE invited_by_id = $user)` simply does not match it;
     * the row's only actor FK is `admitted_by_user_id`, which that file already NULLs.
     */
    invitedById: uuid('invited_by_id').references(() => users.id, { onDelete: 'restrict' }),

    /**
     * SHA-256 hex (64 chars) of a ≥256-bit random token. The RAW token is NEVER persisted.
     * See the ⚠ HASHING STAYS IN THE CALLER note in the table docblock.
     */
    tokenHash: text('token_hash').notNull(),

    /**
     * NO SQL DEFAULT, unlike `proposal_share_links` / `review_invite_tokens`: the window is
     * derived from the MEETING (`scheduled_end + GUEST_TOKEN_TTL_AFTER_END_MS`), not from
     * the mint instant, so a default would be silently wrong for a call three weeks out.
     * See the reschedule limitation + BAL-409/410/411 hand-off in the table docblock.
     */
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),

    /**
     * THIS is what "removing a guest revokes access" means mechanically: every live read
     * (`findLiveByTokenHash`, `listLiveByMeeting`, `findLiveById`, both counts) re-checks
     * `revoked_at IS NULL`, and `meeting_guest_meeting_email_live_idx` is partial on it.
     *
     * ⚠ WRITTEN BY EXACTLY TWO METHODS, AND THEY DIFFER IN ONE COLUMN — which is what keeps
     * the two states distinguishable on the row itself:
     *   · `revoke`          → `revoked_at` **AND** `deleted_at`. A host removed this guest.
     *   · `decideAdmission` → `revoked_at` ONLY, and ONLY on a `denied` decision. A host
     *     refused this knock. `deleted_at` stays NULL, so the row survives as evidence.
     * An ADMIT writes neither — an admitted guest holds a seat, and every "live" read depends
     * on that.
     *
     * ⚠⚠ THE DENIAL STAMP IS LOAD-BEARING, NOT BOOKKEEPING. Without it a denied row keeps its
     * `(meeting, party, email)` slot in the partial unique FOREVER — expiry does not vacate a
     * unique index, and that index has no `admission` predicate — so the host who just said no
     * to an address could never afterwards INVITE that address by email (`23505` →
     * `409 guest_already_invited`). See `decideAdmission`'s docblock for the full three-part
     * consequence and for why re-knockability after a denial is consistent with Decision 10.
     */
    revokedAt: timestamp('revoked_at', { withTimezone: true }),

    /**
     * ATTRIBUTION — who revoked. `restrict`, mirroring
     * `proposal_share_links.revoked_by_user_id`.
     *
     * ⚠ NEW `restrict` FK: a user who REVOKED a guest they did not INVITE would otherwise
     * make `delete-user.ts`'s hard delete fail with 23503, because that file's Phase 4 only
     * knew about `invited_by_id` / `user_id` / `converted_to_user_id`. It now NULLs this
     * column and `admitted_by_user_id` too, AFTER the `invited_by_id` delete. Nulling
     * attribution on a SURVIVING row is the same call `meeting_presence.user_id` makes —
     * `restrict` would block an operator action outright — and it is why both are nullable.
     */
    revokedByUserId: uuid('revoked_by_user_id').references(() => users.id, {
      onDelete: 'restrict',
    }),

    /** Stamped on admit/deny. Paired with `admitted_by_user_id` by CHECK, both directions. */
    admissionDecidedAt: timestamp('admission_decided_at', { withTimezone: true }),

    /** ATTRIBUTION — who admitted or denied. `restrict`; see `revoked_by_user_id`'s ⚠. */
    admittedByUserId: uuid('admitted_by_user_id').references(() => users.id, {
      onDelete: 'restrict',
    }),

    /** Stamped by `recordAccess` on the landing. NULL until first access. */
    lastAccessedAt: timestamp('last_accessed_at', { withTimezone: true }),

    /**
     * ⚠ SCANNER-INFLATED, exactly as `review_invite_tokens.access_count` is: Gmail's image
     * proxy and Microsoft Safe Links detonation each stamp an access. A coarse LIVENESS
     * signal, never "human opens".
     */
    accessCount: integer('access_count').notNull().default(0),

    /**
     * The email's domain AT INVITE TIME — the evidence half of the `access_scope` grant.
     * Derivable from `email`, and kept anyway: together the pair records WHAT was matched
     * when the scope was decided, so a later `party_domains` change cannot rewrite history.
     */
    emailDomain: text('email_domain'),

    /**
     * The acquisition loop. KEPT THOUGH NOTHING WRITES THEM: `delete-user.ts` reads
     * `converted_to_user_id` today, and BAL-345's (currently inert) domain auto-join is
     * their intended writer. No `guest_converted_to_member` analytics constant is declared
     * anywhere — an event with no producer reads as 100% drop-off in a PostHog funnel.
     */
    convertedToUserId: uuid('converted_to_user_id').references(() => users.id),
    convertedAt: timestamp('converted_at', { withTimezone: true }),

    ...timestamps,
    ...softDelete,
  },
  (t) => [
    // ── Uniques ──────────────────────────────────────────────────────────────────────
    // ⚠ NON-PARTIAL, DELIBERATELY — BAL-390's rationale verbatim. The landing lookup MUST
    // resolve across live/revoked/expired/deleted states so it can answer `undefined`
    // UNIFORMLY for all of them instead of becoming an existence oracle ("this token was
    // real once"). The soft-delete/re-create hazard cannot bite here: a re-invite mints a
    // FRESH random token, so a hash never recurs. DO NOT MAKE THIS PARTIAL.
    uniqueIndex('meeting_guest_token_hash_idx').on(t.tokenHash),

    // THE INVARIANT: ONE LIVE INVITE PER (MEETING, **PARTY**, EMAIL).
    //
    // ⚠ PARTIAL — this is where `reference_softdelete_nonpartial_unique_recreate` ACTUALLY
    // lives. A REMOVED guest MUST be re-invitable; `revoke` sets `revoked_at` AND
    // `deleted_at`, so both halves of the predicate vacate the slot. Mirrors
    // `proposal_share_link_relationship_recipient_live_idx`, including `revoked_at`.
    // A NON-partial unique here would silently make removal permanent.
    //
    // ⚠⚠ AND A **DENIAL** VACATES IT TOO (BAL-132), because `decideAdmission` stamps
    // `revoked_at` on the `denied` branch. THE PREDICATE IS THE COMPLETE LIST OF WHAT FREES A
    // SLOT: `revoked_at` or `deleted_at` becoming non-null, and nothing else. In particular
    // **`expires_at` PASSING DOES NOT VACATE THIS INDEX** — expiry is not in the predicate and
    // a unique index does not honour row TTLs. So without the denial stamp, a host who denied
    // an address could never afterwards invite it (the `23505` maps to
    // `409 guest_already_invited`, which would be false and unrecoverable), and a stranger
    // knocking with a guessed address could burn that address's client-side invite slot for
    // good. Anything that changes what stamps `revoked_at` changes THIS invariant — read
    // `decideAdmission`'s docblock before touching either.
    //
    // ⚠⚠ PARTY-SCOPED, AND THE REASON IS CONCEALMENT, NOT MERELY UNIQUENESS. A unique on
    // the bare (meeting, email) pair spans BOTH sides, so its 23505 — which the service
    // maps to a `409 guest_already_invited` — answers a question about the COUNTERPARTY's
    // roster. A client-side member (who by design sees expert-side guests' NAMES but never
    // their addresses, domains or scope — see `projectGuestForViewer`) could then probe any
    // address they liked: 409 ⇒ "the expert side already invited this person", 201 ⇒ "they
    // did not". That turns a status code into a cross-party email-existence oracle and
    // undoes every field-level concealment control at once. Adding `party` to the key means
    // a collision can only ever be with a row the actor is already entitled to see.
    //
    // The cost is the intended one: the SAME address may hold one live invite on each side,
    // which is correct — a person can legitimately attend as the client's colleague on one
    // meeting and the agency's on another, and the two rows carry different `access_scope`
    // grants and different revocation authority (the same-party rule in `removeGuest`).
    uniqueIndex('meeting_guest_meeting_email_live_idx')
      .on(t.meetingId, t.party, t.email)
      .where(sql`${t.deletedAt} IS NULL AND ${t.revokedAt} IS NULL`),

    // ── Reads ────────────────────────────────────────────────────────────────────────
    index('meeting_guest_meeting_idx').on(t.meetingId), // kept from BAL-418
    // The live roster read AND the participant-cap COUNT (which must never materialise rows).
    index('meeting_guest_meeting_live_idx')
      .on(t.meetingId)
      .where(sql`${t.deletedAt} IS NULL AND ${t.revokedAt} IS NULL`),

    // ── FK delete-time scans ─────────────────────────────────────────────────────────
    // ⚠ These are indexed on the SAME reasoning `reviews.reviewer_user_id` gives, and
    // AGAINST the BAL-417 actor-FK ruling: that ruling assumes users are never hard-deleted,
    // and `admin-dev/_actions/delete-user.ts` proves the assumption false. A `restrict` FK
    // whose delete-time scan can actually run needs an index — and `delete-user.ts` scans
    // by every one of these four columns.
    index('meeting_guest_invited_by_idx').on(t.invitedById),
    index('meeting_guest_user_idx').on(t.userId),
    index('meeting_guest_converted_to_user_idx').on(t.convertedToUserId),
    index('meeting_guest_revoked_by_idx').on(t.revokedByUserId),
    index('meeting_guest_admitted_by_idx').on(t.admittedByUserId),

    // ── CHECKs ───────────────────────────────────────────────────────────────────────
    // ALL SIX ARE THREE-VALUED-LOGIC SAFE. Every operand is either a NOT NULL column
    // compared to a literal (never NULL) or a total `IS NULL` / `IS NOT NULL` test — so none
    // of them can "pass by being unknown", the hole `meeting_outcome_requires_ended` calls
    // out. Naming enum literals here is safe because all four guest enums are standalone
    // `CREATE TYPE` in this same migration 0061 (no `ALTER TYPE … ADD VALUE` occurs) — and
    // that holds for `meeting_guest_self_claimed_is_link`'s `'link'` too, added in 0064
    // against the already-committed `meeting_guest_invite_channel` type.

    // Reuse the three-label party enum (see the docblock), constrain to the two sides.
    check('meeting_guest_party_two_sided', sql`${t.party} IN ('client','expert')`),

    // ⚠⚠ LOAD-BEARING. An expert-side DELEGATE is expert SUBSTITUTION, which is out of
    // scope — so it is UNREPRESENTABLE, not merely discouraged. The service refuses it
    // first (with a legible code); this is the backstop, not the UX.
    check(
      'meeting_guest_delegate_is_client_side',
      sql`${t.participationRole} <> 'delegate' OR ${t.party} = 'client'`
    ),

    // A terminal admission is stamped IFF it is terminal (BOTH directions, so a
    // `pre_admitted` row cannot carry a phantom decision and a `denied` one cannot hide
    // when it was decided). This pair is entirely internal to the row, so nothing outside
    // the write path can half-write it.
    check(
      'meeting_guest_admission_terminal_stamped',
      sql`(${t.admission} IN ('admitted','denied')) = (${t.admissionDecidedAt} IS NOT NULL)`
    ),

    // ⚠⚠ THE NEXT TWO ARE ONE-DIRECTIONAL IMPLICATIONS (attribution ⇒ stamp), NOT
    // BICONDITIONALS, AND THE ASYMMETRY IS DELIBERATE — the `meeting_outcome_requires_ended`
    // pattern. Read this before "tightening" either one, because tightening it breaks a
    // shipped operator path with a 23514 that no local gate catches:
    //
    //   · The state they FORBID is the nonsensical one — a row asserting that somebody
    //     revoked/decided it while it is not revoked/decided at all.
    //   · The state they PERMIT is a stamp whose actor is gone. That is not a half-write,
    //     it is the RESIDUE OF A HARD USER DELETE: `revoked_by_user_id` /
    //     `admitted_by_user_id` are ADR-1030 `restrict` FKs, and
    //     `apps/web/src/app/admin-dev/_actions/delete-user.ts` therefore NULLs them (it
    //     cannot delete the guest row — that row belongs to a meeting the departing user may
    //     have had nothing to do with beyond pressing Admit). A biconditional would make
    //     that operator action fail with 23514, and the only alternatives would be to also
    //     null `revoked_at` — resurrecting a revocation that really happened — or to hard
    //     delete an unrelated participation record. Losing the ACTOR while keeping the FACT
    //     is the same trade `meeting_presence.user_id` makes with `set null`.
    //
    // "Both written together" is guaranteed by the WRITE PATH instead:
    // `meetingGuestsRepository.revoke` / `.decideAdmission` set stamp and actor in ONE
    // statement, and the integration test pins that.
    check(
      'meeting_guest_admission_attributed',
      sql`${t.admittedByUserId} IS NULL OR ${t.admissionDecidedAt} IS NOT NULL`
    ),
    check(
      'meeting_guest_revocation_attributed',
      sql`${t.revokedByUserId} IS NULL OR ${t.revokedAt} IS NOT NULL`
    ),

    // ⚠⚠ A NULL INVITER **IMPLIES** A LINK-CHANNEL ROW (BAL-132, Decision 4). Added in
    // migration 0064 alongside the `DROP NOT NULL` that made a null inviter possible at all.
    //
    // THE INVARIANT IN WORDS: "there is no such thing as a self-claimed row that is not a
    // link row." `invited_by_id` went nullable so an anonymous LOBBY KNOCK can exist, and the
    // ONLY writer that leaves it NULL — `meetingGuestsRepository.claimLobbyPlace` — hardcodes
    // `invite_channel = 'link'` (plus `admission = 'pending'`, `participation_role = 'guest'`).
    // This repo enforces its invariants in the DATABASE, not only on the write path
    // (`meeting_guest_admission_terminal_stamped`, `meeting_guest_admission_attributed`,
    // `meeting_context_admin_no_id`, `project_requests_direct_requires_expert`), and a column
    // that just became nullable FOR THE FIRST TIME is exactly where a future writer could
    // quietly produce an inviter-less `email`-channel row that means nothing.
    //
    // ⚠⚠⚠ ONE-DIRECTIONAL, AND IT MUST STAY THAT WAY. DO NOT "TIGHTEN" THIS INTO THE
    // BICONDITIONAL `(invited_by_id IS NULL) = (invite_channel = 'link')`. The biconditional
    // additionally forbids the OTHER direction — a `link`-channel row that DOES name an
    // inviter — and that state is not nonsensical, it is a PLAUSIBLE NEAR-FUTURE FEATURE:
    // BAL-436 ships a "Copy join link" control, and a follow-up could legitimately want the
    // resulting row attributed to the member who copied the link. Forbidding it here would
    // foreclose that decision from a CHECK constraint, and re-widening a constraint later is
    // a migration nobody should have to write for a guarantee we never actually needed.
    // The implication captures the ACTUAL invariant and over-commits to nothing.
    //
    // Three-valued-logic safe like the other five: `invite_channel` is NOT NULL and compared
    // to a literal, and `invited_by_id IS NOT NULL` is a total test — so the disjunction is
    // never UNKNOWN and cannot "pass by being unknown".
    //
    // ⚠ SAFE TO ADD RETROACTIVELY, which is why it could join 0064 rather than waiting: the
    // implication ADMITS EVERY PRE-EXISTING ROW. Before this migration `invited_by_id` was
    // NOT NULL, so the left disjunct is true for all of them and `ADD CONSTRAINT`'s validation
    // scan cannot reject anything. That reasoning is INDEPENDENT of the integration harness,
    // which migrates an EMPTY container (memory `reference_db_migrations_tested_against_empty_db`)
    // and therefore proves nothing about production data. A BICONDITIONAL would NOT have this
    // property — it would reject every existing `email`-channel row on sight.
    check(
      'meeting_guest_self_claimed_is_link',
      sql`${t.invitedById} IS NOT NULL OR ${t.inviteChannel} = 'link'`
    ),

    check('meeting_guest_access_count_nonneg', sql`${t.accessCount} >= 0`),
  ]
);

// ── Relations ──────────────────────────────────────────────────────────

/**
 * ⚠ Memory `reference_drizzle_with_hydration_leaks_secrets`: a relational `with:` read
 * HYDRATES FULL ROWS. Any read that can reach a route MUST carry an explicit `columns:`
 * projection excluding `token_hash` (and, per the counterparty-concealment rule, excluding
 * `email` on a cross-party projection). `meetingGuestsRepository.listLiveByMeeting` already
 * projects explicitly; new readers must too.
 */
export const meetingGuestsRelations = relations(meetingGuests, ({ one }) => ({
  meeting: one(meetings, {
    fields: [meetingGuests.meetingId],
    references: [meetings.id],
  }),
  invitedBy: one(users, {
    fields: [meetingGuests.invitedById],
    references: [users.id],
  }),
  user: one(users, {
    fields: [meetingGuests.userId],
    references: [users.id],
  }),
  convertedToUser: one(users, {
    fields: [meetingGuests.convertedToUserId],
    references: [users.id],
  }),
}));

// ── Type exports ───────────────────────────────────────────────────────

export type MeetingGuest = typeof meetingGuests.$inferSelect;
export type NewMeetingGuest = typeof meetingGuests.$inferInsert;

/** Alongside vs instead-of (schema-derived — single source of truth). */
export type MeetingParticipationRole = (typeof meetingParticipationRoleEnum.enumValues)[number];
/** What a guest may read afterwards (schema-derived — single source of truth). */
export type GuestAccessScope = (typeof guestAccessScopeEnum.enumValues)[number];
/** How the guest reached the meeting (schema-derived — single source of truth). */
export type MeetingGuestInviteChannel = (typeof meetingGuestInviteChannelEnum.enumValues)[number];
/** The admit/deny lifecycle (schema-derived — single source of truth). */
export type MeetingGuestAdmission = (typeof meetingGuestAdmissionEnum.enumValues)[number];
