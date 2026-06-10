import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../client';
import { expressionsOfInterest } from '../schema';
import { requestExpertRelationshipFactory } from '../test/factories';
import { expressionsOfInterestRepository } from './expressions-of-interest';
import {
  InvalidRelationshipTransitionError,
  requestExpertRelationshipsRepository,
} from './request-expert-relationships';

describe('expressionsOfInterestRepository.submit', () => {
  it('inserts the EOI and advances the relationship invited→eoi_submitted atomically', async () => {
    const { relationship, projectRequestId, expertProfileId } =
      await requestExpertRelationshipFactory();

    const eoi = await expressionsOfInterestRepository.submit({
      relationshipId: relationship.id,
      message: '<p>I have built this exact flow three times.</p>',
    });

    expect(eoi.relationshipId).toBe(relationship.id);
    // Denormalised ids are read from the relationship, not the caller.
    expect(eoi.projectRequestId).toBe(projectRequestId);
    expect(eoi.expertProfileId).toBe(expertProfileId);
    expect(eoi.submittedAt).toBeInstanceOf(Date);

    const reloaded = await requestExpertRelationshipsRepository.findById(relationship.id);
    expect(reloaded?.status).toBe('eoi_submitted');
  });

  it('rolls back (no orphan EOI) when the relationship is not in invited', async () => {
    const { relationship } = await requestExpertRelationshipFactory({
      values: { status: 'eoi_submitted' },
    });

    await expect(
      expressionsOfInterestRepository.submit({
        relationshipId: relationship.id,
        message: '<p>Should fail — already past invited.</p>',
      })
    ).rejects.toThrow();

    const rows = await db
      .select()
      .from(expressionsOfInterest)
      .where(eq(expressionsOfInterest.relationshipId, relationship.id));
    expect(rows).toHaveLength(0);
  });

  it('rejects a second EOI for the same relationship — unique index, and does not re-advance', async () => {
    const { relationship, projectRequestId, expertProfileId } =
      await requestExpertRelationshipFactory();

    await expressionsOfInterestRepository.submit({
      relationshipId: relationship.id,
      message: '<p>First pitch.</p>',
    });

    // Relationship is now eoi_submitted, so the transition guard (expectedFrom
    // invited) rejects the second submit before the unique index even fires.
    await expect(
      expressionsOfInterestRepository.submit({
        relationshipId: relationship.id,
        message: '<p>Second pitch.</p>',
      })
    ).rejects.toThrow();

    // The (now PARTIAL) unique index `expression_of_interest_relationship_idx`
    // still rejects a second LIVE EOI at the DB level — a raw insert of a second
    // live row hits the unique constraint. Wrapped in db.transaction() so the
    // violation aborts a SAVEPOINT, not the per-test wrapping transaction —
    // the row-count assertion below still needs a usable transaction.
    await expect(
      db.transaction(async (tx) => {
        await tx.insert(expressionsOfInterest).values({
          relationshipId: relationship.id,
          projectRequestId,
          expertProfileId,
          message: '<p>Second live — must be rejected by the partial unique index.</p>',
        });
      })
    ).rejects.toThrow();

    const rows = await db
      .select()
      .from(expressionsOfInterest)
      .where(eq(expressionsOfInterest.relationshipId, relationship.id));
    expect(rows).toHaveLength(1);
  });

  it('throws for an unknown relationship id', async () => {
    await expect(
      expressionsOfInterestRepository.submit({
        relationshipId: randomUUID(),
        message: '<p>No such relationship.</p>',
      })
    ).rejects.toThrow();
  });
});

