import { describe, it, expect, vi, beforeEach } from 'vitest';

const REQUEST_ID = 'a0000000-0000-4000-8000-000000000001';

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const mockFindById = vi.fn();
const mockCreate = vi.fn();
vi.mock('@balo/db', () => ({
  projectRequestsRepository: {
    findById: (...a: unknown[]) => mockFindById(...a),
  },
  internalNotesRepository: {
    create: (...a: unknown[]) => mockCreate(...a),
  },
}));

const mockRequireOnboardedUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({
  requireOnboardedUser: () => mockRequireOnboardedUser(),
}));

import { createInternalNoteAction } from './create-internal-note';
import { revalidatePath } from 'next/cache';
import { log } from '@/lib/logging';

const STAFF = { id: 'admin-1', platformRole: 'admin', firstName: 'Adeeb', lastName: 'Khan' };
const VALID_INPUT = { requestId: REQUEST_ID, body: 'Waiting on the client to sign off.' };

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireOnboardedUser.mockResolvedValue(STAFF);
  mockFindById.mockResolvedValue({ id: REQUEST_ID });
  mockCreate.mockResolvedValue({
    note: {
      id: 'note-1',
      body: VALID_INPUT.body,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    },
    auditId: 'audit-1',
  });
});

describe('createInternalNoteAction', () => {
  it('rejects an unauthenticated caller', async () => {
    mockRequireOnboardedUser.mockRejectedValue(new Error('Unauthorized'));
    const result = await createInternalNoteAction(VALID_INPUT);
    expect(result).toEqual({ success: false, error: 'You are not signed in.' });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('denies a plain user (no platform capability) before touching the repo', async () => {
    mockRequireOnboardedUser.mockResolvedValue({ id: 'u-2', platformRole: 'user' });
    const result = await createInternalNoteAction(VALID_INPUT);
    expect(result).toEqual({
      success: false,
      error: 'You do not have permission to do this.',
      code: 'denied',
    });
    expect(mockFindById).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('rejects a body shorter than 3 characters', async () => {
    const result = await createInternalNoteAction({ requestId: REQUEST_ID, body: 'hi' });
    expect(result).toEqual({ success: false, error: 'Invalid request.' });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('rejects a whitespace-only body (trimmed below the minimum)', async () => {
    const result = await createInternalNoteAction({ requestId: REQUEST_ID, body: '   ' });
    expect(result).toEqual({ success: false, error: 'Invalid request.' });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('rejects a body over 2000 characters', async () => {
    const result = await createInternalNoteAction({
      requestId: REQUEST_ID,
      body: 'x'.repeat(2001),
    });
    expect(result).toEqual({ success: false, error: 'Invalid request.' });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('rejects an entityType key on the input — server-stated, no wire path (.strict())', async () => {
    const result = await createInternalNoteAction({
      ...VALID_INPUT,
      entityType: 'project_request',
    } as never);
    expect(result).toEqual({ success: false, error: 'Invalid request.' });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('returns a gone message when the request no longer exists', async () => {
    mockFindById.mockResolvedValue(undefined);
    const result = await createInternalNoteAction(VALID_INPUT);
    expect(result).toEqual({
      success: false,
      error: 'This request no longer exists.',
      code: 'gone',
    });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('passes entityType: project_request as a literal, never from the input', async () => {
    await createInternalNoteAction(VALID_INPUT);
    expect(mockCreate).toHaveBeenCalledWith({
      entityType: 'project_request',
      entityId: REQUEST_ID,
      body: VALID_INPUT.body,
      authorUserId: STAFF.id,
    });
  });

  it('returns the created note in view shape, with canDelete:true for its own author', async () => {
    const result = await createInternalNoteAction(VALID_INPUT);
    expect(result).toEqual({
      success: true,
      note: {
        id: 'note-1',
        authorName: 'Adeeb Khan',
        authorInitials: 'AK',
        body: VALID_INPUT.body,
        createdAtIso: '2026-01-01T00:00:00.000Z',
        canDelete: true,
      },
      analytics: { entityType: 'project_request', entityId: REQUEST_ID },
    });
  });

  it('revalidates the detail path', async () => {
    await createInternalNoteAction(VALID_INPUT);
    expect(revalidatePath).toHaveBeenCalledWith(`/projects/${REQUEST_ID}`);
  });

  it('logs creation WITHOUT the body ever appearing in the log payload', async () => {
    await createInternalNoteAction(VALID_INPUT);
    expect(log.info).toHaveBeenCalledWith(
      'Internal note created',
      expect.objectContaining({ requestId: REQUEST_ID, actorUserId: STAFF.id, noteId: 'note-1' })
    );
    const [, fields] = (log.info as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(fields).not.toHaveProperty('body');
    expect(JSON.stringify(fields)).not.toContain(VALID_INPUT.body);
  });

  it('a generic thrown error is logged (without the body) and returns a generic failure', async () => {
    mockCreate.mockRejectedValue(new Error('db exploded'));
    const result = await createInternalNoteAction(VALID_INPUT);
    expect(result).toEqual({
      success: false,
      error: 'Could not add the note. Please try again.',
    });
    expect(log.error).toHaveBeenCalledWith(
      'Failed to create internal note',
      expect.objectContaining({ requestId: REQUEST_ID, error: 'db exploded' })
    );
    const [, fields] = (log.error as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(JSON.stringify(fields)).not.toContain(VALID_INPUT.body);
  });

  it('a rejected pre-flight read (findById) is caught and returns the generic failure result, not an unhandled rejection', async () => {
    mockFindById.mockRejectedValue(new Error('connection reset'));
    const result = await createInternalNoteAction(VALID_INPUT);
    expect(result).toEqual({
      success: false,
      error: 'Could not add the note. Please try again.',
    });
    expect(mockCreate).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith(
      'Failed to create internal note',
      expect.objectContaining({ requestId: REQUEST_ID, error: 'connection reset' })
    );
  });
});
