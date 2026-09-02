import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

const { mockSend, mockWarn } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  mockWarn: vi.fn(),
}));

vi.mock('@/lib/storage/r2', () => ({
  r2Client: { send: mockSend },
  R2_BUCKET: 'test-bucket',
}));

vi.mock('@aws-sdk/client-s3', () => ({
  DeleteObjectCommand: class {
    input: Record<string, unknown>;
    constructor(input: Record<string, unknown>) {
      this.input = input;
    }
  },
}));

vi.mock('@/lib/logging', () => ({
  log: { info: vi.fn(), warn: mockWarn, error: vi.fn() },
}));

import { deletePrefixedObjectFromR2 } from './delete-prefixed-object';

const PREFIX = 'request-files/';
const SCOPE = 'request';

describe('deletePrefixedObjectFromR2', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockResolvedValue({});
  });

  it('deletes an in-prefix key from the configured bucket', async () => {
    await deletePrefixedObjectFromR2(`${PREFIX}req-1/user-1/file-1`, PREFIX, SCOPE);

    expect(mockSend).toHaveBeenCalledTimes(1);
    const [command] = mockSend.mock.calls[0] ?? [];
    expect((command as { input: Record<string, unknown> }).input).toEqual({
      Bucket: 'test-bucket',
      Key: `${PREFIX}req-1/user-1/file-1`,
    });
    expect(mockWarn).not.toHaveBeenCalled();
  });

  /**
   * ⚠ THE PREFIX GUARD MUST BE AUDIBLE. A key outside this scope's key space is never a normal
   * case — it is a bug or an attempt to steer a delete at another scope's objects — and a silent
   * `return` made it indistinguishable from a successful delete. This test fails if the
   * `log.warn` is removed, and equally if the guard stops short-circuiting the send.
   */
  it('warns and sends NOTHING for a key outside the allowed prefix', async () => {
    await deletePrefixedObjectFromR2('conversation-files/c-1/f-1', PREFIX, SCOPE);

    expect(mockSend).not.toHaveBeenCalled();
    expect(mockWarn).toHaveBeenCalledTimes(1);
    expect(mockWarn).toHaveBeenCalledWith(
      'Refused an R2 delete outside the allowed prefix',
      expect.objectContaining({
        key: 'conversation-files/c-1/f-1',
        allowedPrefix: PREFIX,
        scopeLabel: SCOPE,
      })
    );
  });

  /**
   * A prefix that appears LATER in the key is still out of scope — `startsWith`, never
   * `includes`. Otherwise `avatars/../request-files/x` would pass the guard.
   */
  it('warns for a key that merely CONTAINS the allowed prefix', async () => {
    await deletePrefixedObjectFromR2(`avatars/${PREFIX}x`, PREFIX, SCOPE);

    expect(mockSend).not.toHaveBeenCalled();
    expect(mockWarn).toHaveBeenCalledTimes(1);
  });

  /**
   * Best-effort by Ruling 1 — the tombstone plus the audit event are the record, so an R2
   * failure is logged and swallowed rather than thrown back at the caller's transaction.
   */
  it('swallows and logs an R2 failure rather than throwing', async () => {
    mockSend.mockRejectedValue(new Error('R2 unreachable'));

    await expect(
      deletePrefixedObjectFromR2(`${PREFIX}req-1/user-1/file-1`, PREFIX, SCOPE)
    ).resolves.toBeUndefined();

    expect(mockWarn).toHaveBeenCalledWith(
      `Failed to delete ${SCOPE} file from R2`,
      expect.objectContaining({ error: 'R2 unreachable' })
    );
  });
});