describe('expressionsOfInterestRepository.findByRelationship', () => {
  it('returns the live EOI for a relationship', async () => {
    const { relationship } = await requestExpertRelationshipFactory();
    const eoi = await expressionsOfInterestRepository.submit({
      relationshipId: relationship.id,
      message: '<p>Pitch.</p>',
    });

    const found = await expressionsOfInterestRepository.findByRelationship(relationship.id);
    expect(found?.id).toBe(eoi.id);
  });

  it('excludes a soft-deleted EOI', async () => {
    const { relationship } = await requestExpertRelationshipFactory();
    const eoi = await expressionsOfInterestRepository.submit({
      relationshipId: relationship.id,
      message: '<p>Pitch.</p>',
    });
    await db
      .update(expressionsOfInterest)
      .set({ deletedAt: new Date() })
      .where(eq(expressionsOfInterest.id, eoi.id));

    const found = await expressionsOfInterestRepository.findByRelationship(relationship.id);
    expect(found).toBeUndefined();
  });
});

describe('expressionsOfInterestRepository.withdraw', () => {
  it('soft-deletes the live EOI → findByRelationship returns undefined', async () => {
    const { relationship } = await requestExpertRelationshipFactory();
    const eoi = await expressionsOfInterestRepository.submit({
      relationshipId: relationship.id,
      message: '<p>Pitch to withdraw.</p>',
    });

    const removed = await expressionsOfInterestRepository.withdraw({
      relationshipId: relationship.id,
    });

    expect(removed?.id).toBe(eoi.id);
    expect(removed?.deletedAt).toBeInstanceOf(Date);

    // No live EOI remains.
    const found = await expressionsOfInterestRepository.findByRelationship(relationship.id);
    expect(found).toBeUndefined();

    // The row still exists (soft-delete, not hard-delete).
    const [persisted] = await db
      .select()
      .from(expressionsOfInterest)
      .where(eq(expressionsOfInterest.id, eoi.id));
    expect(persisted?.deletedAt).toBeInstanceOf(Date);
  });

  it('is idempotent — a second withdraw returns undefined (no live EOI left)', async () => {
    const { relationship } = await requestExpertRelationshipFactory();
    await expressionsOfInterestRepository.submit({
      relationshipId: relationship.id,
      message: '<p>Pitch.</p>',
    });

    const first = await expressionsOfInterestRepository.withdraw({
      relationshipId: relationship.id,
    });
    expect(first).toBeDefined();

    const second = await expressionsOfInterestRepository.withdraw({
      relationshipId: relationship.id,
    });
    expect(second).toBeUndefined();
  });

  it('returns undefined when the relationship has no live EOI', async () => {
    const { relationship } = await requestExpertRelationshipFactory();

    const removed = await expressionsOfInterestRepository.withdraw({
      relationshipId: relationship.id,
    });
    expect(removed).toBeUndefined();
  });
});

