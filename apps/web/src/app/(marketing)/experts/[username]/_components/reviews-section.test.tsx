import { describe, it, expect, vi, beforeEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import { render, screen } from '@/test/utils';
import { track, EXPERT_PROFILE_EVENTS } from '@/lib/analytics';
import type { ProfileReviewEntryView } from '@/components/expert/profile/types';
import { ReviewsSection } from './reviews-section';

/**
 * The section lists one entry per reviewed engagement, so its length equals `ratingCount`.
 * Below the floor of five it is a compact line; at or above, a large average, a distribution
 * and (when both kinds exist) filter chips. The count says "engagements", never "reviews".
 */

function makeEntry(
  key: string,
  overrides: Partial<ProfileReviewEntryView> = {}
): ProfileReviewEntryView {
  return {
    key,
    engagementKind: 'project',
    rating: 5,
    dateLabel: 'Oct 2026',
    topics: ['Sales Cloud'],
    raters: [
      {
        id: `${key}-rater`,
        rating: 5,
        note: `Note for ${key}`,
        attribution: { name: 'Sam K.', descriptor: 'RevOps Lead', initials: 'SK' },
      },
    ],
    sharedCompanyName: null,
    ...overrides,
  };
}

function makeEntries(
  count: number,
  kindAt: (index: number) => 'project' | 'case' = () => 'project'
): ProfileReviewEntryView[] {
  return Array.from({ length: count }, (_, index) =>
    makeEntry(`e${index + 1}`, { engagementKind: kindAt(index) })
  );
}

function renderSection(
  props: Partial<React.ComponentProps<typeof ReviewsSection>> = {}
): ReturnType<typeof render> {
  return render(
    <ReviewsSection
      expertId="expert-1"
      firstName="Priya"
      ratingAverage={4.8}
      ratingCount={1}
      reviews={[makeEntry('e1')]}
      {...props}
    />
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ReviewsSection — the expert has no ratings', () => {
  it('invites rather than reporting absence, and does not repeat itself', () => {
    const { container } = renderSection({ ratingAverage: null, ratingCount: 0, reviews: [] });

    expect(screen.getByText('Ratings come from completed work')).toBeInTheDocument();
    expect(
      screen.getByText('Be the first to work with Priya and share how it went.')
    ).toBeInTheDocument();
    expect(screen.queryByText(/no reviews yet/i)).not.toBeInTheDocument();
    expect((container.textContent ?? '').match(/Be the first/g)).toHaveLength(1);
  });

  it('renders no numeric rating, and never 0.0', () => {
    const { container } = renderSection({ ratingAverage: null, ratingCount: 0, reviews: [] });
    const text = container.textContent ?? '';
    expect(text).not.toContain('0.0');
    expect(screen.queryByText('Verified engagements')).not.toBeInTheDocument();
  });
});

describe('ReviewsSection — below the summary floor', () => {
  it('shows a compact average with the engagement kind and the entry with its note', () => {
    const { container } = renderSection({ ratingAverage: 5, ratingCount: 1 });

    expect(screen.getByText('5.0')).toBeInTheDocument();
    expect(screen.getByText('from 1 project')).toBeInTheDocument();
    expect(screen.getByText('Note for e1')).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: /filter reviews/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Rating distribution' })).not.toBeInTheDocument();
    expect(container.textContent ?? '').not.toMatch(/\d reviews/i);
  });

  it('breaks a mixed list out by kind', () => {
    renderSection({
      ratingAverage: 4.5,
      ratingCount: 3,
      reviews: makeEntries(3, (index) => (index === 0 ? 'case' : 'project')),
    });
    expect(screen.getByText('from 2 projects and 1 consultation')).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: /filter reviews/i })).not.toBeInTheDocument();
  });

  it('names a multi-rater entry by its shared company or the client team', () => {
    const rater = (id: string): ProfileReviewEntryView['raters'][number] => ({
      id,
      rating: 5,
      note: null,
      attribution: { name: 'Sam K.', descriptor: null, initials: 'SK' },
    });
    renderSection({
      reviews: [
        makeEntry('a', { raters: [rater('a1'), rater('a2')], sharedCompanyName: 'Northwind' }),
      ],
    });
    expect(screen.getByText(/Rated by 2 people/)).toHaveTextContent(
      'Rated by 2 people at Northwind'
    );
  });
});

