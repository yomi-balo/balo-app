import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  codeLinesOf,
  namedImportsFrom,
  occurrences,
  resolveRouteDir,
  scanWorkspaceSources,
} from './_source-scan';

/**
 * BAL-558 — structural invariant: **THE SEVEN `projects/[requestId]/_actions` FILES MIGRATED OFF
 * `requireAdmin()` NEVER READ A PLATFORM ROLE OR ROLE SET, AND EACH ONE'S GATE IS PINNED
 * POSITIVELY.**
 *
 * ⚠⚠ DECISION: READ EXACTLY THE PINNED FILES BY PATH, NO WALK. Two alternatives were considered
 * and rejected:
 *   1. Extending `request-close-capability-gated.test.ts` or `balo-panel-capability-gated.test.ts`
 *      — both FILTER a walk through a hardcoded allow-list and then assert `PINNED_FILES` against
 *      it, which is the BAL-404 (#303) vacuity trap: the collected set can never contain an
 *      unexpected file, because the filter already excluded it. Extending them inherits the trap;
 *      fixing it is out of scope for this ticket. Their `VIEW_GATE_TOKENS` also differ in purpose
 *      from the ROLE-READ ban this file needs.
 *   2. Scanning the whole `projects/[requestId]/_actions/` directory unfiltered with BAL-404's
 *      narrow ban-token list — measured, it trips a legitimate file
 *      (`create-conversation-realtime-token.ts` reads `archetype !==`, unrelated to a platform
 *      role). It would also force a 50+-entry `PINNED_FILES` that every future ticket in the
 *      busiest directory in the repo must edit. The ticket's own AC is scoped to "the migrated
 *      files", not the whole directory.
 *
 * ⚠ WHY READ-BY-PATH IS NOT VACUOUS DESPITE HAVING NO WALK: there is no COLLECTED SET for an
 * allow-list to pre-narrow — the pin IS the read list. Each entry asserts the file EXISTS, is
 * NON-EMPTY, and carries an ANCHOR string present both before and after this ticket (so the read
 * is proven genuine, not a `/dev/null` fallback silently passing). The claim this file makes is
 * honestly scoped to exactly these eight files, never more.
 *
 * ⚠ THE ACCEPTED GAP: a NEW admin action added to this directory tomorrow is not covered here —
 * it would need its own entry. It IS caught by two other nets: `platform-capability-live-gate
 * .test.ts` if it names `hasPlatformCapability(` directly, and B7 below if it resurrects
 * `requireAdmin(`.
 *
 * ⚠ `'admin'` AS A DATA LITERAL (e.g. `initiatedBy: 'admin'`) IS NOT A ROLE READ and is
 * deliberately NOT banned — `ROLE_READ_BAN` bans spellings that READ a platform role or role SET,
 * not the string `'admin'` used as a domain tag.
 */

const ACTIONS_DIR = resolveRouteDir([
  'apps/web/src/app/(dashboard)/projects/[requestId]/_actions',
  'src/app/(dashboard)/projects/[requestId]/_actions',
]);

interface PinnedFile {
  readonly rel: string;
  readonly anchor: string;
  readonly gate: 'helper' | 'session-only' | 'definition';
  readonly token?: string;
}

const PINNED: readonly PinnedFile[] = [
  {
    rel: 'invite-experts.ts',
    anchor: 'export async function inviteExpertsAction(',
    gate: 'helper',
    token: 'MANAGE_ANY_REQUEST_SOURCING',
  },
  {
    rel: 'search-experts-for-invite.ts',
    anchor: 'export async function searchExpertsForInviteAction(',
    gate: 'session-only',
    token: 'MANAGE_ANY_REQUEST_SOURCING',
  },
  {
    rel: 'remove-invited-expert.ts',
    anchor: 'export async function removeInvitedExpertAction(',
    gate: 'helper',
    token: 'MANAGE_ANY_REQUEST_SOURCING',
  },
  {
    rel: 'request-exploratory-meeting.ts',
    anchor: 'export async function requestExploratoryMeetingAction(',
    gate: 'helper',
    token: 'MANAGE_ANY_REQUEST_SOURCING',
  },
  {
    rel: 'request-proposal-as-admin.ts',
    anchor: 'export async function requestProposalAsAdmin(',
    gate: 'helper',
    token: 'MANAGE_ANY_REQUEST_SOURCING',
  },
  {
    rel: 'approve-kickoff.ts',
    anchor: 'export async function approveKickoffAction(',
    gate: 'helper',
    token: 'MANAGE_ANY_KICKOFF_GATE',
  },
  {
    rel: 'remind-client-billing.ts',
    anchor: 'export async function remindClientBilling(',
    gate: 'helper',
    token: 'MANAGE_ANY_KICKOFF_GATE',
  },
  {
    rel: '_shared/require-request-staff-capability.ts',
    anchor: 'export async function requireRequestStaffCapability(',
    gate: 'definition',
  },
];

