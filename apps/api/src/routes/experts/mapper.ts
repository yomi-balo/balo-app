import type { ExpertSearchRow } from '@balo/db';
import { publicDisplayRatePerMinute } from '@balo/shared/pricing';
import type { ExpertSearchResult } from './types.js';

/**
 * Pure DB-row → result-DTO mapper. No DB access. `now` is injected so
 * `yearsExperience` is deterministic (and testable).
 *
 * ⚠ THIS IS A PUBLIC SERIALIZER BOUNDARY (BAL-493 / D1). The DB row's `rateCents` is the
 * UN-MARKED-UP consultant rate — `packages/db`'s `experts.integration.test.ts` pins that and
 * must stay true. The Balo fee is applied HERE, once, so `/experts` quotes the client all-in
 * rate. Never move this arithmetic into the repository or the DB projection.
 *
 * ⚠ The fee is SESSION/ENGAGEMENT grain, not expert grain — there is no per-expert fee column
 * (`credit_sessions.balo_fee_bps` defaults to 2500; `engagements.balo_fee_bps` is NULL for
 * cases). `rate` is therefore computed at `DEFAULT_BALO_FEE_BPS` and is a "FROM" figure; public
 * copy must read "From A$…/min", never an exact promise.
 *
 * ⚠ NO margin, fee-bps or expert-earnings field may ever join this DTO — pinned exhaustively
 * by `mapper.test.ts`'s "public serializer boundary (BAL-493 AC-5)" key-set assertion.
 */
export function mapRowToExpertSearchResult(row: ExpertSearchRow, now: Date): ExpertSearchResult {
  const name = [row.firstName, row.lastName].filter(Boolean).join(' ') || row.username || '';

  return {
    id: row.id,
    username: row.username,
    name,
    avatarUrl: row.avatarUrl,
    headline: row.headline,
    bio: row.bio,
    countryCode: row.countryCode,
    // BAL-493 / D1 — client all-in, Balo fee included at the DEFAULT bps. See the docblock.
    rate: publicDisplayRatePerMinute(row.rateCents),
    nextAvailableAt: row.earliestAvailableAt?.toISOString() ?? null,
    languages: row.languages.map((l) => ({ name: l.name, flagEmoji: l.flagEmoji })),
    agency: row.agencyName ? { name: row.agencyName, logoUrl: row.agencyLogoUrl ?? null } : null,
    distinctions: {
      isSalesforceMvp: row.isSalesforceMvp,
      isSalesforceCta: row.isSalesforceCta,
      isCertifiedTrainer: row.isCertifiedTrainer,
    },
    // BAL-422 — pass-through of the denormalised aggregate. The repository already parsed
    // the `numeric` column to a number; `null` stays null and MUST NOT become 0.
    rating: row.ratingAverage,
    ratingCount: row.ratingCount,
    yearsExperience: row.yearStartedSalesforce
      ? now.getFullYear() - row.yearStartedSalesforce
      : null,
    consultationCount: row.consultationCount,
    competencies: row.competencies.map((c) => ({
      productId: c.productId,
      productName: c.productName,
      supportTypeSlug: c.supportTypeSlug,
      proficiency: c.proficiency,
    })),
  };
}
