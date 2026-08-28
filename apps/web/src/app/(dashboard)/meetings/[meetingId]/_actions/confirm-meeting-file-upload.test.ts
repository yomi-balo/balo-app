import { describe, it, expect, vi, beforeEach } from 'vitest';

const MEETING_ID = 'a0000000-0000-4000-8000-000000000001';
const OTHER_MEETING_ID = 'a0000000-0000-4000-8000-00000000000f';
const USER_ID = 'b0000000-0000-4000-8000-000000000002';
const OTHER_USER_ID = 'b0000000-0000-4000-8000-00000000dead';
const FILE_UUID = 'c0000000-0000-4000-8000-000000000003';
const FILE_ID = 'd0000000-0000-4000-8000-000000000004';
const KEY = `meeting-files/${MEETING_ID}/${USER_ID}/${FILE_UUID}`;
const CREATED_AT = new Date('2026-08-11T10:00:00Z');

vi.mock('server-only', () => ({}));

const mockAdd = vi.fn();
vi.mock('@balo/db', () => ({
  meetingFilesRepository: { add: (...args: unknown[]) => mockAdd(...args) },
}));

const mockRequireOnboardedUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({
  requireOnboardedUser: () => mockRequireOnboardedUser(),
}));

const mockAuthorize = vi.fn();
vi.mock('@/lib/meetings/authorize-meeting-file-access', () => ({
  authorizeMeetingFileAccess: (...args: unknown[]) => mockAuthorize(...args),
}));

const mockSend = vi.fn();
vi.mock('@/lib/storage/r2', () => ({
  r2Client: { send: (...args: unknown[]) => mockSend(...args) },
  R2_BUCKET: 'test-bucket',
}));

vi.mock('@aws-sdk/client-s3', () => ({
  HeadObjectCommand: class {
    input: Record<string, unknown>;
    constructor(input: Record<string, unknown>) {
      this.input = input;
    }
  },
}));

const mockDelete = vi.fn();
vi.mock('@/lib/storage/meeting-file', () => ({
  MEETING_ALLOWED_CONTENT_TYPES: new Set(['application/pdf', 'text/csv']),
  MAX_MEETING_FILE_BYTES: 10 * 1024 * 1024,
  // ⚠ The REAL shapes, not stubs: the whole point of `meetingFileKeyPrefix` is that the
  // minting side and this validating side share ONE normalisation, so a fake here would
  // test nothing. `meetingFileKeyLeaf` likewise — the assertions below are about what
  // actually reaches the log.
  meetingFileKeyPrefix: (meetingId: string, userId: string) =>
    `meeting-files/${meetingId.toLowerCase()}/${userId.toLowerCase()}/`,
  meetingFileKeyLeaf: (key: string) => key.slice(key.lastIndexOf('/') + 1),
  deleteMeetingFileFromR2: (...args: unknown[]) => {
    mockDelete(...args);
    return Promise.resolve();
  },
}));

import { confirmMeetingFileUploadAction } from './confirm-meeting-file-upload';
import { log } from '@/lib/logging';

const VALID_INPUT = {
  meetingId: MEETING_ID,
  key: KEY,
  fileName: 'deck.pdf',
  sizeBytes: 1234,
  source: 'chat' as const,
};

/** The row `add` resolves to — `party` echoes whatever the action passed in. */
function rowFor(input: Record<string, unknown>): Record<string, unknown> {
  return {
    id: FILE_ID,
    meetingId: MEETING_ID,
    uploadedByUserId: USER_ID,
    party: input.party,
    source: input.source,
    r2Key: KEY,
    fileName: 'deck.pdf',
    contentType: 'application/pdf',
    sizeBytes: 1234,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    deletedAt: null,
  };
}

describe('confirmMeetingFileUploadAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireOnboardedUser.mockResolvedValue({ id: USER_ID });
    mockAuthorize.mockResolvedValue({ ok: true, viewer: 'member', side: 'client' });
    mockSend.mockResolvedValue({ ContentLength: 1234, ContentType: 'application/pdf' });
    mockAdd.mockImplementation((input: Record<string, unknown>) => Promise.resolve(rowFor(input)));
  });

  it('rejects when not signed in (or not onboarded)', async () => {
    mockRequireOnboardedUser.mockRejectedValue(new Error('Onboarding not completed'));
    const result = await confirmMeetingFileUploadAction(VALID_INPUT);
    expect(result).toEqual({ success: false, error: 'You are not signed in.' });
    expect(mockAuthorize).not.toHaveBeenCalled();
  });

  it('maps a gate denial to generic copy and never HEADs the object', async () => {
    mockAuthorize.mockResolvedValue({ ok: false, code: 'meeting_not_found' });
    const result = await confirmMeetingFileUploadAction(VALID_INPUT);
    expect(result).toEqual({ success: false, error: 'This meeting is no longer available.' });
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockAdd).not.toHaveBeenCalled();
  });

  /**
   * ⚠⚠ BAL-445 — THE GUEST-UPLOAD BRAKE, AND IT IS THE POINT. `party: access.side` cannot
   * compile for a guest (the guest arm carries no `side`), so this action must narrow on
   * `access.viewer` before ever reaching the insert. Unreachable in production today — this
   * action gates on `requireOnboardedUser()` above, which a guest never satisfies — and
   * handled anyway, per `fetch-meeting-thread.ts`'s precedent that a Server Action is a public
   * endpoint and must never assume its own UI.
   */
  it('refuses a GUEST-viewer gate result and never HEADs or inserts', async () => {
    mockAuthorize.mockResolvedValue({
      ok: true,
      viewer: 'guest',
      guestId: 'guest-1',
      accessScope: 'meeting',
    });
    const result = await confirmMeetingFileUploadAction(VALID_INPUT);
    expect(result).toEqual({ success: false, error: 'This meeting is no longer available.' });
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockAdd).not.toHaveBeenCalled();
  });

  // ══ THE ANTI-CROSS-PARTY CONTROL ══════════════════════════════════════════════════════
  describe('party comes from the GATE, never from the request', () => {
    it('persists `client` for a client-side actor', async () => {
      mockAuthorize.mockResolvedValue({ ok: true, viewer: 'member', side: 'client' });
      const result = await confirmMeetingFileUploadAction(VALID_INPUT);
      expect(mockAdd).toHaveBeenCalledWith(expect.objectContaining({ party: 'client' }));
      expect(result).toMatchObject({
        success: true,
        file: expect.objectContaining({ party: 'client' }),
      });
    });

    it('persists `expert` for an expert-side actor', async () => {
      mockAuthorize.mockResolvedValue({ ok: true, viewer: 'member', side: 'expert' });
      const result = await confirmMeetingFileUploadAction(VALID_INPUT);
      expect(mockAdd).toHaveBeenCalledWith(expect.objectContaining({ party: 'expert' }));
      expect(result).toMatchObject({
        success: true,
        file: expect.objectContaining({ party: 'expert' }),
      });
    });

    /**
     * ⚠⚠ THE LOAD-BEARING ASSERTION. The Zod schema has NO `party` key, so Zod strips it — a
     * body carrying `party: 'expert'` from a CLIENT-side actor still persists `'client'`.
     * That makes cross-party attribution structurally unreachable, not merely unchecked.
     */
    it('IGNORES a `party` field smuggled into the request body', async () => {
      mockAuthorize.mockResolvedValue({ ok: true, viewer: 'member', side: 'client' });
      const smuggled = { ...VALID_INPUT, party: 'expert' } as unknown as typeof VALID_INPUT;
      const result = await confirmMeetingFileUploadAction(smuggled);
      expect(result).toMatchObject({ success: true });
      expect(mockAdd).toHaveBeenCalledWith(expect.objectContaining({ party: 'client' }));
      expect(mockAdd).not.toHaveBeenCalledWith(expect.objectContaining({ party: 'expert' }));
    });

    /**
     * ⚠⚠ THE CLOSED-WORLD ASSERTION — WHAT MAKES THE STRIPPING PROVABLE RATHER THAN ASSUMED.
     *
     * The previous version of this asserted `not.toHaveProperty('partyClaim')`, and
     * `partyClaim` appears NOWHERE in the repository — so it could not have failed under any
     * change whatsoever. Enumerating the payload's key set EXACTLY is the assertion that was
     * meant: a smuggled key that somehow survived Zod, or a new field quietly threaded from
     * request input to the row, shows up as a set difference and fails HERE.
     *
     * ⚠ `.sort((a, b) => a.localeCompare(b))`, never a bare `.sort()` — a bare one is a
     * SonarCloud reliability bug (it sorts by UTF-16 code unit via string coercion).
     */
    it('the `add` payload has EXACTLY the eight expected keys — nothing smuggled survives', async () => {
      mockAuthorize.mockResolvedValue({ ok: true, viewer: 'member', side: 'client' });
      const smuggled = {
        ...VALID_INPUT,
        party: 'expert',
        deletedAt: null,
        id: 'not-yours',
      } as unknown as typeof VALID_INPUT;

      await confirmMeetingFileUploadAction(smuggled);

      const payload = mockAdd.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(Object.keys(payload).sort((a, b) => a.localeCompare(b))).toEqual(
        [
          'contentType',
          'fileName',
          'meetingId',
          'party',
          'r2Key',
          'sizeBytes',
          'source',
          'uploadedByUserId',
        ].sort((a, b) => a.localeCompare(b))
      );
    });

    it('IGNORES it in the other direction too (expert actor, smuggled `client`)', async () => {
      mockAuthorize.mockResolvedValue({ ok: true, viewer: 'member', side: 'expert' });
      const smuggled = { ...VALID_INPUT, party: 'client' } as unknown as typeof VALID_INPUT;
      await confirmMeetingFileUploadAction(smuggled);
      expect(mockAdd).toHaveBeenCalledWith(expect.objectContaining({ party: 'expert' }));
    });
  });

  describe('key shape + provenance', () => {
    it('rejects a malformed key without HEADing', async () => {
      const result = await confirmMeetingFileUploadAction({
        ...VALID_INPUT,
        key: 'meeting-files/short/key',
      });
      expect(result).toEqual({ success: false, error: 'Invalid upload key.' });
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('rejects a key minted by ANOTHER user', async () => {
      const foreign = `meeting-files/${MEETING_ID}/${OTHER_USER_ID}/${FILE_UUID}`;
      const result = await confirmMeetingFileUploadAction({ ...VALID_INPUT, key: foreign });
      expect(result).toEqual({ success: false, error: 'Invalid upload key.' });
      expect(mockAdd).not.toHaveBeenCalled();
    });

    it('rejects a key minted for ANOTHER meeting', async () => {
      const foreign = `meeting-files/${OTHER_MEETING_ID}/${USER_ID}/${FILE_UUID}`;
      const result = await confirmMeetingFileUploadAction({ ...VALID_INPUT, key: foreign });
      expect(result).toEqual({ success: false, error: 'Invalid upload key.' });
      expect(mockAdd).not.toHaveBeenCalled();
    });

    it('rejects a key outside the meeting-files prefix', async () => {
      const foreign = `conversation-files/${MEETING_ID}/${USER_ID}/${FILE_UUID}`;
      const result = await confirmMeetingFileUploadAction({ ...VALID_INPUT, key: foreign });
      expect(result).toEqual({ success: false, error: 'Invalid upload key.' });
    });
  });

  describe('HEAD verification at the source', () => {
    it('maps a zero-byte object to EMPTY copy and deletes it (never "too large")', async () => {
      mockSend.mockResolvedValue({ ContentLength: 0, ContentType: 'application/pdf' });
      const result = await confirmMeetingFileUploadAction(VALID_INPUT);
      expect(result).toEqual({ success: false, error: 'The uploaded file appears to be empty.' });
      expect(mockDelete).toHaveBeenCalledWith(KEY);
      expect(mockAdd).not.toHaveBeenCalled();
    });

    it('maps a missing ContentLength to the same EMPTY copy', async () => {
      mockSend.mockResolvedValue({ ContentType: 'application/pdf' });
      const result = await confirmMeetingFileUploadAction(VALID_INPUT);
      expect(result).toEqual({ success: false, error: 'The uploaded file appears to be empty.' });
      expect(mockDelete).toHaveBeenCalledWith(KEY);
    });

    it('maps an over-cap object to DIFFERENT copy and deletes it', async () => {
      mockSend.mockResolvedValue({
        ContentLength: 99 * 1024 * 1024,
        ContentType: 'application/pdf',
      });
      const result = await confirmMeetingFileUploadAction(VALID_INPUT);
      expect(result).toEqual({
        success: false,
        error: 'Uploaded file is too large. Please try a smaller file.',
      });
      expect(mockDelete).toHaveBeenCalledWith(KEY);
      expect(mockAdd).not.toHaveBeenCalled();
    });

    it('rejects + deletes when the RESOLVED content type is not allowed', async () => {
      mockSend.mockResolvedValue({ ContentLength: 100, ContentType: 'application/x-msdownload' });
      const result = await confirmMeetingFileUploadAction(VALID_INPUT);
      expect(result).toEqual({ success: false, error: 'This file type is not supported.' });
      expect(mockDelete).toHaveBeenCalledWith(KEY);
    });

    /**
     * ⚠⚠ A MISSING `head.ContentType` IS A REJECTION, NOT A FALLBACK. This previously read
     * `head.ContentType ?? claimedContentType`, which demoted a source-of-truth check into a
     * client assertion in exactly the case where the source of truth was unavailable. An
     * object that cannot be SHOWN to be one of the nine allowed types must be DENIED. The
     * action no longer accepts a claimed type at all, so there is nothing to fall back to.
     */
    it('REJECTS + deletes when the object has NO ContentType (never falls back to a claim)', async () => {
      mockSend.mockResolvedValue({ ContentLength: 100 });
      const result = await confirmMeetingFileUploadAction(VALID_INPUT);
      expect(result).toEqual({ success: false, error: 'This file type is not supported.' });
      expect(mockDelete).toHaveBeenCalledWith(KEY);
      expect(mockAdd).not.toHaveBeenCalled();
    });

    it('persists the REAL size and type from R2, not the client claims', async () => {
      mockSend.mockResolvedValue({ ContentLength: 4242, ContentType: 'text/csv' });
      await confirmMeetingFileUploadAction({ ...VALID_INPUT, sizeBytes: 1 });
      expect(mockAdd).toHaveBeenCalledWith(
        expect.objectContaining({ sizeBytes: 4242, contentType: 'text/csv' })
      );
    });

    /**
     * ⚠ THE SCHEMA HAS NO `contentType` KEY AT ALL — so a claim is not merely outvoted, it is
     * STRIPPED. A body asserting an allowed type over an object R2 says is an executable
     * still resolves to the object's type, and is rejected.
     */
    it('a smuggled `contentType` claim cannot rescue a disallowed object', async () => {
      mockSend.mockResolvedValue({ ContentLength: 100, ContentType: 'application/x-msdownload' });
      const smuggled = {
        ...VALID_INPUT,
        contentType: 'application/pdf',
      } as unknown as typeof VALID_INPUT;
      const result = await confirmMeetingFileUploadAction(smuggled);
      expect(result).toEqual({ success: false, error: 'This file type is not supported.' });
      expect(mockAdd).not.toHaveBeenCalled();
    });
  });

  // ══ S5 / S7 — NORMALISATION AT THE WRITE BOUNDARY ═══════════════════════════════════════
  describe('key normalisation and file-name sanitisation', () => {
    /**
     * ⚠ `z.uuid()` ACCEPTS UPPERCASE HEX and Postgres resolves it to the same row, so an
     * uppercase `meetingId` reaches this action and passes the gate. Both the minting side
     * and this validating side derive the expected prefix from ONE function, which lowercases
     * — so an uppercase id confirms against the lowercase key it actually minted, instead of
     * being rejected by the lowercase-only `MEETING_FILE_KEY_PATTERN` and orphaning an object
     * already stored in R2.
     */
    it('accepts an UPPERCASE meetingId against the lowercase key it minted', async () => {
      const result = await confirmMeetingFileUploadAction({
        ...VALID_INPUT,
        meetingId: MEETING_ID.toUpperCase(),
      });
      expect(result).toMatchObject({ success: true });
      expect(mockAdd).toHaveBeenCalledWith(expect.objectContaining({ r2Key: KEY }));
    });

    /**
     * ⚠⚠ BIDI OVERRIDES ARE STRIPPED AT **WRITE** TIME. `U+202E` reorders every glyph after
     * it without changing the code points, so `invoice` + `U+202E` + `gnp.exe` is stored and
     * matched as an `.exe` while RENDERING everywhere as `invoice.png`. Sanitising once here
     * makes every present and future reader — the list, chat, the download's
     * `Content-Disposition`, BAL-421's merged view — safe by default.
     */
    it('strips bidi override characters from the persisted file name', async () => {
      const disguised = `invoice${String.fromCodePoint(0x202e)}gnp.exe`;
      await confirmMeetingFileUploadAction({ ...VALID_INPUT, fileName: disguised });
      expect(mockAdd).toHaveBeenCalledWith(expect.objectContaining({ fileName: 'invoicegnp.exe' }));
    });

    it.each([0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069])(
      'strips bidi control code point %i from the persisted file name',
      async (codePoint) => {
        await confirmMeetingFileUploadAction({
          ...VALID_INPUT,
          fileName: `a${String.fromCodePoint(codePoint)}b.pdf`,
        });
        expect(mockAdd).toHaveBeenCalledWith(expect.objectContaining({ fileName: 'ab.pdf' }));
      }
    );

    /** A name made ENTIRELY of those controls strips to nothing — a rejection, not a store. */
    it('rejects + deletes a name made entirely of bidi controls', async () => {
      const allControls = [0x202a, 0x202e, 0x2066].map((c) => String.fromCodePoint(c)).join('');
      const result = await confirmMeetingFileUploadAction({
        ...VALID_INPUT,
        fileName: allControls,
      });
      expect(result).toEqual({ success: false, error: 'This file name is not supported.' });
      expect(mockDelete).toHaveBeenCalledWith(KEY);
      expect(mockAdd).not.toHaveBeenCalled();
    });

    it('leaves an ordinary name completely alone', async () => {
      await confirmMeetingFileUploadAction({ ...VALID_INPUT, fileName: 'Q3 план 提案.pdf' });
      expect(mockAdd).toHaveBeenCalledWith(
        expect.objectContaining({ fileName: 'Q3 план 提案.pdf' })
      );
    });
  });

  describe('happy path', () => {
    it('inserts standalone with the full row shape and logs the business event', async () => {
      const result = await confirmMeetingFileUploadAction(VALID_INPUT);
      expect(mockAdd).toHaveBeenCalledWith({
        meetingId: MEETING_ID,
        uploadedByUserId: USER_ID,
        party: 'client',
        source: 'chat',
        r2Key: KEY,
        fileName: 'deck.pdf',
        contentType: 'application/pdf',
        sizeBytes: 1234,
      });
      // `add` is the ONLY repository call — no wider transaction wraps it, which is what
      // satisfies its bare-insert contract.
      expect(mockAdd).toHaveBeenCalledOnce();
      expect(result).toEqual({
        success: true,
        file: {
          id: FILE_ID,
          meetingId: MEETING_ID,
          fileName: 'deck.pdf',
          contentType: 'application/pdf',
          sizeBytes: 1234,
          party: 'client',
          source: 'chat',
          uploadedByUserId: USER_ID,
          createdAtIso: CREATED_AT.toISOString(),
        },
      });
      expect(log.info).toHaveBeenCalledWith('Meeting file shared', expect.any(Object));
    });

    it('never logs the r2Key or the file name in the business event (PII)', async () => {
      await confirmMeetingFileUploadAction(VALID_INPUT);
      const fields = vi.mocked(log.info).mock.calls[0]?.[1] as Record<string, unknown>;
      expect(fields).not.toHaveProperty('r2Key');
      expect(fields).not.toHaveProperty('key');
      expect(fields).not.toHaveProperty('fileName');
    });

    // D0: both in-call entry points write to the SAME table, distinguished by `source`.
    it.each(['chat', 'files_tab'] as const)('round-trips source=%s', async (source) => {
      const result = await confirmMeetingFileUploadAction({ ...VALID_INPUT, source });
      expect(mockAdd).toHaveBeenCalledWith(expect.objectContaining({ source }));
      expect(result).toMatchObject({ success: true, file: expect.objectContaining({ source }) });
    });

    it('rejects an unknown source label at the schema', async () => {
      const result = await confirmMeetingFileUploadAction({
        ...VALID_INPUT,
        source: 'recap' as unknown as 'chat',
      });
      expect(result).toEqual({ success: false, error: 'Invalid request.' });
      expect(mockAuthorize).not.toHaveBeenCalled();
    });
  });

  describe('failure mapping', () => {
    it('maps a duplicate confirm (23505) to "already shared" at WARN, not ERROR', async () => {
      mockAdd.mockRejectedValue(Object.assign(new Error('duplicate'), { code: '23505' }));
      const result = await confirmMeetingFileUploadAction(VALID_INPUT);
      expect(result).toEqual({ success: false, error: 'This file was already shared.' });
      expect(log.warn).toHaveBeenCalledWith(
        'Duplicate meeting file confirm (expected double-click)',
        expect.objectContaining({
          meetingId: MEETING_ID,
          userId: USER_ID,
          fileKeyLeaf: FILE_UUID,
        })
      );
      expect(log.error).not.toHaveBeenCalled();
    });

    it('maps any other failure to generic copy at ERROR', async () => {
      mockSend.mockRejectedValue(new Error('R2 down'));
      const result = await confirmMeetingFileUploadAction(VALID_INPUT);
      expect(result).toEqual({
        success: false,
        error: 'Could not share your file. Please try again.',
      });
      expect(log.error).toHaveBeenCalledWith(
        'Failed to confirm meeting file upload',
        expect.objectContaining({ error: 'R2 down' })
      );
    });

    /**
     * ⚠⚠ THE FULL `r2Key` NEVER REACHES A LOG — AT WARN OR ERROR, not just at info. The whole
     * key spells out the meeting id and the uploader's user id and is a directly usable
     * storage path; the leaf is a fresh random uuid that correlates two lines about the same
     * object and reveals nothing else. Both fields are asserted absent by NAME and by VALUE,
     * so renaming the field does not silently reinstate the leak.
     */
    it.each([
      {
        label: 'the duplicate WARN',
        arrange: () =>
          mockAdd.mockRejectedValue(Object.assign(new Error('dup'), { code: '23505' })),
        level: 'warn' as const,
      },
      {
        label: 'the generic ERROR',
        arrange: () => mockSend.mockRejectedValue(new Error('R2 down')),
        level: 'error' as const,
      },
    ])('never logs the full r2Key in $label', async ({ arrange, level }) => {
      arrange();
      await confirmMeetingFileUploadAction(VALID_INPUT);

      const fields = vi.mocked(log[level]).mock.calls.at(-1)?.[1] as Record<string, unknown>;
      expect(fields).not.toHaveProperty('key');
      expect(fields).not.toHaveProperty('r2Key');
      expect(Object.values(fields)).not.toContain(KEY);
      expect(fields.fileKeyLeaf).toBe(FILE_UUID);
    });
  });
});
