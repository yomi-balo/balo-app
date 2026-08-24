import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../client';
import {
  meetings,
  rescheduleProposals,
  rescheduleProposalOptions,
  users,
  type NewRescheduleProposal,
  type RescheduleProposalOption,
} from '../schema';
import { meetingFactory, rescheduleProposalFactory, userFactory } from '../test/factories';
import { expectConstraintViolation } from '../test/helpers/expect-check-violation';
import {
  rescheduleProposalsRepository,
  RescheduleProposalAlreadyPendingError,
  type ProposeRescheduleInput,
} from './reschedule-proposals';

/**
 * BAL-411 — `reschedule_proposals` / `reschedule_proposal_options`.
 *
 * ⚠ EVERY RAW CONSTRAINT PROBE GOES THROUGH `expectConstraintViolation`, WHICH RUNS IT ON
 * ITS OWN SAVEPOINT USING THE SUPPLIED `tx`. The harness holds each test inside ONE outer
 * transaction; a failing statement on the module-level `db` ABORTS it and every later
 * statement answers `25P02` instead of the SQLSTATE under assertion.
 *
 * REPOSITORY calls are different, and deliberately so: `propose`, `accept` and
 * `revertAccept` wrap their own bodies in `exec.transaction(…)`, which is a SAVEPOINT when
 * the executor is already a transaction — so an expected `23505` inside `propose` is
 * CONTAINED and the test can keep asserting afterwards. Several cases below prove exactly
 * that by continuing to query after a rejected call.
 */

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

function rawProposalRow(
  meetingId: string,
  proposedByUserId: string,
  overrides: Partial<NewRescheduleProposal> = {}
): NewRescheduleProposal {
  const originalScheduledStart = new Date(Date.now() + HOUR_MS);
  return {
    meetingId,
    proposedByUserId,
    originalScheduledStart,
    expiresAt: originalScheduledStart,
    ...overrides,
  };
}

/**
 * Narrow one seeded option by DESTRUCTURE + GUARD. `noUncheckedIndexedAccess` is on, and a
 * `!` here would be both a lie and a SonarCloud "unnecessary non-null assertion" false
 * positive (memory `reference_sonar_nonnull_false_positive`).
 */
function optionAt(
  options: readonly RescheduleProposalOption[],
  index: number
): RescheduleProposalOption {
  const option = options[index];
  if (option === undefined) {
    throw new Error(`fixture: expected a seeded option at index ${index}`);
  }
  return option;
}

async function seedMeetingAndExpert(): Promise<{
  meetingId: string;
  expertUserId: string;
  scheduledStart: Date;
}> {
  const { meeting } = await meetingFactory({ contexts: [] });
  const expert = await userFactory();
  return {
    meetingId: meeting.id,
    expertUserId: expert.id,
    scheduledStart: meeting.scheduledStart,
  };
}

function proposeInput(
  meetingId: string,
  proposedByUserId: string,
  originalScheduledStart: Date,
  optionCount = 2
): ProposeRescheduleInput {
  const base = originalScheduledStart.getTime();
  return {
    meetingId,
    proposedByUserId,
    originalScheduledStart,
    expiresAt: originalScheduledStart,
    options: Array.from({ length: optionCount }, (_unused, index) => ({
      scheduledStart: new Date(base + (index + 24) * HOUR_MS),
      scheduledEnd: new Date(base + (index + 25) * HOUR_MS),
    })),
  };
}

