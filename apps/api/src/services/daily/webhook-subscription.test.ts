import { describe, expect, it, vi } from 'vitest';
import { TEST_DAILY_API_KEY, jsonResponse, useDailyApiKey } from '../../test/mocks/daily.js';
import { DAILY_API_BASE } from './client.js';
import { DailyApiError } from './errors.js';
import { HANDLED_DAILY_EVENT_TYPES } from './webhook-events.js';
import {
  BUBBLE_SHARED_DAILY_DOMAIN,
  DAILY_WEBHOOK_RETRY_TYPE,
  buildDailyWebhookBody,
  createDailyWebhook,
  diffEventTypes,
  displayWebhookUrl,
  formatDailyApiFailure,
  getDailyDomain,
  listDailyWebhooks,
  planDailyWebhookSync,
  projectDailyWebhook,
  redactSecret,
  redactSecrets,
  runDailyWebhookSync,
  runDailyWebhookVerify,
  updateDailyWebhook,
  validateWebhookSecret,
  validateWebhookTargetUrl,
  webhookDriftReasons,
  type DailyWebhookSummary,
} from './webhook-subscription.js';

useDailyApiKey();

const TARGET = 'https://api.example.test/webhooks/daily';
const SECRET = Buffer.alloc(32, 7).toString('base64');

function hook(overrides: Partial<DailyWebhookSummary> = {}): DailyWebhookSummary {
  return {
    uuid: 'hook-1',
    url: TARGET,
    state: 'ACTIVE',
    retryType: 'exponential',
    eventTypes: [...HANDLED_DAILY_EVENT_TYPES],
    failedCount: 0,
    hmacMatches: null,
    ...overrides,
  };
}

function plan(
  existing: DailyWebhookSummary[],
  extra: { domainName?: string; forceUpdate?: boolean } = {}
): ReturnType<typeof planDailyWebhookSync> {
  return planDailyWebhookSync({
    domainName: extra.domainName ?? 'balo-new',
    existing,
    targetUrl: TARGET,
    forceUpdate: extra.forceUpdate ?? false,
  });
}

describe('planDailyWebhookSync', () => {
  it('refuses on the Bubble-shared domain, even with nothing registered', () => {
    expect(plan([], { domainName: BUBBLE_SHARED_DAILY_DOMAIN }).kind).toBe('refuse');
  });

  it('refuses when any existing webhook points elsewhere (Bubble listener)', () => {
    const result = plan([hook({ url: 'https://balo.expert/api/1.1/wf/daily_listener' })]);
    expect(result.kind).toBe('refuse');
  });

  it('refuses even when a matching webhook sits beside a foreign one', () => {
    expect(plan([hook(), hook({ uuid: 'hook-2', url: 'https://other.test/x' })]).kind).toBe(
      'refuse'
    );
  });

  it('creates when none exists', () => {
    expect(plan([])).toEqual({ kind: 'create' });
  });

  it('is in_sync for an ACTIVE exponential webhook with every event type', () => {
    expect(plan([hook()])).toEqual({ kind: 'in_sync', uuid: 'hook-1' });
  });

  it.each([
    ['state', hook({ state: 'FAILED' }), 'state is FAILED'],
    ['retryType', hook({ retryType: 'circuit-breaker' }), 'retryType is circuit-breaker'],
    [
      'missing event type',
      hook({ eventTypes: ['participant.joined'] }),
      'missing event types: participant.left',
    ],
    [
      'extra event type',
      hook({ eventTypes: [...HANDLED_DAILY_EVENT_TYPES, 'room.created'] }),
      'unexpected event types: room.created',
    ],
  ])('updates on drifted %s', (_label, drifted, reason) => {
    const result = plan([drifted]);
    expect(result.kind).toBe('update');
    if (result.kind === 'update') {
      expect(result.uuid).toBe('hook-1');
      expect(result.reasons.join(' | ')).toContain(reason);
    }
  });

  it('updates with reason "hmac differs" when the listed hmac does not match the secret', () => {
    expect(plan([hook({ hmacMatches: false })])).toEqual({
      kind: 'update',
      uuid: 'hook-1',
      reasons: ['hmac differs'],
    });
  });

  it('stays in_sync when the hmac matches', () => {
    expect(plan([hook({ hmacMatches: true })])).toEqual({ kind: 'in_sync', uuid: 'hook-1' });
  });

  it('never puts a foreign webhook url query string into the refuse reason', () => {
    const result = plan([hook({ url: 'https://other.test/x?token=SECRETQUERY' })]);
    expect(result.kind).toBe('refuse');
    expect(JSON.stringify(result)).not.toContain('SECRETQUERY');
    expect(JSON.stringify(result)).toContain('https://other.test/x');
  });

  it('updates an in-sync webhook when forced', () => {
    expect(plan([hook()], { forceUpdate: true })).toEqual({
      kind: 'update',
      uuid: 'hook-1',
      reasons: ['forced'],
    });
  });
});

