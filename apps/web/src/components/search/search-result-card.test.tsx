import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import {
  SEARCH_EVENTS,
  SEARCH_RESULT_PROFILE_TARGETS,
  type SearchResultProfileTarget,
} from '@balo/analytics/events';
import { track } from '@/lib/analytics';
import type { ExpertCardData } from '@/components/expert';

// Stub ExpertCard to expose the profile href, profile-link handler and Book handler simply.
vi.mock('@/components/expert', () => ({
  ExpertCard: ({
    expert,
    profileHref,
    onProfileLinkClick,
    onBook,
    bookPending,
  }: {
    expert: { name: string };
    profileHref?: string;
    onProfileLinkClick?: (target: SearchResultProfileTarget) => void;
    onBook?: () => void;
    bookPending?: boolean;
  }) => (
    <div data-book-pending={String(bookPending)} data-profile-href={profileHref ?? ''}>
      <span>{expert.name}</span>
      {onProfileLinkClick ? (
        <>
          {SEARCH_RESULT_PROFILE_TARGETS.map((target) => (
            <button key={target} type="button" onClick={() => onProfileLinkClick(target)}>
              {`profile ${target}`}
            </button>
          ))}
        </>
      ) : (
        <span>no profile links</span>
      )}
      {onBook ? (
        <button type="button" onClick={onBook}>
          Book
        </button>
      ) : (
        <span>Book</span>
      )}
    </div>
  ),
}));

import { SearchResultCard } from './search-result-card';

const mockTrack = vi.mocked(track);
const mockOnBook = vi.fn();

function expert(overrides: Partial<ExpertCardData> = {}): ExpertCardData {
  return {
    id: 'e1',
    username: 'anil',
    name: 'Anil Pilania',
    initials: 'AP',
    avatarUrl: null,
    headline: null,
    bio: null,
    countryCode: null,
    rate: null,
    nextAvailableAt: null,
    languages: [],
    agency: null,
    distinctions: { isSalesforceMvp: false, isSalesforceCta: false, isCertifiedTrainer: false },
    rating: null,
    ratingCount: 0,
    yearsExperience: null,
    consultationCount: 0,
    expertise: [],
    ...overrides,
  };
}

beforeEach(() => vi.clearAllMocks());

describe('SearchResultCard', () => {
  it('passes the profile href to the card', () => {
    const { container } = render(
      <SearchResultCard
        expert={expert()}
        variant="grid"
        position={1}
        sort="best_match"
        page={1}
        onBook={mockOnBook}
        bookPending={false}
      />
    );
    expect(container.querySelector('[data-profile-href="/experts/anil"]')).not.toBeNull();
  });

  it.each(SEARCH_RESULT_PROFILE_TARGETS)(
    'emits search_result_clicked with target %s when that profile link is followed',
    async (target) => {
      const user = userEvent.setup();
      render(
        <SearchResultCard
          expert={expert()}
          variant="grid"
          position={3}
          sort="soonest"
          page={2}
          onBook={mockOnBook}
          bookPending={false}
        />
      );
      await user.click(screen.getByRole('button', { name: `profile ${target}` }));
      expect(mockTrack).toHaveBeenCalledOnce();
      expect(mockTrack).toHaveBeenCalledWith(SEARCH_EVENTS.RESULT_CLICKED, {
        expert_id: 'e1',
        action: 'profile',
        target,
        position: 3,
        sort: 'soonest',
        page: 2,
      });
    }
  );

  it('passes no href or profile handler when the expert has no username', () => {
    const { container } = render(
      <SearchResultCard
        expert={expert({ username: null })}
        variant="grid"
        position={1}
        sort="best_match"
        page={1}
        onBook={mockOnBook}
        bookPending={false}
      />
    );
    expect(container.querySelector('[data-profile-href=""]')).not.toBeNull();
    expect(screen.getByText('no profile links')).toBeInTheDocument();
  });

  it('hands Book to onBook with the username, without tracking a profile click', async () => {
    const user = userEvent.setup();
    render(
      <SearchResultCard
        expert={expert()}
        variant="grid"
        position={1}
        sort="soonest"
        page={1}
        onBook={mockOnBook}
        bookPending={false}
      />
    );
    await user.click(screen.getByRole('button', { name: 'Book' }));
    expect(mockOnBook).toHaveBeenCalledWith('anil', expect.any(Function));
    expect(mockTrack).not.toHaveBeenCalled();
  });

  it('emits search_result_clicked with action book only once the booking accepts the click', async () => {
    const user = userEvent.setup();
    render(
      <SearchResultCard
        expert={expert()}
        variant="grid"
        position={4}
        sort="soonest"
        page={2}
        onBook={mockOnBook}
        bookPending={false}
      />
    );
    await user.click(screen.getByRole('button', { name: 'Book' }));
    expect(mockTrack).not.toHaveBeenCalled();

    const [[, onStart]] = mockOnBook.mock.calls as [[string, () => void]];
    onStart();
    expect(mockTrack).toHaveBeenCalledWith(SEARCH_EVENTS.RESULT_CLICKED, {
      expert_id: 'e1',
      action: 'book',
      position: 4,
      sort: 'soonest',
      page: 2,
    });
  });

  it('forwards bookPending to the card', () => {
    const { container } = render(
      <SearchResultCard
        expert={expert()}
        variant="grid"
        position={1}
        sort="soonest"
        page={1}
        onBook={mockOnBook}
        bookPending
      />
    );
    expect(container.querySelector('[data-book-pending="true"]')).not.toBeNull();
  });

  it('renders an inert Book CTA (no handler) when the expert has no username', () => {
    render(
      <SearchResultCard
        expert={expert({ username: null })}
        variant="grid"
        position={1}
        sort="best_match"
        page={1}
        onBook={mockOnBook}
        bookPending={false}
      />
    );
    expect(screen.queryByRole('button', { name: 'Book' })).not.toBeInTheDocument();
    expect(screen.getByText('Book')).toBeInTheDocument();
  });
});
