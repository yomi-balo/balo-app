import { describe, it, expect } from 'vitest';
import {
  isPublicRoute,
  isAdminRoute,
  isApiRoute,
  isValidReturnTo,
  PUBLIC_PATHS,
  PUBLIC_PREFIXES,
  ONBOARDING_PATH,
} from './route-config';

describe('isPublicRoute', () => {
  it('matches exact public paths', () => {
    for (const path of PUBLIC_PATHS) {
      expect(isPublicRoute(path)).toBe(true);
    }
  });

  it('matches prefix-based public paths', () => {
    expect(isPublicRoute('/api/auth/callback')).toBe(true);
    expect(isPublicRoute('/api/webhooks/stripe')).toBe(true);
    expect(isPublicRoute('/api/health')).toBe(true);
    expect(isPublicRoute('/experts/abc-123')).toBe(true);
    expect(isPublicRoute('/blog/some-post')).toBe(true);
  });

  it('rejects protected routes', () => {
    expect(isPublicRoute('/dashboard')).toBe(false);
    expect(isPublicRoute('/settings')).toBe(false);
    expect(isPublicRoute('/cases/123')).toBe(false);
    expect(isPublicRoute('/projects/456')).toBe(false);
    expect(isPublicRoute('/onboarding')).toBe(false);
    expect(isPublicRoute('/admin')).toBe(false);
    expect(isPublicRoute('/admin/users')).toBe(false);
  });

  it('does not match similar-but-different paths', () => {
    // /experts is exact match, /experts/ is prefix — /expertsx should not match
    expect(isPublicRoute('/expertsx')).toBe(false);
    expect(isPublicRoute('/loginx')).toBe(false);
    expect(isPublicRoute('/api/cases')).toBe(false);
  });
});

describe('isAdminRoute', () => {
  it('matches /admin exactly', () => {
    expect(isAdminRoute('/admin')).toBe(true);
  });

  it('matches /admin/* paths', () => {
    expect(isAdminRoute('/admin/users')).toBe(true);
    expect(isAdminRoute('/admin/settings/roles')).toBe(true);
  });

  it('does not match similar paths', () => {
    expect(isAdminRoute('/administrator')).toBe(false);
    expect(isAdminRoute('/admin-panel')).toBe(false);
    expect(isAdminRoute('/dashboard/admin')).toBe(false);
  });
});

describe('isApiRoute', () => {
  it('matches /api/* paths', () => {
    expect(isApiRoute('/api/cases')).toBe(true);
    expect(isApiRoute('/api/auth/callback')).toBe(true);
    expect(isApiRoute('/api/health')).toBe(true);
  });

  it('does not match non-api paths', () => {
    expect(isApiRoute('/dashboard')).toBe(false);
    expect(isApiRoute('/apiary')).toBe(false);
  });
});

describe('isValidReturnTo', () => {
  it('accepts valid relative paths', () => {
    expect(isValidReturnTo('/dashboard')).toBe(true);
    expect(isValidReturnTo('/cases/123')).toBe(true);
    expect(isValidReturnTo('/dashboard?tab=billing')).toBe(true);
    expect(isValidReturnTo('/settings/profile')).toBe(true);
    expect(isValidReturnTo('/expert/dashboard')).toBe(true);
  });

  it('rejects absolute URLs (open redirect)', () => {
    expect(isValidReturnTo('https://evil.com')).toBe(false);
    expect(isValidReturnTo('http://evil.com')).toBe(false);
  });

  it('rejects protocol-relative URLs', () => {
    expect(isValidReturnTo('//evil.com')).toBe(false);
  });

  it('rejects paths with embedded protocols', () => {
    expect(isValidReturnTo('/redirect?url=https://evil.com')).toBe(false);
  });

  it('rejects backslash-based bypasses', () => {
    expect(isValidReturnTo(String.raw`/\evil.com`)).toBe(false);
  });

  it('rejects auth-related paths to prevent redirect loops', () => {
    expect(isValidReturnTo('/login')).toBe(false);
    expect(isValidReturnTo('/login?foo=bar')).toBe(false);
    expect(isValidReturnTo('/signup')).toBe(false);
    expect(isValidReturnTo('/api/auth/callback')).toBe(false);
  });

  it('rejects paths not starting with /', () => {
    expect(isValidReturnTo('dashboard')).toBe(false);
    expect(isValidReturnTo('')).toBe(false);
  });
});

describe('constants', () => {
  it('ONBOARDING_PATH is /onboarding', () => {
    expect(ONBOARDING_PATH).toBe('/onboarding');
  });

  it('PUBLIC_PREFIXES does not include /_next/ (handled by matcher)', () => {
    expect(PUBLIC_PREFIXES).not.toContain('/_next/');
  });
});
