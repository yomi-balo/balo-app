import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ProjectRequestWithRelations } from '@balo/db';

vi.mock('server-only', () => ({}));

const mockEnsure = vi.fn();
const mockFindByIdWithRelations = vi.fn();
vi.mock('@balo/db', () => ({
  ensureClientBillingGateConfirmed: (...args: unknown[]) => mockEnsure(...args),
  projectRequestsRepository: {
    findByIdWithRelations: (...args: unknown[]) => mockFindByIdWithRelations(...args),
  },
}));

import { ensureAdminBillingAutoskip } from './ensure-admin-billing-autoskip';
import { log } from '@/lib/logging';

const REQUEST_ID = 'a0000000-0000-4000-8000-000000000001';

function buildRequest(overrides: Record<string, unknown> = {}): ProjectRequestWithRelations {
  return {
    id: REQUEST_ID,
    status: 'accepted',
    clientBillingConfirmedAt: null,
    ...overrides,
  } as unknown as ProjectRequestWithRelations;
}

describe('ensureAdminBillingAutoskip', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnsure.mockResolvedValue(undefined);
  });

  it('confirms the gate + returns the FRESH re-read when admin + accepted + gate open', async () => {
    const original = buildRequest();
    const fresh = buildRequest({ clientBillingConfirmedAt: new Date() });
    mockFindByIdWithRelations.mockResolvedValue(fresh);

    const result = await ensureAdminBillingAutoskip(original, true);

    expect(mockEnsure).toHaveBeenCalledWith(REQUEST_ID);
    expect(mockFindByIdWithRelations).toHaveBeenCalledWith(REQUEST_ID);
    expect(result).toBe(fresh);
  });

  it('is a no-op for a non-admin (no ensure, no re-read) — returns the original', async () => {
    const original = buildRequest();
    const result = await ensureAdminBillingAutoskip(original, false);

    expect(mockEnsure).not.toHaveBeenCalled();
    expect(mockFindByIdWithRelations).not.toHaveBeenCalled();
    expect(result).toBe(original);
  });

  it('is a no-op when the request is not accepted', async () => {
    const original = buildRequest({ status: 'kickoff_approved' });
    const result = await ensureAdminBillingAutoskip(original, true);

    expect(mockEnsure).not.toHaveBeenCalled();
    expect(mockFindByIdWithRelations).not.toHaveBeenCalled();
    expect(result).toBe(original);
  });

  it('is a no-op when the billing gate is already confirmed', async () => {
    const original = buildRequest({ clientBillingConfirmedAt: new Date() });
    const result = await ensureAdminBillingAutoskip(original, true);

    expect(mockEnsure).not.toHaveBeenCalled();
    expect(mockFindByIdWithRelations).not.toHaveBeenCalled();
    expect(result).toBe(original);
  });

  it('swallows a thrown ensure: returns the original request and logs a warning', async () => {
    const original = buildRequest();
    mockEnsure.mockRejectedValue(new Error('locked'));

    const result = await ensureAdminBillingAutoskip(original, true);

    expect(result).toBe(original);
    expect(mockFindByIdWithRelations).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      'Auto-skip client billing gate failed',
      expect.objectContaining({ requestId: REQUEST_ID, error: 'locked' })
    );
  });

  it('falls back to the original request when the re-read returns undefined', async () => {
    const original = buildRequest();
    mockFindByIdWithRelations.mockResolvedValue(undefined);

    const result = await ensureAdminBillingAutoskip(original, true);

    expect(mockEnsure).toHaveBeenCalledWith(REQUEST_ID);
    expect(result).toBe(original);
  });
});
