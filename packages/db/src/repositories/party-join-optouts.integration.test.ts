import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '../client';
import { partyJoinOptouts, auditEvents } from '../schema';
import { userFactory } from '../test/factories';
import { partyJoinOptoutsRepository } from './party-join-optouts';

/**
 * Integration tests for party-join-optouts (BAL-345). `partyId` has no FK
 * (polymorphic), so a random uuid is a valid party; `userId` is a real user.
 */

async function optoutAuditCount(): Promise<number> {
  const rows = await db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.action, 'party_join.opted_out'));
  return rows.length;
}

describe('partyJoinOptoutsRepository.optOut', () => {
  it('records a live opt-out + audit (created)', async () => {
    const user = await userFactory();
    const partyId = randomUUID();

    const result = await partyJoinOptoutsRepository.optOut({
      partyType: 'company',
      partyId,
      userId: user.id,
      actorUserId: user.id,
    });
    expect(result).toEqual({ outcome: 'created' });
    expect(await optoutAuditCount()).toBe(1);
  });

  it('is idempotent — a repeat returns already_opted_out with no double audit', async () => {
    const user = await userFactory();
    const input = {
      partyType: 'company' as const,
      partyId: randomUUID(),
      userId: user.id,
      actorUserId: user.id,
    };
    await partyJoinOptoutsRepository.optOut(input);
    const second = await partyJoinOptoutsRepository.optOut(input);
    expect(second).toEqual({ outcome: 'already_opted_out' });
    expect(await optoutAuditCount()).toBe(1);
  });
});

describe('partyJoinOptoutsRepository.exists', () => {
  it('is true only for a live opt-out', async () => {
    const user = await userFactory();
    const partyId = randomUUID();

    await expect(partyJoinOptoutsRepository.exists('company', partyId, user.id)).resolves.toBe(
      false
    );

    await partyJoinOptoutsRepository.optOut({
      partyType: 'company',
      partyId,
      userId: user.id,
      actorUserId: user.id,
    });
    await expect(partyJoinOptoutsRepository.exists('company', partyId, user.id)).resolves.toBe(
      true
    );

    // Soft-delete the opt-out → exists() must return false.
    await db
      .update(partyJoinOptouts)
      .set({ deletedAt: new Date() })
      .where(eq(partyJoinOptouts.userId, user.id));
    await expect(partyJoinOptoutsRepository.exists('company', partyId, user.id)).resolves.toBe(
      false
    );
  });
});
