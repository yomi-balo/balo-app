/**
 * BALO — Phone Verification Design Reference  (BAL-227)
 * ─────────────────────────────────────────────────────────────────
 * Single file covering the complete PhoneVerificationFlow component:
 *   - Happy path (entry → OTP → verified)
 *   - Both modes (onboarding wizard, expert settings)
 *   - All 8 error states
 *
 * EXPORTS
 * ─────────────────────────────────────────────────────────────────
 *   PhoneVerificationFlow   ← ship this (reusable component)
 *   default PhoneVerificationDesignGuide  ← preview only, do not ship
 *
 * COMPONENT API
 * ─────────────────────────────────────────────────────────────────
 *   <PhoneVerificationFlow
 *     mode="onboarding" | "settings"
 *     initialPhone?: string      // settings: current verified number
 *     onVerified: (e164: string) => void
 *     onCancel?: () => void      // settings only
 *   />
 *
 * INTERNAL STAGES
 * ─────────────────────────────────────────────────────────────────
 *   "entry"     phone input + country picker + send button
 *   "sending"   send button shows spinner
 *   "otp"       6 digit boxes + change link + resend timer
 *   "verifying" boxes disabled + spinner (auto-submit on digit 6)
 *   "verified"  check mark + confirmed number + change link
 *   "current"   settings only — shows existing number with Change btn
 *
 * ERROR STATES (all 8 must be implemented — see ErrorStatesPreview)
 * ─────────────────────────────────────────────────────────────────
 *   1. invalid_phone     client-side libphonenumber-js rejection
 *   2. brevo_rejected    API returned error (number unreachable)
 *   3. wrong_code        shake + red boxes, attempts badge updates
 *   4. final_attempt     amber warning, 1 attempt left
 *   5. locked_out        3 wrong attempts, must request new code
 *   6. code_expired      10min Redis TTL hit, must request new code
 *   7. rate_limited      too many sends, phone disabled, show cooldown
 *   8. network_error     send failed, retry CTA
 *
 * VALIDATION
 * ─────────────────────────────────────────────────────────────────
 *   Frontend + backend: libphonenumber-js/min
 *   isValidPhoneNumber + getNumberType — reject FIXED_LINE
 *   Debounce 300ms on keystroke.
 *
 * OTP GENERATION
 * ─────────────────────────────────────────────────────────────────
 *   crypto.randomInt(0, 1_000_000) zero-padded to 6 digits.
 *   NOT Math.random — not cryptographically secure.
 *
 * REDIS KEYS
 * ─────────────────────────────────────────────────────────────────
 *   otp:{phone}          { code, attempts: 0 }   TTL 10min
 *   otp:sends:{phone}    send counter             TTL 10min (max 3)
 *
 * API ROUTES  (apps/api/src/routes/phone/)
 * ─────────────────────────────────────────────────────────────────
 *   POST /phone/send-otp
 *     body:     { phone: string }   E.164 e.g. "+61412345678"
 *     returns:  { sent: true }
 *             | { error: string, cooldownSeconds?: number }
 *
 *   POST /phone/verify-otp
 *     body:     { phone: string, code: string }
 *     returns:  { verified: true }
 *             | { error: string, attemptsRemaining?: number }
 */

import { useState, useEffect, useRef } from 'react';

// ── Design Tokens ────────────────────────────────────────────────
const c = {
  bg: '#F8FAFB',
  surface: '#FFFFFF',
  surfaceSubtle: '#F1F4F8',
  border: '#E0E4EB',
  borderSubtle: '#EAEFF5',
  text: '#111827',
  textSecondary: '#4B5563',
  textTertiary: '#9CA3AF',
  primary: '#2563EB',
  primaryDark: '#1D4ED8',
  primaryLight: '#EFF6FF',
  primaryBorder: '#BFDBFE',
  primaryGlow: 'rgba(37,99,235,0.12)',
  accent: '#7C3AED',
  accentLight: '#F5F3FF',
  accentBorder: '#DDD6FE',
  success: '#059669',
  successLight: '#ECFDF5',
  successBorder: '#A7F3D0',
  warning: '#D97706',
  warningLight: '#FFFBEB',
  warningBorder: '#FDE68A',
  error: '#DC2626',
  errorLight: '#FEF2F2',
  errorBorder: '#FECACA',
  gradient: 'linear-gradient(135deg, #2563EB 0%, #7C3AED 100%)',
};

// ── Keyframes ────────────────────────────────────────────────────
const keyframes = `
@keyframes slideUp  { from { opacity:0; transform:translateY(10px) } to { opacity:1; transform:translateY(0) } }
@keyframes fadeIn   { from { opacity:0 } to { opacity:1 } }
@keyframes spin     { to { transform:rotate(360deg) } }
@keyframes checkPop { 0%{transform:scale(0)} 60%{transform:scale(1.25)} 100%{transform:scale(1)} }
@keyframes shake    { 0%,100%{transform:translateX(0)} 20%{transform:translateX(-5px)} 40%{transform:translateX(5px)} 60%{transform:translateX(-4px)} 80%{transform:translateX(4px)} }
@keyframes dropIn   { from{opacity:0;transform:translateY(-6px)} to{opacity:1;transform:translateY(0)} }
`;

