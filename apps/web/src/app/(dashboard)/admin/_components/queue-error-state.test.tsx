import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';

const mockRefresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: mockRefresh }),
}));

import { QueueErrorState } from './queue-error-state';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('QueueErrorState', () => {
  it('renders the verbatim reassurance copy and a Retry button that calls router.refresh()', async () => {
    const user = userEvent.setup();
    render(<QueueErrorState />);
    expect(screen.getByText("Home didn't load")).toBeInTheDocument();
    expect(
      screen.getByText(/nothing was changed, and every alert is still recorded/i)
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });
});
