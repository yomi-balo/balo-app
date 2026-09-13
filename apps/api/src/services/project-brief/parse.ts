import { NoObjectGeneratedError, TypeValidationError } from 'ai';
import { projectBriefParsesRepository, referenceDataRepository } from '@balo/db';
import {
  MAX_PARSE_INPUT_BYTES,
  type ProjectBriefFailureReason,
} from '@balo/shared/project-requests';
import { createLogger } from '@balo/shared/logging';
import { getR2ObjectBytes, headR2ObjectSize } from '../../lib/storage/r2.js';
import { AiModelNotAllowedError, LlmOutputTruncatedError, type AiClient } from '../ai/index.js';
import {
  resolveProjectBriefModel,
  PROJECT_BRIEF_MAX_OUTPUT_TOKENS,
  PROJECT_BRIEF_BUDGET_INPUT_TOKENS,
} from './config.js';
import { briefParsePrompt, briefParseOutputSchema, type BriefParseOutput } from './prompts.js';
import { buildTaxonomyChoices, mapSlugsToIds } from './taxonomy-mapping.js';
import { projectBriefNoopResult } from './noop-fallback.js';

const log = createLogger('project-brief-parse');

/** The `project-documents/{companyId}/{userId}/` prefix a source document key must start with. */
function ownerPrefix(companyId: string, requestedByUserId: string): string {
  return `project-documents/${companyId}/${requestedByUserId}/`;
}

/**
 * Log an R2 failure WITHOUT any chance of an `r2Key` reaching Axiom (plan §12.10; fix round F6).
 *
 * ⚠ `error.name`, NOT `error.message`. An `@aws-sdk/client-s3` error message is vendor text we do
 * not control and an S3-compatible service is entitled to echo the key back inside it — so the
 * message is not a safe field here even though our own throws no longer name the key. The name
 * (`NoSuchKey`, `AccessDenied`, `TimeoutError`, …) is what actually makes this actionable.
 */
function logR2Failure(parseId: string, error: unknown, message: string): void {
  log.error({ parseId, errorName: error instanceof Error ? error.name : 'unknown' }, message);
}

/**
 * A classified, terminal failure — carries the closed `ProjectBriefFailureReason` literal the
 * worker will persist via `markFailed`. `cause` (when present) is logged, never persisted.
 */
export class ProjectBriefParseError extends Error {
  constructor(
    readonly reason: ProjectBriefFailureReason,
    message: string,
    readonly cause?: unknown
  ) {
    super(message);
    this.name = 'ProjectBriefParseError';
  }
}

export interface ParseDeps {
  readonly ai: AiClient;
}

/** The persisted row this worker operates on. */
type ParseRow = Awaited<ReturnType<typeof projectBriefParsesRepository.findById>> & object;

/** One document's bytes, ready to hand to the model. */
interface ParseFilePart {
  data: Uint8Array;
  mediaType: ParseRow['sourceDocuments'][number]['contentType'];
  filename: string;
}

/**
 * Gate 3 (Ruling A, worker-side re-guard). Every key must sit under
 * `project-documents/{row.companyId}/{row.requestedByUserId}/` — derived from the ROW, never
 * from a payload (there is none; the job carries only `{ parseId }`).
 */
function assertOwnerScopedKeys(row: ParseRow, parseId: string): void {
  const prefix = ownerPrefix(row.companyId, row.requestedByUserId);
  for (const doc of row.sourceDocuments) {
    if (!doc.r2Key.startsWith(prefix)) {
      log.error(
        { parseId },
        'Project brief parse rejected — source document key outside owner scope'
      );
      throw new ProjectBriefParseError('unreadable', 'Source document key outside owner scope');
    }
  }
}

/**
 * ⚠⚠ FIX ROUND F1 — MEMORY-EXHAUSTION DoS. Two passes, and the second one is the real gate.
 *
 * Pass 1 sums the DECLARED `sizeBytes` — a cheap pre-filter over a number the CLIENT put there:
 * `createPresignedProjectDocumentUpload` signs a `PutObjectCommand` with no `ContentLength`
 * condition, and `confirmProjectDocumentUploadAction`'s HEAD check is a SEPARATE client-initiated
 * call that an attacker simply skips. Presign → PUT 2 GB to your own legitimate key → never
 * confirm → start a parse declaring `sizeBytes: 1024`: every tenant gate passes honestly (the key
 * really is yours) and this worker — which shares a process with payments, notifications and
 * meetings, at concurrency 3 — buffers 2 GB per file.
 *
 * Pass 2 therefore HEADs every key and accumulates R2's OWN `ContentLength`, refusing on the
 * RUNNING total BEFORE any `GetObject`. This mirrors the guard `confirm-project-document-upload.ts`
 * already applies at upload time; it is here because confirm is skippable and this is not.
 */
