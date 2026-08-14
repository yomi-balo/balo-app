/**
 * BAL-134 (§5.2) — DAILY WEBHOOK SIGNATURE VERIFICATION, IN **ONE** FUNCTION.
 *
 * ✅ **VERIFIED against `docs.daily.co/reference/rest-api/webhooks` on 2026-08-15**, and the
 * verified scheme is recorded in `.claude/skills/daily-co/SKILL.md`'s `## Webhooks` section
 * (which this PR adds, because the skill had none):
 *
 *     signature = HMAC-SHA256( base64-decoded secret , `${timestamp}.${rawBody}` )   → BASE64
 *     headers   = `x-webhook-timestamp` (unix SECONDS) + `x-webhook-signature`
 *     secret    = the `hmac` field Daily returns when the webhook is CREATED
 *
 * ⚠⚠ THE DIGEST IS BASE64, NOT HEX, AND THAT DISTINCTION IS LOAD-BEARING. An earlier draft of
 * this module computed a HEX digest — a scheme under which EVERY GENUINE DELIVERY FAILS
 * VERIFICATION and returns a perfectly healthy-looking `400`. Nothing errors, nothing pages:
 * presence is simply never written, both clocks stay at zero, and the entire feature is
 * silently dead in production. ⚠ NOTE ALSO THAT A SIGN-THEN-VERIFY ROUND-TRIP TEST PASSES
 * UNDER EITHER ENCODING, so the test below asserts the digest IS base64 against a fixed
 * vector — a round-trip alone would have shipped the bug.
 *
 * The whole scheme is deliberately isolated in this module so that CORRECTING IT COSTS ONE
 * FILE PLUS ITS TEST, and nothing else — no route change, no service change, no schema change.
 *
 * ── WHAT IS NON-NEGOTIABLE REGARDLESS OF THE EXACT SCHEME ─────────────────────────────────
 *
 *   · THE RAW BYTES, never a re-serialized body. `JSON.parse` + `JSON.stringify` reorders keys
 *     and normalises whitespace, so a re-serialized body verifies against nothing. That is why
 *     the route registers `fastify-raw-body` SCOPED (`global: false`, `encoding: false`).
 *   · `crypto.timingSafeEqual`, NEVER `===`. A byte-by-byte string compare leaks the position
 *     of the first mismatch through timing, which is enough to forge a signature offline.
 *     ⚠ `timingSafeEqual` THROWS on unequal lengths, so the length check must come first — and
 *     it is a length check on OUR OWN hex encoding, which carries no secret.
 *   · A FRESHNESS WINDOW on the timestamp, so a delivery captured off the wire cannot be
 *     replayed forever — the `daily_webhook_events` marker table only closes replays of events
 *     Balo has ALREADY SEEN, which is a different (and later) guarantee.
 *   · THE REASON GOES TO `log.warn` AS A FIELD; THE WIRE GETS `400` AND NOTHING ELSE. A caller
 *     who learns "stale timestamp" vs "bad signature" learns how to iterate.
 *
 * ⚠ NO LOGGING IN THIS MODULE, DELIBERATELY. It is pure and total: it returns a reason and the
 * ROUTE logs it. That is what makes the six-row unit test exhaustive without a logger mock.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/** The delivery timestamp, in unix SECONDS. Daily sends `X-Webhook-Timestamp`; Fastify lower-cases. */
export const DAILY_WEBHOOK_TIMESTAMP_HEADER = 'x-webhook-timestamp';

/** The BASE64 HMAC-SHA256 signature. Daily sends `X-Webhook-Signature`; Fastify lower-cases. */
export const DAILY_WEBHOOK_SIGNATURE_HEADER = 'x-webhook-signature';

/**
 * How far out of date a delivery's timestamp may be, in either direction.
 *
 * ⚠ SYMMETRIC ON PURPOSE. A FUTURE timestamp is just as suspicious as an old one — it is what
 * an attacker with a captured signature would send to buy themselves a long replay window if
 * only the past were bounded — and a few minutes of tolerance covers ordinary clock skew
 * between Daily's senders and Railway.
 */
export const DAILY_WEBHOOK_TOLERANCE_MS = 5 * 60_000;

/** Why a delivery was refused. A LOG field, never a wire value. */
export type DailyWebhookSignatureFailure =
  /** A required header was absent, empty, or sent more than once (an array). */
  | 'missing_header'
  /** The timestamp header was not a finite unix-seconds integer. */
  | 'malformed_timestamp'
  /** Outside {@link DAILY_WEBHOOK_TOLERANCE_MS} in either direction. */
  | 'stale_timestamp'
  /** The HMAC did not match — a forged body, a tampered timestamp, or the wrong secret. */
  | 'bad_signature';

export type DailyWebhookSignatureResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: DailyWebhookSignatureFailure };

/**
 * Read exactly one header value.
 *
 * ⚠ AN ARRAY IS A REFUSAL, NOT A "TAKE THE FIRST". A duplicated signature header is a request
 * SMUGGLING shape: an attacker who can make a proxy and the origin disagree about which copy
 * counts gets to have a valid signature verified against a body it does not cover. Refusing is
 * the only answer that cannot be exploited.
 */
function singleHeader(
  headers: Readonly<Record<string, string | string[] | undefined>>,
  name: string
): string | null {
  const value = headers[name];
  if (typeof value !== 'string' || value.trim().length === 0) {
    return null;
  }
  return value.trim();
}

