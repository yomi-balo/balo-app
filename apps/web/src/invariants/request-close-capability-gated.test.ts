import { describe, expect, it } from 'vitest';
import { resolveRouteDir, scanRouteSources, type ScannedFile } from './_source-scan';

/**
 * BAL-540 / ADR-1029 — structural invariant: the BAL-540 request-close / decline-track modules
 * authorize on a CAPABILITY, never on a VIEW-shaped token (`lens`, `role`, `platformRole`,
 * `activeMode`, `archetype`). Capability tokens are resolved once, at the top of each action
 * (`hasCapability` for the client arm, `hasPlatformCapability` for the Balo arm) — never
 * re-derived from a lens comparison downstream, and never a `requireAdmin()` (D7/D14: the
 * client-close pattern this ticket must NOT copy).
 *
 * Modelled on `request-file-no-lens-gate.test.ts` (the newest and best precedent in this repo
 * for this exact shape of scan).
 *
 * ⚠ WHAT THIS SCANS, EXACTLY — AND WHY THAT SET AND NO OTHER (fix round, review finding 3).
 * The original version banned `lens ===` but not `lens !==`, and listed a file that contained
 * two `lens !==` gates — so the one file the scan had been EXTENDED to cover passed vacuously.
 * Two things changed, and both matter:
 *
 *  1. The token list now bans BOTH DIRECTIONS (`===` and `!==`) of every view-shaped name. A
 *     negated lens gate is the same gate.
 *  2. The scanned files were made to SATISFY that ban rather than be exempted from it. The
 *     audience narrowing that used to live in `closed-request-view.ts` moved UP to its caller,
 *     `lib/project-request/request-detail-view.ts` — the mapper that already makes every other
 *     per-lens PRESENTATION choice, and which is deliberately NOT scanned. That is this repo's
 *     established answer for a file that must name a lens: AVOIDANCE (put it where lens reads
 *     belong), never a per-file token allow-list.
 *
 * So the scan set is: the four Server Actions, both of their `_shared` helpers, and the two
 * `lib/project-request` modules this ticket ADDED that make an access-shaped decision
 * (`closed-request-view.ts`, D11's `close_note` audience-gating home; and
 * `resolve-ended-track-view.ts`, deviation V1's narrow de-participated-expert branch). Every
 * one of them appears in BOTH the file allow-list AND `PINNED_FILES` — an unpinned module is a
 * silently UNSCANNED module, which is a false green.
 *
 * NOT scanned, on purpose:
 *  - `lib/project-request/resolve-request-lens.ts` — the RESOLVER, which legitimately reads
 *    `platformRole`/membership to PRODUCE the lens everything else consumes. Scanning it is the
 *    category error `request-file-no-lens-gate`'s docblock warns against.
 *  - `lib/project-request/request-detail-view.ts` and `projects/[requestId]/page.tsx` — pure
 *    presentation/affordance narrowing over an ALREADY-AUTHORIZED, server-computed projection,
 *    matching shipped precedent in both files on `origin/main`. Neither can grant anything:
 *    every mutation re-resolves its own capability server-side, which is what the "exactly one
 *    capability call" assertion below pins.
 */

const ACTIONS_DIR = resolveRouteDir([
  'src/app/(dashboard)/projects/[requestId]/_actions',
  'apps/web/src/app/(dashboard)/projects/[requestId]/_actions',
]);
const PROJECT_REQUEST_LIB_DIR = resolveRouteDir([
  'src/lib/project-request',
  'apps/web/src/lib/project-request',
]);

/** The four Server Actions this ticket ships (BAL-540 Phase 4). */
const CLOSE_REQUEST_ACTION_FILES: ReadonlySet<string> = new Set([
  'close-request.ts',
  'close-request-as-admin.ts',
  'decline-track.ts',
  'decline-track-as-admin.ts',
]);

/**
 * The two shared helpers those actions reach (server-only, not `'use server'` modules): the
 * post-commit fan-out and the decline-stage narrowing.
 */
