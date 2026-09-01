// BAL-393 Unknown 2 — what happens to an account after the user revokes access
// provider-side.
//
//   node src/revoked-probe.mjs [google|microsoft] [--poll <seconds>]
//
// Run BEFORE revoking to capture the healthy baseline, then again straight after revoking.
// `--poll` re-checks on an interval, which is how we measure the lag between the
// provider-side revoke and Apiroc flipping the status.

import { heading, line, loadEnv, rawProbe, save } from './lib.mjs';

const env = loadEnv();
const provider = (process.argv[2] ?? 'google').toLowerCase();
const accountId = provider === 'microsoft' ? env.microsoftAccountId : env.googleAccountId;

const pollIndex = process.argv.indexOf('--poll');
const pollSeconds = pollIndex === -1 ? 0 : Number(process.argv[pollIndex + 1] ?? 30);

if (!accountId) {
  line(`\n✖ No ${provider} account id in .env.`);
  process.exit(1);
}

const label = process.argv.includes('--after') ? 'after-revoke' : 'baseline';

async function snapshot() {
  const account = await rawProbe({
    name: 'account',
    path: `/api/v1/endUserAccounts/${accountId}`,
    env,
  });
  const creds = await rawProbe({
    name: 'credentials',
    path: `/api/v1/endUserAccounts/${accountId}/credentials`,
    env,
  });
  // Two data calls: a metadata read and a real calendar-data read. They may differ —
  // Apiroc might serve cached metadata while the provider call fails.
  const calendars = await rawProbe({
    name: 'calendars',
    path: `/api/v1/calendars/${accountId}`,
    env,
  });
  const freeBusy = await rawProbe({
    name: 'freeBusy',
    method: 'POST',
    path: `/api/v1/freeBusy/${accountId}`,
    env,
    body: {
      startDateTime: '2026-08-20T00:00:00Z',
      endDateTime: '2026-08-21T00:00:00Z',
      timeZone: 'UTC',
      calendarIds: [calendars.response?.bodyParsed?.data?.[0]?.id ?? 'primary'],
    },
  });

  const a = account.response?.bodyParsed ?? {};
  const c = creds.response?.bodyParsed ?? {};

  return {
    accountHttp: account.response?.status,
    accountStatus: a.status ?? null,
    authorizedScopes: a.authorizedScopes ?? null,
    credentialsHttp: creds.response?.status,
    credentialStatus: c.status ?? null,
    credentialsBodyWhenFailed:
      creds.response?.status >= 400 ? creds.response?.bodyParsed : undefined,
    accessTokenPresent:
      typeof c.accessToken === 'string' ? true : c.accessToken === null ? false : 'absent-field',
    refreshTokenPresent:
      typeof c.refreshToken === 'string' ? true : c.refreshToken === null ? false : 'absent-field',
    calendarsHttp: calendars.response?.status,
    calendarsBody:
      calendars.response?.status >= 400
        ? calendars.response?.bodyParsed
        : `${calendars.response?.bodyParsed?.data?.length ?? 0} calendars`,
    freeBusyHttp: freeBusy.response?.status,
    freeBusyBody: freeBusy.response?.status >= 400 ? freeBusy.response?.bodyParsed : 'ok',
    raw: { account, creds, calendars, freeBusy },
  };
}

function report(s, title) {
  heading(title);
  line(`account      GET → HTTP ${s.accountHttp}   status=${s.accountStatus}`);
  line(
    `credentials  GET → HTTP ${s.credentialsHttp}  status=${s.credentialStatus}  accessToken=${s.accessTokenPresent} refreshToken=${s.refreshTokenPresent}`
  );
  if (s.credentialsBodyWhenFailed) line(`  body: ${JSON.stringify(s.credentialsBodyWhenFailed)}`);
  line(`calendars    GET → HTTP ${s.calendarsHttp}   ${JSON.stringify(s.calendarsBody)}`);
  line(`freeBusy    POST → HTTP ${s.freeBusyHttp}   ${JSON.stringify(s.freeBusyBody)}`);
  line(`scopes: ${JSON.stringify(s.authorizedScopes)}`);
}

const first = await snapshot();
report(first, `${provider.toUpperCase()} — ${label}`);
save(`phase2/${provider}/revocation-${label}.json`, first);

if (pollSeconds > 0) {
  heading(`Polling every ${pollSeconds}s — watching for a status flip (Ctrl-C to stop)`);
  const started = first.accountStatus;
  let n = 0;
  const timer = setInterval(async () => {
    n += 1;
    const s = await snapshot();
    const flipped = s.accountStatus !== started || s.calendarsHttp !== first.calendarsHttp;
    line(
      `  +${n * pollSeconds}s  accountStatus=${s.accountStatus}  credStatus=${s.credentialStatus}  calendars=${s.calendarsHttp}  freeBusy=${s.freeBusyHttp}${flipped ? '   ← CHANGED' : ''}`
    );
    if (flipped) {
      save(`phase2/${provider}/revocation-flipped-after-${n * pollSeconds}s.json`, s);
      report(s, `${provider.toUpperCase()} — state CHANGED after ~${n * pollSeconds}s`);
      clearInterval(timer);
    }
  }, pollSeconds * 1000);
}
