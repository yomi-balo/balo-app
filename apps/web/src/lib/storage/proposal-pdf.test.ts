import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));

vi.mock('@/lib/storage/r2', () => ({
  r2Client: { send: mockSend },
  R2_BUCKET: 'test-bucket',
  R2_PUBLIC_URL: 'https://cdn.test',
}));

vi.mock('@aws-sdk/client-s3', () => ({
  GetObjectCommand: class {
    input: Record<string, unknown>;
    constructor(input: Record<string, unknown>) {
      this.input = input;
    }
  },
  PutObjectCommand: class {
    input: Record<string, unknown>;
    constructor(input: Record<string, unknown>) {
      this.input = input;
    }
  },
}));

import {
  PROPOSAL_PDF_LAYOUT_VERSION,
  PROPOSAL_PDF_PREFIX,
  proposalPdfKey,
  getProposalPdfFromR2,
  putProposalPdfToR2,
} from './proposal-pdf';

const PROPOSAL_ID = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('proposalPdfKey', () => {
  it('is a deterministic layout-versioned key under the proposals prefix', () => {
    const key = proposalPdfKey(PROPOSAL_ID);
    expect(key).toBe(`proposals/${PROPOSAL_ID}/client-v2.pdf`);
    expect(key.startsWith(PROPOSAL_PDF_PREFIX)).toBe(true);
  });

  it('carries the layout version, so a layout change orphans the old object instead of serving it', () => {
    // BAL-392 (F3): the download route is a read-through cache. If the key did not
    // move with the layout, every already-generated PDF would serve the retired
    // two-item banner forever.
    expect(PROPOSAL_PDF_LAYOUT_VERSION).toBe('v2');
    expect(proposalPdfKey(PROPOSAL_ID)).toContain(`/client-${PROPOSAL_PDF_LAYOUT_VERSION}.pdf`);
    expect(proposalPdfKey(PROPOSAL_ID)).not.toBe(`proposals/${PROPOSAL_ID}/client.pdf`);
  });
});

describe('getProposalPdfFromR2', () => {
  it('returns the bytes on a cache hit', async () => {
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // %PDF
    mockSend.mockResolvedValue({ Body: { transformToByteArray: () => Promise.resolve(bytes) } });

    const result = await getProposalPdfFromR2(proposalPdfKey(PROPOSAL_ID));
    expect(result).toEqual(bytes);
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('returns null on a NoSuchKey miss', async () => {
    mockSend.mockRejectedValue(Object.assign(new Error('missing'), { name: 'NoSuchKey' }));
    expect(await getProposalPdfFromR2(proposalPdfKey(PROPOSAL_ID))).toBeNull();
  });

  it('returns null on a 404 $metadata miss', async () => {
    mockSend.mockRejectedValue(
      Object.assign(new Error('nope'), { $metadata: { httpStatusCode: 404 } })
    );
    expect(await getProposalPdfFromR2(proposalPdfKey(PROPOSAL_ID))).toBeNull();
  });

  it('returns null (no read) for a key outside the proposal prefix', async () => {
    expect(await getProposalPdfFromR2('other-space/x.pdf')).toBeNull();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('returns null when the object has no Body', async () => {
    mockSend.mockResolvedValue({ Body: undefined });
    expect(await getProposalPdfFromR2(proposalPdfKey(PROPOSAL_ID))).toBeNull();
  });

  it('rethrows a non-not-found (transient) error rather than masking it as a miss', async () => {
    mockSend.mockRejectedValue(
      Object.assign(new Error('timeout'), { $metadata: { httpStatusCode: 503 } })
    );
    await expect(getProposalPdfFromR2(proposalPdfKey(PROPOSAL_ID))).rejects.toThrow('timeout');
  });
});

describe('putProposalPdfToR2', () => {
  it('writes application/pdf bytes to the given key', async () => {
    mockSend.mockResolvedValue({});
    const body = new Uint8Array([1, 2, 3]);
    await putProposalPdfToR2(proposalPdfKey(PROPOSAL_ID), body);

    expect(mockSend).toHaveBeenCalledTimes(1);
    const command = mockSend.mock.calls[0]?.[0] as { input: Record<string, unknown> };
    expect(command.input).toMatchObject({
      Bucket: 'test-bucket',
      Key: `proposals/${PROPOSAL_ID}/client-v2.pdf`,
      Body: body,
      ContentType: 'application/pdf',
    });
  });

  it('refuses to write a key outside the proposal prefix', async () => {
    await expect(putProposalPdfToR2('other-space/x.pdf', new Uint8Array())).rejects.toThrow(
      /outside proposal PDF space/
    );
    expect(mockSend).not.toHaveBeenCalled();
  });
});
