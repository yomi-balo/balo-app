'use client';

import { useCallback } from 'react';
import Link from 'next/link';
import type { MarketingHomeCtaPlacement } from '@/lib/analytics';
import { useMarketingHomeTracking } from '@/components/marketing/use-marketing-home-tracking';

interface CtaLinkProps {
  readonly placement: MarketingHomeCtaPlacement;
  readonly label: string;
  readonly href: string;
  readonly className?: string;
  readonly children: React.ReactNode;
}

/**
 * BAL-493 §1.2 / §10.7 — the ONE `<Link>` every CTA on the page renders through. Fires
 * `marketing_home_cta_clicked{placement,label}` via `useMarketingHomeTracking` before
 * navigating — no CTA on this page calls `track()` directly.
 *
 * A plain `<Link>`, not the shadcn `Button` — every visual CTA class (`mk-btn`, `mk-btn-grad`,
 * `mk-btn-white`, …) comes from `marketing-home.css` via `className`, matching the ported
 * design reference's own `<a className="mk-btn …">` markup.
 */
export function CtaLink({
  placement,
  label,
  href,
  className,
  children,
}: CtaLinkProps): React.JSX.Element {
  const tracking = useMarketingHomeTracking();

  const handleClick = useCallback(() => {
    tracking.ctaClicked(placement, label);
  }, [tracking, placement, label]);

  return (
    <Link href={href} className={className} onClick={handleClick}>
      {children}
    </Link>
  );
}
