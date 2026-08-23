import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../client';
import {
  auditEvents,
  caseEngagementProducts,
  caseEngagements,
  companies,
  companyMembers,
  conversationContexts,
  engagements,
  products,
  reviews,
  verticals,
  type AuditEvent,
} from '../schema';
import {
  caseEngagementFactory,
  companyFactory,
  companyMemberFactory,
  engagementFactory,
  expertDraftFactory,
  meetingFactory,
  userFactory,
} from '../test/factories';
import {
  caseEngagementsRepository,
  CaseAlreadyClosedError,
  CaseCloserNotMemberError,
} from './case-engagements';
import { EngagementTypeMismatchError } from './_shared/engagement-supertype';
import { conversationsRepository } from './conversations';
import { softDeleteEngagementFixture } from '../test/helpers/soft-delete-engagement';
import {
  expectCheckViolation,
  expectConstraintViolation,
} from '../test/helpers/expect-check-violation';

/** Delivery audit rows for one entity (BAL-344 generic table, ordered createdAt asc). */
async function auditEventsForEntity(entityId: string): Promise<AuditEvent[]> {
  return db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.entityId, entityId))
    .orderBy(asc(auditEvents.createdAt), asc(auditEvents.id));
}

async function seedCompanyId(): Promise<string> {
  const [company] = await db
    .insert(companies)
    .values({ name: 'Acme Co', isPersonal: true })
    .returning();
  if (company === undefined) throw new Error('company insert failed');
  return company.id;
}

