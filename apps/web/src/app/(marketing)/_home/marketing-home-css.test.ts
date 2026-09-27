import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { resolveRouteDir, stripBlockComments } from '@/invariants/_source-scan';

/**
 * BAL-493 (D4/§2.5) — the source-scan guard over `marketing-home.css` + `globals.css`.
 *
 * This is a SOURCE SCAN by design: it reads both stylesheets as text and asserts
 * mechanical properties (substrings, brace-bounded rule bodies, parsed OKLCH values).
 * It renders no component and needs none — the component-level rhythm test
 * (`_home/rhythm.test.tsx`, owned by P4) asserts the CLASS is present on each rendered
 * section; this file asserts what that class actually DOES.
 *
 * NO REGEX ANYWHERE (SonarCloud S5852 / `regexp/no-super-linear-move`) — every scan below
 * is a plain `indexOf`/`includes` walk, matching the house convention in
 * `apps/web/src/invariants/_source-scan.ts`.
 */

// `resolveRouteDir` (from `_source-scan.ts`) tries each candidate against `process.cwd()`
// so this test passes whether vitest runs from `apps/web` (a developer) or the repo root
// (CI's `pnpm test:coverage`) — see memory `reference_web_server_disk_asset_cwd`.
const HOME_DIR = resolveRouteDir([
  'src/app/(marketing)/_home',
  'apps/web/src/app/(marketing)/_home',
]);
const APP_DIR = resolveRouteDir(['src/app', 'apps/web/src/app']);

const marketingHomeCssRaw =
  HOME_DIR === '' ? '' : readFileSync(`${HOME_DIR}/marketing-home.css`, 'utf8');
const globalsCssRaw = APP_DIR === '' ? '' : readFileSync(`${APP_DIR}/globals.css`, 'utf8');

/** Every existence/absence check below runs on the STRIPPED text so this file's own docblock —
 * which necessarily NAMES the stripped selectors (`.mk-ctl`, `.mk-page.deep`, `@import url(`,
 * `.mk-nav`) while explaining they are gone — can never trip its own guard. */
const marketingHomeCss = stripBlockComments(marketingHomeCssRaw);
const globalsCss = stripBlockComments(globalsCssRaw);

/** The body of the FIRST rule whose selector text is exactly `${selector} {`, up to the
 * next `}`. Every rule this file looks up is flat (no nested braces in its body), so a
 * single `indexOf('}')` from the opening brace is a correct, non-regex "parse". The
 * trailing space before `{` is load-bearing: it stops `.mk-final {` from matching inside
 * `.mk-final-card {` (Prettier always emits exactly one space before the brace). */
function firstRuleBody(source: string, selector: string): string | undefined {
  const marker = `${selector} {`;
  const idx = source.indexOf(marker);
  if (idx === -1) return undefined;
  const start = idx + marker.length;
  const end = source.indexOf('}', start);
  if (end === -1) return undefined;
  return source.slice(start, end);
}

/** The BRACE-BALANCED body of the first at-rule whose prelude is exactly `${prelude} {`.
 * `firstRuleBody` cannot be reused for this: an `@media` body contains whole rules, so its
 * first `}` closes an inner rule, not the query. A depth counter walk — still no regex. */
function atRuleBody(source: string, prelude: string): string | undefined {
  const marker = `${prelude} {`;
  const idx = source.indexOf(marker);
  if (idx === -1) return undefined;
  const start = idx + marker.length;
  let depth = 1;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i);
    }
  }
  return undefined;
}

/** Every ASCII hex-digit run of length 3/4/6/8 immediately preceded by `#`, anywhere in
 * `source`. A plain character walk, not a regex — matches CSS's own `#rgb`/`#rrggbb`
 * color-literal grammar exactly. */
function hexColorLiterals(source: string): string[] {
  const isHexDigit = (ch: string): boolean =>
    (ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f') || (ch >= 'A' && ch <= 'F');
  const found: string[] = [];
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] !== '#') continue;
    let j = i + 1;
    for (; j < source.length; j += 1) {
      const ch = source[j];
      if (ch === undefined || !isHexDigit(ch)) break;
    }
    const len = j - i - 1;
    if (len === 3 || len === 4 || len === 6 || len === 8) {
      found.push(source.slice(i, j));
    }
  }
  return found;
}

