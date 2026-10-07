/**
 * Shared Sentry alerting for conditions that would otherwise log once per occurrence and either
 * flood Sentry or never reach it at all.
 *
 * `captureMessageOnce(key, message)` dedups per key, FOR THE REST OF THE PROCESS: the first call
 * for a given key sends `Sentry.captureMessage(message, { level: 'error' })`; every later call
 * with the same key is a no-op forever, keyed by an explicit caller-chosen string rather than by
 * call site — e.g. one key per vendor's `webhook_not_configured` branch, so a Mux capture can
 * never suppress a Daily one. Reserved for conditions that can't recur without a restart — e.g.
 * `DAILY_WEBHOOK_SECRET` unset, which config can't change out from under a running process.
 *
 * `captureMessageAtMostEvery(key, message, intervalMs)` dedups per key WITHIN A ROLLING WINDOW:
 * the first call per key captures; a later call with the same key captures again only once
 * `intervalMs` has elapsed since the key's last capture. For conditions that ARE expected to
 * recur within one process's lifetime — e.g. a Redis outage: transient, and a second outage
 * days later must still reach Sentry rather than being silenced forever by the first one.
 *
 * `alertMissingConfigAtBoot(log, message)` does NOT dedup — it runs once, at boot, by
 * construction — and instead branches on environment: in production it calls `log.error` AND
 * `Sentry.captureMessage` (a Pino line alone never reaches Sentry); everywhere else it only
 * calls `log.warn`.
 *
 * One module, so there is one Sentry call shape instead of one per call site. Precedent for
 * module-level once-state: `services/ai/client.ts`'s `noopWarned`.
 *
 * ⚠ NO RESET EXPORT, DELIBERATELY. A test-only `__resetForTests` would be production surface
 * that exists only for tests. Order-independence is a test-file concern — `vi.resetModules()` +
 * a dynamic import — not this module's.
 */
import * as Sentry from '@sentry/node';
import type { FastifyBaseLogger } from 'fastify';

/** Keys already captured this process. Never cleared — see the module docblock. */
const capturedKeys = new Set<string>();

/** Per-key last-capture time (`Date.now()`), for {@link captureMessageAtMostEvery}. */
const lastCapturedAtMs = new Map<string, number>();

/**
 * Capture `message` to Sentry at `level: 'error'` the FIRST time `key` is seen this process;
 * every later call with the SAME `key` is a no-op. `key` must be stable per distinct condition
 * — e.g. `daily-webhook:not-configured` vs `mux-webhook:not-configured`, so a Mux capture can
 * never suppress a Daily one.
 */
export function captureMessageOnce(key: string, message: string): void {
  if (capturedKeys.has(key)) {
    return;
  }
  capturedKeys.add(key);
  Sentry.captureMessage(message, { level: 'error' });
}

/**
 * Capture `message` to Sentry at `level: 'error'` the FIRST time `key` is seen, and again on any
 * later call for the SAME `key` once at least `intervalMs` has elapsed since the key's last
 * capture; a call inside the window is a no-op. Use this instead of {@link captureMessageOnce}
 * for a condition that can genuinely recur within one process's lifetime — a once-per-process
 * dedup would otherwise silence every recurrence after the first, forever.
 */
export function captureMessageAtMostEvery(key: string, message: string, intervalMs: number): void {
  const now = Date.now();
  const last = lastCapturedAtMs.get(key);
  if (last !== undefined && now - last < intervalMs) {
    return;
  }
  lastCapturedAtMs.set(key, now);
  Sentry.captureMessage(message, { level: 'error' });
}

/**
 * BAL-581 / BAL-583 — the boot-time missing-vendor-config posture, in ONE place: in production,
 * `log.error` the message AND capture it to Sentry (a Pino line alone never reaches Sentry —
 * `Sentry.init` has no pino integration); everywhere else, `log.warn` only (dev/staging
 * routinely run without every vendor secret). NEVER a throw — crash-looping Railway over a
 * vendor secret takes every route down to protect one integration.
 */
export function alertMissingConfigAtBoot(
  log: Pick<FastifyBaseLogger, 'error' | 'warn'>,
  message: string
): void {
  if (process.env.NODE_ENV === 'production') {
    log.error(message);
    Sentry.captureMessage(message, { level: 'error' });
  } else {
    log.warn(message);
  }
}
