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

/**
 * Hard ceiling on live buckets. Reached only under a distinct-key flood — a scanner
 * rotating `X-Forwarded-For`, since {@link clientIp} necessarily trusts a spoofable
 * header (see below). Sized well above any plausible legitimate concurrent-IP count
 * for one serverless instance, so eviction is an abuse-path behaviour, not a normal one.
 */
const MAX_TRACKED_KEYS = 10_000;

/** How many keys to scan for expiry per write. Bounded so `checkMemoryLimit` stays O(1)-ish. */
const SWEEP_BATCH = 64;

// Module-level store — one bucket per key (typically the client IP).
const buckets = new Map<string, WindowState>();

/**
 * Drop expired buckets, and — if the map is still at its ceiling — the oldest live ones.
 *
 * ⚠ WHY THIS EXISTS. Every distinct key created an entry that was only ever expired
 * LAZILY, on a subsequent hit for the SAME key. Nothing swept. On a PUBLIC,
 * UNAUTHENTICATED route (`/join/{token}`, `/review/{token}`,
 * `/shared/proposals/{token}`) the key is a caller-influenced value, so a key that is
 * never hit twice is a permanent entry: unbounded heap growth on the one class of route
 * where the caller chooses the cardinality. Sweeping on WRITE (never on read) keeps the
 * cost on the path that creates the pressure.
 *
 * `Map` preserves insertion order, so the head of the iterator is the oldest bucket —
 * which is what makes both the expiry scan and the overflow eviction cheap and fair.
 */
function evictExpired(now: number): void {
  let scanned = 0;
  for (const [key, state] of buckets) {
    if (scanned >= SWEEP_BATCH) break;
    scanned += 1;
    if (now >= state.resetAt) buckets.delete(key);
  }

  // A flood of keys that are all still inside their window outruns the expiry scan.
  // Evicting the oldest is safe: the worst case is that one caller's window restarts
  // early, which is strictly less bad than an unbounded map.
  while (buckets.size >= MAX_TRACKED_KEYS) {
    const [oldest] = buckets.keys();
    if (oldest === undefined) break;
    buckets.delete(oldest);
  }
}

/**
 * Record one hit against `key` and report whether it is WITHIN the limit.
 * Returns `true` when the request is allowed, `false` once the window's cap is
 * exceeded. The window resets `windowMs` after the first hit that opened it.
 *
 * ⚠ `key` IS TYPICALLY DERIVED FROM `clientIp`, WHICH TRUSTS `X-Forwarded-For` AND IS
 * THEREFORE SPOOFABLE. That is a deliberate, pre-existing defence-in-depth position, not
 * an oversight: on every surface that calls this, the PRIMARY control is the ≥256-bit
 * unguessable token plus a constant-time compare and a leak-free generic page, and the
 * limiter exists only to blunt a scanner storm. The consequence for THIS module is that
 * an attacker fully controls the key space — hence the bounded map above. Do not "fix"
 * the header trust here; that is an infrastructure decision (a trusted proxy hop), and
 * making the limiter authoritative would be a different design.
 */
export function checkMemoryLimit(key: string, opts?: { max?: number; windowMs?: number }): boolean {
  const max = opts?.max ?? DEFAULT_MAX;
  const windowMs = opts?.windowMs ?? DEFAULT_WINDOW_MS;
  const now = Date.now();

  const existing = buckets.get(key);
  if (existing === undefined || now >= existing.resetAt) {
    evictExpired(now);
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }

  existing.count += 1;
  return existing.count <= max;
}

/** Test-only: how many buckets are currently held. Exposed so the bound is assertable. */
export function __trackedKeyCountForTests(): number {
  return buckets.size;
}

/** Test-only: clear all buckets so window state never leaks across cases. */
export function __resetMemoryLimitForTests(): void {
  buckets.clear();
}
