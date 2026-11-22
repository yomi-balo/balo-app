import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { asc, eq, sql } from 'drizzle-orm';
import { db } from '../client';
import { engagementClauses, proposalClauses, proposalDocuments } from '../schema';
import { engagementFactory, proposalFactory, userFactory } from '../test/factories';
import { insertClausesTx } from '../repositories/proposal-clauses';
import { proposalDocumentsRepository } from '../repositories/proposal-documents';

/**
 * Migration 0128's data conversion: legacy `proposals.exclusions` HTML becomes ordered
 * `exclusion` clauses, `terms` documents become `ref`, and engagements kicked off before
 * `engagement_clauses` existed get their proposal's clauses. The harness migrates an empty
 * database, so the statements after the marker are lifted from the migration file and run
 * against seeded rows here, twice, to prove the guards.
 */
const MIGRATION = readFileSync(
  new URL('../../drizzle/0128_bal661_proposal_clauses.sql', import.meta.url),
  'utf8'
);
const MARKER = '-- BAL-661 DATA CONVERSION';

const STATEMENTS = (MIGRATION.split(MARKER)[1] ?? '')
  .split('--> statement-breakpoint')
  .map((statement) => statement.trim())
  .filter((statement) => statement !== '');

async function runConversion(): Promise<void> {
  for (const statement of STATEMENTS) {
    await db.execute(sql.raw(statement));
  }
}

async function exclusionsOf(proposalId: string) {
  return db
    .select({
      kind: proposalClauses.kind,
      sortOrder: proposalClauses.sortOrder,
      body: proposalClauses.body,
    })
    .from(proposalClauses)
    .where(eq(proposalClauses.proposalId, proposalId))
    .orderBy(asc(proposalClauses.sortOrder));
}

async function seedProposalWithExclusions(exclusions: string | null) {
  const { proposal } = await proposalFactory({ values: { exclusions } });
  return proposal;
}

