import { describe, expect, it } from 'vitest';
import { resolveRouteDir, scanRouteSources } from './_source-scan';

/**
 * BAL-561 — structural invariant: **NO `platformRole ===` AND NO ROLE-SET READ ANYWHERE IN THE
 * `/admin/staff-access` SURFACE.**
 *
 * The Staff access page renders and REASONS ABOUT platform roles more than any other surface in
 * the product — a role picker, a role badge, per-role storage rules, per-role floor previews —
 * which makes it the single likeliest place for someone to reach for a quick `role === 'admin'`
 * instead of the shared resolver. ADR-1029's rule is unconditional: an eligibility or permission
 * question is answered by `@balo/shared/authz` (here, specifically `staff-access.ts`'s
 * `staffCustomListAllowed`, `customListCanHold`, `accountKeepsStaffManagementFloor`,
 * `staffManagementFloorHolds` and friends), never by comparing a role value inline.
 *
 * ⚠ ROLE VALUES ARE SUBJECT **DATA**, NOT BANNED. `STAFF_ACCESS_ROLE_ORDER`'s tuple, a
 * `Record<PlatformRole, …>` lookup (`STAFF_ACCESS_ROLE_COPY[role]`, `PLATFORM_ROLE_LABELS[role]`),
 * and a `role: 'super_admin'` object literal in test fixture data are all fine — none of them ASKS
 * a permission question inline. What is banned is a spelling that DECIDES something by comparing
 * or switching on a role value directly, or that reaches for a role-SET constant instead of the
 * shared predicate.
 *
 * ⚠ N6 — BAL-558's bare-`platformRole` ban (`request-staff-capability-gated.test.ts`'s
 * `ROLE_READ_BAN`) is DELIBERATELY NOT COPIED VERBATIM here. That list bans the bare substring
 * `platformRole` outright, which would also flag every legitimate `Record<PlatformRole, …>` type
 * annotation and `person.role` rename in this surface — this ticket's UI leans on the type far
 * more than a Server Action ever does. This scan bans the NARROWER, still-dangerous shapes: an
 * equality/inequality comparison (either operand order), a `switch` `case`, a role-SET
 * constant/predicate name, an ad hoc `.includes('<role>')` membership read, or the same read
 * spelled as an INLINE array/Set literal (N3 — `['admin', 'super_admin'].includes(role)` /
 * `new Set([...]).has(role)`, never routed through a named constant a reviewer could audit once).
 *
 * ⚠ UNFILTERED WALK, same discipline as every sibling invariant in this directory
 * (`platform-capability-live-gate.test.ts`, `request-staff-capability-gated.test.ts`): every
 * non-test `.ts`/`.tsx` file under the surface is collected first, then scanned — there is no
 * allow-list to pre-narrow the collected set.
 *
 * F5 (R4) — the ban list is matched against WHITESPACE-NORMALISED code (runs of whitespace,
 * including newlines, collapsed to one space), so a Prettier-wrapped comparison that splits an
 * operator onto its own line can't slip past a naive contiguous-substring scan.
 */

const SURFACE_DIR = resolveRouteDir([
  'apps/web/src/app/(dashboard)/admin/staff-access',
  'src/app/(dashboard)/admin/staff-access',
]);

/** Collapse runs of whitespace (including newlines) to a single space. F5 (R4). */
function normalizeWhitespace(code: string): string {
  return code.replace(/\s+/g, ' ');
}

/**
 * Spellings that DECIDE something by comparing/switching on a role, by a role-SET constant, or by
 * an ad hoc membership read — in EITHER operand order (F5 adds the reversed-operand and
 * `.includes(...)` shapes).
 */
const ROLE_READ_BAN: readonly string[] = [
  'platformRole ===',
  'platformRole !==',
  "=== 'user'",
  "=== 'admin'",
  "=== 'super_admin'",
  "!== 'user'",
  "!== 'admin'",
  "!== 'super_admin'",
  "case 'admin'",
  "case 'super_admin'",
  "case 'user'",
  'isPlatformAdmin',
  'PLATFORM_ADMIN_ROLES',
  'PLATFORM_STAFF_ROLES',
  'PLATFORM_ROLE_CAPABILITIES',
  'platformRoleHasCapability',
  'platformRoleIsStaff',
  // F5 (R4) — reversed operand order
  "'admin' ===",
  "'super_admin' ===",
  "'user' ===",
  "'admin' !==",
  "'super_admin' !==",
  "'user' !==",
  // F5 (R4) — ad hoc set-membership read instead of the shared predicate
  ".includes('admin'",
  ".includes('super_admin'",
  ".includes('user'",
  // N3 — the realistic INLINE-ARRAY shape: `['admin', 'super_admin'].includes(role)` /
  // `new Set([...]).has(role)`, never spelled as a call on a pre-existing named constant.
  "'admin'].includes(",
  "'super_admin'].includes(",
  "'user'].includes(",
  "']).has(",
];

