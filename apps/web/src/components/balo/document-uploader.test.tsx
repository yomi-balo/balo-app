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
  /** ⚠ SEVERAL ticks, like a real upload — one tick cannot show a per-tick publish. */
  send = vi.fn(() => {
    for (const loaded of [10, 40, 70, 100]) {
      this.upload.onprogress?.({ lengthComputable: true, loaded, total: 100 } as ProgressEvent);
    }
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

  // ── F1 — maxDocuments: a case mount reserves slots for its own case-file selections ────────
  describe('maxDocuments (BAL-589 fix round F1)', () => {
    it('defaults to MAX_DOCUMENTS (4) when omitted — unchanged for every other caller', () => {
      render(<DocumentUploader onDocumentsChange={vi.fn()} />);
      expect(
        screen.getByText('PDF, PNG, JPEG or WEBP · up to 4 files · 5 MB each')
      ).toBeInTheDocument();
    });

    it('a lower maxDocuments caps "N of M" and the at-cap note below MAX_DOCUMENTS', async () => {
      const user = userEvent.setup();
      const { container } = render(
        <DocumentUploader onDocumentsChange={vi.fn()} maxDocuments={2} />
      );
      const input = container.querySelector('input[type="file"]') as HTMLInputElement;

      await user.upload(input, makeFile('one.pdf', 'application/pdf', 100));
      await waitFor(() => expect(screen.getByText('Attached')).toBeInTheDocument());
      expect(screen.getByText('Add more — 1 of 2')).toBeInTheDocument();

      await user.upload(input, makeFile('two.pdf', 'application/pdf', 100));
      await waitFor(() => expect(screen.getAllByText('Attached')).toHaveLength(2));
      expect(screen.getByText('2 of 2 attached')).toBeInTheDocument();
    });

    it('a lower maxDocuments rejects an upload that would exceed IT, below MAX_DOCUMENTS', async () => {
      const user = userEvent.setup();
      const { container } = render(
        <DocumentUploader onDocumentsChange={vi.fn()} maxDocuments={1} />
      );
      const input = container.querySelector('input[type="file"]') as HTMLInputElement;

      await user.upload(input, makeFile('one.pdf', 'application/pdf', 100));
      await waitFor(() => expect(screen.getByText('Attached')).toBeInTheDocument());

      // A second file is rejected — this instance's own cap is 1, well under MAX_DOCUMENTS (4).
      await user.upload(input, makeFile('two.pdf', 'application/pdf', 100));
      expect(mockToast.error).toHaveBeenCalledWith(expect.stringContaining('two.pdf not added'));
      expect(screen.getAllByText('Attached')).toHaveLength(1);
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

  // ── BAL-582 (D1) — signed-out auth gate ───────────────────────────────────────────────────
  describe('onRequireAuth (BAL-582 D1)', () => {
    it('a click calls onRequireAuth and never opens the file input', async () => {
      const user = userEvent.setup();
      const onRequireAuth = vi.fn();
      const { container } = render(
        <DocumentUploader onDocumentsChange={vi.fn()} onRequireAuth={onRequireAuth} />
      );
      const input = container.querySelector('input[type="file"]') as HTMLInputElement;
      const clickSpy = vi.spyOn(input, 'click');

      await user.click(screen.getByText(/drag files here or browse/i));

      expect(onRequireAuth).toHaveBeenCalledTimes(1);
      expect(clickSpy).not.toHaveBeenCalled();
      expect(mockRequest).not.toHaveBeenCalled();
    });

    it('a drop calls onRequireAuth and never reaches the presign action', () => {
      const onRequireAuth = vi.fn();
      render(<DocumentUploader onDocumentsChange={vi.fn()} onRequireAuth={onRequireAuth} />);

      fireEvent.drop(screen.getByText(/drag files here or browse/i), {
        dataTransfer: { files: [makeFile('spec.pdf', 'application/pdf', 1000)] },
      });

      expect(onRequireAuth).toHaveBeenCalledTimes(1);
      expect(mockRequest).not.toHaveBeenCalled();
    });

    it('without the prop, a click still opens the picker (unchanged behaviour)', async () => {
      const user = userEvent.setup();
      const { container } = render(<DocumentUploader onDocumentsChange={vi.fn()} />);
      const input = container.querySelector('input[type="file"]') as HTMLInputElement;
      const clickSpy = vi.spyOn(input, 'click');

      await user.click(screen.getByText(/drag files here or browse/i));

      expect(clickSpy).toHaveBeenCalledTimes(1);
    });
  });

  /**
   * ⚠ PROGRESS IS THIS COMPONENT'S BUSINESS, NOT THE PARENT'S. Every XHR `upload.onprogress`
   * tick calls `patchRow(id, {progress})`, which reaches `publish`. Without a guard a 5 MB file
   * drove one `onDocumentsChange` + `ProjectRequestPanel` re-render PER TICK, each carrying an
   * identical confirmed-ref list.
   *
   * The mock fires four ticks per upload, so an unguarded publish is plainly visible in the
   * call count: this asserts the parent hears only the transitions that mean something —
   * attached (uploading true), then confirmed (uploading false).
   */
  it('⚠ does not bubble a publish per progress tick', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const onUploading = vi.fn();
    const { container } = render(
      <DocumentUploader onDocumentsChange={onChange} onUploadingChange={onUploading} />
    );
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;

    await user.upload(input, makeFile('spec.pdf', 'application/pdf', 1000));
    await waitFor(() => expect(screen.getByText('Attached')).toBeInTheDocument());

    // Two meaningful transitions, not two-plus-four-ticks.
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onUploading).toHaveBeenCalledTimes(2);
    expect(onUploading).toHaveBeenNthCalledWith(1, true);
    expect(onUploading).toHaveBeenLastCalledWith(false);
    // ...and the confirmed ref still arrived.
    expect(onChange).toHaveBeenLastCalledWith([
      expect.objectContaining({ r2Key: 'project-documents/c/u/k' }),
    ]);
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
