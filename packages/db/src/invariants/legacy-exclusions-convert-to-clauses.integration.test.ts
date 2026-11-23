import { readFileSync } from 'node:fs';
import { beforeEach, describe, it, expect } from 'vitest';
import { asc, eq, sql } from 'drizzle-orm';
import { db } from '../client';
import { engagementClauses, proposalClauses, proposalDocuments, type Proposal } from '../schema';
import { engagementFactory, proposalFactory, userFactory } from '../test/factories';
import { insertClausesTx } from '../repositories/proposal-clauses';
import { proposalDocumentsRepository } from '../repositories/proposal-documents';

/**
 * The legacy `proposals.exclusions` conversion. Migration 0128 turned that HTML into ordered
 * `exclusion` clauses (a), made `terms` documents `ref` (b), and copied a proposal's clauses onto
 * engagements kicked off before `engagement_clauses` existed (c). Migration 0129 re-runs (a) and
 * (c) verbatim and then drops the column, so the statements run here are 0129's re-run and
 * 0128's (b), lifted from the files after their markers.
 *
 * The harness migrates an empty database, so the column is gone before any test starts. Each
 * conversion test adds it back inside its own rolled-back transaction, writes the legacy text by
 * raw UPDATE (the Drizzle schema no longer declares it) and runs the statements, twice where the
 * guards are under test. The ADD COLUMN has no IF NOT EXISTS: a column that outlived the previous
 * test's rollback fails the next one with 42701.
 */
const read = (file: string): string =>
  readFileSync(new URL(`../../drizzle/${file}`, import.meta.url), 'utf8');

function statementsAfter(migration: string, marker: string): string[] {
  return (migration.split(marker)[1] ?? '')
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter((statement) => statement !== '');
}

/** A statement's SQL without its comment lines, so two copies compare on code alone. */
function withoutComments(statement: string | undefined): string {
  return (statement ?? '')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
    .trim();
}

const CONVERSION_MIGRATION = read('0128_bal661_proposal_clauses.sql');
const CONVERSION_MARKER = '-- BAL-661 DATA CONVERSION';
const CONVERSION = statementsAfter(CONVERSION_MIGRATION, CONVERSION_MARKER);

const RERUN_MIGRATION = read('0129_bal667_drop_proposals_exclusions.sql');
const RERUN_MARKER = '-- BAL-667 DATA RE-RUN';
const RERUN_TAIL = statementsAfter(RERUN_MIGRATION, RERUN_MARKER);
/** 0129's re-run: everything after its marker except the closing DROP. */
const RERUN = RERUN_TAIL.slice(0, -1);
const DROP = 'ALTER TABLE "proposals" DROP COLUMN "exclusions";';

async function runRerun(): Promise<void> {
  for (const statement of RERUN) {
    await db.execute(sql.raw(statement));
  }
}

async function runTermsToRef(): Promise<void> {
  const [, termsToRef] = CONVERSION;
  if (termsToRef === undefined) throw new Error("0128's (b) statement not found");
  await db.execute(sql.raw(termsToRef));
}

async function restoreLegacyColumn(): Promise<void> {
  await db.execute(sql.raw('ALTER TABLE "proposals" ADD COLUMN "exclusions" text'));
}

