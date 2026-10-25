'use client';

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { formatUnreadTabTitle, stripUnreadTabTitle } from './notification-arrival';

/**
 * Prefixes the document title with the unread count, e.g. `(3) Balo`. Next rewrites the title on
 * navigation, so a head observer re-applies the prefix; the write is idempotent, which keeps the
 * observer from feeding itself.
 */
export function useUnreadTabTitle(unread: number): void {
  const pathname = usePathname();

  useEffect(() => {
    const apply = (): void => {
      const next = formatUnreadTabTitle(document.title, unread);
      if (document.title !== next) document.title = next;
    };

    apply();
    const observer = new MutationObserver(apply);
    observer.observe(document.head, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, [pathname, unread]);

  useEffect(
    () => () => {
      document.title = stripUnreadTabTitle(document.title);
    },
    []
  );
}
