import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { PresenceFacts } from '@balo/shared/meetings';

const {
  mockFindForClientMoneyView,
  mockFindForExpertView,
  mockFindStatementContext,
  mockFindBySession,
  mockFactsByMeetingIds,
  mockToClientMoneyBlock,
  mockToExpertMoneyBlock,
  mockResolveSessionLens,
  mockLogError,
} = vi.hoisted(() => ({
  mockFindForClientMoneyView: vi.fn(),
  mockFindForExpertView: vi.fn(),
  mockFindStatementContext: vi.fn(),
  mockFindBySession: vi.fn(),
  mockFactsByMeetingIds: vi.fn(),
  mockToClientMoneyBlock: vi.fn(),
  mockToExpertMoneyBlock: vi.fn(),
  mockResolveSessionLens: vi.fn(),
  mockLogError: vi.fn(),
}));

vi.mock('@balo/db', () => ({
  creditSessionsRepository: {
    findForClientMoneyView: mockFindForClientMoneyView,
    findForExpertView: mockFindForExpertView,
    findStatementContext: mockFindStatementContext,
  },
  expertPayoutRecordsRepository: { findBySession: mockFindBySession },
  meetingPresenceRepository: { factsByMeetingIds: mockFactsByMeetingIds },
  toClientMoneyBlock: mockToClientMoneyBlock,
  toExpertMoneyBlock: mockToExpertMoneyBlock,
}));
vi.mock('./resolve-session-lens.js', () => ({ resolveSessionLens: mockResolveSessionLens }));
vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: mockLogError }),
}));

import { resolveSessionStatement } from './session-statement.js';

const CONTEXT_ROW = {
  sessionId: 'session_1',
  status: 'ended',
  connectedAt: new Date('2026-08-12T10:00:00.000Z'),
  endedAt: new Date('2026-08-12T10:45:00.000Z'),
  meetingId: 'meeting_1',
  engagementId: 'engagement_1',
  companyName: 'Northwind Industrial',
  caseTitle: 'Static analysis walkthrough',
  expertProfileId: 'expert_1',
  expertProfileType: 'agency' as const,
  expertFirstName: 'Priya',
  expertLastName: 'Sharma',
  agencyName: 'CloudPeak Consulting',
};

