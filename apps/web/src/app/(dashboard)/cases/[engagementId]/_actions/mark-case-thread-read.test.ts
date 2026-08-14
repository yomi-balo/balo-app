import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * BAL-421 — unit tests for the case thread's read watermark.
 *
 * ⚠⚠ THE PROPERTY THAT MATTERS IS THAT A WATERMARK FAILURE NEVER FAILS THE PAGE. This is a
 * high-frequency, entirely cosmetic write fired by an island as the viewer scrolls; if the
 * upsert throws, the correct outcome is a handled `{ success: false }` the island can ignore —
 * NOT an unhandled rejection surfacing as a Server Action crash on a page that otherwise
 * rendered perfectly.
 *
 * ⚠ IT WRITES (`conversation_read_states`), so unlike `fetchCaseThreadAction` it gates on
 * `requireOnboardedUser()` and must NEVER appear on `READ_ONLY_ALLOWLIST`. Both session
 * functions are mocked so the suite can assert WHICH one ran, rather than inferring it.
 */

const ENGAGEMENT_ID = 'e0000000-0000-4000-8000-00000000c001';
const USER_ID = 'u0000000-0000-4000-8000-00000000c002';
/** ⚠ Shares no bytes with the input — the thread is named by the GATE, never by the caller. */
const GATE_CONVERSATION_ID = 'd0000000-0000-4000-8000-00000000cbeef';
const OTHER_TENANT_CONVERSATION_ID = 'd0000000-0000-4000-8000-00000000c0ff';

const LAST_READ_AT = new Date('2026-08-12T09:30:00.000Z');

vi.mock('server-only', () => ({}));

const mockMarkThreadRead = vi.fn();
vi.mock('@balo/db', () => ({
  conversationsRepository: { markThreadRead: (...a: unknown[]) => mockMarkThreadRead(...a) },
}));

const mockRequireOnboardedUser = vi.fn();
const mockRequireUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({
  requireOnboardedUser: () => mockRequireOnboardedUser(),
  requireUser: () => mockRequireUser(),
}));

const mockResolveCaseAccess = vi.fn();
vi.mock('@/lib/cases/resolve-case-access', () => ({
  resolveCaseAccess: (...a: unknown[]) => mockResolveCaseAccess(...a),
}));

import { markCaseThreadReadAction } from './mark-case-thread-read';
import { log } from '@/lib/logging';

/** The watermark consumes `conversationId` alone — see the closed-case block at the bottom. */
const ACCESS = { conversationId: GATE_CONVERSATION_ID, conversationWritable: true };

const INPUT = { engagementId: ENGAGEMENT_ID };

function seed(): void {
  vi.clearAllMocks();
  mockRequireOnboardedUser.mockResolvedValue({ id: USER_ID });
  mockRequireUser.mockResolvedValue({ id: USER_ID });
  mockResolveCaseAccess.mockResolvedValue(ACCESS);
  mockMarkThreadRead.mockResolvedValue({
    id: 'crs-1',
    conversationId: GATE_CONVERSATION_ID,
    userId: USER_ID,
    lastReadAt: LAST_READ_AT,
  });
}

beforeEach(() => {
  seed();
});

describe('markCaseThreadReadAction — it is a WRITE, and gated like one', () => {
  it('uses requireOnboardedUser, never the bare requireUser', async () => {
    await markCaseThreadReadAction(INPUT);
    // An entry on `READ_ONLY_ALLOWLIST` would fail that list's own no-stale-entries test;
    // the gate itself is what has to be right.
    expect(mockRequireOnboardedUser).toHaveBeenCalledTimes(1);
    expect(mockRequireUser).not.toHaveBeenCalled();
  });

  it('refuses an un-onboarded session before the tenancy gate runs', async () => {
    mockRequireOnboardedUser.mockRejectedValue(new Error('Onboarding not completed'));
    expect(await markCaseThreadReadAction(INPUT)).toEqual({
      success: false,
      error: 'You are not signed in.',
    });
    expect(mockResolveCaseAccess).not.toHaveBeenCalled();
    expect(mockMarkThreadRead).not.toHaveBeenCalled();
  });

  it('rejects a malformed engagementId before any DB access', async () => {
    expect(await markCaseThreadReadAction({ engagementId: 'nope' })).toEqual({
      success: false,
      error: 'Invalid request.',
    });
    expect(mockResolveCaseAccess).not.toHaveBeenCalled();
    expect(mockMarkThreadRead).not.toHaveBeenCalled();
  });

  it('is STRICT — a caller-supplied conversationId is rejected, never honoured', async () => {
    const result = await markCaseThreadReadAction({
      engagementId: ENGAGEMENT_ID,
      conversationId: OTHER_TENANT_CONVERSATION_ID,
    } as { engagementId: string });
    expect(result).toEqual({ success: false, error: 'Invalid request.' });
    expect(mockMarkThreadRead).not.toHaveBeenCalled();
  });

  it('re-runs the FULL tenancy gate for the session user', async () => {
    await markCaseThreadReadAction(INPUT);
    expect(mockResolveCaseAccess).toHaveBeenCalledWith(ENGAGEMENT_ID, USER_ID);
  });

  it('refuses a gate denial with the shared literal, and writes NOTHING', async () => {
    mockResolveCaseAccess.mockResolvedValue(null);
    expect(await markCaseThreadReadAction(INPUT)).toEqual({
      success: false,
      error: 'This case is no longer available.',
    });
    // ⚠ A watermark on someone else's thread would be a cross-tenant write on a UNIQUE
    // (conversation_id, user_id) row — a real, if quiet, tenancy breach.
    expect(mockMarkThreadRead).not.toHaveBeenCalled();
  });
});

