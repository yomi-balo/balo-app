/**
 * Pure, client-safe helpers for validating rich-text HTML by its PLAIN-TEXT
 * content length (not the HTML length) so an "empty" editor that still emits
 * `<p></p>` is correctly treated as empty.
 *
 * No DOM, no React — trivially unit-testable and safe in any runtime.
 */

/** Min plain-text length for a valid brief (design §2.3). */
export const DESCRIPTION_MIN_TEXT = 10;
/** Max plain-text length for a brief (design §2.3 — UX limit, separate from the server DoS bound). */
export const DESCRIPTION_MAX_TEXT = 4000;

/**
 * Strip tags + decode the handful of entities Tiptap emits, collapse runs of
 * whitespace, and trim. Returns the human-visible text of a fragment of HTML.
 */
export function htmlToPlainText(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

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
