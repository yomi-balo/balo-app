import { afterEach, beforeEach, vi } from 'vitest';
import { resetMuxClientForTest } from '../../services/mux/client.js';

/**
 * Mux REST test scaffolding (BAL-473) — sibling of `test/mocks/daily.ts`. Extracted for the
 * same reason: `assets.test.ts` and any future Mux-SDK-backed suite otherwise carry a
 * byte-identical env-restore block, which is exactly the cross-file duplication SonarCloud's
 * gate flags, and it is also two places to forget to restore a var, which would leak a fake
 * token into an unrelated suite.
 *
 * Usage:
 *
 *   import { useMuxEnv, jsonResponse, TEST_MUX_TOKEN_ID, TEST_MUX_TOKEN_SECRET } from '../../test/mocks/mux';
 *   useMuxEnv();
 */

export const TEST_MUX_TOKEN_ID = 'test-mux-token-id';
export const TEST_MUX_TOKEN_SECRET = 'test-mux-token-secret';
export const TEST_MUX_WEBHOOK_SECRET = 'test-mux-webhook-secret';
export const TEST_MUX_SIGNING_KEY_ID = 'test-mux-signing-key-id';
/** A syntactically-plausible base64 PEM stand-in — signature suites bring their own real key. */
export const TEST_MUX_SIGNING_KEY_PRIVATE = Buffer.from(
  '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----'
).toString('base64');

const MUX_ENV_KEYS = [
  'MUX_TOKEN_ID',
  'MUX_TOKEN_SECRET',
  'MUX_WEBHOOK_SECRET',
  'MUX_SIGNING_KEY_ID',
  'MUX_SIGNING_KEY_PRIVATE',
] as const;

/**
 * A minimal `Response` stand-in — mirrors `test/mocks/daily.ts`'s `jsonResponse`, only the
 * members the SDK's fetch call touches.
 */
export function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/**
 * Install all five `MUX_*` vars before each test and restore the ambient values (or their
 * absence) after, along with un-stubbing any `fetch` global the test replaced and resetting
 * the cached Mux client so a later test's env change is actually picked up.
 */
export function useMuxEnv(): void {
  const originals: Partial<Record<(typeof MUX_ENV_KEYS)[number], string | undefined>> = {};

  beforeEach(() => {
    for (const key of MUX_ENV_KEYS) {
      originals[key] = process.env[key];
    }
    process.env.MUX_TOKEN_ID = TEST_MUX_TOKEN_ID;
    process.env.MUX_TOKEN_SECRET = TEST_MUX_TOKEN_SECRET;
    process.env.MUX_WEBHOOK_SECRET = TEST_MUX_WEBHOOK_SECRET;
    process.env.MUX_SIGNING_KEY_ID = TEST_MUX_SIGNING_KEY_ID;
    process.env.MUX_SIGNING_KEY_PRIVATE = TEST_MUX_SIGNING_KEY_PRIVATE;
    resetMuxClientForTest();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const key of MUX_ENV_KEYS) {
      const original = originals[key];
      if (original === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = original;
      }
    }
    resetMuxClientForTest();
  });
}
