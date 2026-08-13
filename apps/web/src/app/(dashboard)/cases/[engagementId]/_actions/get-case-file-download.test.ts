import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * BAL-421 — unit tests for the case surface's file DOWNLOAD, which serves ONE presigned GET
 * across BOTH arms of the D4 merge (`meeting_files` and `conversation_files`).
 *
 * ⚠⚠ THE PROPERTY UNDER TEST IS CONTAINMENT, NOT PLUMBING. Every id that decides which object
 * gets signed must come from a GATE, never from the caller: the meeting arm reads
 * `access.meeting.id` off `authorizeMeetingFileAccess`, the conversation arm reads
 * `access.conversationId` off `resolveCaseAccess`. The mocks therefore return ids that are
 * DELIBERATELY DIFFERENT from the ones the caller supplied, so "the gate's value wins" is
 * observable rather than a coincidence of two equal strings.
 *
 * ⚠ `isTwoSidedParty` IS THE REAL PREDICATE, not a stub — the branch it guards exists purely so
 * the download path and the files card agree about which rows EXIST, and a stub could not show
 * that.
 */

const ENGAGEMENT_ID = 'e1000000-0000-4000-8000-000000000001';
const USER_ID = 'u1000000-0000-4000-8000-000000000002';
const FILE_ID = 'f1000000-0000-4000-8000-000000000003';
const FOREIGN_FILE_ID = 'f1000000-0000-4000-8000-0000000000ff';
/** What the CALLER names. */
const INPUT_MEETING_ID = 'a1000000-0000-4000-8000-000000000004';
/** What the GATE resolves — deliberately NOT the input, so the winner is observable. */
const GATE_MEETING_ID = 'a1000000-0000-4000-8000-0000000000aa';
/** The thread from the gate. Nothing the caller sends can name it. */
const GATE_CONVERSATION_ID = 'k1000000-0000-4000-8000-000000000005';

const MEETING_KEY = `meeting-files/${GATE_MEETING_ID}/${USER_ID}/stored-object`;
const CONVERSATION_KEY = `conversation-files/${GATE_CONVERSATION_ID}/${USER_ID}/stored-object`;

vi.mock('server-only', () => ({}));

const mockFindInMeeting = vi.fn();
const mockListFiles = vi.fn();
vi.mock('@balo/db', () => ({
  meetingFilesRepository: { findInMeeting: (...a: unknown[]) => mockFindInMeeting(...a) },
  conversationsRepository: { listFiles: (...a: unknown[]) => mockListFiles(...a) },
  // The REAL predicate — see the file docblock.
  isTwoSidedParty: (party: unknown) => party === 'client' || party === 'expert',
}));

const mockRequireUser = vi.fn();
const mockRequireOnboardedUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({
  requireUser: () => mockRequireUser(),
  requireOnboardedUser: () => mockRequireOnboardedUser(),
}));

const mockResolveCaseAccess = vi.fn();
vi.mock('@/lib/cases/resolve-case-access', () => ({
  resolveCaseAccess: (...a: unknown[]) => mockResolveCaseAccess(...a),
}));

const mockAuthorizeMeetingFile = vi.fn();
vi.mock('@/lib/meetings/authorize-meeting-file-access', () => ({
  authorizeMeetingFileAccess: (...a: unknown[]) => mockAuthorizeMeetingFile(...a),
}));

const mockPresignMeeting = vi.fn();
vi.mock('@/lib/storage/meeting-file', () => ({
  createPresignedMeetingFileDownload: (...a: unknown[]) => mockPresignMeeting(...a),
}));

const mockPresignConversation = vi.fn();
vi.mock('@/lib/storage/conversation-file', () => ({
  createPresignedConversationFileDownload: (...a: unknown[]) => mockPresignConversation(...a),
}));

import { getCaseFileDownloadAction } from './get-case-file-download';
import { log } from '@/lib/logging';

type DownloadInput = Parameters<typeof getCaseFileDownloadAction>[0];

/**
 * The schema is a `.strict()` discriminated union, so the malformed shapes worth testing are
 * exactly the ones TypeScript already refuses to build. Routing them through `unknown` keeps
 * the runtime guard tested without an `any`.
 */
function asInput(value: Record<string, unknown>): DownloadInput {
  return value as unknown as DownloadInput;
}

const MEETING_INPUT: DownloadInput = {
  engagementId: ENGAGEMENT_ID,
  origin: 'meeting',
  fileId: FILE_ID,
  meetingId: INPUT_MEETING_ID,
};

const CONVERSATION_INPUT: DownloadInput = {
  engagementId: ENGAGEMENT_ID,
  origin: 'conversation',
  fileId: FILE_ID,
};

