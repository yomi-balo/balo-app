import { resolveModelId } from '../ai/index.js';

/** D7 — RESOLVED (Yomi, 2026-09-13): default is `claude-opus-5`. */
export const DEFAULT_PROJECT_BRIEF_MODEL = 'claude-opus-5';

/** ⚠ VISION-CAPABLE ONLY. Ruling B: the allow-list applies HERE and nowhere else. */
export const PROJECT_BRIEF_MODEL_ALLOW_LIST = [
  'claude-sonnet-5',
  'claude-opus-5',
  'claude-opus-4-8',
] as const;

export const PROJECT_BRIEF_MAX_OUTPUT_TOKENS = 4096;

/** Above this, log a budget warning (observability, not enforcement — D10). */
export const PROJECT_BRIEF_BUDGET_INPUT_TOKENS = 60_000;

export function resolveProjectBriefModel(): string {
  return resolveModelId({
    override: process.env.PROJECT_BRIEF_MODEL, // ⚠ literal — D8
    defaultModelId: DEFAULT_PROJECT_BRIEF_MODEL,
    allowList: PROJECT_BRIEF_MODEL_ALLOW_LIST,
  });
}
