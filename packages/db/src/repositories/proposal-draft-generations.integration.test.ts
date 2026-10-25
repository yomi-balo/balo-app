import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { ProposalDraftOutput } from '@balo/shared/project-requests';
import { db } from '../client';
import { proposalDraftGenerations, requestExpertRelationships } from '../schema';
import type { ProposalDraftGeneration } from '../schema';
import { expertFactory, requestExpertRelationshipFactory, userFactory } from '../test/factories';
import {
  expectCheckViolation,
  expectConstraintViolation,
} from '../test/helpers/expect-check-violation';
import { proposalDraftGenerationsRepository as repo } from './proposal-draft-generations';

/**
 * BAL-611 — `proposal_draft_generations`, the AI proposal draft's async handoff row.
 *
 * What this suite holds, beyond the happy paths:
 *
 *  1. **ONE LIVE GENERATION PER RELATIONSHIP.** `createOrGetForRelationship` is idempotent
 *     through the partial unique index, and a soft-deleted row frees the slot.
 *  2. **SCOPED READS ARE NOT-FOUNDS.** `findForRequester` misses on a wrong relationship OR a
 *     wrong user; `findForRelationshipExpert` misses unless the bearer user is both the
 *     requester and the relationship's expert, on a live relationship.
 *  3. **TERMINAL IS TERMINAL.** Both `mark*` CAS on `pending`; the second terminal write
 *     returns `undefined` and leaves the row unchanged.
 *  4. **THE THREE CHECKS REALLY REJECT.** Each probe violates exactly one constraint, inside its
 *     own SAVEPOINT (`expectCheckViolation`), so the outer per-test transaction survives
 *     (memory `reference_caught_23505_aborts_test_transaction`).
 *
 * ⚠ CONCURRENCY IS NOT EXPRESSIBLE HERE (memory `reference_db_integration_harness_no_concurrency`):
 * idempotency and the CAS are proven by SEQUENTIAL repeats, the shape a second tab or a BullMQ
 * redelivery actually produces.
 */

/** No dates anywhere in this shape (memory `reference_jsonb_date_type_lie`). */
function draftOutput(): ProposalDraftOutput {
  return {
    overviewHtml: '<p>We will rebuild your lead routing in Flow.</p>',
    milestones: [
      {
        title: 'Discovery',
        descriptionHtml: '<p>Map the current assignment rules.</p>',
        acceptanceCriteria: 'The routing map is signed off.',
      },
      {
        title: 'Build',
        descriptionHtml: '<ul><li>Flows</li><li>Queues</li></ul>',
        acceptanceCriteria: 'Every lead lands in the right queue.',
      },
    ],
  };
}

const SUCCESS_AUDIT = {
  modelId: 'claude-sonnet-5',
  promptVersion: 'v1',
  inputTokens: 1_234,
  outputTokens: 567,
} as const;

/** A relationship whose expert is a real user — the requester every scoped read keys on. */
async function seedRelationship(): Promise<{ relationshipId: string; expertUserId: string }> {
  const expert = await expertFactory();
  const { relationship } = await requestExpertRelationshipFactory({
    expertProfileId: expert.id,
    values: { status: 'proposal_requested' },
  });
  return { relationshipId: relationship.id, expertUserId: expert.userId };
}

async function seedPending(): Promise<{
  relationshipId: string;
  expertUserId: string;
  row: ProposalDraftGeneration;
}> {
  const { relationshipId, expertUserId } = await seedRelationship();
  const { row } = await repo.createOrGetForRelationship({
    relationshipId,
    requestedByUserId: expertUserId,
  });
  return { relationshipId, expertUserId, row };
}

async function softDelete(generationId: string): Promise<void> {
  await db
    .update(proposalDraftGenerations)
    .set({ deletedAt: new Date() })
    .where(eq(proposalDraftGenerations.id, generationId));
}

