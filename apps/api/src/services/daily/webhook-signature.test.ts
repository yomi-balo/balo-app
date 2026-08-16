import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  DAILY_WEBHOOK_SIGNATURE_HEADER,
  DAILY_WEBHOOK_TIMESTAMP_HEADER,
  DAILY_WEBHOOK_TOLERANCE_MS,
  signDailyWebhookForTest,
  verifyDailyWebhookSignature,
} from './webhook-signature.js';

/** A realistic Daily secret: base64, as the vendor returns it from `POST /v1/webhooks`. */
const SECRET = Buffer.from('a-32-byte-daily-webhook-secret!!').toString('base64');
const NOW = new Date('2026-08-14T10:00:00.000Z');
const BODY = Buffer.from(
  JSON.stringify({ id: 'evt_1', type: 'participant.joined', payload: { room: 'balo-abc' } })
);

function headersFor(body = BODY, secret = SECRET, signedAt = NOW): Record<string, string> {
  return signDailyWebhookForTest(body, secret, signedAt);
}

describe('verifyDailyWebhookSignature (BAL-134 §5.2)', () => {
  it('accepts a delivery signed with the configured secret over the RAW bytes', () => {
    expect(verifyDailyWebhookSignature(BODY, headersFor(), SECRET, NOW)).toEqual({ ok: true });
  });

  /**
   * ⚠⚠ THE ENCODING PIN — AND THE ONE ASSERTION EVERY OTHER TEST HERE IS BLIND TO.
   *
   * Daily emits a BASE64 HMAC-SHA256 signature (verified against
   * `docs.daily.co/reference/rest-api/webhooks`, 2026-08-15). An earlier draft of this module
   * computed a HEX digest, under which every genuine delivery fails with a healthy-looking
   * `400` — presence is never written, both clocks stay at zero, and the feature is silently
   * dead in production with nothing to page on.
   *
   * ⚠ EVERY OTHER TEST IN THIS FILE ROUND-TRIPS `signDailyWebhookForTest` → `verify`, AND A
   * ROUND-TRIP PASSES UNDER EITHER ENCODING — both sides would simply agree on the wrong one.
   * So this asserts against a FIXED VECTOR computed independently of the module: the exact
   * base64 digest, and that it is NOT the hex form. Without this, the bug ships green.
   */
  it('⚠ produces a BASE64 digest, not hex — pinned against an independent fixed vector', () => {
    const timestamp = String(Math.floor(NOW.getTime() / 1000));
    const key = Buffer.from(SECRET, 'base64');
    const expectedBase64 = createHmac('sha256', key)
      .update(`${timestamp}.`)
      .update(BODY)
      .digest('base64');
    const hexForm = createHmac('sha256', key).update(`${timestamp}.`).update(BODY).digest('hex');

    const signature = headersFor()[DAILY_WEBHOOK_SIGNATURE_HEADER];

    expect(signature).toBe(expectedBase64);
    expect(signature).not.toBe(hexForm);
    // Base64 of a 32-byte digest is 44 chars with padding; hex would be 64.
    expect(signature).toHaveLength(44);
    expect(signature).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });

  /**
   * ⚠⚠ THE PROPERTY THAT MATTERS MOST. `JSON.parse` + `JSON.stringify` reorders keys and
   * normalises whitespace, so a re-serialized body verifies against NOTHING. This asserts that
   * a body differing only in key ORDER — same object, different bytes — is refused, which is
   * what makes the scoped `fastify-raw-body` registration load-bearing rather than decorative.
   */
  it('⚠ refuses a re-serialized body whose bytes differ only in key order', () => {
    const reordered = Buffer.from(
      JSON.stringify({ type: 'participant.joined', id: 'evt_1', payload: { room: 'balo-abc' } })
    );
    expect(reordered.equals(BODY)).toBe(false);

    expect(verifyDailyWebhookSignature(reordered, headersFor(), SECRET, NOW)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('refuses a TAMPERED body', () => {
    const tampered = Buffer.from(
      JSON.stringify({ id: 'evt_1', type: 'meeting.ended', payload: { room: 'balo-abc' } })
    );
    expect(verifyDailyWebhookSignature(tampered, headersFor(), SECRET, NOW)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  /**
   * ⚠ THE TIMESTAMP IS INSIDE THE SIGNED STRING. Without that binding, a captured
   * (body, signature) pair would stay valid forever behind a freshly-minted timestamp header.
   */
  it('⚠ refuses a delivery whose timestamp header was swapped for a fresh one', () => {
    const headers = {
      ...headersFor(),
      [DAILY_WEBHOOK_TIMESTAMP_HEADER]: String(Math.floor(NOW.getTime() / 1000) + 1),
    };
    expect(verifyDailyWebhookSignature(BODY, headers, SECRET, NOW)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('refuses the WRONG secret', () => {
    const other = Buffer.from('a-different-32-byte-daily-secret!').toString('base64');
    expect(verifyDailyWebhookSignature(BODY, headersFor(BODY, other), SECRET, NOW)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('refuses an EMPTY configured secret rather than treating it as a pass', () => {
    expect(verifyDailyWebhookSignature(BODY, headersFor(), '', NOW).ok).toBe(false);
  });

  // ── HEADERS ─────────────────────────────────────────────────────────────────────────────

  const MISSING: ReadonlyArray<{ label: string; headers: Record<string, unknown> }> = [
    { label: 'no headers at all', headers: {} },
    { label: 'signature only', headers: { [DAILY_WEBHOOK_SIGNATURE_HEADER]: 'abc' } },
    { label: 'timestamp only', headers: { [DAILY_WEBHOOK_TIMESTAMP_HEADER]: '1' } },
    {
      label: 'blank signature',
      headers: { [DAILY_WEBHOOK_TIMESTAMP_HEADER]: '1', [DAILY_WEBHOOK_SIGNATURE_HEADER]: '   ' },
    },
  ];

  it.each(MISSING)('missing_header — $label', ({ headers }) => {
    expect(
      verifyDailyWebhookSignature(
        BODY,
        headers as Record<string, string | string[] | undefined>,
        SECRET,
        NOW
      )
    ).toEqual({ ok: false, reason: 'missing_header' });
  });

  /**
   * ⚠ A DUPLICATED HEADER IS A REFUSAL, NOT A "TAKE THE FIRST". It is a request-smuggling
   * shape: an attacker who makes a proxy and the origin disagree about which copy counts gets a
   * valid signature verified against a body it does not cover.
   */
  it('⚠ refuses a DUPLICATED signature header rather than taking the first', () => {
    const valid = headersFor();
    const timestamp = valid[DAILY_WEBHOOK_TIMESTAMP_HEADER];
    const signature = valid[DAILY_WEBHOOK_SIGNATURE_HEADER];
    if (timestamp === undefined || signature === undefined) {
      throw new Error('the signer must produce both headers');
    }

    expect(
      verifyDailyWebhookSignature(
        BODY,
        {
          [DAILY_WEBHOOK_TIMESTAMP_HEADER]: timestamp,
          [DAILY_WEBHOOK_SIGNATURE_HEADER]: [signature, 'forged'],
        },
        SECRET,
        NOW
      )
    ).toEqual({ ok: false, reason: 'missing_header' });
  });

  // ── FRESHNESS ───────────────────────────────────────────────────────────────────────────

  const MALFORMED_TIMESTAMPS = ['not-a-number', '', '  ', '1.5', 'Infinity', 'NaN'];

  it.each(MALFORMED_TIMESTAMPS)('malformed timestamp (%s) is refused', (raw) => {
    const headers = { ...headersFor(), [DAILY_WEBHOOK_TIMESTAMP_HEADER]: raw };
    const result = verifyDailyWebhookSignature(BODY, headers, SECRET, NOW);
    expect(result.ok).toBe(false);
    // A blank / whitespace value reads as ABSENT; anything else is a malformed number.
    expect(result).toEqual({
      ok: false,
      reason: raw.trim().length === 0 ? 'missing_header' : 'malformed_timestamp',
    });
  });

  it('accepts a delivery exactly at the tolerance boundary, in both directions', () => {
    const old = new Date(NOW.getTime() - DAILY_WEBHOOK_TOLERANCE_MS);
    const future = new Date(NOW.getTime() + DAILY_WEBHOOK_TOLERANCE_MS);

    expect(verifyDailyWebhookSignature(BODY, headersFor(BODY, SECRET, old), SECRET, NOW)).toEqual({
      ok: true,
    });
    expect(
      verifyDailyWebhookSignature(BODY, headersFor(BODY, SECRET, future), SECRET, NOW)
    ).toEqual({ ok: true });
  });

  it('refuses a STALE delivery — a captured body cannot be replayed forever', () => {
    const old = new Date(NOW.getTime() - DAILY_WEBHOOK_TOLERANCE_MS - 1000);
    expect(verifyDailyWebhookSignature(BODY, headersFor(BODY, SECRET, old), SECRET, NOW)).toEqual({
      ok: false,
      reason: 'stale_timestamp',
    });
  });

  /**
   * ⚠ THE WINDOW IS SYMMETRIC. A future timestamp is exactly what an attacker with a captured
   * signature would send to buy a long replay window if only the past were bounded.
   */
  it('⚠ refuses a FUTURE delivery beyond the tolerance, not just an old one', () => {
    const future = new Date(NOW.getTime() + DAILY_WEBHOOK_TOLERANCE_MS + 1000);
    expect(
      verifyDailyWebhookSignature(BODY, headersFor(BODY, SECRET, future), SECRET, NOW)
    ).toEqual({ ok: false, reason: 'stale_timestamp' });
  });

  it('checks freshness BEFORE the HMAC — a stale delivery reports staleness, not a bad signature', () => {
    const old = new Date(NOW.getTime() - 60 * 60_000);
    const headers = {
      ...headersFor(BODY, SECRET, old),
      [DAILY_WEBHOOK_SIGNATURE_HEADER]: 'deadbeef',
    };
    expect(verifyDailyWebhookSignature(BODY, headers, SECRET, NOW)).toEqual({
      ok: false,
      reason: 'stale_timestamp',
    });
  });

  // ── SECRET ENCODING ─────────────────────────────────────────────────────────────────────

  /**
   * ⚠ DAILY RETURNS THE HMAC SECRET BASE64-ENCODED, and the HMAC is over the DECODED BYTES.
   * Keying on the base64 TEXT produces a signature that never matches, on every delivery, with
   * a perfectly healthy-looking `400`.
   */
  it('⚠ keys on the DECODED secret bytes for a base64 secret', () => {
    const raw = Buffer.from('a-32-byte-daily-webhook-secret!!');
    const headers = signDailyWebhookForTest(BODY, raw.toString('base64'), NOW);
    expect(verifyDailyWebhookSignature(BODY, headers, raw.toString('base64'), NOW)).toEqual({
      ok: true,
    });
  });

  it('falls back to the raw bytes for a secret that is not valid base64', () => {
    const plain = 'not base64 !!!';
    expect(
      verifyDailyWebhookSignature(BODY, signDailyWebhookForTest(BODY, plain, NOW), plain, NOW)
    ).toEqual({ ok: true });
  });
});
