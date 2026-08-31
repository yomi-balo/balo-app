import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { track, MARKETING_HOME_EVENTS } from '@/lib/analytics';
import type { ExpertCardData } from '@/components/expert/expert-card.types';
import { SpotlightGrid } from './spotlight-grid';

const mockTrack = vi.mocked(track);
const { mockPush } = vi.hoisted(() => ({ mockPush: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mockPush }) }));

/**
 * BAL-493 fix round 2 (review MAJOR 6) — `spotlight-grid.tsx` had no emitter test at all
 * (53.84% line coverage). `ExpertCard` is stubbed here (same pattern as `experts-section.test.tsx`
 * and `search-result-card.test.tsx`) so this file tests `SpotlightGrid`'s OWN wiring — which CTA
 * maps to which `MarketingHomeSpotlightAction`, which `position` is passed, and the null-username
 * guard — rather than `ExpertCard`'s internals, which has its own dedicated test file.
 */
vi.mock('@/components/expert', () => ({
  ExpertCard: ({
    expert,
    onViewProfile,
    onBook,
  }: {
    expert: { id: string; name: string; username: string | null };
    onViewProfile?: () => void;
    onBook?: () => void;
  }) => (
    <div data-testid={`expert-card-${expert.id}`}>
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
          Book a call
        </button>
      ) : (
        <span>Book a call</span>
      )}
    </div>
  ),
}));

function makeExpert(overrides: Partial<ExpertCardData> = {}): ExpertCardData {
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

beforeEach(() => {
  mockTrack.mockClear();
  mockPush.mockClear();
});

describe('SpotlightGrid — spotlight_expert_clicked (AC-6)', () => {
  it('"View profile" fires action:"profile" with the expert id and 0-based position, and navigates', async () => {
    const user = userEvent.setup();
    render(
      <SpotlightGrid
        experts={[makeExpert({ id: 'e1', username: 'anil' })]}
        className="mk-experts"
      />
    );

    await user.click(screen.getByRole('button', { name: 'View profile' }));

    expect(mockTrack).toHaveBeenCalledTimes(1);
    expect(mockTrack).toHaveBeenCalledWith(MARKETING_HOME_EVENTS.SPOTLIGHT_EXPERT_CLICKED, {
      expert_id: 'e1',
      action: 'profile',
      position: 0,
    });
    expect(mockPush).toHaveBeenCalledWith('/experts/anil');
  });

  it('"Book a call" fires action:"book" and deep-links with book=1&src=home_spotlight', async () => {
    const user = userEvent.setup();
    render(
      <SpotlightGrid
        experts={[makeExpert({ id: 'e1', username: 'anil' })]}
        className="mk-experts"
      />
    );

    await user.click(screen.getByRole('button', { name: 'Book a call' }));

    expect(mockTrack).toHaveBeenCalledTimes(1);
    expect(mockTrack).toHaveBeenCalledWith(MARKETING_HOME_EVENTS.SPOTLIGHT_EXPERT_CLICKED, {
      expert_id: 'e1',
      action: 'book',
      position: 0,
    });
    expect(mockPush).toHaveBeenCalledWith('/experts/anil?book=1&src=home_spotlight');
  });

  it('the second card in the grid reports position 1, not 0', async () => {
    const user = userEvent.setup();
    render(
      <SpotlightGrid
        experts={[
          makeExpert({ id: 'e1', username: 'anil' }),
          makeExpert({ id: 'e2', username: 'dana', name: 'Dana Okafor' }),
        ]}
        className="mk-experts mk-experts--2"
      />
    );

    const secondCardButtons = screen.getAllByRole('button', { name: 'View profile' });
    const [, second] = secondCardButtons;
    if (!second) throw new Error('expected two "View profile" buttons');
    await user.click(second);

    expect(mockTrack).toHaveBeenCalledWith(MARKETING_HOME_EVENTS.SPOTLIGHT_EXPERT_CLICKED, {
      expert_id: 'e2',
      action: 'profile',
      position: 1,
    });
  });

  it('a null-username expert gets no click handlers at all — no navigation, no track', async () => {
    render(
      <SpotlightGrid
        experts={[makeExpert({ id: 'e1', username: null })]}
        className="mk-experts mk-experts--1"
      />
    );

    expect(screen.queryByRole('button', { name: 'View profile' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Book a call' })).toBeNull();
    expect(screen.getByText('View profile')).toBeInTheDocument();
    expect(screen.getByText('Book a call')).toBeInTheDocument();
    expect(mockTrack).not.toHaveBeenCalled();
    expect(mockPush).not.toHaveBeenCalled();
  });
});
