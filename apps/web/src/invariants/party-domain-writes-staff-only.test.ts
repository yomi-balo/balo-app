import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { codeLinesOf, memberNamesOf, resolveRouteDir, scanRouteSources } from './_source-scan';

/**
 * BAL-594 — structural invariant: `party_domains` has NO party-side write path. Balo staff are
 * the only writers (besides signup auto-capture, which is not a web action).
 *
 *  (a) the three party-side modules that used to write — the add and remove Server Actions and
 *      the add-domain form — no longer exist;
 *  (b) the staff repository's WRITE members (`addDomain` / `removeDomain` / `reassignDomain`)
 *      are referenced only from `admin/domains/_actions/`. The staff page reads the same
 *      repository (`getPartyForStaff` / `listForStaff`), so the scan is scoped to the writes;
 *  (c) the customer repository (`party-domains.ts`) exposes no `addDomain` / `removeDomain`;
 *  (d) no web source file calls `partyDomainsRepository.capture`.
 *
 * Source-text scans, no regex (`_source-scan.ts`). The non-vacuity tests pin that the scan saw
 * the tree and found the staff actions directory.
 */

const SRC_DIR = resolveRouteDir(['src', 'apps/web/src']);
const STAFF_ACTIONS_PREFIX = 'app/(dashboard)/admin/domains/_actions/';
const STAFF_WRITE_MEMBERS: ReadonlySet<string> = new Set([
  'addDomain',
  'removeDomain',
  'reassignDomain',
]);

const DELETED_PARTY_SIDE_FILES: readonly string[] = [
  'app/(dashboard)/settings/team/_actions/add-domain.ts',
  'app/(dashboard)/settings/team/_actions/remove-domain.ts',
  'components/balo/domain-join/add-domain-form.tsx',
];

const CUSTOMER_REPOSITORY = path.resolve(
  SRC_DIR,
  '../../../packages/db/src/repositories/party-domains.ts'
);

const all = scanRouteSources(SRC_DIR, '', ['node_modules', '.next']);

describe('invariant: party_domains has no party-side write path (BAL-594)', () => {
  it('scans the full source tree and finds the staff actions directory (guards against a vacuous pass)', () => {
    expect(SRC_DIR).not.toBe('');
    expect(all.length).toBeGreaterThan(1000);
    expect(all.some((file) => file.rel.startsWith(STAFF_ACTIONS_PREFIX))).toBe(true);
  });

  it.each(DELETED_PARTY_SIDE_FILES)('(a) %s no longer exists', (rel) => {
    expect(existsSync(path.join(SRC_DIR, rel))).toBe(false);
    expect(all.some((file) => file.rel === rel)).toBe(false);
  });

  it('(b) only admin/domains/_actions/ references a staff-repository write member', () => {
    const offenders = all
      .filter((file) => !file.rel.startsWith(STAFF_ACTIONS_PREFIX))
      .filter((file) =>
        memberNamesOf(file.code, 'partyDomainsStaffRepository').some((member) =>
          STAFF_WRITE_MEMBERS.has(member)
        )
      )
      .map((file) => file.rel);
    expect(
      offenders,
      `These files call a partyDomainsStaffRepository write outside the staff actions:\n  ${offenders.join('\n  ')}`
    ).toEqual([]);
  });

  it('(b) the write-member matcher recognises a real call (guards the guard)', () => {
    const sample = codeLinesOf(
      'const r = await partyDomainsStaffRepository.reassignDomain({});\n// partyDomainsStaffRepository.addDomain(\n'
    );
    expect(memberNamesOf(sample, 'partyDomainsStaffRepository')).toEqual(['reassignDomain']);
  });

  it('(d) no web source file calls partyDomainsRepository.capture (signup capture lives in @balo/db)', () => {
    const offenders = all
      .filter((file) => memberNamesOf(file.code, 'partyDomainsRepository').includes('capture'))
      .map((file) => file.rel);
    expect(
      offenders,
      `These files call partyDomainsRepository.capture from apps/web:\n  ${offenders.join('\n  ')}`
    ).toEqual([]);
  });

  it('(c) the customer party-domains repository exposes no addDomain or removeDomain', () => {
    expect(existsSync(CUSTOMER_REPOSITORY)).toBe(true);
    const code = codeLinesOf(readFileSync(CUSTOMER_REPOSITORY, 'utf8'));
    expect(code).toContain('listForPartySettings');
    expect(code).not.toContain('addDomain:');
    expect(code).not.toContain('removeDomain:');
  });
});
