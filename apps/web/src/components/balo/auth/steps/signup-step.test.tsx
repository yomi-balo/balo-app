import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@/test/utils';
import userEvent from '@testing-library/user-event';

// ── Mocks ───────────────────────────────────────────────────────
// `@balo/shared/domains` stays REAL (pure prefill logic). analytics + logging are
// globally mocked in src/test/setup.ts.

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

const mockSignUpAction = vi.fn();
const mockCheckSignupDomainAction = vi.fn();
vi.mock('@/lib/auth/actions', () => ({
  signUpAction: (...args: unknown[]) => mockSignUpAction(...args),
  checkSignupDomainAction: (...args: unknown[]) => mockCheckSignupDomainAction(...args),
  // SocialAuthButtons imports these from the same barrel; never called here.
  initiateGoogleOAuth: vi.fn(),
  initiateMicrosoftOAuth: vi.fn(),
}));

import { SignupStep } from './signup-step';
import { track, AUTH_EVENTS } from '@/lib/analytics';

// ── Helpers ─────────────────────────────────────────────────────

const TEST_PASSWORD = 'Passw0rd'; // NOSONAR — test fixture, not a real credential

function renderStep(email = 'jane@acme.com') {
  const props = {
    email,
    formError: null,
    onEmailChange: vi.fn(),
    onVerificationRequired: vi.fn(),
    onSuccess: vi.fn(),
    onSignInInstead: vi.fn(),
    onError: vi.fn(),
  };
  const utils = render(<SignupStep {...props} />);
  return { ...utils, props };
}

function companyInput(container: HTMLElement): HTMLInputElement | null {
  return container.querySelector('input[name="companyName"]');
}

function passwordInput(container: HTMLElement): HTMLInputElement {
  const el = container.querySelector('input[name="password"]');
  if (el === null) throw new Error('password input not found');
  return el as HTMLInputElement;
}

function submitButton(): HTMLElement {
  return screen.getByRole('button', { name: /create account/i });
}

function verifiedSignUp(email: string) {
  return {
    success: true,
    data: {
      verified: true,
      userId: 'user-1',
      email,
      activeMode: 'client',
      platformRole: 'user',
      needsOnboarding: true,
    },
  };
}

// ── Tests ───────────────────────────────────────────────────────

