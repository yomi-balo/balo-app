import { describe, expect, it } from 'vitest';

import { render, screen, within } from '@/test/utils';
import type { EngagementProgressView } from '@/lib/engagement/engagement-view';

import { EngagementProgress } from './engagement-progress';

function makeProgress(overrides: Partial<EngagementProgressView> = {}): EngagementProgressView {
  return {
    done: 2,
    total: 5,
    pct: 40,
    reviewCopy: null,
    reviewPill: null,
    segments: [
      { id: 'a', tone: 'completed', label: 'Discovery: Completed' },
      { id: 'b', tone: 'completed', label: 'Design: Completed' },
      { id: 'c', tone: 'in_progress', label: 'Build: In progress' },
      { id: 'd', tone: 'pending', label: 'Test: Not started' },
      { id: 'e', tone: 'pending', label: 'Launch: Not started' },
    ],
    ...overrides,
  };
}

describe('EngagementProgress', () => {
  it('renders the done/total count and never a percentage', () => {
    render(<EngagementProgress progress={makeProgress()} />);

    expect(screen.getByText('2 of 5')).toBeInTheDocument();
    expect(screen.getByText('milestones completed')).toBeInTheDocument();
    expect(screen.queryByText(/%/)).not.toBeInTheDocument();
  });

  it('exposes an accessible native progress element with the correct value', () => {
    render(<EngagementProgress progress={makeProgress({ pct: 40 })} />);

    const bar = screen.getByRole('progressbar');
    expect(bar).toHaveAttribute('value', '40');
    expect(bar).toHaveAttribute('max', '100');
    expect(bar).toHaveAttribute('aria-label', 'Milestones completed');
  });

  it('renders one named segment per milestone', () => {
    render(<EngagementProgress progress={makeProgress()} />);

    const list = screen.getByRole('list', { name: 'Milestone progress' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(5);
    expect(items[0]).toHaveAccessibleName('Discovery: Completed');
    expect(items[2]).toHaveAttribute('title', 'Build: In progress');
  });

  it('colours each segment by tone, with the signature gradient on completed ones', () => {
    render(
      <EngagementProgress
        progress={makeProgress({
          segments: [
            { id: 'a', tone: 'completed', label: 'A: Completed' },
            { id: 'b', tone: 'reopened', label: 'B: Changes requested' },
            { id: 'c', tone: 'in_progress', label: 'C: In progress' },
            { id: 'd', tone: 'pending', label: 'D: Not started' },
          ],
        })}
      />
    );

    expect(screen.getByLabelText('A: Completed').className).toContain('to-violet-600');
    expect(screen.getByLabelText('B: Changes requested').className).toContain('bg-warning');
    expect(screen.getByLabelText('C: In progress').className).toContain('bg-primary/60');
    expect(screen.getByLabelText('D: Not started').className).toContain('bg-muted');
  });

  it('lists only the tones in use in the legend, with counts', () => {
    render(<EngagementProgress progress={makeProgress()} />);

    expect(screen.getByText('Completed 2')).toBeInTheDocument();
    expect(screen.getByText('In progress 1')).toBeInTheDocument();
    expect(screen.getByText('Not started 2')).toBeInTheDocument();
    expect(screen.queryByText(/Changes requested/)).not.toBeInTheDocument();
  });

  it.each([
    ['warning', 'Changes requested'],
    ['violet', 'Ready for your review'],
    ['success', 'Accepted 6 Jul'],
  ] as const)('renders the %s review pill', (tone, label) => {
    render(<EngagementProgress progress={makeProgress({ reviewPill: { label, tone } })} />);

    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it('renders no pill when the view carries none', () => {
    render(<EngagementProgress progress={makeProgress()} />);

    expect(screen.queryByText(/Changes requested|Ready for your review|Accepted/)).toBeNull();
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
    expect(screen.getByRole('progressbar')).toHaveAttribute('value', '100');
  });

  it('uses the singular noun when there is exactly one milestone', () => {
    render(<EngagementProgress progress={makeProgress({ done: 0, total: 1, pct: 0 })} />);

    expect(screen.getByText('0 of 1')).toBeInTheDocument();
    expect(screen.getByText('milestone completed')).toBeInTheDocument();
    expect(screen.queryByText('milestones completed')).not.toBeInTheDocument();
  });
});