describe('rescheduleProposalsRepository.propose', () => {
  it('writes the proposal and its options, positioned by ARRAY ORDER, in one transaction', async () => {
    const { meetingId, expertUserId, scheduledStart } = await seedMeetingAndExpert();
    const now = new Date();

    const { proposal, options } = await rescheduleProposalsRepository.propose(
      proposeInput(meetingId, expertUserId, scheduledStart, 3),
      now
    );

    expect(proposal.status).toBe('pending');
    expect(proposal.meetingId).toBe(meetingId);
    expect(proposal.proposedByUserId).toBe(expertUserId);
    // The biconditional's pending half.
    expect(proposal.resolvedAt).toBeNull();
    expect(proposal.resolvedByUserId).toBeNull();
    expect(proposal.originalScheduledStart.getTime()).toBe(scheduledStart.getTime());
    expect(options.map((option) => option.position)).toEqual([0, 1, 2]);
    expect(options.every((option) => option.acceptedAt === null)).toBe(true);
  });

  it('REFUSES a second pending proposal on one meeting — 23505 mapped to the NAMED error, and the caller transaction SURVIVES', async () => {
    const { meetingId, expertUserId, scheduledStart } = await seedMeetingAndExpert();
    const now = new Date();
    await rescheduleProposalsRepository.propose(
      proposeInput(meetingId, expertUserId, scheduledStart),
      now
    );

    await expect(
      rescheduleProposalsRepository.propose(
        proposeInput(meetingId, expertUserId, scheduledStart),
        now
      )
    ).rejects.toBeInstanceOf(RescheduleProposalAlreadyPendingError);

    // ⚠ THE POINT OF THIS ASSERTION: a statement AFTER the rejected call still runs. The
    // `23505` was contained by `propose`'s own savepoint rather than poisoning the ambient
    // transaction (which would answer `25P02` here).
    const live = await rescheduleProposalsRepository.findLivePendingByMeetingIds([meetingId]);
    expect(live).toHaveLength(1);
    // …and the failed attempt left NOTHING behind — not even orphaned option rows.
    const allRows = await db
      .select({ id: rescheduleProposals.id })
      .from(rescheduleProposals)
      .where(eq(rescheduleProposals.meetingId, meetingId));
    expect(allRows).toHaveLength(1);
  });

  it('a SOFT-DELETED pending proposal does NOT block a new one — the partial unique is partial on deleted_at', async () => {
    const { meetingId, expertUserId, scheduledStart } = await seedMeetingAndExpert();
    await rescheduleProposalFactory({
      meetingId,
      proposedByUserId: expertUserId,
      originalScheduledStart: scheduledStart,
      values: { deletedAt: new Date() },
    });

    const { proposal } = await rescheduleProposalsRepository.propose(
      proposeInput(meetingId, expertUserId, scheduledStart),
      new Date()
    );
    expect(proposal.status).toBe('pending');
  });

  it('EDGE CASE §3 — a LAPSED pending row is expired first, so the next propose succeeds (the index cannot express expiry)', async () => {
    const { meetingId, expertUserId } = await seedMeetingAndExpert();
    const lapsedStart = new Date(Date.now() - 2 * HOUR_MS);
    const { proposal: lapsed } = await rescheduleProposalFactory({
      meetingId,
      proposedByUserId: expertUserId,
      originalScheduledStart: lapsedStart,
    });

    // The client then moved the meeting forward (BAL-409); the expert asks again.
    const newStart = new Date(Date.now() + 3 * HOUR_MS);
    const { proposal: fresh } = await rescheduleProposalsRepository.propose(
      proposeInput(meetingId, expertUserId, newStart),
      new Date()
    );

    expect(fresh.status).toBe('pending');
    const [reloaded] = await db
      .select()
      .from(rescheduleProposals)
      .where(eq(rescheduleProposals.id, lapsed.id));
    expect(reloaded?.status).toBe('expired');
    // `resolved_at = expires_at` — it lapsed when the DEADLINE passed, not when a later
    // write noticed.
    expect(reloaded?.resolvedAt?.getTime()).toBe(lapsed.expiresAt.getTime());
    expect(reloaded?.resolvedByUserId).toBeNull();
  });

  it('refuses a proposal with no options at all', async () => {
    const { meetingId, expertUserId, scheduledStart } = await seedMeetingAndExpert();

    await expect(
      rescheduleProposalsRepository.propose(
        { ...proposeInput(meetingId, expertUserId, scheduledStart), options: [] },
        new Date()
      )
    ).rejects.toThrow(/at least one option/);
  });
});

