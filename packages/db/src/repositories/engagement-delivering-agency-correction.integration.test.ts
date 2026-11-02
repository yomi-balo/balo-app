import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { inArray, sql } from 'drizzle-orm';
import { db } from '../client';
import { engagements } from '../schema';
import {
  agencyFactory,
  agencyMemberFactory,
  caseEngagementFactory,
  engagementFactory,
  expertDraftFactory,
} from '../test/factories';
import { expertsRepository } from './experts';

/**
 * Migration 0124's two data fixes to `engagements.delivering_agency_id`:
 *  1. a re-backfill of NULL pins from the profile's `agency_id`, bounded to rows created before
 *     the stamping build went live whose expert belonged to that agency when the row was created;
 *  2. a correction that clears pins written after the expert's membership in the pinned agency
 *     had ended.
 * The harness migrates an empty database, so each statement is lifted from the migration file
 * by index and run against seeded rows.
 */
const MIGRATION = readFileSync(
  new URL('../../drizzle/0124_bal632_pin_rebackfill_and_correction.sql', import.meta.url),
  'utf8'
);

const STATEMENTS = MIGRATION.split('--> statement-breakpoint');

async function runStatement(index: number): Promise<void> {
  const statement = STATEMENTS[index];
  if (statement === undefined) throw new Error(`0124 has no statement ${index}`);
  await db.execute(sql.raw(statement));
}

async function runMigration(): Promise<void> {
  await runStatement(0);
  await runStatement(1);
}

const BEFORE_CUTOFF = new Date('2026-11-01T00:00:00Z');
const LINKED_AFTER_CREATION = new Date('2026-11-01T12:00:00Z');
const AFTER_CUTOFF = new Date('2026-11-02T02:00:00Z');
const JOINED_AT = new Date('2026-08-01T00:00:00Z');
const LEFT_AT = new Date('2026-10-01T00:00:00Z');
const BEFORE_LEAVING = new Date('2026-09-01T00:00:00Z');
const AFTER_LEAVING = new Date('2026-10-15T00:00:00Z');

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

/** An expert whose profile links `agencyId`, with a membership in it created at `joinedAt`. */
async function linkedExpert(agencyId: string, joinedAt: Date) {
  const expert = await expertDraftFactory();
  await expertsRepository.linkAgency(expert.id, agencyId);
  await agencyMemberFactory({
    agencyId,
    userId: expert.userId,
    joinMethod: 'domain_match',
    joinedAt,
  });
  return expert;
}

/** An expert whose profile links `agencyId`, with a membership in it that ended at `LEFT_AT`. */
async function departedExpert(agencyId: string, options: { rejoined?: boolean } = {}) {
  const expert = await expertDraftFactory();
  await expertsRepository.linkAgency(expert.id, agencyId);
  await agencyMemberFactory({
    agencyId,
    userId: expert.userId,
    joinMethod: 'domain_match',
    joinedAt: JOINED_AT,
    deletedAt: LEFT_AT,
    deletedByUserId: expert.userId,
  });
  if (options.rejoined === true) {
    await agencyMemberFactory({ agencyId, userId: expert.userId, joinMethod: 'invite' });
  }
  return expert;
}

