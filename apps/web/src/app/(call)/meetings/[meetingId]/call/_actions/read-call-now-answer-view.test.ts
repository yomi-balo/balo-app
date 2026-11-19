import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockRequireOnboardedUser, mockLoadAnswerView, mockLog } = vi.hoisted(() => ({
  mockRequireOnboardedUser: vi.fn(),
  mockLoadAnswerView: vi.fn(),
  mockLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/auth/session', () => ({ requireOnboardedUser: mockRequireOnboardedUser }));
vi.mock('@/lib/call-now/load-call-now-answer-view', () => ({
  loadCallNowAnswerView: mockLoadAnswerView,
}));
vi.mock('@/lib/logging', () => ({ log: mockLog }));

import { readCallNowAnswerViewAction } from './read-call-now-answer-view';

const RING_ID = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const MEETING_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const INPUT = { ringId: RING_ID, meetingId: MEETING_ID };
const USER_ID = '11111111-2222-4333-8444-555555555555';
const ANSWER = { kind: 'answer', callerName: 'Dana', rateLine: null };

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireOnboardedUser.mockResolvedValue({ id: USER_ID });
  mockLoadAnswerView.mockResolvedValue(ANSWER);
});

describe('readCallNowAnswerViewAction', () => {
  it('returns the loader’s view for the signed-in viewer', async () => {
    await expect(readCallNowAnswerViewAction(INPUT)).resolves.toEqual(ANSWER);
    expect(mockLoadAnswerView).toHaveBeenCalledWith({
      ringId: RING_ID,
      meetingId: MEETING_ID,
      userId: USER_ID,
    });
  });

  it('gates on an onboarded user before anything else', async () => {
    mockRequireOnboardedUser.mockRejectedValue(new Error('Unauthorized'));

    await expect(readCallNowAnswerViewAction(INPUT)).rejects.toThrow('Unauthorized');
    expect(mockLoadAnswerView).not.toHaveBeenCalled();
  });

  it('⚠ an impersonated session waits and logs, and reads nothing', async () => {
    mockRequireOnboardedUser.mockResolvedValue({
      id: USER_ID,
      isImpersonating: true,
      impersonatorUserId: 'staff-1',
    });

    await expect(readCallNowAnswerViewAction(INPUT)).resolves.toEqual({
      kind: 'wait',
    });
    expect(mockLoadAnswerView).not.toHaveBeenCalled();
    expect(mockLog.warn).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a non-uuid ring id', { ...INPUT, ringId: 'nope' }],
    ['a non-uuid meeting id', { ...INPUT, meetingId: 'nope' }],
    ['no meeting id', { ringId: RING_ID }],
    ['an extra key', { ...INPUT, userId: USER_ID }],
  ])('%s waits without reading', async (_label, input) => {
    await expect(readCallNowAnswerViewAction(input as typeof INPUT)).resolves.toEqual({
      kind: 'wait',
    });
    expect(mockLoadAnswerView).not.toHaveBeenCalled();
  });
});
