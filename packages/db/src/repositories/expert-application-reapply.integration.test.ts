import { describe, it, expect } from 'vitest';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { db } from '../client';
import {
  auditEvents,
  expertApplicationDecisions,
  expertCompetency,
  expertProfiles,
  platformSettings,
  products,
  supportTypes,
  workHistory,
  type ExpertProfile,
} from '../schema';
import { reapplyAvailableAt } from '@balo/shared/experts';
import { expertDraftFactory, userFactory } from '../test/factories';
import { expertsRepository, type ReopenApplicationResult } from './experts';
import { referenceDataRepository } from './reference-data';

/**
 * BAL-557 — RE-APPLICATION AFTER A DECLINE, end to end against real Postgres:
 * `draft → submitted → rejected → draft (reopenApplication) → submitted`.
 *
 * Every transition here goes through the domain path (`submitApplication`, `decideApplication`,
 * `reopenApplication`, `saveApplicantDraftStep`), never a fixture UPDATE, except where a test
 * deliberately shapes a legacy row.
 *
 * Same harness limit as `expert-application-decision.integration.test.ts`: every test runs in
 * ONE outer transaction on a `max: 1` pool, so concurrency is inexpressible here; the row lock
 * is exercised for ordering by `expert-settings-serialization.concurrency.integration.test.ts`.
 */

const DAY_MS = 86_400_000;
/** Mirrors `UTC_PLUS_14_OFFSET_MS` in `reapply-cooldown.ts` — the gate opens this far early. */
const UTC_PLUS_14_OFFSET_MS = 14 * 60 * 60 * 1000;
const NOTE_TEXT = 'Staff-only: two projects, both as an admin.';

async function seedStaff(): Promise<string> {
  return (await userFactory({ platformRole: 'admin' })).id;
}

async function readProfile(expertProfileId: string): Promise<ExpertProfile> {
  const [row] = await db
    .select()
    .from(expertProfiles)
    .where(eq(expertProfiles.id, expertProfileId));
  if (row === undefined) throw new Error(`profile not found: ${expertProfileId}`);
  return row;
}

async function readAudit(
  expertProfileId: string
): Promise<{ id: string; action: string; actorUserId: string | null; metadata: unknown }[]> {
  return db
    .select({
      id: auditEvents.id,
      action: auditEvents.action,
      actorUserId: auditEvents.actorUserId,
      metadata: auditEvents.metadata,
    })
    .from(auditEvents)
    .where(
      and(eq(auditEvents.entityType, 'expert_profile'), eq(auditEvents.entityId, expertProfileId))
    )
    .orderBy(asc(auditEvents.createdAt), asc(auditEvents.seq));
}

async function setCooldownDays(value: unknown): Promise<void> {
  await db
    .update(platformSettings)
    .set({ value })
    .where(
      and(
        eq(platformSettings.key, 'expert_reapply_cooldown_days'),
        isNull(platformSettings.deletedAt)
      )
    );
}

function transition(profile: ExpertProfile, now: Date = new Date()) {
  return { applicantUserId: profile.userId, verticalId: profile.verticalId, now };
}

async function submit(profile: ExpertProfile, now: Date = new Date()) {
  const result = await expertsRepository.submitApplication(transition(profile, now));
  if (result.outcome !== 'submitted') throw new Error(`expected submitted, got ${result.outcome}`);
  return result;
}

async function decline(profile: ExpertProfile, actorUserId: string) {
  const result = await expertsRepository.decideApplication({
    expertProfileId: profile.id,
    actorUserId,
    decision: 'decline',
    reason: 'experience_depth',
    note: NOTE_TEXT,
  });
  if (result.outcome !== 'decided') throw new Error(`expected decided, got ${result.outcome}`);
  return result;
}

function expectReopened(
  result: ReopenApplicationResult
): Extract<ReopenApplicationResult, { outcome: 'reopened' }> {
  if (result.outcome !== 'reopened') throw new Error(`expected reopened, got ${result.outcome}`);
  return result;
}