describe('createOrGetForRelationship', () => {
  it('opens a pending row with no outcome', async () => {
    const { relationshipId, expertUserId } = await seedRelationship();

    const { row, created } = await repo.createOrGetForRelationship({
      relationshipId,
      requestedByUserId: expertUserId,
    });

    expect(created).toBe(true);
    expect(row).toMatchObject({
      relationshipId,
      requestedByUserId: expertUserId,
      status: 'pending',
      output: null,
      failureReason: null,
      completedAt: null,
      modelId: null,
      promptVersion: null,
      inputTokens: null,
      outputTokens: null,
      deletedAt: null,
    });
  });

  it('returns the live row unchanged on a second call — one generation per relationship', async () => {
    const { relationshipId, expertUserId, row: first } = await seedPending();
    const otherUser = await userFactory();

    const second = await repo.createOrGetForRelationship({
      relationshipId,
      requestedByUserId: otherUser.id,
    });

    expect(second.created).toBe(false);
    expect(second.row.id).toBe(first.id);
    expect(second.row.requestedByUserId).toBe(expertUserId);
    expect(second.row.updatedAt).toEqual(first.updatedAt);
    expect(
      await repo.countCreatedSince({ requestedByUserId: otherUser.id, since: new Date(0) })
    ).toBe(0);
  });

  it('returns a terminal row rather than opening a second generation', async () => {
    const { relationshipId, expertUserId, row } = await seedPending();
    await repo.markFailed({ generationId: row.id, failureReason: 'enqueue_failed' });

    const again = await repo.createOrGetForRelationship({
      relationshipId,
      requestedByUserId: expertUserId,
    });

    expect(again.created).toBe(false);
    expect(again.row).toMatchObject({ id: row.id, status: 'failed' });
  });

  it('opens a new row once the live one is soft-deleted', async () => {
    const { relationshipId, expertUserId, row: first } = await seedPending();
    await softDelete(first.id);

    const next = await repo.createOrGetForRelationship({
      relationshipId,
      requestedByUserId: expertUserId,
    });

    expect(next.created).toBe(true);
    expect(next.row.id).not.toBe(first.id);
    expect(next.row.status).toBe('pending');
  });

  it('is backed by the partial unique index, not only by the upsert', async () => {
    const { relationshipId, expertUserId } = await seedPending();

    await expectConstraintViolation(
      '23505',
      (tx) =>
        tx
          .insert(proposalDraftGenerations)
          .values({ relationshipId, requestedByUserId: expertUserId }),
      'proposal_draft_generations_relationship_live_idx'
    );
  });

  it('rejects an unknown relationship (FK)', async () => {
    const user = await userFactory();

    await expectConstraintViolation(
      '23503',
      (tx) =>
        tx
          .insert(proposalDraftGenerations)
          .values({ relationshipId: randomUUID(), requestedByUserId: user.id }),
      'proposal_draft_generations_relationship_fk'
    );
  });

  it('cascades away with its relationship', async () => {
    const { relationshipId, row } = await seedPending();

    await db
      .delete(requestExpertRelationships)
      .where(eq(requestExpertRelationships.id, relationshipId));

    const [gone] = await db
      .select()
      .from(proposalDraftGenerations)
      .where(eq(proposalDraftGenerations.id, row.id));
    expect(gone).toBeUndefined();
  });
});

describe('findLiveByRelationship', () => {
  it('returns the live row', async () => {
    const { relationshipId, row } = await seedPending();

    expect(await repo.findLiveByRelationship(relationshipId)).toEqual(row);
  });

  it('misses a relationship with no generation', async () => {
    const { relationshipId } = await seedRelationship();

    expect(await repo.findLiveByRelationship(relationshipId)).toBeUndefined();
  });

  it('misses a soft-deleted row', async () => {
    const { relationshipId, row } = await seedPending();
    await softDelete(row.id);

    expect(await repo.findLiveByRelationship(relationshipId)).toBeUndefined();
  });
});

