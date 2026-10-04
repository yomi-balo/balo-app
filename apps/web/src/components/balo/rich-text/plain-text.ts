import { htmlToPlainText } from '@balo/shared/notifications';

/**
 * Pure, client-safe helpers for validating rich-text HTML by its PLAIN-TEXT
 * content length (not the HTML length) so an "empty" editor that still emits
 * `<p></p>` is correctly treated as empty.
 *
 * No DOM, no React — trivially unit-testable and safe in any runtime.
 *
 * BAL-424: `htmlToPlainText` (and the linear, S5852-safe tag scan behind it) now
 * lives in `@balo/shared/notifications`, because `apps/api`'s conversation-unread
 * digest rebuilds a message preview at fire time and neither app may import the
 * other. It is RE-EXPORTED here so every existing call site is unchanged.
 */

/** Min plain-text length for a valid brief (design §2.3). */
export const DESCRIPTION_MIN_TEXT = 10;
/** Max plain-text length for a brief (design §2.3 — UX limit, separate from the server DoS bound). */
export const DESCRIPTION_MAX_TEXT = 4000;

export { htmlToPlainText };

/** Plain-text length of an HTML fragment (used for min/max validation). */
export function plainTextLength(html: string): number {
  return htmlToPlainText(html).length;
}

/** True when the editor HTML has no meaningful text content. */
export function isDescriptionEmpty(html: string): boolean {
  return plainTextLength(html) === 0;
}

/**
 * Validate the brief's plain-text length. Returns an inline error message, or
 * `null` when valid. `null` message + `false` is the "empty, not yet errored"
 * case the caller uses to gate submit without showing a message prematurely.
 */
export function validateDescription(html: string): string | null {
  const length = plainTextLength(html);
  if (length === 0) return 'Add a few words about what you need.';
  if (length < DESCRIPTION_MIN_TEXT) return 'Add a few words about what you need.';
  if (length > DESCRIPTION_MAX_TEXT)
    return `Keep your brief under ${DESCRIPTION_MAX_TEXT} characters.`;
  return null;
}

/**
 * Normalise a user-entered link URL: prepend `https://` when no scheme is
 * present, then accept ONLY http(s)/mailto schemes. Returns the normalised URL,
 * or `null` when the scheme is unsafe (caller toasts + keeps the popover open).
 */
export function normalizeLinkUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;

  // mailto: passes through untouched.
  if (/^mailto:/i.test(trimmed)) return trimmed;

  // A bare scheme that isn't http/https is rejected outright (javascript:, data:, …).
  const schemeMatch = /^([a-z][a-z0-9+.-]*):/i.exec(trimmed);
  if (schemeMatch) {
    const scheme = (schemeMatch[1] ?? '').toLowerCase();
    if (scheme !== 'http' && scheme !== 'https') return null;
    return trimmed;
  }

  // No scheme → default to https.
  return `https://${trimmed}`;
}

/**
 * True when `value` is editor-emitted HTML. The editor always opens a document with a block
 * element, so the first tag is enough — a plain-text value that merely CONTAINS `<` ("a <b> c",
 * "<3") is not mistaken for markup.
 */
export function isRichTextHtml(value: string): boolean {
  return /^<(?:p|h2|h3|ul|ol|blockquote)[\s>]/i.test(value.trimStart());
}

function escapeHtmlText(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * A field that USED to be a plain-text textarea, as rich-text HTML: editor HTML passes through
 * untouched; legacy plain text is escaped and each non-blank line becomes a paragraph, so a
 * pre-existing value keeps its line breaks in the editor and the viewer. Blank input → `''`.
 *
 * Safe to run on every read: the output is valid input to the editor, the viewer and the server
 * sanitiser alike. It does NOT sanitise — editor HTML is returned as-is.
 */
export function toRichTextHtml(value: string | null | undefined): string {
  if (value === null || value === undefined || value.trim() === '') return '';
  if (isRichTextHtml(value)) return value;
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => `<p>${escapeHtmlText(line)}</p>`)
    .join('');
}
