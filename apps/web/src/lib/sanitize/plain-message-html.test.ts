import { describe, it, expect, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { plainMessageToHtml } from './plain-message-html';
import { sanitizeProjectHtml } from './project-html';

describe('plainMessageToHtml', () => {
  it('wraps a single line in one paragraph', () => {
    expect(plainMessageToHtml('Hello there')).toBe('<p>Hello there</p>');
  });

  it('returns empty string for whitespace-only input', () => {
    expect(plainMessageToHtml('   \n\n  ')).toBe('');
    expect(plainMessageToHtml('')).toBe('');
  });

  it('splits blank-line-separated text into paragraphs', () => {
    expect(plainMessageToHtml('First\n\nSecond')).toBe('<p>First</p><p>Second</p>');
  });

  it('converts single newlines to <br />', () => {
    expect(plainMessageToHtml('line one\nline two')).toBe('<p>line one<br />line two</p>');
  });

  it('normalises CRLF newlines', () => {
    expect(plainMessageToHtml('a\r\nb\r\n\r\nc')).toBe('<p>a<br />b</p><p>c</p>');
  });

  it('escapes HTML entities', () => {
    expect(plainMessageToHtml('a < b & "c" > \'d\'')).toBe(
      '<p>a &lt; b &amp; &quot;c&quot; &gt; &#39;d&#39;</p>'
    );
  });

  it('neutralises a script injection (also after sanitizeProjectHtml)', () => {
    const html = plainMessageToHtml('<script>alert(1)</script>');
    expect(html).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
    // Belt-and-braces pass the actions run before persisting.
    const safe = sanitizeProjectHtml(html);
    expect(safe).not.toContain('<script>');
    expect(safe).toContain('&lt;script&gt;');
  });

  it('survives sanitizeProjectHtml unchanged for normal text (p/br are allow-listed)', () => {
    const html = plainMessageToHtml('Hello\nworld\n\nBye');
    expect(sanitizeProjectHtml(html)).toBe(html);
  });
});