describe('reschedule_proposals — CHECK and unique backstops', () => {
  it('rejects `expires_at` AFTER `original_scheduled_start` (23514)', async () => {
    const { meetingId, expertUserId } = await seedMeetingAndExpert();
    const start = new Date(Date.now() + HOUR_MS);

    await expectConstraintViolation('23514', (tx) =>
      tx.insert(rescheduleProposals).values(
        rawProposalRow(meetingId, expertUserId, {
          originalScheduledStart: start,
          expiresAt: new Date(start.getTime() + MINUTE_MS),
        })
      )
    );
  });

  it('rejects a PENDING row that carries `resolved_at` (23514 — the biconditional)', async () => {
    const { meetingId, expertUserId } = await seedMeetingAndExpert();

    await expectConstraintViolation('23514', (tx) =>
      tx
        .insert(rescheduleProposals)
        .values(rawProposalRow(meetingId, expertUserId, { resolvedAt: new Date() }))
    );
  });

  it('rejects a RESOLVED row with a NULL `resolved_at` (23514 — the other half)', async () => {
    const { meetingId, expertUserId } = await seedMeetingAndExpert();

    await expectConstraintViolation('23514', (tx) =>
      tx
        .insert(rescheduleProposals)
        .values(rawProposalRow(meetingId, expertUserId, { status: 'declined', resolvedAt: null }))
    );
  });

  it('rejects a second PENDING row for one meeting with a raw 23505', async () => {
    const { meetingId, expertUserId } = await seedMeetingAndExpert();
    await rescheduleProposalFactory({ meetingId, proposedByUserId: expertUserId });

    await expectConstraintViolation('23505', (tx) =>
      tx.insert(rescheduleProposals).values(rawProposalRow(meetingId, expertUserId))
    );
  });

  it('ALLOWS a new pending proposal once the previous one is TERMINAL — the unique is partial on `status`', async () => {
    const { meetingId, expertUserId, scheduledStart } = await seedMeetingAndExpert();
    await rescheduleProposalFactory({
      meetingId,
      proposedByUserId: expertUserId,
      originalScheduledStart: scheduledStart,
      values: { status: 'declined' },
    });

    const { proposal } = await rescheduleProposalsRepository.propose(
      proposeInput(meetingId, expertUserId, scheduledStart),
      new Date()
    );
    expect(proposal.status).toBe('pending');
  });

  it('rejects an unknown `meetingId` (23503) and refuses to hard-delete the proposing user (23503, `restrict`)', async () => {
    const { meetingId, expertUserId } = await seedMeetingAndExpert();

    await expectConstraintViolation('23503', (tx) =>
      tx.insert(rescheduleProposals).values(rawProposalRow(randomUUID(), expertUserId))
    );

    // ATTRIBUTION SURVIVES THE ACTOR: `proposed_by_user_id` is `restrict`, so the user hard
    // delete FAILS while a proposal names them (the `meeting_files` precedent).
    await rescheduleProposalFactory({ meetingId, proposedByUserId: expertUserId });
    await expectConstraintViolation('23503', (tx) =>
      tx.delete(users).where(eq(users.id, expertUserId))
    );
  });
});

