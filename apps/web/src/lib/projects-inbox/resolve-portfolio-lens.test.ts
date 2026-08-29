import { describe, it, expect } from 'vitest';
import type { SessionUser } from '@/lib/auth/session';
import { resolvePortfolioLens } from './resolve-portfolio-lens';

function makeUser(overrides: Partial<SessionUser> = {}): SessionUser {
  return {
    id: 'user-1',
    email: 'dana@northwind.test',
    firstName: 'Dana',
    lastName: 'Lee',
    avatarUrl: null,
    activeMode: 'client',
    onboardingCompleted: true,
    platformRole: 'user',
    companyId: 'company-1',
    companyName: 'Northwind Industrial',
    companyRole: 'owner',
    ...overrides,
  };
}

describe('resolvePortfolioLens', () => {
  describe('allowedLenses', () => {
    it('gives a pure client only the client lens (no control)', () => {
      const { allowedLenses } = resolvePortfolioLens(makeUser());
      expect(allowedLenses).toEqual(['client']);
    });

    it('adds the expert lens when the user has an expert profile', () => {
      const { allowedLenses } = resolvePortfolioLens(makeUser({ expertProfileId: 'expert-1' }));
      expect(allowedLenses).toEqual(['client', 'expert']);
    });

    it('adds the admin lens for a platform admin', () => {
      const { allowedLenses } = resolvePortfolioLens(makeUser({ platformRole: 'admin' }));
      expect(allowedLenses).toEqual(['client', 'admin']);
    });

    it('gives all three lenses to a multi-role user', () => {
      const { allowedLenses } = resolvePortfolioLens(
        makeUser({ platformRole: 'super_admin', expertProfileId: 'expert-1' })
      );
      expect(allowedLenses).toEqual(['client', 'expert', 'admin']);
    });
  });

  describe('default lens', () => {
    it('defaults a plain client to the client lens', () => {
      expect(resolvePortfolioLens(makeUser()).lens).toBe('client');
    });

    it('defaults an expert-mode user with a profile to the expert lens', () => {
      expect(
        resolvePortfolioLens(makeUser({ activeMode: 'expert', expertProfileId: 'expert-1' })).lens
      ).toBe('expert');
    });

    it('does NOT default to expert when activeMode is expert but no profile exists', () => {
      expect(resolvePortfolioLens(makeUser({ activeMode: 'expert' })).lens).toBe('client');
    });

    it('defaults a platform admin to the admin lens regardless of mode', () => {
      expect(
        resolvePortfolioLens(
          makeUser({ platformRole: 'admin', activeMode: 'expert', expertProfileId: 'expert-1' })
        ).lens
      ).toBe('admin');
    });
  });

  describe('?lens= override', () => {
    it('honours a requested lens the viewer qualifies for', () => {
      const { lens } = resolvePortfolioLens(makeUser({ expertProfileId: 'expert-1' }), 'expert');
      expect(lens).toBe('expert');
    });

    it('falls back to the default for a lens the viewer does NOT qualify for', () => {
      // Plain client requesting the expert lens → silently falls back.
      const { lens } = resolvePortfolioLens(makeUser(), 'expert');
      expect(lens).toBe('client');
    });

    it('falls back to the default for a garbage lens value', () => {
      const { lens } = resolvePortfolioLens(makeUser({ expertProfileId: 'expert-1' }), 'wat');
      expect(lens).toBe('client');
    });

    it('lets an admin explicitly switch to the client lens', () => {
      const { lens } = resolvePortfolioLens(makeUser({ platformRole: 'admin' }), 'client');
      expect(lens).toBe('client');
    });
  });
});

describe('BAL-494 / ADR-1053 — expand/contract pin (site 5)', () => {
  // `resolvePortfolioLens` reads only `activeMode` / `expertProfileId` / `platformRole` off
  // `SessionUser` — it never looks at `activeWorkspace` or `workspaces`. These pins prove that
  // behaviour is UNCHANGED now that `activeMode` is a PROJECTION of the active workspace
  // (BAL-494) rather than an independent field: with `active_company_id = NULL` (every
  // existing row), the derived `activeMode` reproduces today's exact value, so this resolver
  // needs no edit.

  it('a SessionUser carrying activeWorkspace resolves identically — the resolver ignores the new field', () => {
    const withWorkspace = makeUser({
      activeWorkspace: {
        type: 'company',
        key: 'company:company-1',
        companyId: 'company-1',
        name: 'Northwind Industrial',
        via: 'membership',
        isPersonal: false,
      },
    });
    const withoutWorkspace = makeUser();

    expect(resolvePortfolioLens(withWorkspace)).toEqual(resolvePortfolioLens(withoutWorkspace));
  });

  it('an active expert workspace (activeMode projected to "expert") defaults to the expert lens', () => {
    // Reachable either the pre-BAL-494 way (approve-expert flips activeMode) or via a switch
    // into the EXPERT_WORKSPACE — both project activeMode:'expert', and this resolver cannot
    // tell them apart (by design: it never reads activeWorkspace).
    const { lens, allowedLenses } = resolvePortfolioLens(
      makeUser({
        activeMode: 'expert',
        expertProfileId: 'expert-1',
        activeWorkspace: { type: 'expert', key: 'expert' },
      })
    );
    expect(lens).toBe('expert');
    expect(allowedLenses).toEqual(['client', 'expert']);
  });

  it('an unapproved applicant qualifies for the expert lens but never defaults to it', () => {
    // deriveWorkspaces never builds an expert workspace for an unapproved applicant
    // (hasApprovedExpertProfile: false), so activeMode can never reach 'expert' through a
    // switch for this user — it stays projected as 'client'. `expertProfileId` is still set
    // (the application exists), which is enough for allowedLenses to include 'expert' so the
    // segmented control is visible, but the default view stays client.
    const { lens, allowedLenses } = resolvePortfolioLens(
      makeUser({
        activeMode: 'client',
        expertProfileId: 'expert-1',
        activeWorkspace: {
          type: 'company',
          key: 'company:company-1',
          companyId: 'company-1',
          name: 'Northwind Industrial',
          via: 'membership',
          isPersonal: false,
        },
      })
    );
    expect(allowedLenses).toEqual(['client', 'expert']);
    expect(lens).toBe('client');
  });
});
