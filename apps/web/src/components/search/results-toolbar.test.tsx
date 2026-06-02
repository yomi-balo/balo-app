import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { SEARCH_EVENTS } from '@balo/analytics/events';
import { track } from '@/lib/analytics';

const { mockReplace, mockUseSearchParams } = vi.hoisted(() => ({
  mockReplace: vi.fn(),
  mockUseSearchParams: vi.fn(() => new URLSearchParams()),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mockReplace, push: vi.fn() }),
  usePathname: () => '/experts',
  useSearchParams: () => mockUseSearchParams(),
}));

import { ResultsToolbar } from './results-toolbar';

const mockTrack = vi.mocked(track);

beforeEach(() => {
  vi.clearAllMocks();
  mockUseSearchParams.mockReturnValue(new URLSearchParams());
  window.scrollTo = vi.fn();
});

function renderToolbar(overrides: Partial<React.ComponentProps<typeof ResultsToolbar>> = {}) {
  return render(
    <ResultsToolbar
      shown={6}
      total={8}
      layout="grid"
      sort="best_match"
      activeCount={0}
      onOpenFilters={vi.fn()}
      {...overrides}
    />
  );
}

describe('ResultsToolbar', () => {
  it('renders the "N of M experts" count and trust line', () => {
    renderToolbar();
    expect(screen.getByText(/of 8 experts/)).toBeInTheDocument();
    expect(screen.getByText('6')).toBeInTheDocument();
  });

  it('exposes the grid/list toggle as a desktop-only group (hidden md:flex)', () => {
    renderToolbar();
    const group = screen.getByRole('group', { name: 'Layout' });
    // Desktop controls container is hidden until md.
    expect(group.parentElement?.className).toContain('hidden');
    expect(group.parentElement?.className).toContain('md:flex');
  });

  it('writes layout=list and emits search_layout_toggled when switching to list', async () => {
    const user = userEvent.setup();
    renderToolbar({ layout: 'grid' });
    await user.click(screen.getByRole('button', { name: 'List view' }));
    expect(mockTrack).toHaveBeenCalledWith(SEARCH_EVENTS.LAYOUT_TOGGLED, { to: 'list' });
    expect(mockReplace).toHaveBeenCalledWith('/experts?layout=list', { scroll: false });
  });

  it('preserves the current page when toggling layout (chrome, not a filter)', async () => {
    const user = userEvent.setup();
    mockUseSearchParams.mockReturnValue(new URLSearchParams('page=3'));
    renderToolbar({ layout: 'grid' });
    await user.click(screen.getByRole('button', { name: 'List view' }));
    const url = mockReplace.mock.calls[0]![0] as string;
    expect(url).toContain('layout=list');
    expect(url).toContain('page=3');
  });

  it('removes the layout param (back to default) when switching to grid', async () => {
    const user = userEvent.setup();
    mockUseSearchParams.mockReturnValue(new URLSearchParams('layout=list'));
    renderToolbar({ layout: 'list' });
    await user.click(screen.getByRole('button', { name: 'Grid view' }));
    expect(mockTrack).toHaveBeenCalledWith(SEARCH_EVENTS.LAYOUT_TOGGLED, { to: 'grid' });
    expect(mockReplace).toHaveBeenCalledWith('/experts', { scroll: false });
  });

  it('does not write or emit when clicking the already-active layout', async () => {
    const user = userEvent.setup();
    renderToolbar({ layout: 'grid' });
    await user.click(screen.getByRole('button', { name: 'Grid view' }));
    expect(mockTrack).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('calls onOpenFilters from the mobile Filters button and shows the active-count badge', async () => {
    const user = userEvent.setup();
    const onOpenFilters = vi.fn();
    renderToolbar({ activeCount: 3, onOpenFilters });
    const filtersBtn = screen.getByRole('button', { name: /filters/i });
    expect(filtersBtn).toHaveTextContent('3');
    await user.click(filtersBtn);
    expect(onOpenFilters).toHaveBeenCalledTimes(1);
  });

  it('layout toggle buttons are keyboard-reachable and labelled', () => {
    renderToolbar();
    expect(screen.getByRole('button', { name: 'Grid view' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'List view' })).toBeEnabled();
  });
});