async function assertRealBytesWithinCap(row: ParseRow, parseId: string): Promise<void> {
  const declaredTotal = row.sourceDocuments.reduce((sum, doc) => sum + doc.sizeBytes, 0);
  if (declaredTotal > MAX_PARSE_INPUT_BYTES) {
    throw new ProjectBriefParseError('too_large', 'Declared source document bytes exceed the cap');
  }

  let headTotal = 0;
  for (const doc of row.sourceDocuments) {
    let size: number;
    try {
      size = await headR2ObjectSize(doc.r2Key);
    } catch (error) {
      logR2Failure(parseId, error, 'Project brief parse — R2 HEAD failed');
      throw new ProjectBriefParseError(
        'unreadable',
        'Failed to stat a source document in R2',
        error
      );
    }
    headTotal += size;
    if (headTotal > MAX_PARSE_INPUT_BYTES) {
      throw new ProjectBriefParseError('too_large', 'Real source document bytes exceed the cap');
    }
  }
}

/**
 * Read every source document's bytes, sequentially (≤4 files; concurrency buys nothing and makes
 * the byte accounting racier).
 *
 * ⚠ THE CAP IS RE-CHECKED INSIDE THE LOOP (fix round F1). A post-loop check reads every object
 * first, so a HEAD that lied — or an object swapped between the HEAD and the GET — would still be
 * fully buffered before anyone objected. The running total stops at the first file that breaches.
 */
async function readSourceDocuments(row: ParseRow, parseId: string): Promise<ParseFilePart[]> {
  const files: ParseFilePart[] = [];
  let actualTotal = 0;
  for (const doc of row.sourceDocuments) {
    let bytes: Uint8Array;
    try {
      bytes = await getR2ObjectBytes(doc.r2Key);
    } catch (error) {
      logR2Failure(parseId, error, 'Project brief parse — R2 read failed');
      throw new ProjectBriefParseError(
        'unreadable',
        'Failed to read a source document from R2',
        error
      );
    }
    actualTotal += bytes.byteLength;
    if (actualTotal > MAX_PARSE_INPUT_BYTES) {
      throw new ProjectBriefParseError('too_large', 'Actual source document bytes exceed the cap');
    }
    files.push({ data: bytes, mediaType: doc.contentType, filename: doc.fileName });
  }
  return files;
}

/** The model call's outcome — the value plus the provenance/usage the row records. */
interface BriefGeneration {
  readonly value: BriefParseOutput;
  readonly audit: {
    modelId: string;
    modelVersion: string | null;
    promptId: string;
    promptVersion: string;
  };
  readonly usage: { inputTokens: number | null; outputTokens: number | null };
}

/**
 * Resolve the model and call it, mapping each error class to its `ProjectBriefFailureReason`.
 *
 * ⚠ THE RETRYABILITY SPLIT LIVES HERE. `AiModelNotAllowedError` (misconfiguration) and
 * `LlmOutputTruncatedError` (deterministic) become `ProjectBriefParseError`s, which the job layer
 * re-throws as `UnrecoverableError`. An invalid structured output is left as the RAW SDK error so
 * BullMQ's two attempts can have a go — generation is stochastic.
 *
 * ⚠ EXTRACTED ONLY TO SHED COGNITIVE COMPLEXITY (SonarJS caps `runProjectBriefParse` at 15).
 * Behaviour is byte-for-byte the inlined version's.
 */
async function generateBrief(input: {
  ai: AiClient;
  parseId: string;
  prompt: ReturnType<typeof briefParsePrompt>;
  files: readonly ParseFilePart[];
  fileNames: readonly string[];
}): Promise<BriefGeneration> {
  const { ai, parseId, prompt, files, fileNames } = input;

  let modelId: string;
  try {
    modelId = resolveProjectBriefModel();
  } catch (error) {
    if (error instanceof AiModelNotAllowedError) {
      log.error({ parseId, error: error.message }, 'Project brief parse — model not allowed');
      throw new ProjectBriefParseError('model_unavailable', error.message, error);
    }
    throw error;
  }

  try {
    const result = await ai.generateObject({
      modelId,
      schema: briefParseOutputSchema,
      system: prompt.system,
      prompt: prompt.user,
      maxOutputTokens: PROJECT_BRIEF_MAX_OUTPUT_TOKENS,
      promptId: prompt.promptId,
      promptVersion: prompt.promptVersion,
      files: files.map((f) => ({ data: f.data, mediaType: f.mediaType, filename: f.filename })),
      noopFallback: () => projectBriefNoopResult(fileNames),
    });
    return { value: result.value, audit: result.audit, usage: result.usage };
  } catch (error) {
    if (error instanceof LlmOutputTruncatedError) {
      throw new ProjectBriefParseError('truncated', error.message, error);
    }
    if (error instanceof NoObjectGeneratedError || error instanceof TypeValidationError) {
      // Retryable — generation is stochastic, let BullMQ's 2 attempts have a go.
      //
      // ⚠ `error.name`, NOT `error.message` (fix round F6, same class). `TypeValidationError`'s
      // message embeds THE VALUE THAT FAILED — i.e. raw model output, which plan §12.10 forbids
      // logging. The error class is the diagnostic; the payload is not.
      log.warn(
        { parseId, errorName: error.name },
        'Project brief parse — model returned an invalid structured output'
      );
    }
    throw error;
  }
}

