import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';

// Sibling tests stub these seams; the segment files don't import them directly,
// but stubbing keeps the suite isolated from server-only / analytics side effects.
vi.mock('server-only', () => ({}));

import EngagementWorkspaceLoading from './loading';
import EngagementWorkspaceError from './error';
import EngagementNotFound from './not-found';

describe('engagements/[id]/loading', () => {
  it('renders the skeleton shell (pulse placeholders, no spinner)', () => {
    const { container } = render(<EngagementWorkspaceLoading />);
    expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0);
  });
});

describe('engagements/[id]/error', () => {
  it('renders the fallback and calls reset() on "Try again"', async () => {
    const user = userEvent.setup();
    const reset = vi.fn();
    render(<EngagementWorkspaceError error={new Error('boom')} reset={reset} />);

    expect(screen.getByText("This engagement didn't load")).toBeInTheDocument();
    // The boundary offers a navigational escape hatch alongside retry.
    expect(screen.getByRole('link', { name: 'Back to projects' })).toHaveAttribute(
      'href',
      '/projects'
    );
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(reset).toHaveBeenCalledTimes(1);
  });
});

describe('engagements/[id]/not-found', () => {
  it('renders the single no-leak copy and a "Back to projects" link', () => {
    render(<EngagementNotFound />);
    expect(screen.getByText('Engagement not found')).toBeInTheDocument();
    expect(screen.getByText(/doesn't exist, or you don't have access to it/i)).toBeInTheDocument();

    const link = screen.getByRole('link', { name: 'Back to projects' });
    expect(link).toHaveAttribute('href', '/projects');
  });
});
