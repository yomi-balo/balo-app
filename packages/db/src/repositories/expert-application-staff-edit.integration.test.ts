import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import type { StaffApplicationEdit } from '@balo/shared/experts';
import { db } from '../client';
import {
  auditEvents,
  certifications,
  expertCertifications,
  expertCompetency,
  expertIndustries,
  expertLanguages,
  expertProfiles,
  industries,
  languages,
  products,
  supportTypes,
  workHistory,
  type ApplicationStatus,
  type ExpertProfile,
} from '../schema';
import { expertDraftFactory, userFactory } from '../test/factories';
import { referenceDataRepository } from './reference-data';
import {
  expertsRepository,
  type ApplicantDraftStepWrite,
  type EditApplicationAsStaffResult,
} from './experts';

/**
 * BAL-593 — a Balo-staff edit of an expert application (`editApplicationAsStaff`) and the
 * applicant draft gate (`saveApplicantDraftStep`), end to end against real Postgres.
 *
 * ⚠ Without Docker this file exits 0 with "No test files" — a FALSE GREEN. A passing run must
 * show this file by name.
 *
 * ⚠ WHAT THIS CANNOT CATCH: the harness runs every test in ONE rolled-back transaction on a
 * `max: 1` pool, so a genuine staff-vs-applicant RACE is inexpressible. The serialisation both
 * methods rely on is the shared profile `FOR UPDATE`; §H1 pins what each side does once it holds
 * that lock (it sees the other's committed status), never the interleaving itself.
 */

const HOUR_MS = 3_600_000;

let seq = 0;
function uniq(prefix: string): string {
  seq++;
  return `${prefix}-${seq}-${Date.now().toString(36)}`;
}

interface Taxonomy {
  p1: string;
  p2: string;
  p3: string;
  stA: string;
  stB: string;
  cert1: string;
  cert2: string;
  cert3: string;
  langEn: string;
  langFr: string;
  langDe: string;
  ind1: string;
  ind2: string;
  ind3: string;
}

async function seedTaxonomy(): Promise<Taxonomy> {
  const vertical = await referenceDataRepository.getSalesforceVertical();
  const productRows = await db
    .insert(products)
    .values(
      ['P1', 'P2', 'P3'].map((name) => ({
        verticalId: vertical.id,
        name,
        slug: uniq(name.toLowerCase()),
      }))
    )
    .returning({ id: products.id });
  const supportRows = await db
    .insert(supportTypes)
    .values(
      ['Build', 'Advise'].map((name) => ({
        verticalId: vertical.id,
        name,
        slug: uniq(name.toLowerCase()),
      }))
    )
    .returning({ id: supportTypes.id });
  const certRows = await db
    .insert(certifications)
    .values(
      ['Admin', 'Developer', 'Architect'].map((name) => ({
        verticalId: vertical.id,
        name,
        slug: uniq(name.toLowerCase()),
      }))
    )
    .returning({ id: certifications.id });
  const langRows = await db
    .insert(languages)
    .values(['English', 'French', 'German'].map((name) => ({ name, code: uniq(name) })))
    .returning({ id: languages.id });
  const indRows = await db
    .insert(industries)
    .values(['Retail', 'Health', 'Energy'].map((name) => ({ name, slug: uniq(name) })))
    .returning({ id: industries.id });

  const [p1, p2, p3] = productRows.map((r) => r.id);
  const [stA, stB] = supportRows.map((r) => r.id);
  const [cert1, cert2, cert3] = certRows.map((r) => r.id);
  const [langEn, langFr, langDe] = langRows.map((r) => r.id);
  const [ind1, ind2, ind3] = indRows.map((r) => r.id);
  if (
    p1 === undefined ||
    p2 === undefined ||
    p3 === undefined ||
    stA === undefined ||
    stB === undefined ||
    cert1 === undefined ||
    cert2 === undefined ||
    cert3 === undefined ||
    langEn === undefined ||
    langFr === undefined ||
    langDe === undefined ||
    ind1 === undefined ||
    ind2 === undefined ||
    ind3 === undefined
  ) {
    throw new Error('seedTaxonomy: insert returned too few rows');
  }
  return { p1, p2, p3, stA, stB, cert1, cert2, cert3, langEn, langFr, langDe, ind1, ind2, ind3 };
}

