/**
 * BAL-254 (D4) — the CONSTRAINED Markdown subset → the 12-tag project-brief HTML allow-list.
 * Deterministic, dependency-free, and its ENTIRE output alphabet is `PROJECT_HTML_ALLOWED_TAGS`.
 *
 * ⚠ THIS IS NOT A SECURITY BOUNDARY. `sanitizeProjectHtml` is. Every caller MUST pipe this
 * function's output through it — pinned by `markdown-to-project-html.test.ts`.
 *
 * ⚠ NO NESTED QUANTIFIERS / NO BACKTRACKING-PRONE REGEX (SonarCloud S5852, memory
 * `reference_sonarcloud_redos_tagstrip_regex`). Block parsing is a line scanner; inline parsing
 * is a single left-to-right index scan, not a regex.
 *
 * Supported, and nothing else:
 *  - Blocks: `## ` → `<h2>`, `### ` → `<h3>`, `- `/`* ` → `<ul><li>`, `1. ` → `<ol><li>`,
 *    blank-line-separated paragraphs → `<p>`, a single newline inside a paragraph → `<br>`.
 *  - ⚠ NESTED list items are FLATTENED to siblings of the list they were nested in — a
 *    deliberate, tested choice, see `blockLine` below.
 *  - Inline: `**bold**`/`__bold__` → `<strong>`, `*em*`/`_em_` → `<em>`,
 *    `[text](url)` → `<a href>` with http/https/mailto ONLY (anything else renders as plain
 *    text — belt; `sanitizeProjectHtml` is the boundary). A URL may contain BALANCED
 *    parentheses (`…/wiki/Salesforce_(company)`); see `findClosingParen`.
 *  - Everything else (`#`, `####`+, `>`, `---`, code fences, images, tables, raw HTML) is
 *    escaped and emitted as literal paragraph text. NEVER passed through.
 *  - All text is HTML-escaped before any tag is emitted.
 */

/**
 * Escape for TEXT CONTENT: `&`, `<`, `>` and nothing else.
 *
 * ⚠ FIX ROUND F11 — `"` IS DELIBERATELY NOT ESCAPED HERE. A double quote is not special in a
 * text node, and `sanitize-html` DECODES `&quot;` back to `"` when it re-serialises — so
 * escaping it made the converter's output differ from its own sanitised form, quietly breaking
 * the "already inside the boundary" property the D4 contract claims and the pinning test
 * asserts. Attribute values are a different context and keep their own escaper below.
 */
