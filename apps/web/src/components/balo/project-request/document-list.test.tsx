import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@/test/utils';
import userEvent from '@testing-library/user-event';

const mockDownload = vi.fn();
vi.mock('@/app/(dashboard)/projects/[requestId]/_actions/get-request-document-download', () => ({
  getRequestDocumentDownloadAction: (...args: unknown[]) => mockDownload(...args),
}));

const mockToastError = vi.fn();
vi.mock('sonner', () => ({
  toast: { error: (...args: unknown[]) => mockToastError(...args) },
}));

import { DocumentList } from './document-list';

const DOCUMENTS = [
  { id: 'doc-1', fileName: 'brief.pdf', sizeBytes: 266072, contentType: 'application/pdf' },
];

/**
 * jsdom's `Location.assign` is a non-configurable own property, so it cannot be spied; the whole
 * `location` object is swapped for these tests and restored after.
 */
describe('DocumentList', () => {
  const realLocation = globalThis.location;
  let assign: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    assign = vi.fn();
    Object.defineProperty(globalThis, 'location', {
      configurable: true,
      value: { href: realLocation.href, origin: realLocation.origin, assign },
    });
  });

  afterEach(() => {
    Object.defineProperty(globalThis, 'location', { configurable: true, value: realLocation });
  });

  it('downloads the presigned URL in place when a document is clicked', async () => {
    const user = userEvent.setup();
    mockDownload.mockResolvedValue({ success: true, url: 'https://signed-download' });
    render(<DocumentList requestId="req-1" documents={DOCUMENTS} />);

    await user.click(screen.getByRole('button', { name: 'Download brief.pdf' }));

    expect(mockDownload).toHaveBeenCalledWith({ requestId: 'req-1', documentId: 'doc-1' });
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://signed-download'));
    expect(mockToastError).not.toHaveBeenCalled();
  });

  it('toasts the action error and opens nothing when the download is refused', async () => {
    const user = userEvent.setup();
    mockDownload.mockResolvedValue({
      success: false,
      error: 'This document is no longer available.',
    });
    render(<DocumentList requestId="req-1" documents={DOCUMENTS} />);

    await user.click(screen.getByRole('button', { name: 'Download brief.pdf' }));

    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith('This document is no longer available.')
    );
    expect(assign).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Download brief.pdf' })).toBeEnabled();
  });

  it('toasts a retry message and re-enables the row when the action call itself rejects', async () => {
    const user = userEvent.setup();
    mockDownload.mockRejectedValue(new Error('Failed to fetch'));
    render(<DocumentList requestId="req-1" documents={DOCUMENTS} />);

    await user.click(screen.getByRole('button', { name: 'Download brief.pdf' }));

    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith('Could not open this document. Please try again.')
    );
    expect(assign).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Download brief.pdf' })).toBeEnabled();
  });

  it('shows a neutral note and no buttons when nothing is attached', () => {
    render(<DocumentList requestId="req-1" documents={[]} />);

    expect(screen.getByText(/No documents attached/i)).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