/** A moment safely past any cooldown the default setting allows. */
function farFuture(): Date {
  return new Date(Date.now() + 400 * DAY_MS);
}

async function seedTaxonomy(): Promise<{
  productA: string;
  productB: string;
  productC: string;
  support: string;
}> {
  const vertical = await referenceDataRepository.getSalesforceVertical();
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const productRows = await db
    .insert(products)
    .values([
      { verticalId: vertical.id, name: 'Sales Cloud', slug: `reapply-a-${suffix}` },
      { verticalId: vertical.id, name: 'Service Cloud', slug: `reapply-b-${suffix}` },
      { verticalId: vertical.id, name: 'Marketing Cloud', slug: `reapply-c-${suffix}` },
    ])
    .returning({ id: products.id });
  const [support] = await db
    .insert(supportTypes)
    .values({ verticalId: vertical.id, name: 'Build', slug: `reapply-build-${suffix}` })
    .returning({ id: supportTypes.id });
  const [productA, productB, productC] = productRows.map((r) => r.id);
  if (
    productA === undefined ||
    productB === undefined ||
    productC === undefined ||
    support === undefined
  ) {
    throw new Error('seedTaxonomy: insert returned too few rows');
  }
  return { productA, productB, productC, support: support.id };
}

async function readCell(
  expertProfileId: string,
  productId: string
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
        eq(expertCompetency.productId, productId)
      )
    );
  return row;
}

async function readCompetencyRow(
  expertProfileId: string,
  productId: string
): Promise<
  { proficiency: number; selfProficiency: number | null; updatedAt: Date | string } | undefined
> {
  const [row] = await db
    .select({
      proficiency: expertCompetency.proficiency,
      selfProficiency: expertCompetency.selfProficiency,
      updatedAt: expertCompetency.updatedAt,
    })
    .from(expertCompetency)
    .where(
      and(
        eq(expertCompetency.expertProfileId, expertProfileId),
        eq(expertCompetency.productId, productId)
      )
    );
  return row;
}

const WORK_ENTRY = {
  role: 'Salesforce Architect',
  company: 'Northwind',
  startedAt: '2022-01-01',
  isCurrent: true,
};

