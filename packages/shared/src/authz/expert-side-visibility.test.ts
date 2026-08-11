import { describe, it, expect, vi } from 'vitest';

import { actorHasExpertSideVisibility } from './expert-side-visibility';
import { ROLE_CAPABILITIES } from './index';
import { resolveHostRole } from './engagement';

const AGENCY_PROFILE = { userId: 'expert_user', agencyId: 'agency_1' } as const;
const INDEPENDENT_PROFILE = { userId: 'expert_user', agencyId: null } as const;

describe('actorHasExpertSideVisibility', () => {
  /**
   * ⚠ THE SHORT-CIRCUIT IS PART OF THE SHIPPED CONTRACT, asserted by CALL-COUNT rather than
   * by inspection — at all three call sites too. A refactor that resolves the agency role
   * eagerly would force a DB round-trip that today never happens, and would fail here.
   */
  it('grants the delivering expert with NO agency lookup', async () => {
    const lookup = vi.fn();
    await expect(actorHasExpertSideVisibility(AGENCY_PROFILE, 'expert_user', lookup)).resolves.toBe(
      true
    );
    expect(lookup).not.toHaveBeenCalled();
  });

  it('denies a stranger against an INDEPENDENT expert with NO agency lookup', async () => {
    const lookup = vi.fn();
    await expect(
      actorHasExpertSideVisibility(INDEPENDENT_PROFILE, 'stranger', lookup)
    ).resolves.toBe(false);
    expect(lookup).not.toHaveBeenCalled();
  });

  /**
   * ⚠ DATA-DRIVEN ON PURPOSE. Iterating `ROLE_CAPABILITIES` rather than hardcoding role
   * strings means a role ADDED to the map surfaces here automatically — the rule is
   * `role !== undefined`, so every present and future role grants. (The map mixes both
   * vocabularies: `member` is company-only, `expert` agency-only. Feeding `member` here is
   * harmless precisely BECAUSE the predicate never interprets the role.)
   */
  const ROLE_NAMES = Object.keys(ROLE_CAPABILITIES);

  it('iterates a non-empty role list that includes the contested `expert` (non-vacuity)', () => {
    expect(ROLE_NAMES.length).toBeGreaterThan(0);
    expect(ROLE_NAMES).toContain('expert');
  });

  it.each(ROLE_NAMES)('grants an agency colleague holding role %s', async (agencyRole) => {
    await expect(
      actorHasExpertSideVisibility(AGENCY_PROFILE, 'colleague', async () => agencyRole)
    ).resolves.toBe(true);
  });

  it('denies when the actor holds no live role in the agency', async () => {
    await expect(
      actorHasExpertSideVisibility(AGENCY_PROFILE, 'colleague', async () => undefined)
    ).resolves.toBe(false);
  });

  /**
   * ⚠ BOTH ARGUMENTS, NOT JUST THE AGENCY ID — THE CONFUSED-DEPUTY GUARD (BAL-419 review).
   * The actor is handed to the lookup PER CALL rather than captured by the closure, which is
   * what stops one lookup built for actor A from answering for actor B. Asserting only the
   * agency id here would leave the second argument free to be dropped in a "simplification",
   * re-opening the resolve-once / check-many escalation that
   * `HostContext.resolvedForActorId` (`./engagement`) closes on the sibling ACT axis.
   */
  it('passes the profile agency id AND the actor through to the lookup unchanged', async () => {
    const lookup = vi.fn().mockResolvedValue('admin');
    await actorHasExpertSideVisibility(AGENCY_PROFILE, 'colleague', lookup);
    expect(lookup).toHaveBeenCalledWith('agency_1', 'colleague');
  });

  /**
   * The behavioural half of the same guard: ONE lookup object reused across TWO actors must
   * answer about whichever actor is being authorized RIGHT NOW. A closure that captured a
   * privileged id would return that id's role for both calls and grant the second.
   */
  it('a lookup reused across actors answers about the CURRENT actor, never a captured one', async () => {
    const ROLES: Record<string, string> = { colleague: 'admin' };
    const lookup = vi.fn(async (_agencyId: string, actorUserId: string) => ROLES[actorUserId]);

    await expect(actorHasExpertSideVisibility(AGENCY_PROFILE, 'colleague', lookup)).resolves.toBe(
      true
    );
    await expect(actorHasExpertSideVisibility(AGENCY_PROFILE, 'attacker', lookup)).resolves.toBe(
      false
    );
    expect(lookup).toHaveBeenNthCalledWith(1, 'agency_1', 'colleague');
    expect(lookup).toHaveBeenNthCalledWith(2, 'agency_1', 'attacker');
  });
});

/**
 * ⚠⚠ TWO RULES, ONE TABLE (ADR-1046 §7). The pin that makes the divergence a DECISION rather
 * than drift. It runs BOTH pure predicates over the SAME agency-role vocabulary in ONE file,
 * so a future refactor that "aligns" them fails HERE, next to the sentence saying not to.
 *
 * ⚠ THE ROLE LIST IS PINNED EXPLICITLY, not read off `ROLE_CAPABILITIES`. That map mixes both
 * vocabularies, and `member` is COMPANY-only — feeding it to `resolveHostRole` would assert an
 * act-verdict for a role that can never appear in an `agency_members.role` column.
 */
describe('visibility vs act — the deliberate divergence', () => {
  it.each([
    { agencyRole: 'owner', visibility: true, act: true },
    { agencyRole: 'admin', visibility: true, act: true },
    { agencyRole: 'expert', visibility: true, act: false }, // ← the whole decision, in one row
  ])(
    'agency role $agencyRole — visibility $visibility, act $act',
    async ({ agencyRole, visibility, act }) => {
      await expect(
        actorHasExpertSideVisibility(AGENCY_PROFILE, 'colleague', async () => agencyRole)
      ).resolves.toBe(visibility);

      expect(
        resolveHostRole(
          {
            resolvedForActorId: 'colleague',
            expertUserId: 'expert_user',
            agency: { agencyId: 'agency_1', actorRole: agencyRole },
          },
          { id: 'colleague' }
        ) !== null
      ).toBe(act);
    }
  );
});
