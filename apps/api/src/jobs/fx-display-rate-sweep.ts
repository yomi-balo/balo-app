import { Worker, type Job } from 'bullmq';
import { fxDisplayRatesRepository, fxDisplayQuoteEnum, type FxDisplayQuote } from '@balo/db';
import { isFxRateStale } from '@balo/shared/pricing';
import { createLogger } from '@balo/shared/logging';
import { trackServer, CREDIT_SERVER_EVENTS } from '@balo/analytics/server';
import { createRedisConnection } from '../lib/redis.js';
import { getQueue } from '../lib/queue.js';

/**
 * BAL-380 (ADR-1040 Lane 3) — the daily display-FX sweep. Fetches AUD→{GBP,EUR,USD} from
 * ExchangeRate-API into `fx_display_rates`, with a LAST-GOOD fallback on any failure, and
 * emits `credit_fx_cache_stale` for any served quote older than 48h.
 *
 * PRESENTATION-ONLY (invariant #8): `fx_display_rates` NEVER enters balance/settlement
 * math — the real AUD balance/price is independent of this feed. So a fetch failure is
 * never a money problem; it just retains the prior rows (consumer surfaces hide the
 * indicative secondary via the pure `isFxRateStale` helper once a quote goes >48h).
 *
 * Uses BARE global `fetch()` (no web-only `loggedFetch` in the API — cf.
 * `services/airwallex/client.ts`) and the structured `@balo/shared/logging` logger.
 */
export const FX_DISPLAY_RATE_SWEEP_QUEUE = 'fx-display-rate-sweep';
export const FX_DISPLAY_RATE_SWEEP_CRON = '0 5 * * *'; // daily 05:00 UTC (offset from dormancy 03:00)

/** ExchangeRate-API v6 base (host swappable for tests/staging via EXCHANGERATE_API_URL). */
const DEFAULT_EXCHANGERATE_API_URL = 'https://v6.exchangerate-api.com/v6';

const HOUR_MS = 60 * 60 * 1000;

const log = createLogger('fx-display-rate-sweep');

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Abort a hung upstream so the concurrency-1 FX worker can never stall (10s). */
const FX_FETCH_TIMEOUT_MS = 10_000;

/**
 * Fetch + parse the latest-AUD payload. Returns a normalised `{ ok, status, body }` or
 * `undefined` on any network/parse throw (the no-upsert / last-good path). Avoids naming
 * the DOM `Response` type — `res` stays inferred. A hung upstream aborts after
 * `FX_FETCH_TIMEOUT_MS`; the AbortError takes the same no-upsert path (last-good retained),
 * so the cron never stalls or crashes.
 */
async function fetchLatest(
  url: string
): Promise<{ ok: boolean; status: number; body: unknown } | undefined> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(FX_FETCH_TIMEOUT_MS) });
    const body: unknown = await res.json();
    return { ok: res.ok, status: res.status, body };
  } catch (error) {
    log.error(
      { error: errorMessage(error) },
      'FX fetch/parse failed — retaining last-good display rates'
    );
    return undefined;
  }
}

/**
 * Extract `conversion_rates` from a SUCCESS payload, or `undefined` for any non-usable
 * response (`!ok`, `result !== 'success'`, or a missing/malformed rates object). No upsert
 * on `undefined` — the prior last-good rows are retained.
 */
function extractConversionRates(ok: boolean, body: unknown): Record<string, unknown> | undefined {
  if (!ok || typeof body !== 'object' || body === null) return undefined;
  const record = body as Record<string, unknown>;
  if (record.result !== 'success') return undefined;
  const rates = record.conversion_rates;
  if (typeof rates !== 'object' || rates === null) return undefined;
  return rates as Record<string, unknown>;
}

/** The source timestamp of a success payload (Unix seconds → Date); `now` fallback. */
function extractAsOf(body: unknown, now: Date): Date {
  const record = body as Record<string, unknown>;
  const unix = record.time_last_update_unix;
  if (typeof unix === 'number' && Number.isFinite(unix)) {
    return new Date(unix * 1000);
  }
  return now;
}

