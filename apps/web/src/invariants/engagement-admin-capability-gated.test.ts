import { describe, expect, it } from 'vitest';
import {
  resolveRouteDir,
  scanRouteSources,
  namedImportsFrom,
  type ScannedFile,
} from './_source-scan';

/**
 * BAL-404 / ADR-1035 — structural invariant: the engagement domain's ADMIN write-gates resolve
 * a PLATFORM CAPABILITY, never the admin LENS and never a platform-role set.
 *
 * ⚠ A NARROWER TOKEN LIST THAN THE ONLY IN-REPO PRECEDENT, AND HERE IS WHY.
 * `request-close-capability-gated.test.ts` bans BOTH directions of EVERY view-shaped name
 * (`lens`, `role`, `platformRole`, `activeMode`, `archetype`). This scan bans only the ADMIN
 * shapes. That is a deliberate, bounded deviation, not an oversight:
 *
 *   BAL-404 migrates ONE AXIS — the ADR-1035 platform axis. The same files still carry
 *   membership-axis (`lens === 'client'`, ADR-1029) and engagement-axis (`lens !== 'expert'`,
 *   ADR-1046) gates, which are correct where they are and belong to BAL-316. The full
 *   precedent list would fail on all of them, forcing BAL-316's migration into this PR — a
 *   scope explosion, and one that would push an unrelated axis through under a tech-debt
 *   ticket. The honest move is to scan narrowly and SAY SO.
 *
 * ⚠ THE FILE SET IS THE WHOLE `_actions` DIRECTORY, UNFILTERED — NOT AN ALLOW-LIST (fix round
 * F2). The first version ran `scanRouteSources` through a `MIGRATED_ACTION_FILES` allow-list
 * BEFORE the `PINNED_FILES` set-equality assertion, so a brand-new `_actions` module containing
 * `platformRole === 'admin'` or `lens === 'admin'` was filtered out before the scan ever saw
 * it — the claim that `PINNED_FILES` is asserted set-equal to "the walk" was false, because the
 * walk itself had already been narrowed. Two independent reviewers proved this by dropping such
 * a file into `_actions/` and watching the suite stay green (5/5). Scanning the whole directory
 * keeps this fix inside BAL-404's scope: the token list stays the NARROW admin-only set below
 * (never the full `VIEW_GATE_TOKENS`), so the client/expert membership-axis gates already
 * living elsewhere in this directory (`lens !== 'expert'` / `lens !== 'client'` shapes, BAL-316
 * territory) do not trip it — only an ADMIN-shaped token does. A new `_actions` module now
 * fails LOUDLY on two independent axes until someone pins it: the `PINNED_FILES` set-equality
 * assertion, and — because it is now actually scanned — the token ban itself.
 *
 * ⚠ WHAT THIS DOES **NOT** COVER, EXPLICITLY:
 *   - `lens === 'client'` / `lens !== 'expert'` in the scanned files — membership/engagement
 *     axis, ADR-1029/ADR-1046, BAL-316. Still allowed here.
 *   - The cases sub-domain (`(dashboard)/cases/_actions`, `_lib`) — seven party-axis gates,
 *     also BAL-316. Unscanned.
 *   - `engagements/[id]` (page + `_components`) and any file outside `_actions` /
 *     `engagements/page.tsx` — presentation, out of scope. An unpinned module anywhere else is
 *     a silently UNSCANNED module, which is why `PINNED_FILES` exists and is asserted set-equal
 *     to what the walk actually collected.
 *
 * NOT scanned, on purpose (the CATEGORY ERROR, per `request-close-capability-gated.test.ts`):
 *   - `lib/engagement/resolve-engagement-lens.ts` — the RESOLVER. It legitimately reads
 *     `platformRole` to PRODUCE the lens, and `lib/authz/platform.ts:17-19` sanctions exactly
 *     that ("the observer-LENS view gate … stays on set membership — a separate boundary").
 *   - `lib/engagement/engagement-view.ts` and `lib/engagement/engagement-parties.ts` — pure
 *     presentation over an already-authorized projection. `deriveActorLabel` was MOVED into
 *     `engagement-parties.ts` by this ticket precisely so the scanned action module could
 *     satisfy the ban instead of being exempted from it: AVOIDANCE, never a per-file token
 *     allow-list. No exemption mechanism exists in this directory and none is being invented.
 *
 * If this test fails: you reintroduced an admin-lens or role-set authorization decision into a
 * migrated engagement gate — OR you added a new `_actions` module that isn't in `PINNED_FILES`
 * yet. Resolve `CANCEL_ANY_ENGAGEMENT` / `MANAGE_ANY_ENGAGEMENT_ACTION_ITEM` /
 * `VIEW_PLATFORM_ADMIN` through `hasPlatformCapability` instead — and if the offender is
 * presentation copy, MOVE IT to `lib/engagement/`.
 */

