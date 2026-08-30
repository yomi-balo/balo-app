import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * BAL-510 — stylesheet-level AC guards jsdom cannot check by rendering: jsdom applies no
 * external CSS, so `prefers-reduced-motion` behaviour (AC 5), the font rewire and the
 * colour-rhythm hexes (AC 1) can only be pinned by reading `v2.css` as text.
 *
 * ⚠ Anchored on `import.meta.url`, NOT `process.cwd()`: CI runs web vitest from the repo
 * root, so `process.cwd()` resolves differently there than it does locally, and a
 * cwd-relative path would ENOENT only in CI. Resolving relative to THIS file's own
 * location sidesteps that difference entirely — the path is correct regardless of where
 * vitest was invoked from.
 */
const CSS_PATH = join(dirname(fileURLToPath(import.meta.url)), 'v2.css');
const CSS = readFileSync(CSS_PATH, 'utf-8');

describe('v2.css — stylesheet AC guards', () => {
  it('does not import Google Fonts (brief item 2 — both Geist faces are already app-wide)', () => {
    expect(CSS).not.toContain('fonts.googleapis.com');
  });

  it('rewires the font stacks onto the app-loaded Geist CSS variables (edit 2 — the silent killer)', () => {
    expect(CSS).toContain('var(--font-geist-sans)');
    expect(CSS).toContain('var(--font-geist-mono)');
  });

  it('does not style the host document body (edit 3 — that belongs to the stripped ControlStrip)', () => {
    expect(CSS).not.toMatch(/(^|\n)body\s*\{/);
    expect(CSS).not.toMatch(/(^|\n)html,\s*body\s*\{/);
  });

  // ⚠ THE GUARD THAT MATTERS, and the one that was too narrow. This file is UNLAYERED author
  // CSS, so any rule here beats every layered rule in `globals.css` and all Tailwind output,
  // unconditionally — and Next's App Router does not reliably unload a page-scoped stylesheet
  // on a soft navigation. A single top-level rule therefore escapes /v2 and applies app-wide
  // for the life of the tab. The earlier version of this test pinned only `body {`, so
  // `html { scroll-behavior: smooth }` walked straight through it.
  //
  // Every top-level selector must be `.mk2-`-scoped or an `html:has(.mk2-page)` guard. The
  // only bare at-rules permitted are @media / @keyframes wrappers, whose own contents are
  // checked by the same rule below.
  it('leaks nothing to the host document — every top-level selector is page-scoped', () => {
    // Strip comments, then collect every selector that opens a declaration block.
    // Written without `\s*` padding around the capture: `\s*` next to `[^@{}]+` can exchange
    // whitespace with it, which is super-linear backtracking (regexp/no-super-linear-backtracking).
    // `[^@{}]+` excludes `{`, so the match is deterministic; whitespace is trimmed in JS below.
    const withoutComments = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
    const selectors = [...withoutComments.matchAll(/(^|\})([^@{}]+)\{/g)]
      .map((m) => m[2] ?? '')
      .flatMap((group) => group.split(','))
      .map((sel) => sel.trim())
      .filter((sel) => sel.length > 0 && !sel.startsWith('@'))
      // `from` / `to` / `70%` are @keyframes stops, not selectors — they cannot escape a
      // stylesheet and the keyframe NAMES they belong to are all `mk2-`-prefixed.
      .filter((sel) => !/^(from|to|-?\d+(\.\d+)?%)$/.test(sel));

    expect(selectors.length).toBeGreaterThan(50); // the regex actually matched something

    const escaped = selectors.filter(
      (sel) => !sel.includes('.mk2-') && !sel.startsWith('html:has(.mk2-page)')
    );
    expect(escaped).toEqual([]);
  });

  it('deletes the control-strip CSS (edit 4)', () => {
    expect(CSS).not.toContain('.mk2-ctl');
    expect(CSS).not.toContain('.mk2-seg');
  });

  it('deletes the nav CSS (edit 5) but keeps the logo mark the footer depends on — the trap', () => {
    expect(CSS).not.toMatch(/\.mk2-nav\b/);
    expect(CSS).toContain('.mk2-logo-mark');
  });

  it('AC 10: the highest-specificity gradient-CTA rule exists, forcing #fff regardless of ancestor colour', () => {
    expect(CSS).toContain('.mk2-page .mk2-btn-grad');
    expect(CSS).toContain('.mk2-page .mk2-xc-book');
    // Both selectors share one declaration block ending in `color: #fff;` (edit 9 / AC 10).
    // `\s+` rather than `\s*\n\s*`: the latter's two `\s*` quantifiers can exchange
    // characters across the `\n`, which is super-linear backtracking (regexp/no-super-linear-backtracking).
    expect(CSS).toMatch(/\.mk2-page \.mk2-btn-grad,\s+\.mk2-page \.mk2-xc-book \{\s+color: #fff;/);
  });

  // The ref's own reduced-motion selector (`marketing-home-v2.jsx:543`) stops at
  // `.mk2-hero > *`, which reaches only .mk2-aurora / .mk2-wrap / .mk2-ticker — NOT the six
  // staggered entry elements one level deeper. Browser-verified: without the widened selector
  // all six still run `mk2-up` under `prefers-reduced-motion: reduce`.
  it('AC 5: the hero entry stagger is silenced too — the ref selector alone does not reach it', () => {
    expect(CSS).toContain('.mk2-page.reduced .mk2-hero .mk2-wrap > *');
    // …and in the pre-hydration media block, where `.reduced` is not on the root yet.
    expect(CSS).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{[^}]*\.mk2-page \.mk2-hero \.mk2-wrap > \*/
    );
  });

  it.each([
    '.mk2-rot',
    '.mk2-ticker-track',
    '.mk2-aur',
    '.mk2-reveal',
    '.mk2-receipt',
    '.mk2-facet-pop',
  ])('AC 5: .mk2-page.reduced honours reduced motion on %s', (selector) => {
    expect(CSS).toContain(`.mk2-page.reduced ${selector}`);
  });

  it('AC 1: the three tint values and the night surface appear literally', () => {
    expect(CSS).toContain('#f3f6ff'); // .mk2-tint-blue (Contrast)
    expect(CSS).toContain('#f8f5ff'); // .mk2-tint-violet (Steps)
    expect(CSS).toContain('linear-gradient(135deg, #eff6ff 0%, #f5f3ff 100%)'); // .mk2-tint-grad (Quote)
    expect(CSS).toContain('--night: #0b1220'); // For experts (Band)
  });
});
