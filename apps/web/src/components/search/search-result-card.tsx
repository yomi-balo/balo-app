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
  /** `onStart` runs only if the booking accepts the click; this card tracks it there. */
  onBook: (username: string, onStart: () => void) => void;
  /** This card's booking is loading. */
  bookPending: boolean;
}

/**
 * Client wrapper around `ExpertCard` that emits `search_result_clicked` (action `'profile'` or
 * `'book'`) and navigates View-profile to `/experts/{username}`.
 *
 * Book a call opens the booking flow in place: `onBook` (owned by `ResultsGrid`, which mounts the
 * one dialog) loads it for this expert's username. Same null-username guard as View-profile — a
 * null `username` means no CTA at all, never a link to `/experts/null`.
 */
export function SearchResultCard({
  expert,
  variant,
  position,
  sort,
  page,
  onBook,
  bookPending,
}: Readonly<SearchResultCardProps>): React.JSX.Element {
  const router = useRouter();

  const handleViewProfile = useCallback(() => {
    track(SEARCH_EVENTS.RESULT_CLICKED, {
      expert_id: expert.id,
      action: 'profile',
      position,
      sort,
      page,
    });
    if (expert.username) {
      router.push(`/experts/${expert.username}`);
    }
  }, [expert.id, expert.username, position, sort, page, router]);

  const handleBook = useCallback(() => {
    if (!expert.username) return;
    onBook(expert.username, () =>
      track(SEARCH_EVENTS.RESULT_CLICKED, {
        expert_id: expert.id,
        action: 'book',
        position,
        sort,
        page,
      })
    );
  }, [expert.id, expert.username, position, sort, page, onBook]);

  return (
    <ExpertCard
      expert={expert}
      variant={variant}
      onViewProfile={expert.username ? handleViewProfile : undefined}
      onBook={expert.username ? handleBook : undefined}
      bookPending={bookPending}
    />
  );
}
