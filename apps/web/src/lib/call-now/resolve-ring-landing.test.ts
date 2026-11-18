import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const { mockCallSessionApi, mockLogWarn } = vi.hoisted(() => ({
  mockCallSessionApi: vi.fn(),
  mockLogWarn: vi.fn(),
}));

vi.mock('@/lib/credit/api-client', () => ({ callSessionApi: mockCallSessionApi }));
vi.mock('@/lib/logging', () => ({
  log: { warn: mockLogWarn, error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { isRingId, resolveRingLandingPath } from './resolve-ring-landing';

const RING_ID = '33333333-3333-4333-8333-333333333333';
const MEETING_ID = '11111111-1111-4111-8111-111111111111';
const ENGAGEMENT_ID = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-11-17T10:00:00.000Z');

function okRing(overrides: Record<string, unknown> = {}): { ok: true; status: 200; data: unknown } {
  return {
    ok: true,
    status: 200,
    data: {
      ringId: RING_ID,
      meetingId: MEETING_ID,
      engagementId: ENGAGEMENT_ID,
      status: 'ringing',
      expiresAt: '2026-11-17T10:01:00.000Z',
      role: 'callee',
      awaitsAnswer: false,
      meetingEnded: false,
      ...overrides,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('resolveRingLandingPath', () => {
  it.each(['not-a-uuid', '../cases', `${RING_ID}/../x`, ''])(
    'lands on the case list without an api call for the non-uuid ring id %j',
    async (badId) => {
      await expect(resolveRingLandingPath(badId)).resolves.toBe('/cases');

      expect(mockCallSessionApi).not.toHaveBeenCalled();
    }
  );

  it('reads the ring through the session api', async () => {
    mockCallSessionApi.mockResolvedValue(okRing());

    await resolveRingLandingPath(RING_ID);

    expect(mockCallSessionApi).toHaveBeenCalledWith(`/call-now/rings/${RING_ID}`, 'GET');
  });

  it('opens the call room for a live ring', async () => {
    mockCallSessionApi.mockResolvedValue(okRing());

    await expect(resolveRingLandingPath(RING_ID)).resolves.toBe(`/meetings/${MEETING_ID}/call`);
  });

  it('opens the case for an unanswered ring', async () => {
    mockCallSessionApi.mockResolvedValue(okRing({ status: 'unanswered' }));

    await expect(resolveRingLandingPath(RING_ID)).resolves.toBe(`/cases/${ENGAGEMENT_ID}`);
  });

  it('opens the case for a ringing row past its expiry', async () => {
    mockCallSessionApi.mockResolvedValue(okRing({ expiresAt: '2026-11-17T09:59:00.000Z' }));

    await expect(resolveRingLandingPath(RING_ID)).resolves.toBe(`/cases/${ENGAGEMENT_ID}`);
  });

  it('opens the case for a client callee who must answer an expert-started ring', async () => {
    mockCallSessionApi.mockResolvedValue(okRing({ awaitsAnswer: true }));

    await expect(resolveRingLandingPath(RING_ID)).resolves.toBe(`/cases/${ENGAGEMENT_ID}`);
  });

  it('opens the case for a connected ring whose meeting has ended', async () => {
    mockCallSessionApi.mockResolvedValue(okRing({ status: 'connected', meetingEnded: true }));

    await expect(resolveRingLandingPath(RING_ID)).resolves.toBe(`/cases/${ENGAGEMENT_ID}`);
  });

  it('opens the call room for a connected ring whose meeting is still running', async () => {
    mockCallSessionApi.mockResolvedValue(okRing({ status: 'connected' }));

    await expect(resolveRingLandingPath(RING_ID)).resolves.toBe(`/meetings/${MEETING_ID}/call`);
  });

  it('falls back to the case list on a 404 without logging', async () => {
    mockCallSessionApi.mockResolvedValue({ ok: false, status: 404, error: 'ring_not_found' });

    await expect(resolveRingLandingPath(RING_ID)).resolves.toBe('/cases');
    expect(mockLogWarn).not.toHaveBeenCalled();
  });

  it('falls back to the case list and warns on any other failure', async () => {
    mockCallSessionApi.mockResolvedValue({ ok: false, status: 503, error: 'down' });

    await expect(resolveRingLandingPath(RING_ID)).resolves.toBe('/cases');
    expect(mockLogWarn).toHaveBeenCalledWith('Call now SMS link could not read the ring', {
      ringId: RING_ID,
      status: 503,
    });
  });

  it.each([
    ['a null body', null],
    ['an unknown status', { ...(okRing().data as object), status: 'weird' }],
    ['a missing engagement id', { ...(okRing().data as object), engagementId: undefined }],
    ['a missing awaitsAnswer', { ...(okRing().data as object), awaitsAnswer: undefined }],
    ['a non-boolean meetingEnded', { ...(okRing().data as object), meetingEnded: 'no' }],
  ])('falls back to the case list for %s', async (_label, data) => {
    mockCallSessionApi.mockResolvedValue({ ok: true, status: 200, data });

    await expect(resolveRingLandingPath(RING_ID)).resolves.toBe('/cases');
    expect(mockLogWarn).toHaveBeenCalledTimes(1);
  });
});

describe('isRingId', () => {
  it('accepts a uuid and rejects anything else', () => {
    expect(isRingId(RING_ID)).toBe(true);
    expect(isRingId('not-a-uuid')).toBe(false);
    expect(isRingId('')).toBe(false);
  });
});
