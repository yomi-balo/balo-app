import { describe, it, expect } from 'vitest';
import {
  planStaffApplicationEdit,
  staffEditExperienceIsInvalid,
  type StaffEditSnapshot,
} from './expert-application-edit';

const P1 = 'product-1';
const P2 = 'product-2';
const P3 = 'product-3';
const ST_A = 'support-a';
const ST_B = 'support-b';

function snapshot(overrides: Partial<StaffEditSnapshot> = {}): StaffEditSnapshot {
  return {
    profile: {
      yearStartedSalesforce: 2015,
      projectCountMin: 10,
      projectLeadCountMin: null,
      isSalesforceMvp: false,
      isSalesforceCta: false,
      isCertifiedTrainer: true,
    },
    competencies: [
      { productId: P1, supportTypeId: ST_A, proficiency: 8, selfProficiency: 9 },
      { productId: P1, supportTypeId: ST_B, proficiency: 6, selfProficiency: 6 },
      { productId: P2, supportTypeId: ST_A, proficiency: 4, selfProficiency: null },
    ],
    certificationIds: ['cert-1', 'cert-2'],
    languages: [
      { languageId: 'en', proficiency: 'native' },
      { languageId: 'fr', proficiency: 'intermediate' },
    ],
    industryIds: ['ind-1', 'ind-2'],
    ...overrides,
  };
}

describe('planStaffApplicationEdit — experience', () => {
  it('keeps only provided fields that differ from the snapshot', () => {
    const plan = planStaffApplicationEdit(snapshot(), {
      experience: { yearStartedSalesforce: 2015, projectCountMin: 25, projectLeadCountMin: 3 },
    });

    expect(plan.experience).toEqual({ projectCountMin: 25, projectLeadCountMin: 3 });
    expect(plan.changes.experience).toEqual({
      projectCountMin: { before: 10, after: 25 },
      projectLeadCountMin: { before: null, after: 3 },
    });
    expect(plan.sections).toEqual(['experience']);
  });

  it('plans nothing when every provided field already matches', () => {
    const plan = planStaffApplicationEdit(snapshot(), {
      experience: { isCertifiedTrainer: true, isSalesforceMvp: false },
    });

    expect(plan.experience).toBeNull();
    expect(plan.changes.experience).toBeNull();
    expect(plan.sections).toEqual([]);
  });
});

describe('planStaffApplicationEdit — languages', () => {
  it('reports added, removed and changed languages and writes the full set', () => {
    const plan = planStaffApplicationEdit(snapshot(), {
      languages: [
        { languageId: 'en', proficiency: 'native' },
        { languageId: 'fr', proficiency: 'advanced' },
        { languageId: 'de', proficiency: 'beginner' },
      ],
    });

    expect(plan.languages).toHaveLength(3);
    expect(plan.changes.languages).toEqual({
      added: [{ languageId: 'de', proficiency: 'beginner' }],
      removed: [],
      changed: [{ languageId: 'fr', before: 'intermediate', after: 'advanced' }],
    });
    expect(plan.sections).toEqual(['experience']);
  });

  it('is null with no write when the set is unchanged, in any order', () => {
    const plan = planStaffApplicationEdit(snapshot(), {
      languages: [
        { languageId: 'fr', proficiency: 'intermediate' },
        { languageId: 'en', proficiency: 'native' },
      ],
    });

    expect(plan.languages).toBeNull();
    expect(plan.changes.languages).toBeNull();
    expect(plan.sections).toEqual([]);
  });

  it('reports a removed language', () => {
    const plan = planStaffApplicationEdit(snapshot(), {
      languages: [{ languageId: 'en', proficiency: 'native' }],
    });

    expect(plan.changes.languages?.removed).toEqual([
      { languageId: 'fr', proficiency: 'intermediate' },
    ]);
  });
});

describe('planStaffApplicationEdit — industries', () => {
  it('reports the set diff and writes the full set', () => {
    const plan = planStaffApplicationEdit(snapshot(), { industryIds: ['ind-2', 'ind-3'] });

    expect(plan.industryIds).toEqual(['ind-2', 'ind-3']);
    expect(plan.changes.industries).toEqual({ added: ['ind-3'], removed: ['ind-1'] });
    expect(plan.sections).toEqual(['experience']);
  });

  it('is null with no write when the set is unchanged', () => {
    const plan = planStaffApplicationEdit(snapshot(), { industryIds: ['ind-2', 'ind-1'] });

    expect(plan.industryIds).toBeNull();
    expect(plan.changes.industries).toBeNull();
  });
});

