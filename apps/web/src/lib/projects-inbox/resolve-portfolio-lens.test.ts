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
