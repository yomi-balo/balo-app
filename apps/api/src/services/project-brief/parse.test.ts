import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NoObjectGeneratedError } from 'ai';
import { runProjectBriefParse, ProjectBriefParseError } from './parse.js';
import type { AiClient } from '../ai/index.js';

const findById = vi.fn();
const markSucceeded = vi.fn();
const markFailed = vi.fn();
const getSalesforceVertical = vi.fn();
const getProjectTagsByVertical = vi.fn();
const getProductsByVertical = vi.fn();
const getR2ObjectBytes = vi.fn();
const headR2ObjectSize = vi.fn();

vi.mock('@balo/db', () => ({
  projectBriefParsesRepository: {
    findById: (...args: unknown[]) => findById(...args),
    markSucceeded: (...args: unknown[]) => markSucceeded(...args),
    markFailed: (...args: unknown[]) => markFailed(...args),
  },
  referenceDataRepository: {
    getSalesforceVertical: (...args: unknown[]) => getSalesforceVertical(...args),
    getProjectTagsByVertical: (...args: unknown[]) => getProjectTagsByVertical(...args),
    getProductsByVertical: (...args: unknown[]) => getProductsByVertical(...args),
  },
}));

vi.mock('../../lib/storage/r2.js', () => ({
  getR2ObjectBytes: (...args: unknown[]) => getR2ObjectBytes(...args),
  headR2ObjectSize: (...args: unknown[]) => headR2ObjectSize(...args),
}));

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const OWNER_COMPANY = '11111111-1111-1111-1111-111111111111';
const OWNER_USER = '22222222-2222-2222-2222-222222222222';
const PARSE_ID = '33333333-3333-3333-3333-333333333333';

function baseRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: PARSE_ID,
    companyId: OWNER_COMPANY,
    requestedByUserId: OWNER_USER,
    sourceDocuments: [
      {
        r2Key: `project-documents/${OWNER_COMPANY}/${OWNER_USER}/doc-1`,
        fileName: 'rfp.pdf',
        contentType: 'application/pdf',
        sizeBytes: 100,
      },
    ],
    result: null,
    failureReason: null,
    completedAt: null,
    ...overrides,
  };
}

function fakeAi(generateObjectImpl: AiClient['generateObject']): AiClient {
  return {
    generateText: vi.fn(),
    generateObject: generateObjectImpl,
  };
}

const validModelOutput = {
  title: 'A drafted title',
  descriptionMarkdown: 'A drafted description.',
  tagSlugs: ['data-migration'],
  productSlugs: [],
  unmatchedTagLabels: [],
  unmatchedProductLabels: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  getSalesforceVertical.mockResolvedValue({ id: 'vertical-1' });
  getProjectTagsByVertical.mockResolvedValue([
    {
      group: { id: 'g1', name: 'Group', slug: 'group', sortOrder: 0 },
      tags: [{ id: 'tag-id-1', name: 'Data Migration', slug: 'data-migration', sortOrder: 0 }],
    },
  ]);
  getProductsByVertical.mockResolvedValue([]);
  getR2ObjectBytes.mockResolvedValue(new Uint8Array([1, 2, 3]));
  headR2ObjectSize.mockResolvedValue(3);
});

