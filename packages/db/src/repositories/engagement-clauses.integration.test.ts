import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '../client';
import { engagementClauses, type ProposalClause } from '../schema';
import { engagementFactory, proposalFactory, userFactory } from '../test/factories';
import type { ProposalFactoryResult } from '../test/factories';
import { engagementClausesRepository, snapshotClausesFromProposalTx } from './engagement-clauses';
import { insertClausesTx } from './proposal-clauses';

const ACCEPTED_AT = new Date('2026-10-01T03:00:00.000Z');

/** An accepted proposal and a project engagement sourced from it. */
async function seedEngagementFromProposal(
  acceptedByUserId: string | null
): Promise<{ engagementId: string; source: ProposalFactoryResult }> {
  const source = await proposalFactory({
    values: { status: 'accepted', acceptedAt: ACCEPTED_AT, acceptedByUserId },
  });
  const { engagement } = await engagementFactory({
    projectValues: {
      sourceProposalId: source.proposal.id,
      relationshipId: source.relationshipId,
      projectRequestId: source.projectRequestId,
    },
  });
  return { engagementId: engagement.id, source };
}

async function seedProposalClauses(proposalId: string): Promise<ProposalClause[]> {
  return db.transaction((tx) =>
    insertClausesTx(tx, proposalId, [
      { kind: 'exclusion', body: 'Data migration.' },
      { kind: 'assumption', body: 'Admin access from day one.' },
      { kind: 'exclusion', body: 'Training.' },
      { kind: 'additional_term', body: 'Invoices are due in 14 days.' },
    ])
  );
}

describe('snapshotClausesFromProposalTx', () => {
  it('copies kind, order, body and source id, authored by the approving admin', async () => {
    const admin = await userFactory({ platformRole: 'admin' });
    const { engagementId, source } = await seedEngagementFromProposal(null);
    const sources = await seedProposalClauses(source.proposal.id);

    const copied = await db.transaction((tx) =>
      snapshotClausesFromProposalTx(tx, {
        engagementId,
        approvingAdminUserId: admin.id,
        sources,
      })
    );

    expect(copied).toHaveLength(sources.length);
    copied.forEach((row, index) => {
      const from = sources[index];
      expect(row.engagementId).toBe(engagementId);
      expect(row.sourceProposalClauseId).toBe(from?.id);
      expect(row.kind).toBe(from?.kind);
      expect(row.sortOrder).toBe(from?.sortOrder);
      expect(row.body).toBe(from?.body);
      expect(row.createdByUserId).toBe(admin.id);
    });
  });

  it('empty sources write nothing and return []', async () => {
    const admin = await userFactory({ platformRole: 'admin' });
    const { engagementId } = await seedEngagementFromProposal(null);

    const copied = await db.transaction((tx) =>
      snapshotClausesFromProposalTx(tx, {
        engagementId,
        approvingAdminUserId: admin.id,
        sources: [],
      })
    );

    expect(copied).toEqual([]);
    const rows = await db
      .select()
      .from(engagementClauses)
      .where(eq(engagementClauses.engagementId, engagementId));
    expect(rows).toEqual([]);
  });
});

describe('engagementClausesRepository.findAgreedTerms', () => {
  it("returns the clauses by kind then order, the acceptance time and the accepter's names", async () => {
    const client = await userFactory({ firstName: 'Dana', lastName: 'Reyes' });
    const admin = await userFactory({ platformRole: 'admin' });
    const { engagementId, source } = await seedEngagementFromProposal(client.id);
    const sources = await seedProposalClauses(source.proposal.id);
    await db.transaction((tx) =>
      snapshotClausesFromProposalTx(tx, { engagementId, approvingAdminUserId: admin.id, sources })
    );

    const terms = await engagementClausesRepository.findAgreedTerms(engagementId);

    expect(terms.clauses.map((c) => [c.kind, c.sortOrder, c.body])).toEqual([
      ['assumption', 0, 'Admin access from day one.'],
      ['exclusion', 0, 'Data migration.'],
      ['exclusion', 1, 'Training.'],
      ['additional_term', 0, 'Invoices are due in 14 days.'],
    ]);
    expect(terms.proposalAcceptedAt).toEqual(ACCEPTED_AT);
    expect(terms.proposalAcceptedBy).toEqual({ firstName: 'Dana', lastName: 'Reyes' });
  });

  it('excludes removed clauses', async () => {
    const admin = await userFactory({ platformRole: 'admin' });
    const { engagementId, source } = await seedEngagementFromProposal(null);
    const sources = await seedProposalClauses(source.proposal.id);
    const [first] = await db.transaction((tx) =>
      snapshotClausesFromProposalTx(tx, { engagementId, approvingAdminUserId: admin.id, sources })
    );
    if (first === undefined) throw new Error('snapshot failed');
    await db
      .update(engagementClauses)
      .set({ deletedAt: new Date() })
      .where(eq(engagementClauses.id, first.id));

    const terms = await engagementClausesRepository.findAgreedTerms(engagementId);

    expect(terms.clauses.map((c) => c.id)).not.toContain(first.id);
    expect(terms.clauses).toHaveLength(sources.length - 1);
  });

  it('a proposal accepted before acceptance was attributed has a time but no accepter', async () => {
    const { engagementId } = await seedEngagementFromProposal(null);

    const terms = await engagementClausesRepository.findAgreedTerms(engagementId);

    expect(terms.clauses).toEqual([]);
    expect(terms.proposalAcceptedAt).toEqual(ACCEPTED_AT);
    expect(terms.proposalAcceptedBy).toBeNull();
  });

  it('keeps an accepter with no name on file as two nulls, not as no accepter', async () => {
    const client = await userFactory({ firstName: null, lastName: null });
    const { engagementId } = await seedEngagementFromProposal(client.id);

    const terms = await engagementClausesRepository.findAgreedTerms(engagementId);

    expect(terms.proposalAcceptedBy).toEqual({ firstName: null, lastName: null });
  });

  it('an engagement with no source proposal gives no clauses and nulls', async () => {
    const { engagement } = await engagementFactory();

    expect(await engagementClausesRepository.findAgreedTerms(engagement.id)).toEqual({
      clauses: [],
      proposalAcceptedAt: null,
      proposalAcceptedBy: null,
    });
  });

  it('an unknown engagement gives no clauses and nulls', async () => {
    expect(await engagementClausesRepository.findAgreedTerms(randomUUID())).toEqual({
      clauses: [],
      proposalAcceptedAt: null,
      proposalAcceptedBy: null,
    });
  });
});
