import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { EMPTY_FILTERS } from '@/lib/search/filters';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => '/experts',
  useSearchParams: () => new URLSearchParams(),
}));

import { ResultsControls } from './results-controls';

const facetCounts = {
  products: [{ id: 'p1', name: 'Agentforce', count: 18 }],
  supportTypes: [],
  languages: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  window.scrollTo = vi.fn();
});

describe('ResultsControls', () => {
  it('renders the toolbar and opens the filter sheet from the mobile Filters button', async () => {
    const user = userEvent.setup();
    render(
      <ResultsControls
        shown={1}
        total={5}
        layout="grid"
        sort="best_match"
        activeCount={0}
        filters={EMPTY_FILTERS}
        facetCounts={facetCounts}
      />
    );

    // Sheet closed initially.
    expect(screen.queryByRole('dialog', { name: 'Filters' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /filters/i }));

    expect(screen.getByRole('dialog', { name: 'Filters' })).toBeInTheDocument();
  });
});