describe('expressionsOfInterestRepository.resubmit', () => {
  it('inserts a fresh live EOI after a withdraw (the partial index frees the slot)', async () => {
    const { relationship, projectRequestId, expertProfileId } =
      await requestExpertRelationshipFactory();

    // Submit, then withdraw — the relationship stays `eoi_submitted`.
    const first = await expressionsOfInterestRepository.submit({
      relationshipId: relationship.id,
      message: '<p>Original pitch.</p>',
    });
    await expressionsOfInterestRepository.withdraw({ relationshipId: relationship.id });

    // Resubmit succeeds (the soft-deleted row is outside the partial unique index).
    const resubmitted = await expressionsOfInterestRepository.resubmit({
      relationshipId: relationship.id,
      message: '<p>Revised, sharper pitch.</p>',
    });

    expect(resubmitted.id).not.toBe(first.id);
    expect(resubmitted.relationshipId).toBe(relationship.id);
    // Denormalised ids are derived from the locked relationship, not the caller.
    expect(resubmitted.projectRequestId).toBe(projectRequestId);
    expect(resubmitted.expertProfileId).toBe(expertProfileId);
    expect(resubmitted.message).toBe('<p>Revised, sharper pitch.</p>');

    // Exactly one LIVE EOI now exists for the relationship (the fresh one).
    const live = await db
      .select()
      .from(expressionsOfInterest)
      .where(
        and(
          eq(expressionsOfInterest.relationshipId, relationship.id),
          isNull(expressionsOfInterest.deletedAt)
        )
      );
    expect(live).toHaveLength(1);
    expect(live[0]?.id).toBe(resubmitted.id);

    // The relationship status is UNCHANGED — resubmit never re-advances it.
    const reloaded = await requestExpertRelationshipsRepository.findById(relationship.id);
    expect(reloaded?.status).toBe('eoi_submitted');

    // findByRelationship surfaces the fresh live EOI.
    const found = await expressionsOfInterestRepository.findByRelationship(relationship.id);
    expect(found?.id).toBe(resubmitted.id);
  });

  it('rejects when the relationship is not eoi_submitted (still invited)', async () => {
    // A fresh `invited` relationship — resubmit is only valid post-submit.
    const { relationship } = await requestExpertRelationshipFactory();

    await expect(
      expressionsOfInterestRepository.resubmit({
        relationshipId: relationship.id,
        message: '<p>Cannot resubmit before a first submit.</p>',
      })
    ).rejects.toBeInstanceOf(InvalidRelationshipTransitionError);

    // No EOI was inserted.
    const rows = await db
      .select()
      .from(expressionsOfInterest)
      .where(eq(expressionsOfInterest.relationshipId, relationship.id));
    expect(rows).toHaveLength(0);
  });

  it('rejects when a live EOI already exists (no double-submit) and inserts nothing', async () => {
    const { relationship } = await requestExpertRelationshipFactory();
    await expressionsOfInterestRepository.submit({
      relationshipId: relationship.id,
      message: '<p>First (still live).</p>',
    });

    // Relationship is `eoi_submitted` AND a live EOI exists → resubmit must reject.
    await expect(
      expressionsOfInterestRepository.resubmit({
        relationshipId: relationship.id,
        message: '<p>Should be rejected — a live EOI already exists.</p>',
      })
    ).rejects.toThrow();

    // Still exactly one (the original) EOI.
    const rows = await db
      .select()
      .from(expressionsOfInterest)
      .where(eq(expressionsOfInterest.relationshipId, relationship.id));
    expect(rows).toHaveLength(1);
  });

  it('throws for an unknown relationship id', async () => {
    await expect(
      expressionsOfInterestRepository.resubmit({
        relationshipId: randomUUID(),
        message: '<p>No such relationship.</p>',
      })
    ).rejects.toThrow();
  });
});

describe('expressionsOfInterestRepository.listByRequest', () => {
  it('lists live EOIs for a request, oldest-submitted first', async () => {
    const request = await requestExpertRelationshipFactory();
    const projectRequestId = request.projectRequestId;

    const eoiA = await expressionsOfInterestRepository.submit({
      relationshipId: request.relationship.id,
      message: '<p>Expert A.</p>',
    });

    // A second invited expert on the SAME request.
    const second = await requestExpertRelationshipFactory({ projectRequestId });
    const eoiB = await expressionsOfInterestRepository.submit({
      relationshipId: second.relationship.id,
      message: '<p>Expert B.</p>',
    });

    const rows = await expressionsOfInterestRepository.listByRequest(projectRequestId);
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(eoiA.id);
    expect(ids).toContain(eoiB.id);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i - 1]!.submittedAt.getTime()).toBeLessThanOrEqual(
        rows[i]!.submittedAt.getTime()
      );
    }
  });
});

describe('expressions_of_interest composite-FK backstop', () => {
  it('rejects an EOI whose denormalised project_request_id diverges from the relationship', async () => {
    const { relationship, expertProfileId } = await requestExpertRelationshipFactory();
    // A different, valid project request that is NOT this relationship's.
    const { projectRequestId: otherRequestId } = await requestExpertRelationshipFactory();

    // The composite FK pins (relationship_id, project_request_id) to the relationship's own
    // pair, so a divergent raw insert is rejected even though otherRequestId is a real
    // project_requests row. Last DB action (it aborts the tx).
    await expect(
      db.insert(expressionsOfInterest).values({
        relationshipId: relationship.id,
        projectRequestId: otherRequestId,
        expertProfileId,
        message: '<p>Divergent.</p>',
      })
    ).rejects.toThrow();
  });
});