const ACCESS = {
  lens: 'client',
  engagementId: ENGAGEMENT_ID,
  companyId: 'c1000000-0000-4000-8000-000000000006',
  expertProfileId: 'p1000000-0000-4000-8000-000000000007',
  engagementStatus: 'active',
  conversationId: GATE_CONVERSATION_ID,
  conversationWritable: true,
};

const MEETING_FILE = {
  id: FILE_ID,
  meetingId: GATE_MEETING_ID,
  r2Key: MEETING_KEY,
  fileName: 'discovery-deck.pdf',
  contentType: 'application/pdf',
  party: 'client',
};

const CONVERSATION_FILE = {
  id: FILE_ID,
  conversationId: GATE_CONVERSATION_ID,
  r2Key: CONVERSATION_KEY,
  fileName: 'org-chart.xlsx',
  contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

/** ⚠ THE ONE COPY every file-level miss answers with. Probing learns nothing. */
const UNAVAILABLE = 'This file is no longer available.';

function errorOf(result: { success: true } | { success: false; error: string }): string {
  if (result.success) {
    throw new Error('expected a refusal, got a signed URL');
  }
  return result.error;
}

function seed(): void {
  vi.clearAllMocks();
  mockRequireUser.mockResolvedValue({ id: USER_ID });
  mockResolveCaseAccess.mockResolvedValue(ACCESS);
  mockAuthorizeMeetingFile.mockResolvedValue({
    ok: true,
    side: 'client',
    meeting: { id: GATE_MEETING_ID, status: 'ended' },
  });
  mockFindInMeeting.mockResolvedValue(MEETING_FILE);
  mockListFiles.mockResolvedValue([CONVERSATION_FILE]);
  mockPresignMeeting.mockResolvedValue('https://signed.example/meeting-get');
  mockPresignConversation.mockResolvedValue('https://signed.example/conversation-get');
}

/** Nothing that touches R2 or a file table may have run. */
function expectNoFileWorkAtAll(): void {
  expect(mockAuthorizeMeetingFile).not.toHaveBeenCalled();
  expect(mockFindInMeeting).not.toHaveBeenCalled();
  expect(mockListFiles).not.toHaveBeenCalled();
  expect(mockPresignMeeting).not.toHaveBeenCalled();
  expect(mockPresignConversation).not.toHaveBeenCalled();
}

beforeEach(() => {
  seed();
});

describe('getCaseFileDownloadAction — the gates run before any R2 work', () => {
  /**
   * ⚠ BARE `requireUser()`, NOT `requireOnboardedUser()`. A download is genuinely READ-ONLY and
   * this action sits on `_read-only-actions.ts`'s `READ_ONLY_ALLOWLIST`; swapping the session
   * helper would silently lock half-onboarded members out of their own case files.
   */
  it('authenticates with requireUser and never reaches the case gate when it throws', async () => {
    mockRequireUser.mockRejectedValue(new Error('Unauthorized'));
    const result = await getCaseFileDownloadAction(MEETING_INPUT);
    expect(result).toEqual({ success: false, error: 'You are not signed in.' });
    expect(mockResolveCaseAccess).not.toHaveBeenCalled();
    expectNoFileWorkAtAll();
  });

  it('never calls requireOnboardedUser — the READ_ONLY_ALLOWLIST entry depends on it', async () => {
    await getCaseFileDownloadAction(CONVERSATION_INPUT);
    expect(mockRequireUser).toHaveBeenCalledTimes(1);
    expect(mockRequireOnboardedUser).not.toHaveBeenCalled();
  });

  it('re-runs the case gate with the session user, on the MEETING arm too', async () => {
    await getCaseFileDownloadAction(MEETING_INPUT);
    expect(mockResolveCaseAccess).toHaveBeenCalledWith(ENGAGEMENT_ID, USER_ID);
  });

  /**
   * ⚠⚠ A DENIAL IS INDISTINGUISHABLE FROM NOT-FOUND, AND IT COSTS NOTHING. No presigner and no
   * file read may run for someone who cannot reach the case in the first place.
   */
  it('refuses a gate denial before any presigner or repository read', async () => {
    mockResolveCaseAccess.mockResolvedValue(null);
    const result = await getCaseFileDownloadAction(MEETING_INPUT);
    expect(result).toEqual({ success: false, error: 'This case is no longer available.' });
    expectNoFileWorkAtAll();
  });
});

/**
 * ⚠⚠ THE DISCRIMINATED UNION IS A SECURITY CONTROL, NOT TIDINESS. A `meeting` file REQUIRES its
 * `meetingId` (the download gate takes the meeting as a WHERE term) and a `conversation` file
 * FORBIDS one, so no caller can hand a meeting id to the arm that would ignore it.
 */
describe('getCaseFileDownloadAction — the discriminated input', () => {
  it('rejects a meeting-arm call with NO meetingId, before any DB read', async () => {
    const result = await getCaseFileDownloadAction(
      asInput({ engagementId: ENGAGEMENT_ID, origin: 'meeting', fileId: FILE_ID })
    );
    expect(result).toEqual({ success: false, error: 'Invalid request.' });
    expect(mockResolveCaseAccess).not.toHaveBeenCalled();
    expectNoFileWorkAtAll();
  });

  it('rejects a conversation-arm call that SMUGGLES a meetingId (.strict())', async () => {
    const result = await getCaseFileDownloadAction(
      asInput({
        engagementId: ENGAGEMENT_ID,
        origin: 'conversation',
        fileId: FILE_ID,
        meetingId: INPUT_MEETING_ID,
      })
    );
    expect(result).toEqual({ success: false, error: 'Invalid request.' });
    expect(mockResolveCaseAccess).not.toHaveBeenCalled();
  });

  it('rejects an unknown origin and a malformed fileId alike', async () => {
    const unknownOrigin = await getCaseFileDownloadAction(
      asInput({ engagementId: ENGAGEMENT_ID, origin: 'transcript', fileId: FILE_ID })
    );
    const badFileId = await getCaseFileDownloadAction(
      asInput({ engagementId: ENGAGEMENT_ID, origin: 'conversation', fileId: 'nope' })
    );
    expect(errorOf(unknownOrigin)).toBe('Invalid request.');
    expect(errorOf(badFileId)).toBe('Invalid request.');
    expect(mockResolveCaseAccess).not.toHaveBeenCalled();
  });
});

describe('getCaseFileDownloadAction — the meeting arm', () => {
  it('signs the STORED key and STORED name once both gates pass', async () => {
    const result = await getCaseFileDownloadAction(MEETING_INPUT);
    expect(result).toEqual({ success: true, url: 'https://signed.example/meeting-get' });
    expect(mockPresignMeeting).toHaveBeenCalledWith(MEETING_KEY, 'discovery-deck.pdf');
  });

  it('asks BAL-423s gate about the named meeting and the session user', async () => {
    await getCaseFileDownloadAction(MEETING_INPUT);
    expect(mockAuthorizeMeetingFile).toHaveBeenCalledWith({
      meetingId: INPUT_MEETING_ID,
      userId: USER_ID,
    });
  });

  /**
   * ⚠⚠ THE MEETING ID IN THE WHERE CLAUSE IS `access.meeting.id` — THE GATE'S ROW. The two are
   * the same value in production (the gate looked the meeting up BY that input), so the mock
   * returns a DIFFERENT id: only then can the assertion fail if someone "simplifies" the read
   * back onto the parsed input.
   */
  it('scopes the by-id read to the GATE row, never to the parsed input', async () => {
    await getCaseFileDownloadAction(MEETING_INPUT);
    expect(mockFindInMeeting).toHaveBeenCalledWith({
      meetingId: GATE_MEETING_ID,
      fileId: FILE_ID,
    });
  });

  it('refuses a meeting-gate denial with the file literal and never presigns', async () => {
    mockAuthorizeMeetingFile.mockResolvedValue({ ok: false, code: 'meeting_not_found' });
    const result = await getCaseFileDownloadAction(MEETING_INPUT);
    expect(errorOf(result)).toBe(UNAVAILABLE);
    expect(mockFindInMeeting).not.toHaveBeenCalled();
    expect(mockPresignMeeting).not.toHaveBeenCalled();
  });

  it('serves an EXPERT-side reader too — one gate, both sides', async () => {
    mockAuthorizeMeetingFile.mockResolvedValue({
      ok: true,
      side: 'expert',
      meeting: { id: GATE_MEETING_ID, status: 'ended' },
    });
    mockFindInMeeting.mockResolvedValue({ ...MEETING_FILE, party: 'expert' });
    expect(await getCaseFileDownloadAction(MEETING_INPUT)).toMatchObject({ success: true });
  });

  /**
   * ⚠⚠ CONSISTENT WITH THE FILES CARD, DELIBERATELY. `loadCaseFiles` DROPS a row whose `party`
   * is outside the two-sided CHECK. Without this branch the same row would be invisible in the
   * card yet still downloadable by anyone holding its id — two read paths disagreeing about
   * whether a file exists is exactly the divergence that turns fail-closed into a bypass.
   */
  it('refuses a NON-TWO-SIDED party row, logs the shape, and never presigns', async () => {
    mockFindInMeeting.mockResolvedValue({ ...MEETING_FILE, party: 'observer' });
    const result = await getCaseFileDownloadAction(MEETING_INPUT);
    expect(errorOf(result)).toBe(UNAVAILABLE);
    expect(mockPresignMeeting).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      'Refusing to download a case meeting file with a non-two-sided party',
      expect.objectContaining({ fileId: FILE_ID, userId: USER_ID, party: 'observer' })
    );
  });
});

