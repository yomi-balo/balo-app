import crypto from 'node:crypto';
import {
  CALENDAR_CONNECT_PROVIDERS,
  calendarConnectNonceCookieName,
  type CalendarConnectProvider,
} from '@balo/shared/calendar';

/**
 * BAL-396 §10.3 — the OAuth connect-flow CSRF state, provider-agnostic (no provider literal
 * anywhere in this file — Scan B, `invariants/sync-token-parity.test.ts`). Reuses the shipped
 * HMAC shape (`services/cronofy/oauth.ts` — `base64url(payload).base64url(hmac)`, keyed on
 * `INTERNAL_API_SECRET`, `timingSafeEqual`, a TTL) rather than inventing a second one.
 *
 * ⚠ The import above names `CalendarConnectProvider` and iterates `CALENDAR_CONNECT_PROVIDERS`,
 * but never writes the literal `'google'` or `'microsoft'` — the values live in
 * `@balo/shared/calendar`, outside Scan B's walk root (`apps/api/src`), so this file's own
 * "provider-agnostic" claim stays true by construction, not by discipline.
 *
 * ⚠ THE `nonce` IS NOT A REPLAY GUARD. It adds per-request uniqueness inside the TTL so two
 * connect attempts for the same (expert, provider) in the same millisecond do not sign
 * identical states — but it is never checked against a server-side store (there is none). The
 * HMAC plus the TTL is the actual CSRF guard, exactly as the Cronofy state it replaces. Say so
 * here rather than implying replay protection that does not exist.
 */
export interface ConnectStatePayload {
  readonly expertProfileId: string;
  readonly provider: string;
  readonly nonce: string;
  readonly ts: number;
}

const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

function requireSecret(): string {
  const secret = process.env.INTERNAL_API_SECRET;
  if (!secret) throw new Error('INTERNAL_API_SECRET is not configured');
  return secret;
}

/** `base64url(payload).base64url(hmac)`, signed with `INTERNAL_API_SECRET`. */
export function signConnectState(expertProfileId: string, provider: string): string {
  const secret = requireSecret();

  const payload: ConnectStatePayload = {
    expertProfileId,
    provider,
    nonce: crypto.randomUUID(),
    ts: Date.now(),
  };

  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const hmac = crypto.createHmac('sha256', secret).update(payloadB64).digest('base64url');

  return `${payloadB64}.${hmac}`;
}

/**
 * Verifies the signature (timing-safe) and the TTL, and returns the payload.
 * Throws on a malformed shape, a bad signature, or an expired state.
 */
export function verifyConnectState(state: string): ConnectStatePayload {
  const secret = requireSecret();

  const parts = state.split('.');
  if (parts.length !== 2) {
    throw new Error('Invalid state format');
  }
  const [payloadB64, providedHmac] = parts as [string, string];

  const expectedHmac = crypto.createHmac('sha256', secret).update(payloadB64).digest('base64url');
  const provided = Buffer.from(providedHmac);
  const expected = Buffer.from(expectedHmac);
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
    throw new Error('Invalid state signature');
  }

  const payload = JSON.parse(
    Buffer.from(payloadB64, 'base64url').toString()
  ) as ConnectStatePayload;

  if (Date.now() - payload.ts > STATE_TTL_MS) {
    throw new Error('State has expired');
  }

  return payload;
}

/**
 * BAL-396 fix round, Finding 1 (round 2: moved to `@balo/shared/calendar`) — the OAuth-connect
 * CSRF binding cookie.
 *
 * The HMAC + TTL on `state` proves Balo minted it FOR some expert; it does not prove the
 * browser completing the callback is the one that started the flow. An attacker can mint a
 * connect URL for their OWN profile and hand it to a victim, whose consent then binds the
 * VICTIM's calendar to the ATTACKER's expert profile. Binding `state`'s `nonce` to a
 * short-lived, HttpOnly, browser-scoped cookie set at connect-time and checked at callback-time
 * closes that: an attacker's browser never holds the victim's cookie.
 *
 * The cookie NAME and its `Domain` derivation used to be hand-duplicated across this file and
 * apps/web's `_lib/calendar-connect-cookie.ts` — see `@balo/shared/calendar/connect-cookie.ts`'s
 * docblock for the three defects that caused, and why both sides now import from there instead.
 */
export { calendarConnectNonceCookieName } from '@balo/shared/calendar';

