import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { track, AUTH_EVENTS, analytics } from '@/lib/analytics';

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

const mockSignInAction = vi.fn();
vi.mock('@/lib/auth/actions', () => ({
  signInAction: (...args: unknown[]) => mockSignInAction(...args),
}));

const mockForgetSetupIntent = vi.fn();
vi.mock('@/lib/stripe/setup-intent-return', () => ({
  forgetSetupIntent: (...args: unknown[]) => mockForgetSetupIntent(...args),
}));

import { PasswordStep } from './password-step';

// ── Helpers ─────────────────────────────────────────────────────

const TEST_PASSWORD = 'SecurePass1'; // NOSONAR — test fixture
const EMAIL = 'dana@northwind.test';

function makeProps(overrides: Partial<React.ComponentProps<typeof PasswordStep>> = {}) {
  return {
    email: EMAIL,
    formError: null,
    onSuccess: vi.fn(),
    onForgotPassword: vi.fn(),
    onCreateAccount: vi.fn(),
    onBack: vi.fn(),
    onError: vi.fn(),
    ...overrides,
  };
}

async function submit(): Promise<void> {
  await userEvent.type(screen.getByLabelText('Password'), TEST_PASSWORD);
  await userEvent.click(screen.getByRole('button', { name: /sign in/i }));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('PasswordStep — BAL-529 fix-round-1 F5', () => {
  it('calls forgetSetupIntent() on a successful sign-in, before onSuccess', async () => {
    const calls: string[] = [];
    mockForgetSetupIntent.mockImplementation(() => calls.push('forgetSetupIntent'));
    const props = makeProps({
      onSuccess: vi.fn(() => calls.push('onSuccess')),
    });
    mockSignInAction.mockResolvedValue({
      success: true,
      data: { userId: 'u1', needsOnboarding: false, email: EMAIL, activeMode: 'client' },
    });

    render(<PasswordStep {...props} />);
    await submit();

    expect(mockForgetSetupIntent).toHaveBeenCalledTimes(1);
    expect(props.onSuccess).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(['forgetSetupIntent', 'onSuccess']);
  });

  it('does NOT call forgetSetupIntent() on a failed sign-in', async () => {
    const props = makeProps();
    mockSignInAction.mockResolvedValue({ success: false, error: 'Invalid credentials' });

    render(<PasswordStep {...props} />);
    await submit();

    expect(mockForgetSetupIntent).not.toHaveBeenCalled();
    expect(props.onError).toHaveBeenCalledWith('Invalid credentials');
  });

  it('still tracks LOGIN_COMPLETED and identifies the user on success (unchanged by F5)', async () => {
    mockSignInAction.mockResolvedValue({
      success: true,
      data: {
        userId: 'u1',
        needsOnboarding: false,
        email: EMAIL,
        activeMode: 'client',
        platformRole: 'user',
      },
    });

    render(<PasswordStep {...makeProps()} />);
    await submit();

    expect(track).toHaveBeenCalledWith(AUTH_EVENTS.LOGIN_COMPLETED, {
      method: 'email',
      is_returning_user: true,
    });
    expect(analytics.identify).toHaveBeenCalledWith('u1', {
      email: EMAIL,
      active_mode: 'client',
      platform_role: 'user',
    });
  });
});
