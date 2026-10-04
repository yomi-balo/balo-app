import { describe, it, expect } from 'vitest';
import { WORK_HISTORY_HTML_ALLOWED_TAGS } from './allowed-tags';
import { sanitizeResponsibilitiesHtml } from './work-history-html';

describe('sanitizeResponsibilitiesHtml', () => {
  it('keeps the minimal editor’s formatting', () => {
    const html = '<p><strong>Led</strong> <em>delivery</em></p><ul><li>CPQ</li></ul>';
    expect(sanitizeResponsibilitiesHtml(html)).toBe(html);
  });

  it('strips scripts, event handlers and unknown tags', () => {
    expect(
      sanitizeResponsibilitiesHtml(
        '<p onclick="x()">Ran CPQ</p><script>alert(1)</script><iframe src="x"></iframe>'
      )
    ).toBe('<p>Ran CPQ</p>');
  });

  it('reduces every link to its text — nothing on a public profile is clickable', () => {
    expect(
      sanitizeResponsibilitiesHtml(
        '<p>Book me at <a href="https://example.com">example.com</a> or <a href="javascript:alert(1)">here</a></p>'
      )
    ).toBe('<p>Book me at example.com or here</p>');
  });

  it('turns headings into paragraphs and numbered lists into bullets — never orphan items', () => {
    expect(sanitizeResponsibilitiesHtml('<h2>Hire me</h2><ol><li>One</li></ol><h3>Now</h3>')).toBe(
      '<p>Hire me</p><ul><li>One</li></ul><p>Now</p>'
    );
  });

  it('allows exactly the shared work-history list, so editor and sanitiser cannot drift', () => {
    expect([...WORK_HISTORY_HTML_ALLOWED_TAGS].sort((a, b) => a.localeCompare(b))).toEqual([
      'b',
      'br',
      'em',
      'i',
      'li',
      'p',
      'strong',
      'ul',
    ]);
  });

  it('turns legacy plain text into escaped paragraphs', () => {
    expect(sanitizeResponsibilitiesHtml('Led <team>\nRan CPQ')).toBe(
      '<p>Led &lt;team&gt;</p><p>Ran CPQ</p>'
    );
  });

  it('shows non-editor markup as literal text — escaped, never executed', () => {
    expect(sanitizeResponsibilitiesHtml('<script>x</script>')).toBe(
      '<p>&lt;script&gt;x&lt;/script&gt;</p>'
    );
  });

  it.each(['', '<p></p>', '<p> </p>', '<p><script>x</script></p>', null, undefined])(
    'returns an empty string for an effectively empty %s',
    (value) => {
      expect(sanitizeResponsibilitiesHtml(value)).toBe('');
    }
  );
});
