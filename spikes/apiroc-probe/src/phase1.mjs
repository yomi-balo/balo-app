// BAL-393 Phase 1 — happy path + schema capture against a real connected account.
//
//   node src/phase1.mjs            # uses GOOGLE_END_USER_ACCOUNT_ID
//   node src/phase1.mjs microsoft  # uses MICROSOFT_END_USER_ACCOUNT_ID
//
// Writes a real event to a real calendar, then reschedules and deletes it. Only ever point
// this at a THROWAWAY account. Every response body is saved verbatim to captures/phase1/.

import { heading, line, loadEnv, rawProbe, save, sdkProbe } from './lib.mjs';

const env = loadEnv();
const provider = (process.argv[2] ?? 'google').toLowerCase();
const accountId = provider === 'microsoft' ? env.microsoftAccountId : env.googleAccountId;

if (!accountId) {
  line(`\n✖ No ${provider} account id in .env. Run the OAuth flow first:`);
  line('   node src/callback-server.mjs   (leave running)');
  line(`   node src/authorize-url.mjs ${provider}`);
  process.exit(1);
}

const { UnifiedCalendarApi } = await import('@apiroc/unified-calendar-api-node-sdk');
const sdk = new UnifiedCalendarApi({ apiKey: env.apiKey });

const P = provider.toUpperCase();
const TAG = 'spike-test-1';
// Fixed future window — no Date.now() so re-runs are comparable.
const START = '2026-08-20T10:00:00Z';
const END = '2026-08-20T10:30:00Z';
const MOVED_START = '2026-08-20T14:00:00Z';
const MOVED_END = '2026-08-20T14:30:00Z';

const findings = {};

async function step(n, name, fn) {
  heading(`${n}. ${name}`);
  try {
    const out = await fn();
    findings[name] = out;
    return out;
  } catch (error) {
    line(`✖ ${error?.constructor?.name}: ${error?.message}`);
    findings[name] = {
      failed: true,
      class: error?.constructor?.name,
      message: error?.message,
      status: error?.status,
    };
    return null;
  }
}

// ── 1. Account + credentials ─────────────────────────────────────────────────────────
await step(1, 'account', async () => {
  const acct = await rawProbe({
    name: 'account',
    path: `/api/v1/endUserAccounts/${accountId}`,
    env,
  });
  const creds = await rawProbe({
    name: 'credentials',
    path: `/api/v1/endUserAccounts/${accountId}/credentials`,
    env,
  });
  save(`phase1/${provider}/01-account.json`, acct);

  // Credentials contain provider access/refresh tokens — record only the SHAPE, never values.
  const credBody = creds.response?.bodyParsed ?? {};
  const credShape = Object.fromEntries(
    Object.entries(credBody).map(([k, v]) => [
      k,
      ['accessToken', 'refreshToken', 'password'].includes(k)
        ? v == null
          ? null
          : `«${typeof v} present, ${String(v).length} chars — NOT CAPTURED»`
        : v,
    ])
  );
  save(`phase1/${provider}/01-credentials-SHAPE-ONLY.json`, {
    status: creds.response?.status,
    note: 'Token values deliberately not captured. Only presence/length recorded.',
    shape: credShape,
  });

  const a = acct.response?.bodyParsed ?? {};
  line(`status=${a.status}  providerType=${a.providerType}  email=${a.email ? '«present»' : '—'}`);
  line(`authorizedScopes: ${JSON.stringify(a.authorizedScopes)}`);
  line(`credentials keys: ${Object.keys(credBody).join(', ')}`);
  line(`credential status=${credBody.status}  expiresAt=${credBody.expiresAt ?? 'null'}`);
  return {
    accountStatus: a.status,
    credentialStatus: credBody.status,
    expiresAt: credBody.expiresAt ?? null,
    scopes: a.authorizedScopes,
  };
});

// ── 2. Calendars ─────────────────────────────────────────────────────────────────────
const calendars = await step(2, 'calendars', async () => {
  const res = await rawProbe({ name: 'calendars', path: `/api/v1/calendars/${accountId}`, env });
  save(`phase1/${provider}/02-calendars.json`, res);
  const list = res.response?.bodyParsed?.data ?? [];
  line(
    `count=${list.length}  nextPageToken=${JSON.stringify(res.response?.bodyParsed?.nextPageToken)}`
  );
  for (const c of list) {
    line(
      `  • isPrimary=${String(c.isPrimary).padEnd(5)} readOnly=${String(c.readOnly).padEnd(5)} tz=${c.timeZone ?? '—'} name=${c.name}`
    );
    if (c.allowedOnlineMeetingProviders)
      line(`    allowedOnlineMeetingProviders: ${JSON.stringify(c.allowedOnlineMeetingProviders)}`);
  }
  const primary = list.find((c) => c.isPrimary) ?? list[0];
  return {
    count: list.length,
    primaryId: primary?.id ?? null,
    isPrimaryReliable: list.some((c) => c.isPrimary),
    fields: list[0] ? Object.keys(list[0]) : [],
  };
});

