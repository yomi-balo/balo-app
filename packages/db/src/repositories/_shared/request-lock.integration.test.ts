import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { db } from '../../client';
import { proposalFactory, requestExpertRelationshipFactory } from '../../test/factories';
import {
  acquireRequestLock,
  acquireRequestLockViaProposalTx,
  acquireRequestLockViaRelationshipTx,
} from './request-lock';

/**
 * ⚠ WHAT THIS FILE PROVES, AND WHAT IT DOES NOT. These run inside the standard harness's single
 * transaction on a `max: 1` pool (`test/setup-integration.ts`), so they prove the statements
 * execute and the reads resolve correctly — they prove NOTHING about serialization against a
 * second, genuinely concurrent connection. The serialization proof is
 * `request-domain-serialization.concurrency.integration.test.ts`.
 */
describe('acquireRequestLock', () => {
  it('resolves and is re-entrant — calling it twice in one transaction does not hang', async () => {
    await db.transaction(async (tx) => {
      const requestId = randomUUID();
      await acquireRequestLock(tx, requestId);
      await acquireRequestLock(tx, requestId);
    });
  });
});

describe('acquireRequestLockViaRelationshipTx', () => {
  it("returns the relationship's projectRequestId and takes the lock", async () => {
    const { relationship, projectRequestId } = await requestExpertRelationshipFactory();

    const resolved = await db.transaction((tx) =>
      acquireRequestLockViaRelationshipTx(tx, relationship.id)
    );

    expect(resolved).toBe(projectRequestId);
  });

  it('returns undefined for a missing relationship id', async () => {
    const resolved = await db.transaction((tx) =>
      acquireRequestLockViaRelationshipTx(tx, randomUUID())
    );

    expect(resolved).toBeUndefined();
  });

  it('returns undefined for a soft-deleted relationship', async () => {
    const { relationship } = await requestExpertRelationshipFactory({
      values: { deletedAt: new Date() },
    });

    const resolved = await db.transaction((tx) =>
      acquireRequestLockViaRelationshipTx(tx, relationship.id)
    );

    expect(resolved).toBeUndefined();
  });
});

describe('acquireRequestLockViaProposalTx', () => {
  it("returns the proposal's projectRequestId and takes the lock", async () => {
    const { proposal, projectRequestId } = await proposalFactory();

    const resolved = await db.transaction((tx) => acquireRequestLockViaProposalTx(tx, proposal.id));

    expect(resolved).toBe(projectRequestId);
  });

  it('returns undefined for a missing proposal id', async () => {
    const resolved = await db.transaction((tx) =>
      acquireRequestLockViaProposalTx(tx, randomUUID())
    );

    expect(resolved).toBeUndefined();
  });

  it('returns undefined for a soft-deleted proposal', async () => {
    const { proposal } = await proposalFactory({ values: { deletedAt: new Date() } });

    const resolved = await db.transaction((tx) => acquireRequestLockViaProposalTx(tx, proposal.id));

    expect(resolved).toBeUndefined();
  });
});
