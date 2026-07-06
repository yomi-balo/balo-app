import type {
  CompanyBillingDetails,
  Proposal,
  ProposalMilestone,
  ProposalPaymentInstallment,
} from '@balo/db';

/**
 * BAL-324 — the admin-only kickoff billing + payment-terms projection. Fully
 * serializable (plain data, no Date/undefined) so it crosses the RSC boundary
 * into the server-rendered panel. `billing` is `null` until the client captures
 * their company billing details; `terms` is `null` when no accepted proposal
 * resolves for the relationship.
 */
export interface AdminKickoffBillingView {
  billing: {
    legalName: string;
    countryCode: string;
    taxId: string | null;
    address: string | null;
    billingEmail: string;
  } | null;
  terms: {
    pricingMethod: 'fixed' | 'tm';
    currency: string;
    /** For `tm` this is a non-binding ESTIMATE, not a committed total. */
    priceCents: number;
    depositCents: number | null;
    rateCents: number | null;
    cadence: 'monthly' | 'fortnightly' | null;
    /** Fixed-only % splits; `amountCents` is DERIVED here (never stored). */
    installments: { id: string; label: string; pct: number; amountCents: number }[];
    milestones: {
      id: string;
      title: string;
      /** Fixed-only line value; `null` for T&M. */
      valueCents: number | null;
      /** T&M-only effort estimate in minutes; `null` for Fixed. */
      estimatedMinutes: number | null;
    }[];
  } | null;
}

/**
 * Pure mapper: hydrated DB rows → serializable admin billing view-model. No I/O,
 * deterministic — the async loader (`load-admin-kickoff-billing.ts`) fetches, this
 * shapes. `undefined` billing/proposal collapse to `null`. Installment amounts are
 * derived `round(priceCents * pct / 100)` (the DB never stores them — BAL-294).
 */
export function mapAdminKickoffBillingView(
  billing: CompanyBillingDetails | null | undefined,
  proposal: Proposal | null | undefined,
  milestones: ProposalMilestone[],
  installments: ProposalPaymentInstallment[]
): AdminKickoffBillingView {
  return {
    billing:
      billing == null
        ? null
        : {
            legalName: billing.legalName,
            countryCode: billing.countryCode,
            taxId: billing.taxId ?? null,
            address: billing.address ?? null,
            billingEmail: billing.billingEmail,
          },
    terms:
      proposal == null
        ? null
        : {
            pricingMethod: proposal.pricingMethod,
            currency: proposal.currency,
            priceCents: proposal.priceCents,
            depositCents: proposal.depositCents,
            rateCents: proposal.rateCents,
            cadence: proposal.cadence,
            installments: installments.map((inst) => ({
              id: inst.id,
              label: inst.label,
              pct: inst.pct,
              amountCents: Math.round((proposal.priceCents * inst.pct) / 100),
            })),
            milestones: milestones.map((m) => ({
              id: m.id,
              title: m.title,
              valueCents: m.valueCents,
              estimatedMinutes: m.estimatedMinutes,
            })),
          },
  };
}
