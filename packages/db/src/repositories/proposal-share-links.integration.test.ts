import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '../client';
import { auditEvents, proposalShareLinks } from '../schema';
import type { AuditEvent } from '../schema';
import {
  userFactory,
  requestExpertRelationshipFactory,
  proposalShareLinkFactory,
} from '../test/factories';
import { proposalShareLinksRepository } from './proposal-share-links';

const tokenHash = (): string => randomBytes(32).toString('hex');

/** All audit rows for one share-link entity id (append-only ledger). */
async function auditRowsFor(entityId: string): Promise<AuditEvent[]> {
  return db
    .select()
    .from(auditEvents)
    .where(
      and(eq(auditEvents.entityType, 'proposal_share_link'), eq(auditEvents.entityId, entityId))
    );
}

describe('proposalShareLinksRepository.create', () => {
  it('inserts a fresh link and records exactly one .created audit row', async () => {
    const rel = await requestExpertRelationshipFactory({
      values: { status: 'proposal_submitted' },
    });
    const sharer = await userFactory();

    const { link, revokedPriorId } = await proposalShareLinksRepository.create({
      relationshipId: rel.relationship.id,
      recipientEmail: 'colleague@example.com',
      tokenHash: tokenHash(),
      note: 'Take a look at this proposal',
      createdByUserId: sharer.id,
    });

    expect(revokedPriorId).toBeNull();
    expect(link.id).toBeDefined();
    expect(link.relationshipId).toBe(rel.relationship.id);
    expect(link.recipientEmail).toBe('colleague@example.com');
    expect(link.note).toBe('Take a look at this proposal');
    expect(link.createdByUserId).toBe(sharer.id);
    expect(link.revokedAt).toBeNull();
    expect(link.revokedByUserId).toBeNull();
    expect(link.accessCount).toBe(0);
    expect(link.lastAccessedAt).toBeNull();
    // DB interval default → ~30 days out.
    expect(link.expiresAt).toBeInstanceOf(Date);
    expect(link.expiresAt.getTime()).toBeGreaterThan(Date.now());

    const audits = await auditRowsFor(link.id);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.action).toBe('proposal_share_link.created');
    expect(audits[0]?.actorUserId).toBe(sharer.id);
  });

  it('honours an explicit expiresAt override', async () => {
    const rel = await requestExpertRelationshipFactory({
      values: { status: 'proposal_submitted' },
    });
    const sharer = await userFactory();
    const expiresAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);

    const { link } = await proposalShareLinksRepository.create({
      relationshipId: rel.relationship.id,
      recipientEmail: 'colleague@example.com',
      tokenHash: tokenHash(),
      note: null,
      createdByUserId: sharer.id,
      expiresAt,
    });

    expect(link.expiresAt.getTime()).toBeCloseTo(expiresAt.getTime(), -3);
  });

  it('reshare: revokes the prior live link and records BOTH .revoked (superseded) + .created in one tx, no partial-unique collision', async () => {
    const rel = await requestExpertRelationshipFactory({
      values: { status: 'proposal_submitted' },
    });
    const sharer = await userFactory();

    const first = await proposalShareLinksRepository.create({
      relationshipId: rel.relationship.id,
      recipientEmail: 'colleague@example.com',
      tokenHash: tokenHash(),
      note: null,
      createdByUserId: sharer.id,
    });

    // Same (relationship, recipient) — mixed case to prove lower() matching.
    const second = await proposalShareLinksRepository.create({
      relationshipId: rel.relationship.id,
      recipientEmail: 'Colleague@Example.com',
      tokenHash: tokenHash(),
      note: null,
      createdByUserId: sharer.id,
    });

    expect(second.revokedPriorId).toBe(first.link.id);
    expect(second.link.id).not.toBe(first.link.id);

    // The prior link is now revoked.
    const [prior] = await db
      .select()
      .from(proposalShareLinks)
      .where(eq(proposalShareLinks.id, first.link.id));
    expect(prior?.revokedAt).toBeInstanceOf(Date);
    expect(prior?.revokedByUserId).toBe(sharer.id);

    // Prior entity has both a .created (from first mint) and a .revoked (superseded).
    const priorAudits = await auditRowsFor(first.link.id);
    const priorActions = priorAudits.map((a) => a.action).sort();
    expect(priorActions).toEqual(['proposal_share_link.created', 'proposal_share_link.revoked']);
    const revokedRow = priorAudits.find((a) => a.action === 'proposal_share_link.revoked');
    expect(revokedRow?.metadata).toMatchObject({ reason: 'superseded_by_reshare' });

    // The new link has just its .created row.
    const newAudits = await auditRowsFor(second.link.id);
    expect(newAudits.map((a) => a.action)).toEqual(['proposal_share_link.created']);

    // Exactly one LIVE link for the relationship (the new one).
    const live = await proposalShareLinksRepository.listActiveByRelationship(rel.relationship.id);
    expect(live).toHaveLength(1);
    expect(live[0]?.id).toBe(second.link.id);
  });
});