/**
 * An application written the way the applicant writes it (so every self-rating is set), then
 * moved to `status` directly — this suite needs a CONTROLLED `submitted_at`.
 */
async function seedApplication(
  t: Taxonomy,
  values: { status: ApplicationStatus; submittedAt?: Date; userId?: string }
): Promise<ExpertProfile> {
  const draft = await expertDraftFactory(
    values.userId === undefined ? {} : { userId: values.userId }
  );
  await expertsRepository.saveProfileStep(draft.id, undefined, {
    yearStartedSalesforce: 2015,
    projectCountMin: 10,
    projectLeadCountMin: 2,
    isSalesforceMvp: false,
    isSalesforceCta: false,
    isCertifiedTrainer: false,
    languages: [
      { languageId: t.langEn, proficiency: 'native' },
      { languageId: t.langFr, proficiency: 'intermediate' },
    ],
    industryIds: [t.ind1, t.ind2],
  });
  await expertsRepository.syncProducts(draft.id, [t.p1, t.p2], [t.stA, t.stB]);
  await expertsRepository.updateCompetencyProficiency(draft.id, [
    { productId: t.p1, supportTypeId: t.stA, proficiency: 8 },
    { productId: t.p1, supportTypeId: t.stB, proficiency: 6 },
    { productId: t.p2, supportTypeId: t.stA, proficiency: 5 },
    { productId: t.p2, supportTypeId: t.stB, proficiency: 3 },
  ]);
  await expertsRepository.saveCertificationsStep(draft.id, 'https://trailblazer.me/id/seed', [
    { certificationId: t.cert1, earnedAt: '2023-04-01', credentialUrl: 'https://cred.example/1' },
    { certificationId: t.cert2 },
  ]);
  await expertsRepository.syncWorkHistory(draft.id, [
    { role: 'Consultant', company: 'Northwind', startedAt: '2020-01-01', isCurrent: true },
  ]);

  const submittedAt = values.submittedAt ?? new Date(Date.now() - 2 * HOUR_MS);
  const approved = values.status === 'approved';
  const [profile] = await db
    .update(expertProfiles)
    .set({
      applicationStatus: values.status,
      submittedAt: values.status === 'draft' ? null : submittedAt,
      ...(approved ? { approvedAt: new Date() } : {}),
    })
    .where(eq(expertProfiles.id, draft.id))
    .returning();
  if (profile === undefined) throw new Error('seedApplication: update matched no row');
  return profile;
}

async function seedActor(): Promise<string> {
  return (await userFactory({ platformRole: 'admin' })).id;
}

async function readCompetencies(expertProfileId: string): Promise<
  {
    productId: string;
    supportTypeId: string;
    proficiency: number;
    selfProficiency: number | null;
  }[]
> {
  return db
    .select({
      productId: expertCompetency.productId,
      supportTypeId: expertCompetency.supportTypeId,
      proficiency: expertCompetency.proficiency,
      selfProficiency: expertCompetency.selfProficiency,
    })
    .from(expertCompetency)
    .where(eq(expertCompetency.expertProfileId, expertProfileId))
    .orderBy(asc(expertCompetency.productId), asc(expertCompetency.supportTypeId));
}

async function readCell(
  expertProfileId: string,
  productId: string,
  supportTypeId: string
): Promise<{ proficiency: number; selfProficiency: number | null } | undefined> {
  const [row] = await db
    .select({
      proficiency: expertCompetency.proficiency,
      selfProficiency: expertCompetency.selfProficiency,
    })
    .from(expertCompetency)
    .where(
      and(
        eq(expertCompetency.expertProfileId, expertProfileId),
        eq(expertCompetency.productId, productId),
        eq(expertCompetency.supportTypeId, supportTypeId)
      )
    );
  return row;
}

async function readEditedAudit(
  expertProfileId: string
): Promise<{ id: string; actorUserId: string | null; entityType: string; metadata: unknown }[]> {
  return db
    .select({
      id: auditEvents.id,
      actorUserId: auditEvents.actorUserId,
      entityType: auditEvents.entityType,
      metadata: auditEvents.metadata,
    })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.entityId, expertProfileId),
        eq(auditEvents.action, 'expert_application.edited')
      )
    )
    .orderBy(asc(auditEvents.createdAt), asc(auditEvents.seq));
}

