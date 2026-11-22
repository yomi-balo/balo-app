import { describe, expect, it } from 'vitest';
import { renderProjectTermsPdfToBuffer } from './project-terms-pdf-document';

describe('ProjectTermsPdfDocument', () => {
  it('renders a multi-page PDF', async () => {
    const buffer = await renderProjectTermsPdfToBuffer();
    expect(buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    const pages = buffer.toString('latin1').match(/\/Type \/Page(?!s)/g) ?? [];
    expect(pages.length).toBeGreaterThan(1);
  });
});