// ── Icons ────────────────────────────────────────────────────────
const I = ({ d, size = 16, color = 'currentColor', style: xs }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke={color}
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    style={xs}
  >
    <path d={d} />
  </svg>
);
const Icons = {
  phone: (p) => (
    <svg
      width={p.size || 16}
      height={p.size || 16}
      viewBox="0 0 24 24"
      fill="none"
      stroke={p.color || 'currentColor'}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07A19.5 19.5 0 013.07 10.8 19.79 19.79 0 01.22 2.18 2 2 0 012.18 0H5.18a2 2 0 012 1.72c.127.96.36 1.903.7 2.81a2 2 0 01-.45 2.11L6.09 7.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.907.34 1.85.573 2.81.7A2 2 0 0122 14.92v2z" />
    </svg>
  ),
  check: (p) => <I {...p} d="M20 6L9 17l-5-5" />,
  send: (p) => (
    <svg
      width={p.size || 16}
      height={p.size || 16}
      viewBox="0 0 24 24"
      fill="none"
      stroke={p.color || 'currentColor'}
      strokeWidth={2.5}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1="22" y1="2" x2="11" y2="13" />
      <polygon points="22 2 15 22 11 13 2 9 22 2" />
    </svg>
  ),
  chevDown: (p) => <I {...p} d="M6 9l6 6 6-6" />,
  alert: (p) => (
    <svg
      width={p.size || 16}
      height={p.size || 16}
      viewBox="0 0 24 24"
      fill="none"
      stroke={p.color || 'currentColor'}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  ),
  lock: (p) => (
    <svg
      width={p.size || 16}
      height={p.size || 16}
      viewBox="0 0 24 24"
      fill="none"
      stroke={p.color || 'currentColor'}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="3" y="11" width="18" height="11" rx="2" />
      <path d="M7 11V7a5 5 0 0110 0v4" />
    </svg>
  ),
  clock: (p) => (
    <svg
      width={p.size || 16}
      height={p.size || 16}
      viewBox="0 0 24 24"
      fill="none"
      stroke={p.color || 'currentColor'}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  ),
  info: (p) => (
    <svg
      width={p.size || 16}
      height={p.size || 16}
      viewBox="0 0 24 24"
      fill="none"
      stroke={p.color || 'currentColor'}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  ),
  wifi: (p) => <I {...p} d="M1 6s4-2 11-2 11 2 11 2M1 12s4-2 11-2 11 2 11 2M12 20h.01" />,
};

// ── Country list ─────────────────────────────────────────────────
// Default: AU — at runtime replace with IP-detected country:
//   const res = await fetch('https://ipapi.co/json/');
//   const { country_code } = await res.json();
const COUNTRIES = [
  { code: 'AU', flag: '🇦🇺', dial: '+61', name: 'Australia' },
  { code: 'NZ', flag: '🇳🇿', dial: '+64', name: 'New Zealand' },
  { code: 'US', flag: '🇺🇸', dial: '+1', name: 'United States' },
  { code: 'GB', flag: '🇬🇧', dial: '+44', name: 'United Kingdom' },
  { code: 'CA', flag: '🇨🇦', dial: '+1', name: 'Canada' },
  { code: 'SG', flag: '🇸🇬', dial: '+65', name: 'Singapore' },
  { code: 'IN', flag: '🇮🇳', dial: '+91', name: 'India' },
];

// ── Sub-components ───────────────────────────────────────────────

function Spinner({ size = 18, color = c.primary }) {
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        flexShrink: 0,
        border: `2.5px solid ${color}30`,
        borderTopColor: color,
        animation: 'spin 0.7s linear infinite',
      }}
    />
  );
}

