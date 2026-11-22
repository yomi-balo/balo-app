import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PROJECT_TERMS_VERSION } from './project-terms';
import { projectTermsFingerprint } from './project-terms-fingerprint';
import { PROJECT_TERMS_VERSIONS, projectTermsPdfFileName } from './project-terms-versions';

const FIX =
  'run `pnpm --filter web legal:publish`, or set a new PROJECT_TERMS_VERSION if wording changed';

describe('project terms version guard', () => {
  it('matches the listed fingerprint for the current version', () => {
    const entry = PROJECT_TERMS_VERSIONS.find((e) => e.version === PROJECT_TERMS_VERSION);
    expect(entry, `Version ${PROJECT_TERMS_VERSION} is not listed: ${FIX}`).toBeDefined();
    expect(
      entry?.sha256,
      `The agreement text changed without a new version: set a new PROJECT_TERMS_VERSION, then ${FIX}`
    ).toBe(projectTermsFingerprint());
  });

  it('ends with the current version', () => {
    expect(
      PROJECT_TERMS_VERSIONS.at(-1)?.version,
      `Last listed version is not current: ${FIX}`
    ).toBe(PROJECT_TERMS_VERSION);
  });

  it('has a committed PDF for every listed version', () => {
    for (const { version } of PROJECT_TERMS_VERSIONS) {
      const file = fileURLToPath(
        new URL(`../../../public/legal/${projectTermsPdfFileName(version)}`, import.meta.url)
      );
      expect(existsSync(file), `Missing PDF for ${version}: ${FIX}`).toBe(true);
    }
  });

  it('lists unique, ascending ISO dates', () => {
    const versions = PROJECT_TERMS_VERSIONS.map((e) => e.version);
    for (const v of versions) {
      expect(v).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    expect(versions).toEqual([...new Set(versions)].sort());
  });
});
