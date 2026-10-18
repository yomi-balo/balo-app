import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { HELP_CAPTURE_DPR } from './types';

/**
 * The guide image's displayed width is `pixelWidth / HELP_CAPTURE_DPR`, so the screenshot runner's
 * `deviceScaleFactor` must be the same number or every image renders at the wrong size.
 */
describe('HELP_CAPTURE_DPR', () => {
  it('equals the help-screenshot runner deviceScaleFactor', () => {
    const config = readFileSync(
      path.resolve(__dirname, '../../../../../e2e/help-screenshots/playwright.config.ts'),
      'utf8'
    );
    const match = /deviceScaleFactor:\s*(\d+(?:\.\d+)?)/.exec(config);
    expect(match).not.toBeNull();
    expect(Number(match?.[1])).toBe(HELP_CAPTURE_DPR);
  });
});
