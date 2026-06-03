import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/utils';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => '/experts',
  useSearchParams: () => new URLSearchParams(),
}));

import { ResultsControls } from './results-controls';

beforeEach(() => {
  vi.clearAllMocks();
  window.scrollTo = vi.fn();
});

describe('ResultsControls', () => {
  it('renders the results toolbar (count + sort) without owning a filter sheet', () => {
    render(<ResultsControls shown={1} total={5} layout="grid" sort="best_match" />);

    expect(screen.getByText(/of 5 experts/)).toBeInTheDocument();
    // The mobile filter trigger now lives in the one-tap MobileComposerBar.
    expect(screen.queryByRole('button', { name: /filters/i })).not.toBeInTheDocument();
    // No filter sheet is mounted here anymore.
    expect(screen.queryByRole('dialog', { name: 'Search & filter' })).not.toBeInTheDocument();
  });
});
