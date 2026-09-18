import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const mockRequireStaffAccessManager = vi.fn();
vi.mock('./_shared/require-staff-access-manager', () => ({
  requireStaffAccessManager: () => mockRequireStaffAccessManager(),
}));

const { mockSaveStaffAccess } = vi.hoisted(() => ({ mockSaveStaffAccess: vi.fn() }));
vi.mock('@balo/db', () => ({
  usersRepository: { saveStaffAccess: (...a: unknown[]) => mockSaveStaffAccess(...a) },
}));

import { revalidatePath } from 'next/cache';
import { log } from '@/lib/logging';
import type { StaffAccessSaveRefusal } from '@balo/shared/authz';
import { STAFF_ACCESS_SAVE_MESSAGES } from '../_lib/staff-access-outcome';
import { saveStaffAccessAction } from './save-staff-access';

const ACTOR = { id: 'actor-1', firstName: 'MJ', platformRole: 'super_admin' as const };
const TARGET_ID = 'b0000000-0000-4000-8000-000000000009';
const STATE = { role: 'admin' as const, customList: null };

const VALID_INPUT = { targetUserId: TARGET_ID, expected: STATE, next: STATE };

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireStaffAccessManager.mockResolvedValue({ ok: true, user: ACTOR });
  mockSaveStaffAccess.mockResolvedValue({
    outcome: 'saved',
    roleChanged: true,
    customListChanged: false,
    auditEventIds: ['audit-1'],
  });
});

describe('saveStaffAccessAction', () => {
  it('denies before parsing and never calls the repository', async () => {
    mockRequireStaffAccessManager.mockResolvedValue({ ok: false, error: 'nope' });
    const result = await saveStaffAccessAction({
      // deliberately malformed — proves the gate runs before Zod ever sees it
      targetUserId: 'not-a-uuid',
    } as never);
    expect(result).toEqual({ success: false, code: 'denied', error: 'nope' });
    expect(mockSaveStaffAccess).not.toHaveBeenCalled();
  });

  it('returns invalid for a malformed payload and never calls the repository', async () => {
    const result = await saveStaffAccessAction({
      targetUserId: 'not-a-uuid',
      expected: STATE,
      next: STATE,
    } as never);
    expect(result).toEqual({
      success: false,
      code: 'invalid',
      error: STAFF_ACCESS_SAVE_MESSAGES.invalid,
    });
    expect(mockSaveStaffAccess).not.toHaveBeenCalled();
  });

  it('passes the actor id from the SESSION, never from the payload', async () => {
    await saveStaffAccessAction(VALID_INPUT);
    expect(mockSaveStaffAccess).toHaveBeenCalledWith(
      expect.objectContaining({ actorUserId: ACTOR.id, targetUserId: TARGET_ID })
    );
  });

  const NON_ACTOR_REFUSALS: readonly Exclude<StaffAccessSaveRefusal, 'actor_not_authorized'>[] = [
    'unknown_capability',
    'custom_list_requires_staff_role',
    'staff_management_requires_super_admin',
    'self_edit',
    'target_not_found',
    'stale',
    'no_change',
    'target_ineligible',
    'grant_exceeds_actor',
    'floor_violation',
  ];

  it.each(NON_ACTOR_REFUSALS)(
    'maps refusal reason %s straight through as the code',
    async (reason) => {
      mockSaveStaffAccess.mockResolvedValue({ outcome: 'refused', reason });
      const result = await saveStaffAccessAction(VALID_INPUT);
      expect(result).toEqual({
        success: false,
        code: reason,
        error: STAFF_ACCESS_SAVE_MESSAGES[reason],
      });
      expect(log.warn).toHaveBeenCalledWith(
        'Staff access save refused',
        expect.objectContaining({ reason })
      );
    }
  );

  it('maps actor_not_authorized to the generic "denied" code', async () => {
    mockSaveStaffAccess.mockResolvedValue({ outcome: 'refused', reason: 'actor_not_authorized' });
    const result = await saveStaffAccessAction(VALID_INPUT);
    expect(result).toEqual({
      success: false,
      code: 'denied',
      error: STAFF_ACCESS_SAVE_MESSAGES.denied,
    });
  });

  it('logs and revalidates on success, returning the repository-reported deltas', async () => {
    const result = await saveStaffAccessAction(VALID_INPUT);
    expect(result).toEqual({ success: true, roleChanged: true, customListChanged: false });
    expect(revalidatePath).toHaveBeenCalledWith('/admin/staff-access');
    expect(log.info).toHaveBeenCalledWith(
      'Staff access changed',
      expect.objectContaining({
        actorUserId: ACTOR.id,
        targetUserId: TARGET_ID,
        roleChanged: true,
        customListChanged: false,
        auditEventIds: ['audit-1'],
      })
    );
  });

  it('log.error fires and a generic failure is returned when the repository throws', async () => {
    mockSaveStaffAccess.mockRejectedValue(new Error('DB down'));
    const result = await saveStaffAccessAction(VALID_INPUT);
    expect(result).toEqual({
      success: false,
      code: 'failed',
      error: STAFF_ACCESS_SAVE_MESSAGES.failed,
    });
    expect(log.error).toHaveBeenCalledWith(
      'Staff access save failed',
      expect.objectContaining({ actorUserId: ACTOR.id, targetUserId: TARGET_ID, error: 'DB down' })
    );
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});
