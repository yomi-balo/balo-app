import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

/**
 * BAL-431 — the R2 boundary for the FIFTH file scope. Every control this feature has at the
 * object layer lives in `request-file.ts`: the key template, both TTLs, the
 * `Content-Disposition` sanitiser, the `ContentLength` condition on the presigned PUT, and the
 * prefix guard on delete. Mirrors `meeting-file.test.ts`, which is the shipped template.
 *
 * ⚠ THIS FILE ALSO GUARDS REVIEWABILITY. The sanitiser's character class used to be written
 * with RAW `0x00`/`0x1f` bytes, which made git classify the whole module as BINARY — GitHub
 * rendered "Binary file not shown" and every control above escaped diff review. The class is
 * now `\x00-\x1f` escapes; if it ever regresses, the `strips … control chars` case below still
 * passes (the behaviour was always fine), so the real defence is `pnpm format:check` plus this
 * comment. Do not paste raw control characters back in.
 */

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
  REQUEST_FILE_PREFIX,
  MAX_REQUEST_FILE_BYTES,
  generateRequestFileKey,
  createPresignedRequestFileUpload,
  createPresignedRequestFileDownload,
  deleteRequestFileFromR2,
} from './request-file';

const REQUEST_ID = 'a0000000-0000-4000-8000-000000000001';
const USER_ID = 'b0000000-0000-4000-8000-000000000002';
const SIZE_BYTES = 24_576;

/** The shape the confirm action validates: prefix + two uuids + a uuid leaf. */
const KEY_PATTERN = /^request-files\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/;

function expiresInOf(callIndex: number): number | undefined {
  const options = mockGetSignedUrl.mock.calls[callIndex]?.[2] as { expiresIn?: number } | undefined;
  return options?.expiresIn;
}

function commandInputOf(callIndex: number): Record<string, unknown> {
  const command = mockGetSignedUrl.mock.calls[callIndex]?.[1] as
    | { input: Record<string, unknown> }
    | undefined;
  return command?.input ?? {};
}