describe('re-application — the full cycle', () => {
  it('declined applicant reopens, edits and resubmits, and is back in the pending queue', async () => {
    const staff = await seedStaff();
    const draft = await expertDraftFactory();
    const firstSubmit = await submit(draft, new Date(Date.now() - 5 * DAY_MS));
    const decided = await decline(draft, staff);
    const declinedProfile = await readProfile(draft.id);

    const reopened = expectReopened(
      await expertsRepository.reopenApplication(transition(draft, farFuture()))
    );
    expect(reopened.expertProfileId).toBe(draft.id);
    expect(reopened.decidedAt).toEqual(declinedProfile.decidedAt);

    // The archive row carries every floor column from the declined row.
    const [archived] = await db
      .select()
      .from(expertApplicationDecisions)
      .where(eq(expertApplicationDecisions.expertProfileId, draft.id));
    expect(archived).toMatchObject({
      id: reopened.archivedDecisionId,
      decision: 'declined',
      decidedAt: declinedProfile.decidedAt,
      decidedByUserId: staff,
      declineReason: 'experience_depth',
      declineNote: NOTE_TEXT,
      submittedAt: firstSubmit.submittedAt,
    });

    // The profile is a draft again, with the floor and the submission cleared.
    const reopenedProfile = await readProfile(draft.id);
    expect(reopenedProfile).toMatchObject({
      applicationStatus: 'draft',
      decidedAt: null,
      decidedByUserId: null,
      declineReason: null,
      declineNote: null,
      submittedAt: null,
      approvedAt: null,
    });

    // The applicant can write again.
    const saved = await expertsRepository.saveApplicantDraftStep({
      applicantUserId: draft.userId,
      expertProfileId: draft.id,
      draftInput: undefined,
      now: new Date(),
      write: { step: 'work-history', entries: [WORK_ENTRY] },
    });
    expect(saved).toEqual({ outcome: 'saved', expertProfileId: draft.id });

    // Resubmit: fresh submitted_at, back in the pending list.
    const resubmitAt = new Date();
    const resubmit = await submit(draft, resubmitAt);
    expect(resubmit.submittedAt).toEqual(resubmitAt);
    expect((await readProfile(draft.id)).submittedAt).toEqual(resubmitAt);

    const pending = await expertsRepository.listApplicationsForReview({
      filter: 'pending',
      decidedSince: new Date(0),
      limit: 500,
    });
    expect(pending.rows.map((r) => r.expertProfileId)).toContain(draft.id);

    // The audit trail, in order — submitted, declined, reopened, submitted.
    const audit = await readAudit(draft.id);
    expect(audit.map((a) => a.action)).toEqual([
      'expert_application.submitted',
      'expert_application.declined',
      'expert_application.reopened',
      'expert_application.submitted',
    ]);
    expect(audit[1]?.id).toBe(decided.auditEventId);
  });

  it('two submits of one profile return two distinct audit ids (one email each)', async () => {
    const staff = await seedStaff();
    const draft = await expertDraftFactory();

    const first = await submit(draft);
    await decline(draft, staff);
    expectReopened(await expertsRepository.reopenApplication(transition(draft, farFuture())));
    const second = await submit(draft);

    expect(first.auditEventId).toMatch(/^[0-9a-f-]{36}$/);
    expect(second.auditEventId).toMatch(/^[0-9a-f-]{36}$/);
    expect(second.auditEventId).not.toBe(first.auditEventId);
    const submittedIds = (await readAudit(draft.id))
      .filter((a) => a.action === 'expert_application.submitted')
      .map((a) => a.id);
    expect(submittedIds).toEqual([first.auditEventId, second.auditEventId]);
  });
});

describe('re-application — the audit rows', () => {
  it('submit records a fixed metadata key set, resubmission false then true', async () => {
    const staff = await seedStaff();
    const draft = await expertDraftFactory();

    await submit(draft);
    await decline(draft, staff);
    expectReopened(await expertsRepository.reopenApplication(transition(draft, farFuture())));
    await submit(draft);

    const submits = (await readAudit(draft.id)).filter(
      (a) => a.action === 'expert_application.submitted'
    );
    expect(submits).toEqual([
      expect.objectContaining({
        actorUserId: draft.userId,
        metadata: { previousStatus: 'draft', applicantUserId: draft.userId, resubmission: false },
      }),
      expect.objectContaining({
        actorUserId: draft.userId,
        metadata: { previousStatus: 'draft', applicantUserId: draft.userId, resubmission: true },
      }),
    ]);
  });

  it('reopen records a fixed metadata key set and never the note', async () => {
    const staff = await seedStaff();
    const draft = await expertDraftFactory();
    await submit(draft);
    await decline(draft, staff);
    await setCooldownDays(0);

    const reopened = expectReopened(
      await expertsRepository.reopenApplication(transition(draft, new Date()))
    );

    const row = (await readAudit(draft.id)).find((a) => a.action === 'expert_application.reopened');
    expect(row).toEqual({
      id: reopened.auditEventId,
      action: 'expert_application.reopened',
      actorUserId: draft.userId,
      metadata: {
        previousStatus: 'rejected',
        applicantUserId: draft.userId,
        archivedDecisionId: reopened.archivedDecisionId,
        cooldownDays: 0,
        ratingsReset: 0,
      },
    });
    expect(JSON.stringify(row?.metadata)).not.toContain(NOTE_TEXT);
  });
});

