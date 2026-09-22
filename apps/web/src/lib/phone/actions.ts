'use server';
import 'server-only';

import { z } from 'zod';
import { isAccountRefusalCode } from '@balo/shared/authz';
import { requireOnboardedUser } from '@/lib/auth/session';
import { AccountNotLiveError, ACCOUNT_UNREADABLE } from '@/lib/auth/account-liveness';
import { isImpersonatedSession } from '@/lib/auth/impersonation';
import { log } from '@/lib/logging';
import {
  isExpiredCredentialFailure,
  postBaloApiJsonWithFailureDetail,
} from '@/lib/api/balo-api-client';
import type { PhoneOtpFailureCode, SendPhoneOtpResult, VerifyPhoneOtpResult } from './types';

/**
 * Phone verification's two hops to `apps/api` (`POST /phone/send-otp`, `POST /phone/verify-otp`).
 *
 * They run server-side so the Bearer is read from the session cookie at call time, never captured
 * at render and handed to the browser. A dead credential maps to `session_expired`, never to a
 * wrong-code result.
 *
 * The middleware refreshes an expiring token and the refreshed cookie reaches this request's
 * `cookies()` (`lib/auth/middleware-session.ts`), so `session_expired` here means the refresh
 * itself did not happen for this request: it failed (a dead refresh token), or a concurrent
 * request's refresh consumed the refresh token first. The client retries once for the second
 * case and offers a fresh sign-in for the first.
 */

/** Mirrors `apps/api`'s `sendOtpBodySchema` / `verifyOtpBodySchema` (routes/phone/schema.ts). */
const e164Schema = z.string().regex(/^\+[1-9]\d{6,14}$/);
const codeSchema = z.string().regex(/^\d{6}$/);

const KNOWN_API_CODES: ReadonlySet<string> = new Set<PhoneOtpFailureCode>([
  'invalid_phone',
  'landline_not_supported',
  'rate_limited',
  'brevo_rejected',
  'wrong_code',
  'final_attempt',
  'locked_out',
  'code_expired',
]);

/** A non-negative integer field off a non-2xx body, or `undefined`. */
function readCount(body: Record<string, unknown>, key: string): number | undefined {
  const value = body[key];
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function toFailureCode(status: number, code: string): PhoneOtpFailureCode {
  if (isAccountRefusalCode(code)) return 'account_refused';
  if (isExpiredCredentialFailure(status, code)) return 'session_expired';
  return KNOWN_API_CODES.has(code) ? (code as PhoneOtpFailureCode) : 'request_failed';
}

/**
 * The actor gate, returning a failure the client can act on instead of throwing where it has one:
 *   - a suspended or deleted account → `account_refused`, so the client signs the person out
 *     (BAL-568). `requireOnboardedUser` refuses a non-live account on the web side, BEFORE the api
 *     is reached, so the api's own refusal marker is never seen for it;
 *   - an unreadable account row → `request_failed`: a DB fault refuses access but must never sign
 *     anyone out;
 *   - an impersonated session → `impersonation_refused`, checked BEFORE the api hop, which an
 *     impersonated session always fails (it holds no access token) and would otherwise report as
 *     an expired session.
 * Anything else (`Unauthorized`, `Onboarding not completed`) rethrows unchanged.
 */
async function gateActor(action: string): Promise<PhoneOtpFailureCode | null> {
  let user: Awaited<ReturnType<typeof requireOnboardedUser>>;
  try {
    user = await requireOnboardedUser();
  } catch (error) {
    if (error instanceof AccountNotLiveError) {
      return error.code === ACCOUNT_UNREADABLE ? 'request_failed' : 'account_refused';
    }
    throw error;
  }
  if (isImpersonatedSession(user)) {
    log.warn('Phone verification refused — impersonated session', {
      userId: user.id,
      impersonatorUserId: user.impersonatorUserId,
      action,
    });
    return 'impersonation_refused';
  }
  return null;
}

export async function sendPhoneOtpAction(phone: string): Promise<SendPhoneOtpResult> {
  const refused = await gateActor('send');
  if (refused !== null) return { ok: false, code: refused };
  const parsed = e164Schema.safeParse(phone);
  if (!parsed.success) return { ok: false, code: 'invalid_phone' };

  const result = await postBaloApiJsonWithFailureDetail(
    '/phone/send-otp',
    { phone: parsed.data },
    () => ({}),
    (body) => readCount(body, 'cooldownSeconds'),
    'phone-send-otp'
  );
  if (result.ok) return { ok: true };

  const code = toFailureCode(result.status, result.code);
  // ⚠ THE KEY IS OMITTED, NOT SET TO `undefined` (`exactOptionalPropertyTypes`).
  return code === 'rate_limited' && result.detail !== undefined
    ? { ok: false, code, cooldownSeconds: result.detail }
    : { ok: false, code };
}

export async function verifyPhoneOtpAction(
  phone: string,
  code: string
): Promise<VerifyPhoneOtpResult> {
  const refused = await gateActor('verify');
  if (refused !== null) return { ok: false, code: refused };
  const parsedPhone = e164Schema.safeParse(phone);
  if (!parsedPhone.success) return { ok: false, code: 'invalid_phone' };
  const parsedCode = codeSchema.safeParse(code);
  // A malformed code is a wrong code as far as the form is concerned; the api is not consulted,
  // so no attempt is spent.
  if (!parsedCode.success) return { ok: false, code: 'wrong_code' };

  const result = await postBaloApiJsonWithFailureDetail(
    '/phone/verify-otp',
    { phone: parsedPhone.data, code: parsedCode.data },
    () => ({}),
    (body) => readCount(body, 'attemptsRemaining'),
    'phone-verify-otp'
  );
  if (result.ok) return { ok: true };

  const failureCode = toFailureCode(result.status, result.code);
  const carriesAttempts = failureCode === 'wrong_code' || failureCode === 'final_attempt';
  return carriesAttempts && result.detail !== undefined
    ? { ok: false, code: failureCode, attemptsRemaining: result.detail }
    : { ok: false, code: failureCode };
}
