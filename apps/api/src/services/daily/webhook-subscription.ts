/**
 * BAL-518 — the per-environment Daily webhook subscription, for the
 * OPS script `apps/api/scripts/daily-webhook.ts` ONLY.
 *
 * `.claude/skills/daily-co/SKILL.md` ("Registration is a one-off per-environment OPS step")
 * still holds: nothing at runtime imports this module, and
 * `invariants/daily-webhook-subscription-is-script-only.test.ts` fails if anything does.
 *
 * ── VENDOR SHAPES (verified against docs.daily.co) ───────────────────────────────────────
 *
 *   · `GET /webhooks` (webhooks/list-webhooks) answers a bare array of `{ uuid, url, hmac,
 *     basicAuth, retryType, eventTypes, state, failedCount, lastMomentPushed, domainId,
 *     createdAt, updatedAt }`.
 *   · `GET /` (domain/get-domain-config) answers the domain config including `domain_name`.
 *   · `enable_recording` is not a settable domain property (domain/set-domain-config); recording
 *     is chosen per room at create in `rooms.ts`, so this module sets no domain properties.
 *
 * ── SAFETY RULES ─────────────────────────────────────────────────────────────────────────
 *
 *   · Bubble owns the `getbalo` domain and its only webhook subscription
 *     (`max_webhook_count` is 1). {@link planDailyWebhookSync} refuses on that domain and
 *     refuses whenever ANY existing webhook points elsewhere; this module never deletes one.
 *   · The webhook secret is the `hmac` sent to Daily. It is never part of a returned summary:
 *     {@link projectDailyWebhook} is an allow-list, so `hmac` and `basicAuth` cannot survive.
 *     The listed `hmac` is reduced to the boolean `hmacMatches`, a constant-time comparison
 *     against the configured secret.
 *   · A webhook url can carry credentials or a token in its query string, so anything printed
 *     goes through {@link displayWebhookUrl} (`origin + pathname` only).
 *   · The sync/verify orchestration lives here ({@link runDailyWebhookSync},
 *     {@link runDailyWebhookVerify}); the script only parses arguments and prints the report.
 */
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { dailyRequest } from './client.js';
import type { DailyApiError } from './errors.js';
import { HANDLED_DAILY_EVENT_TYPES } from './webhook-events.js';
import { isBase64Secret } from './webhook-signature.js';

export const DAILY_WEBHOOK_RETRY_TYPE = 'exponential';

/** The domain Bubble's production app shares. Never register against it. */
export const BUBBLE_SHARED_DAILY_DOMAIN = 'getbalo';

/** The route's path, `routes/daily/webhook.ts`. */
const WEBHOOK_PATH = '/webhooks/daily';

/** Decoded secret length Daily's HMAC key needs to be worth having. */
const MIN_SECRET_BYTES = 32;

export interface DailyWebhookSummary {
  uuid: string;
  url: string;
  state: string;
  retryType: string;
  eventTypes: string[];
  failedCount: number | null;
  /** `null` when no secret was supplied to compare against. Never the `hmac` itself. */
  hmacMatches: boolean | null;
}

export type DailyWebhookPlan =
  | { kind: 'create' }
  | { kind: 'update'; uuid: string; reasons: string[] }
  | { kind: 'in_sync'; uuid: string }
  | { kind: 'refuse'; reason: string };

export interface DailyWebhookBody {
  url: string;
  eventTypes: string[];
  hmac: string;
  retryType: typeof DAILY_WEBHOOK_RETRY_TYPE;
}

/**
 * An allow-list: any key not named here (`basicAuth`, …) is dropped on parse. `hmac` is read
 * only to compute `hmacMatches` and never leaves `projectDailyWebhook`.
 */
const webhookSchema = z.object({
  uuid: z.string(),
  url: z.string(),
  state: z.string(),
  retryType: z.string(),
  eventTypes: z.array(z.string()),
  failedCount: z.number().nullish(),
  hmac: z.string().nullish(),
});

/** Constant-time equality over two strings; unequal lengths are unequal without a compare. */
function secretsMatch(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual, 'utf8');
  const expectedBytes = Buffer.from(expected, 'utf8');
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

