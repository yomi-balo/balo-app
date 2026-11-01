import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { inArray, sql } from 'drizzle-orm';
import { db } from '../client';
import { engagements } from '../schema';
import {
  agencyFactory,
  caseEngagementFactory,
  engagementFactory,
  expertDraftFactory,
} from '../test/factories';
import { expertsRepository } from './experts';

/**
 * Migration 0123's backfill: every engagement whose `delivering_agency_id` is still NULL takes
 * its expert profile's `agency_id`. The harness migrates an empty database, so the statement is
 * lifted from the migration file and run against rows seeded with a NULL pin, the shape every
 * engagement had before the column existed.
 */
const MIGRATION = readFileSync(
  new URL('../../drizzle/0123_bal632_engagement_delivering_agency.sql', import.meta.url),
  'utf8'
);

const BACKFILL = MIGRATION.split('--> statement-breakpoint').find((statement) =>
  statement.includes('UPDATE "engagements"')
);

async function runBackfill(): Promise<void> {
  if (BACKFILL === undefined) throw new Error('0123 has no backfill statement');
  await db.execute(sql.raw(BACKFILL));
}

async function agencyLinkedExpertId(agencyId: string): Promise<string> {
  const expert = await expertDraftFactory();
  await expertsRepository.linkAgency(expert.id, agencyId);
  return expert.id;
}

interface PinRow {
  id: string;
  deliveringAgencyId: string | null;
  updatedAt: Date;
}

async function pinsById(ids: string[]): Promise<Map<string, PinRow>> {
  const rows = await db
    .select({
      id: engagements.id,
      deliveringAgencyId: engagements.deliveringAgencyId,
      updatedAt: engagements.updatedAt,
    })
    .from(engagements)
    .where(inArray(engagements.id, ids));
  return new Map(rows.map((row) => [row.id, row]));
}

async function seed() {
  const agencyA = await agencyFactory();
  const agencyB = await agencyFactory();
  const agencyExpertId = await agencyLinkedExpertId(agencyA.id);
  const independentExpertId = (await expertDraftFactory()).id;
  const movedExpertId = await agencyLinkedExpertId(agencyB.id);

  const unpinned = { deliveringAgencyId: null };
  const project = await engagementFactory({ expertProfileId: agencyExpertId, values: unpinned });
  const kase = await caseEngagementFactory({ expertProfileId: agencyExpertId, values: unpinned });
  const independent = await engagementFactory({
    expertProfileId: independentExpertId,
    values: unpinned,
  });
  const softDeleted = await engagementFactory({
    expertProfileId: agencyExpertId,
    values: { ...unpinned, deletedAt: new Date() },
  });
  const alreadyPinned = await engagementFactory({
    expertProfileId: movedExpertId,
    values: { deliveringAgencyId: agencyA.id },
  });

  return {
    agencyA,
    ids: {
      project: project.engagement.id,
      kase: kase.engagement.id,
      independent: independent.engagement.id,
      softDeleted: softDeleted.engagement.id,
      alreadyPinned: alreadyPinned.engagement.id,
    },
  };
}

describe('migration 0123 — engagements.delivering_agency_id backfill', () => {
  it('pins every unpinned engagement to its profile agency and leaves the rest alone', async () => {
    const { agencyA, ids } = await seed();
    const allIds = Object.values(ids);

    const before = await pinsById(allIds);
    for (const id of allIds.filter((seeded) => seeded !== ids.alreadyPinned)) {
      expect(before.get(id)?.deliveringAgencyId).toBeNull();
    }

    await runBackfill();
    const after = await pinsById(allIds);

    expect(after.get(ids.project)?.deliveringAgencyId).toBe(agencyA.id);
    expect(after.get(ids.kase)?.deliveringAgencyId).toBe(agencyA.id);
    expect(after.get(ids.independent)?.deliveringAgencyId).toBeNull();
    expect(after.get(ids.softDeleted)?.deliveringAgencyId).toBe(agencyA.id);
    // Pinned to A while the profile now says B: the backfill never overwrites a pin.
    expect(after.get(ids.alreadyPinned)?.deliveringAgencyId).toBe(agencyA.id);

    // `updated_at` is not bumped: the backfill records no business change.
    for (const id of allIds) {
      expect(after.get(id)?.updatedAt.getTime()).toBe(before.get(id)?.updatedAt.getTime());
    }
  });

  it('a second run changes nothing', async () => {
    const { ids } = await seed();
    const allIds = Object.values(ids);

    await runBackfill();
    const first = await pinsById(allIds);
    await runBackfill();
    const second = await pinsById(allIds);

    expect(second).toEqual(first);
  });

  it("afterwards no backfilled engagement's pin differs from its profile's agency_id", async () => {
    const { ids } = await seed();
    await runBackfill();

    const backfilledIds = Object.values(ids).filter((id) => id !== ids.alreadyPinned);
    const mismatches = await db.execute<{ id: string }>(sql`
      SELECT e."id"
      FROM "engagements" AS e
      JOIN "expert_profiles" AS ep ON ep."id" = e."expert_profile_id"
      WHERE e."id" IN (${sql.join(
        backfilledIds.map((id) => sql`${id}::uuid`),
        sql`, `
      )})
        AND e."delivering_agency_id" IS DISTINCT FROM ep."agency_id"
    `);

    expect([...mismatches]).toEqual([]);
  });
});