/** Everything an applicant step could write, for a "DB unchanged" comparison. */
async function readApplicationState(expertProfileId: string): Promise<unknown> {
  const [profile] = await db
    .select()
    .from(expertProfiles)
    .where(eq(expertProfiles.id, expertProfileId));
  const [certs, langs, inds, history] = await Promise.all([
    db
      .select({
        certificationId: expertCertifications.certificationId,
        earnedAt: expertCertifications.earnedAt,
      })
      .from(expertCertifications)
      .where(eq(expertCertifications.expertProfileId, expertProfileId))
      .orderBy(asc(expertCertifications.certificationId)),
    db
      .select({ languageId: expertLanguages.languageId, proficiency: expertLanguages.proficiency })
      .from(expertLanguages)
      .where(eq(expertLanguages.expertProfileId, expertProfileId))
      .orderBy(asc(expertLanguages.languageId)),
    db
      .select({ industryId: expertIndustries.industryId })
      .from(expertIndustries)
      .where(eq(expertIndustries.expertProfileId, expertProfileId))
      .orderBy(asc(expertIndustries.industryId)),
    db
      .select({ role: workHistory.role, company: workHistory.company })
      .from(workHistory)
      .where(eq(workHistory.expertProfileId, expertProfileId)),
  ]);
  return {
    profile,
    competencies: await readCompetencies(expertProfileId),
    certs,
    langs,
    inds,
    history,
  };
}

function expectEdited(
  result: EditApplicationAsStaffResult
): Extract<EditApplicationAsStaffResult, { outcome: 'edited' }> {
  if (result.outcome !== 'edited') {
    throw new Error(`expected outcome 'edited', got '${result.outcome}'`);
  }
  return result;
}

async function edit(
  expertProfileId: string,
  actorUserId: string,
  delta: StaffApplicationEdit
): Promise<EditApplicationAsStaffResult> {
  return expertsRepository.editApplicationAsStaff({ expertProfileId, actorUserId, edit: delta });
}

// ── §status ──────────────────────────────────────────────────────────────────────────────

describe('editApplicationAsStaff — §status', () => {
  it.each(['submitted', 'under_review', 'approved'] as const)(
    'edits a %s application',
    async (status) => {
      const t = await seedTaxonomy();
      const actor = await seedActor();
      const profile = await seedApplication(t, { status });

      const result = expectEdited(
        await edit(profile.id, actor, {
          ratings: [{ productId: t.p1, supportTypeId: t.stA, proficiency: 4 }],
        })
      );

      expect(result.applicationStatus).toBe(status);
      expect(result.applicantUserId).toBe(profile.userId);
      expect(result.sections).toEqual(['ratings']);
    }
  );

  it.each(['draft', 'rejected'] as const)(
    'refuses a %s application with not_editable and writes nothing',
    async (status) => {
      const t = await seedTaxonomy();
      const actor = await seedActor();
      const profile = await seedApplication(t, { status });
      const before = await readApplicationState(profile.id);

      const result = await edit(profile.id, actor, {
        ratings: [{ productId: t.p1, supportTypeId: t.stA, proficiency: 1 }],
        certificationsAdded: [t.cert3],
      });

      expect(result).toEqual({ outcome: 'not_editable', currentStatus: status });
      expect(await readApplicationState(profile.id)).toEqual(before);
      expect(await readEditedAudit(profile.id)).toHaveLength(0);
    }
  );

  it('returns not_found for an unknown profile id', async () => {
    const actor = await seedActor();
    expect(await edit(randomUUID(), actor, { industryIds: [] })).toEqual({
      outcome: 'not_found',
    });
  });

  it('never writes skills_locked, the status or the decided columns', async () => {
    const t = await seedTaxonomy();
    const actor = await seedActor();
    const profile = await seedApplication(t, { status: 'approved' });

    expectEdited(
      await edit(profile.id, actor, {
        experience: { isSalesforceMvp: true },
        certificationsRemoved: [t.cert1],
      })
    );

    const [row] = await db.select().from(expertProfiles).where(eq(expertProfiles.id, profile.id));
    expect(row?.skillsLocked).toBe(profile.skillsLocked);
    expect(row?.applicationStatus).toBe('approved');
    expect(row?.decidedAt).toEqual(profile.decidedAt);
    expect(row?.decidedByUserId).toEqual(profile.decidedByUserId);
  });
});

