import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import ProposalComposerError from './error';

describe('ProposalComposerError', () => {
  it('renders the boundary copy', () => {
    render(<ProposalComposerError error={new Error('boom')} reset={vi.fn()} />);
    expect(screen.getByText(/Couldn't open the composer/i)).toBeInTheDocument();
    expect(screen.getByText(/couldn't load your proposal draft/i)).toBeInTheDocument();
  });

  it('calls reset when "Try again" is clicked', async () => {
    const user = userEvent.setup();
    const reset = vi.fn();
    render(<ProposalComposerError error={new Error('boom')} reset={reset} />);

    await user.click(screen.getByRole('button', { name: /try again/i }));
    expect(reset).toHaveBeenCalledTimes(1);
  });
});
