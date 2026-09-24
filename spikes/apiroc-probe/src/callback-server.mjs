// BAL-393 Phase 1 — minimal OAuth callback receiver.
// Listens on localhost:8787, captures whatever Apiroc appends to the redirect, and writes
// the endUserAccountId straight into .env so it never has to be transcribed by hand.
//
//   node src/callback-server.mjs
//
// Leave it running, complete the consent in the browser, then Ctrl-C.

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';

import { CAPTURES, ROOT, heading, line, save } from './lib.mjs';

const PORT = 8787;
const received = [];

/** Rewrite (or append) a single KEY=value line in .env, leaving everything else intact. */
function writeEnvVar(key, value) {
  const envPath = join(ROOT, '.env');
  let text = '';
  try {
    text = readFileSync(envPath, 'utf8');
  } catch {
    /* no .env yet — fall through to append */
  }
  const pattern = new RegExp(`^${key}=.*$`, 'm');
  if (pattern.test(text)) {
    writeFileSync(envPath, text.replace(pattern, `${key}=${value}`), 'utf8');
  } else {
    appendFileSync(envPath, `${key}=${value}\n`, 'utf8');
  }
}

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const query = Object.fromEntries(url.searchParams.entries());

  // Favicon and other browser noise — ignore.
  if (url.pathname !== '/callback') {
    res.writeHead(404).end('not the callback path');
    return;
  }

  const entry = { at: new Date().toISOString(), path: url.pathname, query };
  received.push(entry);

  heading('Callback received');
  line(`path:  ${url.pathname}`);
  line(`query: ${JSON.stringify(query, null, 2)}`);

  // The exact param name is one of the things this spike is measuring — accept any of the
  // plausible spellings rather than assuming, and report which one actually arrived.
  const idKey = ['endUserAccountId', 'end_user_account_id', 'accountId', 'id'].find(
    (k) => query[k]
  );
  const provider = (query.state ?? '').includes('microsoft') ? 'MICROSOFT' : 'GOOGLE';

  if (idKey) {
    const envKey = `${provider}_END_USER_ACCOUNT_ID`;
    writeEnvVar(envKey, query[idKey]);
    line(`\n✔ param name on the wire: "${idKey}"`);
    line(`✔ wrote ${envKey}=${query[idKey]} to .env`);
  } else {
    line(
      '\n⚠ No account-id-shaped param found. Full query captured above — record it as a finding.'
    );
  }

  save('phase1/oauth-callback.json', { received });

  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(
    `<!doctype html><meta charset="utf-8"><title>BAL-393 callback</title>` +
      `<body style="font-family:system-ui;padding:2rem;max-width:40rem">` +
      `<h2>✔ Callback captured</h2>` +
      `<p>${idKey ? `Saved <code>${idKey}</code> to <code>.env</code>.` : 'No account id found — check the terminal.'}</p>` +
      `<pre style="background:#f4f4f5;padding:1rem;border-radius:6px;overflow:auto">${JSON.stringify(
        query,
        null,
        2
      ).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c])}</pre>` +
      `<p>You can close this tab and return to the terminal.</p></body>`
  );
});

server.on('error', (error) => {
  line(`\n✖ Could not listen on :${PORT} — ${error.message}`);
  if (error.code === 'EADDRINUSE')
    line('  Something else is using 8787. Stop it, or change the port in .env + the dashboard.');
  process.exit(1);
});

server.listen(PORT, () => {
  heading(`Listening on http://localhost:${PORT}/callback`);
  line('Complete the consent in your browser. Ctrl-C when done.');
  line(`Captures → ${CAPTURES}/phase1/oauth-callback.json`);
});
