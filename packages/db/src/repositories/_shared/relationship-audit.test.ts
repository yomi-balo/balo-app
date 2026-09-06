import { describe, it, expect, vi } from 'vitest';
import { recordRelationshipTransition } from './relationship-audit';
import type { DbExecutor } from './db-executor';

/**
 * BAL-540 — the ONE branch of `recordRelationshipTransition` that no integration test can
 * reach, because `advanceRelationshipStatus` validates against
 * `RELATIONSHIP_STATUS_TRANSITIONS` first and that map has NO edge into `invited`.
 *
 * The guard exists because `ACTION_BY_DESTINATION` is deliberately typed
 * `Record<Exclude<RelationshipStatus, 'invited'>, …>`: a relationship is BORN `invited` by
 * `invite()`'s insert, so an `request_expert_relationship.invited` audit action would have no
 * writer and would be exactly the dead vocabulary `_shared/meeting-audit.ts` argues against.
 * The throw is what makes the narrowing total rather than an unchecked assumption.
 */
describe('recordRelationshipTransition — the structurally-unreachable `invited` guard', () => {
  it('throws, and writes nothing, for a transition INTO invited', async () => {
    const exec = { insert: vi.fn() } as unknown as DbExecutor;

    await expect(
      recordRelationshipTransition(exec, {
        actorUserId: 'actor',
        relationshipId: 'rel-1',
        projectRequestId: 'req-1',
        from: 'eoi_submitted',
        // Unrepresentable through the real path; forced here to prove the guard.
        to: 'invited',
      })
    ).rejects.toThrow(/born invited/);

    expect(exec.insert).not.toHaveBeenCalled();
  });
});
