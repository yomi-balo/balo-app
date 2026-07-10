import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const mockOverride = vi.fn();
vi.mock('@/app/(dashboard)/projects/[requestId]/_actions/override-balo-fee', () => ({
  overrideBaloFee: (...a: unknown[]) => mockOverride(...a),
}));

import { AdminFeeOverridePanel } from './admin-fee-override-panel';
import { toast } from 'sonner';

const REQUEST_ID = 'req-1';

beforeEach(() => {
  vi.clearAllMocks();
  // Default: a real change from 25% → whatever the test submits.
  mockOverride.mockResolvedValue({ success: true, previousBps: 2500, newBps: 3000, changed: true });
});

describe('AdminFeeOverridePanel', () => {
  it('renders the fee as a percent with a Default badge at 2500 bps', () => {
    render(<AdminFeeOverridePanel requestId={REQUEST_ID} baloFeeBps={2500} />);
    expect(screen.getByRole('heading', { name: 'Balo fee' })).toBeInTheDocument();
    expect(screen.getByText('25%')).toBeInTheDocument();
    expect(screen.getByText('Default')).toBeInTheDocument();
    expect(screen.getByText(/Applies to proposals submitted from now on/i)).toBeInTheDocument();
  });

  it('hides the Default badge for a non-default fee', () => {
    render(<AdminFeeOverridePanel requestId={REQUEST_ID} baloFeeBps={1750} />);
    expect(screen.getByText('17.5%')).toBeInTheDocument();
    expect(screen.queryByText('Default')).not.toBeInTheDocument();
  });

  it('edits, submits a valid fee, calls the action, and confirms with a success toast', async () => {
    const user = userEvent.setup();
    render(<AdminFeeOverridePanel requestId={REQUEST_ID} baloFeeBps={2500} />);

    await user.click(screen.getByRole('button', { name: /edit/i }));
    const input = screen.getByLabelText('Fee (%)');
    // Seeded from the current fee.
    expect(input).toHaveValue('25');

    await user.clear(input);
    await user.type(input, '30');
    await user.click(screen.getByRole('button', { name: /save/i }));

    expect(mockOverride).toHaveBeenCalledWith({ requestId: REQUEST_ID, feeBps: 3000 });
    // Returns to view mode showing the new fee.
    expect(await screen.findByText('30%')).toBeInTheDocument();
    expect(toast.success).toHaveBeenCalledWith('Balo fee updated to 30%');
  });

  it('blocks the server call when client-side validation fails', async () => {
    const user = userEvent.setup();
    render(<AdminFeeOverridePanel requestId={REQUEST_ID} baloFeeBps={2500} />);

    await user.click(screen.getByRole('button', { name: /edit/i }));
    const input = screen.getByLabelText('Fee (%)');
    await user.clear(input);
    await user.type(input, 'abc');
    await user.click(screen.getByRole('button', { name: /save/i }));

    expect(screen.getByText('Enter a percentage, e.g. 17.5.')).toBeInTheDocument();
    expect(mockOverride).not.toHaveBeenCalled();
  });

  it('rejects more than two decimal places without calling the action', async () => {
    const user = userEvent.setup();
    render(<AdminFeeOverridePanel requestId={REQUEST_ID} baloFeeBps={2500} />);

    await user.click(screen.getByRole('button', { name: /edit/i }));
    const input = screen.getByLabelText('Fee (%)');
    await user.clear(input);
    await user.type(input, '17.533');
    await user.click(screen.getByRole('button', { name: /save/i }));

    expect(screen.getByText('Use at most 2 decimal places.')).toBeInTheDocument();
    expect(mockOverride).not.toHaveBeenCalled();
  });

  it('keeps the editor open with the typed value and a retryable error on server failure', async () => {
    mockOverride.mockResolvedValue({
      success: false,
      error: 'Could not update the fee. Please try again.',
    });
    const user = userEvent.setup();
    render(<AdminFeeOverridePanel requestId={REQUEST_ID} baloFeeBps={2500} />);

    await user.click(screen.getByRole('button', { name: /edit/i }));
    const input = screen.getByLabelText('Fee (%)');
    await user.clear(input);
    await user.type(input, '30');
    await user.click(screen.getByRole('button', { name: /save/i }));

    expect(
      await screen.findByText('Could not update the fee. Please try again.')
    ).toBeInTheDocument();
    expect(toast.error).toHaveBeenCalledWith('Could not update the fee. Please try again.');
    // Still in edit mode, value retained for a retry.
    expect(screen.getByLabelText('Fee (%)')).toHaveValue('30');
  });

  it('moves focus to the percent input when Edit is activated', async () => {
    const user = userEvent.setup();
    render(<AdminFeeOverridePanel requestId={REQUEST_ID} baloFeeBps={2500} />);

    await user.click(screen.getByRole('button', { name: /edit/i }));

    expect(screen.getByLabelText('Fee (%)')).toHaveFocus();
  });

  it('blocks the server call and shows an inline error for an out-of-range fee', async () => {
    const user = userEvent.setup();
    render(<AdminFeeOverridePanel requestId={REQUEST_ID} baloFeeBps={2500} />);

    await user.click(screen.getByRole('button', { name: /edit/i }));
    const input = screen.getByLabelText('Fee (%)');
    await user.clear(input);
    await user.type(input, '150');
    await user.click(screen.getByRole('button', { name: /save/i }));

    expect(screen.getByText('Enter a fee between 0% and 100%.')).toBeInTheDocument();
    expect(mockOverride).not.toHaveBeenCalled();
  });

  it('acknowledges a no-op change with a neutral toast', async () => {
    mockOverride.mockResolvedValue({
      success: true,
      previousBps: 2500,
      newBps: 2500,
      changed: false,
    });
    const user = userEvent.setup();
    render(<AdminFeeOverridePanel requestId={REQUEST_ID} baloFeeBps={2500} />);

    await user.click(screen.getByRole('button', { name: /edit/i }));
    await user.click(screen.getByRole('button', { name: /save/i }));

    expect(await screen.findByText('25%')).toBeInTheDocument();
    expect(toast.success).toHaveBeenCalledWith('Fee unchanged.');
  });
});
