import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { resolveRouteDir, stripBlockComments } from '@/invariants/_source-scan';

/**
 * The three SOFT Badge variants (`success` / `warning` / `info`) put status text on a 10-15%
 * wash of its own hue. That composition is where a status palette tuned for FILLS and ICONS
 * quietly falls below the readable floor: measured against `--card`, the plain tokens give
 * 3.00:1 (success), 1.91:1 (warning) and 3.27:1 (info) in light mode, and the pills render at
 * 11px, where WCAG AA asks 4.5:1. The `--*-strong` tokens exist for exactly this composition.
 *
 * ⚠ THIS TEST COMPUTES THE RATIO, it does not pin a class name. A class-name assertion would
 * survive any retune of the OKLCH values, which is the change most likely to reintroduce the
 * problem. Both halves are asserted: the tokens are read out of `globals.css` and converted,
 * and `badge.tsx` is scanned to confirm the variants actually SPEND them.
 *
 * ⚠ jsdom has no layout or colour engine, so nothing here can come from a rendered component —
 * the stylesheet text and a colour-space conversion are the only available ground truth.
 */

const APP_DIR = resolveRouteDir(['src/app', 'apps/web/src/app']);
const UI_DIR = resolveRouteDir(['src/components/ui', 'apps/web/src/components/ui']);

const globalsCss = stripBlockComments(
  APP_DIR === '' ? '' : readFileSync(`${APP_DIR}/globals.css`, 'utf8')
);
const badgeSource = UI_DIR === '' ? '' : readFileSync(`${UI_DIR}/badge.tsx`, 'utf8');

/** WCAG AA for text below 18.66px. The pills are 11px (`text-xs`), so the large-text 3:1 floor
 *  does not apply to them. */
const AA_SMALL_TEXT = 4.5;

type Rgb = readonly [number, number, number];

/**
 * The body of the first `${selector} {` rule. Every block read here is flat, so a single
 * `indexOf('}')` is a correct parse. The trailing space before `{` is load-bearing: without it
 * `:root {` would also match inside `:root:not(...)  {`.
 */
function ruleBody(css: string, selector: string): string {
  const open = css.indexOf(`${selector} {`);
  if (open === -1) return '';
  const start = open + selector.length + 2;
  const close = css.indexOf('}', start);
  return close === -1 ? '' : css.slice(start, close);
}

/** The `oklch(L C H)` triple declared for `--name` in `body`. Throws rather than defaulting —
 *  a token that has silently vanished must fail loudly, not measure as black. */
function oklchToken(body: string, name: string): readonly [number, number, number] {
  const at = body.indexOf(`--${name}: oklch(`);
  if (at === -1) throw new Error(`--${name} is not declared as a literal oklch() value`);
  const start = at + `--${name}: oklch(`.length;
  const close = body.indexOf(')', start);
  const parts = body
    .slice(start, close)
    .split(' ')
    .filter((part) => part !== '')
    .map(Number);
  const [l, c, h] = parts;
  if (l === undefined || c === undefined || h === undefined) {
    throw new Error(
      `--${name}: expected three oklch components, got "${body.slice(start, close)}"`
    );
  }
  return [l, c, h];
}

/** OKLCH → sRGB (D65), clamped into gamut — the same transform the browser applies. */
function oklchToSrgb([lightness, chroma, hueDeg]: readonly [number, number, number]): Rgb {
  const hue = (hueDeg * Math.PI) / 180;
  const a = chroma * Math.cos(hue);
  const b = chroma * Math.sin(hue);
  const lCone = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const mCone = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const sCone = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const linear = [
    4.0767416621 * lCone - 3.3077115913 * mCone + 0.2309699292 * sCone,
    -1.2684380046 * lCone + 2.6097574011 * mCone - 0.3413193965 * sCone,
    -0.0041960863 * lCone - 0.7034186147 * mCone + 1.707614701 * sCone,
  ];
  const encode = (channel: number): number => {
    const clamped = Math.max(channel, 0);
    const encoded =
      clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * Math.pow(clamped, 1 / 2.4) - 0.055;
    return Math.min(1, Math.max(0, encoded));
  };
  return [encode(linear[0] ?? 0), encode(linear[1] ?? 0), encode(linear[2] ?? 0)];
}

