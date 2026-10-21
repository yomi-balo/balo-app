import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db } from '../../client';
import { proposals } from '../../schema';
import { proposalFactory } from '../../test/factories';
import { lockDraftProposalTx, ProposalNotDraftError } from './proposal-draft-lock';

/**
 * These run inside the standard harness's single transaction on a `max: 1` pool, so they
 * cannot race a second connection. The lock is proved structurally instead: a row locked
 * `FOR UPDATE` carries the locking (sub)transaction's id in `xmax`, and nothing else in
 * this helper writes the header row.
 */
async function headerXmax(proposalId: string): Promise<string> {
  const rows = (await db.execute(
    sql`SELECT xmax::text AS xmax FROM proposals WHERE id = ${proposalId}`
  )) as unknown as Array<{ xmax: string }>;
  const [row] = rows;
  if (row === undefined) throw new Error(`proposal ${proposalId} not found`);
  return row.xmax;
}

async function lockError(proposalId: string): Promise<unknown> {
  return db
    .transaction((tx) => lockDraftProposalTx(tx, proposalId))
    .catch((error: unknown) => error);
}

describe('lockDraftProposalTx', () => {
  it('returns the live draft row', async () => {
    const { proposal } = await proposalFactory({ values: { status: 'draft' } });

    const locked = await db.transaction((tx) => lockDraftProposalTx(tx, proposal.id));

    expect(locked.id).toBe(proposal.id);
    expect(locked.status).toBe('draft');
  });

  it('takes a row lock on the header (xmax is stamped by the FOR UPDATE)', async () => {
    const { proposal } = await proposalFactory({ values: { status: 'draft' } });
    expect(await headerXmax(proposal.id)).toBe('0');

    await db.transaction((tx) => lockDraftProposalTx(tx, proposal.id));

    expect(await headerXmax(proposal.id)).not.toBe('0');
  });

  it.each(['submitted', 'changes_requested'] as const)(
    'refuses a %s proposal with ProposalNotDraftError carrying that status',
    async (status) => {
      const { proposal } = await proposalFactory({ values: { status } });

      const err = await lockError(proposal.id);

      expect(err).toBeInstanceOf(ProposalNotDraftError);
      expect((err as ProposalNotDraftError).status).toBe(status);
    }
  );

  it('refuses a soft-deleted draft with a null status', async () => {
    const { proposal } = await proposalFactory({ values: { status: 'draft' } });
    await db.update(proposals).set({ deletedAt: new Date() }).where(eq(proposals.id, proposal.id));

    const err = await lockError(proposal.id);

    expect(err).toBeInstanceOf(ProposalNotDraftError);
    expect((err as ProposalNotDraftError).status).toBeNull();
  });

  it('refuses an unknown proposal id with a null status', async () => {
    const err = await lockError(randomUUID());

    expect(err).toBeInstanceOf(ProposalNotDraftError);
    expect((err as ProposalNotDraftError).status).toBeNull();
  });
});
