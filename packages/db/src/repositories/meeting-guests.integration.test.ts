import { describe, it, expect } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '../client';
import { auditEvents, meetingGuests, meetingPresence, meetings, users } from '../schema';
import type { NewMeetingGuest } from '../schema';
import { meetingFactory, meetingGuestFactory, userFactory } from '../test/factories';
import { expectConstraintViolation } from '../test/helpers/expect-check-violation';
import { meetingGuestsRepository, type CreateMeetingGuestInput } from './meeting-guests';

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

async function invitedAuditRows(guestId: string): Promise<{ actorUserId: string | null }[]> {
  return db
    .select({ actorUserId: auditEvents.actorUserId })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.entityType, 'meeting_guest'),
        eq(auditEvents.entityId, guestId),
        eq(auditEvents.action, 'meeting_guest.invited')
      )
    );
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
      expect(await invitedAuditRows(row.id)).toEqual([{ actorUserId: inviter.id }]);
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
