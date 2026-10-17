import type { Locator, Page } from '@playwright/test';

export type HelpScheme = 'light' | 'dark';

/** Tokens pinned from the design reference (`help-centre.jsx`: Ring L1103-1137, palette L31-78). */
const RING_TOKENS: Record<
  HelpScheme,
  { card: string; primary: string; violet: string; glow: string }
> = {
  light: { card: '#FFFFFF', primary: '#2563EB', violet: '#7C3AED', glow: 'rgba(37,99,235,0.16)' },
  dark: { card: '#111729', primary: '#4A85F2', violet: '#8B5CF6', glow: 'rgba(74,133,242,0.24)' },
};

/** Pixels the overlay reaches beyond the target: 9px glow, or the badge's 11px offset + 2px edge. */
export const RING_OUTSET = 13;

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface DrawArgs {
  box: Box;
  section: number;
  radius: string;
  tokens: (typeof RING_TOKENS)[HelpScheme];
}

/**
 * Appends the ring + numbered badge to `document.body` in DOCUMENT coordinates, so it stays
 * registered with the target. Returns nothing; {@link removeRing} deletes it.
 */
export async function drawRing(
  page: Page,
  target: Locator,
  scheme: HelpScheme,
  section: number,
  box: Box,
  radius: number | undefined
): Promise<void> {
  const computedRadius =
    radius === undefined
      ? await target.evaluate((el) => getComputedStyle(el).borderRadius)
      : `${radius}px`;
  const args: DrawArgs = { box, section, radius: computedRadius, tokens: RING_TOKENS[scheme] };
  await page.evaluate(({ box: b, section: n, radius: r, tokens: t }: DrawArgs) => {
    const ring = document.createElement('div');
    ring.id = 'help-ring';
    ring.dataset.helpRing = '';
    ring.style.cssText = [
      'position:absolute',
      `top:${b.y + window.scrollY}px`,
      `left:${b.x + window.scrollX}px`,
      `width:${b.width}px`,
      `height:${b.height}px`,
      'z-index:2147483647',
      'pointer-events:none',
      'background:transparent',
      `border-radius:${r}`,
      `box-shadow:0 0 0 2px ${t.card}, 0 0 0 4px ${t.primary}, 0 0 0 9px ${t.glow}`,
    ].join(';');

    const family = `Geist, ${getComputedStyle(document.body).fontFamily}`;
    const badge = document.createElement('span');
    badge.dataset.helpRing = '';
    badge.textContent = String(n);
    badge.style.cssText = [
      'position:absolute',
      'top:-11px',
      'right:-11px',
      'width:22px',
      'height:22px',
      'border-radius:999px',
      'display:flex',
      'align-items:center',
      'justify-content:center',
      `background:linear-gradient(135deg, ${t.primary}, ${t.violet})`,
      'color:#fff',
      `font:700 11px/1 ${family}`,
      `box-shadow:0 0 0 2px ${t.card}`,
    ].join(';');
    ring.appendChild(badge);
    document.body.appendChild(ring);
  }, args);
}

/** Removes every ring node and returns how many remain (must be 0). */
export function removeRing(page: Page): Promise<number> {
  return page.evaluate(() => {
    document.querySelectorAll('[data-help-ring]').forEach((node) => node.remove());
    return document.querySelectorAll('[data-help-ring]').length;
  });
}

/** `<nn>` in `<nn>-{light,dark}.png` and in the guide's `](nn)` image refs. */
export function paddedSection(section: number): string {
  return String(section).padStart(2, '0');
}
