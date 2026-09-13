import { describe, it, expect } from 'vitest';
import { markdownToProjectHtml } from './markdown-to-project-html';
import { sanitizeProjectHtml } from '@/lib/sanitize/project-html';
import { PROJECT_HTML_ALLOWED_TAGS } from '@/lib/sanitize/allowed-tags';

describe('markdownToProjectHtml', () => {
  it('converts a heading (## / ###)', () => {
    expect(markdownToProjectHtml('## Heading Two')).toBe('<h2>Heading Two</h2>');
    expect(markdownToProjectHtml('### Heading Three')).toBe('<h3>Heading Three</h3>');
  });

  it('converts a bullet list', () => {
    expect(markdownToProjectHtml('- One\n- Two')).toBe('<ul><li>One</li><li>Two</li></ul>');
  });

  it('also accepts `*` bullets', () => {
    expect(markdownToProjectHtml('* One\n* Two')).toBe('<ul><li>One</li><li>Two</li></ul>');
  });

  it('converts a numbered list', () => {
    expect(markdownToProjectHtml('1. First\n2. Second')).toBe(
      '<ol><li>First</li><li>Second</li></ol>'
    );
  });

  it('converts a paragraph, with a single newline inside becoming <br>', () => {
    // `<br />`, not `<br>` — see the converter's note: the self-closing form is what
    // `sanitize-html` re-serialises to, and matching it is what makes the converter's output
    // identical to its own sanitised form.
    expect(markdownToProjectHtml('Line one\nLine two')).toBe('<p>Line one<br />Line two</p>');
  });

  it('separates paragraphs on a blank line', () => {
    expect(markdownToProjectHtml('Para one\n\nPara two')).toBe('<p>Para one</p><p>Para two</p>');
  });

  it('converts **bold** and __bold__', () => {
    expect(markdownToProjectHtml('**bold**')).toBe('<p><strong>bold</strong></p>');
    expect(markdownToProjectHtml('__bold__')).toBe('<p><strong>bold</strong></p>');
  });

  it('converts *em* and _em_', () => {
    expect(markdownToProjectHtml('*em*')).toBe('<p><em>em</em></p>');
    expect(markdownToProjectHtml('_em_')).toBe('<p><em>em</em></p>');
  });

  it('converts an http(s)/mailto link', () => {
    expect(markdownToProjectHtml('[Balo](https://balo.expert)')).toBe(
      '<p><a href="https://balo.expert">Balo</a></p>'
    );
    expect(markdownToProjectHtml('[mail](mailto:a@b.com)')).toBe(
      '<p><a href="mailto:a@b.com">mail</a></p>'
    );
  });

  it('renders a javascript: link as plain (escaped) text, never as an <a>', () => {
    const result = markdownToProjectHtml('[click](javascript:alert(1))');
    expect(result).not.toContain('<a');
    expect(result).toContain('javascript:alert(1)');
  });

  it('escapes raw HTML embedded in the source rather than emitting it', () => {
    const result = markdownToProjectHtml('<script>alert(1)</script>');
    expect(result).not.toContain('<script>');
    expect(result).toContain('&lt;script&gt;');
  });

  it('escapes unsupported constructs (#, ####, >, ---, code fences) as literal text', () => {
    expect(markdownToProjectHtml('#### Too deep')).toContain('#### Too deep');
    expect(markdownToProjectHtml('> a quote')).toContain('&gt; a quote');
    expect(markdownToProjectHtml('---')).toContain('---');
    expect(markdownToProjectHtml('```code```')).toContain('```code```');
  });

  it('escapes an ampersand and a quote', () => {
    // `"` is NOT escaped in text content — it is not special there, and `sanitize-html`
    // decodes `&quot;` back to `"` anyway (fix round F11).
    expect(markdownToProjectHtml('Tom & Jerry "quoted"')).toBe('<p>Tom &amp; Jerry "quoted"</p>');
  });

  it('empty input yields empty output', () => {
    expect(markdownToProjectHtml('')).toBe('');
  });

  // ── F11 — nested lists ────────────────────────────────────────────────────────────────────
  describe('nested list items are FLATTENED (a deliberate, documented choice — fix round F11)', () => {
    it('an indented `- child` stays inside the list instead of breaking it', () => {
      // Before the fix this produced
      //   <ul><li>parent</li></ul><p>  - child</p><ul><li>parent two</li></ul>
      // — a broken list AND a literal bullet marker rendered as body text.
      expect(markdownToProjectHtml('- parent\n  - child\n- parent two')).toBe(
        '<ul><li>parent</li><li>child</li><li>parent two</li></ul>'
      );
    });

    it('flattens a deeply indented item too', () => {
      expect(markdownToProjectHtml('- a\n    - b\n        - c')).toBe(
        '<ul><li>a</li><li>b</li><li>c</li></ul>'
      );
    });

    it('flattens nested ordered items', () => {
      expect(markdownToProjectHtml('1. first\n   1. nested\n2. second')).toBe(
        '<ol><li>first</li><li>nested</li><li>second</li></ol>'
      );
    });

    it('a nested list of a DIFFERENT kind still becomes its own block, never literal text', () => {
      expect(markdownToProjectHtml('- parent\n  1. child')).toBe(
        '<ul><li>parent</li></ul><ol><li>child</li></ol>'
      );
    });
  });

  // ── F11 — balanced parentheses in a URL ───────────────────────────────────────────────────
  describe('link URLs may contain BALANCED parentheses (fix round F11)', () => {
    it('does not truncate a wikipedia-style URL at the first `)`', () => {
      expect(
        markdownToProjectHtml('[Salesforce](https://en.wikipedia.org/wiki/Salesforce_(company))')
      ).toBe('<p><a href="https://en.wikipedia.org/wiki/Salesforce_(company)">Salesforce</a></p>');
    });

    it('handles more than one balanced pair', () => {
      expect(markdownToProjectHtml('[x](https://e.test/a(b)c(d)e)')).toBe(
        '<p><a href="https://e.test/a(b)c(d)e">x</a></p>'
      );
    });

    it('an UNCLOSED parenthesis is not a link at all — the text is escaped through', () => {
      const result = markdownToProjectHtml('[x](https://e.test/a(b');
      expect(result).not.toContain('<a');
      expect(result).toBe('<p>[x](https://e.test/a(b</p>');
    });
  });

  // ── D4 contract — the pinning tests ───────────────────────────────────────────────────────

  /**
   * ⚠⚠ FIX ROUND F11 — THE ALPHABET CLAIM IS ONLY PROVEN IF THE CORPUS IS EXHAUSTIVE. The
   * previous corpus held only SUPPORTED constructs, so it sampled the happy path and said
   * nothing about the claim that actually matters: that everything OUTSIDE the subset is escaped
   * to text rather than passed through. Every construct a general Markdown renderer would emit a
   * non-allow-listed tag for is listed here — D4's argument, in test form.
   */
  const UNSUPPORTED_CORPUS = [
    '# H1',
    '#### H4',
    '##### H5',
    '###### H6',
    'Setext heading',
    '=============',
    '> a block quote',
    '>> a nested block quote',
    '---',
    '***',
    '___',
    '```js',
    'const x = 1;',
    '```',
    '`inline code`',
    '![alt text](https://example.com/a.png)',
    '| a | b |',
    '| 1 | 2 |',
    '~~strikethrough~~',
    '<https://autolink.test>',
    '<div class="raw">raw html block</div>',
    '<script>alert(1)</script>',
    '<img src="x" onerror="alert(1)">',
    '<blockquote>raw quote</blockquote>',
    '<!-- an html comment -->',
    'A footnote reference[^1]',
    '[^1]: the footnote body',
    'Term',
    ': definition list body',
    '&amp; a raw entity',
    '[ref link][1]',
    '[1]: https://example.com',
  ].join('\n');

  const SUPPORTED_CORPUS = [
    '## H2',
    '### H3',
    '',
    '- item one',
    '- item two',
    '  - a nested item',
    '',
    '1. first',
    '2. second',
    '',
    'Some **bold**, __also bold__, *em*, _also em_ text.',
    '',
    'Multi',
    'line',
    'paragraph.',
  ].join('\n');

  /** Every tag name the converter emitted for `markdown`. */
  function emittedTags(markdown: string): Set<string> {
    const html = markdownToProjectHtml(markdown);
    const tags = new Set<string>();
    for (const match of html.matchAll(/<\/?([a-z0-9]+)/g)) {
      const tag = match[1];
      if (tag !== undefined) tags.add(tag);
    }
    return tags;
  }

  /** What a general Markdown renderer WOULD have emitted for `UNSUPPORTED_CORPUS`. */
  const TAGS_A_FULL_RENDERER_WOULD_EMIT = [
    'h1',
    'h4',
    'h5',
    'h6',
    'blockquote',
    'hr',
    'img',
    'pre',
    'code',
    'table',
    'thead',
    'tbody',
    'tr',
    'td',
    'th',
    'del',
    's',
    'div',
    'script',
    'dl',
    'dt',
    'dd',
    'sup',
  ] as const;

  it('PINNING: every tag the converter emits for the SUPPORTED corpus is in PROJECT_HTML_ALLOWED_TAGS', () => {
    const tags = emittedTags(`${SUPPORTED_CORPUS}\n\nAnd [a link](https://example.com/a_(b)) too.`);
    // Non-vacuity: a corpus that emitted nothing would satisfy a ⊆ claim trivially.
    expect(tags.size).toBeGreaterThanOrEqual(8);
    for (const tag of tags) {
      expect((PROJECT_HTML_ALLOWED_TAGS as readonly string[]).includes(tag)).toBe(true);
    }
  });

  it('PINNING: the UNSUPPORTED corpus emits NOTHING outside the allow-list either', () => {
    const tags = emittedTags(UNSUPPORTED_CORPUS);
    for (const tag of tags) {
      expect((PROJECT_HTML_ALLOWED_TAGS as readonly string[]).includes(tag)).toBe(true);
    }
    for (const forbidden of TAGS_A_FULL_RENDERER_WOULD_EMIT) {
      expect(tags.has(forbidden), `converter emitted <${forbidden}>`).toBe(false);
    }
  });

  it('PINNING: every unsupported construct survives as ESCAPED TEXT, never as markup', () => {
    const html = markdownToProjectHtml(UNSUPPORTED_CORPUS);
    expect(html).toContain('#### H4');
    expect(html).toContain('&gt; a block quote');
    expect(html).toContain('```js');
    expect(html).toContain('`inline code`');
    expect(html).toContain('~~strikethrough~~');
    expect(html).toContain('| a | b |');
    expect(html).toContain('&lt;div class="raw"&gt;');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&lt;!-- an html comment --&gt;');
    expect(html).toContain('&amp;amp; a raw entity');
  });

  it('PINNING: sanitizeProjectHtml(convert(x)) === convert(x) for the supported corpus (already inside the boundary)', () => {
    // ⚠ Deliberately no `<a>` in this corpus: `sanitizeProjectHtml` ALWAYS forces
    // `rel`/`target` onto every anchor (a normalizing transform, not a stripping) — so any
    // link-bearing output would differ from its sanitised form by those two attributes even
    // though nothing was REMOVED. That is covered separately by the "an http(s)/mailto link"
    // and "javascript: link" tests above, and end-to-end in `get-project-brief-parse.test.ts`;
    // this test's job is proving every other supported construct survives byte-for-byte.
    const converted = markdownToProjectHtml(SUPPORTED_CORPUS);
    expect(sanitizeProjectHtml(converted)).toBe(converted);
  });

  it('PINNING: the sanitiser also leaves the UNSUPPORTED corpus untouched (nothing left to strip)', () => {
    const converted = markdownToProjectHtml(UNSUPPORTED_CORPUS);
    expect(sanitizeProjectHtml(converted)).toBe(converted);
  });
});
