'use client';

/**
 * BAL-510 — the /v2 client boundary, ported from the design ref's `MarketingHomeV2()`
 * (ref :1447-1476) minus `<style>{CSS}</style>` (styling is `v2.css`, imported once by
 * the server `page.tsx`), `<ControlStrip>` (prototype-only motion toggle — stripped per
 * the technical plan) and `<Nav>` (the shared `MarketingHeader` from the `(marketing)`
 * group layout is the page's one header; AC 2).
 *
 * This is the ONE client boundary for the whole page (technical plan, "Client / server
 * boundary decision"): the ref implements reduced motion as a class on the ROOT element
 * (`.mk2-page.reduced …`), so toggling it needs client state at the root of the rendered
 * tree — once that's a client component, everything nested below it is in the client
 * graph too. `page.tsx` stays a server component so it can export `metadata` and call
 * the `server-only` `loadSearchTaxonomy()`; this file receives the already-resolved
 * `V2Taxonomy` as a plain serialisable prop.
 */

import type { V2Taxonomy } from '../_lib/product-facet-model';
import { Hero } from './hero';
import { MotionCtx, usePrefersReduced } from './motion';
import { Band, Contrast, Final, Footer, Pricing, Quote, Spotlight, Steps, Ways } from './sections';

export interface MarketingHomeV2Props {
  taxonomy: V2Taxonomy;
}

export function MarketingHomeV2({ taxonomy }: Readonly<MarketingHomeV2Props>): React.JSX.Element {
  const reduced = usePrefersReduced();
  // Computed outside `className={...}` — see the prettier-plugin-tailwindcss note in
  // `motion.tsx`; a template literal authored directly in the attribute would have its
  // significant leading space (before `reduced`) silently stripped by `pnpm format`.
  const pageClassName = `mk2-page${reduced ? ' reduced' : ''}`;

  return (
    <MotionCtx.Provider value={reduced}>
      <div className={pageClassName}>
        <main>
          <Hero taxonomy={taxonomy} />
          <Contrast />
          <Ways />
          <Steps />
          <Spotlight />
          <Pricing />
          <Quote />
          <Band />
          <Final />
        </main>
        <Footer />
      </div>
    </MotionCtx.Provider>
  );
}
