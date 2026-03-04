import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@/test/utils';
import userEvent from '@testing-library/user-event';

// ── Mocks ───────────────────────────────────────────────────────

const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
  }),
}));

const mockResetPasswordAction = vi.fn();
vi.mock('@/lib/auth/actions', () => ({
  resetPasswordAction: (...args: unknown[]) => mockResetPasswordAction(...args),
}));

// Motion mocks to avoid animation timing issues in tests
vi.mock('motion/react', () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  motion: {
    div: ({
      children,
      className,
      ...rest
    }: {
      children?: React.ReactNode;
      className?: string;
      role?: string;
    }) => (
      <div className={className} {...rest}>
        {children}
      </div>
    ),
    p: ({
      children,
      className,
      role,
    }: {
      children?: React.ReactNode;
      className?: string;
      role?: string;
    }) => (
      <p className={className} role={role}>
        {children}
      </p>
    ),
  },
}));

vi.mock('@/components/magicui/blur-fade', () => ({
  BlurFade: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  ),
}));

import { ResetPasswordForm } from './reset-password-form';
import { track, AUTH_EVENTS } from '@/lib/analytics';

// ── Helpers ─────────────────────────────────────────────────────

const TEST_PASSWORD = 'SecurePass1'; // NOSONAR — test fixture

/** Helper to find the password input fields by their `name` attribute. */
function getPasswordInput(container: HTMLElement): HTMLInputElement {
  return container.querySelector('input[name="password"]') as HTMLInputElement;
}

function getConfirmPasswordInput(container: HTMLElement): HTMLInputElement {
  return container.querySelector('input[name="confirmPassword"]') as HTMLInputElement;
}

/** Helper to fill the form and submit. */
async function fillAndSubmit(
  user: ReturnType<typeof userEvent.setup>,
  container: HTMLElement
): Promise<void> {
  const passwordInput = getPasswordInput(container);
  const confirmInput = getConfirmPasswordInput(container);
  await user.type(passwordInput, TEST_PASSWORD);
  await user.type(confirmInput, TEST_PASSWORD);
  await user.click(screen.getByRole('button', { name: /reset password/i }));
}

// ── Tests ───────────────────────────────────────────────────────

