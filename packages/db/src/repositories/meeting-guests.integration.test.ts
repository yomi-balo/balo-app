import { describe, it, expect, vi } from 'vitest';
import { and, asc, eq, sql } from 'drizzle-orm';
import { db } from '../client';
import { auditEvents, meetingGuests, meetingPresence, meetings, users } from '../schema';
import type { MeetingGuest, NewMeetingGuest } from '../schema';
import { meetingFactory, meetingGuestFactory, userFactory } from '../test/factories';
import { expectConstraintViolation } from '../test/helpers/expect-check-violation';
import { auditEventsRepository } from './audit-events';
import {
  meetingGuestsRepository,
  type ClaimLobbyPlaceInput,
  type ConvertedGuestLink,
  type CreateMeetingGuestInput,
} from './meeting-guests';

const DAY_MS = 86_400_000;

/** A distinct 64-char hex hash per call — the shape `apps/api`'s mint produces. */
let hashSeq = 0;
function tokenHash(): string {
  hashSeq++;
  return `${hashSeq}`.padStart(64, 'a');
}

/** A valid client-side `guest` invite input. Overrides ride on top. */
function inviteInput(overrides: Partial<CreateMeetingGuestInput> = {}): CreateMeetingGuestInput {
  return {
    email: `colleague${(hashSeq += 1)}@northwind.test`,
    name: 'Dana Colleague',
    emailDomain: 'northwind.test',
    party: 'client',
    participationRole: 'guest',
    accessScope: 'meeting',
    inviteChannel: 'email',
    admission: 'pre_admitted',
    tokenHash: tokenHash(),
    expiresAt: new Date(Date.now() + 7 * DAY_MS),
    ...overrides,
  };
}

/** A raw row payload for the CHECK probes, which must bypass the repository entirely. */
function rawGuestRow(
  meetingId: string,
  invitedById: string,
  overrides: Partial<NewMeetingGuest> = {}
): NewMeetingGuest {
  return {
    meetingId,
    invitedById,
    email: `raw${(hashSeq += 1)}@northwind.test`,
    party: 'client',
    participationRole: 'guest',
    accessScope: 'meeting',
    inviteChannel: 'email',
    admission: 'pre_admitted',
    tokenHash: tokenHash(),
    expiresAt: new Date(Date.now() + 7 * DAY_MS),
    ...overrides,
  };
}

/** A valid anonymous LOBBY KNOCK input (client-side placeholder party). Overrides ride on top. */
function claimInput(
  meetingId: string,
  overrides: Partial<ClaimLobbyPlaceInput> = {}
): ClaimLobbyPlaceInput {
  return {
    meetingId,
    email: `knock${(hashSeq += 1)}@northwind.test`,
    name: 'Anonymous Visitor',
    emailDomain: 'northwind.test',
    party: 'client',
    accessScope: 'meeting',
    tokenHash: tokenHash(),
    expiresAt: new Date(Date.now() + 7 * DAY_MS),
    ...overrides,
  };
}

/**
 * The `audit_events` rows one guest holds for one action, oldest first. ONE helper rather
 * than a per-action copy — a second copy is both a Sonar new-code duplication finding and a
 * copy that keeps passing after the original's `entity_type` scoping is broken.
 *
 * Ordered by the BAL-426 trail contract — `created_at` then `seq`, both ascending. NEVER `id`:
 * it is `defaultRandom()`, and `created_at` is the TRANSACTION timestamp, so `(created_at, id)`
 * is a coin flip for rows written in one `db.transaction`.
 */
async function guestAuditRows(
  guestId: string,
  action: string
): Promise<{ actorUserId: string | null; metadata: Record<string, unknown> | null }[]> {
  return db
    .select({ actorUserId: auditEvents.actorUserId, metadata: auditEvents.metadata })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.entityType, 'meeting_guest'),
        eq(auditEvents.entityId, guestId),
        eq(auditEvents.action, action)
      )
    )
    .orderBy(asc(auditEvents.createdAt), asc(auditEvents.seq));
}

/** Every audit action recorded against one guest, for "wrote NOTHING" assertions. */
async function guestAuditActions(guestId: string): Promise<string[]> {
  const rows = await db
    .select({ action: auditEvents.action })
    .from(auditEvents)
    .where(and(eq(auditEvents.entityType, 'meeting_guest'), eq(auditEvents.entityId, guestId)));
  return rows.map((row) => row.action).sort((a, b) => a.localeCompare(b));
}

/**
 * Run `attempt` with `auditEventsRepository.record` forced to reject ONCE, and assert the
 * call it drives rejects with that error.
 *
 * ⚠ THE ONLY WAY TO PROVE THE `db.transaction` IN A WRITE PATH IS REAL. A failing audit sink
 * is the failure mode that can occur BETWEEN the row write and the history write; without
 * the transaction the row survives and the history does not, silently and permanently.
 * Shared by `decideAdmission` and `claimLobbyPlace` — one implementation, so the discipline
 * cannot rot in one copy (and so Sonar sees no new-code duplication).
 */
async function expectAuditFailureRollsBack(attempt: () => Promise<unknown>): Promise<void> {
  const spy = vi
    .spyOn(auditEventsRepository, 'record')
    .mockRejectedValueOnce(new Error('audit sink is down'));
  try {
    await expect(attempt()).rejects.toThrow('audit sink is down');
  } finally {
    spy.mockRestore();
  }
}

/** The whole stored row, for "byte-identical afterwards" assertions. */
async function readGuest(guestId: string): Promise<MeetingGuest> {
  const [row] = await db.select().from(meetingGuests).where(eq(meetingGuests.id, guestId));
  if (row === undefined) {
    throw new Error(`expected meeting_guests row ${guestId} to exist`);
  }
  return row;
}

// ── 1. createMany ────────────────────────────────────────────────────────────

