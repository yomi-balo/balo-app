import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '../client';
import { expressionsOfInterest } from '../schema';
import { requestExpertRelationshipFactory } from '../test/factories';
import { expressionsOfInterestRepository } from './expressions-of-interest';
import { requestExpertRelationshipsRepository } from './request-expert-relationships';

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
    const { relationship } = await requestExpertRelationshipFactory();

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
