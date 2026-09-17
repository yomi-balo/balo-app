import { describe, it, expect } from 'vitest';
import { render } from '@/test/utils';
import { UpNextCardSkeleton } from './up-next-card-skeleton';

describe('UpNextCardSkeleton (BAL-566 fix round 1, F8)', () => {
  it('renders an aria-busy <section>', () => {
    const { container } = render(<UpNextCardSkeleton />);
    const section = container.querySelector('section');
    expect(section).not.toBeNull();
    expect(section).toHaveAttribute('aria-busy', 'true');
  });

  it('renders the title and subtitle skeleton bars, plus three placeholder rows', () => {
    const { container } = render(<UpNextCardSkeleton />);
    // Title + subtitle bars, outside the row list.
    const topBars = container.querySelectorAll('section > div.bg-muted');
    expect(topBars.length).toBeGreaterThanOrEqual(2);

    // Three skeleton rows, each with an icon tile and two text placeholders either side.
    const rows = container.querySelectorAll('.space-y-3 > div');
    expect(rows).toHaveLength(3);
    for (const rowEl of rows) {
      expect(rowEl.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0);
    }
  });
});
