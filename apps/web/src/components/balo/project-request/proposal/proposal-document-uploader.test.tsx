import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@/test/utils';
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

import { ProposalDocumentUploader } from './proposal-document-uploader';

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

function renderUploader(props: {
  documents?: ProposalDocumentView[];
  kind?: 'terms' | 'ref';
  single?: boolean;
}): {
  onAdded: ReturnType<typeof vi.fn<(d: ProposalDocumentView) => void>>;
  onRemoved: ReturnType<typeof vi.fn<(id: string) => void>>;
  ensureProposalId: ReturnType<typeof vi.fn<() => Promise<string | null>>>;
  fileInput: HTMLInputElement;
} {
  const onAdded = vi.fn<(d: ProposalDocumentView) => void>();
  const onRemoved = vi.fn<(id: string) => void>();
  const ensureProposalId = vi.fn<() => Promise<string | null>>(() => Promise.resolve(PROPOSAL_ID));
  const { container } = render(
    <>
      {/* The uploader labels its file input via aria-labelledby={labelId}. */}
      <span id="uploader-label">Attach</span>
      <ProposalDocumentUploader
        requestId={REQUEST_ID}
        relationshipId={RELATIONSHIP_ID}
        documents={props.documents ?? []}
        kind={props.kind ?? 'ref'}
        single={props.single}
        ensureProposalId={ensureProposalId}
        onAdded={onAdded}
        onRemoved={onRemoved}
        labelId="uploader-label"
      />
    </>
  );
  const fileInput = container.querySelector<HTMLInputElement>('input[type="file"]');
  if (fileInput === null) throw new Error('file input not found');
  return { onAdded, onRemoved, ensureProposalId, fileInput };
}

function pdf(name = 'spec.pdf', bytes = 1024): File {
  const file = new File(['x'], name, { type: 'application/pdf' });
  Object.defineProperty(file, 'size', { value: bytes });
  return file;
}

describe('ProposalDocumentUploader', () => {
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

  it('rejects a disallowed file type before any network call (toast)', async () => {
    const { fileInput } = renderUploader({});

    // fireEvent.change bypasses the input's `accept` filter so we exercise the
    // component's own client-side allow-list rejection.
    const exe = new File(['x'], 'malware.exe', { type: 'application/x-msdownload' });
    fireEvent.change(fileInput, { target: { files: [exe] } });

    await waitFor(() =>
      expect(mockToast.error).toHaveBeenCalledWith("malware.exe isn't a supported file type.")
    );
    expect(requestProposalDocumentUploadAction).not.toHaveBeenCalled();
  });

  it('rejects an over-size file before any network call (toast)', async () => {
    const { fileInput } = renderUploader({});

    fireEvent.change(fileInput, { target: { files: [pdf('huge.pdf', 11 * 1024 * 1024)] } });

    await waitFor(() =>
      expect(mockToast.error).toHaveBeenCalledWith(expect.stringContaining('10 MB or smaller'))
    );
    expect(requestProposalDocumentUploadAction).not.toHaveBeenCalled();
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

  it('single (terms) mode: at capacity shows "Remove to replace" instead of attach', () => {
    renderUploader({ kind: 'terms', single: true, documents: [doc({ kind: 'terms' })] });
    expect(screen.getByRole('button', { name: /remove to replace/i })).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /attach terms supplement/i })
    ).not.toBeInTheDocument();
  });

  it('single (terms) mode toasts the supplement copy on success', async () => {
    const user = userEvent.setup();
    confirmProposalDocumentUploadAction.mockResolvedValue({
      success: true,
      document: doc({ kind: 'terms' }),
    });
    const { fileInput } = renderUploader({ kind: 'terms', single: true });

    await user.upload(fileInput, pdf('terms.pdf'));

    await waitFor(() =>
      expect(mockToast.success).toHaveBeenCalledWith('Terms supplement attached')
    );
  });

  it('surfaces a presign failure as the action error toast', async () => {
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
  });
});