describe('reschedule_proposal_options — CHECK and unique backstops', () => {
  it('rejects `position` outside 0..2 (23514) — the structural "up to 3" cap', async () => {
    const { proposal } = await rescheduleProposalFactory({ options: [] });
    const start = new Date(Date.now() + 24 * HOUR_MS);

    await expectConstraintViolation('23514', (tx) =>
      tx.insert(rescheduleProposalOptions).values({
        proposalId: proposal.id,
        position: 3,
        scheduledStart: start,
        scheduledEnd: new Date(start.getTime() + HOUR_MS),
      })
    );

    await expectConstraintViolation('23514', (tx) =>
      tx.insert(rescheduleProposalOptions).values({
        proposalId: proposal.id,
        position: -1,
        scheduledStart: start,
        scheduledEnd: new Date(start.getTime() + HOUR_MS),
      })
    );
  });

  it('rejects `scheduled_end <= scheduled_start` (23514) — strict, these are WINDOWS', async () => {
    const { proposal } = await rescheduleProposalFactory({ options: [] });
    const start = new Date(Date.now() + 24 * HOUR_MS);

    await expectConstraintViolation('23514', (tx) =>
      tx.insert(rescheduleProposalOptions).values({
        proposalId: proposal.id,
        position: 0,
        scheduledStart: start,
        scheduledEnd: start,
      })
    );
  });

  it('rejects a duplicate `position` and a duplicate `scheduled_start` within one proposal (23505)', async () => {
    const start = new Date(Date.now() + 24 * HOUR_MS);
    const { proposal } = await rescheduleProposalFactory({
      options: [{ scheduledStart: start, scheduledEnd: new Date(start.getTime() + HOUR_MS) }],
    });

    await expectConstraintViolation('23505', (tx) =>
      tx.insert(rescheduleProposalOptions).values({
        proposalId: proposal.id,
        position: 0,
        scheduledStart: new Date(start.getTime() + 2 * HOUR_MS),
        scheduledEnd: new Date(start.getTime() + 3 * HOUR_MS),
      })
    );

    await expectConstraintViolation('23505', (tx) =>
      tx.insert(rescheduleProposalOptions).values({
        proposalId: proposal.id,
        position: 1,
        scheduledStart: start,
        scheduledEnd: new Date(start.getTime() + HOUR_MS),
      })
    );
  });

  it('permits AT MOST ONE accepted option per proposal (23505)', async () => {
    const start = new Date(Date.now() + 24 * HOUR_MS);
    const { proposal } = await rescheduleProposalFactory({
      options: [
        {
          scheduledStart: start,
          scheduledEnd: new Date(start.getTime() + HOUR_MS),
          acceptedAt: new Date(),
        },
        {
          scheduledStart: new Date(start.getTime() + 2 * HOUR_MS),
          scheduledEnd: new Date(start.getTime() + 3 * HOUR_MS),
        },
      ],
    });

    // Stamping BOTH options accepted is exactly what the partial unique refuses.
    await expectConstraintViolation('23505', (tx) =>
      tx
        .update(rescheduleProposalOptions)
        .set({ acceptedAt: new Date() })
        .where(eq(rescheduleProposalOptions.proposalId, proposal.id))
    );
  });

  it('CASCADES from the proposal, and from the MEETING through the proposal', async () => {
    const { meetingId, proposal } = await rescheduleProposalFactory();

    await db.delete(rescheduleProposals).where(eq(rescheduleProposals.id, proposal.id));
    expect(
      await db
        .select({ id: rescheduleProposalOptions.id })
        .from(rescheduleProposalOptions)
        .where(eq(rescheduleProposalOptions.proposalId, proposal.id))
    ).toHaveLength(0);

    const second = await rescheduleProposalFactory({ meetingId });
    await db.delete(meetings).where(eq(meetings.id, meetingId));
    expect(
      await db
        .select({ id: rescheduleProposals.id })
        .from(rescheduleProposals)
        .where(eq(rescheduleProposals.id, second.proposal.id))
    ).toHaveLength(0);
    expect(
      await db
        .select({ id: rescheduleProposalOptions.id })
        .from(rescheduleProposalOptions)
        .where(eq(rescheduleProposalOptions.proposalId, second.proposal.id))
    ).toHaveLength(0);
  });
});