/** Upsert each schema-defined quote whose rate is a finite number. Never writes NaN. */
async function upsertQuotes(rates: Record<string, unknown>, asOf: Date): Promise<number> {
  let upserted = 0;
  for (const quote of fxDisplayQuoteEnum.enumValues) {
    const rate = rates[quote];
    if (typeof rate !== 'number' || !Number.isFinite(rate)) {
      log.warn({ quote }, 'FX quote missing or non-numeric — skipping (never writing NaN)');
      continue;
    }
    await fxDisplayRatesRepository.upsert({ quote, rate: String(rate), asOf });
    upserted += 1;
  }
  return upserted;
}

/** Fetch → validate → upsert. Returns the count upserted (0 on any failure). */
async function fetchAndUpsert(url: string, now: Date): Promise<number> {
  const fetched = await fetchLatest(url);
  if (fetched === undefined) return 0; // network/parse throw — last-good retained
  const rates = extractConversionRates(fetched.ok, fetched.body);
  if (rates === undefined) {
    log.error(
      { status: fetched.status },
      'FX response was not a usable success payload — retaining last-good display rates'
    );
    return 0;
  }
  return upsertQuotes(rates, extractAsOf(fetched.body, now));
}

/**
 * After the run, emit `credit_fx_cache_stale` for each served quote (the just-upserted
 * row, or the retained last-good on the failure path) older than 48h. A daily, low-volume
 * operational signal. Returns the list of stale quotes.
 */
async function emitStaleness(now: Date): Promise<FxDisplayQuote[]> {
  const stale: FxDisplayQuote[] = [];
  for (const quote of fxDisplayQuoteEnum.enumValues) {
    const row = await fxDisplayRatesRepository.getLatest(quote);
    if (row === undefined) continue; // never fetched — nothing served yet
    if (isFxRateStale(row.asOf, now)) {
      trackServer(CREDIT_SERVER_EVENTS.FX_CACHE_STALE, {
        quote,
        as_of_age_hours: Math.floor((now.getTime() - row.asOf.getTime()) / HOUR_MS),
        distinct_id: 'system:fx-display',
      });
      stale.push(quote);
    }
  }
  return stale;
}

/**
 * The sweep body (exported for unit testing without a Redis-backed Worker). Guards the
 * API key (absent → warn + surface staleness against last-good, no fetch/upsert — a
 * missing key must not crash the cron), fetches/upserts (last-good on failure), then emits
 * staleness. Returns the counts.
 */
export async function runFxDisplayRateSweep(
  now: Date
): Promise<{ upserted: number; stale: FxDisplayQuote[] }> {
  const apiKey = process.env.EXCHANGERATE_API_KEY;
  if (!apiKey) {
    log.warn('EXCHANGERATE_API_KEY not set — skipping FX fetch (last-good retained)');
    // A missing key is exactly when the cache silently ages past 48h, so STILL surface
    // staleness against the retained last-good rows before returning (no fetch/upsert).
    const stale = await emitStaleness(now);
    return { upserted: 0, stale };
  }

  const baseUrl = process.env.EXCHANGERATE_API_URL ?? DEFAULT_EXCHANGERATE_API_URL;
  const upserted = await fetchAndUpsert(`${baseUrl}/${apiKey}/latest/AUD`, now);
  const stale = await emitStaleness(now);
  log.info({ upserted, stale: stale.length }, 'FX display-rate sweep complete');
  return { upserted, stale };
}

/** Start the FX display-rate sweep worker. */
export function startFxDisplayRateSweepWorker(): Worker {
  return new Worker(
    FX_DISPLAY_RATE_SWEEP_QUEUE,
    async (job: Job) => {
      const { upserted, stale } = await runFxDisplayRateSweep(new Date());
      job.log(`fx display-rate sweep: ${upserted} rates upserted, ${stale.length} stale`);
    },
    {
      connection: createRedisConnection(),
      concurrency: 1,
    }
  );
}

/** Register the repeatable FX display-rate sweep (daily 05:00 UTC). */
export async function registerFxDisplayRateSweepCron(): Promise<void> {
  const queue = getQueue(FX_DISPLAY_RATE_SWEEP_QUEUE);
  await queue.add(
    'sweep',
    {},
    {
      repeat: { pattern: FX_DISPLAY_RATE_SWEEP_CRON },
      removeOnComplete: true,
    }
  );
}
