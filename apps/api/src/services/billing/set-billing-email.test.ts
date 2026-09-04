import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockSetBillingEmail,
  mockFindByCompanyId,
  mockSyncStripeCustomerIdentity,
  mockPublishBillingEmailChanged,
  mockTrackServer,
  mockLog,
} = vi.hoisted(() => ({
  mockSetBillingEmail: vi.fn(),
  mockFindByCompanyId: vi.fn(),
  mockSyncStripeCustomerIdentity: vi.fn(),
  mockPublishBillingEmailChanged: vi.fn(),
  mockTrackServer: vi.fn(),
  mockLog: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@balo/shared/logging', () => ({ createLogger: () => mockLog }));
vi.mock('@balo/db', () => ({
  companiesRepository: { setBillingEmail: mockSetBillingEmail },
  creditWalletsRepository: { findByCompanyId: mockFindByCompanyId },
}));
vi.mock('@balo/analytics/server', () => ({
  trackServer: mockTrackServer,
  BILLING_SERVER_EVENTS: { EMAIL_UPDATED: 'billing_email_updated' },
}));
vi.mock('../stripe/index.js', () => ({
  syncStripeCustomerIdentity: (...args: unknown[]) => mockSyncStripeCustomerIdentity(...args),
}));
vi.mock('./billing-email-notify.js', () => ({
  publishBillingEmailChanged: (...args: unknown[]) => mockPublishBillingEmailChanged(...args),
}));

import { setCompanyBillingEmail } from './set-billing-email.js';

const COMPANY_ID = 'company_1';
const ACTOR_USER_ID = 'user_1';

beforeEach(() => {
  vi.clearAllMocks();
  mockPublishBillingEmailChanged.mockResolvedValue(undefined);
});

describe('setCompanyBillingEmail', () => {
  it('changed ⇒ syncs Stripe, publishes billing.email_changed with a colon-free correlationId, and tracks billing_email_updated', async () => {
    const setAt = new Date('2026-08-10T00:00:00.000Z');
    const previousSetAt = new Date('2026-08-01T00:00:00.000Z');
    mockSetBillingEmail.mockResolvedValue({
      outcome: 'changed',
      company: { name: 'Northwind Industrial', isPersonal: false },
      billingEmail: 'dana@northwind.test',
      setAt,
      previousEmail: 'old@northwind.test',
      previousSource: 'seeded',
      previousSetAt,
      auditEventId: 'audit_1',
    });
    mockFindByCompanyId.mockResolvedValue({ stripeCustomerId: 'cus_1' });

    const result = await setCompanyBillingEmail({
      companyId: COMPANY_ID,
      actorUserId: ACTOR_USER_ID,
      billingEmail: 'dana@northwind.test',
    });

    expect(result).toEqual({
      status: 'updated',
      billingEmail: 'dana@northwind.test',
      setAt,
    });
    expect(mockSyncStripeCustomerIdentity).toHaveBeenCalledWith('cus_1', {
      name: 'Northwind Industrial',
      email: 'dana@northwind.test',
    });
    expect(mockPublishBillingEmailChanged).toHaveBeenCalledTimes(1);
    const [notice] = mockPublishBillingEmailChanged.mock.calls[0] as [
      { companyId: string; newEmail: string; previousEmail: string | null; dedupKey: string },
    ];
    expect(notice).toMatchObject({
      companyId: COMPANY_ID,
      newEmail: 'dana@northwind.test',
      previousEmail: 'old@northwind.test',
      changedByUserId: ACTOR_USER_ID,
      dedupKey: 'audit_1',
    });
    expect(mockTrackServer).toHaveBeenCalledWith('billing_email_updated', {
      company_id: COMPANY_ID,
      company_is_personal: false,
      previous_source: 'seeded',
      days_since_set: 9,
      distinct_id: COMPANY_ID,
    });
  });

  it('unchanged ⇒ sync STILL runs; publish and trackServer are NOT called', async () => {
    mockSetBillingEmail.mockResolvedValue({
      outcome: 'unchanged',
      company: { name: 'Northwind Industrial', isPersonal: false },
      billingEmail: 'dana@northwind.test',
      setAt: new Date('2026-08-01T00:00:00.000Z'),
    });
    mockFindByCompanyId.mockResolvedValue({ stripeCustomerId: 'cus_1' });

    const result = await setCompanyBillingEmail({
      companyId: COMPANY_ID,
      actorUserId: ACTOR_USER_ID,
      billingEmail: 'dana@northwind.test',
    });

    expect(result.status).toBe('unchanged');
    expect(mockSyncStripeCustomerIdentity).toHaveBeenCalledTimes(1);
    expect(mockPublishBillingEmailChanged).not.toHaveBeenCalled();
    expect(mockTrackServer).not.toHaveBeenCalled();
  });

  it('no wallet ⇒ no sync attempted; still resolves updated; publish still fires', async () => {
    mockSetBillingEmail.mockResolvedValue({
      outcome: 'changed',
      company: { name: 'Northwind Industrial', isPersonal: false },
      billingEmail: 'dana@northwind.test',
      setAt: new Date(),
      previousEmail: null,
      previousSource: null,
      previousSetAt: null,
      auditEventId: 'audit_2',
    });
    mockFindByCompanyId.mockResolvedValue(undefined);

    const result = await setCompanyBillingEmail({
      companyId: COMPANY_ID,
      actorUserId: ACTOR_USER_ID,
      billingEmail: 'dana@northwind.test',
    });

    expect(result.status).toBe('updated');
    expect(mockSyncStripeCustomerIdentity).not.toHaveBeenCalled();
    expect(mockPublishBillingEmailChanged).toHaveBeenCalledTimes(1);
  });

  it('a wallet with stripeCustomerId === null ⇒ no sync attempted; still resolves updated', async () => {
    mockSetBillingEmail.mockResolvedValue({
      outcome: 'changed',
      company: { name: 'Northwind Industrial', isPersonal: false },
      billingEmail: 'dana@northwind.test',
      setAt: new Date(),
      previousEmail: null,
      previousSource: null,
      previousSetAt: null,
      auditEventId: 'audit_3',
    });
    mockFindByCompanyId.mockResolvedValue({ stripeCustomerId: null });

    const result = await setCompanyBillingEmail({
      companyId: COMPANY_ID,
      actorUserId: ACTOR_USER_ID,
      billingEmail: 'dana@northwind.test',
    });

    expect(result.status).toBe('updated');
    expect(mockSyncStripeCustomerIdentity).not.toHaveBeenCalled();
  });

  it('not_found ⇒ returns immediately; no sync, no publish, no analytics', async () => {
    mockSetBillingEmail.mockResolvedValue({ outcome: 'not_found' });

    const result = await setCompanyBillingEmail({
      companyId: COMPANY_ID,
      actorUserId: ACTOR_USER_ID,
      billingEmail: 'dana@northwind.test',
    });

    expect(result).toEqual({ status: 'not_found' });
    expect(mockFindByCompanyId).not.toHaveBeenCalled();
    expect(mockSyncStripeCustomerIdentity).not.toHaveBeenCalled();
    expect(mockPublishBillingEmailChanged).not.toHaveBeenCalled();
    expect(mockTrackServer).not.toHaveBeenCalled();
  });

  it('forbidden ⇒ returns immediately; no sync, no publish, no analytics', async () => {
    mockSetBillingEmail.mockResolvedValue({ outcome: 'forbidden' });

    const result = await setCompanyBillingEmail({
      companyId: COMPANY_ID,
      actorUserId: ACTOR_USER_ID,
      billingEmail: 'dana@northwind.test',
    });

    expect(result).toEqual({ status: 'forbidden' });
    expect(mockFindByCompanyId).not.toHaveBeenCalled();
    expect(mockPublishBillingEmailChanged).not.toHaveBeenCalled();
  });

  it('a publish failure never throws — the call still resolves updated', async () => {
    mockSetBillingEmail.mockResolvedValue({
      outcome: 'changed',
      company: { name: 'Northwind Industrial', isPersonal: false },
      billingEmail: 'dana@northwind.test',
      setAt: new Date(),
      previousEmail: null,
      previousSource: null,
      previousSetAt: null,
      auditEventId: 'audit_4',
    });
    mockFindByCompanyId.mockResolvedValue({ stripeCustomerId: 'cus_1' });
    // ⚠ A REAL REJECTION. The previous version of this test mocked `mockResolvedValue(undefined)`
    // — no failure at all — so it passed whether or not the caller guarded the publish. The write
    // and its audit row have ALREADY committed by this point, so a queue fault must surface as a
    // logged error, never as a failed save.
    mockPublishBillingEmailChanged.mockRejectedValue(new Error('queue down'));

    await expect(
      setCompanyBillingEmail({
        companyId: COMPANY_ID,
        actorUserId: ACTOR_USER_ID,
        billingEmail: 'dana@northwind.test',
      })
    ).resolves.toEqual({
      status: 'updated',
      billingEmail: 'dana@northwind.test',
      setAt: expect.any(Date),
    });
    expect(mockLog.error).toHaveBeenCalledTimes(1);
  });
});