describe('getCaseFileDownloadAction — the conversation arm', () => {
  it('signs the STORED key and STORED name from the thread row', async () => {
    const result = await getCaseFileDownloadAction(CONVERSATION_INPUT);
    expect(result).toEqual({ success: true, url: 'https://signed.example/conversation-get' });
    expect(mockPresignConversation).toHaveBeenCalledWith(CONVERSATION_KEY, 'org-chart.xlsx');
  });

  /**
   * ⚠ THE THREAD ID COMES FROM THE GATE. Nothing in the input can name a conversation, so a
   * file outside this case is simply not in the list that gets scanned.
   */
  it('lists the GATE thread at the full scope, and never touches the meeting arm', async () => {
    await getCaseFileDownloadAction(CONVERSATION_INPUT);
    expect(mockListFiles).toHaveBeenCalledWith(GATE_CONVERSATION_ID, { kind: 'full' });
    expect(mockAuthorizeMeetingFile).not.toHaveBeenCalled();
    expect(mockFindInMeeting).not.toHaveBeenCalled();
  });

  it('refuses a fileId that is not in the gate thread, and never presigns', async () => {
    const result = await getCaseFileDownloadAction({
      ...CONVERSATION_INPUT,
      fileId: FOREIGN_FILE_ID,
    });
    expect(errorOf(result)).toBe(UNAVAILABLE);
    expect(mockPresignConversation).not.toHaveBeenCalled();
  });

  it('refuses when the thread has no files at all, with the same literal', async () => {
    mockListFiles.mockResolvedValue([]);
    expect(errorOf(await getCaseFileDownloadAction(CONVERSATION_INPUT))).toBe(UNAVAILABLE);
  });
});