/** Count of non-overlapping occurrences of `needle` in `haystack`. */
function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count += 1;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

/** The trimmed value of the FIRST `--token: …;` declaration inside `blockText`. */
function declarationValue(blockText: string, token: string): string | undefined {
  const marker = `--${token}:`;
  const idx = blockText.indexOf(marker);
  if (idx === -1) return undefined;
  const start = idx + marker.length;
  const end = blockText.indexOf(';', start);
  if (end === -1) return undefined;
  return blockText.slice(start, end).trim();
}

/** `{l, c}` parsed out of an `oklch(L C H)` (or `oklch(L C H / A)`) value string. */
function oklchLightnessChroma(value: string): { l: number; c: number } | undefined {
  if (!value.startsWith('oklch(')) return undefined;
  const close = value.indexOf(')');
  if (close === -1) return undefined;
  const inner = value.slice('oklch('.length, close);
  const parts = inner.split(' ').filter((part) => part.length > 0);
  const [l, c] = parts;
  if (l === undefined || c === undefined) return undefined;
  const lNum = Number.parseFloat(l);
  const cNum = Number.parseFloat(c);
  if (Number.isNaN(lNum) || Number.isNaN(cNum)) return undefined;
  return { l: lNum, c: cNum };
}

const NEW_TOKENS = [
  'mist',
  'night',
  'night-foreground',
  'line',
  'line-soft',
  'primary-deep',
  'violet',
  'violet-deep',
  'subtle-foreground',
] as const;

describe('BAL-493 source files were actually found', () => {
  // Guards the guard (per `_source-scan.ts`'s own convention): if `resolveRouteDir`
  // returns '' for either candidate list, `readFileSync` above would have thrown before
  // this test even ran — but an empty file would make every `.includes()` check below
  // vacuously pass by finding nothing to contradict it. Pin non-trivial length instead.
  it('loaded a non-trivial marketing-home.css', () => {
    expect(marketingHomeCssRaw.length).toBeGreaterThan(5000);
  });

  it('loaded a non-trivial globals.css', () => {
    expect(globalsCssRaw.length).toBeGreaterThan(5000);
  });
});

describe('marketing-home.css — the .mk-page token-shadowing guard', () => {
  const mkPageBody = firstRuleBody(marketingHomeCss, '.mk-page');

  it('has a .mk-page rule', () => {
    expect(mkPageBody).toBeDefined();
  });

  it('declares --wrap', () => {
    expect(mkPageBody ?? '').toContain('--wrap: 1320px');
  });

  it.each(['--primary', '--foreground', '--success', '--muted-foreground'])(
    'never shadows the global %s token',
    (token) => {
      expect(mkPageBody ?? '').not.toContain(`${token}:`);
    }
  );
});

describe('marketing-home.css — stripped prototype-only surfaces', () => {
  it('never sets a page-wide body background', () => {
    expect(marketingHomeCss).not.toContain('body {');
  });

  it('has no .mk-ctl control-strip block', () => {
    expect(marketingHomeCss).not.toContain('.mk-ctl');
  });

  it('has no .mk-page.deep hero variant', () => {
    expect(marketingHomeCss).not.toContain('.mk-page.deep');
  });

  it('imports no third-party stylesheet', () => {
    expect(marketingHomeCss).not.toContain('@import url(');
  });

  it('defines no nav chrome (MarketingHeader owns the header)', () => {
    expect(marketingHomeCss).not.toContain('.mk-nav');
  });
});