describe('request-file storage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('generateRequestFileKey', () => {
    /**
     * ⚠ THE FIRST SEGMENT IS THE REQUEST, NOT A CONVERSATION — the deliberate key-layout break
     * a request-grain file forces. The confirm action re-derives segments 2 and 3 from the GATE
     * and the SESSION, so this shape IS the provenance check's contract.
     */
    it('mints `request-files/{requestId}/{userId}/{uuid}`', () => {
      const key = generateRequestFileKey(REQUEST_ID, USER_ID);
      expect(key).toMatch(KEY_PATTERN);
      const [prefix, keyRequestId, keyUserId, leaf, ...extra] = key.split('/');
      expect(`${prefix}/`).toBe(REQUEST_FILE_PREFIX);
      expect(keyRequestId).toBe(REQUEST_ID);
      expect(keyUserId).toBe(USER_ID);
      expect(leaf).not.toBe(USER_ID);
      expect(extra).toEqual([]);
    });

    it('never repeats a key', () => {
      const a = generateRequestFileKey(REQUEST_ID, USER_ID);
      const b = generateRequestFileKey(REQUEST_ID, USER_ID);
      expect(a).not.toBe(b);
    });

    /** ⚠ THE AUDIENCE IS NOT IN THE KEY. Audience is revocable; an R2 key is permanent. */
    it('encodes no audience or relationship in the key', () => {
      const key = generateRequestFileKey(REQUEST_ID, USER_ID);
      for (const forbidden of ['all_live_tracks', 'grants', 'own_track', 'client', 'expert']) {
        expect(key).not.toContain(forbidden);
      }
    });
  });

  describe('createPresignedRequestFileUpload', () => {
    it('uses a 60-second upload TTL', async () => {
      mockGetSignedUrl.mockResolvedValue('https://signed.example/put');
      await createPresignedRequestFileUpload(REQUEST_ID, USER_ID, 'application/pdf', SIZE_BYTES);
      expect(expiresInOf(0)).toBe(60);
    });

    /**
     * ⚠⚠ THE SIZE IS SIGNED INTO THE URL. `ContentLength` is a SIGNED header for an S3
     * presigned PUT, so R2 refuses a body of any other length at the edge. Without it the only
     * enforcement of `MAX_REQUEST_FILE_BYTES` is the confirm step's `HeadObject`, which an
     * attacker simply never calls — leaving unbounded, unattributed, never-reaped objects
     * under `request-files/`.
     */
    it('binds the signature to an exact ContentLength', async () => {
      mockGetSignedUrl.mockResolvedValue('https://signed.example/put');
      await createPresignedRequestFileUpload(REQUEST_ID, USER_ID, 'application/pdf', SIZE_BYTES);
      expect(commandInputOf(0)).toMatchObject({
        Bucket: 'test-bucket',
        ContentType: 'application/pdf',
        ContentLength: SIZE_BYTES,
      });
    });

    it('refuses a size above the cap, without signing anything', async () => {
      await expect(
        createPresignedRequestFileUpload(
          REQUEST_ID,
          USER_ID,
          'application/pdf',
          MAX_REQUEST_FILE_BYTES + 1
        )
      ).rejects.toThrow('Invalid upload size');
      expect(mockGetSignedUrl).not.toHaveBeenCalled();
    });

    it('refuses a zero or fractional size, without signing anything', async () => {
      await expect(
        createPresignedRequestFileUpload(REQUEST_ID, USER_ID, 'application/pdf', 0)
      ).rejects.toThrow('Invalid upload size');
      await expect(
        createPresignedRequestFileUpload(REQUEST_ID, USER_ID, 'application/pdf', 1.5)
      ).rejects.toThrow('Invalid upload size');
      expect(mockGetSignedUrl).not.toHaveBeenCalled();
    });

    it('refuses a content type outside the allow-list, without signing anything', async () => {
      await expect(
        createPresignedRequestFileUpload(
          REQUEST_ID,
          USER_ID,
          'application/x-msdownload',
          SIZE_BYTES
        )
      ).rejects.toThrow('Invalid content type');
      expect(mockGetSignedUrl).not.toHaveBeenCalled();
    });
  });

  describe('createPresignedRequestFileDownload', () => {
    it('uses a 300-second download TTL (a leaked URL dies on its own)', async () => {
      mockGetSignedUrl.mockResolvedValue('https://signed.example/get');
      await createPresignedRequestFileDownload('k', 'brief.pdf');
      expect(expiresInOf(0)).toBe(300);
    });

    it('forces an attachment disposition', async () => {
      mockGetSignedUrl.mockResolvedValue('https://signed.example/get');
      await createPresignedRequestFileDownload('k', 'brief.pdf');
      expect(commandInputOf(0).ResponseContentDisposition).toBe('attachment; filename="brief.pdf"');
    });

    /**
     * ⚠ HEADER INJECTION VIA THE STORED FILE NAME. A quote closes the `filename="…"` value; a
     * CR or LF splits the header outright. All of them, plus the backslash, become `_`.
     */
    it('strips quotes, backslashes, CR and LF from the stored file name', async () => {
      mockGetSignedUrl.mockResolvedValue('https://signed.example/get');
      const crafted = ['a', '"', 'b', '\\', 'c', '\r', '\n', 'd.pdf'].join('');
      await createPresignedRequestFileDownload('k', crafted);
      expect(commandInputOf(0).ResponseContentDisposition).toBe(
        'attachment; filename="a_b_c__d.pdf"'
      );
    });

    /**
     * BOTH ENDS OF THE C0 RANGE, BUILT FROM CHAR CODES rather than pasted as raw bytes —
     * pasting them is exactly what made the module itself unreviewable (git classified it as
     * binary). NUL and US are the two boundaries of the `\\x00-\\x1f` class.
     */
    it('strips the NUL and the far end of the C0 control range', async () => {
      mockGetSignedUrl.mockResolvedValue('https://signed.example/get');
      const crafted = `a${String.fromCharCode(0)}b${String.fromCharCode(0x1f)}c.pdf`;
      await createPresignedRequestFileDownload('k', crafted);
      expect(commandInputOf(0).ResponseContentDisposition).toBe('attachment; filename="a_b_c.pdf"');
    });

    it('leaves an ordinary name untouched', async () => {
      mockGetSignedUrl.mockResolvedValue('https://signed.example/get');
      await createPresignedRequestFileDownload('k', 'Requirements v2 (final).pdf');
      expect(commandInputOf(0).ResponseContentDisposition).toBe(
        'attachment; filename="Requirements v2 (final).pdf"'
      );
    });
  });

  describe('deleteRequestFileFromR2', () => {
    /**
     * ⚠ THE PREFIX GUARD, AND IT IS THIS SCOPE'S OWN — never widened onto
     * `deleteConversationFileFromR2`'s (OSD-4: one implementation, two guards). A guard that
     * accepts two key spaces protects neither.
     */
    it('refuses to delete a key outside the request-files prefix', async () => {
      await deleteRequestFileFromR2('conversation-files/x/y/z');
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('refuses a meeting-files key too', async () => {
      await deleteRequestFileFromR2('meeting-files/x/y/z');
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('deletes a request-files key', async () => {
      mockSend.mockResolvedValue({});
      await deleteRequestFileFromR2(`${REQUEST_FILE_PREFIX}${REQUEST_ID}/${USER_ID}/abc`);
      expect(mockSend).toHaveBeenCalledOnce();
    });

    /** A best-effort object delete must NEVER fail the row operation (Ruling 1's ordering). */
    it('warns (never throws) when the object delete fails', async () => {
      mockSend.mockRejectedValue(new Error('boom'));
      await expect(
        deleteRequestFileFromR2(`${REQUEST_FILE_PREFIX}${REQUEST_ID}/${USER_ID}/abc`)
      ).resolves.toBeUndefined();
      expect(mockWarn).toHaveBeenCalledWith(
        expect.stringContaining('request'),
        expect.objectContaining({ error: 'boom' })
      );
    });
  });
});
