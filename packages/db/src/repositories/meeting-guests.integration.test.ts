import { describe, it, expect, vi } from 'vitest';
import { and, asc, eq } from 'drizzle-orm';
import { db } from '../client';
import { auditEvents, meetingGuests, meetingPresence, meetings, users } from '../schema';
import type { MeetingGuest, NewMeetingGuest } from '../schema';
import { meetingFactory, meetingGuestFactory, userFactory } from '../test/factories';
import { expectConstraintViolation } from '../test/helpers/expect-check-violation';
import { auditEventsRepository } from './audit-events';
import {
  meetingGuestsRepository,
  type ClaimLobbyPlaceInput,
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
    .orderBy(asc(auditEvents.createdAt), asc(auditEvents.id));
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
    // are ADR-1030 `restrict` FKs, so `admin-dev/_actions/delete-user.ts` NULLs them to let
    // an operator hard-delete a user — which produces exactly these two rows. A
    // biconditional would turn that shipped operator action into a 23514 that no local gate
    // catches. Losing the ACTOR while keeping the FACT is the trade
    // `meeting_presence.user_id` already makes.
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
    // and the reason `admin-dev/_actions/delete-user.ts` Phase 4 had to be patched: it now
    // NULLs `admitted_by_user_id` / `revoked_by_user_id` as well, AFTER deleting the rows
    // it invited. ADR-1030: attribution must survive the actor's own departure.
    const inviter = await userFactory();
    await meetingGuestFactory({ invitedById: inviter.id });

    await expectConstraintViolation('23503', (tx) =>
      tx.delete(users).where(eq(users.id, inviter.id))
    );
  });

  it('`revoked_by` and `admitted_by` are ALSO restrict — the two FKs delete-user.ts did not know about', async () => {
    const inviterOne = await userFactory();
    const revoker = await userFactory();
    const seeded = await meetingGuestFactory({ invitedById: inviterOne.id });
    await meetingGuestsRepository.revoke({
      guestId: seeded.guest.id,
      revokedByUserId: revoker.id,
    });

    // `revoker` invited nobody, so `delete-user.ts`'s `delete(... invitedById)` would not
    // have removed this row — which is exactly how the 23503 got reached in production.
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