/**
 * Constant-time equality over two base64 signature strings.
 *
 * ⚠ THE LENGTH CHECK IS FIRST BECAUSE `timingSafeEqual` THROWS on unequal-length buffers —
 * and it leaks nothing, because both operands are base64 encodings of a fixed-width digest, so
 * the only length that ever differs is an attacker's own.
 */
function signatureEquals(expected: string, provided: string): boolean {
  if (expected.length !== provided.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(provided, 'utf8'));
}

/**
 * Decode Daily's HMAC secret.
 *
 * ⚠ THE SECRET IS RETURNED BY DAILY BASE64-ENCODED when a webhook is created, and the HMAC is
 * computed over the DECODED BYTES. Treating the base64 TEXT as the key produces a signature
 * that never matches, on every delivery, with a perfectly healthy-looking `400` — so the
 * fallback below is deliberate: if the configured value is not valid base64, we use its raw
 * bytes rather than silently keying on a truncated decode.
 */
function secretKey(secret: string): Buffer {
  const decoded = Buffer.from(secret, 'base64');
  // `Buffer.from(x, 'base64')` never throws — it stops at the first invalid character. A
  // round-trip mismatch therefore means "this was not base64", and the raw bytes are the
  // honest reading.
  if (
    decoded.length > 0 &&
    stripBase64Padding(decoded.toString('base64')) === stripBase64Padding(secret)
  ) {
    return decoded;
  }
  return Buffer.from(secret, 'utf8');
}

/**
 * Drop trailing `=` padding, by a LINEAR SCAN.
 *
 * ⚠ NOT `/=+$/`, DELIBERATELY. That pattern is a super-linear-backtracking hotspot
 * (`regexp/no-super-linear-move`, the SonarCloud S5852 family): any string of `=` followed by a
 * rejecting suffix makes the engine retry from every start position — quadratic on input a
 * caller controls. Padding is at most two characters, so a scan is also simply the clearer
 * statement of what is meant.
 */
function stripBase64Padding(value: string): string {
  let end = value.length;
  while (end > 0 && value.charAt(end - 1) === '=') {
    end -= 1;
  }
  return value.slice(0, end);
}

/**
 * Verify one Daily webhook delivery against the RAW request bytes.
 *
 * @param rawBody the exact bytes Fastify received — never a re-serialized object.
 * @param headers the request headers, lower-cased by Fastify.
 * @param secret `DAILY_WEBHOOK_SECRET`. The caller must have proven it is set (a missing
 *   secret is a `503` outage, not a `400`) — this function never treats an empty secret as a
 *   pass.
 * @param now injected, so the freshness window is testable without faking the clock.
 */
export function verifyDailyWebhookSignature(
  rawBody: Buffer,
  headers: Readonly<Record<string, string | string[] | undefined>>,
  secret: string,
  now: Date
): DailyWebhookSignatureResult {
  if (secret.length === 0) {
    // Defensive: the route refuses before reaching here. An empty secret must never verify.
    return { ok: false, reason: 'missing_header' };
  }

  const timestamp = singleHeader(headers, DAILY_WEBHOOK_TIMESTAMP_HEADER);
  const provided = singleHeader(headers, DAILY_WEBHOOK_SIGNATURE_HEADER);
  if (timestamp === null || provided === null) {
    return { ok: false, reason: 'missing_header' };
  }

  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds) || !Number.isInteger(seconds)) {
    return { ok: false, reason: 'malformed_timestamp' };
  }

  // ⚠ FRESHNESS BEFORE HMAC, on purpose: it is the cheap check, and it means a replay flood
  // costs us a subtraction rather than a digest over an attacker-sized body.
  if (Math.abs(now.getTime() - seconds * 1000) > DAILY_WEBHOOK_TOLERANCE_MS) {
    return { ok: false, reason: 'stale_timestamp' };
  }

  // ⚠ THE TIMESTAMP IS INSIDE THE SIGNED STRING. That is what BINDS it to the body: without
  // it, an attacker could keep a captured (body, signature) pair valid forever simply by
  // sending a fresh timestamp header.
  const expected = createHmac('sha256', secretKey(secret))
    .update(`${timestamp}.`)
    .update(rawBody)
    .digest('base64');

  if (!signatureEquals(expected, provided)) {
    return { ok: false, reason: 'bad_signature' };
  }
  return { ok: true };
}

/**
 * Produce a valid signature header pair for a body — **TEST AND OPS TOOLING ONLY**.
 *
 * ⚠ EXPORTED DELIBERATELY, and it grants nothing: signing requires the secret, which anybody
 * calling this already holds. It exists so `webhook.test.ts` and `webhook-signature.test.ts`
 * exercise the REAL verifier against a REAL signature instead of stubbing the one function
 * whose correctness is the whole point of the module. Nothing in `src/routes` imports it.
 */
export function signDailyWebhookForTest(
  rawBody: Buffer,
  secret: string,
  now: Date
): Record<string, string> {
  const timestamp = String(Math.floor(now.getTime() / 1000));
  const signature = createHmac('sha256', secretKey(secret))
    .update(`${timestamp}.`)
    .update(rawBody)
    .digest('base64');
  return {
    [DAILY_WEBHOOK_TIMESTAMP_HEADER]: timestamp,
    [DAILY_WEBHOOK_SIGNATURE_HEADER]: signature,
  };
}