describe('rescheduleProposalsRepository.findLivePendingByMeetingIds', () => {
  it('returns one summary per pending proposal, counting only LIVE options', async () => {
    const start = new Date(Date.now() + 24 * HOUR_MS);
    const { proposal, meetingId } = await rescheduleProposalFactory({
      options: [
        { scheduledStart: start, scheduledEnd: new Date(start.getTime() + HOUR_MS) },
        {
          scheduledStart: new Date(start.getTime() + 2 * HOUR_MS),
          scheduledEnd: new Date(start.getTime() + 3 * HOUR_MS),
        },
        {
          scheduledStart: new Date(start.getTime() + 4 * HOUR_MS),
          scheduledEnd: new Date(start.getTime() + 5 * HOUR_MS),
          deletedAt: new Date(),
        },
      ],
    });

    const rows = await rescheduleProposalsRepository.findLivePendingByMeetingIds([meetingId]);
    const found = rows.find((row) => row.proposalId === proposal.id);
    expect(found?.optionCount).toBe(2);
    expect(found?.meetingId).toBe(meetingId);
    expect(found?.expiresAt.getTime()).toBe(proposal.expiresAt.getTime());
  });

  it('skips SOFT-DELETED and NON-PENDING proposals, and returns [] for an empty id list', async () => {
    const deleted = await rescheduleProposalFactory({ values: { deletedAt: new Date() } });
    const declined = await rescheduleProposalFactory({ values: { status: 'declined' } });

    expect(
      await rescheduleProposalsRepository.findLivePendingByMeetingIds([
        deleted.meetingId,
        declined.meetingId,
      ])
    ).toEqual([]);
    expect(await rescheduleProposalsRepository.findLivePendingByMeetingIds([])).toEqual([]);
  });

  it('DOES return a LAPSED pending proposal — expiry is derived in @balo/shared, never filtered here', async () => {
    const lapsedStart = new Date(Date.now() - HOUR_MS);
    const { proposal, meetingId } = await rescheduleProposalFactory({
      originalScheduledStart: lapsedStart,
    });

    const rows = await rescheduleProposalsRepository.findLivePendingByMeetingIds([meetingId]);
    expect(rows.map((row) => row.proposalId)).toEqual([proposal.id]);
  });
});

describe('rescheduleProposalsRepository.findPendingForAnswer', () => {
  it('returns the proposal with its LIVE options in position order', async () => {
    const start = new Date(Date.now() + 24 * HOUR_MS);
    const { proposal, meetingId } = await rescheduleProposalFactory({
      options: [
        { scheduledStart: start, scheduledEnd: new Date(start.getTime() + HOUR_MS), position: 1 },
        {
          scheduledStart: new Date(start.getTime() + 2 * HOUR_MS),
          scheduledEnd: new Date(start.getTime() + 3 * HOUR_MS),
          position: 0,
        },
        {
          scheduledStart: new Date(start.getTime() + 4 * HOUR_MS),
          scheduledEnd: new Date(start.getTime() + 5 * HOUR_MS),
          position: 2,
          deletedAt: new Date(),
        },
      ],
    });

    const found = await rescheduleProposalsRepository.findPendingForAnswer({
      proposalId: proposal.id,
      meetingId,
    });
    expect(found?.proposal.id).toBe(proposal.id);
    expect(found?.options.map((option) => option.position)).toEqual([0, 1]);
  });

  it('returns a NON-PENDING proposal too — the recheck must tell `answered` from `missing`', async () => {
    const { proposal, meetingId } = await rescheduleProposalFactory({
      values: { status: 'withdrawn' },
    });

    const found = await rescheduleProposalsRepository.findPendingForAnswer({
      proposalId: proposal.id,
      meetingId,
    });
    expect(found?.proposal.status).toBe('withdrawn');
  });

  it('returns undefined for a SOFT-DELETED proposal and for the WRONG meeting', async () => {
    const softDeleted = await rescheduleProposalFactory({ values: { deletedAt: new Date() } });
    expect(
      await rescheduleProposalsRepository.findPendingForAnswer({
        proposalId: softDeleted.proposal.id,
        meetingId: softDeleted.meetingId,
      })
    ).toBeUndefined();

    const other = await rescheduleProposalFactory();
    expect(
      await rescheduleProposalsRepository.findPendingForAnswer({
        proposalId: other.proposal.id,
        meetingId: softDeleted.meetingId,
      })
    ).toBeUndefined();
  });
});

