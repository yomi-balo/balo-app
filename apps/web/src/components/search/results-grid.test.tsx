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
  SearchResultCard: ({ expert, variant }: { expert: { name: string }; variant: string }) => (
    <div data-testid={`card-${variant}`}>{expert.name}</div>
  ),
}));

import { useReducedMotion } from 'motion/react';
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
    reviewCount: 0,
    yearsExperience: null,
    consultationCount: 0,
    expertise: [],
  };
}

const experts = [expert('e1', 'Adrian'), expert('e2', 'Freda')];

describe('ResultsGrid', () => {
  beforeEach(() => {
    mockReducedMotion.mockReturnValue(false);
  });

  it('renders only grid cards when layout is grid', () => {
    render(<ResultsGrid experts={experts} layout="grid" sort="best_match" page={1} />);
    expect(screen.getAllByTestId('card-grid')).toHaveLength(2);
    expect(screen.queryByTestId('card-list')).toBeNull();
  });

  it('renders both the desktop list and the mobile-grid fallback when layout is list', () => {
    render(<ResultsGrid experts={experts} layout="list" sort="best_match" page={1} />);
    // dual-block: hidden md:block list (desktop) + md:hidden grid (mobile, for the
    // shared `?layout=list`-on-mobile edge), so the list row is never shown on mobile.
    expect(screen.getAllByTestId('card-list')).toHaveLength(2);
    expect(screen.getAllByTestId('card-grid')).toHaveLength(2);
  });

  it('still renders content under prefers-reduced-motion (opacity-only fade branch)', () => {
    mockReducedMotion.mockReturnValue(true);
    render(<ResultsGrid experts={experts} layout="grid" sort="best_match" page={1} />);
    expect(screen.getAllByTestId('card-grid')).toHaveLength(2);
    expect(screen.getByText('Adrian')).toBeInTheDocument();
  });
});
