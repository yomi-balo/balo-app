// BAL-393 Phase 2 — create webhook subscriptions and capture their lifecycle.
//
//   node src/subscribe.mjs <https-base-url> [google|microsoft]
//
// Answers Unknown 3 (H1): does `expiration` come back, and is renewal ours or theirs?
// Creates BOTH subscription kinds so the ticket's `calendar` vs `event` comparison is real.
// Identity is encoded in the per-subscription webhookUrl path so Unknown 4 can test whether
// that workaround is actually required.

import { heading, line, loadEnv, rawProbe, save } from './lib.mjs';

const env = loadEnv();
const base = (process.argv[2] ?? '').replace(/\/+$/, '');
const provider = (process.argv[3] ?? 'google').toLowerCase();
const accountId = provider === 'microsoft' ? env.microsoftAccountId : env.googleAccountId;

if (!/^https:\/\//.test(base)) {
  line('\n✖ Pass the public HTTPS base URL, e.g.:');
  line('   node src/subscribe.mjs https://xxx.trycloudflare.com google');
  line('   (webhookUrl must be HTTPS — the SDK types say so explicitly)');
  process.exit(1);
}
if (!accountId) {
  line(`\n✖ No ${provider} account id in .env.`);
  process.exit(1);
}

// Primary calendar — event subscriptions require a calendarId.
const cals = await rawProbe({ name: 'calendars', path: `/api/v1/calendars/${accountId}`, env });
const list = cals.response?.bodyParsed?.data ?? [];
const primary = list.find((c) => c.isPrimary) ?? list[0];
if (!primary) {
  line('✖ No calendar found.');
  process.exit(1);
}

heading(`Subscribing (${provider.toUpperCase()})`);
line(`receiver: ${base}/hook/${accountId}/<calendarId>`);

const results = {};

async function subscribe(kind, body) {
  const res = await rawProbe({
    name: `subscribe-${kind}`,
    method: 'POST',
    path: `/api/v1/calendarSubscriptions/${accountId}`,
    env,
    body,
  });
  save(`phase2/${provider}/subscribe-${kind}.json`, res);

  const b = res.response?.bodyParsed ?? {};
  line(`\n${kind} subscription → HTTP ${res.response?.status}`);
  if (res.response?.status >= 400) {
    line(`  ✖ ${res.response?.bodyRaw?.slice(0, 400)}`);
    return null;
  }
  line(`  keys: ${Object.keys(b).join(', ')}`);
  line(`  webhookSubscriptionId: ${b.webhookSubscriptionId ?? '—'}`);
  line(
    `  endpointSecret: ${b.endpointSecret ? `«present, ${b.endpointSecret.length} chars»` : '—'}`
  );
  line(`  expiration: ${JSON.stringify(b.expiration ?? null)}   ← H1 hinges on this`);

  // Hand the secret to the receiver so it can verify signatures live.
  if (b.endpointSecret) {
    await fetch(`${base}/_secret`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: accountId, secret: b.endpointSecret }),
    }).catch(() => line('  (could not register secret with receiver — is it running?)'));
  }
  return b;
}

// `subscriptionType` is REQUIRED in v2 — the skill's example omits it (Finding 0).
results.event = await subscribe('event', {
  calendarId: primary.id,
  webhookUrl: `${base}/hook/${accountId}/${encodeURIComponent(primary.id)}`,
  subscriptionType: 'event',
});

results.calendar = await subscribe('calendar', {
  webhookUrl: `${base}/hook/${accountId}/all-calendars`,
  subscriptionType: 'calendar',
});

// List them back — the create response and the stored record may differ, and `expiration`
// is only documented on the CalendarSubscription read model.
const listed = await rawProbe({
  name: 'subscriptions-list',
  path: `/api/v1/calendarSubscriptions/${accountId}`,
  env,
});
save(`phase2/${provider}/subscriptions-list.json`, listed);

heading('Stored subscription records (the read model)');
const stored = listed.response?.bodyParsed?.data ?? listed.response?.bodyParsed ?? [];
for (const s of Array.isArray(stored) ? stored : []) {
  line(`  id=${s.id}`);
  line(`    calendarId=${s.calendarId ?? 'null (all calendars)'}  provider=${s.provider}`);
  line(`    expiration=${JSON.stringify(s.expiration ?? null)}`);
  line(`    subscriptionId=${s.subscriptionId ?? 'null'}  resourceId=${s.resourceId ?? 'null'}`);
  line(`    createdAt=${s.createdAt}`);
}

save(`phase2/${provider}/_subscribe-summary.json`, {
  provider,
  calendarId: primary.id,
  eventSubscription: results.event ? { ...results.event, endpointSecret: '«redacted»' } : null,
  calendarSubscription: results.calendar
    ? { ...results.calendar, endpointSecret: '«redacted»' }
    : null,
  stored,
});

heading('Next');
line('1. Change something on the calendar (create/move/delete an event).');
line('2. Watch the receiver output for the verbatim payload.');
line('3. node src/trigger-changes.mjs — fires 3 rapid changes to test coalescing.');
