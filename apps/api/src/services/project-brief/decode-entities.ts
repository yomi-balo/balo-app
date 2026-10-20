/**
 * The model sometimes writes HTML entities into its plain-text output (`CRM &amp; Marketing`).
 * The brief's title is stored and rendered as plain text, and its description is markdown that
 * the web converter escapes in full, so an entity left in either shows up literally on the page.
 * Decoding here hands both consumers the characters the model meant.
 *
 * Single pass, so `&amp;lt;` becomes `&lt;` rather than `<`. Unknown names, and numeric
 * references to control characters, surrogates or out-of-range code points, are left as written.
 */
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

const ENTITY_PATTERN = /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z]{2,8}));/g;

function fromCodePoint(codePoint: number): string | null {
  const isSurrogate = codePoint >= 0xd800 && codePoint <= 0xdfff;
  if (codePoint < 0x20 || codePoint > 0x10ffff || isSurrogate) return null;
  return String.fromCodePoint(codePoint);
}

export function decodeHtmlEntities(text: string): string {
  return text.replace(
    ENTITY_PATTERN,
    (match, decimal: string | undefined, hex: string | undefined, name: string | undefined) => {
      if (decimal !== undefined) return fromCodePoint(Number.parseInt(decimal, 10)) ?? match;
      if (hex !== undefined) return fromCodePoint(Number.parseInt(hex, 16)) ?? match;
      return (name !== undefined ? NAMED_ENTITIES[name] : undefined) ?? match;
    }
  );
}