describe('planStaffApplicationEdit — products removed', () => {
  it('removes only products present in the snapshot, recording every cell and its self-rating', () => {
    const plan = planStaffApplicationEdit(snapshot(), { productsRemoved: [P1, P3] });

    expect(plan.productIdsToRemove).toEqual([P1]);
    expect(plan.changes.productsRemoved).toEqual([
      {
        productId: P1,
        ratings: [
          { supportTypeId: ST_A, proficiency: 8, selfProficiency: 9 },
          { supportTypeId: ST_B, proficiency: 6, selfProficiency: 6 },
        ],
      },
    ]);
    expect(plan.counts.productsRemoved).toBe(1);
    expect(plan.sections).toEqual(['products']);
  });

  it('records a staff-added product’s null self-rating on removal', () => {
    const plan = planStaffApplicationEdit(snapshot(), { productsRemoved: [P2] });

    expect(plan.changes.productsRemoved).toEqual([
      { productId: P2, ratings: [{ supportTypeId: ST_A, proficiency: 4, selfProficiency: null }] },
    ]);
  });
});

describe('planStaffApplicationEdit — products added', () => {
  it('a product absent from the snapshot is a real add, inserted per support type', () => {
    const plan = planStaffApplicationEdit(snapshot(), {
      productsAdded: [
        {
          productId: P3,
          ratings: [
            { supportTypeId: ST_A, proficiency: 5 },
            { supportTypeId: ST_B, proficiency: 7 },
          ],
        },
      ],
    });

    expect(plan.competenciesToInsert).toEqual([
      { productId: P3, supportTypeId: ST_A, proficiency: 5 },
      { productId: P3, supportTypeId: ST_B, proficiency: 7 },
    ]);
    expect(plan.changes.productsAdded).toEqual([
      {
        productId: P3,
        ratings: [
          { supportTypeId: ST_A, proficiency: 5 },
          { supportTypeId: ST_B, proficiency: 7 },
        ],
      },
    ]);
    expect(plan.counts.productsAdded).toBe(1);
    expect(plan.sections).toEqual(['products']);
  });

  it('a product already present degrades to rating changes on its existing cells', () => {
    const plan = planStaffApplicationEdit(snapshot(), {
      productsAdded: [
        {
          productId: P1,
          ratings: [
            { supportTypeId: ST_A, proficiency: 3 },
            { supportTypeId: ST_B, proficiency: 6 },
          ],
        },
      ],
    });

    expect(plan.competenciesToInsert).toEqual([]);
    expect(plan.changes.productsAdded).toEqual([]);
    // Self-rating kept; the unchanged cell drops out.
    expect(plan.changes.ratings).toEqual([
      { productId: P1, supportTypeId: ST_A, before: 8, after: 3, selfProficiency: 9 },
    ]);
    expect(plan.ratingUpdates).toEqual([{ productId: P1, supportTypeId: ST_A, proficiency: 3 }]);
    expect(plan.sections).toEqual(['ratings']);
  });

  it('drops a real add that carries no ratings', () => {
    const plan = planStaffApplicationEdit(snapshot(), {
      productsAdded: [{ productId: P3, ratings: [] }],
    });

    expect(plan.competenciesToInsert).toEqual([]);
    expect(plan.counts.productsAdded).toBe(0);
    expect(plan.sections).toEqual([]);
  });
});

describe('planStaffApplicationEdit — ratings', () => {
  it('changes a cell that exists, on a retained product, with a different value', () => {
    const plan = planStaffApplicationEdit(snapshot(), {
      ratings: [{ productId: P1, supportTypeId: ST_B, proficiency: 9 }],
    });

    expect(plan.ratingUpdates).toEqual([{ productId: P1, supportTypeId: ST_B, proficiency: 9 }]);
    expect(plan.changes.ratings).toEqual([
      { productId: P1, supportTypeId: ST_B, before: 6, after: 9, selfProficiency: 6 },
    ]);
    expect(plan.counts.ratingsAdjusted).toBe(1);
    expect(plan.sections).toEqual(['ratings']);
  });

  it('skips an unchanged value, a missing cell and a cell on a product being removed', () => {
    const plan = planStaffApplicationEdit(snapshot(), {
      productsRemoved: [P2],
      ratings: [
        { productId: P1, supportTypeId: ST_A, proficiency: 8 },
        { productId: P2, supportTypeId: ST_B, proficiency: 2 },
        { productId: P3, supportTypeId: ST_A, proficiency: 2 },
        { productId: P2, supportTypeId: ST_A, proficiency: 10 },
      ],
    });

    expect(plan.ratingUpdates).toEqual([]);
    expect(plan.changes.ratings).toEqual([]);
    expect(plan.counts.ratingsAdjusted).toBe(0);
    expect(plan.sections).toEqual(['products']);
  });
});

