import { describe, it, expect } from 'vitest';
import type { PartyJoinSettings } from '@balo/db';
import { evaluateMatchStandDown, isActionableDomainMatch } from './match-stand-down';

/**
 * Pure predicate truth-table (BAL-350). `match-stand-down` type-only imports
 * `@balo/db` (erased at compile time), so this suite mocks nothing — it is fully
 * self-contained. It locks the single source of truth that BOTH `runDomainJoin`
 * (server engine) and `resolveOnboardingCompanyAction` (onboarding resolve check)
 * read, so the show/hide decision and the engine's stand-down can never diverge.
 */

function settings(over: Partial<PartyJoinSettings> = {}): PartyJoinSettings {
  return { domainJoinMode: 'auto', membershipAuthority: 'balo', isPersonal: false, ...over };
}

describe('evaluateMatchStandDown', () => {
  it('personal company → personal_owner (5a)', () => {
    expect(evaluateMatchStandDown('company', settings({ isPersonal: true }))).toBe(
      'personal_owner'
    );
  });

  it('directory authority → directory_authority (5b)', () => {
    expect(evaluateMatchStandDown('company', settings({ membershipAuthority: 'directory' }))).toBe(
      'directory_authority'
    );
  });

  it('join mode off → mode_off (5c)', () => {
    expect(evaluateMatchStandDown('company', settings({ domainJoinMode: 'off' }))).toBe('mode_off');
  });

  it('non-personal company, auto mode → null (engine acts)', () => {
    expect(evaluateMatchStandDown('company', settings())).toBeNull();
  });

  it('non-personal company, request mode → null (engine acts)', () => {
    expect(evaluateMatchStandDown('company', settings({ domainJoinMode: 'request' }))).toBeNull();
  });

  it('agency (isPersonal false), auto mode → null (engine acts)', () => {
    expect(evaluateMatchStandDown('agency', settings())).toBeNull();
  });

  it('personal check does NOT apply to an agency (agencies are never personal)', () => {
    // An agency with a stray isPersonal:true would still not hit 5a (partyType guard).
    expect(evaluateMatchStandDown('agency', settings({ isPersonal: true }))).toBeNull();
  });

  it('directory precedence: directory beats a non-personal auto company', () => {
    expect(
      evaluateMatchStandDown(
        'company',
        settings({ membershipAuthority: 'directory', domainJoinMode: 'auto' })
      )
    ).toBe('directory_authority');
  });
});

describe('isActionableDomainMatch', () => {
  it('true only when the engine would act (null stand-down)', () => {
    expect(isActionableDomainMatch('company', settings())).toBe(true);
    expect(isActionableDomainMatch('company', settings({ domainJoinMode: 'request' }))).toBe(true);
    expect(isActionableDomainMatch('agency', settings())).toBe(true);
  });

  it('false for every stand-down reason (personal / directory / mode off)', () => {
    expect(isActionableDomainMatch('company', settings({ isPersonal: true }))).toBe(false);
    expect(isActionableDomainMatch('company', settings({ membershipAuthority: 'directory' }))).toBe(
      false
    );
    expect(isActionableDomainMatch('company', settings({ domainJoinMode: 'off' }))).toBe(false);
  });
});
