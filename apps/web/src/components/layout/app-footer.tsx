'use client';

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { getVersionString, APP_VERSION } from '@/lib/version';
import { isMeetingCallPath } from '@/lib/meetings/is-meeting-call-path';
import { isMarketingHomePath } from '@/lib/marketing/is-marketing-home-path';

export function AppFooter() {
  const pathname = usePathname();
  const isCallSurface = isMeetingCallPath(pathname ?? '');
  const isMarketingHome = isMarketingHomePath(pathname ?? '');

  useEffect(() => {
    console.log(
      `%c Balo ${getVersionString()} `,
      'background: #111; color: #fff; padding: 2px 6px; border-radius: 3px;'
    );
  }, []);

  /**
   * ⚠⚠ TWO INDEPENDENT REASONS TO SUPPRESS THIS FOOTER, ON TWO DIFFERENT SURFACES.
   *
   * `app/layout.tsx` renders this after `{children}` on EVERY route. That is wrong in two
   * unrelated ways, each with its own named, unit-tested predicate rather than an inline magic
   * string in this shared component:
   *
   * 1. BAL-435 — **the in-call surface** (`isCallSurface`, `isMeetingCallPath`). On
   *    `/meetings/{id}/call` a footer breaks three things at once: ~40px of footer sits BELOW
   *    an `h-dvh` frame that must not scroll, it renders OUTSIDE the call frame's `.dark`
   *    subtree (light-mode tokens under a permanently dark call), and on mobile it lands under
   *    the toolbar's `env(safe-area-inset-bottom)` padding — a version string beneath the Leave
   *    button. Returning `null` (rather than covering it with a `fixed inset-0 z-50` frame) is
   *    what keeps it out of the ACCESSIBILITY TREE and the TAB ORDER too.
   *
   * 2. BAL-493 §13.3 — **the marketing home** (`isMarketingHome`, `isMarketingHomePath`). The
   *    `(marketing)` route's OWN page footer (§13.2) renders a full `<footer>` with the
   *    version stamp folded into its bottom bar via the same `getVersionString()`/
   *    `APP_VERSION` used below — so nothing is lost, it just moves. If this root footer also
   *    rendered its own `<footer>` there, the assembled page would have TWO `contentinfo`
   *    landmarks, which is an axe violation (`landmark-no-duplicate-contentinfo`) and a real
   *    screen-reader defect, not just a style nit. Every OTHER marketing route (`/experts`,
   *    `/experts/{username}`) has no page-level footer, so this root one still renders there.
   */
  if (isCallSurface || isMarketingHome) return null;

  return (
    <footer className="text-muted-foreground py-4 text-center text-xs">
      <span title={`Branch: ${APP_VERSION.branch} | Built: ${APP_VERSION.buildTime}`}>
        {getVersionString()}
      </span>
    </footer>
  );
}
