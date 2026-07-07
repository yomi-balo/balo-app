import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../client';
import { companies, partyDomains, auditEvents } from '../schema';
import { userFactory } from '../test/factories';
import { partyDomainsRepository } from './party-domains';

/**
 * Integration tests for the domain auto-capture repo (BAL-344). Uses the in-harness
 * `db` (the injected per-test transaction — auto-rolled-back). `capture` is called
 * with `db` as its executor, so the audit write rides the SAME transaction.
 *
 * Concurrency note: the harness runs each test inside ONE `db.transaction` on a
 * `max:1` pool, so two genuinely parallel transactions cannot race here. True
 * race-safety is a production property of the partial-unique index + ON CONFLICT;
 * the SEQUENTIAL same-domain double-insert below proves the same code path
 * deterministically (a clean skip, never a thrown 23505). We never open a second
 * connection — that would break rollback isolation.
 */

/** Inserts a bare company row and returns its id. */
async function seedCompany(name = 'Acme Co'): Promise<string> {
  const [company] = await db.insert(companies).values({ name, isPersonal: true }).returning();
  if (company === undefined) throw new Error('company insert failed');
  return company.id;
}

/** All live party_domains rows for a domain (test-local; excludes soft-deleted). */
async function liveRowsForDomain(domain: string): Promise<(typeof partyDomains.$inferSelect)[]> {
  return db
    .select()
    .from(partyDomains)
    .where(and(eq(partyDomains.domain, domain), isNull(partyDomains.deletedAt)));
}

/** All audit_events rows for a party_domains entity id. */
async function auditRowsForEntity(entityId: string): Promise<(typeof auditEvents.$inferSelect)[]> {
  return db.select().from(auditEvents).where(eq(auditEvents.entityId, entityId));
}

