import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { helpFrontmatterSchema } from './frontmatter-schema';
import { parseHelpDoc } from './parse-guide';
import { publicImageExists, publicImageSize, readHelpDocs } from './read-help-docs';
import { validateHelpDocs } from './validate';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../../../../..');

const EXPECTED_FILES = [
  'booking-a-consultation.md',
  'buying-credit.md',
  'connecting-your-calendar.md',
  'dashboard-up-next.md',
  'dashboard-your-move-for-clients.md',
  'dashboard-your-move.md',
  'joining-a-call.md',
  'pausing-new-work.md',
  'project-requests-for-experts.md',
  'rate-and-payouts.md',
  'redeeming-a-promo-code.md',
  'requesting-a-project.md',
  'turning-a-case-into-a-project.md',
  'weekly-schedule.md',
  'what-happens-after-you-apply.md',
  'writing-and-sending-a-proposal.md',
  'your-cases.md',
  'your-live-status.md',
];

/** Publishing is a reviewed decision: flipping a guide means adding it here too. */
const PUBLISHED_FILES = [
  'booking-a-consultation.md',
  'buying-credit.md',
  'connecting-your-calendar.md',
  'joining-a-call.md',
  'pausing-new-work.md',
  'rate-and-payouts.md',
  'weekly-schedule.md',
  'what-happens-after-you-apply.md',
  'your-cases.md',
];

describe('docs/help', () => {
  const docs = readHelpDocs();

  it('holds exactly the end-user guides', () => {
    expect(docs.map((doc) => doc.filename)).toEqual(EXPECTED_FILES);
  });

  it('publishes exactly the reviewed guides', () => {
    const published = docs
      .filter(
        (doc) =>
          helpFrontmatterSchema.parse(parseHelpDoc(doc.filename, doc.source).frontmatter).published
      )
      .map((doc) => doc.filename);
    expect(published).toEqual(PUBLISHED_FILES);
  });

  it('passes validation, including image files for any published guide', () => {
    expect(validateHelpDocs(docs, publicImageExists)).toEqual([]);
  });

  it('gives every screenshot a light and dark file of identical pixel size', () => {
    for (const doc of docs) {
      const slug = doc.filename.replace(/\.md$/, '');
      for (const [, nn] of doc.source.matchAll(/!\[[^\]]*\]\((\d{2})\)/g)) {
        const light = `/help/${slug}/${nn}-light.png`;
        const dark = `/help/${slug}/${nn}-dark.png`;
        if (publicImageExists(light) && publicImageExists(dark)) {
          expect(publicImageSize(light), `${slug} ${nn}`).toEqual(publicImageSize(dark));
        }
      }
    }
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
