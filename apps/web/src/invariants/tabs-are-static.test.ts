import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { codeLinesOf, resolveRouteDir } from './_source-scan';

/**
 * BAL-511 / ADR-1053 — structural invariant for **TABS ARE DELIBERATELY STATIC**.
 *
 * `.claude/design-references/balo-nav-explorer.jsx` (the committed design reference) carries the
 * motion spec, and its `tabs` line reads:
 *   `deliberately static — no underline slide, no panel fade, no press scale, uniform
 *    font-weight (animated tabs read as jitter here)`
 *
 * Fourth consumer of `_source-scan`'s shared reading primitives, after `review-link-never-writes`,
 * `join-link-never-writes` and `credits-chip-server-gated` — see that module's docblock for why
 * sharing does not weaken any of them: each caller carries its own "guards the guard" test.
 *
 * ⚠ WHY A SOURCE SCAN AND NOT A RENDER ASSERTION. `apps/web/src/test/motion-stub.ts`'s
 * `MOTION_PROPS` set includes `layoutId`, so the stub strips it before it ever reaches the DOM: a
 * render-only test passes no matter what the component hands `motion`. BAL-498 had to pin its
 * pill through an EXPORTED PURE FUNCTION for exactly this reason. Reading the source is the only
 * assertion that cannot be fooled (BAL-511 D13).
 *
 * ⚠ THE `motion/react` IMPORT IS BANNED TOO, not just the two prop names. A scan for `layoutId`
 * and `AnimatePresence` alone lets a future `motion.div` with `initial`/`animate` walk straight
 * past both words. All three files below are genuinely motion-free after BAL-511, so the import
 * ban is satisfiable (BAL-511 D12 / M8).
 *
 * THREE controls are covered, not two. `app/(dashboard)/settings/_components/settings-section-nav.tsx`
 * (BAL-503, the CLIENT settings tab bar) carried a byte-identical `layoutId="settings-section-pill"`
 * spring violation and was NOT in the ticket's originally-stated scope — it is an orchestrator
 * scope addition (D18), flattened in this same PR rather than left as a documented gap. See the
 * PR body for the reasoning: a freshly-written invariant that documents its own hole is a bad
 * artifact.
 *
 * NOT covered on purpose: BAL-497's sidebar sliding pill, which the spec's `sidebar pill` line
 * keeps deliberately; and the non-tab `whileHover`/`whileTap` on meeting cards and agenda rows,
 * which the spec's separate `buttons` line sanctions.
 *
 * ⚠ KNOWN LIMITATION — THIS LIST IS FIXED, SO A FOURTH TAB CONTROL SHIPS UNCOVERED. `CONTROLS`
 * below is hand-maintained, and nothing fails when a new tab bar is added elsewhere: BAL-511
 * itself only found the third entry because a reviewer read a neighbouring route by hand. The
 * same limitation applies to every existing `_source-scan` consumer, so this is not a regression
 * — but if you add a tab control anywhere in `app/`, ADD IT HERE IN THE SAME PR. Deriving the
 * list from a registry would close this properly and is worth its own ticket.
 *
 * If this test fails: you re-animated a tab control. Take it out, or amend ADR-1053 first.
 */

interface TabControl {
  readonly label: string;
  readonly path: string;
  /** A string that IS genuinely in the file — the non-vacuity anchor. */
  readonly present: string;
}

const CONTROLS: readonly TabControl[] = [
  {
    label: 'expert calendar view switcher',
    // ⚠ TWO CANDIDATES, ALWAYS. CI runs web vitest from the REPO ROOT while a developer runs it
    // from `apps/web`, so a single cwd-relative path resolves to nothing in one of the two — and
    // a scan that finds nothing passes every assertion for the wrong reason (memory
    // `reference_web_server_disk_asset_cwd`; `_source-scan.ts:289-300`). `resolveRouteDir` is an
    // existsSync-first-match over the candidates and works for a FILE path as well as a
    // directory — do not hand-roll a second resolver.
    path: resolveRouteDir([
      'src/app/(dashboard)/expert/calendar/_components/calendar-view-switcher.tsx',
      'apps/web/src/app/(dashboard)/expert/calendar/_components/calendar-view-switcher.tsx',
    ]),
    present: 'role="radiogroup"',
  },
  {
    label: 'expert settings tabs',
    path: resolveRouteDir([
      'src/app/(dashboard)/expert/settings/_components/settings-tabs.tsx',
      'apps/web/src/app/(dashboard)/expert/settings/_components/settings-tabs.tsx',
    ]),
    present: 'role="tablist"',
  },
  {
    label: 'client settings section nav (BAL-511 D18 — orchestrator scope addition)',
    path: resolveRouteDir([
      'src/app/(dashboard)/settings/_components/settings-section-nav.tsx',
      'apps/web/src/app/(dashboard)/settings/_components/settings-section-nav.tsx',
    ]),
    // ⚠ This control uses `aria-current="page"`, NOT `role="tab"` — it is route links, not the
    // ARIA tabs pattern (see that file's own docblock). Its ARIA is out of scope and untouched;
    // the non-vacuity anchor is its `<nav aria-label>`, which IS genuinely present.
    present: 'aria-label="Settings sections"',
  },
];

/** Every token that reintroduces tab motion, including the import that would carry a new one in. */
const BANNED_TOKENS: readonly string[] = ['layoutId', 'AnimatePresence', 'motion/react'];

describe('invariant: tab controls are deliberately static (BAL-511 / ADR-1053)', () => {
  it.each(CONTROLS)(
    'guards the guard: the $label file resolves on disk and genuinely contains $present',
    ({ path, present }) => {
      // Without this, a moved or renamed file makes every assertion below pass vacuously.
      expect(path).not.toBe('');
      expect(codeLinesOf(readFileSync(path, 'utf8'))).toContain(present);
    }
  );

  it.each(CONTROLS)(
    'the $label names none of layoutId / AnimatePresence / motion/react',
    ({ label, path }) => {
      const code = codeLinesOf(readFileSync(path, 'utf8'));
      const offenders = BANNED_TOKENS.filter((token) => code.includes(token));
      expect(
        offenders,
        `${label} re-animates a tab control (${offenders.join(', ')}). ADR-1053's motion spec ` +
          `says tabs are "deliberately static — no underline slide, no panel fade, no press ` +
          `scale, uniform font-weight". Express the active state as a static class ` +
          `(bg-card/shadow-sm, border-primary/text-primary), or amend the ADR first.`
      ).toEqual([]);
    }
  );
});
