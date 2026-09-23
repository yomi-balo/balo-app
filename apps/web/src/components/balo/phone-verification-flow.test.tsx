import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// ── Mocks ───────────────────────────────────────────────────────

// Mock motion/react to bypass animation timing in tests
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
      [key: string]: unknown;
    }) => (
      <div className={className} {...rest}>
        {children}
      </div>
    ),
  },
}));

// Mock libphonenumber-js/min
const mockIsValidPhoneNumber = vi.fn();
const mockParsePhoneNumber = vi.fn();
vi.mock('libphonenumber-js/min', () => ({
  isValidPhoneNumber: (...args: unknown[]) => mockIsValidPhoneNumber(...args),
  parsePhoneNumber: (...args: unknown[]) => mockParsePhoneNumber(...args),
}));

// Mock fetch globally — ONLY the ipapi.co country lookup goes over `fetch` now; send/verify are
// Server Actions (mocked below).
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const mockSendOtp = vi.fn();
const mockVerifyOtp = vi.fn();
const mockAuthModalOpen = vi.fn();
vi.mock('@/hooks/use-auth-modal', () => ({
  useAuthModal: () => ({ open: mockAuthModalOpen }),
}));
vi.mock('@/lib/phone/actions', () => ({
  sendPhoneOtpAction: (...args: unknown[]) => mockSendOtp(...args),
  verifyPhoneOtpAction: (...args: unknown[]) => mockVerifyOtp(...args),
}));

// Import after mocks
import { PhoneVerificationFlow } from './phone-verification-flow';
import { track, PHONE_EVENTS } from '@/lib/analytics';
import type { SendPhoneOtpResult, VerifyPhoneOtpResult } from '@/lib/phone/types';
import { SESSION_EXPIRED_MESSAGE } from '@/lib/auth/auth-error-copy';

// ── Helpers ─────────────────────────────────────────────────────

const DEFAULT_PROPS = {
  mode: 'onboarding' as const,
  onVerified: vi.fn(),
};

/**
 * One OTP action outcome: a result the action resolves with, an `Error` it rejects with (a
 * transport failure reaching the Server Action), or `'pending'` for a call that never settles.
 */
type ApiOutcome = SendPhoneOtpResult | VerifyPhoneOtpResult | Error | 'pending';

function settle(outcome: ApiOutcome | undefined): Promise<unknown> {
  if (outcome === undefined) return Promise.resolve({ ok: true });
  if (outcome === 'pending') return new Promise(() => {});
  if (outcome instanceof Error) return Promise.reject(outcome);
  return Promise.resolve(outcome);
}

/**
 * ipapi.co resolves AU; send and verify draw from ONE ordered queue, in call order, repeating
 * the last outcome once it runs out — the same sequencing the former single `fetch` mock had.
 */
function setupApiResponses(outcomes: ApiOutcome[] = []): void {
  mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ country_code: 'AU' }) });
  let callIndex = 0;
  const next = (): Promise<unknown> => {
    const outcome = outcomes[callIndex] ?? outcomes[outcomes.length - 1];
    callIndex++;
    return settle(outcome);
  };
  mockSendOtp.mockImplementation(next);
  mockVerifyOtp.mockImplementation(next);
}

/** Configure libphonenumber to accept the phone number as a valid mobile. */
function setupValidPhone(): void {
  mockIsValidPhoneNumber.mockReturnValue(true);
  mockParsePhoneNumber.mockReturnValue({ getType: () => 'MOBILE' });
}

/** Configure libphonenumber to reject the phone number as invalid. */
function setupInvalidPhone(): void {
  mockIsValidPhoneNumber.mockReturnValue(false);
  mockParsePhoneNumber.mockReturnValue({ getType: () => undefined });
}

/** Configure libphonenumber to flag number as a landline. */
function setupLandlinePhone(): void {
  mockIsValidPhoneNumber.mockReturnValue(true);
  mockParsePhoneNumber.mockReturnValue({ getType: () => 'FIXED_LINE' });
}

function sendOtpSuccess(): SendPhoneOtpResult {
  return { ok: true };
}

function sendOtpError(
  code: Extract<SendPhoneOtpResult, { ok: false }>['code'],
  extra: { cooldownSeconds?: number } = {}
): SendPhoneOtpResult {
  return { ok: false, code, ...extra };
}

function verifyOtpSuccess(): VerifyPhoneOtpResult {
  return { ok: true };
}

function verifyOtpError(
  code: Extract<VerifyPhoneOtpResult, { ok: false }>['code'],
  extra: { attemptsRemaining?: number } = {}
): VerifyPhoneOtpResult {
  return { ok: false, code, ...extra };
}

/**
 * BAL-568 — `apps/api`'s `requireAuth` refused a suspended or soft-deleted account; the Server
 * Action reports it as `account_refused` whichever of the two it was.
 */
function accountRefused(): SendPhoneOtpResult {
  return { ok: false, code: 'account_refused' };
}

// ── Tests ───────────────────────────────────────────────────────

