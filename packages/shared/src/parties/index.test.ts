import { describe, it, expect } from 'vitest';
import {
  engagementActorAttribution,
  expertPartyDisplayName,
  isPlatformAdminRole,
  personDisplayName,
  PLATFORM_ADMIN_ROLES,
  type EngagementActorAttributionInput,
} from './index';

/**
 * Unit truth-table for the pure counterpart-name helper (BAL-336). Mocks
 * nothing — `@balo/shared/parties` has no `db` import and no I/O. The
 * party-vs-person convention decides the counterpart label the A7 inbox (D6) and
 * the delivery workspace (D1) both render, so the rules are locked here.
 */

describe('expertPartyDisplayName', () => {
  it('returns the agency name for an agency party', () => {
    expect(
      expertPartyDisplayName({
        type: 'agency',
        agencyName: 'Cloudreach',
        firstName: 'Priya',
        lastName: 'Nadella',
      })
    ).toBe('Cloudreach');
  });

  it('falls back to the person name for an agency with a blank agency name', () => {
    expect(
      expertPartyDisplayName({
        type: 'agency',
        agencyName: '   ',
        firstName: 'Priya',
        lastName: 'Nadella',
      })
    ).toBe('Priya Nadella');
  });

  it('falls back to the person name for an agency with a null agency name', () => {
    expect(
      expertPartyDisplayName({
        type: 'agency',
        agencyName: null,
        firstName: 'Priya',
        lastName: 'Nadella',
      })
    ).toBe('Priya Nadella');
  });

  it('returns "First Last" for a freelancer', () => {
    expect(
      expertPartyDisplayName({
        type: 'freelancer',
        agencyName: null,
        firstName: 'Sam',
        lastName: 'Okafor',
      })
    ).toBe('Sam Okafor');
  });

  it('returns just the first name when the last name is null', () => {
    expect(
      expertPartyDisplayName({
        type: 'freelancer',
        agencyName: null,
        firstName: 'Sam',
        lastName: null,
      })
    ).toBe('Sam');
  });

  it('returns "An expert" when no name resolves', () => {
    expect(
      expertPartyDisplayName({
        type: 'freelancer',
        agencyName: null,
        firstName: null,
        lastName: null,
      })
    ).toBe('An expert');
  });

  it('ignores a whitespace-only agency name and trims the person name', () => {
    expect(
      expertPartyDisplayName({
        type: 'freelancer',
        agencyName: null,
        firstName: '  ',
        lastName: 'Okafor',
      })
    ).toBe('Okafor');
  });
});

describe('personDisplayName', () => {
  it('joins first and last', () => {
    expect(personDisplayName('Ada', 'Admin')).toBe('Ada Admin');
  });

  it('uses whichever part is present', () => {
    expect(personDisplayName('Ada', null)).toBe('Ada');
    expect(personDisplayName(null, 'Admin')).toBe('Admin');
  });

  it('trims and drops whitespace-only parts', () => {
    expect(personDisplayName('  ', 'Admin')).toBe('Admin');
  });

  it('falls back to "Unknown" by default when no name resolves', () => {
    expect(personDisplayName(null, null)).toBe('Unknown');
  });

  it('honours a custom fallback', () => {
    expect(personDisplayName(null, null, 'An expert')).toBe('An expert');
  });
});

describe('PLATFORM_ADMIN_ROLES / isPlatformAdminRole', () => {
  it('contains exactly admin + super_admin', () => {
    expect([...PLATFORM_ADMIN_ROLES].sort()).toEqual(['admin', 'super_admin']);
  });

  it('classifies staff roles as admin', () => {
    expect(isPlatformAdminRole('admin')).toBe(true);
    expect(isPlatformAdminRole('super_admin')).toBe(true);
  });

  it('classifies a plain user as non-admin', () => {
    expect(isPlatformAdminRole('user')).toBe(false);
  });
});

describe('engagementActorAttribution', () => {
  // Factory for a typed attribution input so role/name literals are checked.
  function input(
    overrides: Partial<Omit<EngagementActorAttributionInput, 'actor'>> & {
      actor?: Partial<EngagementActorAttributionInput['actor']>;
    } = {}
  ): EngagementActorAttributionInput {
    const { actor, ...rest } = overrides;
    return {
      expertUserId: 'expert-9',
      expertAgencyName: 'CloudPeak',
      companyName: 'Northwind Industrial',
      ...rest,
      actor: {
        id: 'client-1',
        firstName: 'Dana',
        lastName: 'Client',
        platformRole: 'user',
        ...actor,
      },
    };
  }

  it('names a Balo-staff actor "{name} @ Balo" on internal surfaces', () => {
    expect(
      engagementActorAttribution(
        input({
          actor: { id: 'mj-1', firstName: 'MJ', lastName: 'Okonkwo', platformRole: 'admin' },
        })
      )
    ).toBe('MJ Okonkwo @ Balo');
  });

  it('names a Balo-staff actor as just "Balo" on external surfaces', () => {
    expect(
      engagementActorAttribution(
        input({
          actor: { id: 'mj-1', firstName: 'MJ', lastName: 'Okonkwo', platformRole: 'super_admin' },
        }),
        'external'
      )
    ).toBe('Balo');
  });

  it('names the engagement expert actor "{name} @ {agency}" (agency expert)', () => {
    expect(
      engagementActorAttribution(
        input({ actor: { id: 'expert-9', firstName: 'Priya', lastName: 'Nair' } })
      )
    ).toBe('Priya Nair @ CloudPeak');
  });

  it('names a freelancer expert actor by bare name', () => {
    expect(
      engagementActorAttribution(
        input({
          expertAgencyName: null,
          actor: { id: 'expert-9', firstName: 'Priya', lastName: 'Nair' },
        })
      )
    ).toBe('Priya Nair');
  });

  it('names any other (client-member) actor "{name} @ {company}"', () => {
    expect(engagementActorAttribution(input())).toBe('Dana Client @ Northwind Industrial');
  });

  it('keeps a marketplace actor person-named on external surfaces', () => {
    expect(engagementActorAttribution(input(), 'external')).toBe(
      'Dana Client @ Northwind Industrial'
    );
  });
});
