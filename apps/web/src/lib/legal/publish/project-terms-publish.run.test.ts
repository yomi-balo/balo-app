import { existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PROJECT_TERMS_VERSION } from '../project-terms';
import { projectTermsFingerprint } from '../project-terms-fingerprint';
import { PROJECT_TERMS_VERSIONS, projectTermsPdfFileName } from '../project-terms-versions';
import { renderProjectTermsPdfToBuffer } from '../pdf/project-terms-pdf-document';
import { planProjectTermsPublish } from './project-terms-publish';

const VERSIONS_PATH = fileURLToPath(new URL('../project-terms-versions.json', import.meta.url));
const PDF_DIR = fileURLToPath(new URL('../../../../public/legal/', import.meta.url));

/** Run only by `pnpm --filter web legal:publish`; CI skips it. */
describe.runIf(process.env.LEGAL_PUBLISH === '1')('publish the Projects MSA', () => {
  it('freezes the current version when it is not yet listed', async () => {
    const plan = planProjectTermsPublish(
      { version: PROJECT_TERMS_VERSION, sha256: projectTermsFingerprint() },
      PROJECT_TERMS_VERSIONS
    );
    if (plan.kind === 'refuse') {
      expect.fail(plan.reason);
    }
    if (plan.kind === 'up_to_date') {
      return;
    }
    const pdfPath = `${PDF_DIR}${projectTermsPdfFileName(plan.entry.version)}`;
    expect(existsSync(pdfPath)).toBe(false);
    writeFileSync(pdfPath, await renderProjectTermsPdfToBuffer(), { flag: 'wx' });
    writeFileSync(
      VERSIONS_PATH,
      `${JSON.stringify([...PROJECT_TERMS_VERSIONS, plan.entry], null, 2)}\n`
    );
  });
});
