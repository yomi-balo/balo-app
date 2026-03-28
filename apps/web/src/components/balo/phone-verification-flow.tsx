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
}: {
  selected: Country;
  onChange: (c: Country) => void;
  disabled: boolean;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent): void {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen(!open)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Select country code"
        className={cn(
          'border-input bg-muted flex h-11 items-center gap-1.5 rounded-[10px] border px-3 whitespace-nowrap',
          disabled ? 'cursor-default opacity-50' : 'cursor-pointer'
        )}
      >
        <span className="text-lg">{selected.flag}</span>
        <span className="text-muted-foreground text-[13px]">{selected.dial}</span>
        <ChevronDown className="text-muted-foreground h-3 w-3" />
      </button>
      {open && (
        <div
          role="listbox"
          className="bg-card border-border animate-in fade-in-0 slide-in-from-top-1 absolute top-[calc(100%+6px)] left-0 z-50 min-w-[200px] overflow-hidden rounded-xl border shadow-lg duration-150"
        >
          {COUNTRIES.map((co) => (
            <button
              type="button"
              key={co.code}
              role="option"
              aria-selected={selected.code === co.code}
              onClick={() => {
                onChange(co);
                setOpen(false);
              }}
              className={cn(
                'flex w-full items-center gap-2.5 px-3.5 py-2.5 text-sm',
                selected.code === co.code ? 'bg-primary/5' : 'hover:bg-muted'
              )}
            >
              <span className="text-lg">{co.flag}</span>
              <span className="text-foreground flex-1 text-left">{co.name}</span>
              <span className="text-muted-foreground font-mono text-[11px]">{co.dial}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function OtpBoxes({
  onComplete,
  disabled,
  shakeKey,
}: {
  onComplete: (code: string) => void;
  disabled: boolean;
  shakeKey: number;
}): React.JSX.Element {
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
    const digit = raw.replace(/\D/g, '').slice(-1);
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
    const text = e.clipboardData.getData('text').replace(/\D/g, '');
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
          key={i}
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
            isError
              ? 'border-destructive/40 bg-destructive/5 text-destructive'
              : v
                ? 'border-primary/30 bg-primary/5 text-foreground'
                : 'border-input bg-card text-foreground',
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
}: {
  onResend: () => void;
  initialSeconds?: number;
}): React.JSX.Element {
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
}: {
  type?: 'error' | 'warning' | 'info';
  children: React.ReactNode;
}): React.JSX.Element {
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
}: {
  type?: 'error' | 'warning' | 'info';
  icon: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
}): React.JSX.Element {
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

// ── Main Component ────────────────────────────────────────────────

export function PhoneVerificationFlow({
  mode,
  initialPhone,
  accessToken,
  onVerified,
  onCancel,
}: PhoneVerificationFlowProps): React.JSX.Element {
  const [stage, setStage] = useState<Stage>(
    mode === 'settings' && initialPhone ? 'current' : 'entry'
  );
  const [selectedCountry, setSelectedCountry] = useState<Country>(DEFAULT_COUNTRY);
  const [localNumber, setLocalNumber] = useState('');
  const [e164Phone, setE164Phone] = useState('');
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [otpError, setOtpError] = useState<ErrorState | null>(null);
  const [attemptsRemaining, setAttemptsRemaining] = useState(3);
  const [shakeKey, setShakeKey] = useState(0);
  const [resendKey, setResendKey] = useState(0);
  const [maskedPhone, setMaskedPhone] = useState('');
  const [cooldownSeconds, setCooldownSeconds] = useState(0);
  const [rateLimited, setRateLimited] = useState(false);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const phoneInputRef = useRef<HTMLInputElement>(null);

  // Autofocus phone input when entering the entry stage
  useEffect(() => {
    if (stage === 'entry') {
      phoneInputRef.current?.focus();
    }
  }, [stage]);

  // IP detection for default country
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
  }, []);

  // Debounced phone validation
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);

    if (!localNumber.trim()) {
      setPhoneError(null);
      return;
    }

    debounceRef.current = setTimeout(() => {
      const fullNumber = selectedCountry.dial + localNumber.replace(/\s/g, '');
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
    const n = localNumber.replace(/\s/g, '');
    return `${selectedCountry.dial} ${'*'.repeat(Math.max(0, n.length - 4))}${n.slice(-4)}`;
  }, [localNumber, selectedCountry]);

  const validatePhone = useCallback((): boolean => {
    const n = localNumber.trim().replace(/\s/g, '');
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

  const handleSend = useCallback(async (): Promise<void> => {
    if (!validatePhone()) return;

    const phone = selectedCountry.dial + localNumber.replace(/\s/g, '');
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
        setStage('entry');

        if (data.error === 'rate_limited') {
          setRateLimited(true);
          setCooldownSeconds((data.cooldownSeconds as number) ?? 600);
          return;
        }

        if (data.error === 'invalid_phone' || data.error === 'landline_not_supported') {
          setPhoneError(ERROR_MESSAGES[data.error as ErrorState]);
          return;
        }

        if (data.error === 'brevo_rejected') {
          setPhoneError(ERROR_MESSAGES.brevo_rejected);
          return;
        }

        // Fallback for unknown errors
        setPhoneError(ERROR_MESSAGES.network_error);
        return;
      }

      // Success
      setMaskedPhone(getMasked());
      setOtpError(null);
      setAttemptsRemaining(3);
      setStage('otp');
      setResendKey((k) => k + 1);
    } catch {
      setStage('entry');
      setPhoneError(ERROR_MESSAGES.network_error);
    }
  }, [validatePhone, selectedCountry, localNumber, accessToken, getMasked]);

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
          const errorType = data.error as string;

          if (errorType === 'locked_out') {
            setAttemptsRemaining(0);
            setOtpError('locked_out');
            setStage('otp');
            return;
          }

          if (errorType === 'code_expired') {
            setOtpError('code_expired');
            setStage('otp');
            return;
          }

          const remaining = (data.attemptsRemaining as number) ?? 0;
          setAttemptsRemaining(remaining);

          if (remaining === 1) {
            setOtpError('final_attempt');
          } else {
            setOtpError('wrong_code');
          }
          setShakeKey((n) => n + 1);
          setStage('otp');
          return;
        }

        // Verified
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
    setLocalNumber('');
    setPhoneError(null);
    setOtpError(null);
    setRateLimited(false);
  }, []);

  const canSend = localNumber.trim().replace(/\s/g, '').length >= 4 && !phoneError && !rateLimited;

  // ── Settings: current number view ──────────────────────────────

  if (stage === 'current') {
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
          <Button variant="outline" size="sm" onClick={() => setStage('entry')}>
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
      {mode === 'settings' && initialPhone && (stage === 'entry' || stage === 'sending') && (
        <motion.div
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.2 }}
          className="mb-5"
        >
          <StatusBanner type="warning" icon={AlertTriangle}>
            Changing your number requires a new verification code. SMS will switch to the new number
            once verified.
          </StatusBanner>
        </motion.div>
      )}

      {/* Phone entry */}
      <div>
        <label className="text-muted-foreground mb-1.5 block text-xs font-semibold">
          Phone number
        </label>
        <div className="flex gap-2.5">
          <CountryPicker
            selected={selectedCountry}
            onChange={setSelectedCountry}
            disabled={stage !== 'entry'}
          />
          <input
            ref={phoneInputRef}
            type="tel"
            value={localNumber}
            onChange={(e) => {
              setLocalNumber(e.target.value);
              setPhoneError(null);
            }}
            onBlur={stage === 'entry' ? () => validatePhone() : undefined}
            placeholder="412 345 678"
            disabled={stage !== 'entry'}
            className={cn(
              'h-11 flex-1 rounded-[10px] border px-3.5 text-[15px] transition-colors outline-none',
              phoneError
                ? 'border-destructive/40 bg-destructive/5'
                : stage !== 'entry'
                  ? 'border-input bg-muted text-muted-foreground'
                  : 'border-input bg-card text-foreground focus:border-primary/40'
            )}
          />
        </div>

        {/* Error state 1: invalid phone / landline */}
        {phoneError && <FieldMessage type="error">{phoneError}</FieldMessage>}

        {stage === 'entry' && !phoneError && !rateLimited && (
          <p className="text-muted-foreground mt-1.5 text-[11px]">
            Include country code if pasting, e.g. {selectedCountry.dial}412345678
          </p>
        )}

        {/* Error state 7: rate limited */}
        {rateLimited && (
          <div className="mt-3">
            <StatusBanner type="error" icon={Lock}>
              Too many requests for this number. Please wait{' '}
              <strong>{Math.ceil(cooldownSeconds / 60)} minutes</strong> before trying again.
            </StatusBanner>
          </div>
        )}

        {/* Send / sending button */}
        {(stage === 'entry' || stage === 'sending') && (
          <div className="mt-5 flex gap-2.5">
            {!rateLimited && (
              <Button
                disabled={!canSend || stage === 'sending'}
                onClick={handleSend}
                className="flex-1 gap-2"
                size="lg"
              >
                {stage === 'sending' ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Send className="h-3.5 w-3.5" />
                )}
                {stage === 'sending' ? 'Sending\u2026' : 'Send verification code'}
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
        {(stage === 'otp' || stage === 'verifying' || stage === 'verified') && (
          <motion.div
            key="otp-section"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.25, delay: 0.05 }}
            className="mt-5"
          >
            <div className="bg-border mb-5 h-px" />

            {stage !== 'verified' && (
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
                      onClick={handleChangeNumber}
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
                        {attemptsRemaining === 1
                          ? 'Last attempt'
                          : `${attemptsRemaining} attempts left`}
                      </span>
                    </div>
                  )}

                <label className="text-muted-foreground mb-3.5 block text-center text-xs font-semibold">
                  Enter 6-digit code
                </label>

                {/* Error state 5: locked out */}
                {otpError === 'locked_out' ? (
                  <>
                    <OtpBoxes onComplete={() => {}} disabled shakeKey={0} />
                    <div className="mt-3.5">
                      <StatusBanner type="error" icon={Lock}>
                        {ERROR_MESSAGES.locked_out}
                      </StatusBanner>
                      <Button className="mt-3.5 w-full gap-2" size="lg" onClick={handleResend}>
                        <Send className="h-3.5 w-3.5" /> Send a new code
                      </Button>
                    </div>
                  </>
                ) : otpError === 'code_expired' ? (
                  /* Error state 6: code expired */
                  <>
                    <OtpBoxes onComplete={() => {}} disabled shakeKey={0} />
                    <div className="mt-3.5">
                      <StatusBanner type="error" icon={Clock}>
                        {ERROR_MESSAGES.code_expired}
                      </StatusBanner>
                      <Button className="mt-3.5 w-full gap-2" size="lg" onClick={handleResend}>
                        <Send className="h-3.5 w-3.5" /> Send a new code
                      </Button>
                    </div>
                  </>
                ) : otpError === 'network_error' ? (
                  /* Error state 8: network error */
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
                        onClick={handleSend}
                      >
                        Try again
                      </Button>
                    </div>
                  </>
                ) : (
                  <>
                    <OtpBoxes
                      onComplete={handleOtpComplete}
                      disabled={stage === 'verifying'}
                      shakeKey={shakeKey}
                    />

                    {/* Error state 3: wrong code */}
                    {otpError === 'wrong_code' && attemptsRemaining > 1 && (
                      <FieldMessage type="error">
                        Incorrect code — {attemptsRemaining} attempts remaining
                      </FieldMessage>
                    )}

                    {/* Error state 4: final attempt */}
                    {otpError === 'final_attempt' && attemptsRemaining === 1 && (
                      <div className="mt-2">
                        <FieldMessage type="warning">
                          One more wrong attempt will lock you out. Request a new code if unsure.
                        </FieldMessage>
                      </div>
                    )}

                    {stage === 'otp' && <ResendRow key={resendKey} onResend={handleResend} />}

                    {stage === 'verifying' && (
                      <div className="flex items-center justify-center gap-2.5 py-3.5">
                        <Loader2 className="text-primary h-4 w-4 animate-spin" />
                        <span className="text-muted-foreground text-[13px]">Verifying\u2026</span>
                      </div>
                    )}
                  </>
                )}
              </>
            )}

            {/* Verified */}
            {stage === 'verified' && (
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
                  {mode === 'settings' && initialPhone ? 'Number updated' : 'Phone verified'}
                </p>
                <p className="text-muted-foreground mb-3 text-[13px] leading-relaxed">
                  {mode === 'settings' && initialPhone
                    ? 'Your phone number has been changed and verified.'
                    : "You're set up to receive booking confirmations and SMS alerts."}
                </p>
                <span className="bg-success/10 border-success/20 text-success inline-flex items-center gap-1.5 rounded-full border px-3.5 py-1 text-[13px] font-semibold">
                  <Check className="h-[13px] w-[13px]" />
                  {e164Phone}
                </span>
                <button
                  type="button"
                  onClick={handleChangeNumber}
                  className="text-muted-foreground hover:text-foreground mx-auto mt-3 block text-xs underline underline-offset-[3px]"
                >
                  Change phone number
                </button>
              </motion.div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