describe('migration 0128 — legacy exclusions convert to clauses', () => {
  it('finds the three statements after the marker (guards against a vacuous pass)', () => {
    expect(MIGRATION).toContain(MARKER);
    expect(STATEMENTS).toHaveLength(3);
    expect(STATEMENTS[0]).toContain('INSERT INTO "proposal_clauses"');
    expect(STATEMENTS[1]).toContain('UPDATE "proposal_documents"');
    expect(STATEMENTS[2]).toContain('INSERT INTO "engagement_clauses"');
  });

  it('splits the HTML on block ends, strips tags and list markers, and decodes entities', async () => {
    const proposal = await seedProposalWithExclusions(
      '<p>One</p><p>- Two &amp; three</p><br>1. Four'
    );

    await runConversion();

    expect(await exclusionsOf(proposal.id)).toEqual([
      { kind: 'exclusion', sortOrder: 0, body: 'One' },
      { kind: 'exclusion', sortOrder: 1, body: 'Two & three' },
      { kind: 'exclusion', sortOrder: 2, body: 'Four' },
    ]);
  });

  it('decodes every handled entity once, collapses whitespace and strips each marker style', async () => {
    const proposal = await seedProposalWithExclusions(
      [
        '<ul><li>• &lt;Apex&gt;&nbsp;&nbsp;triggers</li>',
        '<li>2) &quot;Flows&quot;   and\tmore</li>',
        '<li>— the client&#39;s org</li>',
        '<li>* the expert&#x27;s tools</li>',
        '<li>– literal &amp;lt;b&amp;gt;</li></ul>',
        '<div>Plain line</div>',
        '<P>Upper-case tags</P>',
      ].join('')
    );

    await runConversion();

    expect((await exclusionsOf(proposal.id)).map((row) => row.body)).toEqual([
      '<Apex> triggers',
      '"Flows" and more',
      "the client's org",
      "the expert's tools",
      'literal &lt;b&gt;',
      'Plain line',
      'Upper-case tags',
    ]);
  });

  it('keeps a bare < that opens no tag, stripping only the real tags after it', async () => {
    const proposal = await seedProposalWithExclusions('<p>Budget < 5k <em>firm</em></p>');

    await runConversion();

    expect((await exclusionsOf(proposal.id)).map((row) => row.body)).toEqual(['Budget < 5k firm']);
  });

  it('caps a long list at 20 items and a long line at 500 characters', async () => {
    const many = await seedProposalWithExclusions(
      Array.from({ length: 25 }, (_unused, i) => `<p>Item ${i + 1}</p>`).join('')
    );
    const long = await seedProposalWithExclusions(`<p>${'x'.repeat(600)}</p>`);

    await runConversion();

    const manyRows = await exclusionsOf(many.id);
    expect(manyRows.map((row) => row.sortOrder)).toEqual(Array.from({ length: 20 }, (_u, i) => i));
    expect(manyRows.at(-1)?.body).toBe('Item 20');
    const [longRow] = await exclusionsOf(long.id);
    expect(longRow?.body).toHaveLength(500);
  });

  it('skips blank, null and soft-deleted proposals, and one that has ever had an exclusion clause', async () => {
    const blank = await seedProposalWithExclusions('<p>&nbsp;</p><p>   </p>');
    const empty = await seedProposalWithExclusions('   ');
    const none = await seedProposalWithExclusions(null);
    const { proposal: removed } = await proposalFactory({
      values: { exclusions: '<p>Gone</p>', deletedAt: new Date() },
    });
    const touched = await seedProposalWithExclusions('<p>Old text</p>');
    const [cleared] = await db.transaction((tx) =>
      insertClausesTx(tx, touched.id, [{ kind: 'exclusion', body: 'Removed by the expert.' }])
    );
    if (cleared === undefined) throw new Error('clause seed failed');
    await db
      .update(proposalClauses)
      .set({ deletedAt: new Date() })
      .where(eq(proposalClauses.id, cleared.id));

    await runConversion();

    for (const id of [blank.id, empty.id, none.id, removed.id]) {
      expect(await exclusionsOf(id)).toEqual([]);
    }
    expect((await exclusionsOf(touched.id)).map((row) => row.body)).toEqual([
      'Removed by the expert.',
    ]);
  });

  it('turns every terms document into a reference document', async () => {
    const { proposal } = await proposalFactory();
    const uploader = await userFactory();
    const upload = (kind: 'terms' | 'ref', key: string) =>
      proposalDocumentsRepository.addDocument({
        proposalId: proposal.id,
        uploadedByUserId: uploader.id,
        kind,
        r2Key: `proposals/${proposal.id}/${key}`,
        fileName: `${key}.pdf`,
        contentType: 'application/pdf',
        sizeBytes: 1024,
      });
    const terms = await upload('terms', 'terms');
    await upload('ref', 'ref');

    await runConversion();

    const kinds = await db
      .select({ id: proposalDocuments.id, kind: proposalDocuments.kind })
      .from(proposalDocuments)
      .where(eq(proposalDocuments.proposalId, proposal.id));
    expect(kinds.map((row) => row.kind)).toEqual(['ref', 'ref']);
    expect(kinds.some((row) => row.id === terms.id)).toBe(true);
  });

  it("copies a converted proposal's clauses onto the engagement kicked off from it, with no actor", async () => {
    const source = await proposalFactory({
      values: { status: 'accepted', exclusions: '<p>Data migration</p><p>Training</p>' },
    });
    const { engagement } = await engagementFactory({
      projectValues: {
        sourceProposalId: source.proposal.id,
        relationshipId: source.relationshipId,
        projectRequestId: source.projectRequestId,
      },
    });

    await runConversion();

    const copied = await db
      .select()
      .from(engagementClauses)
      .where(eq(engagementClauses.engagementId, engagement.id))
      .orderBy(asc(engagementClauses.sortOrder));
    const sources = await db
      .select()
      .from(proposalClauses)
      .where(eq(proposalClauses.proposalId, source.proposal.id))
      .orderBy(asc(proposalClauses.sortOrder));
    expect(copied.map((row) => [row.kind, row.sortOrder, row.body])).toEqual([
      ['exclusion', 0, 'Data migration'],
      ['exclusion', 1, 'Training'],
    ]);
    expect(copied.map((row) => row.sourceProposalClauseId)).toEqual(sources.map((row) => row.id));
    expect(copied.every((row) => row.createdByUserId === null)).toBe(true);
  });

  it('a second run inserts nothing', async () => {
    const proposal = await seedProposalWithExclusions('<p>One</p><p>Two</p>');
    const source = await proposalFactory({
      values: { status: 'accepted', exclusions: '<p>Agreed</p>' },
    });
    const { engagement } = await engagementFactory({
      projectValues: {
        sourceProposalId: source.proposal.id,
        relationshipId: source.relationshipId,
        projectRequestId: source.projectRequestId,
      },
    });
    const counts = async (): Promise<[number, number]> => {
      const clauses = await db
        .select({ id: proposalClauses.id })
        .from(proposalClauses)
        .where(eq(proposalClauses.proposalId, proposal.id));
      const copied = await db
        .select({ id: engagementClauses.id })
        .from(engagementClauses)
        .where(eq(engagementClauses.engagementId, engagement.id));
      return [clauses.length, copied.length];
    };

    await runConversion();
    const afterFirst = await counts();
    await runConversion();

    expect(afterFirst).toEqual([2, 1]);
    expect(await counts()).toEqual(afterFirst);
  });
});
