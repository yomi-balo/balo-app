import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { renderProjectTermsMarkdown } from './project-terms-markdown';

/**
 * Pins the ported text to the reference copy of the published document, line for line (one line
 * is one clause: number, wording, markers). The first PR that changes wording deletes this test
 * and `docs/legal/balo-projects-msa.md`.
 */
const lines = (md: string): string[] =>
  md
    .replace(/^<!--[\s\S]*?-->/, '')
    .split('\n')
    .filter((l) => l.trim() !== '');

describe('project terms parity with the published document', () => {
  it('matches the reference copy line for line', () => {
    const reference = readFileSync(
      fileURLToPath(new URL('../../../../../docs/legal/balo-projects-msa.md', import.meta.url)),
      'utf8'
    );
    expect(lines(renderProjectTermsMarkdown())).toEqual(lines(reference));
  });
});
