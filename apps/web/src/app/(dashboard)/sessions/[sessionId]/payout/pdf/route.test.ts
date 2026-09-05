import { describe, it, expect, vi, beforeEach } from 'vitest';

// ⚠ `vi.mock()` calls are HOISTED above every top-level statement in this file, so anything a
// mock factory closes over must be created inside `vi.hoisted()` — including the fake error
// CLASS. Declaring it as a bare top-level `class` leaves it in the temporal dead zone when the
// factory runs, which throws `Cannot access '...' before initialization` at collection time.
const {
  mockGetCurrentUser,
  mockLoadSessionStatement,
  mockRenderPdf,
  mockTrackServerAndFlush,
  FakeSessionStatementUnavailableError,
  FakeSessionStatementRateLimitedError,
} = vi.hoisted(() => ({
  mockGetCurrentUser: vi.fn(),
  mockLoadSessionStatement: vi.fn(),
  mockRenderPdf: vi.fn(),
  mockTrackServerAndFlush: vi.fn(),
  FakeSessionStatementUnavailableError: class extends Error {},
  // ⚠ IN `vi.hoisted()`, NOT A TOP-LEVEL CLASS — see this file's header comment. A bare top-level
  // class is in the temporal dead zone when the hoisted `vi.mock` factory runs.
  FakeSessionStatementRateLimitedError: class extends Error {
    retryAfterSeconds: number | null = null;
    constructor(retryAfterSeconds: number | null) {
      super('rate limited');
      this.retryAfterSeconds = retryAfterSeconds;
    }
  },
}));

vi.mock('@/lib/auth/session', () => ({ getCurrentUser: () => mockGetCurrentUser() }));
vi.mock('../../_lib/load-session-statement', () => ({
  loadSessionStatement: (...args: unknown[]) => mockLoadSessionStatement(...args),
  SessionStatementUnavailableError: FakeSessionStatementUnavailableError,
  SessionStatementRateLimitedError: FakeSessionStatementRateLimitedError,
}));
vi.mock('@/lib/credit/statement/pdf/session-statement-pdf-document', () => ({
  renderSessionStatementPdfToBuffer: (...args: unknown[]) => mockRenderPdf(...args),
}));
vi.mock('@/lib/analytics/server', () => ({
  trackServerAndFlush: (...args: unknown[]) => mockTrackServerAndFlush(...args),
  CASE_BILLING_SERVER_EVENTS: { SESSION_STATEMENT_DOWNLOADED: 'session_statement_downloaded' },
}));

import { GET } from './route';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const USER = { id: 'expert-user-1' };
const MONEY_VIEW = {
  lens: 'expert',
  sessionId: SESSION_ID,
  mode: { kind: 'money' },
  occurredAtIso: '2026-08-12T10:00:00.000Z',
  title: 'Static analysis walkthrough',
  counterparty: { name: 'Northwind Industrial', orgLabel: null },
  meetingId: 'meeting_1',
  payout: null,
  block: { lens: 'expert', state: 'finalized', sessionId: SESSION_ID },
};

function callGet(sessionId = SESSION_ID): Promise<Response> {
  return GET(new Request('http://localhost/pdf'), { params: Promise.resolve({ sessionId }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetCurrentUser.mockResolvedValue(USER);
  mockLoadSessionStatement.mockResolvedValue(MONEY_VIEW);
  mockRenderPdf.mockResolvedValue(Buffer.from('%PDF-generated'));
});

describe('GET session statement PDF (payout)', () => {
  it('404s a malformed (non-UUID) sessionId', async () => {
    const res = await callGet('not-a-uuid');
    expect(res.status).toBe(404);
  });

  it('401s an unauthenticated request', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    const res = await callGet();
    expect(res.status).toBe(401);
  });

  // ⚠ THE LENS THIS ROUTE BINDS. Both handlers now come from ONE factory
  // (`_lib/create-statement-pdf-route.ts`), so the only thing distinguishing this route from its
  // twin is the argument below — and nothing else in this file would fail if it were swapped.
  // The lens flows to the gate, the log field, the analytics property AND the filename, so a
  // wrong binding would serve the other side's document under this one's name.
  it('binds the EXPERT lens — never client', async () => {
    await callGet();
    expect(mockLoadSessionStatement).toHaveBeenCalledWith(SESSION_ID, USER.id, 'expert');
    expect(mockLoadSessionStatement).not.toHaveBeenCalledWith(SESSION_ID, USER.id, 'client');
  });

  it('404s on the wrong lens / denial', async () => {
    mockLoadSessionStatement.mockResolvedValue(null);
    const res = await callGet();
    expect(res.status).toBe(404);
  });

  it('404s for a zero-money mode — nothing to forward', async () => {
    mockLoadSessionStatement.mockResolvedValue({ ...MONEY_VIEW, mode: { kind: 'zero' } });
    const res = await callGet();
    expect(res.status).toBe(404);
  });

  it('200s with the exact Content-Disposition filename', async () => {
    const res = await callGet();
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Disposition')).toBe(
      'attachment; filename="Balo-Payout-2026-08-12-11111111.pdf"'
    );
  });

  it('fires the download event with lens: expert on success', async () => {
    await callGet();
    expect(mockTrackServerAndFlush).toHaveBeenCalledWith('session_statement_downloaded', {
      session_id: SESSION_ID,
      lens: 'expert',
      distinct_id: 'expert-user-1',
    });
  });

  it('500s when the PDF render throws', async () => {
    mockRenderPdf.mockRejectedValue(new Error('render boom'));
    const res = await callGet();
    expect(res.status).toBe(500);
  });

  it('429s with Retry-After when the api rate-limited the gate — no render, no event', async () => {
    mockLoadSessionStatement.mockRejectedValue(new FakeSessionStatementRateLimitedError(42));
    const res = await callGet();
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('42');
    expect(mockRenderPdf).not.toHaveBeenCalled();
    expect(mockTrackServerAndFlush).not.toHaveBeenCalled();
  });

  it('429s WITHOUT Retry-After when the api supplied no cooldown', async () => {
    mockLoadSessionStatement.mockRejectedValue(new FakeSessionStatementRateLimitedError(null));
    const res = await callGet();
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBeNull();
    expect(mockRenderPdf).not.toHaveBeenCalled();
  });

  it('a 429 is NOT the 500 outage path — the two errors stay distinct', async () => {
    mockLoadSessionStatement.mockRejectedValue(new FakeSessionStatementRateLimitedError(5));
    expect((await callGet()).status).toBe(429);
    mockLoadSessionStatement.mockRejectedValue(new FakeSessionStatementUnavailableError('outage'));
    expect((await callGet()).status).toBe(500);
  });

  it('a 429 body is empty (matching the 401/404 shape)', async () => {
    mockLoadSessionStatement.mockRejectedValue(new FakeSessionStatementRateLimitedError(7));
    expect(await (await callGet()).text()).toBe('');
  });
});
