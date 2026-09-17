import { describe, it, expect, vi } from 'vitest';

import { resolveCompanyParticipation, type CompanyRoleLookup } from './company-participation';
import {
  CAPABILITIES,
  roleHasCapability,
  resolveCompanyParticipation as resolveFromBarrel,
} from './index';

/**
 * ⚠ THE COMPANY ROLE VOCABULARY IS PINNED EXPLICITLY, not read off `ROLE_CAPABILITIES`. That map
 * mixes both vocabularies — `expert` is AGENCY-only and can never appear in a
 * `company_members.role` column — so iterating it would assert a verdict for an impossible row.
 */
const COMPANY_ROLES = ['owner', 'admin', 'member'] as const;

describe('resolveCompanyParticipation', () => {
  it('is reachable through the @balo/shared/authz barrel as the SAME function', () => {
    expect(resolveFromBarrel).toBe(resolveCompanyParticipation);
  });

  it('pins a non-empty company role list, every one of which grants PARTICIPATE (non-vacuity)', () => {
    expect(COMPANY_ROLES).toHaveLength(3);
    expect(
      COMPANY_ROLES.filter((role) => roleHasCapability(role, CAPABILITIES.PARTICIPATE))
    ).toEqual([...COMPANY_ROLES]);
  });

  it.each(COMPANY_ROLES)('a live member holding company role %s is a participant', async (role) => {
    await expect(
      resolveCompanyParticipation('company_1', 'actor_1', async () => role)
    ).resolves.toBe('participant');
  });

  it('a live member whose role grants no PARTICIPATE is member_without_participate, not not_a_member', async () => {
    await expect(
      resolveCompanyParticipation('company_1', 'actor_1', async () => 'unknown_role')
    ).resolves.toBe('member_without_participate');
  });

  it('no live membership (the lookup returns undefined) is not_a_member', async () => {
    await expect(
      resolveCompanyParticipation('company_1', 'actor_1', async () => undefined)
    ).resolves.toBe('not_a_member');
  });

  it('calls the lookup exactly once, with exactly (companyId, actorUserId)', async () => {
    const lookup = vi.fn<CompanyRoleLookup>().mockResolvedValue('member');
    await resolveCompanyParticipation('company_1', 'actor_1', lookup);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledWith('company_1', 'actor_1');
  });

  /**
   * ⚠ THE CONFUSED-DEPUTY GUARD. ONE lookup reused across TWO actors must answer about whichever
   * actor is being resolved RIGHT NOW. A closure that captured a privileged actor's id would
   * return that actor's role for both calls and admit the second.
   */
  it('a lookup reused across actors answers about the CURRENT actor, never a captured one', async () => {
    const ROLES: Record<string, string> = { member_user: 'member' };
    const lookup = vi.fn<CompanyRoleLookup>(
      async (_companyId: string, actorUserId: string) => ROLES[actorUserId]
    );

    await expect(resolveCompanyParticipation('company_1', 'member_user', lookup)).resolves.toBe(
      'participant'
    );
    await expect(resolveCompanyParticipation('company_1', 'attacker', lookup)).resolves.toBe(
      'not_a_member'
    );
    expect(lookup).toHaveBeenNthCalledWith(1, 'company_1', 'member_user');
    expect(lookup).toHaveBeenNthCalledWith(2, 'company_1', 'attacker');
  });

  it('propagates a lookup failure rather than resolving a verdict', async () => {
    const failure = new Error('db down');
    await expect(
      resolveCompanyParticipation('company_1', 'actor_1', async () => {
        throw failure;
      })
    ).rejects.toBe(failure);
  });
});
