import { describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import pino from 'pino';
import { LOGGER_OPTIONS, REDACT_PATHS } from './index.js';

/**
 * B3 (BAL-467 security review) — pins that `REDACT_PATHS` is actually wired into a real
 * Pino instance and produces real redaction, not merely that the array contains the right
 * strings. Builds a SEPARATE pino instance with no `transport` (transports run in a worker
 * thread and can't be synchronously captured in a unit test), reusing `LOGGER_OPTIONS.redact`
 * — the EXACT object the real exported `log` is constructed with (fix brief round 2, item 6:
 * a test-local `redact: { paths: [...REDACT_PATHS] }` proves `fast-redact` works, not that
 * Balo's exported `log` is configured with it — deleting the real `redact:` block used to
 * leave all 838 `packages/shared` tests green) — writing to an in-memory stream.
 */
function captureLog(): { log: pino.Logger; lines: () => Record<string, unknown>[] } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  const log = pino({ redact: LOGGER_OPTIONS.redact }, stream);
  return {
    log,
    lines: () =>
      chunks
        .join('')
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

describe('shared pino logger — redact config (BAL-467 B3)', () => {
  it('LOGGER_OPTIONS.redact.paths — the object the REAL exported log is built with — matches REDACT_PATHS', () => {
    expect(LOGGER_OPTIONS.redact.paths).toEqual([...REDACT_PATHS]);
  });

  it('lists the required credential-shaped paths', () => {
    for (const required of ['authorization', 'apiKey', 'accessToken', 'refreshToken']) {
      expect(REDACT_PATHS.some((path) => path === required || path.endsWith(`.${required}`))).toBe(
        true
      );
    }
    expect(REDACT_PATHS.some((path) => path.includes('x-api-key'))).toBe(true);
    expect(REDACT_PATHS.some((path) => path.includes('wireErrorRaw'))).toBe(true);
    expect(REDACT_PATHS.some((path) => path.includes('zodIssues'))).toBe(true);
  });

  it('redacts a top-level authorization field', () => {
    const { log, lines } = captureLog();
    log.info({ authorization: 'Bearer secret-token' }, 'test');
    expect(lines()[0]?.authorization).toBe('[REDACTED]');
  });

  it('redacts a top-level apiKey field', () => {
    const { log, lines } = captureLog();
    log.info({ apiKey: 'sk_live_secret' }, 'test');
    expect(lines()[0]?.apiKey).toBe('[REDACTED]');
  });

  it('redacts accessToken and refreshToken', () => {
    const { log, lines } = captureLog();
    log.info({ accessToken: 'at_secret', refreshToken: 'rt_secret' }, 'test');
    const line = lines()[0];
    expect(line?.accessToken).toBe('[REDACTED]');
    expect(line?.refreshToken).toBe('[REDACTED]');
  });

  it('redacts a nested wireErrorRaw field (the Apiroc B1/B2 safety net)', () => {
    const { log, lines } = captureLog();
    log.error(
      { err: { wireErrorRaw: { error: { message: 'echoes attendee@example.com' } } } },
      'apiroc_request_failed'
    );
    const errField = lines()[0]?.err as Record<string, unknown> | undefined;
    expect(errField?.wireErrorRaw).toBe('[REDACTED]');
  });

  it('redacts a nested zodIssues field (item 10 — .message echoes Zod-received values)', () => {
    const { log, lines } = captureLog();
    log.error(
      {
        err: {
          zodIssues: [
            { path: 'calendarId', code: 'invalid_enum_value', message: "received 'xyz'" },
          ],
        },
      },
      'apiroc_request_failed'
    );
    const errField = lines()[0]?.err as Record<string, unknown> | undefined;
    expect(errField?.zodIssues).toBe('[REDACTED]');
  });

  it('does not redact unrelated fields', () => {
    const { log, lines } = captureLog();
    log.info({ status: 400, requestId: 'req-1' }, 'test');
    const line = lines()[0];
    expect(line?.status).toBe(400);
    expect(line?.requestId).toBe('req-1');
  });
});
