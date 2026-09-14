/**
 * ADR-1022 amendment (BAL-254) / Ruling B — model-id resolution with an OPTIONAL allow-list.
 *
 * ⚠⚠ D8 — THE OVERRIDE IS THE ALREADY-READ ENV VALUE, NEVER READ INSIDE THIS FUNCTION.
 * `apps/api/src/env-example-coverage.test.ts` regex-matches the literal `process.env.NAME` at
 * each call site; if this function did `process.env[envVarName]` dynamically that guard would
 * silently stop seeing every model override while still reporting green. Every caller passes
 * the value it already read via a LITERAL `process.env.SOME_MODEL` at the call site — do not
 * "tidy" this into a dynamic read.
 */
export class AiModelNotAllowedError extends Error {
  constructor(modelId: string, allowList: readonly string[]) {
    super(
      `Model "${modelId}" is not on the allow-list [${allowList.join(', ')}]. Set the override ` +
        'env var to one of these, or leave it unset to use the default.'
    );
    this.name = 'AiModelNotAllowedError';
  }
}

export interface ResolveModelIdOptions {
  /** ⚠ THE ALREADY-READ env value — see the docblock above. NEVER `process.env[...]` in here. */
  readonly override: string | undefined;
  readonly defaultModelId: string;
  /** Present ⇒ the resolved id MUST be a member, else throw. Absent ⇒ permissive (Ruling B). */
  readonly allowList?: readonly string[];
}

/**
 * `override ?? defaultModelId` (an empty-string override — how every `.env.example` line ships
 * — is treated as absent). When `allowList` is supplied and the resolved id is not a member,
 * throws {@link AiModelNotAllowedError} naming the rejected id and the allow-list.
 *
 * Ruling B: transcript calls this with NO `allowList` (permissive, unchanged) — the brief
 * parser calls it WITH one. `PROJECT_BRIEF_MODEL_ALLOW_LIST` applies to the brief parser only;
 * no deployed `TRANSCRIPT_*_MODEL` override can start failing because of it.
 */
export function resolveModelId(options: ResolveModelIdOptions): string {
  const resolved =
    options.override === undefined || options.override.length === 0
      ? options.defaultModelId
      : options.override;

  if (options.allowList !== undefined && !options.allowList.includes(resolved)) {
    throw new AiModelNotAllowedError(resolved, options.allowList);
  }

  return resolved;
}
