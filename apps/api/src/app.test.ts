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
});