/**
 * Extracts `name`'s value from a raw `Cookie` request header. `split`/`indexOf` only, no
 * regex (SonarCloud S5852) — a cookie header is a small, flat, semicolon-delimited list, so a
 * parser is unwarranted machinery for one named value.
 *
 * ⚠ BAL-396 fix round 2, Finding 4 — NO `decodeURIComponent`. The value is always a
 * `crypto.randomUUID()` nonce, which contains no character that needs percent-decoding, so
 * decoding was pure liability: this cookie is attacker-writable text on a public,
 * unauthenticated route (`GET /auth/apiroc/callback`), and `decodeURIComponent` throws
 * `URIError` on a malformed percent sequence (verified: `%E0%A4%A`). The call site in
 * `routes/calendar/auth.ts` sits OUTSIDE that route's own try/catch, so the throw was an
 * unhandled 500 reachable by anyone who could set a cookie on the domain — turning a victim's
 * legitimate callback into an opaque failure instead of the clean `state_csrf_mismatch` redirect
 * a genuinely mismatched nonce produces.
 */
export function extractCookieValue(
  cookieHeader: string | undefined,
  name: string
): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    if (key !== name) continue;
    const value = part.slice(eq + 1).trim();
    return value.length > 0 ? value : undefined;
  }
  return undefined;
}

/**
 * The `Domain` to scope the clearing cookie(s) to — re-exported so `routes/calendar/auth.ts`
 * needs only one import for both setting up the clear headers below and any other place it
 * needs the platform's shared derivation.
 */
export { calendarConnectCookieDomain } from '@balo/shared/calendar';

/**
 * The `Set-Cookie` value that deletes `provider`'s CSRF-binding cookie — call this as soon as
 * the callback knows (or trusts) which provider's flow it is clearing, so the nonce is consumed
 * exactly once per callback hit, closing the 10-minute replay window.
 *
 * `hostname` MUST be derived the same way apps/web derived it when it SET the cookie —
 * `calendarConnectCookieDomain()` (`@balo/shared/calendar`) on both sides, never a local
 * re-derivation; `Domain` is part of a cookie's identity, so a mismatched `Domain` quietly
 * creates a second, unrelated cookie instead of clearing the first. `calendarConnectCookieDomain`
 * already excludes `localhost`, so `hostname` here is never that string.
 */
export function buildClearConnectNonceCookieHeader(
  hostname: string | undefined,
  provider: CalendarConnectProvider
): string {
  const domainAttr = hostname ? `; Domain=${hostname}` : '';
  const secureAttr = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `${calendarConnectNonceCookieName(provider)}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${domainAttr}${secureAttr}`;
}

/**
 * BAL-396 fix round 2, Finding 5 — clears EVERY provider's connect-nonce cookie. Used whenever
 * the callback cannot trust (or does not have) a specific provider: a malformed callback query,
 * an unverifiable `state`, or an `error` shape whose unverified payload names no provider. Safe
 * to over-clear — clearing a cookie the browser never set is a no-op — and strictly safer than
 * guessing, which is what a single shared cookie slot effectively did before this fix (see the
 * `@balo/shared/calendar/connect-cookie.ts` docblock).
 */
export function buildClearAllConnectNonceCookieHeaders(hostname: string | undefined): string[] {
  return CALENDAR_CONNECT_PROVIDERS.map((provider) =>
    buildClearConnectNonceCookieHeader(hostname, provider)
  );
}

export interface UnverifiedStateFields {
  readonly expertProfileId?: string;
  readonly provider?: string;
}

/**
 * Best-effort, UNVERIFIED extraction of `expertProfileId` / `provider` from a state's
 * payload — used ONLY to label an OAuth-error redirect when the signature itself cannot be
 * trusted (an expired or tampered state, or the vendor's `error` shape, which carries no
 * guarantee the state is even well-formed). Mirrors `routes/calendar/auth.ts`'s existing
 * Cronofy-era pattern (`auth.ts:104-120`). Never use this for anything that requires trust —
 * call `verifyConnectState` for that.
 */
export function readStatePayloadUnverified(state: string): UnverifiedStateFields {
  try {
    const [payloadB64] = state.split('.');
    if (!payloadB64) return {};
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString()) as {
      expertProfileId?: unknown;
      provider?: unknown;
    };
    const rawExpertProfileId = payload.expertProfileId;
    const rawProvider = payload.provider;
    const expertProfileId = typeof rawExpertProfileId === 'string' ? rawExpertProfileId : undefined;
    const provider = typeof rawProvider === 'string' ? rawProvider : undefined;
    return { expertProfileId, provider };
  } catch {
    return {};
  }
}
