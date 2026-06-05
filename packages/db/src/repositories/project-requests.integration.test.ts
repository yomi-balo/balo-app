import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { db } from '../client';
import { companies, companyMembers } from '../schema';
import { userFactory, expertDraftFactory, projectRequestFactory } from '../test/factories';
import { projectRequestsRepository } from './project-requests';

/**
 * Seeds a creator user + their personal company (owner membership) + a target
 * expert draft, returning the FK ids a `createProjectRequest` call needs. Lets a
 * test drive the repository directly while still exercising real FKs.
 */
async function seedActors(): Promise<{
  companyId: string;
  expertProfileId: string;
  createdByUserId: string;
}> {
  const creator = await userFactory();

  const [company] = await db
    .insert(companies)
    .values({ name: 'Acme Co', isPersonal: true })
    .returning();
  if (company === undefined) {
    throw new Error('company insert failed');
  }

  await db
    .insert(companyMembers)
    .values({ companyId: company.id, userId: creator.id, role: 'owner' });

  const expert = await expertDraftFactory();

  return {
    companyId: company.id,
    expertProfileId: expert.id,
    createdByUserId: creator.id,
  };
}

// ── createProjectRequest ────────────────────────────────────────────

describe('projectRequestsRepository.createProjectRequest', () => {
  it('inserts with default status=submitted and source=manual, returning a generated id', async () => {
    const { companyId, expertProfileId, createdByUserId } = await seedActors();

    const row = await projectRequestsRepository.createProjectRequest({
      companyId,
      expertProfileId,
      createdByUserId,
      title: 'Lead routing rebuild',
      description: 'Rebuild lead routing in Flow with proper assignment rules.',
    });

    expect(row.id).toBeDefined();
    expect(row.companyId).toBe(companyId);
    expect(row.expertProfileId).toBe(expertProfileId);
    expect(row.createdByUserId).toBe(createdByUserId);
    expect(row.status).toBe('submitted'); // default
    expect(row.source).toBe('manual'); // default
    expect(row.title).toBe('Lead routing rebuild');
    expect(row.createdAt).toBeInstanceOf(Date);
    expect(row.deletedAt).toBeNull();
  });

  it('leaves optional fields null when omitted', async () => {
    const { companyId, expertProfileId, createdByUserId } = await seedActors();

    const row = await projectRequestsRepository.createProjectRequest({
      companyId,
      expertProfileId,
      createdByUserId,
      title: 'Quote builder',
      description: 'Stand up a CPQ-lite quote builder for the sales team.',
    });

    expect(row.focusArea).toBeNull();
    expect(row.budget).toBeNull();
    expect(row.timeline).toBeNull();
    expect(row.packageId).toBeNull();
  });

  it('persists optional fields (focusArea / budget / timeline) when provided', async () => {
    const { companyId, expertProfileId, createdByUserId } = await seedActors();

    const row = await projectRequestsRepository.createProjectRequest({
      companyId,
      expertProfileId,
      createdByUserId,
      title: 'Service Cloud migration',
      description: 'Migrate the legacy case desk to Service Cloud with omni-routing.',
      focusArea: 'Service Cloud',
      budget: 'A$5–15k',
      timeline: '1–3 months',
    });

    expect(row.focusArea).toBe('Service Cloud');
    expect(row.budget).toBe('A$5–15k');
    expect(row.timeline).toBe('1–3 months');
  });

  it('accepts an explicit source=quickstart and status=draft (BAL-254/255 forward-compat)', async () => {
    const { companyId, expertProfileId, createdByUserId } = await seedActors();

    const row = await projectRequestsRepository.createProjectRequest({
      companyId,
      expertProfileId,
      createdByUserId,
      title: 'Quick start: health check',
      description: 'Productized org health-check package instantiated from a quick start.',
      source: 'quickstart',
      status: 'draft',
    });

    expect(row.source).toBe('quickstart');
    expect(row.status).toBe('draft');
  });

  it('throws on a non-existent companyId (FK enforcement)', async () => {
    const { expertProfileId, createdByUserId } = await seedActors();

    await expect(
      projectRequestsRepository.createProjectRequest({
        companyId: randomUUID(),
        expertProfileId,
        createdByUserId,
        title: 'Orphan company',
        description: 'Should fail the company_id foreign key constraint.',
      })
    ).rejects.toThrow();
  });

  it('throws on a non-existent expertProfileId (FK enforcement)', async () => {
    const { companyId, createdByUserId } = await seedActors();

    await expect(
      projectRequestsRepository.createProjectRequest({
        companyId,
        expertProfileId: randomUUID(),
        createdByUserId,
        title: 'Orphan expert',
        description: 'Should fail the expert_profile_id foreign key constraint.',
      })
    ).rejects.toThrow();
  });

  it('throws on a non-existent createdByUserId (FK enforcement)', async () => {
    const { companyId, expertProfileId } = await seedActors();

    await expect(
      projectRequestsRepository.createProjectRequest({
        companyId,
        expertProfileId,
        createdByUserId: randomUUID(),
        title: 'Orphan creator',
        description: 'Should fail the created_by_user_id foreign key constraint.',
      })
    ).rejects.toThrow();
  });
});

// ── findById ────────────────────────────────────────────────────────

describe('projectRequestsRepository.findById', () => {
  it('returns the row for a live request', async () => {
    const created = await projectRequestFactory();

    const found = await projectRequestsRepository.findById(created.id);

    expect(found).toBeDefined();
    expect(found?.id).toBe(created.id);
    expect(found?.title).toBe(created.title);
  });

  it('returns undefined for a soft-deleted row', async () => {
    const created = await projectRequestFactory({ deletedAt: new Date() });

    const found = await projectRequestsRepository.findById(created.id);

    expect(found).toBeUndefined();
  });

  it('returns undefined for an unknown id', async () => {
    const found = await projectRequestsRepository.findById(randomUUID());

    expect(found).toBeUndefined();
  });
});
