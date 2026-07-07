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
  type?: ExpertProfile['type'];
  headline?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  companyName?: string;
}): EngagementWithMilestones {
  const expertProfile: ExpertProfile = {
    id: 'expert-1',
    agencyId: opts.agency ? opts.agency.id : null,
    type: opts.type ?? (opts.agency ? 'agency' : 'freelancer'),
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

  it('(drift a) freelancer-typed profile carrying an agencyId shows the PERSON, not the agency', () => {
    // type wins over agency-presence: a freelancer linked to an agency is still party==person.
    const p = deriveEngagementParties(makeEngagement({ agency: makeAgency(), type: 'freelancer' }));
    expect(p.isAgencyExpert).toBe(false);
    expect(p.expertParty).toBe('Priya Sharma');
    expect(p.expertPartyShort).toBe('Priya');
    expect(p.expertRetroFirstMention).toBe('Priya');
  });

  it('(drift b) agency-typed with a null/blank agency name falls back to the person (no crash)', () => {
    // Null joined agency row — the null-safety trap: must not deref agency.name.
    const nullAgency = deriveEngagementParties(makeEngagement({ agency: null, type: 'agency' }));
    expect(nullAgency.isAgencyExpert).toBe(true);
    expect(nullAgency.expertParty).toBe('Priya Sharma');
    expect(nullAgency.expertPartyShort).toBe('Priya');
    expect(nullAgency.expertRetroFirstMention).toBe('Priya');

    // Blank agency name — same shared fallback.
    const blankAgency = deriveEngagementParties(
      makeEngagement({ agency: makeAgency({ name: '   ' }), type: 'agency' })
    );
    expect(blankAgency.expertParty).toBe('Priya Sharma');
  });

  it('(drift c) a nameless expert party falls back to "An expert" (shared convention)', () => {
    const p = deriveEngagementParties(
      makeEngagement({ agency: null, firstName: null, lastName: null })
    );
    expect(p.expertParty).toBe('An expert');
    // Person-side fields keep their own "the expert" fallback (unchanged).
    expect(p.expertPerson).toBe('the expert');
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
