import type { ProjectDraft } from './use-project-draft';

/** The product ids an AI parse prefilled into the request, with the prompt version that chose them. */
export interface AiProductSuggestion {
  readonly productIds: readonly string[];
  readonly promptVersion: string;
}

export interface AiProductSubmitProperties {
  ai_products_suggested?: number;
  ai_products_kept?: number;
  products_added?: number;
  products_removed?: number;
  brief_prompt_version?: string;
}

/**
 * BAL-592 — the suggestion that applies to THIS submit: the case flow's on a case mount, the
 * AI flow's only while the draft is still the AI brief, otherwise none.
 */
export function resolveAiProductSuggestion(
  isCaseMount: boolean,
  caseSuggestion: AiProductSuggestion | null,
  draftSource: ProjectDraft['source'],
  aiSuggestion: AiProductSuggestion | null
): AiProductSuggestion | null {
  if (isCaseMount) return caseSuggestion;
  if (draftSource === 'ai') return aiSuggestion;
  return null;
}

/**
 * BAL-592 — counts comparing the submitted products to the AI suggestion. Empty (no keys at all)
 * when nothing was suggested, so the event payload is unchanged for manual requests.
 */
export function aiProductSubmitProperties(
  suggestion: AiProductSuggestion | null,
  submittedProductIds: readonly string[]
): AiProductSubmitProperties {
  if (suggestion === null) return {};
  const suggested = new Set(suggestion.productIds);
  const submitted = new Set(submittedProductIds);
  let kept = 0;
  for (const id of suggested) {
    if (submitted.has(id)) kept += 1;
  }
  return {
    ai_products_suggested: suggested.size,
    ai_products_kept: kept,
    products_added: submitted.size - kept,
    products_removed: suggested.size - kept,
    brief_prompt_version: suggestion.promptVersion,
  };
}