describe('rescheduleProposalsRepository — the answer CAS (accept / decline / withdraw)', () => {
  it('accept stamps the proposal AND the winning option, and a SECOND accept returns undefined', async () => {
    const { proposal, options, meetingId } = await rescheduleProposalFactory({
      originalScheduledStart: new Date(Date.now() + 24 * HOUR_MS),
    });
    const client = await userFactory();
    const winner = optionAt(options, 0);
    const now = new Date();

    const accepted = await rescheduleProposalsRepository.accept(
      {
        proposalId: proposal.id,
        meetingId,
        optionId: winner.id,
        actorUserId: client.id,
      },
      now
    );
    expect(accepted?.proposal.status).toBe('accepted');
    expect(accepted?.proposal.resolvedAt?.getTime()).toBe(now.getTime());
    expect(accepted?.proposal.resolvedByUserId).toBe(client.id);
    expect(accepted?.option.acceptedAt?.getTime()).toBe(now.getTime());

    // The CAS is what serialises two concurrent accepts — the loser writes nothing.
    expect(
      await rescheduleProposalsRepository.accept(
        {
          proposalId: proposal.id,
          meetingId,
          optionId: winner.id,
          actorUserId: client.id,
        },
        new Date()
      )
    ).toBeUndefined();
  });

  it('accept with an option belonging to ANOTHER proposal returns undefined and ROLLS THE CAS BACK', async () => {
    const mine = await rescheduleProposalFactory({
      originalScheduledStart: new Date(Date.now() + 24 * HOUR_MS),
    });
    const theirs = await rescheduleProposalFactory();
    const client = await userFactory();
    const foreign = optionAt(theirs.options, 0);

    expect(
      await rescheduleProposalsRepository.accept(
        {
          proposalId: mine.proposal.id,
          meetingId: mine.meetingId,
          optionId: foreign.id,
          actorUserId: client.id,
        },
        new Date()
      )
    ).toBeUndefined();

    // ⚠ THE ROLLBACK IS THE ASSERTION: an accepted proposal with no accepted option would be
    // a lie in the ledger.
    const [reloaded] = await db
      .select()
      .from(rescheduleProposals)
      .where(eq(rescheduleProposals.id, mine.proposal.id));
    expect(reloaded?.status).toBe('pending');
    expect(reloaded?.resolvedAt).toBeNull();
  });

  it('refuses to answer an EXPIRED proposal — every path carries `expires_at > now`', async () => {
    const lapsedStart = new Date(Date.now() - HOUR_MS);
    const { proposal, options, meetingId } = await rescheduleProposalFactory({
      originalScheduledStart: lapsedStart,
    });
    const actor = await userFactory();
    const option = optionAt(options, 0);
    const now = new Date();

    expect(
      await rescheduleProposalsRepository.accept(
        { proposalId: proposal.id, meetingId, optionId: option.id, actorUserId: actor.id },
        now
      )
    ).toBeUndefined();
    expect(
      await rescheduleProposalsRepository.decline(
        { proposalId: proposal.id, meetingId, actorUserId: actor.id },
        now
      )
    ).toBeUndefined();
    expect(
      await rescheduleProposalsRepository.withdraw(
        { proposalId: proposal.id, meetingId, actorUserId: actor.id },
        now
      )
    ).toBeUndefined();
  });

  it('refuses to answer a proposal under the WRONG meeting id', async () => {
    const { proposal } = await rescheduleProposalFactory({
      originalScheduledStart: new Date(Date.now() + 24 * HOUR_MS),
    });
    const { meeting: otherMeeting } = await meetingFactory({ contexts: [] });
    const actor = await userFactory();

    expect(
      await rescheduleProposalsRepository.decline(
        { proposalId: proposal.id, meetingId: otherMeeting.id, actorUserId: actor.id },
        new Date()
      )
    ).toBeUndefined();
  });

  it('refuses to answer a SOFT-DELETED proposal', async () => {
    const { proposal, meetingId } = await rescheduleProposalFactory({
      originalScheduledStart: new Date(Date.now() + 24 * HOUR_MS),
      values: { deletedAt: new Date() },
    });
    const actor = await userFactory();

    expect(
      await rescheduleProposalsRepository.withdraw(
        { proposalId: proposal.id, meetingId, actorUserId: actor.id },
        new Date()
      )
    ).toBeUndefined();
  });

  it('decline is terminal and idempotency-free — a second decline returns undefined', async () => {
    const { proposal, meetingId } = await rescheduleProposalFactory({
      originalScheduledStart: new Date(Date.now() + 24 * HOUR_MS),
    });
    const client = await userFactory();
    const now = new Date();

    const declined = await rescheduleProposalsRepository.decline(
      { proposalId: proposal.id, meetingId, actorUserId: client.id },
      now
    );
    expect(declined?.status).toBe('declined');
    expect(declined?.resolvedByUserId).toBe(client.id);

    expect(
      await rescheduleProposalsRepository.decline(
        { proposalId: proposal.id, meetingId, actorUserId: client.id },
        new Date()
      )
    ).toBeUndefined();
  });

  it('withdraw is terminal, and LOSES to an accept that committed first (the §D5 race)', async () => {
    const { proposal, options, meetingId } = await rescheduleProposalFactory({
      originalScheduledStart: new Date(Date.now() + 24 * HOUR_MS),
    });
    const client = await userFactory();
    const expert = await userFactory();
    const option = optionAt(options, 0);

    await rescheduleProposalsRepository.accept(
      { proposalId: proposal.id, meetingId, optionId: option.id, actorUserId: client.id },
      new Date()
    );

    expect(
      await rescheduleProposalsRepository.withdraw(
        { proposalId: proposal.id, meetingId, actorUserId: expert.id },
        new Date()
      )
    ).toBeUndefined();
  });

  it('withdraw succeeds while pending, and a second withdraw returns undefined', async () => {
    const { proposal, meetingId } = await rescheduleProposalFactory({
      originalScheduledStart: new Date(Date.now() + 24 * HOUR_MS),
    });
    const expert = await userFactory();

    const withdrawn = await rescheduleProposalsRepository.withdraw(
      { proposalId: proposal.id, meetingId, actorUserId: expert.id },
      new Date()
    );
    expect(withdrawn?.status).toBe('withdrawn');
    expect(
      await rescheduleProposalsRepository.withdraw(
        { proposalId: proposal.id, meetingId, actorUserId: expert.id },
        new Date()
      )
    ).toBeUndefined();
  });
});

