import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MUX_WEBHOOK_SIGNATURE_HEADER,
  MUX_WEBHOOK_TOLERANCE_SECONDS,
  signMuxWebhookForTest,
  verifyMuxWebhookSignature,
} from './webhook-signature.js';

/**
 * Mux's own webhook secret shape: a plain string, keyed AS-IS (never base64-decoded).
 *
 * ⚠⚠ FIX ROUND 1 (F9) — CONTAINS `!`, a character outside the base64 alphabet, DELIBERATELY.
 * The original `'whsec_test_secret_1'` happened to be tolerant-decodable as base64 (Node's
 * `base64` decoding treats `_` as URL-safe `/`), so grafting Daily's base64-decoding
 * `secretKey()` helper into this signer — the single most likely real regression, a copy-paste
 * from the neighbouring module — left every test in this file green. A secret an eager
 * `Buffer.from(secret, 'base64')` cannot round-trip is what turns that graft into a signature
 * mismatch instead of a silent pass.
 */
const SECRET = 'whsec_test_secret_1!';
const NOW = new Date('2023-11-14T22:13:20.000Z'); // unix 1_700_000_000
const BODY = Buffer.from('{"type":"video.asset.ready","id":"evt_1"}');

function headersFor(body = BODY, secret = SECRET, signedAt = NOW): Record<string, string> {
  return signMuxWebhookForTest(body, secret, signedAt);
}