// ── §atomic ──────────────────────────────────────────────────────────────────────────────

describe('editApplicationAsStaff — §atomic', () => {
  it('a bogus certification id throws and leaves ratings, languages and the audit trail untouched', async () => {
    const t = await seedTaxonomy();
    const actor = await seedActor();
    const profile = await seedApplication(t, { status: 'submitted' });
    const before = await readApplicationState(profile.id);

    await expect(
      edit(profile.id, actor, {
        ratings: [{ productId: t.p1, supportTypeId: t.stA, proficiency: 2 }],
        languages: [{ languageId: t.langDe, proficiency: 'advanced' }],
        certificationsAdded: [randomUUID()],
      })
    ).rejects.toThrow();

    expect(await readApplicationState(profile.id)).toEqual(before);
    expect(await readEditedAudit(profile.id)).toHaveLength(0);
  });
});

// ── §audit ───────────────────────────────────────────────────────────────────────────────

describe('editApplicationAsStaff — §audit', () => {
  it('writes ONE expert_application.edited row with the exact metadata key set', async () => {
    const t = await seedTaxonomy();
    const actor = await seedActor();
    const profile = await seedApplication(t, { status: 'under_review' });

    const result = expectEdited(
      await edit(profile.id, actor, {
        ratings: [{ productId: t.p1, supportTypeId: t.stB, proficiency: 9 }],
        productsRemoved: [t.p2],
        productsAdded: [{ productId: t.p3, ratings: [{ supportTypeId: t.stA, proficiency: 7 }] }],
        certificationsAdded: [t.cert3],
        experience: { projectCountMin: 25 },
      })
    );

    const rows = await readEditedAudit(profile.id);
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row?.id).toBe(result.auditEventId);
    expect(row?.actorUserId).toBe(actor);
    expect(row?.entityType).toBe('expert_profile');
    // ⚠ EXACT KEY SET — `audit_events` is append-only.
    expect(Object.keys(row?.metadata as Record<string, unknown>).sort()).toEqual([
      'applicantUserId',
      'applicationStatus',
      'certifications',
      'counts',
      'experience',
      'industries',
      'languages',
      'productsAdded',
      'productsRemoved',
      'ratings',
      'sections',
    ]);
    expect(row?.metadata).toEqual({
      applicationStatus: 'under_review',
      applicantUserId: profile.userId,
      sections: ['ratings', 'products', 'certifications', 'experience'],
      counts: {
        ratingsAdjusted: 1,
        productsAdded: 1,
        productsRemoved: 1,
        certificationsAdded: 1,
        certificationsRemoved: 0,
      },
      experience: { projectCountMin: { before: 10, after: 25 } },
      languages: null,
      industries: null,
      ratings: [{ productId: t.p1, supportTypeId: t.stB, before: 6, after: 9, selfProficiency: 6 }],
      productsAdded: [{ productId: t.p3, ratings: [{ supportTypeId: t.stA, proficiency: 7 }] }],
      productsRemoved: [
        {
          productId: t.p2,
          ratings: expect.arrayContaining([
            { supportTypeId: t.stA, proficiency: 5, selfProficiency: 5 },
            { supportTypeId: t.stB, proficiency: 3, selfProficiency: 3 },
          ]) as unknown,
        },
      ],
      certifications: { added: [t.cert3], removed: [] },
    });
  });

  it('records the STORED value as before — never a value the client claims', async () => {
    const t = await seedTaxonomy();
    const actor = await seedActor();
    const profile = await seedApplication(t, { status: 'submitted' });
    // A first staff save moves the cell; the second save's "before" must be that stored value.
    expectEdited(
      await edit(profile.id, actor, {
        ratings: [{ productId: t.p1, supportTypeId: t.stA, proficiency: 3 }],
      })
    );
    expectEdited(
      await edit(profile.id, actor, {
        ratings: [{ productId: t.p1, supportTypeId: t.stA, proficiency: 10 }],
      })
    );

    const [, second] = await readEditedAudit(profile.id);
    expect((second?.metadata as { ratings: unknown }).ratings).toEqual([
      { productId: t.p1, supportTypeId: t.stA, before: 3, after: 10, selfProficiency: 8 },
    ]);
  });
});