describe('resolveSessionStatement (BAL-441)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockToClientMoneyBlock.mockReturnValue({ lens: 'client' });
    mockToExpertMoneyBlock.mockReturnValue({ lens: 'expert' });
  });

  it('not_found short-circuits BEFORE either projected read (existence hidden)', async () => {
    mockResolveSessionLens.mockResolvedValue({ ok: false, code: 'not_found' });
    const result = await resolveSessionStatement('session_1', 'stranger');
    expect(result).toEqual({ ok: false, code: 'not_found' });
    expect(mockFindForClientMoneyView).not.toHaveBeenCalled();
    expect(mockFindStatementContext).not.toHaveBeenCalled();
  });

  it('builds the CLIENT arm: expert person + agency org label, never a client figure key', async () => {
    mockResolveSessionLens.mockResolvedValue({ ok: true, lens: 'client', session: {} });
    mockFindForClientMoneyView.mockResolvedValue({ id: 'session_1' });
    mockFindStatementContext.mockResolvedValue(CONTEXT_ROW);

    const result = await resolveSessionStatement('session_1', 'user_1');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.statement).toEqual({
      lens: 'client',
      block: { lens: 'client' },
      context: {
        occurredAtIso: '2026-08-12T10:00:00.000Z',
        title: 'Static analysis walkthrough',
        counterparty: { name: 'Priya Sharma', orgLabel: 'CloudPeak Consulting' },
        meetingId: 'meeting_1',
        cancelled: false,
        clientSideEverPresent: null,
      },
    });
    expect(mockFindBySession).not.toHaveBeenCalled();
    // Negative fee-safety assertion: no key on this arm names a rate/fee/margin/amount.
    const contextKeys = Object.keys(result.statement.context);
    expect(contextKeys.some((k) => /rate|fee|margin|amount/i.test(k))).toBe(false);
  });

  it('an INDEPENDENT expert (freelancer) carries orgLabel: null even with an agency name set', async () => {
    mockResolveSessionLens.mockResolvedValue({ ok: true, lens: 'client', session: {} });
    mockFindForClientMoneyView.mockResolvedValue({ id: 'session_1' });
    mockFindStatementContext.mockResolvedValue({
      ...CONTEXT_ROW,
      expertProfileType: 'freelancer',
      agencyName: null,
    });

    const result = await resolveSessionStatement('session_1', 'user_1');
    if (!result.ok) throw new Error('expected ok');
    expect(result.statement.context.counterparty).toEqual({
      name: 'Priya Sharma',
      orgLabel: null,
    });
  });

  it('NULL engagement/case -> title: null', async () => {
    mockResolveSessionLens.mockResolvedValue({ ok: true, lens: 'client', session: {} });
    mockFindForClientMoneyView.mockResolvedValue({ id: 'session_1' });
    mockFindStatementContext.mockResolvedValue({
      ...CONTEXT_ROW,
      engagementId: null,
      caseTitle: null,
    });

    const result = await resolveSessionStatement('session_1', 'user_1');
    if (!result.ok) throw new Error('expected ok');
    expect(result.statement.context.title).toBeNull();
  });

  it('NULL meeting -> meetingId: null (the recap back-link is omitted)', async () => {
    mockResolveSessionLens.mockResolvedValue({ ok: true, lens: 'client', session: {} });
    mockFindForClientMoneyView.mockResolvedValue({ id: 'session_1' });
    mockFindStatementContext.mockResolvedValue({ ...CONTEXT_ROW, meetingId: null });

    const result = await resolveSessionStatement('session_1', 'user_1');
    if (!result.ok) throw new Error('expected ok');
    expect(result.statement.context.meetingId).toBeNull();
  });

  it('a cancelled session -> cancelled: true', async () => {
    mockResolveSessionLens.mockResolvedValue({ ok: true, lens: 'client', session: {} });
    mockFindForClientMoneyView.mockResolvedValue({ id: 'session_1' });
    mockFindStatementContext.mockResolvedValue({ ...CONTEXT_ROW, status: 'cancelled' });

    const result = await resolveSessionStatement('session_1', 'user_1');
    if (!result.ok) throw new Error('expected ok');
    expect(result.statement.context.cancelled).toBe(true);
  });

  it('builds the EXPERT arm: client COMPANY counterparty (never a client person), payout reference', async () => {
    mockResolveSessionLens.mockResolvedValue({
      ok: true,
      lens: 'expert',
      session: {},
      expertProfileId: 'expert_1',
    });
    mockFindForExpertView.mockResolvedValue({ id: 'session_1' });
    mockFindStatementContext.mockResolvedValue(CONTEXT_ROW);
    mockFindBySession.mockResolvedValue({
      id: 'payout_1',
      status: 'recorded',
      recordedAt: new Date('2026-08-12T11:00:00.000Z'),
    });

    const result = await resolveSessionStatement('session_1', 'expert_user');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.statement).toEqual({
      lens: 'expert',
      block: { lens: 'expert' },
      context: {
        occurredAtIso: '2026-08-12T10:00:00.000Z',
        title: 'Static analysis walkthrough',
        counterparty: { name: 'Northwind Industrial', orgLabel: null },
        meetingId: 'meeting_1',
        cancelled: false,
        payout: { reference: 'payout_1', recordedAtIso: '2026-08-12T11:00:00.000Z' },
      },
    });
    expect(mockToExpertMoneyBlock).toHaveBeenCalledWith({ id: 'session_1' }, 'recorded');
  });

  it('no payout record yet -> payout: null (the real gap between finalize and record write)', async () => {
    mockResolveSessionLens.mockResolvedValue({
      ok: true,
      lens: 'expert',
      session: {},
      expertProfileId: 'expert_1',
    });
    mockFindForExpertView.mockResolvedValue({ id: 'session_1' });
    mockFindStatementContext.mockResolvedValue(CONTEXT_ROW);
    mockFindBySession.mockResolvedValue(undefined);

    const result = await resolveSessionStatement('session_1', 'expert_user');
    if (!result.ok) throw new Error('expected ok');
    expect(result.statement.context).toHaveProperty('payout', null);
  });

  it('404s when the projected money view races a delete after the lens grant', async () => {
    mockResolveSessionLens.mockResolvedValue({ ok: true, lens: 'client', session: {} });
    mockFindForClientMoneyView.mockResolvedValue(undefined);
    mockFindStatementContext.mockResolvedValue(CONTEXT_ROW);

    const result = await resolveSessionStatement('session_1', 'user_1');
    expect(result).toEqual({ ok: false, code: 'not_found' });
  });
});