const ACTIONS_DIR = resolveRouteDir([
  'src/app/(dashboard)/engagements/[id]/_actions',
  'apps/web/src/app/(dashboard)/engagements/[id]/_actions',
]);
const ENGAGEMENTS_DIR = resolveRouteDir([
  'src/app/(dashboard)/engagements',
  'apps/web/src/app/(dashboard)/engagements',
]);

function scanTree(): ScannedFile[] {
  return [
    // UNFILTERED — every module `_actions` contains, not a three-file allow-list. A module
    // dropped in here without joining PINNED_FILES below now fails the set-equality assertion
    // loudly, and — since it is genuinely scanned — the token ban too (fix round F2).
    ...scanRouteSources(ACTIONS_DIR, 'actions', []),
    // `_components` and `[id]` are excluded so this stays a scan of the ONE migrated page,
    // not of the whole engagements route tree (which is presentation, and out of scope).
    ...scanRouteSources(ENGAGEMENTS_DIR, 'engagements', ['_components', '[id]']).filter(
      (file) => file.rel === 'engagements/page.tsx'
    ),
  ];
}

/**
 * Every module `_actions` contains today, plus the one migrated `engagements` page — asserted
 * set-equal to `scannedPaths` below (fix round F2). Spelled out explicitly, rather than derived
 * from a directory listing at test time, so a module silently disappearing from the scan (a
 * rename, a move, a future `.filter` that narrows the walk again) fails LOUDLY instead of
 * vanishing.
 */
const PINNED_FILES: readonly string[] = [
  'actions/accept-project.ts',
  'actions/action-item-action-shared.ts',
  'actions/add-milestone.ts',
  'actions/assign-action-item.ts',
  'actions/cancel-engagement.ts',
  'actions/complete-milestone.ts',
  'actions/create-action-item.ts',
  'actions/engagement-lifecycle-shared.ts',
  'actions/milestone-action-shared.ts',
  'actions/remove-action-item.ts',
  'actions/remove-milestone.ts',
  'actions/reorder-milestones.ts',
  'actions/request-changes.ts',
  'actions/request-completion.ts',
  'actions/revert-milestone.ts',
  'actions/set-action-item-status.ts',
  'actions/start-milestone.ts',
  'actions/submit-engagement-review.ts',
  'actions/update-action-item.ts',
  'actions/update-milestone.ts',
  'actions/withdraw-completion-request.ts',
  'engagements/page.tsx',
];

/**
 * ⚠ BOTH DIRECTIONS, EVERY QUOTE STYLE, AND THE EVASION SHAPES. A `lens !== 'admin'` gate is
 * the same gate; so is `lens === "admin"` (fix round F3 — the original list embedded only the
 * single-quoted literal with exact spacing, so a double-quoted form escaped it — both quoted
 * forms are kept, since either is valid TypeScript), a backtick literal,
 * `archetype === 'observer'` (the lens's other name), a role-set helper (`isPlatformAdmin(...)`,
 * the widening `middleware-admin-capability-gated.test.ts` learned in its own fix round F5), and
 * `requireAdmin()` (fix round F1 — it IS a platform-role-set gate, `lib/auth/require-admin.ts:22`
 * → `isPlatformAdmin`, and it leaves no other banned substring in the calling file; the sibling
 * `projects/[requestId]/_actions` has SEVEN `requireAdmin()` call sites, making copy-paste into
 * this directory the most likely reintroduction vector).
 */
const ADMIN_GATE_TOKENS: readonly string[] = [
  "lens === 'admin'",
  "lens !== 'admin'",
  'lens === "admin"',
  'lens !== "admin"',
  'lens === `admin`',
  'lens !== `admin`',
  'archetype ===',
  'archetype !==',
  'platformRole ===',
  'platformRole !==',
  'isPlatformAdmin',
  'isPlatformAdminRole',
  'PLATFORM_ADMIN_ROLES',
  'requireAdmin(',
];

/** A token present BEFORE and AFTER the migration — proves the file was genuinely read. */
const NON_VACUITY_ANCHORS: ReadonlyMap<string, string> = new Map([
  ['actions/engagement-lifecycle-shared.ts', 'gateAdminEngagement'],
  ['actions/action-item-action-shared.ts', 'gateEngagementParticipant'],
  ['actions/cancel-engagement.ts', 'cancelEngagementAction'],
  ['engagements/page.tsx', 'loadEngagementsOversight'],
]);

