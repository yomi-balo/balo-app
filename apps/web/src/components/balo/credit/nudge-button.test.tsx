import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const mockNudge = vi.fn();
vi.mock('@/lib/credit/actions/session-mutations', () => ({
  nudgeAdminAction: (...a: unknown[]) => mockNudge(...a),
}));

import { NudgeButton } from './nudge-button';
import { toast } from 'sonner';

const SESSION_ID = 'sess-1';

beforeEach(() => {
  vi.clearAllMocks();
  mockNudge.mockResolvedValue({ success: true, data: { ok: true } });
});

describe('NudgeButton', () => {
  it('renders an accessibly-named button', () => {
    render(<NudgeButton sessionId={SESSION_ID} label="Let Sam know" adminName="Sam" />);
    expect(screen.getByRole('button', { name: 'Let Sam know' })).toBeInTheDocument();
  });

  it('calls the nudge action, toasts, and flips to the confirmation on success', async () => {
    const user = userEvent.setup();
    render(<NudgeButton sessionId={SESSION_ID} label="Let Sam know" adminName="Sam" />);

    await user.click(screen.getByRole('button', { name: 'Let Sam know' }));

    expect(mockNudge).toHaveBeenCalledWith(SESSION_ID);
    expect(await screen.findByText('We let Sam know')).toBeInTheDocument();
    expect(toast.success).toHaveBeenCalledWith('We let Sam know');
    expect(screen.queryByRole('button', { name: 'Let Sam know' })).not.toBeInTheDocument();
  });

  it('disables the button while the request is in flight', async () => {
    const user = userEvent.setup();
    let resolveNudge: (value: { success: true; data: { ok: true } }) => void = () => {};
    mockNudge.mockReturnValue(
      new Promise((resolve) => {
        resolveNudge = resolve;
      })
    );

    render(<NudgeButton sessionId={SESSION_ID} label="Let Sam know" adminName="Sam" />);
    const button = screen.getByRole('button', { name: 'Let Sam know' });
    await user.click(button);

    expect(button).toBeDisabled();

    resolveNudge({ success: true, data: { ok: true } });
    expect(await screen.findByText('We let Sam know')).toBeInTheDocument();
  });

  it('toasts an error and stays actionable on failure', async () => {
    const user = userEvent.setup();
    mockNudge.mockResolvedValue({
      success: false,
      error: 'Could not send that nudge — please try again.',
    });

    render(<NudgeButton sessionId={SESSION_ID} label="Let Sam know" adminName="Sam" />);
    await user.click(screen.getByRole('button', { name: 'Let Sam know' }));

    expect(toast.error).toHaveBeenCalledWith('Could not send that nudge — please try again.');
    expect(screen.getByRole('button', { name: 'Let Sam know' })).toBeInTheDocument();
    expect(screen.queryByText('We let Sam know')).not.toBeInTheDocument();
  });

  it('falls back to "your admin" when no admin name is supplied', async () => {
    const user = userEvent.setup();
    render(<NudgeButton sessionId={SESSION_ID} label="Ask your admin to top up" />);
    await user.click(screen.getByRole('button', { name: 'Ask your admin to top up' }));
    expect(await screen.findByText('We let your admin know')).toBeInTheDocument();
  });

  it('has no accessibility violations', async () => {
    const { container } = render(
      <NudgeButton sessionId={SESSION_ID} label="Let Sam know" adminName="Sam" />
    );
    expect(await axe(container)).toHaveNoViolations();
  }, 15000);
});
