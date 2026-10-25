import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { fireEvent } from '@testing-library/react';

import { axe } from '@/test/axe';
import { FileViewerDialog } from './file-viewer-dialog';

const URL_A = 'https://acct.r2.cloudflarestorage.com/a.png?X-Amz-Signature=aaa';
const URL_B = 'https://acct.r2.cloudflarestorage.com/b.png?X-Amz-Signature=bbb';

function renderViewer(overrides: Partial<React.ComponentProps<typeof FileViewerDialog>> = {}) {
  const onDownload = vi.fn();
  const onOpenChange = vi.fn();
  const utils = render(
    <FileViewerDialog
      open
      onOpenChange={onOpenChange}
      fileName="BALO LinkedIn.png"
      url={URL_A}
      onDownload={onDownload}
      {...overrides}
    />
  );
  return { ...utils, onDownload, onOpenChange };
}

describe('FileViewerDialog', () => {
  it('renders the image from the presigned URL, titled with the file name', () => {
    renderViewer();
    const img = screen.getByAltText('BALO LinkedIn.png');
    expect(img).toHaveAttribute('src', URL_A);
    expect(screen.getByRole('heading', { name: 'BALO LinkedIn.png' })).toBeInTheDocument();
  });

  /**
   * ⚠ A plain `<img>` is a subresource load and ignores `Content-Disposition`; an anchor,
   * iframe or navigation would be governed by it and would download instead.
   */
  it('offers no new-tab link for an image', () => {
    renderViewer({});
    expect(screen.queryByRole('link', { name: /Open in new tab/ })).not.toBeInTheDocument();
  });

  it('shows the file with an <img>, never a navigating element', () => {
    renderViewer();
    // ⚠ `document.body`, not `container` — Radix portals DialogContent out of the render root.
    expect(document.body.querySelector('img')).not.toBeNull();
    expect(document.body.querySelector('iframe')).toBeNull();
    expect(document.body.querySelector('embed')).toBeNull();
    // No anchor pointing at the R2 URL — that would be a navigation, and the header would win.
    expect(document.body.querySelector(`a[href="${URL_A}"]`)).toBeNull();
  });

  it('shows a loading state until the image loads, then reveals it', () => {
    renderViewer();
    expect(screen.getByText('Loading preview…')).toBeInTheDocument();
    const img = screen.getByAltText('BALO LinkedIn.png');
    expect(img.className).toContain('opacity-0');

    fireEvent.load(img);

    expect(screen.queryByText('Loading preview…')).not.toBeInTheDocument();
    expect(screen.getByAltText('BALO LinkedIn.png').className).toContain('opacity-100');
  });

  it('falls back to an honest failure that still offers the download', async () => {
    const user = userEvent.setup();
    const { onDownload } = renderViewer();
    fireEvent.error(screen.getByAltText('BALO LinkedIn.png'));

    expect(screen.getByText(/preview couldn't be loaded/i)).toBeInTheDocument();
    expect(screen.queryByAltText('BALO LinkedIn.png')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Download/i }));
    expect(onDownload).toHaveBeenCalledTimes(1);
  });

  /** The URL is in hand before this mounts, so Download is never dead. */
  it('keeps Download live throughout, including before the image has loaded', async () => {
    const user = userEvent.setup();
    const { onDownload } = renderViewer();
    expect(screen.getByText('Loading preview…')).toBeInTheDocument();

    const download = screen.getByRole('button', { name: /Download/i });
    expect(download).toBeEnabled();
    await user.click(download);
    expect(onDownload).toHaveBeenCalledTimes(1);
  });

  /**
   * ⚠ Clicking straight from one image to another never closes the dialog, so a reset keyed on
   * `open` would not fire and the second image would inherit the first's settled state.
   */
  it('resets to loading when a second image opens without the dialog closing', () => {
    const { rerender, onDownload, onOpenChange } = renderViewer();
    fireEvent.error(screen.getByAltText('BALO LinkedIn.png'));
    expect(screen.getByText(/preview couldn't be loaded/i)).toBeInTheDocument();

    rerender(
      <FileViewerDialog
        open
        onOpenChange={onOpenChange}
        fileName="second.png"
        url={URL_B}
        onDownload={onDownload}
      />
    );

    expect(screen.queryByText(/preview couldn't be loaded/i)).not.toBeInTheDocument();
    expect(screen.getByAltText('second.png')).toHaveAttribute('src', URL_B);
  });

  describe('accessibility', () => {
    it('is axe-clean for an image preview', async () => {
      renderViewer({});
      expect(await axe(document.body)).toHaveNoViolations();
    });
  });

  describe('pdf', () => {
    const PDF_URL = 'https://acct.r2.cloudflarestorage.com/a.pdf?X-Amz-Signature=ccc';

    it('embeds the document in an iframe titled with the file name, and no <img>', () => {
      renderViewer({ kind: 'pdf', fileName: 'Brief.pdf', url: PDF_URL });
      const frame = document.body.querySelector('iframe');
      expect(frame).not.toBeNull();
      expect(frame).toHaveAttribute('src', PDF_URL);
      expect(frame).toHaveAttribute('title', 'Brief.pdf');
      expect(document.body.querySelector('img')).toBeNull();
    });

    it('shows a loading state until the frame loads, then reveals it', () => {
      renderViewer({ kind: 'pdf', fileName: 'Brief.pdf', url: PDF_URL });
      expect(screen.getByText('Loading preview…')).toBeInTheDocument();
      const frame = document.body.querySelector('iframe');
      if (frame === null) throw new Error('expected an iframe');
      expect(frame.className).toContain('opacity-0');
      fireEvent.load(frame);
      expect(screen.queryByText('Loading preview…')).not.toBeInTheDocument();
      expect(document.body.querySelector('iframe')?.className).toContain('opacity-100');
    });

    it('offers a new-tab link beside Download, for browsers that cannot embed a PDF', () => {
      renderViewer({ kind: 'pdf', fileName: 'Brief.pdf', url: PDF_URL });
      const link = screen.getByRole('link', { name: /Open in new tab/ });
      expect(link).toHaveAttribute('href', PDF_URL);
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    });

    it('keeps Download in the same chrome', async () => {
      const user = userEvent.setup();
      const { onDownload } = renderViewer({ kind: 'pdf', fileName: 'Brief.pdf', url: PDF_URL });
      await user.click(screen.getByRole('button', { name: /Download/ }));
      expect(onDownload).toHaveBeenCalledTimes(1);
    });
  });
});
