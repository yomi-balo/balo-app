import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SCHEDULE_EVENTS } from '@balo/analytics/events';
import { toast } from 'sonner';
import * as Sentry from '@sentry/nextjs';
import { track } from '@/lib/analytics';
import { TimezoneMismatchGate } from './timezone-mismatch-gate';
import { SCHEDULE_TIMEZONE_CHANGED_EVENT } from './mismatch-lib';

const SYDNEY = 'Australia/Sydney';
const LONDON = 'Europe/London';
const MELBOURNE = 'Australia/Melbourne';
const PAIR_KEY = `balo:tz-mismatch-kept:${SYDNEY}|${LONDON}`;

const state = vi.hoisted(() => ({ device: null as string | null, pathname: '/dashboard' }));
const mockRefresh = vi.hoisted(() => vi.fn());
const mockUpdate = vi.hoisted(() => vi.fn());
const mockImpact = vi.hoisted(() => vi.fn());

vi.mock('@/hooks/use-device-timezone', () => ({
  useDeviceTimezone: () => state.device,
}));
vi.mock('next/navigation', () => ({
  usePathname: () => state.pathname,
  useRouter: () => ({ refresh: mockRefresh }),
}));
vi.mock('sonner', () => ({
  toast: { loading: vi.fn(() => 'toast-1'), success: vi.fn(), error: vi.fn() },
}));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));
vi.mock('@/app/(dashboard)/expert/settings/_actions/update-schedule-timezone', () => ({
  updateScheduleTimezoneAction: (...args: unknown[]) => mockUpdate(...args),
}));
vi.mock('@/app/(dashboard)/expert/settings/_actions/get-timezone-impact', () => ({
  getTimezoneImpactAction: (...args: unknown[]) => mockImpact(...args),
}));

const PROMPT = {
  expertProfileId: 'ep-1',
  scheduleTimezone: SYDNEY,
  commonRange: { startTime: '09:00', endTime: '17:00' },
};

function renderGate(): ReturnType<typeof render> {
  return render(<TimezoneMismatchGate mismatchPrompt={PROMPT} />);
}

