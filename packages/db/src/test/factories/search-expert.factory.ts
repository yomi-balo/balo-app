import { eq } from 'drizzle-orm';
import { db } from '../../client';
import {
  availabilityCache,
  expertProfiles,
  expertCompetency,
  type ExpertProfile,
} from '../../schema';
import { expertsRepository } from '../../repositories/experts';
import { expertFactory } from './expert.factory';

/**
 * A product→support-type pairing to attach to the expert as a competency. Both
 * IDs must already exist (the integration global-setup seeds ONLY the Salesforce
 * vertical, so the test creates its own `products` / `support_types` rows inline
 * and passes the IDs here).
 */
export interface SearchExpertCompetencyInput {
  productId: string;
  supportTypeId: string;
  proficiency?: number;
}

/** A language pairing to attach (language must already exist). */
export interface SearchExpertLanguageInput {
  languageId: string;
  proficiency?: 'beginner' | 'intermediate' | 'advanced' | 'native';
}

export interface SearchExpertOverrides {
  // Profile scalars
  userId?: string;
  verticalId?: string;
  agencyId?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  headline?: string | null;
  bio?: string | null;
  username?: string | null;
  rateCents?: number | null;
  yearStartedSalesforce?: number;
  projectCountMin?: number;
  searchable?: boolean;
  // Distinctions
  isSalesforceMvp?: boolean;
  isSalesforceCta?: boolean;
  isCertifiedTrainer?: boolean;
  // Taxonomy links
  competencies?: SearchExpertCompetencyInput[];
  languages?: SearchExpertLanguageInput[];
  // Availability cache. `undefined` → NO cache row at all (LEFT JOIN → null).
  // `null` → a cache row exists with earliest_available_at = NULL.
  // A Date → a cache row with that earliest_available_at.
  earliestAvailableAt?: Date | null;
}

/**
 * Creates an approved, searchable expert ready to surface in expert-search:
 *   - draft → submitted → approved (via expertFactory)
 *   - sets searchable=true + headline/bio/rateCents/distinctions/experience
 *   - links competencies (expert_competency) and languages (syncLanguages)
 *   - optionally inserts an availability_cache row (configurable earliest slot)
 *
 * Requires the caller to have created any referenced products/support_types/
 * languages rows first (the integration global-setup seeds only the vertical).
 */
export async function searchExpertFactory(
  overrides: SearchExpertOverrides = {}
): Promise<ExpertProfile> {
  const profile = await expertFactory({
    userId: overrides.userId,
    verticalId: overrides.verticalId,
    firstName: overrides.firstName,
    lastName: overrides.lastName,
  });

  // Resolve rateCents: explicit `null` → a null-rate expert (rate_cents NULL,
  // which `updateProfile` cannot express since its input is `number`). `undefined`
  // → default 200. A number → that value. Null is applied directly below.
  const rateProvided = Object.prototype.hasOwnProperty.call(overrides, 'rateCents');
  const rateIsNull = rateProvided && overrides.rateCents === null;
  const rateValue = rateProvided ? overrides.rateCents : 200;

  // Profile scalars + distinctions + searchable flag.
  await expertsRepository.updateProfile(profile.id, {
    headline: overrides.headline ?? 'Salesforce Consultant',
    bio: overrides.bio ?? 'Experienced Salesforce professional.',
    ...(overrides.username !== undefined ? { username: overrides.username } : {}),
    ...(rateIsNull ? {} : { rateCents: rateValue as number }),
    yearStartedSalesforce: overrides.yearStartedSalesforce ?? 2015,
    projectCountMin: overrides.projectCountMin ?? 10,
    searchable: overrides.searchable ?? true,
    isSalesforceMvp: overrides.isSalesforceMvp ?? false,
    isSalesforceCta: overrides.isSalesforceCta ?? false,
    isCertifiedTrainer: overrides.isCertifiedTrainer ?? false,
  });

  // Apply an explicit null rate directly (updateProfile's input is `number`).
  if (rateIsNull) {
    await db
      .update(expertProfiles)
      .set({ rateCents: null })
      .where(eq(expertProfiles.id, profile.id));
  }

  // Agency link is set directly (updateProfile does not cover agencyId).
  if (overrides.agencyId !== undefined) {
    await db
      .update(expertProfiles)
      .set({ agencyId: overrides.agencyId })
      .where(eq(expertProfiles.id, profile.id));
  }

  // Competencies (product + support_type pairings).
  if (overrides.competencies?.length) {
    await db.insert(expertCompetency).values(
      overrides.competencies.map((c) => ({
        expertProfileId: profile.id,
        productId: c.productId,
        supportTypeId: c.supportTypeId,
        proficiency: c.proficiency ?? 3,
      }))
    );
  }

  // Languages.
  if (overrides.languages?.length) {
    await expertsRepository.syncLanguages(
      profile.id,
      overrides.languages.map((l) => ({
        languageId: l.languageId,
        proficiency: l.proficiency ?? 'native',
      }))
    );
  }

  // Availability cache. Distinguish "no cache row" (undefined) from "cache row
  // with NULL earliest" (null) from "cache row with a slot" (Date).
  if (Object.prototype.hasOwnProperty.call(overrides, 'earliestAvailableAt')) {
    await db.insert(availabilityCache).values({
      expertProfileId: profile.id,
      earliestAvailableAt: overrides.earliestAvailableAt ?? null,
    });
  }

  // Return the freshly-updated profile so callers see headline/bio/etc.
  const updated = await expertsRepository.findProfileById(profile.id);
  return updated ?? profile;
}
