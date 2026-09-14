import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useState } from 'react';
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
import type { ProjectDocumentRef } from '@/lib/project-request/actions/schemas';

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

  // ── BAL-254 W1 — seeding from already-confirmed refs ─────────────────────────────────────
  describe('initialDocuments (BAL-254 W1)', () => {
    const SEEDED = [
      {
        r2Key: 'project-documents/c/u/k1',
        fileName: 'rfp.pdf',
        contentType: 'application/pdf' as const,
        sizeBytes: 1000,
      },
      {
        r2Key: 'project-documents/c/u/k2',
        fileName: 'notes.png',
        contentType: 'image/png' as const,
        sizeBytes: 2000,
      },
      {
        r2Key: 'project-documents/c/u/k3',
        fileName: 'scope.pdf',
        contentType: 'application/pdf' as const,
        sizeBytes: 3000,
      },
    ];

    /**
     * ⚠⚠ THE BUG THIS CLOSES. The component owns its rows and `onDocumentsChange` REPLACES the
     * caller's list, so every remount over a draft that already held documents (review →
     * "Change source documents", review → Edit → manual) landed on an EMPTY dropzone and the
     * first file added there emitted a ONE-element list — silently dropping the originals from
     * both the parse input and the request's attachments.
     */
    it('⚠ renders three seeded rows as already-attached, and a fourth file yields FOUR refs, not one', async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      const { container } = render(
        <DocumentUploader initialDocuments={SEEDED} onDocumentsChange={onChange} />
      );

      // The three rows are on screen, already confirmed (no re-upload, no network call).
      expect(screen.getByText('rfp.pdf')).toBeInTheDocument();
      expect(screen.getByText('notes.png')).toBeInTheDocument();
      expect(screen.getByText('scope.pdf')).toBeInTheDocument();
      expect(screen.getAllByText('Attached')).toHaveLength(3);
      expect(mockRequest).not.toHaveBeenCalled();
      expect(mockConfirm).not.toHaveBeenCalled();
      // Seeding does NOT publish — the caller is where these came from.
      expect(onChange).not.toHaveBeenCalled();

      const input = container.querySelector('input[type="file"]') as HTMLInputElement;
      await user.upload(input, makeFile('spec.pdf', 'application/pdf', 1000));

      await waitFor(() => expect(screen.getAllByText('Attached')).toHaveLength(4));
      expect(onChange).toHaveBeenLastCalledWith([
        expect.objectContaining({ r2Key: 'project-documents/c/u/k1' }),
        expect.objectContaining({ r2Key: 'project-documents/c/u/k2' }),
        expect.objectContaining({ r2Key: 'project-documents/c/u/k3' }),
        expect.objectContaining({ r2Key: 'project-documents/c/u/k' }),
      ]);
    });

    it('Remove still works on a seeded row (and best-effort deletes the R2 object)', async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      render(<DocumentUploader initialDocuments={SEEDED} onDocumentsChange={onChange} />);

      await user.click(screen.getByRole('button', { name: /remove notes\.png/i }));

      expect(mockRemove).toHaveBeenCalledWith({ key: 'project-documents/c/u/k2' });
      await waitFor(() =>
        expect(onChange).toHaveBeenLastCalledWith([
          expect.objectContaining({ r2Key: 'project-documents/c/u/k1' }),
          expect.objectContaining({ r2Key: 'project-documents/c/u/k3' }),
        ])
      );
      // ⚠ No DOM-absence assertion — `AnimatePresence`'s exit transition keeps the node mounted
      // in jsdom. The published ref list is the contract, and it is what the panel persists.
    });

    it('seeded rows count against the 4-file cap', () => {
      const fourth = {
        r2Key: 'project-documents/c/u/k4',
        fileName: 'extra.pdf',
        contentType: 'application/pdf' as const,
        sizeBytes: 4000,
      };
      render(
        <DocumentUploader initialDocuments={[...SEEDED, fourth]} onDocumentsChange={vi.fn()} />
      );
      expect(screen.getByText('4 of 4 attached')).toBeInTheDocument();
    });
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

  /**
   * ⚠⚠ REGRESSION PIN — `publish` must run in the event/async callback, NEVER inside a
   * `setRows` updater. An updater runs during the RENDER phase, so publishing from there
   * reached the parent's setState mid-render and React logged "Cannot update a component
   * (`Parent`) while rendering a different component (`DocumentUploader`)".
   *
   * The parent here is the real shape that broke it: `onDocumentsChange` writes parent state
   * (ProjectRequestPanel's `setField('documents', …)`). Asserting on React's own console.error
   * is what pins it — every assertion on the bubbled refs alone stayed green THROUGH the bug.
   */
  describe('parent updates never happen during render', () => {
    function Parent(): React.JSX.Element {
      const [docs, setDocs] = useState<ProjectDocumentRef[]>([]);
      const [uploading, setUploading] = useState(false);
      return (
        <div>
          <span data-testid="doc-count">{docs.length}</span>
          <span data-testid="uploading">{String(uploading)}</span>
          <DocumentUploader onDocumentsChange={setDocs} onUploadingChange={setUploading} />
        </div>
      );
    }

    it('does not update the parent while rendering (attach → upload → remove)', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const user = userEvent.setup();
      const { container } = render(<Parent />);
      const input = container.querySelector('input[type="file"]') as HTMLInputElement;

      // Attach — this is the exact call path that threw: handleFiles → publish → parent setState.
      await user.upload(input, makeFile('spec.pdf', 'application/pdf', 1000));
      await waitFor(() => expect(screen.getByText('Attached')).toBeInTheDocument());
      expect(screen.getByTestId('doc-count')).toHaveTextContent('1');
      expect(screen.getByTestId('uploading')).toHaveTextContent('false');

      // Remove — the other `commitRows` caller.
      await user.click(screen.getByRole('button', { name: /remove spec\.pdf/i }));
      await waitFor(() => expect(screen.getByTestId('doc-count')).toHaveTextContent('0'));

      const setStateInRender = errorSpy.mock.calls.filter((args) =>
        args.some(
          (a) => typeof a === 'string' && a.includes('while rendering a different component')
        )
      );
      errorSpy.mockRestore();
      expect(setStateInRender).toEqual([]);
    });
  });
});
