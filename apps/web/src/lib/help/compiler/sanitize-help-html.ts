import sanitizeHtml from 'sanitize-html';

const ALLOWED_TAGS = ['p', 'strong', 'em', 'a', 'ul', 'ol', 'li', 'h3', 'h4', 'code', 'br'];

/**
 * Sanitises the HTML rendered from a help guide's markdown. Runs once, at generation time; the
 * committed module is the only content source and its freshness test proves the stored HTML
 * equals `sanitizeHelpHtml(render(docs))`.
 *
 * Links keep `href` only (http, https, mailto or relative). Everything outside the allow-list is
 * stripped.
 */
export function sanitizeHelpHtml(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: { a: ['href'] },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowProtocolRelative: false,
  });
}
