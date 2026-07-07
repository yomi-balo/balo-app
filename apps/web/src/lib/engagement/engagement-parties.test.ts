import { describe, it, expect } from 'vitest';
import type { EngagementWithMilestones } from '@balo/db';
import {
  deriveEngagementParties,
  engagementHeaderLine,
  personAtCompany,
} from './engagement-parties';

type ExpertProfile = EngagementWithMilestones['expertProfile'];
type Agency = ExpertProfile['agency'];

function makeAgency(over: Partial<NonNullable<Agency>> = {}): NonNullable<Agency> {
  return { id: 'agency-1', name: 'CloudPeak Consulting', logoUrl: null, ...over };
}

function makeEngagement(opts: {
  agency?: Agency;
  headline?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  companyName?: string;
}): EngagementWithMilestones {
  const expertProfile: ExpertProfile = {
    id: 'expert-1',
    agencyId: opts.agency ? opts.agency.id : null,
    type: opts.agency ? 'agency' : 'freelancer',
    headline: 'headline' in opts ? (opts.headline ?? null) : 'CPQ Specialist',
    user: {
      id: 'user-priya',
      firstName: 'firstName' in opts ? (opts.firstName ?? null) : 'Priya',
      lastName: 'lastName' in opts ? (opts.lastName ?? null) : 'Sharma',
      avatarUrl: null,
    },
    agency: opts.agency ?? null,
  };
  return {
    expertProfile,
    company: { id: 'company-1', name: opts.companyName ?? 'Northwind Industrial' },
  } as EngagementWithMilestones;
}

describe('deriveEngagementParties', () => {
  it('derives independent-expert party strings (person == party)', () => {
    const p = deriveEngagementParties(makeEngagement({ agency: null }));
    expect(p.isAgencyExpert).toBe(false);
    expect(p.expertPerson).toBe('Priya Sharma');
    expect(p.expertPersonShort).toBe('Priya');
    expect(p.expertParty).toBe('Priya Sharma');
    expect(p.expertPartyShort).toBe('Priya');
    expect(p.expertRetroFirstMention).toBe('Priya');
    expect(p.expertHeadline).toBe('CPQ Specialist');
    expect(p.clientCompanyName).toBe('Northwind Industrial');
  });

  it('derives agency-expert party strings (party == agency, retro names person @ agency)', () => {
    const p = deriveEngagementParties(makeEngagement({ agency: makeAgency() }));
    expect(p.isAgencyExpert).toBe(true);
    expect(p.expertPerson).toBe('Priya Sharma');
    expect(p.expertParty).toBe('CloudPeak Consulting');
    expect(p.expertPartyShort).toBe('CloudPeak Consulting');
    expect(p.expertRetroFirstMention).toBe('Priya @ CloudPeak Consulting');
  });

  it('falls back to "the expert" when the person is unnamed', () => {
    const p = deriveEngagementParties(
      makeEngagement({ agency: null, firstName: null, lastName: null })
    );
    expect(p.expertPerson).toBe('the expert');
    expect(p.expertPersonShort).toBe('the expert');
  });
});

describe('personAtCompany', () => {
  it('names the person @ company on first mention', () => {
    expect(personAtCompany({ firstName: 'Dana', lastName: 'Lee' }, 'Northwind Industrial')).toBe(
      'Dana @ Northwind Industrial'
    );
  });

  it('falls back to the company alone when the person is null', () => {
    expect(personAtCompany(null, 'Northwind Industrial')).toBe('Northwind Industrial');
  });

  it('falls back to the company alone when the person is unnamed', () => {
    expect(personAtCompany({ firstName: null, lastName: null }, 'Northwind Industrial')).toBe(
      'Northwind Industrial'
    );
  });
});

describe('engagementHeaderLine', () => {
  it('client (independent): "Delivered by {person} — {headline}"', () => {
    const p = deriveEngagementParties(makeEngagement({ agency: null }));
    expect(engagementHeaderLine('client', p)).toBe('Delivered by Priya Sharma — CPQ Specialist');
  });

  it('client (agency): "Delivered by {agency} ({person}, {headline})"', () => {
    const p = deriveEngagementParties(makeEngagement({ agency: makeAgency() }));
    expect(engagementHeaderLine('client', p)).toBe(
      'Delivered by CloudPeak Consulting (Priya Sharma, CPQ Specialist)'
    );
  });

  it('client (no headline): omits the specialty suffix', () => {
    const p = deriveEngagementParties(makeEngagement({ agency: null, headline: null }));
    expect(engagementHeaderLine('client', p)).toBe('Delivered by Priya Sharma');
  });

  it('expert: "For {clientCompanyName}"', () => {
    const p = deriveEngagementParties(makeEngagement({ agency: null }));
    expect(engagementHeaderLine('expert', p)).toBe('For Northwind Industrial');
  });

  it('admin (independent): "{company} ↔ {person}"', () => {
    const p = deriveEngagementParties(makeEngagement({ agency: null }));
    expect(engagementHeaderLine('admin', p)).toBe('Northwind Industrial ↔ Priya Sharma');
  });

  it('admin (agency): "{company} ↔ {agency} ({person})"', () => {
    const p = deriveEngagementParties(makeEngagement({ agency: makeAgency() }));
    expect(engagementHeaderLine('admin', p)).toBe(
      'Northwind Industrial ↔ CloudPeak Consulting (Priya Sharma)'
    );
  });
});