describe('findForRequester — the web poll read', () => {
  it('returns the row for its requester on its relationship', async () => {
    const { relationshipId, expertUserId, row } = await seedPending();

    const found = await repo.findForRequester({
      generationId: row.id,
      relationshipId,
      requestedByUserId: expertUserId,
    });

    expect(found?.id).toBe(row.id);
  });

  it('misses on a different relationship', async () => {
    const { expertUserId, row } = await seedPending();
    const { relationshipId: otherRelationshipId } = await seedRelationship();

    expect(
      await repo.findForRequester({
        generationId: row.id,
        relationshipId: otherRelationshipId,
        requestedByUserId: expertUserId,
      })
    ).toBeUndefined();
  });

  it('misses for a different user', async () => {
    const { relationshipId, row } = await seedPending();
    const stranger = await userFactory();

    expect(
      await repo.findForRequester({
        generationId: row.id,
        relationshipId,
        requestedByUserId: stranger.id,
      })
    ).toBeUndefined();
  });

  it('misses a soft-deleted row', async () => {
    const { relationshipId, expertUserId, row } = await seedPending();
    await softDelete(row.id);

    expect(
      await repo.findForRequester({
        generationId: row.id,
        relationshipId,
        requestedByUserId: expertUserId,
      })
    ).toBeUndefined();
  });
});

describe('findForRelationshipExpert — the api re-check', () => {
  it("returns the row when the user is the requester and the relationship's expert", async () => {
    const { expertUserId, row } = await seedPending();

    const found = await repo.findForRelationshipExpert({
      generationId: row.id,
      userId: expertUserId,
    });

    expect(found).toEqual(row);
  });

  it('misses for a user who is neither', async () => {
    const { row } = await seedPending();
    const stranger = await userFactory();

    expect(
      await repo.findForRelationshipExpert({ generationId: row.id, userId: stranger.id })
    ).toBeUndefined();
  });

  it("misses when the requester is not the relationship's expert", async () => {
    const { relationshipId } = await seedRelationship();
    const nonExpert = await userFactory();
    const { row } = await repo.createOrGetForRelationship({
      relationshipId,
      requestedByUserId: nonExpert.id,
    });

    expect(
      await repo.findForRelationshipExpert({ generationId: row.id, userId: nonExpert.id })
    ).toBeUndefined();
  });

  it("misses for the relationship's expert when someone else requested it", async () => {
    const { relationshipId, expertUserId } = await seedRelationship();
    const otherUser = await userFactory();
    const { row } = await repo.createOrGetForRelationship({
      relationshipId,
      requestedByUserId: otherUser.id,
    });

    expect(
      await repo.findForRelationshipExpert({ generationId: row.id, userId: expertUserId })
    ).toBeUndefined();
  });

  it('misses when the relationship is soft-deleted', async () => {
    const { relationshipId, expertUserId, row } = await seedPending();
    await db
      .update(requestExpertRelationships)
      .set({ deletedAt: new Date() })
      .where(eq(requestExpertRelationships.id, relationshipId));

    expect(
      await repo.findForRelationshipExpert({ generationId: row.id, userId: expertUserId })
    ).toBeUndefined();
  });

  it('misses a soft-deleted generation', async () => {
    const { expertUserId, row } = await seedPending();
    await softDelete(row.id);

    expect(
      await repo.findForRelationshipExpert({ generationId: row.id, userId: expertUserId })
    ).toBeUndefined();
  });
});

describe('findById — the worker read', () => {
  it('returns the row', async () => {
    const { row } = await seedPending();

    expect(await repo.findById(row.id)).toEqual(row);
  });

  it('misses an unknown id and a soft-deleted row', async () => {
    const { row } = await seedPending();
    await softDelete(row.id);

    expect(await repo.findById(randomUUID())).toBeUndefined();
    expect(await repo.findById(row.id)).toBeUndefined();
  });
});