function relativeLuminance([r, g, b]: Rgb): number {
  const toLinear = (channel: number): number =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

function contrastRatio(foreground: Rgb, background: Rgb): number {
  const first = relativeLuminance(foreground);
  const second = relativeLuminance(background);
  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);
  return (lighter + 0.05) / (darker + 0.05);
}

/** `tint` at `alpha` composited over `base` — what `bg-warning/15` on a card actually paints. */
function composite(tint: Rgb, alpha: number, base: Rgb): Rgb {
  return [
    alpha * tint[0] + (1 - alpha) * base[0],
    alpha * tint[1] + (1 - alpha) * base[1],
    alpha * tint[2] + (1 - alpha) * base[2],
  ];
}

/**
 * One soft variant: its tint token, the alpha `badge.tsx` washes it at, and the class the
 * variant must spend on text. The alphas are re-asserted against the variant strings below, so
 * a retune of `bg-warning/15` cannot leave this measuring a background nothing paints.
 */
const SOFT_VARIANTS = [
  { name: 'success', alpha: 0.1, background: 'bg-success/10', text: 'text-success-strong' },
  { name: 'warning', alpha: 0.15, background: 'bg-warning/15', text: 'text-warning-strong' },
  { name: 'info', alpha: 0.1, background: 'bg-info/10', text: 'text-info-strong' },
] as const;

const lightRoot = ruleBody(globalsCss, ':root');
const darkRoot = ruleBody(globalsCss, '.dark');

describe('soft Badge variants clear AA on their own tint', () => {
  it('reads both token blocks out of globals.css', () => {
    expect(lightRoot.length).toBeGreaterThan(100);
    expect(darkRoot.length).toBeGreaterThan(100);
    expect(badgeSource.length).toBeGreaterThan(100);
  });

  it.each(SOFT_VARIANTS)('$name: light-mode text on its tint clears $text', ({ name, alpha }) => {
    const card = oklchToSrgb(oklchToken(lightRoot, 'card'));
    const tint = oklchToSrgb(oklchToken(lightRoot, name));
    const text = oklchToSrgb(oklchToken(lightRoot, `${name}-strong`));
    expect(contrastRatio(text, composite(tint, alpha, card))).toBeGreaterThanOrEqual(AA_SMALL_TEXT);
  });

  /**
   * ⚠ DARK MODE ALIASES `--*-strong` TO THE PLAIN TOKEN, so this resolves the alias by hand
   * rather than parsing `var(--success)`. Darkening here would REDUCE contrast, and this is what
   * notices someone "fixing" the aliases toward the light values.
   */
  it.each(SOFT_VARIANTS)('$name: dark-mode text on its tint clears AA', ({ name, alpha }) => {
    expect(darkRoot).toContain(`--${name}-strong: var(--${name});`);
    const card = oklchToSrgb(oklchToken(darkRoot, 'card'));
    const tint = oklchToSrgb(oklchToken(darkRoot, name));
    expect(contrastRatio(tint, composite(tint, alpha, card))).toBeGreaterThanOrEqual(AA_SMALL_TEXT);
  });

  /**
   * ⚠ WITHOUT THIS, EVERY RATIO ABOVE MEASURES TOKENS NOTHING SPENDS — `badge.tsx` could name
   * `text-warning` and the whole suite would stay green.
   */
  it.each(SOFT_VARIANTS)('$name: badge.tsx spends $text on $background', (variant) => {
    const declaration = `${variant.name}: 'border-${variant.name}/`;
    const at = badgeSource.indexOf(declaration);
    expect(at, `badge.tsx declares no soft "${variant.name}" variant`).toBeGreaterThan(-1);
    const classes = badgeSource.slice(at, badgeSource.indexOf("'", at + declaration.length));
    expect(classes).toContain(variant.background);
    expect(classes).toContain(variant.text);
    // The plain token must be gone from the TEXT slot — `border-warning/30` still names it.
    expect(classes).not.toContain(`text-${variant.name}'`);
    expect(classes).not.toContain(`text-${variant.name} `);
  });
});
