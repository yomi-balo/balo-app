import { describe, it, expect, beforeEach, vi } from 'vitest';

const {
  mockFindForClientMoneyView,
  mockFindForExpertView,
  mockFindStatementContext,
  mockFindBySession,
  mockToClientMoneyBlock,
  mockToExpertMoneyBlock,
  mockResolveSessionLens,
} = vi.hoisted(() => ({
  mockFindForClientMoneyView: vi.fn(),
  mockFindForExpertView: vi.fn(),
  mockFindStatementContext: vi.fn(),
  mockFindBySession: vi.fn(),
  mockToClientMoneyBlock: vi.fn(),
  mockToExpertMoneyBlock: vi.fn(),
  mockResolveSessionLens: vi.fn(),
}));

vi.mock('@balo/db', () => ({
  creditSessionsRepository: {
    findForClientMoneyView: mockFindForClientMoneyView,
    findForExpertView: mockFindForExpertView,
    findStatementContext: mockFindStatementContext,
  },
  expertPayoutRecordsRepository: { findBySession: mockFindBySession },
  toClientMoneyBlock: mockToClientMoneyBlock,
  toExpertMoneyBlock: mockToExpertMoneyBlock,
}));
vi.mock('./resolve-session-lens.js', () => ({ resolveSessionLens: mockResolveSessionLens }));

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
