import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { SEARCH_EVENTS } from '@balo/analytics/events';
import { track } from '@/lib/analytics';
import type { ExpertCardData } from '@/components/expert';

const { mockPush } = vi.hoisted(() => ({ mockPush: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mockPush }) }));

// Stub ExpertCard to expose the View-profile + Book handlers simply.
vi.mock('@/components/expert', () => ({
  ExpertCard: ({
    expert,
    onViewProfile,
    onBook,
    bookPending,
  }: {
    expert: { name: string };
    onViewProfile?: () => void;
    onBook?: () => void;
    bookPending?: boolean;
  }) => (
    <div data-book-pending={String(bookPending)}>
      <span>{expert.name}</span>
      {onViewProfile ? (
        <button type="button" onClick={onViewProfile}>
          View profile
        </button>
      ) : (
        <span>View profile</span>
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
  it('emits search_result_clicked with position/sort/page and navigates on View profile', async () => {
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
    await user.click(screen.getByRole('button', { name: 'View profile' }));
    expect(mockTrack).toHaveBeenCalledWith(SEARCH_EVENTS.RESULT_CLICKED, {
      expert_id: 'e1',
      action: 'profile',
      position: 3,
      sort: 'soonest',
      page: 2,
    });
    expect(mockPush).toHaveBeenCalledWith('/experts/anil');
  });

  it('renders an inert View-profile (no handler) when the expert has no username', () => {
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
    // No button is wired — the card renders the default inert label.
    expect(screen.queryByRole('button', { name: 'View profile' })).not.toBeInTheDocument();
    expect(screen.getByText('View profile')).toBeInTheDocument();
  });

  it('hands Book to onBook with the username, without navigating', async () => {
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
    expect(mockOnBook).toHaveBeenCalledWith('anil');
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('emits search_result_clicked with action book before handing off to onBook', async () => {
    const user = userEvent.setup();
    mockOnBook.mockImplementation(() => {
      expect(mockTrack).toHaveBeenCalledWith(SEARCH_EVENTS.RESULT_CLICKED, {
        expert_id: 'e1',
        action: 'book',
        position: 4,
        sort: 'soonest',
        page: 2,
      });
    });
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
    expect(mockOnBook).toHaveBeenCalledOnce();
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