/**
 * BAL-254 — the worker's orchestration. Steps, in order, per the plan's §8.5:
 *  1. Load the row (idempotent no-op if already terminal).
 *  2. Gate 3 (Ruling A) — re-assert every source document's key against the ROW's
 *     companyId/requestedByUserId, never the payload (there is none — the job carries only
 *     `{ parseId }`).
 *  3. Byte cap.
 *  4. Read bytes from R2, re-checking the real total.
 *  5. Load the live taxonomy.
 *  6. Call the model (multimodal, schema-bound).
 *  7. Usable-output floor.
 *  8. Slug → id mapping (D5).
 *  9. Persist the outcome.
 *
 * Non-retryable classifications (mapped by the CALLER — `jobs/project-brief-parse.ts` — to
 * BullMQ's `UnrecoverableError`) are thrown as `ProjectBriefParseError`; a transient/stochastic
 * failure (an invalid structured output) is a plain error so BullMQ's 2 attempts can retry.
 */
export async function runProjectBriefParse(parseId: string, deps: ParseDeps): Promise<void> {
  const row = await projectBriefParsesRepository.findById(parseId);
  if (row === undefined) {
    // No row — never retryable. The worker maps this to UnrecoverableError.
    throw new ProjectBriefParseError('unknown', `No project_brief_parses row for ${parseId}`);
  }
  if (row.completedAt !== null) {
    // Idempotent re-delivery — the CAS already made this a no-op at the repository layer, but
    // there's no point re-reading R2 / re-calling the model for a row already settled.
    return;
  }

  assertOwnerScopedKeys(row, parseId);
  await assertRealBytesWithinCap(row, parseId);
  const files = await readSourceDocuments(row, parseId);

  // ── Live taxonomy ─────────────────────────────────────────────────────────────────────────
  const vertical = await referenceDataRepository.getSalesforceVertical();
  const [tagGroups, productCats] = await Promise.all([
    referenceDataRepository.getProjectTagsByVertical(vertical.id),
    referenceDataRepository.getProductsByVertical(vertical.id),
  ]);
  const tagChoices = buildTaxonomyChoices(tagGroups);
  const productChoices = buildTaxonomyChoices(productCats);

  // ── The model call ────────────────────────────────────────────────────────────────────────
  const fileNames = files.map((f) => f.filename);
  const prompt = briefParsePrompt({ tagChoices, productChoices, fileNames });

  const { value, audit, usage } = await generateBrief({
    ai: deps.ai,
    parseId,
    prompt,
    files,
    fileNames,
  });

  // ── Usable-output floor ──────────────────────────────────────────────────────────────────
  if (value.title.trim().length < 3 || value.descriptionMarkdown.trim().length === 0) {
    throw new ProjectBriefParseError('empty_extraction', 'Model output below the usable floor');
  }

  // ── Slug → id mapping (D5) ────────────────────────────────────────────────────────────────
  const tagMapping = mapSlugsToIds(value.tagSlugs, tagChoices);
  const productMapping = mapSlugsToIds(value.productSlugs, productChoices);

  if (usage.inputTokens !== null && usage.inputTokens > PROJECT_BRIEF_BUDGET_INPUT_TOKENS) {
    log.warn(
      { parseId, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens },
      'Project brief parse — input tokens exceeded the budget-observability threshold'
    );
  }

  await projectBriefParsesRepository.markSucceeded({
    parseId,
    result: {
      title: value.title,
      descriptionMarkdown: value.descriptionMarkdown,
      tagIds: tagMapping.ids,
      productIds: productMapping.ids,
      unmatchedTagLabels: value.unmatchedTagLabels,
      unmatchedProductLabels: value.unmatchedProductLabels,
    },
    audit,
    usage,
  });

  log.info(
    {
      parseId,
      modelId: audit.modelId,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
    },
    'Project brief parse succeeded'
  );
}
