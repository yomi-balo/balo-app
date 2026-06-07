import 'server-only';

import sanitizeHtml from 'sanitize-html';
import { PROJECT_HTML_ALLOWED_TAGS } from './allowed-tags';

/**
 * Server-side sanitiser for the project-brief rich-text description (ADR-1022).
 *
 * This is the SECURITY BOUNDARY for stored HTML — never trust client HTML. It runs
 * on submit (before persist) and may be re-run on render as defense-in-depth.
 *
 * Allow-list (locked):
 *  - tags: {@link PROJECT_HTML_ALLOWED_TAGS}
 *  - `a` attrs: href/target/rel; every link is forced to
 *    `rel="noopener noreferrer nofollow"` + `target="_blank"`
 *  - schemes: http / https / mailto only (data:, javascript:, etc. stripped)
 *  - everything else (scripts, styles, event handlers, unknown tags) is removed.
 */
export function sanitizeProjectHtml(dirty: string): string {
  return sanitizeHtml(dirty, {
    allowedTags: [...PROJECT_HTML_ALLOWED_TAGS],
    allowedAttributes: {
      a: ['href', 'target', 'rel'],
    },
    allowedSchemes: ['http', 'https', 'mailto'],
    // Disallow protocol-relative URLs (//evil.com) and bare schemes.
    allowProtocolRelative: false,
    transformTags: {
      a: sanitizeHtml.simpleTransform('a', {
        rel: 'noopener noreferrer nofollow',
        target: '_blank',
      }),
    },
  });
}
