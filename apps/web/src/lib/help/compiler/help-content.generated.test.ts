import { describe, expect, it } from 'vitest';
import { buildHelpGuides, renderHelpModule } from './build-guides';
import { readHelpDocs } from './read-help-docs';

describe('generated help module', () => {
  it('is up to date with docs/help (run `pnpm --filter web help:generate` to refresh)', async () => {
    await expect(renderHelpModule(buildHelpGuides(readHelpDocs()))).toMatchFileSnapshot(
      '../generated/help-guides.generated.ts'
    );
  });
});