export function projectDailyWebhook(raw: unknown, secret?: string): DailyWebhookSummary {
  const parsed = webhookSchema.parse(raw);
  let hmacMatches: boolean | null = null;
  if (secret !== undefined && parsed.hmac != null) {
    hmacMatches = secretsMatch(parsed.hmac, secret);
  }
  return {
    uuid: parsed.uuid,
    url: parsed.url,
    state: parsed.state,
    retryType: parsed.retryType,
    eventTypes: parsed.eventTypes,
    failedCount: parsed.failedCount ?? null,
    hmacMatches,
  };
}

/** The url as safe to print: `origin + pathname`, never credentials, query string or fragment. */
export function displayWebhookUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return '[unparseable url]';
  }
}

export function buildDailyWebhookBody(url: string, secret: string): DailyWebhookBody {
  return {
    url,
    eventTypes: [...HANDLED_DAILY_EVENT_TYPES],
    hmac: secret,
    retryType: DAILY_WEBHOOK_RETRY_TYPE,
  };
}

/**
 * The target must be https, carry no credentials, query string or fragment, and end at exactly the
 * route the API serves. Returns the normalised `origin + pathname`.
 */
export function validateWebhookTargetUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('webhook url is not a valid URL');
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('webhook url must be https');
  }
  if (parsed.pathname !== WEBHOOK_PATH) {
    throw new Error(`webhook url path must be exactly ${WEBHOOK_PATH}`);
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new Error('webhook url must not carry credentials');
  }
  if (parsed.search !== '' || parsed.hash !== '') {
    throw new Error('webhook url must not carry a query string or fragment');
  }
  return `${parsed.origin}${parsed.pathname}`;
}

/** The secret must be base64 (Daily's HMAC key is its decoded bytes) and at least 32 bytes decoded. */
export function validateWebhookSecret(secret: string): void {
  if (!isBase64Secret(secret)) {
    throw new Error(
      'DAILY_WEBHOOK_SECRET is not valid base64 — generate it with: openssl rand -base64 32'
    );
  }
  if (Buffer.from(secret, 'base64').length < MIN_SECRET_BYTES) {
    throw new Error(`DAILY_WEBHOOK_SECRET decodes to fewer than ${MIN_SECRET_BYTES} bytes`);
  }
}

export function diffEventTypes(actual: readonly string[]): { missing: string[]; extra: string[] } {
  const have = new Set(actual);
  const want = new Set<string>(HANDLED_DAILY_EVENT_TYPES);
  return {
    missing: HANDLED_DAILY_EVENT_TYPES.filter((type) => !have.has(type)),
    extra: [...have].filter((type) => !want.has(type)),
  };
}

/** Why a registered webhook differs from the desired subscription; empty when it matches. */
export function webhookDriftReasons(hook: DailyWebhookSummary, targetUrl?: string): string[] {
  const reasons: string[] = [];
  if (targetUrl !== undefined && hook.url !== targetUrl) {
    reasons.push(`url differs from ${targetUrl}`);
  }
  if (hook.state !== 'ACTIVE') {
    reasons.push(`state is ${hook.state}`);
  }
  if (hook.retryType !== DAILY_WEBHOOK_RETRY_TYPE) {
    reasons.push(`retryType is ${hook.retryType}`);
  }
  const { missing, extra } = diffEventTypes(hook.eventTypes);
  if (missing.length > 0) {
    reasons.push(`missing event types: ${missing.join(', ')}`);
  }
  if (extra.length > 0) {
    reasons.push(`unexpected event types: ${extra.join(', ')}`);
  }
  if (hook.hmacMatches === false) {
    reasons.push('hmac differs');
  }
  return reasons;
}