describe('partyDomainsRepository.capture', () => {
  it('captures a fresh corporate domain, normalises it, and writes the audit row in the same tx', async () => {
    const actor = await userFactory();
    const companyId = await seedCompany();

    // Mixed-case input proves the repo re-normalises defensively before insert.
    const result = await partyDomainsRepository.capture(
      { partyType: 'company', partyId: companyId, domain: 'ACME.com', actorUserId: actor.id },
      db
    );

    expect(result).toEqual({ outcome: 'captured', partyType: 'company', source: 'auto_captured' });

    const live = await liveRowsForDomain('acme.com');
    expect(live).toHaveLength(1);
    const [row] = live;
    if (row === undefined) throw new Error('expected a live party_domains row');
    expect(row.partyType).toBe('company');
    expect(row.partyId).toBe(companyId);
    expect(row.domain).toBe('acme.com'); // lowercased
    expect(row.source).toBe('auto_captured');
    expect(row.createdByUserId).toBe(actor.id);
    expect(row.deletedAt).toBeNull();

    // The audit row committed in the SAME transaction as the mapping.
    const audits = await auditRowsForEntity(row.id);
    expect(audits).toHaveLength(1);
    const [audit] = audits;
    if (audit === undefined) throw new Error('expected an audit row');
    expect(audit.action).toBe('party_domain.captured');
    expect(audit.entityType).toBe('party_domain');
    expect(audit.entityId).toBe(row.id);
    expect(audit.actorUserId).toBe(actor.id);
    expect(audit.metadata).toMatchObject({
      domain: 'acme.com',
      partyType: 'company',
      source: 'auto_captured',
    });
  });

  it('skips a blocked freemail domain — no mapping row, no audit row', async () => {
    const actor = await userFactory();
    const companyId = await seedCompany();

    const result = await partyDomainsRepository.capture(
      { partyType: 'company', partyId: companyId, domain: 'gmail.com', actorUserId: actor.id },
      db
    );

    expect(result).toEqual({ outcome: 'skipped', reason: 'blocked_domain' });
    await expect(liveRowsForDomain('gmail.com')).resolves.toHaveLength(0);
    // No audit rows at all for this domain's (non-existent) entity.
    const allAudits = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, 'party_domain.captured'));
    expect(allAudits).toHaveLength(0);
  });

  it('returns not_applicable for an empty domain — no row, no audit', async () => {
    const actor = await userFactory();
    const companyId = await seedCompany();

    const result = await partyDomainsRepository.capture(
      { partyType: 'company', partyId: companyId, domain: '   ', actorUserId: actor.id },
      db
    );

    expect(result).toEqual({ outcome: 'not_applicable' });
  });

  it('skips already_claimed when a different party owns the live domain (one winner, no 500)', async () => {
    const actorA = await userFactory();
    const actorB = await userFactory();
    const companyA = await seedCompany('Company A');
    const companyB = await seedCompany('Company B');

    const first = await partyDomainsRepository.capture(
      { partyType: 'company', partyId: companyA, domain: 'shared.com', actorUserId: actorA.id },
      db
    );
    expect(first.outcome).toBe('captured');

    // The SEQUENTIAL same-domain double-insert: the arbiter (partial unique index)
    // makes this a clean DO-NOTHING skip, NOT a thrown 23505.
    const second = await partyDomainsRepository.capture(
      { partyType: 'company', partyId: companyB, domain: 'shared.com', actorUserId: actorB.id },
      db
    );
    expect(second).toEqual({ outcome: 'skipped', reason: 'already_claimed' });

    // Exactly one live row — company A still owns it.
    const live = await liveRowsForDomain('shared.com');
    expect(live).toHaveLength(1);
    expect(live[0]?.partyId).toBe(companyA);

    // No second audit row (only the first capture wrote one).
    const audits = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, 'party_domain.captured'));
    expect(audits).toHaveLength(1);
  });

  it('is idempotent — re-capturing the same (party, domain) returns already_owned with no double audit', async () => {
    const actor = await userFactory();
    const companyId = await seedCompany();

    const first = await partyDomainsRepository.capture(
      { partyType: 'company', partyId: companyId, domain: 'acme.com', actorUserId: actor.id },
      db
    );
    expect(first.outcome).toBe('captured');

    const second = await partyDomainsRepository.capture(
      { partyType: 'company', partyId: companyId, domain: 'acme.com', actorUserId: actor.id },
      db
    );
    expect(second).toEqual({ outcome: 'already_owned' });

    await expect(liveRowsForDomain('acme.com')).resolves.toHaveLength(1);
    const audits = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, 'party_domain.captured'));
    expect(audits).toHaveLength(1); // exactly one — no double audit
  });

  it('lets a soft-deleted mapping free the slot for re-capture by a different party', async () => {
    const actorA = await userFactory();
    const actorB = await userFactory();
    const companyA = await seedCompany('Company A');
    const companyB = await seedCompany('Company B');

    const first = await partyDomainsRepository.capture(
      { partyType: 'company', partyId: companyA, domain: 'acme.com', actorUserId: actorA.id },
      db
    );
    expect(first.outcome).toBe('captured');

    const [original] = await liveRowsForDomain('acme.com');
    if (original === undefined) throw new Error('expected the original mapping');

    // Soft-delete the mapping (records who deleted it).
    await db
      .update(partyDomains)
      .set({ deletedAt: new Date(), deletedByUserId: actorA.id })
      .where(eq(partyDomains.id, original.id));

    // The soft-deleted row is outside the partial unique index → re-capture inserts
    // a fresh live row for a DIFFERENT party (regression guard for the
    // softdelete + non-partial-unique re-create hazard).
    const reCaptured = await partyDomainsRepository.capture(
      { partyType: 'company', partyId: companyB, domain: 'acme.com', actorUserId: actorB.id },
      db
    );
    expect(reCaptured).toEqual({
      outcome: 'captured',
      partyType: 'company',
      source: 'auto_captured',
    });

    const live = await liveRowsForDomain('acme.com');
    expect(live).toHaveLength(1);
    expect(live[0]?.id).not.toBe(original.id);
    expect(live[0]?.partyId).toBe(companyB);
  });

  it('rolls back BOTH the mapping and the audit row when the surrounding tx throws', async () => {
    const actor = await userFactory();
    const companyId = await seedCompany();

    await expect(
      db.transaction(async (tx) => {
        const result = await partyDomainsRepository.capture(
          {
            partyType: 'company',
            partyId: companyId,
            domain: 'rollback.com',
            actorUserId: actor.id,
          },
          tx
        );
        expect(result.outcome).toBe('captured');
        throw new Error('force rollback');
      })
    ).rejects.toThrow('force rollback');

    // Neither the mapping nor its audit row survived the rollback.
    await expect(liveRowsForDomain('rollback.com')).resolves.toHaveLength(0);
    const audits = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, 'party_domain.captured'));
    expect(audits).toHaveLength(0);
  });

  it('respects a caller-supplied source (admin_added)', async () => {
    const actor = await userFactory();
    const companyId = await seedCompany();

    const result = await partyDomainsRepository.capture(
      {
        partyType: 'company',
        partyId: companyId,
        domain: 'admin.com',
        actorUserId: actor.id,
        source: 'admin_added',
      },
      db
    );

    expect(result).toEqual({ outcome: 'captured', partyType: 'company', source: 'admin_added' });
    const [row] = await liveRowsForDomain('admin.com');
    expect(row?.source).toBe('admin_added');
  });
});

describe('partyDomainsRepository.listByParty', () => {
  it('returns live domains for a party and excludes soft-deleted', async () => {
    const actor = await userFactory();
    const companyId = await seedCompany();
    const otherCompanyId = await seedCompany('Other Co');

    await partyDomainsRepository.capture(
      { partyType: 'company', partyId: companyId, domain: 'one.com', actorUserId: actor.id },
      db
    );
    await partyDomainsRepository.capture(
      { partyType: 'company', partyId: companyId, domain: 'two.com', actorUserId: actor.id },
      db
    );
    // A domain owned by a different party must not leak into this party's list.
    await partyDomainsRepository.capture(
      { partyType: 'company', partyId: otherCompanyId, domain: 'other.com', actorUserId: actor.id },
      db
    );

    // Soft-delete one of this party's domains.
    const [gone] = await liveRowsForDomain('one.com');
    if (gone === undefined) throw new Error('expected one.com mapping');
    await db
      .update(partyDomains)
      .set({ deletedAt: new Date(), deletedByUserId: actor.id })
      .where(eq(partyDomains.id, gone.id));

    const rows = await partyDomainsRepository.listByParty('company', companyId);
    const domains = rows.map((r) => r.domain);
    expect(domains).toEqual(['two.com']);
  });

  it('returns an empty array for a party with no domains', async () => {
    const rows = await partyDomainsRepository.listByParty('company', randomUUID());
    expect(rows).toEqual([]);
  });
});
