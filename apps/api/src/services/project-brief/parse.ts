import { NoObjectGeneratedError, TypeValidationError } from 'ai';
import { projectBriefParsesRepository, referenceDataRepository } from '@balo/db';
import {
  isSessionOwnedProjectDocumentKey,
  MAX_PARSE_DOCUMENT_BYTES,
  MAX_PARSE_INPUT_BYTES,
  MAX_BRIEF_PRODUCT_SLUGS,
} from '@balo/shared/project-requests';
import { createLogger } from '@balo/shared/logging';
import { getR2ObjectBytes, headR2ObjectSize } from '../../lib/storage/r2.js';
import { AiModelNotAllowedError, LlmOutputTruncatedError, type AiClient } from '../ai/index.js';
import {
  resolveProjectBriefModel,
  PROJECT_BRIEF_MAX_OUTPUT_TOKENS,
  PROJECT_BRIEF_BUDGET_INPUT_TOKENS,
} from './config.js';
import {
  briefParsePrompt,
  briefFromCasePrompt,
  briefParseOutputSchema,
  type BriefParseOutput,
  type RenderedBriefPrompt,
} from './prompts.js';
import {
  buildProductChoices,
  buildProductLabelIndex,
  buildTaxonomyChoices,
  deriveUnmatchedLabels,
  mapSlugsToIds,
  resolveLabelsToProducts,
  type TaxonomyChoice,
} from './taxonomy-mapping.js';
import { projectBriefNoopResult, projectBriefCaseNoopResult } from './noop-fallback.js';
import { loadCaseSource } from './case-source.js';
import { ProjectBriefParseError } from './errors.js';

const log = createLogger('project-brief-parse');

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

// `ProjectBriefParseError` lives in `errors.ts` (not here) to avoid a circular import with
// `case-source.ts`; re-exported so every existing importer of it from this module is unaffected.
export { ProjectBriefParseError };

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
 *
 * ⚠⚠ BAL-254 W9 — THE **SHARED** PREDICATE, NOT A LOCAL ONE. This used to be a hand-rolled
 * prefix string plus `startsWith`, with no shape check — i.e. exactly the "third definition of
 * the tenant boundary" that `@balo/shared`'s `document-key.ts` docblock warns is a cross-tenant
 * R2 read waiting to happen. One definition now serves both apps, and `apps/web`'s
 * `project-brief-boundaries-single-caller.test.ts` (which walks `apps/api/src` too) pins this
 * call site. Note the shape check is a genuine TIGHTENING here: a key must now BE a
 * `project-documents/{uuid}/{uuid}/{uuid}`, not merely start with the owner prefix.
 */