// ── §products ────────────────────────────────────────────────────────────────────────────

describe('editApplicationAsStaff — §products', () => {
  it('a staff-added product stores selfProficiency NULL; a removed product’s rows are gone', async () => {
    const t = await seedTaxonomy();
    const actor = await seedActor();
    const profile = await seedApplication(t, { status: 'submitted' });

    const result = expectEdited(
      await edit(profile.id, actor, {
        productsAdded: [
          {
            productId: t.p3,
            ratings: [
              { supportTypeId: t.stA, proficiency: 6 },
              { supportTypeId: t.stB, proficiency: 2 },
            ],
          },
        ],
        productsRemoved: [t.p2],
      })
    );

    expect(result.counts).toMatchObject({ productsAdded: 1, productsRemoved: 1 });
    expect(await readCell(profile.id, t.p3, t.stA)).toEqual({
      proficiency: 6,
      selfProficiency: null,
    });
    expect(await readCell(profile.id, t.p3, t.stB)).toEqual({
      proficiency: 2,
      selfProficiency: null,
    });
    const rows = await readCompetencies(profile.id);
    expect(rows.some((r) => r.productId === t.p2)).toBe(false);
    // The untouched product keeps both columns.
    expect(await readCell(profile.id, t.p1, t.stA)).toEqual({ proficiency: 8, selfProficiency: 8 });
  });

  it('re-adding a product already present changes proficiency only and keeps the self-rating', async () => {
    const t = await seedTaxonomy();
    const actor = await seedActor();
    const profile = await seedApplication(t, { status: 'submitted' });

    const result = expectEdited(
      await edit(profile.id, actor, {
        productsAdded: [{ productId: t.p1, ratings: [{ supportTypeId: t.stA, proficiency: 2 }] }],
      })
    );

    expect(result.sections).toEqual(['ratings']);
    expect(result.counts.productsAdded).toBe(0);
    expect(await readCell(profile.id, t.p1, t.stA)).toEqual({ proficiency: 2, selfProficiency: 8 });
  });
});

// ── §ratings ─────────────────────────────────────────────────────────────────────────────

describe('editApplicationAsStaff — §ratings', () => {
  it('writes proficiency and leaves the self-rating as the expert gave it', async () => {
    const t = await seedTaxonomy();
    const actor = await seedActor();
    const profile = await seedApplication(t, { status: 'submitted' });

    const result = expectEdited(
      await edit(profile.id, actor, {
        ratings: [
          { productId: t.p1, supportTypeId: t.stA, proficiency: 3 },
          { productId: t.p2, supportTypeId: t.stB, proficiency: 9 },
        ],
      })
    );

    expect(result.counts.ratingsAdjusted).toBe(2);
    expect(await readCell(profile.id, t.p1, t.stA)).toEqual({ proficiency: 3, selfProficiency: 8 });
    expect(await readCell(profile.id, t.p2, t.stB)).toEqual({ proficiency: 9, selfProficiency: 3 });
    expect(await readCell(profile.id, t.p1, t.stB)).toEqual({ proficiency: 6, selfProficiency: 6 });
  });
});

// ── §certs ───────────────────────────────────────────────────────────────────────────────

describe('editApplicationAsStaff — §certs', () => {
  it('adds and removes certifications and leaves a retained certification’s metadata untouched', async () => {
    const t = await seedTaxonomy();
    const actor = await seedActor();
    const profile = await seedApplication(t, { status: 'approved' });

    expectEdited(
      await edit(profile.id, actor, {
        certificationsAdded: [t.cert3],
        certificationsRemoved: [t.cert2],
      })
    );

    const rows = await db
      .select()
      .from(expertCertifications)
      .where(eq(expertCertifications.expertProfileId, profile.id));
    expect(rows.map((r) => r.certificationId).sort()).toEqual([t.cert1, t.cert3].sort());
    const retained = rows.find((r) => r.certificationId === t.cert1);
    expect(retained?.earnedAt).toBe('2023-04-01');
    expect(retained?.credentialUrl).toBe('https://cred.example/1');
  });
});

// ── §experience / languages / industries ─────────────────────────────────────────────────

