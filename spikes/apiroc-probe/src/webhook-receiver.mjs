// BAL-393 Phase 2 — webhook receiver.
//
//   node src/webhook-receiver.mjs        (leave running behind a cloudflared tunnel)
//
// Path carries identity: /hook/:endUserAccountId/:calendarId?
// That is deliberate — the skill assumes the payload has NO account/calendar identity and
// that we must encode it in the per-subscription webhookUrl. This receiver captures both
// the path AND the verbatim body so we can prove whether that workaround is needed.
//
// Every request is recorded raw: full body text, ALL headers, arrival time. Nothing is
// interpreted before it is stored.

import { createServer } from 'node:http';

import { heading, line, save } from './lib.mjs';

const PORT = 8788;
const received = [];

/** Secrets per subscription, registered by subscribe.mjs via POST /_secret. */
const secrets = new Map();

function persist() {
  save('phase2/webhooks/received.json', {
    note: 'Verbatim webhook deliveries. Bodies are raw text, headers unfiltered.',
    count: received.length,
    received,
  });
}

const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    const rawBody = Buffer.concat(chunks).toString('utf8');
    const url = new URL(req.url, `http://localhost:${PORT}`);

    // Register a subscription secret so we can verify signatures as they arrive.
    if (url.pathname === '/_secret' && req.method === 'POST') {
      const { key, secret } = JSON.parse(rawBody);
      secrets.set(key, secret);
      line(`  ↳ registered endpointSecret for ${key}`);
      res.writeHead(200).end('ok');
      return;
    }

    // /hook/:acct/:cal? — identity encoded in the path
    const parts = url.pathname.split('/').filter(Boolean);
    const [root, pathAccountId, pathCalendarId] = parts;
    if (root !== 'hook') {
      res.writeHead(404).end('not a hook path');
      return;
    }

    const headers = { ...req.headers };
    const arrivedAt = new Date().toISOString();

    let parsed = null;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      /* keep raw only */
    }

    // Signature verification with the per-subscription secret.
    let signature = 'no-secret-registered';
    const secret = secrets.get(pathAccountId) ?? secrets.get('any');
    if (secret) {
      try {
        const { Webhook } = await import('svix');
        new Webhook(secret).verify(rawBody, {
          'svix-id': headers['svix-id'],
          'svix-timestamp': headers['svix-timestamp'],
          'svix-signature': headers['svix-signature'],
        });
        signature = 'VALID';
      } catch (error) {
        signature = `INVALID: ${error instanceof Error ? error.message : String(error)}`;
      }
    }

    const entry = {
      arrivedAt,
      method: req.method,
      path: url.pathname,
      identityFromPath: {
        endUserAccountId: pathAccountId ?? null,
        calendarId: pathCalendarId ?? null,
      },
      headers,
      svix: {
        id: headers['svix-id'] ?? null,
        timestamp: headers['svix-timestamp'] ?? null,
        signaturePresent: Boolean(headers['svix-signature']),
        verification: signature,
      },
      bodyRaw: rawBody,
      bodyParsed: parsed,
      // The whole question for Unknown 4: does the BODY identify the account/calendar?
      bodyCarriesIdentity: parsed
        ? Object.keys(parsed).filter((k) => /account|calendar|resource|id$/i.test(k))
        : null,
    };
    received.push(entry);
    persist();

    heading(`▼ webhook #${received.length}  ${arrivedAt}`);
    line(`path: ${url.pathname}`);
    line(`svix-id: ${entry.svix.id}   signature: ${signature}`);
    line(`body: ${rawBody || '«empty»'}`);
    line(`body keys hinting at identity: ${JSON.stringify(entry.bodyCarriesIdentity)}`);

    // Ack fast — Svix expects 2xx within ~15s or it retries.
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
  });
});

server.on('error', (error) => {
  line(`\n✖ Could not listen on :${PORT} — ${error.message}`);
  process.exit(1);
});

server.listen(PORT, () => {
  heading(`Webhook receiver on http://localhost:${PORT}`);
  line('Expose with:  cloudflared tunnel --url http://localhost:8788');
  line('Then subscribe with the printed https URL. Ctrl-C to stop.');
});