describe('meetingGuestsRepository.createMany', () => {
  it('inserts the whole batch and writes ONE `meeting_guest.invited` audit row per guest', async () => {
    const { meeting } = await meetingFactory();
    const inviter = await userFactory();
    const first = inviteInput({ email: 'dana@northwind.test' });
    const second = inviteInput({ email: 'sam@northwind.test', participationRole: 'delegate' });

    const rows = await meetingGuestsRepository.createMany({
      meetingId: meeting.id,
      invitedById: inviter.id,
      guests: [first, second],
    });

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.email).sort()).toEqual([
      'dana@northwind.test',
      'sam@northwind.test',
    ]);
    for (const row of rows) {
      expect(row.meetingId).toBe(meeting.id);
      expect(row.invitedById).toBe(inviter.id);
      expect(row.accessCount).toBe(0);
      expect(row.revokedAt).toBeNull();
      expect(row.deletedAt).toBeNull();
      expect(row.admissionDecidedAt).toBeNull();
      const audits = await guestAuditRows(row.id, 'meeting_guest.invited');
      expect(audits).toHaveLength(1);
      expect(audits[0]?.actorUserId).toBe(inviter.id);
    }
  });

  it('stores the caller-supplied `token_hash` VERBATIM — @balo/db never hashes anything', async () => {
    // ⚠ The algorithm-pinning half that lives on this side of the seam. If the repository
    // ever "helpfully" re-hashed, every emailed join link would resolve nothing in
    // production while CI stayed green, because the landing hashes the raw token itself.
    const { meeting } = await meetingFactory();
    const inviter = await userFactory();
    const hash = tokenHash();

    const [row] = await meetingGuestsRepository.createMany({
      meetingId: meeting.id,
      invitedById: inviter.id,
      guests: [inviteInput({ tokenHash: hash })],
    });

    expect(row?.tokenHash).toBe(hash);
    expect(hash).toHaveLength(64);
  });

  it('is ATOMIC — a batch whose SECOND guest violates a CHECK writes no row and no audit row', async () => {
    const { meeting } = await meetingFactory();
    const inviter = await userFactory();

    await expect(
      meetingGuestsRepository.createMany({
        meetingId: meeting.id,
        invitedById: inviter.id,
        guests: [
          inviteInput({ email: 'ok@northwind.test' }),
          // Expert-side DELEGATE — expert substitution, refused by
          // `meeting_guest_delegate_is_client_side`.
          inviteInput({
            email: 'bad@cloudpeak.test',
            party: 'expert',
            participationRole: 'delegate',
          }),
        ],
      })
    ).rejects.toMatchObject({ code: '23514' });

    // The valid first guest must NOT have survived the failed batch.
    await expect(meetingGuestsRepository.listLiveByMeeting(meeting.id)).resolves.toEqual([]);
    const audits = await db
      .select({ id: auditEvents.id })
      .from(auditEvents)
      .where(eq(auditEvents.entityType, 'meeting_guest'));
    expect(audits).toEqual([]);
  });

  it('refuses a duplicate LIVE (meeting, party, email) with 23505 — the caller maps it, never pre-checks', async () => {
    const { meeting } = await meetingFactory();
    const inviter = await userFactory();
    await meetingGuestsRepository.createMany({
      meetingId: meeting.id,
      invitedById: inviter.id,
      guests: [inviteInput({ email: 'dana@northwind.test' })],
    });

    await expect(
      meetingGuestsRepository.createMany({
        meetingId: meeting.id,
        invitedById: inviter.id,
        guests: [inviteInput({ email: 'dana@northwind.test' })],
      })
    ).rejects.toMatchObject({ code: '23505' });
  });

  /**
   * ⚠⚠ THE CROSS-PARTY EMAIL-EXISTENCE ORACLE, CLOSED BY THE INDEX KEY ITSELF.
   *
   * The unique is `(meeting_id, party, email)`, not `(meeting_id, email)`. If it spanned
   * both sides, its 23505 — which the service maps to a user-visible
   * `409 guest_already_invited` — would answer a question about the COUNTERPARTY's roster.
   * A client-side member could then walk a list of candidate addresses against a meeting
   * they legitimately belong to and read the status code as an answer: 409 ⇒ "the expert
   * side already invited this exact address", 201 ⇒ "they did not" (and, as a bonus, mail
   * the guessed address from Balo's sending domain).
   *
   * That single bit defeats every field-level concealment control in
   * `projectGuestForViewer` at once — key-absence for `email`, `emailDomain` concealment
   * and `accessScope` concealment are all designed to stop precisely this inference, and a
   * status code would have routed around all three.
   *
   * The assertion is the OBSERVABLE one: from the client side, "an expert-side guest with
   * this address already exists" and "nobody has this address" are INDISTINGUISHABLE —
   * both succeed.
   */
  it('a client-side invite SUCCEEDS whether or not the SAME address is already an expert-side guest', async () => {
    const inviter = await userFactory();
    const probed = 'dana@northwind.test';

    // (a) The address is nowhere on the meeting.
    const clean = await meetingFactory();
    const [clientOnClean] = await meetingGuestsRepository.createMany({
      meetingId: clean.meeting.id,
      invitedById: inviter.id,
      guests: [inviteInput({ email: probed, party: 'client' })],
    });

    // (b) The EXPERT side already holds a live invite for that same address.
    const seeded = await meetingFactory();
    await meetingGuestsRepository.createMany({
      meetingId: seeded.meeting.id,
      invitedById: inviter.id,
      guests: [inviteInput({ email: probed, party: 'expert' })],
    });
    const [clientOnSeeded] = await meetingGuestsRepository.createMany({
      meetingId: seeded.meeting.id,
      invitedById: inviter.id,
      guests: [inviteInput({ email: probed, party: 'client' })],
    });

    // Same outcome on both meetings — the client side learns nothing either way.
    expect(clientOnClean?.party).toBe('client');
    expect(clientOnSeeded?.party).toBe('client');
    await expect(meetingGuestsRepository.countLiveByMeeting(clean.meeting.id)).resolves.toBe(1);
    await expect(meetingGuestsRepository.countLiveByMeeting(seeded.meeting.id)).resolves.toBe(2);
  });

  it('still refuses a duplicate WITHIN one party (the invariant is per-side, not abandoned)', async () => {
    const { meeting } = await meetingFactory();
    const inviter = await userFactory();
    await meetingGuestsRepository.createMany({
      meetingId: meeting.id,
      invitedById: inviter.id,
      guests: [inviteInput({ email: 'dana@northwind.test', party: 'expert' })],
    });

    await expect(
      meetingGuestsRepository.createMany({
        meetingId: meeting.id,
        invitedById: inviter.id,
        guests: [inviteInput({ email: 'dana@northwind.test', party: 'expert' })],
      })
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('the SAME email on a DIFFERENT meeting is a different slot', async () => {
    const inviter = await userFactory();
    const one = await meetingFactory();
    const two = await meetingFactory();

    for (const seeded of [one, two]) {
      await meetingGuestsRepository.createMany({
        meetingId: seeded.meeting.id,
        invitedById: inviter.id,
        guests: [inviteInput({ email: 'dana@northwind.test' })],
      });
    }

    await expect(meetingGuestsRepository.countLiveByMeeting(one.meeting.id)).resolves.toBe(1);
    await expect(meetingGuestsRepository.countLiveByMeeting(two.meeting.id)).resolves.toBe(1);
  });
});

// ── 2. THE SOFT-DELETE / PARTIAL-UNIQUE REGRESSION ───────────────────────────

describe('re-invite after removal (reference_softdelete_nonpartial_unique_recreate)', () => {
  it('invite → revoke → RE-INVITE the same email on the same meeting SUCCEEDS, with a fresh token', async () => {
    // ⚠ THE REGRESSION THIS TABLE'S PARTIAL UNIQUE EXISTS FOR. With a NON-partial
    // `(meeting_id, party, email)` unique, removing a guest would permanently occupy their slot
    // and re-inviting them would be impossible forever — a product dead end reachable by
    // one mis-specified index.
    const { meeting } = await meetingFactory();
    const inviter = await userFactory();

    const [firstInvite] = await meetingGuestsRepository.createMany({
      meetingId: meeting.id,
      invitedById: inviter.id,
      guests: [inviteInput({ email: 'dana@northwind.test' })],
    });
    if (firstInvite === undefined) {
      throw new Error('expected the first invite to be inserted');
    }

    await meetingGuestsRepository.revoke({
      guestId: firstInvite.id,
      revokedByUserId: inviter.id,
    });

    const [reInvite] = await meetingGuestsRepository.createMany({
      meetingId: meeting.id,
      invitedById: inviter.id,
      guests: [inviteInput({ email: 'dana@northwind.test' })],
    });

    expect(reInvite?.id).not.toBe(firstInvite.id);
    expect(reInvite?.tokenHash).not.toBe(firstInvite.tokenHash);
    await expect(meetingGuestsRepository.countLiveByMeeting(meeting.id)).resolves.toBe(1);
  });

  it('a SOFT-DELETED-but-not-revoked guest also frees the slot (both halves of the predicate)', async () => {
    const { meeting } = await meetingFactory();
    const inviter = await userFactory();
    const seeded = await meetingGuestFactory({
      meetingId: meeting.id,
      invitedById: inviter.id,
      values: { email: 'dana@northwind.test', deletedAt: new Date() },
    });
    expect(seeded.guest.revokedAt).toBeNull();

    const [reInvite] = await meetingGuestsRepository.createMany({
      meetingId: meeting.id,
      invitedById: inviter.id,
      guests: [inviteInput({ email: 'dana@northwind.test' })],
    });
    expect(reInvite?.id).not.toBe(seeded.guest.id);
  });
});

// ── 3. THE UNIFORM-UNDEFINED LOOKUP ──────────────────────────────────────────

describe('meetingGuestsRepository.findLiveByTokenHash', () => {
  it('resolves a LIVE token to its guest AND meeting', async () => {
    const { meeting } = await meetingFactory();
    const seeded = await meetingGuestFactory({ meetingId: meeting.id });

    const resolved = await meetingGuestsRepository.findLiveByTokenHash(seeded.guest.tokenHash);

    expect(resolved?.guest.id).toBe(seeded.guest.id);
    expect(resolved?.meeting.id).toBe(meeting.id);
  });

  it('returns `undefined` IDENTICALLY for every not-live case — never an existence oracle', async () => {
    // ⚠ ONE ASSERTION SHAPE FOR ALL OF THEM, on purpose: the landing renders ONE identical
    // "link is no longer active" card for each, so any divergence here (a throw, a null, a
    // partial row) would leak whether a token ever existed.
    const inviter = await userFactory();

    const expired = await meetingGuestFactory({
      invitedById: inviter.id,
      values: { expiresAt: new Date(Date.now() - DAY_MS) },
    });
    const revoked = await meetingGuestFactory({
      invitedById: inviter.id,
      values: { revokedAt: new Date(), revokedByUserId: inviter.id },
    });
    const softDeleted = await meetingGuestFactory({
      invitedById: inviter.id,
      values: { deletedAt: new Date() },
    });
    const denied = await meetingGuestFactory({
      invitedById: inviter.id,
      values: {
        admission: 'denied',
        admissionDecidedAt: new Date(),
        admittedByUserId: inviter.id,
      },
    });
    const cancelledMeeting = await meetingFactory({ values: { status: 'cancelled' } });
    const onCancelled = await meetingGuestFactory({ meetingId: cancelledMeeting.meeting.id });
    const deletedMeeting = await meetingFactory({ values: { deletedAt: new Date() } });
    const onDeleted = await meetingGuestFactory({ meetingId: deletedMeeting.meeting.id });

    const cases: [string, string][] = [
      ['a WRONG token', 'f'.repeat(64)],
      ['an EXPIRED token', expired.guest.tokenHash],
      ['a REVOKED token', revoked.guest.tokenHash],
      ['a SOFT-DELETED token', softDeleted.guest.tokenHash],
      ['a DENIED guest', denied.guest.tokenHash],
      ['a CANCELLED meeting', onCancelled.guest.tokenHash],
      ['a SOFT-DELETED meeting', onDeleted.guest.tokenHash],
    ];

    for (const [label, hash] of cases) {
      await expect(
        meetingGuestsRepository.findLiveByTokenHash(hash),
        label
      ).resolves.toBeUndefined();
    }
  });

  it('an ENDED meeting STILL resolves — the deliberate asymmetry with the mutation gate', async () => {
    // ⚠ DO NOT "TIDY" THIS INTO AGREEING WITH THE INVITE GATE, which refuses `ended`. An
    // ended meeting's link is the guest's only handle on the recap BAL-388 will attach to
    // it; inviting someone to a call that already happened is meaningless. Both directions
    // are deliberate, and this test is the pin.
    const ended = await meetingFactory({
      values: { status: 'ended', outcome: 'completed', endedAt: new Date() },
    });
    const seeded = await meetingGuestFactory({ meetingId: ended.meeting.id });

    const resolved = await meetingGuestsRepository.findLiveByTokenHash(seeded.guest.tokenHash);
    expect(resolved?.guest.id).toBe(seeded.guest.id);
  });

  /**
   * ⚠ THE OTHER HALF OF THAT ASYMMETRY, AND THE REASON `removeGuest` RUNS NO STATE CHECK.
   * A link that outlives the call for 7 days is a credential that must remain REVOCABLE for
   * those 7 days — otherwise the invite email's "if your invitation is withdrawn, the link
   * stops working straight away" is false for the entire window, and the retrospective
   * `engagement` grant has no off switch.
   */
  it('a guest on an ENDED meeting can still be REVOKED, and the link dies immediately', async () => {
    const ended = await meetingFactory({
      values: { status: 'ended', outcome: 'completed', endedAt: new Date() },
    });
    const remover = await userFactory();
    const seeded = await meetingGuestFactory({ meetingId: ended.meeting.id });

    // Live before removal, gone after — on a meeting that has already happened.
    await expect(
      meetingGuestsRepository.findLiveByTokenHash(seeded.guest.tokenHash)
    ).resolves.toBeDefined();

    const revoked = await meetingGuestsRepository.revoke({
      guestId: seeded.guest.id,
      revokedByUserId: remover.id,
    });

    expect(revoked?.revokedAt).not.toBeNull();
    await expect(
      meetingGuestsRepository.findLiveByTokenHash(seeded.guest.tokenHash)
    ).resolves.toBeUndefined();
  });
});

// ── 4. THE NON-PARTIAL TOKEN UNIQUE ──────────────────────────────────────────

describe('meeting_guest_token_hash_idx (NON-PARTIAL, deliberately)', () => {
  it('enforces uniqueness ACROSS revoked and soft-deleted rows', async () => {
    // ⚠ This is what makes the landing lookup TOTAL — it resolves (to `undefined`) across
    // every state instead of becoming an oracle. A PARTIAL index here would let a hash
    // recur once its first holder was revoked, and the lookup would then be ambiguous.
    const inviter = await userFactory();
    const collidingHash = tokenHash();

    const revoked = await meetingGuestFactory({
      invitedById: inviter.id,
      values: {
        tokenHash: collidingHash,
        revokedAt: new Date(),
        revokedByUserId: inviter.id,
        deletedAt: new Date(),
      },
    });
    expect(revoked.guest.tokenHash).toBe(collidingHash);

    const { meeting } = await meetingFactory();
    await expectConstraintViolation('23505', (tx) =>
      tx.insert(meetingGuests).values(
        rawGuestRow(meeting.id, inviter.id, {
          tokenHash: collidingHash,
        })
      )
    );
  });
});

// ── 5. decideAdmission ───────────────────────────────────────────────────────

describe('meetingGuestsRepository.decideAdmission', () => {
  it('moves a PENDING guest to admitted, stamping the decision AND its attribution together', async () => {
    const host = await userFactory();
    const seeded = await meetingGuestFactory({ values: { admission: 'pending' } });

    const decided = await meetingGuestsRepository.decideAdmission({
      guestId: seeded.guest.id,
      decision: 'admitted',
      deciderUserId: host.id,
    });

    expect(decided?.admission).toBe('admitted');
    expect(decided?.admittedByUserId).toBe(host.id);
    expect(decided?.admissionDecidedAt).not.toBeNull();
  });

  it('denies a PENDING guest, and a denied guest stops resolving their own token', async () => {
    const host = await userFactory();
    const seeded = await meetingGuestFactory({ values: { admission: 'pending' } });

    const decided = await meetingGuestsRepository.decideAdmission({
      guestId: seeded.guest.id,
      decision: 'denied',
      deciderUserId: host.id,
    });

    expect(decided?.admission).toBe('denied');
    await expect(
      meetingGuestsRepository.findLiveByTokenHash(seeded.guest.tokenHash)
    ).resolves.toBeUndefined();
  });

  /**
   * ── ⚠⚠ THE DENIAL STAMPS `revoked_at`, AND THIS IS THE TEST THAT MAKES IT LOAD-BEARING ───
   *
   * `meeting_guest_meeting_email_live_idx` is partial on `deleted_at IS NULL AND
   * revoked_at IS NULL` and NOTHING ELSE — no `admission` predicate, no `expires_at`
   * predicate, and expiry does not vacate a unique index in any case. So before this stamp
   * existed a denied row held its `(meeting, party, email)` slot FOREVER and the host who
   * pressed Deny could never afterwards invite that address by email.
   */
  it('a DENIAL stamps revoked_at + its attribution — an ADMIT stamps neither', async () => {
    const host = await userFactory();
    const denied = await meetingGuestFactory({ values: { admission: 'pending' } });
    const admitted = await meetingGuestFactory({ values: { admission: 'pending' } });

    const deniedRow = await meetingGuestsRepository.decideAdmission({
      guestId: denied.guest.id,
      decision: 'denied',
      deciderUserId: host.id,
    });
    const admittedRow = await meetingGuestsRepository.decideAdmission({
      guestId: admitted.guest.id,
      decision: 'admitted',
      deciderUserId: host.id,
    });

    expect(deniedRow?.revokedAt).not.toBeNull();
    expect(deniedRow?.revokedByUserId).toBe(host.id);
    // ⚠ NOT A SOFT DELETE. `revoke` stamps `deleted_at` too; a denial deliberately does not,
    // so the two states stay distinguishable on the row itself and the refusal survives as
    // evidence rather than disappearing.
    expect(deniedRow?.deletedAt).toBeNull();

    // ⚠⚠ AN ADMIT MUST NOT STAMP IT. Every "live" read is predicated on
    // `revoked_at IS NULL`, so an admitted guest carrying it would be instantly unable to
    // resolve their own token — i.e. admitted into a room they cannot enter.
    expect(admittedRow?.revokedAt).toBeNull();
    expect(admittedRow?.revokedByUserId).toBeNull();
    await expect(
      meetingGuestsRepository.findLiveByTokenHash(admitted.guest.tokenHash)
    ).resolves.toBeDefined();
  });

  it('⚠⚠ a DENIAL FREES THE ADDRESS — the host can then invite that person properly', async () => {
    // THE DEFECT THIS CLOSES, end to end and in the exact order a host performs it: deny the
    // anonymous knock, then invite the same human by email. That second step used to raise
    // `23505` → a `409 guest_already_invited` that was FALSE and had no recovery anywhere.
    const host = await userFactory();
    const inviter = await userFactory();
    const { meeting } = await meetingFactory();

    const knock = await meetingGuestsRepository.claimLobbyPlace(
      claimInput(meeting.id, { email: 'alice@acme.test', party: 'client' })
    );
    if (knock === undefined) throw new Error('expected the knock to be inserted');

    await meetingGuestsRepository.decideAdmission({
      guestId: knock.id,
      decision: 'denied',
      deciderUserId: host.id,
    });

    const invited = await meetingGuestsRepository.createMany({
      meetingId: meeting.id,
      invitedById: inviter.id,
      guests: [inviteInput({ email: 'alice@acme.test', party: 'client' })],
    });

    expect(invited).toHaveLength(1);
    expect(invited[0]?.admission).toBe('pre_admitted');
    expect(invited[0]?.id).not.toBe(knock.id);
  });

  it('a DENIAL also frees the address for a fresh KNOCK — denial is not an identity ban', async () => {
    // ⚠ Decision 10, already accepted: a bare link plus a self-declared address cannot support
    // a durable ban, and the property that matters is untouched — the room is private, so the
    // re-knock mints NOTHING without a second explicit host admit.
    const host = await userFactory();
    const { meeting } = await meetingFactory();

    const first = await meetingGuestsRepository.claimLobbyPlace(
      claimInput(meeting.id, { email: 'dana@northwind.test' })
    );
    if (first === undefined) throw new Error('expected the first knock to be inserted');

    await meetingGuestsRepository.decideAdmission({
      guestId: first.id,
      decision: 'denied',
      deciderUserId: host.id,
    });

    const second = await meetingGuestsRepository.claimLobbyPlace(
      claimInput(meeting.id, { email: 'dana@northwind.test' })
    );

    expect(second).toBeDefined();
    expect(second?.id).not.toBe(first.id);
    expect(second?.admission).toBe('pending');
  });

  it('a DENIED row drops out of listLiveByMeeting — the ACCEPTED cost, pinned deliberately', async () => {
    // ⚠ NOT AN OVERSIGHT. `revoked_at` is what every "live" read filters on, so stamping it on
    // a denial necessarily removes the row from the roster projection. BAL-436's panel will
    // therefore not show denied entries; the durable record is the `meeting_guest.denied`
    // audit row asserted below, which is where a disputed decision is reconstructed from.
    const host = await userFactory();
    const { meeting } = await meetingFactory();
    const knock = await meetingGuestsRepository.claimLobbyPlace(claimInput(meeting.id));
    if (knock === undefined) throw new Error('expected the knock to be inserted');

    await expect(meetingGuestsRepository.listLiveByMeeting(meeting.id)).resolves.toHaveLength(1);

    await meetingGuestsRepository.decideAdmission({
      guestId: knock.id,
      decision: 'denied',
      deciderUserId: host.id,
    });

    await expect(meetingGuestsRepository.listLiveByMeeting(meeting.id)).resolves.toEqual([]);
    await expect(guestAuditRows(knock.id, 'meeting_guest.denied')).resolves.toHaveLength(1);
    // …and the row itself is still there, un-deleted, carrying its decision.
    const after = await readGuest(knock.id);
    expect(after.admission).toBe('denied');
    expect(after.deletedAt).toBeNull();
  });

  /**
   * ── THE ADR-1030 OBLIGATION BAL-408 DEFERRED AND BAL-132 DISCHARGES ────────────────────
   * BAL-408 shipped admit/deny with no `audit_events` row, accepted ONLY while nothing could
   * produce a `pending` guest. `claimLobbyPlace` (below) ends that window, so the write lands
   * here. The three tests below pin all three halves of the contract: the row EXISTS, it
   * DISTINGUISHES admit from deny, and a NO-OP writes NOTHING.
   */
  it('writes exactly ONE `meeting_guest.admitted` audit row, attributed to the decider', async () => {
    const host = await userFactory();
    const seeded = await meetingGuestFactory({ values: { admission: 'pending' } });

    await meetingGuestsRepository.decideAdmission({
      guestId: seeded.guest.id,
      decision: 'admitted',
      deciderUserId: host.id,
    });

    const audits = await guestAuditRows(seeded.guest.id, 'meeting_guest.admitted');
    expect(audits).toHaveLength(1);
    expect(audits[0]?.actorUserId).toBe(host.id);
    expect(audits[0]?.metadata).toMatchObject({
      meetingId: seeded.meetingId,
      party: 'client',
      decision: 'admitted',
      inviteChannel: 'email',
    });
    // ⚠ NEVER the token hash — an audit row is a durable, widely-readable record and
    // `token_hash` is the only secret-adjacent value on the guest row.
    expect(JSON.stringify(audits[0]?.metadata)).not.toContain(seeded.guest.tokenHash);
    // The two actions are DISTINCT, not one `meeting_guest.decided` with a field.
    await expect(guestAuditActions(seeded.guest.id)).resolves.toEqual(['meeting_guest.admitted']);
  });

  it('writes a `meeting_guest.denied` row for the other branch — the two are distinguishable', async () => {
    const host = await userFactory();
    const seeded = await meetingGuestFactory({ values: { admission: 'pending' } });

    await meetingGuestsRepository.decideAdmission({
      guestId: seeded.guest.id,
      decision: 'denied',
      deciderUserId: host.id,
    });

    const denials = await guestAuditRows(seeded.guest.id, 'meeting_guest.denied');
    expect(denials).toHaveLength(1);
    expect(denials[0]?.metadata).toMatchObject({ decision: 'denied' });
    await expect(guestAuditRows(seeded.guest.id, 'meeting_guest.admitted')).resolves.toEqual([]);
  });

  it('a NO-OP decision writes ZERO audit rows — history must not record what did not happen', async () => {
    // ⚠ `revoke`'s discipline, applied here: `undefined` is returned BEFORE the audit call.
    // Without it, the LOSER of a two-host race would be indistinguishable from the winner in
    // `audit_events` — the exact review a disputed call turns on.
    const host = await userFactory();
    const preAdmitted = await meetingGuestFactory(); // default admission, not pending

    await expect(
      meetingGuestsRepository.decideAdmission({
        guestId: preAdmitted.guest.id,
        decision: 'admitted',
        deciderUserId: host.id,
      })
    ).resolves.toBeUndefined();

    await expect(guestAuditActions(preAdmitted.guest.id)).resolves.toEqual([]);
  });

  it('is ATOMIC — a failing audit write rolls the admission back with it', async () => {
    // ⚠ THE WHOLE POINT OF THE `db.transaction` BAL-132 ADDS. Before it, the update was a
    // bare statement, so an audit failure would have left an ADMITTED guest with no history.
    const host = await userFactory();
    const seeded = await meetingGuestFactory({ values: { admission: 'pending' } });

    await expectAuditFailureRollsBack(() =>
      meetingGuestsRepository.decideAdmission({
        guestId: seeded.guest.id,
        decision: 'admitted',
        deciderUserId: host.id,
      })
    );

    const after = await readGuest(seeded.guest.id);
    expect(after.admission).toBe('pending');
    expect(after.admissionDecidedAt).toBeNull();
    expect(after.admittedByUserId).toBeNull();
    await expect(guestAuditActions(seeded.guest.id)).resolves.toEqual([]);
  });

  it('returns `undefined` from ANY non-pending state — no silent transition', async () => {
    const host = await userFactory();
    const preAdmitted = await meetingGuestFactory(); // default admission
    const alreadyDecided = await meetingGuestFactory({
      values: {
        admission: 'admitted',
        admissionDecidedAt: new Date(),
        admittedByUserId: host.id,
      },
    });
    const revoked = await meetingGuestFactory({
      values: { admission: 'pending', revokedAt: new Date(), revokedByUserId: host.id },
    });
    const softDeleted = await meetingGuestFactory({
      values: { admission: 'pending', deletedAt: new Date() },
    });

    for (const [label, guestId] of [
      ['pre_admitted', preAdmitted.guest.id],
      ['already admitted', alreadyDecided.guest.id],
      ['revoked', revoked.guest.id],
      ['soft-deleted', softDeleted.guest.id],
    ] as [string, string][]) {
      await expect(
        meetingGuestsRepository.decideAdmission({
          guestId,
          decision: 'admitted',
          deciderUserId: host.id,
        }),
        label
      ).resolves.toBeUndefined();
    }

    // …and the pre-admitted row is genuinely untouched, not merely unreported.
    const [after] = await db
      .select()
      .from(meetingGuests)
      .where(eq(meetingGuests.id, preAdmitted.guest.id));
    expect(after?.admission).toBe('pre_admitted');
    expect(after?.admissionDecidedAt).toBeNull();
  });

  it('is a COMPARE-AND-SET — a second decision on the same row finds nothing to decide', async () => {
    const hostA = await userFactory();
    const hostB = await userFactory();
    const seeded = await meetingGuestFactory({ values: { admission: 'pending' } });

    const first = await meetingGuestsRepository.decideAdmission({
      guestId: seeded.guest.id,
      decision: 'admitted',
      deciderUserId: hostA.id,
    });
    const second = await meetingGuestsRepository.decideAdmission({
      guestId: seeded.guest.id,
      decision: 'denied',
      deciderUserId: hostB.id,
    });

    expect(first?.admittedByUserId).toBe(hostA.id);
    expect(second).toBeUndefined();
    // ⚠ ASSERTED SEQUENTIALLY, NOT VIA RACING CLIENTS — memory
    // `reference_db_integration_harness_no_concurrency`: the harness is a `max:1` pool inside
    // ONE per-test transaction, so genuine concurrency is INEXPRESSIBLE here. Two ordinary
    // calls prove the same predicate. The audit trail must show exactly ONE decision, and no
    // trace at all of hostB's denial.
    await expect(guestAuditActions(seeded.guest.id)).resolves.toEqual(['meeting_guest.admitted']);
  });
});

// ── 5b. claimLobbyPlace — the anonymous lobby knock (BAL-132) ────────────────

describe('meetingGuestsRepository.claimLobbyPlace', () => {
  it('inserts a `pending` / `link` / null-inviter row and audits it with NO actor', async () => {
    const { meeting } = await meetingFactory();

    const row = await meetingGuestsRepository.claimLobbyPlace(
      claimInput(meeting.id, { email: 'visitor@northwind.test', name: 'Dana Visitor' })
    );

    expect(row?.meetingId).toBe(meeting.id);
    // ⚠ THE WHOLE REASON MIGRATION 0064 EXISTS. A knock has no inviter, and there is no
    // honest non-null value for one.
    expect(row?.invitedById).toBeNull();
    expect(row?.inviteChannel).toBe('link');
    expect(row?.admission).toBe('pending');
    expect(row?.participationRole).toBe('guest');
    // `meeting_guest_admission_terminal_stamped` is a BICONDITIONAL — a non-terminal
    // admission MUST be unstamped, so an insert that "helpfully" stamped would 23514.
    expect(row?.admissionDecidedAt).toBeNull();
    expect(row?.admittedByUserId).toBeNull();
    expect(row?.revokedAt).toBeNull();
    expect(row?.deletedAt).toBeNull();
    expect(row?.accessCount).toBe(0);
    expect(row?.email).toBe('visitor@northwind.test');

    if (row === undefined) {
      throw new Error('expected the knock to be inserted');
    }
    const audits = await guestAuditRows(row.id, 'meeting_guest.self_claimed');
    expect(audits).toHaveLength(1);
    // An anonymous visitor is not an actor; `audit_events.actor_user_id` is nullable for
    // exactly this case.
    expect(audits[0]?.actorUserId).toBeNull();
    expect(audits[0]?.metadata).toMatchObject({
      meetingId: meeting.id,
      email: 'visitor@northwind.test',
      party: 'client',
      participationRole: 'guest',
      accessScope: 'meeting',
      inviteChannel: 'link',
    });
    expect(JSON.stringify(audits[0]?.metadata)).not.toContain(row.tokenHash);
  });

  /**
   * ⚠⚠ THE `ON CONFLICT` PARTIAL-INDEX ARBITER TEST — the single highest-risk line in this
   * slice, and the ONLY thing that can prove it.
   *
   * `meeting_guest_meeting_email_live_idx` is PARTIAL
   * (`deleted_at IS NULL AND revoked_at IS NULL`). Postgres will only infer a partial index
   * for `ON CONFLICT` if the arbiter predicate matches it, and an arbiter carrying a BIND
   * PARAMETER can never match — the statement fails
   * `42P10 there is no unique or exclusion constraint matching the ON CONFLICT specification`
   * (memory `reference_pg_partial_index_arbiter_param_42p10`). No unit test, no typecheck and
   * no schema snapshot can see that; only a real conflict against a real Postgres can.
   *
   * ⚠ THE PIN SURVIVES THE SWITCH TO `DO NOTHING`. Arbiter inference is required for
   * `ON CONFLICT (cols) WHERE pred DO NOTHING` exactly as it was for `DO UPDATE`, so this still
   * drives a genuine second knock onto a LIVE incumbent and would still fail 42P10 if the
   * predicate ever stopped matching the index.
   */
  it('a RE-KNOCK from the same address hits the arbiter and is a NO-OP (the 42P10 pin)', async () => {
    const { meeting } = await meetingFactory();
    const firstHash = tokenHash();
    const secondHash = tokenHash();
    const laterExpiry = new Date(Date.now() + 9 * DAY_MS);

    const first = await meetingGuestsRepository.claimLobbyPlace(
      claimInput(meeting.id, {
        email: 'visitor@northwind.test',
        name: 'Dana',
        tokenHash: firstHash,
      })
    );
    if (first === undefined) {
      throw new Error('expected the first knock to be inserted');
    }
    const before = await readGuest(first.id);

    const second = await meetingGuestsRepository.claimLobbyPlace(
      claimInput(meeting.id, {
        email: 'visitor@northwind.test',
        name: 'Dana Visitor',
        tokenHash: secondHash,
        expiresAt: laterExpiry,
      })
    );

    // ⚠⚠ THE HIJACK FIX. The first cut ROTATED the incumbent's `token_hash`, `name` and
    // `expires_at` so that a person reloading the lobby would not 409. But a knock carries NO
    // proof of identity — only a meeting id and a self-declared address — so "the same person
    // reloading" and "a stranger who guessed a colleague's address" are THE SAME REQUEST, byte
    // for byte. Rotation therefore let a stranger silently invalidate a live credential and
    // inherit that queue position under a name and address of their own choosing.
    expect(second).toBeUndefined();

    // Not merely unreported — the incumbent row is genuinely BYTE-IDENTICAL.
    await expect(readGuest(first.id)).resolves.toEqual(before);

    // ⚠ THE ORIGINAL TOKEN STILL RESOLVES. That is the property that was broken: the
    // incumbent's poll keeps working instead of starting to answer "this link isn't active".
    await expect(meetingGuestsRepository.findLiveByTokenHash(firstHash)).resolves.toMatchObject({
      guest: { id: first.id },
    });
    // …and the impostor's token was never persisted anywhere.
    await expect(meetingGuestsRepository.findLiveByTokenHash(secondHash)).resolves.toBeUndefined();

    await expect(meetingGuestsRepository.countPendingLobbyKnocks(meeting.id)).resolves.toBe(1);

    // ⚠ INSERT-ONLY MEANS EXACTLY ONE AUDIT ROW PER GUEST ROW. A second one on the same
    // `entity_id` is now a bug rather than the rotation signal it used to be.
    await expect(guestAuditRows(first.id, 'meeting_guest.self_claimed')).resolves.toHaveLength(1);
  });

  it('NEVER touches a LIVE row in ANY admission state — `pending` included', async () => {
    // ⚠⚠ `ON CONFLICT DO NOTHING`. The earlier compare-and-set protected only the ALREADY-DECIDED
    // states, so it answered a success for a live `pending` incumbent and a refusal for the
    // rest — the response itself told a caller which one it was, an email-roster oracle sitting
    // on top of the hijack. Every live state now yields ONE outcome.
    const host = await userFactory();
    const inviter = await userFactory();

    const cases: [string, Partial<NewMeetingGuest>][] = [
      // ⚠ `pending` IS THE ONE THAT WAS EXPLOITABLE — it is first on purpose.
      ['pending', { admission: 'pending' }],
      [
        'admitted',
        { admission: 'admitted', admissionDecidedAt: new Date(), admittedByUserId: host.id },
      ],
      ['pre_admitted', { admission: 'pre_admitted' }],
      [
        'denied',
        { admission: 'denied', admissionDecidedAt: new Date(), admittedByUserId: host.id },
      ],
    ];

    for (const [label, values] of cases) {
      const { meeting } = await meetingFactory();
      const incumbent = await meetingGuestFactory({
        meetingId: meeting.id,
        invitedById: inviter.id,
        values: { email: 'taken@northwind.test', party: 'client', ...values },
      });
      const before = await readGuest(incumbent.guest.id);

      await expect(
        meetingGuestsRepository.claimLobbyPlace(
          claimInput(meeting.id, { email: 'taken@northwind.test', name: 'Impostor' })
        ),
        label
      ).resolves.toBeUndefined();

      // Not merely unreported — genuinely untouched.
      const after = await readGuest(incumbent.guest.id);
      expect(after, label).toEqual(before);
      await expect(guestAuditActions(incumbent.guest.id), label).resolves.toEqual([]);
      // ⚠ AND NO SECOND ROW WAS INSERTED for that address either.
      await expect(
        meetingGuestsRepository.listLiveByMeeting(meeting.id),
        label
      ).resolves.toHaveLength(1);
    }
  });

  it('two DIFFERENT addresses on one meeting both get their own place in the queue', async () => {
    const { meeting } = await meetingFactory();

    const one = await meetingGuestsRepository.claimLobbyPlace(
      claimInput(meeting.id, { email: 'dana@northwind.test' })
    );
    const two = await meetingGuestsRepository.claimLobbyPlace(
      claimInput(meeting.id, { email: 'sam@northwind.test' })
    );

    expect(one?.id).not.toBe(two?.id);
    await expect(meetingGuestsRepository.countPendingLobbyKnocks(meeting.id)).resolves.toBe(2);
  });

  it('the arbiter is PARTY-SCOPED — the same address may knock on each side independently', async () => {
    // The conflict target is `(meeting_id, party, email)`, matching the index key. Getting
    // the column list wrong would silently collapse the two sides into one slot.
    const { meeting } = await meetingFactory();

    const clientSide = await meetingGuestsRepository.claimLobbyPlace(
      claimInput(meeting.id, { email: 'dana@northwind.test', party: 'client' })
    );
    const expertSide = await meetingGuestsRepository.claimLobbyPlace(
      claimInput(meeting.id, { email: 'dana@northwind.test', party: 'expert' })
    );

    expect(clientSide?.id).not.toBe(expertSide?.id);
    expect(clientSide?.party).toBe('client');
    expect(expertSide?.party).toBe('expert');
  });

  it('a REVOKED or SOFT-DELETED knock vacates the slot — a fresh INSERT, not a rotation', async () => {
    // ⚠ The other half of the partial-index contract, and the
    // `reference_softdelete_nonpartial_unique_recreate` regression from the knock side: both
    // halves of the index predicate must vacate, or a denied-and-revoked visitor could never
    // be let back in even by a host who changed their mind.
    const inviter = await userFactory();

    for (const [label, values] of [
      ['revoked', { revokedAt: new Date(), revokedByUserId: inviter.id }],
      ['soft-deleted', { deletedAt: new Date() }],
    ] as [string, Partial<NewMeetingGuest>][]) {
      const { meeting } = await meetingFactory();
      const dead = await meetingGuestFactory({
        meetingId: meeting.id,
        invitedById: inviter.id,
        values: { email: 'dana@northwind.test', admission: 'pending', ...values },
      });

      const fresh = await meetingGuestsRepository.claimLobbyPlace(
        claimInput(meeting.id, { email: 'dana@northwind.test' })
      );

      expect(fresh?.id, label).not.toBe(dead.guest.id);
      expect(fresh?.admission, label).toBe('pending');
      expect(fresh?.invitedById, label).toBeNull();
    }
  });

  it('rejects a knock on a meeting that does not exist (23503) — no orphan queue entries', async () => {
    // ⚠ The repository is called DIRECTLY rather than through `expectConstraintViolation`,
    // and that is safe for the same reason that helper exists: `claimLobbyPlace` opens its
    // own `db.transaction`, which under the integration harness is a SAVEPOINT, so the 23503
    // rolls back to it and the outer per-test transaction survives (`test/setup-integration.ts`).
    // The service is expected to have resolved the meeting already; this is the backstop.
    await expect(
      meetingGuestsRepository.claimLobbyPlace(claimInput('00000000-0000-0000-0000-000000000000'))
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('a knock is projected by listLiveByMeeting with a NULL invitedById (the type ripple)', async () => {
    // ⚠ `MeetingGuestPublic.invitedById` widened to `string | null` in this slice. Every
    // reader must branch; `apps/web/src/app/join/[token]/page.tsx` is the one that did.
    const { meeting } = await meetingFactory();
    const knock = await meetingGuestsRepository.claimLobbyPlace(claimInput(meeting.id));

    const [projected] = await meetingGuestsRepository.listLiveByMeeting(meeting.id);
    expect(projected?.id).toBe(knock?.id);
    expect(projected?.invitedById).toBeNull();
    expect(projected?.admission).toBe('pending');
    expect(projected?.inviteChannel).toBe('link');
  });

  it('a knock can then be ADMITTED, and the same row carries both audit rows', async () => {
    // The end-to-end lifecycle this slice makes reachable for the first time: knock (no
    // actor) → host decision (attributed). Both live under one `entity_id`.
    const host = await userFactory();
    const { meeting } = await meetingFactory();
    const knock = await meetingGuestsRepository.claimLobbyPlace(claimInput(meeting.id));
    if (knock === undefined) {
      throw new Error('expected the knock to be inserted');
    }

    const decided = await meetingGuestsRepository.decideAdmission({
      guestId: knock.id,
      decision: 'admitted',
      deciderUserId: host.id,
    });

    expect(decided?.admission).toBe('admitted');
    expect(decided?.admittedByUserId).toBe(host.id);
    // ⚠ The admission is attributed even though the ROW has no inviter — `invited_by_id` and
    // `admitted_by_user_id` are independent attribution columns.
    expect(decided?.invitedById).toBeNull();
    await expect(guestAuditActions(knock.id)).resolves.toEqual([
      'meeting_guest.admitted',
      'meeting_guest.self_claimed',
    ]);
    const admittedAudit = await guestAuditRows(knock.id, 'meeting_guest.admitted');
    expect(admittedAudit[0]?.metadata).toMatchObject({ inviteChannel: 'link' });
  });

  it('is ATOMIC — a failing audit write rolls the knock back with it', async () => {
    const { meeting } = await meetingFactory();

    await expectAuditFailureRollsBack(() =>
      meetingGuestsRepository.claimLobbyPlace(
        claimInput(meeting.id, { email: 'visitor@northwind.test' })
      )
    );

    // Not merely unaudited — the queue entry itself never existed, so the visitor's retry
    // takes the INSERT arm cleanly rather than colliding with a half-written row.
    await expect(meetingGuestsRepository.countLiveByMeeting(meeting.id)).resolves.toBe(0);
    const orphans = await db
      .select({ id: meetingGuests.id })
      .from(meetingGuests)
      .where(eq(meetingGuests.meetingId, meeting.id));
    expect(orphans).toEqual([]);
  });
});

// ── 6. countLiveByMeeting / listLiveByMeeting / findLiveById ──────────────────

describe('meetingGuestsRepository — the live reads', () => {
  it('countLiveByMeeting EXCLUDES revoked and soft-deleted rows', async () => {
    const { meeting } = await meetingFactory();
    const inviter = await userFactory();

    await meetingGuestFactory({ meetingId: meeting.id, invitedById: inviter.id });
    await meetingGuestFactory({ meetingId: meeting.id, invitedById: inviter.id });
    await meetingGuestFactory({
      meetingId: meeting.id,
      invitedById: inviter.id,
      values: { revokedAt: new Date(), revokedByUserId: inviter.id },
    });
    await meetingGuestFactory({
      meetingId: meeting.id,
      invitedById: inviter.id,
      values: { deletedAt: new Date() },
    });

    await expect(meetingGuestsRepository.countLiveByMeeting(meeting.id)).resolves.toBe(2);
    await expect(meetingGuestsRepository.listLiveByMeeting(meeting.id)).resolves.toHaveLength(2);
  });

  it('countLiveByMeeting is 0 for a meeting with no guests at all', async () => {
    const { meeting } = await meetingFactory();
    await expect(meetingGuestsRepository.countLiveByMeeting(meeting.id)).resolves.toBe(0);
  });

  /**
   * ── ⚠⚠ BAL-132: SEATS AND QUEUE SLOTS ARE TWO DIFFERENT RESOURCES ──────────────────────
   *
   * `countLiveByMeeting` used to filter only `deleted_at` / `revoked_at`, which was correct
   * while `pre_admitted` was the only admission any writer could produce. The lobby makes
   * `pending` and `denied` reachable, and under the old predicate BOTH consumed a seat
   * permanently — `decideAdmission` stamps `admission`, NOT `revoked_at`, so a DENIED row
   * stayed "live" forever. Expired rows counted too.
   *
   * The consequence was NOT confined to the lobby: `inviteGuests` shares this counter, so a
   * handful of anonymous knocks from ONE address left the HOST unable to invite anybody by
   * email, with no way to clear it. Denying them did not help.
   */
  describe('⚠⚠ countLiveByMeeting counts SEATS, not rows', () => {
    it('EXCLUDES a `pending` knock — waiting is not holding a seat', async () => {
      const { meeting } = await meetingFactory();

      await meetingGuestsRepository.claimLobbyPlace(
        claimInput(meeting.id, { email: 'knocker@northwind.test' })
      );

      await expect(meetingGuestsRepository.countLiveByMeeting(meeting.id)).resolves.toBe(0);
      await expect(meetingGuestsRepository.countPendingLobbyKnocks(meeting.id)).resolves.toBe(1);
    });

    it('⚠⚠ EXCLUDES a `denied` row — and a DENY therefore FREES the slot it took', async () => {
      const host = await userFactory();
      const { meeting } = await meetingFactory();

      const knock = await meetingGuestsRepository.claimLobbyPlace(
        claimInput(meeting.id, { email: 'knocker@northwind.test' })
      );
      if (knock === undefined) throw new Error('expected the knock to be inserted');
      await expect(meetingGuestsRepository.countPendingLobbyKnocks(meeting.id)).resolves.toBe(1);

      await meetingGuestsRepository.decideAdmission({
        guestId: knock.id,
        decision: 'denied',
        deciderUserId: host.id,
      });

      // ⚠ NO SECOND WRITE AND NO SWEEP — the row simply drops out of both predicates.
      await expect(meetingGuestsRepository.countLiveByMeeting(meeting.id)).resolves.toBe(0);
      await expect(meetingGuestsRepository.countPendingLobbyKnocks(meeting.id)).resolves.toBe(0);
    });

    it('COUNTS an `admitted` knock — an admit converts a queue slot into a seat', async () => {
      const host = await userFactory();
      const { meeting } = await meetingFactory();

      const knock = await meetingGuestsRepository.claimLobbyPlace(
        claimInput(meeting.id, { email: 'knocker@northwind.test' })
      );
      if (knock === undefined) throw new Error('expected the knock to be inserted');

      await meetingGuestsRepository.decideAdmission({
        guestId: knock.id,
        decision: 'admitted',
        deciderUserId: host.id,
      });

      await expect(meetingGuestsRepository.countLiveByMeeting(meeting.id)).resolves.toBe(1);
      await expect(meetingGuestsRepository.countPendingLobbyKnocks(meeting.id)).resolves.toBe(0);
    });

    it('EXCLUDES an EXPIRED row — an expired handle occupies nothing', async () => {
      const { meeting } = await meetingFactory();
      const inviter = await userFactory();

      await meetingGuestFactory({ meetingId: meeting.id, invitedById: inviter.id });
      await meetingGuestFactory({
        meetingId: meeting.id,
        invitedById: inviter.id,
        values: { expiresAt: new Date(Date.now() - DAY_MS) },
      });

      // ⚠ `findLiveByTokenHash` already refuses to resolve an expired row, so counting it would
      // reserve a seat nobody can ever occupy.
      await expect(meetingGuestsRepository.countLiveByMeeting(meeting.id)).resolves.toBe(1);
    });

    it('⚠⚠ A FULL KNOCK QUEUE LEAVES THE PARTICIPANT COUNT AT ZERO (the host can still invite)', async () => {
      // The defect in one assertion: under the old single counter these knocks filled the
      // meeting and `inviteGuests` — which shares this exact counter — started refusing every
      // email invite the host tried to send.
      const { meeting } = await meetingFactory();

      for (const email of ['a@x.test', 'b@x.test', 'c@x.test', 'd@x.test', 'e@x.test']) {
        await meetingGuestsRepository.claimLobbyPlace(claimInput(meeting.id, { email }));
      }

      await expect(meetingGuestsRepository.countPendingLobbyKnocks(meeting.id)).resolves.toBe(5);
      await expect(meetingGuestsRepository.countLiveByMeeting(meeting.id)).resolves.toBe(0);
    });
  });

  describe('countPendingLobbyKnocks — the queue counter', () => {
    it('is 0 for a meeting with no knocks', async () => {
      const { meeting } = await meetingFactory();
      await expect(meetingGuestsRepository.countPendingLobbyKnocks(meeting.id)).resolves.toBe(0);
    });

    it('⚠ counts only `link`-channel rows — an emailed invitee is never queue noise', async () => {
      const { meeting } = await meetingFactory();
      const inviter = await userFactory();

      // A `pending` EMAIL-channel row cannot be produced by any shipped writer, but the
      // predicate is scoped to `link` so a future one could not inflate the lobby's bound.
      await meetingGuestFactory({
        meetingId: meeting.id,
        invitedById: inviter.id,
        values: { inviteChannel: 'email', admission: 'pending' },
      });
      await meetingGuestsRepository.claimLobbyPlace(
        claimInput(meeting.id, { email: 'knocker@northwind.test' })
      );

      await expect(meetingGuestsRepository.countPendingLobbyKnocks(meeting.id)).resolves.toBe(1);
    });

    it('excludes revoked, soft-deleted and expired knocks', async () => {
      const { meeting } = await meetingFactory();
      const inviter = await userFactory();

      const base = {
        inviteChannel: 'link' as const,
        admission: 'pending' as const,
        invitedById: null,
      };
      await meetingGuestFactory({
        meetingId: meeting.id,
        invitedById: inviter.id,
        values: { ...base, revokedAt: new Date(), revokedByUserId: inviter.id },
      });
      await meetingGuestFactory({
        meetingId: meeting.id,
        invitedById: inviter.id,
        values: { ...base, deletedAt: new Date() },
      });
      await meetingGuestFactory({
        meetingId: meeting.id,
        invitedById: inviter.id,
        values: { ...base, expiresAt: new Date(Date.now() - DAY_MS) },
      });

      await expect(meetingGuestsRepository.countPendingLobbyKnocks(meeting.id)).resolves.toBe(0);
    });

    it('is scoped to ONE meeting', async () => {
      const one = await meetingFactory();
      const two = await meetingFactory();

      await meetingGuestsRepository.claimLobbyPlace(
        claimInput(one.meeting.id, { email: 'knocker@northwind.test' })
      );

      await expect(meetingGuestsRepository.countPendingLobbyKnocks(one.meeting.id)).resolves.toBe(
        1
      );
      await expect(meetingGuestsRepository.countPendingLobbyKnocks(two.meeting.id)).resolves.toBe(
        0
      );
    });
  });

  it('listLiveByMeeting NEVER projects token_hash (nor expires_at / access_count)', async () => {
    // ⚠ `reference_drizzle_with_hydration_leaks_secrets`: this read reaches a route. The
    // assertion is on the KEY SET, not on a value, so a future `select()` widening to the
    // whole row fails here rather than shipping the hash to a browser.
    const { meeting } = await meetingFactory();
    const seeded = await meetingGuestFactory({ meetingId: meeting.id });

    const [row] = await meetingGuestsRepository.listLiveByMeeting(meeting.id);

    expect(row?.id).toBe(seeded.guest.id);
    expect(Object.keys(row ?? {}).sort((a, b) => a.localeCompare(b))).toEqual([
      'accessScope',
      'admission',
      'admissionDecidedAt',
      'createdAt',
      'email',
      'emailDomain',
      'id',
      'inviteChannel',
      'invitedById',
      'meetingId',
      'name',
      'participationRole',
      'party',
      'userId',
    ]);
  });

  it('findLiveById is SCOPED BY MEETING — a guest id from another meeting resolves to undefined', async () => {
    const inviter = await userFactory();
    const mine = await meetingFactory();
    const theirs = await meetingFactory();
    const seeded = await meetingGuestFactory({
      meetingId: theirs.meeting.id,
      invitedById: inviter.id,
    });

    await expect(
      meetingGuestsRepository.findLiveById(mine.meeting.id, seeded.guest.id)
    ).resolves.toBeUndefined();
    await expect(
      meetingGuestsRepository.findLiveById(theirs.meeting.id, seeded.guest.id)
    ).resolves.toMatchObject({ id: seeded.guest.id });
  });
});

// ── revoke / recordAccess / extendExpiryForMeeting ───────────────────────────

describe('meetingGuestsRepository.revoke', () => {
  it('stamps revoked_at + revoked_by + deleted_at, audits it, and kills the token instantly', async () => {
    const remover = await userFactory();
    const seeded = await meetingGuestFactory();

    const revoked = await meetingGuestsRepository.revoke({
      guestId: seeded.guest.id,
      revokedByUserId: remover.id,
    });

    expect(revoked?.revokedAt).not.toBeNull();
    expect(revoked?.revokedByUserId).toBe(remover.id);
    expect(revoked?.deletedAt).not.toBeNull();
    await expect(
      meetingGuestsRepository.findLiveByTokenHash(seeded.guest.tokenHash)
    ).resolves.toBeUndefined();

    const audits = await db
      .select({ actorUserId: auditEvents.actorUserId })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.entityId, seeded.guest.id),
          eq(auditEvents.action, 'meeting_guest.removed')
        )
      );
    expect(audits).toEqual([{ actorUserId: remover.id }]);
  });

  it('is IDEMPOTENT — a second revoke returns undefined and writes NO second audit row', async () => {
    const remover = await userFactory();
    const seeded = await meetingGuestFactory();

    await meetingGuestsRepository.revoke({
      guestId: seeded.guest.id,
      revokedByUserId: remover.id,
    });
    await expect(
      meetingGuestsRepository.revoke({ guestId: seeded.guest.id, revokedByUserId: remover.id })
    ).resolves.toBeUndefined();

    const audits = await db
      .select({ id: auditEvents.id })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.entityId, seeded.guest.id),
          eq(auditEvents.action, 'meeting_guest.removed')
        )
      );
    expect(audits).toHaveLength(1);
  });
});