describe('buildDailyWebhookBody', () => {
  it('is exactly url, every handled event type, the secret as hmac, and exponential retry', () => {
    expect(buildDailyWebhookBody(TARGET, SECRET)).toEqual({
      url: TARGET,
      eventTypes: [...HANDLED_DAILY_EVENT_TYPES],
      hmac: SECRET,
      retryType: 'exponential',
    });
    expect(DAILY_WEBHOOK_RETRY_TYPE).toBe('exponential');
  });
});

describe('projectDailyWebhook', () => {
  it('drops hmac and basicAuth and never surfaces the secret', () => {
    const projected = projectDailyWebhook({
      uuid: 'u',
      url: TARGET,
      state: 'ACTIVE',
      retryType: 'exponential',
      eventTypes: ['meeting.ended'],
      failedCount: 2,
      hmac: SECRET,
      basicAuth: 'user:pass',
    });
    expect(JSON.stringify(projected)).not.toContain(SECRET);
    expect(JSON.stringify(projected)).not.toContain('user:pass');
    expect(projected.failedCount).toBe(2);
  });

  it('computes hmacMatches against the supplied secret and never returns the hmac', () => {
    const raw = { ...hook(), hmac: SECRET };
    expect(projectDailyWebhook(raw, SECRET).hmacMatches).toBe(true);
    expect(projectDailyWebhook(raw, Buffer.alloc(32, 8).toString('base64')).hmacMatches).toBe(
      false
    );
    expect(projectDailyWebhook(raw, 'short').hmacMatches).toBe(false);
    // Daily omitted the hmac: unknown, not a mismatch, so sync doesn't loop on "hmac differs".
    expect(projectDailyWebhook({ ...hook() }, SECRET).hmacMatches).toBeNull();
    expect(projectDailyWebhook(raw).hmacMatches).toBeNull();
    expect(JSON.stringify(projectDailyWebhook(raw, SECRET))).not.toContain(SECRET);
  });

  it('maps a missing failedCount to null', () => {
    const withoutCount: Record<string, unknown> = { ...hook() };
    delete withoutCount.failedCount;
    expect(projectDailyWebhook(withoutCount).failedCount).toBeNull();
  });

  it('throws on a malformed webhook', () => {
    expect(() => projectDailyWebhook({ uuid: 1 })).toThrow();
  });
});

describe('validateWebhookTargetUrl', () => {
  it('accepts an https url at exactly /webhooks/daily', () => {
    expect(validateWebhookTargetUrl(TARGET)).toBe(TARGET);
  });

  it.each([
    ['http', 'http://api.example.test/webhooks/daily'],
    ['wrong path', 'https://api.example.test/webhooks/stripe'],
    ['trailing path', 'https://api.example.test/webhooks/daily/x'],
    ['query', 'https://api.example.test/webhooks/daily?x=1'],
    ['fragment', 'https://api.example.test/webhooks/daily#x'],
    ['username', 'https://user@api.example.test/webhooks/daily'],
    ['username and password', 'https://user:pass@api.example.test/webhooks/daily'],
    ['not a url', 'nope'],
  ])('rejects %s', (_label, url) => {
    expect(() => validateWebhookTargetUrl(url)).toThrow();
  });

  it('returns origin + pathname only', () => {
    expect(validateWebhookTargetUrl('https://API.example.test:443/webhooks/daily')).toBe(
      'https://api.example.test/webhooks/daily'
    );
  });
});

describe('displayWebhookUrl', () => {
  it('drops credentials, query string and fragment', () => {
    expect(displayWebhookUrl('https://u:p@host.test/a/b?token=abc#frag')).toBe(
      'https://host.test/a/b'
    );
  });

  it('does not echo an unparseable value', () => {
    expect(displayWebhookUrl('not a url?token=abc')).toBe('[unparseable url]');
  });
});

