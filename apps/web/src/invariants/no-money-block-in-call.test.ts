import { describe, expect, it } from 'vitest';
import { resolveRouteDir, scanRouteSources, type ScannedFile } from './_source-scan';

/**
 * BAL-403 — a regression guard, not a new rule: BAL-399's recap money block
 * (`components/balo/recap/money-block.tsx`) and this ticket's in-call Balance panel are two
 * DIFFERENT surfaces that must never co-render.
 *
 * They cannot today, structurally — different route groups: the recap mounts only under
 * `(dashboard)/meetings/[meetingId]` and `(dashboard)/cases/[engagementId]`, while this panel
 * mounts only under `(call)/meetings/[meetingId]/call`. This test pins that boundary so a
 * future edit cannot casually import one into the other.
 *
 * ⚠⚠ FIX ROUND 1 (S3) — `app/(call)/**` ALONE WAS CEREMONIAL. The live call's actual render
 * tree is `components/balo/meetings/**` (`meeting-frame-impl.tsx` and everything it composes)
 * plus, since this ticket, `components/balo/credit/**` (`in-call-balance-panel.tsx`,
 * `in-session-panel.tsx`) — neither of which lives under `app/(call)`. A regression would arrive
 * as an import inside `meeting-frame-impl.tsx` or `in-call-balance-panel.tsx`, and the original
 * scan would never see it. Both extra trees are scanned now, each pinned separately below so a
 * silently-empty directory (a renamed folder, a wrong cwd) fails loudly rather than passing
 * vacuously.
 */
const CALL_ROUTE_DIR = resolveRouteDir(['src/app/(call)', 'apps/web/src/app/(call)']);
const MEETINGS_COMPONENTS_DIR = resolveRouteDir([
  'src/components/balo/meetings',
  'apps/web/src/components/balo/meetings',
]);
const CREDIT_COMPONENTS_DIR = resolveRouteDir([
  'src/components/balo/credit',
  'apps/web/src/components/balo/credit',
]);

function scanCallRenderTree(): ScannedFile[] {
  return [
    ...scanRouteSources(CALL_ROUTE_DIR, 'app/(call)', []),
    ...scanRouteSources(MEETINGS_COMPONENTS_DIR, 'components/balo/meetings', []),
    ...scanRouteSources(CREDIT_COMPONENTS_DIR, 'components/balo/credit', []),
  ];
}

describe('invariant: the recap money block never reaches the live call route (BAL-403)', () => {
  it('collects all three trees (guards against a vacuous pass)', () => {
    expect(CALL_ROUTE_DIR).not.toBe('');
    expect(MEETINGS_COMPONENTS_DIR).not.toBe('');
    expect(CREDIT_COMPONENTS_DIR).not.toBe('');
    const scanned = scanCallRenderTree();
    expect(scanned.length).toBeGreaterThan(0);
    // ⚠ THE FILES THAT ACTUALLY COMPOSE THE LIVE CALL, NAMED — a directory walk that silently
    // finds nothing passes every assertion below.
    const scannedPaths = scanned.map((file) => file.rel);
    expect(scannedPaths).toContain('components/balo/meetings/meeting-frame-impl.tsx');
    expect(scannedPaths).toContain('components/balo/credit/in-call-balance-panel.tsx');
  });

  it('⚠ no file under app/(call)/**, components/balo/meetings/** or components/balo/credit/** imports the recap money block', () => {
    const scanned = scanCallRenderTree();
    const offenders = scanned
      .filter((file) => file.code.includes('recap/money-block'))
      .map((file) => file.rel);

    expect(
      offenders,
      `These call-render-tree files import the recap money block. BAL-399's recap and this ` +
        `ticket's in-call Balance panel are separate surfaces on separate route groups and must ` +
        `never co-render:\n  ` +
        offenders.join('\n  ')
    ).toEqual([]);
  });
});