/** Spellings that read a platform ROLE or ROLE SET — banned across every pinned file. */
const ROLE_READ_BAN: readonly string[] = [
  'requireAdmin(',
  'lib/auth/require-admin',
  'isPlatformAdmin',
  'isPlatformAdminRole',
  'PLATFORM_ADMIN_ROLES',
  'PLATFORM_STAFF_ROLES',
  'ADMIN_ROLES',
  'platformRole',
  'super_admin',
  'platformRoleIsStaff',
  'platformRoleHasCapability',
  'lib/auth/is-admin',
];

interface ReadFile {
  readonly rel: string;
  readonly raw: string;
  readonly code: string;
  /** Every line trimmed and concatenated with no separator — defeats Prettier line-wrapping. */
  readonly flat: string;
}

/**
 * ⚠ FIX ROUND 1, REV-L3 — `codeLinesOf` (shared with every sibling invariant), not a file-local
 * re-implementation. The local version only stripped a line that STARTED with `//`, `*` or `/*`,
 * which mishandles a block comment that does not put `*` at the start of every continuation
 * line. `codeLinesOf` is the same comment-stripper every other invariant in this directory
 * relies on, so this file's B2/B7 role-read scan gets the same, already-proven handling.
 */
function readPinned(rel: string): ReadFile {
  const fullPath = join(ACTIONS_DIR === '' ? '/dev/null' : ACTIONS_DIR, rel);
  const raw = existsSync(fullPath) ? readFileSync(fullPath, 'utf8') : '';
  const code = codeLinesOf(raw);
  const flat = code
    .split('\n')
    .map((line) => line.trim())
    .join('');
  return { rel, raw, code, flat };
}

const FILES: readonly ReadFile[] = PINNED.map((entry) => readPinned(entry.rel));

