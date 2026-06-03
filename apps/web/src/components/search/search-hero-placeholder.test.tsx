import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';

const { mockReplace, mockUseSearchParams } = vi.hoisted(() => ({
  mockReplace: vi.fn(),
  mockUseSearchParams: vi.fn(() => new URLSearchParams()),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mockReplace, push: vi.fn() }),
  usePathname: () => '/experts',
  useSearchParams: () => mockUseSearchParams(),
}));

import { SearchHeroPlaceholder } from './search-hero-placeholder';

beforeEach(() => {
  vi.clearAllMocks();
  mockUseSearchParams.mockReturnValue(new URLSearchParams());
  window.scrollTo = vi.fn();
});

describe('SearchHeroPlaceholder', () => {
  it('writes the query param on submit', async () => {
    const user = userEvent.setup();
    render(<SearchHeroPlaceholder initialQuery="" />);
    await user.type(screen.getByLabelText('Search experts'), 'agentforce rollout');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    expect(mockReplace).toHaveBeenCalledWith('/experts?q=agentforce+rollout', { scroll: false });
  });

  it('clears the query param when submitted empty', async () => {
    const user = userEvent.setup();
    mockUseSearchParams.mockReturnValue(new URLSearchParams('q=old'));
    render(<SearchHeroPlaceholder initialQuery="old" />);
    await user.clear(screen.getByLabelText('Search experts'));
    await user.click(screen.getByRole('button', { name: 'Search' }));
    expect(mockReplace).toHaveBeenCalledWith('/experts', { scroll: false });
  });

  it('seeds the input from initialQuery', () => {
    render(<SearchHeroPlaceholder initialQuery="seeded" />);
    expect(screen.getByLabelText('Search experts')).toHaveValue('seeded');
  });
});
