import type { ApplicationWithRelations } from '@balo/db';
import type { ReferenceData } from '@/lib/expert-apply/reference-data';
import type {
  ProfileStepData,
  ProductsStepData,
  AssessmentStepData,
  CertificationsStepData,
  WorkHistoryStepData,
} from '@/app/(apply)/expert/apply/_actions/schemas';
import { buildDistinctions } from './application-derived-data';

/**
 * The view model behind the application summary. It is built from either a persisted
 * application (the post-submit review page) or the in-progress wizard draft (the Review and
 * submit step), so both render the same sections from the same shape.
 *
 * All `@balo/db` and `reference-data` imports are TYPE-ONLY: erased at compile time, so this
 * module is safe to import from a `'use client'` leaf.
 */

export type SummaryEditTarget =
  | 'profile'
  | 'products'
  | 'assessment'
  | 'certifications'
  | 'work-history';

export type SummaryLanguageProficiency =
  ApplicationWithRelations['languages'][number]['proficiency'];

export interface ApplicationSummaryView {
  experience: {
    yearStarted: number | null;
    projectCountMin: number | null;
    projectLeadCountMin: number | null;
    linkedinUrl: string | null;
  };
  languages: {
    id: string;
    name: string;
    flagEmoji: string | null;
    proficiency: SummaryLanguageProficiency;
  }[];
  industries: { id: string; name: string }[];
  distinctions: string[];
  products: {
    id: string;
    name: string;
    rated: boolean;
    ratings: { supportTypeId: string; slug: string; name: string; proficiency: number }[];
  }[];
  trailheadUrl: string | null;
  certifications: { id: string; name: string; category: string | null }[];
  workHistory: {
    key: string;
    role: string;
    company: string;
    isCurrent: boolean;
    periodLabel: string;
    responsibilities: string | null;
  }[];
}

type SummaryReference = Pick<ReferenceData, 'supportTypes' | 'certificationsByCategory'>;

export interface SummaryDraft {
  profile: Partial<ProfileStepData>;
  products: Partial<ProductsStepData>;
  assessment: Partial<AssessmentStepData>;
  certifications: Partial<CertificationsStepData>;
  workHistory: Partial<WorkHistoryStepData>;
}

interface RatingLike {
  productId: string;
  supportTypeId: string;
  proficiency: number;
}

/**
 * The one definition of "this product has been rated": at least one dimension above zero. The
 * assessment step's gate and the summary's unrated flag both read it, so they cannot drift.
 */
export function productHasRating(
  ratings: readonly { productId: string; proficiency: number }[],
  productId: string
): boolean {
  return ratings.some((r) => r.productId === productId && r.proficiency > 0);
}

function formatDate(date: Date | string | null | undefined): string {
  if (!date) return '—';
  const d = typeof date === 'string' ? new Date(date) : date;
  return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}

function periodLabel(
  startedAt: Date | string | null | undefined,
  endedAt: Date | string | null | undefined,
  isCurrent: boolean
): string {
  return `${formatDate(startedAt)} — ${isCurrent ? 'Present' : formatDate(endedAt)}`;
}

function isWebUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/** A stored value is a full http(s) URL, or a bare slug that gets `prefix`. Anything else is dropped. */
function toAbsoluteUrl(value: string | null | undefined, prefix: string): string | null {
  if (!value) return null;
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `${prefix}${value}`;
  return isWebUrl(candidate) ? candidate : null;
}

const LINKEDIN_PREFIX = 'https://linkedin.com/in/';
const TRAILHEAD_PREFIX = 'https://trailblazer.me/id/';

function buildCertCategoryLookup(
  certificationsByCategory: SummaryReference['certificationsByCategory']
): Map<string, { name: string; category: string }> {
  const lookup = new Map<string, { name: string; category: string }>();
  for (const cat of certificationsByCategory) {
    for (const cert of cat.certifications) {
      lookup.set(cert.id, { name: cert.name, category: cat.category.name });
    }
  }
  return lookup;
}

function buildProductRatings(
  productId: string,
  ratings: readonly RatingLike[],
  supportTypes: SummaryReference['supportTypes']
): ApplicationSummaryView['products'][number]['ratings'] {
  return supportTypes.map((st) => ({
    supportTypeId: st.id,
    slug: st.slug,
    name: st.name,
    proficiency:
      ratings.find((r) => r.productId === productId && r.supportTypeId === st.id)?.proficiency ?? 0,
  }));
}

function buildProducts(
  entries: readonly { id: string; name: string }[],
  ratings: readonly RatingLike[],
  supportTypes: SummaryReference['supportTypes']
): ApplicationSummaryView['products'] {
  return entries.map(({ id, name }) => ({
    id,
    name,
    rated: productHasRating(ratings, id),
    ratings: buildProductRatings(id, ratings, supportTypes),
  }));
}