/**
 * ⚠ THE SDK'S `Webhooks.verifySignature` READS `Date.now()` DIRECTLY (verified: it is not an
 * injectable parameter anywhere in `@mux/mux-node@15.0.0`). `verifyMuxWebhookSignature`'s OWN
 * symmetric freshness check runs FIRST and is what this module's `now` parameter actually
 * governs — but a delivery this module accepts must ALSO clear the SDK's own (real-clock)
 * check, or every "accepts" case here would be flaky against the wall clock. Fake timers pin
 * `Date.now()` to `NOW` so both checks agree deterministically.
 */
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('verifyMuxWebhookSignature (BAL-473 §8.5)', () => {
  it('accepts a delivery signed with the configured secret over the RAW bytes', async () => {
    await expect(verifyMuxWebhookSignature(BODY, headersFor(), SECRET, NOW)).resolves.toEqual({
      ok: true,
    });
  });

  /**
   * ⚠⚠ THE FIXED HEX VECTOR — THE HIGHEST-VALUE ASSERTION IN THIS SUITE. Computed INDEPENDENTLY
   * of this module (a literal expected hex string, not a call to `signMuxWebhookForTest`), so a
   * regression to base64 (Daily's encoding) or any other digest shape fails loudly. A
   * sign-then-verify ROUND TRIP passes under either encoding — this is what a round trip alone
   * cannot catch.
   */
  it('⚠⚠ produces the exact HEX digest — pinned against an independent fixed vector', () => {
    const header = headersFor()[MUX_WEBHOOK_SIGNATURE_HEADER];
    expect(header).toBe(
      't=1700000000,v1=379f475df8f6cc81cf5a3f1af11182cf8855d31ef08b03cf0e161162679e3757'
    );
  });

  it('a round-trip through signMuxWebhookForTest and the SDK verifier agree', async () => {
    const body = Buffer.from('{"type":"video.asset.errored","id":"evt_2"}');
    const result = await verifyMuxWebhookSignature(body, headersFor(body), SECRET, NOW);
    expect(result).toEqual({ ok: true });
  });

  /**
   * ⚠ A RE-SERIALIZED BODY (pretty-printed with extra whitespace, then round-tripped through
   * `JSON.parse`/`JSON.stringify`) MUST FAIL — proof the module verifies the RAW BYTES it was
   * handed, never a re-serialization. A whitespace-insensitive comparison here would silently
   * accept a body that was never signed.
   */
  it('rejects a body that was re-serialized through JSON (whitespace changed)', async () => {
    const pretty = Buffer.from('{\n  "type": "video.asset.ready",\n  "id": "evt_1"\n}');
    const headers = headersFor(pretty);
    const reserialized = Buffer.from(JSON.stringify(JSON.parse(pretty.toString('utf8'))));

    expect(reserialized.equals(pretty)).toBe(false);
    const result = await verifyMuxWebhookSignature(reserialized, headers, SECRET, NOW);
    expect(result).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects a missing mux-signature header', async () => {
    const result = await verifyMuxWebhookSignature(BODY, {}, SECRET, NOW);
    expect(result).toEqual({ ok: false, reason: 'missing_header' });
  });

  it('rejects a BLANK mux-signature header', async () => {
    const result = await verifyMuxWebhookSignature(
      BODY,
      { [MUX_WEBHOOK_SIGNATURE_HEADER]: '   ' },
      SECRET,
      NOW
    );
    expect(result).toEqual({ ok: false, reason: 'missing_header' });
  });

  /**
   * ⚠⚠ A DUPLICATED (ARRAY) HEADER IS A REFUSAL, NOT "TAKE THE FIRST" — the request-smuggling
   * shape; copies `singleHeader`'s reasoning from the Daily module verbatim.
   */
  it('⚠⚠ rejects a DUPLICATED mux-signature header (an array) rather than taking the first', async () => {
    const valid = headersFor()[MUX_WEBHOOK_SIGNATURE_HEADER];
    const result = await verifyMuxWebhookSignature(
      BODY,
      { [MUX_WEBHOOK_SIGNATURE_HEADER]: [valid as string, valid as string] },
      SECRET,
      NOW
    );
    expect(result).toEqual({ ok: false, reason: 'missing_header' });
  });

  it('rejects a header with no `t=`', async () => {
    const result = await verifyMuxWebhookSignature(
      BODY,
      { [MUX_WEBHOOK_SIGNATURE_HEADER]: 'v1=deadbeef' },
      SECRET,
      NOW
    );
    expect(result).toEqual({ ok: false, reason: 'malformed_signature' });
  });

  it('rejects a header with no `v1=`', async () => {
    const result = await verifyMuxWebhookSignature(
      BODY,
      { [MUX_WEBHOOK_SIGNATURE_HEADER]: 't=1700000000' },
      SECRET,
      NOW
    );
    expect(result).toEqual({ ok: false, reason: 'malformed_signature' });
  });

  /**
   * ⚠⚠ FIX ROUND 1 (F5) — DUPLICATE-`t=` HEADER SMUGGLING, THE FUTURE DIRECTION. Balo's own
   * `parseTimestamp` used to return the FIRST `t=`; the Mux SDK's `parseHeader` reduce keeps
   * the LAST — so a header naming a FRESH `t=` first and a FAR-FUTURE `t=` second has its
   * freshness checked against the fresh value while the HMAC the SDK recomputes covers the
   * future one. The SDK's own tolerance check is ONE-DIRECTIONAL (`timestampAge > tolerance`,
   * which a NEGATIVE age — a future timestamp — never satisfies), so nothing catches this
   * direction except this module's own refusal. Before the fix this resolved `{ ok: true }` —
   * a signature that will keep verifying for as long as the attacker likes, defeating the
   * freshness window entirely.
   */
  it('⚠⚠ rejects a header with TWO `t=` values — the future-direction smuggling bypass', async () => {
    const future = Math.floor(NOW.getTime() / 1000) + MUX_WEBHOOK_TOLERANCE_SECONDS + 100;
    const futureHeader = headersFor(BODY, SECRET, new Date(future * 1000))[
      MUX_WEBHOOK_SIGNATURE_HEADER
    ] as string;
    const futureSig = futureHeader.split(',v1=')[1];
    const freshFirst = Math.floor(NOW.getTime() / 1000);
    const smuggled = `t=${freshFirst},t=${future},v1=${futureSig}`;

    const result = await verifyMuxWebhookSignature(
      BODY,
      { [MUX_WEBHOOK_SIGNATURE_HEADER]: smuggled },
      SECRET,
      NOW
    );

    expect(result).toEqual({ ok: false, reason: 'malformed_signature' });
  });

  it('rejects a non-numeric `t=`', async () => {
    const result = await verifyMuxWebhookSignature(
      BODY,
      { [MUX_WEBHOOK_SIGNATURE_HEADER]: 't=nonsense,v1=deadbeef' },
      SECRET,
      NOW
    );
    expect(result).toEqual({ ok: false, reason: 'malformed_signature' });
  });

  /** ⚠ SYMMETRIC — a timestamp too far in the PAST is refused. */
  it('rejects a STALE (too old) timestamp', async () => {
    const staleAt = new Date(NOW.getTime() - (MUX_WEBHOOK_TOLERANCE_SECONDS + 1) * 1000);
    const result = await verifyMuxWebhookSignature(
      BODY,
      headersFor(BODY, SECRET, staleAt),
      SECRET,
      NOW
    );
    expect(result).toEqual({ ok: false, reason: 'stale_timestamp' });
  });

  /** ⚠ SYMMETRIC — a timestamp too far in the FUTURE is ALSO refused (unlike the SDK's own one-directional check). */
  it('⚠ rejects a timestamp too far in the FUTURE — symmetric, unlike the SDK default', async () => {
    const futureAt = new Date(NOW.getTime() + (MUX_WEBHOOK_TOLERANCE_SECONDS + 1) * 1000);
    const result = await verifyMuxWebhookSignature(
      BODY,
      headersFor(BODY, SECRET, futureAt),
      SECRET,
      NOW
    );
    expect(result).toEqual({ ok: false, reason: 'stale_timestamp' });
  });

  it('accepts a timestamp exactly at the tolerance boundary', async () => {
    const boundary = new Date(NOW.getTime() - MUX_WEBHOOK_TOLERANCE_SECONDS * 1000);
    const result = await verifyMuxWebhookSignature(
      BODY,
      headersFor(BODY, SECRET, boundary),
      SECRET,
      NOW
    );
    expect(result).toEqual({ ok: true });
  });

  it('rejects the wrong secret', async () => {
    const result = await verifyMuxWebhookSignature(
      BODY,
      headersFor(BODY, 'whsec_wrong_secret'),
      SECRET,
      NOW
    );
    expect(result).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects a tampered body', async () => {
    const tampered = Buffer.from('{"type":"video.asset.ready","id":"evt_1_tampered"}');
    const result = await verifyMuxWebhookSignature(tampered, headersFor(), SECRET, NOW);
    expect(result).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects an empty configured secret without ever reporting a pass', async () => {
    const result = await verifyMuxWebhookSignature(BODY, headersFor(), '', NOW);
    expect(result).toEqual({ ok: false, reason: 'missing_header' });
  });
});