describe('runProjectBriefParse', () => {
  it('an already-terminal row is a silent no-op', async () => {
    findById.mockResolvedValue(baseRow({ completedAt: new Date() }));
    const ai = fakeAi(vi.fn());
    await runProjectBriefParse(PARSE_ID, { ai });
    expect(ai.generateObject).not.toHaveBeenCalled();
    expect(markSucceeded).not.toHaveBeenCalled();
  });

  it('a missing row throws a non-retryable ProjectBriefParseError', async () => {
    findById.mockResolvedValue(undefined);
    await expect(runProjectBriefParse(PARSE_ID, { ai: fakeAi(vi.fn()) })).rejects.toThrow(
      ProjectBriefParseError
    );
  });

  it('the worker-side prefix re-guard rejects a source document key outside the ROW owner scope', async () => {
    findById.mockResolvedValue(
      baseRow({
        sourceDocuments: [
          {
            r2Key: 'project-documents/some-other-company/some-other-user/doc-1',
            fileName: 'rfp.pdf',
            contentType: 'application/pdf',
            sizeBytes: 100,
          },
        ],
      })
    );
    await expect(runProjectBriefParse(PARSE_ID, { ai: fakeAi(vi.fn()) })).rejects.toMatchObject({
      reason: 'unreadable',
    });
  });

  it('rejects when the declared byte total exceeds the cap', async () => {
    findById.mockResolvedValue(
      baseRow({
        sourceDocuments: [
          {
            r2Key: `project-documents/${OWNER_COMPANY}/${OWNER_USER}/doc-1`,
            fileName: 'big.pdf',
            contentType: 'application/pdf',
            sizeBytes: 20 * 1024 * 1024,
          },
        ],
      })
    );
    await expect(runProjectBriefParse(PARSE_ID, { ai: fakeAi(vi.fn()) })).rejects.toMatchObject({
      reason: 'too_large',
    });
  });

  it('an R2 read failure maps to `unreadable`', async () => {
    findById.mockResolvedValue(baseRow());
    getR2ObjectBytes.mockRejectedValue(new Error('boom'));
    await expect(runProjectBriefParse(PARSE_ID, { ai: fakeAi(vi.fn()) })).rejects.toMatchObject({
      reason: 'unreadable',
    });
  });

  // ── F1 — the memory-exhaustion DoS. `sizeBytes` is client-supplied; R2's HEAD is not. ──────
  describe('the real-size gate (fix round F1)', () => {
    /** A row with `count` owner-scoped documents, each DECLARING `sizeBytes`. */
    function rowWithDocuments(count: number, sizeBytes: number): Record<string, unknown> {
      return baseRow({
        sourceDocuments: Array.from({ length: count }, (_, index) => ({
          r2Key: `project-documents/${OWNER_COMPANY}/${OWNER_USER}/doc-${index}`,
          fileName: `doc-${index}.pdf`,
          contentType: 'application/pdf',
          sizeBytes,
        })),
      });
    }

    it('⚠ a document whose DECLARED size understates its REAL size is rejected BEFORE any read', async () => {
      // The exploit: presign → PUT 2 GB to your own legitimate key → never confirm → start a
      // parse declaring a kilobyte. Both tenant gates pass honestly; only R2's own HEAD does not.
      findById.mockResolvedValue(rowWithDocuments(1, 1024));
      headR2ObjectSize.mockResolvedValue(2 * 1024 * 1024 * 1024);

      await expect(runProjectBriefParse(PARSE_ID, { ai: fakeAi(vi.fn()) })).rejects.toMatchObject({
        reason: 'too_large',
      });
      expect(headR2ObjectSize).toHaveBeenCalledTimes(1);
      // THE ASSERTION THAT MATTERS: not one byte was pulled into memory.
      expect(getR2ObjectBytes).not.toHaveBeenCalled();
    });

    it('the HEAD total is a RUNNING one — it trips mid-list, not after every HEAD', async () => {
      findById.mockResolvedValue(rowWithDocuments(4, 1024));
      headR2ObjectSize.mockResolvedValue(6 * 1024 * 1024);

      await expect(runProjectBriefParse(PARSE_ID, { ai: fakeAi(vi.fn()) })).rejects.toMatchObject({
        reason: 'too_large',
      });
      expect(headR2ObjectSize).toHaveBeenCalledTimes(2);
      expect(getR2ObjectBytes).not.toHaveBeenCalled();
    });

    it('a HEAD failure maps to `unreadable`', async () => {
      findById.mockResolvedValue(baseRow());
      headR2ObjectSize.mockRejectedValue(new Error('boom'));
      await expect(runProjectBriefParse(PARSE_ID, { ai: fakeAi(vi.fn()) })).rejects.toMatchObject({
        reason: 'unreadable',
      });
      expect(getR2ObjectBytes).not.toHaveBeenCalled();
    });

    it('⚠ a LYING HEAD cannot defeat the cap — the post-read check fires INSIDE the read loop', async () => {
      // HEAD reports a kilobyte per file; every GET actually returns 6 MiB. With three documents
      // a post-LOOP check would read all three (18 MiB) before objecting; the in-loop check stops
      // after the second, the first moment the running total breaches 10 MiB.
      findById.mockResolvedValue(rowWithDocuments(3, 1024));
      headR2ObjectSize.mockResolvedValue(1024);
      getR2ObjectBytes.mockResolvedValue(new Uint8Array(6 * 1024 * 1024));

      await expect(runProjectBriefParse(PARSE_ID, { ai: fakeAi(vi.fn()) })).rejects.toMatchObject({
        reason: 'too_large',
      });
      expect(getR2ObjectBytes).toHaveBeenCalledTimes(2);
    });
  });

  it('the usable-output floor rejects a too-short title with `empty_extraction`', async () => {
    findById.mockResolvedValue(baseRow());
    const ai = fakeAi(
      vi.fn().mockResolvedValue({
        value: { ...validModelOutput, title: 'ab' },
        audit: { modelId: 'claude-opus-5', modelVersion: null, promptId: 'p', promptVersion: 'v1' },
        usage: { inputTokens: 10, outputTokens: 5 },
      })
    );
    await expect(runProjectBriefParse(PARSE_ID, { ai })).rejects.toMatchObject({
      reason: 'empty_extraction',
    });
  });

  it('an invalid structured output (NoObjectGeneratedError) is RETRYABLE (not a ProjectBriefParseError)', async () => {
    findById.mockResolvedValue(baseRow());
    const ai = fakeAi(
      vi.fn().mockRejectedValue(
        new NoObjectGeneratedError({
          response: { id: 'r1', timestamp: new Date(), modelId: 'claude-opus-5' },
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          finishReason: 'stop',
        } as never)
      )
    );
    await expect(runProjectBriefParse(PARSE_ID, { ai })).rejects.toBeInstanceOf(
      NoObjectGeneratedError
    );
    expect(markFailed).not.toHaveBeenCalled();
  });

  it('happy path: slug→id mapping reaches markSucceeded', async () => {
    findById.mockResolvedValue(baseRow());
    const ai = fakeAi(
      vi.fn().mockResolvedValue({
        value: validModelOutput,
        audit: { modelId: 'claude-opus-5', modelVersion: null, promptId: 'p', promptVersion: 'v1' },
        usage: { inputTokens: 10, outputTokens: 5 },
      })
    );
    await runProjectBriefParse(PARSE_ID, { ai });

    expect(markSucceeded).toHaveBeenCalledWith(
      expect.objectContaining({
        parseId: PARSE_ID,
        result: expect.objectContaining({
          title: 'A drafted title',
          tagIds: ['tag-id-1'],
          productIds: [],
        }),
      })
    );
  });
});