describe('webhookDriftReasons', () => {
  it('is empty for a matching webhook', () => {
    expect(webhookDriftReasons(hook(), TARGET)).toEqual([]);
  });

  it('reports a url that differs from the target', () => {
    expect(webhookDriftReasons(hook({ url: 'https://other.test/x' }), TARGET)).toEqual([
      `url differs from ${TARGET}`,
    ]);
  });

  it('does not check the url without a target', () => {
    expect(webhookDriftReasons(hook({ url: 'https://other.test/x' }))).toEqual([]);
  });
});

describe('validateWebhookSecret', () => {
  it('accepts a base64 secret of 32 decoded bytes', () => {
    expect(() => validateWebhookSecret(SECRET)).not.toThrow();
  });

  it('rejects a non-base64 secret', () => {
    expect(() => validateWebhookSecret('not base64 !!!')).toThrow(/base64/);
  });

  it('rejects a base64 secret under 32 decoded bytes', () => {
    expect(() => validateWebhookSecret(Buffer.alloc(31, 1).toString('base64'))).toThrow(/32 bytes/);
  });
});

describe('diffEventTypes', () => {
  it('reports missing and extra types', () => {
    expect(diffEventTypes([...HANDLED_DAILY_EVENT_TYPES])).toEqual({ missing: [], extra: [] });
    const diff = diffEventTypes(['participant.joined', 'x.y']);
    expect(diff.extra).toEqual(['x.y']);
    expect(diff.missing).not.toContain('participant.joined');
    expect(diff.missing).toContain('meeting.ended');
  });
});

describe('redactSecret', () => {
  it('replaces every occurrence', () => {
    expect(redactSecret(`a ${SECRET} b ${SECRET}`, SECRET)).toBe('a [redacted] b [redacted]');
  });

  it('leaves text alone for an empty secret', () => {
    expect(redactSecret('abc', '')).toBe('abc');
  });

  it('also replaces the JSON-escaped form of a secret containing a slash', () => {
    expect(redactSecret(String.raw`ab/cd+ef/gh= ab\/cd+ef\/gh=`, 'ab/cd+ef/gh=')).toBe(
      '[redacted] [redacted]'
    );
  });
});

describe('redactSecrets', () => {
  it('redacts every secret in the list, skipping empty ones', () => {
    expect(redactSecrets('a KEY b SEC c', ['KEY', '', 'SEC'])).toBe('a [redacted] b [redacted] c');
  });
});

describe('formatDailyApiFailure', () => {
  const API_KEY = 'dk_live_abc/123';
  const SLASHY_SECRET = 'sec/ret+value=';

  it('prints method, path, status and only the parsed error field', () => {
    const body = JSON.stringify({ error: 'invalid-request-error', info: 'hmac too short' });
    const line = formatDailyApiFailure(new DailyApiError('POST', '/webhooks', 400, body), [
      SECRET,
      API_KEY,
    ]);
    expect(line).toBe('POST /webhooks → 400: invalid-request-error');
    expect(line).not.toContain('hmac too short');
  });

  it('redacts the secret and the API key from the error field, raw and JSON-escaped', () => {
    const body = String.raw`{"error":"bad sec\/ret+value= and dk_live_abc\/123 and ${SLASHY_SECRET}"}`;
    const line = formatDailyApiFailure(new DailyApiError('GET', '/', 401, body), [
      SLASHY_SECRET,
      API_KEY,
    ]);
    expect(line).toBe('GET / → 401: bad [redacted] and [redacted] and [redacted]');
  });

  it('never returns a non-JSON body', () => {
    const body = `<html>${API_KEY}</html>`;
    const line = formatDailyApiFailure(new DailyApiError('GET', '/', 502, body), [API_KEY]);
    expect(line).toBe('GET / → 502');
  });

  it('ignores an error field that is not a string', () => {
    const body = JSON.stringify({ error: { secret: SECRET } });
    const line = formatDailyApiFailure(new DailyApiError('GET', '/', 400, body), [SECRET]);
    expect(line).toBe('GET / → 400');
  });
});

