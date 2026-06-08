import { describe, it, expect, vi } from 'vitest';

// `project-html.ts` imports `server-only`, which throws outside an RSC. Stub it.
vi.mock('server-only', () => ({}));

import { sanitizeProjectHtml } from './project-html';

describe('sanitizeProjectHtml', () => {
  describe('allow-list — kept tags', () => {
    it('keeps the allowed formatting tags', () => {
      const input =
        '<p>Intro <strong>bold</strong> <em>italic</em> <b>b</b> <i>i</i></p>' +
        '<h2>Heading two</h2><h3>Heading three</h3>' +
        '<ul><li>one</li></ul><ol><li>two</li></ol><br />';
      const out = sanitizeProjectHtml(input);
      expect(out).toContain('<p>');
      expect(out).toContain('<strong>bold</strong>');
      expect(out).toContain('<em>italic</em>');
      expect(out).toContain('<b>b</b>');
      expect(out).toContain('<i>i</i>');
      expect(out).toContain('<h2>Heading two</h2>');
      expect(out).toContain('<h3>Heading three</h3>');
      expect(out).toContain('<ul><li>one</li></ul>');
      expect(out).toContain('<ol><li>two</li></ol>');
      expect(out).toContain('<br />');
    });

    it('preserves plain text content for tags it strips', () => {
      const out = sanitizeProjectHtml('<div><span>just text</span></div>');
      expect(out).toContain('just text');
      expect(out).not.toContain('<div>');
      expect(out).not.toContain('<span>');
    });
  });

  describe('XSS — dangerous content stripped', () => {
    it('strips <script> tags entirely', () => {
      const out = sanitizeProjectHtml('<p>hi</p><script>alert(1)</script>');
      expect(out).not.toContain('<script');
      expect(out).not.toContain('alert(1)');
      expect(out).toContain('<p>hi</p>');
    });

    it('strips inline event handlers like onerror', () => {
      const out = sanitizeProjectHtml('<img src=x onerror="alert(1)" /><p>safe</p>');
      expect(out).not.toContain('onerror');
      expect(out).not.toContain('<img');
      expect(out).toContain('<p>safe</p>');
    });

    it('strips javascript: scheme hrefs', () => {
      const out = sanitizeProjectHtml('<a href="javascript:alert(1)">click</a>');
      expect(out).not.toContain('javascript:');
      // text is preserved, the unsafe href is dropped
      expect(out).toContain('click');
    });

    it('strips data: scheme hrefs', () => {
      const out = sanitizeProjectHtml('<a href="data:text/html,<script>1</script>">x</a>');
      expect(out).not.toContain('data:');
    });

    it('drops protocol-relative URLs', () => {
      const out = sanitizeProjectHtml('<a href="//evil.com">x</a>');
      expect(out).not.toContain('//evil.com');
    });
  });

  describe('link hardening', () => {
    it('keeps http/https/mailto links and forces rel + target', () => {
      const out = sanitizeProjectHtml('<a href="https://balo.expert">Balo</a>');
      expect(out).toContain('href="https://balo.expert"');
      expect(out).toContain('rel="noopener noreferrer nofollow"');
      expect(out).toContain('target="_blank"');
    });

    it('keeps mailto links', () => {
      const out = sanitizeProjectHtml('<a href="mailto:hi@balo.expert">mail</a>');
      expect(out).toContain('href="mailto:hi@balo.expert"');
    });

    it('overrides a client-supplied rel/target with the hardened values', () => {
      const out = sanitizeProjectHtml(
        '<a href="https://x.com" rel="dofollow" target="_self">x</a>'
      );
      expect(out).toContain('rel="noopener noreferrer nofollow"');
      expect(out).toContain('target="_blank"');
      expect(out).not.toContain('dofollow');
      expect(out).not.toContain('_self');
    });
  });

  describe('edge cases', () => {
    it('returns an empty string for an empty input', () => {
      expect(sanitizeProjectHtml('')).toBe('');
    });

    it('returns whitespace-only / no-content for markup with no text', () => {
      const out = sanitizeProjectHtml('<script>bad()</script>');
      expect(out.trim()).toBe('');
    });
  });
});
