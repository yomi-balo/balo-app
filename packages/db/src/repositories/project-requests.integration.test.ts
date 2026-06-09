import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '../client';
import {
  companies,
  companyMembers,
  categories,
  products,
  projectRequestTags,
  projectRequestProducts,
  projectRequestDocuments,
} from '../schema';
import {
  userFactory,
  expertDraftFactory,
  projectRequestFactory,
  projectTagFactory,
  requestExpertRelationshipFactory,
} from '../test/factories';
import { referenceDataRepository } from './reference-data';
import { projectRequestsRepository, InvalidStatusTransitionError } from './project-requests';

/**
 * Seeds a creator user + their personal company (owner membership) + a target
 * expert draft, returning the FK ids a `createProjectRequest` call needs.
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

/** Inserts a product under a fresh category in the seeded Salesforce vertical. */
async function seedProduct(): Promise<string> {
  const vertical = await referenceDataRepository.getSalesforceVertical();
  const suffix = randomUUID().slice(0, 8);
  const [cat] = await db
    .insert(categories)
    .values({ verticalId: vertical.id, name: `Cat ${suffix}`, slug: `cat-${suffix}`, sortOrder: 0 })
    .returning();
  if (cat === undefined) {
    throw new Error('category insert failed');
  }
  const [product] = await db
    .insert(products)
    .values({
      verticalId: vertical.id,
      categoryId: cat.id,
      name: `Product ${suffix}`,
      slug: `product-${suffix}`,
      sortOrder: 0,
    })
    .returning();
  if (product === undefined) {
    throw new Error('product insert failed');
  }
  return product.id;
}

// ── createProjectRequest ────────────────────────────────────────────

