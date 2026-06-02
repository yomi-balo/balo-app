import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import ExpertsLoading from './loading';
import ExpertsError from './error';

describe('experts/loading', () => {
  it('renders the skeleton grid shell (no spinner)', () => {
    render(<ExpertsLoading />);
    expect(screen.getAllByLabelText('Loading expert card').length).toBeGreaterThan(0);
  });
});

describe('experts/error', () => {
  it('renders the fallback and calls reset on Try again', async () => {
    const user = userEvent.setup();
    const reset = vi.fn();
    render(<ExpertsError error={new Error('boom')} reset={reset} />);
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(reset).toHaveBeenCalledTimes(1);
  });
});
