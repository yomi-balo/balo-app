import type {
  ProductsByCategory,
  CertificationsByCategory,
  ApplicationCompetencyWithRelations,
  ApplicationProfile,
} from '@balo/db';

/**
 * BAL-549 — pure view-model builders shared by the applicant-voiced review page
 * (`(apply)/expert/apply/review/_components/application-review.tsx`, a client component) and
 * the staff review surface (`(dashboard)/admin/applications/_components/application-sections.tsx`,
 * a server component). Both render the SAME application shape; this module is the one place the
 * product/certification grouping and distinctions logic lives, so the two cannot drift and
 * jscpd has nothing to flag.
 *
 * All `@balo/db` imports here are TYPE-ONLY — erased at compile time, so this module is safe to
 * import from a `'use client'` leaf without dragging the postgres driver into the browser bundle
 * (memory `reference_balo_db_client_bundle_footgun`).
 */

export function buildProductCategoryMap(
  productsByCategory: readonly ProductsByCategory[]
): Map<string, string> {
  const productCategoryMap = new Map<string, string>();
  for (const cat of productsByCategory) {
    for (const product of cat.products) {
      productCategoryMap.set(product.id, cat.category.name);
    }
  }
  return productCategoryMap;
}

export function buildProductNamesByCategory(
  competencies: readonly ApplicationCompetencyWithRelations[],
  productCategoryMap: Map<string, string>
): { productNamesByCategory: Map<string, string[]>; uniqueProductIds: string[] } {
  const uniqueProductIds = [...new Set(competencies.map((c) => c.productId))];
  const productNamesByCategory = new Map<string, string[]>();
  for (const productId of uniqueProductIds) {
    const categoryName = productCategoryMap.get(productId) ?? 'Other';
    const productName = competencies.find((c) => c.productId === productId)?.product.name ?? '';
    const existingNames = productNamesByCategory.get(categoryName);
    if (existingNames) {
      existingNames.push(productName);
    } else {
      productNamesByCategory.set(categoryName, [productName]);
    }
  }
  return { productNamesByCategory, uniqueProductIds };
}

export function buildAssessmentMap(
  competencies: readonly ApplicationCompetencyWithRelations[]
): Map<string, { name: string; ratings: Map<string, number> }> {
  const assessmentMap = new Map<string, { name: string; ratings: Map<string, number> }>();
  for (const c of competencies) {
    const entry = assessmentMap.get(c.productId) ?? { name: c.product.name, ratings: new Map() };
    entry.ratings.set(c.supportType.slug, c.proficiency);
    assessmentMap.set(c.productId, entry);
  }
  return assessmentMap;
}

export function buildCertCategoryMap(
  certificationsByCategory: readonly CertificationsByCategory[]
): Map<string, string> {
  const certCategoryMap = new Map<string, string>();
  for (const cat of certificationsByCategory) {
    for (const cert of cat.certifications) {
      certCategoryMap.set(cert.id, cat.category.name);
    }
  }
  return certCategoryMap;
}

export function buildDistinctions(profile: ApplicationProfile): string[] {
  const distinctions: string[] = [];
  if (profile.isSalesforceMvp) distinctions.push('Salesforce MVP');
  if (profile.isSalesforceCta) distinctions.push('Salesforce CTA');
  if (profile.isCertifiedTrainer) distinctions.push('Certified Trainer');
  return distinctions;
}

export function formatSubmittedDate(submittedAt: ApplicationProfile['submittedAt']): string {
  if (!submittedAt) return 'N/A';
  return new Date(submittedAt).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}
