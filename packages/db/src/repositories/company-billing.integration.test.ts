import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '../client';
import { companies, companyBillingDetails } from '../schema';
import { userFactory, projectRequestFactory } from '../test/factories';
import { companyBillingRepository, ensureClientBillingGateConfirmed } from './company-billing';
import { projectRequestsRepository } from './project-requests';

/** Inserts a bare (non-personal-defaulting) company row and returns its id. */
async function seedCompany(): Promise<string> {
  const [company] = await db
    .insert(companies)
    .values({ name: 'Acme Co', isPersonal: true })
    .returning();
  if (company === undefined) {
    throw new Error('company insert failed');
  }
  return company.id;
}

/** Seeds a company + a submitter user, returning both ids. */
async function seedCompanyAndUser(): Promise<{ companyId: string; userId: string }> {
  const companyId = await seedCompany();
  const user = await userFactory();
  return { companyId, userId: user.id };
}

// ── companyBillingRepository.upsertByCompanyId ───────────────────────

describe('companyBillingRepository.upsertByCompanyId', () => {
  it('inserts a new row when none exists — fields round-trip, no deletedAt', async () => {
    const { companyId, userId } = await seedCompanyAndUser();

    const row = await companyBillingRepository.upsertByCompanyId({
      companyId,
      legalName: 'Acme Legal Pty Ltd',
      countryCode: 'AU',
      taxId: '12 345 678 901',
      address: '1 George St, Sydney NSW 2000',
      billingEmail: 'billing@acme.test',
      submittedByUserId: userId,
    });

    expect(row.id).toBeDefined();
    expect(row.companyId).toBe(companyId);
    expect(row.legalName).toBe('Acme Legal Pty Ltd');
    expect(row.countryCode).toBe('AU');
    expect(row.taxId).toBe('12 345 678 901');
    expect(row.address).toBe('1 George St, Sydney NSW 2000');
    expect(row.billingEmail).toBe('billing@acme.test');
    expect(row.submittedByUserId).toBe(userId);
    expect(row.createdAt).toBeInstanceOf(Date);
    expect(row.updatedAt).toBeInstanceOf(Date);
    // Single current fact — no soft-delete column exists on this table.
    expect('deletedAt' in row).toBe(false);
  });

  it('updates in place on conflict — mutates every field, id unchanged', async () => {
    const { companyId, userId } = await seedCompanyAndUser();
    const secondUser = await userFactory();

    const first = await companyBillingRepository.upsertByCompanyId({
      companyId,
      legalName: 'Acme Legal Pty Ltd',
      countryCode: 'AU',
      taxId: 'AU-TAX-1',
      address: 'Old address',
      billingEmail: 'old@acme.test',
      submittedByUserId: userId,
    });

    const second = await companyBillingRepository.upsertByCompanyId({
      companyId,
      legalName: 'Acme Global Inc',
      countryCode: 'US',
      taxId: 'US-EIN-9',
      address: 'New address',
      billingEmail: 'new@acme.test',
      submittedByUserId: secondUser.id,
    });

    expect(second.id).toBe(first.id); // same row, updated in place
    expect(second.legalName).toBe('Acme Global Inc');
    expect(second.countryCode).toBe('US');
    expect(second.taxId).toBe('US-EIN-9');
    expect(second.address).toBe('New address');
    expect(second.billingEmail).toBe('new@acme.test');
    expect(second.submittedByUserId).toBe(secondUser.id);
  });

  it('enforces one row per company — two upserts leave exactly one row', async () => {
    const { companyId, userId } = await seedCompanyAndUser();

    await companyBillingRepository.upsertByCompanyId({
      companyId,
      legalName: 'First',
      countryCode: 'AU',
      billingEmail: 'first@acme.test',
      submittedByUserId: userId,
    });
    await companyBillingRepository.upsertByCompanyId({
      companyId,
      legalName: 'Second',
      countryCode: 'AU',
      billingEmail: 'second@acme.test',
      submittedByUserId: userId,
    });

    const rows = await db
      .select()
      .from(companyBillingDetails)
      .where(eq(companyBillingDetails.companyId, companyId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.legalName).toBe('Second');
  });

  it('persists null taxId and address when omitted (nullable columns)', async () => {
    const { companyId, userId } = await seedCompanyAndUser();

    const row = await companyBillingRepository.upsertByCompanyId({
      companyId,
      legalName: 'No Tax Co',
      countryCode: 'AU',
      billingEmail: 'billing@notax.test',
      submittedByUserId: userId,
    });

    expect(row.taxId).toBeNull();
    expect(row.address).toBeNull();
  });

  it('bumps updatedAt on update while preserving createdAt', async () => {
    const { companyId, userId } = await seedCompanyAndUser();

    const first = await companyBillingRepository.upsertByCompanyId({
      companyId,
      legalName: 'First',
      countryCode: 'AU',
      billingEmail: 'first@acme.test',
      submittedByUserId: userId,
    });

    const second = await companyBillingRepository.upsertByCompanyId({
      companyId,
      legalName: 'Second',
      countryCode: 'AU',
      billingEmail: 'second@acme.test',
      submittedByUserId: userId,
    });

    expect(second.createdAt.getTime()).toBe(first.createdAt.getTime());
    // Compare against the first row's createdAt (the transaction-start timestamp),
    // NOT first.updatedAt: under transaction-per-test both insert timestamps equal the
    // transaction start, so a `>= first.updatedAt` check is a tautology that passes even
    // if the onConflict `updatedAt` bump is dropped. The bump sets updatedAt to a JS
    // `new Date()` captured after the transaction started, so it is strictly greater —
    // this assertion fails if the bump ever regresses.
    expect(second.updatedAt.getTime()).toBeGreaterThan(first.createdAt.getTime());
  });

  it('throws on a non-existent companyId (cascade FK enforcement)', async () => {
    const user = await userFactory();

    await expect(
      companyBillingRepository.upsertByCompanyId({
        companyId: randomUUID(),
        legalName: 'Orphan Co',
        countryCode: 'AU',
        billingEmail: 'orphan@acme.test',
        submittedByUserId: user.id,
      })
    ).rejects.toThrow();
  });

  it('throws on a non-existent submittedByUserId (restrict FK enforcement)', async () => {
    const companyId = await seedCompany();

    await expect(
      companyBillingRepository.upsertByCompanyId({
        companyId,
        legalName: 'Bad Submitter Co',
        countryCode: 'AU',
        billingEmail: 'billing@acme.test',
        submittedByUserId: randomUUID(),
      })
    ).rejects.toThrow();
  });
});

// ── companyBillingRepository.findByCompanyId ─────────────────────────

describe('companyBillingRepository.findByCompanyId', () => {
  it('returns the row for a company that has billing details', async () => {
    const { companyId, userId } = await seedCompanyAndUser();

    await companyBillingRepository.upsertByCompanyId({
      companyId,
      legalName: 'Findable Co',
      countryCode: 'AU',
      billingEmail: 'billing@findable.test',
      submittedByUserId: userId,
    });

    const found = await companyBillingRepository.findByCompanyId(companyId);
    expect(found).toBeDefined();
    expect(found?.companyId).toBe(companyId);
    expect(found?.legalName).toBe('Findable Co');
  });

  it('returns undefined for a company with no billing details', async () => {
    const companyId = await seedCompany();

    const found = await companyBillingRepository.findByCompanyId(companyId);
    expect(found).toBeUndefined();
  });
});

// ── ensureClientBillingGateConfirmed ─────────────────────────────────

describe('ensureClientBillingGateConfirmed', () => {
  it('[branch 1] throws for an unknown or soft-deleted request', async () => {
    // Unknown id.
    await expect(ensureClientBillingGateConfirmed(randomUUID())).rejects.toThrow();

    // Soft-deleted request → findById returns undefined → throws (fail loud).
    const deleted = await projectRequestFactory({
      status: 'accepted',
      deletedAt: new Date(),
    });
    await expect(ensureClientBillingGateConfirmed(deleted.id)).rejects.toThrow();
  });

  it('[branch 2] no-op when clientBillingConfirmedAt is already set (before the status check)', async () => {
    const alreadyConfirmedAt = new Date('2026-01-01T00:00:00.000Z');
    // Deliberately NON-accepted status: proves the already-confirmed check runs
    // BEFORE the status guard (would otherwise never reach here).
    const request = await projectRequestFactory({
      status: 'proposal_submitted',
      clientBillingConfirmedAt: alreadyConfirmedAt,
    });

    await expect(ensureClientBillingGateConfirmed(request.id)).resolves.toBeUndefined();

    const reloaded = await projectRequestsRepository.findById(request.id);
    expect(reloaded?.clientBillingConfirmedAt?.getTime()).toBe(alreadyConfirmedAt.getTime());
  });

  it('[branch 3] no-op when no billing details exist for the company (status accepted)', async () => {
    const request = await projectRequestFactory({ status: 'accepted' });
    // No billing seeded for request.companyId.

    await expect(ensureClientBillingGateConfirmed(request.id)).resolves.toBeUndefined();

    const reloaded = await projectRequestsRepository.findById(request.id);
    expect(reloaded?.clientBillingConfirmedAt).toBeNull();
  });

  it('[branch 4] no-op when status is not accepted even though billing exists (no InvalidKickoffStateError)', async () => {
    const request = await projectRequestFactory({ status: 'proposal_submitted' });
    await companyBillingRepository.upsertByCompanyId({
      companyId: request.companyId,
      legalName: 'Billing Co',
      countryCode: 'AU',
      billingEmail: 'billing@co.test',
      submittedByUserId: request.createdByUserId,
    });

    await expect(ensureClientBillingGateConfirmed(request.id)).resolves.toBeUndefined();

    const reloaded = await projectRequestsRepository.findById(request.id);
    expect(reloaded?.clientBillingConfirmedAt).toBeNull();
    expect(reloaded?.status).toBe('proposal_submitted');
  });

  it('[branch 5] confirms the gate when status is accepted AND billing exists', async () => {
    const request = await projectRequestFactory({ status: 'accepted' });
    await companyBillingRepository.upsertByCompanyId({
      companyId: request.companyId,
      legalName: 'Billing Co',
      countryCode: 'AU',
      billingEmail: 'billing@co.test',
      submittedByUserId: request.createdByUserId,
    });

    await ensureClientBillingGateConfirmed(request.id);

    const reloaded = await projectRequestsRepository.findById(request.id);
    expect(reloaded?.clientBillingConfirmedAt).toBeInstanceOf(Date);
  });

  it('[idempotency] a second call after a confirm preserves the original timestamp', async () => {
    const request = await projectRequestFactory({ status: 'accepted' });
    await companyBillingRepository.upsertByCompanyId({
      companyId: request.companyId,
      legalName: 'Billing Co',
      countryCode: 'AU',
      billingEmail: 'billing@co.test',
      submittedByUserId: request.createdByUserId,
    });

    await ensureClientBillingGateConfirmed(request.id);
    const afterFirst = await projectRequestsRepository.findById(request.id);
    const firstAt = afterFirst?.clientBillingConfirmedAt;
    expect(firstAt).toBeInstanceOf(Date);

    await ensureClientBillingGateConfirmed(request.id);
    const afterSecond = await projectRequestsRepository.findById(request.id);

    expect(afterSecond?.clientBillingConfirmedAt?.getTime()).toBe(firstAt?.getTime());
  });
});
