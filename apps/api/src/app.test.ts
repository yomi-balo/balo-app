import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';

// A REAL pino instance, transport-free so no worker threads leak into the test run. It must be
// real: the defect this file pins is Fastify 5 rejecting a genuine logger INSTANCE passed under
// `logger` (FST_ERR_LOG_INVALID_LOGGER_CONFIG) — a plain object of vi.fn()s would not trigger
// Fastify's validation and the test would prove nothing.
const sharedWrites: string[] = [];
vi.mock('@balo/shared/logging', () => {
  const instance = pino(
    { level: 'info' },
    { write: (line: string) => void sharedWrites.push(line) }
  );
  return {
    log: instance,
    createLogger: (context: string) => instance.child({ context }),
  };
});

import { ACCOUNT_REFUSAL_HEADER } from '@balo/shared/authz';
import { RATE_LIMIT_CHECK_PATH } from '@balo/shared/rate-limit';
import { buildApp } from './app.js';

/**
 * `buildApp()` WITH NO OPTIONS is the production boot path — `index.ts` calls it bare, above
 * its try/catch, so a throw here is an unhandled rejection at startup: a Railway crash loop.
 *
 * That is exactly what shipped once: the shared pino instance was passed as `logger`, which
 * Fastify 5 rejects outright, and every test in the repo passed `logger: false` — so CI was
 * fully green on an API that could not boot. Review caught it; this file makes the default
 * path a tested path.
 */
describe('buildApp', () => {
  it('boots with NO options — the production entrypoint path', async () => {
    const app = await buildApp();
    // Reaching here means Fastify() accepted the config; assert the app is genuinely usable.
    expect(app.log).toBeDefined();
    await app.close();
  });

  it('runs Fastify ON the shared logger, keeping request logs on the Axiom pipeline', async () => {
    // Behavioural, not identity: Fastify children the instance, so `app.log` is not `===` the
    // shared logger — but everything it writes must land in the shared logger's stream. A
    // `logger: true` regression would boot fine while silently forking request logs off the
    // shared (Axiom + redaction) pipeline again, which is the split this branch closed.
    const app = await buildApp();
    sharedWrites.length = 0;
    app.log.info('pipeline-probe');
    expect(sharedWrites.some((line) => line.includes('pipeline-probe'))).toBe(true);
    await app.close();
  });

  it('still boots silent for tests via logger: false', async () => {
    const app = await buildApp({ logger: false });
    await app.close();
  });

  /**
   * ⚠⚠ BAL-568 — REQUIRED, AND THE FAILURE IT PREVENTS IS SILENT. A browser cannot READ a custom
   * response header cross-origin without `Access-Control-Expose-Headers`, and web (`:3000`) → api
   * (`:3002`) is cross-origin. Without `exposedHeaders` on the CORS registration the browser
   * strips `x-balo-session-invalid` before any JavaScript sees it, so a browser-side Bearer
   * caller could never act on it — and NO test that only inspects `requireAuth`'s reply would
   * notice, because the header IS sent; it just never arrives. (No browser caller exists today;
   * every current reader is server-side, where CORS does not apply.)
   *
   * ⚠ BEHAVIOURAL, NOT A SOURCE SCAN: it sends a real cross-origin request through the real CORS
   * plugin and reads the header a browser would read.
   */
  it('⚠ exposes the BAL-568 account-refusal header cross-origin', async () => {
    const app = await buildApp({ logger: false });
    const response = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'http://localhost:3000' },
    });
    expect(response.statusCode).toBe(200);
    const exposed = response.headers['access-control-expose-headers'];
    expect(exposed, 'the CORS registration must set exposedHeaders').toBeDefined();
    expect(String(exposed)).toContain(ACCOUNT_REFUSAL_HEADER);
    await app.close();
  });

  /**
   * BAL-461 — `POST /rate-limit/check` registers `{ logLevel: 'warn' }`, which drops Fastify's
   * own per-request "incoming request"/"request completed" info lines for this route only. This
   * route can see up to ~120 calls a minute from one active typist; without the suppression,
   * ordinary traffic would double Axiom's request-log volume for no operational question a
   * `warn`/`error` line doesn't already answer.
   *
   * `buildApp()` bare (no options) is used deliberately — the same production logging path
   * `app.log` pins above — with `INTERNAL_API_SECRET` deleted so `requireInternalAuth` writes a
   * real `request.log.error` line (`internal-auth.ts:16`) through the same shared-logger
   * pipeline, proving `logLevel: 'warn'` still lets an `error` line through while dropping the
   * two `info` ones.
   */
  it('BAL-461 — suppresses per-request info lines on POST /rate-limit/check (logLevel: warn)', async () => {
    const previousSecret = process.env.INTERNAL_API_SECRET;
    delete process.env.INTERNAL_API_SECRET;
    try {
      const app = await buildApp();
      sharedWrites.length = 0;
      const response = await app.inject({ method: 'POST', url: RATE_LIMIT_CHECK_PATH });
      expect(response.statusCode).toBe(500);
      const messages = sharedWrites.map((line) => (JSON.parse(line) as { msg?: string }).msg);
      expect(messages).toContain('INTERNAL_API_SECRET env var is not configured');
      expect(messages).not.toContain('incoming request');
      expect(messages).not.toContain('request completed');
      await app.close();
    } finally {
      if (previousSecret !== undefined) {
        process.env.INTERNAL_API_SECRET = previousSecret;
      }
    }
  });

  /**
   * Control for the case above: a route with NO `logLevel` override still writes Fastify's
   * default per-request info lines — proving the suppression above comes from
   * `POST /rate-limit/check`'s own route option, not from some global logger change.
   */
  it('control: GET /health (default logLevel) still writes the per-request info lines', async () => {
    const app = await buildApp();
    sharedWrites.length = 0;
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    const messages = sharedWrites.map((line) => (JSON.parse(line) as { msg?: string }).msg);
    expect(messages).toContain('incoming request');
    await app.close();
  });
});
