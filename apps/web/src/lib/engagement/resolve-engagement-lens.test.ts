import { describe, it, expect } from 'vitest';
import { PLATFORM_STAFF_ROLES } from '@balo/shared/authz';
import type { SessionUser } from '@/lib/auth/session';
import { resolveEngagementLens } from './resolve-engagement-lens';

const CLIENT_COMPANY = 'company-northwind';
const EXPERT_PROFILE = 'expert-priya';

function makeUser(over: Partial<SessionUser> = {}): SessionUser {
  return {
    id: 'user-1',
    email: 'user@example.com',
    firstName: 'Dana',
    lastName: 'Lee',
    avatarUrl: null,
    activeMode: 'client',
    onboardingCompleted: true,
    platformRole: 'user',
    companyId: 'company-other',
    companyName: 'Other Co',
    companyRole: 'member',
    ...over,
  };
}

/**
 * Only `companyId` / `expertProfileId` are read by the resolver, and since BAL-417
 * that is exactly what the parameter DECLARES — so this fixture needs NO cast. The
 * pre-split version had to `as EngagementWithMilestones` a 2-field object at a
 * ~30-field parameter, which silenced the compiler on every field including the two
 * that matter. This version is genuinely type-checked.
 */
function makeEngagement(over: Partial<{ companyId: string; expertProfileId: string }> = {}): {
  companyId: string;
  expertProfileId: string;
} {
  return {
    companyId: CLIENT_COMPANY,
    expertProfileId: EXPERT_PROFILE,
    ...over,
  };
}

describe('resolveEngagementLens', () => {
  it('resolves the owning company to the client participant lens', () => {
    const ctx = resolveEngagementLens(makeUser({ companyId: CLIENT_COMPANY }), makeEngagement());
    expect(ctx).toEqual({
      lens: 'client',
      archetype: 'participant',
      isClientOwner: true,
      isDeliveringExpert: false,
    });
  });

  it('resolves the delivering expert to the expert participant lens', () => {
    const ctx = resolveEngagementLens(
      makeUser({ companyId: 'company-other', expertProfileId: EXPERT_PROFILE }),
      makeEngagement()
    );
    expect(ctx).toEqual({
      lens: 'expert',
      archetype: 'participant',
      isClientOwner: false,
      isDeliveringExpert: true,
    });
  });

  it('resolves a platform admin to the admin observer lens', () => {
    const ctx = resolveEngagementLens(
      makeUser({ platformRole: 'admin', companyId: 'company-other' }),
      makeEngagement()
    );
    expect(ctx?.lens).toBe('admin');
    expect(ctx?.archetype).toBe('observer');
  });

  it('super_admin also resolves to the admin observer lens', () => {
    const ctx = resolveEngagementLens(
      makeUser({ platformRole: 'super_admin', companyId: 'company-other' }),
      makeEngagement()
    );
    expect(ctx?.lens).toBe('admin');
  });

  it('gives admin precedence even when the admin also owns the company', () => {
    const ctx = resolveEngagementLens(
      makeUser({ platformRole: 'admin', companyId: CLIENT_COMPANY }),
      makeEngagement()
    );
    expect(ctx?.lens).toBe('admin');
    expect(ctx?.archetype).toBe('observer');
    // Incidental overlap still recorded on the flags for the view.
    expect(ctx?.isClientOwner).toBe(true);
  });

  it('gives admin precedence even when the admin is also the delivering expert', () => {
    const ctx = resolveEngagementLens(
      makeUser({
        platformRole: 'admin',
        companyId: 'company-other',
        expertProfileId: EXPERT_PROFILE,
      }),
      makeEngagement()
    );
    expect(ctx?.lens).toBe('admin');
    expect(ctx?.isDeliveringExpert).toBe(true);
  });

  it('returns null for a stranger (no company / expert match)', () => {
    const ctx = resolveEngagementLens(
      makeUser({ companyId: 'company-other', expertProfileId: 'expert-stranger' }),
      makeEngagement()
    );
    expect(ctx).toBeNull();
  });

  it('returns null when the user has no expert profile and is not the owner', () => {
    const ctx = resolveEngagementLens(
      makeUser({ companyId: 'company-other', expertProfileId: undefined }),
      makeEngagement()
    );
    expect(ctx).toBeNull();
  });

  it('is IDOR-safe: a company mismatch never grants the client lens', () => {
    const ctx = resolveEngagementLens(
      makeUser({ companyId: 'company-attacker' }),
      makeEngagement({ companyId: CLIENT_COMPANY })
    );
    expect(ctx).toBeNull();
  });

  it('is IDOR-safe: an expertProfileId mismatch never grants the expert lens', () => {
    const ctx = resolveEngagementLens(
      makeUser({ companyId: 'company-other', expertProfileId: 'expert-other' }),
      makeEngagement()
    );
    expect(ctx).toBeNull();
  });

  it('is activeMode-agnostic: an expert browsing in client mode still gets the expert lens', () => {
    const ctx = resolveEngagementLens(
      makeUser({
        companyId: 'company-other',
        expertProfileId: EXPERT_PROFILE,
        activeMode: 'client',
      }),
      makeEngagement()
    );
    expect(ctx?.lens).toBe('expert');
  });

  it('is activeMode-agnostic: an owner browsing in expert mode still gets the client lens', () => {
    const ctx = resolveEngagementLens(
      makeUser({ companyId: CLIENT_COMPANY, activeMode: 'expert', expertProfileId: 'expert-x' }),
      makeEngagement()
    );
    expect(ctx?.lens).toBe('client');
  });

  /**
   * BAL-404 fix round F7 — `ADMIN_ROLES` in `resolve-engagement-lens.ts` is a THIRD, independent
   * spelling of the platform-staff set (`packages/shared/src/authz/platform.ts`'s
   * `PLATFORM_STAFF_ROLES` is the ADR-1035 canonical one; `require-admin.ts`'s `isPlatformAdmin`
   * is the second). `ADMIN_ROLES` is not exported, and this file may not edit the resolver (R5
   * — it is a hard guardrail), so it cannot be imported and compared directly. This pins the two
   * sets BEHAVIORALLY instead, from a test file only: every `PLATFORM_STAFF_ROLES` role must
   * resolve the admin observer lens (below), and a role that ISN'T in that set must not (the
   * `platformRole: 'user'` cases already above, `'returns null for a stranger'` included).
   *
   * ⚠ THIS PINS ONE DIRECTION ONLY (external review, pre-merge — the earlier wording, "a role
   * added to one set and not the other fails one of these", overclaimed). A role added to
   * `PLATFORM_STAFF_ROLES` but NOT to the resolver's `ADMIN_ROLES` fails here. The REVERSE — a
   * role added to `ADMIN_ROLES` only — trips nothing, because this test never enumerates
   * `ADMIN_ROLES` (it can't; it is unexported). That gap is deliberate and it fails CLOSED: such
   * a role would receive the admin observer LENS but hold no platform capability, so every
   * migrated gate in this PR still denies it. An accepted gap, not coverage — closing it needs
   * the resolver to export its set, which R5 forbids here. Fold into BAL-316.
   */
  it.each([...PLATFORM_STAFF_ROLES])(
    'every PLATFORM_STAFF_ROLES role (%s) resolves the admin observer lens',
    (role) => {
      const ctx = resolveEngagementLens(
        makeUser({ platformRole: role, companyId: 'company-other' }),
        makeEngagement()
      );
      expect(ctx?.lens).toBe('admin');
      expect(ctx?.archetype).toBe('observer');
    }
  );
});
