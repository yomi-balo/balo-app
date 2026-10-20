import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import type { ProposalDocumentView } from '@/app/(dashboard)/projects/[requestId]/_actions/confirm-proposal-document-upload';

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));

// The shared upload helper — mock the XHR PUT + keep a real-ish formatBytes.
const putWithProgress = vi.fn<(opts: { onProgress: (n: number) => void }) => Promise<void>>();
vi.mock('@/components/balo/document-uploader/upload-file', () => ({
  putWithProgress: (opts: { onProgress: (n: number) => void }) => putWithProgress(opts),
  formatBytes: (bytes: number) => `${bytes} B`,
}));

const requestProposalDocumentUploadAction = vi.fn();
vi.mock('@/app/(dashboard)/projects/[requestId]/_actions/request-proposal-document-upload', () => ({
  requestProposalDocumentUploadAction: (input: unknown) =>
    requestProposalDocumentUploadAction(input),
}));

const confirmProposalDocumentUploadAction = vi.fn();
vi.mock('@/app/(dashboard)/projects/[requestId]/_actions/confirm-proposal-document-upload', () => ({
  confirmProposalDocumentUploadAction: (input: unknown) =>
    confirmProposalDocumentUploadAction(input),
}));

const removeProposalDocumentAction = vi.fn();
vi.mock('@/app/(dashboard)/projects/[requestId]/_actions/remove-proposal-document', () => ({
  removeProposalDocumentAction: (input: unknown) => removeProposalDocumentAction(input),
}));

import {
  ProposalDocumentUploaderView,
  useProposalDocumentUpload,
} from './proposal-document-uploader';

const REQUEST_ID = '11111111-1111-1111-1111-111111111111';
const RELATIONSHIP_ID = '22222222-2222-2222-2222-222222222222';
const PROPOSAL_ID = '33333333-3333-3333-3333-333333333333';

const mockToast = vi.mocked(toast);

