import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { codeLinesOf, namedImportsFrom, resolveRouteDir } from './_source-scan';

/**
 * BAL-534 / ADR-1029 — structural invariant for **THE `/admin` MIDDLEWARE GATE RESOLVES A
 * CAPABILITY, NEVER A PLATFORM-ROLE LITERAL.**
 *
 * ⚠ WRITTEN HERE BECAUSE NOTHING COVERED `middleware.ts` (orchestrator D8). Before this file,
 * `grep -rln middleware apps/web/src/invariants/` returned nothing and `_source-scan.ts`
 * carried no middleware exemption — so the ticket's "the invariant scan passes with the new
 * call site" AC would have been vacuous in both directions: nothing failed with the literals
 * in, nothing newly passed with them out.
 *
 * Fourth consumer of `_source-scan`'s shared reading primitives. Per that module's docblock,
 * this file carries its OWN "guards the guard" test proving the scan genuinely reaches
 * `middleware.ts` and reads a token that IS present — otherwise every `not.toContain` below
 * would pass for the wrong reason.
 *
 * If this test fails: you reintroduced a platform-role literal into the Edge gate. Resolve
 * `PLATFORM_CAPABILITIES.VIEW_PLATFORM_ADMIN` through `platformRoleHasCapability` instead.
 *
 * ⚠ BAL-534 fix round F5 — the ban list is widened past the four original substrings, which an
 * evader could route around without touching any of them: a role gate reintroduced via a helper
 * (`isPlatformAdmin(...)` / `isPlatformAdminRole(...)`) contains none of the original tokens, and
 * a template-literal comparison (`` role === `admin` ``) evades the single-quoted `'admin'`. The
 * list below additionally bans the helper-name shapes, the `platformRole ===` comparison, and
 * the backtick literal forms.
 */

const MIDDLEWARE_PATH = resolveRouteDir(['src/middleware.ts', 'apps/web/src/middleware.ts']);

describe('the /admin middleware gate is capability-resolved, never role-literal (BAL-534)', () => {
  const source = codeLinesOf(
    readFileSync(MIDDLEWARE_PATH === '' ? '/dev/null' : MIDDLEWARE_PATH, 'utf8')
  );

  it('guards the guard: the path resolves, the source is non-empty, and it genuinely gates the admin prefix', () => {
    expect(MIDDLEWARE_PATH).not.toBe('');
    expect(source.length).toBeGreaterThan(0);
    // NON-VACUITY ANCHOR — `isAdminRoute` is present both BEFORE and AFTER this ticket's change,
    // so it proves the file was read without itself being what the invariant asserts.
    expect(source).toContain('isAdminRoute');
    expect(source).toContain('checkRouteGuards');
  });

  it.each([
    "'admin'",
    "'super_admin'",
    'role ===',
    "role !== '",
    'isPlatformAdmin',
    'isPlatformAdminRole',
    'platformRole ===',
    '`admin`',
    '`super_admin`',
  ])('never contains the forbidden platform-role literal %j', (token) => {
    expect(source).not.toContain(token);
  });

  it('resolves the gate through the platform capability predicate', () => {
    expect(source).toContain('platformRoleHasCapability');
    expect(source).toContain('VIEW_PLATFORM_ADMIN');
  });

  it('imports both the predicate and the token map by name from @balo/shared/authz', () => {
    expect(namedImportsFrom(source, '@balo/shared/authz')).toEqual(
      expect.arrayContaining(['platformRoleHasCapability', 'PLATFORM_CAPABILITIES'])
    );
  });

  it('stays Edge-legal: no server-only, no @balo/db, no node: import', () => {
    expect(source).not.toContain('server-only');
    expect(source).not.toContain('@balo/db');
    expect(source).not.toContain('node:');
  });
});