describe('invariant: the migrated request-staff actions never read a platform role, and each gate is pinned (BAL-558)', () => {
  it('B1: every pinned file exists, is non-empty, and carries its anchor', () => {
    expect(ACTIONS_DIR).not.toBe('');
    expect(PINNED).toHaveLength(8);
    for (const [index, entry] of PINNED.entries()) {
      const file = FILES[index];
      expect(file, `${entry.rel} must be read`).toBeDefined();
      if (file === undefined) continue;
      expect(existsSync(join(ACTIONS_DIR, entry.rel)), `${entry.rel} must exist`).toBe(true);
      expect(file.raw.length, `${entry.rel} must be non-empty`).toBeGreaterThan(0);
      expect(file.code, `${entry.rel} must contain its anchor`).toContain(entry.anchor);
    }
  });

  it('B2: no pinned file reads a platform role or role set', () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      for (const token of ROLE_READ_BAN) {
        if (file.code.includes(token)) {
          offenders.push(`${file.rel}: ${token}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('B3: each helper-gated action calls the helper ONCE with ITS token, and never the other', () => {
    const helperGated = PINNED.filter((entry) => entry.gate === 'helper');
    expect(helperGated).toHaveLength(6);
    for (const entry of helperGated) {
      const file = FILES[PINNED.indexOf(entry)];
      if (file === undefined || entry.token === undefined) continue;
      const otherToken =
        entry.token === 'MANAGE_ANY_REQUEST_SOURCING'
          ? 'MANAGE_ANY_KICKOFF_GATE'
          : 'MANAGE_ANY_REQUEST_SOURCING';
      const rightCallCount = occurrences(
        file.flat,
        `requireRequestStaffCapability(PLATFORM_CAPABILITIES.${entry.token})`
      );
      expect(
        rightCallCount,
        `${entry.rel} must call the helper with ${entry.token} exactly once`
      ).toBe(1);
      const totalCallCount = occurrences(file.flat, 'requireRequestStaffCapability(');
      expect(totalCallCount, `${entry.rel} must call the helper exactly once`).toBe(1);
      expect(file.flat, `${entry.rel} must not name the OTHER token`).not.toContain(otherToken);
      expect(
        namedImportsFrom(file.code, './_shared/require-request-staff-capability'),
        `${entry.rel} must import requireRequestStaffCapability by name`
      ).toContain('requireRequestStaffCapability');
    }
  });

  it('B4: the gate precedes the parse (and precedes any repository read)', () => {
    for (const entry of PINNED) {
      if (entry.gate === 'definition') continue;
      const file = FILES[PINNED.indexOf(entry)];
      if (file === undefined) continue;
      const anchorFlat = flatten(entry.anchor);
      const anchorIndex = file.flat.indexOf(anchorFlat);
      expect(anchorIndex, `${entry.rel}: anchor must be found in the flattened source`).not.toBe(
        -1
      );
      const body = file.flat.slice(anchorIndex);

      const gateNeedle =
        entry.gate === 'helper'
          ? `requireRequestStaffCapability(PLATFORM_CAPABILITIES.${entry.token})`
          : 'hasPlatformCapability(user, PLATFORM_CAPABILITIES.MANAGE_ANY_REQUEST_SOURCING)';
      const gateIndex = body.indexOf(gateNeedle);
      const parseIndex = body.indexOf('.safeParse(');
      expect(gateIndex, `${entry.rel}: gate needle "${gateNeedle}" must be present`).not.toBe(-1);
      expect(parseIndex, `${entry.rel}: .safeParse( must be present`).not.toBe(-1);
      expect(gateIndex, `${entry.rel}: the gate must precede the parse`).toBeLessThan(parseIndex);

      const repoIndex = body.indexOf('Repository.');
      if (repoIndex !== -1) {
        expect(
          gateIndex,
          `${entry.rel}: the gate must precede the first repository read`
        ).toBeLessThan(repoIndex);
      }
    }
  });

  it('B5: search-experts-for-invite is session-gated and names getCurrentUser, never the live gate or the helper', () => {
    const file = FILES[PINNED.findIndex((entry) => entry.rel === 'search-experts-for-invite.ts')];
    expect(file).toBeDefined();
    if (file === undefined) return;
    expect(occurrences(file.flat, 'getCurrentUser(')).toBe(1);
    expect(
      occurrences(
        file.flat,
        'hasPlatformCapability(user, PLATFORM_CAPABILITIES.MANAGE_ANY_REQUEST_SOURCING)'
      )
    ).toBe(1);
    expect(file.flat).not.toContain('actorHoldsPlatformCapability(');
    expect(file.flat).not.toContain('requireRequestStaffCapability(');
  });

  it('B6: the helper resolves session → capability → LIVE row, in that order, and never requireOnboardedUser', () => {
    const file = FILES[PINNED.findIndex((entry) => entry.gate === 'definition')];
    expect(file).toBeDefined();
    if (file === undefined) return;
    const getCurrentUserIndex = file.flat.indexOf('getCurrentUser(');
    const hasCapabilityIndex = file.flat.indexOf('hasPlatformCapability(');
    const liveGateIndex = file.flat.indexOf('actorHoldsPlatformCapability(');
    expect(getCurrentUserIndex).not.toBe(-1);
    expect(hasCapabilityIndex).not.toBe(-1);
    expect(liveGateIndex).not.toBe(-1);
    expect(getCurrentUserIndex).toBeLessThan(hasCapabilityIndex);
    expect(hasCapabilityIndex).toBeLessThan(liveGateIndex);
    expect(file.flat).not.toContain('requireOnboardedUser(');
  });

  it('B7: requireAdmin is gone from the whole web tree, and stays gone', () => {
    const scanned = scanWorkspaceSources().filter((f) => f.rel.startsWith('apps/web/src/'));
    expect(scanned.length).toBeGreaterThan(1000);
    const offenders = scanned
      .filter((f) => f.code.includes('requireAdmin(') || f.code.includes('lib/auth/require-admin'))
      .map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  /**
   * ⚠⚠ FIX ROUND 1, REV-L3 — BOTH DIRECTIONS, NOT ONE. The title used to claim "every
   * ROLE_READ_BAN token is caught by at least one decoy", but the body only ever checked the
   * REVERSE (every decoy caught by ≥1 token) — a decoy set that happened to exercise only some
   * ban tokens would still pass. `decoys` below now has a realistic-shaped entry for every one
   * of the 12 `ROLE_READ_BAN` tokens, and both directions are asserted with a length pin so an
   * emptied list on either side cannot pass vacuously.
   */
  it('B8: guards the guard — every decoy is caught by a ban token, AND every ban token catches a decoy', () => {
    const decoys: readonly string[] = [
      "if (user.platformRole === 'admin') { /* probe */ }",
      'ADMIN_ROLES.has(user.platformRole)',
      'await requireAdmin()',
      'isPlatformAdmin(user)',
      "['admin','super_admin'].includes(r)",
      'PLATFORM_STAFF_ROLES.includes(x)',
      "import { requireAdmin } from '@/lib/auth/require-admin';",
      'if (platformRoleIsStaff(user.platformRole)) { /* probe */ }',
      "import { isPlatformAdminRole } from '@balo/shared/parties';",
      'if (PLATFORM_ADMIN_ROLES.has(user.platformRole)) { /* probe */ }',
      'if (platformRoleHasCapability(user.platformRole, T)) { /* probe */ }',
      "import { isPlatformAdmin } from '@/lib/auth/is-admin';",
    ];
    expect(decoys).toHaveLength(12);
    expect(ROLE_READ_BAN).toHaveLength(12);

    for (const decoy of decoys) {
      const hit = ROLE_READ_BAN.some((token) => decoy.includes(token));
      expect(hit, `decoy "${decoy}" must be caught by at least one ROLE_READ_BAN token`).toBe(true);
    }
    for (const token of ROLE_READ_BAN) {
      const hit = decoys.some((decoy) => decoy.includes(token));
      expect(hit, `ban token "${token}" must catch at least one decoy`).toBe(true);
    }
  });
});

/** Same flatten rule as `readPinned`, applied to a short literal (the anchor) for comparison. */
function flatten(text: string): string {
  return text
    .split('\n')
    .map((line) => line.trim())
    .join('');
}
