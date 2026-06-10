import 'server-only';

/**
 * Plain text → minimal message HTML (BAL-271 / A4 — D4).
 *
 * The conversation composer is PLAIN TEXT; the schema contract says
 * `conversation_messages.body` is sanitised HTML. This converts the typed text
 * into the smallest possible HTML: entities escaped, blank-line-separated
 * paragraphs as `<p>…</p>`, single newlines as `<br />`. Callers then run
 * `sanitizeProjectHtml()` over the result as belt-and-braces before persisting.
 */

const ENTITIES: ReadonlyArray<readonly [string, string]> = [
  ['&', '&amp;'], // must run first
  ['<', '&lt;'],
  ['>', '&gt;'],
  ['"', '&quot;'],
  ["'", '&#39;'],
];

function escapeHtml(text: string): string {
  let out = text;
  for (const [raw, entity] of ENTITIES) {
    out = out.replaceAll(raw, entity);
  }
  return out;
}

/**
 * Convert composer plain text to minimal HTML. Trims the input; returns `''`
 * for whitespace-only input (callers treat that as "type a message first").
 */
export function plainMessageToHtml(text: string): string {
  const normalized = text.replace(/\r\n?/g, '\n').trim();
  if (normalized.length === 0) return '';

  return normalized
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replaceAll('\n', '<br />')}</p>`)
    .join('');
}
