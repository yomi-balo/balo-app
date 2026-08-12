import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockLoggedFetch = vi.fn();
const mockGetSession = vi.fn();
const mockHeaders = vi.fn();

vi.mock('server-only', () => ({}));
vi.mock('@/lib/logging/fetch-wrapper', () => ({
  loggedFetch: (...args: unknown[]) => mockLoggedFetch(...args),
}));
vi.mock('@/lib/auth/session', () => ({
  getSession: (...args: unknown[]) => mockGetSession(...args),
}));
vi.mock('next/headers', () => ({
  headers: async () => mockHeaders(),
}));

import { log } from '@/lib/logging';
import { postGuestJoin, postLobbyClaim, postMemberJoin } from './join-api-client';

const MEETING_ID = '0f7b1c2d-3e4f-4a5b-8c9d-0e1f2a3b4c5d';
const ACCESS_TOKEN = 'workos.access.token';
const GUEST_TOKEN = 'z'.repeat(43);

/** A minimal `Response` stand-in — only what `callJoinApi` touches. */
function response(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/** The `RequestInit`-ish object the wrapper was called with. */
function lastInit(): { headers: Record<string, string>; body: string; method: string } {
  return mockLoggedFetch.mock.calls.at(-1)?.[1] as {
    headers: Record<string, string>;
    body: string;
    method: string;
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.API_URL = 'http://api.test';
  mockGetSession.mockResolvedValue({
    user: { id: 'user-1', onboardingCompleted: true },
    accessToken: ACCESS_TOKEN,
  });
  mockLoggedFetch.mockResolvedValue(response(200, { ok: true }));
  mockHeaders.mockReturnValue(new Headers({ 'x-vercel-forwarded-for': '203.0.113.7' }));
});

describe('postMemberJoin — the AUTHENTICATED hop', () => {
  it('forwards the viewer`s access token as a Bearer', async () => {
    await postMemberJoin(MEETING_ID);

    expect(mockLoggedFetch).toHaveBeenCalledWith(
      `http://api.test/meetings/${MEETING_ID}/join`,
      expect.objectContaining({ service: 'balo-api', method: 'POST' })
    );
    expect(lastInit().headers['Authorization']).toBe(`Bearer ${ACCESS_TOKEN}`);
  });

  it('fails closed when there is no session, WITHOUT calling the api', async () => {
    mockGetSession.mockResolvedValue({});

    await expect(postMemberJoin(MEETING_ID)).resolves.toEqual({
      ok: false,
      status: 401,
      code: 'unauthenticated',
    });
    expect(mockLoggedFetch).not.toHaveBeenCalled();
  });

  it('fails closed when the session carries no access token', async () => {
    mockGetSession.mockResolvedValue({ user: { id: 'user-1' }, accessToken: '' });

    const result = await postMemberJoin(MEETING_ID);

    expect(result.ok).toBe(false);
    expect(mockLoggedFetch).not.toHaveBeenCalled();
  });

  it('returns the grant on 200', async () => {
    const grant = {
      roomUrl: 'https://x',
      token: 't',
      isOwner: true,
      expiresAt: 'i',
      participantId: 'u',
    };
    mockLoggedFetch.mockResolvedValue(response(200, grant));

    await expect(postMemberJoin(MEETING_ID)).resolves.toEqual({ ok: true, data: grant });
  });
});

describe('⚠⚠ the PUBLIC hops send NO Authorization header', () => {
  it('postLobbyClaim sends no Authorization, even when a session exists', async () => {
    // An anonymous route that behaved differently for a signed-in visitor would be a
    // difference nothing tests and nobody expects.
    await postLobbyClaim(MEETING_ID, 'Sam', 'sam@x.example');

    expect('Authorization' in lastInit().headers).toBe(false);
    expect(mockGetSession).not.toHaveBeenCalled();
  });

  it('postGuestJoin sends no Authorization', async () => {
    await postGuestJoin(MEETING_ID, GUEST_TOKEN);

    expect('Authorization' in lastInit().headers).toBe(false);
    expect(mockGetSession).not.toHaveBeenCalled();
  });

  it('⚠ the guest token travels in the BODY, never in the URL', async () => {
    // URLs land in access logs, proxy logs and `Referer` headers, and a guest token is
    // deliberately NOT single-use — one logged copy stays replayable for its whole window.
    await postGuestJoin(MEETING_ID, GUEST_TOKEN);

    const [url] = mockLoggedFetch.mock.calls.at(-1) as [string];
    expect(url).not.toContain(GUEST_TOKEN);
    expect(JSON.parse(lastInit().body)).toEqual({ guestToken: GUEST_TOKEN });
  });

  it('sends the lobby fields in the body', async () => {
    await postLobbyClaim(MEETING_ID, 'Sam Rivera', 'sam@x.example');

    expect(JSON.parse(lastInit().body)).toEqual({
      name: 'Sam Rivera',
      email: 'sam@x.example',
    });
  });
});

describe('⚠ nothing here throws', () => {
  it('maps a non-2xx to a typed failure carrying the FIXED literal', async () => {
    mockLoggedFetch.mockResolvedValue(response(404, { error: 'meeting_not_found' }));

    await expect(postGuestJoin(MEETING_ID, GUEST_TOKEN)).resolves.toEqual({
      ok: false,
      status: 404,
      code: 'meeting_not_found',
    });
  });

  it('maps a transport error to a failure rather than an exception', async () => {
    // An exception escaping a Server Action becomes a Next error boundary, which is the
    // wrong shape for "this link isn't active".
    mockLoggedFetch.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(postLobbyClaim(MEETING_ID, 'Sam', 'sam@x.example')).resolves.toEqual({
      ok: false,
      status: 0,
      code: 'request_failed',
    });
  });

  it('tolerates an empty or unparseable body', async () => {
    mockLoggedFetch.mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => 'not json at all',
    } as unknown as Response);

    await expect(postGuestJoin(MEETING_ID, GUEST_TOKEN)).resolves.toEqual({
      ok: false,
      status: 503,
      code: 'request_failed',
    });
  });

  it('never surfaces a message from the api — only its literal', async () => {
    mockLoggedFetch.mockResolvedValue(
      response(500, { error: 'meeting_token_unavailable', message: 'daily said room X missing' })
    );

    const result = await postGuestJoin(MEETING_ID, GUEST_TOKEN);

    expect(JSON.stringify(result)).not.toContain('daily said');
  });
});

