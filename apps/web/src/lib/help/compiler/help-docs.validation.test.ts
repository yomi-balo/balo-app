import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { helpFrontmatterSchema } from './frontmatter-schema';
import { parseHelpDoc } from './parse-guide';
import { publicImageExists, readHelpDocs } from './read-help-docs';
import { validateHelpDocs } from './validate';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../../../../..');

const EXPECTED_FILES = [
  'booking-a-consultation.md',
  'cases-index.md',
  'dashboard-up-next.md',
  'pausing-new-work.md',
  'project-requests-for-experts.md',
  'redeeming-a-promo-code.md',
  'requesting-a-project.md',
  'turning-a-case-into-a-project.md',
  'what-happens-after-you-apply.md',
];

describe('docs/help', () => {
  const docs = readHelpDocs();

  it('holds exactly the nine end-user guides', () => {
    expect(docs.map((doc) => doc.filename)).toEqual(EXPECTED_FILES);
  });

  it('keeps every guide unpublished until its content is reviewed', () => {
    for (const doc of docs) {
      const parsed = helpFrontmatterSchema.parse(
        parseHelpDoc(doc.filename, doc.source).frontmatter
      );
      expect(parsed.published, doc.filename).toBe(false);
    }
  });

  it('passes validation, including image files for any published guide', () => {
    expect(validateHelpDocs(docs, publicImageExists)).toEqual([]);
  });

  it('keeps the two admin drafts under docs/ops, not docs/help', () => {
    for (const name of [
      'who-can-do-what-in-balo-admin.md',
      'correcting-an-expert-application.md',
    ]) {
      expect(existsSync(path.join(REPO_ROOT, 'docs/ops', name)), name).toBe(true);
      expect(existsSync(path.join(REPO_ROOT, 'docs/help', name)), name).toBe(false);
    }
  });
});
