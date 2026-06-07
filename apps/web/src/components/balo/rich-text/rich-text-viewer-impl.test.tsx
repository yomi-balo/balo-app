import { describe, it, expect, beforeAll } from 'vitest';
import { render, screen, waitFor } from '@/test/utils';

// ProseMirror layout-API stubs (same as the editor impl test).
beforeAll(() => {
  if (typeof document.elementFromPoint !== 'function') {
    document.elementFromPoint = () => null;
  }
  if (typeof Range.prototype.getClientRects !== 'function') {
    Range.prototype.getClientRects = () =>
      ({
        length: 0,
        item: () => null,
        [Symbol.iterator]: function* () {},
      }) as unknown as DOMRectList;
  }
});

import RichTextViewerImpl from './rich-text-viewer-impl';

describe('RichTextViewerImpl', () => {
  it('renders the brief text read-only', async () => {
    render(<RichTextViewerImpl value="<p>Rebuild lead routing in Flow.</p>" />);
    await waitFor(() =>
      expect(screen.getByText('Rebuild lead routing in Flow.')).toBeInTheDocument()
    );
  });

  it('drops disallowed tags on parse (no script survives)', async () => {
    const { container } = render(
      <RichTextViewerImpl value="<p>Safe</p><script>alert(1)</script>" />
    );
    await waitFor(() => expect(screen.getByText('Safe')).toBeInTheDocument());
    expect(container.querySelector('script')).toBeNull();
  });

  it('preserves allow-listed formatting (strong, lists)', async () => {
    const { container } = render(
      <RichTextViewerImpl value="<p><strong>Bold</strong></p><ul><li>One</li></ul>" />
    );
    await waitFor(() => expect(container.querySelector('strong')).not.toBeNull());
    expect(container.querySelector('ul li')).not.toBeNull();
  });
});