export function planDailyWebhookSync(input: {
  domainName: string;
  existing: DailyWebhookSummary[];
  targetUrl: string;
  forceUpdate: boolean;
}): DailyWebhookPlan {
  const { domainName, existing, targetUrl, forceUpdate } = input;
  if (domainName === BUBBLE_SHARED_DAILY_DOMAIN) {
    return {
      kind: 'refuse',
      reason: `the API key belongs to the "${BUBBLE_SHARED_DAILY_DOMAIN}" domain, which Bubble owns`,
    };
  }
  const foreign = existing.find((hook) => hook.url !== targetUrl);
  if (foreign !== undefined) {
    return {
      kind: 'refuse',
      reason: `webhook ${foreign.uuid} already points at a different url (${displayWebhookUrl(foreign.url)}); the domain allows one subscription and this tool never modifies or deletes another`,
    };
  }
  const [match] = existing;
  if (match === undefined) {
    return { kind: 'create' };
  }

  const reasons = webhookDriftReasons(match);
  if (forceUpdate) {
    reasons.push('forced');
  }
  if (reasons.length === 0) {
    return { kind: 'in_sync', uuid: match.uuid };
  }
  return { kind: 'update', uuid: match.uuid, reasons };
}

/**
 * Replace every occurrence of `secret` in `text`, in its raw form and in the JSON-escaped form
 * (`/` written `\/`) a vendor body may carry. Linear scan via split/join; no regex.
 */
export function redactSecret(text: string, secret: string): string {
  if (secret.length === 0) {
    return text;
  }
  const escaped = secret.split('/').join(String.raw`\/`);
  return text.split(secret).join('[redacted]').split(escaped).join('[redacted]');
}

export function redactSecrets(text: string, secrets: readonly string[]): string {
  return secrets.reduce((redacted, secret) => redactSecret(redacted, secret), text);
}