describe('markSucceeded', () => {
  it('stores the output and provenance and completes the row', async () => {
    const { row } = await seedPending();
    const output = draftOutput();

    const updated = await repo.markSucceeded({ generationId: row.id, output, ...SUCCESS_AUDIT });

    expect(updated).toMatchObject({
      id: row.id,
      status: 'succeeded',
      failureReason: null,
      ...SUCCESS_AUDIT,
    });
    expect(updated?.completedAt).toBeInstanceOf(Date);
    expect((await repo.findById(row.id))?.output).toEqual(output);
  });

  it('accepts unreported token usage', async () => {
    const { row } = await seedPending();

    const updated = await repo.markSucceeded({
      generationId: row.id,
      output: draftOutput(),
      modelId: 'claude-sonnet-5',
      promptVersion: 'v1',
      inputTokens: null,
      outputTokens: null,
    });

    expect(updated).toMatchObject({ status: 'succeeded', inputTokens: null, outputTokens: null });
  });

  it('loses the CAS on an already-terminal row and leaves it unchanged', async () => {
    const { row } = await seedPending();
    const first = await repo.markSucceeded({
      generationId: row.id,
      output: draftOutput(),
      ...SUCCESS_AUDIT,
    });

    const redelivered = await repo.markSucceeded({
      generationId: row.id,
      output: { overviewHtml: '<p>Other</p>', milestones: [] },
      ...SUCCESS_AUDIT,
    });
    const lateFailure = await repo.markFailed({ generationId: row.id, failureReason: 'unknown' });

    expect(redelivered).toBeUndefined();
    expect(lateFailure).toBeUndefined();
    expect(await repo.findById(row.id)).toEqual(first);
  });

  it('does not complete a soft-deleted row', async () => {
    const { row } = await seedPending();
    await softDelete(row.id);

    expect(
      await repo.markSucceeded({ generationId: row.id, output: draftOutput(), ...SUCCESS_AUDIT })
    ).toBeUndefined();
  });
});

describe('markFailed', () => {
  it('stores the reason and completes the row with no provenance', async () => {
    const { row } = await seedPending();

    const updated = await repo.markFailed({
      generationId: row.id,
      failureReason: 'enqueue_failed',
    });

    expect(updated).toMatchObject({
      id: row.id,
      status: 'failed',
      failureReason: 'enqueue_failed',
      output: null,
      modelId: null,
    });
    expect(updated?.completedAt).toBeInstanceOf(Date);
  });

  it('loses the CAS on an already-failed row, so a late success cannot overwrite it', async () => {
    const { row } = await seedPending();
    const first = await repo.markFailed({ generationId: row.id, failureReason: 'truncated' });

    const lateSuccess = await repo.markSucceeded({
      generationId: row.id,
      output: draftOutput(),
      ...SUCCESS_AUDIT,
    });
    const redelivered = await repo.markFailed({ generationId: row.id, failureReason: 'unknown' });

    expect(lateSuccess).toBeUndefined();
    expect(redelivered).toBeUndefined();
    expect(await repo.findById(row.id)).toEqual(first);
  });

  it('misses an unknown id', async () => {
    expect(
      await repo.markFailed({ generationId: randomUUID(), failureReason: 'unknown' })
    ).toBeUndefined();
  });
});

