'use client';

import {
  useState,
  useEffect,
  useRef,
  useCallback,
  type ChangeEvent,
  type KeyboardEvent,
  type ClipboardEvent,
} from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { isValidPhoneNumber, parsePhoneNumber } from 'libphonenumber-js/min';
import {
  Check,
  Send,
  ChevronDown,
  AlertTriangle,
  Lock,
  Clock,
  Info,
  Wifi,
  Loader2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { track, PHONE_EVENTS } from '@/lib/analytics';

// ── Types ─────────────────────────────────────────────────────────

type Stage = 'entry' | 'sending' | 'otp' | 'verifying' | 'verified' | 'current';

type ErrorState =
  | 'invalid_phone'
  | 'landline_not_supported'
  | 'brevo_rejected'
  | 'wrong_code'
  | 'final_attempt'
  | 'locked_out'
  | 'code_expired'
  | 'rate_limited'
  | 'network_error';

interface Country {
  code: string;
  flag: string;
  dial: string;
  name: string;
}

interface PhoneVerificationFlowProps {
  /** 'onboarding' — no cancel button, occupies full step; 'settings' — shows cancel */
  mode: 'onboarding' | 'settings';
  /** Settings mode: pre-fill with already-verified number to show 'current' stage initially */
  initialPhone?: string;
  /** WorkOS access token for API auth header */
  accessToken: string;
  /** Called when phone is successfully verified — passes E.164 string */
  onVerified: (e164: string) => void;
  /** Settings mode only — called when user clicks Cancel */
  onCancel?: () => void;
}

// ── Constants ─────────────────────────────────────────────────────

const COUNTRIES: Country[] = [
  { code: 'AU', flag: '\u{1F1E6}\u{1F1FA}', dial: '+61', name: 'Australia' },
  { code: 'NZ', flag: '\u{1F1F3}\u{1F1FF}', dial: '+64', name: 'New Zealand' },
  { code: 'US', flag: '\u{1F1FA}\u{1F1F8}', dial: '+1', name: 'United States' },
  { code: 'GB', flag: '\u{1F1EC}\u{1F1E7}', dial: '+44', name: 'United Kingdom' },
  { code: 'CA', flag: '\u{1F1E8}\u{1F1E6}', dial: '+1', name: 'Canada' },
  { code: 'SG', flag: '\u{1F1F8}\u{1F1EC}', dial: '+65', name: 'Singapore' },
  { code: 'IN', flag: '\u{1F1EE}\u{1F1F3}', dial: '+91', name: 'India' },
];

const DEFAULT_COUNTRY = COUNTRIES[0]!;
const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? '';
const RESEND_COOLDOWN_SECONDS = 30;

// ── Error messages ────────────────────────────────────────────────

const ERROR_MESSAGES: Record<ErrorState, string> = {
  invalid_phone: 'Enter a valid phone number including country code',
  landline_not_supported: 'That looks like a landline \u2014 enter a mobile number',
  brevo_rejected: "We couldn't send a code to this number. Check it's correct and try again.",
  wrong_code: 'Incorrect code',
  final_attempt: 'Incorrect code \u2014 one attempt left before lockout',
  locked_out:
    'Too many incorrect attempts. Request a new code to continue \u2014 the previous code is now invalid.',
  code_expired: 'Your code has expired. Request a new one to continue.',
  rate_limited: 'Too many requests for this number. Please wait before trying again.',
  network_error: 'Something went wrong sending the code. Check your connection and try again.',
};

// ── Sub-components ────────────────────────────────────────────────

function CountryPicker({
  selected,
  onChange,
  disabled,
}: Readonly<{
  selected: Country;
  onChange: (c: Country) => void;
  disabled: boolean;
}>): React.JSX.Element {
  return (
    <div className="relative">
      <div
        className={cn(
          'border-input bg-muted flex h-11 items-center gap-1.5 rounded-[10px] border px-3 whitespace-nowrap',
          disabled ? 'cursor-default opacity-50' : 'cursor-pointer'
        )}
      >
        <span className="text-lg">{selected.flag}</span>
        <span className="text-muted-foreground text-[13px]">{selected.dial}</span>
        <ChevronDown className="text-muted-foreground h-3 w-3" />
        <select
          disabled={disabled}
          value={selected.code}
          onChange={(e) => {
            const match = COUNTRIES.find((c) => c.code === e.target.value);
            if (match) onChange(match);
          }}
          aria-label="Select country code"
          className="absolute inset-0 cursor-pointer opacity-0"
        >
          {COUNTRIES.map((co) => (
            <option key={co.code} value={co.code}>
              {co.flag} {co.name} ({co.dial})
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

function OtpBoxes({
  onComplete,
  disabled,
  shakeKey,
}: Readonly<{
  onComplete: (code: string) => void;
  disabled: boolean;
  shakeKey: number;
}>): React.JSX.Element {
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);
  const [values, setValues] = useState<string[]>(['', '', '', '', '', '']);
  const [shaking, setShaking] = useState(false);

  // Shake + clear on shakeKey change (non-zero)
  useEffect(() => {
    if (shakeKey > 0) {
      setShaking(true);
      const timer = setTimeout(() => {
        setValues(['', '', '', '', '', '']);
        setShaking(false);
        inputRefs.current[0]?.focus();
      }, 400);
      return () => clearTimeout(timer);
    }
  }, [shakeKey]);

  function handleInput(idx: number, raw: string): void {
    const digit = raw.replaceAll(/\D/g, '').slice(-1);
    const next = [...values];
    next[idx] = digit;
    setValues(next);
    if (digit && idx < 5) {
      inputRefs.current[idx + 1]?.focus();
    }
    if (next.every(Boolean)) {
      onComplete(next.join(''));
    }
  }

  function handleKeyDown(idx: number, e: KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'Backspace' && !values[idx] && idx > 0) {
      inputRefs.current[idx - 1]?.focus();
    }
  }

  function handlePaste(e: ClipboardEvent<HTMLInputElement>): void {
    e.preventDefault();
    const text = e.clipboardData.getData('text').replaceAll(/\D/g, '');
    const next = ['', '', '', '', '', ''];
    for (let i = 0; i < 6 && i < text.length; i++) {
      next[i] = text[i]!;
    }
    setValues(next);
    inputRefs.current[Math.min(text.length, 5)]?.focus();
    if (next.every(Boolean)) {
      onComplete(next.join(''));
    }
  }

  const isError = shaking;

  return (
    <div className={cn('flex justify-center gap-2.5', shaking && 'animate-shake')}>
      {values.map((v, i) => (
        <input
          key={`digit-${String(i)}`}
          ref={(el) => {
            inputRefs.current[i] = el;
          }}
          value={v}
          maxLength={1}
          inputMode="numeric"
          pattern="\d*"
          disabled={disabled}
          onChange={(e: ChangeEvent<HTMLInputElement>) => handleInput(i, e.target.value)}
          onKeyDown={(e) => handleKeyDown(i, e)}
          onPaste={handlePaste}
          className={cn(
            'h-[58px] w-[52px] rounded-xl border text-center text-[22px] font-bold transition-[border-color,background] duration-150 outline-none',
            (() => {
              if (isError) return 'border-destructive/40 bg-destructive/5 text-destructive';
              if (v) return 'border-primary/30 bg-primary/5 text-foreground';
              return 'border-input bg-card text-foreground';
            })(),
            disabled && 'opacity-60'
          )}
          aria-label={`Digit ${i + 1}`}
        />
      ))}
    </div>
  );
}

function ResendRow({
  onResend,
  initialSeconds = RESEND_COOLDOWN_SECONDS,
}: Readonly<{
  onResend: () => void;
  initialSeconds?: number;
}>): React.JSX.Element {
  const [secs, setSecs] = useState(initialSeconds);

  useEffect(() => {
    const timer = setInterval(() => setSecs((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="mt-3 flex items-center justify-center gap-1.5">
      {secs > 0 ? (
        <span className="text-muted-foreground text-xs">Resend in {secs}s</span>
      ) : (
        <button
          type="button"
          onClick={onResend}
          className="text-primary text-xs font-semibold hover:underline"
        >
          Resend code
        </button>
      )}
    </div>
  );
}

function FieldMessage({
  type = 'error',
  children,
}: Readonly<{
  type?: 'error' | 'warning' | 'info';
  children: React.ReactNode;
}>): React.JSX.Element {
  const config = {
    error: { color: 'text-destructive', Icon: Info },
    warning: { color: 'text-warning', Icon: AlertTriangle },
    info: { color: 'text-muted-foreground', Icon: Info },
  };
  const { color, Icon } = config[type];
  return (
    <div className="mt-1.5 flex items-start gap-1.5" aria-live="polite" aria-atomic="true">
      <Icon className={cn('mt-0.5 h-[13px] w-[13px] shrink-0', color)} />
      <span className={cn('text-xs leading-[1.45]', color)}>{children}</span>
    </div>
  );
}

function StatusBanner({
  type = 'error',
  icon: Icon,
  children,
}: Readonly<{
  type?: 'error' | 'warning' | 'info';
  icon: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
}>): React.JSX.Element {
  const styles = {
    error: 'bg-destructive/5 border-destructive/20 text-destructive',
    warning: 'bg-warning/10 border-warning/20 text-warning',
    info: 'bg-muted border-border text-muted-foreground',
  };

  return (
    <div
      role="alert"
      className={cn('flex items-start gap-2 rounded-[10px] border p-3', styles[type])}
    >
      <Icon className="mt-0.5 h-[15px] w-[15px] shrink-0" />
      <p className="text-[13px] leading-relaxed">{children}</p>
    </div>
  );
}

// ── API response handlers (extracted to reduce cognitive complexity) ──

interface SendErrorHandlers {
  setStage: (s: Stage) => void;
  setRateLimited: (v: boolean) => void;
  setCooldownSeconds: (n: number) => void;
  setPhoneError: (e: string | null) => void;
}

/** Map a send-otp error response to the correct UI state. */
function handleSendError(data: Record<string, unknown>, handlers: SendErrorHandlers): void {
  handlers.setStage('entry');

  const errorMap: Record<string, () => void> = {
    rate_limited: () => {
      handlers.setRateLimited(true);
      handlers.setCooldownSeconds((data.cooldownSeconds as number) ?? 600);
    },
    invalid_phone: () => handlers.setPhoneError(ERROR_MESSAGES.invalid_phone),
    landline_not_supported: () => handlers.setPhoneError(ERROR_MESSAGES.landline_not_supported),
    brevo_rejected: () => handlers.setPhoneError(ERROR_MESSAGES.brevo_rejected),
  };

  const handler = errorMap[data.error as string];
  if (handler) {
    handler();
  } else {
    handlers.setPhoneError(ERROR_MESSAGES.network_error);
  }
}

interface VerifyErrorHandlers {
  setStage: (s: Stage) => void;
  setAttemptsRemaining: (n: number) => void;
  setOtpError: (e: ErrorState | null) => void;
  setShakeKey: (fn: (n: number) => number) => void;
}

/** Map a verify-otp error response to the correct UI state. */
function handleVerifyError(data: Record<string, unknown>, handlers: VerifyErrorHandlers): void {
  const errorType = data.error as string;

  if (errorType === 'locked_out') {
    handlers.setAttemptsRemaining(0);
    handlers.setOtpError('locked_out');
  } else if (errorType === 'code_expired') {
    handlers.setOtpError('code_expired');
  } else {
    const remaining = (data.attemptsRemaining as number) ?? 0;
    handlers.setAttemptsRemaining(remaining);
    handlers.setOtpError(remaining === 1 ? 'final_attempt' : 'wrong_code');
    handlers.setShakeKey((n) => n + 1);
  }

  handlers.setStage('otp');
}

// ── Custom Hooks (extracted to reduce component cognitive complexity) ──

/** Detect user's country via IP on mount. */
function useCountryDetection(setSelectedCountry: (c: Country) => void): void {
  useEffect(() => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    fetch('https://ipapi.co/json/', { signal: controller.signal })
      .then((res) => res.json())
      .then((data: { country_code?: string }) => {
        if (data.country_code) {
          const match = COUNTRIES.find((c) => c.code === data.country_code);
          if (match) setSelectedCountry(match);
        }
      })
      .catch(() => {
        // Silently fallback to AU default
      })
      .finally(() => clearTimeout(timeout));
    return () => {
      clearTimeout(timeout);
      controller.abort();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
}

/** Validate phone input with debounce and on-demand. */
function usePhoneValidation(
  localNumber: string,
  selectedCountry: Country
): {
  phoneError: string | null;
  setPhoneError: (e: string | null) => void;
  validatePhone: () => boolean;
  getMasked: () => string;
} {
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);

    if (!localNumber.trim()) {
      setPhoneError(null);
      return;
    }

    debounceRef.current = setTimeout(() => {
      const fullNumber = selectedCountry.dial + localNumber.replaceAll(/\s/g, '');
      if (!isValidPhoneNumber(fullNumber)) {
        setPhoneError(ERROR_MESSAGES.invalid_phone);
      } else if (parsePhoneNumber(fullNumber).getType() === 'FIXED_LINE') {
        setPhoneError(ERROR_MESSAGES.landline_not_supported);
      } else {
        setPhoneError(null);
      }
    }, 300);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [localNumber, selectedCountry]);

  const getMasked = useCallback((): string => {
    const n = localNumber.replaceAll(/\s/g, '');
    return `${selectedCountry.dial} ${'*'.repeat(Math.max(0, n.length - 4))}${n.slice(-4)}`;
  }, [localNumber, selectedCountry]);

  const validatePhone = useCallback((): boolean => {
    const n = localNumber.trim().replaceAll(/\s/g, '');
    if (n.length < 4) {
      setPhoneError(ERROR_MESSAGES.invalid_phone);
      return false;
    }
    const full = selectedCountry.dial + n;
    if (!isValidPhoneNumber(full)) {
      setPhoneError(ERROR_MESSAGES.invalid_phone);
      return false;
    }
    if (parsePhoneNumber(full).getType() === 'FIXED_LINE') {
      setPhoneError(ERROR_MESSAGES.landline_not_supported);
      return false;
    }
    setPhoneError(null);
    return true;
  }, [localNumber, selectedCountry]);

  return { phoneError, setPhoneError, validatePhone, getMasked };
}

/** Handle OTP send/verify API calls and state transitions. */
function usePhoneOtp(opts: {
  accessToken: string;
  selectedCountry: Country;
  localNumber: string;
  e164Phone: string;
  mode: 'onboarding' | 'settings';
  validatePhone: () => boolean;
  getMasked: () => string;
  setPhoneError: (e: string | null) => void;
  onVerified: (e164: string) => void;
}): {
  stage: Stage;
  setStage: (s: Stage) => void;
  e164Phone: string;
  otpError: ErrorState | null;
  attemptsRemaining: number;
  shakeKey: number;
  resendKey: number;
  maskedPhone: string;
  cooldownSeconds: number;
  rateLimited: boolean;
  handleSend: () => Promise<void>;
  handleOtpComplete: (code: string) => Promise<void>;
  handleResend: () => void;
  handleChangeNumber: () => void;
} {
  const {
    accessToken,
    selectedCountry,
    localNumber,
    e164Phone: initialE164,
    mode,
    validatePhone,
    getMasked,
    setPhoneError,
    onVerified,
  } = opts;

  const [stage, setStage] = useState<Stage>(
    mode === 'settings' && initialE164 ? 'current' : 'entry'
  );
  const [e164Phone, setE164Phone] = useState(initialE164);
  const [otpError, setOtpError] = useState<ErrorState | null>(null);
  const [attemptsRemaining, setAttemptsRemaining] = useState(3);
  const [shakeKey, setShakeKey] = useState(0);
  const [resendKey, setResendKey] = useState(0);
  const [maskedPhone, setMaskedPhone] = useState('');
  const [cooldownSeconds, setCooldownSeconds] = useState(0);
  const [rateLimited, setRateLimited] = useState(false);

  const handleSend = useCallback(async (): Promise<void> => {
    if (!validatePhone()) return;

    const phone = selectedCountry.dial + localNumber.replaceAll(/\s/g, '');
    setE164Phone(phone);
    setStage('sending');
    setRateLimited(false);

    try {
      const res = await fetch(`${API_BASE}/phone/send-otp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ phone }),
      });

      const data = (await res.json()) as Record<string, unknown>;

      if (!res.ok) {
        handleSendError(data, { setStage, setRateLimited, setCooldownSeconds, setPhoneError });
        return;
      }

      setMaskedPhone(getMasked());
      setOtpError(null);
      setAttemptsRemaining(3);
      setStage('otp');
      setResendKey((k) => k + 1);
    } catch {
      setStage('entry');
      setPhoneError(ERROR_MESSAGES.network_error);
    }
  }, [validatePhone, selectedCountry, localNumber, accessToken, getMasked, setPhoneError]);

  const handleOtpComplete = useCallback(
    async (code: string): Promise<void> => {
      setStage('verifying');
      setOtpError(null);

      try {
        const res = await fetch(`${API_BASE}/phone/verify-otp`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({ phone: e164Phone, code }),
        });

        const data = (await res.json()) as Record<string, unknown>;

        if (!res.ok) {
          handleVerifyError(data, { setStage, setAttemptsRemaining, setOtpError, setShakeKey });
          return;
        }

        setStage('verified');

        track(PHONE_EVENTS.PHONE_VERIFIED, {
          phone_masked: '****' + e164Phone.slice(-4),
          country_code: selectedCountry.code,
          source: mode,
        });

        onVerified(e164Phone);
      } catch {
        setStage('otp');
        setOtpError('network_error');
      }
    },
    [accessToken, e164Phone, selectedCountry, mode, onVerified]
  );

  const handleResend = useCallback((): void => {
    setOtpError(null);
    setAttemptsRemaining(3);
    setResendKey((k) => k + 1);
    handleSend();
  }, [handleSend]);

  const handleChangeNumber = useCallback((): void => {
    setStage('entry');
    setOtpError(null);
    setRateLimited(false);
    setPhoneError(null);
  }, [setPhoneError]);

  return {
    stage,
    setStage,
    e164Phone,
    otpError,
    attemptsRemaining,
    shakeKey,
    resendKey,
    maskedPhone,
    cooldownSeconds,
    rateLimited,
    handleSend,
    handleOtpComplete,
    handleResend,
    handleChangeNumber,
  };
}

// ── OTP Stage Sub-components (extracted to reduce main component complexity) ──

interface OtpActiveAreaProps {
  otpError: ErrorState | null;
  attemptsRemaining: number;
  stage: Stage;
  shakeKey: number;
  resendKey: number;
  maskedPhone: string;
  onComplete: (code: string) => Promise<void>;
  onResend: () => void;
  onChangeNumber: () => void;
  onRetrySend: () => Promise<void>;
}

function OtpActiveArea({
  otpError,
  attemptsRemaining,
  stage,
  shakeKey,
  resendKey,
  maskedPhone,
  onComplete,
  onResend,
  onChangeNumber,
  onRetrySend,
}: Readonly<OtpActiveAreaProps>): React.JSX.Element {
  return (
    <>
      {/* Masked phone + change number link */}
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground text-[13px]">Code sent to</span>
          <span className="bg-primary/5 border-primary/20 text-primary rounded-full border px-2.5 py-0.5 text-[13px] font-semibold">
            {maskedPhone}
          </span>
        </div>
        {stage === 'otp' && attemptsRemaining > 0 && (
          <button
            type="button"
            onClick={onChangeNumber}
            className="border-border text-muted-foreground hover:bg-muted rounded-md border px-2.5 py-0.5 text-xs font-semibold"
          >
            Change number
          </button>
        )}
      </div>

      {/* Attempts badge */}
      {otpError &&
        (otpError === 'wrong_code' || otpError === 'final_attempt') &&
        attemptsRemaining > 0 && (
          <div className="mb-2.5 flex justify-center">
            <span
              className={cn(
                'inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold',
                attemptsRemaining === 1
                  ? 'bg-warning/10 border-warning/20 text-warning'
                  : 'bg-destructive/5 border-destructive/20 text-destructive'
              )}
            >
              <Info className="h-[11px] w-[11px]" />
              {attemptsRemaining === 1 ? 'Last attempt' : `${attemptsRemaining} attempts left`}
            </span>
          </div>
        )}

      <p className="text-muted-foreground mb-3.5 block text-center text-xs font-semibold">
        Enter 6-digit code
      </p>

      {/* Error state 5: locked out */}
      {otpError === 'locked_out' && (
        <>
          <OtpBoxes onComplete={() => {}} disabled shakeKey={0} />
          <div className="mt-3.5">
            <StatusBanner type="error" icon={Lock}>
              {ERROR_MESSAGES.locked_out}
            </StatusBanner>
            <Button className="mt-3.5 w-full gap-2" size="lg" onClick={onResend}>
              <Send className="h-3.5 w-3.5" /> Send a new code
            </Button>
          </div>
        </>
      )}

      {/* Error state 6: code expired */}
      {otpError === 'code_expired' && (
        <>
          <OtpBoxes onComplete={() => {}} disabled shakeKey={0} />
          <div className="mt-3.5">
            <StatusBanner type="error" icon={Clock}>
              {ERROR_MESSAGES.code_expired}
            </StatusBanner>
            <Button className="mt-3.5 w-full gap-2" size="lg" onClick={onResend}>
              <Send className="h-3.5 w-3.5" /> Send a new code
            </Button>
          </div>
        </>
      )}

      {/* Error state 8: network error */}
      {otpError === 'network_error' && (
        <>
          <OtpBoxes onComplete={() => {}} disabled shakeKey={0} />
          <div className="mt-3.5">
            <StatusBanner type="info" icon={Wifi}>
              {ERROR_MESSAGES.network_error}
            </StatusBanner>
            <Button
              variant="outline"
              className="mt-3.5 w-full gap-2"
              size="lg"
              onClick={onRetrySend}
            >
              Try again
            </Button>
          </div>
        </>
      )}

      {/* Default: active OTP input */}
      {otpError !== 'locked_out' && otpError !== 'code_expired' && otpError !== 'network_error' && (
        <>
          <OtpBoxes onComplete={onComplete} disabled={stage === 'verifying'} shakeKey={shakeKey} />

          {otpError === 'wrong_code' && attemptsRemaining > 1 && (
            <FieldMessage type="error">
              Incorrect code — {attemptsRemaining} attempts remaining
            </FieldMessage>
          )}

          {otpError === 'final_attempt' && attemptsRemaining === 1 && (
            <div className="mt-2">
              <FieldMessage type="warning">
                One more wrong attempt will lock you out. Request a new code if unsure.
              </FieldMessage>
            </div>
          )}

          {stage === 'otp' && <ResendRow key={resendKey} onResend={onResend} />}

          {stage === 'verifying' && (
            <div className="flex items-center justify-center gap-2.5 py-3.5">
              <Loader2 className="text-primary h-4 w-4 animate-spin" />
              <span className="text-muted-foreground text-[13px]">Verifying&hellip;</span>
            </div>
          )}
        </>
      )}
    </>
  );
}

interface VerifiedViewProps {
  mode: 'onboarding' | 'settings';
  initialPhone?: string;
  e164Phone: string;
  onChangeNumber: () => void;
}

function VerifiedView({
  mode,
  initialPhone,
  e164Phone,
  onChangeNumber,
}: Readonly<VerifiedViewProps>): React.JSX.Element {
  const isNumberChange = mode === 'settings' && !!initialPhone;
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25 }}
      className="pt-3 pb-1 text-center"
    >
      <motion.div
        initial={{ scale: 0 }}
        animate={{ scale: [0, 1.25, 1] }}
        transition={{ duration: 0.4 }}
        className="bg-success/10 border-success/20 mx-auto mb-3 flex h-[52px] w-[52px] items-center justify-center rounded-full border"
      >
        <Check className="text-success h-6 w-6" />
      </motion.div>
      <p className="text-foreground mb-1.5 text-base font-bold">
        {isNumberChange ? 'Number updated' : 'Phone verified'}
      </p>
      <p className="text-muted-foreground mb-3 text-[13px] leading-relaxed">
        {isNumberChange
          ? 'Your phone number has been changed and verified.'
          : 'You\u2019ll receive booking alerts and reminders at this number.'}
      </p>
      <span className="bg-primary/5 border-primary/20 text-primary inline-block rounded-full border px-3.5 py-1 text-[14px] font-semibold">
        {e164Phone}
      </span>
      <div className="mt-3">
        <button
          type="button"
          onClick={onChangeNumber}
          className="text-muted-foreground hover:text-foreground text-xs underline underline-offset-2 transition-colors"
        >
          Change phone number
        </button>
      </div>
    </motion.div>
  );
}

// ── Main Component ────────────────────────────────────────────────

export function PhoneVerificationFlow({
  mode,
  initialPhone,
  accessToken,
  onVerified,
  onCancel,
}: Readonly<PhoneVerificationFlowProps>): React.JSX.Element {
  const [selectedCountry, setSelectedCountry] = useState<Country>(DEFAULT_COUNTRY);
  const [localNumber, setLocalNumber] = useState('');
  const phoneInputRef = useRef<HTMLInputElement>(null);

  useCountryDetection(setSelectedCountry);

  const { phoneError, setPhoneError, validatePhone, getMasked } = usePhoneValidation(
    localNumber,
    selectedCountry
  );

  const otp = usePhoneOtp({
    accessToken,
    selectedCountry,
    localNumber,
    e164Phone: initialPhone ?? '',
    mode,
    validatePhone,
    getMasked,
    setPhoneError,
    onVerified,
  });

  // Autofocus phone input when entering the entry stage
  useEffect(() => {
    if (otp.stage === 'entry') {
      phoneInputRef.current?.focus();
    }
  }, [otp.stage]);

  const handleChangeNumber = useCallback((): void => {
    otp.handleChangeNumber();
    setLocalNumber('');
  }, [otp]);

  const canSend =
    localNumber.trim().replaceAll(/\s/g, '').length >= 4 && !phoneError && !otp.rateLimited;

  // ── Settings: current number view ──────────────────────────────

  if (otp.stage === 'current') {
    return (
      <div>
        <div className="bg-muted border-border flex items-center justify-between rounded-[10px] border p-3.5">
          <div>
            <p className="text-muted-foreground mb-0.5 text-[11px] font-bold tracking-wider uppercase">
              Verified number
            </p>
            <div className="flex items-center gap-2">
              <p className="text-foreground text-[15px] font-semibold">{initialPhone}</p>
              <span className="text-success bg-success/10 border-success/20 rounded-full border px-2 py-0.5 text-[11px] font-semibold">
                Verified
              </span>
            </div>
          </div>
          <Button variant="outline" size="sm" onClick={() => otp.setStage('entry')}>
            Change
          </Button>
        </div>
        <p className="text-muted-foreground mt-1.5 text-[11px]">
          Changing requires re-verification. SMS will use the new number once confirmed.
        </p>
      </div>
    );
  }

  // ── Main flow ──────────────────────────────────────────────────

  return (
    <div>
      {/* Settings change warning */}
      {mode === 'settings' &&
        initialPhone &&
        (otp.stage === 'entry' || otp.stage === 'sending') && (
          <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.2 }}
            className="mb-5"
          >
            <StatusBanner type="warning" icon={AlertTriangle}>
              Changing your number requires a new verification code. SMS will switch to the new
              number once verified.
            </StatusBanner>
          </motion.div>
        )}

      {/* Phone entry */}
      <div>
        <label
          htmlFor="phone-number-input"
          className="text-muted-foreground mb-1.5 block text-xs font-semibold"
        >
          Phone number
        </label>
        <div className="flex gap-2.5">
          <CountryPicker
            selected={selectedCountry}
            onChange={setSelectedCountry}
            disabled={otp.stage !== 'entry'}
          />
          <input
            id="phone-number-input"
            ref={phoneInputRef}
            type="tel"
            value={localNumber}
            onChange={(e) => {
              setLocalNumber(e.target.value);
              setPhoneError(null);
            }}
            onBlur={otp.stage === 'entry' ? () => validatePhone() : undefined}
            placeholder="412 345 678"
            disabled={otp.stage !== 'entry'}
            className={cn(
              'h-11 flex-1 rounded-[10px] border px-3.5 text-[15px] transition-colors outline-none',
              (() => {
                if (phoneError) return 'border-destructive/40 bg-destructive/5';
                if (otp.stage === 'entry')
                  return 'border-input bg-card text-foreground focus:border-primary/40';
                return 'border-input bg-muted text-muted-foreground';
              })()
            )}
          />
        </div>

        {/* Error state 1: invalid phone / landline */}
        {phoneError && <FieldMessage type="error">{phoneError}</FieldMessage>}

        {otp.stage === 'entry' && !phoneError && !otp.rateLimited && (
          <p className="text-muted-foreground mt-1.5 text-[11px]">
            Include country code if pasting, e.g. {selectedCountry.dial}412345678
          </p>
        )}

        {/* Error state 7: rate limited */}
        {otp.rateLimited && (
          <div className="mt-3">
            <StatusBanner type="error" icon={Lock}>
              Too many requests for this number. Please wait{' '}
              <strong>{Math.ceil(otp.cooldownSeconds / 60)} minutes</strong> before trying again.
            </StatusBanner>
          </div>
        )}

        {/* Send / sending button */}
        {(otp.stage === 'entry' || otp.stage === 'sending') && (
          <div className="mt-5 flex gap-2.5">
            {!otp.rateLimited && (
              <Button
                disabled={!canSend || otp.stage === 'sending'}
                onClick={otp.handleSend}
                className="flex-1 gap-2"
                size="lg"
              >
                {otp.stage === 'sending' ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Send className="h-3.5 w-3.5" />
                )}
                {otp.stage === 'sending' ? 'Sending\u2026' : 'Send verification code'}
              </Button>
            )}
            {mode === 'settings' && onCancel && (
              <Button variant="outline" size="lg" onClick={onCancel}>
                Cancel
              </Button>
            )}
          </div>
        )}
      </div>

      {/* OTP section */}
      <AnimatePresence mode="wait">
        {(otp.stage === 'otp' || otp.stage === 'verifying' || otp.stage === 'verified') && (
          <motion.div
            key="otp-section"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.25, delay: 0.05 }}
            className="mt-5"
          >
            <div className="bg-border mb-5 h-px" />

            {otp.stage !== 'verified' && (
              <OtpActiveArea
                otpError={otp.otpError}
                attemptsRemaining={otp.attemptsRemaining}
                stage={otp.stage}
                shakeKey={otp.shakeKey}
                resendKey={otp.resendKey}
                maskedPhone={otp.maskedPhone}
                onComplete={otp.handleOtpComplete}
                onResend={otp.handleResend}
                onChangeNumber={handleChangeNumber}
                onRetrySend={otp.handleSend}
              />
            )}

            {otp.stage === 'verified' && (
              <VerifiedView
                mode={mode}
                initialPhone={initialPhone}
                e164Phone={otp.e164Phone}
                onChangeNumber={handleChangeNumber}
              />
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