const calendarId = calendars?.primaryId;
if (!calendarId) {
  line('\n✖ No calendar found — cannot continue to event steps.');
  save(`phase1/${provider}/_summary.json`, { accountId: '«redacted-by-policy»', findings });
  process.exit(1);
}

// ── 3. freeBusy (empty window, before we add anything) ───────────────────────────────
await step(3, 'freeBusy-before', async () => {
  const res = await rawProbe({
    name: 'freeBusy-before',
    method: 'POST',
    path: `/api/v1/freeBusy/${accountId}`,
    env,
    body: { startDateTime: START, endDateTime: END, timeZone: 'UTC', calendarIds: [calendarId] },
  });
  save(`phase1/${provider}/03-freebusy-before.json`, res);
  line(`HTTP ${res.response?.status}  body=${res.response?.bodyRaw?.slice(0, 300)}`);
  return { status: res.response?.status, body: res.response?.bodyParsed };
});

// ── 4. Create event (+ custom-id probe) ──────────────────────────────────────────────
const created = await step(4, 'event-create', async () => {
  const base = {
    title: 'BAL-393 spike — ignore',
    description:
      'Created by the BAL-393 throwaway harness. Safe to delete.\nhttps://balo.daily.co/spike-test-1',
    start: { dateTime: START, timeZone: 'UTC' },
    end: { dateTime: END, timeZone: 'UTC' },
    // "opaque" = busy, and it lives on `transparency`. `visibility` is a different axis
    // (default|public|private|confidential) — mixing them up is a 400.
    transparency: 'opaque',
    privateExtendedProperties: { baloBookingId: TAG },
  };

  // Probe: does the provider accept a caller-supplied id? (idempotency lever)
  const CUSTOM_ID = 'bal393spikecustomid001';
  const withId = await rawProbe({
    name: 'event-create-custom-id',
    method: 'POST',
    path: `/api/v1/events/${accountId}/${calendarId}`,
    env,
    body: { ...base, id: CUSTOM_ID },
  });
  save(`phase1/${provider}/04a-create-custom-id.json`, withId);
  line(`custom id → HTTP ${withId.response?.status}`);
  if (withId.response?.status >= 400)
    line(`  rejected: ${withId.response?.bodyRaw?.slice(0, 300)}`);

  // A 2xx is NOT enough: Microsoft returns 200 and silently substitutes its own id.
  // Honouring the id means the RETURNED id equals the one we asked for.
  const returnedId = withId.response?.bodyParsed?.id ?? null;
  const customIdHonoured = withId.response?.status < 400 && returnedId === CUSTOM_ID;
  const customIdSilentlyIgnored = withId.response?.status < 400 && returnedId !== CUSTOM_ID;
  if (customIdSilentlyIgnored) {
    line(
      `  ⚠ 2xx but id NOT honoured — provider substituted "${String(returnedId).slice(0, 32)}…"`
    );
    line('    → caller-supplied ids are NOT an idempotency lever on this provider.');
  }

  // Either way an event now exists; only fall through to a plain create on a real failure.
  const customIdAccepted = withId.response?.status < 400;
  let res = withId;
  if (!customIdAccepted) {
    res = await rawProbe({
      name: 'event-create',
      method: 'POST',
      path: `/api/v1/events/${accountId}/${calendarId}`,
      env,
      body: base,
    });
    save(`phase1/${provider}/04b-create.json`, res);
    line(`plain create → HTTP ${res.response?.status}`);
  }

  const ev = res.response?.bodyParsed ?? {};
  line(`eventId=${ev.id ?? '—'}  fields=${Object.keys(ev).join(', ').slice(0, 200)}`);
  line(`privateExtendedProperties round-tripped: ${JSON.stringify(ev.privateExtendedProperties)}`);
  if (ev.conferenceData) line(`conferenceData: ${JSON.stringify(ev.conferenceData).slice(0, 200)}`);
  return {
    customIdHonoured,
    customIdSilentlyIgnored,
    eventId: ev.id ?? null,
    echoedPrivateProps: ev.privateExtendedProperties ?? null,
  };
});

const eventId = created?.eventId;

