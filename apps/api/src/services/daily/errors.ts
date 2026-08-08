/**
 * Typed Daily.co provider errors (BAL-129). Mirrors `services/stripe/errors.ts` — a small,
 * named error so a misconfiguration surfaces loudly (a throw, never a silent `!` non-null
 * assertion on a missing env var, which is what `services/airwallex/client.ts` does and
 * what this deliberately does not copy).
 */
export class DailyConfigError extends Error {
  constructor(detail: string) {
    super(`Daily configuration error: ${detail}`);
    this.name = 'DailyConfigError';
  }
}

/**
 * A non-2xx response from the Daily REST API.
 *
 * ⚠ `body` IS THE VENDOR'S RAW RESPONSE TEXT AND IS FOR THE SERVER LOG ONLY. The route
 * never echoes it (§6.3) — it maps a provisioning failure to `201 provisioned: false` and
 * logs this error with the meeting id attached, which is what makes the repair actionable.
 *
 * `status` is carried as its own field because `rooms.ts` branches on it: a `400` is the
 * already-exists signal, and every other status propagates. Branching on the status plus a
 * successful `GET` — never on the vendor's error string — is deliberate; the string is not
 * a stable contract.
 */
export class DailyApiError extends Error {
  constructor(
    public readonly method: string,
    public readonly path: string,
    public readonly status: number,
    public readonly body: string
  ) {
    super(`Daily API error: ${method} ${path} responded ${status}`);
    this.name = 'DailyApiError';
  }
}
