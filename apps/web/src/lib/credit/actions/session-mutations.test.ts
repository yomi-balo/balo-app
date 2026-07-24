import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({
  cookies: vi.fn(() => ({ get: vi.fn() })),
  headers: vi.fn(() => new Headers()),
}));

const mockCall = vi.fn();
vi.mock('../api-client', () => ({
  callSessionApi: (...args: unknown[]) => mockCall(...args),
}));

import {
  connectSessionAction,
  endSessionAction,
  nudgeAdminAction,
  openSessionAction,
} from './session-mutations';

const EXPERT_ID = 'b0000000-0000-4000-8000-000000000001';
const SESSION_ID = 'c0000000-0000-4000-8000-000000000002';
const COMPANY_ID = 'd0000000-0000-4000-8000-000000000003';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('openSessionAction', () => {
  it('forwards ONLY the expert id + estimate (no company/wallet) and returns the session', async () => {
    mockCall.mockResolvedValue({
      ok: true,
      status: 201,
      data: { sessionId: SESSION_ID, status: 'pending', holdId: 'hold-1' },
    });

    const result = await openSessionAction({ expertProfileId: EXPERT_ID, estimatedMinutes: 30 });

    expect(mockCall).toHaveBeenCalledWith('/sessions', 'POST', {
      expertProfileId: EXPERT_ID,
      estimatedMinutes: 30,
    });
    expect(result).toEqual({
      success: true,
      data: { sessionId: SESSION_ID, status: 'pending', holdId: 'hold-1' },
    });
  });

  it('forwards a valid companyId to the api (BAL-401)', async () => {
    mockCall.mockResolvedValue({
      ok: true,
      status: 201,
      data: { sessionId: SESSION_ID, status: 'pending', holdId: 'hold-1' },
    });

    const result = await openSessionAction({
      expertProfileId: EXPERT_ID,
      estimatedMinutes: 30,
      companyId: COMPANY_ID,
    });

    expect(mockCall).toHaveBeenCalledWith('/sessions', 'POST', {
      expertProfileId: EXPERT_ID,
      estimatedMinutes: 30,
      companyId: COMPANY_ID,
    });
    expect(result.success).toBe(true);
  });

  it('surfaces the eligible companies + warm copy on company_selection_required (BAL-401)', async () => {
    const companies = [
      { id: COMPANY_ID, name: 'Acme', logoUrl: null },
      { id: EXPERT_ID, name: 'Globex', logoUrl: 'https://logo/globex.png' },
    ];
    mockCall.mockResolvedValue({
      ok: false,
      status: 409,
      code: 'company_selection_required',
      companies,
      error: 'x',
    });

    const result = await openSessionAction({ expertProfileId: EXPERT_ID, estimatedMinutes: 30 });

    expect(result).toEqual({
      success: false,
      code: 'company_selection_required',
      companies,
      error: 'Choose which team this consultation is for.',
    });
  });

  it('rejects a non-uuid companyId WITHOUT calling the api (BAL-401)', async () => {
    const result = await openSessionAction({
      expertProfileId: EXPERT_ID,
      estimatedMinutes: 30,
      companyId: 'not-a-uuid',
    });
    expect(mockCall).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
  });

  it('maps an insufficient-funds gate to warm copy (never "overdraft")', async () => {
    mockCall.mockResolvedValue({
      ok: false,
      status: 409,
      code: 'insufficient_no_mandate',
      error: 'x',
    });

    const result = await openSessionAction({ expertProfileId: EXPERT_ID, estimatedMinutes: 30 });

    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected failure');
    expect(result.error).toBe('Top up to start this consultation.');
    expect(result.code).toBe('insufficient_no_mandate');
    expect(result.error.toLowerCase()).not.toContain('overdraft');
  });

  it('maps the account-hold gate to non-adversarial copy', async () => {
    mockCall.mockResolvedValue({ ok: false, status: 409, code: 'account_hold', error: 'x' });
    const result = await openSessionAction({ expertProfileId: EXPERT_ID, estimatedMinutes: 30 });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected failure');
    expect(result.error.toLowerCase()).not.toContain('overdraft');
    expect(result.error).toMatch(/unsettled balance/i);
  });

  it('maps the settlement-pending gate to warm, non-"overdraft" retry copy', async () => {
    mockCall.mockResolvedValue({ ok: false, status: 409, code: 'settlement_pending', error: 'x' });
    const result = await openSessionAction({ expertProfileId: EXPERT_ID, estimatedMinutes: 30 });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected failure');
    expect(result.code).toBe('settlement_pending');
    expect(result.error.toLowerCase()).not.toContain('overdraft');
    expect(result.error).toMatch(/finalizing your last session/i);
  });

  it('rejects an invalid expert id WITHOUT calling the api', async () => {
    const result = await openSessionAction({ expertProfileId: 'not-a-uuid', estimatedMinutes: 30 });
    expect(mockCall).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
  });

  it('rejects an out-of-range estimate WITHOUT calling the api', async () => {
    const result = await openSessionAction({
      expertProfileId: EXPERT_ID,
      estimatedMinutes: 100000,
    });
    expect(mockCall).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
  });
});

describe('connectSessionAction', () => {
  it('connects and returns the drawdown state', async () => {
    const drawdown = { key: 'healthy', lens: 'client' };
    mockCall.mockResolvedValue({ ok: true, status: 200, data: drawdown });

    const result = await connectSessionAction(SESSION_ID);

    expect(mockCall).toHaveBeenCalledWith(`/sessions/${SESSION_ID}/connect`, 'POST', {});
    expect(result).toEqual({ success: true, data: drawdown });
  });

  it('rejects a malformed session id without calling the api', async () => {
    const result = await connectSessionAction('nope');
    expect(mockCall).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
  });
});

describe('endSessionAction', () => {
  it('ends and returns the settlement summary', async () => {
    mockCall.mockResolvedValue({
      ok: true,
      status: 200,
      data: { settlementStatus: 'not_required', overdraftSettledMinor: 0 },
    });

    const result = await endSessionAction(SESSION_ID);

    expect(mockCall).toHaveBeenCalledWith(`/sessions/${SESSION_ID}/end`, 'POST', {});
    expect(result.success).toBe(true);
  });

  it('returns a friendly error when the api rejects', async () => {
    mockCall.mockResolvedValue({ ok: false, status: 409, error: 'x' });
    const result = await endSessionAction(SESSION_ID);
    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected failure');
    expect(result.error.toLowerCase()).not.toContain('overdraft');
  });
});

describe('nudgeAdminAction', () => {
  it('nudges and returns ok', async () => {
    mockCall.mockResolvedValue({ ok: true, status: 202, data: { ok: true } });

    const result = await nudgeAdminAction(SESSION_ID);

    expect(mockCall).toHaveBeenCalledWith(`/sessions/${SESSION_ID}/nudge`, 'POST', {});
    expect(result).toEqual({ success: true, data: { ok: true } });
  });

  it('returns a friendly error on failure', async () => {
    mockCall.mockResolvedValue({ ok: false, status: 500, error: 'x' });
    const result = await nudgeAdminAction(SESSION_ID);
    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected failure');
    expect(result.error).toMatch(/try again/i);
  });

  it('rejects a malformed session id without calling the api', async () => {
    const result = await nudgeAdminAction('nope');
    expect(mockCall).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
  });
});