describe('meetingGuestsRepository.recordAccess', () => {
  it('bumps access_count and stamps last_accessed_at', async () => {
    const seeded = await meetingGuestFactory();
    expect(seeded.guest.accessCount).toBe(0);
    expect(seeded.guest.lastAccessedAt).toBeNull();

    await meetingGuestsRepository.recordAccess(seeded.guest.id);
    await meetingGuestsRepository.recordAccess(seeded.guest.id);

    const [row] = await db
      .select()
      .from(meetingGuests)
      .where(eq(meetingGuests.id, seeded.guest.id));
    expect(row?.accessCount).toBe(2);
    expect(row?.lastAccessedAt).not.toBeNull();
  });
});

describe('meetingGuestsRepository.extendExpiryForMeeting (the BAL-409/410/411 hand-off)', () => {
  it('pushes every LIVE guest link out, and reports how many moved', async () => {
    const { meeting } = await meetingFactory();
    const inviter = await userFactory();
    const soon = new Date(Date.now() + DAY_MS);
    const live = await meetingGuestFactory({
      meetingId: meeting.id,
      invitedById: inviter.id,
      values: { expiresAt: soon },
    });
    const revoked = await meetingGuestFactory({
      meetingId: meeting.id,
      invitedById: inviter.id,
      values: { expiresAt: soon, revokedAt: new Date(), revokedByUserId: inviter.id },
    });

    const later = new Date(Date.now() + 30 * DAY_MS);
    await expect(meetingGuestsRepository.extendExpiryForMeeting(meeting.id, later)).resolves.toBe(
      1
    );

    const [movedLive] = await db
      .select()
      .from(meetingGuests)
      .where(eq(meetingGuests.id, live.guest.id));
    const [untouchedRevoked] = await db
      .select()
      .from(meetingGuests)
      .where(eq(meetingGuests.id, revoked.guest.id));
    expect(movedLive?.expiresAt.getTime()).toBe(later.getTime());
    expect(untouchedRevoked?.expiresAt.getTime()).toBe(soon.getTime());
  });

  it('NEVER SHORTENS a window — moving a meeting earlier is not a silent revocation', async () => {
    const { meeting } = await meetingFactory();
    const far = new Date(Date.now() + 30 * DAY_MS);
    const seeded = await meetingGuestFactory({
      meetingId: meeting.id,
      values: { expiresAt: far },
    });

    await expect(
      meetingGuestsRepository.extendExpiryForMeeting(meeting.id, new Date(Date.now() + DAY_MS))
    ).resolves.toBe(0);

    const [row] = await db
      .select()
      .from(meetingGuests)
      .where(eq(meetingGuests.id, seeded.guest.id));
    expect(row?.expiresAt.getTime()).toBe(far.getTime());
  });
});

