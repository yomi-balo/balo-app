/**
 * BAL-520 — the transcript-submit job's retry constants and the worst-case time it can spend
 * before it either stamps `transcript_job_submitted_at` or runs out of attempts.
 *
 * ⚠ ITS OWN MODULE, NOT `transcript-capture.ts`: `routes/mux/webhook.ts` needs the budget, and
 * importing the job module would drag the transcript pipeline and Anthropic client graph into
 * that route. `transcript-capture.ts` imports the two constants FROM here, so there is still ONE
 * definition of each.
 */
import { DAILY_REQUEST_TIMEOUT_MS } from '../services/daily/client.js';

export const SUBMIT_ATTEMPTS = 3;
/** ALSO the ingest job's backoff delay (`transcript-capture.ts` ingest enqueue): changing it
 *  moves both. */
export const BACKOFF_DELAY_MS = 10_000;

/**
 * The non-HTTP work inside ONE submit attempt: `findById`, `resolveMeetingEngagement`, the
 * `markTranscriptJobSubmitted` CAS write, and BullMQ's delayed→wait promotion and worker
 * pickup. Those are a handful of DB/Redis round trips that normally take tens of milliseconds;
 * 5s absorbs pool contention and promotion lag by more than 10×, while keeping the Daily
 * source's extra lifetime at about a minute.
 */
export const SUBMIT_ATTEMPT_NON_HTTP_SLACK_MS = 5_000;

/**
 * How long the Mux-triggered `recording-cleanup-source` enqueue is DELAYED, so the transcript
 * submit job has stamped `transcript_job_submitted_at` (or exhausted its attempts) before
 * cleanup's first withhold-gate read. See DOOR 3 in `recording-cleanup-source.ts`.
 *
 * ── THE TERMS ──────────────────────────────────────────────────────────────────────────────
 *
 *   SUBMIT_ATTEMPTS × DAILY_REQUEST_TIMEOUT_MS
 *       Every attempt's Daily POST is aborted at 10s. The abort is a `DOMException`, not a
 *       `DailyApiError`, so `handleSubmit` rethrows it and BullMQ retries.
 *   + BACKOFF_DELAY_MS × (2^(SUBMIT_ATTEMPTS − 1) − 1)
 *       The exponential waits, Σ BACKOFF_DELAY_MS × 2^(n−1) for n = 1..SUBMIT_ATTEMPTS−1 —
 *       10s + 20s today. BullMQ waits `round(2^(attemptsMade−1) × delay)` only while another
 *       attempt remains, so there is no wait after the last attempt, and no jitter is configured.
 *   + SUBMIT_ATTEMPTS × SUBMIT_ATTEMPT_NON_HTTP_SLACK_MS
 *       Per-attempt slack for the non-HTTP work, so it scales with `SUBMIT_ATTEMPTS`.
 *
 * Worst case today: attempt 1 times out at t+10s, attempt 2 starts at t+20s and times out at
 * t+30s, attempt 3 starts at t+50s and stamps by about t+60s plus overhead. The budget is 75s.
 *
 * The delay is measured from Mux's `ready`, which is strictly AFTER the submit enqueue (the
 * ingest that leads to `ready` is enqueued alongside it), so the real margin is larger.
 *
 * ── WHAT THIS DOES *NOT* COVER ─────────────────────────────────────────────────────────────
 *
 *  - queue wait before submit attempt 1 (`transcript-capture` runs `concurrency: 5`, shared
 *    with ingest);
 *  - the worker being down;
 *  - a failed best-effort submit enqueue — submit never runs, so no delay helps.
 *
 * ⚠ EXPORTED for `routes/mux/webhook.ts` and the derivation test.
 */
export const TRANSCRIPT_SUBMIT_RETRY_BUDGET_MS =
  SUBMIT_ATTEMPTS * (DAILY_REQUEST_TIMEOUT_MS + SUBMIT_ATTEMPT_NON_HTTP_SLACK_MS) +
  BACKOFF_DELAY_MS * (2 ** (SUBMIT_ATTEMPTS - 1) - 1);