function CountryPicker({ selected, onChange, disabled }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    const fn = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', fn);
    return () => document.removeEventListener('mousedown', fn);
  }, []);
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        disabled={disabled}
        onClick={() => setOpen(!open)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          height: 44,
          padding: '0 12px',
          borderRadius: 10,
          border: `1px solid ${c.border}`,
          background: c.surfaceSubtle,
          cursor: disabled ? 'default' : 'pointer',
          opacity: disabled ? 0.5 : 1,
          fontFamily: 'inherit',
          color: c.text,
          whiteSpace: 'nowrap',
        }}
      >
        <span style={{ fontSize: 18 }}>{selected.flag}</span>
        <span style={{ fontSize: 13, color: c.textSecondary }}>{selected.dial}</span>
        <Icons.chevDown size={12} color={c.textTertiary} />
      </button>
      {open && (
        <div
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            left: 0,
            minWidth: 200,
            background: c.surface,
            border: `1px solid ${c.border}`,
            borderRadius: 12,
            boxShadow: '0 8px 24px rgba(0,0,0,0.1)',
            zIndex: 50,
            overflow: 'hidden',
            animation: 'dropIn 0.15s ease-out both',
          }}
        >
          {COUNTRIES.map((co) => (
            <div
              key={co.code}
              onClick={() => {
                onChange(co);
                setOpen(false);
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '9px 14px',
                cursor: 'pointer',
                fontSize: 14,
                color: c.text,
                background: selected.code === co.code ? c.primaryLight : 'transparent',
              }}
            >
              <span style={{ fontSize: 18 }}>{co.flag}</span>
              <span style={{ flex: 1 }}>{co.name}</span>
              <span style={{ fontSize: 11, color: c.textTertiary, fontFamily: 'monospace' }}>
                {co.dial}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// 6 individual OTP boxes.
// - Auto-advances focus on each digit entry
// - Auto-submits when all 6 digits filled (no submit button)
// - Supports paste of full 6-digit code
// - Turns red + shakes on wrong code; clears automatically
function OtpBoxes({ onComplete, disabled, shakeAndClear }) {
  const refs = Array.from({ length: 6 }, () => useRef(null));
  const [values, setValues] = useState(['', '', '', '', '', '']);
  const [shaking, setShaking] = useState(false);

  useEffect(() => {
    if (shakeAndClear) {
      setShaking(true);
      setTimeout(() => {
        setValues(['', '', '', '', '', '']);
        setShaking(false);
        refs[0].current?.focus();
      }, 400);
    }
  }, [shakeAndClear]);

  function handleInput(idx, raw) {
    const digit = raw.replace(/\D/g, '').slice(-1);
    const next = [...values];
    next[idx] = digit;
    setValues(next);
    if (digit && idx < 5) refs[idx + 1].current?.focus();
    if (next.every(Boolean)) onComplete(next.join(''));
  }

  function handleKey(idx, e) {
    if (e.key === 'Backspace' && !values[idx] && idx > 0) refs[idx - 1].current?.focus();
  }

  function handlePaste(e) {
    e.preventDefault();
    const text = (e.clipboardData || window.clipboardData).getData('text').replace(/\D/g, '');
    const next = ['', '', '', '', '', ''];
    for (let i = 0; i < 6 && i < text.length; i++) next[i] = text[i];
    setValues(next);
    refs[Math.min(text.length, 5)].current?.focus();
    if (next.every(Boolean)) onComplete(next.join(''));
  }

  const isError = shaking;
  return (
    <div
      style={{
        display: 'flex',
        gap: 10,
        justifyContent: 'center',
        animation: shaking ? 'shake 0.4s ease-out' : 'none',
      }}
    >
      {values.map((v, i) => (
        <input
          key={i}
          ref={refs[i]}
          value={v}
          maxLength={1}
          inputMode="numeric"
          disabled={disabled}
          onChange={(e) => handleInput(i, e.target.value)}
          onKeyDown={(e) => handleKey(i, e)}
          onPaste={handlePaste}
          style={{
            width: 52,
            height: 58,
            borderRadius: 12,
            textAlign: 'center',
            fontSize: 22,
            fontWeight: 700,
            fontFamily: 'inherit',
            border: `1px solid ${isError ? c.errorBorder : v ? c.accent : c.border}`,
            background: isError ? c.errorLight : v ? c.accentLight : c.surface,
            color: isError ? c.error : c.text,
            outline: 'none',
            opacity: disabled ? 0.6 : 1,
            transition: 'border-color 0.15s, background 0.15s',
          }}
        />
      ))}
    </div>
  );
}

function ResendRow({ onResend, initialSeconds = 30 }) {
  const [secs, setSecs] = useState(initialSeconds);
  useEffect(() => {
    const t = setInterval(() => setSecs((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        marginTop: 12,
      }}
    >
      {secs > 0 ? (
        <span style={{ fontSize: 12, color: c.textTertiary }}>Resend in {secs}s</span>
      ) : (
        <button
          onClick={onResend}
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: c.primary,
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            fontFamily: 'inherit',
          }}
        >
          Resend code
        </button>
      )}
    </div>
  );
}

// Inline error / warning message under a field
function FieldMsg({ type = 'error', children }) {
  const map = {
    error: { color: c.error, Icon: Icons.info },
    warning: { color: c.warning, Icon: Icons.alert },
    info: { color: c.textTertiary, Icon: Icons.info },
  };
  const { color, Icon } = map[type];
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6, marginTop: 6 }}>
      <Icon size={13} color={color} style={{ flexShrink: 0, marginTop: 1 }} />
      <span style={{ fontSize: 12, color, lineHeight: 1.45 }}>{children}</span>
    </div>
  );
}

// Coloured banner for lockout / expiry / rate-limit / network error
function StatusBanner({ type = 'error', icon: Icon, children }) {
  const styles = {
    error: { bg: c.errorLight, border: c.errorBorder, color: c.error },
    warning: { bg: c.warningLight, border: c.warningBorder, color: c.warning },
    info: { bg: c.surfaceSubtle, border: c.border, color: c.textSecondary },
  };
  const s = styles[type];
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 8,
        padding: '12px 14px',
        background: s.bg,
        border: `1px solid ${s.border}`,
        borderRadius: 10,
      }}
    >
      <Icon size={15} color={s.color} style={{ flexShrink: 0, marginTop: 1 }} />
      <p style={{ fontSize: 13, color: s.color, margin: 0, lineHeight: 1.5 }}>{children}</p>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// PhoneVerificationFlow — MAIN REUSABLE COMPONENT
// ══════════════════════════════════════════════════════════════════