describe('meetingGuestsRepository.rotateToken (BAL-436 — the re-send)', () => {
  /**
   * The ONE shape this method may ever rotate: a LIVE, `link`-channel, ADMITTED row.
   *
   * ⚠ `admissionDecidedAt` IS NOT DECORATION — `meeting_guest_admission_terminal_stamped`
   * makes it an IFF with a terminal `admission`, so an `admitted` row without it will not
   * insert at all.
   */
  async function resendableGuest(
    values: Partial<NewMeetingGuest> = {}
  ): ReturnType<typeof meetingGuestFactory> {
    return meetingGuestFactory({
      values: {
        inviteChannel: 'link',
        admission: 'admitted',
        admissionDecidedAt: new Date(),
        ...values,
      },
    });
  }

  async function linkResentAuditCount(guestId: string): Promise<number> {
    const audits = await db
      .select({ id: auditEvents.id })
      .from(auditEvents)
      .where(
        and(eq(auditEvents.entityId, guestId), eq(auditEvents.action, 'meeting_guest.link_resent'))
      );
    return audits.length;
  }

  it('⚠⚠ replaces the hash, refreshes the expiry, and KILLS the previous credential', async () => {
    const host = await userFactory();
    const seeded = await resendableGuest({ expiresAt: new Date(Date.now() + DAY_MS) });
    const oldHash = seeded.guest.tokenHash;
    const newHash = tokenHash();
    const newExpiry = new Date(Date.now() + 30 * DAY_MS);

    const rotated = await meetingGuestsRepository.rotateToken({
      meetingId: seeded.meetingId,
      guestId: seeded.guest.id,
      tokenHash: newHash,
      expiresAt: newExpiry,
      rotatedByUserId: host.id,
    });

    expect(rotated?.tokenHash).toBe(newHash);
    expect(rotated?.expiresAt.getTime()).toBe(newExpiry.getTime());

    // ⚠ THE WHOLE SECURITY PROPERTY: the OLD hash no longer resolves, so the link the guest
    // may still be holding is dead. Two live credentials on one row would be a second hijack
    // surface opened by the act of rescuing somebody.
    await expect(meetingGuestsRepository.findLiveByTokenHash(oldHash)).resolves.toBeUndefined();
    const resolved = await meetingGuestsRepository.findLiveByTokenHash(newHash);
    expect(resolved?.guest.id).toBe(seeded.guest.id);
  });

  it('appends ONE attributed `meeting_guest.link_resent` audit row, carrying no token hash', async () => {
    const host = await userFactory();
    const seeded = await resendableGuest();

    await meetingGuestsRepository.rotateToken({
      meetingId: seeded.meetingId,
      guestId: seeded.guest.id,
      tokenHash: tokenHash(),
      expiresAt: new Date(Date.now() + 7 * DAY_MS),
      rotatedByUserId: host.id,
    });

    const audits = await db
      .select({ actorUserId: auditEvents.actorUserId, metadata: auditEvents.metadata })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.entityId, seeded.guest.id),
          eq(auditEvents.action, 'meeting_guest.link_resent')
        )
      );
    expect(audits).toHaveLength(1);
    expect(audits[0]?.actorUserId).toBe(host.id);
    expect(JSON.stringify(audits[0]?.metadata)).not.toContain('tokenHash');
  });

  it('⚠ REFUSES a revoked row — a rotation must never undo a deliberate revocation', async () => {
    const host = await userFactory();
    const seeded = await resendableGuest();
    await meetingGuestsRepository.revoke({
      guestId: seeded.guest.id,
      revokedByUserId: host.id,
    });

    await expect(
      meetingGuestsRepository.rotateToken({
        meetingId: seeded.meetingId,
        guestId: seeded.guest.id,
        tokenHash: tokenHash(),
        expiresAt: new Date(Date.now() + 7 * DAY_MS),
        rotatedByUserId: host.id,
      })
    ).resolves.toBeUndefined();

    await expect(linkResentAuditCount(seeded.guest.id)).resolves.toBe(0);
  });

  /**
   * ⚠⚠ **THE `WHERE` CLAUSE IS THE BOUNDARY — THERE IS NO RLS BEHIND IT.** Each case below
   * calls the method with a shape the SERVICE would have refused first, precisely to prove the
   * refusal does not depend on the service. A caller that skips the pre-read still cannot widen
   * the shape.
   *
   * ⚠ CORRECTED BY BAL-442: this note used to say BAL-442's guest self-service arm "inherits this
   * primitive". It does not — that arm calls `rotatePendingLobbyToken`, because the
   * `admission = 'admitted'` case below excludes every row it can match. What is inherited is the
   * DISCIPLINE (tenancy and liveness live in the statement), not the function.
   */
  it('⚠⚠ REFUSES A CROSS-MEETING ROTATE — the tenancy scope is IN the statement', async () => {
    const host = await userFactory();
    const seeded = await resendableGuest();
    const { meeting: otherMeeting } = await meetingFactory();
    const oldHash = seeded.guest.tokenHash;

    await expect(
      meetingGuestsRepository.rotateToken({
        // The attacker holds a valid guest uuid but names a meeting they DO have rights on.
        meetingId: otherMeeting.id,
        guestId: seeded.guest.id,
        tokenHash: tokenHash(),
        expiresAt: new Date(Date.now() + 7 * DAY_MS),
        rotatedByUserId: host.id,
      })
    ).resolves.toBeUndefined();

    // ⚠ AND THE ROW IS UNTOUCHED — the original credential still resolves.
    const resolved = await meetingGuestsRepository.findLiveByTokenHash(oldHash);
    expect(resolved?.guest.id).toBe(seeded.guest.id);
    await expect(linkResentAuditCount(seeded.guest.id)).resolves.toBe(0);
  });

  it('⚠ REFUSES an `email`-channel row — that path has its own attributed re-invite', async () => {
    const host = await userFactory();
    const seeded = await meetingGuestFactory({
      values: { inviteChannel: 'email', admission: 'admitted', admissionDecidedAt: new Date() },
    });

    await expect(
      meetingGuestsRepository.rotateToken({
        meetingId: seeded.meetingId,
        guestId: seeded.guest.id,
        tokenHash: tokenHash(),
        expiresAt: new Date(Date.now() + 7 * DAY_MS),
        rotatedByUserId: host.id,
      })
    ).resolves.toBeUndefined();
    await expect(linkResentAuditCount(seeded.guest.id)).resolves.toBe(0);
  });

  /**
   * ⚠⚠ **THE BAL-442 GUARD.** `pending` STAYS REFUSED HERE. BAL-442 added a second,
   * separately-named primitive rather than widening this predicate, precisely so the HOST resend
   * arm (`resendGuestJoinLink`) never gains the ability to re-send to an un-admitted knock. If a
   * future change widens this to `inArray(admission, ['admitted','pending'])`, this case fails.
   */
  it.each(['pending' as const, 'denied' as const])(
    '⚠ REFUSES a `%s` row — a re-send must never precede an admit',
    async (admission) => {
      const host = await userFactory();
      const seeded = await meetingGuestFactory({
        values: {
          inviteChannel: 'link',
          admission,
          // The CHECK is an IFF: `pending` must have NO stamp, `denied` must have one.
          admissionDecidedAt: admission === 'denied' ? new Date() : null,
        },
      });

      await expect(
        meetingGuestsRepository.rotateToken({
          meetingId: seeded.meetingId,
          guestId: seeded.guest.id,
          tokenHash: tokenHash(),
          expiresAt: new Date(Date.now() + 7 * DAY_MS),
          rotatedByUserId: host.id,
        })
      ).resolves.toBeUndefined();
      await expect(linkResentAuditCount(seeded.guest.id)).resolves.toBe(0);
    }
  );
});