describe('SignupStep — company-name capture (BAL-350)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('runs the pre-submit domain check on mount with the initial email', async () => {
    mockCheckSignupDomainAction.mockResolvedValue({ status: 'new' });
    renderStep('jane@acme.com');
    await waitFor(() => expect(mockCheckSignupDomainAction).toHaveBeenCalledWith('jane@acme.com'));
  });

  it('shows the company field prefilled from the domain apex on "new" status', async () => {
    mockCheckSignupDomainAction.mockResolvedValue({ status: 'new' });
    const { container } = renderStep('jane@acme.com');
    await waitFor(() => expect(companyInput(container)).toBeInTheDocument());
    const input = companyInput(container);
    expect(input).not.toBeNull();
    expect(input?.value).toBe('Acme');
  });

  it('blocks submit with a required error when the shown field is empty', async () => {
    mockCheckSignupDomainAction.mockResolvedValue({ status: 'new' });
    const user = userEvent.setup();
    const { container } = renderStep('jane@acme.com');
    await waitFor(() => expect(companyInput(container)).toBeInTheDocument());

    const input = companyInput(container);
    if (input) await user.clear(input);
    await user.type(passwordInput(container), TEST_PASSWORD);
    await user.click(submitButton());

    await waitFor(() => expect(screen.getByText('Company name is required')).toBeInTheDocument());
    expect(mockSignUpAction).not.toHaveBeenCalled();
  });

  it('hides the field on "matched" and submits without a company name', async () => {
    mockCheckSignupDomainAction.mockResolvedValue({ status: 'matched' });
    mockSignUpAction.mockResolvedValue(verifiedSignUp('jane@acme.com'));
    const user = userEvent.setup();
    const { container } = renderStep('jane@acme.com');
    await waitFor(() => expect(mockCheckSignupDomainAction).toHaveBeenCalled());

    expect(companyInput(container)).toBeNull();
    await user.type(passwordInput(container), TEST_PASSWORD);
    await user.click(submitButton());

    await waitFor(() =>
      expect(mockSignUpAction).toHaveBeenCalledWith({
        email: 'jane@acme.com',
        password: TEST_PASSWORD,
        companyName: undefined,
      })
    );
    expect(track).not.toHaveBeenCalledWith(
      AUTH_EVENTS.SIGNUP_COMPANY_NAME_CAPTURED,
      expect.anything()
    );
  });

  it('shows an EMPTY field on "blocked" (no freemail "Gmail" prefill)', async () => {
    mockCheckSignupDomainAction.mockResolvedValue({ status: 'blocked' });
    const { container } = renderStep('jane@gmail.com');
    await waitFor(() => expect(companyInput(container)).toBeInTheDocument());
    expect(companyInput(container)?.value).toBe('');
  });

  it('fires SIGNUP_COMPANY_NAME_CAPTURED with domain_type "new" on a named submit', async () => {
    mockCheckSignupDomainAction.mockResolvedValue({ status: 'new' });
    mockSignUpAction.mockResolvedValue(verifiedSignUp('jane@acme.com'));
    const user = userEvent.setup();
    const { container } = renderStep('jane@acme.com');
    await waitFor(() => expect(companyInput(container)).toBeInTheDocument());

    await user.type(passwordInput(container), TEST_PASSWORD);
    await user.click(submitButton());

    await waitFor(() =>
      expect(mockSignUpAction).toHaveBeenCalledWith(
        expect.objectContaining({ companyName: 'Acme' })
      )
    );
    expect(track).toHaveBeenCalledWith(AUTH_EVENTS.SIGNUP_COMPANY_NAME_CAPTURED, {
      domain_type: 'new',
    });
  });

  it('fires the capture event with domain_type "blocked" for a freemail signup', async () => {
    mockCheckSignupDomainAction.mockResolvedValue({ status: 'blocked' });
    mockSignUpAction.mockResolvedValue(verifiedSignUp('jane@gmail.com'));
    const user = userEvent.setup();
    const { container } = renderStep('jane@gmail.com');
    await waitFor(() => expect(companyInput(container)).toBeInTheDocument());

    const input = companyInput(container);
    if (input) await user.type(input, 'My Startup');
    await user.type(passwordInput(container), TEST_PASSWORD);
    await user.click(submitButton());

    await waitFor(() =>
      expect(mockSignUpAction).toHaveBeenCalledWith(
        expect.objectContaining({ companyName: 'My Startup' })
      )
    );
    expect(track).toHaveBeenCalledWith(AUTH_EVENTS.SIGNUP_COMPANY_NAME_CAPTURED, {
      domain_type: 'blocked',
    });
  });

  it('forwards the captured company name via onVerificationRequired on the primary path', async () => {
    mockCheckSignupDomainAction.mockResolvedValue({ status: 'new' });
    mockSignUpAction.mockResolvedValue({
      success: true,
      data: { pendingAuthToken: 'pat_x', email: 'jane@acme.com' },
    });
    const user = userEvent.setup();
    const { container, props } = renderStep('jane@acme.com');
    await waitFor(() => expect(companyInput(container)).toBeInTheDocument());

    await user.type(passwordInput(container), TEST_PASSWORD);
    await user.click(submitButton());

    await waitFor(() => expect(props.onVerificationRequired).toHaveBeenCalledWith('pat_x', 'Acme'));
  });

  it('resolves the domain check at submit time when the debounce has not landed (guard await-branch)', async () => {
    // Deferred: the check does NOT resolve until we release it, so submit fires
    // while `domainStatus` is still null and the guard must await it, then read
    // the just-applied prefill from the LIVE form value (not the stale snapshot).
    let resolveCheck!: (value: { status: 'new' }) => void;
    const deferred = new Promise<{ status: 'new' }>((resolve) => {
      resolveCheck = resolve;
    });
    mockCheckSignupDomainAction.mockReturnValue(deferred);
    mockSignUpAction.mockResolvedValue(verifiedSignUp('jane@acme.com'));

    const user = userEvent.setup();
    const { container } = renderStep('jane@acme.com');

    // The mount check is in-flight but unresolved → status null, field hidden.
    await waitFor(() => expect(mockCheckSignupDomainAction).toHaveBeenCalledWith('jane@acme.com'));
    expect(companyInput(container)).toBeNull();

    // Submit while the check is still pending — the guard must await it.
    await user.type(passwordInput(container), TEST_PASSWORD);
    await user.click(submitButton());

    // Release the check as a "new" domain (prefills "Acme").
    resolveCheck({ status: 'new' });

    // The guard awaited the resolution, applied the prefill, and accepted the
    // live prefilled name WITHOUT a false "required" error.
    await waitFor(() =>
      expect(mockSignUpAction).toHaveBeenCalledWith(
        expect.objectContaining({ email: 'jane@acme.com', companyName: 'Acme' })
      )
    );
    expect(screen.queryByText('Company name is required')).toBeNull();
  });

  it('re-checks the freshly-edited email at submit instead of a stale status', async () => {
    // A "matched" domain (field hidden) edited to a "blocked" freemail one within
    // the debounce window: the guard must re-resolve against the NEW email so the
    // now-required, empty company field blocks submit rather than waving through
    // the stale "matched" status.
    mockCheckSignupDomainAction.mockImplementation((email: string) =>
      Promise.resolve({ status: email === 'jane@gmail.com' ? 'blocked' : 'matched' })
    );
    const user = userEvent.setup();
    const { container } = renderStep('jane@acme.com');

    // Mount check resolves to "matched" → field hidden.
    await waitFor(() => expect(mockCheckSignupDomainAction).toHaveBeenCalledWith('jane@acme.com'));
    expect(companyInput(container)).toBeNull();

    // Edit the email to a freemail address and submit.
    const emailField = container.querySelector('input[name="email"]');
    if (emailField === null) throw new Error('email input not found');
    await user.clear(emailField);
    await user.type(emailField, 'jane@gmail.com');
    await user.type(passwordInput(container), TEST_PASSWORD);
    await user.click(submitButton());

    // Guard re-checked against the new email; the required, empty field blocks it.
    await waitFor(() => expect(mockCheckSignupDomainAction).toHaveBeenCalledWith('jane@gmail.com'));
    await waitFor(() => expect(screen.getByText('Company name is required')).toBeInTheDocument());
    expect(mockSignUpAction).not.toHaveBeenCalled();
  });
});