describe('markCaseThreadReadAction — the watermark itself', () => {
  it('marks the GATE conversation for the SESSION user', async () => {
    await markCaseThreadReadAction(INPUT);
    expect(mockMarkThreadRead).toHaveBeenCalledWith({
      conversationId: GATE_CONVERSATION_ID,
      userId: USER_ID,
      at: expect.any(Date),
    });
  });

  it('never marks a conversation named by the caller', async () => {
    await markCaseThreadReadAction(INPUT);
    const [call] = mockMarkThreadRead.mock.calls;
    if (call === undefined) {
      throw new Error('expected the watermark to have been written');
    }
    const [args] = call as [{ conversationId: string }];
    expect(args.conversationId).not.toBe(ENGAGEMENT_ID);
  });

  it('follows the gate when it resolves a different thread', async () => {
    mockResolveCaseAccess.mockResolvedValue({
      ...ACCESS,
      conversationId: OTHER_TENANT_CONVERSATION_ID,
    });
    await markCaseThreadReadAction(INPUT);
    expect(mockMarkThreadRead).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: OTHER_TENANT_CONVERSATION_ID })
    );
  });

  it('returns the persisted watermark as an ISO string, not the Date', async () => {
    // The repository upserts with `GREATEST(existing, new)`, so the row it returns can be
    // NEWER than the instant just sent. Echoing the sent time instead would let the island
    // move its own watermark backwards.
    expect(await markCaseThreadReadAction(INPUT)).toEqual({
      success: true,
      lastReadAtIso: '2026-08-12T09:30:00.000Z',
    });
  });

  it('reports the row the repository returned, even when it is ahead of this mark', async () => {
    const ahead = new Date('2026-08-12T11:00:00.000Z');
    mockMarkThreadRead.mockResolvedValue({ lastReadAt: ahead });
    expect(await markCaseThreadReadAction(INPUT)).toEqual({
      success: true,
      lastReadAtIso: '2026-08-12T11:00:00.000Z',
    });
  });
});

/**
 * ⚠⚠ A COSMETIC WRITE MUST DEGRADE, NEVER CRASH. The island fires this on scroll; a raw
 * throw would surface as a Server Action failure on a page that rendered fine.
 */
describe('markCaseThreadReadAction — a watermark failure never fails the page', () => {
  it('HANDLES an upsert failure, logging it and returning friendly copy', async () => {
    mockMarkThreadRead.mockRejectedValue(new Error('23505 duplicate key'));

    const result = await markCaseThreadReadAction(INPUT);

    expect(result).toEqual({
      success: false,
      error: 'Could not update the thread. Please try again.',
    });
    expect(log.error).toHaveBeenCalledWith(
      'Failed to mark case conversation thread read',
      expect.objectContaining({
        engagementId: ENGAGEMENT_ID,
        userId: USER_ID,
        error: '23505 duplicate key',
      })
    );
  });

  it('resolves rather than rejects — the caller never has to catch', async () => {
    mockMarkThreadRead.mockRejectedValue(new Error('connection refused'));
    await expect(markCaseThreadReadAction(INPUT)).resolves.toMatchObject({ success: false });
  });
});

/**
 * ⚠⚠ NO WRITABILITY CHECK. Marking a CLOSED case's thread read is correct and expected — the
 * thread stays readable forever, and a viewer who has read it has read it. A
 * `conversationWritable` guard here would leave every resolved case permanently "unread".
 */
describe('markCaseThreadReadAction — a CLOSED case still records the read', () => {
  it('marks a non-writable thread read and returns the watermark', async () => {
    mockResolveCaseAccess.mockResolvedValue({
      ...ACCESS,
      engagementStatus: 'completed',
      conversationWritable: false,
    });

    expect(await markCaseThreadReadAction(INPUT)).toEqual({
      success: true,
      lastReadAtIso: '2026-08-12T09:30:00.000Z',
    });
    expect(mockMarkThreadRead).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: GATE_CONVERSATION_ID, userId: USER_ID })
    );
  });
});