describe('getCaseFileDownloadAction — one literal for every file-level miss', () => {
  /**
   * ⚠⚠ PROBING MUST LEARN NOTHING. A foreign meeting file, a corrupt meeting row and a foreign
   * conversation file are three different code paths in two different tables, and they must be
   * one answer on the wire.
   *
   * ⚠ THE CASE-LEVEL DENIAL IS DELIBERATELY A DIFFERENT LITERAL ('This case is no longer
   * available.'), and that is NOT a leak: it is returned uniformly for every engagement the
   * caller cannot reach, so it discloses only whether they can open the case they are already
   * looking at — never whether a given fileId exists. Asserted here as an inequality so the two
   * literals cannot be quietly merged or swapped without a red test.
   */
  it('answers a foreign meeting file, a corrupt row and a foreign thread file identically', async () => {
    mockFindInMeeting.mockResolvedValue(undefined);
    const foreignMeetingFile = await getCaseFileDownloadAction({
      ...MEETING_INPUT,
      fileId: FOREIGN_FILE_ID,
    });

    seed();
    mockFindInMeeting.mockResolvedValue({ ...MEETING_FILE, party: 'observer' });
    const corruptRow = await getCaseFileDownloadAction(MEETING_INPUT);

    seed();
    const foreignThreadFile = await getCaseFileDownloadAction({
      ...CONVERSATION_INPUT,
      fileId: FOREIGN_FILE_ID,
    });

    seed();
    mockResolveCaseAccess.mockResolvedValue(null);
    const deniedCase = await getCaseFileDownloadAction(MEETING_INPUT);

    expect(errorOf(foreignMeetingFile)).toBe(UNAVAILABLE);
    expect(errorOf(corruptRow)).toBe(UNAVAILABLE);
    expect(errorOf(foreignThreadFile)).toBe(UNAVAILABLE);
    expect(errorOf(deniedCase)).toBe('This case is no longer available.');
  });
});

describe('getCaseFileDownloadAction — failures degrade to friendly copy', () => {
  it('logs the origin and the ids when the meeting presigner throws', async () => {
    mockPresignMeeting.mockRejectedValue(new Error('R2 down'));
    const result = await getCaseFileDownloadAction(MEETING_INPUT);
    expect(result).toEqual({
      success: false,
      error: 'Could not download this file. Please try again.',
    });
    expect(log.error).toHaveBeenCalledWith(
      'Failed to presign case file download',
      expect.objectContaining({
        engagementId: ENGAGEMENT_ID,
        origin: 'meeting',
        fileId: FILE_ID,
        userId: USER_ID,
        error: 'R2 down',
      })
    );
  });

  it('answers the same way when the CASE GATE itself throws', async () => {
    mockResolveCaseAccess.mockRejectedValue(new Error('db down'));
    const result = await getCaseFileDownloadAction(CONVERSATION_INPUT);
    expect(errorOf(result)).toBe('Could not download this file. Please try again.');
    expect(log.error).toHaveBeenCalledWith(
      'Failed to presign case file download',
      expect.objectContaining({ origin: 'conversation', error: 'db down' })
    );
  });
});
