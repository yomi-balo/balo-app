import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '../client';
import { proposalClauses } from '../schema';
import { proposalFactory } from '../test/factories';
import { ProposalNotDraftError } from './_shared/proposal-draft-lock';
import {
  insertClausesTx,
  listClausesByProposalTx,
  proposalClausesRepository,
  type ProposalClauseInput,
} from './proposal-clauses';

async function seedDraft(): Promise<string> {
  const { proposal } = await proposalFactory({ values: { status: 'draft' } });
  return proposal.id;
}

/** Every row for the proposal, live or removed. */
async function allRows(proposalId: string) {
  return db.select().from(proposalClauses).where(eq(proposalClauses.proposalId, proposalId));
}

const MIXED: ProposalClauseInput[] = [
  { kind: 'exclusion', body: 'Data migration.' },
  { kind: 'assumption', body: 'Admin access from day one.' },
  { kind: 'additional_term', body: 'Invoices are due in 14 days.' },
  { kind: 'exclusion', body: 'Training.' },
  { kind: 'assumption', body: 'One sandbox.' },
  { kind: 'exclusion', body: 'Support after go-live.' },
];

describe('proposalClausesRepository.setForProposal', () => {
  it('numbers each kind from 0 in array order and lists them by kind, then order', async () => {
    const proposalId = await seedDraft();

    const inserted = await proposalClausesRepository.setForProposal({
      proposalId,
      clauses: MIXED,
    });
    expect(inserted.map((c) => [c.kind, c.sortOrder])).toEqual([
      ['exclusion', 0],
      ['assumption', 0],
      ['additional_term', 0],
      ['exclusion', 1],
      ['assumption', 1],
      ['exclusion', 2],
    ]);

    const listed = await proposalClausesRepository.listByProposal(proposalId);
    expect(listed.map((c) => [c.kind, c.sortOrder, c.body])).toEqual([
      ['assumption', 0, 'Admin access from day one.'],
      ['assumption', 1, 'One sandbox.'],
      ['exclusion', 0, 'Data migration.'],
      ['exclusion', 1, 'Training.'],
      ['exclusion', 2, 'Support after go-live.'],
      ['additional_term', 0, 'Invoices are due in 14 days.'],
    ]);
  });

  it('a second call soft-deletes the first set and writes the new one', async () => {
    const proposalId = await seedDraft();
    const first = await proposalClausesRepository.setForProposal({ proposalId, clauses: MIXED });

    await proposalClausesRepository.setForProposal({
      proposalId,
      clauses: [{ kind: 'assumption', body: 'Replaced.' }],
    });

    const listed = await proposalClausesRepository.listByProposal(proposalId);
    expect(listed.map((c) => c.body)).toEqual(['Replaced.']);
    const removed = (await allRows(proposalId)).filter((row) => row.deletedAt !== null);
    expect(removed.map((row) => row.id).sort()).toEqual(first.map((row) => row.id).sort());
  });

  it('an empty input clears the set', async () => {
    const proposalId = await seedDraft();
    await proposalClausesRepository.setForProposal({ proposalId, clauses: MIXED });

    const result = await proposalClausesRepository.setForProposal({ proposalId, clauses: [] });

    expect(result).toEqual([]);
    expect(await proposalClausesRepository.listByProposal(proposalId)).toEqual([]);
    expect((await allRows(proposalId)).every((row) => row.deletedAt !== null)).toBe(true);
  });

  it('a blank body fails the CHECK (23514) and keeps the previous set', async () => {
    const proposalId = await seedDraft();
    await proposalClausesRepository.setForProposal({
      proposalId,
      clauses: [{ kind: 'exclusion', body: 'Kept.' }],
    });

    await expect(
      proposalClausesRepository.setForProposal({
        proposalId,
        clauses: [
          { kind: 'exclusion', body: 'Fine.' },
          { kind: 'assumption', body: '   ' },
        ],
      })
    ).rejects.toMatchObject({ code: '23514', constraint_name: 'proposal_clause_body_not_blank' });

    const listed = await proposalClausesRepository.listByProposal(proposalId);
    expect(listed.map((c) => c.body)).toEqual(['Kept.']);
  });

  it('refuses a submitted proposal with ProposalNotDraftError and writes nothing', async () => {
    const { proposal } = await proposalFactory();

    const err = await proposalClausesRepository
      .setForProposal({ proposalId: proposal.id, clauses: MIXED })
      .catch((error: unknown) => error);

    expect(err).toBeInstanceOf(ProposalNotDraftError);
    expect((err as ProposalNotDraftError).status).toBe('submitted');
    expect(await allRows(proposal.id)).toEqual([]);
  });

  it('refuses an unknown proposal with ProposalNotDraftError', async () => {
    const err = await proposalClausesRepository
      .setForProposal({ proposalId: randomUUID(), clauses: MIXED })
      .catch((error: unknown) => error);

    expect(err).toBeInstanceOf(ProposalNotDraftError);
    expect((err as ProposalNotDraftError).status).toBeNull();
  });
});

describe('proposalClausesRepository.listByProposal', () => {
  it('excludes removed rows and other proposals', async () => {
    const proposalId = await seedDraft();
    const otherId = await seedDraft();
    const [removed] = await proposalClausesRepository.setForProposal({
      proposalId,
      clauses: [
        { kind: 'exclusion', body: 'Removed.' },
        { kind: 'exclusion', body: 'Live.' },
      ],
    });
    if (removed === undefined) throw new Error('clause seed failed');
    await db
      .update(proposalClauses)
      .set({ deletedAt: new Date() })
      .where(eq(proposalClauses.id, removed.id));
    await proposalClausesRepository.setForProposal({
      proposalId: otherId,
      clauses: [{ kind: 'exclusion', body: 'Elsewhere.' }],
    });

    const listed = await proposalClausesRepository.listByProposal(proposalId);
    expect(listed.map((c) => c.body)).toEqual(['Live.']);
  });

  it('returns [] for a proposal with no clauses', async () => {
    expect(await proposalClausesRepository.listByProposal(await seedDraft())).toEqual([]);
  });
});

describe('insertClausesTx / listClausesByProposalTx', () => {
  it('writes onto a non-draft proposal inside a caller transaction and reads it back in order', async () => {
    const { proposal } = await proposalFactory();

    const listed = await db.transaction(async (tx) => {
      await insertClausesTx(tx, proposal.id, MIXED);
      return listClausesByProposalTx(tx, proposal.id);
    });

    expect(listed.map((c) => [c.kind, c.sortOrder])).toEqual([
      ['assumption', 0],
      ['assumption', 1],
      ['exclusion', 0],
      ['exclusion', 1],
      ['exclusion', 2],
      ['additional_term', 0],
    ]);
  });

  it('an empty input inserts nothing and returns []', async () => {
    const { proposal } = await proposalFactory();

    const inserted = await db.transaction((tx) => insertClausesTx(tx, proposal.id, []));

    expect(inserted).toEqual([]);
    expect(await allRows(proposal.id)).toEqual([]);
  });

  it('rejects a negative sort order at the CHECK (23514)', async () => {
    const { proposal } = await proposalFactory();

    await expect(
      db.transaction((tx) =>
        tx
          .insert(proposalClauses)
          .values({ proposalId: proposal.id, kind: 'assumption', sortOrder: -1, body: 'x' })
      )
    ).rejects.toMatchObject({ code: '23514', constraint_name: 'proposal_clause_sort_nonneg' });
  });
});
