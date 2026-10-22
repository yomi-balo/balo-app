import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PlatformCapability } from '@balo/shared/authz';

const REQUEST_ID = 'a0000000-0000-4000-8000-000000000001';
const REL_ID = 'b0000000-0000-4000-8000-000000000002';
const PROPOSAL_ID = 'c0000000-0000-4000-8000-000000000003';

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const mockGetCurrentUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({
  getCurrentUser: () => mockGetCurrentUser(),
}));

const mockActorHoldsLive = vi.fn<
  (userId: string, capability: PlatformCapability) => Promise<boolean>
>(async () => true);
vi.mock('@/lib/authz/live-platform-capability', () => ({
  actorHoldsPlatformCapability: (userId: string, capability: PlatformCapability) =>
    mockActorHoldsLive(userId, capability),
}));

const {
  mockFindByIdWithRelations,
  mockFindCurrentByRelationship,
  mockListInstallments,
  mockMarkRaised,
  InvalidKickoffStateError,
  UpfrontInvoiceBeforeBillingError,
} = vi.hoisted(() => {
  class InvalidKickoffStateError extends Error {}
  class UpfrontInvoiceBeforeBillingError extends Error {}
  return {
    mockFindByIdWithRelations: vi.fn(),
    mockFindCurrentByRelationship: vi.fn(),
    mockListInstallments: vi.fn(),
    mockMarkRaised: vi.fn(),
    InvalidKickoffStateError,
    UpfrontInvoiceBeforeBillingError,
  };
});

vi.mock('@balo/db', () => ({
  proposalsRepository: {
    findCurrentByRelationship: (...a: unknown[]) => mockFindCurrentByRelationship(...a),
  },
  proposalPaymentInstallmentsRepository: {
    listByProposal: (...a: unknown[]) => mockListInstallments(...a),
  },
  projectRequestsRepository: {
    findByIdWithRelations: (...a: unknown[]) => mockFindByIdWithRelations(...a),
    markUpfrontInvoiceRaised: (...a: unknown[]) => mockMarkRaised(...a),
  },
  InvalidKickoffStateError,
  UpfrontInvoiceBeforeBillingError,
}));

import { markUpfrontInvoiceRaisedAction } from './mark-upfront-invoice-raised';
import { revalidatePath } from 'next/cache';
import { log } from '@/lib/logging';

const ADMIN = { id: 'user-admin', platformRole: 'admin' as const };
const PERMISSION_DENIED = 'You do not have permission to do this.';
const STALE = 'This request is no longer awaiting kickoff.';
const BILLING_FIRST = 'The client needs to add billing details before the invoice is raised.';
const NOTHING_DUE = 'Nothing is due upfront on this deal — approve kickoff instead.';

const VALID_INPUT = { requestId: REQUEST_ID, relationshipId: REL_ID };

const PROPOSAL = {
  id: PROPOSAL_ID,
  status: 'accepted',
  isCurrent: true,
  pricingMethod: 'fixed',
  priceCents: 500000,
  currency: 'aud',
  depositCents: null,
  baloFeeBps: 2500,
};

function requestGraph(overrides: Record<string, unknown> = {}) {
  return {
    id: REQUEST_ID,
    status: 'accepted',
    clientBillingConfirmedAt: new Date('2026-06-01T00:00:00Z'),
    upfrontInvoiceRaisedAt: null,
    relationships: [{ id: REL_ID, status: 'accepted' }],
    ...overrides,
  };
}

describe('markUpfrontInvoiceRaisedAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCurrentUser.mockResolvedValue(ADMIN);
    mockActorHoldsLive.mockImplementation(async () => true);
    mockFindByIdWithRelations.mockResolvedValue(requestGraph());
    mockFindCurrentByRelationship.mockResolvedValue({ ...PROPOSAL });
    mockListInstallments.mockResolvedValue([{ pct: 30 }, { pct: 70 }]);
    mockMarkRaised.mockResolvedValue({ request: { id: REQUEST_ID }, changed: true });
  });

  it('denies a session-uncapable caller; nothing is read or written', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1', platformRole: 'user' });
    expect(await markUpfrontInvoiceRaisedAction(VALID_INPUT)).toEqual({
      success: false,
      error: PERMISSION_DENIED,
    });
    expect(mockFindByIdWithRelations).not.toHaveBeenCalled();
    expect(mockMarkRaised).not.toHaveBeenCalled();
  });

  it('denies when the LIVE row has revoked the capability', async () => {
    mockActorHoldsLive.mockImplementation(async () => false);
    expect(await markUpfrontInvoiceRaisedAction(VALID_INPUT)).toEqual({
      success: false,
      error: PERMISSION_DENIED,
    });
    expect(mockMarkRaised).not.toHaveBeenCalled();
  });

  it('rejects invalid input', async () => {
    expect(await markUpfrontInvoiceRaisedAction({ ...VALID_INPUT, requestId: 'nope' })).toEqual({
      success: false,
      error: 'Invalid request.',
    });
    expect(mockFindByIdWithRelations).not.toHaveBeenCalled();
  });

  it('rejects a request that is no longer accepted', async () => {
    mockFindByIdWithRelations.mockResolvedValue(requestGraph({ status: 'kickoff_approved' }));
    expect(await markUpfrontInvoiceRaisedAction(VALID_INPUT)).toEqual({
      success: false,
      error: STALE,
    });
    expect(mockMarkRaised).not.toHaveBeenCalled();
  });

  it('rejects when the claimed relationship is not the accepted one', async () => {
    mockFindByIdWithRelations.mockResolvedValue(
      requestGraph({ relationships: [{ id: 'other-rel', status: 'accepted' }] })
    );
    expect(await markUpfrontInvoiceRaisedAction(VALID_INPUT)).toEqual({
      success: false,
      error: STALE,
    });
    expect(mockMarkRaised).not.toHaveBeenCalled();
  });

  it('rejects before the client has added billing details', async () => {
    mockFindByIdWithRelations.mockResolvedValue(requestGraph({ clientBillingConfirmedAt: null }));
    expect(await markUpfrontInvoiceRaisedAction(VALID_INPUT)).toEqual({
      success: false,
      error: BILLING_FIRST,
    });
    expect(mockMarkRaised).not.toHaveBeenCalled();
  });

  it('rejects when the deal has nothing due upfront', async () => {
    mockListInstallments.mockResolvedValue([{ pct: 0 }, { pct: 100 }]);
    expect(await markUpfrontInvoiceRaisedAction(VALID_INPUT)).toEqual({
      success: false,
      error: NOTHING_DUE,
    });
    expect(mockMarkRaised).not.toHaveBeenCalled();
  });

  it('rejects a stale (non-accepted) current proposal', async () => {
    mockFindCurrentByRelationship.mockResolvedValue({ ...PROPOSAL, status: 'submitted' });
    expect(await markUpfrontInvoiceRaisedAction(VALID_INPUT)).toEqual({
      success: false,
      error: STALE,
    });
    expect(mockMarkRaised).not.toHaveBeenCalled();
  });

  it('records who raised it and for how much, logs the business event, and revalidates', async () => {
    expect(await markUpfrontInvoiceRaisedAction(VALID_INPUT)).toEqual({
      success: true,
      changed: true,
    });
    // The client's fee-inclusive figure: 30% of 500,000 grossed up by 25%.
    expect(mockMarkRaised).toHaveBeenCalledWith({
      id: REQUEST_ID,
      actorUserId: ADMIN.id,
      amountCents: 187500,
      currency: 'aud',
    });
    expect(log.info).toHaveBeenCalledWith(
      'Upfront invoice marked raised',
      // The client's fee-inclusive figure: 30% of 500,000 grossed up by 25%.
      expect.objectContaining({ requestId: REQUEST_ID, amountCents: 187500, currency: 'aud' })
    );
    expect(revalidatePath).toHaveBeenCalledWith(`/projects/${REQUEST_ID}`);
  });

  it('passes an idempotent repeat through as changed: false', async () => {
    mockMarkRaised.mockResolvedValue({ request: { id: REQUEST_ID }, changed: false });
    expect(await markUpfrontInvoiceRaisedAction(VALID_INPUT)).toEqual({
      success: true,
      changed: false,
    });
  });

  it('maps InvalidKickoffStateError (status moved on) to stale copy', async () => {
    mockMarkRaised.mockRejectedValue(new InvalidKickoffStateError('kickoff_approved'));
    expect(await markUpfrontInvoiceRaisedAction(VALID_INPUT)).toEqual({
      success: false,
      error: STALE,
    });
  });

  it('maps UpfrontInvoiceBeforeBillingError to the billing-first copy', async () => {
    mockMarkRaised.mockRejectedValue(new UpfrontInvoiceBeforeBillingError());
    expect(await markUpfrontInvoiceRaisedAction(VALID_INPUT)).toEqual({
      success: false,
      error: BILLING_FIRST,
    });
  });

  it('maps an unexpected failure to the generic error and logs it', async () => {
    mockMarkRaised.mockRejectedValue(new Error('db down'));
    expect(await markUpfrontInvoiceRaisedAction(VALID_INPUT)).toEqual({
      success: false,
      error: 'Could not record the invoice. Please try again.',
    });
    expect(log.error).toHaveBeenCalledWith(
      'Failed to mark upfront invoice raised',
      expect.objectContaining({ requestId: REQUEST_ID, error: 'db down' })
    );
  });
});
