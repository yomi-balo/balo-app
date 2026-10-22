import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/utils';
import type { ExpertCardData } from '@/components/expert';

// Keep AnimatePresence/motion real (so the keyed cross-fade actually mounts), but
// control useReducedMotion so both the normal and reduced-motion branches are covered.
vi.mock('motion/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('motion/react')>();
  return { ...actual, useReducedMotion: vi.fn(() => false) };
});

// Stub the card to a tiny variant-tagged node — this test is about the
// grid/list branching + transition wrapper, not the card internals.
vi.mock('./search-result-card', () => ({
  SearchResultCard: ({
    expert,
    variant,
    onBook,
    bookPending,
  }: {
    expert: { name: string; username: string | null };
    variant: string;
    onBook: (username: string) => void;
    bookPending: boolean;
  }) => (
    <div data-testid={`card-${variant}`} data-book-pending={String(bookPending)}>
      {expert.name}
      <button type="button" onClick={() => onBook(expert.username ?? '')}>
        Book {expert.name}
      </button>
    </div>
  ),
}));

const { mockBooking } = vi.hoisted(() => ({
  mockBooking: {
    launch: null as unknown,
    open: false,
    pendingUsername: null as string | null,
    book: vi.fn(),
    close: vi.fn(),
  },
}));
vi.mock('sonner', () => ({ toast: vi.fn() }));
vi.mock('./use-search-booking', () => ({ useSearchBooking: () => mockBooking }));

vi.mock('@/components/booking', () => ({
  BookingFlowDialog: ({
    open,
    source,
    expert,
    entry,
    onMessage,
  }: {
    open: boolean;
    source: string;
    expert: { name: string };
    entry: { mode: string; context: { arm: string } };
    onMessage: () => void;
  }) => (
    <div data-testid="booking-dialog" data-open={String(open)} data-source={source}>
      {expert.name} · {entry.mode} · {entry.context.arm}
      <button type="button" onClick={onMessage}>
        Message instead
      </button>
    </div>
  ),
}));

import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { useReducedMotion } from 'motion/react';
import { EMPTY_TAXONOMY } from '@/lib/search/taxonomy';
import { ResultsGrid } from './results-grid';

const mockReducedMotion = vi.mocked(useReducedMotion);

function expert(id: string, name: string): ExpertCardData {
  return {
    id,
    username: name.toLowerCase(),
    name,
    initials: 'XX',
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
  };
}

const experts = [expert('e1', 'Adrian'), expert('e2', 'Freda')];

describe('ResultsGrid', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReducedMotion.mockReturnValue(false);
    mockBooking.launch = null;
    mockBooking.open = false;
    mockBooking.pendingUsername = null;
  });

  it('renders only grid cards when layout is grid', () => {
    render(
      <ResultsGrid
        experts={experts}
        layout="grid"
        sort="best_match"
        page={1}
        productsTaxonomy={EMPTY_TAXONOMY}
      />
    );
    expect(screen.getAllByTestId('card-grid')).toHaveLength(2);
    expect(screen.queryByTestId('card-list')).toBeNull();
  });

  it('renders both the desktop list and the mobile-grid fallback when layout is list', () => {
    render(
      <ResultsGrid
        experts={experts}
        layout="list"
        sort="best_match"
        page={1}
        productsTaxonomy={EMPTY_TAXONOMY}
      />
    );
    // dual-block: hidden md:block list (desktop) + md:hidden grid (mobile, for the
    // shared `?layout=list`-on-mobile edge), so the list row is never shown on mobile.
    expect(screen.getAllByTestId('card-list')).toHaveLength(2);
    expect(screen.getAllByTestId('card-grid')).toHaveLength(2);
  });

  it('still renders content under prefers-reduced-motion (opacity-only fade branch)', () => {
    mockReducedMotion.mockReturnValue(true);
    render(
      <ResultsGrid
        experts={experts}
        layout="grid"
        sort="best_match"
        page={1}
        productsTaxonomy={EMPTY_TAXONOMY}
      />
    );
    expect(screen.getAllByTestId('card-grid')).toHaveLength(2);
    expect(screen.getByText('Adrian')).toBeInTheDocument();
  });

  it("hands a card's Book to the in-place booking with that username", async () => {
    const user = userEvent.setup();
    render(
      <ResultsGrid
        experts={experts}
        layout="grid"
        sort="best_match"
        page={1}
        productsTaxonomy={EMPTY_TAXONOMY}
      />
    );
    await user.click(screen.getByRole('button', { name: 'Book Freda' }));
    expect(mockBooking.book).toHaveBeenCalledWith('freda');
  });

  it('marks only the loading card as pending', () => {
    mockBooking.pendingUsername = 'freda';
    render(
      <ResultsGrid
        experts={experts}
        layout="grid"
        sort="best_match"
        page={1}
        productsTaxonomy={EMPTY_TAXONOMY}
      />
    );
    const [adrian, freda] = screen.getAllByTestId('card-grid');
    expect(adrian).toHaveAttribute('data-book-pending', 'false');
    expect(freda).toHaveAttribute('data-book-pending', 'true');
  });

  it('mounts no booking dialog until a booking has loaded', () => {
    render(
      <ResultsGrid
        experts={experts}
        layout="grid"
        sort="best_match"
        page={1}
        productsTaxonomy={EMPTY_TAXONOMY}
      />
    );
    expect(screen.queryByTestId('booking-dialog')).toBeNull();
  });

  it('opens the loaded booking as the search-sourced chooser', () => {
    mockBooking.launch = {
      expert: { expertProfileId: 'p2', name: 'Freda' },
      context: { arm: 'onboarding_required' },
      viewerEmailDomain: null,
    };
    mockBooking.open = true;
    render(
      <ResultsGrid
        experts={experts}
        layout="grid"
        sort="best_match"
        page={1}
        productsTaxonomy={EMPTY_TAXONOMY}
      />
    );
    const dialog = screen.getByTestId('booking-dialog');
    expect(dialog).toHaveAttribute('data-open', 'true');
    expect(dialog).toHaveAttribute('data-source', 'search');
    expect(dialog).toHaveTextContent('Freda · chooser · onboarding_required');
  });

  it('closes the dialog and says messaging is coming soon on "Message instead"', async () => {
    const user = userEvent.setup();
    mockBooking.launch = {
      expert: { expertProfileId: 'p2', name: 'Freda' },
      context: { arm: 'onboarding_required' },
      viewerEmailDomain: null,
    };
    mockBooking.open = true;
    render(
      <ResultsGrid
        experts={experts}
        layout="grid"
        sort="best_match"
        page={1}
        productsTaxonomy={EMPTY_TAXONOMY}
      />
    );
    await user.click(screen.getByRole('button', { name: 'Message instead' }));
    expect(mockBooking.close).toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith('Coming soon', { description: 'This flow is on its way.' });
  });
});
