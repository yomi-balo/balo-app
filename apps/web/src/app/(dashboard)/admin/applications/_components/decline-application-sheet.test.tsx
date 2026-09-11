import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { track, ADMIN_APPLICATIONS_EVENTS } from '@/lib/analytics';
import type { DecideApplicationActionResult } from '../_actions/_shared/decision-outcome';

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));

const declineExpertApplicationAction =
  vi.fn<(input: unknown) => Promise<DecideApplicationActionResult>>();
vi.mock('../_actions/decline-expert-application', () => ({
  declineExpertApplicationAction: (input: unknown) => declineExpertApplicationAction(input),
}));

const refresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh }),
}));

import { DeclineApplicationSheet } from './decline-application-sheet';

const PROFILE_ID = '11111111-1111-1111-1111-111111111111';
const mockToast = vi.mocked(toast);
const mockTrack = vi.mocked(track);

const SUCCESS: DecideApplicationActionResult = {
  success: true,
  analytics: { decision: 'declined', days_waiting: 4, reason: 'not_a_fit' },
  decidedByLabel: 'Dana @ Balo',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('DeclineApplicationSheet', () => {
  it('the confirm button is disabled until a reason AND an 8-char note are present', async () => {
    const user = userEvent.setup();
    render(
      <DeclineApplicationSheet
        open
        onOpenChange={vi.fn()}
        expertProfileId={PROFILE_ID}
        firstName="Priya"
      />
    );
    const confirm = screen.getByRole('button', { name: /decline application/i });
    expect(confirm).toBeDisabled();

    await user.click(screen.getByRole('button', { name: /^Not a fit right now/ }));
    expect(confirm).toBeDisabled();

    const note = screen.getByLabelText(/Balo-only note/i);
    await user.type(note, 'short');
    expect(confirm).toBeDisabled();

    await user.type(note, ' plus more text');
    expect(confirm).toBeEnabled();
  });

  it('the reason picker sets aria-pressed on the selected card only', async () => {
    const user = userEvent.setup();
    render(
      <DeclineApplicationSheet
        open
        onOpenChange={vi.fn()}
        expertProfileId={PROFILE_ID}
        firstName="Priya"
      />
    );
    const notAFit = screen.getByRole('button', { name: /^Not a fit right now/ });
    const incomplete = screen.getByRole('button', { name: /^Application incomplete/ });

    expect(notAFit).toHaveAttribute('aria-pressed', 'false');
    await user.click(notAFit);
    expect(notAFit).toHaveAttribute('aria-pressed', 'true');
    expect(incomplete).toHaveAttribute('aria-pressed', 'false');
  });

  it('the description is wired as the dialog description (a real SheetDescription, never aria-describedby={undefined})', () => {
    render(
      <DeclineApplicationSheet
        open
        onOpenChange={vi.fn()}
        expertProfileId={PROFILE_ID}
        firstName="Priya"
      />
    );
    const dialog = screen.getByRole('dialog');
    const describedBy = dialog.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(String(describedBy))?.textContent).toContain('never this note');
  });

  it('calls declineExpertApplicationAction with the picked reason and trimmed note, then toasts, tracks and refreshes', async () => {
    const user = userEvent.setup();
    declineExpertApplicationAction.mockResolvedValue(SUCCESS);
    render(
      <DeclineApplicationSheet
        open
        onOpenChange={vi.fn()}
        expertProfileId={PROFILE_ID}
        firstName="Priya"
      />
    );
    await user.click(screen.getByRole('button', { name: /^Not a fit right now/ }));
    await user.type(screen.getByLabelText(/Balo-only note/i), 'Not enough demand right now.');
    await user.click(screen.getByRole('button', { name: /decline application/i }));

    await waitFor(() =>
      expect(declineExpertApplicationAction).toHaveBeenCalledWith({
        expertProfileId: PROFILE_ID,
        reason: 'not_a_fit',
        note: 'Not enough demand right now.',
      })
    );
    expect(mockToast.success).toHaveBeenCalledWith('Declined — Priya has been told why');
    expect(mockTrack).toHaveBeenCalledWith(ADMIN_APPLICATIONS_EVENTS.REVIEWED, SUCCESS.analytics);
    expect(refresh).toHaveBeenCalled();
  });

  it('shows an error toast and does NOT refresh on failure', async () => {
    const user = userEvent.setup();
    declineExpertApplicationAction.mockResolvedValue({
      success: false,
      error: 'That application has already been decided.',
    });
    render(
      <DeclineApplicationSheet
        open
        onOpenChange={vi.fn()}
        expertProfileId={PROFILE_ID}
        firstName="Priya"
      />
    );
    await user.click(screen.getByRole('button', { name: /^Not a fit right now/ }));
    await user.type(screen.getByLabelText(/Balo-only note/i), 'Not enough demand right now.');
    await user.click(screen.getByRole('button', { name: /decline application/i }));

    await waitFor(() =>
      expect(mockToast.error).toHaveBeenCalledWith('That application has already been decided.')
    );
    expect(refresh).not.toHaveBeenCalled();
  });
});