// ── 6a. THE SELF-SERVICE LOBBY RE-ENTRY ARM (BAL-442) ────────────────────────

const SELF_RECOVERED = 'meeting_guest.link_self_recovered';

/**
 * BAL-442 fix round (R-6) — the row's CURRENT compare-and-set token, read the same way the
 * repository projects it.
 *
 * ⚠⚠ `updated_at::text`, NEVER `readGuest(...).updatedAt`. `timestamptz` carries MICROSECOND
 * precision and a JavaScript `Date` carries only milliseconds, so a `Date` round-trip TRUNCATES
 * — and a compare-and-set on the truncated value would match NOTHING, turning every rotation in
 * this file into a `undefined` that the "refused" assertions would happily accept. A test that
 * read it as a `Date` would pass the negatives and silently lose every positive.
 *
 * ⚠ It reads the row DIRECTLY rather than through `findLivePendingLobbyByEmail`, because the
 * refusal cases below are deliberately shapes that read refuses (admitted, revoked, expired).
 */
async function versionTokenOf(guestId: string): Promise<string> {
  const [row] = await db
    .select({ versionToken: sql<string>`${meetingGuests.updatedAt}::text` })
    .from(meetingGuests)
    .where(eq(meetingGuests.id, guestId));
  if (row === undefined) {
    throw new Error(`expected meeting_guests row ${guestId} to exist`);
  }
  return row.versionToken;
}

/**
 * One LIVE, client-side, `link`-channel, `pending` lobby row — the ONLY shape BAL-442's
 * recovery arm may ever read or rotate.
 *
 * ⚠ `invitedById: null` is what `claimLobbyPlace` actually writes (a knock has no inviter), and
 * `meeting_guest_self_claimed_is_link` permits it ONLY because the channel is `link`.
 * ⚠ `admissionDecidedAt` MUST stay null: `meeting_guest_admission_terminal_stamped` is a
 * BICONDITIONAL, so a `pending` row carrying a decision stamp will not insert at all.
 */
async function pendingLobbyGuest(
  overrides: { meetingId?: string; values?: Partial<NewMeetingGuest> } = {}
): ReturnType<typeof meetingGuestFactory> {
  return meetingGuestFactory({
    ...(overrides.meetingId === undefined ? {} : { meetingId: overrides.meetingId }),
    values: {
      invitedById: null,
      inviteChannel: 'link',
      admission: 'pending',
      admissionDecidedAt: null,
      party: 'client',
      ...overrides.values,
    },
  });
}

/**
 * ONE refusal assertion, shared by every negative in the rotate block — the `guestAuditRows`
 * rule applied here: a per-case copy is both a Sonar new-code duplication finding AND a copy
 * that keeps passing after the original's assertions are weakened.
 *
 * Asserts the THREE things a refusal has to mean, not just the return value: `undefined` comes
 * back, the stored credential is BYTE-IDENTICAL afterwards, and NO audit row was written.
 * `meetingId` is overridable so the tenancy case can name a meeting that is not the row's.
 */
async function expectLobbyRotationRefused(
  seeded: Awaited<ReturnType<typeof meetingGuestFactory>>,
  meetingId: string = seeded.meetingId
): Promise<void> {
  const oldHash = seeded.guest.tokenHash;
  // ⚠ THE **CURRENT**, CORRECT token — so every refusal below is attributable to the predicate
  // under test and never to a stale compare-and-set that would refuse everything for free.
  const expectedVersionToken = await versionTokenOf(seeded.guest.id);

  await expect(
    meetingGuestsRepository.rotatePendingLobbyToken({
      meetingId,
      guestId: seeded.guest.id,
      tokenHash: tokenHash(),
      expiresAt: new Date(Date.now() + 7 * DAY_MS),
      expectedVersionToken,
    })
  ).resolves.toBeUndefined();

  expect((await readGuest(seeded.guest.id)).tokenHash).toBe(oldHash);
  await expect(guestAuditActions(seeded.guest.id)).resolves.toEqual([]);
}

describe('meetingGuestsRepository.findLivePendingLobbyByEmail (BAL-442 — the recovery read)', () => {
  const ADDRESS = 'dana@northwind.test';

  it('finds the LIVE `pending` lobby row an address holds on the meeting', async () => {
    const seeded = await pendingLobbyGuest({ values: { email: ADDRESS, name: 'Dana Visitor' } });

    const match = await meetingGuestsRepository.findLivePendingLobbyByEmail(
      seeded.meetingId,
      ADDRESS
    );

    expect(match?.id).toBe(seeded.guest.id);
    expect(match?.meetingId).toBe(seeded.meetingId);
    // ⚠ THE STORED BYTES — the address the recovery link may be sent to.
    expect(match?.email).toBe(ADDRESS);
    expect(match?.name).toBe('Dana Visitor');
  });

  /**
   * ⚠ THE FALSE NEGATIVE THIS CLOSES IS INVISIBLE EVERYWHERE ELSE. A miss and a match produce
   * the SAME neutral response by design, so a lookup that silently matched nothing because the
   * caller forgot to canonicalise could never be seen in a log, a metric or a downstream test.
   */
  it('⚠ CANONICALISES THE LOOKUP KEY — trims and lowercases before matching', async () => {
    const seeded = await pendingLobbyGuest({ values: { email: ADDRESS } });

    const match = await meetingGuestsRepository.findLivePendingLobbyByEmail(
      seeded.meetingId,
      '  DANA@Northwind.TEST  '
    );

    expect(match?.id).toBe(seeded.guest.id);
  });

  it('⚠ PROJECTS EXACTLY FOUR COLUMNS AND NEVER `token_hash`', async () => {
    const seeded = await pendingLobbyGuest({ values: { email: ADDRESS } });

    const match = await meetingGuestsRepository.findLivePendingLobbyByEmail(
      seeded.meetingId,
      ADDRESS
    );

    if (match === undefined) {
      throw new Error('expected the live pending row to match');
    }
    // ⚠ `localeCompare`, never a bare `.sort()` — S2871 fails the Sonar gate on Reliability.
    // ⚠ fix round (R-6) — FIVE now, not four: `versionToken` is the compare-and-set value the
    // rotation demands. Still no `token_hash`, no `expires_at` and no attribution column.
    expect(Object.keys(match).sort((a, b) => a.localeCompare(b))).toEqual([
      'email',
      'id',
      'meetingId',
      'name',
      'versionToken',
    ]);
  });

  /**
   * BAL-442 fix round (R-6) — ⚠⚠ THE PROJECTED TOKEN MUST BE THE **EXACT, UNTRUNCATED**
   * `updated_at`, which is why it is `::text` and not the `Date` column. A `timestamptz` read
   * into a JavaScript `Date` loses its microseconds, and the compare-and-set built on it would
   * then match NOTHING — every recovery would collapse into a neutral "lost race" that no log,
   * metric or response could tell apart from a genuine miss.
   */
  it('⚠⚠ the projected `versionToken` round-trips EXACTLY, and a truncated `Date` would not', async () => {
    const seeded = await pendingLobbyGuest({ values: { email: ADDRESS } });

    const match = await meetingGuestsRepository.findLivePendingLobbyByEmail(
      seeded.meetingId,
      ADDRESS
    );
    if (match === undefined) {
      throw new Error('expected the live pending row to match');
    }

    // It IS the stored value, byte for byte, as the database renders it.
    await expect(versionTokenOf(seeded.guest.id)).resolves.toBe(match.versionToken);
    // ⚠ AND IT IS ACCEPTED BY THE WRITE — the half that proves it is not merely a string.
    await expect(
      meetingGuestsRepository.rotatePendingLobbyToken({
        meetingId: seeded.meetingId,
        guestId: seeded.guest.id,
        tokenHash: tokenHash(),
        expiresAt: new Date(Date.now() + 7 * DAY_MS),
        expectedVersionToken: match.versionToken,
      })
    ).resolves.toBeDefined();
  });

  /**
   * ⚠⚠ ONE NEGATIVE PER PREDICATE, EACH SEEDING EXACTLY ONE ROW IN THE REFUSED SHAPE — so the
   * only thing that can make the lookup answer `undefined` is the predicate under test. There is
   * no RLS behind this read; the `WHERE` is the entire boundary.
   */
  it('⚠ REFUSES an `email`-channel row — that address has BAL-436 host resend, not this arm', async () => {
    // ⚠ NOT `pendingLobbyGuest`: `meeting_guest_self_claimed_is_link` forbids a null inviter on
    // an `email` row, so this fixture must name one.
    const seeded = await meetingGuestFactory({
      values: {
        email: ADDRESS,
        inviteChannel: 'email',
        admission: 'pending',
        admissionDecidedAt: null,
        party: 'client',
      },
    });

    await expect(
      meetingGuestsRepository.findLivePendingLobbyByEmail(seeded.meetingId, ADDRESS)
    ).resolves.toBeUndefined();
  });

  it.each([
    ['admitted' as const, new Date()],
    ['pre_admitted' as const, null],
  ])(
    '⚠ REFUSES an `%s` row — room entry is NOT self-recoverable, only a queue place is',
    async (admission, decidedAt) => {
      const seeded = await pendingLobbyGuest({
        values: { email: ADDRESS, admission, admissionDecidedAt: decidedAt },
      });

      await expect(
        meetingGuestsRepository.findLivePendingLobbyByEmail(seeded.meetingId, ADDRESS)
      ).resolves.toBeUndefined();
    }
  );

  it('⚠⚠ REFUSES a DENIED row — a host denial is never undone by self-service', async () => {
    const host = await userFactory();
    const seeded = await pendingLobbyGuest({ values: { email: ADDRESS } });
    // ⚠ THE DENY BRANCH STAMPS `revoked_at`, which is what drops the row out of this lookup.
    await meetingGuestsRepository.decideAdmission({
      guestId: seeded.guest.id,
      decision: 'denied',
      deciderUserId: host.id,
    });

    await expect(
      meetingGuestsRepository.findLivePendingLobbyByEmail(seeded.meetingId, ADDRESS)
    ).resolves.toBeUndefined();
  });

  it('⚠ REFUSES a revoked row', async () => {
    const seeded = await pendingLobbyGuest({
      values: { email: ADDRESS, revokedAt: new Date() },
    });

    await expect(
      meetingGuestsRepository.findLivePendingLobbyByEmail(seeded.meetingId, ADDRESS)
    ).resolves.toBeUndefined();
  });

  it('⚠ REFUSES a soft-deleted row', async () => {
    const seeded = await pendingLobbyGuest({
      values: { email: ADDRESS, deletedAt: new Date() },
    });

    await expect(
      meetingGuestsRepository.findLivePendingLobbyByEmail(seeded.meetingId, ADDRESS)
    ).resolves.toBeUndefined();
  });

  /**
   * ⚠ `meeting_guest_meeting_email_live_idx` carries NO `expires_at` predicate, so expiry does
   * not vacate the slot and this method must exclude the row itself. Rotating an expired row
   * would email a link whose recomputed window is also in the past — dead on arrival.
   */
  it('⚠ REFUSES an EXPIRED row', async () => {
    const seeded = await pendingLobbyGuest({
      values: { email: ADDRESS, expiresAt: new Date(Date.now() - DAY_MS) },
    });

    await expect(
      meetingGuestsRepository.findLivePendingLobbyByEmail(seeded.meetingId, ADDRESS)
    ).resolves.toBeUndefined();
  });

  /**
   * ⚠ THE MATCH KEY ITSELF. Without it the read returns SOMEBODY ELSE'S row — which on this
   * arm would email a fresh credential to an address that never asked for one.
   */
  it('⚠⚠ REFUSES AN ADDRESS WITH NO ROW, even while another knock is queued there', async () => {
    const seeded = await pendingLobbyGuest({ values: { email: ADDRESS } });

    await expect(
      meetingGuestsRepository.findLivePendingLobbyByEmail(
        seeded.meetingId,
        'stranger@elsewhere.test'
      )
    ).resolves.toBeUndefined();
    // Non-vacuity: the queued knock really is there to be wrongly returned.
    await expect(
      meetingGuestsRepository.findLivePendingLobbyByEmail(seeded.meetingId, ADDRESS)
    ).resolves.toBeDefined();
  });

  it('⚠⚠ TENANCY — the same address pending on ANOTHER meeting does not match', async () => {
    const seeded = await pendingLobbyGuest({ values: { email: ADDRESS } });
    const { meeting: otherMeeting } = await meetingFactory();

    await expect(
      meetingGuestsRepository.findLivePendingLobbyByEmail(otherMeeting.id, ADDRESS)
    ).resolves.toBeUndefined();
    // Non-vacuity: the row really is findable on ITS OWN meeting.
    await expect(
      meetingGuestsRepository.findLivePendingLobbyByEmail(seeded.meetingId, ADDRESS)
    ).resolves.toBeDefined();
  });

  /**
   * ⚠ `party = 'client'` IS WHAT MAKES `meeting_guest_meeting_email_live_idx` USABLE (it is
   * `(meeting_id, party, email)`), and it is also correct: `claimLobbyPlace` hard-codes `client`,
   * so no expert-side row can be a lobby knock this arm may recover.
   */
  it('⚠ REFUSES an expert-side row holding the same address', async () => {
    const seeded = await pendingLobbyGuest({ values: { email: ADDRESS, party: 'expert' } });

    await expect(
      meetingGuestsRepository.findLivePendingLobbyByEmail(seeded.meetingId, ADDRESS)
    ).resolves.toBeUndefined();
  });
});

