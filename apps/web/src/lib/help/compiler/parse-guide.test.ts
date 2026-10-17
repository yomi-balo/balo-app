import { describe, expect, it } from 'vitest';
import { parseHelpDoc } from './parse-guide';

const FM = '---\ntitle: T\n---\n';

function parse(body: string, filename = 'a-guide.md') {
  return parseHelpDoc(filename, `${FM}${body}`);
}

describe('parseHelpDoc: frontmatter', () => {
  it('reads the YAML block and the slug from the filename', () => {
    const doc = parse('Hello.\n');
    expect(doc.slug).toBe('a-guide');
    expect(doc.frontmatter).toEqual({ title: 'T' });
  });

  it('keeps an ISO date as a string', () => {
    const doc = parseHelpDoc('a.md', '---\nupdated: 2026-10-17\n---\nx\n');
    expect(doc.frontmatter).toEqual({ updated: '2026-10-17' });
  });

  it('reports missing frontmatter', () => {
    const doc = parseHelpDoc('a.md', 'No fence here.\n');
    expect(doc.frontmatter).toBeUndefined();
    expect(doc.issues.map((issue) => issue.code)).toEqual(['missing_frontmatter']);
  });

  it('reports YAML that cannot be parsed', () => {
    const doc = parseHelpDoc('a.md', '---\ntitle: [unclosed\n---\nx\n');
    expect(doc.issues.map((issue) => issue.code)).toEqual(['invalid_frontmatter']);
  });

  it('accepts a closing fence at the end of the file', () => {
    const doc = parseHelpDoc('a.md', '---\ntitle: T\n---');
    expect(doc.frontmatter).toEqual({ title: 'T' });
    expect(doc.sections).toEqual([]);
  });

  it('treats an unclosed fence as missing frontmatter', () => {
    const doc = parseHelpDoc('a.md', '---\ntitle: T\n');
    expect(doc.issues.map((issue) => issue.code)).toContain('missing_frontmatter');
  });

  it('handles CRLF line endings', () => {
    const doc = parseHelpDoc('a.md', '---\r\ntitle: T\r\n---\r\n## One\r\n\r\nText.\r\n');
    expect(doc.frontmatter).toEqual({ title: 'T' });
    expect(doc.sections).toHaveLength(1);
  });
});

describe('parseHelpDoc: sections', () => {
  it('numbers ## sections from 1 in document order and puts earlier content in the intro', () => {
    const doc = parse('Intro text.\n\n## One\n\nA.\n\n## Two\n\nB.\n\n## Three\n\nC.\n');
    expect(doc.intro).toEqual([{ id: 'intro-b0', kind: 'html', html: '<p>Intro text.</p>' }]);
    expect(doc.sections.map((section) => [section.n, section.title])).toEqual([
      [1, 'One'],
      [2, 'Two'],
      [3, 'Three'],
    ]);
    expect(doc.sections[1]?.blocks).toEqual([{ id: 's2-b0', kind: 'html', html: '<p>B.</p>' }]);
  });

  it('uses plain text, with markup removed and entities decoded, for the title', () => {
    const doc = parse('## Pay & go with **bold** and `code`\n\nx\n');
    expect(doc.sections[0]?.title).toBe('Pay & go with bold and code');
  });

  it('decodes &amp; last, so &amp;lt; reads as the text &lt;', () => {
    const doc = parse('## Use &amp;lt; here\n\nx\n');
    expect(doc.sections[0]?.title).toBe('Use &lt; here');
  });

  it('keeps h3 headings inside a section as html', () => {
    const doc = parse('## One\n\n### Detail\n\nText.\n');
    expect(doc.sections[0]?.blocks).toEqual([
      { id: 's1-b0', kind: 'html', html: '<h3>Detail</h3>\n<p>Text.</p>' },
    ]);
  });

  it('reports a level-one heading in the body', () => {
    const doc = parse('# Title\n\n## One\n\nx\n');
    expect(doc.issues.map((issue) => issue.code)).toEqual(['h1_in_body']);
  });

  it('sanitises script, handlers and javascript: links', () => {
    const doc = parse(
      '## One\n\n<script>alert(1)</script>\n\n<p onclick="x()">Hi</p>\n\n[bad](javascript:alert(1))\n'
    );
    const html = doc.sections[0]?.blocks
      .map((block) => (block.kind === 'html' ? block.html : ''))
      .join('');
    expect(html).not.toContain('script');
    expect(html).not.toContain('onclick');
    expect(html).not.toContain('javascript:');
    expect(html).toContain('Hi');
  });
});

