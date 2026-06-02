import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/utils';
import type { ExpertSearchResponseDTO, ExpertSearchResultDTO } from '@/lib/search/search-data';
import type { SearchFilters } from '@/lib/search/filters';

// The single mockable seam.
const { mockSearchExperts } = vi.hoisted(() => ({ mockSearchExperts: vi.fn() }));
vi.mock('@/lib/search/search-data', () => ({ searchExperts: mockSearchExperts }));

// Client children use next/navigation hooks.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/experts',
  useSearchParams: () => new URLSearchParams(),
}));

import ExpertsPage from './page';

function makeExpert(overrides: Partial<ExpertSearchResultDTO> = {}): ExpertSearchResultDTO {
  return {
    id: 'e1',
    username: 'anil',
    name: 'Anil Pilania',
    avatarUrl: null,
    headline: 'Salesforce Architect',
    bio: 'Bio',
    countryCode: 'CA',
    rate: 3.13,
    nextAvailableAt: null,
    languages: [],
    agency: null,
    distinctions: { isSalesforceMvp: false, isSalesforceCta: false, isCertifiedTrainer: false },
    rating: null,
    yearsExperience: 9,
    consultationCount: 124,
    ...overrides,
  };
}

function makeResponse(overrides: Partial<ExpertSearchResponseDTO> = {}): ExpertSearchResponseDTO {
  return {
    experts: [],
    total: 0,
    facetCounts: { products: [], supportTypes: [], languages: [] },
    wasAvailabilityGated: false,
    ...overrides,
  };
}

/** Render the async server component. */
async function renderPage(params: Record<string, string | string[]> = {}) {
  const ui = await ExpertsPage({ searchParams: Promise.resolve(params) });
  return render(ui);
}

beforeEach(() => {
  vi.clearAllMocks();
  window.scrollTo = vi.fn();
});

describe('ExpertsPage — success state', () => {
  it('renders the expert cards and the "N of M experts" count', async () => {
    mockSearchExperts.mockResolvedValue(
      makeResponse({
        experts: [
          makeExpert({ id: 'e1', name: 'Anil Pilania' }),
          makeExpert({ id: 'e2', name: 'Chad Lieberman', username: 'chad' }),
        ],
        total: 2,
      })
    );
    await renderPage();
    expect(screen.getAllByText('Anil Pilania').length).toBeGreaterThan(0);
    expect(screen.getByText(/of 2 experts/)).toBeInTheDocument();
  });

  it('builds the request from default URL state (empty params)', async () => {
    mockSearchExperts.mockResolvedValue(makeResponse({ experts: [makeExpert()], total: 1 }));
    await renderPage();
    const filters = mockSearchExperts.mock.calls[0]![0] as SearchFilters;
    expect(filters).toMatchObject({
      q: '',
      products: [],
      sort: 'best_match',
      page: 1,
      vertical: 'salesforce',
    });
  });

  it('passes parsed filters (query, facets, sort, page) from searchParams to the seam', async () => {
    mockSearchExperts.mockResolvedValue(makeResponse({ experts: [makeExpert()], total: 1 }));
    await renderPage({ q: 'flows', products: ['p1', 'p2'], sort: 'soonest', page: '2' });
    const filters = mockSearchExperts.mock.calls[0]![0] as SearchFilters;
    expect(filters).toMatchObject({
      q: 'flows',
      products: ['p1', 'p2'],
      sort: 'soonest',
      page: 2,
    });
  });
});

describe('ExpertsPage — empty states', () => {
  it('shows the not-gated copy when total is 0 and not availability-gated', async () => {
    mockSearchExperts.mockResolvedValue(makeResponse({ total: 0, wasAvailabilityGated: false }));
    await renderPage({ products: ['p1'] });
    expect(screen.getByText('No experts match those filters')).toBeInTheDocument();
  });

  it('shows the availability copy when total is 0 and availability-gated', async () => {
    mockSearchExperts.mockResolvedValue(makeResponse({ total: 0, wasAvailabilityGated: true }));
    await renderPage({ timeframe: 'today' });
    expect(screen.getByText('No experts available in that window')).toBeInTheDocument();
  });
});

describe('ExpertsPage — error state', () => {
  it('renders the inline error fallback when the seam rejects', async () => {
    mockSearchExperts.mockRejectedValue(new Error('boom'));
    await renderPage();
    expect(screen.getByText("We couldn't load experts")).toBeInTheDocument();
  });
});

describe('ExpertsPage — pagination', () => {
  it('renders numbered pages derived from total and the default page size', async () => {
    mockSearchExperts.mockResolvedValue(makeResponse({ experts: [makeExpert()], total: 45 }));
    await renderPage();
    // 45 / 20 → 3 pages
    expect(screen.getByRole('button', { name: 'Page 3' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Page 4' })).not.toBeInTheDocument();
  });

  it('shows the page-beyond-range state when total > 0 but the page has no results', async () => {
    mockSearchExperts.mockResolvedValue(makeResponse({ experts: [], total: 25 }));
    await renderPage({ page: '99' });
    expect(screen.getByText('Nothing on this page')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to page 1' })).toBeInTheDocument();
  });
});

describe('ExpertsPage — layout', () => {
  it('renders list markup at md and grid markup on mobile when layout=list', async () => {
    mockSearchExperts.mockResolvedValue(
      makeResponse({ experts: [makeExpert(), makeExpert({ id: 'e2' })], total: 2 })
    );
    const { container } = await renderPage({ layout: 'list' });
    // Dual-block: a md:hidden grid block AND a hidden md:block list block.
    expect(container.querySelector('.md\\:hidden')).toBeTruthy();
    expect(container.querySelector('.hidden.md\\:block')).toBeTruthy();
  });
});
