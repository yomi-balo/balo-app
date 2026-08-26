/**
 * BAL-473 — typed Mux provider errors. Mirrors `services/daily/errors.ts` — a small, named
 * error so a misconfiguration surfaces loudly (a throw, never a silent `!` non-null assertion
 * on a missing env var, which is what `services/airwallex/client.ts` does and what this
 * deliberately does not copy).
 */
export class MuxConfigError extends Error {
  constructor(detail: string) {
    super(`Mux configuration error: ${detail}`);
    this.name = 'MuxConfigError';
  }
}

/**
 * Whether an error from a Mux SDK call is worth a BullMQ retry.
 *
 * ⚠ MIRRORS THE DAILY 4XX-EXCEPT-429 RULE (`rooms.ts`'s "any 4xx other than 429 is a config
 * or payload bug, not retryable"). The Mux SDK throws `Mux.APIError` subtypes carrying a
 * `status`; a 429 or any 5xx/network fault is transient, everything else is a bug in the
 * request this platform sent and retrying it changes nothing.
 */
export function isRetryableMuxError(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  if (typeof status !== 'number') {
    // No status at all — a network fault (timeout, DNS, connection reset). Retry it.
    return true;
  }
  return status === 429 || status >= 500;
}
