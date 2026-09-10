import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/utils';
import { GroupTiles } from './group-tiles';
import type { AdminQueueTileView } from '../_lib/admin-queue-view';

function tiles(
  overrides: Partial<Record<string, Partial<AdminQueueTileView>>> = {}
): AdminQueueTileView[] {
  const base: AdminQueueTileView[] = [
    {
      key: 'marketplace',
      label: 'Marketplace',
      hint: 'hint-m',
      count: 3,
      oldestAgeLabel: '2d',
      active: false,
    },
    { key: 'money', label: 'Money', hint: 'hint-$', count: 0, oldestAgeLabel: null, active: false },
    {
      key: 'capture',
      label: 'Capture',
      hint: 'hint-c',
      count: 1,
      oldestAgeLabel: '5h',
      active: false,
    },
    {
      key: 'meetings',
      label: 'Meetings & calendar',
      hint: 'hint-cal',
      count: 0,
      oldestAgeLabel: null,
      active: false,
    },
  ];
  return base.map((tile) => ({ ...tile, ...overrides[tile.key] }));
}

describe('GroupTiles', () => {
  it('renders all four tiles, each linking to its own group filter', () => {
    render(<GroupTiles tiles={tiles()} />);
    expect(screen.getByRole('link', { name: /Marketplace/ })).toHaveAttribute(
      'href',
      '/admin?group=marketplace'
    );
    expect(screen.getByRole('link', { name: /Money/ })).toHaveAttribute(
      'href',
      '/admin?group=money'
    );
  });

  it('shows the exact count and "oldest {age}" sub-line when a tile has open rows', () => {
    render(<GroupTiles tiles={tiles()} />);
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('oldest 2d')).toBeInTheDocument();
  });

  it('shows "nothing open" for an empty group', () => {
    render(<GroupTiles tiles={tiles()} />);
    expect(screen.getAllByText('nothing open')).toHaveLength(2);
  });

  it('links back to /admin (clears the filter) and marks aria-current on the active tile', () => {
    render(<GroupTiles tiles={tiles({ marketplace: { active: true } })} />);
    const activeTile = screen.getByRole('link', { name: /Marketplace/ });
    expect(activeTile).toHaveAttribute('href', '/admin');
    expect(activeTile).toHaveAttribute('aria-current', 'page');
  });
});