export function PhoneVerificationFlow({ mode = 'onboarding', initialPhone, onVerified, onCancel }) {
  const [country, setCountry] = useState(COUNTRIES[0]);
  const [phoneVal, setPhoneVal] = useState('');
  const [phoneError, setPhoneError] = useState(null);

  // stage: "current" | "entry" | "sending" | "otp" | "verifying" | "verified"
  const [stage, setStage] = useState(mode === 'settings' && initialPhone ? 'current' : 'entry');
  const [otpErrorMsg, setOtpErrorMsg] = useState(null);
  const [otpShake, setOtpShake] = useState(0); // increment to trigger shake+clear
  const [attemptsLeft, setAttemptsLeft] = useState(3);
  const [maskedPhone, setMaskedPhone] = useState('');
  const [resendKey, setResendKey] = useState(0);

  const fullPhone = `${country.dial}${phoneVal.replace(/\s/g, '')}`;

  // libphonenumber-js validation stub
  // Replace with: import { isValidPhoneNumber, getNumberType } from 'libphonenumber-js/min'
  function validatePhone() {
    const n = phoneVal.trim().replace(/\s/g, '');
    if (n.length < 6) {
      setPhoneError('Enter a valid phone number including country code');
      return false;
    }
    // isValidPhoneNumber(fullPhone) → if false: setPhoneError("Enter a valid phone number")
    // getNumberType(fullPhone) === "FIXED_LINE" → setPhoneError("That looks like a landline — enter a mobile number")
    setPhoneError(null);
    return true;
  }

  function getMasked() {
    const n = phoneVal.replace(/\s/g, '');
    return `${country.dial} ${'*'.repeat(Math.max(0, n.length - 4))}${n.slice(-4)}`;
  }

  async function handleSend() {
    if (!validatePhone()) return;
    setStage('sending');
    // TODO: const res = await fetch('/phone/send-otp', { method: 'POST', body: JSON.stringify({ phone: fullPhone }) });
    // const data = await res.json();
    // if (!res.ok) {
    //   setStage("entry");
    //   if (data.cooldownSeconds) { /* error state 7: rate limited */ }
    //   else { setPhoneError("We couldn't send a code to this number. Check it's correct and try again."); } /* error state 2 */
    //   return;
    // }
    await new Promise((r) => setTimeout(r, 1100)); // stub — remove in production
    setMaskedPhone(getMasked());
    setOtpErrorMsg(null);
    setAttemptsLeft(3);
    setStage('otp');
    setResendKey((k) => k + 1);
  }

  async function handleOtpComplete(code) {
    setStage('verifying');
    // TODO: const res = await fetch('/phone/verify-otp', { method: 'POST', body: JSON.stringify({ phone: fullPhone, code }) });
    // const data = await res.json();
    // if (!res.ok) {
    //   const remaining = data.attemptsRemaining ?? 0;
    //   if (remaining === 0) { setAttemptsLeft(0); setStage("otp"); return; } // error state 5: locked out
    //   setAttemptsLeft(remaining);
    //   setOtpErrorMsg(remaining === 1 ? "Incorrect code — one attempt left before lockout" : `Incorrect code — ${remaining} attempts remaining`);
    //   setOtpShake((n) => n + 1); // trigger shake+clear in OtpBoxes
    //   setStage("otp");
    //   return;
    // }
    await new Promise((r) => setTimeout(r, 1500)); // stub — remove in production
    setStage('verified');
    onVerified?.(fullPhone);
  }

  function handleResend() {
    setOtpErrorMsg(null);
    setAttemptsLeft(3);
    setResendKey((k) => k + 1);
    handleSend();
  }

  function handleChangeNumber() {
    setStage('entry');
    setPhoneVal('');
    setPhoneError(null);
    setOtpErrorMsg(null);
  }

  // ── settings: current number view ────────────────────────────
  if (stage === 'current') {
    return (
      <>
        <style>{keyframes}</style>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '14px 16px',
            borderRadius: 10,
            background: c.surfaceSubtle,
            border: `1px solid ${c.border}`,
          }}
        >
          <div>
            <p
              style={{
                fontSize: 11,
                fontWeight: 700,
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
                color: c.textTertiary,
                margin: '0 0 3px',
              }}
            >
              Verified number
            </p>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <p style={{ fontSize: 15, fontWeight: 600, color: c.text, margin: 0 }}>
                {initialPhone}
              </p>
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  color: c.success,
                  background: c.successLight,
                  border: `1px solid ${c.successBorder}`,
                  padding: '2px 8px',
                  borderRadius: 10,
                }}
              >
                Verified
              </span>
            </div>
          </div>
          <button
            onClick={() => setStage('entry')}
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: c.primary,
              background: 'none',
              border: `1px solid ${c.primaryBorder}`,
              borderRadius: 8,
              padding: '6px 14px',
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            Change
          </button>
        </div>
        <p style={{ fontSize: 11, color: c.textTertiary, marginTop: 6 }}>
          Changing requires re-verification. SMS will use the new number once confirmed.
        </p>
      </>
    );
  }

  return (
    <>
      <style>{keyframes}</style>

      {/* Settings change warning (error state 2 banner also goes here when triggered) */}
      {mode === 'settings' && initialPhone && (stage === 'entry' || stage === 'sending') && (
        <div style={{ marginBottom: 20, animation: 'slideUp 0.25s ease-out both' }}>
          <StatusBanner type="warning" icon={Icons.alert}>
            Changing your number requires a new verification code. SMS will switch to the new number
            once verified.
          </StatusBanner>
        </div>
      )}

      {/* Phone entry — visible in entry/sending; frozen (greyed) in otp/verifying/verified */}
      <div>
        <label
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: c.textSecondary,
            display: 'block',
            marginBottom: 7,
          }}
        >
          Phone number
        </label>
        <div style={{ display: 'flex', gap: 10 }}>
          <CountryPicker selected={country} onChange={setCountry} disabled={stage !== 'entry'} />
          <input
            type="tel"
            value={phoneVal}
            onChange={(e) => {
              setPhoneVal(e.target.value);
              setPhoneError(null);
            }}
            onBlur={stage === 'entry' ? validatePhone : undefined}
            placeholder="412 345 678"
            disabled={stage !== 'entry'}
            style={{
              flex: 1,
              height: 44,
              padding: '0 14px',
              borderRadius: 10,
              fontFamily: 'inherit',
              border: `1px solid ${phoneError ? c.errorBorder : c.border}`,
              background: phoneError
                ? c.errorLight
                : stage !== 'entry'
                  ? c.surfaceSubtle
                  : c.surface,
              color: stage !== 'entry' ? c.textTertiary : c.text,
              fontSize: 15,
              outline: 'none',
            }}
          />
        </div>

        {/* Error state 1: invalid phone */}
        {phoneError && <FieldMsg type="error">{phoneError}</FieldMsg>}

        {stage === 'entry' && !phoneError && (
          <p style={{ fontSize: 11, color: c.textTertiary, marginTop: 6 }}>
            Include country code if pasting, e.g. {country.dial}412345678
          </p>
        )}

        {/* Send / sending button */}
        {(stage === 'entry' || stage === 'sending') && (
          <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
            <button
              disabled={phoneVal.trim().length < 6 || !!phoneError || stage === 'sending'}
              onClick={handleSend}
              style={{
                flex: 1,
                height: 46,
                borderRadius: 10,
                border: 'none',
                background: c.gradient,
                color: 'white',
                fontSize: 14,
                fontWeight: 600,
                fontFamily: 'inherit',
                cursor: phoneVal.trim().length < 6 || phoneError ? 'not-allowed' : 'pointer',
                opacity: phoneVal.trim().length < 6 || phoneError ? 0.45 : 1,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
              }}
            >
              {stage === 'sending' ? (
                <Spinner color="white" size={16} />
              ) : (
                <Icons.send size={14} color="white" />
              )}
              {stage === 'sending' ? 'Sending…' : 'Send verification code'}
            </button>
            {mode === 'settings' && onCancel && (
              <button
                onClick={onCancel}
                style={{
                  height: 46,
                  padding: '0 18px',
                  borderRadius: 10,
                  border: `1px solid ${c.border}`,
                  background: c.surfaceSubtle,
                  fontSize: 14,
                  fontWeight: 500,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  color: c.textSecondary,
                }}
              >
                Cancel
              </button>
            )}
          </div>
        )}

        {/* Error state 7: rate limited
            Trigger: API returns cooldownSeconds → replace send button area with:
            <StatusBanner type="error" icon={Icons.lock}>
              Too many requests for this number. Please wait <strong>10 minutes</strong> before trying again.
            </StatusBanner>
            + disabled send button */}
      </div>

      {/* OTP section */}
      {(stage === 'otp' || stage === 'verifying' || stage === 'verified') && (
        <div style={{ marginTop: 20, animation: 'slideUp 0.25s 0.05s ease-out both' }}>
          <div style={{ height: 1, background: c.border, marginBottom: 20 }} />

          {stage !== 'verified' && (
            <>
              {/* Masked phone + change number link */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  marginBottom: 16,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 13, color: c.textSecondary }}>Code sent to</span>
                  <span
                    style={{
                      fontSize: 13,
                      fontWeight: 600,
                      color: c.primary,
                      background: c.primaryLight,
                      border: `1px solid ${c.primaryBorder}`,
                      padding: '3px 10px',
                      borderRadius: 20,
                    }}
                  >
                    {maskedPhone}
                  </span>
                </div>
                {stage === 'otp' && attemptsLeft > 0 && (
                  <button
                    onClick={handleChangeNumber}
                    style={{
                      fontSize: 12,
                      fontWeight: 600,
                      color: c.textSecondary,
                      background: 'none',
                      border: `1px solid ${c.border}`,
                      borderRadius: 6,
                      padding: '3px 10px',
                      cursor: 'pointer',
                      fontFamily: 'inherit',
                    }}
                  >
                    Change number
                  </button>
                )}
              </div>

              {/* Attempts badge — error states 3 and 4 */}
              {otpErrorMsg && attemptsLeft > 0 && (
                <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 10 }}>
                  <span
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 4,
                      padding: '3px 10px',
                      borderRadius: 20,
                      fontSize: 11,
                      fontWeight: 600,
                      background: attemptsLeft === 1 ? c.warningLight : c.errorLight,
                      color: attemptsLeft === 1 ? c.warning : c.error,
                      border: `1px solid ${attemptsLeft === 1 ? c.warningBorder : c.errorBorder}`,
                    }}
                  >
                    <Icons.info size={11} color={attemptsLeft === 1 ? c.warning : c.error} />
                    {attemptsLeft === 1 ? 'Last attempt' : `${attemptsLeft} attempts left`}
                  </span>
                </div>
              )}

              <label
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  color: c.textSecondary,
                  display: 'block',
                  textAlign: 'center',
                  marginBottom: 14,
                }}
              >
                Enter 6-digit code
              </label>

              {/* Error state 5: locked out — boxes locked */}
              {attemptsLeft === 0 ? (
                <>
                  <OtpBoxes onComplete={() => {}} disabled={true} shakeAndClear={0} />
                  <div style={{ marginTop: 14 }}>
                    <StatusBanner type="error" icon={Icons.lock}>
                      Too many incorrect attempts. Request a new code to continue — the previous
                      code is now invalid.
                    </StatusBanner>
                    <button
                      onClick={handleResend}
                      style={{
                        width: '100%',
                        height: 46,
                        marginTop: 14,
                        borderRadius: 10,
                        border: 'none',
                        background: c.gradient,
                        color: 'white',
                        fontSize: 14,
                        fontWeight: 600,
                        fontFamily: 'inherit',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: 8,
                      }}
                    >
                      <Icons.send size={14} color="white" /> Send a new code
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <OtpBoxes
                    onComplete={handleOtpComplete}
                    disabled={stage === 'verifying'}
                    shakeAndClear={otpShake}
                  />

                  {/* Error state 3: wrong code message */}
                  {otpErrorMsg && attemptsLeft > 1 && (
                    <FieldMsg type="error">{otpErrorMsg}</FieldMsg>
                  )}

                  {/* Error state 4: final attempt — amber warning */}
                  {attemptsLeft === 1 && (
                    <div style={{ marginTop: 8 }}>
                      <FieldMsg type="warning">
                        One more wrong attempt will lock you out. Request a new code if unsure.
                      </FieldMsg>
                    </div>
                  )}

                  {/* Error state 6: code expired
                      Trigger: API returns { error: "code_expired" } → show instead of boxes:
                      <StatusBanner type="error" icon={Icons.clock}>
                        Your code has expired. Request a new one to continue.
                      </StatusBanner>
                      <button onClick={handleResend}>Send a new code</button> */}

                  {/* Error state 8: network error
                      Trigger: fetch throws or 5xx → setStage("entry") and show:
                      <StatusBanner type="info" icon={Icons.wifi}>
                        Something went wrong sending the code. Check your connection and try again.
                      </StatusBanner>
                      <button onClick={handleSend}>Try again</button> */}

                  {stage === 'otp' && <ResendRow key={resendKey} onResend={handleResend} />}

                  {stage === 'verifying' && (
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: 10,
                        padding: '14px 0',
                      }}
                    >
                      <Spinner />
                      <span style={{ fontSize: 13, color: c.textSecondary }}>Verifying…</span>
                    </div>
                  )}
                </>
              )}
            </>
          )}

          {/* Verified */}
          {stage === 'verified' && (
            <div
              style={{
                textAlign: 'center',
                padding: '12px 0 4px',
                animation: 'slideUp 0.25s ease-out both',
              }}
            >
              <div
                style={{
                  width: 52,
                  height: 52,
                  borderRadius: '50%',
                  margin: '0 auto 12px',
                  background: c.successLight,
                  border: `1px solid ${c.successBorder}`,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  animation: 'checkPop 0.4s ease-out',
                }}
              >
                <Icons.check size={24} color={c.success} />
              </div>
              <p style={{ fontSize: 16, fontWeight: 700, color: c.text, margin: '0 0 6px' }}>
                {mode === 'settings' && initialPhone ? 'Number updated' : 'Phone verified'}
              </p>
              <p
                style={{
                  fontSize: 13,
                  color: c.textSecondary,
                  lineHeight: 1.5,
                  margin: '0 0 12px',
                }}
              >
                {mode === 'settings' && initialPhone
                  ? 'Your phone number has been changed and verified.'
                  : "You're set up to receive booking confirmations and SMS alerts."}
              </p>
              <div
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '4px 14px',
                  borderRadius: 20,
                  background: c.successLight,
                  border: `1px solid ${c.successBorder}`,
                  fontSize: 13,
                  fontWeight: 600,
                  color: c.success,
                }}
              >
                <Icons.check size={13} color={c.success} />
                {fullPhone}
              </div>
              <button
                onClick={handleChangeNumber}
                style={{
                  display: 'block',
                  margin: '12px auto 0',
                  fontSize: 12,
                  color: c.textTertiary,
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  textDecoration: 'underline',
                  textUnderlineOffset: 3,
                }}
              >
                Change phone number
              </button>
            </div>
          )}
        </div>
      )}
    </>
  );
}

