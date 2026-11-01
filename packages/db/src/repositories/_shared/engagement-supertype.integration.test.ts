import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { db } from '../../client';
import { caseEngagements, companies, engagements, projectEngagements } from '../../schema';
import {
  agencyFactory,
  caseEngagementFactory,
  engagementFactory,
  expertDraftFactory,
} from '../../test/factories';
import { expertsRepository } from '../experts';
import {
  EngagementTypeMismatchError,
  insertEngagementRowTx,
  lockEngagementRowTx,
  resolveDeliveringAgencyIdTx,
  softDeleteEngagementTx,
} from './engagement-supertype';

async function seedCompanyId(): Promise<string> {
  const [company] = await db
    .insert(companies)
    .values({ name: 'Acme Co', isPersonal: true })
    .returning();
  if (company === undefined) throw new Error('company insert failed');
  return company.id;
}

describe('insertEngagementRowTx', () => {
  it('persists the discriminator it is given (it is a required parameter — the column has NO default)', async () => {
    const companyId = await seedCompanyId();
    const expert = await expertDraftFactory();

    const row = await db.transaction(async (tx) =>
      insertEngagementRowTx(tx, {
        engagementType: 'case',
        companyId,
        expertProfileId: expert.id,
        // A CASE must write the fee as NULL EXPLICITLY — `engagement_balo_fee_bps_case_null`
        // rejects the column DEFAULT (2500) on a case row. See the `baloFeeBps` docblock.
        baloFeeBps: null,
      })
    );

    expect(row.engagementType).toBe('case');
    expect(row.status).toBe('active');
    expect(row.currency).toBe('aud');
    expect(row.baloFeeBps).toBeNull();

    const [persisted] = await db.select().from(engagements).where(eq(engagements.id, row.id));
    expect(persisted?.engagementType).toBe('case');
  });

  it('a CASE insert that OMITS baloFeeBps fails LOUDLY on the CHECK rather than storing 2500', async () => {
    // The design decision behind keeping the column DEFAULT: an omitted fee on a
    // project/retainer still works (the retainer seam), while a case path that forgets
    // to pass `null` gets a 23514 instead of a credible-but-uncharged 2500.
    const companyId = await seedCompanyId();
    const expert = await expertDraftFactory();

    await expect(
      db.transaction(async (tx) =>
        insertEngagementRowTx(tx, {
          engagementType: 'case',
          companyId,
          expertProfileId: expert.id,
        })
      )
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('a NON-case insert with an explicit NULL fee is rejected — NOT NULL semantics survive', async () => {
    const companyId = await seedCompanyId();
    const expert = await expertDraftFactory();

    await expect(
      db.transaction(async (tx) =>
        insertEngagementRowTx(tx, {
          engagementType: 'project',
          companyId,
          expertProfileId: expert.id,
          baloFeeBps: null,
        })
      )
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('a raw INSERT that omits engagement_type is rejected (23502) — no schema default rescues it', async () => {
    const companyId = await seedCompanyId();
    const expert = await expertDraftFactory();

    await expect(
      db.execute(
        sql`INSERT INTO engagements (company_id, expert_profile_id) VALUES (${companyId}::uuid, ${expert.id}::uuid)`
      )
    ).rejects.toMatchObject({ code: '23502' });
  });

  it("pins the expert profile's agency at insert, and the pin does not follow a later re-link", async () => {
    const companyId = await seedCompanyId();
    const expert = await expertDraftFactory();
    const original = await agencyFactory();
    const later = await agencyFactory();
    await expertsRepository.linkAgency(expert.id, original.id);

    const row = await db.transaction(async (tx) =>
      insertEngagementRowTx(tx, {
        engagementType: 'project',
        companyId,
        expertProfileId: expert.id,
      })
    );
    expect(row.deliveringAgencyId).toBe(original.id);

    await expertsRepository.linkAgency(expert.id, later.id);

    const [persisted] = await db
      .select({ deliveringAgencyId: engagements.deliveringAgencyId })
      .from(engagements)
      .where(eq(engagements.id, row.id));
    expect(persisted?.deliveringAgencyId).toBe(original.id);
  });

  it('an independent expert gets a NULL pin', async () => {
    const companyId = await seedCompanyId();
    const expert = await expertDraftFactory();

    const row = await db.transaction(async (tx) =>
      insertEngagementRowTx(tx, {
        engagementType: 'project',
        companyId,
        expertProfileId: expert.id,
      })
    );
    expect(row.deliveringAgencyId).toBeNull();
  });

  it('the deliveringAgency relation resolves the pinned agency', async () => {
    const companyId = await seedCompanyId();
    const expert = await expertDraftFactory();
    const agency = await agencyFactory();
    await expertsRepository.linkAgency(expert.id, agency.id);

    const row = await db.transaction(async (tx) =>
      insertEngagementRowTx(tx, {
        engagementType: 'project',
        companyId,
        expertProfileId: expert.id,
      })
    );

    const loaded = await db.query.engagements.findFirst({
      where: eq(engagements.id, row.id),
      with: { deliveringAgency: true },
    });
    expect(loaded?.deliveringAgency?.id).toBe(agency.id);
    expect(loaded?.deliveringAgency?.name).toBe(agency.name);
  });
});

describe('resolveDeliveringAgencyIdTx', () => {
  it("returns the profile's agency, or NULL for an independent expert or an unknown profile", async () => {
    const independent = await expertDraftFactory();
    const linked = await expertDraftFactory();
    const agency = await agencyFactory();
    await expertsRepository.linkAgency(linked.id, agency.id);

    const resolved = await db.transaction(async (tx) => ({
      linked: await resolveDeliveringAgencyIdTx(tx, linked.id),
      independent: await resolveDeliveringAgencyIdTx(tx, independent.id),
      unknown: await resolveDeliveringAgencyIdTx(tx, randomUUID()),
    }));

    expect(resolved).toEqual({ linked: agency.id, independent: null, unknown: null });
  });
});

describe('lockEngagementRowTx', () => {
  it('returns the row when the concrete type matches', async () => {
    const { engagement } = await engagementFactory();
    const locked = await db.transaction(async (tx) =>
      lockEngagementRowTx(tx, engagement.id, 'project')
    );
    expect(locked.id).toBe(engagement.id);
    expect(locked.engagementType).toBe('project');
  });

  it('throws EngagementTypeMismatchError when the concrete type differs', async () => {
    const { engagement } = await caseEngagementFactory();
    await expect(
      db.transaction(async (tx) => lockEngagementRowTx(tx, engagement.id, 'project'))
    ).rejects.toBeInstanceOf(EngagementTypeMismatchError);
  });

  it('throws Error(not found) for a missing or soft-deleted engagement', async () => {
    await expect(
      db.transaction(async (tx) => lockEngagementRowTx(tx, randomUUID(), 'project'))
    ).rejects.toThrow(/Engagement not found/);

    const { engagement } = await engagementFactory();
    await db.transaction(async (tx) => softDeleteEngagementTx(tx, engagement.id));
    await expect(
      db.transaction(async (tx) => lockEngagementRowTx(tx, engagement.id, 'project'))
    ).rejects.toThrow(/Engagement not found/);
  });
});

describe('softDeleteEngagementTx — the deleted_at MIRROR (R3)', () => {
  it('stamps PARENT and PROJECT child with the SAME timestamp', async () => {
    const { engagement } = await engagementFactory();
    const at = new Date('2026-07-07T12:00:00.000Z');

    await db.transaction(async (tx) => softDeleteEngagementTx(tx, engagement.id, at));

    const [parent] = await db.select().from(engagements).where(eq(engagements.id, engagement.id));
    const [child] = await db
      .select()
      .from(projectEngagements)
      .where(eq(projectEngagements.engagementId, engagement.id));
    expect(parent?.deletedAt?.getTime()).toBe(at.getTime());
    expect(child?.deletedAt?.getTime()).toBe(at.getTime());
  });

  it('stamps PARENT and CASE child with the SAME timestamp', async () => {
    const { engagement } = await caseEngagementFactory();
    const at = new Date('2026-07-08T12:00:00.000Z');

    await db.transaction(async (tx) => softDeleteEngagementTx(tx, engagement.id, at));

    const [parent] = await db.select().from(engagements).where(eq(engagements.id, engagement.id));
    const [child] = await db
      .select()
      .from(caseEngagements)
      .where(eq(caseEngagements.engagementId, engagement.id));
    expect(parent?.deletedAt?.getTime()).toBe(at.getTime());
    expect(child?.deletedAt?.getTime()).toBe(at.getTime());
  });

  it('is idempotent — a second call does not move the timestamps', async () => {
    const { engagement } = await engagementFactory();
    const first = new Date('2026-07-07T12:00:00.000Z');
    const second = new Date('2026-09-09T12:00:00.000Z');

    await db.transaction(async (tx) => softDeleteEngagementTx(tx, engagement.id, first));
    await db.transaction(async (tx) => softDeleteEngagementTx(tx, engagement.id, second));

    const [parent] = await db.select().from(engagements).where(eq(engagements.id, engagement.id));
    const [child] = await db
      .select()
      .from(projectEngagements)
      .where(eq(projectEngagements.engagementId, engagement.id));
    expect(parent?.deletedAt?.getTime()).toBe(first.getTime());
    expect(child?.deletedAt?.getTime()).toBe(first.getTime());
  });

  it('a missing engagement is a no-op', async () => {
    await expect(
      db.transaction(async (tx) => softDeleteEngagementTx(tx, randomUUID()))
    ).resolves.toBeUndefined();
  });
});

// ── The STRUCTURAL type pairing: composite FK + single-value CHECK ───────────
//
// These are the tests that make "a wrong-type child is impossible" a DATABASE fact
// rather than a repository convention. Every one of them bypasses the repository and
// writes raw SQL, because that is the only attack the constraints exist to stop.

describe('the supertype/subtype pairing is enforced AT THE DATABASE', () => {
  it('a raw INSERT INTO project_engagements against a CASE-typed parent is rejected (23503)', async () => {
    const { engagement } = await caseEngagementFactory();

    await expect(
      db.execute(sql`
        INSERT INTO project_engagements (engagement_id, pricing_method, price_cents)
        VALUES (${engagement.id}::uuid, 'fixed', 1000)
      `)
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('a raw INSERT INTO case_engagements against a PROJECT-typed parent is rejected (23503)', async () => {
    const { engagement } = await engagementFactory();

    await expect(
      db.execute(sql`
        INSERT INTO case_engagements (engagement_id, title, description)
        VALUES (${engagement.id}::uuid, 'x', '<p>y</p>')
      `)
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('a raw INSERT INTO project_engagements with engagement_type = case is rejected (23514)', async () => {
    const companyId = await seedCompanyId();
    const expert = await expertDraftFactory();
    const parent = await db.transaction(async (tx) =>
      insertEngagementRowTx(tx, {
        engagementType: 'case',
        companyId,
        expertProfileId: expert.id,
        baloFeeBps: null, // required on a case — engagement_balo_fee_bps_case_null
      })
    );

    // The single-value CHECK fires before the composite FK ever gets a chance.
    await expect(
      db.execute(sql`
        INSERT INTO project_engagements (engagement_id, engagement_type, pricing_method, price_cents)
        VALUES (${parent.id}::uuid, 'case', 'fixed', 1000)
      `)
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('a raw UPDATE flipping the PARENT engagement_type out from under a child is rejected (23503)', async () => {
    const { engagement } = await engagementFactory();

    // ⚠ THE FEE MUST BE NULLED IN THE SAME STATEMENT, or this test stops testing what it
    // says. A project row carries `balo_fee_bps = 2500`, so a bare
    // `SET engagement_type = 'case'` now trips `engagement_balo_fee_bps_case_null`
    // (23514) FIRST and the composite FK never gets evaluated — the flip is still
    // rejected, but by the wrong constraint, and the FK backstop would go unproven.
    // Satisfying the fee invariant isolates `project_engagement_parent_type_fk`.
    await expect(
      db.execute(
        sql`UPDATE engagements SET engagement_type = 'case', balo_fee_bps = NULL WHERE id = ${engagement.id}::uuid`
      )
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('the NAIVE type flip (fee left in place) is rejected by the fee invariant first (23514)', async () => {
    // The other half of the statement above, pinned so nobody "simplifies" the NULL back
    // out of it: both constraints reject the flip, and which one fires depends on
    // whether the fee is made coherent in the same statement.
    const { engagement } = await engagementFactory();

    await expect(
      db.execute(
        sql`UPDATE engagements SET engagement_type = 'case' WHERE id = ${engagement.id}::uuid`
      )
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('flipping a CASE parent to project is rejected too (23503, fee made coherent)', async () => {
    // The mirror direction, so the FK backstop is proven for both children.
    const { engagement } = await caseEngagementFactory();

    await expect(
      db.execute(
        sql`UPDATE engagements SET engagement_type = 'project', balo_fee_bps = 2500 WHERE id = ${engagement.id}::uuid`
      )
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('a SECOND project child for the same parent is rejected (PK 23505)', async () => {
    const { engagement } = await engagementFactory();

    await expect(
      db.execute(sql`
        INSERT INTO project_engagements (engagement_id, pricing_method, price_cents)
        VALUES (${engagement.id}::uuid, 'fixed', 2000)
      `)
    ).rejects.toMatchObject({ code: '23505' });
  });
});