describe('caseEngagementsRepository.create', () => {
  it('writes BOTH rows: parent engagement_type=case + status=active, child title/description verbatim', async () => {
    const companyId = await seedCompanyId();
    const expert = await expertDraftFactory();

    const created = await caseEngagementsRepository.create({
      companyId,
      expertProfileId: expert.id,
      title: 'Flow fails on record update',
      description: '<p>The <strong>after-save</strong> flow errors.</p>',
    });

    expect(created.companyId).toBe(companyId);
    expect(created.expertProfileId).toBe(expert.id);
    expect(created.status).toBe('active');
    expect(created.title).toBe('Flow fails on record update');
    expect(created.description).toBe('<p>The <strong>after-save</strong> flow errors.</p>');
    expect(created.closedAt).toBeNull();
    expect(created.closeReason).toBeNull();
    expect(created.closedByUserId).toBeNull();
    expect(created.activatedAt).toBeInstanceOf(Date);

    const [parent] = await db.select().from(engagements).where(eq(engagements.id, created.id));
    expect(parent?.engagementType).toBe('case');
    expect(parent?.status).toBe('active');
    const [child] = await db
      .select()
      .from(caseEngagements)
      .where(eq(caseEngagements.engagementId, created.id));
    expect(child?.engagementType).toBe('case');
    expect(child?.title).toBe('Flow fails on record update');
  });

  it('BAL-424 — provisions an engagement-anchored conversation with NO relationship row anywhere', async () => {
    const companyId = await seedCompanyId();
    const expert = await expertDraftFactory();

    const created = await caseEngagementsRepository.create({
      companyId,
      expertProfileId: expert.id,
      title: 'A case can be talked about',
      description: '<p>x</p>',
    });

    const conversation = await conversationsRepository.findByContext({
      contextType: 'engagement',
      contextId: created.id,
    });
    if (conversation === undefined) throw new Error('expected a provisioned conversation');

    // The AC, asserted directly: exactly one live context, on the `engagement` label, and
    // the thread names no relationship at all — a Case never passes through origination.
    const contexts = await conversationsRepository.listContexts(conversation.id);
    expect(contexts).toHaveLength(1);
    expect(contexts[0]?.contextType).toBe('engagement');
    expect(contexts[0]?.contextId).toBe(created.id);

    const relationshipContexts = await db
      .select({ id: conversationContexts.id })
      .from(conversationContexts)
      .where(
        and(
          eq(conversationContexts.conversationId, conversation.id),
          eq(conversationContexts.contextType, 'relationship')
        )
      );
    expect(relationshipContexts).toHaveLength(0);
  });

  it('(b) the PARENT row it writes has balo_fee_bps IS NULL — read RAW, not through the strip', async () => {
    // ⚠ READ THE PARENT COLUMN DIRECTLY. `CaseEngagementRow`'s `Omit` and `toCaseRow`'s
    // strip both hide the key from the case path, but neither stops a REPORTING QUERY,
    // AN ADMIN SURFACE OR A RECONCILIATION SCRIPT doing a raw
    // `db.select().from(engagements)` and reading a credible-but-WRONG 2500 that was
    // never charged at that rate. NULL is what makes that unreadable, and only a raw
    // read of the stored column proves it.
    const companyId = await seedCompanyId();
    const expert = await expertDraftFactory();

    const created = await caseEngagementsRepository.create({
      companyId,
      expertProfileId: expert.id,
      title: 'Fee must be NULL on a case',
      description: '<p>x</p>',
    });

    const [raw] = await db
      .select({ baloFeeBps: engagements.baloFeeBps })
      .from(engagements)
      .where(eq(engagements.id, created.id));
    expect(raw?.baloFeeBps).toBeNull();

    // And the same read scoped the way a reporting query would scope it.
    const caseRows = await db
      .select({ baloFeeBps: engagements.baloFeeBps })
      .from(engagements)
      .where(and(eq(engagements.engagementType, 'case'), isNull(engagements.deletedAt)));
    expect(caseRows.length).toBeGreaterThan(0);
    expect(caseRows.every((r) => r.baloFeeBps === null)).toBe(true);
  });

  it('(c) a raw case INSERT that CARRIES a fee is REJECTED (23514), including via the DEFAULT', async () => {
    const companyId = await seedCompanyId();
    const expert = await expertDraftFactory();

    // Explicit fee → rejected.
    await expectCheckViolation(sql`
      INSERT INTO engagements (engagement_type, company_id, expert_profile_id, balo_fee_bps)
      VALUES ('case', ${companyId}::uuid, ${expert.id}::uuid, 2500)
    `);

    // OMITTED fee → falls through to the column DEFAULT (2500) → ALSO rejected. This is
    // the whole reason the DEFAULT was kept rather than dropped: a case writer that
    // forgets to pass `null` fails LOUDLY here instead of silently storing an uncharged
    // 2500. (`caseEngagementsRepository.create` passes `baloFeeBps: null` explicitly.)
    await expectCheckViolation(sql`
      INSERT INTO engagements (engagement_type, company_id, expert_profile_id)
      VALUES ('case', ${companyId}::uuid, ${expert.id}::uuid)
    `);

    // A raw UPDATE putting a fee back onto a LIVE case is rejected too — the invariant
    // is not just an insert-time one.
    const { engagement } = await caseEngagementFactory();
    await expectCheckViolation(sql`
      UPDATE engagements SET balo_fee_bps = 2500 WHERE id = ${engagement.id}::uuid
    `);
  });

  it('writes exactly ONE engagement.created audit row with engagement_type=case metadata', async () => {
    const companyId = await seedCompanyId();
    const expert = await expertDraftFactory();

    const created = await caseEngagementsRepository.create({
      companyId,
      expertProfileId: expert.id,
      title: 'Audited at birth',
      description: '<p>x</p>',
    });

    const events = await auditEventsForEntity(created.id);
    const createdEvents = events.filter((e) => e.action === 'engagement.created');
    expect(createdEvents).toHaveLength(1);
    const [createdEvent] = createdEvents;
    expect(createdEvent?.entityType).toBe('engagement');
    expect(createdEvent?.entityId).toBe(created.id);
    // ADR-1030 SYSTEM-ACTOR ATTRIBUTION EXEMPTION: BAL-417 ships no live case producer
    // (D4), so no caller has a human actor to name and `actorUserId` stays NULL rather
    // than being fabricated. BAL-400's booking surface passes `actorUserId`.
    expect(createdEvent?.actorUserId).toBeNull();
    // The DISCRIMINATOR: `engagement.created` is type-agnostic, so only the metadata
    // tells a downstream reader a Case (not a Project) was created.
    expect(createdEvent?.metadata).toMatchObject({
      engagement_type: 'case',
      engagementId: created.id,
    });
  });

  it('attributes engagement.created to the actor when one is supplied', async () => {
    const companyId = await seedCompanyId();
    const expert = await expertDraftFactory();
    const actor = await userFactory();

    const created = await caseEngagementsRepository.create({
      companyId,
      expertProfileId: expert.id,
      title: 'Attributed',
      description: '<p>x</p>',
      actorUserId: actor.id,
    });

    const [createdEvent] = (await auditEventsForEntity(created.id)).filter(
      (e) => e.action === 'engagement.created'
    );
    expect(createdEvent?.actorUserId).toBe(actor.id);
  });

  it('the returned CaseEngagementRow has NO baloFeeBps key and its createdAt is the PARENT’s', async () => {
    // ⚠ D3: `credit_sessions.balo_fee_bps` is the SSOT for a case's margin. The
    // supertype column exists but is never charged on a case, so it is made
    // UNREACHABLE from the case path rather than merely documented.
    //
    // ⚠ ASSERTED ON PRODUCTION `create()`, NOT ON THE FACTORY. `Omit<…,'baloFeeBps'>`
    // hides the key from TypeScript but does NOT stop it serialising across a Server
    // Action boundary, and object spreads bypass excess-property checking — so deleting
    // the strip in `toCaseRow` compiles clean. Only a runtime key assertion over a
    // PRODUCTION return value catches that.
    const companyId = await seedCompanyId();
    const expert = await expertDraftFactory();
    const created = await caseEngagementsRepository.create({
      companyId,
      expertProfileId: expert.id,
      title: 'Margin must not leak',
      description: '<p>x</p>',
    });

    expect(created).not.toHaveProperty('baloFeeBps');
    // EXACT KEY SET, not just the absence of one key: an ADDITION to this projection is
    // compile-invisible the same way a deletion of the strip is, and BAL-421 hands this
    // shape to a client surface.
    expect(Object.keys(created).sort()).toEqual(
      [
        'activatedAt',
        'closeReason',
        'closedAt',
        'closedByUserId',
        'companyId',
        'createdAt',
        'currency',
        'deletedAt',
        'description',
        'engagementType',
        'expertProfileId',
        'id',
        'resolutionRequestedAt',
        'resolutionRequestedByUserId',
        'status',
        'title',
        'updatedAt',
      ].sort()
    );

    const [parent] = await db.select().from(engagements).where(eq(engagements.id, created.id));
    // The inactivity clock is the PARENT's created_at — the same column
    // `listOpenCreatedBefore` filters on, so the candidate scan and `isCaseInactive`
    // cannot diverge on two clocks.
    expect(created.createdAt.getTime()).toBe(parent?.createdAt.getTime());

    // The other two production reads fold through the SAME `toCaseRow`; pin them too,
    // so a strip deleted on one path cannot hide behind the others.
    const found = await caseEngagementsRepository.findByEngagementId(created.id);
    expect(found).not.toHaveProperty('baloFeeBps');
    const [listed] = await caseEngagementsRepository.listOpenCreatedBefore(
      new Date(Date.now() + 60_000)
    );
    expect(listed).not.toHaveProperty('baloFeeBps');
  });

  it('rejects a blank/whitespace title (CHECK 23514)', async () => {
    const companyId = await seedCompanyId();
    const expert = await expertDraftFactory();
    await expect(
      caseEngagementsRepository.create({
        companyId,
        expertProfileId: expert.id,
        title: '   ',
        description: '<p>x</p>',
      })
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('rejects a blank description (CHECK 23514)', async () => {
    const companyId = await seedCompanyId();
    const expert = await expertDraftFactory();
    await expect(
      caseEngagementsRepository.create({
        companyId,
        expertProfileId: expert.id,
        title: 'Real title',
        description: '',
      })
    ).rejects.toMatchObject({ code: '23514' });
  });
});

describe('caseEngagementsRepository.findByEngagementId', () => {
  it('returns a live case and excludes soft-deleted / project ids / unknown ids', async () => {
    const { engagement } = await caseEngagementFactory();
    expect((await caseEngagementsRepository.findByEngagementId(engagement.id))?.id).toBe(
      engagement.id
    );

    const { engagement: project } = await engagementFactory();
    expect(await caseEngagementsRepository.findByEngagementId(project.id)).toBeUndefined();

    await softDeleteEngagementFixture(engagement.id);
    expect(await caseEngagementsRepository.findByEngagementId(engagement.id)).toBeUndefined();
  });
});

describe('caseEngagementsRepository.close — the closed_by_user_id MEMBERSHIP INVARIANT', () => {
  // ⚠ THIS BLOCK PROVES A DATA-INTEGRITY INVARIANT, NOT AN AUTHORIZATION GATE.
  // `close()` resolves no capability and compares no role — it asserts only that
  // `closed_by_user_id` is a LIVE member of `engagements.company_id`, i.e. that the
  // ROW IS COHERENT. The AUTHORIZATION rule (`hasCapability(actor, PARTICIPATE,
  // { companyId })`) lives in BAL-421's close server action.

  it('(a) a LIVE member of the contracting company closes: parent → completed, child stamped, audit written', async () => {
    const { engagement, clientMemberUserId } = await caseEngagementFactory({
      withClientMember: true,
    });
    if (clientMemberUserId === undefined) throw new Error('expected a seeded client member');

    const closed = await caseEngagementsRepository.close({
      engagementId: engagement.id,
      reason: 'resolved',
      userId: clientMemberUserId,
    });

    expect(closed.status).toBe('completed');
    expect(closed.closedAt).toBeInstanceOf(Date);
    expect(closed.closedByUserId).toBe(clientMemberUserId);
    expect(closed.closeReason).toBe('resolved');

    const [parent] = await db.select().from(engagements).where(eq(engagements.id, engagement.id));
    expect(parent?.status).toBe('completed');

    const events = await auditEventsForEntity(engagement.id);
    const closeEvent = events.find((e) => e.action === 'engagement.case_closed');
    expect(closeEvent).toBeDefined();
    expect(closeEvent?.entityType).toBe('engagement');
    expect(closeEvent?.actorUserId).toBe(clientMemberUserId);
    expect(closeEvent?.metadata).toMatchObject({
      close_reason: 'resolved',
      from: 'active',
      to: 'completed',
      engagementId: engagement.id,
    });
  });

  it('(b) THE DELIVERING EXPERT CANNOT CLOSE → CaseCloserNotMemberError, nothing mutated', async () => {
    // The headline AC, made true by the INVARIANT: the delivering expert holds no
    // membership in the CLIENT company, so a coherence check on `closed_by_user_id`
    // catches them without any capability being resolved.
    const expertUser = await userFactory();
    const expert = await expertDraftFactory({ userId: expertUser.id });
    const { engagement } = await caseEngagementFactory({ expertProfileId: expert.id });

    await expect(
      caseEngagementsRepository.close({
        engagementId: engagement.id,
        reason: 'resolved',
        userId: expertUser.id,
      })
    ).rejects.toBeInstanceOf(CaseCloserNotMemberError);

    const [parent] = await db.select().from(engagements).where(eq(engagements.id, engagement.id));
    expect(parent?.status).toBe('active');
    const [child] = await db
      .select()
      .from(caseEngagements)
      .where(eq(caseEngagements.engagementId, engagement.id));
    expect(child?.closedAt).toBeNull();
    expect(await auditEventsForEntity(engagement.id)).toHaveLength(0);
  });

  it('(c) a live member of an UNRELATED company → CaseCloserNotMemberError', async () => {
    // The invariant is scoped to `engagement.company_id`, not to "is a member of something".
    const { engagement } = await caseEngagementFactory();
    const otherCompany = await companyFactory();
    const outsider = await userFactory();
    await companyMemberFactory({ companyId: otherCompany.id, userId: outsider.id });

    await expect(
      caseEngagementsRepository.close({
        engagementId: engagement.id,
        reason: 'resolved',
        userId: outsider.id,
      })
    ).rejects.toBeInstanceOf(CaseCloserNotMemberError);
  });

  it('(d) a SOFT-REMOVED member → CaseCloserNotMemberError (the read is of LIVE membership)', async () => {
    const { engagement, companyId, clientMemberUserId } = await caseEngagementFactory({
      withClientMember: true,
    });
    if (clientMemberUserId === undefined) throw new Error('expected a seeded client member');

    await db
      .update(companyMembers)
      .set({ deletedAt: new Date() })
      .where(eq(companyMembers.userId, clientMemberUserId));

    // Sanity: the membership row exists but is soft-deleted.
    const rows = await db
      .select()
      .from(companyMembers)
      .where(eq(companyMembers.companyId, companyId));
    expect(rows.every((r) => r.deletedAt !== null)).toBe(true);

    await expect(
      caseEngagementsRepository.close({
        engagementId: engagement.id,
        reason: 'resolved',
        userId: clientMemberUserId,
      })
    ).rejects.toBeInstanceOf(CaseCloserNotMemberError);
  });

  it('the auto_inactive path closes with closed_by_user_id NULL (ADR-1030 system actor)', async () => {
    const { engagement } = await caseEngagementFactory();

    const closed = await caseEngagementsRepository.close({
      engagementId: engagement.id,
      reason: 'auto_inactive',
    });

    expect(closed.status).toBe('completed');
    expect(closed.closedByUserId).toBeNull();
    expect(closed.closeReason).toBe('auto_inactive');

    const [parent] = await db.select().from(engagements).where(eq(engagements.id, engagement.id));
    expect(parent?.status).toBe('completed');

    const events = await auditEventsForEntity(engagement.id);
    const closeEvent = events.find((e) => e.action === 'engagement.case_closed');
    expect(closeEvent?.actorUserId).toBeNull();
    expect(closeEvent?.metadata).toMatchObject({ close_reason: 'auto_inactive' });
  });

  it('(e) a DOUBLE close throws CaseAlreadyClosedError and mutates nothing further', async () => {
    const { engagement, clientMemberUserId } = await caseEngagementFactory({
      withClientMember: true,
    });
    if (clientMemberUserId === undefined) throw new Error('expected a seeded client member');

    const first = await caseEngagementsRepository.close({
      engagementId: engagement.id,
      reason: 'resolved',
      userId: clientMemberUserId,
    });

    await expect(
      caseEngagementsRepository.close({ engagementId: engagement.id, reason: 'auto_inactive' })
    ).rejects.toBeInstanceOf(CaseAlreadyClosedError);

    const [child] = await db
      .select()
      .from(caseEngagements)
      .where(eq(caseEngagements.engagementId, engagement.id));
    expect(child?.closeReason).toBe('resolved');
    expect(child?.closedByUserId).toBe(clientMemberUserId);
    expect(child?.closedAt?.getTime()).toBe(first.closedAt?.getTime());
    expect(
      (await auditEventsForEntity(engagement.id)).filter(
        (e) => e.action === 'engagement.case_closed'
      )
    ).toHaveLength(1);
  });

  it('close(projectEngagementId) throws EngagementTypeMismatchError', async () => {
    const { engagement } = await engagementFactory();
    await expect(
      caseEngagementsRepository.close({ engagementId: engagement.id, reason: 'auto_inactive' })
    ).rejects.toBeInstanceOf(EngagementTypeMismatchError);
  });
});

describe('case_engagements CHECK constraints (raw-write backstops)', () => {
  it('case_engagement_close_coherent rejects auto_inactive WITH a closer, and resolved WITHOUT one', async () => {
    const { engagement, clientMemberUserId } = await caseEngagementFactory({
      withClientMember: true,
    });
    if (clientMemberUserId === undefined) throw new Error('expected a seeded client member');

    await expectCheckViolation(sql`
      UPDATE case_engagements
      SET closed_at = now(), close_reason = 'auto_inactive', closed_by_user_id = ${clientMemberUserId}::uuid
      WHERE engagement_id = ${engagement.id}::uuid
    `);

    await expectCheckViolation(sql`
      UPDATE case_engagements
      SET closed_at = now(), close_reason = 'resolved', closed_by_user_id = NULL
      WHERE engagement_id = ${engagement.id}::uuid
    `);
  });

  it('case_engagement_close_coherent rejects a CLOSED case with NO close_reason (the NULL-CHECK hole)', async () => {
    // ⚠ REGRESSION PROBE for the `=` → `IS NOT DISTINCT FROM` fix. With plain `=`,
    // `close_reason IS NULL` made disjunct 1 FALSE and disjuncts 2/3 NULL
    // (`NULL = 'resolved'` is NULL) — so the CHECK evaluated to NULL, which Postgres
    // treats as SATISFIED, and BOTH shapes below were ACCEPTED. A closed case with no
    // reason is exactly what the constraint exists to forbid.
    const { engagement, clientMemberUserId } = await caseEngagementFactory({
      withClientMember: true,
    });
    if (clientMemberUserId === undefined) throw new Error('expected a seeded client member');

    await expectCheckViolation(sql`
      UPDATE case_engagements
      SET closed_at = now(), close_reason = NULL, closed_by_user_id = NULL
      WHERE engagement_id = ${engagement.id}::uuid
    `);

    await expectCheckViolation(sql`
      UPDATE case_engagements
      SET closed_at = now(), close_reason = NULL, closed_by_user_id = ${clientMemberUserId}::uuid
      WHERE engagement_id = ${engagement.id}::uuid
    `);

    // …and the three INTENDED-ACCEPT shapes are still accepted (the fix tightened the
    // NULL hole only — it did not narrow the legal set).
    const [stillOpen] = await db
      .select()
      .from(caseEngagements)
      .where(eq(caseEngagements.engagementId, engagement.id));
    expect(stillOpen?.closedAt).toBeNull();

    await db.execute(sql`
      UPDATE case_engagements
      SET closed_at = now(), close_reason = 'resolved', closed_by_user_id = ${clientMemberUserId}::uuid
      WHERE engagement_id = ${engagement.id}::uuid
    `);
    await db.execute(sql`
      UPDATE case_engagements
      SET closed_at = now(), close_reason = 'auto_inactive', closed_by_user_id = NULL
      WHERE engagement_id = ${engagement.id}::uuid
    `);
    const [reclosed] = await db
      .select()
      .from(caseEngagements)
      .where(eq(caseEngagements.engagementId, engagement.id));
    expect(reclosed?.closeReason).toBe('auto_inactive');
  });

  it('case_engagement_resolution_request_paired rejects a half-set pair and accepts both set (D1)', async () => {
    const { engagement, clientMemberUserId } = await caseEngagementFactory({
      withClientMember: true,
    });
    if (clientMemberUserId === undefined) throw new Error('expected a seeded client member');

    await expectCheckViolation(sql`
      UPDATE case_engagements SET resolution_requested_at = now()
      WHERE engagement_id = ${engagement.id}::uuid
    `);

    await expectCheckViolation(sql`
      UPDATE case_engagements SET resolution_requested_by_user_id = ${clientMemberUserId}::uuid
      WHERE engagement_id = ${engagement.id}::uuid
    `);

    // Both set together → accepted. (INERT columns — no repository writes them.)
    await db.execute(sql`
      UPDATE case_engagements
      SET resolution_requested_at = now(), resolution_requested_by_user_id = ${clientMemberUserId}::uuid
      WHERE engagement_id = ${engagement.id}::uuid
    `);
    const [child] = await db
      .select()
      .from(caseEngagements)
      .where(eq(caseEngagements.engagementId, engagement.id));
    expect(child?.resolutionRequestedAt).toBeInstanceOf(Date);
    expect(child?.resolutionRequestedByUserId).toBe(clientMemberUserId);

    // THE OTHER HALF OF THE AC: a resolution request writes the request columns and
    // NOTHING ELSE — the case stays OPEN. Asserting only the two columns that were
    // written would pass even if the request had closed the case, so re-read BOTH the
    // child's `closed_at` and the PARENT's `status`.
    expect(child?.closedAt).toBeNull();
    expect(child?.closeReason).toBeNull();
    expect(child?.closedByUserId).toBeNull();
    const [parent] = await db.select().from(engagements).where(eq(engagements.id, engagement.id));
    expect(parent?.status).toBe('active');
    // …and the case is therefore still a live inactivity-sweep candidate.
    expect(
      (await caseEngagementsRepository.listOpenCreatedBefore(new Date(Date.now() + 60_000))).map(
        (r) => r.id
      )
    ).toContain(engagement.id);
  });
});

describe('caseEngagementsRepository.listOpenCreatedBefore — the inactivity candidate scan', () => {
  it('returns OPEN cases created ≤ cutoff, oldest first; excludes closed / soft-deleted / too-new / PROJECTS', async () => {
    const cutoff = new Date('2026-06-01T00:00:00.000Z');
    const old1 = new Date('2026-01-01T00:00:00.000Z');
    const old2 = new Date('2026-03-01T00:00:00.000Z');
    const tooNew = new Date('2026-08-01T00:00:00.000Z');

    const oldest = await caseEngagementFactory({ values: { createdAt: old1 } });
    const newer = await caseEngagementFactory({ values: { createdAt: old2 } });
    // Created after the cutoff → excluded.
    const future = await caseEngagementFactory({ values: { createdAt: tooNew } });
    // Closed → excluded.
    const closed = await caseEngagementFactory({ values: { createdAt: old1 } });
    await caseEngagementsRepository.close({
      engagementId: closed.engagement.id,
      reason: 'auto_inactive',
    });
    // Soft-deleted → excluded.
    const deleted = await caseEngagementFactory({ values: { createdAt: old1 } });
    await softDeleteEngagementFixture(deleted.engagement.id);
    // A PROJECT created long ago → excluded (the scan is type-scoped).
    const project = await engagementFactory({ values: { createdAt: old1 } });

    const rows = await caseEngagementsRepository.listOpenCreatedBefore(cutoff);
    const ids = rows.map((r) => r.id);

    expect(ids).toContain(oldest.engagement.id);
    expect(ids).toContain(newer.engagement.id);
    expect(ids).not.toContain(future.engagement.id);
    expect(ids).not.toContain(closed.engagement.id);
    expect(ids).not.toContain(deleted.engagement.id);
    expect(ids).not.toContain(project.engagement.id);

    // Oldest first — the same clock (`engagements.created_at`) the rows expose.
    expect(ids.indexOf(oldest.engagement.id)).toBeLessThan(ids.indexOf(newer.engagement.id));
    rows.forEach((r) => {
      expect(r.closedAt).toBeNull();
      expect(r.createdAt.getTime()).toBeLessThanOrEqual(cutoff.getTime());
    });
  });
});

// ── BAL-390: the CASE rating-nudge candidate scan ────────────────────────────

describe('caseEngagementsRepository.listClosedBetween', () => {
  const ANCHOR = new Date('2026-08-01T12:00:00.000Z');
  /** The one-hour band whose INCLUSIVE upper edge is exactly `ANCHOR`. */
  const AFTER = new Date(ANCHOR.getTime() - 3_600_000);

  /** Seed a case whose `closed_at` is exactly `closedAt` (the auto_inactive shape). */
  async function seedClosed(closedAt: Date) {
    return caseEngagementFactory({
      values: { status: 'completed' },
      caseValues: { closedAt, closeReason: 'auto_inactive' },
    });
  }

  /** The `resolved` shape — a CLIENT closed it on purpose, so a member must be named. */
  async function seedResolved(closedAt: Date) {
    const seeded = await caseEngagementFactory({ values: { status: 'completed' } });
    const closer = await userFactory();
    await companyMemberFactory({ companyId: seeded.companyId, userId: closer.id });
    await db
      .update(caseEngagements)
      .set({ closedAt, closeReason: 'resolved', closedByUserId: closer.id })
      .where(eq(caseEngagements.engagementId, seeded.engagement.id));
    return seeded;
  }

  async function candidateIds(after = AFTER, until = ANCHOR): Promise<string[]> {
    const rows = await caseEngagementsRepository.listClosedBetween(after, until);
    return rows.map((row) => row.engagementId);
  }

  it('returns the RatingNudgeCandidate shape for a case closed inside the band', async () => {
    const seeded = await seedClosed(ANCHOR);

    const candidates = await caseEngagementsRepository.listClosedBetween(AFTER, ANCHOR);
    const found = candidates.find((c) => c.engagementId === seeded.engagement.id);
    if (found === undefined) throw new Error('expected the closed case to be a candidate');

    expect(found.engagementKind).toBe('case');
    expect(found.companyId).toBe(seeded.companyId);
    expect(found.expertProfileId).toBe(seeded.expertProfileId);
    expect(found.anchorAt.toISOString()).toBe(ANCHOR.toISOString());
    expect(found.title).toBe(seeded.engagement.title);
    // Shape-identical to the PROJECT candidate apart from `closeReason`, which only a
    // case can have — the sweep still never branches, it just forwards the field.
    expect(Object.keys(found).sort()).toEqual([
      'anchorAt',
      'closeReason',
      'companyId',
      'engagementId',
      'engagementKind',
      'expertProfileId',
      'title',
    ]);
  });

  /**
   * BAL-390 — the +7d nudge STATES why the case closed, so the real enum value has to
   * reach it. Reading `auto_inactive` off every row would tell a client who deliberately
   * resolved their own case that "things went quiet", which is the one thing BAL-329's
   * tone ruling forbids.
   */
  it('carries the REAL close_reason, per row, for both enum values', async () => {
    const quiet = await seedClosed(ANCHOR);
    const resolved = await seedResolved(ANCHOR);

    const candidates = await caseEngagementsRepository.listClosedBetween(AFTER, ANCHOR);
    const byId = new Map(candidates.map((c) => [c.engagementId, c.closeReason]));

    expect(byId.get(quiet.engagement.id)).toBe('auto_inactive');
    expect(byId.get(resolved.engagement.id)).toBe('resolved');
  });

  it('is HALF-OPEN: an anchor exactly at `until` is INCLUDED, one exactly at `after` is EXCLUDED', async () => {
    const atUntil = await seedClosed(ANCHOR);
    const atAfter = await seedClosed(AFTER);

    const ids = await candidateIds();
    expect(ids).toContain(atUntil.engagement.id);
    expect(ids).not.toContain(atAfter.engagement.id);
  });

  it('excludes an OPEN case (closed_at IS NULL) — the empty-set state BAL-390 actually ships in', async () => {
    // ⚠ D5: the only production caller of `close()` today is BAL-388's `resolveCaseAction`,
    // so most cases are still in this state and this reader legitimately skips them.
    const open = await caseEngagementFactory();
    const ids = await candidateIds(new Date(0), new Date(Date.now() + 86_400_000));
    expect(ids).not.toContain(open.engagement.id);
  });

  it('excludes a SOFT-DELETED case, whether the parent or the child carries the stamp', async () => {
    const both = await seedClosed(ANCHOR);
    await softDeleteEngagementFixture(both.engagement.id);

    const parentOnly = await seedClosed(ANCHOR);
    await db
      .update(engagements)
      .set({ deletedAt: new Date() })
      .where(eq(engagements.id, parentOnly.engagement.id));

    const childOnly = await seedClosed(ANCHOR);
    await db
      .update(caseEngagements)
      .set({ deletedAt: new Date() })
      .where(eq(caseEngagements.engagementId, childOnly.engagement.id));

    const ids = await candidateIds();
    expect(ids).not.toContain(both.engagement.id);
    expect(ids).not.toContain(parentOnly.engagement.id);
    expect(ids).not.toContain(childOnly.engagement.id);
  });

  it('EXCLUDES a case that already has a live review, and still returns one whose review is soft-deleted', async () => {
    const rated = await seedClosed(ANCHOR);
    const ratedReviewer = await userFactory();
    await companyMemberFactory({ companyId: rated.companyId, userId: ratedReviewer.id });
    await db.insert(reviews).values({
      engagementId: rated.engagement.id,
      reviewerUserId: ratedReviewer.id,
      expertProfileId: rated.expertProfileId,
      rating: 5,
      surface: 'email',
      authMethod: 'magic_link',
    });

    const moderated = await seedClosed(ANCHOR);
    const moderatedReviewer = await userFactory();
    await companyMemberFactory({ companyId: moderated.companyId, userId: moderatedReviewer.id });
    await db.insert(reviews).values({
      engagementId: moderated.engagement.id,
      reviewerUserId: moderatedReviewer.id,
      expertProfileId: moderated.expertProfileId,
      rating: 1,
      surface: 'email',
      authMethod: 'magic_link',
      deletedAt: new Date(),
    });

    const ids = await candidateIds();
    expect(ids).not.toContain(rated.engagement.id);
    expect(ids).toContain(moderated.engagement.id);
  });

  it('NEVER returns a project engagement — the scan is child-rooted', async () => {
    const project = await engagementFactory({
      projectValues: {
        deliveryStatus: 'completed',
        acceptedAt: ANCHOR,
        acceptanceMethod: 'auto',
      },
    });
    expect(await candidateIds()).not.toContain(project.engagement.id);
  });

  it('orders oldest anchor first and returns [] for an empty band', async () => {
    const older = await seedClosed(new Date(ANCHOR.getTime() - 1_800_000));
    const newer = await seedClosed(ANCHOR);

    const ordered = (await candidateIds()).filter(
      (id) => id === older.engagement.id || id === newer.engagement.id
    );
    expect(ordered).toEqual([older.engagement.id, newer.engagement.id]);

    const empty = new Date('2020-01-01T00:00:00.000Z');
    await expect(
      caseEngagementsRepository.listClosedBetween(new Date(empty.getTime() - 3_600_000), empty)
    ).resolves.toEqual([]);
  });
});

describe('case_engagements — the composite FK cascade', () => {
  it('hard-deleting the parent cascades the case_engagements row away', async () => {
    const { engagement } = await caseEngagementFactory();

    await db.delete(engagements).where(eq(engagements.id, engagement.id));

    const rows = await db
      .select()
      .from(caseEngagements)
      .where(eq(caseEngagements.engagementId, engagement.id));
    expect(rows).toHaveLength(0);
  });
});

/**
 * BAL-421 — `requestResolution`. The ASK half: the expert says "is this resolved?", the
 * paired columns are stamped, and the case STAYS OPEN. The exact mirror of
 * `clearResolutionRequest` below, and the FIRST writer of columns that shipped inert.
 */
describe('caseEngagementsRepository.requestResolution', () => {
  it('writes BOTH paired columns in one UPDATE, without tripping the CHECK', async () => {
    // ⚠ `case_engagement_resolution_request_paired` is `(at IS NULL) = (by IS NULL)`, so a
    // one-column update would be rejected 23514. This test is what proves the repository
    // writes the pair — the same guarantee its dismissal mirror makes for nulling them.
    const requester = await userFactory();
    const { engagement } = await caseEngagementFactory();

    const requested = await caseEngagementsRepository.requestResolution({
      engagementId: engagement.id,
      userId: requester.id,
    });

    expect(requested).toBeDefined();
    expect(requested?.resolutionRequestedAt).toBeInstanceOf(Date);
    expect(requested?.resolutionRequestedByUserId).toBe(requester.id);

    // PERSISTED, not merely present on the returned object.
    const [row] = await db
      .select()
      .from(caseEngagements)
      .where(eq(caseEngagements.engagementId, engagement.id));
    expect(row?.resolutionRequestedAt).toBeInstanceOf(Date);
    expect(row?.resolutionRequestedByUserId).toBe(requester.id);
  });

  it('LEAVES THE CASE OPEN — closed_at, close_reason and the parent status are untouched', async () => {
    // Asserting only the two columns that were written would pass even if the ask had
    // CLOSED the case, so re-read the child's close columns AND the parent's status.
    const requester = await userFactory();
    const { engagement } = await caseEngagementFactory();

    await caseEngagementsRepository.requestResolution({
      engagementId: engagement.id,
      userId: requester.id,
    });

    const [child] = await db
      .select()
      .from(caseEngagements)
      .where(eq(caseEngagements.engagementId, engagement.id));
    expect(child?.closedAt).toBeNull();
    expect(child?.closeReason).toBeNull();
    expect(child?.closedByUserId).toBeNull();

    const [parent] = await db.select().from(engagements).where(eq(engagements.id, engagement.id));
    expect(parent?.status).toBe('active');

    // …and the case is therefore still a live inactivity-sweep candidate: asking whether a
    // case is resolved must not take it out of the BAL-420 scan.
    expect(
      (await caseEngagementsRepository.listOpenCreatedBefore(new Date(Date.now() + 60_000))).map(
        (r) => r.id
      )
    ).toContain(engagement.id);
  });

  it('LAST-ASK-WINS — a re-request overwrites both the timestamp and the actor', async () => {
    // Owner decision (2026-08-12). The WHERE deliberately does NOT require the columns to
    // be NULL. Seed the FIRST ask far in the past so "the timestamp moved forward" is
    // decidable without depending on sub-millisecond clock resolution.
    const firstRequester = await userFactory();
    const secondRequester = await userFactory();
    const staleAsk = new Date('2026-08-01T00:00:00.000Z');
    const { engagement } = await caseEngagementFactory({
      caseValues: {
        resolutionRequestedAt: staleAsk,
        resolutionRequestedByUserId: firstRequester.id,
      },
    });

    const reasked = await caseEngagementsRepository.requestResolution({
      engagementId: engagement.id,
      userId: secondRequester.id,
    });

    expect(reasked).toBeDefined();
    expect(reasked?.resolutionRequestedByUserId).toBe(secondRequester.id);
    expect(reasked?.resolutionRequestedAt?.getTime()).toBeGreaterThan(staleAsk.getTime());

    const [row] = await db
      .select()
      .from(caseEngagements)
      .where(eq(caseEngagements.engagementId, engagement.id));
    expect(row?.resolutionRequestedByUserId).toBe(secondRequester.id);
    expect(row?.resolutionRequestedAt?.getTime()).toBeGreaterThan(staleAsk.getTime());
  });

  it('ROUND-TRIPS with clearResolutionRequest — ask → dismiss → ask again', async () => {
    // The two halves are mirrors, and the pair must survive a full cycle: nulling both
    // columns and re-setting both must each satisfy the paired CHECK.
    const requester = await userFactory();
    const { engagement } = await caseEngagementFactory();

    await caseEngagementsRepository.requestResolution({
      engagementId: engagement.id,
      userId: requester.id,
    });
    const cleared = await caseEngagementsRepository.clearResolutionRequest({
      engagementId: engagement.id,
    });
    expect(cleared?.resolutionRequestedAt).toBeNull();
    expect(cleared?.resolutionRequestedByUserId).toBeNull();

    const reasked = await caseEngagementsRepository.requestResolution({
      engagementId: engagement.id,
      userId: requester.id,
    });
    expect(reasked?.resolutionRequestedAt).toBeInstanceOf(Date);
    expect(reasked?.resolutionRequestedByUserId).toBe(requester.id);
  });

  it('REFUSES a CLOSED case — asking whether a closed case is resolved is incoherent', async () => {
    const requester = await userFactory();
    const { engagement } = await caseEngagementFactory({ withClientMember: true });
    await caseEngagementsRepository.close({ engagementId: engagement.id, reason: 'auto_inactive' });

    await expect(
      caseEngagementsRepository.requestResolution({
        engagementId: engagement.id,
        userId: requester.id,
      })
    ).resolves.toBeUndefined();

    // The refusal is a refusal, not a partial write — and terminal history is intact.
    const [row] = await db
      .select()
      .from(caseEngagements)
      .where(eq(caseEngagements.engagementId, engagement.id));
    expect(row?.resolutionRequestedAt).toBeNull();
    expect(row?.resolutionRequestedByUserId).toBeNull();
    expect(row?.closeReason).toBe('auto_inactive');
    expect(row?.closedAt).not.toBeNull();
  });

  it('refuses a SOFT-DELETED case, and writes nothing', async () => {
    const requester = await userFactory();
    const { engagement } = await caseEngagementFactory();
    await softDeleteEngagementFixture(engagement.id);

    await expect(
      caseEngagementsRepository.requestResolution({
        engagementId: engagement.id,
        userId: requester.id,
      })
    ).resolves.toBeUndefined();

    const [row] = await db
      .select()
      .from(caseEngagements)
      .where(eq(caseEngagements.engagementId, engagement.id));
    expect(row?.resolutionRequestedAt).toBeNull();
  });

  it('refuses a PROJECT engagement id — the parent read is type-scoped', async () => {
    const requester = await userFactory();
    const project = await engagementFactory();

    await expect(
      caseEngagementsRepository.requestResolution({
        engagementId: project.engagement.id,
        userId: requester.id,
      })
    ).resolves.toBeUndefined();
  });

  it('REPORTS FAILURE AND WRITES NOTHING when the PARENT row has drifted', async () => {
    // The parent-read-BEFORE-update ordering, asserted directly. DELIBERATE parent/child
    // drift: only the PARENT is stamped, so the child UPDATE would still match. That is the
    // exact state in which reading the parent AFTER the update would COMMIT the ask and
    // then report "this case is no longer open" about a request that was in fact written.
    const requester = await userFactory();
    const { engagement } = await caseEngagementFactory();

    await db
      .update(engagements)
      .set({ deletedAt: new Date() })
      .where(eq(engagements.id, engagement.id));

    await expect(
      caseEngagementsRepository.requestResolution({
        engagementId: engagement.id,
        userId: requester.id,
      })
    ).resolves.toBeUndefined();

    const [row] = await db
      .select()
      .from(caseEngagements)
      .where(eq(caseEngagements.engagementId, engagement.id));
    expect(row?.resolutionRequestedAt).toBeNull();
    expect(row?.resolutionRequestedByUserId).toBeNull();
  });

  it('returns undefined for an unknown engagement id', async () => {
    const requester = await userFactory();
    await expect(
      caseEngagementsRepository.requestResolution({
        engagementId: '00000000-0000-4000-8000-000000000000',
        userId: requester.id,
      })
    ).resolves.toBeUndefined();
  });

  it('rejects an unknown requester with the raw FK violation (23503) — the ONLY guarantee about userId', async () => {
    // There is deliberately NO membership/holder check here (the asymmetry with `close` is
    // argued in the method docblock): the ADR-1046 holder rule is the server action's, and
    // resolving it in `@balo/db` would be a second definition of an authorization rule.
    const { engagement } = await caseEngagementFactory();

    await expect(
      caseEngagementsRepository.requestResolution({
        engagementId: engagement.id,
        userId: '00000000-0000-4000-8000-000000000000',
      })
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('writes NO audit row — the paired columns ARE the attribution record', async () => {
    // Symmetric with the dismiss half (owner decision D-E): no notification, no domain
    // event, no `recordDeliveryAudit`. A future ticket that wants a trail must add one
    // deliberately, and this assertion is what will make it notice.
    const requester = await userFactory();
    const { engagement } = await caseEngagementFactory();

    await caseEngagementsRepository.requestResolution({
      engagementId: engagement.id,
      userId: requester.id,
    });

    expect(await auditEventsForEntity(engagement.id)).toHaveLength(0);
  });
});

/**
 * BAL-388 — `clearResolutionRequest`. The dismissal half of §R4: the client says "not yet",
 * the pending request goes away, and the case STAYS OPEN.
 */
describe('caseEngagementsRepository.clearResolutionRequest', () => {
  it('nulls BOTH paired columns in one UPDATE, without tripping the CHECK', async () => {
    // ⚠ `case_engagement_resolution_request_paired` is
    // `(at IS NULL) = (by IS NULL)`, so a one-column update would be rejected 23514. This
    // test is what proves the repository writes the pair.
    const requester = await userFactory();
    const { engagement } = await caseEngagementFactory({
      caseValues: {
        resolutionRequestedAt: new Date('2026-08-01T00:00:00.000Z'),
        resolutionRequestedByUserId: requester.id,
      },
    });

    const cleared = await caseEngagementsRepository.clearResolutionRequest({
      engagementId: engagement.id,
    });

    expect(cleared).toBeDefined();
    expect(cleared?.resolutionRequestedAt).toBeNull();
    expect(cleared?.resolutionRequestedByUserId).toBeNull();

    const [row] = await db
      .select()
      .from(caseEngagements)
      .where(eq(caseEngagements.engagementId, engagement.id));
    expect(row?.resolutionRequestedAt).toBeNull();
    expect(row?.resolutionRequestedByUserId).toBeNull();
  });

  it('LEAVES THE CASE OPEN — closed_at, close_reason and the parent status are untouched', async () => {
    const requester = await userFactory();
    const { engagement } = await caseEngagementFactory({
      caseValues: {
        resolutionRequestedAt: new Date('2026-08-01T00:00:00.000Z'),
        resolutionRequestedByUserId: requester.id,
      },
    });

    await caseEngagementsRepository.clearResolutionRequest({ engagementId: engagement.id });

    const [child] = await db
      .select()
      .from(caseEngagements)
      .where(eq(caseEngagements.engagementId, engagement.id));
    expect(child?.closedAt).toBeNull();
    expect(child?.closeReason).toBeNull();
    expect(child?.closedByUserId).toBeNull();

    const [parent] = await db.select().from(engagements).where(eq(engagements.id, engagement.id));
    expect(parent?.status).toBe('active');
  });

  it('is IDEMPOTENT — a second clear is a no-op that still returns the row', async () => {
    const requester = await userFactory();
    const { engagement } = await caseEngagementFactory({
      caseValues: {
        resolutionRequestedAt: new Date('2026-08-01T00:00:00.000Z'),
        resolutionRequestedByUserId: requester.id,
      },
    });

    await caseEngagementsRepository.clearResolutionRequest({ engagementId: engagement.id });
    const second = await caseEngagementsRepository.clearResolutionRequest({
      engagementId: engagement.id,
    });

    expect(second).toBeDefined();
    expect(second?.resolutionRequestedAt).toBeNull();
  });

  it('is a no-op on a case that never had a request', async () => {
    const { engagement } = await caseEngagementFactory();
    const cleared = await caseEngagementsRepository.clearResolutionRequest({
      engagementId: engagement.id,
    });
    expect(cleared?.resolutionRequestedAt).toBeNull();
  });

  it('REFUSES a CLOSED case — terminal history is not rewritten', async () => {
    const requester = await userFactory();
    const { engagement } = await caseEngagementFactory({
      withClientMember: true,
      caseValues: {
        resolutionRequestedAt: new Date('2026-08-01T00:00:00.000Z'),
        resolutionRequestedByUserId: requester.id,
      },
    });
    await caseEngagementsRepository.close({ engagementId: engagement.id, reason: 'auto_inactive' });

    await expect(
      caseEngagementsRepository.clearResolutionRequest({ engagementId: engagement.id })
    ).resolves.toBeUndefined();

    // And the request columns are STILL set — the refusal is a refusal, not a partial write.
    const [row] = await db
      .select()
      .from(caseEngagements)
      .where(eq(caseEngagements.engagementId, engagement.id));
    expect(row?.resolutionRequestedAt).not.toBeNull();
  });

  it('refuses a SOFT-DELETED case', async () => {
    const { engagement } = await caseEngagementFactory();
    await softDeleteEngagementFixture(engagement.id);

    await expect(
      caseEngagementsRepository.clearResolutionRequest({ engagementId: engagement.id })
    ).resolves.toBeUndefined();
  });

  it('REPORTS FAILURE AND WRITES NOTHING when the PARENT row has drifted', async () => {
    const requester = await userFactory();
    const requestedAt = new Date('2026-08-01T00:00:00.000Z');
    const { engagement } = await caseEngagementFactory({
      caseValues: { resolutionRequestedAt: requestedAt, resolutionRequestedByUserId: requester.id },
    });

    // DELIBERATE parent/child drift — the sanctioned fixture stamps BOTH rows, and this test
    // needs only the PARENT stamped so the child UPDATE would still match. That is the exact
    // state in which reading the parent AFTER the update commits the clear and then reports
    // "no longer open" to a client whose request was in fact cleared.
    await db
      .update(engagements)
      .set({ deletedAt: new Date() })
      .where(eq(engagements.id, engagement.id));

    await expect(
      caseEngagementsRepository.clearResolutionRequest({ engagementId: engagement.id })
    ).resolves.toBeUndefined();

    const [row] = await db
      .select()
      .from(caseEngagements)
      .where(eq(caseEngagements.engagementId, engagement.id));
    expect(row?.resolutionRequestedAt).toEqual(requestedAt);
    expect(row?.resolutionRequestedByUserId).toBe(requester.id);
  });

  it('returns undefined for an unknown engagement id', async () => {
    await expect(
      caseEngagementsRepository.clearResolutionRequest({
        engagementId: '00000000-0000-4000-8000-000000000000',
      })
    ).resolves.toBeUndefined();
  });
});

// ── BAL-400 — booking idempotency key, product tags, open-case chooser ─────────────────

let bookingKeySeq = 0;

/**
 * A DISTINCT, VALID booking key: 64 lowercase hex chars, which is all
 * `case_engagement_booking_idempotency_key_format` demands. Production values are
 * `sha256(userId:nonce)`.
 */
function bookingKey(): string {
  bookingKeySeq += 1;
  return bookingKeySeq.toString(16).padStart(64, '0');
}

let productSeq = 0;

/**
 * Seed ONE `products` row on its OWN vertical. The integration global-setup seeds only the
 * Salesforce vertical and no products, and `products` carries a composite unique on
 * `(vertical_id, slug)` — a fresh vertical per product keeps every fixture independent.
 * Rolled back with the per-test transaction.
 */
async function seedProductId(): Promise<string> {
  productSeq += 1;
  const suffix = `${productSeq}-${Date.now()}`;
  const [vertical] = await db
    .insert(verticals)
    .values({ name: `Vertical ${suffix}`, slug: `vertical-${suffix}`, isActive: true })
    .returning();
  if (vertical === undefined) throw new Error('vertical insert failed');
  const [product] = await db
    .insert(products)
    .values({ verticalId: vertical.id, name: `Product ${suffix}`, slug: `product-${suffix}` })
    .returning();
  if (product === undefined) throw new Error('product insert failed');
  return product.id;
}

/** The raw child row — the ONLY place the stripped booking key is observable. */
async function childRow(engagementId: string): Promise<typeof caseEngagements.$inferSelect> {
  const [row] = await db
    .select()
    .from(caseEngagements)
    .where(eq(caseEngagements.engagementId, engagementId));
  if (row === undefined) throw new Error(`no case_engagements row for ${engagementId}`);
  return row;
}

async function productLinks(
  engagementId: string
): Promise<(typeof caseEngagementProducts.$inferSelect)[]> {
  return db
    .select()
    .from(caseEngagementProducts)
    .where(eq(caseEngagementProducts.engagementId, engagementId))
    .orderBy(asc(caseEngagementProducts.productId));
}

async function newCaseInput(): Promise<{ companyId: string; expertProfileId: string }> {
  const companyId = await seedCompanyId();
  const expert = await expertDraftFactory();
  return { companyId, expertProfileId: expert.id };
}

/** A CLOSED case fixture for this pair, using the only reason that needs no closer user. */
async function seedClosedCase(shared: {
  companyId: string;
  expertProfileId?: string;
}): Promise<string> {
  const { engagement } = await caseEngagementFactory({
    ...shared,
    values: { status: 'completed' },
    caseValues: { closedAt: new Date(), closeReason: 'auto_inactive' },
  });
  return engagement.id;
}

describe('caseEngagementsRepository.create — booking idempotency key (BAL-400)', () => {
  it('persists the key on the CHILD row and keeps it OUT of the returned projection', async () => {
    const base = await newCaseInput();
    const key = bookingKey();

    const created = await caseEngagementsRepository.create({
      ...base,
      title: 'Flow fails on record update',
      description: '<p>Broken flow.</p>',
      bookingIdempotencyKey: key,
    });

    expect((await childRow(created.id)).bookingIdempotencyKey).toBe(key);
    // Stripped by `toCaseRow`, exactly as `baloFeeBps` is — the key must never ride a case
    // row onto a client surface.
    expect(created).not.toHaveProperty('bookingIdempotencyKey');
    expect(created).not.toHaveProperty('baloFeeBps');
  });

  it('defaults the key to NULL when the caller passes none (the seeder / BAL-417 path)', async () => {
    const base = await newCaseInput();
    const created = await caseEngagementsRepository.create({
      ...base,
      title: 'No key',
      description: '<p>No key.</p>',
    });
    expect((await childRow(created.id)).bookingIdempotencyKey).toBeNull();
  });

  it('still writes balo_fee_bps as NULL for a case when a booking key is supplied', async () => {
    // `engagement_balo_fee_bps_case_null` is a BICONDITIONAL, so a case row that fell
    // through to the column DEFAULT (2500) would be rejected 23514. This proves the new
    // parameter did not disturb the explicit-NULL write.
    const base = await newCaseInput();
    const created = await caseEngagementsRepository.create({
      ...base,
      title: 'Fee stays null',
      description: '<p>Fee.</p>',
      bookingIdempotencyKey: bookingKey(),
    });
    const [parent] = await db.select().from(engagements).where(eq(engagements.id, created.id));
    expect(parent?.baloFeeBps).toBeNull();
  });

  it('REFUSES a second live case under the SAME key — 23505 on the partial unique', async () => {
    const base = await newCaseInput();
    const key = bookingKey();

    await caseEngagementsRepository.create({
      ...base,
      title: 'First',
      description: '<p>First.</p>',
      bookingIdempotencyKey: key,
    });

    // THE WHOLE POINT: a concurrent double-submit cannot open two cases. `create` uses no
    // `ON CONFLICT` (the arbiter is a PARTIAL index — 42P10), so the caller sees the raw
    // 23505 and re-reads by key.
    await expect(
      caseEngagementsRepository.create({
        ...base,
        title: 'Second',
        description: '<p>Second.</p>',
        bookingIdempotencyKey: key,
      })
    ).rejects.toMatchObject({ code: '23505' });

    const rows = await db
      .select({ id: caseEngagements.engagementId })
      .from(caseEngagements)
      .where(eq(caseEngagements.bookingIdempotencyKey, key));
    expect(rows).toHaveLength(1);
  });

  it('lets a SOFT-DELETED case FREE its key (the unique is partial on deleted_at)', async () => {
    const base = await newCaseInput();
    const key = bookingKey();

    const first = await caseEngagementsRepository.create({
      ...base,
      title: 'First',
      description: '<p>First.</p>',
      bookingIdempotencyKey: key,
    });
    await softDeleteEngagementFixture(first.id);

    // Without the `deleted_at IS NULL` half of the predicate this is 23505 forever — the
    // `reference_softdelete_nonpartial_unique_recreate` failure mode.
    const second = await caseEngagementsRepository.create({
      ...base,
      title: 'Second',
      description: '<p>Second.</p>',
      bookingIdempotencyKey: key,
    });
    expect(second.id).not.toBe(first.id);
    expect((await childRow(second.id)).bookingIdempotencyKey).toBe(key);
  });

  it('REJECTS a malformed key with 23514 — a raw client nonce never reaches the column', async () => {
    const base = await newCaseInput();
    await expect(
      caseEngagementsRepository.create({
        ...base,
        title: 'Bad key',
        description: '<p>Bad.</p>',
        // A client-minted UUID: the exact IDOR shape the CHECK exists to refuse.
        bookingIdempotencyKey: randomUUID(),
      })
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('REJECTS an UPPERCASE hex key — the digest is lowercase by contract', async () => {
    const base = await newCaseInput();
    await expect(
      caseEngagementsRepository.create({
        ...base,
        title: 'Upper',
        description: '<p>Upper.</p>',
        bookingIdempotencyKey: 'A'.repeat(64),
      })
    ).rejects.toMatchObject({ code: '23514' });
  });
});

describe('caseEngagementsRepository.create — product tags (BAL-400)', () => {
  it('writes ONE link row per product id, in the same transaction as the case', async () => {
    const base = await newCaseInput();
    const a = await seedProductId();
    const b = await seedProductId();

    const created = await caseEngagementsRepository.create({
      ...base,
      title: 'Tagged',
      description: '<p>Tagged.</p>',
      productIds: [a, b],
    });

    const links = await productLinks(created.id);
    expect(links).toHaveLength(2);
    expect(links.map((l) => l.productId).sort()).toEqual([a, b].sort());
    expect(links.every((l) => l.deletedAt === null)).toBe(true);
  });

  it('writes NO rows for an empty array and for an omitted parameter', async () => {
    const empty = await caseEngagementsRepository.create({
      ...(await newCaseInput()),
      title: 'Empty',
      description: '<p>Empty.</p>',
      productIds: [],
    });
    const omitted = await caseEngagementsRepository.create({
      ...(await newCaseInput()),
      title: 'Omitted',
      description: '<p>Omitted.</p>',
    });

    expect(await productLinks(empty.id)).toEqual([]);
    expect(await productLinks(omitted.id)).toEqual([]);
  });

  it('DE-DUPLICATES a repeated product id instead of failing the whole case on 23505', async () => {
    const base = await newCaseInput();
    const productId = await seedProductId();

    const created = await caseEngagementsRepository.create({
      ...base,
      title: 'Duped',
      description: '<p>Duped.</p>',
      productIds: [productId, productId, productId],
    });

    expect(await productLinks(created.id)).toHaveLength(1);
  });

  it('ROLLS THE WHOLE CASE BACK on an unknown product id (23503 on the restrict FK)', async () => {
    const base = await newCaseInput();
    const before = await db.select({ id: engagements.id }).from(engagements);

    await expect(
      caseEngagementsRepository.create({
        ...base,
        title: 'Bad product',
        description: '<p>Bad product.</p>',
        productIds: [randomUUID()],
      })
    ).rejects.toMatchObject({ code: '23503' });

    // The case, its child, its conversation and its audit row all went with it.
    const after = await db.select({ id: engagements.id }).from(engagements);
    expect(after).toHaveLength(before.length);
  });

  it('lets a SOFT-DELETED link be re-created — the unique is PARTIAL, unlike the template', async () => {
    // ⚠ THE DELIBERATE DIVERGENCE FROM `project_request_products`, whose unique is
    // NON-partial: there, a soft-deleted link blocks re-tagging forever. Ours must not.
    const base = await newCaseInput();
    const productId = await seedProductId();

    const created = await caseEngagementsRepository.create({
      ...base,
      title: 'Retag',
      description: '<p>Retag.</p>',
      productIds: [productId],
    });

    await db
      .update(caseEngagementProducts)
      .set({ deletedAt: new Date() })
      .where(eq(caseEngagementProducts.engagementId, created.id));

    await db.insert(caseEngagementProducts).values({ engagementId: created.id, productId });

    const links = await productLinks(created.id);
    expect(links).toHaveLength(2);
    expect(links.filter((l) => l.deletedAt === null)).toHaveLength(1);
  });

  it('REFUSES two LIVE links for the same (case, product) pair — 23505', async () => {
    const base = await newCaseInput();
    const productId = await seedProductId();
    const created = await caseEngagementsRepository.create({
      ...base,
      title: 'Dupe live',
      description: '<p>Dupe live.</p>',
      productIds: [productId],
    });

    await expectConstraintViolation('23505', (tx) =>
      tx.insert(caseEngagementProducts).values({ engagementId: created.id, productId })
    );
  });

  it('REFUSES a link whose parent is not a CASE — there is no case_engagements row to name', async () => {
    const project = await engagementFactory();
    const productId = await seedProductId();

    await expectConstraintViolation('23503', (tx) =>
      tx.insert(caseEngagementProducts).values({ engagementId: project.engagement.id, productId })
    );
  });

  it('CASCADES the links away when the case row is hard-deleted', async () => {
    const base = await newCaseInput();
    const productId = await seedProductId();
    const created = await caseEngagementsRepository.create({
      ...base,
      title: 'Cascade',
      description: '<p>Cascade.</p>',
      productIds: [productId],
    });

    // Deleting the SUPERTYPE cascades to `case_engagements`, which cascades to the links.
    await db.delete(engagements).where(eq(engagements.id, created.id));
    expect(await productLinks(created.id)).toEqual([]);
  });
});

describe('caseEngagementsRepository.findByBookingIdempotencyKey (BAL-400)', () => {
  it('returns the live case that was created under the key', async () => {
    const base = await newCaseInput();
    const key = bookingKey();
    const created = await caseEngagementsRepository.create({
      ...base,
      title: 'Findable',
      description: '<p>Findable.</p>',
      bookingIdempotencyKey: key,
    });

    const found = await caseEngagementsRepository.findByBookingIdempotencyKey(key);
    expect(found?.id).toBe(created.id);
    expect(found?.companyId).toBe(base.companyId);
    expect(found?.title).toBe('Findable');
    // Stripped from the projection — the retry already holds the key it passed in.
    expect(found).not.toHaveProperty('bookingIdempotencyKey');
  });

  it('returns undefined for an unknown key', async () => {
    await expect(
      caseEngagementsRepository.findByBookingIdempotencyKey(bookingKey())
    ).resolves.toBeUndefined();
  });

  it('IGNORES a soft-deleted case, so a replay never re-enters against a dead one', async () => {
    const base = await newCaseInput();
    const key = bookingKey();
    const created = await caseEngagementsRepository.create({
      ...base,
      title: 'Deleted',
      description: '<p>Deleted.</p>',
      bookingIdempotencyKey: key,
    });
    await softDeleteEngagementFixture(created.id);

    await expect(
      caseEngagementsRepository.findByBookingIdempotencyKey(key)
    ).resolves.toBeUndefined();
  });

  it('IGNORES a case whose PARENT alone was soft-deleted (both rows are filtered)', async () => {
    const base = await newCaseInput();
    const key = bookingKey();
    const created = await caseEngagementsRepository.create({
      ...base,
      title: 'Parent gone',
      description: '<p>Parent gone.</p>',
      bookingIdempotencyKey: key,
    });
    // DELIBERATE parent-only drift: the child stays live, so only the PARENT guard can
    // exclude this row. The sanctioned fixture stamps both — this proves the guard is not
    // load-bearing on the child alone.
    await db
      .update(engagements)
      .set({ deletedAt: new Date() })
      .where(eq(engagements.id, created.id));

    await expect(
      caseEngagementsRepository.findByBookingIdempotencyKey(key)
    ).resolves.toBeUndefined();
  });
});

describe('caseEngagementsRepository.listOpenForCompanyAndExpert (BAL-400)', () => {
  it('returns an OPEN case with a zero consultation count and lastActivityAt = createdAt', async () => {
    const { engagement, companyId, expertProfileId } = await caseEngagementFactory();

    const result = await caseEngagementsRepository.listOpenForCompanyAndExpert({
      companyId,
      expertProfileId,
    });

    expect(result.openCases).toHaveLength(1);
    const [only] = result.openCases;
    expect(only?.engagementId).toBe(engagement.id);
    expect(only?.title).toBe('Salesforce flow debugging');
    expect(only?.consultationCount).toBe(0);
    // A case with no consultation yet is an ACCEPTABLE resting state (D4b) and must still
    // be offered as an attach target.
    expect(only?.lastActivityAt).toBeInstanceOf(Date);
    expect(only?.lastActivityAt.getTime()).toBe(only?.createdAt.getTime());
    expect(result.resolvedCaseCount).toBe(0);
  });

  it('EXCLUDES another expert’s case and another company’s case', async () => {
    const companyId = await seedCompanyId();
    const expert = await expertDraftFactory();
    const mine = await caseEngagementFactory({ companyId, expertProfileId: expert.id });
    // Same company, DIFFERENT expert.
    await caseEngagementFactory({ companyId });
    // Same expert, DIFFERENT company.
    await caseEngagementFactory({ expertProfileId: expert.id });

    const result = await caseEngagementsRepository.listOpenForCompanyAndExpert({
      companyId,
      expertProfileId: expert.id,
    });

    expect(result.openCases.map((c) => c.engagementId)).toEqual([mine.engagement.id]);
  });

  it('EXCLUDES a closed case, a non-active parent, and a soft-deleted case', async () => {
    const companyId = await seedCompanyId();
    const expert = await expertDraftFactory();
    const shared = { companyId, expertProfileId: expert.id };

    const open = await caseEngagementFactory(shared);
    // CLOSED on the child while the parent is still `active` — the two liveness predicates
    // are independent and neither implies the other.
    await caseEngagementFactory({
      ...shared,
      caseValues: { closedAt: new Date(), closeReason: 'auto_inactive' },
    });
    // Parent moved off `active` while the child is still open.
    await caseEngagementFactory({ ...shared, values: { status: 'cancelled' } });
    const deleted = await caseEngagementFactory(shared);
    await softDeleteEngagementFixture(deleted.engagement.id);

    const result = await caseEngagementsRepository.listOpenForCompanyAndExpert(shared);
    expect(result.openCases.map((c) => c.engagementId)).toEqual([open.engagement.id]);
  });

  it('counts LIVE meetings only, never a context row whose meeting is soft-deleted', async () => {
    const { engagement, companyId, expertProfileId } = await caseEngagementFactory();
    const attach = [{ contextType: 'case' as const, contextId: engagement.id }];

    await meetingFactory({ contexts: attach });
    await meetingFactory({ contexts: attach });
    // ⚠ `meetingFactory` deliberately does NOT propagate `deletedAt` to the context row, so
    // this seeds a LIVE context pointing at a DEAD meeting — the exact shape a raw
    // context-row count would over-report to a client reading "N consultations".
    await meetingFactory({ contexts: attach, values: { deletedAt: new Date() } });

    const result = await caseEngagementsRepository.listOpenForCompanyAndExpert({
      companyId,
      expertProfileId,
    });
    expect(result.openCases[0]?.consultationCount).toBe(2);
  });

  it('does not count a case context row belonging to a DIFFERENT engagement', async () => {
    const companyId = await seedCompanyId();
    const expert = await expertDraftFactory();
    const shared = { companyId, expertProfileId: expert.id };
    const a = await caseEngagementFactory(shared);
    const b = await caseEngagementFactory(shared);

    await meetingFactory({ contexts: [{ contextType: 'case', contextId: a.engagement.id }] });

    const result = await caseEngagementsRepository.listOpenForCompanyAndExpert(shared);
    const byId = new Map(result.openCases.map((c) => [c.engagementId, c.consultationCount]));
    expect(byId.get(a.engagement.id)).toBe(1);
    expect(byId.get(b.engagement.id)).toBe(0);
  });

  it('orders MOST-RECENT-ACTIVITY first — a booked meeting outranks a newer, quiet case', async () => {
    const companyId = await seedCompanyId();
    const expert = await expertDraftFactory();
    const shared = { companyId, expertProfileId: expert.id };

    const old = await caseEngagementFactory({
      ...shared,
      values: { createdAt: new Date('2026-01-01T00:00:00.000Z') },
    });
    const fresh = await caseEngagementFactory(shared);

    const start = new Date(Date.now() + 10 * 24 * 3_600_000);
    await meetingFactory({
      contexts: [{ contextType: 'case', contextId: old.engagement.id }],
      values: { scheduledStart: start, scheduledEnd: new Date(start.getTime() + 3_600_000) },
    });

    const result = await caseEngagementsRepository.listOpenForCompanyAndExpert(shared);
    expect(result.openCases.map((c) => c.engagementId)).toEqual([
      old.engagement.id,
      fresh.engagement.id,
    ]);
    expect(result.openCases[0]?.lastActivityAt.getTime()).toBe(start.getTime());
  });

  it('is DETERMINISTIC on a tie — identical clocks fall back to engagement id ASC', async () => {
    const companyId = await seedCompanyId();
    const expert = await expertDraftFactory();
    const shared = { companyId, expertProfileId: expert.id };
    const createdAt = new Date('2026-03-03T03:03:03.000Z');

    const a = await caseEngagementFactory({ ...shared, values: { createdAt } });
    const b = await caseEngagementFactory({ ...shared, values: { createdAt } });
    const c = await caseEngagementFactory({ ...shared, values: { createdAt } });

    const expected = [a.engagement.id, b.engagement.id, c.engagement.id].sort((x, y) =>
      x < y ? -1 : 1
    );

    // Run it twice: a wobbling order would move cards under the cursor between renders.
    const first = await caseEngagementsRepository.listOpenForCompanyAndExpert(shared);
    const second = await caseEngagementsRepository.listOpenForCompanyAndExpert(shared);
    expect(first.openCases.map((r) => r.engagementId)).toEqual(expected);
    expect(second.openCases.map((r) => r.engagementId)).toEqual(expected);
  });

  it('applies `limit` to the OPEN list, and short-circuits on limit <= 0', async () => {
    const companyId = await seedCompanyId();
    const expert = await expertDraftFactory();
    const shared = { companyId, expertProfileId: expert.id };
    await caseEngagementFactory(shared);
    await caseEngagementFactory(shared);
    await caseEngagementFactory(shared);

    const capped = await caseEngagementsRepository.listOpenForCompanyAndExpert({
      ...shared,
      limit: 2,
    });
    expect(capped.openCases).toHaveLength(2);
    await expect(
      caseEngagementsRepository.listOpenForCompanyAndExpert({ ...shared, limit: 0 })
    ).resolves.toEqual({ openCases: [], resolvedCaseCount: 0 });
  });

  it('counts RESOLVED cases for this pair only, and never caps them with `limit`', async () => {
    const companyId = await seedCompanyId();
    const expert = await expertDraftFactory();
    const shared = { companyId, expertProfileId: expert.id };

    await caseEngagementFactory(shared); // open — not counted
    await seedClosedCase(shared);
    await seedClosedCase(shared);
    // Same company, DIFFERENT expert → not this pair's history.
    await seedClosedCase({ companyId });
    // A SOFT-DELETED closed case must not count either.
    await softDeleteEngagementFixture(await seedClosedCase(shared));

    const result = await caseEngagementsRepository.listOpenForCompanyAndExpert({
      ...shared,
      limit: 1,
    });
    expect(result.openCases).toHaveLength(1);
    expect(result.resolvedCaseCount).toBe(2);
  });

  it('returns an empty result for a company/expert pair with no cases at all', async () => {
    const companyId = await seedCompanyId();
    const expert = await expertDraftFactory();
    await expect(
      caseEngagementsRepository.listOpenForCompanyAndExpert({
        companyId,
        expertProfileId: expert.id,
      })
    ).resolves.toEqual({ openCases: [], resolvedCaseCount: 0 });
  });

  it('never returns a PROJECT engagement, even for the same company and expert', async () => {
    const companyId = await seedCompanyId();
    const expert = await expertDraftFactory();
    await engagementFactory({ companyId, expertProfileId: expert.id });

    const result = await caseEngagementsRepository.listOpenForCompanyAndExpert({
      companyId,
      expertProfileId: expert.id,
    });
    expect(result.openCases).toEqual([]);
  });
});