describe('projectRequestsRepository.createProjectRequest', () => {
  it('creates a direct request with empty relation arrays, defaulting status/source/sendTo', async () => {
    const { companyId, expertProfileId, createdByUserId } = await seedActors();

    const row = await projectRequestsRepository.createProjectRequest({
      request: {
        companyId,
        expertProfileId,
        createdByUserId,
        title: 'Lead routing rebuild',
        description: '<p>Rebuild lead routing in Flow with proper assignment rules.</p>',
      },
      tagIds: [],
      productIds: [],
      documents: [],
    });

    expect(row.id).toBeDefined();
    expect(row.companyId).toBe(companyId);
    expect(row.expertProfileId).toBe(expertProfileId);
    expect(row.createdByUserId).toBe(createdByUserId);
    expect(row.sendTo).toBe('direct'); // default
    expect(row.status).toBe('requested'); // default
    expect(row.source).toBe('manual'); // default
    expect(row.title).toBe('Lead routing rebuild');
    expect(row.createdAt).toBeInstanceOf(Date);
    expect(row.deletedAt).toBeNull();

    // No junction/child rows were written.
    const tags = await db
      .select()
      .from(projectRequestTags)
      .where(eq(projectRequestTags.projectRequestId, row.id));
    const prods = await db
      .select()
      .from(projectRequestProducts)
      .where(eq(projectRequestProducts.projectRequestId, row.id));
    const docs = await db
      .select()
      .from(projectRequestDocuments)
      .where(eq(projectRequestDocuments.projectRequestId, row.id));
    expect(tags).toHaveLength(0);
    expect(prods).toHaveLength(0);
    expect(docs).toHaveLength(0);
  });

  it('creates a match request (no expert) — sendTo=match, expertProfileId null', async () => {
    const { companyId, createdByUserId } = await seedActors();

    const row = await projectRequestsRepository.createProjectRequest({
      request: {
        companyId,
        createdByUserId,
        sendTo: 'match',
        title: 'Find me an expert',
        description: '<p>Looking for someone to scope a Service Cloud migration.</p>',
      },
      tagIds: [],
      productIds: [],
      documents: [],
    });

    expect(row.sendTo).toBe('match');
    expect(row.expertProfileId).toBeNull();
  });

  it('inserts tags, products, and documents in one transaction with the parent', async () => {
    const { companyId, expertProfileId, createdByUserId } = await seedActors();

    const tagA = await projectTagFactory();
    const tagB = await projectTagFactory();
    const productA = await seedProduct();
    const productB = await seedProduct();

    const row = await projectRequestsRepository.createProjectRequest({
      request: {
        companyId,
        expertProfileId,
        createdByUserId,
        title: 'Full brief',
        description: '<p>Brief with tags, products, and attachments.</p>',
      },
      tagIds: [tagA.id, tagB.id],
      productIds: [productA, productB],
      documents: [
        {
          r2Key: `project-documents/${companyId}/${createdByUserId}/${randomUUID()}`,
          fileName: 'scope.pdf',
          contentType: 'application/pdf',
          sizeBytes: 2048,
        },
        {
          r2Key: `project-documents/${companyId}/${createdByUserId}/${randomUUID()}`,
          fileName: 'diagram.png',
          contentType: 'image/png',
          sizeBytes: 4096,
        },
      ],
    });

    const tagRows = await db
      .select()
      .from(projectRequestTags)
      .where(eq(projectRequestTags.projectRequestId, row.id));
    const productRows = await db
      .select()
      .from(projectRequestProducts)
      .where(eq(projectRequestProducts.projectRequestId, row.id));
    const docRows = await db
      .select()
      .from(projectRequestDocuments)
      .where(eq(projectRequestDocuments.projectRequestId, row.id));

    expect(tagRows.map((t) => t.projectTagId).sort()).toEqual([tagA.id, tagB.id].sort());
    expect(productRows.map((p) => p.productId).sort()).toEqual([productA, productB].sort());
    expect(docRows.map((d) => d.fileName).sort()).toEqual(['diagram.png', 'scope.pdf']);
    expect(docRows.every((d) => d.sizeBytes > 0)).toBe(true);
  });

  it('rolls back the whole transaction on a duplicate document r2_key (unique constraint)', async () => {
    const { companyId, expertProfileId, createdByUserId } = await seedActors();
    const dupKey = `project-documents/${companyId}/${createdByUserId}/${randomUUID()}`;

    await expect(
      projectRequestsRepository.createProjectRequest({
        request: {
          companyId,
          expertProfileId,
          createdByUserId,
          title: 'Dup docs',
          description: '<p>Two documents share an r2 key.</p>',
        },
        tagIds: [],
        productIds: [],
        documents: [
          { r2Key: dupKey, fileName: 'a.pdf', contentType: 'application/pdf', sizeBytes: 1 },
          { r2Key: dupKey, fileName: 'b.pdf', contentType: 'application/pdf', sizeBytes: 1 },
        ],
      })
    ).rejects.toThrow();

    // Nothing persisted — the parent insert rolled back with the failed child.
    const docs = await db
      .select()
      .from(projectRequestDocuments)
      .where(eq(projectRequestDocuments.r2Key, dupKey));
    expect(docs).toHaveLength(0);
  });

  it('throws when a tag id does not exist (restrict FK)', async () => {
    const { companyId, expertProfileId, createdByUserId } = await seedActors();

    await expect(
      projectRequestsRepository.createProjectRequest({
        request: {
          companyId,
          expertProfileId,
          createdByUserId,
          title: 'Unknown tag',
          description: '<p>Should violate the project_tag_id FK.</p>',
        },
        tagIds: [randomUUID()],
        productIds: [],
        documents: [],
      })
    ).rejects.toThrow();
  });

  it('accepts an explicit source=quickstart and status=draft (BAL-254/255 forward-compat)', async () => {
    const { companyId, expertProfileId, createdByUserId } = await seedActors();

    const row = await projectRequestsRepository.createProjectRequest({
      request: {
        companyId,
        expertProfileId,
        createdByUserId,
        title: 'Quick start: health check',
        description: '<p>Productized org health-check package from a quick start.</p>',
        source: 'quickstart',
        status: 'draft',
      },
      tagIds: [],
      productIds: [],
      documents: [],
    });

    expect(row.source).toBe('quickstart');
    expect(row.status).toBe('draft');
  });

  // ── routing CHECK constraint (both directions) ──────────────────────

  it('rejects a direct request with a null expert (CHECK constraint)', async () => {
    const { companyId, createdByUserId } = await seedActors();

    await expect(
      projectRequestsRepository.createProjectRequest({
        request: {
          companyId,
          createdByUserId,
          sendTo: 'direct',
          // expertProfileId intentionally omitted → null
          title: 'Direct without expert',
          description: '<p>Should violate project_requests_direct_requires_expert.</p>',
        },
        tagIds: [],
        productIds: [],
        documents: [],
      })
    ).rejects.toThrow();
  });

  it('rejects a match request with a non-null expert (CHECK constraint)', async () => {
    const { companyId, expertProfileId, createdByUserId } = await seedActors();

    await expect(
      projectRequestsRepository.createProjectRequest({
        request: {
          companyId,
          expertProfileId,
          createdByUserId,
          sendTo: 'match',
          title: 'Match with expert',
          description: '<p>Should violate project_requests_direct_requires_expert.</p>',
        },
        tagIds: [],
        productIds: [],
        documents: [],
      })
    ).rejects.toThrow();
  });

  // ── FK enforcement ──────────────────────────────────────────────────

  it('throws on a non-existent companyId (FK enforcement)', async () => {
    const { expertProfileId, createdByUserId } = await seedActors();

    await expect(
      projectRequestsRepository.createProjectRequest({
        request: {
          companyId: randomUUID(),
          expertProfileId,
          createdByUserId,
          title: 'Orphan company',
          description: '<p>Should fail the company_id foreign key constraint.</p>',
        },
        tagIds: [],
        productIds: [],
        documents: [],
      })
    ).rejects.toThrow();
  });

  it('throws on a non-existent expertProfileId (FK enforcement)', async () => {
    const { companyId, createdByUserId } = await seedActors();

    await expect(
      projectRequestsRepository.createProjectRequest({
        request: {
          companyId,
          expertProfileId: randomUUID(),
          createdByUserId,
          title: 'Orphan expert',
          description: '<p>Should fail the expert_profile_id foreign key constraint.</p>',
        },
        tagIds: [],
        productIds: [],
        documents: [],
      })
    ).rejects.toThrow();
  });

  it('throws on a non-existent createdByUserId (FK enforcement)', async () => {
    const { companyId, expertProfileId } = await seedActors();

    await expect(
      projectRequestsRepository.createProjectRequest({
        request: {
          companyId,
          expertProfileId,
          createdByUserId: randomUUID(),
          title: 'Orphan creator',
          description: '<p>Should fail the created_by_user_id foreign key constraint.</p>',
        },
        tagIds: [],
        productIds: [],
        documents: [],
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

// ── transitionStatus ─────────────────────────────────────────────────

describe('projectRequestsRepository.transitionStatus', () => {
  it('advances a request through a legal transition and persists it', async () => {
    const created = await projectRequestFactory({ status: 'requested' });

    const updated = await projectRequestsRepository.transitionStatus({
      id: created.id,
      to: 'experts_invited',
    });

    expect(updated.status).toBe('experts_invited');

    // Persisted (not just returned).
    const reloaded = await projectRequestsRepository.findById(created.id);
    expect(reloaded?.status).toBe('experts_invited');
  });

  it('throws InvalidStatusTransitionError on an illegal transition and leaves the row unchanged', async () => {
    const created = await projectRequestFactory({ status: 'requested' });

    await expect(
      // requested → accepted is not a legal edge.
      projectRequestsRepository.transitionStatus({ id: created.id, to: 'accepted' })
    ).rejects.toBeInstanceOf(InvalidStatusTransitionError);

    const reloaded = await projectRequestsRepository.findById(created.id);
    expect(reloaded?.status).toBe('requested');
  });

  it('throws when expectedFrom does not match the live status', async () => {
    const created = await projectRequestFactory({ status: 'requested' });

    await expect(
      projectRequestsRepository.transitionStatus({
        id: created.id,
        to: 'experts_invited',
        expectedFrom: 'draft', // live status is 'requested'
      })
    ).rejects.toBeInstanceOf(InvalidStatusTransitionError);

    const reloaded = await projectRequestsRepository.findById(created.id);
    expect(reloaded?.status).toBe('requested');
  });

  it('advances when expectedFrom matches the live status', async () => {
    const created = await projectRequestFactory({ status: 'requested' });

    const updated = await projectRequestsRepository.transitionStatus({
      id: created.id,
      to: 'experts_invited',
      expectedFrom: 'requested',
    });

    expect(updated.status).toBe('experts_invited');
  });

  it('throws for an unknown id', async () => {
    await expect(
      projectRequestsRepository.transitionStatus({ id: randomUUID(), to: 'experts_invited' })
    ).rejects.toThrow();
  });

  it('throws for a soft-deleted request', async () => {
    const created = await projectRequestFactory({ status: 'requested', deletedAt: new Date() });

    await expect(
      projectRequestsRepository.transitionStatus({ id: created.id, to: 'experts_invited' })
    ).rejects.toThrow();
  });

  it('rejects any out-edge from the terminal kickoff_approved status', async () => {
    const created = await projectRequestFactory({ status: 'kickoff_approved' });

    await expect(
      projectRequestsRepository.transitionStatus({ id: created.id, to: 'accepted' })
    ).rejects.toBeInstanceOf(InvalidStatusTransitionError);
  });
});

// ── findByIdWithRelations ────────────────────────────────────────────

describe('projectRequestsRepository.findByIdWithRelations', () => {
  it('hydrates company, creator, tags, products, documents, relationships, and budget/timeline', async () => {
    // A request with a budget range + timeline, plus its target expert.
    const request = await projectRequestFactory({
      title: 'Hydration brief',
      budgetMinCents: 4_500_000,
      budgetMaxCents: 7_000_000,
      budgetCurrency: 'aud',
      timeline: 'Target go-live: end of Q3',
    });
    if (request.expertProfileId === null) {
      throw new Error('expected a direct request with a target expert');
    }

    // Tags (junction rows) + products (junction rows) + documents (child rows).
    const tagA = await projectTagFactory();
    const tagB = await projectTagFactory();
    await db.insert(projectRequestTags).values([
      { projectRequestId: request.id, projectTagId: tagA.id },
      { projectRequestId: request.id, projectTagId: tagB.id },
    ]);

    const productId = await seedProduct();
    await db.insert(projectRequestProducts).values({ projectRequestId: request.id, productId });

    await db.insert(projectRequestDocuments).values({
      projectRequestId: request.id,
      r2Key: `project-documents/${randomUUID()}`,
      fileName: 'scope.pdf',
      contentType: 'application/pdf',
      sizeBytes: 2048,
    });

    // One live relationship for the request's own expert (so expertProfile.user hydrates).
    const { relationship } = await requestExpertRelationshipFactory({
      projectRequestId: request.id,
      expertProfileId: request.expertProfileId,
    });

    const found = await projectRequestsRepository.findByIdWithRelations(request.id);

    expect(found).toBeDefined();
    if (found === undefined) {
      throw new Error('expected the request to hydrate');
    }

    // Top-level row + the new budget/timeline columns round-trip.
    expect(found.id).toBe(request.id);
    expect(found.title).toBe('Hydration brief');
    expect(found.budgetMinCents).toBe(4_500_000);
    expect(found.budgetMaxCents).toBe(7_000_000);
    expect(found.budgetCurrency).toBe('aud');
    expect(found.timeline).toBe('Target go-live: end of Q3');

    // Company + creator.
    expect(found.company.id).toBe(request.companyId);
    expect(found.company.name).toBeDefined();
    expect(found.createdByUser.id).toBe(request.createdByUserId);
    expect(found.createdByUser.email).toBeDefined();

    // Tags + products + documents.
    expect(found.tags.map((t) => t.projectTag.id).sort()).toEqual([tagA.id, tagB.id].sort());
    expect(found.products.map((p) => p.product.id)).toEqual([productId]);
    expect(found.documents).toHaveLength(1);
    const [doc] = found.documents;
    expect(doc?.fileName).toBe('scope.pdf');
    expect(doc?.sizeBytes).toBe(2048);
    expect(doc?.contentType).toBe('application/pdf');

    // Relationship + nested expert user identity.
    expect(found.relationships).toHaveLength(1);
    const [rel] = found.relationships;
    expect(rel?.id).toBe(relationship.id);
    expect(rel?.expertProfileId).toBe(request.expertProfileId);
    expect(rel?.status).toBe('invited');
    expect(rel?.invitedAt).toBeInstanceOf(Date);
    expect(rel?.expertProfile.id).toBe(request.expertProfileId);
    expect(rel?.expertProfile.user.id).toBeDefined();
  });

  it('round-trips a null/default budget (legacy-shaped request)', async () => {
    const request = await projectRequestFactory({ title: 'No budget brief' });

    const found = await projectRequestsRepository.findByIdWithRelations(request.id);

    expect(found?.budgetMinCents).toBeNull();
    expect(found?.budgetMaxCents).toBeNull();
    expect(found?.budgetCurrency).toBe('aud'); // schema default backfill
    expect(found?.timeline).toBeNull();
    expect(found?.tags).toHaveLength(0);
    expect(found?.products).toHaveLength(0);
    expect(found?.documents).toHaveLength(0);
    expect(found?.relationships).toHaveLength(0);
  });

  it('returns undefined for a soft-deleted request', async () => {
    const request = await projectRequestFactory({ deletedAt: new Date() });

    const found = await projectRequestsRepository.findByIdWithRelations(request.id);

    expect(found).toBeUndefined();
  });

  it('returns undefined for an unknown id', async () => {
    const found = await projectRequestsRepository.findByIdWithRelations(randomUUID());

    expect(found).toBeUndefined();
  });

  it('excludes a soft-deleted child document from the hydrated result', async () => {
    const request = await projectRequestFactory();

    await db.insert(projectRequestDocuments).values([
      {
        projectRequestId: request.id,
        r2Key: `project-documents/${randomUUID()}`,
        fileName: 'live.pdf',
        contentType: 'application/pdf',
        sizeBytes: 1024,
      },
      {
        projectRequestId: request.id,
        r2Key: `project-documents/${randomUUID()}`,
        fileName: 'removed.pdf',
        contentType: 'application/pdf',
        sizeBytes: 1024,
        deletedAt: new Date(),
      },
    ]);

    const found = await projectRequestsRepository.findByIdWithRelations(request.id);

    expect(found?.documents.map((d) => d.fileName)).toEqual(['live.pdf']);
  });

  it('excludes a soft-deleted relationship from the hydrated result', async () => {
    const request = await projectRequestFactory();
    if (request.expertProfileId === null) {
      throw new Error('expected a direct request with a target expert');
    }

    await requestExpertRelationshipFactory({
      projectRequestId: request.id,
      expertProfileId: request.expertProfileId,
      values: { deletedAt: new Date() },
    });

    const found = await projectRequestsRepository.findByIdWithRelations(request.id);

    expect(found?.relationships).toHaveLength(0);
  });
});

// ── budget CHECK constraints ─────────────────────────────────────────

describe('project_requests budget CHECK constraints', () => {
  it('accepts a one-sided budget (min only, max null)', async () => {
    const request = await projectRequestFactory({
      budgetMinCents: 4_500_000,
      budgetMaxCents: null,
    });

    expect(request.budgetMinCents).toBe(4_500_000);
    expect(request.budgetMaxCents).toBeNull();
  });

  it('accepts a one-sided budget (max only, min null)', async () => {
    const request = await projectRequestFactory({
      budgetMinCents: null,
      budgetMaxCents: 7_000_000,
    });

    expect(request.budgetMinCents).toBeNull();
    expect(request.budgetMaxCents).toBe(7_000_000);
  });

  it('rejects an incoherent range where max < min (project_requests_budget_range)', async () => {
    await expect(
      projectRequestFactory({ budgetMinCents: 7_000_000, budgetMaxCents: 4_500_000 })
    ).rejects.toThrow();
  });

  it('rejects a negative budget_min_cents (project_requests_budget_min_nonneg)', async () => {
    await expect(projectRequestFactory({ budgetMinCents: -1 })).rejects.toThrow();
  });

  it('rejects a negative budget_max_cents (project_requests_budget_max_nonneg)', async () => {
    await expect(projectRequestFactory({ budgetMaxCents: -1 })).rejects.toThrow();
  });
});