describe('re-application — the cooldown', () => {
  it('refuses while the configured cooldown runs, with the date it ends', async () => {
    const staff = await seedStaff();
    const draft = await expertDraftFactory();
    await submit(draft);
    await decline(draft, staff);
    await setCooldownDays(10);
    const decidedAt = (await readProfile(draft.id)).decidedAt;
    if (decidedAt === null) throw new Error('decline left decided_at NULL');
    const availableAt = reapplyAvailableAt(decidedAt, 10);
    if (availableAt === null) throw new Error('expected an availableAt');

    const result = await expertsRepository.reopenApplication(
      transition(draft, new Date(availableAt.getTime() - UTC_PLUS_14_OFFSET_MS - 1))
    );

    expect(result).toEqual({
      outcome: 'cooldown_active',
      availableAt,
    });
    expect((await readProfile(draft.id)).applicationStatus).toBe('rejected');
    await expect(
      db
        .select()
        .from(expertApplicationDecisions)
        .where(eq(expertApplicationDecisions.expertProfileId, draft.id))
    ).resolves.toEqual([]);
  });

  it('reopens once the 14h-early gate opens', async () => {
    const staff = await seedStaff();
    const draft = await expertDraftFactory();
    await submit(draft);
    await decline(draft, staff);
    await setCooldownDays(10);
    const decidedAt = (await readProfile(draft.id)).decidedAt;
    if (decidedAt === null) throw new Error('decline left decided_at NULL');
    const availableAt = reapplyAvailableAt(decidedAt, 10);
    if (availableAt === null) throw new Error('expected an availableAt');

    const result = await expertsRepository.reopenApplication(
      transition(draft, new Date(availableAt.getTime() - UTC_PLUS_14_OFFSET_MS))
    );

    expect(result.outcome).toBe('reopened');
  });

  it('uses the 60-day default when the stored value is invalid', async () => {
    const staff = await seedStaff();
    const draft = await expertDraftFactory();
    await submit(draft);
    await decline(draft, staff);
    await setCooldownDays('abc');
    const decidedAt = (await readProfile(draft.id)).decidedAt;
    if (decidedAt === null) throw new Error('decline left decided_at NULL');
    const availableAt = reapplyAvailableAt(decidedAt, 60);
    if (availableAt === null) throw new Error('expected an availableAt');

    const result = await expertsRepository.reopenApplication(
      transition(draft, new Date(availableAt.getTime() - UTC_PLUS_14_OFFSET_MS - 1))
    );

    expect(result).toEqual({
      outcome: 'cooldown_active',
      availableAt,
    });
  });

  it('reopens a legacy decline with no decided_at at once, archiving its NULLs', async () => {
    const draft = await expertDraftFactory();
    await db
      .update(expertProfiles)
      .set({ applicationStatus: 'rejected' })
      .where(eq(expertProfiles.id, draft.id));

    const reopened = expectReopened(
      await expertsRepository.reopenApplication(transition(draft, new Date()))
    );

    expect(reopened.decidedAt).toBeNull();
    const [archived] = await db
      .select()
      .from(expertApplicationDecisions)
      .where(eq(expertApplicationDecisions.id, reopened.archivedDecisionId));
    expect(archived).toMatchObject({
      decidedAt: null,
      decidedByUserId: null,
      declineReason: null,
      declineNote: null,
      submittedAt: null,
    });
  });
});

