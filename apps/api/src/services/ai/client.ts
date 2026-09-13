import { createAnthropic } from '@ai-sdk/anthropic';
import { generateText, generateObject } from 'ai';
import { createLogger } from '@balo/shared/logging';
import { AI_PROVIDER } from './types.js';
import type {
  AiClient,
  AiFilePart,
  AiResult,
  AiUsage,
  GenerateObjectRequest,
  GenerateTextRequest,
  LlmAudit,
} from './types.js';

const log = createLogger('ai-client');

/**
 * Thrown when a `generateText`/`generateObject` call hits its output-token cap
 * (`finishReason === 'length'`). A DETERMINISTIC failure — a retry re-spends a full model pass
 * for the same truncated result — so job layers map this to BullMQ's `UnrecoverableError`.
 *
 * ⚠ MOVED from `services/transcript/llm/anthropic-client.ts` (Ruling D — now thrown on BOTH the
 * text and the object paths; only the two `generateText` stages inspected `finishReason`
 * before, so `extractActionItems` could silently persist a partial artifact). Defined without
 * importing bullmq to keep this module free of the queue dependency (layering).
 */
export class LlmOutputTruncatedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LlmOutputTruncatedError';
  }
}

/** Warn ONCE across the process when running without a key (avoids per-run log spam). */
let noopWarned = false;

function coerceUsage(usage: { inputTokens?: number; outputTokens?: number } | undefined): AiUsage {
  return {
    inputTokens: usage?.inputTokens ?? null,
    outputTokens: usage?.outputTokens ?? null,
  };
}

function assertNotTruncated(
  finishReason: string | undefined,
  promptId: string,
  maxOutputTokens: number
): void {
  if (finishReason === 'length') {
    throw new LlmOutputTruncatedError(
      `${promptId} output was truncated at the ${maxOutputTokens}-token cap ` +
        '(finishReason=length) — refusing to persist a partial artifact'
    );
  }
}

/**
 * The absent-key path (ADR-1022 amendment §1). Warns once, then returns each CALLER's own
 * degraded fallback — this client cannot invent a value of an arbitrary result type. Never
 * calls `generateText`/`generateObject`. `audit.prompt` is always populated from the request's
 * `prompt`, so a caller asserting `audit.prompt.length > 0` on the Noop path (transcript's test)
 * keeps passing.
 */
class NoopAiClient implements AiClient {
  constructor() {
    if (!noopWarned) {
      noopWarned = true;
      log.warn(
        "ANTHROPIC_API_KEY not set — using the Noop AI client (each caller's degraded " +
          'fallback is used; no model is called)'
      );
    }
  }

  private audit(request: { promptId: string; promptVersion: string; prompt: string }): LlmAudit {
    return {
      provider: AI_PROVIDER,
      modelId: 'noop',
      modelVersion: null,
      promptId: request.promptId,
      promptVersion: request.promptVersion,
      prompt: request.prompt,
    };
  }

  async generateText(request: GenerateTextRequest): Promise<AiResult<string>> {
    return {
      value: request.noopFallback(),
      audit: this.audit(request),
      usage: { inputTokens: null, outputTokens: null },
    };
  }

  async generateObject<T>(request: GenerateObjectRequest<T>): Promise<AiResult<T>> {
    return {
      value: request.noopFallback(),
      audit: this.audit(request),
      usage: { inputTokens: null, outputTokens: null },
    };
  }
}

/** Build the multimodal user-message content: the prompt text, then each file part. */
function buildFileMessageContent(
  prompt: string,
  files: readonly AiFilePart[]
): Array<
  | { type: 'text'; text: string }
  | { type: 'file'; data: Uint8Array; mediaType: string; filename?: string }
> {
  return [
    { type: 'text' as const, text: prompt },
    ...files.map((f) => ({
      type: 'file' as const,
      data: f.data,
      mediaType: f.mediaType,
      // ⚠ Omit the `filename` key entirely when absent, rather than setting it to `undefined`.
      ...(f.filename === undefined ? {} : { filename: f.filename }),
    })),
  ];
}

/**
 * The real client, backed by the Vercel AI SDK (`ai` + `@ai-sdk/anthropic`) per the ADR-1022
 * amendment's provider-agnostic mandate. No `temperature` / thinking budget is passed
 * (`budget_tokens` is rejected on the Sonnet-5 / Opus-5 tier).
 */
class AnthropicAiClient implements AiClient {
  private readonly anthropic: ReturnType<typeof createAnthropic>;

  constructor(apiKey: string) {
    this.anthropic = createAnthropic({ apiKey });
  }

  async generateText(request: GenerateTextRequest): Promise<AiResult<string>> {
    const result = await generateText({
      model: this.anthropic(request.modelId),
      system: request.system,
      prompt: request.prompt,
      maxOutputTokens: request.maxOutputTokens,
    });
    assertNotTruncated(result.finishReason, request.promptId, request.maxOutputTokens);
    return {
      value: result.text,
      audit: {
        provider: AI_PROVIDER,
        modelId: request.modelId,
        modelVersion: result.response.modelId,
        promptId: request.promptId,
        promptVersion: request.promptVersion,
        prompt: request.prompt,
      },
      usage: coerceUsage(result.usage),
    };
  }

  async generateObject<T>(request: GenerateObjectRequest<T>): Promise<AiResult<T>> {
    const files = request.files;
    const result =
      files === undefined || files.length === 0
        ? await generateObject({
            model: this.anthropic(request.modelId),
            schema: request.schema,
            system: request.system,
            prompt: request.prompt,
            maxOutputTokens: request.maxOutputTokens,
          })
        : await generateObject({
            model: this.anthropic(request.modelId),
            schema: request.schema,
            system: request.system,
            messages: [
              { role: 'user' as const, content: buildFileMessageContent(request.prompt, files) },
            ],
            maxOutputTokens: request.maxOutputTokens,
          });
    assertNotTruncated(result.finishReason, request.promptId, request.maxOutputTokens);
    return {
      value: result.object,
      audit: {
        provider: AI_PROVIDER,
        modelId: request.modelId,
        modelVersion: result.response.modelId,
        promptId: request.promptId,
        promptVersion: request.promptVersion,
        prompt: request.prompt,
      },
      usage: coerceUsage(result.usage),
    };
  }
}

/**
 * Build the injectable AI client: the real Vercel-AI-SDK client when `ANTHROPIC_API_KEY` is
 * present, else the warn-once `NoopAiClient`.
 *
 * `productionRequirementLabel` names the caller in the production-throw message, so an absent
 * key fails LOUDLY in production rather than silently degrading — transcript passes
 * `'the transcript pipeline'`, the brief parser `'the project brief parser'`.
 *
 * ⚠ THE TRANSCRIPT MESSAGE CHANGED, AND THAT IS DELIBERATE (fix round F19 — this docblock used
 * to claim "byte-for-byte", which was untrue). It was
 * `ANTHROPIC_API_KEY is required in production for the transcript pipeline`; it is now
 * `ANTHROPIC_API_KEY is required in production (the transcript pipeline)`, because ONE template
 * has to serve every caller. Nothing depends on the old wording: transcript's test asserts
 * `/ANTHROPIC_API_KEY is required in production/`, which both forms satisfy. If you ever need
 * the exact string back, change the template here — not the label at a call site.
 */
export function createAiClient(options: { productionRequirementLabel: string }): AiClient {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey === undefined || apiKey.length === 0) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        `ANTHROPIC_API_KEY is required in production (${options.productionRequirementLabel})`
      );
    }
    return new NoopAiClient();
  }
  return new AnthropicAiClient(apiKey);
}
