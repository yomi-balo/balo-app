import { describe, it, expect } from 'vitest';
import type { StaffApplicationWithRelations, SupportType } from '@balo/db';
import {
  buildStaffEditModel,
  buildStaffEdit,
  describeStaffEditChanges,
  type StaffEditModel,
  type StaffEditReference,
} from './staff-edit-model';

// ── Fixtures ─────────────────────────────────────────────────────

const SUPPORT_TYPES: SupportType[] = [
  { id: 'st-fix', name: 'Technical Fix', slug: 'technical-fix' } as SupportType,
  { id: 'st-arch', name: 'Architecture', slug: 'architecture' } as SupportType,
];

function application(
  overrides: Partial<StaffApplicationWithRelations> = {}
): StaffApplicationWithRelations {
  return {
    profile: {
      id: 'p1',
      yearStartedSalesforce: 2018,
      projectCountMin: 10,
      projectLeadCountMin: 1,
      isSalesforceMvp: false,
      isSalesforceCta: false,
      isCertifiedTrainer: false,
      declineNote: null,
      // Remaining ExpertProfile fields are irrelevant to the model builder and are not read.
    } as unknown as StaffApplicationWithRelations['profile'],
    user: {
      id: 'u1',
      firstName: 'Priya',
      lastName: 'Shah',
      email: 'priya@example.com',
      avatarUrl: null,
      phone: null,
      timezone: null,
      country: null,
      countryCode: null,
      deletedAt: null,
    },
    agency: null,
    competencies: [
      {
        id: 'c1',
        expertProfileId: 'p1',
        productId: 'sales-cloud',
        supportTypeId: 'st-fix',
        proficiency: 7,
        product: { id: 'sales-cloud', name: 'Sales Cloud' },
        supportType: { id: 'st-fix', name: 'Technical Fix', slug: 'technical-fix' },
      },
      {
        id: 'c2',
        expertProfileId: 'p1',
        productId: 'sales-cloud',
        supportTypeId: 'st-arch',
        proficiency: 5,
        product: { id: 'sales-cloud', name: 'Sales Cloud' },
        supportType: { id: 'st-arch', name: 'Architecture', slug: 'architecture' },
      },
    ] as unknown as StaffApplicationWithRelations['competencies'],
    certifications: [
      {
        id: 'cert-row-1',
        expertProfileId: 'p1',
        certificationId: 'admin',
        certification: { id: 'admin', name: 'Administrator' },
      },
    ] as unknown as StaffApplicationWithRelations['certifications'],
    languages: [
      {
        id: 'lang-row-1',
        expertProfileId: 'p1',
        languageId: 'en',
        proficiency: 'native',
        language: { id: 'en', name: 'English', code: 'en', flagEmoji: '🇬🇧' },
      },
    ] as unknown as StaffApplicationWithRelations['languages'],
    industries: [
      {
        id: 'ind-row-1',
        expertProfileId: 'p1',
        industryId: 'technology',
        industry: { id: 'technology', name: 'Technology', slug: 'technology' },
      },
    ] as unknown as StaffApplicationWithRelations['industries'],
    workHistory: [],
    selfRatings: [
      { productId: 'sales-cloud', supportTypeId: 'st-fix', selfProficiency: 8 },
      { productId: 'sales-cloud', supportTypeId: 'st-arch', selfProficiency: 5 },
    ],
    ...overrides,
  };
}

const REFERENCE: StaffEditReference = {
  productsByCategory: [
    {
      category: { id: 'cat1', name: 'Sales Cloud', slug: 'sales-cloud-cat', sortOrder: 0 },
      products: [{ id: 'sales-cloud', name: 'Sales Cloud', slug: 'sales-cloud', sortOrder: 0 }],
    },
    {
      category: { id: 'cat2', name: 'Platform', slug: 'platform-cat', sortOrder: 1 },
      products: [{ id: 'flow', name: 'Flow', slug: 'flow', sortOrder: 0 }],
    },
  ],
  supportTypes: SUPPORT_TYPES,
  certificationsByCategory: [
    {
      category: { id: 'cert-cat1', name: 'Core', slug: 'core', sortOrder: 0 },
      certifications: [
        { id: 'admin', name: 'Administrator', slug: 'admin' },
        { id: 'pd1', name: 'Platform Developer I', slug: 'pd1' },
      ],
    },
  ],
  languages: [
    {
      id: 'en',
      name: 'English',
      code: 'en',
      flagEmoji: '🇬🇧',
    } as StaffEditReference['languages'][number],
    {
      id: 'fr',
      name: 'French',
      code: 'fr',
      flagEmoji: '🇫🇷',
    } as StaffEditReference['languages'][number],
  ],
  industries: [
    {
      id: 'technology',
      name: 'Technology',
      slug: 'technology',
    } as StaffEditReference['industries'][number],
    {
      id: 'financial-services',
      name: 'Financial Services',
      slug: 'financial-services',
    } as StaffEditReference['industries'][number],
  ],
};

