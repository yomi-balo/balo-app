import { describe, it, expect } from 'vitest';
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
});