describe('vendor calls', () => {
  function stubFetch(response: unknown, status = 200): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(status, response));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  function lastCall(fetchMock: ReturnType<typeof vi.fn>): [string, RequestInit] {
    return fetchMock.mock.calls[0] as [string, RequestInit];
  }

  it('getDailyDomain issues GET / and reads domain_name', async () => {
    const fetchMock = stubFetch({ domain_name: 'balo-new', config: { enable_recording: 'cloud' } });
    await expect(getDailyDomain()).resolves.toEqual({ domainName: 'balo-new' });
    const [url, init] = lastCall(fetchMock);
    expect(url).toBe(`${DAILY_API_BASE}/`);
    expect(init.method).toBe('GET');
    expect(init.headers).toEqual({ Authorization: `Bearer ${TEST_DAILY_API_KEY}` });
  });

  it('getDailyDomain throws when domain_name is missing', async () => {
    stubFetch({ config: {} });
    await expect(getDailyDomain()).rejects.toThrow();
  });

  it('listDailyWebhooks reads a bare array and projects each webhook', async () => {
    const fetchMock = stubFetch([{ ...hook(), hmac: SECRET, basicAuth: 'user:pass' }]);
    const listed = await listDailyWebhooks();
    expect(listed).toEqual([hook()]);
    expect(JSON.stringify(listed)).not.toContain(SECRET);
    const [url, init] = lastCall(fetchMock);
    expect(url).toBe(`${DAILY_API_BASE}/webhooks`);
    expect(init.method).toBe('GET');
  });

  it('listDailyWebhooks computes hmacMatches when given the secret', async () => {
    stubFetch([
      { ...hook(), hmac: SECRET },
      { ...hook({ uuid: 'hook-2' }), hmac: 'other' },
    ]);
    const listed = await listDailyWebhooks(SECRET);
    expect(listed.map((item) => item.hmacMatches)).toEqual([true, false]);
  });

  it('listDailyWebhooks rejects a non-array response', async () => {
    stubFetch({ data: [hook()] });
    await expect(listDailyWebhooks()).rejects.toThrow();
  });

  it('createDailyWebhook POSTs /webhooks with the full body and returns a projection', async () => {
    const fetchMock = stubFetch({ ...hook(), hmac: SECRET });
    const body = buildDailyWebhookBody(TARGET, SECRET);
    const created = await createDailyWebhook(body);
    const [url, init] = lastCall(fetchMock);
    expect(url).toBe(`${DAILY_API_BASE}/webhooks`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual(body);
    expect(JSON.stringify(created)).not.toContain(SECRET);
    expect(created.hmacMatches).toBe(true);
  });

  it('updateDailyWebhook POSTs /webhooks/:uuid with the full body', async () => {
    const fetchMock = stubFetch(hook());
    const body = buildDailyWebhookBody(TARGET, SECRET);
    await updateDailyWebhook('hook-1', body);
    const [url, init] = lastCall(fetchMock);
    expect(url).toBe(`${DAILY_API_BASE}/webhooks/hook-1`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual(body);
  });
});

describe('runDailyWebhookVerify / runDailyWebhookSync', () => {
  const BUBBLE_URL = 'https://balo.expert/api/1.1/wf/daily_listener?key=BUBBLEKEY';
  const SYNC = { url: TARGET, secret: SECRET, apply: false, forceUpdate: false };

  function stubDaily(route: { domain?: string; hooks?: unknown[] }): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      if (init.method === 'POST') {
        return jsonResponse(200, hook({ uuid: 'hook-new' }));
      }
      if (url === `${DAILY_API_BASE}/`) {
        return jsonResponse(200, { domain_name: route.domain ?? 'balo-new' });
      }
      return jsonResponse(200, route.hooks ?? []);
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  function posts(fetchMock: ReturnType<typeof vi.fn>): [string, RequestInit][] {
    return (fetchMock.mock.calls as [string, RequestInit][]).filter(
      ([, init]) => init.method === 'POST'
    );
  }

  it('verify reports OK for a matching webhook and "not checked" without a secret', async () => {
    stubDaily({ hooks: [{ ...hook(), hmac: SECRET }] });
    const report = await runDailyWebhookVerify({ url: TARGET });
    expect(report.drifted).toBe(false);
    expect(report.hooks[0]?.hmac).toBe('not checked');
    expect(report.domainName).toBe('balo-new');
  });

  it('verify flags an hmac mismatch when the secret is supplied', async () => {
    stubDaily({ hooks: [{ ...hook(), hmac: 'rotated-away' }] });
    const report = await runDailyWebhookVerify({ url: TARGET, secret: SECRET });
    expect(report.drifted).toBe(true);
    expect(report.hooks[0]?.hmac).toBe('differs');
    expect(report.hooks[0]?.reasons).toContain('hmac differs');
  });

  it('verify flags no webhook, and a different url with a failed state, printing urls safely', async () => {
    stubDaily({ hooks: [] });
    await expect(runDailyWebhookVerify({})).resolves.toMatchObject({ drifted: true, hooks: [] });

    stubDaily({ hooks: [hook({ url: BUBBLE_URL, state: 'FAILED' })] });
    const report = await runDailyWebhookVerify({ url: TARGET });
    expect(report.drifted).toBe(true);
    expect(JSON.stringify(report)).not.toContain('BUBBLEKEY');
    expect(report.hooks[0]?.url).toBe('https://balo.expert/api/1.1/wf/daily_listener');
  });

  it('sync refuses on the getbalo domain and issues no POST', async () => {
    const fetchMock = stubDaily({ domain: 'getbalo', hooks: [] });
    const report = await runDailyWebhookSync({ ...SYNC, apply: true });
    expect(report.plan.kind).toBe('refuse');
    expect(report.body).toBeNull();
    expect(report.verify).toBeNull();
    expect(posts(fetchMock)).toHaveLength(0);
  });

  it("sync refuses next to Bubble's webhook and issues no POST, never echoing its query", async () => {
    const fetchMock = stubDaily({ hooks: [hook({ uuid: 'bubble', url: BUBBLE_URL })] });
    const report = await runDailyWebhookSync({ ...SYNC, apply: true, forceUpdate: true });
    expect(report.plan.kind).toBe('refuse');
    expect(JSON.stringify(report)).not.toContain('BUBBLEKEY');
    expect(posts(fetchMock)).toHaveLength(0);
  });

  it('sync is a dry run by default: plans the create, redacts hmac, issues no POST', async () => {
    const fetchMock = stubDaily({ hooks: [] });
    const report = await runDailyWebhookSync(SYNC);
    expect(report.plan).toEqual({ kind: 'create' });
    expect(report.body).toEqual({
      url: TARGET,
      eventTypes: [...HANDLED_DAILY_EVENT_TYPES],
      hmac: '[redacted]',
      retryType: 'exponential',
    });
    expect(JSON.stringify(report)).not.toContain(SECRET);
    expect(report.applied).toBeNull();
    expect(posts(fetchMock)).toHaveLength(0);
  });

  it('sync --apply issues exactly one POST with the expected body, then re-verifies', async () => {
    const fetchMock = stubDaily({ hooks: [] });
    const report = await runDailyWebhookSync({ ...SYNC, apply: true });
    const sent = posts(fetchMock);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.[0]).toBe(`${DAILY_API_BASE}/webhooks`);
    expect(JSON.parse(String(sent[0]?.[1].body))).toEqual(buildDailyWebhookBody(TARGET, SECRET));
    expect(report.applied).toEqual({ action: 'created', uuid: 'hook-new' });
    expect(report.verify).not.toBeNull();
    expect(JSON.stringify(report)).not.toContain(SECRET);
  });

  it('sync --apply updates a drifted webhook with one POST to its uuid', async () => {
    const fetchMock = stubDaily({ hooks: [{ ...hook(), hmac: 'old' }] });
    const report = await runDailyWebhookSync({ ...SYNC, apply: true });
    expect(report.plan).toEqual({ kind: 'update', uuid: 'hook-1', reasons: ['hmac differs'] });
    const sent = posts(fetchMock);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.[0]).toBe(`${DAILY_API_BASE}/webhooks/hook-1`);
    expect(report.applied).toEqual({ action: 'updated', uuid: 'hook-new' });
  });

  it('sync --apply on an in-sync webhook issues no POST but still verifies', async () => {
    const fetchMock = stubDaily({ hooks: [{ ...hook(), hmac: SECRET }] });
    const report = await runDailyWebhookSync({ ...SYNC, apply: true });
    expect(report.plan.kind).toBe('in_sync');
    expect(report.body).toBeNull();
    expect(report.verify?.drifted).toBe(false);
    expect(posts(fetchMock)).toHaveLength(0);
  });

  it('sync rejects an invalid url or secret before any request', async () => {
    const fetchMock = stubDaily({});
    await expect(
      runDailyWebhookSync({ ...SYNC, url: 'http://x.test/webhooks/daily' })
    ).rejects.toThrow(/https/);
    await expect(runDailyWebhookSync({ ...SYNC, secret: 'nope!!' })).rejects.toThrow(/base64/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
