import { describe, it, expect } from 'vitest';
import type { PublicExpertProfile } from '@balo/db';
import { mapProfileToView, formatPeriod, formatDuration } from './profile-view';

// Minimal valid PublicExpertProfile graph; tests override the bits they assert.
function makeProfile(overrides: Partial<PublicExpertProfile> = {}): PublicExpertProfile {
  const base = {
    id: 'expert-1',
    agencyId: null,
    rateCents: null,
    yearStartedSalesforce: null,
    headline: 'Salesforce Architect',
    bio: 'A bio.',
    availableForWork: true,
    consultationCount: 0,
    user: {
      id: 'user-1',
      firstName: 'Priya',
      lastName: 'Raman',
      avatarUrl: 'avatar-key',
      country: 'Australia',
      countryCode: 'AU',
      timezone: 'Australia/Melbourne',
    },
    agency: null,
    skills: [],
    certifications: [],
    languages: [],
    industries: [],
    workHistory: [],
  };
  return { ...base, ...overrides } as unknown as PublicExpertProfile;
}

describe('mapProfileToView — names & basics', () => {
  it('joins first + last into name and exposes firstName', () => {
    const view = mapProfileToView(makeProfile());
    expect(view.name).toBe('Priya Raman');
    expect(view.firstName).toBe('Priya');
    expect(view.initials).toBe('PR');
  });

  it('falls back to "Salesforce Expert" / "this expert" when names are null', () => {
    const view = mapProfileToView(
      makeProfile({
        user: {
          id: 'u',
          firstName: null,
          lastName: null,
          avatarUrl: null,
          country: null,
          countryCode: null,
          timezone: 'UTC',
        } as PublicExpertProfile['user'],
      })
    );
    expect(view.name).toBe('Salesforce Expert');
    expect(view.firstName).toBe('this expert');
  });

  it('passes through the avatar key (mapper stays pure — no URL resolution)', () => {
    expect(mapProfileToView(makeProfile()).avatarKey).toBe('avatar-key');
  });

  it('hard-codes baloVerified true and topRated false', () => {
    const view = mapProfileToView(makeProfile());
    expect(view.baloVerified).toBe(true);
    expect(view.topRated).toBe(false);
  });

  it('passes through the real consultation count', () => {
    expect(mapProfileToView(makeProfile({ consultationCount: 3 })).consultationCount).toBe(3);
    expect(mapProfileToView(makeProfile({ consultationCount: 0 })).consultationCount).toBe(0);
  });
});

describe('mapProfileToView — rate', () => {
  it('converts rateCents to dollars per minute', () => {
    expect(mapProfileToView(makeProfile({ rateCents: 950 })).rate).toBe(9.5);
  });

  it('maps null rateCents to null rate', () => {
    expect(mapProfileToView(makeProfile({ rateCents: null })).rate).toBeNull();
  });
});

describe('mapProfileToView — yearsExperience', () => {
  it('computes years from the start year', () => {
    const startYear = new Date().getUTCFullYear() - 11;
    expect(
      mapProfileToView(makeProfile({ yearStartedSalesforce: startYear })).yearsExperience
    ).toBe(11);
  });

  it('maps a null start year to null', () => {
    expect(
      mapProfileToView(makeProfile({ yearStartedSalesforce: null })).yearsExperience
    ).toBeNull();
  });

  it('never returns a negative number', () => {
    const future = new Date().getUTCFullYear() + 5;
    expect(mapProfileToView(makeProfile({ yearStartedSalesforce: future })).yearsExperience).toBe(
      0
    );
  });
});

describe('mapProfileToView — skills', () => {
  it('dedupes a skill across support types to its MAX proficiency and sorts desc', () => {
    const skills = [
      { skill: { id: 's1', name: 'Apex' }, supportType: { id: 't1' }, proficiency: 6 },
      { skill: { id: 's1', name: 'Apex' }, supportType: { id: 't2' }, proficiency: 9 },
      { skill: { id: 's2', name: 'Flow' }, supportType: { id: 't1' }, proficiency: 4 },
    ];
    const view = mapProfileToView(
      makeProfile({ skills: skills as unknown as PublicExpertProfile['skills'] })
    );
    expect(view.skills).toHaveLength(2);
    // sorted by proficiency desc → Apex (9) first
    expect(view.skills[0]).toMatchObject({ name: 'Apex', proficiency: 9, level: 'Expert' });
    expect(view.skills[1]).toMatchObject({ name: 'Flow', proficiency: 4, level: 'Intermediate' });
    expect(view.skills[0]?.pct).toBe(90);
  });

  it('returns an empty array when there are no skills', () => {
    expect(mapProfileToView(makeProfile()).skills).toEqual([]);
  });
});

