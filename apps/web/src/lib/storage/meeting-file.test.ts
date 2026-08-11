import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

const { mockSend, mockGetSignedUrl, mockWarn } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  mockGetSignedUrl: vi.fn(),
  mockWarn: vi.fn(),
}));

vi.mock('@/lib/storage/r2', () => ({
  r2Client: { send: mockSend },
  R2_BUCKET: 'test-bucket',
  R2_PUBLIC_URL: 'https://cdn.test',
}));

vi.mock('@aws-sdk/client-s3', () => ({
  PutObjectCommand: class {
    input: Record<string, unknown>;
    constructor(input: Record<string, unknown>) {
      this.input = input;
    }
  },
  GetObjectCommand: class {
    input: Record<string, unknown>;
    constructor(input: Record<string, unknown>) {
      this.input = input;
    }
  },
  DeleteObjectCommand: class {
    input: Record<string, unknown>;
    constructor(input: Record<string, unknown>) {
      this.input = input;
    }
  },
}));

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: (...args: unknown[]) => mockGetSignedUrl(...args),
}));

vi.mock('@/lib/logging', () => ({
  log: { info: vi.fn(), warn: mockWarn, error: vi.fn() },
}));

import {
  generateMeetingFileKey,
  meetingFileKeyPrefix,
  meetingFileKeyLeaf,
  createPresignedMeetingFileUpload,
  createPresignedMeetingFileDownload,
  deleteMeetingFileFromR2,
  MEETING_FILE_PREFIX,
  MEETING_ALLOWED_CONTENT_TYPES,
  MAX_MEETING_FILE_BYTES,
} from './meeting-file';

const MEETING_ID = 'a0000000-0000-4000-8000-000000000001';
const USER_ID = 'b0000000-0000-4000-8000-000000000002';
const SIZE_BYTES = 4096;

/** The shape the confirm action validates: three uuid segments under the prefix. */
const KEY_PATTERN = /^meeting-files\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/;

/** Extract the presign options argument (`{ expiresIn }`) from a `getSignedUrl` call. */
function expiresInOf(callIndex: number): number | undefined {
  const options = mockGetSignedUrl.mock.calls[callIndex]?.[2] as { expiresIn?: number } | undefined;
  return options?.expiresIn;
}

/** Extract the command argument from a `getSignedUrl` call. */
function commandInputOf(callIndex: number): Record<string, unknown> {
  const command = mockGetSignedUrl.mock.calls[callIndex]?.[1] as
    | { input: Record<string, unknown> }
    | undefined;
  return command?.input ?? {};
}

