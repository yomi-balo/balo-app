'use client';

import Script from 'next/script';
import { usePathname, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
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
 * ⚠ A URL SINK THAT CANNOT BE FULLY SCRUBBED, SO IT IS REFUSED — entry 4 of the sink registry in
 * `@balo/shared/redaction`. Ybug's `onbeforesend` can rewrite or cancel the report body (page URL,
 * referrer, console/network log), but the page URL also leaves through two channels no hook
 * reaches: opening the widget POSTs `location.href` to Ybug's reachability check before any event
 * fires, and the screenshot's DOM snapshot embeds it as `<base href>`. So where `isSensitiveUrl`
 * (derived from that registry) holds, the widget must not exist at all — the same "cannot scrub,
 * can only refuse" call `instrumentation-client.ts` makes for Session Replay:
 *   - landing on a sensitive URL, or arriving FROM one (every report carries `document.referrer`,
 *     e.g. a link on `/admin/lookup?q=…` opened in a new tab) → the scripts are never rendered, so
 *     nothing is fetched from Ybug;
 *   - a client-side navigation INTO one (the admin Lookup box `router.replace`s every debounced
 *     search into `?q=`) → `Ybug.destroy()`, and if the loader is still downloading at that moment,
 *     its `onLoad` destroys Ybug as soon as it boots.
 * The refusal is ONE-WAY for the rest of the document. That a later `boot()` would start with empty
 * console/network logs is Ybug implementation detail, not documented behaviour, so this does not
 * rely on it; the widget comes back on the next full page load.
 *
 * ⚠ RESIDUAL, stated rather than papered over: a sensitive URL the router FETCHES but never
 * commits — the BAL-494 `/api/auth/switch-workspace?t=` hop, followed as a redirect — can enter
 * Ybug's network log when the project's plan and settings enable it. That token is bound to the
 * session and expires after 120 s.
 *
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
    if (isSensitiveUrl(globalThis.location.href) || isSensitiveUrl(globalThis.document.referrer)) {
      refused.current = true;
      loadedYbug()?.destroy();
      setActive(false);
      return;
    }
    setActive(true);
  }, [pathname, search]);

  // next/script binds `onLoad` to the injected element, so it still fires after the <Script>
  // unmounts — and the loader boots synchronously as it executes, before `load` is dispatched.
  const destroyIfRefused = useCallback(() => {
    if (refused.current) loadedYbug()?.destroy();
  }, []);

  if (!ybugId || !active) {
    return null;
  }

  return (
    <>
      <Script id="ybug-settings" strategy="afterInteractive">
        {`window.ybug_settings = ${JSON.stringify({ id: ybugId })};`}
      </Script>
      <Script
        src={`https://widget.ybug.io/button/${ybugId}.js`}
        strategy="afterInteractive"
        onLoad={destroyIfRefused}
      />
    </>
  );
}
