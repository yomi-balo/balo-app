import { afterEach, beforeEach, vi } from 'vitest';

/**
 * Daily.co REST test scaffolding (BAL-129) — sibling to `mocks/stripe.ts`.
 *
 * Extracted because `services/daily/client.test.ts` and `services/daily/rooms.test.ts`
 * otherwise carry a byte-identical 17-line `beforeEach`/`afterEach` env-restore block plus
 * an identical `jsonResponse` builder. That is exactly the cross-file duplication
 * SonarCloud's gate flags (10+ identical lines), and it is also two places to forget to
 * restore `process.env.DAILY_API_KEY`, which would leak a key into unrelated suites.
 *
 * Usage:
 *
 *   import { TEST_DAILY_API_KEY, jsonResponse, useDailyApiKey } from '../../test/mocks/daily';
 *   useDailyApiKey();
 */

/** The key both Daily suites install, so header assertions can be literal. */
export const TEST_DAILY_API_KEY = 'test-daily-key';

/**
 * A minimal `Response` stand-in — only the four members `dailyRequest` touches (`ok`,
 * `status`, `json()`, `text()`). Deliberately not a real `Response`: constructing one would
 * drag in body-stream semantics that the assertions do not care about.
 */
export function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/**
 * Install `DAILY_API_KEY` before each test and restore the ambient value (or its absence)
 * after, along with un-stubbing any `fetch` global the test replaced.
 *
 * ⚠ RESTORES TO THE ORIGINAL RATHER THAN DELETING. A developer with a real key in their
 * shell must not have it silently removed for the rest of the run, and CI (where it is
 * unset) must not end up with a stray `'test-daily-key'` that makes a later
 * `DailyConfigError` assertion pass for the wrong reason.
 */
export function useDailyApiKey(): void {
  const original = process.env.DAILY_API_KEY;

  beforeEach(() => {
    process.env.DAILY_API_KEY = TEST_DAILY_API_KEY;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (original === undefined) {
      delete process.env.DAILY_API_KEY;
    } else {
      process.env.DAILY_API_KEY = original;
    }
  });
}
