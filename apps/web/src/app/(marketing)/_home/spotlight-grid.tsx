'use client';

import { useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { ExpertCard, type ExpertCardData } from '@/components/expert';
import { useMarketingHomeTracking } from '@/components/marketing/use-marketing-home-tracking';

interface SpotlightCardProps {
  readonly expert: ExpertCardData;
  /** 0-based position within the spotlight grid (analytics ordering). */
  readonly position: number;
}

/**
 * One spotlight card: the canonical `<ExpertCard variant="grid">` (UNMODIFIED — plan §8.3, no
 * third variant), wrapped in `.mk-xc-frame` for the marketing page's elevation/hover-lift, and
 * in `.mk-reveal` for the scroll-in stagger (its ancestor `<RevealGroup>` lives in
 * `experts-section.tsx`). Mirrors `search-result-card.tsx`'s CTA wiring exactly — same deep
 * links, same null-username guard — except `onViewProfile`/`onBook` fire
 * `spotlight_expert_clicked` (action `'profile'`/`'book'`) instead of `search_result_clicked`.
 */
function SpotlightCard({ expert, position }: Readonly<SpotlightCardProps>): React.JSX.Element {
  const router = useRouter();
  const tracking = useMarketingHomeTracking();

  const handleViewProfile = useCallback(() => {
    tracking.spotlightExpertClicked(expert.id, 'profile', position);
    if (expert.username) {
      router.push(`/experts/${expert.username}`);
    }
  }, [tracking, expert.id, expert.username, position, router]);

  const handleBook = useCallback(() => {
    tracking.spotlightExpertClicked(expert.id, 'book', position);
    if (expert.username) {
      router.push(`/experts/${expert.username}?book=1&src=home_spotlight`);
    }
  }, [tracking, expert.id, expert.username, position, router]);

  return (
    <div className="mk-reveal" style={{ '--i': position + 3 } as React.CSSProperties}>
      <div className="mk-xc-frame">
        <ExpertCard
          expert={expert}
          variant="grid"
          onViewProfile={expert.username ? handleViewProfile : undefined}
          onBook={expert.username ? handleBook : undefined}
        />
      </div>
    </div>
  );
}

interface SpotlightGridProps {
  readonly experts: readonly ExpertCardData[];
  /** `.mk-experts` / `.mk-experts--2` / `.mk-experts--1`, computed by `experts-section.tsx`
   * from `experts.length` (the 2/3-card layout decision belongs to the server parent, which
   * also decides the 0-card invitation state and never mounts this component in that case). */
  readonly className: string;
}

/**
 * BAL-493 §3 / §8.3 — the spotlight grid. Client island: `ExpertCard` is itself `'use client'`
 * and takes `onBook`/`onViewProfile`, and this owns `spotlight_expert_clicked` + the
 * `router.push` navigation — reasons this can't be a server component. Receives `experts` as
 * plain `ExpertCardData[]` (never a `@balo/db` row — the client-bundle `tls` footgun).
 */
export function SpotlightGrid({
  experts,
  className,
}: Readonly<SpotlightGridProps>): React.JSX.Element {
  return (
    <div className={className}>
      {experts.map((expert, index) => (
        <SpotlightCard key={expert.id} expert={expert} position={index} />
      ))}
    </div>
  );
}
