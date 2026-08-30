import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { SENSITIVE_PATH_PREFIXES } from '@balo/shared/redaction';
import {
  isPublicRoute,
  isAdminRoute,
  isApiRoute,
  isOnboardingRoute,
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
    // BAL-386 — public email-bound magic-link proposal view.
    expect(isPublicRoute('/shared/proposals/some-token')).toBe(true);
    // BAL-390 — public token-authenticated star-rating landing. Without this the
    // middleware 302s every emailed reviewer to /login and the feature is dead.
    expect(isPublicRoute('/review/some-token')).toBe(true);
    expect(isPublicRoute('/review/some-token?r=3')).toBe(true);
    // BAL-408 — public token-authenticated guest join landing. Without this the
    // middleware 302s every invited guest to /login, and a guest has no account to
    // log in WITH, so the feature is not merely degraded — it is unreachable.
    expect(isPublicRoute('/join/some-token')).toBe(true);
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

  // BAL-502 §22 — the marketing header's supply-side link target. Public so the page (not
  // the Edge) owns the anonymous experience: `/expert/apply` renders a genuine anonymous
  // preview (public taxonomy only, via `loadReferenceData()`) rather than redirecting to
  // /login — the auth wall moved to SUBMIT. See `route-config.ts`'s own comment on this
  // entry for the full detail.
  it('makes /expert/apply public, exact match only', () => {
    expect(isPublicRoute('/expert/apply')).toBe(true);
    // ⚠ EXACT MATCH ONLY — the children must stay protected.
    expect(isPublicRoute('/expert/apply/success')).toBe(false);
    expect(isPublicRoute('/expert/apply/review')).toBe(false);
    // And the singular prefix must not have opened the plural directory or vice-versa.
    expect(isPublicRoute('/expert')).toBe(false);
    expect(isPublicRoute('/expert/settings')).toBe(false);
  });

  // BAL-510 — TEMPORARY, and the pairing is the whole point of this test.
  //
  // `/v2` is the marketing-home direction preview. It is granted anonymous access so it can be
  // read with the signed-out `MarketingHeader`, the way `/` and `/experts` are. That grant is
  // only defensible while the preview page is actually there: a `PUBLIC_PATHS` entry that
  // outlives its route is a permanently unauthenticated path sitting in the registry, waiting
  // for some future surface to be mounted at exactly `/v2` and silently inherit it.
  //
  // The two facts must move together. When the V1-vs-V2 decision lands and
  // `app/(marketing)/v2/` is deleted, THIS TEST GOES RED until the registry line goes too —
  // which is the only mechanism that survives whoever does the teardown not having read the
  // ticket.
  it('keeps /v2 public only while the preview page exists (paired teardown)', () => {
    const previewPage = join(
      dirname(fileURLToPath(import.meta.url)),
      '../../app/(marketing)/v2/page.tsx'
    );
    expect(PUBLIC_PATHS.has('/v2')).toBe(existsSync(previewPage));
    // ⚠ EXACT MATCH ONLY — no `PUBLIC_PREFIXES` entry was added, so children stay protected.
    expect(isPublicRoute('/v2/anything')).toBe(false);
    expect(isPublicRoute('/v2x')).toBe(false);
  });

  it('does not match similar-but-different paths', () => {
    // /experts is exact match, /experts/ is prefix — /expertsx should not match
    expect(isPublicRoute('/expertsx')).toBe(false);
    expect(isPublicRoute('/loginx')).toBe(false);
    expect(isPublicRoute('/api/cases')).toBe(false);
    // BAL-390 — `/review/` is a prefix, so neither the bare word nor a plural
    // sibling route opens up.
    expect(isPublicRoute('/review')).toBe(false);
    expect(isPublicRoute('/reviews/123')).toBe(false);
    // BAL-408 — same treatment for `/join/`.
    expect(isPublicRoute('/join')).toBe(false);
    expect(isPublicRoute('/joins/123')).toBe(false);
  });
});

/**
 * BAL-390 — the paired-registry guard. A token-in-URL route has to be BOTH public
 * (or the recipient is bounced to /login) AND redacted (or the raw token lands in
 * Axiom and PostHog). Registering one without the other is the defect this test
 * exists to catch, so it asserts containment rather than a hand-listed pair.
 */
describe('token-in-URL routes are public AND redacted', () => {
  it('every sensitive path prefix is also a public prefix', () => {
    for (const prefix of SENSITIVE_PATH_PREFIXES) {
      expect(PUBLIC_PREFIXES).toContain(prefix);
      expect(isPublicRoute(`${prefix}a-token`)).toBe(true);
    }
  });

  it('registers the three token-bearing landings in both registries', () => {
    expect(SENSITIVE_PATH_PREFIXES).toContain('/shared/proposals/');
    expect(SENSITIVE_PATH_PREFIXES).toContain('/review/');
    expect(SENSITIVE_PATH_PREFIXES).toContain('/join/');
    expect(PUBLIC_PREFIXES).toContain('/shared/proposals/');
    expect(PUBLIC_PREFIXES).toContain('/review/');
    expect(PUBLIC_PREFIXES).toContain('/join/');
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

describe('isOnboardingRoute (BAL-348)', () => {
  it('matches the wizard root exactly', () => {
    expect(isOnboardingRoute(ONBOARDING_PATH)).toBe(true);
    expect(isOnboardingRoute('/onboarding')).toBe(true);
  });

  it('matches nested onboarding routes (the join-result landing)', () => {
    expect(isOnboardingRoute('/onboarding/join-result')).toBe(true);
    expect(isOnboardingRoute('/onboarding/anything/deeper')).toBe(true);
  });

  it('does not match similar-but-different paths (so the not-onboarded redirect still applies)', () => {
    expect(isOnboardingRoute('/onboardingx')).toBe(false);
    expect(isOnboardingRoute('/dashboard')).toBe(false);
    expect(isOnboardingRoute('/onboard')).toBe(false);
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
