// BAL-393 Phase 2 — provoke calendar changes and watch what the webhook does.
//
//   node src/trigger-changes.mjs [google|microsoft]
//
// Fires one isolated change, waits, then three rapid-fire changes. The gap tells us whether
// one ping maps to one change; the burst tells us whether rapid changes coalesce (which
// decides if the delta-read job can be debounced).

import { heading, line, loadEnv, rawProbe } from './lib.mjs';

const env = loadEnv();
const provider = (process.argv[2] ?? 'google').toLowerCase();
const accountId = provider === 'microsoft' ? env.microsoftAccountId : env.googleAccountId;

const cals = await rawProbe({ name: 'calendars', path: `/api/v1/calendars/${accountId}`, env });
const list = cals.response?.bodyParsed?.data ?? [];
const cal = (list.find((c) => c.isPrimary) ?? list[0])?.id;
const P = `/api/v1/events/${accountId}/${encodeURIComponent(cal)}`;

const mk = (n) => ({
  title: `BAL-393 webhook probe ${n}`,
  start: { dateTime: `2026-08-25T1${n}:00:00Z`, timeZone: 'UTC' },
  end: { dateTime: `2026-08-25T1${n}:30:00Z`, timeZone: 'UTC' },
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

heading('Change 1 — isolated (baseline: does one change produce one ping?)');
const a = await rawProbe({ name: 'create-1', method: 'POST', path: P, env, body: mk(1) });
line(`create → HTTP ${a.response?.status} id=${a.response?.bodyParsed?.id?.slice(0, 24) ?? '—'}`);
line('waiting 25s for delivery…');
await wait(25_000);

heading('Changes 2-4 — rapid burst (do they coalesce into one ping?)');
const ids = [];
for (const n of [2, 3, 4]) {
  const r = await rawProbe({ name: `create-${n}`, method: 'POST', path: P, env, body: mk(n) });
  ids.push(r.response?.bodyParsed?.id);
  line(`create ${n} → HTTP ${r.response?.status}`);
}
line('waiting 25s…');
await wait(25_000);

heading('Cleanup — deleting all 4 probe events');
for (const id of [a.response?.bodyParsed?.id, ...ids].filter(Boolean)) {
  const d = await rawProbe({ name: 'delete', method: 'DELETE', path: `${P}/${id}`, env });
  line(`delete → HTTP ${d.response?.status}`);
}
line('\nwaiting 20s for delete-triggered deliveries…');
await wait(20_000);
line('Done. Check the receiver output / captures/phase2/webhooks/received.json');