describe('countCreatedSince', () => {
  it("counts the user's live rows at or after `since`, whatever their outcome", async () => {
    const user = await userFactory();
    const a = await seedRelationship();
    const b = await seedRelationship();
    const c = await seedRelationship();
    const { row: first } = await repo.createOrGetForRelationship({
      relationshipId: a.relationshipId,
      requestedByUserId: user.id,
    });
    const { row: second } = await repo.createOrGetForRelationship({
      relationshipId: b.relationshipId,
      requestedByUserId: user.id,
    });
    await repo.markFailed({ generationId: second.id, failureReason: 'invalid_output' });
    await repo.createOrGetForRelationship({
      relationshipId: c.relationshipId,
      requestedByUserId: c.expertUserId,
    });

    expect(
      await repo.countCreatedSince({ requestedByUserId: user.id, since: first.createdAt })
    ).toBe(2);
  });

  it('includes a row created exactly at `since` and excludes one before it', async () => {
    const { expertUserId, row } = await seedPending();

    expect(
      await repo.countCreatedSince({ requestedByUserId: expertUserId, since: row.createdAt })
    ).toBe(1);
    expect(
      await repo.countCreatedSince({
        requestedByUserId: expertUserId,
        since: new Date(row.createdAt.getTime() + 1),
      })
    ).toBe(0);
  });

  it('excludes a row older than the window', async () => {
    const { expertUserId, row } = await seedPending();
    const since = new Date(row.createdAt.getTime() - 60 * 60 * 1000);
    await db
      .update(proposalDraftGenerations)
      .set({ createdAt: new Date(since.getTime() - 1) })
      .where(eq(proposalDraftGenerations.id, row.id));

    expect(await repo.countCreatedSince({ requestedByUserId: expertUserId, since })).toBe(0);
  });

  it('excludes a soft-deleted row', async () => {
    const { expertUserId, row } = await seedPending();
    await softDelete(row.id);

    expect(
      await repo.countCreatedSince({ requestedByUserId: expertUserId, since: new Date(0) })
    ).toBe(0);
  });
});

describe('hasSucceededForRelationship', () => {
  it('is false with no generation, and while pending', async () => {
    const { relationshipId } = await seedRelationship();
    expect(await repo.hasSucceededForRelationship(relationshipId)).toBe(false);

    const { relationshipId: pendingRelationshipId } = await seedPending();
    expect(await repo.hasSucceededForRelationship(pendingRelationshipId)).toBe(false);
  });

  it('is false for a failed generation', async () => {
    const { relationshipId, row } = await seedPending();
    await repo.markFailed({ generationId: row.id, failureReason: 'empty_output' });

    expect(await repo.hasSucceededForRelationship(relationshipId)).toBe(false);
  });

  it('is true for a succeeded generation', async () => {
    const { relationshipId, row } = await seedPending();
    await repo.markSucceeded({ generationId: row.id, output: draftOutput(), ...SUCCESS_AUDIT });

    expect(await repo.hasSucceededForRelationship(relationshipId)).toBe(true);
  });

  it('is false once the succeeded generation is soft-deleted', async () => {
    const { relationshipId, row } = await seedPending();
    await repo.markSucceeded({ generationId: row.id, output: draftOutput(), ...SUCCESS_AUDIT });
    await softDelete(row.id);

    expect(await repo.hasSucceededForRelationship(relationshipId)).toBe(false);
  });
});

describe('CHECK constraints', () => {
  it('refuses succeeded without an output', async () => {
    const { row } = await seedPending();

    await expectCheckViolation(
      sql`UPDATE proposal_draft_generations SET status = 'succeeded', completed_at = now() WHERE id = ${row.id}`,
      'proposal_draft_generations_output_iff_succeeded'
    );
  });

  it('refuses an output on a pending row', async () => {
    const { row } = await seedPending();

    await expectCheckViolation(
      sql`UPDATE proposal_draft_generations SET output = '{}'::jsonb WHERE id = ${row.id}`,
      'proposal_draft_generations_output_iff_succeeded'
    );
  });

  it('refuses failed without a reason', async () => {
    const { row } = await seedPending();

    await expectCheckViolation(
      sql`UPDATE proposal_draft_generations SET status = 'failed', completed_at = now() WHERE id = ${row.id}`,
      'proposal_draft_generations_reason_iff_failed'
    );
  });

  it('refuses a terminal status without completed_at', async () => {
    const { row } = await seedPending();

    await expectCheckViolation(
      sql`UPDATE proposal_draft_generations SET status = 'failed', failure_reason = 'unknown' WHERE id = ${row.id}`,
      'proposal_draft_generations_completed_iff_terminal'
    );
  });

  it('refuses completed_at on a pending row', async () => {
    const { row } = await seedPending();

    await expectCheckViolation(
      sql`UPDATE proposal_draft_generations SET completed_at = now() WHERE id = ${row.id}`,
      'proposal_draft_generations_completed_iff_terminal'
    );
  });
});
