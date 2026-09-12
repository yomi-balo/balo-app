import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@/test/utils';
import userEvent from '@testing-library/user-event';

const mockReplace = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mockReplace }),
}));

import { ApplicationFilterChips } from './application-filter-chips';

const COUNTS = { pending: 4, approved: 2, declined: 1 };

beforeEach(() => {
  mockReplace.mockClear();
});

describe('ApplicationFilterChips', () => {
  it('renders three chips in order with live counts', () => {
    render(<ApplicationFilterChips filter="pending" counts={COUNTS} />);
    const group = screen.getByRole('group', { name: /filter applications/i });
    const buttons = within(group).getAllByRole('button');
    expect(buttons.map((b) => b.textContent)).toEqual(['Pending4', 'Approved2', 'Declined1']);
  });

  it('marks the active chip aria-pressed=true and others false', () => {
    render(<ApplicationFilterChips filter="approved" counts={COUNTS} />);
    expect(screen.getByRole('button', { name: /^Approved/ })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(screen.getByRole('button', { name: /^Pending/ })).toHaveAttribute(
      'aria-pressed',
      'false'
    );
  });

  it('dims and disables a zero-count chip that is not active', () => {
    const counts = { ...COUNTS, declined: 0 };
    render(<ApplicationFilterChips filter="pending" counts={counts} />);
    expect(screen.getByRole('button', { name: /^Declined/ })).toBeDisabled();
  });

  it('never disables the active chip even at zero count', () => {
    const counts = { ...COUNTS, declined: 0 };
    render(<ApplicationFilterChips filter="declined" counts={counts} />);
    expect(screen.getByRole('button', { name: /^Declined/ })).not.toBeDisabled();
  });

  it('replaces the URL with the clicked filter (not tabs — no role=tab anywhere)', async () => {
    const user = userEvent.setup();
    render(<ApplicationFilterChips filter="pending" counts={COUNTS} />);
    await user.click(screen.getByRole('button', { name: /^Approved/ }));
    expect(mockReplace).toHaveBeenCalledWith('/admin/applications?filter=approved', {
      scroll: false,
    });
    expect(screen.queryByRole('tab')).toBeNull();
    expect(screen.queryByRole('tablist')).toBeNull();
  });
});