describe('meetingGuestsRepository.rotatePendingLobbyToken (BAL-442 — the recovery write)', () => {
  it('⚠⚠ replaces the hash and the expiry, and KILLS the previous credential', async () => {
    const seeded = await pendingLobbyGuest({
      values: { expiresAt: new Date(Date.now() + DAY_MS) },
    });
    const oldHash = seeded.guest.tokenHash;
    const newHash = tokenHash();
    const newExpiry = new Date(Date.now() + 30 * DAY_MS);

    const rotated = await meetingGuestsRepository.rotatePendingLobbyToken({
      meetingId: seeded.meetingId,
      guestId: seeded.guest.id,
      tokenHash: newHash,
      expiresAt: newExpiry,
      expectedVersionToken: await versionTokenOf(seeded.guest.id),
    });

    expect(rotated?.tokenHash).toBe(newHash);
    expect(rotated?.expiresAt.getTime()).toBe(newExpiry.getTime());
    // ⚠ The lost credential stops resolving — the tab that held it is gone, and two live
    // credentials on one row would be a second hijack surface opened by the rescue itself.
    await expect(meetingGuestsRepository.findLiveByTokenHash(oldHash)).resolves.toBeUndefined();
    const resolved = await meetingGuestsRepository.findLiveByTokenHash(newHash);
    expect(resolved?.guest.id).toBe(seeded.guest.id);
  });

  it('⚠⚠ writes ONE UNATTRIBUTED `meeting_guest.link_self_recovered` row — never `link_resent`', async () => {
    const seeded = await pendingLobbyGuest({ values: { email: 'dana@northwind.test' } });

    await meetingGuestsRepository.rotatePendingLobbyToken({
      meetingId: seeded.meetingId,
      guestId: seeded.guest.id,
      tokenHash: tokenHash(),
      expiresAt: new Date(Date.now() + 7 * DAY_MS),
      expectedVersionToken: await versionTokenOf(seeded.guest.id),
    });

    // ⚠ EXACT SET: `meeting_guest.link_resent` means "a HOST re-sent it" and is FALSE here, so
    // reusing the host arm's action would make the two arms indistinguishable in the trail.
    await expect(guestAuditActions(seeded.guest.id)).resolves.toEqual([SELF_RECOVERED]);

    const audits = await guestAuditRows(seeded.guest.id, SELF_RECOVERED);
    expect(audits).toHaveLength(1);
    // ⚠ NULL — self-service has no actor, exactly as `meeting_guest.self_claimed` has none.
    expect(audits[0]?.actorUserId).toBeNull();
    expect(audits[0]?.metadata).toMatchObject({
      meetingId: seeded.meetingId,
      party: 'client',
      inviteChannel: 'link',
    });
    // ⚠ IDS AND LABELS ONLY — never the credential, never the address.
    const serialised = JSON.stringify(audits[0]?.metadata);
    expect(serialised).not.toContain('tokenHash');
    expect(serialised).not.toContain('token_hash');
    expect(serialised).not.toContain('dana@northwind.test');
  });

  /**
   * ⚠ THE OPPOSITE RULE TO `meeting_guest.self_claimed`, WHICH IS ONE-PER-ROW. A guest may lose
   * a tab more than once, so repeated recovery is expected and each rotation kills the last link.
   */
  it('⚠ rotating TWICE writes TWO `link_self_recovered` rows — recovery is repeatable', async () => {
    const seeded = await pendingLobbyGuest();
    const first = tokenHash();
    const second = tokenHash();

    await meetingGuestsRepository.rotatePendingLobbyToken({
      meetingId: seeded.meetingId,
      guestId: seeded.guest.id,
      tokenHash: first,
      expiresAt: new Date(Date.now() + 7 * DAY_MS),
      expectedVersionToken: await versionTokenOf(seeded.guest.id),
    });
    // ⚠ RE-READ THE TOKEN — the first rotation moved `updated_at`, and passing the ORIGINAL
    // token here would be refused. That is the compare-and-set working, not a test artefact.
    await meetingGuestsRepository.rotatePendingLobbyToken({
      meetingId: seeded.meetingId,
      guestId: seeded.guest.id,
      tokenHash: second,
      expiresAt: new Date(Date.now() + 7 * DAY_MS),
      expectedVersionToken: await versionTokenOf(seeded.guest.id),
    });

    await expect(guestAuditRows(seeded.guest.id, SELF_RECOVERED)).resolves.toHaveLength(2);
    await expect(meetingGuestsRepository.findLiveByTokenHash(first)).resolves.toBeUndefined();
    await expect(meetingGuestsRepository.findLiveByTokenHash(second)).resolves.toBeDefined();
  });

  it('⚠⚠ LEAVES THE ROW `pending` — a recovery is a credential replacement, not an admission', async () => {
    const seeded = await pendingLobbyGuest({ values: { name: 'Dana Visitor' } });

    await meetingGuestsRepository.rotatePendingLobbyToken({
      meetingId: seeded.meetingId,
      guestId: seeded.guest.id,
      tokenHash: tokenHash(),
      expiresAt: new Date(Date.now() + 7 * DAY_MS),
      expectedVersionToken: await versionTokenOf(seeded.guest.id),
    });

    const after = await readGuest(seeded.guest.id);
    expect(after.admission).toBe('pending');
    expect(after.admissionDecidedAt).toBeNull();
    expect(after.admittedByUserId).toBeNull();
    // ⚠ NOT AN IDENTITY EDIT EITHER — the host's queue still shows what was knocked with.
    expect(after.name).toBe('Dana Visitor');
    expect(after.email).toBe(seeded.guest.email);
    expect(after.party).toBe('client');
  });

  /**
   * ⚠⚠ THE RECOVERY DOES NOT REOPEN `claimLobbyPlace`'s `ON CONFLICT DO NOTHING` HIJACK CONTROL
   * (residual F3). Only the CREDENTIAL is recoverable — never the queue slot, and never the
   * right to re-knock under a different name.
   */
  it('⚠⚠ does NOT vacate `meeting_guest_meeting_email_live_idx` — the re-knock stays refused', async () => {
    const seeded = await pendingLobbyGuest({ values: { email: 'dana@northwind.test' } });

    await meetingGuestsRepository.rotatePendingLobbyToken({
      meetingId: seeded.meetingId,
      guestId: seeded.guest.id,
      tokenHash: tokenHash(),
      expiresAt: new Date(Date.now() + 7 * DAY_MS),
      expectedVersionToken: await versionTokenOf(seeded.guest.id),
    });

    await expect(
      meetingGuestsRepository.claimLobbyPlace(
        claimInput(seeded.meetingId, { email: 'dana@northwind.test', name: 'Someone Else' })
      )
    ).resolves.toBeUndefined();
    const after = await readGuest(seeded.guest.id);
    expect(after.name).toBe('Guest Person');
    expect(after.revokedAt).toBeNull();
    expect(after.deletedAt).toBeNull();
  });

  /**
   * ⚠⚠ EIGHT PREDICATES, ONE NEGATIVE EACH — and every one of these calls the method with a
   * shape the SERVICE would have refused first, precisely to prove the refusal does not depend
   * on the service. The pre-read is a COURTESY; the `WHERE` is the gate, and there is no RLS.
   */
  it('⚠⚠ ROTATES ONLY THE NAMED ROW — a sibling knock on the SAME meeting is untouched', async () => {
    const mine = await pendingLobbyGuest();
    const bystander = await pendingLobbyGuest({ meetingId: mine.meetingId });
    const bystanderHash = bystander.guest.tokenHash;

    await meetingGuestsRepository.rotatePendingLobbyToken({
      meetingId: mine.meetingId,
      guestId: mine.guest.id,
      tokenHash: tokenHash(),
      expiresAt: new Date(Date.now() + 7 * DAY_MS),
      expectedVersionToken: await versionTokenOf(mine.guest.id),
    });

    // ⚠ A rotation not keyed on the id would re-mint EVERY queued knock on the meeting at
    // once — killing bystanders' live links in order to rescue one person.
    expect((await readGuest(bystander.guest.id)).tokenHash).toBe(bystanderHash);
    await expect(guestAuditActions(bystander.guest.id)).resolves.toEqual([]);
  });

  it('⚠⚠ REFUSES A CROSS-MEETING ROTATE — the tenancy scope is IN the statement', async () => {
    const seeded = await pendingLobbyGuest();
    const { meeting: otherMeeting } = await meetingFactory();

    // A caller holding a valid guest uuid but naming a meeting of their own. The helper also
    // pins that the row is BYTE-IDENTICAL afterwards — the original credential still resolves.
    await expectLobbyRotationRefused(seeded, otherMeeting.id);
  });

  it.each([
    ['admitted' as const, new Date()],
    ['pre_admitted' as const, null],
    ['denied' as const, new Date()],
  ])(
    '⚠⚠ REFUSES an `%s` row — self-service may only rotate a queue place',
    async (admission, decidedAt) => {
      const seeded = await pendingLobbyGuest({
        values: { admission, admissionDecidedAt: decidedAt },
      });
      await expectLobbyRotationRefused(seeded);
    }
  );

  it('⚠ REFUSES an `email`-channel row — that path has its own attributed re-send', async () => {
    const seeded = await meetingGuestFactory({
      values: { inviteChannel: 'email', admission: 'pending', admissionDecidedAt: null },
    });
    await expectLobbyRotationRefused(seeded);
  });

  it.each([
    ['revoked', { revokedAt: new Date() }],
    ['soft-deleted', { deletedAt: new Date() }],
  ])(
    '⚠ REFUSES a %s row — a rotation must never undo a deliberate switch-off',
    async (_label, values) => {
      const seeded = await pendingLobbyGuest({ values });
      await expectLobbyRotationRefused(seeded);
    }
  );

  /**
   * ⚠⚠ THE SEVENTH PREDICATE, AND THE ONE `rotateToken` DELIBERATELY DOES NOT CARRY. It is here
   * so the write is independently safe when called by a future caller that skips the read — the
   * same philosophy `rotateToken`'s "ATOMIC, NOT RE-READ" paragraph states. Without it an expired
   * handle could be re-minted with a fresh window, reviving a credential nobody ever admitted.
   */
  it('⚠⚠ REFUSES an EXPIRED row even though the READ would have refused it first', async () => {
    const seeded = await pendingLobbyGuest({
      values: { expiresAt: new Date(Date.now() - DAY_MS) },
    });
    await expectLobbyRotationRefused(seeded);
  });

  /**
   * ── BAL-442 fix round (R-6): THE EIGHTH PREDICATE, THE COMPARE-AND-SET ────────────────────
   *
   * Two simultaneous re-entry requests for the SAME address both read the same row and BOTH
   * rotated it. Two emails went out; the LOSER's was minted second and could arrive LAST, so
   * the guest's newest inbox message held an already-dead credential while the working one
   * looked stale. With `updated_at` in the `WHERE`, exactly one writer wins.
   *
   * ⚠ THE HARNESS RUNS EVERY TEST INSIDE ONE TRANSACTION ON A `max: 1` POOL, so genuinely
   * CONCURRENT writers are not expressible here. These drive the predicate DETERMINISTICALLY
   * instead — a stale token is exactly what a loser presents once the winner has committed —
   * which is the same statement the race produces and is testable without concurrency.
   */
  it('⚠⚠ REFUSES A STALE TOKEN — the loser of a double recovery rotates NOTHING', async () => {
    const seeded = await pendingLobbyGuest();
    // Both callers read the SAME token, exactly as two simultaneous requests would.
    const sharedToken = await versionTokenOf(seeded.guest.id);
    const winnerHash = tokenHash();

    // The winner commits first.
    await expect(
      meetingGuestsRepository.rotatePendingLobbyToken({
        meetingId: seeded.meetingId,
        guestId: seeded.guest.id,
        tokenHash: winnerHash,
        expiresAt: new Date(Date.now() + 7 * DAY_MS),
        expectedVersionToken: sharedToken,
      })
    ).resolves.toBeDefined();

    // The loser now presents the token it read BEFORE that commit.
    const loserHash = tokenHash();
    await expect(
      meetingGuestsRepository.rotatePendingLobbyToken({
        meetingId: seeded.meetingId,
        guestId: seeded.guest.id,
        tokenHash: loserHash,
        expiresAt: new Date(Date.now() + 7 * DAY_MS),
        expectedVersionToken: sharedToken,
      })
    ).resolves.toBeUndefined();

    // ⚠⚠ THE WINNER'S CREDENTIAL IS THE ONE THAT SURVIVES — the whole point. Without the
    // predicate the loser would have overwritten it, and its email could land afterwards.
    const after = await readGuest(seeded.guest.id);
    expect(after.tokenHash).toBe(winnerHash);
    await expect(meetingGuestsRepository.findLiveByTokenHash(loserHash)).resolves.toBeUndefined();
    const resolved = await meetingGuestsRepository.findLiveByTokenHash(winnerHash);
    expect(resolved?.guest.id).toBe(seeded.guest.id);
  });

  it('⚠⚠ THE LOSER IS A SILENT NO-OP — no audit row, so exactly ONE recovery is recorded', async () => {
    const seeded = await pendingLobbyGuest();
    const sharedToken = await versionTokenOf(seeded.guest.id);

    await meetingGuestsRepository.rotatePendingLobbyToken({
      meetingId: seeded.meetingId,
      guestId: seeded.guest.id,
      tokenHash: tokenHash(),
      expiresAt: new Date(Date.now() + 7 * DAY_MS),
      expectedVersionToken: sharedToken,
    });
    await meetingGuestsRepository.rotatePendingLobbyToken({
      meetingId: seeded.meetingId,
      guestId: seeded.guest.id,
      tokenHash: tokenHash(),
      expiresAt: new Date(Date.now() + 7 * DAY_MS),
      expectedVersionToken: sharedToken,
    });

    // ⚠ ONE, not two. The refusal is `undefined` and NOT an error — a distinguishable
    // "somebody beat you to it" would be a match oracle on a route whose whole design is that
    // a match and a miss are the same response.
    await expect(guestAuditRows(seeded.guest.id, SELF_RECOVERED)).resolves.toHaveLength(1);
  });

  it('⚠ REFUSES A TOKEN THAT NAMES A DIFFERENT INSTANT ENTIRELY', async () => {
    const seeded = await pendingLobbyGuest();
    const oldHash = seeded.guest.tokenHash;

    await expect(
      meetingGuestsRepository.rotatePendingLobbyToken({
        meetingId: seeded.meetingId,
        guestId: seeded.guest.id,
        tokenHash: tokenHash(),
        expiresAt: new Date(Date.now() + 7 * DAY_MS),
        expectedVersionToken: '2020-01-01 00:00:00+00',
      })
    ).resolves.toBeUndefined();

    expect((await readGuest(seeded.guest.id)).tokenHash).toBe(oldHash);
    await expect(guestAuditActions(seeded.guest.id)).resolves.toEqual([]);
  });

  /**
   * ⚠⚠ THE NON-VACUITY PAIR FOR EVERY REFUSAL ABOVE. A compare-and-set that refused
   * EVERYTHING — the shape a `Date`-based token would silently produce, because `timestamptz`
   * microseconds do not survive a JavaScript `Date` — would pass all three of them and break
   * the feature outright. This is the one that fails if that happens.
   */
  it('⚠⚠ ACCEPTS THE CURRENT TOKEN — the compare-and-set is not refusing everything', async () => {
    const seeded = await pendingLobbyGuest();
    const newHash = tokenHash();

    const rotated = await meetingGuestsRepository.rotatePendingLobbyToken({
      meetingId: seeded.meetingId,
      guestId: seeded.guest.id,
      tokenHash: newHash,
      expiresAt: new Date(Date.now() + 7 * DAY_MS),
      expectedVersionToken: await versionTokenOf(seeded.guest.id),
    });

    expect(rotated?.tokenHash).toBe(newHash);
    await expect(guestAuditRows(seeded.guest.id, SELF_RECOVERED)).resolves.toHaveLength(1);
  });

  it('⚠ ROLLS THE ROTATION BACK when the audit write fails — one transaction, not two', async () => {
    const seeded = await pendingLobbyGuest();
    const oldHash = seeded.guest.tokenHash;
    const expectedVersionToken = await versionTokenOf(seeded.guest.id);

    await expectAuditFailureRollsBack(() =>
      meetingGuestsRepository.rotatePendingLobbyToken({
        meetingId: seeded.meetingId,
        guestId: seeded.guest.id,
        tokenHash: tokenHash(),
        expiresAt: new Date(Date.now() + 7 * DAY_MS),
        expectedVersionToken,
      })
    );

    expect((await readGuest(seeded.guest.id)).tokenHash).toBe(oldHash);
  });
});

// ── 6b. THE GUEST→MEMBER LINKAGE (BAL-489) ───────────────────────────────────

