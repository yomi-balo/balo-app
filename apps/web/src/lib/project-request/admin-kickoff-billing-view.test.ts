import { describe, it, expect } from 'vitest';
import type {
  CompanyBillingDetails,
  Proposal,
  ProposalMilestone,
  ProposalPaymentInstallment,
} from '@balo/db';
import { mapAdminKickoffBillingView } from './admin-kickoff-billing-view';

function billing(overrides: Partial<CompanyBillingDetails> = {}): CompanyBillingDetails {
  return {
    id: 'b1',
    companyId: 'c1',
    legalName: 'Acme Pty Ltd',
    countryCode: 'AU',
    taxId: '12345678901',
    address: '1 King St',
    billingEmail: 'billing@acme.test',
    submittedByUserId: 'u1',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as CompanyBillingDetails;
}

function proposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: 'p1',
    pricingMethod: 'fixed',
    priceCents: 7_800_000,
    currency: 'aud',
    depositCents: null,
    rateCents: null,
    cadence: null,
    ...overrides,
  } as Proposal;
}

describe('mapAdminKickoffBillingView', () => {
  it('collapses undefined/null billing to null', () => {
    expect(mapAdminKickoffBillingView(undefined, null, [], []).billing).toBeNull();
    expect(mapAdminKickoffBillingView(null, null, [], []).billing).toBeNull();
  });

  it('maps billing fields and coerces missing tax id / address to null', () => {
    const view = mapAdminKickoffBillingView(billing({ taxId: null, address: null }), null, [], []);
    expect(view.billing).toEqual({
      legalName: 'Acme Pty Ltd',
      countryCode: 'AU',
      taxId: null,
      address: null,
      billingEmail: 'billing@acme.test',
    });
  });

  it('returns null terms when there is no accepted proposal', () => {
    expect(mapAdminKickoffBillingView(billing(), null, [], []).terms).toBeNull();
    expect(mapAdminKickoffBillingView(billing(), undefined, [], []).terms).toBeNull();
  });

  it('derives installment amounts as round(priceCents * pct / 100)', () => {
    const installments = [
      { id: 'i1', label: 'Upfront', pct: 30 },
      { id: 'i2', label: 'On delivery', pct: 70 },
    ] as ProposalPaymentInstallment[];

    const view = mapAdminKickoffBillingView(billing(), proposal(), [], installments);

    expect(view.terms?.installments).toEqual([
      { id: 'i1', label: 'Upfront', pct: 30, amountCents: 2_340_000 },
      { id: 'i2', label: 'On delivery', pct: 70, amountCents: 5_460_000 },
    ]);
  });

  it('rounds a non-integer derived installment amount', () => {
    const installments = [{ id: 'i1', label: 'Third', pct: 33 }] as ProposalPaymentInstallment[];
    // round(100 * 33 / 100) = 33
    const view = mapAdminKickoffBillingView(
      billing(),
      proposal({ priceCents: 100 }),
      [],
      installments
    );
    expect(view.terms?.installments[0]?.amountCents).toBe(33);
  });

  it('passes through T&M terms + milestone effort', () => {
    const milestones = [
      { id: 'm1', title: 'Build', valueCents: null, estimatedMinutes: 480 },
    ] as ProposalMilestone[];

    const view = mapAdminKickoffBillingView(
      billing(),
      proposal({
        pricingMethod: 'tm',
        depositCents: 1_000_000,
        rateCents: 25_000,
        cadence: 'monthly',
      }),
      milestones,
      []
    );

    expect(view.terms).toMatchObject({
      pricingMethod: 'tm',
      depositCents: 1_000_000,
      rateCents: 25_000,
      cadence: 'monthly',
      milestones: [{ id: 'm1', title: 'Build', valueCents: null, estimatedMinutes: 480 }],
    });
  });
});