const SHARED_FILES: ReadonlySet<string> = new Set([
  '_shared/close-request-fanout.ts',
  '_shared/decline-track-stage.ts',
]);

/**
 * `lib/project-request` files this invariant polices — a narrow allow-list, not the whole
 * directory (see the docblock for what is deliberately outside it and why).
 */
const PROJECT_REQUEST_FILES: ReadonlySet<string> = new Set([
  'closed-request-view.ts',
  'resolve-ended-track-view.ts',
]);

function scanTree(): ScannedFile[] {
  return [
    ...scanRouteSources(ACTIONS_DIR, 'actions', []).filter(
      (file) =>
        CLOSE_REQUEST_ACTION_FILES.has(file.rel.slice('actions/'.length)) ||
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
  'actions/close-request.ts',
  'actions/close-request-as-admin.ts',
  'actions/decline-track.ts',
  'actions/decline-track-as-admin.ts',
  'actions/_shared/close-request-fanout.ts',
  'actions/_shared/decline-track-stage.ts',
  'lib/closed-request-view.ts',
  'lib/resolve-ended-track-view.ts',
];

/**
 * ⚠ BOTH DIRECTIONS OF EVERY NAME. A `lens !== 'client'` gate is a lens gate; banning only
 * `===` is how the first version of this test passed vacuously over a file with two of them.
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

describe('invariant: BAL-540 request-close/decline-track modules never gate on lens/role/platformRole/activeMode/archetype (ADR-1029)', () => {
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
      `These BAL-540 sources reference a VIEW-shaped authorization token. Every action must ` +
        `gate on hasCapability / hasPlatformCapability, never on lens, role, platformRole, ` +
        `activeMode or archetype — in EITHER direction:\n  ` +
        offenders.join('\n  ')
    ).toEqual([]);
  });

  it('each of the four actions gates on exactly one capability check and zero requireAdmin (D7/D14)', () => {
    const actionFiles = scanned.filter((file) =>
      CLOSE_REQUEST_ACTION_FILES.has(file.rel.slice('actions/'.length))
    );
    expect(actionFiles).toHaveLength(4);

    for (const file of actionFiles) {
      const hasMembershipGate = file.code.includes('hasCapability(');
      const hasPlatformGate = file.code.includes('hasPlatformCapability(');
      expect(
        hasMembershipGate !== hasPlatformGate,
        `${file.rel} must call exactly one of hasCapability( / hasPlatformCapability( — ` +
          `found membership=${hasMembershipGate}, platform=${hasPlatformGate}`
      ).toBe(true);
      expect(
        file.code,
        `${file.rel} must never call requireAdmin() (D7/D14 — no new requireAdmin sites)`
      ).not.toContain('requireAdmin(');
    }
  });

  it('D11: closed-request-view gates close_note on the CAPABILITY boolean, not an audience shape', () => {
    const view = scanned.find((file) => file.rel === 'lib/closed-request-view.ts');
    expect(view, 'closed-request-view.ts must be in the scan set').toBeDefined();
    expect(view?.code).toContain('ctx.canSeeStaffOnly');
    expect(view?.code).toContain('request.closeNote');
  });

  it('⚠ guards the guard: BOTH directions of a deliberate lens gate WOULD be caught', () => {
    const decoys: readonly ScannedFile[] = [
      { rel: 'actions/close-request.ts', code: "if (ctx.lens === 'admin') return null;", raw: '' },
      {
        rel: 'lib/closed-request-view.ts',
        code: "if (ctx.lens !== 'client' && ctx.lens !== 'admin') return [];",
        raw: '',
      },
      {
        rel: 'lib/resolve-ended-track-view.ts',
        code: "if (ctx.archetype !== 'participant') return null;",
        raw: '',
      },
    ];
    for (const decoy of decoys) {
      const offenders = VIEW_GATE_TOKENS.filter((token) => decoy.code.includes(token));
      expect(offenders.length, `decoy not caught: ${decoy.code}`).toBeGreaterThan(0);
    }
  });
});
