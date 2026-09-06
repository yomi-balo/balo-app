import { describe, expect, it } from 'vitest';
import { resolveRouteDir, scanRouteSources, type ScannedFile } from './_source-scan';

/**
 * BAL-541 / ADR-1029 — structural invariant: the "Balo" owner + staff-internal-notes surface
 * authorizes ONLY on the PLATFORM capability axis (`hasPlatformCapability`), never on a
 * VIEW-shaped token (`lens`, `role`, `platformRole`, `activeMode`, `archetype`) and never on
 * `requireAdmin()`. Modelled on `request-close-capability-gated.test.ts` — same scan shape, same
 * `VIEW_GATE_TOKENS` list, same "guards the guard" decoy test.
 *
 * ⚠ ADAPTED GATE ASSERTION — DELIBERATELY NOT BAL-540's "exactly one capability call" rule.
 * `delete-internal-note.ts` legitimately calls `hasPlatformCapability` TWICE: once for the base
 * `MANAGE_INTERNAL_NOTES` gate, once to resolve the `allowAnyAuthor` boolean from
 * `DELETE_ANY_INTERNAL_NOTE` before handing it to the repository. Copying BAL-540's exact-one
 * assertion here would fail correct code, so this file asserts ≥1 `hasPlatformCapability(` call,
 * zero `hasCapability(` (the MEMBERSHIP axis has no business gating Balo's own staffing of a
 * request or its internal notebook), and zero `requireAdmin(`.
 *
 * Also structural: no scanned file may reference `'super_admin'` literally (D2's ban) — the
 * `DELETE_ANY_INTERNAL_NOTE` token exists SPECIFICALLY so `platformRole === 'super_admin'` never
 * needs to appear in feature code.
 *
 * Scan set (§13.4): the three Server Actions, their shared post-commit fan-out, and the panel's
 * server loader. NOT `balo-panel.tsx` (a `'use client'` component with no authorization logic of
 * its own — it only renders what the server already gated) and NOT `resolve-request-lens.ts` (the
 * RESOLVER, which legitimately reads the platform capability to PRODUCE `canSeeBaloPanel` —
 * scanning it would be the category error `request-file-no-lens-gate`'s docblock warns against).
 */

const ACTIONS_DIR = resolveRouteDir([
  'src/app/(dashboard)/projects/[requestId]/_actions',
  'apps/web/src/app/(dashboard)/projects/[requestId]/_actions',
]);
const PROJECT_REQUEST_LIB_DIR = resolveRouteDir([
  'src/lib/project-request',
  'apps/web/src/lib/project-request',
]);

/** The three Server Actions BAL-541 ships. */
const BALO_PANEL_ACTION_FILES: ReadonlySet<string> = new Set([
  'assign-request-owner.ts',
  'create-internal-note.ts',
  'delete-internal-note.ts',
]);

/** The one shared helper those actions reach (server-only, not a `'use server'` module). */
const SHARED_FILES: ReadonlySet<string> = new Set(['_shared/assign-owner-fanout.ts']);

/** `lib/project-request` files this invariant polices. */
const PROJECT_REQUEST_FILES: ReadonlySet<string> = new Set(['load-balo-panel.ts']);

function scanTree(): ScannedFile[] {
  return [
    ...scanRouteSources(ACTIONS_DIR, 'actions', []).filter(
      (file) =>
        BALO_PANEL_ACTION_FILES.has(file.rel.slice('actions/'.length)) ||
        SHARED_FILES.has(file.rel.slice('actions/'.length))
    ),
    ...scanRouteSources(PROJECT_REQUEST_LIB_DIR, 'lib', []).filter((file) =>
      PROJECT_REQUEST_FILES.has(file.rel.slice('lib/'.length))
    ),
  ];
}

/**
 * Every file in the scan set, spelled out again so a module that silently stops being collected
 * (a rename, a move, a `.filter` that no longer matches) fails LOUDLY instead of vanishing.
 */
const PINNED_FILES: readonly string[] = [
  'actions/assign-request-owner.ts',
  'actions/create-internal-note.ts',
  'actions/delete-internal-note.ts',
  'actions/_shared/assign-owner-fanout.ts',
  'lib/load-balo-panel.ts',
];

/**
 * ⚠ BOTH DIRECTIONS OF EVERY NAME. A `lens !== 'client'` gate is a lens gate; banning only `===`
 * is how the BAL-540 original of this scan passed vacuously over a file with two of them.
 */
