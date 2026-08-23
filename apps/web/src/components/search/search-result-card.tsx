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
 * Client wrapper around `ExpertCard` that emits `search_result_clicked` and navigates
 * View-profile to `/experts/{username}`.
 *
 * BAL-400 (D4a entry point 2) — `onBook` navigates to `/experts/{username}?book=1&src=search`,
 * reusing the `handleViewProfile` precedent so the search grid needs no booking-context loader
 * of its own; `page.tsx` resolves `loadBookingContext` and auto-opens the wrapper there. Same
 * null-username guard as View-profile — a null `username` means no CTA at all, never a link to
 * `/experts/null`.
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

  const handleBook = useCallback(() => {
    if (expert.username) {
      router.push(`/experts/${expert.username}?book=1&src=search`);
    }
  }, [expert.username, router]);

  return (
    <ExpertCard
      expert={expert}
      variant={variant}
      onViewProfile={expert.username ? handleViewProfile : undefined}
      onBook={expert.username ? handleBook : undefined}
    />
  );
}
