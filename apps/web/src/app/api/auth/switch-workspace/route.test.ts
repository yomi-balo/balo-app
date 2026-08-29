import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Mocks ───────────────────────────────────────────────────────

const mockGetSession = vi.fn();
vi.mock('@/lib/auth/session', () => ({ getSession: () => mockGetSession() }));

const mockSwitchWorkspace = vi.fn();
vi.mock('@/lib/workspaces/switch-workspace', () => ({
  switchWorkspace: (...args: unknown[]) => mockSwitchWorkspace(...args),
}));

// The real seal/unseal is exercised in `lib/workspaces/switch-token.test.ts`. Here it is
// stubbed so each rejection arm (missing / tampered / expired / wrong-user) is expressible.
const mockUnsealWorkspaceSwitchToken = vi.fn();
vi.mock('@/lib/workspaces/switch-token', () => ({
  WORKSPACE_SWITCH_TOKEN_PARAM: 't',
  unsealWorkspaceSwitchToken: (...args: unknown[]) => mockUnsealWorkspaceSwitchToken(...args),
}));

const mockLogWarn = vi.fn();
const mockLogError = vi.fn();
vi.mock('@/lib/logging', () => ({
  log: {
    info: vi.fn(),
    warn: (...args: unknown[]) => mockLogWarn(...args),
    error: (...args: unknown[]) => mockLogError(...args),
  },
}));

import { GET } from './route';

// ── Helpers ─────────────────────────────────────────────────────

const BASE_URL = 'http://localhost:3000';
const USER_ID = 'user-1';
const TARGET_KEY = 'company:11111111-1111-4111-8111-111111111111';

function makeRequest(queryString = '', headers: Record<string, string> = {}): NextRequest {
  const suffix = queryString ? `?${queryString}` : '';
  const url = `${BASE_URL}/api/auth/switch-workspace${suffix}`;
  return new NextRequest(new URL(url), { headers });
}

/** The query string a legitimately minted redirect carries. */
function signedQuery(returnTo: string, token = 'valid-token'): string {
  return `t=${encodeURIComponent(token)}&returnTo=${encodeURIComponent(returnTo)}`;
}

function getRedirectLocation(response: Response): string {
  const location = new URL(response.headers.get('Location') ?? '', BASE_URL);
  return location.pathname + location.search;
}

function onboardedSession(): void {
  mockGetSession.mockResolvedValue({ user: { id: USER_ID, onboardingCompleted: true } });
}

function validToken(returnTo: string): void {
  mockUnsealWorkspaceSwitchToken.mockResolvedValue({
    userId: USER_ID,
    targetKey: TARGET_KEY,
    returnTo,
  });
}

