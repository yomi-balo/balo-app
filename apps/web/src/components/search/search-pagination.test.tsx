import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { SEARCH_EVENTS } from '@balo/analytics/events';
import { track } from '@/lib/analytics';

const { mockPush, mockUseSearchParams } = vi.hoisted(() => ({
  mockPush: vi.fn(),
  mockUseSearchParams: vi.fn(() => new URLSearchParams()),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: mockPush }),
  usePathname: () => '/experts',
  useSearchParams: () => mockUseSearchParams(),
}));

import { SearchPagination } from './search-pagination';

const mockTrack = vi.mocked(track);

beforeEach(() => {
  vi.clearAllMocks();
  mockUseSearchParams.mockReturnValue(new URLSearchParams());
  window.scrollTo = vi.fn();
});

describe('SearchPagination', () => {
  it('renders nothing when there is a single page', () => {
    const { container } = render(<SearchPagination page={1} total={12} pageSize={20} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders numbered pages from total/pageSize (ceil)', () => {
    render(<SearchPagination page={1} total={45} pageSize={20} />);
    // 45 / 20 → 3 pages
    expect(screen.getByRole('button', { name: 'Page 1' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Page 2' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Page 3' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Page 4' })).not.toBeInTheDocument();
  });

  it('disables Previous on the first page', () => {
    render(<SearchPagination page={1} total={45} pageSize={20} />);
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Next page' })).toBeEnabled();
  });

  it('disables Next on the last page', () => {
    render(<SearchPagination page={3} total={45} pageSize={20} />);
    expect(screen.getByRole('button', { name: 'Next page' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeEnabled();
  });

  it('navigates and emits search_pagination on a page click', async () => {
    const user = userEvent.setup();
    render(<SearchPagination page={1} total={45} pageSize={20} />);
    await user.click(screen.getByRole('button', { name: 'Page 2' }));
    expect(mockTrack).toHaveBeenCalledWith(SEARCH_EVENTS.PAGINATION, { to_page: 2 });
    expect(mockPush).toHaveBeenCalledWith('/experts?page=2', { scroll: false });
  });

  it('does nothing when clicking the current page', async () => {
    const user = userEvent.setup();
    render(<SearchPagination page={2} total={45} pageSize={20} />);
    await user.click(screen.getByRole('button', { name: 'Page 2' }));
    expect(mockTrack).not.toHaveBeenCalled();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('Next advances to the following page', async () => {
    const user = userEvent.setup();
    render(<SearchPagination page={1} total={45} pageSize={20} />);
    await user.click(screen.getByRole('button', { name: 'Next page' }));
    expect(mockPush).toHaveBeenCalledWith('/experts?page=2', { scroll: false });
  });

  it('renders the compact "Page N of M" mobile branch', () => {
    render(<SearchPagination page={2} total={45} pageSize={20} />);
    const compact = screen.getByText('Page 2 of 3');
    expect(compact.className).toContain('md:hidden');
  });
});
