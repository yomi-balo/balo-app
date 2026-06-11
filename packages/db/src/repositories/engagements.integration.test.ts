import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '../client';
import { companies, engagements, proposals } from '../schema';
import { engagementFactory, expertDraftFactory } from '../test/factories';
import { engagementsRepository } from './engagements';

/** Seed a personal company and return its id (engagements need a company party). */
async function seedCompanyId(): Promise<string> {
  const [company] = await db
    .insert(companies)
    .values({ name: 'Acme Co', isPersonal: true })
    .returning();
  if (company === undefined) throw new Error('company insert failed');
  return company.id;
}

describe('engagementsRepository.create — the seam proof', () => {
  it('creates WITH a source proposal: all provenance ids set, terms snapshotted, defaults applied', async () => {
    const { engagement, sourceProposal, companyId, expertProfileId } = await engagementFactory({
      withSourceProposal: true,
    });

    if (sourceProposal === undefined) throw new Error('expected a seeded source proposal');

    expect(engagement.companyId).toBe(companyId);
    expect(engagement.expertProfileId).toBe(expertProfileId);
    // All provenance wired from the proposal.
    expect(engagement.sourceProposalId).toBe(sourceProposal.proposal.id);
    expect(engagement.relationshipId).toBe(sourceProposal.relationshipId);
    expect(engagement.projectRequestId).toBe(sourceProposal.projectRequestId);
    // Snapshotted terms + defaults.
    expect(engagement.pricingMethod).toBe('fixed');
    expect(engagement.priceCents).toBe(500_000);
    expect(engagement.currency).toBe('aud');
    expect(engagement.billingModel).toBe('proposal'); // default
    expect(engagement.approvalModel).toBe('admin_invoice'); // default
    expect(engagement.status).toBe('active'); // default
    expect(engagement.activatedAt).toBeInstanceOf(Date);
  });

  it('creates WITHOUT a proposal (the retainer seam): only company + expert + terms → row created', async () => {
    const companyId = await seedCompanyId();
    const expert = await expertDraftFactory();

    const engagement = await engagementsRepository.create({
      companyId,
      expertProfileId: expert.id,
      pricingMethod: 'tm',
      priceCents: 250_000,
      depositCents: 50_000,
      rateCents: 18_000,
      cadence: 'monthly',
      billingModel: 'retainer',
      approvalModel: 'auto',
    });

    // The load-bearing seam assertion: NO origination row whatsoever.
    expect(engagement.sourceProposalId).toBeNull();
    expect(engagement.relationshipId).toBeNull();
    expect(engagement.projectRequestId).toBeNull();
    // Terms carried on the engagement itself.
    expect(engagement.pricingMethod).toBe('tm');
    expect(engagement.priceCents).toBe(250_000);
    expect(engagement.depositCents).toBe(50_000);
    expect(engagement.rateCents).toBe(18_000);
    expect(engagement.cadence).toBe('monthly');
    expect(engagement.billingModel).toBe('retainer');
    expect(engagement.approvalModel).toBe('auto');
    expect(engagement.status).toBe('active');
    expect(engagement.activatedAt).toBeInstanceOf(Date);
  });

  it('SET NULL: hard-deleting the source proposal nulls source_proposal_id while the engagement survives', async () => {
    const { engagement, sourceProposal } = await engagementFactory({ withSourceProposal: true });
    if (sourceProposal === undefined) throw new Error('expected a seeded source proposal');

    expect(engagement.sourceProposalId).toBe(sourceProposal.proposal.id);

    // Hard DELETE (not soft) the origination proposal.
    await db.delete(proposals).where(eq(proposals.id, sourceProposal.proposal.id));

    const survivor = await engagementsRepository.findById(engagement.id);
    expect(survivor).toBeDefined();
    expect(survivor?.id).toBe(engagement.id);
    // ON DELETE SET NULL — the engagement outlives its origination proposal.
    expect(survivor?.sourceProposalId).toBeNull();
  });
});

describe('engagementsRepository.create — FK / CHECK constraints', () => {
  it('throws (FK 23503) for an unknown companyId', async () => {
    const expert = await expertDraftFactory();
    await expect(
      engagementsRepository.create({
        companyId: randomUUID(),
        expertProfileId: expert.id,
        pricingMethod: 'fixed',
        priceCents: 1000,
      })
    ).rejects.toThrow();
  });

  it('throws (FK 23503) for an unknown expertProfileId', async () => {
    const companyId = await seedCompanyId();
    await expect(
      engagementsRepository.create({
        companyId,
        expertProfileId: randomUUID(),
        pricingMethod: 'fixed',
        priceCents: 1000,
      })
    ).rejects.toThrow();
  });

  it('rejects negative priceCents / depositCents / rateCents (CHECK)', async () => {
    const companyId = await seedCompanyId();
    const expert = await expertDraftFactory();

    await expect(
      engagementsRepository.create({
        companyId,
        expertProfileId: expert.id,
        pricingMethod: 'fixed',
        priceCents: -1,
      })
    ).rejects.toThrow();

    await expect(
      engagementsRepository.create({
        companyId,
        expertProfileId: expert.id,
        pricingMethod: 'tm',
        priceCents: 1000,
        depositCents: -1,
      })
    ).rejects.toThrow();

    await expect(
      engagementsRepository.create({
        companyId,
        expertProfileId: expert.id,
        pricingMethod: 'tm',
        priceCents: 1000,
        rateCents: -1,
      })
    ).rejects.toThrow();
  });
});

describe('engagementsRepository.findById / listByCompany', () => {
  it('findById returns a live engagement and excludes soft-deleted', async () => {
    const { engagement } = await engagementFactory();

    expect((await engagementsRepository.findById(engagement.id))?.id).toBe(engagement.id);

    await db
      .update(engagements)
      .set({ deletedAt: new Date() })
      .where(eq(engagements.id, engagement.id));
    expect(await engagementsRepository.findById(engagement.id)).toBeUndefined();
  });

  it('listByCompany returns live engagements for the company only', async () => {
    const companyId = await seedCompanyId();
    const otherCompanyId = await seedCompanyId();
    const expertA = await expertDraftFactory();
    const expertB = await expertDraftFactory();

    const e1 = await engagementsRepository.create({
      companyId,
      expertProfileId: expertA.id,
      pricingMethod: 'fixed',
      priceCents: 1000,
    });
    const e2 = await engagementsRepository.create({
      companyId,
      expertProfileId: expertB.id,
      pricingMethod: 'fixed',
      priceCents: 2000,
    });
    // A different company's engagement must not appear.
    const other = await engagementsRepository.create({
      companyId: otherCompanyId,
      expertProfileId: expertA.id,
      pricingMethod: 'fixed',
      priceCents: 3000,
    });

    const list = await engagementsRepository.listByCompany(companyId);
    const ids = list.map((e) => e.id);
    expect(ids).toContain(e1.id);
    expect(ids).toContain(e2.id);
    expect(ids).not.toContain(other.id);

    // Soft-deleted excluded.
    await db.update(engagements).set({ deletedAt: new Date() }).where(eq(engagements.id, e1.id));
    const afterDelete = await engagementsRepository.listByCompany(companyId);
    expect(afterDelete.map((e) => e.id)).not.toContain(e1.id);
    expect(afterDelete.map((e) => e.id)).toContain(e2.id);
  });
});