describe('invariant: no role read anywhere in the /admin/staff-access surface (BAL-561)', () => {
  const scanned = scanRouteSources(SURFACE_DIR, '', []);

  it('scans the whole surface (non-vacuity)', () => {
    expect(SURFACE_DIR).not.toBe('');
    expect(scanned.length).toBeGreaterThanOrEqual(15);
  });

  /**
   * F5 (R4) — positive anchor. Proves the extraction pipeline itself is alive: if `scanRouteSources`
   * / `codeLinesOf` ever regressed to returning blanks for this file, every "no banned spelling"
   * assertion below would pass VACUOUSLY. Pinning a real, known-present call makes that failure
   * mode visible instead of silent.
   */
  it('positive anchor: add-staff-dialog.tsx really was scanned (guards against blank extraction)', () => {
    const dialog = scanned.find((file) => file.rel.endsWith('_components/add-staff-dialog.tsx'));
    expect(dialog).toBeDefined();
    expect(dialog?.code).toContain('staffCustomListAllowed(');
  });

  it('no file in the surface names a banned role-read spelling', () => {
    const offenders: string[] = [];
    for (const file of scanned) {
      const normalized = normalizeWhitespace(file.code);
      for (const needle of ROLE_READ_BAN) {
        if (normalized.includes(needle)) {
          offenders.push(`${file.rel}: ${needle}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  /**
   * Both directions, realistically shaped — the same discipline
   * `request-staff-capability-gated.test.ts`'s B8 uses: a hand-written decoy per needle, not a
   * mechanically-wrapped copy of the needle itself (which would trivially "catch itself").
   */
  it('guards the guard: every decoy is caught by a ban needle, AND every needle catches a decoy', () => {
    const decoys: readonly string[] = [
      "if (person.platformRole === 'admin') { /* probe */ }",
      "if (viewer.platformRole !== 'super_admin') { /* probe */ }",
      "if (state.role === 'user') { /* probe */ }",
      "if (draft.role === 'admin') { /* probe */ }",
      "if (target.role === 'super_admin') { /* probe */ }",
      "if (state.role !== 'user') { /* probe */ }",
      "if (draft.role !== 'admin') { /* probe */ }",
      "if (target.role !== 'super_admin') { /* probe */ }",
      "switch (role) { case 'admin': return ADMIN_BUNDLE; }",
      "switch (role) { case 'super_admin': return ALL_CAPS; }",
      "switch (role) { case 'user': return []; }",
      'if (isPlatformAdmin(user)) { /* probe */ }',
      'PLATFORM_ADMIN_ROLES.has(user.platformRole)',
      'PLATFORM_STAFF_ROLES.includes(role)',
      'PLATFORM_ROLE_CAPABILITIES[role]',
      'if (platformRoleHasCapability(role, token)) { /* probe */ }',
      'if (platformRoleIsStaff(role)) { /* probe */ }',
      // F5 (R4) — reversed operand
      "if ('admin' === person.platformRole) { /* probe */ }",
      "if ('super_admin' === viewer.platformRole) { /* probe */ }",
      "if ('user' === state.role) { /* probe */ }",
      "if ('admin' !== draft.role) { /* probe */ }",
      "if ('super_admin' !== target.role) { /* probe */ }",
      "if ('user' !== state.role) { /* probe */ }",
      // F5 (R4) — set-membership read
      "if (STAFF_ROLES.includes('admin')) { /* probe */ }",
      "if (STAFF_ROLES.includes('super_admin')) { /* probe */ }",
      "if (STAFF_ROLES.includes('user')) { /* probe */ }",
      // N3 — the same read as an inline array/Set literal, never a named constant
      "if (['user', 'admin'].includes('admin')) { /* probe */ }",
      "if (['admin', 'super_admin'].includes('super_admin')) { /* probe */ }",
      "if (['super_admin', 'user'].includes('user')) { /* probe */ }",
      "if (new Set(['admin', 'super_admin']).has(role)) { /* probe */ }",
    ];
    expect(decoys).toHaveLength(ROLE_READ_BAN.length);

    for (const decoy of decoys) {
      const hit = ROLE_READ_BAN.some((needle) => decoy.includes(needle));
      expect(hit, `decoy "${decoy}" must be caught by at least one ban needle`).toBe(true);
    }
    for (const needle of ROLE_READ_BAN) {
      const hit = decoys.some((decoy) => decoy.includes(needle));
      expect(hit, `ban needle "${needle}" must catch at least one decoy`).toBe(true);
    }
  });

  /**
   * F5 (R4) — a comparison Prettier has wrapped across lines (operator on its own line) is NOT a
   * contiguous substring match against the raw text, but IS caught once whitespace is normalised.
   * This is what justifies `normalizeWhitespace` above rather than a plain `.includes`.
   */
  it('a line-wrapped comparison is missed by a raw scan but caught after whitespace normalization', () => {
    const wrapped = "if (\n  person.platformRole\n    ===\n    'admin'\n) {\n  /* probe */\n}";
    const rawHit = ROLE_READ_BAN.some((needle) => wrapped.includes(needle));
    expect(rawHit).toBe(false);

    const normalizedHit = ROLE_READ_BAN.some((needle) =>
      normalizeWhitespace(wrapped).includes(needle)
    );
    expect(normalizedHit).toBe(true);
  });

  it('a role literal used as DATA (copy, fixtures, Record lookups) is never flagged', () => {
    const decoyData = [
      "const person = { role: 'super_admin', customList: null };",
      "const ROLE_ORDER = ['user', 'admin', 'super_admin'] as const;",
      'STAFF_ACCESS_ROLE_COPY[role].title',
      'PLATFORM_ROLE_LABELS[role]',
      'staffCustomListAllowed(roleAfter)',
    ].join('\n');
    const normalized = normalizeWhitespace(decoyData);
    for (const needle of ROLE_READ_BAN) {
      expect(normalized, `data literal must not be flagged by "${needle}"`).not.toContain(needle);
    }
  });

  /**
   * F5 (R4) mutation proof (manual, not automated here): with the code extraction forced to return
   * `''` for every file, the positive anchor test above goes red (`dialog?.code` is `''`, which
   * does not contain `staffCustomListAllowed(`), proving the anchor is load-bearing rather than
   * vacuously true. See the BAL-561 fix-round report for the observed before/after.
   */
});