describe('meeting-file storage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('generateMeetingFileKey', () => {
    it('scopes the key to MEETING + uploader under the meeting-files prefix', () => {
      const key = generateMeetingFileKey(MEETING_ID, USER_ID);
      expect(key.startsWith(`${MEETING_FILE_PREFIX}${MEETING_ID}/${USER_ID}/`)).toBe(true);
    });

    it('matches the three-uuid shape the confirm action validates', () => {
      expect(KEY_PATTERN.test(generateMeetingFileKey(MEETING_ID, USER_ID))).toBe(true);
    });

    it('mints a fresh leaf per call (never a reusable tuple)', () => {
      expect(generateMeetingFileKey(MEETING_ID, USER_ID)).not.toBe(
        generateMeetingFileKey(MEETING_ID, USER_ID)
      );
    });

    /**
     * ⚠⚠ THE LOWERCASING IS LOAD-BEARING. `z.uuid()` accepts UPPERCASE hex and Postgres
     * resolves an uppercase uuid to the same row, so an uppercase `meetingId` passes both
     * validation and the gate — and would then mint a key that the confirm action's
     * `MEETING_FILE_KEY_PATTERN` (`[0-9a-f-]`, lowercase-only) REJECTS. The object would
     * already be in R2: unconfirmable, therefore unreachable by every read path and never
     * deleted. PERMANENTLY ORPHANED, with no error the uploader could act on.
     */
    it('LOWERCASES both uuids, so an uppercase id cannot mint an unconfirmable key', () => {
      const key = generateMeetingFileKey(MEETING_ID.toUpperCase(), USER_ID.toUpperCase());
      expect(key).toBe(`${MEETING_FILE_PREFIX}${MEETING_ID}/${USER_ID}/${meetingFileKeyLeaf(key)}`);
      expect(KEY_PATTERN.test(key)).toBe(true);
    });

    /**
     * ⚠ ONE DEFINITION OF THE PREFIX, CONSUMED BY BOTH SIDES. `confirm-meeting-file-upload.ts`
     * calls `meetingFileKeyPrefix` for its `startsWith` provenance check rather than
     * re-spelling the template, so the two sides normalise identically BY CONSTRUCTION.
     */
    it('builds the key on the SHARED prefix function', () => {
      const key = generateMeetingFileKey(MEETING_ID, USER_ID);
      expect(key.startsWith(meetingFileKeyPrefix(MEETING_ID, USER_ID))).toBe(true);
      expect(meetingFileKeyPrefix(MEETING_ID.toUpperCase(), USER_ID.toUpperCase())).toBe(
        meetingFileKeyPrefix(MEETING_ID, USER_ID)
      );
    });
  });

  describe('meetingFileKeyLeaf', () => {
    /**
     * ⚠ AN `r2Key` NEVER GOES TO A LOG WHOLE, at any level: it spells out the meeting id AND
     * the uploader's user id in plain text and is a directly usable storage path. The leaf is
     * a fresh random uuid — it correlates two lines about the same object and nothing more.
     */
    it('returns only the random leaf, never the meeting or user segment', () => {
      const key = `${MEETING_FILE_PREFIX}${MEETING_ID}/${USER_ID}/c0000000-0000-4000-8000-000000000003`;
      const leaf = meetingFileKeyLeaf(key);
      expect(leaf).toBe('c0000000-0000-4000-8000-000000000003');
      expect(leaf).not.toContain(MEETING_ID);
      expect(leaf).not.toContain(USER_ID);
    });

    it('returns the whole string when there is no separator (degenerate, still total)', () => {
      expect(meetingFileKeyLeaf('abc')).toBe('abc');
    });
  });

  describe('re-exported constraints', () => {
    it('re-exports the allow-list and the 10 MB cap so server callers keep one import site', () => {
      expect(MEETING_ALLOWED_CONTENT_TYPES.has('application/pdf')).toBe(true);
      expect(MAX_MEETING_FILE_BYTES).toBe(10 * 1024 * 1024);
    });
  });

  describe('createPresignedMeetingFileUpload', () => {
    it('presigns an allowed content type and returns url + key', async () => {
      mockGetSignedUrl.mockResolvedValue('https://signed.example/put');
      const result = await createPresignedMeetingFileUpload(
        MEETING_ID,
        USER_ID,
        'text/csv',
        SIZE_BYTES
      );
      expect(result.presignedUrl).toBe('https://signed.example/put');
      expect(result.key.startsWith(`${MEETING_FILE_PREFIX}${MEETING_ID}/${USER_ID}/`)).toBe(true);
      expect(commandInputOf(0).ContentType).toBe('text/csv');
    });

    /**
     * ⚠⚠ THE CAP IS BOUND INTO THE SIGNATURE, NOT MERELY CHECKED AFTERWARDS. `ContentLength`
     * is a SIGNED header, so R2 rejects a body of any other length AT THE EDGE. Without it the
     * 10 MB cap would be advisory until the post-hoc HEAD at confirm — and the holder of one
     * valid presigned URL could park an arbitrarily large object in the bucket (billable, and
     * never confirmed, so unreachable by every read path and never deleted) simply by not
     * calling confirm.
     */
    it('BINDS ContentLength into the signature', async () => {
      mockGetSignedUrl.mockResolvedValue('https://signed.example/put');
      await createPresignedMeetingFileUpload(MEETING_ID, USER_ID, 'text/csv', SIZE_BYTES);
      expect(commandInputOf(0).ContentLength).toBe(SIZE_BYTES);
    });

    // ⚠ 60s is PINNED to the 10 MB cap — a larger cap would let a PUT outrun its signature.
    it('uses a 60-second upload TTL', async () => {
      mockGetSignedUrl.mockResolvedValue('https://signed.example/put');
      await createPresignedMeetingFileUpload(MEETING_ID, USER_ID, 'application/pdf', SIZE_BYTES);
      expect(expiresInOf(0)).toBe(60);
    });

    it('rejects a disallowed content type without presigning', async () => {
      await expect(
        createPresignedMeetingFileUpload(
          MEETING_ID,
          USER_ID,
          'application/x-msdownload',
          SIZE_BYTES
        )
      ).rejects.toThrow(/Invalid content type/);
      expect(mockGetSignedUrl).not.toHaveBeenCalled();
    });

    /**
     * ⚠ THE SIZE GUARD IS RESTATED IN THE MINTING FUNCTION even though the action checks it
     * first. A function that mints a credential must not depend on its caller having
     * validated; the action's check exists to produce friendly copy, this one exists so the
     * credential is never wrong.
     */
    it.each([
      { label: 'over the 10 MB cap', sizeBytes: MAX_MEETING_FILE_BYTES + 1 },
      { label: 'zero', sizeBytes: 0 },
      { label: 'negative', sizeBytes: -1 },
      { label: 'fractional', sizeBytes: 1.5 },
    ])('refuses to mint a credential for a $label length', async ({ sizeBytes }) => {
      await expect(
        createPresignedMeetingFileUpload(MEETING_ID, USER_ID, 'text/csv', sizeBytes)
      ).rejects.toThrow(/Invalid content length/);
      expect(mockGetSignedUrl).not.toHaveBeenCalled();
    });

    it('mints at exactly the cap (the boundary is inclusive)', async () => {
      mockGetSignedUrl.mockResolvedValue('https://signed.example/put');
      await createPresignedMeetingFileUpload(
        MEETING_ID,
        USER_ID,
        'text/csv',
        MAX_MEETING_FILE_BYTES
      );
      expect(commandInputOf(0).ContentLength).toBe(MAX_MEETING_FILE_BYTES);
    });
  });

  describe('createPresignedMeetingFileDownload', () => {
    it('presigns a GET with an attachment disposition carrying the stored name', async () => {
      mockGetSignedUrl.mockResolvedValue('https://signed.example/get');
      const url = await createPresignedMeetingFileDownload('k', 'deck.pdf');
      expect(url).toBe('https://signed.example/get');
      expect(commandInputOf(0).ResponseContentDisposition).toBe('attachment; filename="deck.pdf"');
      expect(commandInputOf(0).Bucket).toBe('test-bucket');
    });

    it('uses a 300-second download TTL (a leaked URL dies on its own)', async () => {
      mockGetSignedUrl.mockResolvedValue('https://signed.example/get');
      await createPresignedMeetingFileDownload('k', 'deck.pdf');
      expect(expiresInOf(0)).toBe(300);
    });

    it('strips quotes, backslashes and control chars from the stored file name', async () => {
      mockGetSignedUrl.mockResolvedValue('https://signed.example/get');
      // A crafted upload name carrying a quote, a backslash and a newline.
      const crafted = ['a', '"', 'b', '\\', 'c', '\n', 'd.pdf'].join('');
      await createPresignedMeetingFileDownload('k', crafted);
      expect(commandInputOf(0).ResponseContentDisposition).toBe(
        'attachment; filename="a_b_c_d.pdf"'
      );
    });
  });

  describe('deleteMeetingFileFromR2', () => {
    it('refuses to delete a key outside the meeting-files prefix', async () => {
      await deleteMeetingFileFromR2('conversation-files/x/y/z');
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('deletes a meeting-files key', async () => {
      mockSend.mockResolvedValue({});
      await deleteMeetingFileFromR2(`${MEETING_FILE_PREFIX}${MEETING_ID}/${USER_ID}/abc`);
      expect(mockSend).toHaveBeenCalledOnce();
    });

    // D3: a best-effort object delete must NEVER fail the row operation.
    it('warns (never throws) when the object delete fails', async () => {
      mockSend.mockRejectedValue(new Error('boom'));
      await expect(
        deleteMeetingFileFromR2(`${MEETING_FILE_PREFIX}${MEETING_ID}/${USER_ID}/abc`)
      ).resolves.toBeUndefined();
      expect(mockWarn).toHaveBeenCalledWith(
        'Failed to delete meeting file from R2',
        expect.objectContaining({ error: 'boom' })
      );
    });

    /** ⚠ THE LEAF, NEVER THE FULL KEY — the key spells out the meeting and the uploader. */
    it('logs only the key LEAF on failure, never the full r2Key', async () => {
      mockSend.mockRejectedValue(new Error('boom'));
      const key = `${MEETING_FILE_PREFIX}${MEETING_ID}/${USER_ID}/abc`;
      await deleteMeetingFileFromR2(key);

      const fields = mockWarn.mock.calls.at(-1)?.[1] as Record<string, unknown>;
      expect(fields).not.toHaveProperty('key');
      expect(Object.values(fields)).not.toContain(key);
      expect(fields.fileKeyLeaf).toBe('abc');
    });
  });
});