// ── buildStaffEditModel ──────────────────────────────────────────

describe('buildStaffEditModel', () => {
  it('builds experience, languages, industries, products, ratings and certifications', () => {
    const model = buildStaffEditModel(application(), SUPPORT_TYPES);

    expect(model.experience).toEqual({
      yearStartedSalesforce: 2018,
      projectCountMin: 10,
      projectLeadCountMin: 1,
      isSalesforceMvp: false,
      isSalesforceCta: false,
      isCertifiedTrainer: false,
    });
    expect(model.languages).toEqual([{ languageId: 'en', proficiency: 'native' }]);
    expect(model.industryIds).toEqual(['technology']);
    expect(model.products).toEqual(['sales-cloud']);
    expect(model.certificationIds).toEqual(['admin']);
    expect(model.ratings['sales-cloud']).toEqual({
      'st-fix': { balo: 7, self: 8 },
      'st-arch': { balo: 5, self: 5 },
    });
  });

  it('marks a support type with no expert_competency row read-only (missing: true), never a made-up 0', () => {
    const app = application({
      competencies: [
        {
          id: 'c1',
          expertProfileId: 'p1',
          productId: 'sales-cloud',
          supportTypeId: 'st-fix',
          proficiency: 7,
          product: { id: 'sales-cloud', name: 'Sales Cloud' },
          supportType: { id: 'st-fix', name: 'Technical Fix', slug: 'technical-fix' },
        },
      ] as unknown as StaffApplicationWithRelations['competencies'],
      selfRatings: [{ productId: 'sales-cloud', supportTypeId: 'st-fix', selfProficiency: 8 }],
    });

    const model = buildStaffEditModel(app, SUPPORT_TYPES);

    expect(model.ratings['sales-cloud']).toEqual({
      'st-fix': { balo: 7, self: 8 },
      'st-arch': { balo: 0, self: null, missing: true },
    });
  });

  it('marks a staff-added product (no self-rating row at all) with self: null, and its unrated support type missing', () => {
    const app = application({
      competencies: [
        {
          id: 'c1',
          expertProfileId: 'p1',
          productId: 'flow',
          supportTypeId: 'st-fix',
          proficiency: 0,
          product: { id: 'flow', name: 'Flow' },
          supportType: { id: 'st-fix', name: 'Technical Fix', slug: 'technical-fix' },
        },
      ] as unknown as StaffApplicationWithRelations['competencies'],
      selfRatings: [],
    });

    const model = buildStaffEditModel(app, SUPPORT_TYPES);

    expect(model.ratings['flow']).toEqual({
      'st-fix': { balo: 0, self: null },
      'st-arch': { balo: 0, self: null, missing: true },
    });
  });
});

// ── buildStaffEdit ───────────────────────────────────────────────

