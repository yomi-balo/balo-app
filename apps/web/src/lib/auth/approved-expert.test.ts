import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

const { mockFindApprovalById } = vi.hoisted(() => ({ mockFindApprovalById: vi.fn() }));
vi.mock('@balo/db', () => ({
  expertsRepository: { findApprovalById: mockFindApprovalById },
}));

import { log } from '@/lib/logging';
import { codeLinesOf } from '@/invariants/_source-scan';
import {
  APPROVED_PROFILE_ROW,
  DRAFT_PROFILE_ROW,
} from '@/test/fixtures/approved-expert-gate-cases';
import { APPROVED_EXPERT_REQUIRED_ERROR, resolveApprovedExpert } from './approved-expert';

const USER = { id: 'user-1', expertProfileId: 'profile-1' };

describe('resolveApprovedExpert', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([undefined, ''])('refuses no_profile for %j without a read', async (id) => {
    const result = await resolveApprovedExpert({ id: 'user-1', expertProfileId: id });
    expect(result).toEqual({ ok: false, reason: 'no_profile' });
    expect(mockFindApprovalById).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('refuses not_found when the profile row is missing', async () => {
    mockFindApprovalById.mockResolvedValue(undefined);
    expect(await resolveApprovedExpert(USER)).toEqual({ ok: false, reason: 'not_found' });
    expect(log.warn).toHaveBeenCalledWith('Approved-expert guard refused', {
      userId: 'user-1',
      expertProfileId: 'profile-1',
      reason: 'not_found',
    });
  });

  it('refuses not_owner when the profile belongs to another user', async () => {
    mockFindApprovalById.mockResolvedValue({ ...APPROVED_PROFILE_ROW, userId: 'someone-else' });
    expect(await resolveApprovedExpert(USER)).toEqual({ ok: false, reason: 'not_owner' });
    expect(log.warn).toHaveBeenCalledWith(
      'Approved-expert guard refused',
      expect.objectContaining({ reason: 'not_owner' })
    );
  });

  it('refuses not_approved when approvedAt is null and logs the reason', async () => {
    mockFindApprovalById.mockResolvedValue(DRAFT_PROFILE_ROW);
    expect(await resolveApprovedExpert(USER)).toEqual({ ok: false, reason: 'not_approved' });
    expect(log.warn).toHaveBeenCalledWith(
      'Approved-expert guard refused',
      expect.objectContaining({ reason: 'not_approved' })
    );
  });

  it('fails closed when the row carries no approvedAt key at all', async () => {
    mockFindApprovalById.mockResolvedValue({ userId: 'user-1' } as unknown);
    expect(await resolveApprovedExpert(USER)).toEqual({ ok: false, reason: 'not_approved' });
  });

  it('resolves ok with the session profile id for an approved owner', async () => {
    mockFindApprovalById.mockResolvedValue(APPROVED_PROFILE_ROW);
    expect(await resolveApprovedExpert(USER)).toEqual({ ok: true, expertProfileId: 'profile-1' });
    expect(mockFindApprovalById).toHaveBeenCalledWith('profile-1');
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('propagates a failed profile read', async () => {
    mockFindApprovalById.mockRejectedValue(new Error('db down'));
    await expect(resolveApprovedExpert(USER)).rejects.toThrow('db down');
  });

  it('exports the shared refusal copy', () => {
    expect(APPROVED_EXPERT_REQUIRED_ERROR).toBe('Expert profile required');
  });

  it('never reads activeMode in its code lines', () => {
    const source = readFileSync(path.join(__dirname, 'approved-expert.ts'), 'utf8');
    expect(codeLinesOf(source)).not.toContain('activeMode');
  });
});