export function summaryFromApplication(
  app: ApplicationWithRelations,
  ref: SummaryReference
): ApplicationSummaryView {
  const { profile, competencies, certifications, languages, industries, workHistory } = app;
  const certLookup = buildCertCategoryLookup(ref.certificationsByCategory);

  const productEntries = new Map<string, string>();
  for (const c of competencies) {
    if (!productEntries.has(c.productId)) productEntries.set(c.productId, c.product.name);
  }

  return {
    experience: {
      yearStarted: profile.yearStartedSalesforce,
      projectCountMin: profile.projectCountMin,
      projectLeadCountMin: profile.projectLeadCountMin,
      linkedinUrl: toAbsoluteUrl(profile.linkedinUrl, LINKEDIN_PREFIX),
    },
    languages: languages.map((l) => ({
      id: l.language.id,
      name: l.language.name,
      flagEmoji: l.language.flagEmoji,
      proficiency: l.proficiency,
    })),
    industries: industries.map((i) => ({ id: i.industry.id, name: i.industry.name })),
    distinctions: buildDistinctions(profile),
    products: buildProducts(
      [...productEntries].map(([id, name]) => ({ id, name })),
      competencies,
      ref.supportTypes
    ),
    trailheadUrl: toAbsoluteUrl(profile.trailheadUrl, TRAILHEAD_PREFIX),
    certifications: certifications.map((c) => ({
      id: c.certificationId,
      name: c.certification.name,
      category: certLookup.get(c.certificationId)?.category ?? null,
    })),
    workHistory: workHistory.map((w) => ({
      key: w.id,
      role: w.role,
      company: w.company,
      isCurrent: w.isCurrent,
      periodLabel: periodLabel(w.startedAt, w.endedAt, w.isCurrent),
      responsibilities: w.responsibilities,
    })),
  };
}

export function summaryFromDraft(draft: SummaryDraft, ref: ReferenceData): ApplicationSummaryView {
  const { profile, products, assessment, certifications, workHistory } = draft;
  const certLookup = buildCertCategoryLookup(ref.certificationsByCategory);
  const productNames = new Map<string, string>();
  for (const cat of ref.productsByCategory) {
    for (const product of cat.products) productNames.set(product.id, product.name);
  }
  const languageById = new Map(ref.languages.map((l) => [l.id, l]));
  const industryById = new Map(ref.industries.map((i) => [i.id, i]));

  const languages: ApplicationSummaryView['languages'] = [];
  for (const entry of profile.languages ?? []) {
    const language = languageById.get(entry.languageId);
    if (language) {
      languages.push({
        id: language.id,
        name: language.name,
        flagEmoji: language.flagEmoji,
        proficiency: entry.proficiency,
      });
    }
  }

  const industries: ApplicationSummaryView['industries'] = [];
  for (const id of profile.industryIds ?? []) {
    const industry = industryById.get(id);
    if (industry) industries.push({ id: industry.id, name: industry.name });
  }

  const draftCerts: ApplicationSummaryView['certifications'] = [];
  for (const c of certifications.certifications ?? []) {
    const known = certLookup.get(c.certificationId);
    draftCerts.push({
      id: c.certificationId,
      name: known?.name ?? c.certificationId,
      category: known?.category ?? null,
    });
  }

  const linkedinSlug = profile.linkedinSlug;
  const trailheadSlug = certifications.trailheadSlug;

  return {
    experience: {
      yearStarted: profile.yearStartedSalesforce ?? null,
      projectCountMin: profile.projectCountMin ?? null,
      projectLeadCountMin: profile.projectLeadCountMin ?? null,
      linkedinUrl: linkedinSlug ? `${LINKEDIN_PREFIX}${linkedinSlug}` : null,
    },
    languages,
    industries,
    distinctions: buildDistinctions({
      isSalesforceMvp: profile.isSalesforceMvp ?? false,
      isSalesforceCta: profile.isSalesforceCta ?? false,
    }),
    products: buildProducts(
      (products.productIds ?? []).map((id) => ({ id, name: productNames.get(id) ?? id })),
      assessment.ratings ?? [],
      ref.supportTypes
    ),
    trailheadUrl: trailheadSlug ? `${TRAILHEAD_PREFIX}${trailheadSlug}` : null,
    certifications: draftCerts,
    workHistory: (workHistory.entries ?? []).map((w) => ({
      key: w.id ?? `${w.role}|${w.company}|${w.startedAt}`,
      role: w.role,
      company: w.company,
      isCurrent: w.isCurrent,
      periodLabel: periodLabel(w.startedAt, w.endedAt, w.isCurrent),
      responsibilities: w.responsibilities ?? null,
    })),
  };
}