describe('marketing-home.css — button colours beat the anchor reset (BAL-493 follow-up)', () => {
  /**
   * REGRESSION GUARD for a real, user-visible defect found by rendering the page.
   *
   * `.mk-page a { color: inherit }` is specificity (0,1,1); every `.mk-btn-*` colour is a
   * single class, (0,1,0). So a CTA rendered as a <Link> inherited its SECTION's colour
   * instead of its own — and on the dark "For experts" band and the gradient final-CTA card
   * that colour is white, so `.mk-btn-white` shipped WHITE TEXT ON WHITE and the labels
   * "Apply to join" and "Find an expert" were invisible.
   *
   * The `a.mk-btn-*` rules are (0,2,1) and win. If someone "simplifies" them away, the
   * buttons go invisible again in exactly two places that no jsdom test can see (jsdom does
   * not compute the cascade), which is why this is a source scan.
   */
  it('scopes every coloured button class for anchors', () => {
    for (const sel of [
      '.mk-page a.mk-btn-white',
      '.mk-page a.mk-btn-outline-light',
      '.mk-page a.mk-btn-ghost',
      '.mk-page a.mk-btn-text',
    ]) {
      expect(marketingHomeCss).toContain(sel);
    }
    // solid + grad share one rule; assert both selectors are present in it.
    expect(marketingHomeCss).toContain('.mk-page a.mk-btn-solid');
    expect(marketingHomeCss).toContain('.mk-page a.mk-btn-grad');
  });

  it('still resets ordinary prose links to inherit', () => {
    expect(marketingHomeCss).toContain('.mk-page a {');
  });
});

describe('marketing-home.css — no hex-colour literal anywhere', () => {
  // This port uses zero hex literals full stop (var()/color-mix()/rgba()/named keywords
  // only, including `black` in place of the ref's `#000` mask stops) — a strictly
  // stronger guarantee than "no hex outside box-shadow:/filter:/rgba( context", so a
  // single blanket scan is the correct guard rather than a context-sensitive allowlist.
  it('contains no #rgb/#rrggbb/#rgba/#rrggbbaa literal', () => {
    expect(hexColorLiterals(marketingHomeCss)).toEqual([]);
  });
});

describe('marketing-home.css — the mk-reveal JS-disabled fix', () => {
  it('does not hide content unconditionally', () => {
    const baseRevealBody = firstRuleBody(marketingHomeCss, '.mk-reveal');
    expect(baseRevealBody ?? '').not.toContain('opacity:');
  });

  it('scopes the hidden state to an un-revealed group', () => {
    expect(marketingHomeCss).toContain('.mk-reveal-group:not(.is-in) .mk-reveal');
  });

  it('forces full visibility when scripting is unavailable', () => {
    expect(marketingHomeCss).toContain('@media (scripting: none)');
  });
});

describe('marketing-home.css — Table A (light rhythm), one assertion per row', () => {
  const rows: { readonly label: string; readonly selector: string; readonly expect: string }[] = [
    { label: 'hero', selector: '.mk-hero', expect: 'background: var(--background)' },
    { label: 'proof band', selector: '.mk-proof', expect: 'background: var(--background)' },
    {
      label: 'ways/experts/testimonials (mist)',
      selector: '.mk-mist',
      expect: 'background: var(--mist)',
    },
    {
      label: 'how-it-works/pricing (plain section)',
      selector: '.mk-section',
      expect: 'background: var(--background)',
    },
    {
      label: 'for experts (night band)',
      selector: '.mk-xband',
      expect: 'background: var(--night)',
    },
    { label: 'final CTA section', selector: '.mk-final', expect: 'background: var(--background)' },
    { label: 'footer', selector: '.mk-footer', expect: 'background: var(--background)' },
  ];

  it.each(rows)('$label: $selector sets $expect', ({ selector, expect: expected }) => {
    const body = firstRuleBody(marketingHomeCss, selector);
    expect(body).toBeDefined();
    expect(body ?? '').toContain(expected);
  });
});

describe('marketing-home.css — Table B (dark rhythm), exactly nine overrides', () => {
  const REQUIRED_DARK_RHYTHM_SELECTORS = [
    ':is(.dark) .mk-blob-a',
    ':is(.dark) .mk-blob-b',
    ':is(.dark) .mk-blob-c',
    ':is(.dark) .mk-grid',
    ':is(.dark) .mk-receipt-glow',
    ':is(.dark) .mk-xband-glow',
    ':is(.dark) .mk-xband-glow2',
    ':is(.dark) .mk-final-card::before',
    ':is(.dark) .mk-xband-grid',
  ] as const;

  it.each(REQUIRED_DARK_RHYTHM_SELECTORS)('overrides %s', (selector) => {
    expect(marketingHomeCss).toContain(`${selector} {`);
  });

  it('has no dark rhythm override beyond the nine — the only other `:is(.dark) .mk-…` family is the five .mk-mark-* bench-tile tints', () => {
    const total = countOccurrences(marketingHomeCss, ':is(.dark) .mk-');
    const markTintOverrides = countOccurrences(marketingHomeCss, ':is(.dark) .mk-mark-');
    expect(markTintOverrides).toBe(5);
    expect(total - markTintOverrides).toBe(9);
  });
});

