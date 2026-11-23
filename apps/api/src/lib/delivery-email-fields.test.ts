import { describe, expect, it } from 'vitest';
import type { ProjectEngagementWithMilestones } from '@balo/db';
import { deliveryEmailFields } from './delivery-email-fields';

interface FixtureOverrides {
  expertType?: 'agency' | 'freelancer';
  agencyName?: string | null;
  projectTitle?: string | null;
  milestones?: number;
}

function engagement(overrides: FixtureOverrides = {}): ProjectEngagementWithMilestones {
  const { expertType = 'agency', agencyName = 'CloudPeak Consulting', milestones = 3 } = overrides;
  const projectTitle =
    overrides.projectTitle === undefined ? 'Org migration' : overrides.projectTitle;
  return {
    company: { id: 'co-1', name: 'Northwind Industrial' },
    expertProfile: {
      type: expertType,
      user: { firstName: 'Dana', lastName: 'Reyes' },
    },
    deliveringAgency: agencyName === null ? null : { id: 'ag-1', name: agencyName, logoUrl: null },
    projectRequest: projectTitle === null ? null : { title: projectTitle },
    milestones: Array.from({ length: milestones }, (_, n) => ({ id: `m-${n}` })),
  } as unknown as ProjectEngagementWithMilestones;
}

describe('deliveryEmailFields', () => {
  it('names the agency as the expert party for an agency expert', () => {
    expect(deliveryEmailFields(engagement())).toEqual({
      clientCompanyName: 'Northwind Industrial',
      expertPartyLabel: 'CloudPeak Consulting',
      projectTitle: 'Org migration',
      milestonesTotal: 3,
    });
  });

  it("uses an independent expert's own name", () => {
    const fields = deliveryEmailFields(engagement({ expertType: 'freelancer', agencyName: null }));
    expect(fields.expertPartyLabel).toBe('Dana Reyes');
  });

  it('falls back to "Delivery with {label}" for a blank project title', () => {
    expect(deliveryEmailFields(engagement({ projectTitle: '   ' })).projectTitle).toBe(
      'Delivery with CloudPeak Consulting'
    );
  });

  it('falls back when the engagement has no project request', () => {
    expect(deliveryEmailFields(engagement({ projectTitle: null })).projectTitle).toBe(
      'Delivery with CloudPeak Consulting'
    );
  });

  it('counts the live milestones', () => {
    expect(deliveryEmailFields(engagement({ milestones: 0 })).milestonesTotal).toBe(0);
  });
});
