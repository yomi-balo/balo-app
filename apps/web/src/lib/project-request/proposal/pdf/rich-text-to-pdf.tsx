import { Link, StyleSheet, Text, View } from '@react-pdf/renderer';
import { HTMLElement, TextNode, parse } from 'node-html-parser';
import { PDF_COLORS, PDF_TYPE } from './pdf-theme';

/**
 * HTML → react-pdf mapper for the proposal's rich-text fields (overview,
 * exclusions, milestone descriptions) — the ticket's flagged risk (BAL-385).
 *
 * The input is ALREADY server-sanitised to a known allow-list
 * (`PROPOSAL_OVERVIEW_ALLOWED_TAGS`: p, br, strong, b, em, i, a, h2, h3, ul, ol,
 * li, blockquote, hr). react-pdf renders its own primitives (not HTML), so each
 * allowed tag maps to a primitive. Anything unexpected degrades to its text
 * content; if parsing throws outright, a plain-text fallback (tag-stripped) is
 * emitted. The mapper NEVER throws and NEVER renders raw HTML.
 */

const styles = StyleSheet.create({
  paragraph: {
    fontSize: PDF_TYPE.body,
    lineHeight: 1.5,
    color: PDF_COLORS.text,
    marginBottom: 6,
  },
  h2: {
    fontSize: PDF_TYPE.h2,
    fontWeight: 600,
    color: PDF_COLORS.text,
    marginTop: 4,
    marginBottom: 4,
  },
  h3: {
    fontSize: PDF_TYPE.h3,
    fontWeight: 600,
    color: PDF_COLORS.text,
    marginTop: 3,
    marginBottom: 3,
  },
  bold: { fontWeight: 700 },
  italic: { fontStyle: 'italic' },
  link: { color: PDF_COLORS.brand, textDecoration: 'underline' },
  list: { marginBottom: 6, gap: 3 },
  listItem: { flexDirection: 'row', gap: 6 },
  listMarker: {
    fontSize: PDF_TYPE.body,
    color: PDF_COLORS.muted,
    minWidth: 14,
  },
  listItemText: { flex: 1, fontSize: PDF_TYPE.body, lineHeight: 1.5, color: PDF_COLORS.text },
  // Block-level children of an <li> (a nested ul/ol or p) render indented under the item.
  listItemChildren: { marginLeft: 20, marginTop: 3 },
  blockquote: {
    borderLeftWidth: 3,
    borderLeftColor: PDF_COLORS.brandBorder,
    paddingLeft: 10,
    marginBottom: 6,
  },
  hr: {
    borderBottomWidth: 1,
    borderBottomColor: PDF_COLORS.border,
    marginTop: 6,
    marginBottom: 6,
  },
});

/** Monotonic React keys for a single mapping pass (never the array index — S6479). */
type KeyGen = () => string;
function makeKeyGen(): KeyGen {
  let n = 0;
  return () => `rt${n++}`;
}

/** Decode the handful of entities the sanitiser emits. All linear (no ReDoS). */
function decodeBasicEntities(input: string): string {
  return input
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&nbsp;', ' ')
    .replaceAll('&amp;', '&'); // last, so we never double-decode
}

function textOf(node: TextNode): string {
  return decodeBasicEntities(node.rawText);
}

/** Map inline nodes (text, br, strong/b, em/i, a) to react-pdf inline children. */
function mapInline(nodes: readonly (HTMLElement | TextNode)[], keygen: KeyGen): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  for (const node of nodes) {
    if (node instanceof TextNode) {
      out.push(textOf(node));
      continue;
    }
    const tag = node.tagName?.toLowerCase();
    if (tag === 'br') {
      out.push('\n');
    } else if (tag === 'strong' || tag === 'b') {
      out.push(
        <Text key={keygen()} style={styles.bold}>
          {mapInline(node.childNodes as (HTMLElement | TextNode)[], keygen)}
        </Text>
      );
    } else if (tag === 'em' || tag === 'i') {
      out.push(
        <Text key={keygen()} style={styles.italic}>
          {mapInline(node.childNodes as (HTMLElement | TextNode)[], keygen)}
        </Text>
      );
    } else if (tag === 'a') {
      out.push(mapAnchor(node, keygen));
    } else {
      // Unknown inline tag → keep its text content, drop the wrapper.
      out.push(...mapInline(node.childNodes as (HTMLElement | TextNode)[], keygen));
    }
  }
  return out;
}

/** `a` → react-pdf `Link` (href already scheme-restricted by the sanitiser). A
 *  missing href degrades to plain inline text so nothing renders as a dead link. */
function mapAnchor(node: HTMLElement, keygen: KeyGen): React.ReactNode {
  const href = node.getAttribute('href');
  const children = mapInline(node.childNodes as (HTMLElement | TextNode)[], keygen);
  if (href === undefined || href === '') {
    return <Text key={keygen()}>{children}</Text>;
  }
  return (
    <Link key={keygen()} src={href} style={styles.link}>
      {children}
    </Link>
  );
}