/**
 * BAL-493 fix round 1 (UX MAJOR 1) — AC-7 row 10, the gradient CTA's hover crossfade.
 *
 * ⚠ THE PSEUDO-ELEMENT IS THE POINT. `.mk-btn-grad::before` declares its OWN
 * `transition: opacity 0.25s`, and a `transition-duration` set on the HOST (`.mk-btn`) does
 * not cascade into it — a pseudo-element inherits inheritable properties, and `transition` is
 * not one. The reduced-motion block therefore appeared to satisfy AC-7 while the crossfade
 * still ran at full duration. Both halves are asserted below: that the pseudo-element really
 * declares its own transition (so the host rule cannot possibly cover it), and that the
 * reduced-motion block carries a matching entry for it.
 */
describe('marketing-home.css — reduced motion reaches the gradient CTA pseudo-element', () => {
  const reducedBody = atRuleBody(marketingHomeCss, '@media (prefers-reduced-motion: reduce)');

  it('has a prefers-reduced-motion block', () => {
    expect(reducedBody).toBeDefined();
  });

  it('the pseudo-element declares its own transition outside the query (why the host rule is not enough)', () => {
    const base = firstRuleBody(marketingHomeCss, '.mk-btn-grad::before');
    expect(base).toBeDefined();
    expect(base ?? '').toContain('transition:');
  });

  it('damps the host .mk-btn transition (the entry that LOOKED sufficient)', () => {
    expect(reducedBody ?? '').toContain('.mk-page .mk-btn,');
  });

  it('ALSO damps .mk-page .mk-btn-grad::before', () => {
    const body = firstRuleBody(reducedBody ?? '', '.mk-page .mk-btn-grad::before');
    expect(body).toBeDefined();
    expect(body ?? '').toContain('transition-duration');
  });
});

describe('marketing-home.css — the bench-tile tint classes exist', () => {
  it.each(['blue', 'violet', 'teal', 'amber', 'slate'])('defines .mk-mark-%s', (tint) => {
    expect(marketingHomeCss).toContain(`.mk-mark-${tint} {`);
  });
});

describe('globals.css — the nine BAL-493 tokens exist in both :root and .dark', () => {
  const rootBody = firstRuleBody(globalsCss, ':root');
  const darkBody = firstRuleBody(globalsCss, '.dark');

  it('found both blocks', () => {
    expect(rootBody).toBeDefined();
    expect(darkBody).toBeDefined();
  });

  it.each(NEW_TOKENS)('--%s is declared in :root', (token) => {
    expect(declarationValue(rootBody ?? '', token)).toBeDefined();
  });

  it.each(NEW_TOKENS)('--%s is declared in .dark', (token) => {
    expect(declarationValue(darkBody ?? '', token)).toBeDefined();
  });

  it('the three composed tokens (--grad, --grad-hover, --ease) are :root-only', () => {
    expect(declarationValue(rootBody ?? '', 'grad')).toBeDefined();
    expect(declarationValue(rootBody ?? '', 'grad-hover')).toBeDefined();
    expect(declarationValue(rootBody ?? '', 'ease')).toBeDefined();
    expect(declarationValue(darkBody ?? '', 'grad')).toBeUndefined();
    expect(declarationValue(darkBody ?? '', 'grad-hover')).toBeUndefined();
    expect(declarationValue(darkBody ?? '', 'ease')).toBeUndefined();
  });
});

