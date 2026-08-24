import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockLoggedFetch = vi.fn();
const mockGetSession = vi.fn();

vi.mock('server-only', () => ({}));
vi.mock('@/lib/logging/fetch-wrapper', () => ({
  loggedFetch: (...args: unknown[]) => mockLoggedFetch(...args),
}));
vi.mock('@/lib/auth/session', () => ({
  getSession: (...args: unknown[]) => mockGetSession(...args),
}));

import {
  postAcceptRescheduleProposal,
  postDeclineRescheduleProposal,
  postProposeReschedule,
  postWithdrawRescheduleProposal,
} from './reschedule-proposal-api-client';

const MEETING_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PROPOSAL_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OPTION_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ACCESS_TOKEN = 'workos.access.token';

function response(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function lastInit(): { headers: Record<string, string>; body?: string; method: string } {
  return mockLoggedFetch.mock.calls.at(-1)?.[1] as {
    headers: Record<string, string>;
    body?: string;
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
});

describe('postProposeReschedule', () => {
  const proposeBody = {
    proposalId: PROPOSAL_ID,
    meetingId: MEETING_ID,
    expiresAtIso: '2026-09-01T10:00:00.000Z',
    options: [
      {
        optionId: OPTION_ID,
        scheduledStart: '2026-09-01T11:00:00.000Z',
        scheduledEnd: '2026-09-01T11:30:00.000Z',
        position: 0,
      },
    ],
  };

  it('posts to the meeting-scoped route with the viewer`s Bearer token', async () => {
    mockLoggedFetch.mockResolvedValue(response(200, proposeBody));
    await postProposeReschedule(MEETING_ID, {
      options: [{ scheduledStart: '2026-09-01T11:00:00.000Z' }],
    });
    expect(mockLoggedFetch).toHaveBeenCalledWith(
      `http://api.test/meetings/${MEETING_ID}/reschedule-proposals`,
      expect.objectContaining({ service: 'balo-api', method: 'POST' })
    );
    expect(lastInit().headers.Authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
  });

  it('returns the typed options array on success', async () => {
    mockLoggedFetch.mockResolvedValue(response(200, proposeBody));
    const result = await postProposeReschedule(MEETING_ID, {
      options: [{ scheduledStart: '2026-09-01T11:00:00.000Z' }],
    });
    expect(result).toEqual({ ok: true, data: proposeBody });
  });

  it('fails closed to unauthenticated with no session', async () => {
    mockGetSession.mockResolvedValue({ user: undefined, accessToken: undefined });
    const result = await postProposeReschedule(MEETING_ID, {
      options: [{ scheduledStart: '2026-09-01T11:00:00.000Z' }],
    });
    expect(result).toEqual({ ok: false, status: 401, code: 'unauthenticated' });
    expect(mockLoggedFetch).not.toHaveBeenCalled();
  });

  it('maps a non-2xx to { ok: false, status, code }', async () => {
    mockLoggedFetch.mockResolvedValue(response(409, { error: 'proposal_already_pending' }));
    const result = await postProposeReschedule(MEETING_ID, {
      options: [{ scheduledStart: '2026-09-01T11:00:00.000Z' }],
    });
    expect(result).toEqual({ ok: false, status: 409, code: 'proposal_already_pending' });
  });

  it('carries retryAfterSeconds only on a 429', async () => {
    mockLoggedFetch.mockResolvedValue(
      response(429, { error: 'rate_limited' }, { 'Retry-After': '12' })
    );
    const result = await postProposeReschedule(MEETING_ID, {
      options: [{ scheduledStart: '2026-09-01T11:00:00.000Z' }],
    });
    expect(result).toEqual({ ok: false, status: 429, code: 'rate_limited', retryAfterSeconds: 12 });
  });

  it('a transport error becomes status: 0, code: request_failed — nothing throws', async () => {
    mockLoggedFetch.mockRejectedValue(new Error('network down'));
    await expect(
      postProposeReschedule(MEETING_ID, {
        options: [{ scheduledStart: '2026-09-01T11:00:00.000Z' }],
      })
    ).resolves.toEqual({ ok: false, status: 0, code: 'request_failed' });
  });

  it('a malformed 200 body degrades to a transport-shaped failure, not a throw', async () => {
    mockLoggedFetch.mockResolvedValue(response(200, { proposalId: PROPOSAL_ID }));
    const result = await postProposeReschedule(MEETING_ID, {
      options: [{ scheduledStart: '2026-09-01T11:00:00.000Z' }],
    });
    expect(result).toEqual({ ok: false, status: 0, code: 'request_failed' });
  });

  it('a malformed option inside an otherwise-valid body degrades the same way', async () => {
    mockLoggedFetch.mockResolvedValue(
      response(200, { ...proposeBody, options: [{ optionId: OPTION_ID }] })
    );
    const result = await postProposeReschedule(MEETING_ID, {
      options: [{ scheduledStart: '2026-09-01T11:00:00.000Z' }],
    });
    expect(result).toEqual({ ok: false, status: 0, code: 'request_failed' });
  });
});

describe('postWithdrawRescheduleProposal', () => {
  it('posts to the proposal-scoped withdraw route', async () => {
    mockLoggedFetch.mockResolvedValue(
      response(200, { proposalId: PROPOSAL_ID, status: 'withdrawn' })
    );
    const result = await postWithdrawRescheduleProposal(MEETING_ID, PROPOSAL_ID);
    expect(mockLoggedFetch).toHaveBeenCalledWith(
      `http://api.test/meetings/${MEETING_ID}/reschedule-proposals/${PROPOSAL_ID}/withdraw`,
      expect.objectContaining({ method: 'POST' })
    );
    expect(result).toEqual({ ok: true, data: { proposalId: PROPOSAL_ID, status: 'withdrawn' } });
  });

  it('maps a 409 to proposal_not_answerable', async () => {
    mockLoggedFetch.mockResolvedValue(response(409, { error: 'proposal_not_answerable' }));
    const result = await postWithdrawRescheduleProposal(MEETING_ID, PROPOSAL_ID);
    expect(result).toEqual({ ok: false, status: 409, code: 'proposal_not_answerable' });
  });
});

describe('postAcceptRescheduleProposal', () => {
  const acceptBody = {
    proposalId: PROPOSAL_ID,
    meetingId: MEETING_ID,
    scheduledStart: '2026-09-02T10:00:00.000Z',
    scheduledEnd: '2026-09-02T10:30:00.000Z',
    previousScheduledStart: '2026-09-01T09:00:00.000Z',
    previousScheduledEnd: '2026-09-01T09:30:00.000Z',
    rescheduleAuditId: 'audit-1',
  };

  it('posts the chosen optionId to the accept route', async () => {
    mockLoggedFetch.mockResolvedValue(response(200, acceptBody));
    await postAcceptRescheduleProposal(MEETING_ID, PROPOSAL_ID, { optionId: OPTION_ID });
    expect(lastInit().body).toBe(JSON.stringify({ optionId: OPTION_ID }));
  });

  it('returns the committed window plus the rescheduleAuditId on success', async () => {
    mockLoggedFetch.mockResolvedValue(response(200, acceptBody));
    const result = await postAcceptRescheduleProposal(MEETING_ID, PROPOSAL_ID, {
      optionId: OPTION_ID,
    });
    expect(result).toEqual({ ok: true, data: acceptBody });
  });

  it('tolerates a MISSING rescheduleAuditId (deploy-skew) rather than failing the parse', async () => {
    const withoutAuditId = {
      proposalId: acceptBody.proposalId,
      meetingId: acceptBody.meetingId,
      scheduledStart: acceptBody.scheduledStart,
      scheduledEnd: acceptBody.scheduledEnd,
      previousScheduledStart: acceptBody.previousScheduledStart,
      previousScheduledEnd: acceptBody.previousScheduledEnd,
    };
    mockLoggedFetch.mockResolvedValue(response(200, withoutAuditId));
    const result = await postAcceptRescheduleProposal(MEETING_ID, PROPOSAL_ID, {
      optionId: OPTION_ID,
    });
    expect(result).toEqual({ ok: true, data: withoutAuditId });
  });

  it('maps a slot-lost 409 to window_not_available', async () => {
    mockLoggedFetch.mockResolvedValue(response(409, { error: 'window_not_available' }));
    const result = await postAcceptRescheduleProposal(MEETING_ID, PROPOSAL_ID, {
      optionId: OPTION_ID,
    });
    expect(result).toEqual({ ok: false, status: 409, code: 'window_not_available' });
  });

  it('maps a stale-proposal 409 to proposal_stale', async () => {
    mockLoggedFetch.mockResolvedValue(response(409, { error: 'proposal_stale' }));
    const result = await postAcceptRescheduleProposal(MEETING_ID, PROPOSAL_ID, {
      optionId: OPTION_ID,
    });
    expect(result).toEqual({ ok: false, status: 409, code: 'proposal_stale' });
  });
});

describe('postDeclineRescheduleProposal', () => {
  it('posts to the proposal-scoped decline route', async () => {
    mockLoggedFetch.mockResolvedValue(
      response(200, { proposalId: PROPOSAL_ID, status: 'declined' })
    );
    const result = await postDeclineRescheduleProposal(MEETING_ID, PROPOSAL_ID);
    expect(mockLoggedFetch).toHaveBeenCalledWith(
      `http://api.test/meetings/${MEETING_ID}/reschedule-proposals/${PROPOSAL_ID}/decline`,
      expect.objectContaining({ method: 'POST' })
    );
    expect(result).toEqual({ ok: true, data: { proposalId: PROPOSAL_ID, status: 'declined' } });
  });

  it('a transport error becomes status: 0, code: request_failed — nothing throws', async () => {
    mockLoggedFetch.mockRejectedValue(new Error('network down'));
    await expect(postDeclineRescheduleProposal(MEETING_ID, PROPOSAL_ID)).resolves.toEqual({
      ok: false,
      status: 0,
      code: 'request_failed',
    });
  });
});
