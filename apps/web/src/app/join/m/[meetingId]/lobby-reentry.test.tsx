import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock('motion/react', async () => {
  const { createMotionStub } = await import('@/test/motion-stub');
  return createMotionStub();
});

const mockReentry = vi.fn();
vi.mock('@/app/join/_actions/request-lobby-reentry-link', () => ({
  requestLobbyReentryLinkAction: (...args: unknown[]) => mockReentry(...args),
}));

import { toast } from 'sonner';
import { LobbyReentry } from './lobby-reentry';
import { LOBBY_REENTRY_NEUTRAL_MESSAGE, LOBBY_REENTRY_TRANSPORT_ERROR } from '@/lib/meetings/lobby';

const MEETING_ID = '0f7b1c2d-3e4f-4a5b-8c9d-0e1f2a3b4c5d';

function renderPanel(defaultEmail = ''): ReturnType<typeof render> {
  return render(
    <LobbyReentry meetingId={MEETING_ID} defaultEmail={defaultEmail} reduceMotion={false} />
  );
}

async function expandPanel(): Promise<void> {
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: /already asked to join/i }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockReentry.mockResolvedValue({ success: true, message: LOBBY_REENTRY_NEUTRAL_MESSAGE });
});

describe('LobbyReentry — the trigger', () => {
  it('is present on first paint, before any expansion', () => {
    renderPanel();

    expect(screen.getByRole('button', { name: /already asked to join/i })).toBeInTheDocument();
    expect(screen.queryByLabelText(/the email you used/i)).not.toBeInTheDocument();
  });

  it('aria-expanded toggles on click', async () => {
    renderPanel();
    const trigger = screen.getByRole('button', { name: /already asked to join/i });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');

    await expandPanel();

    expect(trigger).toHaveAttribute('aria-expanded', 'true');
  });

  it('expanding reveals a labelled email input seeded from defaultEmail', async () => {
    renderPanel('sam@cloudpeak.example');

    await expandPanel();

    const input = screen.getByLabelText(/the email you used/i);
    expect(input).toBeInTheDocument();
    expect(input).toHaveValue('sam@cloudpeak.example');
  });
});

describe('LobbyReentry — submit', () => {
  it('shows the submitting label and a disabled button, then the neutral message and a toast', async () => {
    renderPanel('sam@cloudpeak.example');
    await expandPanel();

    let resolvePending: (value: { success: true; message: string }) => void = () => {};
    mockReentry.mockReturnValue(
      new Promise((resolve) => {
        resolvePending = resolve;
      })
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Email me my link' }));

    expect(screen.getByRole('button', { name: /sending/i })).toBeDisabled();

    resolvePending({ success: true, message: LOBBY_REENTRY_NEUTRAL_MESSAGE });

    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent(LOBBY_REENTRY_NEUTRAL_MESSAGE);
    });
    expect(toast.success).toHaveBeenCalledWith(LOBBY_REENTRY_NEUTRAL_MESSAGE);
  });

  it('⚠ invalid_input keeps the panel open with the typed value intact, inline role=alert', async () => {
    mockReentry.mockResolvedValue({
      success: false,
      kind: 'invalid_input',
      error: 'Please enter the email address you used.',
    });

    renderPanel();
    await expandPanel();

    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/the email you used/i), 'nope');
    await user.click(screen.getByRole('button', { name: 'Email me my link' }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Please enter the email address you used.'
      );
    });
    // ⚠ NOT TERMINAL — the panel is still open with the value the visitor typed.
    expect(screen.getByLabelText(/the email you used/i)).toHaveValue('nope');
    expect(screen.getByLabelText(/the email you used/i)).toBeInTheDocument();
  });

  it('unavailable → toast.error AND the inline region', async () => {
    mockReentry.mockResolvedValue({
      success: false,
      kind: 'unavailable',
      error: "This link isn't active",
    });

    renderPanel('sam@cloudpeak.example');
    await expandPanel();

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Email me my link' }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent("This link isn't active");
    });
    expect(toast.error).toHaveBeenCalledWith("This link isn't active");
  });

  /**
   * BAL-442 fix round (F1 / UX-1 / REV-1) — a REJECTED action promise (a dropped connection;
   * the request may never have reached the server) must render the TRANSPORT-FAILURE copy —
   * never `LOBBY_REENTRY_NEUTRAL_MESSAGE`, which is an affirmative "we've sent a new link"
   * claim that would be a lie here, leaving the guest waiting for an email that never arrives.
   */
  it('⚠⚠ F1 — a transport failure (rejected promise) shows the TRANSPORT copy, never the neutral success copy', async () => {
    mockReentry.mockRejectedValue(new Error('boom'));

    renderPanel('sam@cloudpeak.example');
    await expandPanel();

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Email me my link' }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(LOBBY_REENTRY_TRANSPORT_ERROR);
    });
    expect(toast.error).toHaveBeenCalledWith(LOBBY_REENTRY_TRANSPORT_ERROR);
    // ⚠ THE NEGATIVE HALF OF THE PROOF — the neutral (success) sentence must appear NOWHERE.
    expect(screen.queryByText(LOBBY_REENTRY_NEUTRAL_MESSAGE)).not.toBeInTheDocument();
    expect(toast.error).not.toHaveBeenCalledWith(LOBBY_REENTRY_NEUTRAL_MESSAGE);
  });
});

describe('LobbyReentry — post-success retry (F4)', () => {
  /**
   * BAL-442 fix round (F4 / UX-2) — success used to be a ONE-WAY DOOR: `state` never reset, so
   * collapsing/re-expanding showed the success message forever, with no way back to the form
   * short of a full page reload. This strands exactly the guest the neutral copy exists to
   * serve: one who mistyped their address gets silence, then no retry.
   */
  it('⚠⚠ "Try a different address" resets to the form, with the typed value intact', async () => {
    renderPanel('sam@cloudpeak.example');
    await expandPanel();

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Email me my link' }));

    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent(LOBBY_REENTRY_NEUTRAL_MESSAGE);
    });

    await user.click(screen.getByRole('button', { name: /try a different address/i }));

    // ⚠ BACK TO THE FORM — the email input is visible again, seeded with what was typed.
    const input = await screen.findByLabelText(/the email you used/i);
    expect(input).toHaveValue('sam@cloudpeak.example');
    expect(screen.queryByText(LOBBY_REENTRY_NEUTRAL_MESSAGE)).not.toBeInTheDocument();

    // ⚠ AND IT IS GENUINELY RESUBMITTABLE, not just visually reset.
    mockReentry.mockResolvedValueOnce({ success: true, message: LOBBY_REENTRY_NEUTRAL_MESSAGE });
    await user.click(screen.getByRole('button', { name: 'Email me my link' }));
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent(LOBBY_REENTRY_NEUTRAL_MESSAGE);
    });
    expect(mockReentry).toHaveBeenCalledTimes(2);
  });
});

describe('LobbyReentry — accessibility', () => {
  it('has no axe violations when expanded', async () => {
    const { container } = renderPanel('sam@cloudpeak.example');
    await expandPanel();

    expect(await axe(container)).toHaveNoViolations();
  });

  it('the submit button is at least 44px tall (min-h-11)', async () => {
    renderPanel();
    await expandPanel();

    expect(screen.getByRole('button', { name: 'Email me my link' }).className).toContain(
      'min-h-11'
    );
  });
});