describe('meetingGuestsRepository.linkConvertedUser (BAL-489 — the guest→member linkage)', () => {
  const CONVERTED = 'meeting_guest.converted';

  /**
   * One ELIGIBLE row on a FRESH meeting: `email` channel, `pre_admitted`, live, unconverted.
   * `values` rides on top, so a refusal case can force exactly one state away from eligible.
   */
  async function seedGuest(
    email: string,
    values: Partial<NewMeetingGuest> = {}
  ): Promise<MeetingGuest> {
    const { guest } = await meetingGuestFactory({ values: { email, ...values } });
    return guest;
  }

  /** The linked guest ids, comparator-sorted (a bare `.sort()` is SonarCloud S2871). */
  function linkedIds(links: readonly ConvertedGuestLink[]): string[] {
    return links.map((link) => link.guestId).sort((a, b) => a.localeCompare(b));
  }

  /**
   * ⚠⚠ THE NON-VACUITY RULE FOR EVERY REFUSAL CASE. Each one seeds an ELIGIBLE CONTROL row with
   * the SAME address on a DIFFERENT meeting, and the result must be EXACTLY that control row. A
   * bare `toEqual([])` would pass just as happily if the email never matched at all (a broken
   * canonicaliser, a typo in the fixture) — the control proves the address DID match, so the
   * predicate under test is the only thing that can have excluded the refused row.
   *
   * It also discharges "a no-op writes zero audit rows" (case 15) against a paired positive: the
   * control carries exactly one `meeting_guest.converted` row, the refused row carries none.
   */
  async function expectOnlyControlLinked(
    links: readonly ConvertedGuestLink[],
    control: MeetingGuest,
    refusedGuestId: string,
    userId: string
  ): Promise<void> {
    expect(linkedIds(links)).toEqual([control.id]);

    const refused = await readGuest(refusedGuestId);
    expect(refused.convertedToUserId).toBeNull();
    expect(refused.convertedAt).toBeNull();
    expect(await guestAuditActions(refusedGuestId)).not.toContain(CONVERTED);

    const linkedControl = await readGuest(control.id);
    expect(linkedControl.convertedToUserId).toBe(userId);
    await expect(guestAuditRows(control.id, CONVERTED)).resolves.toHaveLength(1);
  }

  it('links an eligible `email`-channel row — stamps the conversion pair, leaves `user_id` NULL, returns the anchor', async () => {
    const user = await userFactory();
    const { meeting } = await meetingFactory();
    const { guest } = await meetingGuestFactory({
      meetingId: meeting.id,
      values: { email: 'dana@link-eligible.test' },
    });
    expect(guest.inviteChannel).toBe('email');
    expect(guest.admission).toBe('pre_admitted');

    const links = await meetingGuestsRepository.linkConvertedUser({
      convertedToUserId: user.id,
      verifiedEmail: 'dana@link-eligible.test',
    });

    // ⚠ NARROW: exactly these keys, so a widened projection (token_hash, joinUrl, …) fails here.
    expect(links).toEqual([
      {
        guestId: guest.id,
        meeting: { id: meeting.id, startedAt: null, scheduledStart: meeting.scheduledStart },
      },
    ]);

    const stored = await readGuest(guest.id);
    expect(stored.convertedToUserId).toBe(user.id);
    expect(stored.convertedAt).toBeInstanceOf(Date);
    // ⚠ R7 — `user_id` means "the Balo user this guest is", including a PRE-EXISTING user, which
    // a new-user seam cannot produce. The linkage must never write it.
    expect(stored.userId).toBeNull();

    const audits = await guestAuditRows(guest.id, CONVERTED);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.actorUserId).toBe(user.id);
    // ⚠ EXACT metadata — an `email` key (or anything else) widens this and fails.
    expect(audits[0]?.metadata).toEqual({
      meetingId: meeting.id,
      party: 'client',
      inviteChannel: 'email',
    });
  });

  it('links an EXPIRED row — `expires_at` bounds the token, not the person (R5)', async () => {
    const user = await userFactory();
    const expired = await seedGuest('dana@link-expired.test', {
      expiresAt: new Date(Date.now() - DAY_MS),
    });

    const links = await meetingGuestsRepository.linkConvertedUser({
      convertedToUserId: user.id,
      verifiedEmail: 'dana@link-expired.test',
    });

    expect(linkedIds(links)).toEqual([expired.id]);
    expect((await readGuest(expired.id)).convertedToUserId).toBe(user.id);
  });

  it('⚠ REFUSES a REMOVED row (`revoke` stamps `revoked_at` AND `deleted_at`)', async () => {
    const user = await userFactory();
    const host = await userFactory();
    const email = 'dana@refuse-removed.test';
    const removed = await seedGuest(email);
    await meetingGuestsRepository.revoke({ guestId: removed.id, revokedByUserId: host.id });
    const control = await seedGuest(email);

    const links = await meetingGuestsRepository.linkConvertedUser({
      convertedToUserId: user.id,
      verifiedEmail: email,
    });

    await expectOnlyControlLinked(links, control, removed.id, user.id);
  });

  it('⚠ REFUSES a DENIED-shape row — `revoked_at` ONLY, `deleted_at` NULL (isolates the revoked_at predicate)', async () => {
    const user = await userFactory();
    const email = 'dana@refuse-denied.test';
    const denied = await seedGuest(email, {
      admission: 'denied',
      admissionDecidedAt: new Date(),
      revokedAt: new Date(),
    });
    // The isolation is the point: `deleted_at` is NULL, so ONLY `revoked_at IS NULL` can refuse it.
    expect(denied.deletedAt).toBeNull();
    expect(denied.revokedAt).not.toBeNull();
    const control = await seedGuest(email);

    const links = await meetingGuestsRepository.linkConvertedUser({
      convertedToUserId: user.id,
      verifiedEmail: email,
    });

    await expectOnlyControlLinked(links, control, denied.id, user.id);
  });

  it('⚠ REFUSES a SOFT-DELETED-but-not-revoked row (isolates the deleted_at predicate)', async () => {
    const user = await userFactory();
    const email = 'dana@refuse-deleted.test';
    const deleted = await seedGuest(email, { deletedAt: new Date() });
    expect(deleted.revokedAt).toBeNull();
    expect(deleted.deletedAt).not.toBeNull();
    const control = await seedGuest(email);

    const links = await meetingGuestsRepository.linkConvertedUser({
      convertedToUserId: user.id,
      verifiedEmail: email,
    });

    await expectOnlyControlLinked(links, control, deleted.id, user.id);
  });

  it('⚠⚠ REFUSES a `link`-channel row with the same address, EVEN ONCE ADMITTED (R4 — a typed address is not a verified one)', async () => {
    const user = await userFactory();
    const host = await userFactory();
    const email = 'dana@refuse-link.test';
    const { meeting } = await meetingFactory();
    const knock = await meetingGuestsRepository.claimLobbyPlace(claimInput(meeting.id, { email }));
    if (knock === undefined) {
      throw new Error('expected the knock to be inserted');
    }
    const admitted = await meetingGuestsRepository.decideAdmission({
      guestId: knock.id,
      decision: 'admitted',
      deciderUserId: host.id,
    });
    // The isolation: LIVE, UNREVOKED and ADMITTED — only the channel predicate can refuse it.
    expect(admitted?.inviteChannel).toBe('link');
    expect(admitted?.admission).toBe('admitted');
    expect(admitted?.revokedAt).toBeNull();
    expect(admitted?.deletedAt).toBeNull();
    const control = await seedGuest(email);

    const links = await meetingGuestsRepository.linkConvertedUser({
      convertedToUserId: user.id,
      verifiedEmail: email,
    });

    await expectOnlyControlLinked(links, control, knock.id, user.id);
  });

  it('⚠ matches the address EXACTLY — no alias or plus-address reconciliation (R3)', async () => {
    const user = await userFactory();
    const guest = await seedGuest('dana@exact-match.test');

    for (const alias of ['dana.chen@exact-match.test', 'dana+work@exact-match.test']) {
      await expect(
        meetingGuestsRepository.linkConvertedUser({
          convertedToUserId: user.id,
          verifiedEmail: alias,
        })
      ).resolves.toEqual([]);
    }
    const untouched = await readGuest(guest.id);
    expect(untouched.convertedToUserId).toBeNull();
    expect(untouched.convertedAt).toBeNull();
    expect(await guestAuditActions(guest.id)).not.toContain(CONVERTED);

    // Non-vacuity: the row WAS eligible all along — the exact address links it.
    const links = await meetingGuestsRepository.linkConvertedUser({
      convertedToUserId: user.id,
      verifiedEmail: 'dana@exact-match.test',
    });
    expect(linkedIds(links)).toEqual([guest.id]);
  });

  it('canonicalises the lookup key — a mixed-case, padded verified address links the stored lowercase row', async () => {
    const user = await userFactory();
    const guest = await seedGuest('dana@canonical-key.test');

    const links = await meetingGuestsRepository.linkConvertedUser({
      convertedToUserId: user.id,
      verifiedEmail: '  Dana@Canonical-Key.TEST ',
    });

    expect(linkedIds(links)).toEqual([guest.id]);
  });

  it('⚠ REFUSES a non-ASCII verified address — Unicode case-folding must not alias onto an ASCII lookalike', async () => {
    const user = await userFactory();
    const email = 'kate@nonascii-guard.test';
    const guest = await seedGuest(email);

    // The KELVIN SIGN "K" (U+212A) lowercases to ASCII "k" under `.toLowerCase()` — this must be
    // refused BEFORE any canonicalisation or DB I/O, so it never matches the stored ASCII row.
    // Written as an explicit `\u212A` ESCAPE, deliberately NOT the literal glyph: NFC
    // normalisation maps U+212A to plain ASCII 'K', so a tool that normalises source text
    // (an editor, a formatter, a copy/paste through a lossy pipe) would silently turn this
    // literal character into the SAME ASCII 'K' the control below uses, collapsing the
    // refusal case into a second control without leaving any visible diff.
    const kelvinSignEmail = '\u212A' + email.slice(1);
    const refused = await meetingGuestsRepository.linkConvertedUser({
      convertedToUserId: user.id,
      verifiedEmail: kelvinSignEmail,
    });
    expect(refused).toEqual([]);

    const untouched = await readGuest(guest.id);
    expect(untouched.convertedToUserId).toBeNull();
    expect(await guestAuditActions(guest.id)).not.toContain(CONVERTED);

    // Non-vacuity (control): the SAME row, addressed by a plain-ASCII case variant, WAS matchable.
    const links = await meetingGuestsRepository.linkConvertedUser({
      convertedToUserId: user.id,
      verifiedEmail: 'K' + email.slice(1),
    });
    expect(linkedIds(links)).toEqual([guest.id]);
  });

  it('is IDEMPOTENT — a re-run links nothing, writes no second audit row, and leaves `converted_at` alone', async () => {
    const user = await userFactory();
    const email = 'dana@idempotent.test';
    const guest = await seedGuest(email);
    const first = await meetingGuestsRepository.linkConvertedUser({
      convertedToUserId: user.id,
      verifiedEmail: email,
    });
    expect(linkedIds(first)).toEqual([guest.id]);

    // ⚠ `now()` is the TRANSACTION timestamp, and the harness runs this whole test in ONE
    // transaction — so a re-stamp would write the SAME instant and "unchanged" would be vacuous.
    // Back-date the stamp first (still CHECK-legal: both columns stay set) so a re-stamp shows.
    const backdated = new Date(Date.now() - 30 * DAY_MS);
    await db
      .update(meetingGuests)
      .set({ convertedAt: backdated })
      .where(eq(meetingGuests.id, guest.id));

    const second = await meetingGuestsRepository.linkConvertedUser({
      convertedToUserId: user.id,
      verifiedEmail: email,
    });

    expect(second).toEqual([]);
    const stored = await readGuest(guest.id);
    expect(stored.convertedAt?.getTime()).toBe(backdated.getTime());
    await expect(guestAuditRows(guest.id, CONVERTED)).resolves.toHaveLength(1);
  });

  it('⚠ NEVER RE-POINTS an already-converted row to a second user', async () => {
    const userA = await userFactory();
    const userB = await userFactory();
    const email = 'dana@never-repoint.test';
    const guest = await seedGuest(email);
    await meetingGuestsRepository.linkConvertedUser({
      convertedToUserId: userA.id,
      verifiedEmail: email,
    });

    await expect(
      meetingGuestsRepository.linkConvertedUser({
        convertedToUserId: userB.id,
        verifiedEmail: email,
      })
    ).resolves.toEqual([]);

    expect((await readGuest(guest.id)).convertedToUserId).toBe(userA.id);
    const audits = await guestAuditRows(guest.id, CONVERTED);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.actorUserId).toBe(userA.id);
  });

  it('links EVERY eligible row one address holds — both parties, several meetings — with ONE exact audit row each (R8 cardinality)', async () => {
    const user = await userFactory();
    const inviter = await userFactory();
    const email = 'dana@multi-row.test';
    const { meeting: m1 } = await meetingFactory();
    const { meeting: m2 } = await meetingFactory();
    const seeded = [
      await meetingGuestFactory({
        meetingId: m1.id,
        invitedById: inviter.id,
        values: { email, party: 'client' },
      }),
      await meetingGuestFactory({
        meetingId: m1.id,
        invitedById: inviter.id,
        values: { email, party: 'expert' },
      }),
      await meetingGuestFactory({
        meetingId: m2.id,
        invitedById: inviter.id,
        values: { email, party: 'client' },
      }),
    ].map((result) => result.guest);

    const links = await meetingGuestsRepository.linkConvertedUser({
      convertedToUserId: user.id,
      verifiedEmail: email,
    });

    expect(linkedIds(links)).toEqual(
      seeded.map((guest) => guest.id).sort((a, b) => a.localeCompare(b))
    );
    for (const guest of seeded) {
      const link = links.find((candidate) => candidate.guestId === guest.id);
      expect(link?.meeting.id).toBe(guest.meetingId);

      const audits = await guestAuditRows(guest.id, CONVERTED);
      expect(audits).toHaveLength(1);
      expect(audits[0]?.actorUserId).toBe(user.id);
      expect(audits[0]?.metadata).toEqual({
        meetingId: guest.meetingId,
        party: guest.party,
        inviteChannel: 'email',
      });
    }
  });

  it('a MIXED batch links only the eligible row — the removed and `link` rows keep a NULL conversion', async () => {
    const user = await userFactory();
    const host = await userFactory();
    const email = 'dana@mixed-batch.test';
    const eligible = await seedGuest(email);
    const removed = await seedGuest(email);
    await meetingGuestsRepository.revoke({ guestId: removed.id, revokedByUserId: host.id });
    const { meeting } = await meetingFactory();
    const knock = await meetingGuestsRepository.claimLobbyPlace(claimInput(meeting.id, { email }));
    if (knock === undefined) {
      throw new Error('expected the knock to be inserted');
    }

    const links = await meetingGuestsRepository.linkConvertedUser({
      convertedToUserId: user.id,
      verifiedEmail: email,
    });

    expect(linkedIds(links)).toEqual([eligible.id]);
    expect((await readGuest(eligible.id)).convertedToUserId).toBe(user.id);
    for (const refusedId of [removed.id, knock.id]) {
      const refused = await readGuest(refusedId);
      expect(refused.convertedToUserId).toBeNull();
      expect(refused.convertedAt).toBeNull();
    }
  });

  it('returns the meeting `started_at` when the meeting has started', async () => {
    const user = await userFactory();
    const scheduledStart = new Date(Date.now() - 3 * DAY_MS);
    const startedAt = new Date(scheduledStart.getTime() + 2 * 60_000);
    const { meeting } = await meetingFactory({
      values: {
        scheduledStart,
        scheduledEnd: new Date(scheduledStart.getTime() + 60 * 60_000),
        startedAt,
      },
    });
    const { guest } = await meetingGuestFactory({
      meetingId: meeting.id,
      values: { email: 'dana@started-at.test' },
    });

    const [link, ...rest] = await meetingGuestsRepository.linkConvertedUser({
      convertedToUserId: user.id,
      verifiedEmail: 'dana@started-at.test',
    });

    expect(rest).toEqual([]);
    expect(link?.guestId).toBe(guest.id);
    expect(link?.meeting.startedAt?.getTime()).toBe(startedAt.getTime());
    expect(link?.meeting.scheduledStart.getTime()).toBe(scheduledStart.getTime());
  });

  it('⚠ still links, and still returns the anchor, for a row on a CANCELLED + SOFT-DELETED meeting (the documented unfiltered join)', async () => {
    // R5 does not gate on meeting state, and step 3 deliberately does not filter
    // `meetings.deleted_at` — a filtered join would silently drop an ALREADY-LINKED row's anchor.
    const user = await userFactory();
    const { meeting } = await meetingFactory({
      values: { status: 'cancelled', deletedAt: new Date() },
    });
    const { guest } = await meetingGuestFactory({
      meetingId: meeting.id,
      values: { email: 'dana@deleted-meeting.test' },
    });

    const links = await meetingGuestsRepository.linkConvertedUser({
      convertedToUserId: user.id,
      verifiedEmail: 'dana@deleted-meeting.test',
    });

    expect(links).toEqual([
      {
        guestId: guest.id,
        meeting: { id: meeting.id, startedAt: null, scheduledStart: meeting.scheduledStart },
      },
    ]);
  });

  it('is ATOMIC — a failing audit sink leaves the conversion pair unwritten', async () => {
    const user = await userFactory();
    const email = 'dana@atomic.test';
    const guest = await seedGuest(email);

    await expectAuditFailureRollsBack(() =>
      meetingGuestsRepository.linkConvertedUser({
        convertedToUserId: user.id,
        verifiedEmail: email,
      })
    );

    const afterFailure = await readGuest(guest.id);
    expect(afterFailure.convertedToUserId).toBeNull();
    expect(afterFailure.convertedAt).toBeNull();
    expect(await guestAuditActions(guest.id)).not.toContain(CONVERTED);

    // Non-vacuity: the rolled-back row is still eligible, so the rollback really undid a write.
    const retried = await meetingGuestsRepository.linkConvertedUser({
      convertedToUserId: user.id,
      verifiedEmail: email,
    });
    expect(linkedIds(retried)).toEqual([guest.id]);
  });

  it('`meeting_guest_email_unconverted_idx` exists, leads on `email`, and is partial on the three row states — NOT on `invite_channel`', async () => {
    const rows = await db.execute(sql`
      SELECT indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'meeting_guests'
        AND indexname = 'meeting_guest_email_unconverted_idx'
    `);

    expect(rows).toHaveLength(1);
    const [row] = rows;
    if (row === undefined) {
      throw new Error('expected meeting_guest_email_unconverted_idx to exist');
    }
    const indexdef = String(row.indexdef);
    expect(indexdef).toContain('(email)');
    expect(indexdef).toContain('converted_to_user_id IS NULL');
    expect(indexdef).toContain('revoked_at IS NULL');
    expect(indexdef).toContain('deleted_at IS NULL');
    // ⚠ The literal is omitted on purpose — see the index comment in `schema/guests.ts`.
    expect(indexdef).not.toContain('invite_channel');
  });
});

