'use client';

import { useCallback } from 'react';
import { ExpertCard, type ExpertCardData, type ExpertCardProfileTarget } from '@/components/expert';
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
 * `'book'`).
 *
 * The profile is a real link: the card passes `profileHref` (`/experts/{username}`) and the card's
 * name link, View profile button and "+N more products" link all navigate natively. This wrapper
 * only tracks them, with the `target` that was followed.
 *
 * Book a call opens the booking flow in place: `onBook` (owned by `ResultsGrid`, which mounts the
 * one dialog) loads it for this expert's username. Same null-username guard as the profile links —
 * a null `username` means no links and no CTA at all, never a link to `/experts/null`.
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
  const handleProfileLinkClick = useCallback(
    (target: ExpertCardProfileTarget) => {
      track(SEARCH_EVENTS.RESULT_CLICKED, {
        expert_id: expert.id,
        action: 'profile',
        target,
        position,
        sort,
        page,
      });
    },
    [expert.id, position, sort, page]
  );

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

  const profileHref = expert.username ? `/experts/${expert.username}` : undefined;

  return (
    <ExpertCard
      expert={expert}
      variant={variant}
      profileHref={profileHref}
      onProfileLinkClick={profileHref ? handleProfileLinkClick : undefined}
      onBook={expert.username ? handleBook : undefined}
      bookPending={bookPending}
    />
  );
}
