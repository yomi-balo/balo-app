import { describe, expect, it } from 'vitest';
import { resolveRouteDir, scanRouteSources } from './_source-scan';

/**
 * BAL-618 — "Flat everywhere", repo-wide: no class expression in `apps/web/src` both draws a card
 * surface and elevates it.
 *
 * `flat-card-surfaces.test.ts` pins the files that DEFINE a card; this scan catches the inline
 * sites that never went through one. A unit is either one `className=` value (a string, or the
 * whole `{…}` expression, so a `cn()` that splits the surface and the shadow across arguments
 * is still one unit) or one string literal anywhere else (a class constant). A unit is a card
 * when it carries a `bg-card` token, calls `baloCardClassName(`, or is the `className` of a card
 * component (`BaloCard`, `Card`, `RequestCard`, `SectionCard`). It is elevated when it carries a
 * `shadow` utility under any variants and with either `!` (`shadow-sm`, `hover:shadow-md`,
 * `data-[state=open]:shadow`, `@md:!shadow-lg`); `shadow-none` and `transition-shadow` are not
 * elevation.
 *
 * `bg-card` also paints things that are not cards and legitimately keep a shadow: active tabs,
 * sticky bars, tooltips and overlays. Those live in {@link ALLOWED}, per file with an exact
 * count and a reason, so a new elevated card anywhere fails here, and so does an allowlist
 * entry whose site has gone.
 */

const CARD_COMPONENTS = new Set(['BaloCard', 'Card', 'RequestCard', 'SectionCard']);
/**
 * A variant run is any `…:` segments (`md:`, `data-[state=open]:`, `group-hover/card:`, `@md:`,
 * `has-[a:b]:`); `!` important may lead (v3) or trail (v4).
 */