describe('buildStaffEdit', () => {
  it('returns {} for a no-op draft', () => {
    const model = buildStaffEditModel(application(), SUPPORT_TYPES);
    expect(buildStaffEdit(model, model)).toEqual({});
  });

  it('emits only the changed experience field', () => {
    const initial = buildStaffEditModel(application(), SUPPORT_TYPES);
    const draft: StaffEditModel = {
      ...initial,
      experience: { ...initial.experience, yearStartedSalesforce: 2016 },
    };
    expect(buildStaffEdit(initial, draft)).toEqual({ experience: { yearStartedSalesforce: 2016 } });
  });

  it('emits the full language set on a proficiency-only change', () => {
    const initial = buildStaffEditModel(application(), SUPPORT_TYPES);
    const draft: StaffEditModel = {
      ...initial,
      languages: [{ languageId: 'en', proficiency: 'advanced' }],
    };
    expect(buildStaffEdit(initial, draft)).toEqual({
      languages: [{ languageId: 'en', proficiency: 'advanced' }],
    });
  });

  it('emits the full industry set when it differs', () => {
    const initial = buildStaffEditModel(application(), SUPPORT_TYPES);
    const draft: StaffEditModel = { ...initial, industryIds: ['technology', 'healthcare'] };
    expect(buildStaffEdit(initial, draft)).toEqual({
      industryIds: ['technology', 'healthcare'],
    });
  });

  it('emits productsRemoved for a product dropped from the draft', () => {
    const initial = buildStaffEditModel(application(), SUPPORT_TYPES);
    const draft: StaffEditModel = { ...initial, products: [] };
    expect(buildStaffEdit(initial, draft)).toEqual({ productsRemoved: ['sales-cloud'] });
  });

  it('emits certificationsAdded / certificationsRemoved as set diffs', () => {
    const initial = buildStaffEditModel(application(), SUPPORT_TYPES);
    const draft: StaffEditModel = { ...initial, certificationIds: ['pd1'] };
    expect(buildStaffEdit(initial, draft)).toEqual({
      certificationsAdded: ['pd1'],
      certificationsRemoved: ['admin'],
    });
  });

  it('emits ratings only for the changed cell of a retained product', () => {
    const initial = buildStaffEditModel(application(), SUPPORT_TYPES);
    const draft: StaffEditModel = {
      ...initial,
      ratings: {
        'sales-cloud': {
          ...initial.ratings['sales-cloud'],
          'st-fix': { balo: 9, self: 8 },
        },
      },
    };
    expect(buildStaffEdit(initial, draft)).toEqual({
      ratings: [{ productId: 'sales-cloud', supportTypeId: 'st-fix', proficiency: 9 }],
    });
  });

  it('never emits a rating for a missing (read-only) cell, even if the draft value differs', () => {
    const app = application({
      competencies: [
        {
          id: 'c1',
          expertProfileId: 'p1',
          productId: 'sales-cloud',
          supportTypeId: 'st-fix',
          proficiency: 7,
          product: { id: 'sales-cloud', name: 'Sales Cloud' },
          supportType: { id: 'st-fix', name: 'Technical Fix', slug: 'technical-fix' },
        },
      ] as unknown as StaffApplicationWithRelations['competencies'],
      selfRatings: [{ productId: 'sales-cloud', supportTypeId: 'st-fix', selfProficiency: 8 }],
    });
    const initial = buildStaffEditModel(app, SUPPORT_TYPES);
    const draft: StaffEditModel = {
      ...initial,
      ratings: {
        'sales-cloud': {
          ...initial.ratings['sales-cloud'],
          'st-arch': { balo: 4, self: null, missing: true },
        },
      },
    };
    expect(buildStaffEdit(initial, draft)).toEqual({});
  });

  it('removing then re-adding a product with its saved ratings restored produces no delta', () => {
    const initial = buildStaffEditModel(application(), SUPPORT_TYPES);
    // Simulate the UI: remove (products without sales-cloud), then undo (restores the original
    // ratings verbatim) — design 2409-2418's restore-from-saved behaviour.
    const removed: StaffEditModel = { ...initial, products: [] };
    const restored: StaffEditModel = {
      ...removed,
      products: ['sales-cloud'],
      ratings: { 'sales-cloud': initial.ratings['sales-cloud'] ?? {} },
    };
    expect(buildStaffEdit(initial, restored)).toEqual({});
  });

  it('a staff-added product carries one rating per support type, defaulting untouched cells to 0', () => {
    const initial = buildStaffEditModel(application(), SUPPORT_TYPES);
    const draft: StaffEditModel = {
      ...initial,
      products: [...initial.products, 'flow'],
      ratings: {
        ...initial.ratings,
        flow: {
          'st-fix': { balo: 3, self: null },
          'st-arch': { balo: 0, self: null },
        },
      },
    };
    const edit = buildStaffEdit(initial, draft);
    expect(edit.productsAdded).toEqual([
      {
        productId: 'flow',
        ratings: [
          { supportTypeId: 'st-fix', proficiency: 3 },
          { supportTypeId: 'st-arch', proficiency: 0 },
        ],
      },
    ]);
  });
});

