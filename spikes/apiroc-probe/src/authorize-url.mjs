// BAL-393 Phase 1 helper — print the hosted-OAuth authorize URL for a provider.
// Yomi opens it, consents in the browser, and reports back the returned endUserAccountId.
// Credentials stay in the browser; nothing sensitive comes back through here.
//
//   node src/authorize-url.mjs google
//   node src/authorize-url.mjs microsoft

import { heading, line, loadEnv } from './lib.mjs';

const env = loadEnv();
const arg = (process.argv[2] ?? '').toLowerCase();

if (!['google', 'microsoft'].includes(arg)) {
  line('Usage: node src/authorize-url.mjs <google|microsoft>');
  process.exit(1);
}
const provider = arg.toUpperCase();

// The redirect must match an entry in dashboard → Application Details → Authorized Redirect URIs
// EXACTLY. If Apiroc rejected `http://localhost:...` there, that rejection is itself a finding —
// record it and switch to the cloudflared tunnel URL.
let url;
try {
  const { getOAuthUrl } = await import('@apiroc/unified-calendar-api-node-sdk/oauth');
  url = getOAuthUrl(env.appId, provider, {
    redirectUrl: env.redirectUri,
    state: `bal393-${arg}`,
    // Force the account chooser — without it the provider silently reuses whatever session
    // is already signed in, which is how a REAL account gets connected by accident.
    // `consent` additionally re-shows the scope checkboxes even when already granted, which
    // is what the partial-grant probe needs.
    prompt: process.argv[3] ?? 'select_account',
  });
} catch (error) {
  line(`SDK oauth helper unavailable (${error instanceof Error ? error.message : error}).`);
  line('Falling back to the documented URL shape — verify against the dashboard if it 404s.');
  const params = new URLSearchParams({
    appId: env.appId,
    provider,
    redirectUrl: env.redirectUri,
    state: `bal393-${arg}`,
  });
  url = `${env.baseUrl}/api/v1/oauth/authorize?${params.toString()}`;
}

heading(`Phase 1 — connect a ${provider} account`);
line(`redirect_uri (must be allowlisted verbatim): ${env.redirectUri}`);
line('');
line('Open this URL, consent with the THROWAWAY account, then report the endUserAccountId');
line('returned on the callback (query string) — paste it into .env as');
line(`${arg === 'google' ? 'GOOGLE' : 'MICROSOFT'}_END_USER_ACCOUNT_ID.`);
line('');
line(url);
line('');
