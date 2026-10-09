import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { track, EXPERT_EVENTS } from '@/lib/analytics';

// ── Mocks ────────────────────────────────────────────────────────

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

const mockStartNewApplicationAction = vi.fn();
vi.mock('../_actions/start-new-application', () => ({
  startNewApplicationAction: () => mockStartNewApplicationAction(),
}));

import { DeclinedApplicationPanel } from './declined-application-panel';
import { reopenCooldownError } from '../_actions/declined-application-copy';

const toastSuccess = vi.mocked(toast.success);
const toastError = vi.mocked(toast.error);
const trackMock = vi.mocked(track);

/** A promise the test controls the resolution of — for asserting the pending state in between. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('DeclinedApplicationPanel — cooldown arm', () => {
  it('renders a disabled CTA and the cooldown date', () => {
    render(<DeclinedApplicationPanel reapplyAvailableOn="9 Dec 2026" canStartNow={false} />);

    expect(screen.getByRole('button', { name: /start a new application/i })).toBeDisabled();
    expect(screen.getByText(/9 Dec 2026/)).toBeInTheDocument();
  });

  it('describes the disabled CTA with the availability text', () => {
    render(<DeclinedApplicationPanel reapplyAvailableOn="9 Dec 2026" canStartNow={false} />);

    expect(
      screen.getByRole('button', { name: /start a new application/i })
    ).toHaveAccessibleDescription(/9 Dec 2026/);
  });
});

describe('DeclinedApplicationPanel — ready arm', () => {
  it('renders an enabled CTA', () => {
    render(<DeclinedApplicationPanel reapplyAvailableOn={null} canStartNow={true} />);

    expect(screen.getByRole('button', { name: /start a new application/i })).toBeEnabled();
  });

  it('describes the enabled CTA with the availability text', () => {
    render(<DeclinedApplicationPanel reapplyAvailableOn={null} canStartNow={true} />);

    expect(
      screen.getByRole('button', { name: /start a new application/i })
    ).toHaveAccessibleDescription(/whenever you're ready/i);
  });

  it('shows the pending state (aria-busy, label kept) while the action is in flight, then success', async () => {
    const user = userEvent.setup();
    const { promise, resolve } = deferred<{
      success: true;
      alreadyOpen: false;
      daysSinceDecision: number;
    }>();
    mockStartNewApplicationAction.mockReturnValue(promise);

    render(<DeclinedApplicationPanel reapplyAvailableOn={null} canStartNow={true} />);

    const button = screen.getByRole('button', { name: /start a new application/i });
    await user.click(button);

    await waitFor(() => expect(button).toHaveAttribute('aria-busy', 'true'));
    // The label is kept during the pending state, not swapped out.
    expect(button).toHaveTextContent(/start a new application/i);

    resolve({ success: true, alreadyOpen: false, daysSinceDecision: 12 });

    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    expect(trackMock).toHaveBeenCalledWith(EXPERT_EVENTS.APPLICATION_RESTARTED, {
      days_since_decision: 12,
    });
    expect(refresh).toHaveBeenCalled();
  });

  it('does not fire the analytics event on an alreadyOpen (double click / second tab) success', async () => {
    const user = userEvent.setup();
    mockStartNewApplicationAction.mockResolvedValue({ success: true, alreadyOpen: true });

    render(<DeclinedApplicationPanel reapplyAvailableOn={null} canStartNow={true} />);
    await user.click(screen.getByRole('button', { name: /start a new application/i }));

    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    expect(trackMock).not.toHaveBeenCalledWith(
      EXPERT_EVENTS.APPLICATION_RESTARTED,
      expect.anything()
    );
    expect(refresh).toHaveBeenCalled();
  });

  it('shows a toast and inline alert text on a generic failure, CTA stays enabled', async () => {
    const user = userEvent.setup();
    mockStartNewApplicationAction.mockResolvedValue({
      success: false,
      code: 'not_found',
      error: 'We could not find an application to restart.',
    });

    render(<DeclinedApplicationPanel reapplyAvailableOn={null} canStartNow={true} />);
    await user.click(screen.getByRole('button', { name: /start a new application/i }));

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(expect.stringContaining('restart'))
    );
    expect(screen.getByRole('alert')).toHaveTextContent(
      'We could not find an application to restart.'
    );
    expect(screen.getByRole('button', { name: /start a new application/i })).toBeEnabled();
  });

  it('shows a toast and inline alert text when the action throws, CTA stays enabled', async () => {
    const user = userEvent.setup();
    mockStartNewApplicationAction.mockRejectedValue(new Error('network down'));

    render(<DeclinedApplicationPanel reapplyAvailableOn={null} canStartNow={true} />);
    await user.click(screen.getByRole('button', { name: /start a new application/i }));

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(screen.getByRole('alert')).toHaveTextContent(/went wrong/i);
    expect(screen.getByRole('button', { name: /start a new application/i })).toBeEnabled();
  });

  /**
   * A `cooldown_active` RESULT (the cooldown changed between render and click) flips the panel
   * to the cooldown arm using the server's own date.
   *
   * MUTATION-PROVEN: drop the `setCanStartNow(false)` / `setAvailableOn(...)` calls on this arm
   * and the button stays enabled → red.
   */
  it('flips to the cooldown arm on a cooldown_active result', async () => {
    const user = userEvent.setup();
    mockStartNewApplicationAction.mockResolvedValue({
      success: false,
      code: 'cooldown_active',
      availableOn: '9 Dec 2026',
      error: reopenCooldownError('9 Dec 2026'),
    });

    render(<DeclinedApplicationPanel reapplyAvailableOn={null} canStartNow={true} />);
    await user.click(screen.getByRole('button', { name: /start a new application/i }));

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /start a new application/i })).toBeDisabled()
    );
    expect(screen.getAllByText(/9 Dec 2026/).length).toBeGreaterThan(0);
    expect(toastError).toHaveBeenCalledWith(reopenCooldownError('9 Dec 2026'));
    expect(screen.getByRole('alert')).toHaveTextContent('9 Dec 2026');
  });
});
