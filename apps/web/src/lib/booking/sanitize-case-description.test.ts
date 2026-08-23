import { describe, it, expect } from 'vitest';
import { sanitizeCaseDescription } from './sanitize-case-description';

describe('sanitizeCaseDescription', () => {
  it('strips a <script> tag and rejects the resulting empty content', () => {
    const result = sanitizeCaseDescription('<script>alert(1)</script>');
    expect(result.ok).toBe(false);
  });

  it('rejects an empty Tiptap editor emitting <p></p>', () => {
    const result = sanitizeCaseDescription('<p></p>');
    expect(result.ok).toBe(false);
  });

  it('rejects &nbsp;-only content', () => {
    const result = sanitizeCaseDescription('<p>&nbsp;</p>');
    expect(result.ok).toBe(false);
  });

  it('rejects a bare empty string', () => {
    const result = sanitizeCaseDescription('');
    expect(result.ok).toBe(false);
  });

  it('keeps allowed tags and returns the sanitised html for real text content', () => {
    const result = sanitizeCaseDescription(
      '<p>The client needs help with <strong>flows</strong>.</p>'
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.html).toContain('<strong>flows</strong>');
      expect(result.html).toContain('The client needs help with');
    }
  });

  it('strips a disallowed tag but keeps its text content, and still accepts it', () => {
    const result = sanitizeCaseDescription('<div><span>a real problem statement</span></div>');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.html).not.toContain('<div>');
      expect(result.html).toContain('a real problem statement');
    }
  });
});
