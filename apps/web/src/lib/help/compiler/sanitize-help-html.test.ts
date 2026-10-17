import { describe, expect, it } from 'vitest';
import { sanitizeHelpHtml } from './sanitize-help-html';

describe('sanitizeHelpHtml', () => {
  it('keeps the allow-listed tags', () => {
    const html =
      '<p>a <strong>b</strong> <em>c</em> <code>d</code><br></p><h3>h</h3><ul><li>x</li></ul>';
    expect(sanitizeHelpHtml(html)).toBe(
      '<p>a <strong>b</strong> <em>c</em> <code>d</code><br /></p><h3>h</h3><ul><li>x</li></ul>'
    );
  });

  it('strips script elements and their contents', () => {
    expect(sanitizeHelpHtml('<p>hi</p><script>alert(1)</script>')).toBe('<p>hi</p>');
  });

  it('strips event-handler attributes', () => {
    expect(sanitizeHelpHtml('<p onclick="x()">hi</p>')).toBe('<p>hi</p>');
  });

  it('strips javascript: and protocol-relative links but keeps http, mailto and relative ones', () => {
    expect(sanitizeHelpHtml('<a href="javascript:alert(1)">x</a>')).toBe('<a>x</a>');
    expect(sanitizeHelpHtml('<a href="//evil.example">x</a>')).toBe('<a>x</a>');
    expect(sanitizeHelpHtml('<a href="https://a.example" target="_blank">x</a>')).toBe(
      '<a href="https://a.example">x</a>'
    );
    expect(sanitizeHelpHtml('<a href="mailto:a@b.example">x</a>')).toBe(
      '<a href="mailto:a@b.example">x</a>'
    );
    expect(sanitizeHelpHtml('<a href="/help/x">x</a>')).toBe('<a href="/help/x">x</a>');
  });

  it('drops disallowed elements but keeps their text', () => {
    expect(sanitizeHelpHtml('<div><img src="x.png">text</div>')).toBe('text');
  });

  it.each([
    ['backslash-led', '/\\evil.example'],
    ['slash-backslash', '\\/evil.example'],
    ['entity-encoded slash-backslash', '&#47;&#92;evil.example'],
    ['entity-encoded javascript:', '&#106;avascript:alert(1)'],
    ['hex-entity javascript:', '&#x6A;avascript:alert(1)'],
    ['tab-split javascript:', 'java&#9;script:alert(1)'],
    ['literal tab-split javascript:', 'java\tscript:alert(1)'],
    ['data:', 'data:text/html,<script>alert(1)</script>'],
  ])('does not leave a navigable href for %s', (_name, href) => {
    const out = sanitizeHelpHtml(`<a href="${href}">x</a>`);
    const match = /href="([^"]*)"/.exec(out);
    if (match === null) return;
    const kept = (match[1] ?? '').toLowerCase();
    expect(kept.startsWith('//') || kept.startsWith('/\\') || kept.startsWith('\\')).toBe(false);
    expect(kept).not.toContain('javascript:');
    expect(kept).not.toContain('data:');
  });
});
