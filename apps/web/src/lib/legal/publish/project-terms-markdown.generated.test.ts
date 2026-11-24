import { describe, expect, it } from 'vitest';
import { renderProjectTermsMarkdown } from '../project-terms-markdown';

describe('generated project terms Markdown', () => {
  it('is up to date with project-terms.ts (run `pnpm --filter web legal:publish` to refresh)', async () => {
    await expect(renderProjectTermsMarkdown()).toMatchFileSnapshot(
      '../../../../../../docs/legal/project-terms.md'
    );
  });
});
