import 'server-only';

import sanitizeHtml from 'sanitize-html';
import { PROJECT_HTML_ALLOWED_TAGS, PROPOSAL_OVERVIEW_ALLOWED_TAGS } from './allowed-tags';

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

/**
 * Server-side sanitiser for the FULL proposal-overview rich text (A6.2 / BAL-288).
 *
 * Same SECURITY BOUNDARY contract as {@link sanitizeProjectHtml} — never trust
 * client HTML; it runs on submit (before persist) and may re-run on render as
 * defense-in-depth — but reads the WIDENED proposal-overview allow-list, which
 * additionally permits `blockquote` and `hr` (decided Q3). Identical link
 * hardening and scheme allow-list; everything outside the allow-list (scripts,
 * styles, event handlers, unknown/disallowed tags) is removed.
 *
 * Kept as a sibling of `sanitizeProjectHtml` (NOT a parameter on it) so the brief
 * editor and milestone light-text keep their narrower contract unchanged.
 */
export function sanitizeProposalOverviewHtml(dirty: string): string {
  return sanitizeHtml(dirty, {
    allowedTags: [...PROPOSAL_OVERVIEW_ALLOWED_TAGS],
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
