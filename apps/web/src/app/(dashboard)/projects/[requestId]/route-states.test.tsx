import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';

// Sibling tests stub these seams; the segment files don't import them directly,
// but stubbing keeps the suite isolated from server-only / analytics side effects.
vi.mock('server-only', () => ({}));

import RequestDetailLoading from './loading';
import RequestDetailError from './error';
import RequestNotFound from './not-found';

describe('projects/[requestId]/loading', () => {
  it('renders the skeleton shell (pulse placeholders, no spinner)', () => {
    const { container } = render(<RequestDetailLoading />);
    expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0);
  });
});

describe('projects/[requestId]/error', () => {
  it('renders the fallback and calls reset() on "Try again"', async () => {
    const user = userEvent.setup();
    const reset = vi.fn();
    render(<RequestDetailError error={new Error('boom')} reset={reset} />);

    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(reset).toHaveBeenCalledTimes(1);
  });
});

describe('projects/[requestId]/not-found', () => {
  it('renders the single no-leak copy and a "Back to projects" link', () => {
    render(<RequestNotFound />);
    // One ambiguous copy that does not distinguish missing from unauthorised.
    expect(screen.getByText('Request not found')).toBeInTheDocument();
    expect(screen.getByText(/doesn't exist, or you don't have access to it/i)).toBeInTheDocument();

    const link = screen.getByRole('link', { name: 'Back to projects' });
    expect(link).toHaveAttribute('href', '/projects');
  });
});