function doc(overrides: Partial<ProposalDocumentView> = {}): ProposalDocumentView {
  return {
    id: 'doc-1',
    proposalId: PROPOSAL_ID,
    kind: 'ref',
    fileName: 'spec.pdf',
    contentType: 'application/pdf',
    sizeBytes: 1024,
    uploadedByUserId: 'user-1',
    createdAtIso: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

interface Rendered {
  onAdded: ReturnType<typeof vi.fn<(d: ProposalDocumentView) => void>>;
  onRemoved: ReturnType<typeof vi.fn<(id: string) => void>>;
  ensureProposalId: ReturnType<typeof vi.fn<() => Promise<string | null>>>;
  fileInput: HTMLInputElement;
}

function renderUploader(props: {
  documents?: ProposalDocumentView[];
  kind?: 'terms' | 'ref';
  single?: boolean;
  pickLabel?: string;
  ensureProposalId?: () => Promise<string | null>;
}): Rendered {
  const onAdded = vi.fn<(d: ProposalDocumentView) => void>();
  const onRemoved = vi.fn<(id: string) => void>();
  const ensureProposalId = vi.fn<() => Promise<string | null>>(
    props.ensureProposalId ?? (() => Promise.resolve(PROPOSAL_ID))
  );
  const { kind = 'ref', single, pickLabel } = props;
  const documents = props.documents ?? [];
  function Harness(): React.JSX.Element {
    const controller = useProposalDocumentUpload({
      requestId: REQUEST_ID,
      relationshipId: RELATIONSHIP_ID,
      kind,
      single,
      documents,
      ensureProposalId,
      onAdded,
      onRemoved,
    });
    return (
      <>
        <span id="uploader-label">Attach</span>
        <ProposalDocumentUploaderView
          controller={controller}
          documents={documents}
          labelId="uploader-label"
          single={single}
          pickLabel={pickLabel}
        />
      </>
    );
  }
  const { container } = render(<Harness />);
  const fileInput = container.querySelector<HTMLInputElement>('input[type="file"]');
  if (fileInput === null) throw new Error('file input not found');
  return { onAdded, onRemoved, ensureProposalId, fileInput };
}

function pdf(name = 'spec.pdf', bytes = 1024): File {
  const file = new File(['x'], name, { type: 'application/pdf' });
  Object.defineProperty(file, 'size', { value: bytes });
  return file;
}

describe('useProposalDocumentUpload + ProposalDocumentUploaderView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    putWithProgress.mockResolvedValue(undefined);
    requestProposalDocumentUploadAction.mockResolvedValue({
      success: true,
      presignedUrl: 'https://r2.example/put',
      key: `proposal-documents/${PROPOSAL_ID}/user/uuid`,
    });
    confirmProposalDocumentUploadAction.mockResolvedValue({ success: true, document: doc() });
    removeProposalDocumentAction.mockResolvedValue({ success: true });
  });

  it('presign → PUT → confirm happy path adds the document', async () => {
    const user = userEvent.setup();
    const { onAdded, fileInput } = renderUploader({});

    await user.upload(fileInput, pdf());

    await waitFor(() => expect(onAdded).toHaveBeenCalledWith(doc()));
    expect(requestProposalDocumentUploadAction).toHaveBeenCalledWith(
      expect.objectContaining({ proposalId: PROPOSAL_ID, kind: 'ref' })
    );
    expect(putWithProgress).toHaveBeenCalled();
    expect(confirmProposalDocumentUploadAction).toHaveBeenCalled();
    expect(mockToast.success).toHaveBeenCalledWith('Attachment added');
  });

  it('uploads several files in sequence and toasts once at the end', async () => {
    const user = userEvent.setup();
    const { onAdded, ensureProposalId, fileInput } = renderUploader({});

    await user.upload(fileInput, [pdf('a.pdf'), pdf('b.pdf')]);

    await waitFor(() => expect(mockToast.success).toHaveBeenCalledWith('2 files attached'));
    expect(requestProposalDocumentUploadAction).toHaveBeenCalledTimes(2);
    expect(confirmProposalDocumentUploadAction).toHaveBeenCalledTimes(2);
    expect(requestProposalDocumentUploadAction).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ fileName: 'a.pdf' })
    );
    expect(requestProposalDocumentUploadAction).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ fileName: 'b.pdf' })
    );
    expect(onAdded).toHaveBeenCalledTimes(2);
    expect(ensureProposalId).toHaveBeenCalledTimes(1);
    expect(mockToast.success).toHaveBeenCalledTimes(1);
  });

  it('toasts each rejected file but still uploads the valid ones', async () => {
    const { fileInput } = renderUploader({});
    const exe = new File(['x'], 'malware.exe', { type: 'application/x-msdownload' });

    // fireEvent.change bypasses the input's `accept` filter so we exercise the
    // hook's own client-side allow-list rejection.
    fireEvent.change(fileInput, { target: { files: [exe, pdf('ok.pdf')] } });

    await waitFor(() => expect(mockToast.success).toHaveBeenCalledWith('Attachment added'));
    expect(mockToast.error).toHaveBeenCalledWith("malware.exe isn't a supported file type.");
    expect(requestProposalDocumentUploadAction).toHaveBeenCalledTimes(1);
  });

  it('rejects an over-size file before any network call (toast)', async () => {
    const { fileInput, ensureProposalId } = renderUploader({});

    fireEvent.change(fileInput, { target: { files: [pdf('huge.pdf', 11 * 1024 * 1024)] } });

    await waitFor(() =>
      expect(mockToast.error).toHaveBeenCalledWith(expect.stringContaining('10 MB or smaller'))
    );
    expect(requestProposalDocumentUploadAction).not.toHaveBeenCalled();
    expect(ensureProposalId).not.toHaveBeenCalled();
  });

  it('stops with a toast when the draft cannot be created', async () => {
    const user = userEvent.setup();
    const { fileInput } = renderUploader({ ensureProposalId: () => Promise.resolve(null) });

    await user.upload(fileInput, pdf());

    await waitFor(() =>
      expect(mockToast.error).toHaveBeenCalledWith(
        "Couldn't prepare your proposal. Please try again."
      )
    );
    expect(requestProposalDocumentUploadAction).not.toHaveBeenCalled();
  });

  it('surfaces a presign failure as the action error toast and adds nothing', async () => {
    const user = userEvent.setup();
    requestProposalDocumentUploadAction.mockResolvedValue({
      success: false,
      error: 'This proposal can no longer be edited.',
    });
    const { onAdded, fileInput } = renderUploader({});

    await user.upload(fileInput, pdf());

    await waitFor(() =>
      expect(mockToast.error).toHaveBeenCalledWith('This proposal can no longer be edited.')
    );
    expect(onAdded).not.toHaveBeenCalled();
    expect(mockToast.success).not.toHaveBeenCalled();
  });

  it('surfaces a confirm failure as the action error toast', async () => {
    const user = userEvent.setup();
    confirmProposalDocumentUploadAction.mockResolvedValue({ success: false, error: 'Not found.' });
    const { onAdded, fileInput } = renderUploader({});

    await user.upload(fileInput, pdf());

    await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith('Not found.'));
    expect(onAdded).not.toHaveBeenCalled();
  });

  it('toasts a generic error when the PUT throws, then carries on to the next file', async () => {
    const user = userEvent.setup();
    putWithProgress.mockRejectedValueOnce(new Error('network'));
    const { onAdded, fileInput } = renderUploader({});

    await user.upload(fileInput, [pdf('a.pdf'), pdf('b.pdf')]);

    await waitFor(() => expect(mockToast.success).toHaveBeenCalledWith('Attachment added'));
    expect(mockToast.error).toHaveBeenCalledWith("Couldn't upload that file. Please try again.");
    expect(onAdded).toHaveBeenCalledTimes(1);
  });

  it('shows the progress bar while the PUT is in flight', async () => {
    const user = userEvent.setup();
    let finish: () => void = () => undefined;
    putWithProgress.mockImplementationOnce(({ onProgress }) => {
      onProgress(40);
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    });
    const { fileInput } = renderUploader({});

    await user.upload(fileInput, pdf());

    expect(await screen.findByText('Uploading… 40%')).toBeInTheDocument();
    await act(async () => {
      finish();
    });
    await waitFor(() => expect(screen.queryByText(/Uploading/)).not.toBeInTheDocument());
  });

  it('remove flow calls the action and onRemoved', async () => {
    const user = userEvent.setup();
    const { onRemoved } = renderUploader({ documents: [doc()] });

    await user.click(screen.getByRole('button', { name: 'Remove spec.pdf' }));

    await waitFor(() => expect(onRemoved).toHaveBeenCalledWith('doc-1'));
    expect(removeProposalDocumentAction).toHaveBeenCalledWith(
      expect.objectContaining({ proposalId: PROPOSAL_ID, documentId: 'doc-1' })
    );
    expect(mockToast.success).toHaveBeenCalledWith('Removed');
  });

  it('surfaces a remove failure and keeps the document', async () => {
    const user = userEvent.setup();
    removeProposalDocumentAction.mockResolvedValue({ success: false, error: 'Locked.' });
    const { onRemoved } = renderUploader({ documents: [doc()] });

    await user.click(screen.getByRole('button', { name: 'Remove spec.pdf' }));

    await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith('Locked.'));
    expect(onRemoved).not.toHaveBeenCalled();
  });

  it('toasts a generic error when the remove action throws', async () => {
    const user = userEvent.setup();
    removeProposalDocumentAction.mockRejectedValue(new Error('boom'));
    renderUploader({ documents: [doc()] });

    await user.click(screen.getByRole('button', { name: 'Remove spec.pdf' }));

    await waitFor(() =>
      expect(mockToast.error).toHaveBeenCalledWith(
        "Couldn't remove that document. Please try again."
      )
    );
  });

  it('tags each row by kind', () => {
    renderUploader({
      documents: [doc(), doc({ id: 'doc-2', kind: 'terms', fileName: 'terms.pdf' })],
    });
    expect(screen.getByText('Reference')).toBeInTheDocument();
    expect(screen.getByText('Your terms')).toBeInTheDocument();
  });

  describe('single (terms) mode', () => {
    it('takes one file only and toasts the terms copy', async () => {
      confirmProposalDocumentUploadAction.mockResolvedValue({
        success: true,
        document: doc({ kind: 'terms' }),
      });
      const { fileInput } = renderUploader({ kind: 'terms', single: true });
      expect(fileInput).not.toHaveAttribute('multiple');

      fireEvent.change(fileInput, { target: { files: [pdf('terms.pdf'), pdf('extra.pdf')] } });

      await waitFor(() =>
        expect(mockToast.success).toHaveBeenCalledWith('Your terms are attached')
      );
      expect(requestProposalDocumentUploadAction).toHaveBeenCalledTimes(1);
    });

    it('offers "Attach your terms" with nothing attached', () => {
      renderUploader({ kind: 'terms', single: true });
      expect(screen.getByRole('button', { name: 'Attach your terms' })).toBeInTheDocument();
    });

    it('at capacity keeps the picker as "Replace your terms" and uploads through it', async () => {
      const user = userEvent.setup();
      const { fileInput, onAdded } = renderUploader({
        kind: 'terms',
        single: true,
        documents: [doc({ kind: 'terms' })],
      });
      expect(screen.queryByRole('button', { name: /remove to replace/i })).not.toBeInTheDocument();
      const picker = screen.getByRole('button', { name: 'Replace your terms' });
      expect(picker).toBeEnabled();

      const click = vi.spyOn(fileInput, 'click');
      await user.click(picker);
      expect(click).toHaveBeenCalled();

      await user.upload(fileInput, pdf('new-terms.pdf'));
      await waitFor(() => expect(onAdded).toHaveBeenCalled());
      expect(requestProposalDocumentUploadAction).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'terms', fileName: 'new-terms.pdf' })
      );
    });

    it('still lets the attached terms be removed', async () => {
      const user = userEvent.setup();
      const { onRemoved } = renderUploader({
        kind: 'terms',
        single: true,
        documents: [doc({ kind: 'terms' })],
      });
      await user.click(screen.getByRole('button', { name: 'Remove spec.pdf' }));
      await waitFor(() => expect(onRemoved).toHaveBeenCalledWith('doc-1'));
    });
  });

  it('uses the custom pick label in multi mode', () => {
    renderUploader({ pickLabel: 'Drop files anywhere on this page, or browse' });
    expect(
      screen.getByRole('button', { name: 'Drop files anywhere on this page, or browse' })
    ).toBeInTheDocument();
  });
});
