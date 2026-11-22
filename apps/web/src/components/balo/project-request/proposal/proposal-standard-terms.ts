/**
 * The Balo Project T&Cs summary shown on every proposal. Hoisted out of the composer so
 * the composer (authoring), the read-only proposal document, the accept dialog and the PDF
 * share one source of truth. Each line restates something the agreement itself says.
 */
export const STANDARD_TERMS = [
  // Summarises clause 5.1
  'Work is delivered against the milestones and scope set out in this proposal.',
  // Summarises section 8 (Confidentiality)
  'Confidential information shared during the engagement stays confidential.',
];

/** Balo's rule for how a cost increase is handled, by pricing method (ADR-1057). */
export function pricingMethodRule(method: 'fixed' | 'tm', companyName: string): string {
  if (method === 'fixed') {
    return `This is a fixed-price project. Any increase in cost is only charged if ${companyName} approves it.`;
  }
  return `This is a time and materials project. ${companyName} is billed for the hours logged each billing period. If a milestone goes over its estimate, ${companyName} is told, and raising an estimate needs ${companyName}'s approval.`;
}

/** Introduces the expert's additional terms: they sit on top of the Balo Project T&Cs. */
export const BALO_TERMS_ADDITIVE_SENTENCE = 'These add to Balo’s Project T&Cs.';

/**
 * Deliberately not rendered until MJ settles clause 2.2 vs 5.7 (BAL-661). Exported so the
 * document, composer and dialog tests can assert it is absent.
 */
export const BALO_TERMS_PRECEDENCE_SENTENCE =
  'Where one conflicts with Balo’s Project T&Cs, Balo’s apply.';
