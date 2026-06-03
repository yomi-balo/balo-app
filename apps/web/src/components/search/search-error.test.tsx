import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';

const { mockRefresh } = vi.hoisted(() => ({ mockRefresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mockRefresh }) }));

import { SearchError } from './search-error';

beforeEach(() => vi.clearAllMocks());

describe('SearchError', () => {
  it('renders the graceful fallback message', () => {
    render(<SearchError />);
    expect(screen.getByText("We couldn't load experts")).toBeInTheDocument();
  });

  it('re-runs the RSC fetch via router.refresh on Try again', async () => {
    const user = userEvent.setup();
    render(<SearchError />);
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });
});
