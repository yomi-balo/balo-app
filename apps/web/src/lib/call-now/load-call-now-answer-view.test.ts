import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetCallNowRing, mockResolveCaseAccess, mockReadFirstName, mockReadRateLine, mockLog } =
  vi.hoisted(() => ({
    mockGetCallNowRing: vi.fn(),
    mockResolveCaseAccess: vi.fn(),
    mockReadFirstName: vi.fn(),
    mockReadRateLine: vi.fn(),
    mockLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  }));

vi.mock('server-only', () => ({}));
vi.mock('./call-now-api-client', () => ({ getCallNowRing: mockGetCallNowRing }));
vi.mock('@/lib/cases/resolve-case-access', () => ({ resolveCaseAccess: mockResolveCaseAccess }));
vi.mock('./load-call-now-caller-view', () => ({ readExpertFirstName: mockReadFirstName }));
vi.mock('./call-now-rate-line', () => ({ readCallNowRateLine: mockReadRateLine }));
vi.mock('@/lib/logging', async () => {
  const actual = await vi.importActual<typeof import('@/lib/logging')>('@/lib/logging');
  return { ...actual, log: mockLog };
});

import { loadCallNowAnswerView } from './load-call-now-answer-view';

const RING_ID = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const USER_ID = '11111111-2222-4333-8444-555555555555';
const ENGAGEMENT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const EXPERT_PROFILE_ID = '88888888-8888-4888-8888-888888888888';
const RATE_LINE = 'From A$3.75/min · 15-minute minimum';

const MEETING_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const INPUT = { ringId: RING_ID, meetingId: MEETING_ID, userId: USER_ID };

function ring(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ringId: RING_ID,
    meetingId: MEETING_ID,
    engagementId: ENGAGEMENT_ID,
    role: 'callee',
    awaitsAnswer: true,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetCallNowRing.mockResolvedValue({ ok: true, data: ring() });
  mockResolveCaseAccess.mockResolvedValue({
    engagementId: ENGAGEMENT_ID,
    expertProfileId: EXPERT_PROFILE_ID,
  });
  mockReadFirstName.mockResolvedValue('Dana');
  mockReadRateLine.mockResolvedValue(RATE_LINE);
});

describe('loadCallNowAnswerView', () => {
  it('the ring’s callee who awaits the answer gets the caller’s name and the rate, loaded server-side', async () => {
    await expect(loadCallNowAnswerView(INPUT)).resolves.toEqual({
      kind: 'answer',
      callerName: 'Dana',
      rateLine: RATE_LINE,
    });
    expect(mockResolveCaseAccess).toHaveBeenCalledWith(ENGAGEMENT_ID, USER_ID);
    expect(mockReadFirstName).toHaveBeenCalledWith(EXPERT_PROFILE_ID);
    expect(mockReadRateLine).toHaveBeenCalledWith(EXPERT_PROFILE_ID);
  });

  it('a rate that cannot be quoted is still an answer, with no rate line', async () => {
    mockReadRateLine.mockResolvedValue(null);

    await expect(loadCallNowAnswerView(INPUT)).resolves.toEqual({
      kind: 'answer',
      callerName: 'Dana',
      rateLine: null,
    });
  });

  it('⚠ a colleague (the party-scoped ring read is a 404) waits, without a warning', async () => {
    mockGetCallNowRing.mockResolvedValue({ ok: false, status: 404, code: 'ring_not_found' });

    await expect(loadCallNowAnswerView(INPUT)).resolves.toEqual({ kind: 'wait' });
    expect(mockLog.warn).not.toHaveBeenCalled();
    expect(mockResolveCaseAccess).not.toHaveBeenCalled();
  });

  it.each([
    ['the caller', { role: 'caller' }],
    ['no role', { role: null }],
    ['a callee who is not awaiting an answer', { role: 'callee', awaitsAnswer: false }],
    [
      'a ring that belongs to another meeting',
      { meetingId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' },
    ],
  ])('⚠ %s waits and is never offered Answer', async (_label, overrides) => {
    mockGetCallNowRing.mockResolvedValue({ ok: true, data: ring(overrides) });

    await expect(loadCallNowAnswerView(INPUT)).resolves.toEqual({ kind: 'wait' });
    expect(mockResolveCaseAccess).not.toHaveBeenCalled();
  });

  it('⚠ a transient read failure is a retry, never "someone else", and logs', async () => {
    mockGetCallNowRing.mockResolvedValue({ ok: false, status: 503, code: 'request_failed' });

    await expect(loadCallNowAnswerView(INPUT)).resolves.toEqual({ kind: 'retry' });
    expect(mockLog.warn).toHaveBeenCalledWith('Call room could not read the ring to answer', {
      ringId: RING_ID,
      status: 503,
    });
  });

  it('a viewer who has lost the case waits', async () => {
    mockResolveCaseAccess.mockResolvedValue(null);

    await expect(loadCallNowAnswerView(INPUT)).resolves.toEqual({ kind: 'wait' });
    expect(mockReadFirstName).not.toHaveBeenCalled();
  });

  it('⚠ a read that throws is a retry, not a verdict, and logs', async () => {
    mockReadFirstName.mockRejectedValue(new Error('db down'));

    await expect(loadCallNowAnswerView(INPUT)).resolves.toEqual({ kind: 'retry' });
    expect(mockLog.warn).toHaveBeenCalledWith(
      'Call room could not load its answer view',
      expect.objectContaining({ ringId: RING_ID, error: 'db down' })
    );
  });
});
