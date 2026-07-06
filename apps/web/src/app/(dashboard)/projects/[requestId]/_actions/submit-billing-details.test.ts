import { describe, it, expect, vi, beforeEach } from 'vitest';

const REQUEST_ID = 'a0000000-0000-4000-8000-000000000001';
const REL_ID = 'b0000000-0000-4000-8000-000000000002';
const COMPANY_ID = 'c0000000-0000-4000-8000-000000000003';

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const mockRequireUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({
  requireUser: () => mockRequireUser(),
}));

const mockResolveAccess = vi.fn();
vi.mock('@/lib/project-request/resolve-conversation-access', () => ({
  resolveConversationAccess: (...args: unknown[]) => mockResolveAccess(...args),
}));

const {
  mockUpsert,
  mockFindByCompanyId,
  mockEnsureGate,
  mockFindCurrentByRel,
  InvalidKickoffStateError,
} = vi.hoisted(() => {
  class InvalidKickoffStateError extends Error {}
  return {
    mockUpsert: vi.fn(),
    mockFindByCompanyId: vi.fn(),
    mockEnsureGate: vi.fn(),
    mockFindCurrentByRel: vi.fn(),
    InvalidKickoffStateError,
  };
});

vi.mock('@balo/db', () => ({
  companyBillingRepository: {
    upsertByCompanyId: (...a: unknown[]) => mockUpsert(...a),
    findByCompanyId: (...a: unknown[]) => mockFindByCompanyId(...a),
  },
  ensureClientBillingGateConfirmed: (...a: unknown[]) => mockEnsureGate(...a),
  proposalsRepository: {
    findCurrentByRelationship: (...a: unknown[]) => mockFindCurrentByRel(...a),
  },
  InvalidKickoffStateError,
}));

const mockTrack = vi.fn();
vi.mock('@/lib/analytics/server', () => ({
  trackServerAndFlush: (...a: unknown[]) => mockTrack(...a),
  BILLING_SERVER_EVENTS: { DETAILS_SUBMITTED: 'billing_details_submitted' },
}));

const mockPublish = vi.fn();
vi.mock('@/lib/notifications/publish', () => ({
  publishNotificationEvent: (...a: unknown[]) => mockPublish(...a),
}));

import { submitBillingDetailsAction } from './submit-billing-details';
import { revalidatePath } from 'next/cache';
import { log } from '@/lib/logging';

const USER = {
  id: 'user-1',
  companyId: COMPANY_ID,
  companyName: 'Acme',
  companyRole: 'owner',
};

const VALID_INPUT = {
  requestId: REQUEST_ID,
  relationshipId: REL_ID,
  legalName: 'Acme Pty Ltd',
  countryCode: 'AU',
  taxId: '51 824 753 556',
  address: '1 George St, Sydney',
  billingEmail: 'ap@acme.example',
};

function accessOk(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    ctx: { lens: 'client' },
    relationship: { id: REL_ID, status: 'accepted' },
    request: { status: 'accepted', companyId: COMPANY_ID, title: 'CPQ implementation' },
    recipient: { role: 'expert', expertProfileId: 'e0000000-0000-4000-8000-000000000009' },
    ...overrides,
  };
}

