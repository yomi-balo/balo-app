import { describe, it, expect, vi } from 'vitest';
import { Link, Text, View } from '@react-pdf/renderer';

// Preserve HTMLElement/TextNode (the mapper's instanceof guards depend on them) but
// let a sentinel string force `parse` to throw so the plain-text fallback is covered.
vi.mock('node-html-parser', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node-html-parser')>();
  return {
    ...actual,
    parse: (html: string) => {
      if (html === '<p>forced fallback</p>') {
        throw new Error('boom');
      }
      return actual.parse(html);
    },
  };
});

import { richTextToPdf } from './rich-text-to-pdf';

type El = React.ReactElement<{ children?: React.ReactNode; src?: string }>;

function isElement(node: React.ReactNode): node is El {
  return typeof node === 'object' && node !== null && 'type' in node;
}

/** Recursively collect all rendered text across an element subtree. */
function collectText(node: React.ReactNode): string {
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(collectText).join('');
  if (isElement(node)) return collectText(node.props.children);
  return '';
}

/** Depth-first find the first element whose `type` matches. */
function findByType(nodes: React.ReactNode, type: unknown): El | null {
  const list = Array.isArray(nodes) ? nodes : [nodes];
  for (const node of list) {
    if (!isElement(node)) continue;
    if (node.type === type) return node;
    const nested = findByType(node.props.children, type);
    if (nested !== null) return nested;
  }
  return null;
}

describe('richTextToPdf', () => {
  it('returns [] for null / empty / whitespace-only input', () => {
    expect(richTextToPdf(null)).toEqual([]);
    expect(richTextToPdf('')).toEqual([]);
    expect(richTextToPdf('   ')).toEqual([]);
  });

  it('maps a paragraph to a Text element', () => {
    const [para] = richTextToPdf('<p>Hello world</p>');
    expect(para?.type).toBe(Text);
    expect(collectText(para)).toBe('Hello world');
  });

  it('nests strong/b and em/i as inline Text', () => {
    const result = richTextToPdf('<p>a <strong>bold</strong> <em>italic</em></p>');
    expect(collectText(result)).toBe('a bold italic');
    // The bold/italic wrappers are nested Text elements inside the paragraph.
    const para = result[0] as El | undefined;
    const inner = findByType(para?.props.children, Text);
    expect(inner).not.toBeNull();
  });

  it('decodes HTML entities in text content', () => {
    expect(collectText(richTextToPdf('<p>Tom &amp; Jerry &lt;3</p>'))).toBe('Tom & Jerry <3');
  });

  it('maps an anchor to a react-pdf Link carrying the href', () => {
    const result = richTextToPdf('<p><a href="https://balo.example">docs</a></p>');
    const link = findByType(result, Link);
    expect(link).not.toBeNull();
    expect(link?.props.src).toBe('https://balo.example');
    expect(collectText(link)).toBe('docs');
  });

  it('renders an anchor with no href as plain text (no dead link)', () => {
    const result = richTextToPdf('<p><a>bare</a></p>');
    expect(findByType(result, Link)).toBeNull();
    expect(collectText(result)).toBe('bare');
  });

  it('renders an unordered list with bullet markers', () => {
    const [list] = richTextToPdf('<ul><li>one</li><li>two</li></ul>');
    expect(list?.type).toBe(View);
    const text = collectText(list);
    expect(text).toContain('•');
    expect(text).toContain('one');
    expect(text).toContain('two');
  });

  it('renders a nested list via the block path (children keep their own markers/lines, not flattened)', () => {
    const [list] = richTextToPdf(
      '<ul><li>Parent<ul><li>Child A</li><li>Child B</li></ul></li></ul>'
    );
    const text = collectText(list);
    expect(text).toContain('Parent');
    expect(text).toContain('Child A');
    expect(text).toContain('Child B');
    // Three distinct bullet lines (parent + two nested children) — proof the nested
    // items are NOT flattened into a single concatenated run ('ParentChild A…').
    expect((text.match(/•/g) ?? []).length).toBe(3);
    expect(text).not.toContain('ParentChild');
    // The nested list is a real View subtree (block path), not inline text.
    const listEl = list as El | undefined;
    const nested = findByType(listEl?.props.children, View);
    expect(nested).not.toBeNull();
  });

  it('renders an ordered list with numeric markers', () => {
    const text = collectText(richTextToPdf('<ol><li>first</li><li>second</li></ol>'));
    expect(text).toContain('1.');
    expect(text).toContain('2.');
    expect(text).toContain('first');
    expect(text).toContain('second');
  });

  it('maps headings, blockquote and hr to block elements', () => {
    expect(collectText(richTextToPdf('<h2>Heading</h2>'))).toBe('Heading');
    expect(collectText(richTextToPdf('<h3>Sub</h3>'))).toBe('Sub');
    expect(collectText(richTextToPdf('<blockquote><p>quote</p></blockquote>'))).toBe('quote');
    const [hr] = richTextToPdf('<hr>');
    expect(hr?.type).toBe(View);
  });

  it('degrades an unknown block tag to a paragraph, preserving its text', () => {
    expect(collectText(richTextToPdf('<div>kept</div>'))).toBe('kept');
  });

  it('supports line breaks within a paragraph', () => {
    expect(collectText(richTextToPdf('<p>line1<br>line2</p>'))).toBe('line1\nline2');
  });

  it('falls back to tag-stripped plain text when parsing throws', () => {
    const result = richTextToPdf('<p>forced fallback</p>');
    expect(result).toHaveLength(1);
    expect(result[0]?.type).toBe(Text);
    expect(collectText(result)).toBe('forced fallback');
  });
});
