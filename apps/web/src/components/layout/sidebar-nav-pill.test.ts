import { describe, it, expect } from 'vitest';
import {
  SIDEBAR_NAV_ROW_HEIGHT_PX,
  SIDEBAR_NAV_ROW_GAP_PX,
  SIDEBAR_NAV_ROW_PITCH_PX,
  resolveSidebarNavPill,
} from './sidebar-nav-pill';

const PRIMARY = ['/dashboard', '/experts', '/consultations', '/projects', '/messages'];

describe('sidebar-nav-pill (BAL-497)', () => {
  it('THE PITCH PIN: 44px row (h-11) + 4px gap (gap-1) = 48px', () => {
    // If you change `h-11` on `sidebar-nav-link.tsx` or `gap-1` on `SidebarNavSection`'s row
    // stack, change these constants too — and see `sidebar-nav-section.test.tsx`'s class-side
    // half of this same pin.
    expect(SIDEBAR_NAV_ROW_HEIGHT_PX).toBe(44);
    expect(SIDEBAR_NAV_ROW_GAP_PX).toBe(4);
    expect(SIDEBAR_NAV_ROW_PITCH_PX).toBe(48);
  });

  it.each([
    ['/dashboard', 0, 0, true],
    ['/experts', 1, 48, true],
    ['/consultations', 2, 96, true],
    ['/projects', 3, 144, true],
    ['/messages', 4, 192, true],
  ] as const)(
    'pathname %s resolves to activeIndex %i, offsetPx %i, isVisible %s',
    (pathname, activeIndex, offsetPx, isVisible) => {
      expect(resolveSidebarNavPill(PRIMARY, pathname)).toEqual({
        activeIndex,
        offsetPx,
        isVisible,
      });
    }
  );

  it('a nested route lights its parent row', () => {
    expect(resolveSidebarNavPill(PRIMARY, '/projects/req-1')).toEqual({
      activeIndex: 3,
      offsetPx: 144,
      isVisible: true,
    });
  });

  it('the /dashboard exact-match carve-out is inherited from isNavItemActive, not re-implemented', () => {
    expect(resolveSidebarNavPill(PRIMARY, '/dashboard/x')).toEqual({
      activeIndex: -1,
      offsetPx: 0,
      isVisible: false,
    });
  });

  // The D5 "no pill" class — routes no entry in EITHER section prefix-matches. `account` is
  // deliberately excluded: it IS a secondary registry entry and DOES light that section's pill.
  it.each([
    '/cases/abc',
    '/meetings/abc',
    '/engagements',
    '/redeem',
    '/promo-codes',
    '/billing/top-up',
  ])('pathname %s is outside this section entirely', (pathname) => {
    expect(resolveSidebarNavPill(PRIMARY, pathname)).toEqual({
      activeIndex: -1,
      offsetPx: 0,
      isVisible: false,
    });
  });

  it('an empty section resolves without throwing', () => {
    expect(resolveSidebarNavPill([], '/dashboard')).toEqual({
      activeIndex: -1,
      offsetPx: 0,
      isVisible: false,
    });
  });

  it('longest match wins, not first — findIndex would park the pill on the shallower parent', () => {
    // Both '/settings' and '/settings/account' match '/settings/account' under the
    // prefix-with-separator rule. Both links tint (BAL-495's per-link rule, out of scope here),
    // but there is only one pill — it must resolve to the MOST SPECIFIC row.
    expect(
      resolveSidebarNavPill(['/settings', '/settings/account'], '/settings/account').activeIndex
    ).toBe(1);
  });

  it('order-independence of the same rule — proves it is longest-href, not last-index', () => {
    expect(
      resolveSidebarNavPill(['/settings/account', '/settings'], '/settings/account').activeIndex
    ).toBe(0);
  });
});
