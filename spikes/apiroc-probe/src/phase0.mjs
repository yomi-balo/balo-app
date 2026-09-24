// BAL-393 Phase 0 — error vocabulary.
// Needs only the sandbox API key: no connected account, no OAuth consent, no webhook receiver.
//
// Every failure is probed TWICE:
//   raw fetch → the true wire envelope + HTTP status + headers (docs say `{error,message,requestId}`)
//   SDK call  → how v2.0.1 normalises it (`{code,message,details,status}` + error class)
// The adapter will branch on the SDK half; the raw half tells us what the SDK is discarding.

import { heading, line, loadEnv, rawProbe, save, sdkProbe } from './lib.mjs';

const env = loadEnv();
const runRateLimit = process.argv.includes('--rate-limit');

const BOGUS_ACCOUNT = 'euacc_bal393_does_not_exist';
const BOGUS_CALENDAR = 'cal_bal393_does_not_exist';

// The SDK is optional: if it is not installed we still get the raw half.
let sdk = null;
let sdkLoadError = null;
try {
  const mod = await import('@apiroc/unified-calendar-api-node-sdk');
  const Ctor = mod.UnifiedCalendarApi ?? mod.default?.UnifiedCalendarApi ?? mod.default;
  sdk = new Ctor({ apiKey: env.apiKey });
} catch (error) {
  sdkLoadError = error instanceof Error ? error.message : String(error);
}

const results = [];

async function probe(name, { raw, viaSdk }) {
  const record = { name };
  record.raw = await rawProbe({ ...raw, name, env });
  if (viaSdk && sdk) record.sdk = await sdkProbe(name, () => viaSdk(sdk));
  results.push(record);

  const status = record.raw.response?.status ?? `network:${record.raw.networkError ?? '?'}`;
  const wireCode =
    record.raw.response?.bodyParsed?.error ?? record.raw.response?.bodyParsed?.code ?? '—';
  const sdkClass = record.sdk?.errorClass ?? (record.sdk ? 'did-not-throw' : '—');
  const sdkCode = record.sdk?.code ?? '—';
  line(
    `  ${name.padEnd(26)} http=${String(status).padEnd(16)} wire=${String(wireCode).padEnd(22)} sdk=${sdkClass}/${sdkCode}`
  );
  return record;
}

heading('BAL-393 Phase 0 — Apiroc sandbox error vocabulary');
line(`base:      ${env.baseUrl}`);
line(`sdk:       ${sdk ? 'loaded' : `NOT LOADED (${sdkLoadError}) — raw half only`}`);
line(`rate-limit probe: ${runRateLimit ? 'ON' : 'off (pass --rate-limit to include)'}`);
line('');

// ── 0. Baseline. If this is not 2xx, nothing below can be interpreted. ────────────────
await probe('baseline-valid-key', {
  raw: { method: 'GET', path: '/api/v1/endUserAccounts', auth: 'valid' },
  viaSdk: (c) => c.endUserAccounts.list(),
});

// ── 1-2. Authentication ──────────────────────────────────────────────────────────────
await probe('missing-key', {
  raw: { method: 'GET', path: '/api/v1/endUserAccounts', auth: 'missing' },
});

await probe('bad-key', {
  raw: { method: 'GET', path: '/api/v1/endUserAccounts', auth: 'garbage' },
});

// ── 3. Unknown account ───────────────────────────────────────────────────────────────
await probe('unknown-account', {
  raw: { method: 'GET', path: `/api/v1/endUserAccounts/${BOGUS_ACCOUNT}`, auth: 'valid' },
  viaSdk: (c) => c.endUserAccounts.get(BOGUS_ACCOUNT),
});