// ── 5. metadataFilters round-trip ────────────────────────────────────────────────────
await step(5, 'metadata-roundtrip', async () => {
  const filter = encodeURIComponent(JSON.stringify({ baloBookingId: TAG }));
  const res = await rawProbe({
    name: 'metadata-roundtrip',
    path: `/api/v1/events/${accountId}/${calendarId}?metadataFilters=${filter}`,
    env,
  });
  save(`phase1/${provider}/05-metadata-filter.json`, res);
  const hits = res.response?.bodyParsed?.data ?? [];
  line(
    `HTTP ${res.response?.status}  matched=${hits.length}  ids=${hits.map((e) => e.id).join(', ') || '—'}`
  );
  const found = hits.some((e) => e.id === eventId);
  line(
    found
      ? '✔ reconciliation backbone works — tagged event found by filter'
      : '✖ tagged event NOT returned by metadataFilters'
  );
  return { status: res.response?.status, matched: hits.length, foundOurEvent: found };
});

// ── 6. freeBusy again (now busy) ─────────────────────────────────────────────────────
await step(6, 'freeBusy-after', async () => {
  const res = await rawProbe({
    name: 'freeBusy-after',
    method: 'POST',
    path: `/api/v1/freeBusy/${accountId}`,
    env,
    body: {
      startDateTime: '2026-08-20T00:00:00Z',
      endDateTime: '2026-08-21T00:00:00Z',
      timeZone: 'UTC',
      calendarIds: [calendarId],
    },
  });
  save(`phase1/${provider}/06-freebusy-after.json`, res);
  line(`HTTP ${res.response?.status}`);
  line(`body: ${res.response?.bodyRaw?.slice(0, 500)}`);
  return { status: res.response?.status, body: res.response?.bodyParsed };
});

// ── 7. Reschedule (PUT) then delete ──────────────────────────────────────────────────
if (eventId) {
  await step(7, 'event-update-delete', async () => {
    const upd = await rawProbe({
      name: 'event-update',
      method: 'PUT',
      path: `/api/v1/events/${accountId}/${calendarId}/${eventId}`,
      env,
      body: {
        title: 'BAL-393 spike — rescheduled',
        start: { dateTime: MOVED_START, timeZone: 'UTC' },
        end: { dateTime: MOVED_END, timeZone: 'UTC' },
      },
    });
    save(`phase1/${provider}/07a-update.json`, upd);
    line(
      `PUT → HTTP ${upd.response?.status}  newStart=${JSON.stringify(upd.response?.bodyParsed?.start)}`
    );
    line(
      `  privateExtendedProperties survived PUT: ${JSON.stringify(upd.response?.bodyParsed?.privateExtendedProperties)}`
    );

    const del = await rawProbe({
      name: 'event-delete',
      method: 'DELETE',
      path: `/api/v1/events/${accountId}/${calendarId}/${eventId}`,
      env,
    });
    save(`phase1/${provider}/07b-delete.json`, del);
    line(`DELETE → HTTP ${del.response?.status}  body=${del.response?.bodyRaw?.slice(0, 200)}`);

    return {
      updateStatus: upd.response?.status,
      privatePropsSurvivePut: upd.response?.bodyParsed?.privateExtendedProperties ?? null,
      deleteStatus: del.response?.status,
    };
  });
}

// ── 8. Paging / sync tokens ──────────────────────────────────────────────────────────
await step(8, 'paging-sync-tokens', async () => {
  const first = await rawProbe({
    name: 'events-page-1',
    path: `/api/v1/events/${accountId}/${calendarId}`,
    env,
  });
  save(`phase1/${provider}/08a-events-page1.json`, first);
  const body = first.response?.bodyParsed ?? {};
  const count = body.data?.length ?? 0;
  line(`page 1: count=${count}  keys=${Object.keys(body).join(', ')}`);
  line(`  nextPageToken=${JSON.stringify(body.nextPageToken)}`);
  line(`  nextSyncToken=${JSON.stringify(body.nextSyncToken)}`);

  let second = null;
  if (body.nextSyncToken) {
    second = await rawProbe({
      name: 'events-sync',
      path: `/api/v1/events/${accountId}/${calendarId}?syncToken=${encodeURIComponent(body.nextSyncToken)}`,
      env,
    });
    save(`phase1/${provider}/08b-events-synctoken.json`, second);
    const b2 = second.response?.bodyParsed ?? {};
    line(
      `delta read: HTTP ${second.response?.status} count=${b2.data?.length ?? 0} nextSyncToken=${JSON.stringify(b2.nextSyncToken)}`
    );
  } else {
    line('  ⚠ no nextSyncToken on a plain list — may require an explicit param. Finding.');
  }

  return {
    defaultPageSize: count,
    hasNextPageToken: body.nextPageToken != null,
    hasNextSyncToken: body.nextSyncToken != null,
    envelopeKeys: Object.keys(body),
    deltaStatus: second?.response?.status ?? null,
  };
});

const path = save(`phase1/${provider}/_summary.json`, {
  provider: P,
  capturedAt: '2026-08-14',
  calendarId,
  findings,
});
heading('Phase 1 done');
line(`Summary: ${path}`);