async function seed() {
  const agency = await agencyFactory();

  const linked = await linkedExpert(agency.id, JOINED_AT);
  const unpinnedBeforeCutoff = await engagementFactory({
    expertProfileId: linked.id,
    values: { deliveringAgencyId: null, createdAt: BEFORE_CUTOFF },
  });
  const unpinnedAfterCutoff = await caseEngagementFactory({
    expertProfileId: linked.id,
    values: { deliveringAgencyId: null, createdAt: AFTER_CUTOFF },
  });

  // Linked the agency after this engagement was created (but still before the cutoff): the
  // agency had no part in it, so its NULL pin must stay NULL.
  const linkedLater = await linkedExpert(agency.id, LINKED_AFTER_CREATION);
  const unpinnedBeforeLinking = await engagementFactory({
    expertProfileId: linkedLater.id,
    values: { deliveringAgencyId: null, createdAt: BEFORE_CUTOFF },
  });

  const departed = await departedExpert(agency.id);
  const pinnedAfterLeaving = await engagementFactory({
    expertProfileId: departed.id,
    values: { createdAt: AFTER_LEAVING },
  });
  const pinnedBeforeLeaving = await engagementFactory({
    expertProfileId: departed.id,
    values: { createdAt: BEFORE_LEAVING },
  });

  const rejoined = await departedExpert(agency.id, { rejoined: true });
  const pinnedWhileLive = await caseEngagementFactory({
    expertProfileId: rejoined.id,
    values: { createdAt: AFTER_LEAVING },
  });

  return {
    agency,
    ids: {
      unpinnedBeforeCutoff: unpinnedBeforeCutoff.engagement.id,
      unpinnedAfterCutoff: unpinnedAfterCutoff.engagement.id,
      unpinnedBeforeLinking: unpinnedBeforeLinking.engagement.id,
      pinnedAfterLeaving: pinnedAfterLeaving.engagement.id,
      pinnedBeforeLeaving: pinnedBeforeLeaving.engagement.id,
      pinnedWhileLive: pinnedWhileLive.engagement.id,
    },
  };
}

describe('migration 0124 — delivering-agency re-backfill and correction', () => {
  it('has exactly two UPDATE statements, re-backfill first', () => {
    expect(STATEMENTS).toHaveLength(2);
    expect(STATEMENTS.every((statement) => statement.includes('UPDATE "engagements"'))).toBe(true);
    expect(STATEMENTS[0]).toContain('"delivering_agency_id" IS NULL');
    expect(STATEMENTS[1]).toContain('SET "delivering_agency_id" = NULL');
  });

  it('statement 1 fills a pre-cutoff NULL pin whose expert was a member when it was created', async () => {
    const { agency, ids } = await seed();

    await runStatement(0);
    const after = await pinsById([ids.unpinnedBeforeCutoff, ids.unpinnedAfterCutoff]);

    expect(after.get(ids.unpinnedBeforeCutoff)?.deliveringAgencyId).toBe(agency.id);
    expect(after.get(ids.unpinnedAfterCutoff)?.deliveringAgencyId).toBeNull();
  });

  it('statement 1 leaves a pre-cutoff NULL pin NULL when the expert linked the agency after it was created', async () => {
    const { ids } = await seed();

    await runStatement(0);
    const after = await pinsById([ids.unpinnedBeforeLinking]);

    expect(after.get(ids.unpinnedBeforeLinking)?.deliveringAgencyId).toBeNull();
  });

  it('statement 2 clears a pin written after the membership ended, and nothing else', async () => {
    const { agency, ids } = await seed();
    const allIds = Object.values(ids);
    const before = await pinsById(allIds);
    expect(before.get(ids.pinnedAfterLeaving)?.deliveringAgencyId).toBe(agency.id);

    await runStatement(1);
    const after = await pinsById(allIds);

    expect(after.get(ids.pinnedAfterLeaving)?.deliveringAgencyId).toBeNull();
    expect(after.get(ids.pinnedBeforeLeaving)?.deliveringAgencyId).toBe(agency.id);
    // A live membership in the pinned agency keeps the pin, whatever ended before it.
    expect(after.get(ids.pinnedWhileLive)?.deliveringAgencyId).toBe(agency.id);
    expect(after.get(ids.unpinnedBeforeCutoff)?.deliveringAgencyId).toBeNull();
    expect(after.get(ids.unpinnedAfterCutoff)?.deliveringAgencyId).toBeNull();
    expect(after.get(ids.unpinnedBeforeLinking)?.deliveringAgencyId).toBeNull();

    // `updated_at` is not bumped: the correction records no business change.
    for (const id of allIds) {
      expect(after.get(id)?.updatedAt.getTime()).toBe(before.get(id)?.updatedAt.getTime());
    }
  });

  it('a second run of both statements changes nothing', async () => {
    const { ids } = await seed();
    const allIds = Object.values(ids);

    await runMigration();
    const first = await pinsById(allIds);
    await runMigration();
    const second = await pinsById(allIds);

    expect(second).toEqual(first);
    expect(first.get(ids.pinnedAfterLeaving)?.deliveringAgencyId).toBeNull();
  });
});