/**
 * ⚠⚠ THE VISITOR'S IP HAS TO REACH `apps/api`, OR ITS "PER-IP" WINDOWS ARE ONE PLATFORM-WIDE
 * BUCKET. These calls are server-to-server, so the address the api sees on the socket is this
 * tier's egress — identical for every guest on the planet. At the lobby's documented poll
 * cadence (~264 requests/hour each) THREE concurrent waiting guests exceeded the 600/hour
 * window between them: a functional break at trivial load, not merely a weak control.
 */
describe('⚠⚠ the visitor IP forward (the rate-limit key)', () => {
  it('forwards the platform-set address on the LOBBY hop', async () => {
    await postLobbyClaim(MEETING_ID, 'Sam', 'sam@x.example');

    expect(lastInit().headers['x-balo-client-ip']).toBe('203.0.113.7');
  });

  it('forwards it on the GUEST POLL hop too — that is the polled one', async () => {
    await postGuestJoin(MEETING_ID, GUEST_TOKEN);

    expect(lastInit().headers['x-balo-client-ip']).toBe('203.0.113.7');
  });

  it('⚠ does NOT forward it on the member hop — that route is identified by its Bearer', async () => {
    await postMemberJoin(MEETING_ID);

    expect(lastInit().headers['x-balo-client-ip']).toBeUndefined();
  });

  it('⚠⚠ prefers the PLATFORM header over anything a browser could have sent', async () => {
    // A browser can put whatever it likes at the FRONT of `x-forwarded-for`. Vercel strips
    // client-supplied `x-vercel-*` on ingress, so that one is the platform's own observation.
    mockHeaders.mockReturnValue(
      new Headers({
        'x-vercel-forwarded-for': '203.0.113.7',
        'x-forwarded-for': '10.0.0.1, 198.51.100.4',
        'x-real-ip': '198.51.100.9',
      })
    );

    await postLobbyClaim(MEETING_ID, 'Sam', 'sam@x.example');

    expect(lastInit().headers['x-balo-client-ip']).toBe('203.0.113.7');
  });

  it('falls back to x-real-ip when the Vercel header is absent', async () => {
    mockHeaders.mockReturnValue(new Headers({ 'x-real-ip': '198.51.100.9' }));

    await postLobbyClaim(MEETING_ID, 'Sam', 'sam@x.example');

    expect(lastInit().headers['x-balo-client-ip']).toBe('198.51.100.9');
  });

  it('⚠⚠ takes the LAST x-forwarded-for entry, NEVER the first — the first is caller-supplied', async () => {
    // The platform APPENDS its own observation, so the last element is the trustworthy one.
    // Reading the first (which `lib/magic-link`'s deliberately-spoofable helper does) would let
    // a visitor evade their own window — or burn somebody else's.
    mockHeaders.mockReturnValue(
      new Headers({ 'x-forwarded-for': '10.0.0.1, 172.16.0.2, 198.51.100.4' })
    );

    await postLobbyClaim(MEETING_ID, 'Sam', 'sam@x.example');

    expect(lastInit().headers['x-balo-client-ip']).toBe('198.51.100.4');
  });

  /**
   * ── ⚠⚠ THE PRECEDENCE **RULE**, NOT JUST THE RESULTING VALUE ────────────────────────────
   *
   * The two tests above assert which value wins. That is NOT the same claim as the safety
   * property, and the difference is what a future edit will break: the property is that
   * branches 2 and 3 are **never consulted at all** while branch 1 is present. Branch 1
   * (`x-vercel-forwarded-for`) is the only one Vercel strips from client requests on ingress;
   * `x-real-ip` and the last `x-forwarded-for` entry are client-settable behind an edge that
   * does not rewrite them. So an editor who reorders the list, or who "helpfully" merges the
   * three with a `??` chain in a different order, hands a browser the ability to choose this
   * value — which is a FRAMING primitive against another visitor's window, not merely an
   * evasion of their own. A value assertion would stay green through that change whenever the
   * fixtures happened to agree; this one cannot.
   */
  describe('⚠⚠ the header-selection ORDER is the invariant, not the value', () => {
    /** A header bag that RECORDS which names were consulted, in order. */
    function recordingHeaders(values: Record<string, string>): {
      bag: { get: (name: string) => string | null };
      consulted: string[];
    } {
      const consulted: string[] = [];
      const real = new Headers(values);
      return {
        bag: {
          get: (name: string): string | null => {
            consulted.push(name);
            return real.get(name);
          },
        },
        consulted,
      };
    }

    it('consults ONLY `x-vercel-forwarded-for` when it is present', async () => {
      const { bag, consulted } = recordingHeaders({
        'x-vercel-forwarded-for': '203.0.113.7',
        // Both of these are present and both would resolve. Neither may be READ.
        'x-real-ip': '198.51.100.9',
        'x-forwarded-for': '10.0.0.1, 198.51.100.4',
      });
      mockHeaders.mockReturnValue(bag);

      await postLobbyClaim(MEETING_ID, 'Sam', 'sam@x.example');

      expect(lastInit().headers['x-balo-client-ip']).toBe('203.0.113.7');
      expect(consulted).toEqual(['x-vercel-forwarded-for']);
    });

    it('consults `x-forwarded-for` ONLY after both platform headers came back empty', async () => {
      const { bag, consulted } = recordingHeaders({
        'x-forwarded-for': '10.0.0.1, 198.51.100.4',
      });
      mockHeaders.mockReturnValue(bag);

      await postLobbyClaim(MEETING_ID, 'Sam', 'sam@x.example');

      expect(lastInit().headers['x-balo-client-ip']).toBe('198.51.100.4');
      // ⚠ IN THIS ORDER. The least-spoofable header is asked first, every time.
      expect(consulted).toEqual(['x-vercel-forwarded-for', 'x-real-ip', 'x-forwarded-for']);
    });
  });

  /**
   * ── ⚠⚠ NEITHER NO-RESOLUTION PATH MAY BE SILENT ─────────────────────────────────────────
   *
   * When nothing resolves, `apps/api` sets `client = peer`, so every guest on the platform
   * collapses into the single bucket `<egress>|<egress>` at 10/hr (lobby) and 600/hr
   * (guest-join) — the exact platform-wide DoS this whole forward exists to close. A hosting
   * change or a header rename would reintroduce it INVISIBLY. The `warn` is the only thing
   * that would show up anywhere.
   */
  describe('⚠ the unresolved-IP warning', () => {
    it('OMITS the header AND warns when no platform header resolves — never a placeholder', async () => {
      // A placeholder would merge every such visitor into ONE shared bucket, silently
      // reintroducing the exact bug this fixes. The api falls back to its own `request.ip`.
      mockHeaders.mockReturnValue(new Headers({}));

      await postLobbyClaim(MEETING_ID, 'Sam', 'sam@x.example');

      expect(lastInit().headers['x-balo-client-ip']).toBeUndefined();
      expect(log.warn).toHaveBeenCalledWith(
        expect.stringContaining('Visitor IP unresolved'),
        expect.objectContaining({ reason: 'no_platform_header' })
      );
    });

    it('warns on an `x-forwarded-for` that is present but carries no usable entry', async () => {
      mockHeaders.mockReturnValue(new Headers({ 'x-forwarded-for': '  ' }));

      await postLobbyClaim(MEETING_ID, 'Sam', 'sam@x.example');

      expect(lastInit().headers['x-balo-client-ip']).toBeUndefined();
      expect(log.warn).toHaveBeenCalledWith(
        expect.stringContaining('Visitor IP unresolved'),
        expect.objectContaining({ reason: 'no_platform_header' })
      );
    });

    it('survives being called outside a request scope, and warns with the distinct reason', async () => {
      mockHeaders.mockImplementation(() => {
        throw new Error('headers() outside a request scope');
      });

      await expect(postLobbyClaim(MEETING_ID, 'Sam', 'sam@x.example')).resolves.toMatchObject({
        ok: true,
      });
      expect(lastInit().headers['x-balo-client-ip']).toBeUndefined();
      expect(log.warn).toHaveBeenCalledWith(
        expect.stringContaining('Visitor IP unresolved'),
        expect.objectContaining({
          reason: 'headers_unavailable',
          error: 'headers() outside a request scope',
        })
      );
    });

    it('⚠ says NOTHING on the happy path — a per-request warn that always fires is noise', async () => {
      await postLobbyClaim(MEETING_ID, 'Sam', 'sam@x.example');

      expect(log.warn).not.toHaveBeenCalledWith(
        expect.stringContaining('Visitor IP unresolved'),
        expect.anything()
      );
    });
  });

  it('⚠ still sends NO Authorization header on either public hop', async () => {
    // An anonymous knocker has no account; a guest's credential is the token in the BODY.
    await postLobbyClaim(MEETING_ID, 'Sam', 'sam@x.example');
    expect(lastInit().headers['Authorization']).toBeUndefined();

    await postGuestJoin(MEETING_ID, GUEST_TOKEN);
    expect(lastInit().headers['Authorization']).toBeUndefined();
  });

  it('⚠ never forwards INTERNAL_API_SECRET from a public hop', async () => {
    // These routes are public BY DESIGN and must stay callable without it — a deliberate
    // divergence from `lib/credit/api-client.ts`'s internal hop.
    process.env.INTERNAL_API_SECRET = 'super-secret';

    await postLobbyClaim(MEETING_ID, 'Sam', 'sam@x.example');

    expect(lastInit().headers['x-internal-api-key']).toBeUndefined();
    expect(JSON.stringify(lastInit().headers)).not.toContain('super-secret');
  });
});

