import { describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';

import { render, screen } from '@/test/utils';

vi.mock('next/navigation', () => ({ useParams: () => ({ id: 'eng-1' }) }));

import ChangeOrderComposerLoading from './loading';
import ChangeOrderComposerError from './error';

describe('engagements/[id]/change-order/loading', () => {
  it('renders the two-column skeleton (pulse placeholders, no spinner)', () => {
    const { container } = render(<ChangeOrderComposerLoading />);
    expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0);
    expect(container.querySelector('[class*="lg:grid-cols"]')).not.toBeNull();
  });
});

describe('engagements/[id]/change-order/error', () => {
  it('renders the fallback and calls reset() on "Try again"', async () => {
    const user = userEvent.setup();
    const reset = vi.fn();
    render(<ChangeOrderComposerError error={new Error('boom')} reset={reset} />);

    expect(screen.getByText("The change didn't load")).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to the project' })).toHaveAttribute(
      'href',
      '/engagements/eng-1'
    );
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(reset).toHaveBeenCalledTimes(1);
  });
});
