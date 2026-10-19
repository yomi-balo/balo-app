import { describe, it, expect, vi, beforeEach } from 'vitest';
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

describe('DocumentList', () => {
  const mockOpen = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('open', mockOpen);
  });

  it('opens the presigned URL in a new tab when a document is clicked', async () => {
    const user = userEvent.setup();
    mockDownload.mockResolvedValue({ success: true, url: 'https://signed-download' });
    render(<DocumentList requestId="req-1" documents={DOCUMENTS} />);

    await user.click(screen.getByRole('button', { name: 'Download brief.pdf' }));

    expect(mockDownload).toHaveBeenCalledWith({ requestId: 'req-1', documentId: 'doc-1' });
    await waitFor(() =>
      expect(mockOpen).toHaveBeenCalledWith(
        'https://signed-download',
        '_blank',
        'noopener,noreferrer'
      )
    );
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
    expect(mockOpen).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Download brief.pdf' })).toBeEnabled();
  });

  it('shows a neutral note and no buttons when nothing is attached', () => {
    render(<DocumentList requestId="req-1" documents={[]} />);

    expect(screen.getByText(/No documents attached/i)).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