describe('globals.css — the D4 lightness/chroma ordering invariant', () => {
  const rootBody = firstRuleBody(globalsCss, ':root') ?? '';
  const darkBody = firstRuleBody(globalsCss, '.dark') ?? '';

  function requireOklch(blockText: string, token: string): { l: number; c: number } {
    const value = declarationValue(blockText, token);
    const parsed = value === undefined ? undefined : oklchLightnessChroma(value);
    if (parsed === undefined) {
      throw new Error(`--${token} did not parse as an oklch(...) value: ${String(value)}`);
    }
    return parsed;
  }

  it('light: L(--night) < L(--mist) < L(--background)', () => {
    const night = requireOklch(rootBody, 'night');
    const mist = requireOklch(rootBody, 'mist');
    const background = requireOklch(rootBody, 'background');
    expect(night.l).toBeLessThan(mist.l);
    expect(mist.l).toBeLessThan(background.l);
  });

  it('dark: L(--mist) < L(--background) < L(--night) — the inversion', () => {
    const mist = requireOklch(darkBody, 'mist');
    const background = requireOklch(darkBody, 'background');
    const night = requireOklch(darkBody, 'night');
    expect(mist.l).toBeLessThan(background.l);
    expect(background.l).toBeLessThan(night.l);
  });

  it('dark: C(--night) > C(--background) — the band is the most chromatic surface', () => {
    const night = requireOklch(darkBody, 'night');
    const background = requireOklch(darkBody, 'background');
    expect(night.c).toBeGreaterThan(background.c);
  });
});

describe('globals.css — the scoped smooth-scroll rule', () => {
  it('scopes scroll-behavior to .mk-page via :has(), not globally', () => {
    expect(globalsCss).toContain('html:has(.mk-page)');
    expect(globalsCss).not.toContain('html { scroll-behavior: smooth }');
  });
});

/**
 * BAL-582 — the dual-intent hero's sentence mode toggle and intent nudge (plan §8).
 * Same source-scan convention as the rest of this file: no regex, plain `indexOf`/
 * `includes` walks and the shared brace-parsing helpers above.
 */
describe('marketing-home.css — BAL-582 sentence toggle and nudge rules exist', () => {
  it.each([
    '.mk-sent',
    '.mk-sent-btn',
    '.mk-sent-flip',
    '.mk-sent-alt',
    '.mk-search-zone',
    '.mk-mode-hint',
    '.mk-nudge',
    '.mk-nudge-go',
    '.mk-nudge-x',
  ])('defines %s', (selector) => {
    expect(firstRuleBody(marketingHomeCss, selector)).toBeDefined();
  });

  it('rotates the flip chip when the toggle is pressed', () => {
    expect(marketingHomeCss).toContain(".mk-sent-btn[aria-pressed='true'] .mk-sent-flip {");
  });

  it('darkens the nudge CTA on hover', () => {
    const body = firstRuleBody(marketingHomeCss, '.mk-nudge-go:hover');
    expect(body).toBeDefined();
    expect(body ?? '').toContain('var(--violet-deep)');
    expect(body ?? '').toContain('var(--primary-foreground)');
  });
});

describe('marketing-home.css — BAL-582 adds a sixth staggered hero-inner child', () => {
  it('stages :nth-child(6) after the existing five', () => {
    const body = firstRuleBody(marketingHomeCss, '.mk-hero-inner > :nth-child(6)');
    expect(body).toBeDefined();
    expect(body ?? '').toContain('animation-delay: 0.54s');
  });
});

describe('marketing-home.css — BAL-582 keyframes for the tail fade and phrase roll', () => {
  it.each(['mk-fade', 'mk-roll'])('defines @keyframes %s', (name) => {
    expect(marketingHomeCss).toContain(`@keyframes ${name} {`);
  });
});

