import { describe, it, expect, vi, beforeEach } from 'vitest';

const REQUEST_ID = 'a0000000-0000-4000-8000-000000000001';
const NOTE_ID = 'b0000000-0000-4000-8000-000000000002';

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const mockSoftDelete = vi.fn();
vi.mock('@balo/db', () => ({
  internalNotesRepository: {
    softDelete: (...a: unknown[]) => mockSoftDelete(...a),
  },
}));

const mockRequireOnboardedUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({
  requireOnboardedUser: () => mockRequireOnboardedUser(),
}));

import { deleteInternalNoteAction } from './delete-internal-note';
import { revalidatePath } from 'next/cache';
import { log } from '@/lib/logging';

const AUTHOR = { id: 'admin-1', platformRole: 'admin' };
const SUPER_ADMIN = { id: 'super-1', platformRole: 'super_admin' };
const VALID_INPUT = { requestId: REQUEST_ID, noteId: NOTE_ID };

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireOnboardedUser.mockResolvedValue(AUTHOR);
  mockSoftDelete.mockResolvedValue({ outcome: 'deleted', noteId: NOTE_ID, auditId: 'audit-1' });
});

describe('deleteInternalNoteAction', () => {
  it('rejects an unauthenticated caller', async () => {
    mockRequireOnboardedUser.mockRejectedValue(new Error('Unauthorized'));
    const result = await deleteInternalNoteAction(VALID_INPUT);
    expect(result).toEqual({ success: false, error: 'You are not signed in.' });
    expect(mockSoftDelete).not.toHaveBeenCalled();
  });

  it('denies a plain user (no MANAGE_INTERNAL_NOTES) before touching the repo', async () => {
    mockRequireOnboardedUser.mockResolvedValue({ id: 'u-2', platformRole: 'user' });
    const result = await deleteInternalNoteAction(VALID_INPUT);
    expect(result).toEqual({
      success: false,
      error: 'You do not have permission to do this.',
      code: 'denied',
    });
    expect(mockSoftDelete).not.toHaveBeenCalled();
  });

  it('rejects a malformed noteId', async () => {
    const result = await deleteInternalNoteAction({ requestId: REQUEST_ID, noteId: 'not-a-uuid' });
    expect(result).toEqual({ success: false, error: 'Invalid request.' });
    expect(mockSoftDelete).not.toHaveBeenCalled();
  });

  it('derives allowAnyAuthor:false for a plain admin and passes it through', async () => {
    await deleteInternalNoteAction(VALID_INPUT);
    expect(mockSoftDelete).toHaveBeenCalledWith({
      noteId: NOTE_ID,
      actorUserId: AUTHOR.id,
      allowAnyAuthor: false,
      expectedEntity: { entityType: 'project_request', entityId: REQUEST_ID },
    });
  });

  it('derives allowAnyAuthor:true for a super_admin', async () => {
    mockRequireOnboardedUser.mockResolvedValue(SUPER_ADMIN);
    await deleteInternalNoteAction(VALID_INPUT);
    expect(mockSoftDelete).toHaveBeenCalledWith(expect.objectContaining({ allowAnyAuthor: true }));
  });

  it("maps 'forbidden' to the permission-denied copy", async () => {
    mockSoftDelete.mockResolvedValue({ outcome: 'forbidden' });
    const result = await deleteInternalNoteAction(VALID_INPUT);
    expect(result).toEqual({
      success: false,
      error: 'You do not have permission to do this.',
      code: 'denied',
    });
  });

  it("maps 'not_found' to the gone copy", async () => {
    mockSoftDelete.mockResolvedValue({ outcome: 'not_found' });
    const result = await deleteInternalNoteAction(VALID_INPUT);
    expect(result).toEqual({
      success: false,
      error: 'That note is no longer there.',
      code: 'gone',
    });
  });

  it('succeeds, logs, and revalidates on deletion', async () => {
    const result = await deleteInternalNoteAction(VALID_INPUT);
    expect(result).toEqual({ success: true, noteId: NOTE_ID });
    expect(revalidatePath).toHaveBeenCalledWith(`/projects/${REQUEST_ID}`);
    expect(log.info).toHaveBeenCalledWith(
      'Internal note deleted',
      expect.objectContaining({
        requestId: REQUEST_ID,
        actorUserId: AUTHOR.id,
        noteId: NOTE_ID,
        allowAnyAuthor: false,
      })
    );
  });

  it('a generic thrown error is logged and returns a generic failure', async () => {
    mockSoftDelete.mockRejectedValue(new Error('db exploded'));
    const result = await deleteInternalNoteAction(VALID_INPUT);
    expect(result).toEqual({
      success: false,
      error: 'Could not delete the note. Please try again.',
    });
    expect(log.error).toHaveBeenCalledWith(
      'Failed to delete internal note',
      expect.objectContaining({ requestId: REQUEST_ID, noteId: NOTE_ID, error: 'db exploded' })
    );
  });
});