describe('ReviewsSection — at or above the summary floor', () => {
  const eight = makeEntries(8, (index) => (index < 5 ? 'project' : 'case'));

  it('shows the large average, the engagement count and the distribution', () => {
    renderSection({ ratingAverage: 4.8, ratingCount: 8, reviews: eight });

    expect(screen.getByText('4.8')).toBeInTheDocument();
    expect(screen.getByText('from 8 engagements')).toBeInTheDocument();
    const rows = screen.getByRole('list', { name: 'Rating distribution' });
    expect(rows.children).toHaveLength(5);
    expect(rows.children[0]).toHaveAttribute('aria-label', '5 stars: 8 engagements');
    expect(rows.children[4]).toHaveAttribute('aria-label', '1 star: 0 engagements');
  });

  it('describes the count as engagements in the summary, never as reviews', () => {
    const { container } = renderSection({ ratingAverage: 4.8, ratingCount: 8, reviews: eight });
    const summary = container.querySelector('[role="list"]')?.parentElement?.parentElement;
    expect(summary?.textContent ?? '').not.toMatch(/\b\d+ reviews?\b/);
  });

  it('filters the list from the chips while the summary stays on all engagements', async () => {
    const user = userEvent.setup();
    renderSection({ ratingAverage: 4.8, ratingCount: 8, reviews: eight });

    await user.click(screen.getByRole('button', { name: /Consultations/ }));

    expect(screen.getByRole('button', { name: /Consultations/ })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(screen.getAllByRole('article')).toHaveLength(3);
    expect(screen.getByText('from 8 engagements')).toBeInTheDocument();
    const rows = screen.getByRole('list', { name: 'Rating distribution' });
    expect(rows.children[0]).toHaveAttribute('aria-label', '5 stars: 8 engagements');
    expect(screen.getByRole('status')).toHaveTextContent('Showing 3 consultation reviews');
    expect(track).toHaveBeenCalledWith(EXPERT_PROFILE_EVENTS.REVIEWS_FILTER_SELECTED, {
      expert_id: 'expert-1',
      filter: 'case',
    });
  });

  it('offers no chips when every engagement is the same kind', () => {
    renderSection({ ratingAverage: 4.8, ratingCount: 5, reviews: makeEntries(5) });
    expect(screen.queryByRole('group', { name: /filter reviews/i })).not.toBeInTheDocument();
  });

  it('shows three entries, expands to all, and collapses again', async () => {
    const user = userEvent.setup();
    renderSection({ ratingAverage: 4.8, ratingCount: 8, reviews: eight });

    expect(screen.getAllByRole('article')).toHaveLength(3);

    await user.click(screen.getByRole('button', { name: 'Show 5 more reviews' }));
    expect(screen.getAllByRole('article')).toHaveLength(8);
    expect(screen.getByRole('button', { name: 'Show fewer' })).toHaveAttribute(
      'aria-expanded',
      'true'
    );
    expect(track).toHaveBeenCalledWith(EXPERT_PROFILE_EVENTS.REVIEWS_SHOW_MORE, {
      expert_id: 'expert-1',
      revealed: 5,
    });

    vi.mocked(track).mockClear();
    await user.click(screen.getByRole('button', { name: 'Show fewer' }));
    expect(screen.getAllByRole('article')).toHaveLength(3);
    expect(track).not.toHaveBeenCalled();
  });

  it('collapses the list when the filter changes', async () => {
    const user = userEvent.setup();
    renderSection({ ratingAverage: 4.8, ratingCount: 8, reviews: eight });

    await user.click(screen.getByRole('button', { name: 'Show 5 more reviews' }));
    await user.click(screen.getByRole('button', { name: /Projects/ }));

    expect(screen.getAllByRole('article')).toHaveLength(3);
  });
});

describe('ReviewsSection — Verified engagements', () => {
  it('explains the counting rule in a popover and tracks the open', async () => {
    const user = userEvent.setup();
    renderSection();

    expect(screen.queryByText(/Every rating comes from a client/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Verified engagements/ }));

    expect(
      screen.getByText(/Every rating comes from a client who completed work with Priya on Balo/)
    ).toBeInTheDocument();
    expect(track).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledWith(EXPERT_PROFILE_EVENTS.REVIEWS_VERIFIED_INFO_OPENED, {
      expert_id: 'expert-1',
    });
  });
});

describe('ReviewsSection — the entry list is unavailable', () => {
  it('treats an empty list under a stored average like a failed load', () => {
    renderSection({ ratingAverage: 4.8, ratingCount: 12, reviews: [] });

    expect(screen.getByText('from 12 engagements')).toBeInTheDocument();
    expect(screen.getByText(/Reviews couldn't load right now/)).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Rating distribution' })).not.toBeInTheDocument();
  });

  it('keeps the stored aggregate and says the reviews could not load', () => {
    renderSection({ ratingAverage: 4.8, ratingCount: 12, reviews: null });

    expect(screen.getByText('4.8')).toBeInTheDocument();
    expect(screen.getByText('from 12 engagements')).toBeInTheDocument();
    expect(
      screen.getByText("Reviews couldn't load right now. Refresh the page to try again.")
    ).toBeInTheDocument();
    expect(screen.queryByRole('article')).not.toBeInTheDocument();
  });
});
