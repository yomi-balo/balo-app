import { describe, expect, it } from 'vitest';
import { renderProjectTermsPdfToBuffer } from './project-terms-pdf-document';

describe('ProjectTermsPdfDocument', () => {
  it('renders a multi-page PDF', async () => {
    const buffer = await renderProjectTermsPdfToBuffer();
    expect(buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    const pages = buffer.toString('latin1').match(/\/Type \/Page(?!s)/g) ?? [];
    expect(pages.length).toBeGreaterThan(1);
  });

  it('embeds each Geist weight it uses as its own font', async () => {
    const pdf = (await renderProjectTermsPdfToBuffer()).toString('latin1');
    const fonts = new Set(
      [...pdf.matchAll(/\/BaseFont \/[A-Z]{6}\+(Geist-\w+)/g)].map((m) => m[1])
    );
    expect([...fonts].sort()).toEqual([
      'Geist-Bold',
      'Geist-Medium',
      'Geist-Regular',
      'Geist-SemiBold',
    ]);
  });
});
