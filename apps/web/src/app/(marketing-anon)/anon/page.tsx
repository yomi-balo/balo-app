import type { Metadata } from 'next';
import { PHASE_PRODUCTION_BUILD } from 'next/constants';
import { loadHomeDataResult } from '@/lib/marketing/load-home-data';
import { log } from '@/lib/logging';
import { MarketingHome } from '../../(marketing)/_home/marketing-home';
import { MARKETING_HOME_METADATA } from '../../(marketing)/_home/marketing-home-metadata';

export const metadata: Metadata = MARKETING_HOME_METADATA;

// Segment config is parsed statically — these must stay literals, not derived values.
export const revalidate = 300;
export const dynamic = 'error';

/**
 * BAL-504 — the static, session-free anonymous marketing home. Middleware rewrites an anonymous
 * `/` here transparently; a direct hit is redirected back to `/` (see `middleware.ts`).
 * `dynamic = 'error'` makes the build itself fail if this tree ever touches
 * `cookies()`/`headers()`/`searchParams` — pinning "no cross-user content" at compile time, not
 * just by review. There is no `isLoggedIn` prop to resolve: this route only ever renders the
 * signed-out hero.
 *
 * ⚠⚠ THE DEGRADED GUARD. A `loadHomeDataResult()` degraded result must never get BAKED into the
 * 300s ISR cache — unlike the signed-in `(marketing)/page.tsx`, which re-resolves per request,
 * a stale/degraded `/anon` render would serve every anonymous visitor for the full revalidate
 * window. At RUNTIME, in production, a degraded result throws instead of rendering: ISR then
 * keeps the last known-good HTML and retries on the next request past the revalidate window
 * (documented Next.js behaviour). AT BUILD TIME (`NEXT_PHASE === PHASE_PRODUCTION_BUILD`),
 * throwing would fail the deploy over a down API/DB, which is worse than a degraded-but-live
 * front door — so the build renders degraded data and only logs. The `NODE_ENV === 'production'`
 * guard is a second, independent gate: in dev there is no ISR cache to protect, so a degraded
 * result should render (and be visibly debuggable) rather than throw.
 */
export default async function AnonMarketingHomePage(): Promise<React.JSX.Element> {
  const { data, degraded } = await loadHomeDataResult();

  const isBuildPhase = process.env.NEXT_PHASE === PHASE_PRODUCTION_BUILD;
  if (degraded && process.env.NODE_ENV === 'production' && !isBuildPhase) {
    throw new Error('Marketing home data degraded; keeping the last good prerender');
  }
  if (degraded) {
    log.error('Marketing home data degraded; rendering the degraded anon home', {
      isBuildPhase,
      nodeEnv: process.env.NODE_ENV,
    });
  }

  return <MarketingHome data={data} isLoggedIn={false} />;
}
