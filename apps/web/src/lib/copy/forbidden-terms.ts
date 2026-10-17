/**
 * Fee, margin and money language that must stay out of user-facing copy (BAL-493 AC-8, extended
 * to the help centre by BAL-597). The split is by audience:
 *
 * - {@link FEE_TERMS}: nobody sees fee or margin talk, so these are banned everywhere.
 * - {@link EXPERT_MONEY_TERMS}: experts legitimately read about payouts and earnings, but clients
 *   must never see them. A help guide may use these only when it is written for experts alone.
 *
 * The marketing home is public to both sides, so it checks {@link GLOBAL_FORBIDDEN}, the union.
 * Matching is a case-insensitive substring test.
 */
export const FEE_TERMS = ['margin', 'commission', 'take rate', 'our cut', 'platform fee'] as const;

export const EXPERT_MONEY_TERMS = ['earnings', 'payout'] as const;

export const GLOBAL_FORBIDDEN = [...FEE_TERMS, ...EXPERT_MONEY_TERMS] as const;

/** The terms from `terms` present in `text`, case-insensitively, in list order. */
export function forbiddenTermsIn(text: string, terms: readonly string[]): readonly string[] {
  const lowered = text.toLowerCase();
  return terms.filter((term) => lowered.includes(term));
}
