import { describe, it, expect, vi, beforeEach } from 'vitest';

const REQUEST_ID = 'a0000000-0000-4000-8000-000000000001';
const RELATIONSHIP_ID = 'b0000000-0000-4000-8000-000000000002';
const OTHER_RELATIONSHIP_ID = 'b0000000-0000-4000-8000-000000000003';
const COMPANY_ID = 'c0000000-0000-4000-8000-000000000004';
const OWNER_ID = 'd0000000-0000-4000-8000-000000000005';
const CREATOR_ID = 'e0000000-0000-4000-8000-000000000006';

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const mockFindByIdWithRelations = vi.fn();
const mockFindOwnerByCompanyId = vi.fn();
const mockFindWithMembers = vi.fn();
const mockFindCurrentByRelationship = vi.fn();
vi.mock('@balo/db', () => ({
  projectRequestsRepository: {
    findByIdWithRelations: (...args: unknown[]) => mockFindByIdWithRelations(...args),
  },
  companiesRepository: {
    findOwnerByCompanyId: (...args: unknown[]) => mockFindOwnerByCompanyId(...args),
    findWithMembers: (...args: unknown[]) => mockFindWithMembers(...args),
  },
  proposalsRepository: {
    findCurrentByRelationship: (...args: unknown[]) => mockFindCurrentByRelationship(...args),
  },
}));

const mockRequireAdmin = vi.fn();
vi.mock('@/lib/auth/require-admin', () => ({
  requireAdmin: () => mockRequireAdmin(),
}));

const mockPublish = vi.fn().mockResolvedValue(undefined);
vi.mock('@/lib/notifications/publish', () => ({
  publishNotificationEvent: (...args: unknown[]) => mockPublish(...args),
}));

import { remindClientBilling } from './remind-client-billing';
import { revalidatePath } from 'next/cache';
import { log } from '@/lib/logging';

const ADMIN = { id: 'admin-1', platformRole: 'admin' };
const VALID_INPUT = { requestId: REQUEST_ID, relationshipId: RELATIONSHIP_ID };

interface RequestOptions {
  status?: string;
  createdByUserId?: string;
}

function buildRequest(opts: RequestOptions = {}): Record<string, unknown> {
  const { status = 'accepted', createdByUserId = CREATOR_ID } = opts;
  return {
    id: REQUEST_ID,
    status,
    companyId: COMPANY_ID,
    title: 'CPQ rollout',
    createdByUserId,
    company: { id: COMPANY_ID, name: 'Acme Pty Ltd' },
    relationships: [{ id: RELATIONSHIP_ID }],
  };
}

/** Members list including both owner + creator (creator IS a member). */
function membersWithCreator(): Record<string, unknown> {
  return { members: [{ userId: OWNER_ID }, { userId: CREATOR_ID }] };
}

