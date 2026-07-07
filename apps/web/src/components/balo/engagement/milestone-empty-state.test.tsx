import { describe, it, expect } from 'vitest';

import { render, screen } from '@/test/utils';
import type { EmptyStateView } from '@/lib/engagement/engagement-view';

import { MilestoneEmptyState } from './milestone-empty-state';

const expertInvitation: EmptyStateView = {
  title: 'Shape the delivery plan',
  body: 'Add your first milestone so the client can follow progress.',
  icon: 'Flag',
};

const clientInvitation: EmptyStateView = {
  title: 'Priya is shaping the delivery plan',
  body: "Milestones appear here as Priya adds them, and you'll be notified as each is delivered.",
  icon: 'Flag',
};

describe('MilestoneEmptyState', () => {
  it('renders the invitation title as a heading and the body', () => {
    render(<MilestoneEmptyState emptyState={expertInvitation} />);
    // Composed under the page <h1>; the invitation heading is an <h2> (no skipped level).
    expect(
      screen.getByRole('heading', { level: 2, name: 'Shape the delivery plan' })
    ).toBeInTheDocument();
    expect(screen.getByText(/Add your first milestone/)).toBeInTheDocument();
  });

  it('renders per-lens invitation copy', () => {
    render(<MilestoneEmptyState emptyState={clientInvitation} />);
    expect(
      screen.getByRole('heading', { level: 2, name: 'Priya is shaping the delivery plan' })
    ).toBeInTheDocument();
  });

  it('renders no add-milestone CTA (read-only)', () => {
    render(<MilestoneEmptyState emptyState={expertInvitation} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('falls back to the Flag icon defensively for a non-Flag icon value', () => {
    // `icon` is typed as the full `ViewIcon` union; the empty state only ever
    // carries `Flag`, but the map guards against any other value falling through.
    render(<MilestoneEmptyState emptyState={{ ...expertInvitation, icon: 'Layers' }} />);
    expect(
      screen.getByRole('heading', { level: 2, name: 'Shape the delivery plan' })
    ).toBeInTheDocument();
  });
});
