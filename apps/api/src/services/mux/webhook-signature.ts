/**
 * BAL-473 (OD-5) — MUX WEBHOOK SIGNATURE VERIFICATION, IN **ONE** MODULE. Mirrors
 * `services/daily/webhook-signature.ts`'s shape and discipline — a vendor correction costs one
 * file plus its test, and nothing else.
 *
 * ✅ VERIFIED (orchestrator, WebFetch, OD-5): `Mux-Signature: t=<unix_seconds>,v1=<hex>`,
 * HMAC-SHA256 over `` `${t}.${rawBody}` ``, 5-minute default tolerance.
 *
 * ── ⚠⚠ EXACTLY WHERE THIS DIFFERS FROM THE DAILY MODULE — THE HIGHEST-RISK LINE IN THIS PR ──
 *
 *   |                  | Daily                                    | Mux                                        |
 *   | ---------------- | ----------------------------------------- | ------------------------------------------- |
 *   | Headers          | two: `x-webhook-timestamp` + `-signature`  | ONE: `mux-signature`, `t=` is INSIDE it      |
 *   | Secret handling  | base64-encoded; DECODED to raw bytes first | plain string, keyed AS-IS. Do NOT decode     |
 *   | Digest encoding  | BASE64                                     | HEX                                          |
 *
 * ⚠⚠ THE HEX/BASE64 DIFFERENCE IS THE SINGLE HIGHEST-RISK LINE IN THIS PR. A hex digest on the
 * Daily side failed EVERY genuine delivery with a healthy-looking `400` and nothing paged. A
 * SIGN-THEN-VERIFY ROUND-TRIP TEST PASSES UNDER EITHER ENCODING — `webhook-signature.test.ts`
 * pins a FIXED HEX VECTOR for exactly this reason; a round-trip alone would ship the bug.
 *
 * ── WHY THIS MODULE DOES ITS OWN FRESHNESS CHECK RATHER THAN TRUSTING THE SDK'S ─────────────
 *
 * `@mux/mux-node`'s `Webhooks.verifySignature` DOES enforce a tolerance, but (a) it reads
 * `Date.now()` DIRECTLY — an injected `now` cannot reach it, which would make this module's own
 * tests non-deterministic — and (b) it is ONE-DIRECTIONAL (rejects only a STALE timestamp, never
 * a FUTURE one), unlike Daily's symmetric window. So this module parses `t=` itself and runs a
 * SYMMETRIC, INJECTABLE check FIRST (the cheap check, before any HMAC work), then delegates the
 * actual signature computation to the SDK — OD-5's "use the SDK for verification", applied to
 * the one thing it verifies correctly.
 *
 * ⚠ NO LOGGING IN THIS MODULE, DELIBERATELY. It is pure and total: it returns a reason and the
 * ROUTE logs it — the Daily module's discipline, restated.
 *
 * ⚠ DEVIATION FROM PLAN §8.5'S LITERAL (SYNCHRONOUS) SIGNATURE, MADE DELIBERATELY:
 * `Webhooks.verifySignature` uses `globalThis.crypto.subtle` (WebCrypto), which is inherently
 * ASYNC — there is no synchronous path through the SDK's HMAC computation. OD-5 mandates using
 * the SDK for verification; a synchronous wrapper would require hand-rolling the HMAC instead,
 * which is the exact risk OD-5 exists to avoid. `verifyMuxWebhookSignature` is therefore
 * `Promise<MuxWebhookSignatureResult>`; every call site already runs inside an async Fastify
 * handler, so this costs nothing at the call site.
 */
import { createHmac } from 'node:crypto';
import Mux from '@mux/mux-node';

/** Mux sends exactly one header; the timestamp is INSIDE it (unlike Daily's two headers). */
export const MUX_WEBHOOK_SIGNATURE_HEADER = 'mux-signature';

/** Symmetric, either direction — the Daily module's `DAILY_WEBHOOK_TOLERANCE_MS`, restated in seconds. */
export const MUX_WEBHOOK_TOLERANCE_SECONDS = 300;

/** Why a delivery was refused. A LOG field, never a wire value. */
export type MuxWebhookSignatureFailure =
  /** The header was absent, empty, or sent more than once (an array) — a refusal, never "take the first". */
  | 'missing_header'
  /** The header did not parse into a `t=`/`v1=` pair. */
  | 'malformed_signature'
  /** Outside {@link MUX_WEBHOOK_TOLERANCE_SECONDS} in either direction. */
  | 'stale_timestamp'
  /** The HMAC did not match — a forged body, a tampered timestamp, or the wrong secret. */
  | 'bad_signature';

export type MuxWebhookSignatureResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: MuxWebhookSignatureFailure };

/**
 * Read exactly one header value.
 *
 * ⚠ AN ARRAY IS A REFUSAL, NOT A "TAKE THE FIRST" — the Daily module's `singleHeader`,
 * verbatim reasoning: a duplicated signature header is a request-smuggling shape, and refusing
 * is the only answer that cannot be exploited.
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
 * Parse `t=<seconds>,v1=<hex>[,v1=<hex>...]` (Mux allows multiple `v1` entries during secret
 * rotation) into the timestamp this module needs for its OWN freshness check. Does not
 * validate the hex signature itself — the SDK does that.
 *
 * ⚠⚠ FIX ROUND 1 (F5) — A HEADER WITH MORE THAN ONE `t=` IS A REFUSAL, NOT "TAKE THE FIRST".
 * Balo's own scan below always returned the FIRST `t=`, while `@mux/mux-node`'s
 * `parseHeader` reduce keeps the LAST — so `t=<fresh>,t=<old>,v1=<sig over old>` had its
 * freshness checked against the fresh value while the HMAC the SDK computes covers the OLD
 * one, defeating the freshness window via header smuggling. This is `singleHeader`'s "an array
 * header is a refusal" posture, restated for a value smuggled INSIDE one header rather than
 * duplicated across two.
 */
