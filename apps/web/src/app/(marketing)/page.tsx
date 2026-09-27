import type { Metadata } from 'next';
import { loadHomeData } from '@/lib/marketing/load-home-data';
import { getCurrentUser } from '@/lib/auth/session';
import { log } from '@/lib/logging';
import { MarketingHome } from './_home/marketing-home';
import { MARKETING_HOME_METADATA } from './_home/marketing-home-metadata';

export const metadata: Metadata = MARKETING_HOME_METADATA;

/**
 * BAL-582 §4 — same session-read-fails-open contract as `(marketing)/layout.tsx:42-50`: an
 * anonymous visitor and a session-read failure are indistinguishable here, and both must resolve
 * to `false` (the signed-out hero) rather than escape the page. `await` stays inside the `try`
 * (S4822) so a rejection from `getCurrentUser()` itself is caught, not just a bad projection.
 */
async function resolveIsLoggedIn(): Promise<boolean> {
  try {
    return (await getCurrentUser()) !== null;
  } catch (error) {
    log.warn('Marketing home session read failed; rendering the signed-out hero', {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * BAL-493 §12.4 — the marketing home route for a signed-in visitor, or one whose session read
 * failed (`resolveIsLoggedIn` fails open to `false`). Server component: one `loadHomeData()`
 * fetch (§6, `lib/marketing/load-home-data.ts`) feeds `<MarketingHome>` (`_home/marketing-
 * home.tsx`), the tree this route shares byte-for-byte with the static anonymous prerender at
 * `(marketing-anon)/anon/page.tsx` (BAL-504). `<header>` comes from
 * `(marketing)/layout.tsx`'s `MarketingHeader`.
 *
 * BAL-582 — also resolves `isLoggedIn` (§4, D1) in parallel with `loadHomeData()`, so the hero's
 * home-mount `ProjectRequestPanel` knows whether to gate Submit/upload behind the auth modal.
 */
export default async function MarketingHomePage(): Promise<React.JSX.Element> {
  const [data, isLoggedIn] = await Promise.all([loadHomeData(), resolveIsLoggedIn()]);

  return <MarketingHome data={data} isLoggedIn={isLoggedIn} />;
}
