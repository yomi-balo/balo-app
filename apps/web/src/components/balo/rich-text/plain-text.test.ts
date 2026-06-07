import { describe, it, expect } from 'vitest';
import {
  htmlToPlainText,
  plainTextLength,
  isDescriptionEmpty,
  validateDescription,
  normalizeLinkUrl,
  DESCRIPTION_MAX_TEXT,
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
