import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockConnect, mockAuthorize, InvalidSessionTransitionError } = vi.hoisted(() => {
  class InvalidSessionTransitionError extends Error {
    constructor() {
      super('invalid');
      this.name = 'InvalidSessionTransitionError';
    }
  }
  return { mockConnect: vi.fn(), mockAuthorize: vi.fn(), InvalidSessionTransitionError };
});

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('@balo/db', () => ({
  creditSessionsRepository: { connect: mockConnect },
}));
vi.mock('./authorize-session-actor.js', () => ({ authorizeSessionActor: mockAuthorize }));

import { connectSession, connectSessionAsSystem } from './connect-session.js';

const SESSION = { id: 'session_1', companyId: 'company_1', status: 'active' };

describe('connectSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthorize.mockResolvedValue({ ok: true, session: SESSION, role: 'member' });
    mockConnect.mockResolvedValue(SESSION);
  });

  it('authorizes with CONSUME_CREDITS then connects', async () => {
    const res = await connectSession('session_1', 'user_1');
    expect(mockAuthorize).toHaveBeenCalledWith({
      sessionId: 'session_1',
      userId: 'user_1',
      requireCapability: 'consume_credits',
    });
    expect(mockConnect).toHaveBeenCalledWith('session_1', {});
    expect(res).toEqual({ ok: true, session: SESSION });
  });

  it('returns forbidden without connecting for a non-member actor (cross-tenant IDOR)', async () => {
    mockAuthorize.mockResolvedValue({ ok: false, code: 'forbidden' });
    const res = await connectSession('session_1', 'stranger');
    expect(res).toEqual({ ok: false, code: 'forbidden' });
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it('returns not_found without connecting when the session is missing', async () => {
    mockAuthorize.mockResolvedValue({ ok: false, code: 'not_found' });
    const res = await connectSession('missing', 'user_1');
    expect(res).toEqual({ ok: false, code: 'not_found' });
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it('propagates an illegal-transition error thrown by the repo', async () => {
    mockConnect.mockRejectedValue(new InvalidSessionTransitionError());
    await expect(connectSession('session_1', 'user_1')).rejects.toBeInstanceOf(
      InvalidSessionTransitionError
    );
  });

  it('delegates to connectSessionAsSystem — one transition path', async () => {
    await connectSession('session_1', 'user_1', { now: new Date('2026-08-25T00:00:00.000Z') });
    expect(mockConnect).toHaveBeenCalledWith('session_1', {
      now: new Date('2026-08-25T00:00:00.000Z'),
    });
  });

  it('F1 (BAL-466 fix round) — refuses a presence-sourced session (forbidden, no connect call)', async () => {
    mockAuthorize.mockResolvedValue({
      ok: true,
      session: { ...SESSION, durationSource: 'presence' },
      role: 'member',
    });
    const res = await connectSession('session_1', 'user_1');
    expect(res).toEqual({ ok: false, code: 'forbidden' });
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it('F1 — a live_capture session is unaffected by the presence guard', async () => {
    mockAuthorize.mockResolvedValue({
      ok: true,
      session: { ...SESSION, durationSource: 'live_capture' },
      role: 'member',
    });
    const res = await connectSession('session_1', 'user_1');
    expect(res).toEqual({ ok: true, session: SESSION });
    expect(mockConnect).toHaveBeenCalled();
  });
});

describe('connectSessionAsSystem (BAL-466, D6)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConnect.mockResolvedValue(SESSION);
  });

  it('runs NO authorizeSessionActor — system-only, no actor authorization', async () => {
    const session = await connectSessionAsSystem('session_1');

    expect(session).toEqual(SESSION);
    expect(mockAuthorize).not.toHaveBeenCalled();
    expect(mockConnect).toHaveBeenCalledWith('session_1', {});
  });

  it('passes `now` through to the repository', async () => {
    const now = new Date('2026-08-25T00:00:00.000Z');
    await connectSessionAsSystem('session_1', { now });
    expect(mockConnect).toHaveBeenCalledWith('session_1', { now });
  });

  it('propagates a thrown InvalidSessionTransitionError to the caller', async () => {
    mockConnect.mockRejectedValue(new InvalidSessionTransitionError());
    await expect(connectSessionAsSystem('session_1')).rejects.toBeInstanceOf(
      InvalidSessionTransitionError
    );
  });

  it('connectSession still authorizes and delegates to connectSessionAsSystem', async () => {
    mockAuthorize.mockResolvedValue({ ok: true, session: SESSION, role: 'member' });
    const res = await connectSession('session_1', 'user_1');
    expect(mockAuthorize).toHaveBeenCalled();
    expect(res).toEqual({ ok: true, session: SESSION });
  });
});