describe('submitBillingDetailsAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireUser.mockResolvedValue(USER);
    mockResolveAccess.mockResolvedValue(accessOk());
    mockFindByCompanyId.mockResolvedValue(undefined); // first-time by default
    mockUpsert.mockResolvedValue({ id: 'billing-1' });
    mockEnsureGate.mockResolvedValue(undefined);
    mockFindCurrentByRel.mockResolvedValue({ acceptedAt: new Date(Date.now() - 2 * 3_600_000) });
  });

  it('rejects when not signed in', async () => {
    mockRequireUser.mockRejectedValue(new Error('Unauthorized'));
    expect(await submitBillingDetailsAction(VALID_INPUT)).toEqual({
      success: false,
      error: 'You are not signed in.',
    });
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it('rejects invalid input (bad email)', async () => {
    expect(
      await submitBillingDetailsAction({ ...VALID_INPUT, billingEmail: 'not-an-email' })
    ).toEqual({ success: false, error: 'Invalid request.' });
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it('rejects invalid input (bad country code)', async () => {
    expect(await submitBillingDetailsAction({ ...VALID_INPUT, countryCode: 'AUS' })).toEqual({
      success: false,
      error: 'Invalid request.',
    });
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it('bubbles the access guard error', async () => {
    mockResolveAccess.mockResolvedValue({ ok: false, error: 'You do not have access.' });
    expect(await submitBillingDetailsAction(VALID_INPUT)).toEqual({
      success: false,
      error: 'You do not have access.',
    });
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it('rejects a non-client lens', async () => {
    mockResolveAccess.mockResolvedValue(accessOk({ ctx: { lens: 'expert' } }));
    expect(await submitBillingDetailsAction(VALID_INPUT)).toEqual({
      success: false,
      error: 'Only the client can add billing details.',
    });
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it('rejects a plain member (owner/admin only)', async () => {
    mockRequireUser.mockResolvedValue({ ...USER, companyRole: 'member' });
    expect(await submitBillingDetailsAction(VALID_INPUT)).toEqual({
      success: false,
      error: 'Only a company owner or admin can add billing details.',
    });
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it('allows a company admin (not just the owner)', async () => {
    mockRequireUser.mockResolvedValue({ ...USER, companyRole: 'admin' });
    expect(await submitBillingDetailsAction(VALID_INPUT)).toEqual({ success: true });
    expect(mockUpsert).toHaveBeenCalledTimes(1);
  });

  it('rejects a stale request status (not accepted)', async () => {
    mockResolveAccess.mockResolvedValue(
      accessOk({ request: { status: 'kickoff_approved', companyId: COMPANY_ID } })
    );
    expect(await submitBillingDetailsAction(VALID_INPUT)).toEqual({
      success: false,
      error: 'This kickoff is no longer open.',
    });
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it('rejects a stale relationship status (not accepted)', async () => {
    mockResolveAccess.mockResolvedValue(
      accessOk({ relationship: { id: REL_ID, status: 'proposal_submitted' } })
    );
    expect(await submitBillingDetailsAction(VALID_INPUT)).toEqual({
      success: false,
      error: 'This kickoff is no longer open.',
    });
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it('first-time: upserts, confirms the gate, tracks, notifies, revalidates, succeeds', async () => {
    const result = await submitBillingDetailsAction(VALID_INPUT);
    expect(result).toEqual({ success: true });

    expect(mockUpsert).toHaveBeenCalledWith({
      companyId: COMPANY_ID,
      legalName: 'Acme Pty Ltd',
      countryCode: 'AU',
      taxId: '51 824 753 556',
      address: '1 George St, Sydney',
      billingEmail: 'ap@acme.example',
      submittedByUserId: 'user-1',
    });
    expect(mockEnsureGate).toHaveBeenCalledWith(REQUEST_ID);
    expect(mockTrack).toHaveBeenCalledWith(
      'billing_details_submitted',
      expect.objectContaining({
        company_id: COMPANY_ID,
        request_id: REQUEST_ID,
        country_code: 'AU',
        is_first_time: true,
        hours_since_acceptance: expect.any(Number),
        distinct_id: 'user-1',
      })
    );
    expect(mockPublish).toHaveBeenCalledWith('billing.details_confirmed', {
      correlationId: COMPANY_ID,
      companyId: COMPANY_ID,
      companyName: 'Acme',
      projectRequestId: REQUEST_ID,
    });
    expect(revalidatePath).toHaveBeenCalledWith(`/projects/${REQUEST_ID}`);
  });

  it('edit (existing details): does NOT re-notify, and flags is_first_time false', async () => {
    mockFindByCompanyId.mockResolvedValue({ id: 'existing-billing' });
    const result = await submitBillingDetailsAction(VALID_INPUT);
    expect(result).toEqual({ success: true });
    expect(mockUpsert).toHaveBeenCalledTimes(1);
    expect(mockPublish).not.toHaveBeenCalled();
    expect(mockTrack).toHaveBeenCalledWith(
      'billing_details_submitted',
      expect.objectContaining({ is_first_time: false })
    );
  });

  it('normalises an empty optional address to null', async () => {
    await submitBillingDetailsAction({ ...VALID_INPUT, address: '' });
    expect(mockUpsert).toHaveBeenCalledWith(expect.objectContaining({ address: null }));
  });

  it('maps an InvalidKickoffStateError from the gate confirm to stale copy', async () => {
    mockEnsureGate.mockRejectedValue(new InvalidKickoffStateError());
    expect(await submitBillingDetailsAction(VALID_INPUT)).toEqual({
      success: false,
      error: 'This kickoff is no longer open.',
    });
  });

  it('maps an unexpected upsert failure to the generic error and logs it', async () => {
    mockUpsert.mockRejectedValue(new Error('db down'));
    expect(await submitBillingDetailsAction(VALID_INPUT)).toEqual({
      success: false,
      error: 'Could not save your billing details. Please try again.',
    });
    expect(log.error).toHaveBeenCalledWith('Failed to submit billing details', expect.any(Object));
  });
});
