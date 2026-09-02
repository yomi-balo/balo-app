import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockCallSessionApi } = vi.hoisted(() => ({ mockCallSessionApi: vi.fn() }));

vi.mock('@/lib/credit/api-client', () => ({
  callSessionApi: mockCallSessionApi,
}));

import { fetchSessionStatement } from './session-statement';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';

describe('fetchSessionStatement (BAL-441)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns { outcome: "ok", statement } on a 2xx, requesting the statement route with GET', async () => {
    const statement = { lens: 'client', block: {}, context: {} };
    mockCallSessionApi.mockResolvedValue({ ok: true, status: 200, data: statement });

    const result = await fetchSessionStatement(SESSION_ID);

    expect(result).toEqual({ outcome: 'ok', statement });
    expect(mockCallSessionApi).toHaveBeenCalledWith(`/sessions/${SESSION_ID}/statement`, 'GET');
  });

  it.each([400, 401, 403, 404])('maps status %i to { outcome: "denied" }', async (status) => {
    mockCallSessionApi.mockResolvedValue({ ok: false, status, error: 'denied' });
    expect(await fetchSessionStatement(SESSION_ID)).toEqual({ outcome: 'denied' });
  });

  it('maps status 0 (transport failure) to { outcome: "unavailable" }', async () => {
    mockCallSessionApi.mockResolvedValue({ ok: false, status: 0, error: 'Something went wrong.' });
    expect(await fetchSessionStatement(SESSION_ID)).toEqual({ outcome: 'unavailable' });
  });

  it('maps a 5xx (incl. the route\'s own 503) to { outcome: "unavailable" }', async () => {
    mockCallSessionApi.mockResolvedValue({
      ok: false,
      status: 503,
      error: 'statement_unavailable',
    });
    expect(await fetchSessionStatement(SESSION_ID)).toEqual({ outcome: 'unavailable' });
  });

  it('FAILS LOUD on an unexpected status — never silently 404s', async () => {
    mockCallSessionApi.mockResolvedValue({ ok: false, status: 418, error: 'teapot' });
    expect(await fetchSessionStatement(SESSION_ID)).toEqual({ outcome: 'unavailable' });
  });

  // ── Security: the id reaches api URL CONSTRUCTION, so its shape is a control, not a nicety.
  // Next decodes dynamic segments, so these all arrive verbatim from the route param.
  it.each([
    ['path traversal to another api route', '../../admin/sessions/x/money-block'],
    ['encoded traversal', '%2E%2E%2Fadmin'],
    ['query injection', 'abc?foo=bar'],
    ['fragment injection', 'abc#frag'],
    ['plainly not a uuid', 'session_1'],
    ['empty', ''],
  ])('rejects %s WITHOUT ever calling the api', async (_label, malformed) => {
    expect(await fetchSessionStatement(malformed)).toEqual({ outcome: 'denied' });
    // The assertion that matters: a malformed id must never reach URL construction at all,
    // because `callSessionApi` attaches the viewer's Bearer token to whatever path it is given.
    expect(mockCallSessionApi).not.toHaveBeenCalled();
  });

  it('a malformed id is INDISTINGUISHABLE from a real denial — existence never leaks', async () => {
    mockCallSessionApi.mockResolvedValue({ ok: false, status: 404, error: 'not_found' });
    const realDenial = await fetchSessionStatement(SESSION_ID);
    const malformed = await fetchSessionStatement('not-a-uuid');
    expect(malformed).toEqual(realDenial);
  });
});