// ── 7. EVERY CHECK REJECTS ITS VIOLATION ─────────────────────────────────────

describe('meeting_guests — the CHECK backstops', () => {
  it('refuses party = `observer` (meeting_guest_party_two_sided)', async () => {
    const { meeting } = await meetingFactory();
    const inviter = await userFactory();
    await expectConstraintViolation('23514', (tx) =>
      tx.insert(meetingGuests).values(rawGuestRow(meeting.id, inviter.id, { party: 'observer' }))
    );
  });

  it('refuses an EXPERT-SIDE DELEGATE — expert substitution is UNREPRESENTABLE', async () => {
    // ⚠⚠ THE LOAD-BEARING GUARD (D4). A delegate attends INSTEAD of the booker, and the
    // booker is the client — so an expert-side delegate IS expert substitution, which is
    // out of scope. Refusing it at the DATABASE means no future service branch can
    // reintroduce it. The service refuses it first with a legible 422; this is the backstop.
    const { meeting } = await meetingFactory();
    const inviter = await userFactory();
    await expectConstraintViolation('23514', (tx) =>
      tx
        .insert(meetingGuests)
        .values(
          rawGuestRow(meeting.id, inviter.id, { party: 'expert', participationRole: 'delegate' })
        )
    );
  });

  it('ALLOWS an expert-side GUEST and a client-side DELEGATE (the guard is not over-broad)', async () => {
    const { meeting } = await meetingFactory();
    const inviter = await userFactory();

    const rows = await meetingGuestsRepository.createMany({
      meetingId: meeting.id,
      invitedById: inviter.id,
      guests: [
        inviteInput({ email: 'colleague@cloudpeak.test', party: 'expert' }),
        inviteInput({ email: 'stand-in@northwind.test', participationRole: 'delegate' }),
      ],
    });
    expect(rows).toHaveLength(2);
  });

  it('refuses a terminal admission with no stamp, and a stamp on a non-terminal admission', async () => {
    const { meeting } = await meetingFactory();
    const inviter = await userFactory();

    // Terminal, unstamped.
    await expectConstraintViolation('23514', (tx) =>
      tx.insert(meetingGuests).values(rawGuestRow(meeting.id, inviter.id, { admission: 'denied' }))
    );
    // Non-terminal, stamped (and attributed, so it is THIS check that fires).
    await expectConstraintViolation('23514', (tx) =>
      tx.insert(meetingGuests).values(
        rawGuestRow(meeting.id, inviter.id, {
          admission: 'pending',
          admissionDecidedAt: new Date(),
          admittedByUserId: inviter.id,
        })
      )
    );
  });

  it('refuses attribution WITHOUT a stamp — the nonsensical direction (both attributed CHECKs)', async () => {
    const { meeting } = await meetingFactory();
    const inviter = await userFactory();

    // "Somebody admitted this" on a row that was never decided.
    await expectConstraintViolation('23514', (tx) =>
      tx.insert(meetingGuests).values(
        rawGuestRow(meeting.id, inviter.id, {
          admission: 'pre_admitted',
          admissionDecidedAt: null,
          admittedByUserId: inviter.id,
        })
      )
    );
    // "Somebody revoked this" on a row that is not revoked.
    await expectConstraintViolation('23514', (tx) =>
      tx
        .insert(meetingGuests)
        .values(rawGuestRow(meeting.id, inviter.id, { revokedByUserId: inviter.id }))
    );
  });

  it('PERMITS a stamp whose actor is gone — the residue of a hard user delete', async () => {
    // ⚠ THE OTHER DIRECTION IS DELIBERATELY LEGAL, and this test is why the two CHECKs are
    // implications rather than biconditionals. `revoked_by_user_id` / `admitted_by_user_id`
    // are ADR-1030 `restrict` FKs, and a hard-delete path existed at `admin-dev/_actions/
    // delete-user.ts` until BAL-549 deleted it, which NULLed them to let an operator
    // hard-delete a user — which produces exactly these two rows. A biconditional would turn
    // any future operator action of that shape into a 23514 that no local gate catches.
    // Losing the ACTOR while keeping the FACT is the trade `meeting_presence.user_id` already
    // makes.
    const { meeting } = await meetingFactory();
    const inviter = await userFactory();

    const [revokedActorGone] = await db
      .insert(meetingGuests)
      .values(rawGuestRow(meeting.id, inviter.id, { revokedAt: new Date(), deletedAt: new Date() }))
      .returning();
    expect(revokedActorGone?.revokedAt).not.toBeNull();
    expect(revokedActorGone?.revokedByUserId).toBeNull();

    const [decidedActorGone] = await db
      .insert(meetingGuests)
      .values(
        rawGuestRow(meeting.id, inviter.id, {
          admission: 'admitted',
          admissionDecidedAt: new Date(),
        })
      )
      .returning();
    expect(decidedActorGone?.admission).toBe('admitted');
    expect(decidedActorGone?.admittedByUserId).toBeNull();
  });

  it('refuses a NULL inviter on a non-`link` channel (meeting_guest_self_claimed_is_link)', async () => {
    // ⚠ THE CONSTRAINT THAT GUARDS 0064'S OWN WIDENING. `invited_by_id` became nullable in
    // this migration, so this is the row shape that only became EXPRESSIBLE here: an
    // inviter-less guest that claims to have arrived by `email`. Nobody sent that email —
    // there is no sender — so the row asserts a provenance that cannot exist.
    const { meeting } = await meetingFactory();
    await expectConstraintViolation('23514', (tx) =>
      tx.insert(meetingGuests).values(
        // `rawGuestRow`'s second arg is the inviter; the override nulls it. Every other
        // column stays valid, so it is THIS check that fires and not a neighbour.
        rawGuestRow(meeting.id, '00000000-0000-0000-0000-000000000000', {
          invitedById: null,
          inviteChannel: 'email',
        })
      )
    );
  });

  it('PERMITS a link-channel row that DOES name an inviter — the check is an IMPLICATION, not a biconditional', async () => {
    // ⚠⚠ THIS TEST IS THE GUARD AGAINST A FUTURE "TIGHTENING". The one-directional check
    // says only "a null inviter implies a link row". The converse — an attributed link row —
    // is DELIBERATELY LEGAL, because BAL-436 ships a "Copy join link" control and a follow-up
    // could legitimately attribute the resulting row to the member who copied the link.
    // A biconditional would forbid this insert; if someone ever writes one, this test is the
    // thing that goes red and explains why.
    const { meeting } = await meetingFactory();
    const inviter = await userFactory();

    const [row] = await db
      .insert(meetingGuests)
      .values(rawGuestRow(meeting.id, inviter.id, { inviteChannel: 'link' }))
      .returning();

    expect(row?.inviteChannel).toBe('link');
    expect(row?.invitedById).toBe(inviter.id);
  });

  it('PERMITS the self-claim shape the check exists to allow (null inviter + link)', async () => {
    // The other half of "not over-broad": the exact row `claimLobbyPlace` writes must pass.
    const { meeting } = await meetingFactory();

    const [row] = await db
      .insert(meetingGuests)
      .values(
        rawGuestRow(meeting.id, '00000000-0000-0000-0000-000000000000', {
          invitedById: null,
          inviteChannel: 'link',
          admission: 'pending',
        })
      )
      .returning();

    expect(row?.invitedById).toBeNull();
    expect(row?.inviteChannel).toBe('link');
  });

  it('refuses a half-written conversion (meeting_guest_conversion_paired)', async () => {
    // BAL-489 (R11) — BOTH directions. Every other column stays valid, so it is THIS check that
    // fires and not a neighbour.
    const { meeting } = await meetingFactory();
    const inviter = await userFactory();
    const convertedUser = await userFactory();

    // "Converted to U, never."
    await expectConstraintViolation('23514', (tx) =>
      tx.insert(meetingGuests).values(
        rawGuestRow(meeting.id, inviter.id, {
          convertedToUserId: convertedUser.id,
          convertedAt: null,
        })
      )
    );
    // "Converted at T, to nobody."
    await expectConstraintViolation('23514', (tx) =>
      tx.insert(meetingGuests).values(
        rawGuestRow(meeting.id, inviter.id, {
          convertedToUserId: null,
          convertedAt: new Date(),
        })
      )
    );
  });

  it('PERMITS a complete conversion pair (the conversion CHECK is not over-broad)', async () => {
    const { meeting } = await meetingFactory();
    const inviter = await userFactory();
    const convertedUser = await userFactory();

    const [row] = await db
      .insert(meetingGuests)
      .values(
        rawGuestRow(meeting.id, inviter.id, {
          convertedToUserId: convertedUser.id,
          convertedAt: new Date(),
        })
      )
      .returning();

    expect(row?.convertedToUserId).toBe(convertedUser.id);
    expect(row?.convertedAt).toBeInstanceOf(Date);
  });

  it('refuses a negative access_count', async () => {
    const { meeting } = await meetingFactory();
    const inviter = await userFactory();
    await expectConstraintViolation('23514', (tx) =>
      tx.insert(meetingGuests).values(rawGuestRow(meeting.id, inviter.id, { accessCount: -1 }))
    );
  });
});

// ── FK behaviour (the migration's real behaviour change) ─────────────────────

describe('meeting_guests — FK behaviour', () => {
  it('the inviter is ON DELETE RESTRICT — a hard user delete is BLOCKED while a guest row names them', async () => {
    // ⚠ THIS IS THE BEHAVIOUR CHANGE 0061 MAKES (BAL-418 left `invited_by_id` at NO ACTION)
    // and the reason the hard-delete path that existed at `admin-dev/_actions/delete-user.ts`
    // (until BAL-549 deleted it) Phase 4 had to be patched: it NULLed `admitted_by_user_id` /
    // `revoked_by_user_id` as well, AFTER deleting the rows it invited. ADR-1030: attribution
    // must survive the actor's own departure.
    const inviter = await userFactory();
    await meetingGuestFactory({ invitedById: inviter.id });

    await expectConstraintViolation('23503', (tx) =>
      tx.delete(users).where(eq(users.id, inviter.id))
    );
  });

  it('`revoked_by` and `admitted_by` are ALSO restrict — the two FKs the deleted admin-dev/_actions/delete-user.ts did not know about', async () => {
    const inviterOne = await userFactory();
    const revoker = await userFactory();
    const seeded = await meetingGuestFactory({ invitedById: inviterOne.id });
    await meetingGuestsRepository.revoke({
      guestId: seeded.guest.id,
      revokedByUserId: revoker.id,
    });

    // `revoker` invited nobody, so the deleted `admin-dev/_actions/delete-user.ts`'s
    // `delete(... invitedById)` would not have removed this row — which is exactly how the
    // 23503 got reached in production.
    await expectConstraintViolation('23503', (tx) =>
      tx.delete(users).where(eq(users.id, revoker.id))
    );
  });

  it('a HARD-deleted meeting cascades its guests away (ON DELETE cascade)', async () => {
    const { meeting } = await meetingFactory({ contexts: [] });
    await meetingGuestFactory({ meetingId: meeting.id });

    await db.delete(meetings).where(eq(meetings.id, meeting.id));

    const rows = await db
      .select({ id: meetingGuests.id })
      .from(meetingGuests)
      .where(eq(meetingGuests.meetingId, meeting.id));
    expect(rows).toEqual([]);
  });
});

// ── 8. THE meeting_presence GUEST GAP, CLOSED ────────────────────────────────

describe('meeting_presence — the BAL-408 guest identity (D7)', () => {
  it('rejects a SECOND OPEN interval for one guest (meeting_presence_one_open_per_guest_idx)', async () => {
    // ⚠ ASSERTED SEQUENTIALLY, NOT VIA RACING CLIENTS — memory
    // `reference_db_integration_harness_no_concurrency`: the harness is a `max:1` pool
    // inside ONE per-test transaction, so genuine concurrency is INEXPRESSIBLE here. Two
    // ordinary inserts prove the same constraint: the second must fail 23505.
    const { meeting } = await meetingFactory();
    const seeded = await meetingGuestFactory({ meetingId: meeting.id });

    await db.insert(meetingPresence).values({
      meetingId: meeting.id,
      meetingGuestId: seeded.guest.id,
      party: 'client',
      joinedAt: new Date(),
    });

    await expectConstraintViolation('23505', (tx) =>
      tx.insert(meetingPresence).values({
        meetingId: meeting.id,
        meetingGuestId: seeded.guest.id,
        party: 'client',
        joinedAt: new Date(),
      })
    );
  });

  it('a CLOSED guest interval frees the slot — a genuine rejoin still works', async () => {
    const { meeting } = await meetingFactory();
    const seeded = await meetingGuestFactory({ meetingId: meeting.id });
    const joinedAt = new Date(Date.now() - 60_000);

    const [first] = await db
      .insert(meetingPresence)
      .values({
        meetingId: meeting.id,
        meetingGuestId: seeded.guest.id,
        party: 'client',
        joinedAt,
        leftAt: new Date(),
      })
      .returning();

    const [second] = await db
      .insert(meetingPresence)
      .values({
        meetingId: meeting.id,
        meetingGuestId: seeded.guest.id,
        party: 'client',
        joinedAt: new Date(),
      })
      .returning();

    expect(second?.id).not.toBe(first?.id);
  });

  it('refuses BOTH identities on one interval (meeting_presence_identity_not_both)', async () => {
    const { meeting } = await meetingFactory();
    const seeded = await meetingGuestFactory({ meetingId: meeting.id });
    const user = await userFactory();

    await expectConstraintViolation('23514', (tx) =>
      tx.insert(meetingPresence).values({
        meetingId: meeting.id,
        userId: user.id,
        meetingGuestId: seeded.guest.id,
        party: 'client',
        joinedAt: new Date(),
      })
    );
  });

  it('allows NEITHER identity — BAL-134 may observe a Daily participant it cannot map', async () => {
    // Deliberately "at most one", never "exactly one": forcing a lie is worse than a NULL.
    const { meeting } = await meetingFactory();
    const [row] = await db
      .insert(meetingPresence)
      .values({ meetingId: meeting.id, party: 'observer', joinedAt: new Date() })
      .returning();
    expect(row?.userId).toBeNull();
    expect(row?.meetingGuestId).toBeNull();
  });

  it('a hard-deleted guest SET NULLs the presence pointer — the billing interval survives', async () => {
    // `set null`, not `restrict`, for the same reason `user_id` is: a presence interval is a
    // BILLING input (BAL-412) that must outlive the identity row, and `party` preserves the
    // side regardless.
    const { meeting } = await meetingFactory();
    const seeded = await meetingGuestFactory({ meetingId: meeting.id });
    const [interval] = await db
      .insert(meetingPresence)
      .values({
        meetingId: meeting.id,
        meetingGuestId: seeded.guest.id,
        party: 'client',
        joinedAt: new Date(),
      })
      .returning();
    if (interval === undefined) {
      throw new Error('expected a presence interval to be inserted');
    }

    await db.delete(meetingGuests).where(eq(meetingGuests.id, seeded.guest.id));

    const [after] = await db
      .select()
      .from(meetingPresence)
      .where(eq(meetingPresence.id, interval.id));
    expect(after?.meetingGuestId).toBeNull();
    expect(after?.party).toBe('client');
  });
});