describe('ResetPasswordForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('when token is missing', () => {
    it('renders "Invalid reset link" error state', () => {
      render(<ResetPasswordForm token={undefined} />);
      expect(screen.getByText('Invalid reset link')).toBeInTheDocument();
    });

    it('does not render the password form', () => {
      render(<ResetPasswordForm token={undefined} />);
      expect(screen.queryByText('Set your new password')).not.toBeInTheDocument();
    });

    it('renders "Back to sign in" link', () => {
      render(<ResetPasswordForm token={undefined} />);
      expect(screen.getByRole('link', { name: /back to sign in/i })).toHaveAttribute(
        'href',
        '/login'
      );
    });

    it('fires PASSWORD_RESET_TOKEN_MISSING analytics event', () => {
      render(<ResetPasswordForm token={undefined} />);
      expect(track).toHaveBeenCalledWith(AUTH_EVENTS.PASSWORD_RESET_TOKEN_MISSING, {});
    });
  });

  describe('when token is empty string', () => {
    it('renders error state for empty token', () => {
      render(<ResetPasswordForm token="" />);
      expect(screen.getByText('Invalid reset link')).toBeInTheDocument();
    });

    it('fires PASSWORD_RESET_TOKEN_MISSING analytics event for empty token', () => {
      render(<ResetPasswordForm token="" />);
      expect(track).toHaveBeenCalledWith(AUTH_EVENTS.PASSWORD_RESET_TOKEN_MISSING, {});
    });
  });

  describe('when token is provided', () => {
    it('renders the password form', () => {
      render(<ResetPasswordForm token="valid-token" />);
      expect(screen.getByText('Set your new password')).toBeInTheDocument();
    });

    it('renders AuthHeader with correct title and subtitle', () => {
      render(<ResetPasswordForm token="valid-token" />);
      expect(screen.getByText('Set your new password')).toBeInTheDocument();
      expect(
        screen.getByText('Choose a strong password to secure your account')
      ).toBeInTheDocument();
    });

    it('renders both password fields', () => {
      render(<ResetPasswordForm token="valid-token" />);
      expect(screen.getByText('New password')).toBeInTheDocument();
      expect(screen.getByText('Confirm password')).toBeInTheDocument();
    });

    it('renders the Reset Password submit button', () => {
      render(<ResetPasswordForm token="valid-token" />);
      expect(screen.getByRole('button', { name: /reset password/i })).toBeInTheDocument();
    });

    it('does not fire token missing analytics event', () => {
      render(<ResetPasswordForm token="valid-token" />);
      expect(track).not.toHaveBeenCalledWith(AUTH_EVENTS.PASSWORD_RESET_TOKEN_MISSING, {});
    });
  });

  describe('form submission -- success', () => {
    it('calls resetPasswordAction with form data', async () => {
      mockResetPasswordAction.mockResolvedValue({ success: true });
      const user = userEvent.setup();
      const { container } = render(<ResetPasswordForm token="test-token" />);

      await fillAndSubmit(user, container);

      await waitFor(() => {
        expect(mockResetPasswordAction).toHaveBeenCalledWith({
          token: 'test-token',
          password: TEST_PASSWORD,
          confirmPassword: TEST_PASSWORD,
        });
      });
    });

    it('transitions to success state on success', async () => {
      mockResetPasswordAction.mockResolvedValue({ success: true });
      const user = userEvent.setup();
      const { container } = render(<ResetPasswordForm token="test-token" />);

      await fillAndSubmit(user, container);

      await waitFor(() => {
        expect(screen.getByText('Password reset successful')).toBeInTheDocument();
      });
    });

    it('fires PASSWORD_RESET_COMPLETED analytics event', async () => {
      mockResetPasswordAction.mockResolvedValue({ success: true });
      const user = userEvent.setup();
      const { container } = render(<ResetPasswordForm token="test-token" />);

      await fillAndSubmit(user, container);

      await waitFor(() => {
        expect(track).toHaveBeenCalledWith(AUTH_EVENTS.PASSWORD_RESET_COMPLETED, {});
      });
    });

    it('renders "Sign in to your account" button on success', async () => {
      mockResetPasswordAction.mockResolvedValue({ success: true });
      const user = userEvent.setup();
      const { container } = render(<ResetPasswordForm token="test-token" />);

      await fillAndSubmit(user, container);

      await waitFor(() => {
        expect(
          screen.getByRole('button', { name: /sign in to your account/i })
        ).toBeInTheDocument();
      });
    });
  });

  describe('form submission -- expired token error', () => {
    it('transitions to expired error state', async () => {
      mockResetPasswordAction.mockResolvedValue({
        success: false,
        error: 'This password reset link has expired. Please request a new one.',
        code: 'password_reset_expired',
      });
      const user = userEvent.setup();
      const { container } = render(<ResetPasswordForm token="expired-token" />);

      await fillAndSubmit(user, container);

      await waitFor(() => {
        expect(screen.getByText('Reset link expired')).toBeInTheDocument();
      });
    });

    it('fires PASSWORD_RESET_FAILED analytics event', async () => {
      mockResetPasswordAction.mockResolvedValue({
        success: false,
        error: 'This password reset link has expired.',
        code: 'password_reset_expired',
      });
      const user = userEvent.setup();
      const { container } = render(<ResetPasswordForm token="expired-token" />);

      await fillAndSubmit(user, container);

      await waitFor(() => {
        expect(track).toHaveBeenCalledWith(AUTH_EVENTS.PASSWORD_RESET_FAILED, {
          error_message: 'This password reset link has expired.',
        });
      });
    });
  });

  describe('form submission -- generic error', () => {
    it('shows inline error message', async () => {
      mockResetPasswordAction.mockResolvedValue({
        success: false,
        error: 'Please choose a stronger password.',
      });
      const user = userEvent.setup();
      const { container } = render(<ResetPasswordForm token="test-token" />);

      await fillAndSubmit(user, container);

      await waitFor(() => {
        expect(screen.getByRole('alert')).toHaveTextContent('Please choose a stronger password.');
      });
    });

    it('keeps the form active for retry', async () => {
      mockResetPasswordAction.mockResolvedValue({
        success: false,
        error: 'Something went wrong.',
      });
      const user = userEvent.setup();
      const { container } = render(<ResetPasswordForm token="test-token" />);

      await fillAndSubmit(user, container);

      await waitFor(() => {
        expect(screen.getByRole('alert')).toBeInTheDocument();
      });
      // Form should still be visible
      expect(screen.getByText('Set your new password')).toBeInTheDocument();
    });

    it('fires PASSWORD_RESET_FAILED analytics event', async () => {
      mockResetPasswordAction.mockResolvedValue({
        success: false,
        error: 'Something went wrong.',
      });
      const user = userEvent.setup();
      const { container } = render(<ResetPasswordForm token="test-token" />);

      await fillAndSubmit(user, container);

      await waitFor(() => {
        expect(track).toHaveBeenCalledWith(AUTH_EVENTS.PASSWORD_RESET_FAILED, {
          error_message: 'Something went wrong.',
        });
      });
    });
  });
});
