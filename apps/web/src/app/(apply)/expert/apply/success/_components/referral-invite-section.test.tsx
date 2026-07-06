import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@/test/utils';
import userEvent from '@testing-library/user-event';

// ── Mocks ────────────────────────────────────────────────────────

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock('../_actions/send-referral-invites', () => ({
  sendReferralInvitesAction: vi.fn(),
}));

// Stub motion to render plain elements (JSDOM-friendly).
const MOTION_PROPS = new Set(['initial', 'animate', 'exit', 'variants', 'transition']);

vi.mock('motion/react', async () => {
  const React = await import('react');
  return {
    motion: new Proxy(
      {},
      {
        get: (_t: unknown, prop: string) =>
          React.forwardRef(function MotionStub(
            props: Record<string, unknown>,
            ref: React.Ref<unknown>
          ) {
            const filtered: Record<string, unknown> = {};
            for (const [key, value] of Object.entries(props)) {
              if (!MOTION_PROPS.has(key)) filtered[key] = value;
            }
            return React.createElement(prop, { ...filtered, ref });
          }),
      }
    ),
    AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
  };
});

import { axe } from 'jest-axe';
import { ReferralInviteSection } from './referral-invite-section';
import { sendReferralInvitesAction } from '../_actions/send-referral-invites';
import { toast } from 'sonner';
import { track, EXPERT_EVENTS } from '@/lib/analytics';

const actionMock = vi.mocked(sendReferralInvitesAction);
const toastSuccess = vi.mocked(toast.success);
const toastError = vi.mocked(toast.error);
const trackMock = vi.mocked(track);

async function addEmail(user: ReturnType<typeof userEvent.setup>, email: string): Promise<void> {
  const input = screen.getByRole('textbox');
  await user.type(input, `${email}{Enter}`);
}

describe('ReferralInviteSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fires REFERRAL_PROMPT_VIEWED once on mount', () => {
    render(<ReferralInviteSection />);
    expect(trackMock).toHaveBeenCalledWith(EXPERT_EVENTS.REFERRAL_PROMPT_VIEWED, {});
  });

  it('disables the send button while there are no emails (empty state)', () => {
    render(<ReferralInviteSection />);
    expect(screen.getByRole('button', { name: /send invitations/i })).toBeDisabled();
  });

  it('shows the spinner and disables inputs while sending', async () => {
    const user = userEvent.setup();
    // Never-resolving promise keeps the component in the sending state.
    actionMock.mockReturnValue(new Promise(() => {}));

    render(<ReferralInviteSection />);
    await addEmail(user, 'a@b.com');
    await user.click(screen.getByRole('button', { name: /send invitations/i }));

    expect(await screen.findByRole('button', { name: /sending/i })).toBeDisabled();
    expect(screen.getByRole('textbox')).toBeDisabled();
  });

  it('renders the confirmation, toasts success, and tracks counts on a successful send', async () => {
    const user = userEvent.setup();
    actionMock.mockResolvedValue({
      ok: true,
      results: [{ email: 'a@b.com', status: 'sent' }],
      sentCount: 1,
      alreadyCount: 0,
    });

    render(<ReferralInviteSection />);
    await addEmail(user, 'a@b.com');
    await user.click(screen.getByRole('button', { name: /send invitations/i }));

    expect(await screen.findByText('1 invitation sent')).toBeInTheDocument();
    expect(toastSuccess).toHaveBeenCalledWith('1 invitation sent!');
    expect(trackMock).toHaveBeenCalledWith(EXPERT_EVENTS.REFERRAL_INVITES_SENT, {
      invites_sent: 1,
      invites_attempted: 1,
      already_invited: 0,
    });
    // The form is replaced by the confirmation.
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('includes a typed-but-not-Enter’d address on send (flushes pending input)', async () => {
    const user = userEvent.setup();
    actionMock.mockResolvedValue({
      ok: true,
      results: [
        { email: 'a@b.com', status: 'sent' },
        { email: 'c@d.com', status: 'sent' },
      ],
      sentCount: 2,
      alreadyCount: 0,
    });

    render(<ReferralInviteSection />);
    // First address committed as a chip (enables the Send button).
    await addEmail(user, 'a@b.com');
    // Second address typed but NOT committed (no Enter/comma). fireEvent.click does
    // NOT blur the textarea, so the only way c@d.com reaches the action is the send
    // handler flushing the pending input via the chips-input ref.
    await user.type(screen.getByRole('textbox'), 'c@d.com');
    fireEvent.click(screen.getByRole('button', { name: /send invitations/i }));

    await waitFor(() =>
      expect(actionMock).toHaveBeenCalledWith({ emails: ['a@b.com', 'c@d.com'] })
    );
    expect(trackMock).toHaveBeenCalledWith(EXPERT_EVENTS.REFERRAL_INVITES_SENT, {
      invites_sent: 2,
      invites_attempted: 2,
      already_invited: 0,
    });
  });

  it('distinguishes already-invited addresses in the confirmation', async () => {
    const user = userEvent.setup();
    actionMock.mockResolvedValue({
      ok: true,
      results: [{ email: 'a@b.com', status: 'already_invited' }],
      sentCount: 0,
      alreadyCount: 1,
    });

    render(<ReferralInviteSection />);
    await addEmail(user, 'a@b.com');
    await user.click(screen.getByRole('button', { name: /send invitations/i }));

    expect(await screen.findByText('Already invited')).toBeInTheDocument();
    expect(toastSuccess).toHaveBeenCalledWith('Those colleagues were already invited.');
  });

  it('shows an inline error, toasts error, and allows retry', async () => {
    const user = userEvent.setup();
    actionMock.mockResolvedValue({ ok: false, error: 'unknown' });

    render(<ReferralInviteSection />);
    await addEmail(user, 'a@b.com');
    await user.click(screen.getByRole('button', { name: /send invitations/i }));

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(toastError).toHaveBeenCalledWith("Couldn't send invitations. Please try again.");

    // Retry returns to the idle state (error cleared, email preserved).
    await user.click(screen.getByRole('button', { name: /try again/i }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(screen.getByText('a@b.com')).toBeInTheDocument();
  });

  it('has no accessibility violations', async () => {
    const { container } = render(<ReferralInviteSection />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