// ══════════════════════════════════════════════════════════════════
// Error States Preview — static grid for CC design reference
// ══════════════════════════════════════════════════════════════════

function ErrorStatesPreview() {
  const Boxes = ({ variant }) => (
    <div
      style={{
        display: 'flex',
        gap: 8,
        justifyContent: 'center',
        marginBottom: 10,
        animation: variant === 'shake' ? 'shake 0.4s ease-out' : 'none',
      }}
    >
      {[1, 2, 3, 4, 5, 6].map((i) => (
        <div
          key={i}
          style={{
            width: 44,
            height: 52,
            borderRadius: 10,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 18,
            fontWeight: 700,
            border: `1px solid ${variant === 'error' ? c.errorBorder : c.border}`,
            background:
              variant === 'error'
                ? c.errorLight
                : variant === 'disabled'
                  ? c.surfaceSubtle
                  : c.surface,
            color: variant === 'error' ? c.error : c.textTertiary,
            opacity: variant === 'disabled' ? 0.6 : 1,
          }}
        >
          {variant !== 'disabled' ? i : '·'}
        </div>
      ))}
    </div>
  );

  const Card = ({ label, children }) => (
    <div
      style={{
        background: c.surface,
        border: `1px solid ${c.border}`,
        borderRadius: 14,
        padding: 18,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      <p
        style={{
          fontSize: 10,
          fontWeight: 700,
          textTransform: 'uppercase',
          letterSpacing: '0.07em',
          color: c.textTertiary,
          margin: 0,
        }}
      >
        {label}
      </p>
      {children}
    </div>
  );

  const SendBtn = ({ label, disabled }) => (
    <button
      disabled={disabled}
      style={{
        width: '100%',
        height: 40,
        borderRadius: 10,
        border: 'none',
        background: c.gradient,
        color: 'white',
        fontSize: 13,
        fontWeight: 600,
        fontFamily: 'inherit',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.4 : 1,
      }}
    >
      {label}
    </button>
  );

  const PhoneRow = ({ val, hasError }) => (
    <div style={{ display: 'flex', gap: 8 }}>
      <div
        style={{
          height: 40,
          padding: '0 10px',
          borderRadius: 10,
          border: `1px solid ${c.border}`,
          background: c.surfaceSubtle,
          display: 'flex',
          alignItems: 'center',
          gap: 5,
          fontSize: 13,
          color: c.textSecondary,
          whiteSpace: 'nowrap',
        }}
      >
        🇦🇺 +61
      </div>
      <div
        style={{
          flex: 1,
          height: 40,
          padding: '0 12px',
          borderRadius: 10,
          display: 'flex',
          alignItems: 'center',
          border: `1px solid ${hasError ? c.errorBorder : c.border}`,
          background: hasError ? c.errorLight : c.surface,
          fontSize: 14,
          color: hasError ? c.error : c.text,
        }}
      >
        {val}
      </div>
    </div>
  );

  const AttemptsTag = ({ n, type }) => (
    <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          padding: '3px 8px',
          borderRadius: 20,
          fontSize: 11,
          fontWeight: 600,
          background: type === 'warning' ? c.warningLight : c.errorLight,
          color: type === 'warning' ? c.warning : c.error,
          border: `1px solid ${type === 'warning' ? c.warningBorder : c.errorBorder}`,
        }}
      >
        <Icons.info size={11} color={type === 'warning' ? c.warning : c.error} />
        {n}
      </span>
    </div>
  );

  return (
    <div style={{ padding: '24px' }}>
      <p
        style={{
          fontSize: 11,
          fontWeight: 700,
          textTransform: 'uppercase',
          letterSpacing: '0.07em',
          color: c.textTertiary,
          marginBottom: 18,
        }}
      >
        All 8 error states
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <Card label="1 — invalid phone (client-side, libphonenumber-js)">
          <PhoneRow val="041 234" hasError={true} />
          <FieldMsg type="error">Enter a valid phone number including country code</FieldMsg>
          <SendBtn label="Send verification code" disabled={true} />
        </Card>

        <Card label="2 — brevo rejected (number unreachable)">
          <PhoneRow val="412 345 678" hasError={true} />
          <FieldMsg type="error">
            We couldn't send a code to this number. Check it's correct and try again.
          </FieldMsg>
          <SendBtn label="Try again" disabled={false} />
        </Card>

        <Card label="3 — wrong code (2 attempts left)">
          <AttemptsTag n="2 attempts left" type="error" />
          <Boxes variant="shake" />
          <FieldMsg type="error">Incorrect code — boxes clear automatically, try again</FieldMsg>
        </Card>

        <Card label="4 — final attempt warning (1 left)">
          <AttemptsTag n="Last attempt" type="warning" />
          <Boxes variant="normal" />
          <FieldMsg type="warning">
            One more wrong attempt will lock you out. Request a new code if unsure.
          </FieldMsg>
        </Card>

        <Card label="5 — locked out (3 wrong attempts)">
          <Boxes variant="disabled" />
          <StatusBanner type="error" icon={Icons.lock}>
            Too many incorrect attempts. <strong>Request a new code</strong> — the previous code is
            now invalid.
          </StatusBanner>
          <SendBtn label="Send a new code" disabled={false} />
        </Card>

        <Card label="6 — code expired (10 min Redis TTL)">
          <Boxes variant="disabled" />
          <StatusBanner type="error" icon={Icons.clock}>
            Your code has expired. <strong>Request a new one</strong> to continue.
          </StatusBanner>
          <SendBtn label="Send a new code" disabled={false} />
        </Card>

        <Card label="7 — rate limited (too many send requests)">
          <PhoneRow val="412 345 678" hasError={false} />
          <StatusBanner type="error" icon={Icons.lock}>
            Too many requests for this number. Please wait <strong>10 minutes</strong> before trying
            again.
          </StatusBanner>
          <SendBtn label="Send verification code" disabled={true} />
        </Card>

        <Card label="8 — network / send failure">
          <PhoneRow val="412 345 678" hasError={false} />
          <StatusBanner type="info" icon={Icons.wifi}>
            Something went wrong sending the code. Check your connection and try again.
          </StatusBanner>
          <SendBtn label="Try again" disabled={false} />
        </Card>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// Default export — Design Guide Preview Shell  (do not ship)
// ══════════════════════════════════════════════════════════════════

export default function PhoneVerificationDesignGuide() {
  const [view, setView] = useState('onboarding');

  const tabs = [
    { key: 'onboarding', label: 'Onboarding wizard' },
    { key: 'settings', label: 'Expert settings' },
    { key: 'errors', label: 'Error states' },
  ];

  return (
    <div
      style={{
        minHeight: '100vh',
        background: c.bg,
        fontFamily: "'DM Sans', -apple-system, BlinkMacSystemFont, sans-serif",
        padding: '28px 16px 64px',
      }}
    >
      <style>{keyframes}</style>
      <link
        href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap"
        rel="stylesheet"
      />

      <div
        style={{
          maxWidth: 520,
          margin: '0 auto 28px',
          display: 'flex',
          gap: 6,
          alignItems: 'center',
        }}
      >
        <span style={{ fontSize: 11, color: c.textTertiary, marginRight: 4 }}>View:</span>
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setView(t.key)}
            style={{
              padding: '6px 14px',
              borderRadius: 20,
              fontSize: 12,
              fontWeight: 600,
              cursor: 'pointer',
              fontFamily: 'inherit',
              border: `1px solid ${view === t.key ? c.primaryBorder : c.border}`,
              background: view === t.key ? c.primaryLight : c.surfaceSubtle,
              color: view === t.key ? c.primary : c.textSecondary,
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {view === 'onboarding' && (
        <div style={{ maxWidth: 480, margin: '0 auto' }}>
          <div
            style={{
              height: 3,
              borderRadius: 2,
              background: c.border,
              marginBottom: 24,
              overflow: 'hidden',
            }}
          >
            <div
              style={{ width: '60%', height: '100%', background: c.gradient, borderRadius: 2 }}
            />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 20 }}>
            <div style={{ width: 7, height: 7, borderRadius: '50%', background: c.gradient }} />
            <span
              style={{
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: '0.07em',
                textTransform: 'uppercase',
                color: c.textSecondary,
              }}
            >
              Step 4 of 6 · Phone verification
            </span>
          </div>
          <div
            style={{
              background: c.surface,
              borderRadius: 16,
              border: `1px solid ${c.border}`,
              padding: '28px 28px 24px',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6 }}>
              <div
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: 11,
                  background: c.primaryLight,
                  border: `1px solid ${c.primaryBorder}`,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                }}
              >
                <Icons.phone size={20} color={c.primary} />
              </div>
              <h2 style={{ fontSize: 17, fontWeight: 700, color: c.text, margin: 0 }}>
                Verify your phone number
              </h2>
            </div>
            <p
              style={{
                fontSize: 13,
                color: c.textSecondary,
                lineHeight: 1.55,
                margin: '0 0 24px 52px',
              }}
            >
              Required for booking alerts and to appear in expert search. We'll send a one-time code
              to confirm.
            </p>
            <PhoneVerificationFlow
              mode="onboarding"
              onVerified={(p) => console.log('Verified:', p)}
            />
          </div>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginTop: 20,
            }}
          >
            <button
              style={{
                background: 'none',
                border: 'none',
                fontSize: 13,
                color: c.textSecondary,
                cursor: 'pointer',
                fontFamily: 'inherit',
              }}
            >
              ← Back
            </button>
            <p style={{ fontSize: 12, color: c.textTertiary }}>
              Only used for operational notifications
            </p>
          </div>
        </div>
      )}

      {view === 'settings' && (
        <div style={{ maxWidth: 480, margin: '0 auto' }}>
          <div
            style={{
              background: c.surface,
              borderRadius: 16,
              border: `1px solid ${c.border}`,
              padding: '28px 28px 24px',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6 }}>
              <div
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: 11,
                  background: c.primaryLight,
                  border: `1px solid ${c.primaryBorder}`,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                }}
              >
                <Icons.phone size={20} color={c.primary} />
              </div>
              <h2 style={{ fontSize: 17, fontWeight: 700, color: c.text, margin: 0 }}>
                Phone number
              </h2>
            </div>
            <p
              style={{
                fontSize: 13,
                color: c.textSecondary,
                lineHeight: 1.55,
                margin: '0 0 20px 52px',
              }}
            >
              Used for booking confirmations and operational SMS alerts.
            </p>
            <PhoneVerificationFlow
              mode="settings"
              initialPhone="+61 412 345 678"
              onVerified={(p) => console.log('Updated:', p)}
              onCancel={() => console.log('Cancelled')}
            />
          </div>
        </div>
      )}

      {view === 'errors' && (
        <div style={{ maxWidth: 760, margin: '0 auto' }}>
          <div
            style={{
              background: c.surface,
              borderRadius: 16,
              border: `1px solid ${c.border}`,
              overflow: 'hidden',
            }}
          >
            <ErrorStatesPreview />
          </div>
        </div>
      )}
    </div>
  );
}