/** The vendor's `error` field from a JSON error body, or `null` when absent or not JSON. */
function parsedErrorField(body: string): string | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === 'object' && parsed !== null && 'error' in parsed) {
      return typeof parsed.error === 'string' ? parsed.error : null;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * One printable line for a failed Daily call: method, path, status and only the parsed `error`
 * field, redacted of every secret. The raw body is never returned.
 */
export function formatDailyApiFailure(error: DailyApiError, secrets: readonly string[]): string {
  const head = `${error.method} ${error.path} → ${error.status}`;
  const detail = parsedErrorField(error.body);
  return redactSecrets(detail === null ? head : `${head}: ${detail}`, secrets);
}

const domainSchema = z.object({ domain_name: z.string() });

const webhookListSchema = z.array(z.unknown());

export async function getDailyDomain(): Promise<{ domainName: string }> {
  const parsed = domainSchema.parse(await dailyRequest<unknown>('GET', '/'));
  return { domainName: parsed.domain_name };
}

export async function listDailyWebhooks(secret?: string): Promise<DailyWebhookSummary[]> {
  const raw = webhookListSchema.parse(await dailyRequest<unknown>('GET', '/webhooks'));
  return raw.map((hook) => projectDailyWebhook(hook, secret));
}

export async function createDailyWebhook(body: DailyWebhookBody): Promise<DailyWebhookSummary> {
  return projectDailyWebhook(await dailyRequest<unknown>('POST', '/webhooks', body), body.hmac);
}

export async function updateDailyWebhook(
  uuid: string,
  body: DailyWebhookBody
): Promise<DailyWebhookSummary> {
  return projectDailyWebhook(
    await dailyRequest<unknown>('POST', `/webhooks/${encodeURIComponent(uuid)}`, body),
    body.hmac
  );
}

export interface DailyWebhookDeps {
  getDomain: typeof getDailyDomain;
  listWebhooks: typeof listDailyWebhooks;
  createWebhook: typeof createDailyWebhook;
  updateWebhook: typeof updateDailyWebhook;
}

const DEFAULT_DEPS: DailyWebhookDeps = {
  getDomain: getDailyDomain,
  listWebhooks: listDailyWebhooks,
  createWebhook: createDailyWebhook,
  updateWebhook: updateDailyWebhook,
};

export interface DailyWebhookVerifyHook {
  uuid: string;
  /** `origin + pathname` only. */
  url: string;
  state: string;
  retryType: string;
  failedCount: number | null;
  missing: string[];
  extra: string[];
  hmac: 'matches' | 'differs' | 'not checked';
  reasons: string[];
}

export interface DailyWebhookVerifyReport {
  domainName: string;
  hooks: DailyWebhookVerifyHook[];
  /** No webhook is registered, or any registered one drifted. */
  drifted: boolean;
}

export interface DailyWebhookVerifyInput {
  /** When set, every webhook must point at it. */
  url?: string;
  /** When set, the listed `hmac` is compared against it; otherwise it is not checked. */
  secret?: string;
}

function hmacLabel(matches: boolean | null): DailyWebhookVerifyHook['hmac'] {
  if (matches === null) {
    return 'not checked';
  }
  return matches ? 'matches' : 'differs';
}

export async function runDailyWebhookVerify(
  input: DailyWebhookVerifyInput,
  deps: DailyWebhookDeps = DEFAULT_DEPS
): Promise<DailyWebhookVerifyReport> {
  const targetUrl = input.url === undefined ? undefined : validateWebhookTargetUrl(input.url);
  const domain = await deps.getDomain();
  const listed = await deps.listWebhooks(input.secret);
  const hooks = listed.map((hook): DailyWebhookVerifyHook => {
    const { missing, extra } = diffEventTypes(hook.eventTypes);
    return {
      uuid: hook.uuid,
      url: displayWebhookUrl(hook.url),
      state: hook.state,
      retryType: hook.retryType,
      failedCount: hook.failedCount,
      missing,
      extra,
      hmac: hmacLabel(hook.hmacMatches),
      reasons: webhookDriftReasons(hook, targetUrl),
    };
  });
  return {
    domainName: domain.domainName,
    hooks,
    drifted: hooks.length === 0 || hooks.some((hook) => hook.reasons.length > 0),
  };
}

export interface DailyWebhookSyncInput {
  url: string;
  secret: string;
  apply: boolean;
  forceUpdate: boolean;
}

export interface DailyWebhookSyncReport {
  domainName: string;
  plan: DailyWebhookPlan;
  /** The request body with `hmac` redacted; `null` when the plan needs no request. */
  body: (Omit<DailyWebhookBody, 'hmac'> & { hmac: '[redacted]' }) | null;
  applied: { action: 'created' | 'updated'; uuid: string } | null;
  /** The re-verify after `apply`; `null` on a dry run or a refusal. */
  verify: DailyWebhookVerifyReport | null;
}

/**
 * Plan, and with `apply` execute, the one webhook subscription for the key's domain. A `refuse`
 * plan issues no write; a dry run issues no write. Applying issues at most one POST, then
 * re-verifies.
 */
export async function runDailyWebhookSync(
  input: DailyWebhookSyncInput,
  deps: DailyWebhookDeps = DEFAULT_DEPS
): Promise<DailyWebhookSyncReport> {
  const targetUrl = validateWebhookTargetUrl(input.url);
  validateWebhookSecret(input.secret);

  const domain = await deps.getDomain();
  const existing = await deps.listWebhooks(input.secret);
  const plan = planDailyWebhookSync({
    domainName: domain.domainName,
    existing,
    targetUrl,
    forceUpdate: input.forceUpdate,
  });
  const base = { domainName: domain.domainName, plan, applied: null, verify: null };

  if (plan.kind === 'refuse') {
    return { ...base, body: null };
  }
  const body = buildDailyWebhookBody(targetUrl, input.secret);
  const redactedBody = plan.kind === 'in_sync' ? null : { ...body, hmac: '[redacted]' as const };
  if (!input.apply) {
    return { ...base, body: redactedBody };
  }

  let applied: DailyWebhookSyncReport['applied'] = null;
  if (plan.kind === 'create') {
    applied = { action: 'created', uuid: (await deps.createWebhook(body)).uuid };
  } else if (plan.kind === 'update') {
    applied = { action: 'updated', uuid: (await deps.updateWebhook(plan.uuid, body)).uuid };
  }
  const verify = await runDailyWebhookVerify({ url: targetUrl, secret: input.secret }, deps);
  return { ...base, body: redactedBody, applied, verify };
}