/**
 * Block-level tags that can appear inside an `<li>` (the sanitiser allows nested
 * `ul`/`ol`, and the composer can wrap item text in `p`). These must render via the
 * BLOCK path — indented under the parent item — not be flattened into the item's
 * inline text run (which would concatenate child items with no markers/line breaks).
 */
const LI_BLOCK_CHILD_TAGS = new Set(['ul', 'ol', 'p', 'blockquote', 'h2', 'h3', 'hr']);

function isLiBlockChild(node: HTMLElement | TextNode): node is HTMLElement {
  return node instanceof HTMLElement && LI_BLOCK_CHILD_TAGS.has(node.tagName?.toLowerCase() ?? '');
}

function mapList(node: HTMLElement, ordered: boolean, keygen: KeyGen): React.ReactElement {
  const items = (node.childNodes as (HTMLElement | TextNode)[]).filter(
    (child): child is HTMLElement =>
      child instanceof HTMLElement && child.tagName?.toLowerCase() === 'li'
  );
  return (
    <View key={keygen()} style={styles.list}>
      {items.map((li, index) => {
        const children = li.childNodes as (HTMLElement | TextNode)[];
        const blockChildren = children.filter(isLiBlockChild);
        const inlineChildren = children.filter((child) => !isLiBlockChild(child));
        return (
          <View key={keygen()}>
            <View style={styles.listItem}>
              <Text style={styles.listMarker}>{ordered ? `${index + 1}.` : '•'}</Text>
              <Text style={styles.listItemText}>{mapInline(inlineChildren, keygen)}</Text>
            </View>
            {blockChildren.length > 0 ? (
              <View style={styles.listItemChildren}>{mapBlocks(blockChildren, keygen)}</View>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

/** Map one block-level node to a react-pdf element, or `null` to skip it. */
function mapBlock(node: HTMLElement | TextNode, keygen: KeyGen): React.ReactElement | null {
  if (node instanceof TextNode) {
    const text = textOf(node).trim();
    return text === '' ? null : (
      <Text key={keygen()} style={styles.paragraph}>
        {text}
      </Text>
    );
  }
  const tag = node.tagName?.toLowerCase();
  const inline = (): React.ReactNode[] =>
    mapInline(node.childNodes as (HTMLElement | TextNode)[], keygen);

  if (tag === 'ul') return mapList(node, false, keygen);
  if (tag === 'ol') return mapList(node, true, keygen);
  if (tag === 'hr') return <View key={keygen()} style={styles.hr} />;
  if (tag === 'h2') {
    return (
      <Text key={keygen()} style={styles.h2}>
        {inline()}
      </Text>
    );
  }
  if (tag === 'h3') {
    return (
      <Text key={keygen()} style={styles.h3}>
        {inline()}
      </Text>
    );
  }
  if (tag === 'blockquote') {
    return (
      <View key={keygen()} style={styles.blockquote}>
        {mapBlocks(node.childNodes as (HTMLElement | TextNode)[], keygen)}
      </View>
    );
  }
  // `p` and any unknown block tag → a paragraph of its inline content (preserved).
  const children = inline();
  return children.length === 0 ? null : (
    <Text key={keygen()} style={styles.paragraph}>
      {children}
    </Text>
  );
}

function mapBlocks(
  nodes: readonly (HTMLElement | TextNode)[],
  keygen: KeyGen
): React.ReactElement[] {
  const out: React.ReactElement[] = [];
  for (const node of nodes) {
    const element = mapBlock(node, keygen);
    if (element !== null) {
      out.push(element);
    }
  }
  return out;
}

/** Tag-stripped single-paragraph fallback (ReDoS-safe `/<[^<>]*>/g`). */
function plainTextFallback(html: string, keygen: KeyGen): React.ReactElement[] {
  const text = decodeBasicEntities(html.replaceAll(/<[^<>]*>/g, ' '))
    .replaceAll(/\s+/g, ' ')
    .trim();
  return text === ''
    ? []
    : [
        <Text key={keygen()} style={styles.paragraph}>
          {text}
        </Text>,
      ];
}

/**
 * Transform sanitised proposal rich-text HTML into react-pdf block elements.
 * Returns `[]` for null/empty input. On any parse failure, degrades to a
 * tag-stripped plain-text paragraph rather than throwing.
 */
export function richTextToPdf(html: string | null): React.ReactElement[] {
  if (html === null || html.trim() === '') {
    return [];
  }
  const keygen = makeKeyGen();
  try {
    const root = parse(html);
    const blocks = mapBlocks(root.childNodes as (HTMLElement | TextNode)[], keygen);
    return blocks.length > 0 ? blocks : plainTextFallback(html, keygen);
  } catch {
    return plainTextFallback(html, keygen);
  }
}