function escapeText(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/** Escape for a double-quoted ATTRIBUTE VALUE — text escaping plus the quote itself. */
function escapeAttributeValue(value: string): string {
  return escapeText(value).replaceAll('"', '&quot;');
}

const ALLOWED_LINK_SCHEMES = ['http://', 'https://', 'mailto:'];

/**
 * The index of the `)` that CLOSES the `(` at `openIndex`, counting balanced pairs in between —
 * or `-1` when the parenthesis is never closed.
 *
 * ⚠ FIX ROUND F11 — a bare `indexOf(')')` stopped at the FIRST `)`, so any URL containing one
 * (`…/wiki/Salesforce_(company)`, a Confluence or SharePoint link, a Google Docs export URL)
 * was TRUNCATED mid-href and the tail leaked out as literal text next to the link. Real RFPs
 * cite pages like that constantly.
 *
 * A left-to-right index scan, no regex (SonarCloud S5852).
 */
function findClosingParen(text: string, openIndex: number): number {
  let depth = 0;
  for (let i = openIndex; i < text.length; i += 1) {
    const char = text[i];
    if (char === '(') {
      depth += 1;
    } else if (char === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * One consumed inline token: the HTML it produced, and where the scan resumes. `null` means the
 * marker at this position is not actually a token, so the caller falls through to the next form.
 *
 * ⚠ THE THREE `try*` HELPERS BELOW EXIST TO KEEP `renderInline` UNDER THE COGNITIVE-COMPLEXITY
 * GATE (SonarJS caps it at 15; inlined, the scan reached 32). Each is the corresponding branch
 * verbatim — same indices, same escaping, same fall-through — lifted out, not rewritten.
 */
interface InlineToken {
  readonly html: string;
  readonly nextIndex: number;
}

/** `**bold**` / `__bold__` at `i`. */
function tryStrong(text: string, i: number): InlineToken | null {
  const marker = text.slice(i, i + 2);
  if (marker !== '**' && marker !== '__') return null;
  const close = text.indexOf(marker, i + 2);
  if (close === -1 || close <= i + 2) return null;
  return {
    html: `<strong>${escapeText(text.slice(i + 2, close))}</strong>`,
    nextIndex: close + 2,
  };
}

/** `*em*` / `_em_` at `i`. */
function tryEmphasis(text: string, i: number): InlineToken | null {
  const char = text[i];
  if (char !== '*' && char !== '_') return null;
  const close = text.indexOf(char, i + 1);
  if (close === -1 || close <= i + 1) return null;
  return {
    html: `<em>${escapeText(text.slice(i + 1, close))}</em>`,
    nextIndex: close + 1,
  };
}

/**
 * `[text](url)` — or `![alt](url)`, which is NOT a link.
 *
 * ⚠ FIX ROUND F11 — AN IMAGE IS NOT A LINK. `![alt](url)` used to fall through to the `[` branch
 * one character later and emit `!` followed by a real `<a href>`, contradicting this module's own
 * contract ("`![img]()` … is escaped and emitted as literal paragraph text"). `img` is not in the
 * allow-list and a caption is not a citation, so the whole construct is escaped through as text.
 */
function tryLinkOrImage(text: string, i: number): InlineToken | null {
  const char = text[i];
  const isImageMarker = char === '!' && text[i + 1] === '[';
  if (char !== '[' && !isImageMarker) return null;

  const bracketStart = isImageMarker ? i + 1 : i;
  const closeBracket = text.indexOf(']', bracketStart + 1);
  if (closeBracket === -1 || text[closeBracket + 1] !== '(') return null;
  const closeParen = findClosingParen(text, closeBracket + 1);
  if (closeParen === -1) return null;

  const linkText = text.slice(bracketStart + 1, closeBracket);
  const url = text.slice(closeBracket + 2, closeParen);
  const isSafe = !isImageMarker && ALLOWED_LINK_SCHEMES.some((scheme) => url.startsWith(scheme));
  if (isSafe) {
    return {
      html: `<a href="${escapeAttributeValue(url)}">${escapeText(linkText)}</a>`,
      nextIndex: closeParen + 1,
    };
  }
  // An image, or an unsafe scheme — render as plain text, never as markup (belt;
  // sanitizeProjectHtml is the actual boundary).
  return { html: escapeText(text.slice(i, closeParen + 1)), nextIndex: closeParen + 1 };
}

/** The inline forms, in precedence order: `**`/`__` before `*`/`_`, then links/images. */
const INLINE_MATCHERS = [tryStrong, tryEmphasis, tryLinkOrImage] as const;

/** Left-to-right scan for `**bold**`, `__bold__`, `*em*`, `_em_`, `[text](url)`. No regex. */
function renderInline(text: string): string {
  let out = '';
  let i = 0;

  while (i < text.length) {
    let matched: InlineToken | null = null;
    for (const matcher of INLINE_MATCHERS) {
      matched = matcher(text, i);
      if (matched !== null) break;
    }

    if (matched === null) {
      out += escapeText(text[i] ?? '');
      i += 1;
      continue;
    }
    out += matched.html;
    i = matched.nextIndex;
  }

  return out;
}

/** One parsed block, pre-HTML. */
type Block =
  | { kind: 'heading'; level: 2 | 3; text: string }
  | { kind: 'ul'; items: string[] }
  | { kind: 'ol'; items: string[] }
  | { kind: 'paragraph'; lines: string[] };

/**
 * One source line, normalised for block classification.
 *
 * ⚠⚠ FIX ROUND F11 — `trim()`, NOT `trimEnd()`, AND THAT IS THE NESTED-LIST DECISION. An
 * indented `  - child` did not match `startsWith('- ')`, so it (a) terminated the enclosing
 * `<ul>` and (b) came out as a PARAGRAPH containing the literal text `  - child`, bullet marker
 * and all. Two broken things for the price of one, on output a model produces routinely.
 *
 * The choice made here is to **FLATTEN**: a nested item becomes a sibling `<li>` of the list it
 * was nested in. It is deliberate, not incidental, and it is the honest option for a converter
 * whose whole contract is a CONSTRAINED subset — the system prompt asks for flat lists, the
 * 12-tag alphabet has no notion of depth to carry, and one flat level reads correctly while a
 * broken list and a stray literal marker do not. `markdown-to-project-html.test.ts` pins the
 * flattening as a behaviour, so a future decision to render real nesting has to change that test
 * on purpose.
 *
 * Side effect, accepted: up to three leading spaces before a `## ` heading now reads as a
 * heading (CommonMark agrees), and leading indentation on a paragraph line is dropped (HTML
 * collapses it anyway).
 */
function blockLine(raw: string | undefined): string {
  return (raw ?? '').trim();
}

function isUnorderedListItem(line: string): boolean {
  return line.startsWith('- ') || line.startsWith('* ');
}

/** True when `line` opens a block that a paragraph must stop before. */
function startsNonParagraphBlock(line: string): boolean {
  return (
    line.length === 0 ||
    line.startsWith('## ') ||
    line.startsWith('### ') ||
    isUnorderedListItem(line) ||
    isOrderedListItem(line)
  );
}

/** One consumed block: the block itself, and the line index the scan resumes at. */
interface ConsumedBlock {
  readonly block: Block;
  readonly nextIndex: number;
}

/**
 * Consume a run of list items of ONE kind, starting at `start`.
 *
 * ⚠ EXTRACTED ONLY TO SHED COGNITIVE COMPLEXITY (SonarJS caps `parseBlocks` at 15; with the two
 * list loops and the paragraph loop inlined it reached 30). Behaviour is byte-for-byte the
 * inlined version's, including the `blockLine` trim that FLATTENS nested items.
 */
function consumeList(
  lines: readonly string[],
  start: number,
  kind: 'ul' | 'ol',
  isItem: (line: string) => boolean,
  itemText: (line: string) => string
): ConsumedBlock {
  const items: string[] = [];
  let i = start;
  while (i < lines.length) {
    const current = blockLine(lines[i]);
    if (!isItem(current)) break;
    items.push(itemText(current));
    i += 1;
  }
  return { block: { kind, items }, nextIndex: i };
}

/** Consume a paragraph run — every line until a blank one or the start of another block type. */
function consumeParagraph(lines: readonly string[], start: number): ConsumedBlock {
  const paraLines: string[] = [];
  let i = start;
  while (i < lines.length) {
    const current = blockLine(lines[i]);
    if (startsNonParagraphBlock(current)) break;
    paraLines.push(current);
    i += 1;
  }
  return { block: { kind: 'paragraph', lines: paraLines }, nextIndex: i };
}

/** The `## `/`### ` heading at `line`, or `null`. */
function headingBlock(line: string): Block | null {
  if (line.startsWith('### ')) return { kind: 'heading', level: 3, text: line.slice(4) };
  if (line.startsWith('## ')) return { kind: 'heading', level: 2, text: line.slice(3) };
  return null;
}

/** The block starting at `lines[start]`, which is known to be non-blank. */
function consumeBlock(lines: readonly string[], start: number, line: string): ConsumedBlock {
  const heading = headingBlock(line);
  if (heading !== null) return { block: heading, nextIndex: start + 1 };
  if (isUnorderedListItem(line)) {
    return consumeList(lines, start, 'ul', isUnorderedListItem, (item) => item.slice(2));
  }
  if (isOrderedListItem(line)) {
    return consumeList(lines, start, 'ol', isOrderedListItem, stripOrderedMarker);
  }
  return consumeParagraph(lines, start);
}

function parseBlocks(markdown: string): Block[] {
  const lines = markdown.replaceAll('\r\n', '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = blockLine(lines[i]);
    if (line.length === 0) {
      i += 1;
      continue;
    }
    const consumed = consumeBlock(lines, i, line);
    blocks.push(consumed.block);
    i = consumed.nextIndex;
  }

  return blocks;
}

/** How many leading ASCII-digit characters `line` starts with. Guard-by-destructure, never `!`. */
function countLeadingDigits(line: string): number {
  let j = 0;
  while (j < line.length) {
    const char = line[j];
    if (char === undefined || char < '0' || char > '9') break;
    j += 1;
  }
  return j;
}

/** `1. `, `2. `, … — a digit run followed by `. `. No regex (a bounded manual scan). */
function isOrderedListItem(line: string): boolean {
  const digitCount = countLeadingDigits(line);
  return digitCount > 0 && line.slice(digitCount, digitCount + 2) === '. ';
}

function stripOrderedMarker(line: string): string {
  const digitCount = countLeadingDigits(line);
  return line.slice(digitCount + 2);
}

/** `<li>…</li>` for every item, joined — extracted so `renderBlock` has no nested template. */
function renderListItems(items: readonly string[]): string {
  return items.map((item) => `<li>${renderInline(item)}</li>`).join('');
}

function renderBlock(block: Block): string {
  switch (block.kind) {
    case 'heading':
      return `<h${block.level}>${renderInline(block.text)}</h${block.level}>`;
    case 'ul':
      return `<ul>${renderListItems(block.items)}</ul>`;
    case 'ol':
      return `<ol>${renderListItems(block.items)}</ol>`;
    case 'paragraph':
      // ⚠ `<br />`, not `<br>` (fix round F11). `sanitize-html` re-serialises a void element in
      // the self-closing form, so emitting `<br>` made the converter's output differ from its own
      // sanitised form — the "already inside the boundary" property is only true written this way.
      return `<p>${block.lines.map((line) => renderInline(line)).join('<br />')}</p>`;
  }
}

/** Convert the model's constrained Markdown subset to the project-brief HTML allow-list. */
export function markdownToProjectHtml(markdown: string): string {
  return parseBlocks(markdown).map(renderBlock).join('');
}