describe('editApplicationAsStaff — §experience, languages and industries', () => {
  it('writes changed scalars and the new language and industry sets', async () => {
    const t = await seedTaxonomy();
    const actor = await seedActor();
    const profile = await seedApplication(t, { status: 'submitted' });

    const result = expectEdited(
      await edit(profile.id, actor, {
        experience: { yearStartedSalesforce: 2012, isSalesforceCta: true },
        languages: [
          { languageId: t.langEn, proficiency: 'native' },
          { languageId: t.langDe, proficiency: 'beginner' },
        ],
        industryIds: [t.ind3],
      })
    );

    expect(result.sections).toEqual(['experience']);
    const [row] = await db.select().from(expertProfiles).where(eq(expertProfiles.id, profile.id));
    expect(row?.yearStartedSalesforce).toBe(2012);
    expect(row?.isSalesforceCta).toBe(true);
    expect(row?.projectCountMin).toBe(10);
    const langs = await db
      .select({ languageId: expertLanguages.languageId, proficiency: expertLanguages.proficiency })
      .from(expertLanguages)
      .where(eq(expertLanguages.expertProfileId, profile.id));
    expect(langs).toHaveLength(2);
    expect(langs).toEqual(
      expect.arrayContaining([
        { languageId: t.langEn, proficiency: 'native' },
        { languageId: t.langDe, proficiency: 'beginner' },
      ])
    );
    const inds = await db
      .select({ industryId: expertIndustries.industryId })
      .from(expertIndustries)
      .where(eq(expertIndustries.expertProfileId, profile.id));
    expect(inds).toEqual([{ industryId: t.ind3 }]);
  });
});

// ── §no_changes ──────────────────────────────────────────────────────────────────────────

describe('editApplicationAsStaff — §no_changes', () => {
  it('a delta that matches the stored application writes nothing and records no audit row', async () => {
    const t = await seedTaxonomy();
    const actor = await seedActor();
    const profile = await seedApplication(t, { status: 'approved' });
    const before = await readApplicationState(profile.id);

    const result = await edit(profile.id, actor, {
      experience: { projectCountMin: 10 },
      ratings: [{ productId: t.p1, supportTypeId: t.stA, proficiency: 8 }],
      certificationsAdded: [t.cert1],
      industryIds: [t.ind2, t.ind1],
    });

    expect(result).toEqual({ outcome: 'no_changes', applicationStatus: 'approved' });
    expect(await readApplicationState(profile.id)).toEqual(before);
    expect(await readEditedAudit(profile.id)).toHaveLength(0);
  });
});

// ── §invalid_experience ──────────────────────────────────────────────────────────────────

describe('editApplicationAsStaff — §invalid_experience', () => {
  it('a partial delta that puts the lead count above the stored project count writes nothing and records no audit row', async () => {
    const t = await seedTaxonomy();
    const actor = await seedActor();
    const profile = await seedApplication(t, { status: 'approved' });
    const before = await readApplicationState(profile.id);

    const result = await edit(profile.id, actor, {
      experience: { projectLeadCountMin: 11 },
    });

    expect(result).toEqual({ outcome: 'invalid_experience' });
    expect(await readApplicationState(profile.id)).toEqual(before);
    expect(await readEditedAudit(profile.id)).toHaveLength(0);
  });
});

// ── §readers ─────────────────────────────────────────────────────────────────────────────

describe('editApplicationAsStaff — §readers', () => {
  it('the public and settings reads return the staff-adjusted rating', async () => {
    const t = await seedTaxonomy();
    const actor = await seedActor();
    const profile = await seedApplication(t, { status: 'approved' });
    const username = uniq('reader');
    await db
      .update(expertProfiles)
      .set({ username, searchable: true })
      .where(eq(expertProfiles.id, profile.id));

    expectEdited(
      await edit(profile.id, actor, {
        ratings: [{ productId: t.p1, supportTypeId: t.stA, proficiency: 2 }],
      })
    );

    const isEditedCell = (c: { productId: string; supportTypeId: string }): boolean =>
      c.productId === t.p1 && c.supportTypeId === t.stA;
    const publicProfile = await expertsRepository.findPublicProfileByUsername(username);
    expect(publicProfile?.competencies.find(isEditedCell)?.proficiency).toBe(2);
    const settings = await expertsRepository.findProfileForSettings(profile.id);
    expect(settings?.competencies.find(isEditedCell)?.proficiency).toBe(2);
    const staff = await expertsRepository.findApplicationForStaffReview(profile.id);
    expect(staff?.competencies.find(isEditedCell)?.proficiency).toBe(2);
    expect(staff?.selfRatings.find(isEditedCell)?.selfProficiency).toBe(8);
  });
});

