import { MARKETING_HOME_SECTIONS } from '@/lib/analytics';
import type { MarketingHomeData } from '@/lib/marketing/load-home-data';
import { HeroSection } from './hero-section';
import { ProofBand } from './proof-band';
import { WaysSection } from './ways-section';
import { HowItWorksSection } from './how-it-works-section';
import { ExpertsSection } from './experts-section';
import { PricingSection } from './pricing-section';
import { ExpertBandSection } from './expert-band-section';
import { TestimonialsSection } from './testimonials-section';
import { FinalCtaSection } from './final-cta-section';
import { MarketingFooter } from './marketing-footer';
import { SectionViewTracker } from './section-view-tracker';
import { METRICS } from './copy';
import './marketing-home.css';

export interface MarketingHomeProps {
  readonly data: MarketingHomeData;
  readonly isLoggedIn: boolean;
}

/**
 * BAL-493 §12.4 / BAL-504 — the marketing home's shared body: both the signed-in/session-read-
 * failed route (`(marketing)/page.tsx`) and the static anonymous prerender
 * (`(marketing-anon)/anon/page.tsx`) render the exact same tree from one `data` + `isLoggedIn`
 * pair. One `loadHomeData()`/`loadHomeDataResult()` fetch feeds every section below, in the
 * exact order `MARKETING_HOME_SECTIONS` declares. `<header>` comes from each route's own layout
 * (`(marketing)/layout.tsx` or `(marketing-anon)/layout.tsx`); `<footer>` comes from
 * `<MarketingFooter>` below — this `<main>` is the only landmark this file owns directly. Every
 * section already carries its own `id` (matching `MARKETING_HOME_SECTIONS`) internally; nothing
 * here needs to re-apply one. The single page `<h1>` lives inside `<HeroSection>`.
 */
export function MarketingHome({
  data,
  isLoggedIn,
}: Readonly<MarketingHomeProps>): React.JSX.Element {
  return (
    <main className="mk-page">
      <HeroSection
        expertTotal={data.expertTotal}
        wasAvailabilityGated={data.wasAvailabilityGated}
        taxonomy={data.taxonomy}
        productNameMap={data.productNameMap}
        chips={data.chips}
        benchTiles={data.benchTiles}
        isLoggedIn={isLoggedIn}
      />
      <ProofBand metrics={METRICS} />
      <WaysSection />
      <HowItWorksSection />
      <ExpertsSection experts={data.spotlight} expertTotal={data.expertTotal} />
      <PricingSection />
      <ExpertBandSection />
      <TestimonialsSection />
      <FinalCtaSection />
      <MarketingFooter />
      <SectionViewTracker sections={MARKETING_HOME_SECTIONS} />
    </main>
  );
}
