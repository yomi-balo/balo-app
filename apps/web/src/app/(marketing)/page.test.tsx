import { readFileSync } from 'node:fs';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@/test/utils';
import { axe } from 'jest-axe';
import { resolveRouteDir } from '@/invariants/_source-scan';
import type { MarketingHomeData } from '@/lib/marketing/load-home-data';
import MarketingLayout from './layout';
import MarketingHomePage, { metadata } from './page';
import { AppFooter } from '@/components/layout/app-footer';
import * as ogImage from './opengraph-image';

const { mockLoadHomeData, mockGetCurrentUser } = vi.hoisted(() => ({
  mockLoadHomeData: vi.fn(),
  mockGetCurrentUser: vi.fn(),
}));

vi.mock('@/lib/marketing/load-home-data', () => ({ loadHomeData: mockLoadHomeData }));
vi.mock('@/lib/auth/session', () => ({ getCurrentUser: mockGetCurrentUser }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/hooks/use-auth-modal', () => ({ useAuthModal: () => ({ open: vi.fn() }) }));
// The real bell fetches /api/notifications on mount — irrelevant here (viewer is null anyway).
vi.mock('@/components/balo/notification-bell', () => ({ NotificationBell: () => null }));

function makeHomeData(overrides: Partial<MarketingHomeData> = {}): MarketingHomeData {
  return {
    taxonomy: { groups: [{ id: 'g-ai', name: 'AI', items: [{ id: 'p1', name: 'Agentforce' }] }] },
    productNameMap: { p1: 'Agentforce' },
    chips: [{ id: 'p1', name: 'Agentforce' }],
    benchTiles: [],
    expertTotal: 42,
    wasAvailabilityGated: false,
    spotlight: [],
    ...overrides,
  };
}

/**
 * The full assembled ROUTE, not just `page.tsx` in isolation — AC-9's landmark/uniqueness
 * claims (one `banner`, one `main`, one UNIQUE `contentinfo`) are properties of the composed
 * `(marketing)/layout.tsx` + `(marketing)/page.tsx` + the ROOT layout's `<AppFooter/>`, exactly
 * as Next.js actually assembles them. `AppFooter` returning `null` on `/` (P4a's fix, BAL-493
 * §13.3) is precisely what this test proves — rendering only `page.tsx` would make the
 * uniqueness assertion vacuously true regardless of whether that fix existed.
 */
async function renderAssembledRoute() {
  const pageUi = await MarketingHomePage();
  const layoutUi = await MarketingLayout({ children: pageUi });
  return render(
    <>
      {layoutUi}
      <AppFooter />
    </>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadHomeData.mockResolvedValue(makeHomeData());
  mockGetCurrentUser.mockResolvedValue(null);
});

afterEach(() => {
  document.documentElement.classList.remove('dark');
});

describe('(marketing)/ — assembled route landmarks (AC-9)', () => {
  it('renders exactly one h1', async () => {
    await renderAssembledRoute();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });

  it('renders exactly one banner, one main, and one UNIQUE contentinfo landmark', async () => {
    await renderAssembledRoute();
    expect(screen.getAllByRole('banner')).toHaveLength(1);
    expect(screen.getAllByRole('main')).toHaveLength(1);
    // The root layout's <AppFooter/> must suppress itself here (P4a) — the page's OWN
    // <MarketingFooter/> is the only contentinfo landmark. Two would be an axe violation
    // (landmark-no-duplicate-contentinfo) and a real screen-reader defect.
    expect(screen.getAllByRole('contentinfo')).toHaveLength(1);
  });

  it('the <main> is the .mk-page rhythm root', async () => {
    const { container } = await renderAssembledRoute();
    expect(container.querySelector('main.mk-page')).not.toBeNull();
  });
});

describe('(marketing)/ — accessibility (AC-9)', () => {
  it('has no accessibility violations in light mode', async () => {
    const { container } = await renderAssembledRoute();
    expect(await axe(container)).toHaveNoViolations();
  }, 15000);

  it('has no accessibility violations in dark mode', async () => {
    document.documentElement.classList.add('dark');
    const { container } = await renderAssembledRoute();
    expect(await axe(container)).toHaveNoViolations();
  }, 15000);
});

describe('(marketing)/ — metadata (AC-9)', () => {
  it('sets a title, a description, and a canonical alternate', () => {
    expect(metadata.title).toBe('Top Salesforce experts, on demand — Balo');
    expect(typeof metadata.description).toBe('string');
    expect((metadata.description as string).length).toBeGreaterThan(20);
    expect(metadata.alternates?.canonical).toBe('/');
  });
});

describe('(marketing)/opengraph-image — OG image contract (AC-9)', () => {
  it('exports size, alt, and contentType', () => {
    expect(ogImage.size).toEqual({ width: 1200, height: 630 });
    expect(typeof ogImage.alt).toBe('string');
    expect(ogImage.alt.length).toBeGreaterThan(0);
    expect(ogImage.contentType).toBe('image/png');
  });
});

describe('(marketing)/ — every mk- keyframe is transform/opacity-only (no layout shift, AC-9)', () => {
  const HOME_DIR = resolveRouteDir([
    'src/app/(marketing)/_home',
    'apps/web/src/app/(marketing)/_home',
  ]);
  const css = HOME_DIR === '' ? '' : readFileSync(`${HOME_DIR}/marketing-home.css`, 'utf8');

  /** Every `@keyframes mk-*` name declared in `source`, in source order. A plain character
   * walk (no regex, S5852): finds the marker, then reads forward to the next space or `{`. */
  function markKeyframeNames(source: string): string[] {
    const marker = '@keyframes mk-';
    const names: string[] = [];
    let i = source.indexOf(marker);
    while (i !== -1) {
      const nameStart = i + '@keyframes '.length;
      let end = nameStart;
      while (end < source.length && source[end] !== ' ' && source[end] !== '{') end += 1;
      names.push(source.slice(nameStart, end));
      i = source.indexOf(marker, end);
    }
    return names;
  }

  /** The full body of `@keyframes ${name} { ... }`, matching NESTED braces (`from {}`/`to {}`/
   * percentage blocks) via brace-depth counting — a naive first-`}` `indexOf` would truncate at
   * the first inner block's close. No regex. */
  function keyframesBody(source: string, name: string): string {
    const marker = `@keyframes ${name} {`;
    const start = source.indexOf(marker);
    if (start === -1) return '';
    let depth = 1;
    let i = start + marker.length;
    const bodyStart = i;
    while (i < source.length && depth > 0) {
      if (source[i] === '{') depth += 1;
      else if (source[i] === '}') depth -= 1;
      i += 1;
    }
    return source.slice(bodyStart, i - 1);
  }

  it('found marketing-home.css with non-trivial content', () => {
    expect(css.length).toBeGreaterThan(1000);
  });

  it('declares at least one mk- keyframe (guards the two helpers above against a silent no-op)', () => {
    expect(markKeyframeNames(css).length).toBeGreaterThan(0);
  });

  it.each(['width:', 'height:', 'top:', 'left:', 'margin:'])(
    'no mk- keyframe touches the layout property "%s"',
    (layoutProp) => {
      for (const name of markKeyframeNames(css)) {
        const body = keyframesBody(css, name);
        expect(body.length, `@keyframes ${name} had an empty body`).toBeGreaterThan(0);
        expect(body.includes(layoutProp), `@keyframes ${name} touches ${layoutProp}`).toBe(false);
      }
    }
  );
});