const SHADOW =
  /(?:^|[\s'"`])(?:[^\s'"`:]+:)*!?shadow(?:-(?!none!?(?=[\s'"`]|$))[^\s'"`]+)?!?(?=[\s'"`]|$)/;
const BG_CARD = /(?:^|[\s'"`])(?:[^\s'"`:]+:)*!?bg-card(?:\/\d+)?!?(?=[\s'"`]|$)/;

interface Allowed {
  readonly count: number;
  readonly reason: string;
}

const ACTIVE_TAB = 'the active tab or segment of a switcher, not a card';

/** Elevated `bg-card` units that are not cards, keyed by path relative to `apps/web/src`. */
const ALLOWED: Readonly<Record<string, Allowed>> = {
  'app/(dashboard)/admin/_components/admin-section-nav.tsx': { count: 1, reason: ACTIVE_TAB },
  'app/(dashboard)/expert/calendar/_components/calendar-view-switcher.tsx': {
    count: 1,
    reason: ACTIVE_TAB,
  },
  'app/(dashboard)/expert/settings/_components/rate-tab.tsx': { count: 1, reason: ACTIVE_TAB },
  'app/(dashboard)/expert/settings/_components/settings-tabs.tsx': { count: 1, reason: ACTIVE_TAB },
  'app/(dashboard)/projects/_components/lens-switch.tsx': { count: 1, reason: ACTIVE_TAB },
  'app/(dashboard)/settings/_components/settings-section-nav.tsx': { count: 1, reason: ACTIVE_TAB },
  'components/balo/project-request/proposal/pricing-section.tsx': { count: 1, reason: ACTIVE_TAB },
  'components/search/results-toolbar.tsx': { count: 1, reason: ACTIVE_TAB },
  'app/(dashboard)/admin/staff-access/_components/staff-access-detail.tsx': {
    count: 3,
    reason: 'two active segments of the follow/custom switcher, and the sticky save bar',
  },
  'app/(dashboard)/admin/applications/_components/edit/edit-save-bar.tsx': {
    count: 2,
    reason: 'the sticky save bar and the change list it opens above itself',
  },
  'components/availability/availability-slots-panel.tsx': {
    count: 1,
    reason: 'the mobile sticky footer (flat from md up)',
  },
  'app/(dashboard)/dashboard/_components/track-term.tsx': { count: 1, reason: 'a tooltip' },
  'components/balo/meetings/meeting-overlay.tsx': {
    count: 1,
    reason: 'a dialog/sheet layer over the meeting page',
  },
  'app/(call)/meetings/[meetingId]/call/_components/call-client.tsx': {
    count: 1,
    reason: 'a translucent notice floating over the video stage',
  },
  'app/(marketing)/experts/[username]/_components/booking-card.tsx': {
    count: 1,
    reason: 'sticky and pulled over the profile hero by a negative margin: a floating layer',
  },
  'components/search/composer/unified-bar.tsx': {
    count: 1,
    reason: 'the search bar, which keeps its shadow (BAL-618 OQ2)',
  },
  'components/search/composer/mobile-composer-bar.tsx': {
    count: 1,
    reason: 'the mobile search bar, which keeps its shadow (BAL-618 OQ2)',
  },
  'app/(dashboard)/expert/settings/_components/calendar-o365-guidance-modal.tsx': {
    count: 1,
    reason: 'a 40px icon tile in a dialog header, not a card',
  },
};

/** The index just past the `}` that closes the `{` at `open`, or -1. */
function closingBrace(code: string, open: number): number {
  let depth = 0;
  for (let i = open; i < code.length; i += 1) {
    if (code[i] === '{') depth += 1;
    else if (code[i] === '}') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/** The JSX tag name whose attribute list `index` sits in, or `''`. */
function enclosingTag(code: string, index: number): string {
  const open = code.lastIndexOf('<', index);
  return open === -1 ? '' : (/^<([A-Za-z][\w.]*)/.exec(code.slice(open))?.[1] ?? '');
}

interface Unit {
  readonly text: string;
  readonly isCardComponent: boolean;
}

/** Every `className=` value, then every string literal outside those values. */
function classUnitsOf(code: string): Unit[] {
  const units: Unit[] = [];
  const covered: Array<readonly [number, number]> = [];
  for (const match of code.matchAll(/className=/g)) {
    const start = match.index + match[0].length;
    const quote = code[start];
    let end = -1;
    if (quote === '{') end = closingBrace(code, start);
    else if (quote === '"' || quote === "'") end = code.indexOf(quote, start + 1) + 1;
    if (end <= 0) continue;
    covered.push([start, end]);
    units.push({
      text: code.slice(start, end),
      isCardComponent: CARD_COMPONENTS.has(enclosingTag(code, match.index)),
    });
  }
  for (const match of code.matchAll(/'[^'\n]*'|"[^"\n]*"|`[^`]*`/g)) {
    const at = match.index;
    if (covered.some(([from, to]) => at >= from && at < to)) continue;
    units.push({ text: match[0], isCardComponent: false });
  }
  return units;
}

function isElevatedCard(unit: Unit): boolean {
  if (!SHADOW.test(unit.text)) return false;
  return (
    unit.isCardComponent || BG_CARD.test(unit.text) || unit.text.includes('baloCardClassName(')
  );
}

const ROOT = resolveRouteDir(['src', 'apps/web/src']);
const FILES = scanRouteSources(ROOT, '', ['node_modules', 'invariants', 'test']);

const FOUND: Record<string, string[]> = {};
for (const file of FILES) {
  const hits = classUnitsOf(file.code)
    .filter(isElevatedCard)
    .map((unit) => unit.text.replaceAll(/\s+/g, ' '));
  if (hits.length > 0) FOUND[file.rel] = hits;
}

describe('invariant: no elevated card surface anywhere in apps/web (BAL-618)', () => {
  it('guards the guard: the walk reads the web source tree', () => {
    expect(ROOT).not.toBe('');
    expect(FILES.length).toBeGreaterThan(500);
    expect(FILES.some((file) => file.rel === 'components/balo/card/balo-card.tsx')).toBe(true);
  });

  it('guards the guard: the matcher flags an elevated card and passes a flat one', () => {
    const flagged = (code: string): number => classUnitsOf(code).filter(isElevatedCard).length;
    expect(flagged(`<div className="bg-card rounded-2xl border shadow-sm" />`)).toBe(1);
    expect(flagged(`<div className={cn('bg-card border', open && 'hover:shadow-md')} />`)).toBe(1);
    expect(flagged(`<Card className="p-0 dark:shadow-[0_1px_2px_#000]" />`)).toBe(1);
    expect(flagged(`<li className={cn(baloCardClassName(), 'shadow-lg')} />`)).toBe(1);
    expect(flagged(`const CHROME = 'bg-card/95 border shadow';`)).toBe(1);
    expect(flagged(`<div className="bg-card data-[state=open]:shadow-md" />`)).toBe(1);
    expect(flagged(`<div className="bg-card group-hover/card:shadow-md" />`)).toBe(1);
    expect(flagged(`<div className="bg-card @md:shadow" />`)).toBe(1);
    expect(flagged(`<div className="bg-card !shadow-sm" />`)).toBe(1);
    expect(flagged(`<div className="bg-card shadow-sm!" />`)).toBe(1);
    expect(flagged(`<div className="bg-card has-[button:focus-visible]:shadow" />`)).toBe(1);
    expect(flagged(`<div className="data-[state=open]:!bg-card border shadow" />`)).toBe(1);
    expect(flagged(`<div className="bg-card border transition-shadow shadow-none" />`)).toBe(0);
    expect(flagged(`<div className="bg-card border md:shadow-none!" />`)).toBe(0);
    expect(flagged(`<div className="bg-card border" /><Button className="shadow-sm" />`)).toBe(0);
  });

  it('every elevated bg-card unit is an allowlisted non-card, at its exact count', () => {
    const counts = Object.fromEntries(
      Object.entries(FOUND).map(([rel, hits]) => [rel, hits.length])
    );
    const allowed = Object.fromEntries(
      Object.entries(ALLOWED).map(([rel, entry]) => [rel, entry.count])
    );
    expect(
      counts,
      `An elevated card surface: BAL-618 "Flat everywhere" draws cards as a border with no ` +
        `shadow. Drop the shadow (use BaloCard / baloCardClassName), or, if this is a floating ` +
        `layer or other non-card, add it to ALLOWED with a reason.\n` +
        JSON.stringify(FOUND, null, 2)
    ).toEqual(allowed);
  });
});