function parseTimestamp(header: string): number | null {
  let value: number | null = null;
  let count = 0;
  for (const part of header.split(',')) {
    const eq = part.indexOf('=');
    if (eq === -1) {
      continue;
    }
    const key = part.slice(0, eq).trim();
    const raw = part.slice(eq + 1).trim();
    if (key === 't' && raw.length > 0) {
      count += 1;
      if (count === 1) {
        const parsed = Number(raw);
        value = Number.isFinite(parsed) ? parsed : null;
      }
    }
  }
  return count > 1 ? null : value;
}

/** `true` when the header names at least one `v1=` signature. */
function hasV1Signature(header: string): boolean {
  return header.split(',').some((part) => {
    const eq = part.indexOf('=');
    return eq !== -1 && part.slice(0, eq).trim() === 'v1' && part.slice(eq + 1).trim().length > 0;
  });
}

/**
 * A THROWAWAY SDK CLIENT FOR SIGNATURE VERIFICATION ONLY. `Webhooks.verifySignature` needs no
 * API token — deliberately NOT `getMuxClient()`, so this module works even when
 * `MUX_TOKEN_ID`/`MUX_TOKEN_SECRET` are unset but `MUX_WEBHOOK_SECRET` is set (each of the five
 * `MUX_*` vars has an INDEPENDENT absent-key behaviour — see `.env.example`). Constructing a
 * `Mux` client never throws (verified: the SDK constructor has no validation), so this is safe
 * to call unconditionally.
 */
function verificationClient(): Mux {
  return new Mux({ tokenId: null, tokenSecret: null });
}

/**
 * Verify one Mux webhook delivery against the RAW request bytes.
 *
 * @param rawBody the exact bytes Fastify received.
 * @param headers the request headers, lower-cased by Fastify.
 * @param secret `MUX_WEBHOOK_SECRET` — a PLAIN STRING, keyed AS-IS (⚠ do NOT base64-decode,
 *   unlike Daily's secret). The caller must have proven it is set (a missing secret is a `503`
 *   outage, not a `400`) — this function never treats an empty secret as a pass.
 * @param now injected, so the freshness window is testable without faking the clock.
 */
export async function verifyMuxWebhookSignature(
  rawBody: Buffer,
  headers: Readonly<Record<string, string | string[] | undefined>>,
  secret: string,
  now: Date
): Promise<MuxWebhookSignatureResult> {
  if (secret.length === 0) {
    // Defensive: the route refuses before reaching here. An empty secret must never verify.
    return { ok: false, reason: 'missing_header' };
  }

  const header = singleHeader(headers, MUX_WEBHOOK_SIGNATURE_HEADER);
  if (header === null) {
    return { ok: false, reason: 'missing_header' };
  }

  const timestamp = parseTimestamp(header);
  if (timestamp === null || !hasV1Signature(header)) {
    return { ok: false, reason: 'malformed_signature' };
  }

  // ⚠ FRESHNESS BEFORE THE SDK CALL, on purpose — the cheap check first, and it is what makes
  // this module's freshness window SYMMETRIC and INJECTABLE where the SDK's own is neither.
  const ageSeconds = Math.abs(now.getTime() / 1000 - timestamp);
  if (ageSeconds > MUX_WEBHOOK_TOLERANCE_SECONDS) {
    return { ok: false, reason: 'stale_timestamp' };
  }

  try {
    await verificationClient().webhooks.verifySignature(
      rawBody.toString('utf8'),
      { [MUX_WEBHOOK_SIGNATURE_HEADER]: header },
      secret
    );
    return { ok: true };
  } catch {
    // Header shape and freshness are already proven above, so a throw here is the SDK's own
    // HMAC mismatch — a forged body, a tampered timestamp, or the wrong secret.
    return { ok: false, reason: 'bad_signature' };
  }
}

/**
 * Produce a valid `mux-signature` header for a body — **TEST AND OPS TOOLING ONLY**.
 *
 * ⚠ EXPORTED DELIBERATELY, and it grants nothing: signing requires the secret, which anybody
 * calling this already holds. It HAND-ROLLS the HMAC (that is the point of a fixed-vector test
 * elsewhere in this suite) rather than reusing the SDK, so `webhook-signature.test.ts`'s
 * round-trip proves this signer and the SDK's verifier independently agree.
 */
export function signMuxWebhookForTest(
  rawBody: Buffer,
  secret: string,
  now: Date
): Record<string, string> {
  const timestamp = String(Math.floor(now.getTime() / 1000));
  const signature = createHmac('sha256', secret)
    .update(`${timestamp}.`)
    .update(rawBody)
    .digest('hex');
  return { [MUX_WEBHOOK_SIGNATURE_HEADER]: `t=${timestamp},v1=${signature}` };
}
