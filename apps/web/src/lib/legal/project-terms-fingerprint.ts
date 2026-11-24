import 'server-only';

import { createHash } from 'node:crypto';
import {
  PROJECT_TERMS,
  PROJECT_TERMS_LAST_UPDATED_LINE,
  PROJECT_TERMS_TITLE,
  PROJECT_TERMS_VERSION,
} from './project-terms';

/**
 * SHA-256 hex of the current agreement: title, version, the Last Updated line, and every section
 * with its intro and clause tree. Any wording or structure change moves it, which is how
 * `project-terms-guard.test.ts` notices an edit that was not published as a new version.
 */
export function projectTermsFingerprint(): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        title: PROJECT_TERMS_TITLE,
        version: PROJECT_TERMS_VERSION,
        lastUpdatedLine: PROJECT_TERMS_LAST_UPDATED_LINE,
        sections: PROJECT_TERMS,
      })
    )
    .digest('hex');
}