function switchSucceeds(): void {
  mockSwitchWorkspace.mockResolvedValue({
    ok: true,
    workspace: { type: 'company', key: TARGET_KEY },
    changed: true,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Tests ───────────────────────────────────────────────────────

describe('GET /api/auth/switch-workspace', () => {
  it('redirects to /login when there is no session user', async () => {
    mockGetSession.mockResolvedValue({});
    const response = await GET(makeRequest(signedQuery('/dashboard')));
    expect(response.status).toBe(307);
    expect(getRedirectLocation(response)).toBe('/login');
    expect(mockSwitchWorkspace).not.toHaveBeenCalled();
  });

  it('redirects to /onboarding when the user has not completed onboarding', async () => {
    mockGetSession.mockResolvedValue({ user: { id: USER_ID, onboardingCompleted: false } });
    const response = await GET(makeRequest(signedQuery('/dashboard')));
    expect(response.status).toBe(307);
    expect(getRedirectLocation(response)).toBe('/onboarding');
    expect(mockSwitchWorkspace).not.toHaveBeenCalled();
  });

  it('happy path: switches to the SEALED target and redirects to the sealed returnTo', async () => {
    onboardedSession();
    validToken('/projects/req-1');
    switchSucceeds();

    const response = await GET(makeRequest(signedQuery('/projects/req-1')));

    expect(mockUnsealWorkspaceSwitchToken).toHaveBeenCalledWith('valid-token');
    expect(mockSwitchWorkspace).toHaveBeenCalledWith(
      { id: USER_ID, onboardingCompleted: true },
      TARGET_KEY,
      'deep_link_auto'
    );
    expect(response.status).toBe(307);
    expect(getRedirectLocation(response)).toBe('/projects/req-1');
  });

  // ⚠ THE LOOP REGRESSION. `Sec-Fetch-Site` is computed against the INITIATOR's origin over
  // the request's whole url list and is NOT recomputed per hop, so a Gmail/Slack-web deep link
  // arrives — and stays — `cross-site` through our own same-origin redirect. The old header
  // check rejected it forever: page → switch → page → ERR_TOO_MANY_REDIRECTS. A valid token
  // must switch regardless of the header.
  it.each(['cross-site', 'same-site', 'same-origin', 'none'])(
    'switches for a request with Sec-Fetch-Site: %s (no redirect loop)',
    async (secFetchSite) => {
      onboardedSession();
      validToken('/projects/req-1');
      switchSucceeds();

      const response = await GET(
        makeRequest(signedQuery('/projects/req-1'), { 'sec-fetch-site': secFetchSite })
      );

      expect(mockSwitchWorkspace).toHaveBeenCalledTimes(1);
      expect(getRedirectLocation(response)).toBe('/projects/req-1');
    }
  );

  it('rejects a MISSING token — no switch, safe redirect', async () => {
    onboardedSession();
    mockUnsealWorkspaceSwitchToken.mockResolvedValue(null);

    const response = await GET(makeRequest('returnTo=%2Fprojects%2Freq-1'));

    expect(mockUnsealWorkspaceSwitchToken).toHaveBeenCalledWith(null);
    expect(mockSwitchWorkspace).not.toHaveBeenCalled();
    expect(getRedirectLocation(response)).toBe('/projects/req-1');
  });

  it('rejects a TAMPERED or EXPIRED token — no switch, back to the page so it can re-mint', async () => {
    onboardedSession();
    mockUnsealWorkspaceSwitchToken.mockResolvedValue(null);

    const response = await GET(makeRequest(signedQuery('/projects/req-1', 'tampered')));

    expect(mockSwitchWorkspace).not.toHaveBeenCalled();
    expect(getRedirectLocation(response)).toBe('/projects/req-1');
    expect(mockLogWarn).toHaveBeenCalledWith(
      'Workspace switch rejected: missing or invalid token',
      expect.objectContaining({ userId: USER_ID })
    );
  });

  it('rejects a token minted for a DIFFERENT user — no switch', async () => {
    onboardedSession();
    mockUnsealWorkspaceSwitchToken.mockResolvedValue({
      userId: 'someone-else',
      targetKey: TARGET_KEY,
      returnTo: '/projects/req-1',
    });

    const response = await GET(makeRequest(signedQuery('/projects/req-1')));

    expect(mockSwitchWorkspace).not.toHaveBeenCalled();
    expect(getRedirectLocation(response)).toBe('/projects/req-1');
    expect(mockLogWarn).toHaveBeenCalledWith(
      'Workspace switch rejected: token minted for a different user',
      expect.objectContaining({ userId: USER_ID })
    );
  });

  it('rejects when the clear-text returnTo disagrees with the sealed one', async () => {
    onboardedSession();
    validToken('/projects/req-1');

    const response = await GET(makeRequest(signedQuery('/projects/OTHER')));

    expect(mockSwitchWorkspace).not.toHaveBeenCalled();
    expect(getRedirectLocation(response)).toBe('/projects/OTHER');
    expect(mockLogWarn).toHaveBeenCalledWith(
      'Workspace switch rejected: returnTo does not match the sealed token',
      expect.objectContaining({ userId: USER_ID })
    );
  });

  it('never reads the switch target from a raw query param', async () => {
    onboardedSession();
    validToken('/projects/req-1');
    switchSucceeds();

    await GET(makeRequest(`to=expert&${signedQuery('/projects/req-1')}`));

    expect(mockSwitchWorkspace).toHaveBeenCalledWith(
      expect.anything(),
      TARGET_KEY,
      'deep_link_auto'
    );
  });

  it('rejects an open-redirect returnTo even when the token seals it', async () => {
    onboardedSession();
    mockUnsealWorkspaceSwitchToken.mockResolvedValue({
      userId: USER_ID,
      targetKey: TARGET_KEY,
      returnTo: 'https://evil.com',
    });
    switchSucceeds();

    const response = await GET(makeRequest(signedQuery('https://evil.com')));

    expect(getRedirectLocation(response)).toBe('/dashboard');
  });

  it('rejects a DOT-SEGMENT open-redirect returnTo (protocol-relative smuggling)', async () => {
    onboardedSession();
    mockUnsealWorkspaceSwitchToken.mockResolvedValue({
      userId: USER_ID,
      targetKey: TARGET_KEY,
      returnTo: '/.//evil.com',
    });
    switchSucceeds();

    const response = await GET(makeRequest(signedQuery('/.//evil.com')));

    const location = new URL(response.headers.get('Location') ?? '', BASE_URL);
    expect(location.origin).toBe(BASE_URL);
    expect(location.pathname).toBe('/dashboard');
  });

  it('an ineligible target does not loop — it redirects to the safe returnTo', async () => {
    onboardedSession();
    validToken('/projects/req-1');
    mockSwitchWorkspace.mockResolvedValue({ ok: false, reason: 'not_eligible' });

    const response = await GET(makeRequest(signedQuery('/projects/req-1')));

    expect(response.status).toBe(307);
    expect(getRedirectLocation(response)).toBe('/projects/req-1');
  });

  it('a representation target does not switch and redirects to the safe returnTo', async () => {
    onboardedSession();
    validToken('/projects/req-1');
    mockSwitchWorkspace.mockResolvedValue({
      ok: false,
      reason: 'representation_switch_not_enabled',
    });

    const response = await GET(makeRequest(signedQuery('/projects/req-1')));

    expect(response.status).toBe(307);
    expect(getRedirectLocation(response)).toBe('/projects/req-1');
  });

  it('a thrown DB error is logged and lands on /dashboard, NOT the deep link (loop guard)', async () => {
    // ⚠ FIX ROUND 2, MUST-FIX 2. Returning to `/projects/req-1` here loops: the page's READS
    // still succeed while the WRITE keeps failing, so it re-resolves, re-mints a fresh token
    // and sends the user straight back — unbounded. `/dashboard` mints no token, so the cycle
    // terminates in one hop. This differs from the `!result.ok` arms below/above, which
    // rejected on a read the page repeats and therefore converge on the deep link.
    onboardedSession();
    validToken('/projects/req-1');
    mockSwitchWorkspace.mockRejectedValue(new Error('connection terminated'));

    const response = await GET(makeRequest(signedQuery('/projects/req-1')));

    expect(response.status).toBe(307);
    expect(getRedirectLocation(response)).toBe('/dashboard');
    expect(mockLogError).toHaveBeenCalledWith(
      'Workspace switch (deep link) failed',
      expect.objectContaining({ userId: USER_ID, error: 'connection terminated' })
    );
  });

  it('a PERSISTENT write failure cannot ping-pong: every attempt lands on /dashboard', async () => {
    // The loop this closes is not a single bad hop, it is an unbounded cycle. Two consecutive
    // failures must both terminate at the same fixed landing.
    onboardedSession();
    validToken('/projects/req-1');
    mockSwitchWorkspace.mockRejectedValue(new Error('connection terminated'));

    const first = await GET(makeRequest(signedQuery('/projects/req-1')));
    const second = await GET(makeRequest(signedQuery('/projects/req-1')));

    expect(getRedirectLocation(first)).toBe('/dashboard');
    expect(getRedirectLocation(second)).toBe('/dashboard');
  });

  it('a thrown error still lands on /dashboard when the sealed returnTo was already /dashboard', async () => {
    onboardedSession();
    validToken('/dashboard');
    mockSwitchWorkspace.mockRejectedValue(new Error('connection terminated'));

    const response = await GET(makeRequest(signedQuery('/dashboard')));

    expect(getRedirectLocation(response)).toBe('/dashboard');
  });

  it('redirects to /dashboard when the sealed returnTo is the dashboard', async () => {
    onboardedSession();
    validToken('/dashboard');
    switchSucceeds();

    const response = await GET(makeRequest(signedQuery('/dashboard')));

    expect(getRedirectLocation(response)).toBe('/dashboard');
  });
});
