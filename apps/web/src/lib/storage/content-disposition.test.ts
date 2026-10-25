import { describe, it, expect } from 'vitest';
import { attachmentDisposition, inlineDisposition } from './content-disposition';

describe('attachmentDisposition', () => {
  it('emits a plain quoted filename for an ASCII name', () => {
    expect(attachmentDisposition('Requirements v2 (final).pdf')).toBe(
      'attachment; filename="Requirements v2 (final).pdf"'
    );
  });

  it('strips quotes, backslashes, CR and LF', () => {
    const crafted = ['a', '"', 'b', '\\', 'c', '\r', '\n', 'd.pdf'].join('');
    expect(attachmentDisposition(crafted)).toBe('attachment; filename="a_b_c__d.pdf"');
  });

  it('strips both ends of the C0 range and DEL', () => {
    const crafted = `a${String.fromCharCode(0)}b${String.fromCharCode(0x1f)}c${String.fromCharCode(0x7f)}d.pdf`;
    expect(attachmentDisposition(crafted)).toBe('attachment; filename="a_b_c_d.pdf"');
  });

  it('adds a UTF-8 filename* with an ASCII fallback for a non-ASCII name', () => {
    expect(attachmentDisposition('Brief – NDC.pdf')).toBe(
      `attachment; filename="Brief _ NDC.pdf"; filename*=UTF-8''Brief%20%E2%80%93%20NDC.pdf`
    );
  });

  it("percent-encodes the RFC 5987 non-attr-chars encodeURIComponent leaves alone: ' ( ) *", () => {
    expect(attachmentDisposition("Café's (v2)*.pdf")).toBe(
      `attachment; filename="Caf_'s (v2)*.pdf"; filename*=UTF-8''Caf%C3%A9%27s%20%28v2%29%2A.pdf`
    );
  });

  it('maps an astral character to ONE fallback underscore', () => {
    expect(attachmentDisposition('plan 📎.pdf')).toBe(
      `attachment; filename="plan _.pdf"; filename*=UTF-8''plan%20%F0%9F%93%8E.pdf`
    );
  });

  it('survives a lone surrogate instead of throwing', () => {
    const crafted = `x${String.fromCharCode(0xd800)}y.pdf`;
    expect(attachmentDisposition(crafted)).toBe(
      `attachment; filename="x_y.pdf"; filename*=UTF-8''x_y.pdf`
    );
  });

  it('keeps every header value on one line', () => {
    expect(attachmentDisposition('a\r\nSet-Cookie: x=1 – ü.pdf')).not.toMatch(/[\r\n]/);
  });
});

describe('inlineDisposition', () => {
  it('emits an inline disposition with a plain quoted filename for an ASCII name', () => {
    expect(inlineDisposition('brief.pdf')).toBe('inline; filename="brief.pdf"');
  });

  it('applies the same header-injection hardening as the attachment form', () => {
    const crafted = ['a', '"', 'b', '\\', 'c', '\r', '\n', 'd.pdf'].join('');
    expect(inlineDisposition(crafted)).toBe('inline; filename="a_b_c__d.pdf"');
  });

  it('adds a UTF-8 filename* with an ASCII fallback for a non-ASCII name', () => {
    expect(inlineDisposition('Brief – NDC.pdf')).toBe(
      `inline; filename="Brief _ NDC.pdf"; filename*=UTF-8''Brief%20%E2%80%93%20NDC.pdf`
    );
  });
});