// ── §H1 — the applicant draft gate ───────────────────────────────────────────────────────

/** One write per wizard step, each of which would visibly change the seeded application. */
function stepWrites(t: Taxonomy): ApplicantDraftStepWrite[] {
  return [
    {
      step: 'profile',
      data: {
        yearStartedSalesforce: 2001,
        projectCountMin: 99,
        languages: [],
        industryIds: [],
      },
    },
    { step: 'products', productIds: [t.p3], supportTypeIds: [t.stA, t.stB] },
    { step: 'assessment', ratings: [{ productId: t.p1, supportTypeId: t.stA, proficiency: 10 }] },
    { step: 'certifications', trailheadUrl: 'https://trailblazer.me/id/late', certs: [] },
    {
      step: 'work-history',
      entries: [{ role: 'Late', company: 'Overwrite', startedAt: '2024-01-01', isCurrent: false }],
    },
  ];
}

describe('saveApplicantDraftStep — §H1', () => {
  it.each(['submitted', 'approved'] as const)(
    'refuses every step on a staff-edited %s application outside grace, writing nothing',
    async (status) => {
      const t = await seedTaxonomy();
      const actor = await seedActor();
      const profile = await seedApplication(t, {
        status,
        submittedAt: new Date(Date.now() - 2 * HOUR_MS),
      });
      expectEdited(
        await edit(profile.id, actor, {
          ratings: [{ productId: t.p1, supportTypeId: t.stA, proficiency: 4 }],
        })
      );
      const before = await readApplicationState(profile.id);

      // Every step runs before anything is asserted, so a regression reports all five at once.
      const writes = stepWrites(t);
      const results = [];
      for (const write of writes) {
        const result = await expertsRepository.saveApplicantDraftStep({
          applicantUserId: profile.userId,
          expertProfileId: profile.id,
          draftInput: undefined,
          now: new Date(),
          write,
        });
        results.push({ step: write.step, result });
      }

      expect(results).toEqual(
        writes.map((write) => ({
          step: write.step,
          result: { outcome: 'closed', expertProfileId: profile.id, currentStatus: status },
        }))
      );
      expect(await readApplicationState(profile.id)).toEqual(before);
    }
  );

  it('saves a step on a submitted application inside the grace window', async () => {
    const t = await seedTaxonomy();
    const profile = await seedApplication(t, {
      status: 'submitted',
      submittedAt: new Date(Date.now() - 30_000),
    });

    const result = await expertsRepository.saveApplicantDraftStep({
      applicantUserId: profile.userId,
      expertProfileId: profile.id,
      draftInput: undefined,
      now: new Date(),
      write: {
        step: 'assessment',
        ratings: [{ productId: t.p1, supportTypeId: t.stA, proficiency: 10 }],
      },
    });

    expect(result).toEqual({ outcome: 'saved', expertProfileId: profile.id });
    expect(await readCell(profile.id, t.p1, t.stA)).toEqual({
      proficiency: 10,
      selfProficiency: 10,
    });
  });

  it('refuses a first-save profile step that ADOPTS an existing submitted row', async () => {
    const t = await seedTaxonomy();
    const profile = await seedApplication(t, { status: 'submitted' });
    const before = await readApplicationState(profile.id);

    const result = await expertsRepository.saveApplicantDraftStep({
      applicantUserId: profile.userId,
      expertProfileId: undefined,
      draftInput: {
        userId: profile.userId,
        verticalId: profile.verticalId,
        type: 'freelancer',
        firstName: 'Fresh',
        lastName: 'Tab',
      },
      now: new Date(),
      write: { step: 'profile', data: { projectCountMin: 99, languages: [], industryIds: [] } },
    });

    expect(result).toEqual({
      outcome: 'closed',
      expertProfileId: profile.id,
      currentStatus: 'submitted',
    });
    expect(await readApplicationState(profile.id)).toEqual(before);
  });

  it('creates and saves a draft on a genuine first save', async () => {
    const user = await userFactory();
    const vertical = await referenceDataRepository.getSalesforceVertical();

    const result = await expertsRepository.saveApplicantDraftStep({
      applicantUserId: user.id,
      expertProfileId: undefined,
      draftInput: { userId: user.id, verticalId: vertical.id, type: 'freelancer' },
      now: new Date(),
      write: { step: 'profile', data: { projectCountMin: 7, languages: [], industryIds: [] } },
    });

    if (result.outcome !== 'saved') throw new Error(`expected saved, got ${result.outcome}`);
    const [row] = await db
      .select()
      .from(expertProfiles)
      .where(eq(expertProfiles.id, result.expertProfileId));
    expect(row?.userId).toBe(user.id);
    expect(row?.applicationStatus).toBe('draft');
    expect(row?.projectCountMin).toBe(7);
  });

  it('returns declined for a rejected application and writes nothing', async () => {
    const t = await seedTaxonomy();
    const profile = await seedApplication(t, { status: 'rejected' });
    const before = await readApplicationState(profile.id);

    const result = await expertsRepository.saveApplicantDraftStep({
      applicantUserId: profile.userId,
      expertProfileId: profile.id,
      draftInput: undefined,
      now: new Date(),
      write: { step: 'products', productIds: [t.p3], supportTypeIds: [t.stA] },
    });

    expect(result).toEqual({ outcome: 'declined', expertProfileId: profile.id });
    expect(await readApplicationState(profile.id)).toEqual(before);
  });

  it('returns not_owner for another user’s application and for an unknown id', async () => {
    const t = await seedTaxonomy();
    const profile = await seedApplication(t, { status: 'draft' });
    const stranger = await userFactory();
    const before = await readApplicationState(profile.id);

    const write: ApplicantDraftStepWrite = {
      step: 'products',
      productIds: [t.p3],
      supportTypeIds: [t.stA],
    };
    expect(
      await expertsRepository.saveApplicantDraftStep({
        applicantUserId: stranger.id,
        expertProfileId: profile.id,
        draftInput: undefined,
        now: new Date(),
        write,
      })
    ).toEqual({ outcome: 'not_owner' });
    expect(
      await expertsRepository.saveApplicantDraftStep({
        applicantUserId: profile.userId,
        expertProfileId: randomUUID(),
        draftInput: undefined,
        now: new Date(),
        write,
      })
    ).toEqual({ outcome: 'not_owner' });
    expect(await readApplicationState(profile.id)).toEqual(before);
  });

  it('runs every step on a draft, writing the self-rating with the rating', async () => {
    const t = await seedTaxonomy();
    const profile = await seedApplication(t, { status: 'draft' });

    for (const write of [...stepWrites(t), { step: 'none' } as const]) {
      const result = await expertsRepository.saveApplicantDraftStep({
        applicantUserId: profile.userId,
        expertProfileId: profile.id,
        draftInput: undefined,
        now: new Date(),
        write,
      });
      expect({ step: write.step, result }).toEqual({
        step: write.step,
        result: { outcome: 'saved', expertProfileId: profile.id },
      });
    }

    const [row] = await db.select().from(expertProfiles).where(eq(expertProfiles.id, profile.id));
    expect(row?.projectCountMin).toBe(99);
    expect(row?.trailheadUrl).toBe('https://trailblazer.me/id/late');
    // `products` replaced P1/P2 with P3 at 0/0; `assessment` then rated P1 afresh.
    expect(await readCell(profile.id, t.p3, t.stA)).toEqual({ proficiency: 0, selfProficiency: 0 });
    expect(await readCell(profile.id, t.p1, t.stA)).toEqual({
      proficiency: 10,
      selfProficiency: 10,
    });
    const history = await db
      .select({ role: workHistory.role })
      .from(workHistory)
      .where(eq(workHistory.expertProfileId, profile.id));
    expect(history).toEqual([{ role: 'Late' }]);
  });

  it('throws when a non-profile step arrives without an id', async () => {
    const user = await userFactory();
    await expect(
      expertsRepository.saveApplicantDraftStep({
        applicantUserId: user.id,
        expertProfileId: undefined,
        draftInput: undefined,
        now: new Date(),
        write: { step: 'none' },
      })
    ).rejects.toThrow();
  });
});