describe('rescheduleProposalsRepository.revertAccept', () => {
  it('restores answerability — status, resolution columns AND every option`s accepted_at', async () => {
    const start = new Date(Date.now() + 24 * HOUR_MS);
    // Fix round 1 item 4(b) — the meeting's OWN `scheduled_start` must match the anchor for
    // the CAS to succeed, so seed it explicitly rather than let the factory default it.
    const { meeting } = await meetingFactory({
      contexts: [],
      values: { scheduledStart: start, scheduledEnd: new Date(start.getTime() + HOUR_MS) },
    });
    const { proposal, options, meetingId } = await rescheduleProposalFactory({
      meetingId: meeting.id,
      originalScheduledStart: start,
      options: [
        {
          scheduledStart: new Date(start.getTime() + HOUR_MS),
          scheduledEnd: new Date(start.getTime() + 2 * HOUR_MS),
        },
        {
          scheduledStart: new Date(start.getTime() + 3 * HOUR_MS),
          scheduledEnd: new Date(start.getTime() + 4 * HOUR_MS),
        },
      ],
    });
    const client = await userFactory();
    const first = optionAt(options, 0);
    const second = optionAt(options, 1);

    await rescheduleProposalsRepository.accept(
      { proposalId: proposal.id, meetingId, optionId: first.id, actorUserId: client.id },
      new Date()
    );

    const reverted = await rescheduleProposalsRepository.revertAccept({
      proposalId: proposal.id,
      expectedOriginalScheduledStart: start,
    });
    expect(reverted?.status).toBe('pending');
    expect(reverted?.resolvedAt).toBeNull();
    expect(reverted?.resolvedByUserId).toBeNull();

    const stillAccepted = await db
      .select({ id: rescheduleProposalOptions.id })
      .from(rescheduleProposalOptions)
      .where(
        and(
          eq(rescheduleProposalOptions.proposalId, proposal.id),
          isNull(rescheduleProposalOptions.deletedAt)
        )
      );
    expect(stillAccepted).toHaveLength(2);

    // ⚠ THE REAL PROOF: a DIFFERENT option can now be accepted. Leaving the old
    // `accepted_at` in place would make this fail 23505 on the accepted-option unique.
    const reaccepted = await rescheduleProposalsRepository.accept(
      { proposalId: proposal.id, meetingId, optionId: second.id, actorUserId: client.id },
      new Date()
    );
    expect(reaccepted?.option.id).toBe(second.id);
  });

  it('returns undefined when the proposal was never accepted', async () => {
    const start = new Date(Date.now() + 24 * HOUR_MS);
    const { proposal } = await rescheduleProposalFactory({
      originalScheduledStart: start,
    });

    expect(
      await rescheduleProposalsRepository.revertAccept({
        proposalId: proposal.id,
        expectedOriginalScheduledStart: start,
      })
    ).toBeUndefined();
  });

  // Item 4(b) — the whole point of the fix: if the meeting's `scheduled_start` has ALREADY
  // moved away from the anchor (a real, committed move — the normal "the move failed before
  // it wrote anything" case does NOT apply here), the revert must be a no-op, not a re-open.
  it('is a no-op when the meeting has already moved away from the anchor (a committed move)', async () => {
    const start = new Date(Date.now() + 24 * HOUR_MS);
    const { meeting } = await meetingFactory({
      contexts: [],
      values: { scheduledStart: start, scheduledEnd: new Date(start.getTime() + HOUR_MS) },
    });
    const { proposal, options, meetingId } = await rescheduleProposalFactory({
      meetingId: meeting.id,
      originalScheduledStart: start,
    });
    const client = await userFactory();
    const [only] = options;
    if (only === undefined) throw new Error('expected one seeded option');

    await rescheduleProposalsRepository.accept(
      { proposalId: proposal.id, meetingId, optionId: only.id, actorUserId: client.id },
      new Date()
    );

    // Simulate the meeting's write having ALREADY committed (e.g. `rescheduleMeeting` threw
    // AFTER its DB write, from a post-commit step) — the meeting no longer sits at `start`.
    await db
      .update(meetings)
      .set({ scheduledStart: only.scheduledStart, scheduledEnd: only.scheduledEnd })
      .where(eq(meetings.id, meetingId));

    const reverted = await rescheduleProposalsRepository.revertAccept({
      proposalId: proposal.id,
      expectedOriginalScheduledStart: start,
    });
    expect(reverted).toBeUndefined();

    // The proposal is STILL accepted — the revert changed nothing.
    const [stillAcceptedProposal] = await db
      .select({ status: rescheduleProposals.status })
      .from(rescheduleProposals)
      .where(eq(rescheduleProposals.id, proposal.id));
    expect(stillAcceptedProposal?.status).toBe('accepted');
  });
});

