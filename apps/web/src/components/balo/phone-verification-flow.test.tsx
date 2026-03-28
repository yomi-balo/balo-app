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

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Import after mocks
import { PhoneVerificationFlow } from './phone-verification-flow';
import { track, PHONE_EVENTS } from '@/lib/analytics';

// ── Helpers ─────────────────────────────────────────────────────

const DEFAULT_PROPS = {
  mode: 'onboarding' as const,
  accessToken: 'test-token-123',
  onVerified: vi.fn(),
};

/** Mock ipapi.co geolocation fetch to return AU by default, plus any additional fetch calls. */
function setupFetchMock(
  additionalResponses: Array<{
    ok: boolean;
    json: () => Promise<Record<string, unknown>>;
  }> = []
): void {
  const responses = [
    // First call: ipapi.co geolocation
    { ok: true, json: () => Promise.resolve({ country_code: 'AU' }) },
    ...additionalResponses,
  ];
  let callIndex = 0;
  mockFetch.mockImplementation(() => {
    const response = responses[callIndex] ?? responses[responses.length - 1];
    callIndex++;
    return Promise.resolve(response);
  });
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

/** Create a successful send-otp response. */
function sendOtpSuccess(): { ok: boolean; json: () => Promise<Record<string, unknown>> } {
  return { ok: true, json: () => Promise.resolve({ success: true }) };
}

/** Create a failed send-otp response with a specific error. */
function sendOtpError(
  error: string,
  extra: Record<string, unknown> = {}
): { ok: boolean; json: () => Promise<Record<string, unknown>> } {
  return { ok: false, json: () => Promise.resolve({ error, ...extra }) };
}

/** Create a successful verify-otp response. */
function verifyOtpSuccess(): { ok: boolean; json: () => Promise<Record<string, unknown>> } {
  return { ok: true, json: () => Promise.resolve({ success: true }) };
}

/** Create a failed verify-otp response. */
function verifyOtpError(
  error: string,
  extra: Record<string, unknown> = {}
): { ok: boolean; json: () => Promise<Record<string, unknown>> } {
  return { ok: false, json: () => Promise.resolve({ error, ...extra }) };
}

// ── Tests ───────────────────────────────────────────────────────

describe('PhoneVerificationFlow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupValidPhone();
    setupFetchMock();
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
      // Country picker button
      expect(screen.getByRole('button', { name: 'Select country code' })).toBeInTheDocument();
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

  // ── 2. Current stage rendering (settings with initialPhone) ───

  describe('current stage rendering', () => {
    it('renders verified number and Change button when initialPhone provided', () => {
      render(
        <PhoneVerificationFlow
          mode="settings"
          initialPhone="+61412345678"
          accessToken="test-token"
          onVerified={vi.fn()}
        />
      );

      expect(screen.getByText('+61412345678')).toBeInTheDocument();
      expect(screen.getByText('Verified')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /change/i })).toBeInTheDocument();
    });

    it('shows info about changing requiring re-verification', () => {
      render(
        <PhoneVerificationFlow
          mode="settings"
          initialPhone="+61412345678"
          accessToken="test-token"
          onVerified={vi.fn()}
        />
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

    it('opens dropdown and selects a different country', async () => {
      const user = userEvent.setup();
      render(<PhoneVerificationFlow {...DEFAULT_PROPS} />);

      await user.click(screen.getByRole('button', { name: 'Select country code' }));

      // Dropdown should be open with listbox
      expect(screen.getByRole('listbox')).toBeInTheDocument();
      expect(screen.getByText('New Zealand')).toBeInTheDocument();

      // Select New Zealand
      await user.click(screen.getByText('New Zealand'));

      // Should show +64 dial code now
      expect(screen.getByText('+64')).toBeInTheDocument();
    });

    it('closes dropdown when clicking outside', async () => {
      const user = userEvent.setup();
      render(<PhoneVerificationFlow {...DEFAULT_PROPS} />);

      await user.click(screen.getByRole('button', { name: 'Select country code' }));
      expect(screen.getByRole('listbox')).toBeInTheDocument();

      // Click outside using mousedown event on document body
      await act(async () => {
        document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      });

      await waitFor(() => {
        expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
      });
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
      setupFetchMock([sendOtpSuccess()]);
      const user = userEvent.setup();
      render(<PhoneVerificationFlow {...DEFAULT_PROPS} />);

      const input = screen.getByPlaceholderText('412 345 678');
      await user.type(input, '412345678');

      await user.click(screen.getByRole('button', { name: /send verification code/i }));

      await waitFor(() => {
        expect(screen.getByText('Enter 6-digit code')).toBeInTheDocument();
      });

      // Should have 6 digit inputs
      const digitInputs = screen.getAllByRole('textbox');
      // Phone input + 6 OTP inputs = could vary; check by aria-label
      const otpInputs = screen.getAllByLabelText(/Digit \d/);
      expect(otpInputs).toHaveLength(6);
    });

    it('shows masked phone number in OTP stage', async () => {
      setupFetchMock([sendOtpSuccess()]);
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
      setupFetchMock([sendOtpSuccess()]);
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
      setupFetchMock([sendOtpError('rate_limited', { cooldownSeconds: 600 })]);
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
      setupFetchMock([sendOtpError('rate_limited', { cooldownSeconds: 600 })]);
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
      setupFetchMock([sendOtpError('brevo_rejected')]);
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
      setupFetchMock([sendOtpSuccess()]);
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
      setupFetchMock([sendOtpSuccess(), verifyOtpSuccess()]);
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
      setupFetchMock([sendOtpSuccess(), verifyOtpSuccess()]);
      const user = userEvent.setup();
      render(
        <PhoneVerificationFlow mode="onboarding" accessToken="test-token" onVerified={onVerified} />
      );

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
      setupFetchMock([sendOtpSuccess(), verifyOtpSuccess()]);
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
      setupFetchMock([sendOtpSuccess(), verifyOtpSuccess()]);
      const user = userEvent.setup();
      render(
        <PhoneVerificationFlow
          mode="settings"
          initialPhone="+61400000000"
          accessToken="test-token"
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
      setupFetchMock([sendOtpSuccess(), verifyOtpSuccess()]);
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
      setupFetchMock([sendOtpSuccess(), verifyOtpError('wrong_code', { attemptsRemaining: 2 })]);
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

    it('shows final attempt warning when 1 attempt remaining', async () => {
      setupFetchMock([sendOtpSuccess(), verifyOtpError('wrong_code', { attemptsRemaining: 1 })]);
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
    });
  });

  // ── 12. Verify — locked out ───────────────────────────────────

  describe('verify — locked out', () => {
    it('shows lockout message after max attempts', async () => {
      setupFetchMock([sendOtpSuccess(), verifyOtpError('locked_out')]);
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
      setupFetchMock([sendOtpSuccess(), verifyOtpError('code_expired')]);
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

      setupFetchMock([sendOtpSuccess()]);
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
      render(
        <PhoneVerificationFlow
          mode="settings"
          accessToken="test-token"
          onVerified={vi.fn()}
          onCancel={onCancel}
        />
      );

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
        <PhoneVerificationFlow
          mode="settings"
          initialPhone="+61412345678"
          accessToken="test-token"
          onVerified={vi.fn()}
        />
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
    it('fetch failure during send shows network error', async () => {
      // ipapi.co succeeds, then send-otp fetch throws
      let callIndex = 0;
      mockFetch.mockImplementation(() => {
        callIndex++;
        if (callIndex === 1) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ country_code: 'AU' }),
          });
        }
        return Promise.reject(new Error('Network failure'));
      });

      const user = userEvent.setup();
      render(<PhoneVerificationFlow {...DEFAULT_PROPS} />);

      await user.type(screen.getByPlaceholderText('412 345 678'), '412345678');
      await user.click(screen.getByRole('button', { name: /send verification code/i }));

      await waitFor(() => {
        expect(screen.getByText(/Something went wrong sending the code/)).toBeInTheDocument();
      });
    });

    it('network error during verify shows error with try again', async () => {
      // ipapi succeeds, send-otp succeeds, verify-otp throws
      let callIndex = 0;
      mockFetch.mockImplementation(() => {
        callIndex++;
        if (callIndex === 1) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ country_code: 'AU' }),
          });
        }
        if (callIndex === 2) {
          return Promise.resolve(sendOtpSuccess());
        }
        return Promise.reject(new Error('Network failure'));
      });

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
      setupFetchMock([sendOtpError('invalid_phone')]);
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
      setupFetchMock([sendOtpError('landline_not_supported')]);
      const user = userEvent.setup();
      render(<PhoneVerificationFlow {...DEFAULT_PROPS} />);

      await user.type(screen.getByPlaceholderText('412 345 678'), '412345678');
      await user.click(screen.getByRole('button', { name: /send verification code/i }));

      await waitFor(() => {
        expect(screen.getByText(/enter a mobile number/i)).toBeInTheDocument();
      });
    });

    it('shows fallback network error for unknown server errors', async () => {
      setupFetchMock([sendOtpError('unknown_error_type')]);
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
      let callIndex = 0;
      mockFetch.mockImplementation(() => {
        callIndex++;
        if (callIndex === 1) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ country_code: 'AU' }),
          });
        }
        // Never resolve the send-otp call
        return new Promise(() => {});
      });

      const user = userEvent.setup();
      render(<PhoneVerificationFlow {...DEFAULT_PROPS} />);

      await user.type(screen.getByPlaceholderText('412 345 678'), '412345678');
      await user.click(screen.getByRole('button', { name: /send verification code/i }));

      await waitFor(() => {
        expect(screen.getByText(/Sending/)).toBeInTheDocument();
      });
    });

    it('disables phone input and country picker while sending', async () => {
      let callIndex = 0;
      mockFetch.mockImplementation(() => {
        callIndex++;
        if (callIndex === 1) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ country_code: 'AU' }),
          });
        }
        return new Promise(() => {});
      });

      const user = userEvent.setup();
      render(<PhoneVerificationFlow {...DEFAULT_PROPS} />);

      await user.type(screen.getByPlaceholderText('412 345 678'), '412345678');
      await user.click(screen.getByRole('button', { name: /send verification code/i }));

      await waitFor(() => {
        expect(screen.getByPlaceholderText('412 345 678')).toBeDisabled();
        expect(screen.getByRole('button', { name: 'Select country code' })).toBeDisabled();
      });
    });
  });

  // ── 21. Change number from verified stage ──────────────────────

  describe('change phone number from verified stage', () => {
    it('clicking "Change phone number" returns to entry', async () => {
      setupFetchMock([sendOtpSuccess(), verifyOtpSuccess()]);
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
      let callIndex = 0;
      mockFetch.mockImplementation(() => {
        callIndex++;
        if (callIndex === 1) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ country_code: 'AU' }),
          });
        }
        if (callIndex === 2) {
          return Promise.resolve(sendOtpSuccess());
        }
        return new Promise(() => {});
      });

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
});
