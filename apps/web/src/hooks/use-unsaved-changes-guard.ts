'use client';

import { useEffect } from 'react';

/**
 * BAL-593 — intercepts in-app navigation while `active` so a staff edit in progress is never
 * silently discarded by a stray click on a link.
 *
 * Two layers, because they cover different exits:
 *  - `beforeunload` covers a FULL document unload (reload, close tab, type a new URL). The
 *    browser renders its own native prompt; `onAttemptLeave` is never called for this arm.
 *  - A capture-phase `click` listener on `document` covers IN-APP `<a>` navigation (Next.js
 *    `Link`, a plain anchor, the breadcrumb back link). It calls `onAttemptLeave(href)` so the
 *    caller can show the discard-changes dialog and navigate itself on confirm.
 *
 * Browser back/forward (`popstate`) is NOT intercepted — there is no way to cancel it
 * synchronously without `history.pushState` tricks that fight the router, and `beforeunload`
 * already covers the worst case (losing the tab entirely). The residual gap — back/forward
 * silently discarding a draft — is accepted.
 */
export function useUnsavedChangesGuard(
  active: boolean,
  onAttemptLeave: (href: string) => void
): void {
  useEffect(() => {
    if (!active) return;

    const handleBeforeUnload = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
      event.returnValue = '';
    };

    const handleClick = (event: MouseEvent): void => {
      if (event.defaultPrevented) return;
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
      }

      const target = event.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest('a[href]');
      if (!(anchor instanceof HTMLAnchorElement)) return;
      if (anchor.target === '_blank' || anchor.hasAttribute('download')) return;

      let url: URL;
      try {
        url = new URL(anchor.href, globalThis.location.href);
      } catch {
        return;
      }
      if (url.origin !== globalThis.location.origin) return;
      // A same-path hash link (an in-page anchor) is not a navigation away from this draft.
      if (url.pathname === globalThis.location.pathname && url.hash !== '') return;

      event.preventDefault();
      event.stopPropagation();
      onAttemptLeave(`${url.pathname}${url.search}${url.hash}`);
    };

    globalThis.addEventListener('beforeunload', handleBeforeUnload);
    document.addEventListener('click', handleClick, true);

    return () => {
      globalThis.removeEventListener('beforeunload', handleBeforeUnload);
      document.removeEventListener('click', handleClick, true);
    };
  }, [active, onAttemptLeave]);
}