describe('rescheduleProposalsRepository.expireStaleForMeeting', () => {
  it('expires only LAPSED pending rows, stamping `resolved_at = expires_at`, and returns the count', async () => {
    const lapsed = await rescheduleProposalFactory({
      originalScheduledStart: new Date(Date.now() - HOUR_MS),
    });
    const live = await rescheduleProposalFactory({
      originalScheduledStart: new Date(Date.now() + 24 * HOUR_MS),
    });

    expect(
      await rescheduleProposalsRepository.expireStaleForMeeting(lapsed.meetingId, new Date())
    ).toBe(1);
    // Idempotent: the row is no longer pending, so a second sweep moves nothing.
    expect(
      await rescheduleProposalsRepository.expireStaleForMeeting(lapsed.meetingId, new Date())
    ).toBe(0);
    expect(
      await rescheduleProposalsRepository.expireStaleForMeeting(live.meetingId, new Date())
    ).toBe(0);

    const [reloadedLive] = await db
      .select()
      .from(rescheduleProposals)
      .where(eq(rescheduleProposals.id, live.proposal.id));
    expect(reloadedLive?.status).toBe('pending');
  });

  it('ignores SOFT-DELETED lapsed rows', async () => {
    const { meetingId } = await rescheduleProposalFactory({
      originalScheduledStart: new Date(Date.now() - HOUR_MS),
      values: { deletedAt: new Date() },
    });

    expect(await rescheduleProposalsRepository.expireStaleForMeeting(meetingId, new Date())).toBe(
      0
    );
  });
});
