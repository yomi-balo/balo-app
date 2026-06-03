'use client';

import { useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { ExpertCard, type ExpertCardData } from '@/components/expert';
import { track, SEARCH_EVENTS } from '@/lib/analytics';

interface SearchResultCardProps {
  expert: ExpertCardData;
  variant: 'grid' | 'list';
  /** 1-based position within the current page (for analytics). */
  position: number;
  sort: string;
  page: number;
}

/**
 * Client wrapper around `ExpertCard` that emits `search_result_clicked` and
 * navigates View-profile to `/experts/{username}`. Booking is visual-only in v1,
 * so no `onBook` handler is wired (the card renders the default inert CTA) and the
 * click event fires ONLY on the View-profile surface.
 */
export function SearchResultCard({
  expert,
  variant,
  position,
  sort,
  page,
}: Readonly<SearchResultCardProps>): React.JSX.Element {
  const router = useRouter();

  const handleViewProfile = useCallback(() => {
    track(SEARCH_EVENTS.RESULT_CLICKED, {
      expert_id: expert.id,
      position,
      sort,
      page,
    });
    if (expert.username) {
      router.push(`/experts/${expert.username}`);
    }
  }, [expert.id, expert.username, position, sort, page, router]);

  return (
    <ExpertCard
      expert={expert}
      variant={variant}
      onViewProfile={expert.username ? handleViewProfile : undefined}
    />
  );
}