// ── 4. Unknown calendar ──────────────────────────────────────────────────────────────
// With a bogus account too, the 404 is ambiguous (which id was not found?). When a real
// account id is in .env after Phase 1, re-run to isolate it — recorded as a caveat either way.
const calendarAccount = env.googleAccountId ?? BOGUS_ACCOUNT;
await probe('unknown-calendar', {
  raw: {
    method: 'GET',
    path: `/api/v1/calendars/${calendarAccount}/${BOGUS_CALENDAR}`,
    auth: 'valid',
  },
  viaSdk: (c) => c.calendars.get?.(calendarAccount, BOGUS_CALENDAR),
});
if (!env.googleAccountId) {
  line('    ⚠ unknown-calendar used a BOGUS account id — re-run after Phase 1 to disambiguate.');
}

// ── 5. Malformed body — freeBusy with no calendarIds / timeZone ──────────────────────
await probe('malformed-body-freebusy', {
  raw: {
    method: 'POST',
    path: `/api/v1/freeBusy/${calendarAccount}`,
    auth: 'valid',
    body: { startDateTime: '2026-08-20T00:00:00Z', endDateTime: '2026-08-21T00:00:00Z' },
  },
  viaSdk: (c) =>
    c.freeBusy.get(calendarAccount, {
      startDateTime: '2026-08-20T00:00:00Z',
      endDateTime: '2026-08-21T00:00:00Z',
    }),
});

// ── 6. Missing required field — event create with no title / start ───────────────────
await probe('missing-required-field', {
  raw: {
    method: 'POST',
    path: `/api/v1/events/${calendarAccount}/${BOGUS_CALENDAR}`,
    auth: 'valid',
    body: { description: 'BAL-393 spike — intentionally missing title and start' },
  },
  viaSdk: (c) =>
    c.events.create(calendarAccount, BOGUS_CALENDAR, {
      description: 'BAL-393 spike — intentionally missing title and start',
    }),
});

// ── 7. Rate limit (opt-in) — sandbox is documented at 20 req/s ───────────────────────
if (runRateLimit) {
  heading('Rate-limit probe (60 concurrent GETs against a 20 req/s sandbox cap)');
  const burst = await Promise.all(
    Array.from({ length: 60 }, (_, i) =>
      rawProbe({ name: `rate-limit-${i}`, method: 'GET', path: '/api/v1/endUserAccounts', env })
    )
  );
  const throttled = burst.filter((r) => r.response?.status === 429);
  const statuses = burst.reduce((acc, r) => {
    const k = String(r.response?.status ?? 'network-error');
    acc[k] = (acc[k] ?? 0) + 1;
    return acc;
  }, {});
  const [firstThrottled] = throttled;

  line(`  status distribution: ${JSON.stringify(statuses)}`);
  line(`  429s: ${throttled.length}/60`);
  line(
    `  Retry-After present: ${firstThrottled ? Boolean(firstThrottled.response.headers['retry-after']) : 'n/a — no 429 observed'}`
  );
  if (firstThrottled) line(`  first 429 body: ${firstThrottled.response.bodyRaw.slice(0, 400)}`);

  results.push({
    name: 'rate-limit-burst',
    statuses,
    throttledCount: throttled.length,
    sample: firstThrottled ?? null,
  });
  save('phase0/rate-limit.json', { statuses, throttledCount: throttled.length, all: burst });
} else {
  line('\n  (rate-limit probe skipped — run `pnpm phase0:rate-limit` to include it)');
}

// ── Persist ──────────────────────────────────────────────────────────────────────────
for (const record of results) {
  if (record.name === 'rate-limit-burst') continue;
  save(`phase0/${record.name}.json`, record);
}
const summaryPath = save('phase0/_summary.json', {
  capturedAt: new Date().toISOString(),
  baseUrl: env.baseUrl,
  sdkLoaded: Boolean(sdk),
  sdkLoadError,
  unknownCalendarUsedRealAccount: Boolean(env.googleAccountId),
  results,
});

heading('Done');
line(`Captures written to spikes/apiroc-probe/captures/phase0/`);
line(`Summary: ${summaryPath}`);
line('Next: paste the printed table into FINDINGS.md → Unknown 1 (error vocabulary).');
