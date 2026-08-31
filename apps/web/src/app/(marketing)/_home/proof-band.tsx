'use client';

import { useEffect, useRef, useState } from 'react';
import { useMarketingReducedMotion } from '@/components/marketing/motion/use-reduced-motion';
import { useCountUp } from '@/components/marketing/motion/use-count-up';
import type { MarketingMetric } from './copy';

/** Matches the design reference's `useInView(reduced, 0.4)` threshold (`marketing-home.jsx:1757-1758`). */
const PROOF_THRESHOLD = 0.4;

interface ProofMetricProps {
  readonly metric: MarketingMetric;
  readonly active: boolean;
  readonly reduced: boolean;
}

function ProofMetric({ metric, active, reduced }: ProofMetricProps): React.JSX.Element {
  const value = useCountUp(metric.value, active, reduced, metric.decimals ?? 0);
  return (
    <div className="mk-proof-item">
      <div className="mk-proof-val">
        {metric.prefix}
        {value}
        {metric.suffix}
      </div>
      <div className="mk-proof-lab">{metric.label}</div>
    </div>
  );
}

interface ProofBandProps {
  readonly metrics: readonly MarketingMetric[];
}

/**
 * BAL-493 §3 / §11 — the proof band. Client island: one `IntersectionObserver` gates all four
 * `useCountUp` ramps at once. Deliberately NOT `<RevealGroup>` — the numbers themselves ARE the
 * reveal (no `.mk-reveal`-staggered children here), so this owns a single-shot observer
 * modelled directly on the design reference's `useInView`, rather than reusing the group
 * primitive built for staggered content.
 *
 * `metrics` arrives as a prop (plain data from `copy.ts`'s `METRICS`) rather than being
 * imported directly, matching §3's client-boundary contract: a server parent owns `copy.ts`
 * imports, client islands receive copy as plain props (see `hero-search.tsx`'s `phrases`).
 */
export function ProofBand({ metrics }: Readonly<ProofBandProps>): React.JSX.Element {
  const reduced = useMarketingReducedMotion();
  const sectionRef = useRef<HTMLElement | null>(null);
  const [active, setActive] = useState(false);

  useEffect(() => {
    if (reduced) {
      setActive(true);
      return undefined;
    }

    const el = sectionRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      setActive(true);
      return undefined;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        const [entry] = entries;
        if (entry?.isIntersecting) {
          setActive(true);
          observer.disconnect();
        }
      },
      { threshold: PROOF_THRESHOLD }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [reduced]);

  return (
    <section className="mk-proof" id="proof" ref={sectionRef}>
      <div className="mk-wrap mk-proof-inner">
        {metrics.map((metric) => (
          <ProofMetric key={metric.label} metric={metric} active={active} reduced={reduced} />
        ))}
      </div>
    </section>
  );
}
