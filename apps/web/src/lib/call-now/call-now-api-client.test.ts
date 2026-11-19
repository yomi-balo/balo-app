import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const { mockGet, mockPost } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockPost: vi.fn(),
}));

vi.mock('@/lib/api/balo-api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/balo-api-client')>();
  return {
    ...actual,
    getBaloApiJson: mockGet,
    postBaloApiJson: mockPost,
  };
});

import {
  getCallNowRing,
  getCallNowView,
  parseCallNowView,
  parseRingRead,
  postAnswerRing,
  postStartCallNow,
  postStopRing,
} from './call-now-api-client';

const RING = {
  ringId: 'ring-1',
  meetingId: 'meeting-1',
  engagementId: 'eng-1',
  status: 'ringing',
  placement: 'new_meeting',
  expiresAt: '2026-11-19T04:01:00.000Z',
  role: 'caller',
  awaitsAnswer: false,
  meetingEnded: false,
  reachedBy: 'sms',
  attemptId: 'attempt-1',
  calleePresenceAtStart: 'online',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('parseCallNowView', () => {
  it('reads the view with the in-place candidate and the presence fields', () => {
    expect(
      parseCallNowView({
        canCallNow: true,
        reason: null,
        calleeOnline: true,
        calleeTimeZone: 'Australia/Perth',
        inPlaceCandidate: { meetingId: 'm-1', scheduledStart: '2026-11-19T06:00:00.000Z' },
      })
    ).toEqual({
      canCallNow: true,
      reason: null,
      calleeOnline: true,
      calleeTimeZone: 'Australia/Perth',
      inPlaceCandidate: { meetingId: 'm-1', scheduledStartIso: '2026-11-19T06:00:00.000Z' },
    });
  });

  it('defaults a missing calleeOnline to false and a missing time zone to null (deploy skew)', () => {
    expect(parseCallNowView({ canCallNow: false, reason: 'busy', inPlaceCandidate: null })).toEqual(
      {
        canCallNow: false,
        reason: 'busy',
        calleeOnline: false,
        calleeTimeZone: null,
        inPlaceCandidate: null,
      }
    );
  });

  it.each([
    ['a non-boolean canCallNow', { canCallNow: 'yes', reason: null, inPlaceCandidate: null }],
    ['an unknown reason', { canCallNow: false, reason: 'weird', inPlaceCandidate: null }],
    [
      'a malformed candidate',
      { canCallNow: true, reason: null, inPlaceCandidate: { meetingId: 'm-1' } },
    ],
  ])('rejects %s', (_label, body) => {
    expect(parseCallNowView(body)).toBeNull();
  });
});

describe('parseRingRead', () => {
  it('reads a full ring body, including who is reading and how the callee was reached', () => {
    expect(parseRingRead(RING)).toEqual({
      ringId: 'ring-1',
      meetingId: 'meeting-1',
      engagementId: 'eng-1',
      status: 'ringing',
      placement: 'new_meeting',
      expiresAt: '2026-11-19T04:01:00.000Z',
      role: 'caller',
      awaitsAnswer: false,
      meetingEnded: false,
      reachedBy: 'sms',
      attemptId: 'attempt-1',
      calleePresenceAtStart: 'online',
    });
  });

  it('defaults a missing attempt id to null and a missing presence to offline (deploy skew)', () => {
    const old: Record<string, unknown> = { ...RING };
    delete old.attemptId;
    delete old.calleePresenceAtStart;
    expect(parseRingRead(old)).toMatchObject({ attemptId: null, calleePresenceAtStart: 'offline' });
    expect(parseRingRead({ ...RING, attemptId: null, calleePresenceAtStart: null })).toMatchObject({
      attemptId: null,
      calleePresenceAtStart: 'offline',
    });
  });

  it('defaults a missing reachedBy to app and tolerates a missing placement and role', () => {
    const old: Record<string, unknown> = { ...RING };
    delete old.reachedBy;
    delete old.placement;
    delete old.role;
    expect(parseRingRead(old)).toMatchObject({ reachedBy: 'app', placement: null, role: null });
  });

  it.each([
    ['null', null],
    ['an unknown status', { ...RING, status: 'weird' }],
    ['a missing ring id', { ...RING, ringId: undefined }],
    ['a missing engagement id', { ...RING, engagementId: undefined }],
    ['a non-boolean awaitsAnswer', { ...RING, awaitsAnswer: 'no' }],
  ])('rejects %s', (_label, body) => {
    expect(parseRingRead(body)).toBeUndefined();
  });
});

describe('the hops', () => {
  it('reads the case view from the engagement path', async () => {
    mockGet.mockResolvedValue({ ok: true, data: {} });
    await getCallNowView('eng-1');
    const [path, parse, label] = mockGet.mock.calls[0] ?? [];
    expect(path).toBe('/cases/eng-1/call-now');
    expect(parse).toBe(parseCallNowView);
    expect(label).toBe('Call now view');
  });

  it('starts with an empty body, or with the in-place meeting when one is chosen', async () => {
    mockPost.mockResolvedValue({ ok: true, data: {} });
    await postStartCallNow('eng-1', { attemptId: 'a-1' });
    await postStartCallNow('eng-1', { inPlaceOfMeetingId: 'm-1', attemptId: 'a-1' });
    expect(mockPost.mock.calls[0]?.[1]).toEqual({});
    expect(mockPost.mock.calls[1]?.[1]).toEqual({ inPlaceOfMeetingId: 'm-1' });
  });

  it('sends the attempt id as a query parameter and never in the strict body', async () => {
    mockPost.mockResolvedValue({ ok: true, data: {} });
    await postStartCallNow('eng/1', { inPlaceOfMeetingId: 'm-1', attemptId: 'a b' });
    const [path, body] = mockPost.mock.calls[0] ?? [];
    expect(path).toBe('/cases/eng%2F1/call-now?attemptId=a%20b');
    expect(JSON.stringify(body)).not.toContain('attemptId');
  });

  it('parses a start body', async () => {
    mockPost.mockResolvedValue({ ok: true, data: {} });
    await postStartCallNow('eng-1', { attemptId: 'a-1' });
    const [, , parse] = mockPost.mock.calls[0] ?? [];
    expect(
      parse({
        ringId: 'r',
        meetingId: 'm',
        placement: 'in_place',
        expiresAt: '2026-11-19T04:01:00.000Z',
      })
    ).toEqual({
      ringId: 'r',
      meetingId: 'm',
      placement: 'in_place',
      expiresAt: '2026-11-19T04:01:00.000Z',
    });
    expect(parse({ ringId: 'r' })).toBeNull();
  });

  it('reads and acts on a ring by its encoded id', async () => {
    mockGet.mockResolvedValue({ ok: true, data: {} });
    mockPost.mockResolvedValue({ ok: true, data: {} });
    await getCallNowRing('ring/1');
    await postStopRing('ring-1');
    expect(mockGet.mock.calls[0]?.[0]).toBe('/call-now/rings/ring%2F1');
    expect(mockGet.mock.calls[0]?.[1](RING)).toMatchObject({ ringId: 'ring-1' });
    expect(mockGet.mock.calls[0]?.[1]({ status: 'weird' })).toBeNull();
    expect(mockPost.mock.calls[0]?.[0]).toBe('/call-now/rings/ring-1/stop');
    expect(mockPost.mock.calls[0]?.[2]({ status: 'stopped' })).toEqual({ status: 'stopped' });
    expect(mockPost.mock.calls[0]?.[2]({})).toBeNull();
  });

  it('answers a ring and accepts only a join grant', async () => {
    mockPost.mockResolvedValue({ ok: true, data: {} });
    await postAnswerRing('ring-1');
    const [path, , parse] = mockPost.mock.calls[0] ?? [];
    expect(path).toBe('/call-now/rings/ring-1/answer');
    expect(parse({ roomUrl: 'https://x.daily.co/r', token: 't', isOwner: false })).toMatchObject({
      roomUrl: 'https://x.daily.co/r',
    });
    expect(parse({ roomUrl: 'https://x.daily.co/r' })).toBeNull();
  });
});