describe('planStaffApplicationEdit — certifications', () => {
  it('adds only ids not present and removes only ids present', () => {
    const plan = planStaffApplicationEdit(snapshot(), {
      certificationsAdded: ['cert-1', 'cert-3'],
      certificationsRemoved: ['cert-2', 'cert-9'],
    });

    expect(plan.certificationIdsToAdd).toEqual(['cert-3']);
    expect(plan.certificationIdsToRemove).toEqual(['cert-2']);
    expect(plan.changes.certifications).toEqual({ added: ['cert-3'], removed: ['cert-2'] });
    expect(plan.counts).toMatchObject({ certificationsAdded: 1, certificationsRemoved: 1 });
    expect(plan.sections).toEqual(['certifications']);
  });

  it('is null when every requested change is already true', () => {
    const plan = planStaffApplicationEdit(snapshot(), {
      certificationsAdded: ['cert-1'],
      certificationsRemoved: ['cert-9'],
    });

    expect(plan.changes.certifications).toBeNull();
    expect(plan.sections).toEqual([]);
  });
});

describe('planStaffApplicationEdit — counts and sections', () => {
  it('maps every non-empty group to its section, in display order', () => {
    const plan = planStaffApplicationEdit(snapshot(), {
      experience: { isSalesforceMvp: true },
      productsAdded: [{ productId: P3, ratings: [{ supportTypeId: ST_A, proficiency: 5 }] }],
      productsRemoved: [P2],
      ratings: [
        { productId: P1, supportTypeId: ST_A, proficiency: 7 },
        { productId: P1, supportTypeId: ST_B, proficiency: 7 },
      ],
      certificationsRemoved: ['cert-1'],
    });

    expect(plan.sections).toEqual(['ratings', 'products', 'certifications', 'experience']);
    expect(plan.counts).toEqual({
      ratingsAdjusted: 2,
      productsAdded: 1,
      productsRemoved: 1,
      certificationsAdded: 0,
      certificationsRemoved: 1,
    });
    expect(plan.changes.sections).toEqual(plan.sections);
    expect(plan.changes.counts).toEqual(plan.counts);
  });

  it('an empty edit plans nothing, with every metadata group empty', () => {
    const plan = planStaffApplicationEdit(snapshot(), {});

    expect(plan.sections).toEqual([]);
    expect(plan.changes).toEqual({
      sections: [],
      counts: {
        ratingsAdjusted: 0,
        productsAdded: 0,
        productsRemoved: 0,
        certificationsAdded: 0,
        certificationsRemoved: 0,
      },
      experience: null,
      languages: null,
      industries: null,
      ratings: [],
      productsAdded: [],
      productsRemoved: [],
      certifications: null,
    });
  });
});

describe('staffEditExperienceIsInvalid', () => {
  const profile = (
    overrides: Partial<StaffEditSnapshot['profile']> = {}
  ): StaffEditSnapshot['profile'] => ({ ...snapshot().profile, ...overrides });

  it('refuses a partial delta that sends only projectLeadCountMin above the snapshot’s projectCountMin', () => {
    const invalid = staffEditExperienceIsInvalid(profile({ projectCountMin: 10 }), {
      projectLeadCountMin: 11,
    });

    expect(invalid).toBe(true);
  });

  it('refuses a delta that lowers projectCountMin below the snapshot’s stored projectLeadCountMin', () => {
    const invalid = staffEditExperienceIsInvalid(
      profile({ projectCountMin: 10, projectLeadCountMin: 8 }),
      { projectCountMin: 5 }
    );

    expect(invalid).toBe(true);
  });

  it('allows an effective lead count at or below the effective project count', () => {
    expect(
      staffEditExperienceIsInvalid(profile({ projectCountMin: 10, projectLeadCountMin: 10 }), {})
    ).toBe(false);
    expect(
      staffEditExperienceIsInvalid(profile({ projectCountMin: 10 }), { projectLeadCountMin: 10 })
    ).toBe(false);
  });

  it('allows an undefined delta and no provided experience at all', () => {
    expect(staffEditExperienceIsInvalid(profile(), undefined)).toBe(false);
  });

  it('cannot fire when either effective value is null', () => {
    expect(
      staffEditExperienceIsInvalid(profile({ projectCountMin: null, projectLeadCountMin: null }), {
        projectLeadCountMin: 999,
      })
    ).toBe(false);
  });
});
