import { describe, expect, it } from 'vitest';
import { resolveRouteDir, scanRouteSources, type ScannedFile } from './_source-scan';

/**
 * BAL-499 — structural proof that the top-bar credits chip's workspace gate is SERVER-SIDE
 * (D2), never re-decided client-side in `top-nav.tsx` (`'use client'`). Third consumer of
 * `_source-scan`'s shared reading primitives, after BAL-390's `review-link-never-writes` and
 * BAL-408's `join-link-never-writes` — see that module's docblock for why sharing it does not
 * weaken any of the three: each caller (this one included) carries its own "guards the guard"
 * test proving the scan genuinely reaches the file it means to check.
 */

const LAYOUT_DIR = resolveRouteDir(['src/components/layout', 'apps/web/src/components/layout']);

function fileByRel(rel: string): ScannedFile | undefined {
  return scanRouteSources(LAYOUT_DIR, '', []).find((file) => file.rel === rel);
}

describe('the top-bar credits chip gate is server-side (BAL-499)', () => {
  it('guards the guard: LAYOUT_DIR resolves to a real path, and top-nav.tsx genuinely names creditsChip', () => {
    expect(LAYOUT_DIR).not.toBe('');
    const topNav = fileByRel('top-nav.tsx');
    expect(topNav).toBeDefined();
    expect(topNav?.code).toContain('creditsChip');
  });

  it('top-nav.tsx never re-decides the chip client-side (no activeMode / workspaceType / navContext read)', () => {
    const topNav = fileByRel('top-nav.tsx');
    expect(topNav?.code).not.toContain('activeMode');
    expect(topNav?.code).not.toContain('workspaceType');
    expect(topNav?.code).not.toContain('navContext');
  });

  it('top-nav.tsx does not name the server-only wallet read, @balo/db, or server-only', () => {
    const topNav = fileByRel('top-nav.tsx');
    expect(topNav?.code).not.toContain('@/lib/credit/wallet-read');
    expect(topNav?.code).not.toContain('@balo/db');
    expect(topNav?.code).not.toContain('server-only');
  });

  it("credits-chip.tsx (the 'use client' leaf) does not name the server-only wallet read, @balo/db, or server-only", () => {
    const chip = fileByRel('credits-chip.tsx');
    expect(chip).toBeDefined();
    expect(chip?.code).not.toContain('@balo/db');
    expect(chip?.code).not.toContain('server-only');
    expect(chip?.code).not.toContain('@/lib/credit/wallet-read');
  });

  it("credits-chip-slot.tsx's raw source does not contain 'use client' — it must stay a Server Component", () => {
    const slot = fileByRel('credits-chip-slot.tsx');
    expect(slot).toBeDefined();
    expect(slot?.raw).not.toContain("'use client'");
  });

  it('credits-chip-scope.ts does not name @balo/db or server-only', () => {
    const scope = fileByRel('credits-chip-scope.ts');
    expect(scope).toBeDefined();
    expect(scope?.code).not.toContain('@balo/db');
    expect(scope?.code).not.toContain('server-only');
  });
});