describe('proposalShareLinksRepository.findLiveByTokenHash', () => {
  it('returns a live link', async () => {
    const hash = tokenHash();
    const { link } = await proposalShareLinkFactory({ values: { tokenHash: hash } });

    const found = await proposalShareLinksRepository.findLiveByTokenHash(hash);
    expect(found?.id).toBe(link.id);
  });

  it('returns undefined for a wrong token hash', async () => {
    await proposalShareLinkFactory();
    const found = await proposalShareLinksRepository.findLiveByTokenHash(tokenHash());
    expect(found).toBeUndefined();
  });

  it('returns undefined for an expired link', async () => {
    const hash = tokenHash();
    await proposalShareLinkFactory({
      values: { tokenHash: hash, expiresAt: new Date(Date.now() - 60_000) },
    });
    const found = await proposalShareLinksRepository.findLiveByTokenHash(hash);
    expect(found).toBeUndefined();
  });

  it('returns undefined for a revoked link', async () => {
    const hash = tokenHash();
    await proposalShareLinkFactory({ values: { tokenHash: hash, revokedAt: new Date() } });
    const found = await proposalShareLinksRepository.findLiveByTokenHash(hash);
    expect(found).toBeUndefined();
  });

  it('returns undefined for a soft-deleted link', async () => {
    const hash = tokenHash();
    await proposalShareLinkFactory({ values: { tokenHash: hash, deletedAt: new Date() } });
    const found = await proposalShareLinksRepository.findLiveByTokenHash(hash);
    expect(found).toBeUndefined();
  });
});

describe('proposalShareLinksRepository.recordAccess', () => {
  it('increments access_count and stamps last_accessed_at', async () => {
    const { link } = await proposalShareLinkFactory();
    expect(link.accessCount).toBe(0);
    expect(link.lastAccessedAt).toBeNull();

    await proposalShareLinksRepository.recordAccess(link.id);
    await proposalShareLinksRepository.recordAccess(link.id);

    const [after] = await db
      .select()
      .from(proposalShareLinks)
      .where(eq(proposalShareLinks.id, link.id));
    expect(after?.accessCount).toBe(2);
    expect(after?.lastAccessedAt).toBeInstanceOf(Date);
  });
});

describe('proposalShareLinksRepository.listActiveByRelationship', () => {
  it('excludes revoked and soft-deleted links and orders newest first', async () => {
    const rel = await requestExpertRelationshipFactory({
      values: { status: 'proposal_submitted' },
    });

    const older = await proposalShareLinkFactory({
      relationship: rel,
      values: {
        recipientEmail: 'a@example.com',
        tokenHash: tokenHash(),
        createdAt: new Date(Date.now() - 60_000),
      },
    });
    const newer = await proposalShareLinkFactory({
      relationship: rel,
      values: { recipientEmail: 'b@example.com', tokenHash: tokenHash() },
    });
    // Revoked + soft-deleted rows must be excluded.
    await proposalShareLinkFactory({
      relationship: rel,
      values: { recipientEmail: 'c@example.com', tokenHash: tokenHash(), revokedAt: new Date() },
    });
    await proposalShareLinkFactory({
      relationship: rel,
      values: { recipientEmail: 'd@example.com', tokenHash: tokenHash(), deletedAt: new Date() },
    });

    const live = await proposalShareLinksRepository.listActiveByRelationship(rel.relationship.id);
    expect(live.map((l) => l.id)).toEqual([newer.link.id, older.link.id]);
  });
});

describe('proposalShareLinksRepository.revoke', () => {
  it('revokes a live link, records one .revoked (manual) audit row, and is idempotent on the second call', async () => {
    const rel = await requestExpertRelationshipFactory({
      values: { status: 'proposal_submitted' },
    });
    const { link } = await proposalShareLinkFactory({ relationship: rel });
    const actor = await userFactory();

    const revoked = await proposalShareLinksRepository.revoke({
      id: link.id,
      actorUserId: actor.id,
    });
    expect(revoked?.id).toBe(link.id);
    expect(revoked?.revokedAt).toBeInstanceOf(Date);
    expect(revoked?.revokedByUserId).toBe(actor.id);

    const audits = await auditRowsFor(link.id);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.action).toBe('proposal_share_link.revoked');
    expect(audits[0]?.actorUserId).toBe(actor.id);
    expect(audits[0]?.metadata).toMatchObject({
      reason: 'manual',
      relationshipId: rel.relationship.id,
    });

    // Second revoke is a no-op → undefined, and adds no further audit row.
    const again = await proposalShareLinksRepository.revoke({ id: link.id, actorUserId: actor.id });
    expect(again).toBeUndefined();
    expect(await auditRowsFor(link.id)).toHaveLength(1);
  });
});
