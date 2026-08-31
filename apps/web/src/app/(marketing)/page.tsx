import type { Metadata } from 'next';
import { MARKETING_HOME_SECTIONS } from '@/lib/analytics';
import { loadHomeData } from '@/lib/marketing/load-home-data';
import { HeroSection } from './_home/hero-section';
import { ProofBand } from './_home/proof-band';
import { WaysSection } from './_home/ways-section';
import { HowItWorksSection } from './_home/how-it-works-section';
import { ExpertsSection } from './_home/experts-section';
import { PricingSection } from './_home/pricing-section';
import { ExpertBandSection } from './_home/expert-band-section';
import { TestimonialsSection } from './_home/testimonials-section';
import { FinalCtaSection } from './_home/final-cta-section';
import { MarketingFooter } from './_home/marketing-footer';
import { SectionViewTracker } from './_home/section-view-tracker';
import { METRICS } from './_home/copy';
import './_home/marketing-home.css';

export const metadata: Metadata = {
  title: 'Top Salesforce experts, on demand — Balo',
  description:
    'Book a vetted Salesforce expert by the minute. Consultations, projects and packages — ' +
    'one all-in rate, service fee included.',
  alternates: { canonical: '/' },
};

/**
 * BAL-493 §12.4 — the marketing home route. Server component: one `loadHomeData()` fetch
 * (§6, `lib/marketing/load-home-data.ts`) feeds every section below, in the exact order
 * `MARKETING_HOME_SECTIONS` declares (P4b2's handoff table). `<header>` comes from
 * `(marketing)/layout.tsx`'s `MarketingHeader`; `<footer>` comes from `<MarketingFooter>`
 * below — this `<main>` is the only landmark this file owns directly. Every section already
 * carries its own `id` (matching `MARKETING_HOME_SECTIONS`) internally; nothing here needs to
 * re-apply one. The single page `<h1>` lives inside `<HeroSection>`.
 */
export default async function MarketingHomePage(): Promise<React.JSX.Element> {
  const data = await loadHomeData();

  return (
    <main className="mk-page">
      <HeroSection
        expertTotal={data.expertTotal}
        wasAvailabilityGated={data.wasAvailabilityGated}
        taxonomy={data.taxonomy}
        productNameMap={data.productNameMap}
        chips={data.chips}
        benchTiles={data.benchTiles}
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
