import { describe, it, expect } from 'vitest';
import type {
  ProductsByCategory,
  CertificationsByCategory,
  ApplicationCompetencyWithRelations,
  ApplicationProfile,
} from '@balo/db';
import {
  buildProductCategoryMap,
  buildProductNamesByCategory,
  buildAssessmentMap,
  buildCertCategoryMap,
  buildDistinctions,
  formatSubmittedDate,
} from './application-derived-data';

function competency(
  overrides: Partial<ApplicationCompetencyWithRelations> = {}
): ApplicationCompetencyWithRelations {
  return {
    productId: 'prod-1',
    product: { id: 'prod-1', name: 'Sales Cloud' },
    supportType: { id: 'st-1', name: 'Implementation', slug: 'implementation' },
    proficiency: 3,
    ...overrides,
  } as unknown as ApplicationCompetencyWithRelations;
}

function profile(overrides: Partial<ApplicationProfile> = {}): ApplicationProfile {
  return {
    isSalesforceMvp: false,
    isSalesforceCta: false,
    isCertifiedTrainer: false,
    submittedAt: null,
    ...overrides,
  } as unknown as ApplicationProfile;
}

describe('buildProductCategoryMap', () => {
  it('maps each product id to its category name across multiple categories', () => {
    const productsByCategory: ProductsByCategory[] = [
      {
        category: { id: 'c1', name: 'Sales', slug: 'sales', sortOrder: 0 },
        products: [{ id: 'p1', name: 'Sales Cloud', slug: 'sales-cloud', sortOrder: 0 }],
      },
      {
        category: { id: 'c2', name: 'Service', slug: 'service', sortOrder: 1 },
        products: [{ id: 'p2', name: 'Service Cloud', slug: 'service-cloud', sortOrder: 0 }],
      },
    ];

    const map = buildProductCategoryMap(productsByCategory);

    expect(map.get('p1')).toBe('Sales');
    expect(map.get('p2')).toBe('Service');
  });

  it('returns an empty map for no categories', () => {
    expect(buildProductCategoryMap([]).size).toBe(0);
  });
});

describe('buildProductNamesByCategory', () => {
  it('groups product names under their category, deduplicating product ids', () => {
    const productCategoryMap = new Map([
      ['p1', 'Sales'],
      ['p2', 'Sales'],
    ]);
    const competencies = [
      competency({ productId: 'p1', product: { id: 'p1', name: 'Sales Cloud' } }),
      competency({ productId: 'p1', product: { id: 'p1', name: 'Sales Cloud' } }), // duplicate id
      competency({ productId: 'p2', product: { id: 'p2', name: 'CPQ' } }),
    ];

    const { productNamesByCategory, uniqueProductIds } = buildProductNamesByCategory(
      competencies,
      productCategoryMap
    );

    expect(uniqueProductIds).toEqual(['p1', 'p2']);
    expect(productNamesByCategory.get('Sales')).toEqual(['Sales Cloud', 'CPQ']);
  });

  it('falls back to "Other" for a product id absent from the category map', () => {
    const { productNamesByCategory } = buildProductNamesByCategory(
      [competency({ productId: 'unmapped', product: { id: 'unmapped', name: 'Mystery Cloud' } })],
      new Map()
    );

    expect(productNamesByCategory.get('Other')).toEqual(['Mystery Cloud']);
  });
});

describe('buildAssessmentMap', () => {
  it('collects every support-type rating under its product', () => {
    const competencies = [
      competency({
        productId: 'p1',
        product: { id: 'p1', name: 'Sales Cloud' },
        supportType: { id: 'st1', name: 'Implementation', slug: 'implementation' },
        proficiency: 4,
      }),
      competency({
        productId: 'p1',
        product: { id: 'p1', name: 'Sales Cloud' },
        supportType: { id: 'st2', name: 'Support', slug: 'support' },
        proficiency: 2,
      }),
    ];

    const assessmentMap = buildAssessmentMap(competencies);
    const entry = assessmentMap.get('p1');

    expect(entry?.name).toBe('Sales Cloud');
    expect(entry?.ratings.get('implementation')).toBe(4);
    expect(entry?.ratings.get('support')).toBe(2);
  });
});

describe('buildCertCategoryMap', () => {
  it('maps each certification id to its category name', () => {
    const certificationsByCategory: CertificationsByCategory[] = [
      {
        category: { id: 'cc1', name: 'Admin', slug: 'admin', sortOrder: 0 },
        certifications: [{ id: 'cert1', name: 'Administrator', slug: 'administrator' }],
      },
    ];

    expect(buildCertCategoryMap(certificationsByCategory).get('cert1')).toBe('Admin');
  });
});

describe('buildDistinctions', () => {
  it('returns an empty list when the applicant holds no distinctions', () => {
    expect(buildDistinctions(profile())).toEqual([]);
  });

  it('lists every distinction the applicant holds, in a fixed order', () => {
    const distinctions = buildDistinctions(
      profile({ isSalesforceMvp: true, isSalesforceCta: true, isCertifiedTrainer: true })
    );

    expect(distinctions).toEqual(['Salesforce MVP', 'Salesforce CTA', 'Certified Trainer']);
  });
});

describe('formatSubmittedDate', () => {
  it('returns N/A when there is no submission date', () => {
    expect(formatSubmittedDate(null)).toBe('N/A');
  });

  it('formats a submission date as a long US date', () => {
    expect(formatSubmittedDate(new Date('2026-03-14T00:00:00Z'))).toBe('March 14, 2026');
  });
});