describe('marketing-home.css — BAL-582 responsive and tap-target rules', () => {
  it('the 520px sentence query hides the tail and gives the phrase button a tap target', () => {
    const body = atRuleBody(marketingHomeCss, '@media (max-width: 520px)');
    expect(body).toBeDefined();
    expect(firstRuleBody(body ?? '', '.mk-sent-alt')).toContain('display: none');
    expect(firstRuleBody(body ?? '', '.mk-sent-btn')).toContain('min-height: 44px');
  });

  it('gives the nudge dismiss button a 24px+ tap target (WCAG 2.5.8)', () => {
    expect(firstRuleBody(marketingHomeCss, '.mk-nudge-x') ?? '').toContain('padding: 6px');
  });

  it('wraps the nudge pill at narrow widths so no label breaks mid-phrase', () => {
    const body = atRuleBody(marketingHomeCss, '@media (max-width: 520px)');
    expect(body).toBeDefined();
    const nudgeBody = firstRuleBody(body ?? '', '.mk-nudge');
    expect(nudgeBody).toBeDefined();
    expect(nudgeBody ?? '').toContain('flex-wrap: wrap');
    expect(nudgeBody ?? '').toContain('white-space: nowrap');
    const nudgeGoBody = firstRuleBody(body ?? '', '.mk-nudge-go');
    expect(nudgeGoBody ?? '').toContain('white-space: nowrap');
  });

  it('hides the dead toggle when there is no active scripting', () => {
    const body = atRuleBody(marketingHomeCss, '@media (scripting: none)');
    expect(body).toBeDefined();
    expect(firstRuleBody(body ?? '', '.mk-sent')).toContain('display: none');
  });
});

describe('marketing-home.css — BAL-582 reduced motion covers the toggle and the nudge', () => {
  const reducedBody = atRuleBody(marketingHomeCss, '@media (prefers-reduced-motion: reduce)');

  it('stops the nudge and sentence-word animations', () => {
    expect(reducedBody ?? '').toContain('.mk-page .mk-nudge,');
    expect(reducedBody ?? '').toContain('.mk-page .mk-sent-word,');
    expect(reducedBody ?? '').toContain('.mk-page .mk-sent-alt-word');
  });

  it('damps the flip, tail-hover and nudge-CTA transitions, without dropping .mk-btn', () => {
    expect(reducedBody ?? '').toContain('.mk-page .mk-btn,');
    expect(reducedBody ?? '').toContain('.mk-page .mk-sent-flip');
    expect(reducedBody ?? '').toContain('.mk-page .mk-sent-alt button');
    expect(reducedBody ?? '').toContain('.mk-page .mk-nudge-go,');
    expect(reducedBody ?? '').toContain('.mk-page .mk-nudge-go svg');
  });
});

describe('marketing-home.css — the Popular chips stay on ONE row', () => {
  it('never wraps: nowrap + sideways scroll, spanning the search bar width', () => {
    const body = firstRuleBody(marketingHomeCss, '.mk-chips') ?? '';
    expect(body).toContain('flex-wrap: nowrap');
    expect(body).toContain('overflow-x: auto');
    expect(body).toContain('max-width: 760px');
    expect(firstRuleBody(marketingHomeCss, '.mk-chips > *') ?? '').toContain('flex-shrink: 0');
  });

  it('centres with end-child auto margins, never justify-content (unreachable overflow)', () => {
    expect(firstRuleBody(marketingHomeCss, '.mk-chips') ?? '').not.toContain('justify-content');
    expect(firstRuleBody(marketingHomeCss, '.mk-chips > :first-child') ?? '').toContain(
      'margin-left: auto'
    );
    expect(firstRuleBody(marketingHomeCss, '.mk-chips > :last-child') ?? '').toContain(
      'margin-right: auto'
    );
  });

  it('the 820px query tightens the chips and bleeds the row through the 24px hero padding', () => {
    const body = atRuleBody(marketingHomeCss, '@media (max-width: 820px)');
    expect(body).toBeDefined();
    const chipsBody = firstRuleBody(body ?? '', '.mk-chips') ?? '';
    expect(chipsBody).toContain('margin-left: -24px');
    expect(chipsBody).toContain('padding-left: 24px');
    expect(firstRuleBody(body ?? '', '.mk-chip') ?? '').toContain('padding: 7px 11px');
  });

  it('fades the right edge in the 820px query, so a hidden scrollbar still hints more chips are off-screen', () => {
    const body = atRuleBody(marketingHomeCss, '@media (max-width: 820px)');
    const chipsBody = firstRuleBody(body ?? '', '.mk-chips') ?? '';
    expect(chipsBody).toContain('mask-image: linear-gradient(to right, black 88%, transparent)');
    expect(chipsBody).toContain(
      '-webkit-mask-image: linear-gradient(to right, black 88%, transparent)'
    );
  });
});
