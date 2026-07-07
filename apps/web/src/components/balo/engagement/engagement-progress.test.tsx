import { describe, expect, it } from 'vitest';

import { render, screen } from '@/test/utils';
import type { EngagementProgressView } from '@/lib/engagement/engagement-view';

import { EngagementProgress } from './engagement-progress';

function makeProgress(overrides: Partial<EngagementProgressView> = {}): EngagementProgressView {
  return {
    done: 2,
    total: 5,
    pct: 40,
    reviewCopy: null,
    ...overrides,
  };
}

describe('EngagementProgress', () => {
  it('renders the done/total count and percentage', () => {
    render(<EngagementProgress progress={makeProgress()} />);

    expect(screen.getByText('2 of 5')).toBeInTheDocument();
    expect(screen.getByText('milestones completed')).toBeInTheDocument();
    expect(screen.getByText('40%')).toBeInTheDocument();
  });

  it('exposes an accessible progressbar with the correct aria values', () => {
    render(<EngagementProgress progress={makeProgress({ pct: 40 })} />);

    const bar = screen.getByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuenow', '40');
    expect(bar).toHaveAttribute('aria-valuemin', '0');
    expect(bar).toHaveAttribute('aria-valuemax', '100');
    expect(bar).toHaveStyle({ width: '40%' });
  });

  it('applies the signature gradient fill', () => {
    render(<EngagementProgress progress={makeProgress()} />);

    const bar = screen.getByRole('progressbar');
    expect(bar.className).toContain('from-primary');
    expect(bar.className).toContain('to-violet-600');
  });

  it('renders the client-lens review copy when present', () => {
    render(
      <EngagementProgress
        progress={makeProgress({
          reviewCopy: 'When the whole project is done, you review it — accept or request changes.',
        })}
      />
    );

    expect(screen.getByText(/you review it — accept or request changes/i)).toBeInTheDocument();
  });

  it('omits the review copy for the expert/admin lens (null)', () => {
    render(<EngagementProgress progress={makeProgress({ reviewCopy: null })} />);

    expect(screen.queryByText(/request changes/i)).not.toBeInTheDocument();
  });

  it('renders a fully-complete bar at 100%', () => {
    render(<EngagementProgress progress={makeProgress({ done: 5, total: 5, pct: 100 })} />);

    expect(screen.getByText('5 of 5')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');
  });
});