const VIEW_GATE_TOKENS: readonly string[] = [
  'lens ===',
  'lens !==',
  'role ===',
  'role !==',
  'platformRole ===',
  'platformRole !==',
  'activeMode ===',
  'activeMode !==',
  'archetype ===',
  'archetype !==',
];

describe('invariant: BAL-541 Balo-panel modules never gate on lens/role/platformRole/activeMode/archetype (ADR-1029)', () => {
  const scanned = scanTree();
  const scannedPaths = scanned.map((file) => file.rel);

  it('collects the trees (guards against a vacuous pass)', () => {
    expect(ACTIONS_DIR).not.toBe('');
    expect(PROJECT_REQUEST_LIB_DIR).not.toBe('');
    for (const pinned of PINNED_FILES) {
      expect(scannedPaths).toContain(pinned);
    }
    // Every collected file is pinned, and every pinned file is collected — so a NEW module
    // dropped into the allow-lists without joining PINNED_FILES cannot slip in unnoticed.
    expect([...scannedPaths].sort()).toEqual([...PINNED_FILES].sort());
  });

  it('none of the scanned files references a VIEW-shaped authorization token', () => {
    const offenders: string[] = [];
    for (const file of scanned) {
      for (const token of VIEW_GATE_TOKENS) {
        if (file.code.includes(token)) offenders.push(`${file.rel} → ${token}`);
      }
    }
    expect(
      offenders,
      `These BAL-541 sources reference a VIEW-shaped authorization token. Every action must ` +
        `gate on hasPlatformCapability, never on lens, role, platformRole, activeMode or ` +
        `archetype — in EITHER direction:\n  ` +
        offenders.join('\n  ')
    ).toEqual([]);
  });

  it('each of the three actions gates on the PLATFORM axis, never membership, never requireAdmin', () => {
    const actionFiles = scanned.filter((file) =>
      BALO_PANEL_ACTION_FILES.has(file.rel.slice('actions/'.length))
    );
    expect(actionFiles).toHaveLength(3);

    for (const file of actionFiles) {
      // ⚠ ≥1, NOT exactly one — `delete-internal-note.ts` legitimately calls this twice (the
      // base gate, then the `allowAnyAuthor` resolution). Do NOT "fix" this down to ===1.
      const platformGateCount = file.code.split('hasPlatformCapability(').length - 1;
      expect(
        platformGateCount,
        `${file.rel} must call hasPlatformCapability( at least once`
      ).toBeGreaterThanOrEqual(1);
      expect(
        file.code,
        `${file.rel} must never call the MEMBERSHIP axis's hasCapability( — Balo's own staffing ` +
          `of a request and its internal notebook have no membership-axis holder`
      ).not.toContain('hasCapability(');
      expect(
        file.code,
        `${file.rel} must never call requireAdmin() (no new requireAdmin sites)`
      ).not.toContain('requireAdmin(');
    }
  });

  it('delete-internal-note.ts is the one file calling hasPlatformCapability TWICE, and says why', () => {
    const file = scanned.find((f) => f.rel === 'actions/delete-internal-note.ts');
    expect(file, 'delete-internal-note.ts must be in the scan set').toBeDefined();
    const count = (file?.code ?? '').split('hasPlatformCapability(').length - 1;
    expect(count).toBe(2);
  });

  it("D2: no scanned file reads platformRole === 'super_admin' literally", () => {
    const offenders = scanned.filter((file) => file.code.includes('super_admin')).map((f) => f.rel);
    expect(
      offenders,
      `DELETE_ANY_INTERNAL_NOTE exists precisely so feature code never needs to name ` +
        `'super_admin' directly:\n  ${offenders.join('\n  ')}`
    ).toEqual([]);
  });

  it('⚠ guards the guard: BOTH directions of a deliberate lens gate WOULD be caught', () => {
    const decoys: readonly ScannedFile[] = [
      {
        rel: 'actions/assign-request-owner.ts',
        code: "if (ctx.lens === 'admin') return null;",
        raw: '',
      },
      {
        rel: 'lib/load-balo-panel.ts',
        code: "if (ctx.lens !== 'client' && ctx.lens !== 'admin') return [];",
        raw: '',
      },
      {
        rel: 'actions/delete-internal-note.ts',
        code: "if (user.platformRole !== 'admin') return null;",
        raw: '',
      },
    ];
    for (const decoy of decoys) {
      const offenders = VIEW_GATE_TOKENS.filter((token) => decoy.code.includes(token));
      expect(offenders.length, `decoy not caught: ${decoy.code}`).toBeGreaterThan(0);
    }
  });
});