function assertOwnerScopedKeys(row: ParseRow, parseId: string): void {
  const owner = { companyId: row.companyId, userId: row.requestedByUserId };
  for (const doc of row.sourceDocuments) {
    if (!isSessionOwnedProjectDocumentKey(doc.r2Key, owner)) {
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
 * Pass 2 therefore HEADs every key and accumulates R2's OWN `ContentLength`, refusing on BOTH
 * the PER-FILE cap and the RUNNING total, BEFORE any `GetObject`. This mirrors the guard
 * `confirm-project-document-upload.ts` already applies at upload time; it is here because
 * confirm is skippable and this is not.
 *
 * ⚠ BAL-254 W3 — THE PER-FILE CHECK IS NOT REDUNDANT WITH THE TOTAL. Only the running total was
 * checked, so a single object of any size up to 10 MB passed both gates while DECLARING a
 * kilobyte — the 5 MB per-file cap the uploader promises, and `documentRefSchema` bounds against
 * the DECLARATION, was never enforced against real bytes anywhere.
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
    if (size > MAX_PARSE_DOCUMENT_BYTES) {
      throw new ProjectBriefParseError(
        'too_large',
        'A source document exceeds the per-file byte cap'
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

/** Everything `generateBrief` needs, regardless of which arm produced it. */
interface ParseSource {
  readonly prompt: RenderedBriefPrompt;
  readonly files: readonly ParseFilePart[];
  readonly noopFallback: () => BriefParseOutput;
}

/**
 * The documents arm (BAL-254, unchanged): Gate 3, the byte cap, the real read, then the
 * documents prompt.
 */
async function loadDocumentsSource(
  row: ParseRow,
  parseId: string,
  tagChoices: readonly TaxonomyChoice[],
  productChoices: readonly TaxonomyChoice[]
): Promise<ParseSource> {
  assertOwnerScopedKeys(row, parseId);
  await assertRealBytesWithinCap(row, parseId);
  const files = await readSourceDocuments(row, parseId);
  const fileNames = files.map((f) => f.filename);
  return {
    prompt: briefParsePrompt({ tagChoices, productChoices, fileNames }),
    files,
    noopFallback: () => projectBriefNoopResult(fileNames),
  };
}

/**
 * The case arm (BAL-589): the case gate + history build (`loadCaseSource`), then the
 * from-case prompt. `files` is always `[]` — the case arm is text-only.
 */
async function loadCaseParseSource(
  row: ParseRow,
  parseId: string,
  tagChoices: readonly TaxonomyChoice[],
  productChoices: readonly TaxonomyChoice[]
): Promise<ParseSource> {
  const caseSource = await loadCaseSource(row, parseId);
  return {
    prompt: briefFromCasePrompt({
      tagChoices,
      productChoices,
      caseTitle: caseSource.caseTitle,
      historyText: caseSource.historyText,
    }),
    files: [],
    noopFallback: () => projectBriefCaseNoopResult(caseSource.caseTitle),
  };
}

/**
 * Dispatch on the row's source: a case source (`source_engagement_id` set) takes the
 * case arm; otherwise the documents arm. The CHECK `project_brief_parses_exactly_one_source`
 * guarantees these are exhaustive and mutually exclusive.
 */
async function loadParseSource(
  row: ParseRow,
  parseId: string,
  tagChoices: readonly TaxonomyChoice[],
  productChoices: readonly TaxonomyChoice[]
): Promise<ParseSource> {
  if (row.sourceEngagementId === null) {
    return loadDocumentsSource(row, parseId, tagChoices, productChoices);
  }
  return loadCaseParseSource(row, parseId, tagChoices, productChoices);
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
  prompt: RenderedBriefPrompt;
  files: readonly ParseFilePart[];
  noopFallback: () => BriefParseOutput;
}): Promise<BriefGeneration> {
  const { ai, parseId, prompt, files, noopFallback } = input;

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
      noopFallback,
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
 * Re-read the row and answer whether it is still un-completed (BAL-254 W8).
 *
 * A missing row counts as NOT claimable: it was soft-deleted or never existed, and either way
 * there is nothing left to spend a model call on.
 */
async function isStillClaimable(parseId: string): Promise<boolean> {
  const row = await projectBriefParsesRepository.findById(parseId);
  return row !== undefined && row.completedAt === null;
}

/**
 * BAL-254 / BAL-589 — the worker's orchestration. Steps, in order:
 *  1. Load the row (idempotent no-op if already terminal).
 *  2. Load the live taxonomy (needed to render either arm's prompt).
 *  3. Load the parse source — the documents arm (Gate 3, the byte cap, the real read) or the
 *     case arm (the case gate + the history build), dispatched on `source_engagement_id`.
 *  4. Re-check the row is still claimable (W8 — never spend a paid call on a settled row).
 *  5. Call the model (multimodal for documents, text-only for a case; schema-bound either way).
 *  6. Usable-output floor.
 *  7. Slug → id mapping + the unmatched-label footnote.
 *  8. Persist the outcome.
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

  // ── Live taxonomy ─────────────────────────────────────────────────────────────────────────
  const vertical = await referenceDataRepository.getSalesforceVertical();
  const [tagGroups, productCats] = await Promise.all([
    referenceDataRepository.getProjectTagsByVertical(vertical.id),
    referenceDataRepository.getProductsForBriefMapping(vertical.id),
  ]);
  const tagChoices = buildTaxonomyChoices(tagGroups);
  const productChoices = buildProductChoices(productCats);
  const productLabelIndex = buildProductLabelIndex(productChoices);

  // ── The parse source — documents or a case, never both (CHECK) ──────────────────
  const source = await loadParseSource(row, parseId, tagChoices, productChoices);

  // ── The model call ────────────────────────────────────────────────────────────────────────
  // ⚠⚠ BAL-254 W8 — LAST CHANCE TO NOT SPEND AN OPUS CALL. The row was claimable when this job
  // started, but the web action races us: if `postBaloApiJson` times out AFTER the api enqueued,
  // `startProjectBriefParseAction` wins the CAS with `enqueue_failed` while this job is already
  // reading R2. The parse then ran to completion and `markSucceeded` no-op'd on the CAS — the
  // user saw an error and the paid call was spent anyway. One SELECT here is orders of magnitude
  // cheaper than the call it can avoid.
  //
  // ⚠ Not a lock and not a claim — the row can still go terminal DURING the call. This narrows
  // the window from "the whole parse" to "the model call"; it does not close it, and it does not
  // need to (the CAS is what keeps the outcome correct either way).
  if (!(await isStillClaimable(parseId))) {
    log.info({ parseId }, 'Project brief parse abandoned before the model call — row is terminal');
    return;
  }

  const { value, audit, usage } = await generateBrief({
    ai: deps.ai,
    parseId,
    prompt: source.prompt,
    files: source.files,
    noopFallback: source.noopFallback,
  });

  // ── Usable-output floor ──────────────────────────────────────────────────────────────────
  if (value.title.trim().length < 3 || value.descriptionMarkdown.trim().length === 0) {
    throw new ProjectBriefParseError('empty_extraction', 'Model output below the usable floor');
  }

  // ── Slug → id mapping (D5; products also resolve by alias, BAL-592) ──────────────────────
  const tagMapping = mapSlugsToIds(value.tagSlugs, tagChoices);
  const productMapping = mapSlugsToIds(value.productSlugs, productChoices);

  // ⚠⚠ BAL-254 W4 — THE FOOTNOTE IS DERIVED FROM THE ACTUAL MAPPING FAILURES, not from the
  // model's self-report alone. `unmatchedSlugs` used to be computed and discarded while the
  // persisted labels came straight from `value.unmatched*Labels`, so a slug that missed the live
  // taxonomy and was NOT self-reported disappeared without trace — the exact silent drop this
  // footnote exists to prevent. Both sources are unioned; see `deriveUnmatchedLabels`.
  const unmatchedTagLabels = deriveUnmatchedLabels(
    tagMapping.unmatchedSlugs,
    value.unmatchedTagLabels
  );
  // Products only: a missed slug or model-reported label that exactly matches a live product name
  // or alias becomes that product's id; only what still failed reaches the footnote.
  const resolution = resolveLabelsToProducts(
    productMapping.unmatchedSlugs,
    value.unmatchedProductLabels,
    productLabelIndex
  );
  const liveProductIds = new Set(productChoices.map((c) => c.id));
  const productIds = [...new Set([...productMapping.ids, ...resolution.productIds])]
    .filter((id) => liveProductIds.has(id))
    .slice(0, MAX_BRIEF_PRODUCT_SLUGS);
  const unmatchedProductLabels = deriveUnmatchedLabels(
    resolution.unresolvedSlugs,
    resolution.unresolvedLabels
  );

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
      productIds,
      unmatchedTagLabels,
      unmatchedProductLabels,
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
      aliasResolvedCount: resolution.resolvedCount,
      unmatchedProductCount: unmatchedProductLabels.length,
      promptVersion: audit.promptVersion,
    },
    'Project brief parse succeeded'
  );
}