describe('mapProfileToView — languages', () => {
  it('maps language rows and builds a comma-joined label', () => {
    const languages = [
      { language: { name: 'English', flagEmoji: '🇬🇧' } },
      { language: { name: 'Tamil', flagEmoji: null } },
    ];
    const view = mapProfileToView(
      makeProfile({ languages: languages as unknown as PublicExpertProfile['languages'] })
    );
    expect(view.languages).toEqual([
      { name: 'English', flagEmoji: '🇬🇧' },
      { name: 'Tamil', flagEmoji: null },
    ]);
    expect(view.languagesLabel).toBe('English, Tamil');
  });
});

describe('mapProfileToView — certifications', () => {
  it('maps certs and counts them', () => {
    const certifications = [
      { certification: { id: 'c1', name: 'CTA', logoUrl: 'cta.png' } },
      { certification: { id: 'c2', name: 'Platform Dev II', logoUrl: null } },
    ];
    const view = mapProfileToView(
      makeProfile({
        certifications: certifications as unknown as PublicExpertProfile['certifications'],
      })
    );
    expect(view.certCount).toBe(2);
    expect(view.certifications[0]).toEqual({ id: 'c1', name: 'CTA', logoUrl: 'cta.png' });
  });
});

describe('mapProfileToView — agency', () => {
  it('returns null for a freelancer (no agency)', () => {
    expect(mapProfileToView(makeProfile()).agency).toBeNull();
    expect(mapProfileToView(makeProfile()).agencyId).toBeNull();
  });

  it('maps an agency lockup with derived initials', () => {
    const view = mapProfileToView(
      makeProfile({
        agencyId: 'agency-1',
        agency: {
          id: 'agency-1',
          name: 'MIDCAI Consulting',
          slug: 'midcai',
          logoUrl: 'logo.png',
        } as PublicExpertProfile['agency'],
      })
    );
    expect(view.agencyId).toBe('agency-1');
    expect(view.agency).toEqual({
      name: 'MIDCAI Consulting',
      slug: 'midcai',
      logoUrl: 'logo.png',
      initials: 'MC',
    });
  });
});

describe('mapProfileToView — work history formatting', () => {
  it('formats a current role period as "— Present" with an empty duration', () => {
    const view = mapProfileToView(
      makeProfile({
        workHistory: [
          {
            role: 'Founder',
            company: 'MIDCAI',
            startedAt: new Date(Date.UTC(2025, 3, 1)),
            endedAt: null,
            isCurrent: true,
            responsibilities: 'Lead.',
          },
        ] as unknown as PublicExpertProfile['workHistory'],
      })
    );
    expect(view.workHistory[0]).toMatchObject({
      role: 'Founder',
      periodLabel: 'Apr 2025 — Present',
      durationLabel: '',
      isCurrent: true,
    });
  });

  it('formats a past role period and a year-only duration', () => {
    const view = mapProfileToView(
      makeProfile({
        workHistory: [
          {
            role: 'MD',
            company: 'Horizontal',
            startedAt: new Date(Date.UTC(2020, 3, 1)),
            endedAt: new Date(Date.UTC(2025, 3, 1)),
            isCurrent: false,
            responsibilities: null,
          },
        ] as unknown as PublicExpertProfile['workHistory'],
      })
    );
    expect(view.workHistory[0]?.periodLabel).toBe('Apr 2020 — Apr 2025');
    expect(view.workHistory[0]?.durationLabel).toBe('5 yrs');
  });
});

describe('formatPeriod / formatDuration helpers', () => {
  it('formatPeriod uses Present for current or open-ended roles', () => {
    expect(formatPeriod(new Date(Date.UTC(2025, 3, 1)), null, true)).toBe('Apr 2025 — Present');
    expect(formatPeriod(new Date(Date.UTC(2025, 3, 1)), null, false)).toBe('Apr 2025 — Present');
  });

  it('formatDuration renders "yrs" + "mos"', () => {
    expect(formatDuration(new Date(Date.UTC(2017, 10, 1)), new Date(Date.UTC(2020, 3, 1)))).toBe(
      '2 yrs 5 mos'
    );
  });

  it('formatDuration renders months-only spans', () => {
    expect(formatDuration(new Date(Date.UTC(2020, 0, 1)), new Date(Date.UTC(2020, 8, 1)))).toBe(
      '8 mos'
    );
  });

  it('formatDuration renders a singular year', () => {
    expect(formatDuration(new Date(Date.UTC(2020, 0, 1)), new Date(Date.UTC(2021, 0, 1)))).toBe(
      '1 yr'
    );
  });

  it('formatDuration handles sub-month spans', () => {
    expect(formatDuration(new Date(Date.UTC(2020, 0, 1)), new Date(Date.UTC(2020, 0, 15)))).toBe(
      '< 1 mo'
    );
  });
});