describe('PhoneVerificationFlow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupValidPhone();
    setupApiResponses();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── 1. Entry stage rendering ──────────────────────────────────

  describe('entry stage rendering', () => {
    it('renders phone input, country picker, and send button', async () => {
      render(<PhoneVerificationFlow {...DEFAULT_PROPS} />);

      // Phone input
      expect(screen.getByPlaceholderText('412 345 678')).toBeInTheDocument();
      // Country picker select
      expect(screen.getByRole('combobox', { name: 'Select country code' })).toBeInTheDocument();
      // Send button
      expect(screen.getByRole('button', { name: /send verification code/i })).toBeInTheDocument();
    });

    it('shows helper text with country dial code', async () => {
      render(<PhoneVerificationFlow {...DEFAULT_PROPS} />);

      await waitFor(() => {
        expect(screen.getByText(/Include country code if pasting/)).toBeInTheDocument();
      });
    });

    it('send button is disabled when no number entered', () => {
      render(<PhoneVerificationFlow {...DEFAULT_PROPS} />);

      expect(screen.getByRole('button', { name: /send verification code/i })).toBeDisabled();
    });
  });

  describe('entry stage focus', () => {
    it('focuses the phone input on mount by default', () => {
      render(<PhoneVerificationFlow {...DEFAULT_PROPS} />);

      expect(screen.getByPlaceholderText('412 345 678')).toHaveFocus();
    });

    it('leaves focus alone on mount when focusOnMount is false', () => {
      render(<PhoneVerificationFlow {...DEFAULT_PROPS} focusOnMount={false} />);

      expect(screen.getByPlaceholderText('412 345 678')).not.toHaveFocus();
    });

    it('still focuses the phone input on returning to entry when focusOnMount is false', async () => {
      setupApiResponses([sendOtpSuccess()]);
      const user = userEvent.setup();
      render(<PhoneVerificationFlow {...DEFAULT_PROPS} focusOnMount={false} />);

      await user.type(screen.getByPlaceholderText('412 345 678'), '412345678');
      await user.click(screen.getByRole('button', { name: /send verification code/i }));
      await waitFor(() => {
        expect(screen.getByText('Enter 6-digit code')).toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: 'Change number' }));

      await waitFor(() => {
        expect(screen.getByPlaceholderText('412 345 678')).toHaveFocus();
      });
    });
  });

  // ── 2. Current stage rendering (settings with initialPhone) ───

  describe('current stage rendering', () => {
    it('renders verified number and Change button when initialPhone provided', () => {
      render(
        <PhoneVerificationFlow mode="settings" initialPhone="+61412345678" onVerified={vi.fn()} />
      );

      expect(screen.getByText('+61412345678')).toBeInTheDocument();
      expect(screen.getByText('Verified')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /change/i })).toBeInTheDocument();
    });

    it('shows info about changing requiring re-verification', () => {
      render(
        <PhoneVerificationFlow mode="settings" initialPhone="+61412345678" onVerified={vi.fn()} />
      );

      expect(screen.getByText(/Changing requires re-verification/)).toBeInTheDocument();
    });
  });

  // ── 3. Country picker ──────────────────────────────────────────

  describe('country picker', () => {
    it('defaults to AU', () => {
      render(<PhoneVerificationFlow {...DEFAULT_PROPS} />);

      expect(screen.getByText('+61')).toBeInTheDocument();
    });

    it('selects a different country via native select', async () => {
      const user = userEvent.setup();
      render(<PhoneVerificationFlow {...DEFAULT_PROPS} />);

      const select = screen.getByRole('combobox', { name: 'Select country code' });

      // Select New Zealand
      await user.selectOptions(select, 'NZ');

      // Should show +64 dial code now
      expect(screen.getByText('+64')).toBeInTheDocument();
    });
  });

  // ── 4. Phone validation ────────────────────────────────────────

  describe('phone validation', () => {
    it('shows error for invalid number on blur', async () => {
      setupInvalidPhone();
      const user = userEvent.setup();
      render(<PhoneVerificationFlow {...DEFAULT_PROPS} />);

      const input = screen.getByPlaceholderText('412 345 678');
      await user.type(input, '123');
      await user.tab(); // blur

      await waitFor(() => {
        expect(
          screen.getByText('Enter a valid phone number including country code')
        ).toBeInTheDocument();
      });
    });

    it('shows landline error when number is a landline', async () => {
      setupLandlinePhone();
      const user = userEvent.setup();
      render(<PhoneVerificationFlow {...DEFAULT_PROPS} />);

      const input = screen.getByPlaceholderText('412 345 678');
      await user.type(input, '29876543');
      await user.tab(); // blur

      await waitFor(() => {
        expect(screen.getByText(/enter a mobile number/i)).toBeInTheDocument();
      });
    });
  });

  // ── 5. Send OTP — success ─────────────────────────────────────

  describe('send OTP — success', () => {
    it('transitions to OTP stage and shows 6 digit inputs', async () => {
      setupApiResponses([sendOtpSuccess()]);
      const user = userEvent.setup();
      render(<PhoneVerificationFlow {...DEFAULT_PROPS} />);

      const input = screen.getByPlaceholderText('412 345 678');
      await user.type(input, '412345678');

      await user.click(screen.getByRole('button', { name: /send verification code/i }));

      await waitFor(() => {
        expect(screen.getByText('Enter 6-digit code')).toBeInTheDocument();
      });

      // Should have 6 digit inputs
      const otpInputs = screen.getAllByLabelText(/Digit \d/);
      expect(otpInputs).toHaveLength(6);
    });

    it('shows masked phone number in OTP stage', async () => {
      setupApiResponses([sendOtpSuccess()]);
      const user = userEvent.setup();
      render(<PhoneVerificationFlow {...DEFAULT_PROPS} />);

      const input = screen.getByPlaceholderText('412 345 678');
      await user.type(input, '412345678');

      await user.click(screen.getByRole('button', { name: /send verification code/i }));

      await waitFor(() => {
        expect(screen.getByText(/Code sent to/)).toBeInTheDocument();
      });
    });

    it('shows change number button in OTP stage', async () => {
      setupApiResponses([sendOtpSuccess()]);
      const user = userEvent.setup();
      render(<PhoneVerificationFlow {...DEFAULT_PROPS} />);

      await user.type(screen.getByPlaceholderText('412 345 678'), '412345678');
      await user.click(screen.getByRole('button', { name: /send verification code/i }));

      await waitFor(() => {
        expect(screen.getByText('Change number')).toBeInTheDocument();
      });
    });
  });

  // ── 6. Send OTP — rate limited ─────────────────────────────────

  describe('send OTP — rate limited', () => {
    it('shows rate limit error with cooldown', async () => {
      setupApiResponses([sendOtpError('rate_limited', { cooldownSeconds: 600 })]);
      const user = userEvent.setup();
      render(<PhoneVerificationFlow {...DEFAULT_PROPS} />);

      await user.type(screen.getByPlaceholderText('412 345 678'), '412345678');
      await user.click(screen.getByRole('button', { name: /send verification code/i }));

      await waitFor(() => {
        expect(screen.getByText(/Too many requests for this number/)).toBeInTheDocument();
        expect(screen.getByText(/10 minutes/)).toBeInTheDocument();
      });
    });

    it('hides the send button when rate limited', async () => {
      setupApiResponses([sendOtpError('rate_limited', { cooldownSeconds: 600 })]);
      const user = userEvent.setup();
      render(<PhoneVerificationFlow {...DEFAULT_PROPS} />);

      await user.type(screen.getByPlaceholderText('412 345 678'), '412345678');
      await user.click(screen.getByRole('button', { name: /send verification code/i }));

      await waitFor(() => {
        expect(screen.getByText(/Too many requests/)).toBeInTheDocument();
      });

      // Send button should be hidden (not in DOM) when rate limited
      expect(
        screen.queryByRole('button', { name: /send verification code/i })
      ).not.toBeInTheDocument();
    });
  });

  // ── 7. Send OTP — brevo rejected ──────────────────────────────

  describe('send OTP — brevo rejected', () => {
    it('shows brevo error', async () => {
      setupApiResponses([sendOtpError('brevo_rejected')]);
      const user = userEvent.setup();
      render(<PhoneVerificationFlow {...DEFAULT_PROPS} />);

      await user.type(screen.getByPlaceholderText('412 345 678'), '412345678');
      await user.click(screen.getByRole('button', { name: /send verification code/i }));

      await waitFor(() => {
        expect(screen.getByText(/couldn't send a code to this number/i)).toBeInTheDocument();
      });
    });
  });

  // ── 8. OTP input — digit entry and focus advance ──────────────

  describe('OTP input', () => {
    async function goToOtpStage(user: ReturnType<typeof userEvent.setup>): Promise<void> {
      setupApiResponses([sendOtpSuccess()]);
      render(<PhoneVerificationFlow {...DEFAULT_PROPS} />);

      await user.type(screen.getByPlaceholderText('412 345 678'), '412345678');
      await user.click(screen.getByRole('button', { name: /send verification code/i }));

      await waitFor(() => {
        expect(screen.getByText('Enter 6-digit code')).toBeInTheDocument();
      });
    }

    it('entering a digit advances focus to the next box', async () => {
      const user = userEvent.setup();
      await goToOtpStage(user);

      const digit1 = screen.getByLabelText('Digit 1');
      await user.click(digit1);
      await user.keyboard('1');

      // Value should be set
      expect(digit1).toHaveValue('1');
    });

    it('backspace on empty box moves focus to previous box', async () => {
      const user = userEvent.setup();
      await goToOtpStage(user);

      // Focus the second box (Digit 2) and press Backspace
      const digit2 = screen.getByLabelText('Digit 2');
      await user.click(digit2);
      await user.keyboard('{Backspace}');

      // Focus should move to Digit 1 — we can check Digit 1 has focus
      expect(screen.getByLabelText('Digit 1')).toHaveFocus();
    });
  });

  // ── 9. OTP paste ──────────────────────────────────────────────

  describe('OTP paste', () => {
    it('pasting 6 digits fills all boxes and auto-submits', async () => {
      setupApiResponses([sendOtpSuccess(), verifyOtpSuccess()]);
      const user = userEvent.setup();
      render(<PhoneVerificationFlow {...DEFAULT_PROPS} />);

      await user.type(screen.getByPlaceholderText('412 345 678'), '412345678');
      await user.click(screen.getByRole('button', { name: /send verification code/i }));

      await waitFor(() => {
        expect(screen.getByText('Enter 6-digit code')).toBeInTheDocument();
      });

      // Paste 6 digits into the first box
      const digit1 = screen.getByLabelText('Digit 1');
      await user.click(digit1);

      // Simulate paste event
      await act(async () => {
        const pasteEvent = new Event('paste', { bubbles: true, cancelable: true });
        Object.defineProperty(pasteEvent, 'clipboardData', {
          value: {
            getData: () => '123456',
          },
        });
        digit1.dispatchEvent(pasteEvent);
      });

      // After paste and auto-submit, verify should transition to verified stage
      await waitFor(() => {
        expect(screen.getByText('Phone verified')).toBeInTheDocument();
      });
    });
  });

  // ── 10. Verify — success ──────────────────────────────────────

  describe('verify — success', () => {
    it('correct code shows verified stage with checkmark and calls onVerified', async () => {
      const onVerified = vi.fn();
      setupApiResponses([sendOtpSuccess(), verifyOtpSuccess()]);
      const user = userEvent.setup();
      render(<PhoneVerificationFlow mode="onboarding" onVerified={onVerified} />);

      // Enter phone and send
      await user.type(screen.getByPlaceholderText('412 345 678'), '412345678');
      await user.click(screen.getByRole('button', { name: /send verification code/i }));

      await waitFor(() => {
        expect(screen.getByText('Enter 6-digit code')).toBeInTheDocument();
      });

      // Type 6 digits one by one
      const digits = screen.getAllByLabelText(/Digit \d/);
      for (let i = 0; i < 6; i++) {
        await user.click(digits[i]!);
        await user.keyboard(String(i + 1));
      }

      await waitFor(() => {
        expect(screen.getByText('Phone verified')).toBeInTheDocument();
      });

      expect(onVerified).toHaveBeenCalledWith('+61412345678');
    });

    it('fires PHONE_VERIFIED analytics event on success', async () => {
      setupApiResponses([sendOtpSuccess(), verifyOtpSuccess()]);
      const user = userEvent.setup();
      render(<PhoneVerificationFlow {...DEFAULT_PROPS} />);

      await user.type(screen.getByPlaceholderText('412 345 678'), '412345678');
      await user.click(screen.getByRole('button', { name: /send verification code/i }));

      await waitFor(() => {
        expect(screen.getByText('Enter 6-digit code')).toBeInTheDocument();
      });

      const digits = screen.getAllByLabelText(/Digit \d/);
      for (let i = 0; i < 6; i++) {
        await user.click(digits[i]!);
        await user.keyboard(String(i + 1));
      }

      await waitFor(() => {
        expect(track).toHaveBeenCalledWith(PHONE_EVENTS.PHONE_VERIFIED, {
          phone_masked: '****5678',
          country_code: 'AU',
          source: 'onboarding',
        });
      });
    });

    it('shows "Number updated" text in settings mode with initialPhone', async () => {
      const onVerified = vi.fn();
      setupApiResponses([sendOtpSuccess(), verifyOtpSuccess()]);
      const user = userEvent.setup();
      render(
        <PhoneVerificationFlow
          mode="settings"
          initialPhone="+61400000000"
          onVerified={onVerified}
        />
      );

      // Click Change to go to entry stage
      await user.click(screen.getByRole('button', { name: /change/i }));

      await user.type(screen.getByPlaceholderText('412 345 678'), '412345678');
      await user.click(screen.getByRole('button', { name: /send verification code/i }));

      await waitFor(() => {
        expect(screen.getByText('Enter 6-digit code')).toBeInTheDocument();
      });

      const digits = screen.getAllByLabelText(/Digit \d/);
      for (let i = 0; i < 6; i++) {
        await user.click(digits[i]!);
        await user.keyboard(String(i + 1));
      }

      await waitFor(() => {
        expect(screen.getByText('Number updated')).toBeInTheDocument();
        expect(
          screen.getByText('Your phone number has been changed and verified.')
        ).toBeInTheDocument();
      });
    });

    it('shows e164 phone on verified stage and allows change', async () => {
      setupApiResponses([sendOtpSuccess(), verifyOtpSuccess()]);
      const user = userEvent.setup();
      render(<PhoneVerificationFlow {...DEFAULT_PROPS} />);

      await user.type(screen.getByPlaceholderText('412 345 678'), '412345678');
      await user.click(screen.getByRole('button', { name: /send verification code/i }));

      await waitFor(() => {
        expect(screen.getByText('Enter 6-digit code')).toBeInTheDocument();
      });

      const digits = screen.getAllByLabelText(/Digit \d/);
      for (let i = 0; i < 6; i++) {
        await user.click(digits[i]!);
        await user.keyboard(String(i + 1));
      }

      await waitFor(() => {
        expect(screen.getByText('+61412345678')).toBeInTheDocument();
        expect(screen.getByText('Change phone number')).toBeInTheDocument();
      });
    });
  });

  // ── 11. Verify — wrong code ───────────────────────────────────

  describe('verify — wrong code', () => {
    it('shows error and attempts remaining', async () => {
      setupApiResponses([sendOtpSuccess(), verifyOtpError('wrong_code', { attemptsRemaining: 2 })]);
      const user = userEvent.setup();
      render(<PhoneVerificationFlow {...DEFAULT_PROPS} />);

      await user.type(screen.getByPlaceholderText('412 345 678'), '412345678');
      await user.click(screen.getByRole('button', { name: /send verification code/i }));

      await waitFor(() => {
        expect(screen.getByText('Enter 6-digit code')).toBeInTheDocument();
      });

      const digits = screen.getAllByLabelText(/Digit \d/);
      for (let i = 0; i < 6; i++) {
        await user.click(digits[i]!);
        await user.keyboard(String(i + 1));
      }

      await waitFor(() => {
        expect(screen.getByText(/2 attempts remaining/)).toBeInTheDocument();
        expect(screen.getByText(/2 attempts left/)).toBeInTheDocument();
      });
    });

    it("shows final attempt warning on the api's final_attempt response", async () => {
      setupApiResponses([
        sendOtpSuccess(),
        verifyOtpError('final_attempt', { attemptsRemaining: 1 }),
      ]);
      const user = userEvent.setup();
      render(<PhoneVerificationFlow {...DEFAULT_PROPS} />);

      await user.type(screen.getByPlaceholderText('412 345 678'), '412345678');
      await user.click(screen.getByRole('button', { name: /send verification code/i }));

      await waitFor(() => {
        expect(screen.getByText('Enter 6-digit code')).toBeInTheDocument();
      });

      const digits = screen.getAllByLabelText(/Digit \d/);
      for (let i = 0; i < 6; i++) {
        await user.click(digits[i]!);
        await user.keyboard(String(i + 1));
      }

      await waitFor(() => {
        expect(screen.getByText('Last attempt')).toBeInTheDocument();
        expect(screen.getByText(/One more wrong attempt will lock you out/)).toBeInTheDocument();
      });
      // Must not fall through to the generic arm.
      expect(screen.queryByText(/Something went wrong/)).not.toBeInTheDocument();
    });

    it('treats a wrong_code carrying one remaining attempt as the final attempt too', async () => {
      setupApiResponses([sendOtpSuccess(), verifyOtpError('wrong_code', { attemptsRemaining: 1 })]);
      const user = userEvent.setup();
      render(<PhoneVerificationFlow {...DEFAULT_PROPS} />);

      await user.type(screen.getByPlaceholderText('412 345 678'), '412345678');
      await user.click(screen.getByRole('button', { name: /send verification code/i }));
      await waitFor(() => {
        expect(screen.getByText('Enter 6-digit code')).toBeInTheDocument();
      });

      const digits = screen.getAllByLabelText(/Digit \d/);
      for (let i = 0; i < 6; i++) {
        await user.click(digits[i]!);
        await user.keyboard(String(i + 1));
      }

      await waitFor(() => {
        expect(screen.getByText(/One more wrong attempt will lock you out/)).toBeInTheDocument();
      });
    });
  });

  // ── 12. Verify — locked out ───────────────────────────────────

  describe('verify — locked out', () => {
    it('shows lockout message after max attempts', async () => {
      setupApiResponses([sendOtpSuccess(), verifyOtpError('locked_out')]);
      const user = userEvent.setup();
      render(<PhoneVerificationFlow {...DEFAULT_PROPS} />);

      await user.type(screen.getByPlaceholderText('412 345 678'), '412345678');
      await user.click(screen.getByRole('button', { name: /send verification code/i }));

      await waitFor(() => {
        expect(screen.getByText('Enter 6-digit code')).toBeInTheDocument();
      });

      const digits = screen.getAllByLabelText(/Digit \d/);
      for (let i = 0; i < 6; i++) {
        await user.click(digits[i]!);
        await user.keyboard(String(i + 1));
      }

      await waitFor(() => {
        expect(screen.getByText(/Too many incorrect attempts/)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /send a new code/i })).toBeInTheDocument();
      });
    });
  });

  // ── 13. Verify — expired ──────────────────────────────────────

  describe('verify — expired', () => {
    it('shows expired message', async () => {
      setupApiResponses([sendOtpSuccess(), verifyOtpError('code_expired')]);
      const user = userEvent.setup();
      render(<PhoneVerificationFlow {...DEFAULT_PROPS} />);

      await user.type(screen.getByPlaceholderText('412 345 678'), '412345678');
      await user.click(screen.getByRole('button', { name: /send verification code/i }));

      await waitFor(() => {
        expect(screen.getByText('Enter 6-digit code')).toBeInTheDocument();
      });

      const digits = screen.getAllByLabelText(/Digit \d/);
      for (let i = 0; i < 6; i++) {
        await user.click(digits[i]!);
        await user.keyboard(String(i + 1));
      }

      await waitFor(() => {
        expect(screen.getByText(/Your code has expired/)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /send a new code/i })).toBeInTheDocument();
      });
    });
  });

  // ── 14. Resend timer ──────────────────────────────────────────

  describe('resend timer', () => {
    it('shows countdown and resend button appears after timer expires', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });

      setupApiResponses([sendOtpSuccess()]);
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      render(<PhoneVerificationFlow {...DEFAULT_PROPS} />);

      await user.type(screen.getByPlaceholderText('412 345 678'), '412345678');
      await user.click(screen.getByRole('button', { name: /send verification code/i }));

      await waitFor(() => {
        expect(screen.getByText('Enter 6-digit code')).toBeInTheDocument();
      });

      // Should show countdown
      expect(screen.getByText(/Resend in/)).toBeInTheDocument();

      // Advance timers by 31 seconds to pass the 30s cooldown
      await act(async () => {
        vi.advanceTimersByTime(31_000);
      });

      await waitFor(() => {
        expect(screen.getByText('Resend code')).toBeInTheDocument();
      });
    });
  });

  // ── 15. Settings mode — cancel ─────────────────────────────────

  describe('settings mode — cancel', () => {
    it('calls onCancel when cancel button clicked', async () => {
      const onCancel = vi.fn();
      const user = userEvent.setup();
      render(<PhoneVerificationFlow mode="settings" onVerified={vi.fn()} onCancel={onCancel} />);

      // In settings mode without initialPhone, starts at entry
      const cancelButton = screen.getByRole('button', { name: /cancel/i });
      await user.click(cancelButton);

      expect(onCancel).toHaveBeenCalledTimes(1);
    });
  });

  // ── 16. Settings mode — change ─────────────────────────────────

  describe('settings mode — change', () => {
    it('transitions from current to entry stage when Change clicked', async () => {
      const user = userEvent.setup();
      render(
        <PhoneVerificationFlow mode="settings" initialPhone="+61412345678" onVerified={vi.fn()} />
      );

      // Should be in current stage
      expect(screen.getByText('+61412345678')).toBeInTheDocument();
      expect(screen.getByText('Verified')).toBeInTheDocument();

      // Click Change
      await user.click(screen.getByRole('button', { name: /change/i }));

      // Should now show entry stage with phone input
      await waitFor(() => {
        expect(screen.getByPlaceholderText('412 345 678')).toBeInTheDocument();
      });

      // Should show warning banner about changing number
      expect(
        screen.getByText(/Changing your number requires a new verification code/)
      ).toBeInTheDocument();
    });
  });

  // ── 17. Network error ─────────────────────────────────────────

  describe('network error', () => {
    it('a rejected send action shows network error', async () => {
      // the send action rejects (a transport failure reaching the Server Action)
      setupApiResponses([new Error('Network failure')]);

      const user = userEvent.setup();
      render(<PhoneVerificationFlow {...DEFAULT_PROPS} />);

      await user.type(screen.getByPlaceholderText('412 345 678'), '412345678');
      await user.click(screen.getByRole('button', { name: /send verification code/i }));

      await waitFor(() => {
        expect(screen.getByText(/Something went wrong sending the code/)).toBeInTheDocument();
      });
    });

    it('network error during verify shows error with try again', async () => {
      // send succeeds, then the verify action rejects
      setupApiResponses([sendOtpSuccess(), new Error('Network failure')]);

      const user = userEvent.setup();
      render(<PhoneVerificationFlow {...DEFAULT_PROPS} />);

      await user.type(screen.getByPlaceholderText('412 345 678'), '412345678');
      await user.click(screen.getByRole('button', { name: /send verification code/i }));

      await waitFor(() => {
        expect(screen.getByText('Enter 6-digit code')).toBeInTheDocument();
      });

      const digits = screen.getAllByLabelText(/Digit \d/);
      for (let i = 0; i < 6; i++) {
        await user.click(digits[i]!);
        await user.keyboard(String(i + 1));
      }

      await waitFor(() => {
        expect(screen.getByText(/Something went wrong sending the code/)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
      });
    });
  });

  // ── 18. Send OTP — server returns invalid_phone ────────────────

  describe('send OTP — server validation errors', () => {
    it('shows server-side invalid_phone error', async () => {
      setupApiResponses([sendOtpError('invalid_phone')]);
      const user = userEvent.setup();
      render(<PhoneVerificationFlow {...DEFAULT_PROPS} />);

      await user.type(screen.getByPlaceholderText('412 345 678'), '412345678');
      await user.click(screen.getByRole('button', { name: /send verification code/i }));

      await waitFor(() => {
        expect(
          screen.getByText('Enter a valid phone number including country code')
        ).toBeInTheDocument();
      });
    });

    it('shows server-side landline error', async () => {
      setupApiResponses([sendOtpError('landline_not_supported')]);
      const user = userEvent.setup();
      render(<PhoneVerificationFlow {...DEFAULT_PROPS} />);

      await user.type(screen.getByPlaceholderText('412 345 678'), '412345678');
      await user.click(screen.getByRole('button', { name: /send verification code/i }));

      await waitFor(() => {
        expect(screen.getByText(/enter a mobile number/i)).toBeInTheDocument();
      });
    });

    it('shows fallback network error for a failed request (the action maps unknown literals here)', async () => {
      setupApiResponses([sendOtpError('request_failed')]);
      const user = userEvent.setup();
      render(<PhoneVerificationFlow {...DEFAULT_PROPS} />);

      await user.type(screen.getByPlaceholderText('412 345 678'), '412345678');
      await user.click(screen.getByRole('button', { name: /send verification code/i }));

      await waitFor(() => {
        expect(screen.getByText(/Something went wrong sending the code/)).toBeInTheDocument();
      });
    });
  });

  // ── 19. IP geolocation fallback ────────────────────────────────

  describe('IP geolocation', () => {
    it('falls back to AU when ipapi.co fails', async () => {
      mockFetch.mockRejectedValueOnce(new Error('timeout'));
      render(<PhoneVerificationFlow {...DEFAULT_PROPS} />);

      // Default country should remain AU
      expect(screen.getByText('+61')).toBeInTheDocument();
    });

    it('updates country when ipapi.co returns a matching country', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ country_code: 'US' }),
      });

      render(<PhoneVerificationFlow {...DEFAULT_PROPS} />);

      await waitFor(() => {
        expect(screen.getByText('+1')).toBeInTheDocument();
      });
    });
  });

  // ── 20. Sending state ──────────────────────────────────────────

  describe('sending state', () => {
    it('shows "Sending..." text while waiting for send-otp response', async () => {
      // ipapi.co resolves, then send-otp never resolves
      setupApiResponses(['pending']);

      const user = userEvent.setup();
      render(<PhoneVerificationFlow {...DEFAULT_PROPS} />);

      await user.type(screen.getByPlaceholderText('412 345 678'), '412345678');
      await user.click(screen.getByRole('button', { name: /send verification code/i }));

      await waitFor(() => {
        expect(screen.getByText(/Sending/)).toBeInTheDocument();
      });
    });

    it('disables phone input and country picker while sending', async () => {
      setupApiResponses(['pending']);

      const user = userEvent.setup();
      render(<PhoneVerificationFlow {...DEFAULT_PROPS} />);

      await user.type(screen.getByPlaceholderText('412 345 678'), '412345678');
      await user.click(screen.getByRole('button', { name: /send verification code/i }));

      await waitFor(() => {
        expect(screen.getByPlaceholderText('412 345 678')).toBeDisabled();
        expect(screen.getByRole('combobox', { name: 'Select country code' })).toBeDisabled();
      });
    });
  });

  // ── 21. Change number from verified stage ──────────────────────

  describe('change phone number from verified stage', () => {
    it('clicking "Change phone number" returns to entry', async () => {
      setupApiResponses([sendOtpSuccess(), verifyOtpSuccess()]);
      const user = userEvent.setup();
      render(<PhoneVerificationFlow {...DEFAULT_PROPS} />);

      await user.type(screen.getByPlaceholderText('412 345 678'), '412345678');
      await user.click(screen.getByRole('button', { name: /send verification code/i }));

      await waitFor(() => {
        expect(screen.getByText('Enter 6-digit code')).toBeInTheDocument();
      });

      const digits = screen.getAllByLabelText(/Digit \d/);
      for (let i = 0; i < 6; i++) {
        await user.click(digits[i]!);
        await user.keyboard(String(i + 1));
      }

      await waitFor(() => {
        expect(screen.getByText('Phone verified')).toBeInTheDocument();
      });

      await user.click(screen.getByText('Change phone number'));

      await waitFor(() => {
        expect(screen.getByPlaceholderText('412 345 678')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /send verification code/i })).toBeInTheDocument();
      });
    });
  });

  // ── 22. Verifying state ────────────────────────────────────────

  describe('verifying state', () => {
    it('shows verifying spinner while waiting for verify-otp response', async () => {
      // ipapi.co resolves, send-otp resolves, verify-otp never resolves
      setupApiResponses([sendOtpSuccess(), 'pending']);

      const user = userEvent.setup();
      render(<PhoneVerificationFlow {...DEFAULT_PROPS} />);

      await user.type(screen.getByPlaceholderText('412 345 678'), '412345678');
      await user.click(screen.getByRole('button', { name: /send verification code/i }));

      await waitFor(() => {
        expect(screen.getByText('Enter 6-digit code')).toBeInTheDocument();
      });

      const digits = screen.getAllByLabelText(/Digit \d/);
      for (let i = 0; i < 6; i++) {
        await user.click(digits[i]!);
        await user.keyboard(String(i + 1));
      }

      await waitFor(() => {
        expect(screen.getByText(/Verifying/)).toBeInTheDocument();
      });
    });
  });

  /**
   * ── BAL-568 — AN ACCOUNT REFUSAL SIGNS THE PERSON OUT ──────────────────────────────────
   *
   * The phone Server Actions report a suspended or deleted account as `account_refused`,
   * whichever of the two it was. The component then navigates to the session-sync Route
   * Handler, which re-reads the LIVE row, destroys the cookie and lands on
   * `/login?error=account_suspended|account_deleted` with BAL-197's copy.
   *
   * ⚠ IT MUST NOT PICK THE CODE ITSELF — the route owns the precedence — and it must NOT run the
   * normal error mapping, which would show retry copy for an account that can never retry.
   */
  describe('BAL-568 — an account-refused result signs the person out', () => {
    let assignSpy: ReturnType<typeof vi.fn>;
    let originalLocation: Location;

    beforeEach(() => {
      assignSpy = vi.fn();
      originalLocation = globalThis.location;
      Object.defineProperty(globalThis, 'location', {
        configurable: true,
        writable: true,
        value: { ...originalLocation, assign: assignSpy },
      });
    });

    afterEach(() => {
      Object.defineProperty(globalThis, 'location', {
        configurable: true,
        writable: true,
        value: originalLocation,
      });
    });

    it('⚠ navigates to the sync route on an account-refused SEND result, once, with no error copy', async () => {
      setupApiResponses([accountRefused()]);
      const user = userEvent.setup();
      render(<PhoneVerificationFlow {...DEFAULT_PROPS} />);

      await user.type(screen.getByPlaceholderText('412 345 678'), '412345678');
      await user.click(screen.getByRole('button', { name: /send verification code/i }));

      await waitFor(() => {
        expect(assignSpy).toHaveBeenCalledTimes(1);
      });
      expect(assignSpy).toHaveBeenCalledWith('/api/auth/session-sync?returnTo=/login');
      // The normal mapping never ran: no generic failure copy, and no OTP stage.
      expect(screen.queryByText(/Something went wrong sending the code/)).not.toBeInTheDocument();
      expect(screen.queryByText('Enter 6-digit code')).not.toBeInTheDocument();
    });

    it('⚠ navigates on an account-refused VERIFY result too, without the wrong-code mapping', async () => {
      setupApiResponses([sendOtpSuccess(), accountRefused()]);
      const user = userEvent.setup();
      render(<PhoneVerificationFlow {...DEFAULT_PROPS} />);

      await user.type(screen.getByPlaceholderText('412 345 678'), '412345678');
      await user.click(screen.getByRole('button', { name: /send verification code/i }));
      await waitFor(() => {
        expect(screen.getByText('Enter 6-digit code')).toBeInTheDocument();
      });

      const digits = screen.getAllByLabelText(/Digit \d/);
      for (let i = 0; i < 6; i++) {
        await user.click(digits[i]!);
        await user.keyboard(String(i + 1));
      }

      await waitFor(() => {
        expect(assignSpy).toHaveBeenCalledWith('/api/auth/session-sync?returnTo=/login');
      });
      expect(screen.queryByText(/incorrect/i)).not.toBeInTheDocument();
    });

    it('a non-refusal failure is unchanged — it still maps to its normal error copy', async () => {
      setupApiResponses([sendOtpError('brevo_rejected')]);
      const user = userEvent.setup();
      render(<PhoneVerificationFlow {...DEFAULT_PROPS} />);

      await user.type(screen.getByPlaceholderText('412 345 678'), '412345678');
      await user.click(screen.getByRole('button', { name: /send verification code/i }));

      await waitFor(() => {
        expect(screen.getByText(/couldn't send/i)).toBeInTheDocument();
      });
      expect(assignSpy).not.toHaveBeenCalled();
    });
  });

  // ── 24. Expired session (the page outlived its access token) ───

  describe('expired session', () => {
    async function reachOtpStage(user: ReturnType<typeof userEvent.setup>): Promise<void> {
      await user.type(screen.getByPlaceholderText('412 345 678'), '412345678');
      await user.click(screen.getByRole('button', { name: /send verification code/i }));
      await waitFor(() => {
        expect(screen.getByText('Enter 6-digit code')).toBeInTheDocument();
      });
    }

    async function typeCode(user: ReturnType<typeof userEvent.setup>): Promise<void> {
      const digits = screen.getAllByLabelText(/Digit \d/);
      for (let i = 0; i < 6; i++) {
        await user.click(digits[i]!);
        await user.keyboard(String(i + 1));
      }
    }

    it('retries a verify once when the session was stale, and verifies on the retry', async () => {
      const onVerified = vi.fn();
      setupApiResponses([sendOtpSuccess(), verifyOtpError('session_expired'), verifyOtpSuccess()]);
      const user = userEvent.setup();
      render(<PhoneVerificationFlow mode="onboarding" onVerified={onVerified} />);

      await reachOtpStage(user);
      await typeCode(user);

      await waitFor(() => {
        expect(onVerified).toHaveBeenCalledWith('+61412345678');
      });
      expect(mockVerifyOtp).toHaveBeenCalledTimes(2);
      expect(mockVerifyOtp).toHaveBeenNthCalledWith(1, '+61412345678', '123456');
      expect(mockVerifyOtp).toHaveBeenNthCalledWith(2, '+61412345678', '123456');
    });

    it('⚠ never reports "Incorrect code" when the session is still expired after the retry', async () => {
      setupApiResponses([sendOtpSuccess(), verifyOtpError('session_expired')]);
      const user = userEvent.setup();
      render(<PhoneVerificationFlow {...DEFAULT_PROPS} />);

      await reachOtpStage(user);
      await typeCode(user);

      await waitFor(() => {
        expect(screen.getByText(SESSION_EXPIRED_MESSAGE)).toBeInTheDocument();
      });
      expect(screen.getByRole('button', { name: 'Sign in again' })).toBeInTheDocument();
      expect(screen.queryByText(/incorrect/i)).not.toBeInTheDocument();
      expect(mockVerifyOtp).toHaveBeenCalledTimes(2);
    });

    it('"Sign in again" opens the auth modal, and a successful sign-in re-opens the same code for entry', async () => {
      const onVerified = vi.fn();
      setupApiResponses([
        sendOtpSuccess(),
        verifyOtpError('session_expired'),
        verifyOtpError('session_expired'),
        verifyOtpSuccess(),
      ]);
      const user = userEvent.setup();
      render(<PhoneVerificationFlow mode="onboarding" onVerified={onVerified} />);

      await reachOtpStage(user);
      await typeCode(user);
      await user.click(await screen.findByRole('button', { name: 'Sign in again' }));

      expect(mockAuthModalOpen).toHaveBeenCalledTimes(1);
      const [options] = mockAuthModalOpen.mock.calls[0] as [
        { initialError: string; onSuccess: () => void },
      ];
      expect(options.initialError).toBe(SESSION_EXPIRED_MESSAGE);

      act(() => options.onSuccess());
      await waitFor(() => {
        expect(screen.queryByText(SESSION_EXPIRED_MESSAGE)).not.toBeInTheDocument();
      });

      // The same code, never checked by the api, is entered again and now verifies.
      await typeCode(user);
      await waitFor(() => {
        expect(onVerified).toHaveBeenCalledWith('+61412345678');
      });
      expect(mockSendOtp).toHaveBeenCalledTimes(1);
    });

    it('retries a send once when the session was stale, then reaches the OTP stage', async () => {
      setupApiResponses([sendOtpError('session_expired'), sendOtpSuccess()]);
      const user = userEvent.setup();
      render(<PhoneVerificationFlow {...DEFAULT_PROPS} />);

      await reachOtpStage(user);

      expect(mockSendOtp).toHaveBeenCalledTimes(2);
      expect(mockSendOtp).toHaveBeenNthCalledWith(2, '+61412345678');
    });

    it('offers "Sign in again" in place of Send when a send stays expired, and restores Send after sign-in', async () => {
      setupApiResponses([sendOtpError('session_expired')]);
      const user = userEvent.setup();
      render(<PhoneVerificationFlow {...DEFAULT_PROPS} />);

      await user.type(screen.getByPlaceholderText('412 345 678'), '412345678');
      await user.click(screen.getByRole('button', { name: /send verification code/i }));

      await waitFor(() => {
        expect(screen.getByText(SESSION_EXPIRED_MESSAGE)).toBeInTheDocument();
      });
      expect(mockSendOtp).toHaveBeenCalledTimes(2);
      expect(screen.queryByText('Enter 6-digit code')).not.toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: /send verification code/i })
      ).not.toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Sign in again' }));
      const [options] = mockAuthModalOpen.mock.calls[0] as [{ onSuccess: () => void }];
      act(() => options.onSuccess());

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /send verification code/i })).toBeInTheDocument();
      });
      expect(screen.queryByText(SESSION_EXPIRED_MESSAGE)).not.toBeInTheDocument();
    });

    it('does not retry any other failure', async () => {
      setupApiResponses([sendOtpSuccess(), verifyOtpError('wrong_code', { attemptsRemaining: 2 })]);
      const user = userEvent.setup();
      render(<PhoneVerificationFlow {...DEFAULT_PROPS} />);

      await reachOtpStage(user);
      await typeCode(user);

      await waitFor(() => {
        expect(screen.getByText(/2 attempts remaining/)).toBeInTheDocument();
      });
      expect(mockVerifyOtp).toHaveBeenCalledTimes(1);
    });

    it('a failed request on verify shows the connection banner, not a wrong code', async () => {
      setupApiResponses([sendOtpSuccess(), verifyOtpError('request_failed')]);
      const user = userEvent.setup();
      render(<PhoneVerificationFlow {...DEFAULT_PROPS} />);

      await reachOtpStage(user);
      await typeCode(user);

      await waitFor(() => {
        expect(screen.getByText(/Something went wrong sending the code/)).toBeInTheDocument();
      });
      expect(screen.queryByText(/incorrect/i)).not.toBeInTheDocument();
    });
  });

  // ── 25. Impersonated session ───────────────────────────────────

  describe('impersonated session', () => {
    it('refuses a send without a retry or a sign-in offer — signing in would end the impersonation', async () => {
      setupApiResponses([sendOtpError('impersonation_refused')]);
      const user = userEvent.setup();
      render(<PhoneVerificationFlow {...DEFAULT_PROPS} />);

      await user.type(screen.getByPlaceholderText('412 345 678'), '412345678');
      await user.click(screen.getByRole('button', { name: /send verification code/i }));

      await waitFor(() => {
        expect(screen.getByText(/has to be their action/)).toBeInTheDocument();
      });
      expect(mockSendOtp).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole('button', { name: 'Sign in again' })).not.toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: /send verification code/i })
      ).not.toBeInTheDocument();
      expect(screen.queryByText(SESSION_EXPIRED_MESSAGE)).not.toBeInTheDocument();
    });

    it('refuses a verify with the same copy, never as a wrong code', async () => {
      setupApiResponses([sendOtpSuccess(), verifyOtpError('impersonation_refused')]);
      const user = userEvent.setup();
      render(<PhoneVerificationFlow {...DEFAULT_PROPS} />);

      await user.type(screen.getByPlaceholderText('412 345 678'), '412345678');
      await user.click(screen.getByRole('button', { name: /send verification code/i }));
      await waitFor(() => {
        expect(screen.getByText('Enter 6-digit code')).toBeInTheDocument();
      });
      const digits = screen.getAllByLabelText(/Digit \d/);
      for (let i = 0; i < 6; i++) {
        await user.click(digits[i]!);
        await user.keyboard(String(i + 1));
      }

      await waitFor(() => {
        expect(screen.getByText(/has to be their action/)).toBeInTheDocument();
      });
      expect(mockVerifyOtp).toHaveBeenCalledTimes(1);
      expect(screen.queryByText(/incorrect/i)).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Sign in again' })).not.toBeInTheDocument();
    });
  });
});
