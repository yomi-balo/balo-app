import type { ExpertSearchRow } from '@balo/db';
import type { ExpertSearchResult } from './types.js';

/**
 * Pure DB-row → result-DTO mapper. No DB access. `now` is injected so
 * `yearsExperience` is deterministic (and testable).
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
    rate: row.rateCents == null ? null : row.rateCents / 100,
    nextAvailableAt: row.earliestAvailableAt?.toISOString() ?? null,
    languages: row.languages.map((l) => ({ name: l.name, flagEmoji: l.flagEmoji })),
    agency: row.agencyName ? { name: row.agencyName, logoUrl: row.agencyLogoUrl ?? null } : null,
    distinctions: {
      isSalesforceMvp: row.isSalesforceMvp,
      isSalesforceCta: row.isSalesforceCta,
      isCertifiedTrainer: row.isCertifiedTrainer,
    },
    rating: null,
    yearsExperience: row.yearStartedSalesforce
      ? now.getFullYear() - row.yearStartedSalesforce
      : null,
    consultationCount: row.consultationCount,
    skills: row.skills.map((s) => ({
      productId: s.productId,
      productName: s.productName,
      supportTypeSlug: s.supportTypeSlug,
      proficiency: s.proficiency,
    })),
  };
}
