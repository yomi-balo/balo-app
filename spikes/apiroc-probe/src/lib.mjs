// BAL-393 spike harness — shared helpers.
// Disposable code. Not product code, not a pattern to copy.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, '..');
export const CAPTURES = join(ROOT, 'captures');

/** Values that must never reach stdout, a capture file, or Linear. */
const SECRETS = new Set();

export function loadEnv() {
  try {
    process.loadEnvFile(join(ROOT, '.env'));
  } catch {
    fail(
      'No .env found. Copy .env.example to .env and fill in APIROC_API_KEY + APIROC_APP_ID.\n' +
        '  cp spikes/apiroc-probe/.env.example spikes/apiroc-probe/.env'
    );
  }

  const apiKey = process.env.APIROC_API_KEY?.trim();
  const appId = process.env.APIROC_APP_ID?.trim();
  if (!apiKey) fail('APIROC_API_KEY is empty in .env');
  if (!appId) fail('APIROC_APP_ID is empty in .env');

  SECRETS.add(apiKey);

  return {
    apiKey,
    appId,
    baseUrl: (process.env.APIROC_BASE_URL || 'https://api.onecalunified.com').replace(/\/+$/, ''),
    redirectUri: process.env.APIROC_REDIRECT_URI || 'http://localhost:8787/callback',
    googleAccountId: process.env.GOOGLE_END_USER_ACCOUNT_ID?.trim() || null,
    microsoftAccountId: process.env.MICROSOFT_END_USER_ACCOUNT_ID?.trim() || null,
    webhookPublicUrl: process.env.WEBHOOK_PUBLIC_URL?.trim() || null,
  };
}

function fail(message) {
  process.stderr.write(`\n✖ ${message}\n\n`);
  process.exit(1);
}

/**
 * Strip every known secret out of anything on its way to disk or the terminal.
 * Belt-and-braces: we also never put the key into a captured request record.
 */
export function redact(value) {
  let text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  if (text === undefined) return text;
  for (const secret of SECRETS) {
    if (secret.length >= 8) text = text.split(secret).join('«REDACTED»');
  }
  return text;
}

/** Header allowlist — everything else is dropped so no key can leak via a capture. */
const SAFE_RESPONSE_HEADERS = [
  'content-type',
  'retry-after',
  'x-request-id',
  'x-ratelimit-limit',
  'x-ratelimit-remaining',
  'x-ratelimit-reset',
  'ratelimit-limit',
  'ratelimit-remaining',
  'ratelimit-reset',
  'date',
  'svix-id',
  'svix-timestamp',
];

function pickHeaders(headers) {
  const out = {};
  for (const name of SAFE_RESPONSE_HEADERS) {
    const v = headers.get(name);
    if (v !== null) out[name] = v;
  }
  return out;
}

/**
 * Raw HTTP probe — bypasses the SDK so we capture the true wire envelope
 * (`{ error, message, requestId }` per docs) rather than the SDK's normalised shape.
 *
 * `auth`: 'valid' | 'missing' | 'garbage'
 */
export async function rawProbe({ name, method = 'GET', path, body, auth = 'valid', env }) {
  const url = `${env.baseUrl}${path}`;
  const headers = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (auth === 'valid') headers['x-api-key'] = env.apiKey;
  if (auth === 'garbage') headers['x-api-key'] = 'not-a-real-key-000000000000';

  const started = Date.now();
  let response;
  let networkError = null;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    networkError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  }

  const record = {
    probe: name,
    request: {
      method,
      // Never record the header VALUE — only which auth mode was used.
      url,
      authMode: auth,
      body: body ?? null,
    },
    durationMs: Date.now() - started,
  };

  if (networkError !== null || !response) {
    record.networkError = networkError;
    return record;
  }

  const text = await response.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* non-JSON body — keep the raw text only */
  }

  record.response = {
    status: response.status,
    statusText: response.statusText,
    headers: pickHeaders(response.headers),
    bodyRaw: text.length > 20_000 ? `${text.slice(0, 20_000)}…«truncated»` : text,
    bodyParsed: parsed,
  };
  return record;
}

/**
 * Run the same failure through the SDK and record how it normalises the error
 * (`{ code, message, details, status }` + the thrown class name). This is the shape the
 * real adapter would branch on, so both halves matter.
 */
export async function sdkProbe(name, fn) {
  const started = Date.now();
  try {
    const result = await fn();
    return {
      probe: name,
      threw: false,
      result: summarise(result),
      durationMs: Date.now() - started,
    };
  } catch (error) {
    return {
      probe: name,
      threw: true,
      durationMs: Date.now() - started,
      errorClass: error?.constructor?.name ?? typeof error,
      // These are the fields the skill claims exist — capture whatever is actually present.
      code: error?.code ?? null,
      status: error?.status ?? null,
      message: error?.message ?? null,
      details: error?.details ?? null,
      retryAfter: error?.retryAfter ?? null,
      ownKeys: error && typeof error === 'object' ? Object.keys(error) : [],
    };
  }
}

/** Keep captures readable — we want shapes, not megabytes. */
function summarise(value) {
  if (value === null || typeof value !== 'object') return value;
  const text = JSON.stringify(value);
  if (text !== undefined && text.length > 20_000)
    return { truncated: true, preview: text.slice(0, 20_000) };
  return value;
}

/** Credential fields that must never reach a capture file, at any depth. */
const SECRET_KEYS = new Set(['accessToken', 'refreshToken', 'password', 'endpointSecret']);

/**
 * Google calendar ids and iCalUIDs are shaped like email addresses but are opaque
 * machine ids, not people. Keep those — they carry real schema signal — and redact
 * anything that identifies an actual human.
 */
const MACHINE_EMAIL = /@(group\.)?(v\.)?calendar\.google\.com$|@google\.com$/;

function scrub(value) {
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => {
        if (SECRET_KEYS.has(k) && v != null) {
          return [k, `«${typeof v} present, ${String(v).length} chars — REDACTED»`];
        }
        return [k, scrub(v)];
      })
    );
  }
  if (typeof value === 'string') {
    // `bodyRaw` holds the same payload as a JSON *string*, so key-based redaction above
    // would sail straight past the tokens inside it. Re-scrub through the parsed form.
    if (/^\s*[[{]/.test(value)) {
      try {
        return JSON.stringify(scrub(JSON.parse(value)));
      } catch {
        /* not JSON after all — fall through to the plain string path */
      }
    }
    // Personal addresses (the expert's own, and any third party who invited them) are PII
    // and must not land in the repo. Calendar-infrastructure ids stay.
    return value.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-z]{2,}/g, (m) =>
      MACHINE_EMAIL.test(m) ? m : '«email-redacted»'
    );
  }
  return value;
}

export function save(relativePath, data) {
  const target = join(CAPTURES, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  // scrub() strips credentials + personal emails from the object tree; redact() then
  // sweeps the serialised text for the API key. Both, deliberately.
  writeFileSync(target, `${redact(scrub(data))}\n`, 'utf8');
  return target;
}

export function heading(text) {
  process.stdout.write(`\n\x1b[1m${text}\x1b[0m\n${'─'.repeat(text.length)}\n`);
}

export function line(text) {
  process.stdout.write(`${redact(text)}\n`);
}
