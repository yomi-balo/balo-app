/**
 * Minimal in-memory fixed-window rate limiter (BAL-386). Defense-in-depth for the
 * public shared-proposal route — the PRIMARY control is the ≥256-bit unguessable
 * token + constant-time compare + leak-free generic page. This is best-effort and
 * PER-SERVERLESS-INSTANCE (a module-level Map is not shared across Vercel lambdas),
 * so it caps a single hot instance rather than providing a global guarantee.
 *
 * No Redis / apps/api hop in v1 (OQ-2). A fixed window (not a sliding log) keeps
 * the bookkeeping O(1) per key and the memory bounded by the live-window key set.
 */

interface WindowState {
  count: number;
  resetAt: number;
}

const DEFAULT_MAX = 30;
const DEFAULT_WINDOW_MS = 60_000;

// Module-level store — one bucket per key (typically the client IP). Entries are
// lazily expired on access; a key that stops being hit simply stops being read.
const buckets = new Map<string, WindowState>();

/**
 * Record one hit against `key` and report whether it is WITHIN the limit.
 * Returns `true` when the request is allowed, `false` once the window's cap is
 * exceeded. The window resets `windowMs` after the first hit that opened it.
 */
export function checkMemoryLimit(key: string, opts?: { max?: number; windowMs?: number }): boolean {
  const max = opts?.max ?? DEFAULT_MAX;
  const windowMs = opts?.windowMs ?? DEFAULT_WINDOW_MS;
  const now = Date.now();

  const existing = buckets.get(key);
  if (existing === undefined || now >= existing.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }

  existing.count += 1;
  return existing.count <= max;
}

/** Test-only: clear all buckets so window state never leaks across cases. */
export function __resetMemoryLimitForTests(): void {
  buckets.clear();
}