// `missed_call` only records that the expert never joined; the session cannot say whether anybody
// on the client side did (it opens when the call page mints a join grant). The client arm reads
// the presence rows for that shape ONLY, so `durationLine` can name nobody when nobody joined.
describe('resolveSessionStatement — client-side presence on a missed call', () => {
  function presenceFacts(clientSideEverPresent: boolean): Map<string, PresenceFacts> {
    return new Map([
      [
        'meeting_1',
        {
          expertEverPresent: false,
          expertOpen: false,
          clientSideEverPresent,
          anyOpen: false,
          lastLeftAt: null,
          expertFirstJoinedAt: null,
        },
      ],
    ]);
  }

  async function resolveClient(): Promise<Record<string, unknown>> {
    const result = await resolveSessionStatement('session_1', 'user_1');
    if (!result.ok) throw new Error('expected ok');
    expect(result.statement.lens).toBe('client');
    return result.statement.context as unknown as Record<string, unknown>;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveSessionLens.mockResolvedValue({ ok: true, lens: 'client', session: {} });
    mockFindForClientMoneyView.mockResolvedValue({ id: 'session_1' });
    mockFindStatementContext.mockResolvedValue(CONTEXT_ROW);
    mockToClientMoneyBlock.mockReturnValue({
      lens: 'client',
      state: 'finalized',
      settlementShape: 'missed_call',
    });
    mockToExpertMoneyBlock.mockReturnValue({
      lens: 'expert',
      state: 'finalized',
      settlementShape: 'missed_call',
    });
  });

  it.each([false, true])(
    'carries clientSideEverPresent: %s from ONE read of the session meeting',
    async (clientSideEverPresent) => {
      mockFactsByMeetingIds.mockResolvedValue(presenceFacts(clientSideEverPresent));
      const context = await resolveClient();
      expect(context).toHaveProperty('clientSideEverPresent', clientSideEverPresent);
      expect(mockFactsByMeetingIds).toHaveBeenCalledTimes(1);
      expect(mockFactsByMeetingIds).toHaveBeenCalledWith(['meeting_1']);
    }
  );

  it.each([
    ['held', { state: 'finalized', settlementShape: 'held' }],
    ['no_show_client', { state: 'finalized', settlementShape: 'no_show_client' }],
    ['abandoned_wait', { state: 'finalized', settlementShape: 'abandoned_wait' }],
    ['a live_capture session (no shape)', { state: 'finalized' }],
    ['pending', { state: 'pending' }],
  ])('%s -> no presence read, null', async (_label, block) => {
    mockToClientMoneyBlock.mockReturnValue({ lens: 'client', ...block });
    const context = await resolveClient();
    expect(context).toHaveProperty('clientSideEverPresent', null);
    expect(mockFactsByMeetingIds).not.toHaveBeenCalled();
  });

  it('a missed call with no meeting -> no presence read, null', async () => {
    mockFindStatementContext.mockResolvedValue({ ...CONTEXT_ROW, meetingId: null });
    const context = await resolveClient();
    expect(context).toHaveProperty('clientSideEverPresent', null);
    expect(mockFactsByMeetingIds).not.toHaveBeenCalled();
  });

  it('a result missing the meeting -> null rather than a guess', async () => {
    mockFactsByMeetingIds.mockResolvedValue(new Map());
    const context = await resolveClient();
    expect(context).toHaveProperty('clientSideEverPresent', null);
  });

  it('a FAILED presence read still serves the statement, with presence unknown (null), and logs', async () => {
    mockFactsByMeetingIds.mockRejectedValue(new Error('connection reset'));
    const context = await resolveClient();
    expect(context).toHaveProperty('clientSideEverPresent', null);
    expect(context).toHaveProperty('counterparty', {
      name: 'Priya Sharma',
      orgLabel: 'CloudPeak Consulting',
    });
    expect(mockLogError).toHaveBeenCalledTimes(1);
    expect(mockLogError).toHaveBeenCalledWith(
      expect.objectContaining({
        op: 'resolveSessionStatement',
        sessionId: 'session_1',
        meetingId: 'meeting_1',
        error: 'connection reset',
        stack: expect.any(String),
      }),
      expect.any(String)
    );
  });

  it('the EXPERT arm never reads presence and carries no clientSideEverPresent', async () => {
    mockResolveSessionLens.mockResolvedValue({
      ok: true,
      lens: 'expert',
      session: {},
      expertProfileId: 'expert_1',
    });
    mockFindForExpertView.mockResolvedValue({ id: 'session_1' });
    mockFindBySession.mockResolvedValue(undefined);

    const result = await resolveSessionStatement('session_1', 'expert_user');
    if (!result.ok) throw new Error('expected ok');
    expect(result.statement.lens).toBe('expert');
    expect(result.statement.context).not.toHaveProperty('clientSideEverPresent');
    expect(mockFactsByMeetingIds).not.toHaveBeenCalled();
  });
});
