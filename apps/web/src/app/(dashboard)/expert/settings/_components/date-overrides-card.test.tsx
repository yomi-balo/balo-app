import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, waitFor } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import type { AvailabilityOverrideDto } from '../_types/availability-override';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const mockGet = vi.fn();
const mockCreate = vi.fn();
const mockDelete = vi.fn();

vi.mock('../_actions/get-availability-overrides', () => ({
  getAvailabilityOverridesAction: () => mockGet(),
}));
vi.mock('../_actions/create-availability-override', () => ({
  createAvailabilityOverrideAction: (...args: unknown[]) => mockCreate(...args),
}));
vi.mock('../_actions/delete-availability-override', () => ({
  deleteAvailabilityOverrideAction: (...args: unknown[]) => mockDelete(...args),
}));

import { toast } from 'sonner';
import { DateOverridesCard } from './date-overrides-card';

const CHRISTMAS: AvailabilityOverrideDto = {
  id: 'o1',
  startDate: '2026-12-25',
  endDate: '2026-12-25',
  label: 'Holiday',
};

const NEW_YEAR: AvailabilityOverrideDto = {
  id: 'o2',
  startDate: '2026-12-24',
  endDate: '2026-12-26',
  label: 'Holiday',
};

/**
 * Click today's cell in the open calendar. Today is always in the default
 * (current) month and — since the picker now disables all days before today —
 * is guaranteed enabled, so this is deterministic regardless of the run date
 * (a fixed day-of-month could otherwise land on a past, disabled cell). Each
 * day button carries a date-unique `data-day` (`Date#toLocaleDateString`), so
 * matching today's key avoids the outside-day duplicate-number ambiguity.
 */
async function pickToday(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  const grid = await screen.findByRole('grid');
  const todayKey = new Date().toLocaleDateString();
  const todayButton = within(grid)
    .getAllByRole('button')
    .find((b) => b.getAttribute('data-day') === todayKey);
  if (!todayButton) throw new Error("expected today's day button to be enabled");
  await user.click(todayButton);
}

describe('DateOverridesCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows the invitation-framed empty state once loading resolves with no blocks', async () => {
    mockGet.mockResolvedValue([]);
    render(<DateOverridesCard />);

    expect(
      await screen.findByText(/No time off scheduled — add dates when you're unavailable\./i)
    ).toBeInTheDocument();
  });

  it('renders existing time-off blocks with a formatted range and label', async () => {
    mockGet.mockResolvedValue([CHRISTMAS]);
    render(<DateOverridesCard />);

    expect(await screen.findByText('Fri, 25 Dec 2026')).toBeInTheDocument();
    expect(screen.getByText('Holiday')).toBeInTheDocument();
  });

  it('shows an error state when the fetch rejects', async () => {
    mockGet.mockRejectedValue(new Error('boom'));
    render(<DateOverridesCard />);

    expect(await screen.findByText(/Couldn't load your time off/i)).toBeInTheDocument();
  });

  it('opens the add popover, submits a picked date, calls the action, toasts, and shows the new row', async () => {
    const user = userEvent.setup();
    mockGet.mockResolvedValue([]);
    mockCreate.mockResolvedValue({ success: true, override: NEW_YEAR });
    render(<DateOverridesCard />);

    await screen.findByText(/No time off scheduled/i);

    await user.click(screen.getByRole('button', { name: /add time off/i }));

    // Popover + calendar open. Pick today (always enabled) BEFORE typing the
    // label — typing re-renders the popover and would detach an earlier grid ref.
    await pickToday(user);

    await user.type(screen.getByLabelText('Label (optional)'), 'Holiday');
    await user.click(screen.getByRole('button', { name: /block these dates/i }));

    await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1));
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        startDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        endDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        label: 'Holiday',
      })
    );
    expect(toast.success).toHaveBeenCalledWith('Time off added');
    expect(await screen.findByText('24 Dec 2026 – 26 Dec 2026')).toBeInTheDocument();
  });

  it('surfaces an error toast when creating a block fails', async () => {
    const user = userEvent.setup();
    mockGet.mockResolvedValue([]);
    mockCreate.mockResolvedValue({
      success: false,
      error: 'End date must be on or after start date',
    });
    render(<DateOverridesCard />);

    await screen.findByText(/No time off scheduled/i);
    await user.click(screen.getByRole('button', { name: /add time off/i }));
    await pickToday(user);
    await user.click(screen.getByRole('button', { name: /block these dates/i }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('End date must be on or after start date')
    );
  });

  it('confirms deletion, calls the delete action, toasts, and removes the row', async () => {
    const user = userEvent.setup();
    mockGet.mockResolvedValue([CHRISTMAS]);
    mockDelete.mockResolvedValue({ success: true });
    render(<DateOverridesCard />);

    await screen.findByText('Fri, 25 Dec 2026');

    await user.click(screen.getByRole('button', { name: /remove time off/i }));

    // Confirm dialog copy.
    expect(await screen.findByText('Remove this time off?')).toBeInTheDocument();
    expect(
      screen.getByText('Clients may be able to book you during this time.')
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /^remove$/i }));

    await waitFor(() => expect(mockDelete).toHaveBeenCalledWith({ overrideId: 'o1' }));
    expect(toast.success).toHaveBeenCalledWith('Time off removed');
    await waitFor(() => expect(screen.queryByText('Fri, 25 Dec 2026')).not.toBeInTheDocument());
  });

  it('has no accessibility violations in the list state', async () => {
    mockGet.mockResolvedValue([CHRISTMAS]);
    const { container } = render(<DateOverridesCard />);
    await screen.findByText('Fri, 25 Dec 2026');

    expect(await axe(container)).toHaveNoViolations();
  });
});