describe('re-application — refusals', () => {
  it('a caller with no application of their own cannot reopen or submit anyone else', async () => {
    const staff = await seedStaff();
    const owner = await expertDraftFactory();
    await submit(owner);
    await decline(owner, staff);
    const before = await readProfile(owner.id);
    const intruder = await userFactory();

    const asIntruder = {
      applicantUserId: intruder.id,
      verticalId: owner.verticalId,
      now: farFuture(),
    };
    await expect(expertsRepository.reopenApplication(asIntruder)).resolves.toEqual({
      outcome: 'not_found',
    });
    await expect(expertsRepository.submitApplication(asIntruder)).resolves.toEqual({
      outcome: 'not_found',
    });

    expect(await readProfile(owner.id)).toEqual(before);
    expect((await readAudit(owner.id)).map((a) => a.action)).toEqual([
      'expert_application.submitted',
      'expert_application.declined',
    ]);
  });

  it('a reopen of a draft (double click, second tab) is not_rejected and writes nothing', async () => {
    const draft = await expertDraftFactory();

    await expect(
      expertsRepository.reopenApplication(transition(draft, farFuture()))
    ).resolves.toEqual({ outcome: 'not_rejected', currentStatus: 'draft' });
    await expect(readAudit(draft.id)).resolves.toEqual([]);
  });

  it('a second submit is not_draft and records nothing', async () => {
    const draft = await expertDraftFactory();
    await submit(draft);

    await expect(expertsRepository.submitApplication(transition(draft))).resolves.toEqual({
      outcome: 'not_draft',
      expertProfileId: draft.id,
      currentStatus: 'submitted',
    });
    expect(await readAudit(draft.id)).toHaveLength(1);
  });

  it('a stale tab cannot write to or submit a still-rejected profile; after reopen it can', async () => {
    const staff = await seedStaff();
    const draft = await expertDraftFactory();
    await submit(draft);
    await decline(draft, staff);
    const staleWrite = {
      applicantUserId: draft.userId,
      expertProfileId: draft.id,
      draftInput: undefined,
      now: new Date(),
      write: { step: 'work-history' as const, entries: [WORK_ENTRY] },
    };

    await expect(expertsRepository.saveApplicantDraftStep(staleWrite)).resolves.toEqual({
      outcome: 'declined',
      expertProfileId: draft.id,
    });
    await expect(
      db.select().from(workHistory).where(eq(workHistory.expertProfileId, draft.id))
    ).resolves.toEqual([]);
    await expect(expertsRepository.submitApplication(transition(draft))).resolves.toEqual({
      outcome: 'not_draft',
      expertProfileId: draft.id,
      currentStatus: 'rejected',
    });

    expectReopened(await expertsRepository.reopenApplication(transition(draft, farFuture())));

    await expect(expertsRepository.saveApplicantDraftStep(staleWrite)).resolves.toEqual({
      outcome: 'saved',
      expertProfileId: draft.id,
    });
  });
});

describe('re-application — the ratings', () => {
  it("resets each self-rated cell to the applicant's own rating and keeps a staff-added product", async () => {
    const staff = await seedStaff();
    const draft = await expertDraftFactory();
    const t = await seedTaxonomy();
    await expertsRepository.updateCompetencyProficiency(draft.id, [
      { productId: t.productA, supportTypeId: t.support, proficiency: 6 },
      { productId: t.productC, supportTypeId: t.support, proficiency: 7 },
    ]);
    await submit(draft);
    // Staff adjusted the applicant's rating, and added a product of their own. Product C's
    // self-rating is left exactly as the applicant set it — staff made no adjustment there.
    await db
      .update(expertCompetency)
      .set({ proficiency: 3 })
      .where(
        and(
          eq(expertCompetency.expertProfileId, draft.id),
          eq(expertCompetency.productId, t.productA)
        )
      );
    await db.insert(expertCompetency).values({
      expertProfileId: draft.id,
      productId: t.productB,
      supportTypeId: t.support,
      proficiency: 8,
      selfProficiency: null,
    });
    const unchangedBefore = await readCompetencyRow(draft.id, t.productC);
    await decline(draft, staff);

    const reopened = expectReopened(
      await expertsRepository.reopenApplication(transition(draft, farFuture()))
    );

    expect(await readCell(draft.id, t.productA)).toEqual({ proficiency: 6, selfProficiency: 6 });
    expect(await readCell(draft.id, t.productB)).toEqual({ proficiency: 8, selfProficiency: null });
    // Already equal to its own self-rating — not counted, and its row is left untouched.
    const unchangedAfter = await readCompetencyRow(draft.id, t.productC);
    expect(unchangedAfter).toEqual({
      proficiency: 7,
      selfProficiency: 7,
      updatedAt: unchangedBefore?.updatedAt,
    });
    const row = (await readAudit(draft.id)).find((a) => a.id === reopened.auditEventId);
    expect(row?.metadata).toMatchObject({ ratingsReset: 1 });
  });
});