beforeEach(() => {
  vi.clearAllMocks();
  globalThis.localStorage.clear();
  state.device = LONDON;
  state.pathname = '/dashboard';
  mockImpact.mockResolvedValue(null);
  mockUpdate.mockResolvedValue({ success: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TimezoneMismatchGate — when it opens', () => {
  it('opens on mount when the device zone differs from the schedule zone', async () => {
    renderGate();
    expect(await screen.findByRole('alertdialog')).toBeInTheDocument();
    expect(
      screen.getByText('You’re in London, but your hours are set in Sydney time')
    ).toBeInTheDocument();
  });

  it('stays closed when the zones are the same city offset (Melbourne vs Sydney)', () => {
    state.device = MELBOURNE;
    renderGate();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('stays closed until the device zone is known', () => {
    state.device = null;
    renderGate();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('stays closed when this pair was already answered', () => {
    globalThis.localStorage.setItem(PAIR_KEY, String(Date.now()));
    renderGate();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('prompts again once a remembered Keep is older than 30 days', () => {
    globalThis.localStorage.setItem(PAIR_KEY, String(Date.now() - 31 * 24 * 60 * 60 * 1000));
    renderGate();
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });

  it('prompts again for the legacy "1" value', () => {
    globalThis.localStorage.setItem(PAIR_KEY, '1');
    renderGate();
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });

  it('holds a zone change that arrives after load until the next route change', async () => {
    state.device = SYDNEY;
    const view = renderGate();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();

    state.device = LONDON;
    view.rerender(<TimezoneMismatchGate mismatchPrompt={PROMPT} />);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();

    state.pathname = '/cases';
    view.rerender(<TimezoneMismatchGate mismatchPrompt={PROMPT} />);
    expect(await screen.findByRole('alertdialog')).toBeInTheDocument();
  });

  it('does not open on a route change when nothing is pending', () => {
    state.device = SYDNEY;
    const view = renderGate();
    state.pathname = '/cases';
    view.rerender(<TimezoneMismatchGate mismatchPrompt={PROMPT} />);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('drops a pending prompt when the device returns to the schedule zone', () => {
    state.device = SYDNEY;
    const view = renderGate();
    state.device = LONDON;
    view.rerender(<TimezoneMismatchGate mismatchPrompt={PROMPT} />);
    state.device = SYDNEY;
    view.rerender(<TimezoneMismatchGate mismatchPrompt={PROMPT} />);
    state.pathname = '/cases';
    view.rerender(<TimezoneMismatchGate mismatchPrompt={PROMPT} />);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });
});

describe('TimezoneMismatchGate — Keep', () => {
  it('writes the pair key, and a remount stays closed', async () => {
    const user = userEvent.setup();
    const view = renderGate();
    await user.click(await screen.findByRole('button', { name: 'Keep Sydney hours' }));

    expect(globalThis.localStorage.getItem(PAIR_KEY)).not.toBeNull();
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());

    view.unmount();
    renderGate();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('treats Escape as Keep', async () => {
    const user = userEvent.setup();
    renderGate();
    await screen.findByRole('alertdialog');
    await user.keyboard('{Escape}');

    expect(globalThis.localStorage.getItem(PAIR_KEY)).not.toBeNull();
    expect(track).toHaveBeenCalledWith(
      SCHEDULE_EVENTS.TIMEZONE_MISMATCH_RESOLVED,
      expect.objectContaining({ action: 'kept', via_escape: true, source: 'detected' })
    );
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});

const RETRY_OPTIONS = {
  id: 'toast-1',
  description: 'Try again from Expert settings → Schedule.',
};

describe('TimezoneMismatchGate — Switch', () => {
  it('saves the device zone, toasts, announces the change and refreshes the layout', async () => {
    const user = userEvent.setup();
    const onChanged = vi.fn();
    globalThis.addEventListener(SCHEDULE_TIMEZONE_CHANGED_EVENT, onChanged);
    renderGate();
    await user.click(await screen.findByRole('button', { name: 'Switch to London time' }));

    await waitFor(() => expect(mockRefresh).toHaveBeenCalledTimes(1));
    expect(mockUpdate).toHaveBeenCalledWith(LONDON);
    expect(toast.loading).toHaveBeenCalledWith('Updating your timezone…');
    expect(toast.success).toHaveBeenCalledWith(
      'Timezone updated. Your hours are now set in London time.',
      { id: 'toast-1' }
    );
    expect(track).toHaveBeenCalledWith(SCHEDULE_EVENTS.TIMEZONE_CHANGED, {
      expert_id: 'ep-1',
      from_timezone: SYDNEY,
      to_timezone: LONDON,
      source: 'mismatch_dialog',
    });
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(globalThis.localStorage.getItem(PAIR_KEY)).toBeNull();
    globalThis.removeEventListener(SCHEDULE_TIMEZONE_CHANGED_EVENT, onChanged);
  });

  it('shows the error and leaves the pair unanswered when the save fails', async () => {
    mockUpdate.mockResolvedValue({ success: false, error: 'Nope' });
    const user = userEvent.setup();
    renderGate();
    await user.click(await screen.findByRole('button', { name: 'Switch to London time' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Nope', RETRY_OPTIONS));
    expect(mockRefresh).not.toHaveBeenCalled();
    expect(track).not.toHaveBeenCalledWith(SCHEDULE_EVENTS.TIMEZONE_CHANGED, expect.anything());
    expect(globalThis.localStorage.getItem(PAIR_KEY)).toBeNull();
  });

  it('falls back to a generic error when the failure carries no message', async () => {
    mockUpdate.mockResolvedValue({ success: false });
    const user = userEvent.setup();
    renderGate();
    await user.click(await screen.findByRole('button', { name: 'Switch to London time' }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Failed to update timezone', RETRY_OPTIONS)
    );
  });

  it('reports a thrown action to Sentry and toasts', async () => {
    const boom = new Error('network');
    mockUpdate.mockRejectedValue(boom);
    const user = userEvent.setup();
    renderGate();
    await user.click(await screen.findByRole('button', { name: 'Switch to London time' }));

    await waitFor(() => expect(Sentry.captureException).toHaveBeenCalledWith(boom));
    expect(toast.error).toHaveBeenCalledWith('Failed to update timezone', RETRY_OPTIONS);
    expect(mockRefresh).not.toHaveBeenCalled();
  });
});
