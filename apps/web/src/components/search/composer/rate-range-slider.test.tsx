import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@/test/utils';
import { RATE_BOUNDS } from './constants';
import { RateRangeSlider } from './rate-range-slider';

beforeEach(() => {
  window.scrollTo = vi.fn();
});

describe('RateRangeSlider', () => {
  it('renders two thumbs and the A$ endpoint labels', () => {
    render(<RateRangeSlider rateMinDollars={null} rateMaxDollars={null} onCommit={vi.fn()} />);
    expect(screen.getAllByRole('slider')).toHaveLength(2);
    expect(screen.getByText('A$0')).toBeInTheDocument();
    expect(screen.getByText(`A$${RATE_BOUNDS.max}+`)).toBeInTheDocument();
  });

  it('reflects the current bounds from props', () => {
    render(<RateRangeSlider rateMinDollars={2} rateMaxDollars={8} onCommit={vi.fn()} />);
    const thumbs = screen.getAllByRole('slider');
    expect(thumbs[0]).toHaveAttribute('aria-valuenow', '2');
    expect(thumbs[1]).toHaveAttribute('aria-valuenow', '8');
  });

  it('commits a bounds object on keyboard value-commit', () => {
    const onCommit = vi.fn();
    render(<RateRangeSlider rateMinDollars={2} rateMaxDollars={8} onCommit={onCommit} />);
    const minThumb = screen.getAllByRole('slider')[0]!;
    minThumb.focus();
    fireEvent.keyDown(minThumb, { key: 'Home' });
    expect(onCommit).toHaveBeenCalled();
    const lastCall = onCommit.mock.calls.at(-1)![0];
    expect(lastCall).toHaveProperty('min');
    expect(lastCall).toHaveProperty('max');
  });
});
