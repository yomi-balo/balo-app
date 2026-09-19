import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { fireEvent } from '@testing-library/react';

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

  it('shows the loading state and disables Download while the URL is still being minted', () => {
    renderViewer({ url: null });
    expect(screen.getByText('Loading preview…')).toBeInTheDocument();
    expect(screen.queryByAltText('BALO LinkedIn.png')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Download/i })).toBeDisabled();
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
});
