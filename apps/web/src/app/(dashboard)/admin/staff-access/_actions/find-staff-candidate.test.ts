import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

const mockRequireStaffAccessManager = vi.fn();
vi.mock('./_shared/require-staff-access-manager', () => ({
  requireStaffAccessManager: () => mockRequireStaffAccessManager(),
}));

const { mockFindStaffCandidateByEmail } = vi.hoisted(() => ({
  mockFindStaffCandidateByEmail: vi.fn(),
}));
vi.mock('@balo/db', () => ({
  usersRepository: {
    findStaffCandidateByEmail: (...a: unknown[]) => mockFindStaffCandidateByEmail(...a),
  },
}));

import { log } from '@/lib/logging';
import { STAFF_CANDIDATE_MESSAGES } from '../_lib/staff-access-outcome';
import { findStaffCandidateAction } from './find-staff-candidate';

const ACTOR = { id: 'actor-1', platformRole: 'super_admin' as const };
const PERSON = {
  id: 'target-1',
  firstName: 'Dana',
  lastName: 'Whitfield',
  email: 'dana@example.com',
  role: 'user' as const,
  customList: null,
  isLive: true,
  emailVerified: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireStaffAccessManager.mockResolvedValue({ ok: true, user: ACTOR });
});

describe('findStaffCandidateAction', () => {
  it('denies before parsing and never calls the repository', async () => {
    mockRequireStaffAccessManager.mockResolvedValue({ ok: false, error: 'nope' });
    const result = await findStaffCandidateAction({ email: 'dana@' } as never);
    expect(result).toEqual({ success: false, code: 'denied', error: 'nope' });
    expect(mockFindStaffCandidateByEmail).not.toHaveBeenCalled();
  });

  it('returns invalid for a partial address and never calls the repository', async () => {
    const result = await findStaffCandidateAction({ email: 'dana@' });
    expect(result).toEqual({
      success: false,
      code: 'invalid',
      error: STAFF_CANDIDATE_MESSAGES.invalid,
    });
    expect(mockFindStaffCandidateByEmail).not.toHaveBeenCalled();
  });

  it('returns not_found for a miss', async () => {
    mockFindStaffCandidateByEmail.mockResolvedValue(undefined);
    const result = await findStaffCandidateAction({ email: 'nobody@example.com' });
    expect(result).toEqual({
      success: false,
      code: 'not_found',
      error: STAFF_CANDIDATE_MESSAGES.not_found,
    });
  });

  it('returns the found person', async () => {
    mockFindStaffCandidateByEmail.mockResolvedValue(PERSON);
    const result = await findStaffCandidateAction({ email: 'dana@example.com' });
    expect(result).toEqual({ success: true, person: PERSON });
  });

  it('passes the TRIMMED email through unchanged — no re-lowercasing here', async () => {
    mockFindStaffCandidateByEmail.mockResolvedValue(PERSON);
    await findStaffCandidateAction({ email: '  Dana@Example.com  ' });
    expect(mockFindStaffCandidateByEmail).toHaveBeenCalledWith('Dana@Example.com');
  });

  it('log.error fires on a repository throw, and NEVER logs the email', async () => {
    mockFindStaffCandidateByEmail.mockRejectedValue(new Error('DB down'));
    const result = await findStaffCandidateAction({ email: 'dana@example.com' });
    expect(result).toEqual({
      success: false,
      code: 'failed',
      error: STAFF_CANDIDATE_MESSAGES.failed,
    });
    expect(log.error).toHaveBeenCalledWith(
      'Staff candidate lookup failed',
      expect.objectContaining({ actorUserId: ACTOR.id, error: 'DB down' })
    );
    const loggedPayload = (log.error as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0]?.[1] as Record<string, unknown>;
    expect(Object.keys(loggedPayload)).not.toContain('email');
    expect(JSON.stringify(loggedPayload)).not.toContain('dana@example.com');
  });
});
