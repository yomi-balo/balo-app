import { describe, expect, it } from 'vitest';
import { aiProductSubmitProperties, resolveAiProductSuggestion } from './ai-product-metrics';

const SUGGESTION = { productIds: ['a', 'b', 'c'], promptVersion: 'v2' };
const OTHER = { productIds: ['z'], promptVersion: 'v2' };

describe('aiProductSubmitProperties', () => {
  it('returns no keys when nothing was suggested', () => {
    expect(aiProductSubmitProperties(null, ['a'])).toEqual({});
    expect(Object.keys(aiProductSubmitProperties(null, ['a']))).toHaveLength(0);
  });

  it('counts kept, added and removed', () => {
    expect(aiProductSubmitProperties(SUGGESTION, ['a', 'b', 'x', 'y'])).toEqual({
      ai_products_suggested: 3,
      ai_products_kept: 2,
      products_added: 2,
      products_removed: 1,
      brief_prompt_version: 'v2',
    });
  });

  it('de-duplicates both sides', () => {
    expect(
      aiProductSubmitProperties({ productIds: ['a', 'a', 'b'], promptVersion: 'v2' }, ['a', 'a'])
    ).toMatchObject({
      ai_products_suggested: 2,
      ai_products_kept: 1,
      products_added: 0,
      products_removed: 1,
    });
  });

  it('reports zero-change when submitted equals suggested', () => {
    expect(aiProductSubmitProperties(SUGGESTION, ['c', 'b', 'a'])).toMatchObject({
      ai_products_kept: 3,
      products_added: 0,
      products_removed: 0,
    });
  });
});

describe('resolveAiProductSuggestion', () => {
  it('uses the case suggestion on a case mount regardless of source', () => {
    expect(resolveAiProductSuggestion(true, SUGGESTION, 'manual', OTHER)).toBe(SUGGESTION);
    expect(resolveAiProductSuggestion(true, null, 'ai', OTHER)).toBeNull();
  });

  it('uses the AI suggestion only when the draft source is ai', () => {
    expect(resolveAiProductSuggestion(false, SUGGESTION, 'ai', OTHER)).toBe(OTHER);
    expect(resolveAiProductSuggestion(false, SUGGESTION, 'manual', OTHER)).toBeNull();
  });
});
