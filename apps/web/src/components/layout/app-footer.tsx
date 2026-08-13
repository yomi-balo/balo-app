'use client';

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { getVersionString, APP_VERSION } from '@/lib/version';
import { isMeetingCallPath } from '@/lib/meetings/is-meeting-call-path';

export function AppFooter() {
  const pathname = usePathname();
  const isCallSurface = isMeetingCallPath(pathname ?? '');

  useEffect(() => {
    console.log(
      `%c Balo ${getVersionString()} `,
      'background: #111; color: #fff; padding: 2px 6px; border-radius: 3px;'
    );
  }, []);

  /**
   * ⚠⚠ BAL-435 — **THE ONE PLACE A BUILD VERSION STAMP MUST NOT APPEAR.**
   *
   * `app/layout.tsx` renders this after `{children}` on EVERY route, and on the in-call surface
   * that breaks three things at once:
   *
   *   1. ~40px of footer sits BELOW an `h-dvh` frame, so a shell that must not scroll, scrolls.
   *   2. It is OUTSIDE the call frame's `.dark` subtree, so it renders light-mode tokens under a
   *      permanently dark call.
   *   3. On mobile it lands under the toolbar's `env(safe-area-inset-bottom)` padding — a version
   *      string beneath the Leave button.
   *
   * ⚠ RETURNING `null` (rather than covering it with a `fixed inset-0 z-50` frame) is what keeps
   * it out of the ACCESSIBILITY TREE and the TAB ORDER too.
   *
   * ⚠ THE PREDICATE IS A NAMED, UNIT-TESTED FUNCTION, not an inline magic string in a shared
   * component.
   */
  if (isCallSurface) return null;

  return (
    <footer className="text-muted-foreground py-4 text-center text-xs">
      <span title={`Branch: ${APP_VERSION.branch} | Built: ${APP_VERSION.buildTime}`}>
        {getVersionString()}
      </span>
    </footer>
  );
}
