// TEMPORARY — /v2 direction preview, remove after the V1-vs-V2 decision (see BAL-493)

/**
 * BAL-510 — the V2.2 "airy" marketing home preview at `/v2`, inside the existing
 * `(marketing)` route group (so it inherits the shared `MarketingHeader` from
 * `(marketing)/layout.tsx` and nothing else — AC 2). Temporary, preview-grade,
 * unlinked, `noindex`: it exists so the team can compare V2 against V1 (BAL-493) and
 * pick a direction, then it is deleted — teardown is `rm -rf (marketing)/v2/` PLUS
 * removing the `'/v2'` entry from `PUBLIC_PATHS` in `lib/auth/route-config.ts` (see the
 * technical plan's "Teardown obligation"). That entry is what lets this page be viewed
 * signed out — without it middleware 307s anonymous visitors to `/login`.
 *
 * This file is a SERVER component, deliberately (technical plan, "Client / server
 * boundary decision"):
 * - It exports `metadata` — a client module cannot.
 * - It is the ONLY file in this feature allowed to call `loadSearchTaxonomy()`, which is
 *   `import 'server-only'` and reaches `referenceDataRepository` in `@balo/db`. A value
 *   import of that graph from a client component breaks `next build` outright
 *   (`postgres` → "can't resolve 'tls'") — every other file under `(marketing)/v2/` uses
 *   `import type` only for taxonomy shapes, never a value import.
 *
 * Taxonomy load and graceful degradation (O1) — `loadSearchTaxonomy()` never actually
 * THROWS (it catches internally, logs, and returns `EMPTY_TAXONOMY`), so the degradation
 * branch below manifests as `toV2Taxonomy()` returning `source: 'fallback'` (empty
 * groups), not a rejection. The `try/catch` here is cheap defensive belt-and-braces on
 * top of that, so a future change to `loadSearchTaxonomy` can't turn this page into a 500.
 */

import type { Metadata } from 'next';
import { log } from '@/lib/logging';
import { loadSearchTaxonomy } from '@/lib/search/load-taxonomy';
import { EMPTY_TAXONOMY, type ProductTaxonomy } from '@/lib/search/taxonomy';
import { MarketingHomeV2 } from './_components/marketing-home-v2';
import { toV2Taxonomy } from './_lib/product-facet-model';
import './v2.css';

export const metadata: Metadata = {
  title: 'Balo — Marketing Home V2 (preview)',
  description: 'Internal preview — not for public indexing.',
  robots: { index: false, follow: false },
};

export default async function MarketingHomeV2Page(): Promise<React.JSX.Element> {
  let live: ProductTaxonomy = EMPTY_TAXONOMY;
  try {
    live = await loadSearchTaxonomy();
  } catch (error) {
    // Defensive — `loadSearchTaxonomy` owns its own catch and already logs — but a
    // caught boundary that returns a user-facing result must log per CLAUDE.md.
    log.error('/v2 preview product taxonomy load threw unexpectedly', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
  }

  const taxonomy = toV2Taxonomy(live);
  if (taxonomy.source === 'fallback') {
    log.warn(
      '/v2 preview product taxonomy unavailable; the hero product facet is disabled and submit emits q only'
    );
  }

  return <MarketingHomeV2 taxonomy={taxonomy} />;
}
