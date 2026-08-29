import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { codeLinesOf, namedImportsFrom, resolveRouteDir, scanRouteSources } from './_source-scan';

/**
 * BAL-495 / ADR-1029 — structural invariant for **THE NAV REGISTRY GATES ON A RESOLVED
 * CAPABILITY, NEVER ON A ROLE, LENS, OR VIEW COMPARISON.**
 *
 * Orchestrator decision 2: ONE new, narrowly-scoped invariant scanning `nav-registry.ts` (the
 * gating source). Do NOT modify any existing invariant suite. Do NOT widen an existing scan to
 * cover `components/layout/**` — `activeMode ===` legitimately survives elsewhere in that tree
 * for PRESENTATION (Logo expert badge, user-pill subtitle).
 *
 * Open-questions answer #1: KEEP Scan B. `nav-context.ts` is where the old
 * `companyRole !== 'owner' && companyRole !== 'admin'` comparison actually lived — it names a
 * FILE, not a tree, so it strengthens decision 2 without widening it. Its token set is
 * NARROWER and deliberately permits `activeMode` — the ADR-1053 projection, not a gate.
 *
 * Reuses `codeLinesOf` / `namedImportsFrom` / `resolveRouteDir` from `./_source-scan`
 * (extracted for `review-link-never-writes.test.ts` / `join-link-never-writes.test.ts`) rather
 * than duplicating ~70 lines — `resolveRouteDir` also supplies the CI-vs-local cwd-candidate
 * handling (memory `reference_web_server_disk_asset_cwd`).
 */

const REGISTRY_PATH = resolveRouteDir([
  'src/components/layout/nav-registry.ts',
  'apps/web/src/components/layout/nav-registry.ts',
]);

const NAV_CONTEXT_PATH = resolveRouteDir([
  'src/lib/navigation/nav-context.ts',
  'apps/web/src/lib/navigation/nav-context.ts',
]);

function readCodeLines(filePath: string): string {
  return codeLinesOf(readFileSync(filePath, 'utf8'));
}

describe('nav registry — capability-gated, never role/lens/view-gated (BAL-495)', () => {
  it('guards the guard: both files resolve to a real, non-empty path', () => {
    expect(REGISTRY_PATH).not.toBe('');
    expect(NAV_CONTEXT_PATH).not.toBe('');
  });

  describe('Scan A — nav-registry.ts (the gating source)', () => {
    const source = readCodeLines(REGISTRY_PATH);

    it('guards the guard: the scanned source is non-empty and genuinely contains NAV_ENTRIES', () => {
      expect(source.length).toBeGreaterThan(0);
      expect(source).toContain('NAV_ENTRIES');
    });

    it.each([
      'lens',
      'activeMode',
      'platformRole',
      'role ===',
      "role === '",
      'companyRole',
      'isPersonal',
    ])('never contains the forbidden token %j', (token) => {
      expect(source).not.toContain(token);
    });

    it('does not value-import @/lib/authz (server-only, async, DB-backed)', () => {
      expect(source).not.toContain('@/lib/authz');
      expect(namedImportsFrom(source, '@/lib/authz')).toEqual([]);
    });

    it('does not import @balo/db (the client-bundle tls footgun) nor server-only', () => {
      expect(source).not.toContain('@balo/db');
      expect(source).not.toContain('server-only');
    });

    it('imports the pure role→capability map from @balo/shared/authz', () => {
      expect(source).toContain('@balo/shared/authz');
      expect(namedImportsFrom(source, '@balo/shared/authz')).toEqual(
        expect.arrayContaining(['CAPABILITIES'])
      );
    });
  });

  describe('Scan B — nav-context.ts (the resolution seam, narrower token set)', () => {
    const source = readCodeLines(NAV_CONTEXT_PATH);

    it('guards the guard: the scanned source is non-empty and genuinely calls roleHasCapability + companiesRepository', () => {
      expect(source.length).toBeGreaterThan(0);
      expect(source).toContain('roleHasCapability');
      expect(source).toContain('companiesRepository');
    });

    it.each(['role ===', "role === '", "'owner'", "'admin'"])(
      'never contains the forbidden token %j',
      (token) => {
        expect(source).not.toContain(token);
      }
    );

    it('imports @balo/shared/authz and calls roleHasCapability', () => {
      expect(namedImportsFrom(source, '@balo/shared/authz')).toEqual(
        expect.arrayContaining(['roleHasCapability'])
      );
    });
  });

  describe('Scan C — NAV_ENTRIES has exactly one non-test consumer (BAL-495 fix round #7)', () => {
    const SRC_DIR = resolveRouteDir(['src', 'apps/web/src']);

    it('guards the guard: SRC_DIR resolves to a real, non-empty path', () => {
      expect(SRC_DIR).not.toBe('');
    });

    it('nav-registry.ts is the ONLY non-test file naming NAV_ENTRIES — BAL-501/503 must import resolveNavItems', () => {
      const consumers = scanRouteSources(SRC_DIR, '', [])
        .filter((file) => file.code.includes('NAV_ENTRIES'))
        .map((file) => file.rel);
      expect(consumers).toEqual(['components/layout/nav-registry.ts']);
    });
  });

  describe('codeLinesOf comment-stripping (guards the guard against a false pass)', () => {
    it('drops a comment line quoting a forbidden word while keeping real code', () => {
      const scanned = codeLinesOf('// role === "owner"\nconst a = NAV_ENTRIES;');
      expect(scanned).not.toContain('role ===');
      expect(scanned).toContain('NAV_ENTRIES');
    });

    it('keeps code that follows a same-line block-comment close', () => {
      const scanned = codeLinesOf("/* note */ if (activeMode === 'expert') {}");
      expect(scanned).toContain('activeMode');
    });
  });
});
