import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));

const { mockRequest, mockConfirm, mockRemove } = vi.hoisted(() => ({
  mockRequest: vi.fn(),
  mockConfirm: vi.fn(),
  mockRemove: vi.fn(),
}));
vi.mock('@/lib/project-request/actions/request-project-document-upload', () => ({
  requestProjectDocumentUploadAction: mockRequest,
}));
vi.mock('@/lib/project-request/actions/confirm-project-document-upload', () => ({
  confirmProjectDocumentUploadAction: mockConfirm,
}));
vi.mock('@/lib/project-request/actions/remove-project-document', () => ({
  removeProjectDocumentAction: mockRemove,
}));

import { DocumentUploader } from './document-uploader';

const mockToast = vi.mocked(toast);

function makeFile(name: string, type: string, size: number): File {
  const file = new File(['x'], name, { type });
  Object.defineProperty(file, 'size', { value: size });
  return file;
}

/** A controllable mock XHR whose `send` immediately succeeds (200). */
class MockXhr {
  upload = { onprogress: null as ((e: ProgressEvent) => void) | null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  status = 200;
  open = vi.fn();
  setRequestHeader = vi.fn();
  abort = vi.fn();
  send = vi.fn(() => {
    this.upload.onprogress?.({ lengthComputable: true, loaded: 100, total: 100 } as ProgressEvent);
    this.onload?.();
  });
}

describe('DocumentUploader', () => {
  let originalXhr: typeof XMLHttpRequest;

  beforeEach(() => {
    vi.clearAllMocks();
    originalXhr = globalThis.XMLHttpRequest;
    globalThis.XMLHttpRequest = MockXhr as unknown as typeof XMLHttpRequest;
    mockRequest.mockResolvedValue({
      success: true,
      presignedUrl: 'https://r2/put',
      key: 'project-documents/c/u/k',
    });
    mockConfirm.mockResolvedValue({
      success: true,
      document: {
        r2Key: 'project-documents/c/u/k',
        fileName: 'spec.pdf',
        contentType: 'application/pdf',
        sizeBytes: 1000,
      },
    });
    mockRemove.mockResolvedValue({ success: true });
  });

  afterEach(() => {
    globalThis.XMLHttpRequest = originalXhr;
  });

  it('renders the idle drop zone', () => {
    render(<DocumentUploader onDocumentsChange={vi.fn()} />);
    expect(screen.getByText(/drag files here or browse/i)).toBeInTheDocument();
  });

  it('rejects an unsupported type before any network call + toasts', async () => {
    // `fireEvent.change` bypasses the input's `accept` filter (as a real
    // drag-drop would) so the client-side type guard is what does the rejecting.
    const { container } = render(<DocumentUploader onDocumentsChange={vi.fn()} />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;

    fireEvent.change(input, { target: { files: [makeFile('a.gif', 'image/gif', 100)] } });

    await waitFor(() =>
      expect(mockToast.error).toHaveBeenCalledWith(expect.stringMatching(/isn't a supported type/i))
    );
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('rejects a file over 5 MB before upload', async () => {
    const { container } = render(<DocumentUploader onDocumentsChange={vi.fn()} />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;

    fireEvent.change(input, {
      target: { files: [makeFile('big.pdf', 'application/pdf', 6 * 1024 * 1024)] },
    });

    await waitFor(() =>
      expect(mockToast.error).toHaveBeenCalledWith(expect.stringMatching(/5 MB or smaller/i))
    );
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('uploads a valid file through presign→PUT→confirm and bubbles the confirmed ref', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { container } = render(<DocumentUploader onDocumentsChange={onChange} />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;

    await user.upload(input, makeFile('spec.pdf', 'application/pdf', 1000));

    await waitFor(() => expect(screen.getByText('Attached')).toBeInTheDocument());
    expect(mockRequest).toHaveBeenCalledWith({
      contentType: 'application/pdf',
      fileName: 'spec.pdf',
    });
    expect(mockConfirm).toHaveBeenCalled();
    // Final onChange carries the confirmed ref.
    expect(onChange).toHaveBeenLastCalledWith([
      expect.objectContaining({ r2Key: 'project-documents/c/u/k', fileName: 'spec.pdf' }),
    ]);
  });

  it('shows a failed row + Retry on upload error, then succeeds on retry', async () => {
    const user = userEvent.setup();
    mockConfirm.mockResolvedValueOnce({ success: false, error: 'nope' });
    const { container } = render(<DocumentUploader onDocumentsChange={vi.fn()} />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;

    await user.upload(input, makeFile('spec.pdf', 'application/pdf', 1000));

    const retry = await screen.findByRole('button', { name: /retry/i });
    expect(mockToast.error).toHaveBeenCalledWith(expect.stringMatching(/couldn't upload/i));

    await user.click(retry);
    await waitFor(() => expect(screen.getByText('Attached')).toBeInTheDocument());
  });

  it('removes a confirmed file (best-effort R2 delete) and updates the parent', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { container } = render(<DocumentUploader onDocumentsChange={onChange} />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;

    await user.upload(input, makeFile('spec.pdf', 'application/pdf', 1000));
    await waitFor(() => expect(screen.getByText('Attached')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /remove spec\.pdf/i }));

    expect(mockRemove).toHaveBeenCalledWith({ key: 'project-documents/c/u/k' });
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith([]));
  });
});
