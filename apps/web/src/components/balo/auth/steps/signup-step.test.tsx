import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { track, AUTH_EVENTS } from '@/lib/analytics';

// ── Mocks ───────────────────────────────────────────────────────

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
  }),
}));

const mockSignUpAction = vi.fn();
vi.mock('@/lib/auth/actions', () => ({
  signUpAction: (...args: unknown[]) => mockSignUpAction(...args),
  initiateGoogleOAuth: vi.fn(),
  initiateMicrosoftOAuth: vi.fn(),
}));

const mockCaptureException = vi.fn();
vi.mock('@sentry/nextjs', () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}));

import { SignupStep } from './signup-step';

// ── Helpers ─────────────────────────────────────────────────────

const TEST_PASSWORD = 'SecurePass1'; // NOSONAR — test fixture
const EMAIL = 'dana@northwind.test';

function makeProps(overrides: Partial<React.ComponentProps<typeof SignupStep>> = {}) {
  return {
    email: EMAIL,
    formError: null,
    onEmailChange: vi.fn(),
    onVerificationRequired: vi.fn(),
    onSuccess: vi.fn(),
    onSignInInstead: vi.fn(),
    onError: vi.fn(),
    ...overrides,
  };
}

async function submit(): Promise<void> {
  await userEvent.type(screen.getByLabelText('Create a password'), TEST_PASSWORD);
  await userEvent.click(screen.getByRole('button', { name: /create account/i }));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('SignupStep', () => {
  it('moves to verification when the action asks for an email code', async () => {
    mockSignUpAction.mockResolvedValue({
      success: true,
      data: { pendingAuthToken: 'pending-token', email: EMAIL },
    });
    const props = makeProps();

    render(<SignupStep {...props} />);
    await submit();

    expect(mockSignUpAction).toHaveBeenCalledWith({ email: EMAIL, password: TEST_PASSWORD });
    expect(props.onVerificationRequired).toHaveBeenCalledWith('pending-token');
    expect(props.onError).not.toHaveBeenCalled();
  });

  it('shows the error the action returns', async () => {
    mockSignUpAction.mockResolvedValue({
      success: false,
      error: 'Please choose a stronger password.',
    });
    const props = makeProps();

    render(<SignupStep {...props} />);
    await submit();

    expect(props.onError).toHaveBeenCalledWith('Please choose a stronger password.');
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it('reports a rejected action and shows an error instead of silently resetting', async () => {
    const thrown = new Error('An unexpected response was received from the server.');
    mockSignUpAction.mockRejectedValue(thrown);
    const props = makeProps();

    render(<SignupStep {...props} />);
    await submit();

    expect(mockCaptureException).toHaveBeenCalledWith(thrown, {
      tags: { auth_action: 'sign_up' },
    });
    expect(props.onError).toHaveBeenCalledWith('Something went wrong. Please try again.');
    expect(track).toHaveBeenCalledWith(AUTH_EVENTS.SIGNUP_FAILED, {
      method: 'email',
      error_message: 'Something went wrong. Please try again.',
    });
    expect(props.onVerificationRequired).not.toHaveBeenCalled();
    expect(props.onSuccess).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /create account/i })).toBeEnabled();
  });
});
