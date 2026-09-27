import type { Metadata } from 'next';
import { MARKETING_HOME_SECTIONS } from '@/lib/analytics';
import { loadHomeData } from '@/lib/marketing/load-home-data';
import { getCurrentUser } from '@/lib/auth/session';
import { log } from '@/lib/logging';
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
 * BAL-493 §12.4 — the marketing home route. Server component: one `loadHomeData()` fetch
 * (§6, `lib/marketing/load-home-data.ts`) feeds every section below, in the exact order
 * `MARKETING_HOME_SECTIONS` declares (P4b2's handoff table). `<header>` comes from
 * `(marketing)/layout.tsx`'s `MarketingHeader`; `<footer>` comes from `<MarketingFooter>`
 * below — this `<main>` is the only landmark this file owns directly. Every section already
 * carries its own `id` (matching `MARKETING_HOME_SECTIONS`) internally; nothing here needs to
 * re-apply one. The single page `<h1>` lives inside `<HeroSection>`.
 *
 * BAL-582 — also resolves `isLoggedIn` (§4, D1) in parallel with `loadHomeData()`, so the hero's
 * home-mount `ProjectRequestPanel` knows whether to gate Submit/upload behind the auth modal.
 */
export default async function MarketingHomePage(): Promise<React.JSX.Element> {
  const [data, isLoggedIn] = await Promise.all([loadHomeData(), resolveIsLoggedIn()]);

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
