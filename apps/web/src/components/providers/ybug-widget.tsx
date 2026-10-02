'use client';

import Script from 'next/script';
import { usePathname, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { isSensitiveUrl } from '@/lib/observability/sentry-scrub';

/** The one method of Ybug's documented JS API used here (https://ybug.io/docs/installation/javascript-api). */
interface YbugApi {
  destroy: () => void;
}

function loadedYbug(): YbugApi | undefined {
  return (globalThis as { Ybug?: YbugApi }).Ybug;
}

/**
 * Feedback widget (https://ybug.io) for every build — local dev, Vercel preview and production —
 * wherever `NEXT_PUBLIC_YBUG_ID` is configured (unset or empty → nothing loads). Being
 * `NEXT_PUBLIC_*`, the ID is inlined at build time, so adding it to an environment takes effect
 * from that environment's next deploy.
 *
 * ⚠ A URL SINK THAT CANNOT SCRUB, SO IT IS REFUSED — entry 4 of the sink registry in
 * `@balo/shared/redaction`. Every Ybug report carries the page URL plus Ybug's console and network
 * log, and Ybug has no hook to redact either, so on a token-bearing URL (`isSensitiveUrl`, derived
 * from that registry) the widget must not exist at all — the same "cannot scrub, can only refuse"
 * call `instrumentation-client.ts` makes for Session Replay:
 *   - landing on a sensitive URL → the scripts are never rendered, so nothing is fetched from Ybug;
 *   - a client-side navigation INTO one (the admin Lookup box `router.replace`s every debounced
 *     search into `?q=`) → `Ybug.destroy()`, ONE-WAY for the rest of the document. Ybug's network
 *     log may already hold the request that changed the URL and its API cannot clear it, so
 *     booting it again would hand that entry to the next report.
 * The decision runs after mount because only the browser knows the URL; the server renders nothing,
 * so not even a preload of the script reaches a sensitive landing. `useSearchParams` is why
 * `app/layout.tsx` mounts this inside `<Suspense>`.
 */
export function YbugWidget(): React.JSX.Element | null {
  const ybugId = process.env.NEXT_PUBLIC_YBUG_ID;
  const pathname = usePathname();
  const search = useSearchParams().toString();
  const refused = useRef(false);
  const [active, setActive] = useState(false);

  useEffect(() => {
    if (refused.current) return;
    if (isSensitiveUrl(globalThis.location.href)) {
      refused.current = true;
      loadedYbug()?.destroy();
      setActive(false);
      return;
    }
    setActive(true);
  }, [pathname, search]);

  if (!ybugId || !active) {
    return null;
  }

  return (
    <>
      <Script id="ybug-settings" strategy="afterInteractive">
        {`window.ybug_settings = ${JSON.stringify({ id: ybugId })};`}
      </Script>
      <Script src={`https://widget.ybug.io/button/${ybugId}.js`} strategy="afterInteractive" />
    </>
  );
}