describe('remindClientBilling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireAdmin.mockResolvedValue(ADMIN);
    mockFindByIdWithRelations.mockResolvedValue(buildRequest());
    mockFindOwnerByCompanyId.mockResolvedValue({ id: OWNER_ID });
    mockFindWithMembers.mockResolvedValue(membersWithCreator());
    mockFindCurrentByRelationship.mockResolvedValue({
      acceptedAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
      updatedAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000),
    });
    mockPublish.mockResolvedValue(undefined);
  });

  it('rejects a non-admin before touching the graph', async () => {
    mockRequireAdmin.mockRejectedValue(new Error('Forbidden'));
    const result = await remindClientBilling(VALID_INPUT);
    expect(result).toEqual({ success: false, error: 'You do not have permission to do this.' });
    expect(mockFindByIdWithRelations).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('rejects invalid ids before loading the request', async () => {
    const result = await remindClientBilling({ requestId: 'nope', relationshipId: 'also-nope' });
    expect(result).toEqual({ success: false, error: 'Invalid request.' });
    expect(mockFindByIdWithRelations).not.toHaveBeenCalled();
  });

  it('rejects when the request is gone', async () => {
    mockFindByIdWithRelations.mockResolvedValue(undefined);
    const result = await remindClientBilling(VALID_INPUT);
    expect(result).toEqual({
      success: false,
      error: 'This request can no longer take a billing reminder.',
    });
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('rejects when the relationship is not on the request (IDOR-safe)', async () => {
    const result = await remindClientBilling({
      requestId: REQUEST_ID,
      relationshipId: OTHER_RELATIONSHIP_ID,
    });
    expect(result).toEqual({ success: false, error: 'This expert is not on this request.' });
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('rejects when the request is not at accepted (stale)', async () => {
    mockFindByIdWithRelations.mockResolvedValue(buildRequest({ status: 'kickoff_approved' }));
    const result = await remindClientBilling(VALID_INPUT);
    expect(result).toEqual({
      success: false,
      error: 'This request is no longer awaiting kickoff.',
    });
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('notifies owner + creator (recipientCount 2) when creator ≠ owner AND a member', async () => {
    const result = await remindClientBilling(VALID_INPUT);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.recipientCount).toBe(2);
      expect(result.companyId).toBe(COMPANY_ID);
      expect(result.adminUserId).toBe('admin-1');
    }
    expect(mockPublish).toHaveBeenCalledTimes(1);
    expect(mockPublish).toHaveBeenCalledWith(
      'project.billing_reminder',
      expect.objectContaining({
        projectRequestId: REQUEST_ID,
        title: 'CPQ rollout',
        companyName: 'Acme Pty Ltd',
        recipientId: OWNER_ID,
        creatorUserId: CREATOR_ID,
      })
    );
  });

  it('notifies owner only (recipientCount 1) when creator === owner', async () => {
    mockFindByIdWithRelations.mockResolvedValue(buildRequest({ createdByUserId: OWNER_ID }));
    const result = await remindClientBilling(VALID_INPUT);
    expect(result.success).toBe(true);
    if (result.success) expect(result.recipientCount).toBe(1);
    const payload = mockPublish.mock.calls[0]?.[1] as { creatorUserId?: string };
    expect(payload.creatorUserId).toBeUndefined();
    // creator === owner short-circuits the membership check.
    expect(mockFindWithMembers).not.toHaveBeenCalled();
  });

  it('notifies owner only (recipientCount 1) when the creator is NOT a company member', async () => {
    mockFindWithMembers.mockResolvedValue({ members: [{ userId: OWNER_ID }] });
    const result = await remindClientBilling(VALID_INPUT);
    expect(result.success).toBe(true);
    if (result.success) expect(result.recipientCount).toBe(1);
    const payload = mockPublish.mock.calls[0]?.[1] as { creatorUserId?: string };
    expect(payload.creatorUserId).toBeUndefined();
  });

  it('publishes exactly ONE event with the project.billing_reminder name', async () => {
    await remindClientBilling(VALID_INPUT);
    expect(mockPublish).toHaveBeenCalledTimes(1);
    expect(mockPublish.mock.calls[0]?.[0]).toBe('project.billing_reminder');
  });

  it('mints a DIFFERENT correlationId per invocation (a re-remind is a fresh dispatch)', async () => {
    await remindClientBilling(VALID_INPUT);
    await remindClientBilling(VALID_INPUT);
    const first = mockPublish.mock.calls[0]?.[1] as { correlationId: string };
    const second = mockPublish.mock.calls[1]?.[1] as { correlationId: string };
    expect(first.correlationId).toEqual(expect.any(String));
    expect(second.correlationId).toEqual(expect.any(String));
    expect(first.correlationId).not.toBe(second.correlationId);
  });

  it('returns daysSinceAcceptance from the accepted proposal (precise acceptedAt)', async () => {
    const result = await remindClientBilling(VALID_INPUT);
    expect(result.success).toBe(true);
    if (result.success) expect(result.daysSinceAcceptance).toBe(3);
  });

  it('falls back to proposal.updatedAt for daysSinceAcceptance when acceptedAt is null', async () => {
    mockFindCurrentByRelationship.mockResolvedValue({
      acceptedAt: null,
      updatedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
    });
    const result = await remindClientBilling(VALID_INPUT);
    expect(result.success).toBe(true);
    if (result.success) expect(result.daysSinceAcceptance).toBe(2);
  });

  it('returns null daysSinceAcceptance when no current proposal resolves', async () => {
    mockFindCurrentByRelationship.mockResolvedValue(undefined);
    const result = await remindClientBilling(VALID_INPUT);
    expect(result.success).toBe(true);
    if (result.success) expect(result.daysSinceAcceptance).toBeNull();
  });

  it('maps a findOwnerByCompanyId throw to the generic failure and logs it', async () => {
    mockFindOwnerByCompanyId.mockRejectedValue(new Error('No owner found'));
    const result = await remindClientBilling(VALID_INPUT);
    expect(result).toEqual({
      success: false,
      error: 'Could not send the reminder. Please try again.',
    });
    expect(mockPublish).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith(
      'Failed to resolve company owner for billing reminder',
      expect.objectContaining({ error: 'No owner found', companyId: COMPANY_ID })
    );
  });

  it('a rejected notification publish never fails the send', async () => {
    mockPublish.mockRejectedValue(new Error('queue down'));
    const result = await remindClientBilling(VALID_INPUT);
    expect(result.success).toBe(true);
  });

  it('revalidates the request path on success', async () => {
    await remindClientBilling(VALID_INPUT);
    expect(revalidatePath).toHaveBeenCalledWith(`/projects/${REQUEST_ID}`);
  });

  it('logs the reminder with the admin id + recipient count', async () => {
    await remindClientBilling(VALID_INPUT);
    expect(log.info).toHaveBeenCalledWith(
      'Billing reminder sent',
      expect.objectContaining({ requestId: REQUEST_ID, adminUserId: 'admin-1', recipientCount: 2 })
    );
  });

  it('maps unexpected failures to the generic copy and logs the original error', async () => {
    mockFindByIdWithRelations.mockRejectedValue(new Error('DB down'));
    const result = await remindClientBilling(VALID_INPUT);
    expect(result).toEqual({
      success: false,
      error: 'Could not send the reminder. Please try again.',
    });
    expect(log.error).toHaveBeenCalledWith(
      'Failed to remind client billing',
      expect.objectContaining({ error: 'DB down', adminUserId: 'admin-1' })
    );
  });
});
