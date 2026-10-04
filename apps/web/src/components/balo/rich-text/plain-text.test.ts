import { describe, it, expect } from 'vitest';
import {
  htmlToPlainText,
  plainTextLength,
  isDescriptionEmpty,
  validateDescription,
  normalizeLinkUrl,
  DESCRIPTION_MAX_TEXT,
  isRichTextHtml,
  toRichTextHtml,
} from './plain-text';

describe('htmlToPlainText', () => {
  it('strips tags and collapses whitespace', () => {
    expect(htmlToPlainText('<p>Hello   <strong>world</strong></p>')).toBe('Hello world');
  });

  it('decodes the common entities Tiptap emits', () => {
    expect(htmlToPlainText('<p>A &amp; B &lt;C&gt; &quot;D&quot; &#39;E&#39;&nbsp;F</p>')).toBe(
      'A & B <C> "D" \'E\' F'
    );
  });

  it('treats an empty paragraph as no text', () => {
    expect(htmlToPlainText('<p></p>')).toBe('');
  });
});

describe('plainTextLength / isDescriptionEmpty', () => {
  it('measures plain-text length, not HTML length', () => {
    expect(plainTextLength('<p><strong>hi</strong></p>')).toBe(2);
  });

  it('an empty paragraph is empty', () => {
    expect(isDescriptionEmpty('<p></p>')).toBe(true);
    expect(isDescriptionEmpty('<p>x</p>')).toBe(false);
  });
});

describe('validateDescription', () => {
  it('rejects empty / too-short briefs', () => {
    expect(validateDescription('<p></p>')).toMatch(/add a few words/i);
    expect(validateDescription('<p>short</p>')).toMatch(/add a few words/i);
  });

  it('accepts a brief over the minimum', () => {
    expect(validateDescription('<p>This is a long enough brief.</p>')).toBeNull();
  });

  it('rejects a brief over the max', () => {
    const long = `<p>${'a'.repeat(DESCRIPTION_MAX_TEXT + 1)}</p>`;
    expect(validateDescription(long)).toMatch(/under .* characters/i);
  });
});

describe('normalizeLinkUrl', () => {
  it('prepends https:// when no scheme is present', () => {
    expect(normalizeLinkUrl('example.com')).toBe('https://example.com');
  });

  it('passes through http/https/mailto', () => {
    expect(normalizeLinkUrl('http://x.com')).toBe('http://x.com');
    expect(normalizeLinkUrl('https://x.com')).toBe('https://x.com');
    expect(normalizeLinkUrl('mailto:a@b.com')).toBe('mailto:a@b.com');
  });

  it('rejects unsafe schemes', () => {
    expect(normalizeLinkUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeLinkUrl('data:text/html,<script>')).toBeNull();
    expect(normalizeLinkUrl('ftp://x.com')).toBeNull();
  });

  it('rejects empty input', () => {
    expect(normalizeLinkUrl('   ')).toBeNull();
  });
});

describe('isRichTextHtml', () => {
  it.each(['<p>x</p>', '  <ul><li>x</li></ul>', '<h2>x</h2>', '<ol><li>x</li></ol>', '<P>x</P>'])(
    'recognises editor HTML: %s',
    (value) => {
      expect(isRichTextHtml(value)).toBe(true);
    }
  );

  it.each(['Led projects.', 'a <b> c', '<3 Salesforce', '<pre>x</pre>', ''])(
    'treats %s as plain text',
    (value) => {
      expect(isRichTextHtml(value)).toBe(false);
    }
  );
});

describe('toRichTextHtml', () => {
  it('passes editor HTML through untouched', () => {
    expect(toRichTextHtml('<p><strong>Led</strong></p>')).toBe('<p><strong>Led</strong></p>');
  });

  it('turns each non-blank line of legacy plain text into a paragraph', () => {
    expect(toRichTextHtml('Led delivery\n\n  Ran CPQ  \r\nTrained admins')).toBe(
      '<p>Led delivery</p><p>Ran CPQ</p><p>Trained admins</p>'
    );
  });

  it('escapes legacy plain text so it can never become markup', () => {
    expect(toRichTextHtml(`a <script>x</script> & "b" 'c'`)).toBe(
      '<p>a &lt;script&gt;x&lt;/script&gt; &amp; &quot;b&quot; &#39;c&#39;</p>'
    );
  });

  it.each([null, undefined, '', '   \n  '])('returns an empty string for %s', (value) => {
    expect(toRichTextHtml(value)).toBe('');
  });

  it('keeps the visible text of legacy plain text intact', () => {
    expect(htmlToPlainText(toRichTextHtml('A & B <C>'))).toBe('A & B <C>');
  });
});
