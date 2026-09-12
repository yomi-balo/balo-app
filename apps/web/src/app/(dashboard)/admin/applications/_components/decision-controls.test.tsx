import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { track, ADMIN_APPLICATIONS_EVENTS } from '@/lib/analytics';
import type { DecideApplicationActionResult } from '../_actions/_shared/decision-outcome';

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));

const approveExpertApplicationAction =
  vi.fn<(input: unknown) => Promise<DecideApplicationActionResult>>();
vi.mock('../_actions/approve-expert-application', () => ({
  approveExpertApplicationAction: (input: unknown) => approveExpertApplicationAction(input),
}));
vi.mock('../_actions/decline-expert-application', () => ({
  declineExpertApplicationAction: vi.fn(),
}));

const refresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh }),
}));

import { DecisionControls } from './decision-controls';

const PROFILE_ID = '11111111-1111-1111-1111-111111111111';
const mockToast = vi.mocked(toast);
const mockTrack = vi.mocked(track);

const APPROVE_SUCCESS: DecideApplicationActionResult = {
  success: true,
  analytics: { decision: 'approved', days_waiting: 3 },
  decidedByLabel: 'Dana @ Balo',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('DecisionControls', () => {
  it('renders an Approve primary control and a ghost Decline control', () => {
    render(<DecisionControls expertProfileId={PROFILE_ID} firstName="Priya" />);
    expect(screen.getByRole('button', { name: /approve/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /decline/i })).toBeInTheDocument();
  });

  /**
   * FIX ROUND F9 (user-ruled) — APPROVE CONFIRMS FIRST.
   *
   * MUTATION-PROVEN: wire the Approve button back to the mutation
   * (`onClick={handleConfirmApprove}`) and this test goes red — the action fires on the first
   * click, before any dialog exists.
   */
  it('does NOT call the approve action on the button click — it opens a confirmation', async () => {
    const user = userEvent.setup();
    approveExpertApplicationAction.mockResolvedValue(APPROVE_SUCCESS);
    render(<DecisionControls expertProfileId={PROFILE_ID} firstName="Priya" />);

    await user.click(screen.getByRole('button', { name: /^approve$/i }));

    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(approveExpertApplicationAction).not.toHaveBeenCalled();
  });

  it('leaves the approve action uncalled when the confirmation is cancelled', async () => {
    const user = userEvent.setup();
    render(<DecisionControls expertProfileId={PROFILE_ID} firstName="Priya" />);

    await user.click(screen.getByRole('button', { name: /^approve$/i }));
    await user.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Not yet' })
    );

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(approveExpertApplicationAction).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('shows a success toast and refreshes once the approval is confirmed', async () => {
    const user = userEvent.setup();
    approveExpertApplicationAction.mockResolvedValue(APPROVE_SUCCESS);
    render(<DecisionControls expertProfileId={PROFILE_ID} firstName="Priya" />);

    await user.click(screen.getByRole('button', { name: /^approve$/i }));
    await user.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Approve' })
    );

    await waitFor(() =>
      expect(approveExpertApplicationAction).toHaveBeenCalledWith({ expertProfileId: PROFILE_ID })
    );
    expect(mockToast.success).toHaveBeenCalledWith('Approved — Priya is now an expert on Balo');
    expect(mockTrack).toHaveBeenCalledWith(
      ADMIN_APPLICATIONS_EVENTS.REVIEWED,
      APPROVE_SUCCESS.analytics
    );
    expect(refresh).toHaveBeenCalled();
  });

  it('shows an error toast and does NOT refresh on a codeless approve failure', async () => {
    const user = userEvent.setup();
    approveExpertApplicationAction.mockResolvedValue({
      success: false,
      error: 'That application has already been decided.',
    });
    render(<DecisionControls expertProfileId={PROFILE_ID} firstName="Priya" />);

    await user.click(screen.getByRole('button', { name: /^approve$/i }));
    await user.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Approve' })
    );

    await waitFor(() =>
      expect(mockToast.error).toHaveBeenCalledWith('That application has already been decided.')
    );
    expect(refresh).not.toHaveBeenCalled();
  });

  /**
   * WEB-REVIEW FIX ROUND W3 — A LOST RACE MUST RE-RENDER THE PAGE.
   *
   * Both actions return `code: 'not_pending' | 'gone'` specifically so the UI can react, and this
   * component only toasted: the staffer who lost the race kept looking at live Approve / Decline
   * controls until a manual reload, and their next click failed the same way.
   *
   * MUTATION-PROVEN: remove the `decisionOutcomeIsStale(result.code)` refresh and both rows below
   * go red, while the `'denied'` and codeless cases stay green.
   */
  it.each([
    ['not_pending', 'That application has already been decided.'],
    ['gone', 'That application no longer exists.'],
  ] as const)('refreshes the page when the approve lost the race (%s)', async (code, error) => {
    const user = userEvent.setup();
    approveExpertApplicationAction.mockResolvedValue({ success: false, error, code });
    render(<DecisionControls expertProfileId={PROFILE_ID} firstName="Priya" />);

    await user.click(screen.getByRole('button', { name: /^approve$/i }));
    await user.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Approve' })
    );

    await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith(error));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('does NOT refresh on a capability denial — a re-render cannot change it', async () => {
    const user = userEvent.setup();
    approveExpertApplicationAction.mockResolvedValue({
      success: false,
      error: 'You do not have access to that.',
      code: 'denied',
    });
    render(<DecisionControls expertProfileId={PROFILE_ID} firstName="Priya" />);

    await user.click(screen.getByRole('button', { name: /^approve$/i }));
    await user.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Approve' })
    );

    await waitFor(() =>
      expect(mockToast.error).toHaveBeenCalledWith('You do not have access to that.')
    );
    expect(refresh).not.toHaveBeenCalled();
  });

  it('opens the decline sheet on Decline click', async () => {
    const user = userEvent.setup();
    render(<DecisionControls expertProfileId={PROFILE_ID} firstName="Priya" />);
    expect(screen.queryByRole('dialog')).toBeNull();
    await user.click(screen.getByRole('button', { name: /^decline$/i }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});
