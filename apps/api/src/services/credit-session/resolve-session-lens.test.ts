import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockAuthorizeActor, mockAuthorizeExpert } = vi.hoisted(() => ({
  mockAuthorizeActor: vi.fn(),
  mockAuthorizeExpert: vi.fn(),
}));

vi.mock('./authorize-session-actor.js', () => ({ authorizeSessionActor: mockAuthorizeActor }));
vi.mock('./authorize-session-expert-visibility.js', () => ({
  authorizeSessionExpertVisibility: mockAuthorizeExpert,
}));

import { resolveSessionLens } from './resolve-session-lens.js';

describe('resolveSessionLens (BAL-441)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves the CLIENT arm for a company member, WITHOUT consulting the expert gate', async () => {
    const session = { id: 'session_1' };
    mockAuthorizeActor.mockResolvedValue({ ok: true, session, role: 'member' });
    const result = await resolveSessionLens('session_1', 'user_1');
    expect(result).toEqual({ ok: true, lens: 'client', session });
    expect(mockAuthorizeExpert).not.toHaveBeenCalled();
  });

  it('falls through to the EXPERT arm when `forbidden` on the actor gate — never leaks a 403', async () => {
    const session = { id: 'session_1' };
    mockAuthorizeActor.mockResolvedValue({ ok: false, code: 'forbidden' });
    mockAuthorizeExpert.mockResolvedValue({ ok: true, session, expertProfileId: 'expert_1' });
    const result = await resolveSessionLens('session_1', 'expert_user');
    expect(result).toEqual({
      ok: true,
      lens: 'expert',
      session,
      expertProfileId: 'expert_1',
    });
  });

  it('falls through to the EXPERT arm when `not_found` on the actor gate too', async () => {
    const session = { id: 'session_1' };
    mockAuthorizeActor.mockResolvedValue({ ok: false, code: 'not_found' });
    mockAuthorizeExpert.mockResolvedValue({ ok: true, session, expertProfileId: 'expert_1' });
    const result = await resolveSessionLens('session_1', 'expert_user');
    expect(result).toEqual({
      ok: true,
      lens: 'expert',
      session,
      expertProfileId: 'expert_1',
    });
  });

  it('resolves not_found for a stranger — neither a member nor the expert', async () => {
    mockAuthorizeActor.mockResolvedValue({ ok: false, code: 'forbidden' });
    mockAuthorizeExpert.mockResolvedValue({ ok: false, code: 'forbidden' });
    const result = await resolveSessionLens('session_1', 'stranger');
    expect(result).toEqual({ ok: false, code: 'not_found' });
  });

  it('resolves not_found when the session itself is missing on both gates', async () => {
    mockAuthorizeActor.mockResolvedValue({ ok: false, code: 'not_found' });
    mockAuthorizeExpert.mockResolvedValue({ ok: false, code: 'not_found' });
    const result = await resolveSessionLens('nope', 'user_1');
    expect(result).toEqual({ ok: false, code: 'not_found' });
  });
});
