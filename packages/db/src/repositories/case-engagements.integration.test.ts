import { describe, it, expect } from 'vitest';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../client';
import {
  auditEvents,
  caseEngagements,
  companies,
  companyMembers,
  conversationContexts,
  engagements,
  reviews,
  type AuditEvent,
} from '../schema';
import {
  caseEngagementFactory,
  companyFactory,
  companyMemberFactory,
  engagementFactory,
  expertDraftFactory,
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
import { expectCheckViolation } from '../test/helpers/expect-check-violation';

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
    // ⚠ D5: `close()` has no production caller, so in production EVERY case is in this
    // state and this reader legitimately returns nothing. It self-activates unchanged.
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