async function setLegacyExclusions(proposalId: string, exclusions: string | null): Promise<void> {
  await db.execute(
    sql`UPDATE "proposals" SET "exclusions" = ${exclusions} WHERE "id" = ${proposalId}`
  );
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

async function seedProposalWithExclusions(exclusions: string | null): Promise<Proposal> {
  const { proposal } = await proposalFactory();
  await setLegacyExclusions(proposal.id, exclusions);
  return proposal;
}

describe('migrations 0128 and 0129 — legacy exclusions convert to clauses', () => {
  it('finds the three statements after the marker (guards against a vacuous pass)', () => {
    expect(CONVERSION_MIGRATION).toContain(CONVERSION_MARKER);
    expect(CONVERSION).toHaveLength(3);
    expect(CONVERSION[0]).toContain('INSERT INTO "proposal_clauses"');
    expect(CONVERSION[1]).toContain('UPDATE "proposal_documents"');
    expect(CONVERSION[2]).toContain('INSERT INTO "engagement_clauses"');
  });

  it("0129 re-runs 0128's (a) and (c) verbatim, then drops the column as its last statement", () => {
    expect(RERUN_MIGRATION).toContain(RERUN_MARKER);
    expect(RERUN_MIGRATION.split(RERUN_MARKER)[0]?.trim()).toBe('');
    expect(RERUN_TAIL).toHaveLength(3);
    expect(RERUN_TAIL.at(-1)).toBe(DROP);
    expect(RERUN).toHaveLength(2);
    expect(withoutComments(RERUN[0])).toBe(withoutComments(CONVERSION[0]));
    expect(withoutComments(RERUN[1])).toBe(withoutComments(CONVERSION[2]));
  });

  it('leaves the migrated database with no proposals.exclusions column', async () => {
    const columns = await db.execute(
      sql`SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'proposals' AND column_name = 'exclusions'`
    );
    expect(columns).toHaveLength(0);
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

    await runTermsToRef();

    const kinds = await db
      .select({ id: proposalDocuments.id, kind: proposalDocuments.kind })
      .from(proposalDocuments)
      .where(eq(proposalDocuments.proposalId, proposal.id));
    expect(kinds.map((row) => row.kind)).toEqual(['ref', 'ref']);
    expect(kinds.some((row) => row.id === terms.id)).toBe(true);
  });

  describe('with the legacy column restored', () => {
    beforeEach(restoreLegacyColumn);

    it('splits the HTML on block ends, strips tags and list markers, and decodes entities', async () => {
      const proposal = await seedProposalWithExclusions(
        '<p>One</p><p>- Two &amp; three</p><br>1. Four'
      );

      await runRerun();

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

      await runRerun();

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

      await runRerun();

      expect((await exclusionsOf(proposal.id)).map((row) => row.body)).toEqual([
        'Budget < 5k firm',
      ]);
    });

    it('caps a long list at 20 items and a long line at 500 characters', async () => {
      const many = await seedProposalWithExclusions(
        Array.from({ length: 25 }, (_unused, i) => `<p>Item ${i + 1}</p>`).join('')
      );
      const long = await seedProposalWithExclusions(`<p>${'x'.repeat(600)}</p>`);

      await runRerun();

      const manyRows = await exclusionsOf(many.id);
      expect(manyRows.map((row) => row.sortOrder)).toEqual(
        Array.from({ length: 20 }, (_u, i) => i)
      );
      expect(manyRows.at(-1)?.body).toBe('Item 20');
      const [longRow] = await exclusionsOf(long.id);
      expect(longRow?.body).toHaveLength(500);
    });

    it('skips blank, null and soft-deleted proposals, and one that has ever had an exclusion clause', async () => {
      const blank = await seedProposalWithExclusions('<p>&nbsp;</p><p>   </p>');
      const empty = await seedProposalWithExclusions('   ');
      const none = await seedProposalWithExclusions(null);
      const { proposal: removed } = await proposalFactory({ values: { deletedAt: new Date() } });
      await setLegacyExclusions(removed.id, '<p>Gone</p>');
      const touched = await seedProposalWithExclusions('<p>Old text</p>');
      const [cleared] = await db.transaction((tx) =>
        insertClausesTx(tx, touched.id, [{ kind: 'exclusion', body: 'Removed by the expert.' }])
      );
      if (cleared === undefined) throw new Error('clause seed failed');
      await db
        .update(proposalClauses)
        .set({ deletedAt: new Date() })
        .where(eq(proposalClauses.id, cleared.id));

      await runRerun();

      for (const id of [blank.id, empty.id, none.id, removed.id]) {
        expect(await exclusionsOf(id)).toEqual([]);
      }
      expect((await exclusionsOf(touched.id)).map((row) => row.body)).toEqual([
        'Removed by the expert.',
      ]);
    });

    it("copies a converted proposal's clauses onto the engagement kicked off from it, with no actor", async () => {
      const source = await proposalFactory({ values: { status: 'accepted' } });
      await setLegacyExclusions(source.proposal.id, '<p>Data migration</p><p>Training</p>');
      const { engagement } = await engagementFactory({
        projectValues: {
          sourceProposalId: source.proposal.id,
          relationshipId: source.relationshipId,
          projectRequestId: source.projectRequestId,
        },
      });

      await runRerun();

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
      const source = await proposalFactory({ values: { status: 'accepted' } });
      await setLegacyExclusions(source.proposal.id, '<p>Agreed</p>');
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

      await runRerun();
      const afterFirst = await counts();
      await runRerun();

      expect(afterFirst).toEqual([2, 1]);
      expect(await counts()).toEqual(afterFirst);
    });
  });
});