describe('parseHelpDoc: callouts and images', () => {
  it('turns a blockquote into a callout', () => {
    const doc = parse('## One\n\n> Mind the **gap**.\n');
    expect(doc.sections[0]?.blocks).toEqual([
      { id: 's1-b0', kind: 'callout', html: '<p>Mind the <strong>gap</strong>.</p>' },
    ]);
  });

  it('makes the first image in a section its screenshot, with light and dark paths', () => {
    const doc = parse('## One\n\nText.\n\n![A booking summary](01-book-button)\n');
    expect(doc.sections[0]?.screenshot).toEqual({
      alt: 'A booking summary',
      lightSrc: '/help/a-guide/01-book-button-light.png',
      darkSrc: '/help/a-guide/01-book-button-dark.png',
    });
    expect(doc.sections[0]?.blocks).toEqual([{ id: 's1-b0', kind: 'html', html: '<p>Text.</p>' }]);
  });

  it('makes a second image in the section an image block, in place', () => {
    const doc = parse('## One\n\n![First](a-one)\n\nBetween.\n\n![Second](a-two)\n');
    expect(doc.sections[0]?.screenshot?.alt).toBe('First');
    expect(doc.sections[0]?.blocks).toEqual([
      { id: 's1-b0', kind: 'html', html: '<p>Between.</p>' },
      {
        id: 's1-b1',
        kind: 'image',
        image: {
          alt: 'Second',
          lightSrc: '/help/a-guide/a-two-light.png',
          darkSrc: '/help/a-guide/a-two-dark.png',
        },
      },
    ]);
  });

  it('makes an intro image an image block', () => {
    const doc = parse('![Intro](intro-shot)\n\n## One\n\nx\n');
    expect(doc.intro).toEqual([
      {
        id: 'intro-b0',
        kind: 'image',
        image: {
          alt: 'Intro',
          lightSrc: '/help/a-guide/intro-shot-light.png',
          darkSrc: '/help/a-guide/intro-shot-dark.png',
        },
      },
    ]);
  });

  it('reports an image mixed into a sentence', () => {
    const doc = parse('## One\n\nSee ![shot](a-shot) here.\n');
    expect(doc.issues.map((issue) => issue.code)).toEqual(['inline_image']);
  });

  it.each([
    ['a list item', '## One\n\n- step\n- ![shot](a-shot)\n'],
    ['a blockquote', '## One\n\n> ![shot](a-shot)\n'],
    ['a heading', '## One\n\n### ![shot](a-shot)\n'],
  ])('reports an image nested in %s', (_name, body) => {
    expect(parse(body).issues.map((issue) => issue.code)).toEqual(['inline_image']);
  });

  it('reports an image in a table cell as both nested and unsupported', () => {
    const codes = parse('## One\n\n| a |\n| - |\n| ![shot](a-shot) |\n').issues.map((i) => i.code);
    expect(codes).toEqual(['unsupported_markdown', 'inline_image']);
  });

  it('reports an image reference that is not a bare kebab name', () => {
    const doc = parse('## One\n\n![shot](https://x.example/a.png)\n\n![shot](Not_Kebab)\n');
    expect(doc.issues.map((issue) => issue.code)).toEqual([
      'invalid_image_ref',
      'invalid_image_ref',
    ]);
    expect(doc.sections[0]?.screenshot).toBeNull();
  });
});
