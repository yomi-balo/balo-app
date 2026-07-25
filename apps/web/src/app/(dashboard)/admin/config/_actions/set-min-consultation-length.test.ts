import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const mockGetCurrentUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({
  getCurrentUser: () => mockGetCurrentUser(),
}));

// The repo is a mock; the authz seam is REAL (pure `@balo/shared/authz` map) so the new
// MANAGE_PLATFORM_CONFIG capability gate is exercised end-to-end.
const mockSetMin = vi.fn();
vi.mock('@balo/db', () => ({
  platformConfigRepository: { setMinConsultationMinutes: (...a: unknown[]) => mockSetMin(...a) },
}));

const mockTrack = vi.fn();
vi.mock('@/lib/analytics/server', () => ({
  trackServerAndFlush: (...a: unknown[]) => mockTrack(...a),
  ADMIN_CONFIG_SERVER_EVENTS: {
    MIN_CONSULTATION_LENGTH_SET: 'admin_min_consultation_length_set',
  },
}));

import { setMinConsultationLength } from './set-min-consultation-length';
import { revalidatePath } from 'next/cache';
import { log } from '@/lib/logging';

const ADMIN = { id: 'admin-1', platformRole: 'admin' };
const PERMISSION_DENIED = 'You do not have permission to do this.';

beforeEach(() => {
  vi.clearAllMocks();
  mockGetCurrentUser.mockResolvedValue(ADMIN);
  mockSetMin.mockResolvedValue({ id: 1, minConsultationMinutes: 30, updatedBy: 'admin-1' });
});

describe('setMinConsultationLength', () => {
  it('denies an unauthenticated caller before touching the repo (no existence leak)', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    const result = await setMinConsultationLength({ minutes: 30 });
    expect(result).toEqual({ success: false, error: PERMISSION_DENIED });
    expect(mockSetMin).not.toHaveBeenCalled();
  });

  it('denies a viewer without MANAGE_PLATFORM_CONFIG (plain user)', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u-2', platformRole: 'user' });
    const result = await setMinConsultationLength({ minutes: 30 });
    expect(result).toEqual({ success: false, error: PERMISSION_DENIED });
    expect(mockSetMin).not.toHaveBeenCalled();
  });

  it('rejects a value below the billing floor before hitting the repo', async () => {
    const result = await setMinConsultationLength({ minutes: 14 });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('15 minutes or more');
    }
    expect(mockSetMin).not.toHaveBeenCalled();
  });

  it('sets the minimum, emits analytics + log.info, and revalidates', async () => {
    const result = await setMinConsultationLength({ minutes: 30 });

    expect(mockSetMin).toHaveBeenCalledWith(30, 'admin-1');
    expect(mockTrack).toHaveBeenCalledWith('admin_min_consultation_length_set', {
      minutes: 30,
      distinct_id: 'admin-1',
    });
    expect(log.info).toHaveBeenCalledWith(
      'Admin set min consultation length',
      expect.objectContaining({ minutes: 30, actorUserId: 'admin-1' })
    );
    expect(revalidatePath).toHaveBeenCalledWith('/admin/config');
    expect(result).toEqual({ success: true, minutes: 30 });
  });

  it('allows a super_admin', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'sa-1', platformRole: 'super_admin' });
    const result = await setMinConsultationLength({ minutes: 45 });
    expect(result.success).toBe(true);
    expect(mockSetMin).toHaveBeenCalledWith(45, 'sa-1');
  });

  it('maps an unexpected repo throw to the generic error and logs it', async () => {
    mockSetMin.mockRejectedValue(new Error('DB down'));
    const result = await setMinConsultationLength({ minutes: 30 });
    expect(result).toEqual({
      success: false,
      error: 'Could not save the setting. Please try again.',
    });
    expect(log.error).toHaveBeenCalledWith(
      'Failed to set min consultation length',
      expect.objectContaining({ error: 'DB down', actorUserId: 'admin-1' })
    );
    expect(mockTrack).not.toHaveBeenCalled();
  });
});
