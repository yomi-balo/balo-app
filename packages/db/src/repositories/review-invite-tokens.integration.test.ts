import { describe, it, expect } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '../client';
import { auditEvents, reviewInviteTokens } from '../schema';
import type { AuditEvent } from '../schema';
import { engagementFactory, reviewInviteTokenFactory, userFactory } from '../test/factories';
import { reviewInviteTokensRepository } from './review-invite-tokens';

const DAY_MS = 86_400_000;

/** Mint a raw token exactly as a production caller does, and hash it the same way. */
function mintToken(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString('base64url');
  return { raw, hash: createHash('sha256').update(raw).digest('hex') };
}

/** All audit rows for one token entity id. */
async function auditRowsFor(entityId: string): Promise<AuditEvent[]> {
  return db
    .select()
    .from(auditEvents)
    .where(
      and(eq(auditEvents.entityType, 'review_invite_token'), eq(auditEvents.entityId, entityId))
    );
}

describe('reviewInviteTokensRepository.create', () => {
  it('persists only the HASH and round-trips through findLiveByTokenHash', async () => {
    const engagement = await engagementFactory();
    const reviewer = await userFactory();
    const { raw, hash } = mintToken();

    const token = await reviewInviteTokensRepository.create({
      engagementId: engagement.engagement.id,
      reviewerUserId: reviewer.id,
      tokenHash: hash,
    });

    expect(token.engagementId).toBe(engagement.engagement.id);
    expect(token.reviewerUserId).toBe(reviewer.id);
    // The RAW token is never persisted, in any column.
    expect(token.tokenHash).toBe(hash);
    expect(token.tokenHash).not.toBe(raw);
    expect(token.tokenHash).toHaveLength(64);
    expect(token.revokedAt).toBeNull();
    expect(token.lastAccessedAt).toBeNull();
    expect(token.accessCount).toBe(0);

    const found = await reviewInviteTokensRepository.findLiveByTokenHash(hash);
    expect(found?.id).toBe(token.id);
  });

  it('applies the 30-day DB interval default when no expiry is supplied', async () => {
    const engagement = await engagementFactory();
    const reviewer = await userFactory();
    const { hash } = mintToken();

    const token = await reviewInviteTokensRepository.create({
      engagementId: engagement.engagement.id,
      reviewerUserId: reviewer.id,
      tokenHash: hash,
    });

    const daysOut = (token.expiresAt.getTime() - Date.now()) / DAY_MS;
    expect(daysOut).toBeGreaterThan(29.9);
    expect(daysOut).toBeLessThan(30.1);
  });

  it('honours an explicit expiry', async () => {
    const engagement = await engagementFactory();
    const reviewer = await userFactory();
    const { hash } = mintToken();
    const expiresAt = new Date(Date.now() + 3 * DAY_MS);

    const token = await reviewInviteTokensRepository.create({
      engagementId: engagement.engagement.id,
      reviewerUserId: reviewer.id,
      tokenHash: hash,
      expiresAt,
    });

    expect(token.expiresAt.getTime()).toBe(expiresAt.getTime());
  });

  it('records exactly one system-actor audit row in the SAME transaction, carrying no secret', async () => {
    const engagement = await engagementFactory();
    const reviewer = await userFactory();
    const { raw, hash } = mintToken();

    const token = await reviewInviteTokensRepository.create({
      engagementId: engagement.engagement.id,
      reviewerUserId: reviewer.id,
      tokenHash: hash,
    });

    const audits = await auditRowsFor(token.id);
    expect(audits).toHaveLength(1);
    const [audit] = audits;
    expect(audit?.action).toBe('review_invite_token.created');
    // ADR-1030 system-actor exemption: minting is a machine act on the notification path.
    expect(audit?.actorUserId).toBeNull();
    expect(audit?.metadata).toEqual({
      engagementId: engagement.engagement.id,
      reviewerUserId: reviewer.id,
    });
    // Neither the raw token nor its hash may appear in a widely-readable audit row.
    const serialised = JSON.stringify(audit?.metadata);
    expect(serialised).not.toContain(raw);
    expect(serialised).not.toContain(hash);
  });

  it('lets UP TO THREE LIVE TOKENS coexist for one (engagement, reviewer)', async () => {
    // ⚠ THE GUARD AGAINST A FUTURE "let's make this a partial unique". The raw token is
    // unrecoverable from its hash, so each nudge MUST mint a fresh one; a one-live-token
    // rule would force revoking the prior and kill the star links in an email the client
    // may not have opened yet.
    const engagement = await engagementFactory();
    const reviewer = await userFactory();

    const first = await reviewInviteTokensRepository.create({
      engagementId: engagement.engagement.id,
      reviewerUserId: reviewer.id,
      tokenHash: mintToken().hash,
    });
    const second = await reviewInviteTokensRepository.create({
      engagementId: engagement.engagement.id,
      reviewerUserId: reviewer.id,
      tokenHash: mintToken().hash,
    });
    const third = await reviewInviteTokensRepository.create({
      engagementId: engagement.engagement.id,
      reviewerUserId: reviewer.id,
      tokenHash: mintToken().hash,
    });

    const live = await db
      .select()
      .from(reviewInviteTokens)
      .where(
        and(
          eq(reviewInviteTokens.engagementId, engagement.engagement.id),
          eq(reviewInviteTokens.reviewerUserId, reviewer.id)
        )
      );
    expect(live).toHaveLength(3);
    // Creating a new token does NOT revoke the priors.
    expect(live.every((row) => row.revokedAt === null)).toBe(true);
    expect(new Set([first.id, second.id, third.id]).size).toBe(3);
  });
});

