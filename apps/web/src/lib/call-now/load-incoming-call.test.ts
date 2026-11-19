import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockGetIncoming,
  mockResolveCaseAccess,
  mockReadFirstName,
  mockReadRateLine,
  mockFindCase,
  mockFindCompany,
  mockLog,
} = vi.hoisted(() => ({
  mockGetIncoming: vi.fn(),
  mockResolveCaseAccess: vi.fn(),
  mockReadFirstName: vi.fn(),
  mockReadRateLine: vi.fn(),
  mockFindCase: vi.fn(),
  mockFindCompany: vi.fn(),
  mockLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('server-only', () => ({}));
vi.mock('./call-now-api-client', () => ({ getIncomingCallNowRing: mockGetIncoming }));
vi.mock('@/lib/cases/resolve-case-access', () => ({ resolveCaseAccess: mockResolveCaseAccess }));
vi.mock('./load-call-now-caller-view', () => ({ readExpertFirstName: mockReadFirstName }));
vi.mock('./call-now-rate-line', () => ({ readCallNowRateLine: mockReadRateLine }));
vi.mock('@balo/db', () => ({
  caseEngagementsRepository: { findByEngagementId: mockFindCase },
  companiesRepository: { findNameById: mockFindCompany },
}));
vi.mock('@/lib/logging', async () => {
  const actual = await vi.importActual<typeof import('@/lib/logging')>('@/lib/logging');
  return { ...actual, log: mockLog };
});

import { loadIncomingCall } from './load-incoming-call';

const USER_ID = 'user-1';
const RATE_LINE = 'From A$3.75/min · 15-minute minimum';
const RING = {
  ringId: 'ring-1',
  meetingId: 'meeting-1',
  engagementId: 'eng-1',
  callerSide: 'expert',
  placement: 'new_meeting',
  reachedBy: 'app',
  expiresAt: '2026-11-19T04:01:00.000Z',
  startedAt: '2026-11-19T04:00:15.000Z',
  awaitsAnswer: true,
};

function access(lens: 'client' | 'expert'): Record<string, unknown> {
  return { lens, engagementId: 'eng-1', companyId: 'co-1', expertProfileId: 'ep-1' };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetIncoming.mockResolvedValue({ ok: true, data: { ring: RING } });
  mockResolveCaseAccess.mockResolvedValue(access('client'));
  mockReadFirstName.mockResolvedValue('Dana');
  mockReadRateLine.mockResolvedValue(RATE_LINE);
  mockFindCase.mockResolvedValue({ title: 'Flow migration' });
  mockFindCompany.mockResolvedValue({ id: 'co-1', name: 'Northwind Industrial' });
});

describe('loadIncomingCall', () => {
  it('gives the client lens the expert first name, the rate line and the join path', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-19T10:00:05.000Z'), toFake: ['Date'] });
    const view = await loadIncomingCall(USER_ID);
    vi.useRealTimers();
    expect(view).toEqual({
      ringId: 'ring-1',
      meetingId: 'meeting-1',
      engagementId: 'eng-1',
      lens: 'client',
      callerLabel: 'Dana',
      caseTitle: 'Flow migration',
      rateLine: RATE_LINE,
      expiresAtIso: RING.expiresAt,
      startedAtIso: RING.startedAt,
      awaitsAnswer: true,
      joinPath: '/meetings/meeting-1/call',
      serverNowIso: '2026-11-19T10:00:05.000Z',
    });
    expect(mockReadFirstName).toHaveBeenCalledWith('ep-1');
    expect(mockReadRateLine).toHaveBeenCalledWith('ep-1');
  });

  it('gives the expert lens the client company and NO rate line, and never reads one', async () => {
    mockResolveCaseAccess.mockResolvedValue(access('expert'));
    mockGetIncoming.mockResolvedValue({
      ok: true,
      data: { ring: { ...RING, callerSide: 'client' } },
    });

    const view = await loadIncomingCall(USER_ID);

    expect(view).toMatchObject({
      lens: 'expert',
      callerLabel: 'Northwind Industrial',
      rateLine: null,
    });
    expect(mockReadRateLine).not.toHaveBeenCalled();
    expect(mockFindCompany).toHaveBeenCalledWith('co-1');
  });

  it('falls back to a neutral label when the company has no readable name', async () => {
    mockResolveCaseAccess.mockResolvedValue(access('expert'));
    mockGetIncoming.mockResolvedValue({
      ok: true,
      data: { ring: { ...RING, callerSide: 'client' } },
    });
    mockFindCompany.mockResolvedValue(undefined);

    await expect(loadIncomingCall(USER_ID)).resolves.toMatchObject({ callerLabel: 'the client' });
  });

  it('keeps the toast when the case title is missing', async () => {
    mockFindCase.mockResolvedValue(undefined);

    await expect(loadIncomingCall(USER_ID)).resolves.toMatchObject({ caseTitle: null });
  });

  it('is null when no ring is live', async () => {
    mockGetIncoming.mockResolvedValue({ ok: true, data: { ring: null } });

    await expect(loadIncomingCall(USER_ID)).resolves.toBeNull();
    expect(mockResolveCaseAccess).not.toHaveBeenCalled();
  });

  it('is null when the viewer lost the case', async () => {
    mockResolveCaseAccess.mockResolvedValue(null);

    await expect(loadIncomingCall(USER_ID)).resolves.toBeNull();
  });

  it.each(['client', 'expert'] as const)(
    'is null when the viewer resolves to the caller side (%s)',
    async (side) => {
      mockGetIncoming.mockResolvedValue({
        ok: true,
        data: { ring: { ...RING, callerSide: side } },
      });
      mockResolveCaseAccess.mockResolvedValue(access(side));

      await expect(loadIncomingCall(USER_ID)).resolves.toBeNull();
    }
  );

  it('is null and silent on a 404, but logs any other failed read', async () => {
    mockGetIncoming.mockResolvedValue({ ok: false, status: 404, code: 'x' });
    await expect(loadIncomingCall(USER_ID)).resolves.toBeNull();
    expect(mockLog.warn).not.toHaveBeenCalled();

    mockGetIncoming.mockResolvedValue({ ok: false, status: 500, code: 'internal_error' });
    await expect(loadIncomingCall(USER_ID)).resolves.toBeNull();
    expect(mockLog.warn).toHaveBeenCalledWith(
      'Call toast could not read the incoming ring',
      expect.objectContaining({ status: 500 })
    );
  });

  it('is null and logs when a read throws', async () => {
    mockReadFirstName.mockRejectedValue(new Error('db down'));

    await expect(loadIncomingCall(USER_ID)).resolves.toBeNull();
    expect(mockLog.warn).toHaveBeenCalledWith(
      'Call toast could not load the incoming ring',
      expect.objectContaining({ error: 'db down' })
    );
  });
});
