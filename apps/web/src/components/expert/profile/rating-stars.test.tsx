import { describe, it, expect } from 'vitest';
import { render } from '@/test/utils';
import { RatingStars, StarRow } from './rating-stars';

/**
 * `RatingStars` / `StarRow` are token-driven primitives shipped for a future
 * reviews feature — they're null-gated out of the v1 profile, so they need
 * direct coverage. Both clip a fill overlay to `rating/5`; assert the clamp.
 */
describe('RatingStars', () => {
  it('clips the fill overlay to the fractional rating/5 percentage', () => {
    const { container } = render(<RatingStars rating={2.5} />);
    const overlay = container.querySelector<HTMLElement>('.overflow-hidden');
    expect(overlay).not.toBeNull();
    expect(overlay?.style.width).toBe('50%');
  });

  it('clamps an out-of-range rating to 100%', () => {
    const { container } = render(<RatingStars rating={9} size={20} />);
    const overlay = container.querySelector<HTMLElement>('.overflow-hidden');
    expect(overlay?.style.width).toBe('100%');
  });

  it('clamps a negative rating to 0%', () => {
    const { container } = render(<RatingStars rating={-1} />);
    const overlay = container.querySelector<HTMLElement>('.overflow-hidden');
    expect(overlay?.style.width).toBe('0%');
  });
});

describe('StarRow', () => {
  it('renders five stars per layer and clips the filled layer to the rating', () => {
    const { container } = render(<StarRow rating={4} />);
    // Two layers (empty base + filled overlay) × 5 stars each.
    expect(container.querySelectorAll('svg')).toHaveLength(10);
    const overlay = container.querySelector<HTMLElement>('.overflow-hidden');
    expect(overlay?.style.width).toBe('80%');
  });
});