describe('reviewInviteTokensRepository.findLiveByTokenHash', () => {
  it('resolves a live token by the hash of its raw value', async () => {
    const { token, rawToken } = await reviewInviteTokenFactory();
    const hash = createHash('sha256').update(rawToken).digest('hex');

    const found = await reviewInviteTokensRepository.findLiveByTokenHash(hash);
    expect(found?.id).toBe(token.id);
  });

  it.each([
    {
      name: 'an EXPIRED token',
      values: { expiresAt: new Date(Date.now() - 1000) },
    },
    {
      name: 'a REVOKED token',
      values: { revokedAt: new Date() },
    },
    {
      name: 'a SOFT-DELETED token',
      values: { deletedAt: new Date() },
    },
  ])('returns undefined for $name — indistinguishable from a wrong token', async ({ values }) => {
    const { rawToken } = await reviewInviteTokenFactory({ values });
    const hash = createHash('sha256').update(rawToken).digest('hex');

    await expect(reviewInviteTokensRepository.findLiveByTokenHash(hash)).resolves.toBeUndefined();
  });

  it('returns undefined for a hash that was never issued', async () => {
    await reviewInviteTokenFactory();
    await expect(
      reviewInviteTokensRepository.findLiveByTokenHash(mintToken().hash)
    ).resolves.toBeUndefined();
  });

  it('returns undefined when handed the RAW token instead of its hash', async () => {
    const { rawToken } = await reviewInviteTokenFactory();
    await expect(
      reviewInviteTokensRepository.findLiveByTokenHash(rawToken)
    ).resolves.toBeUndefined();
  });

  it('still resolves a token that expires in the future but was minted long ago', async () => {
    const { token, rawToken } = await reviewInviteTokenFactory({
      values: { expiresAt: new Date(Date.now() + DAY_MS) },
    });
    const hash = createHash('sha256').update(rawToken).digest('hex');
    await expect(reviewInviteTokensRepository.findLiveByTokenHash(hash)).resolves.toMatchObject({
      id: token.id,
    });
  });
});

describe('reviewInviteTokensRepository.recordAccess', () => {
  it('increments accessCount and stamps lastAccessedAt', async () => {
    const { token } = await reviewInviteTokenFactory();
    expect(token.accessCount).toBe(0);
    expect(token.lastAccessedAt).toBeNull();

    await reviewInviteTokensRepository.recordAccess(token.id);

    const [afterFirst] = await db
      .select()
      .from(reviewInviteTokens)
      .where(eq(reviewInviteTokens.id, token.id));
    expect(afterFirst?.accessCount).toBe(1);
    expect(afterFirst?.lastAccessedAt).toBeInstanceOf(Date);

    await reviewInviteTokensRepository.recordAccess(token.id);

    const [afterSecond] = await db
      .select()
      .from(reviewInviteTokens)
      .where(eq(reviewInviteTokens.id, token.id));
    expect(afterSecond?.accessCount).toBe(2);
  });

  it('does NOT revoke or expire the token — it stays reusable so "change my review" works', async () => {
    const { token, rawToken } = await reviewInviteTokenFactory();
    const hash = createHash('sha256').update(rawToken).digest('hex');

    await reviewInviteTokensRepository.recordAccess(token.id);

    const found = await reviewInviteTokensRepository.findLiveByTokenHash(hash);
    expect(found?.id).toBe(token.id);
    expect(found?.revokedAt).toBeNull();
  });

  it('is a silent no-op for an unknown id', async () => {
    await expect(
      reviewInviteTokensRepository.recordAccess('00000000-0000-0000-0000-000000000000')
    ).resolves.toBeUndefined();
  });
});