// ── describeStaffEditChanges ─────────────────────────────────────

describe('describeStaffEditChanges', () => {
  it('describes an experience change', () => {
    const initial = buildStaffEditModel(application(), SUPPORT_TYPES);
    const draft: StaffEditModel = {
      ...initial,
      experience: { ...initial.experience, yearStartedSalesforce: 2016 },
    };
    expect(describeStaffEditChanges(initial, draft, REFERENCE)).toEqual([
      { section: 'Experience', text: 'Year started 2018 → 2016' },
    ]);
  });

  it('describes a distinction added', () => {
    const initial = buildStaffEditModel(application(), SUPPORT_TYPES);
    const draft: StaffEditModel = {
      ...initial,
      experience: { ...initial.experience, isSalesforceMvp: true },
    };
    expect(describeStaffEditChanges(initial, draft, REFERENCE)).toEqual([
      { section: 'Experience', text: 'Added Salesforce MVP' },
    ]);
  });

  it('describes a language proficiency change by name', () => {
    const initial = buildStaffEditModel(application(), SUPPORT_TYPES);
    const draft: StaffEditModel = {
      ...initial,
      languages: [{ languageId: 'en', proficiency: 'advanced' }],
    };
    expect(describeStaffEditChanges(initial, draft, REFERENCE)).toEqual([
      { section: 'Languages', text: 'English native → advanced' },
    ]);
  });

  it('describes a language added and removed', () => {
    const initial = buildStaffEditModel(application(), SUPPORT_TYPES);
    const draft: StaffEditModel = {
      ...initial,
      languages: [{ languageId: 'fr', proficiency: 'intermediate' }],
    };
    expect(describeStaffEditChanges(initial, draft, REFERENCE)).toEqual([
      { section: 'Languages', text: 'Added French (intermediate)' },
      { section: 'Languages', text: 'Removed English' },
    ]);
  });

  it('describes an industry added and removed', () => {
    const initial = buildStaffEditModel(application(), SUPPORT_TYPES);
    const draft: StaffEditModel = { ...initial, industryIds: ['financial-services'] };
    expect(describeStaffEditChanges(initial, draft, REFERENCE)).toEqual([
      { section: 'Industries', text: 'Added Financial Services' },
      { section: 'Industries', text: 'Removed Technology' },
    ]);
  });

  it('describes a product added with its ratings and a product removed', () => {
    const initial = buildStaffEditModel(application(), SUPPORT_TYPES);
    const draft: StaffEditModel = {
      ...initial,
      products: ['flow'],
      ratings: {
        flow: {
          'st-fix': { balo: 3, self: null },
          'st-arch': { balo: 0, self: null },
        },
      },
    };
    expect(describeStaffEditChanges(initial, draft, REFERENCE)).toEqual([
      { section: 'Products', text: 'Added Flow (Technical Fix 3, Architecture 0)' },
      { section: 'Products', text: 'Removed Sales Cloud' },
    ]);
  });

  it('describes a rating change on a retained product', () => {
    const initial = buildStaffEditModel(application(), SUPPORT_TYPES);
    const draft: StaffEditModel = {
      ...initial,
      ratings: {
        'sales-cloud': {
          ...initial.ratings['sales-cloud'],
          'st-fix': { balo: 9, self: 8 },
        },
      },
    };
    expect(describeStaffEditChanges(initial, draft, REFERENCE)).toEqual([
      { section: 'Ratings', text: 'Sales Cloud, Technical Fix 7 → 9' },
    ]);
  });

  it('describes a certification added and removed', () => {
    const initial = buildStaffEditModel(application(), SUPPORT_TYPES);
    const draft: StaffEditModel = { ...initial, certificationIds: ['pd1'] };
    expect(describeStaffEditChanges(initial, draft, REFERENCE)).toEqual([
      { section: 'Certifications', text: 'Added Platform Developer I' },
      { section: 'Certifications', text: 'Removed Administrator' },
    ]);
  });

  it('returns [] for a no-op draft', () => {
    const initial = buildStaffEditModel(application(), SUPPORT_TYPES);
    expect(describeStaffEditChanges(initial, initial, REFERENCE)).toEqual([]);
  });
});
