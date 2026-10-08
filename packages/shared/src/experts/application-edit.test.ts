import { describe, it, expect } from 'vitest';
import {
  STAFF_EDITABLE_APPLICATION_STATUSES,
  EXPERT_APPLICATION_EDIT_SECTIONS,
  type StaffApplicationEdit,
  type StaffApplicationEditCounts,
} from './application-edit';

describe('STAFF_EDITABLE_APPLICATION_STATUSES', () => {
  it('holds exactly submitted, under_review and approved, in order', () => {
    expect([...STAFF_EDITABLE_APPLICATION_STATUSES]).toEqual([
      'submitted',
      'under_review',
      'approved',
    ]);
  });

  it('excludes draft and rejected', () => {
    expect(STAFF_EDITABLE_APPLICATION_STATUSES).not.toContain('draft');
    expect(STAFF_EDITABLE_APPLICATION_STATUSES).not.toContain('rejected');
  });
});

describe('EXPERT_APPLICATION_EDIT_SECTIONS', () => {
  it('holds exactly the four sections, in display order', () => {
    expect([...EXPERT_APPLICATION_EDIT_SECTIONS]).toEqual([
      'ratings',
      'products',
      'certifications',
      'experience',
    ]);
  });
});

describe('StaffApplicationEdit', () => {
  it('allows an empty object (the action layer rejects it, not the type)', () => {
    const edit: StaffApplicationEdit = {};
    expect(edit).toEqual({});
  });

  it('allows a delta touching every section at once', () => {
    const edit: StaffApplicationEdit = {
      experience: { yearStartedSalesforce: 2018, isSalesforceMvp: true },
      languages: [{ languageId: 'lang-1', proficiency: 'native' }],
      industryIds: ['industry-1'],
      productsAdded: [
        { productId: 'product-1', ratings: [{ supportTypeId: 'support-1', proficiency: 8 }] },
      ],
      productsRemoved: ['product-2'],
      ratings: [{ productId: 'product-3', supportTypeId: 'support-2', proficiency: 6 }],
      certificationsAdded: ['cert-1'],
      certificationsRemoved: ['cert-2'],
    };
    expect(edit.experience).toEqual({ yearStartedSalesforce: 2018, isSalesforceMvp: true });
    expect(edit.productsAdded).toHaveLength(1);
  });
});

describe('StaffApplicationEditCounts', () => {
  it('shapes the five change counts', () => {
    const counts: StaffApplicationEditCounts = {
      ratingsAdjusted: 1,
      productsAdded: 2,
      productsRemoved: 0,
      certificationsAdded: 1,
      certificationsRemoved: 1,
    };
    expect(Object.keys(counts).sort()).toEqual(
      [
        'ratingsAdjusted',
        'productsAdded',
        'productsRemoved',
        'certificationsAdded',
        'certificationsRemoved',
      ].sort()
    );
  });
});