describe('Retry-After (only on a 429)', () => {
  function responseWithRetryAfter(status: number, retryAfter: string | null): Response {
    return {
      ok: false,
      status,
      headers: { get: (name: string) => (name === 'Retry-After' ? retryAfter : null) },
      text: async () => JSON.stringify({ error: 'rate_limited' }),
    } as unknown as Response;
  }

  it('surfaces a usable Retry-After so the poller can obey it', async () => {
    mockLoggedFetch.mockResolvedValue(responseWithRetryAfter(429, '45'));

    await expect(postGuestJoin(MEETING_ID, GUEST_TOKEN)).resolves.toMatchObject({
      status: 429,
      retryAfterSeconds: 45,
    });
  });

  it('⚠ CLAMPS an absurd value — it becomes a setTimeout delay in a browser', async () => {
    mockLoggedFetch.mockResolvedValue(responseWithRetryAfter(429, '99999'));

    await expect(postGuestJoin(MEETING_ID, GUEST_TOKEN)).resolves.toMatchObject({
      retryAfterSeconds: 300,
    });
  });

  it.each([['garbage'], ['-5'], ['0'], [null]])('ignores a nonsensical value (%s)', async (raw) => {
    mockLoggedFetch.mockResolvedValue(responseWithRetryAfter(429, raw));

    const result = await postGuestJoin(MEETING_ID, GUEST_TOKEN);

    expect(result).not.toHaveProperty('retryAfterSeconds');
  });
});
