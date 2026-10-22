import { describe, expect, it } from 'vitest';
import type { ExpertProfileView } from '@/components/expert/profile';
import { buildBookingFlowExpert } from './booking-flow-expert';

function view(overrides: Partial<ExpertProfileView> = {}): ExpertProfileView {
  return {
    expertId: 'expert-1',
    name: 'Anil Pilania',
    firstName: 'Anil',
    initials: 'AP',
    agency: null,
    baloVerified: false,
    availableForWork: true,
    vertical: { slug: 'salesforce', name: 'Salesforce' },
    competencies: [],
    ...overrides,
  } as ExpertProfileView;
}

describe('buildBookingFlowExpert', () => {
  it('names an independent expert as their own party', () => {
    expect(buildBookingFlowExpert(view(), 'https://cdn/avatar.png')).toEqual({
      expertProfileId: 'expert-1',
      name: 'Anil Pilania',
      firstName: 'Anil',
      initials: 'AP',
      avatarUrl: 'https://cdn/avatar.png',
      partyLabel: 'Anil Pilania',
      verified: false,
      availableForWork: true,
      similarExpertsHref: '/experts?vertical=salesforce&timeframe=week&sort=soonest',
    });
  });

  it("names an agency expert's agency as the party", () => {
    const result = buildBookingFlowExpert(
      view({ agency: { name: 'CloudPeak' } as ExpertProfileView['agency'] }),
      null
    );
    expect(result.partyLabel).toBe('CloudPeak');
  });

  it("narrows the similar-experts link to the expert's top product", () => {
    const result = buildBookingFlowExpert(
      view({ competencies: [{ id: 'p-1' }, { id: 'p-2' }] as ExpertProfileView['competencies'] }),
      null
    );
    expect(result.similarExpertsHref).toContain('p-1');
    expect(result.similarExpertsHref).not.toContain('p-2');
  });
});