/** file → the token its gate must resolve. */
const REQUIRED_CAPABILITY: ReadonlyMap<string, string> = new Map([
  ['actions/engagement-lifecycle-shared.ts', 'CANCEL_ANY_ENGAGEMENT'],
  ['actions/action-item-action-shared.ts', 'MANAGE_ANY_ENGAGEMENT_ACTION_ITEM'],
  ['engagements/page.tsx', 'VIEW_PLATFORM_ADMIN'],
]);

describe('invariant: BAL-404 engagement admin write-gates resolve a PLATFORM CAPABILITY (ADR-1035)', () => {
  const scanned = scanTree();
  const scannedPaths = scanned.map((file) => file.rel);

  it('collects the trees (guards against a vacuous pass)', () => {
    expect(ACTIONS_DIR).not.toBe('');
    expect(ENGAGEMENTS_DIR).not.toBe('');
    for (const pinned of PINNED_FILES) {
      expect(scannedPaths).toContain(pinned);
    }
    expect([...scannedPaths].sort()).toEqual([...PINNED_FILES].sort());
  });

  it('guards the guard: each scanned file was genuinely read', () => {
    for (const [rel, anchor] of NON_VACUITY_ANCHORS) {
      const file = scanned.find((f) => f.rel === rel);
      expect(file, `${rel} must be in the scan set`).toBeDefined();
      expect(file?.code).toContain(anchor);
    }
  });

  it('none of the scanned files makes an ADMIN-lens or role-set authorization decision', () => {
    const offenders: string[] = [];
    for (const file of scanned) {
      for (const token of ADMIN_GATE_TOKENS) {
        if (file.code.includes(token)) offenders.push(`${file.rel} → ${token}`);
      }
    }
    expect(
      offenders,
      `These BAL-404 engagement sources reference an ADMIN-lens or role-set authorization ` +
        `token. Every Balo-staff gate must resolve hasPlatformCapability instead:\n  ` +
        offenders.join('\n  ')
    ).toEqual([]);
  });

  it('each migrated gate resolves its platform capability by name', () => {
    for (const [rel, token] of REQUIRED_CAPABILITY) {
      const file = scanned.find((f) => f.rel === rel);
      expect(file, `${rel} must be in the scan set`).toBeDefined();
      if (file === undefined) continue;
      expect(file.code).toContain('hasPlatformCapability(');
      expect(file.code).toContain(token);
      expect(namedImportsFrom(file.code, '@/lib/authz/platform')).toEqual(
        expect.arrayContaining(['hasPlatformCapability', 'PLATFORM_CAPABILITIES'])
      );
    }

    // `cancel-engagement.ts` is in PINNED_FILES but NOT in REQUIRED_CAPABILITY — it delegates
    // to `gateAdminEngagement` rather than resolving the token itself. Assert the delegation
    // instead, so a future inlined gate cannot escape this scan.
    const cancelEngagement = scanned.find((f) => f.rel === 'actions/cancel-engagement.ts');
    expect(cancelEngagement, 'actions/cancel-engagement.ts must be in the scan set').toBeDefined();
    expect(cancelEngagement?.code).toContain('gateAdminEngagement(');
  });

  it('⚠ guards the guard: every banned shape WOULD be caught', () => {
    const decoys: readonly ScannedFile[] = [
      {
        rel: 'actions/engagement-lifecycle-shared.ts',
        code: "if (ctx.lens === 'admin') {",
        raw: '',
      },
      {
        rel: 'actions/action-item-action-shared.ts',
        code: "if (loaded.lens !== 'admin') {",
        raw: '',
      },
      {
        rel: 'actions/action-item-action-shared.ts',
        code: 'if (loaded.lens === "admin") {',
        raw: '',
      },
      { rel: 'engagements/page.tsx', code: 'if (ctx.lens === `admin`) {', raw: '' },
      {
        rel: 'actions/engagement-lifecycle-shared.ts',
        code: "if (ctx.archetype === 'observer') {",
        raw: '',
      },
      {
        rel: 'actions/action-item-action-shared.ts',
        code: "if (user.platformRole === 'admin') {",
        raw: '',
      },
      { rel: 'engagements/page.tsx', code: '!isPlatformAdmin(user)', raw: '' },
      {
        rel: 'actions/cancel-engagement.ts',
        code: 'const admin = await requireAdmin();',
        raw: '',
      },
    ];
    for (const decoy of decoys) {
      const offenders = ADMIN_GATE_TOKENS.filter((token) => decoy.code.includes(token));
      expect(offenders.length, `decoy not caught: ${decoy.code}`).toBeGreaterThan(0);
    }
  });
});
