import { describe, expect, it } from 'vitest';
import { buildHelpGuides, renderHelpModule } from './build-guides';
import { publicImageSize, readHelpDocs } from './read-help-docs';

describe('generated help module', () => {
  it('is up to date with docs/help (run `pnpm --filter web help:generate` to refresh)', async () => {
    await expect(
      renderHelpModule(buildHelpGuides(readHelpDocs(), publicImageSize))
    ).toMatchFileSnapshot('../generated/help-guides.generated.ts');
  });
});
