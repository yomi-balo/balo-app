import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { track, REQUEST_FILE_EVENTS } from '@/lib/analytics';
import { useRequestFilePreview, type PreviewTarget } from './use-request-file-preview';

const mocks = vi.hoisted(() => ({ download: vi.fn(), capture: vi.fn() }));

vi.mock('server-only', () => ({}));
vi.mock('@/app/(dashboard)/projects/[requestId]/_actions/get-request-file-download', () => ({
  getRequestFileDownloadAction: mocks.download,
}));
vi.mock('@sentry/nextjs', () => ({ captureException: mocks.capture }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const REQUEST_ID = 'a0000000-0000-4000-8000-000000000001';
const IMAGE: PreviewTarget = { id: 'f-img', fileName: 'diagram.png', contentType: 'image/png' };
const PDF: PreviewTarget = { id: 'f-pdf', fileName: 'brief.pdf', contentType: 'application/pdf' };
const DOCX: PreviewTarget = {
  id: 'f-doc',
  fileName: 'notes.docx',
  contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

function Harness({
  target,
  onDownload,
}: Readonly<{ target: PreviewTarget; onDownload: (id: string) => void }>): React.JSX.Element {
  const { preview, previewingId, viewer } = useRequestFilePreview({
    requestId: REQUEST_ID,
    viewerSide: 'client',
    onDownload,
  });
  return (
    <>
      <button type="button" onClick={() => preview(target, 'files_card')}>
        open
      </button>
      <output data-testid="busy">{previewingId ?? 'idle'}</output>
      {viewer}
    </>
  );
}

function setup(target: PreviewTarget) {
  const onDownload = vi.fn();
  render(<Harness target={target} onDownload={onDownload} />);
  return { onDownload };
}

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.download.mockResolvedValue({ success: true, url: 'https://r2/get', contentType: 'x' });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useRequestFilePreview', () => {
  it('mints a download URL for an image, then mounts the viewer with an <img>', async () => {
    const user = userEvent.setup();
    setup(IMAGE);
    await user.click(screen.getByRole('button', { name: 'open' }));
    await waitFor(() => expect(document.body.querySelector('img')).not.toBeNull());
    expect(mocks.download).toHaveBeenCalledWith({
      requestId: REQUEST_ID,
      fileId: 'f-img',
      purpose: 'download',
    });
    expect(document.body.querySelector('img')).toHaveAttribute('src', 'https://r2/get');
    expect(document.body.querySelector('iframe')).toBeNull();
    expect(track).toHaveBeenCalledWith(REQUEST_FILE_EVENTS.PREVIEWED, {
      kind: 'image',
      surface: 'files_card',
      lens: 'client',
    });
  });

  it('mints the PREVIEW url for a pdf and mounts the viewer with an iframe', async () => {
    const user = userEvent.setup();
    setup(PDF);
    await user.click(screen.getByRole('button', { name: 'open' }));
    await waitFor(() => expect(document.body.querySelector('iframe')).not.toBeNull());
    expect(mocks.download).toHaveBeenCalledWith({
      requestId: REQUEST_ID,
      fileId: 'f-pdf',
      purpose: 'preview',
    });
    expect(document.body.querySelector('iframe')).toHaveAttribute('title', 'brief.pdf');
    expect(track).toHaveBeenCalledWith(
      REQUEST_FILE_EVENTS.PREVIEWED,
      expect.objectContaining({ kind: 'pdf' })
    );
  });

  it('falls through to a download for any other type, without minting a preview', async () => {
    const user = userEvent.setup();
    const { onDownload } = setup(DOCX);
    await user.click(screen.getByRole('button', { name: 'open' }));
    expect(onDownload).toHaveBeenCalledWith('f-doc');
    expect(mocks.download).not.toHaveBeenCalled();
    expect(track).not.toHaveBeenCalled();
    expect(document.body.querySelector('iframe, img')).toBeNull();
  });

  it('covers the mint with the row’s busy state and clears it after', async () => {
    let resolve: (value: unknown) => void = () => {};
    mocks.download.mockReturnValueOnce(
      new Promise((r) => {
        resolve = r;
      })
    );
    const user = userEvent.setup();
    setup(IMAGE);
    await user.click(screen.getByRole('button', { name: 'open' }));
    expect(screen.getByTestId('busy')).toHaveTextContent('f-img');
    expect(document.body.querySelector('img')).toBeNull();
    resolve({ success: true, url: 'https://r2/get', contentType: 'image/png' });
    await waitFor(() => expect(screen.getByTestId('busy')).toHaveTextContent('idle'));
    expect(document.body.querySelector('img')).not.toBeNull();
  });

  it('toasts the server’s reason and mounts no viewer when the mint is refused', async () => {
    mocks.download.mockResolvedValueOnce({
      success: false,
      error: 'This file is no longer available.',
    });
    const user = userEvent.setup();
    setup(PDF);
    await user.click(screen.getByRole('button', { name: 'open' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('This file is no longer available.')
    );
    expect(document.body.querySelector('iframe')).toBeNull();
    expect(track).not.toHaveBeenCalled();
  });

  it('reports a rejected call to Sentry and toasts a retry hint', async () => {
    mocks.download.mockRejectedValueOnce(new Error('offline'));
    const user = userEvent.setup();
    setup(IMAGE);
    await user.click(screen.getByRole('button', { name: 'open' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Could not open this file. Please try again.')
    );
    expect(mocks.capture).toHaveBeenCalled();
    expect(screen.getByTestId('busy')).toHaveTextContent('idle');
  });

  it('runs the viewer’s Download through the plain download path', async () => {
    const user = userEvent.setup();
    const { onDownload } = setup(IMAGE);
    await user.click(screen.getByRole('button', { name: 'open' }));
    await waitFor(() => expect(document.body.querySelector('img')).not.toBeNull());
    await user.click(screen.getByRole('button', { name: /Download/ }));
    expect(onDownload).toHaveBeenCalledWith('f-img');
  });

  it('unmounts the viewer when it is dismissed', async () => {
    const user = userEvent.setup();
    setup(IMAGE);
    await user.click(screen.getByRole('button', { name: 'open' }));
    await waitFor(() => expect(document.body.querySelector('img')).not.toBeNull());
    fireEvent.keyDown(document.body.querySelector('[role="dialog"]') as Element, { key: 'Escape' });
    await waitFor(() => expect(document.body.querySelector('img')).toBeNull());
  });

  describe('on iOS', () => {
    function stubIos(open: () => Window | null): void {
      vi.stubGlobal('navigator', { userAgent: IPHONE, platform: 'iPhone', maxTouchPoints: 5 });
      vi.stubGlobal('open', open);
    }

    it('opens the tab synchronously in the click and points it at the preview URL afterwards', async () => {
      const tab = { location: { href: '' }, close: vi.fn() } as unknown as Window;
      const open = vi.fn(() => tab);
      stubIos(open);
      let resolve: (value: unknown) => void = () => {};
      mocks.download.mockReturnValueOnce(
        new Promise((r) => {
          resolve = r;
        })
      );
      setup(PDF);
      fireEvent.click(screen.getByRole('button', { name: 'open' }));
      expect(open).toHaveBeenCalledWith('', '_blank');
      expect(tab.location.href).toBe('');
      resolve({ success: true, url: 'https://r2/preview', contentType: 'application/pdf' });
      await waitFor(() => expect(tab.location.href).toBe('https://r2/preview'));
      expect(document.body.querySelector('iframe')).toBeNull();
    });

    it('closes the pre-opened tab when the mint fails', async () => {
      const tab = { location: { href: '' }, close: vi.fn() } as unknown as Window;
      stubIos(() => tab);
      mocks.download.mockResolvedValueOnce({ success: false, error: 'Gone.' });
      setup(PDF);
      fireEvent.click(screen.getByRole('button', { name: 'open' }));
      await waitFor(() => expect(tab.close).toHaveBeenCalled());
      expect(toast.error).toHaveBeenCalledWith('Gone.');
    });

    it('falls back to the in-app viewer when the browser refuses the tab', async () => {
      stubIos(() => null);
      setup(PDF);
      fireEvent.click(screen.getByRole('button', { name: 'open' }));
      await waitFor(() => expect(document.body.querySelector('iframe')).not.toBeNull());
    });

    it('does not open a tab for an image', async () => {
      const open = vi.fn(() => null);
      stubIos(open);
      setup(IMAGE);
      fireEvent.click(screen.getByRole('button', { name: 'open' }));
      await waitFor(() => expect(document.body.querySelector('img')).not.toBeNull());
      expect(open).not.toHaveBeenCalled();
    });
  });
});
