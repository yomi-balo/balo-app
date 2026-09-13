import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NoObjectGeneratedError } from 'ai';
import { runProjectBriefParse, ProjectBriefParseError } from './parse.js';
import type { AiClient } from '../ai/index.js';
import type { BriefParseOutput } from './prompts.js';

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

/**
 * ⚠ A REAL KEY SHAPE (BAL-254 W9). Gate 3 now runs the SHARED
 * `isSessionOwnedProjectDocumentKey`, which checks `project-documents/{uuid}/{uuid}/{uuid}` —
 * not just the owner prefix — so the object segment has to be an actual uuid. Real keys always
 * are (`generateProjectDocumentKey` mints them with `crypto.randomUUID()`); the old `doc-1`
 * fixtures were only ever passing because the worker had no shape check.
 */
function ownerKey(index = 0): string {
  return `project-documents/${OWNER_COMPANY}/${OWNER_USER}/4444444${index}-4444-4444-4444-444444444444`;
}

function baseRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: PARSE_ID,
    companyId: OWNER_COMPANY,
    requestedByUserId: OWNER_USER,
    sourceDocuments: [
      {
        r2Key: ownerKey(),
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

/** A row whose single source document sits at `r2Key`. */
function rowWithKey(r2Key: string): Record<string, unknown> {
  return baseRow({
    sourceDocuments: [
      { r2Key, fileName: 'rfp.pdf', contentType: 'application/pdf', sizeBytes: 100 },
    ],
  });
}

/** Run one parse whose model returns {@link validModelOutput} merged with `overrides`. */
async function runWithModelOutput(overrides: Partial<BriefParseOutput>): Promise<void> {
  findById.mockResolvedValue(baseRow());
  const ai = fakeAi(
    vi.fn().mockResolvedValue({
      value: { ...validModelOutput, ...overrides },
      audit: { modelId: 'claude-opus-5', modelVersion: null, promptId: 'p', promptVersion: 'v1' },
      usage: { inputTokens: 10, outputTokens: 5 },
    })
  );
  await runProjectBriefParse(PARSE_ID, { ai });
}

/** Assert the persisted `result` contains `expected`. */
function expectPersistedResult(expected: Record<string, unknown>): void {
  expect(markSucceeded).toHaveBeenCalledWith(
    expect.objectContaining({ result: expect.objectContaining(expected) })
  );
}

function fakeAi(generateObjectImpl: AiClient['generateObject']): AiClient {
  return {
    generateText: vi.fn(),
    generateObject: generateObjectImpl,
  };
}

const validModelOutput: BriefParseOutput = {
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
    findById.mockResolvedValue(rowWithKey('project-documents/other-co/other-user/doc-1'));
    await expect(runProjectBriefParse(PARSE_ID, { ai: fakeAi(vi.fn()) })).rejects.toMatchObject({
      reason: 'unreadable',
    });
  });

  /**
   * BAL-254 W9 — Gate 3 now runs the SHARED predicate, which checks the key's SHAPE as well as
   * its owner prefix. The old worker-local `startsWith` accepted anything appended after the
   * prefix, so this key passed it.
   */
  it('⚠ the prefix re-guard rejects a traversal tail under a legitimate owner prefix', async () => {
    findById.mockResolvedValue(
      rowWithKey(`project-documents/${OWNER_COMPANY}/${OWNER_USER}/../../secret`)
    );
    await expect(runProjectBriefParse(PARSE_ID, { ai: fakeAi(vi.fn()) })).rejects.toMatchObject({
      reason: 'unreadable',
    });
    expect(headR2ObjectSize).not.toHaveBeenCalled();
  });

  it('rejects when the declared byte total exceeds the cap', async () => {
    findById.mockResolvedValue(
      baseRow({
        sourceDocuments: [
          {
            r2Key: ownerKey(),
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
          r2Key: ownerKey(index),
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
      // ⚠ 4 MiB EACH, i.e. UNDER the 5 MB per-file cap (BAL-254 W3) — otherwise the per-file
      // check refuses the first document and this test stops exercising the running total at
      // all. 4 + 4 = 8 MiB is fine; the third breaches the 10 MiB ceiling.
      findById.mockResolvedValue(rowWithDocuments(4, 1024));
      headR2ObjectSize.mockResolvedValue(4 * 1024 * 1024);

      await expect(runProjectBriefParse(PARSE_ID, { ai: fakeAi(vi.fn()) })).rejects.toMatchObject({
        reason: 'too_large',
      });
      expect(headR2ObjectSize).toHaveBeenCalledTimes(3);
      expect(getR2ObjectBytes).not.toHaveBeenCalled();
    });

    /**
     * BAL-254 W3 — the per-file cap, which the running total alone never enforced. 9 MiB is
     * under `MAX_PARSE_INPUT_BYTES` (10 MiB), so the ONLY thing that can refuse it is the
     * per-file check against R2's own `ContentLength`.
     */
    it('⚠ ONE object over the 5 MB per-file cap is refused even though the 10 MB total is not breached', async () => {
      findById.mockResolvedValue(rowWithDocuments(1, 1024));
      headR2ObjectSize.mockResolvedValue(9 * 1024 * 1024);

      await expect(runProjectBriefParse(PARSE_ID, { ai: fakeAi(vi.fn()) })).rejects.toMatchObject({
        reason: 'too_large',
      });
      expect(getR2ObjectBytes).not.toHaveBeenCalled();
    });

    it('a document exactly at the per-file cap is accepted', async () => {
      findById.mockResolvedValue(rowWithDocuments(1, 1024));
      headR2ObjectSize.mockResolvedValue(5 * 1024 * 1024);
      getR2ObjectBytes.mockResolvedValue(new Uint8Array([1, 2, 3]));
      const ai = fakeAi(
        vi.fn().mockResolvedValue({
          value: validModelOutput,
          audit: {
            modelId: 'claude-opus-5',
            modelVersion: null,
            promptId: 'p',
            promptVersion: 'v1',
          },
          usage: { inputTokens: 10, outputTokens: 5 },
        })
      );
      await runProjectBriefParse(PARSE_ID, { ai });
      expect(markSucceeded).toHaveBeenCalled();
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

  /**
   * BAL-254 W8 — the enqueue race. `postBaloApiJson` times out AFTER the api enqueued, so the web
   * action wins the CAS with `enqueue_failed` while this job is already reading R2. Without the
   * pre-call re-read the worker ran the whole parse and burned a paid Opus call whose result
   * `markSucceeded` then discarded on the CAS.
   */
  it('⚠ bails BEFORE the model call when the row went terminal mid-parse (the enqueue race)', async () => {
    findById
      .mockResolvedValueOnce(baseRow())
      .mockResolvedValueOnce(baseRow({ completedAt: new Date(), failureReason: 'enqueue_failed' }));
    const ai = fakeAi(vi.fn());

    await runProjectBriefParse(PARSE_ID, { ai });

    // The R2 work happened (it precedes the re-read) — the PAID call did not.
    expect(getR2ObjectBytes).toHaveBeenCalled();
    expect(ai.generateObject).not.toHaveBeenCalled();
    expect(markSucceeded).not.toHaveBeenCalled();
  });

  it('bails before the model call when the row disappeared mid-parse', async () => {
    findById.mockResolvedValueOnce(baseRow()).mockResolvedValueOnce(undefined);
    const ai = fakeAi(vi.fn());
    await runProjectBriefParse(PARSE_ID, { ai });
    expect(ai.generateObject).not.toHaveBeenCalled();
  });

  /**
   * BAL-254 W4 — the footnote is derived from the ACTUAL mapping failures. `crm-analytics` is not
   * in the live taxonomy AND the model did not self-report it; before this it was dropped by
   * `mapSlugsToIds` and nothing anywhere told the user.
   */
  it('⚠ a slug that misses the taxonomy and is NOT self-reported still reaches unmatchedTagLabels', async () => {
    await runWithModelOutput({ tagSlugs: ['data-migration', 'crm-analytics'] });
    expectPersistedResult({ tagIds: ['tag-id-1'], unmatchedTagLabels: ['Crm analytics'] });
  });

  it("the model's own self-reported labels survive alongside the derived ones", async () => {
    await runWithModelOutput({
      tagSlugs: ['crm-analytics'],
      unmatchedTagLabels: ['Sandbox refresh'],
    });
    expectPersistedResult({ unmatchedTagLabels: ['Crm analytics', 'Sandbox refresh'] });
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
