import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { toast } from 'sonner';
import { getProposalDocumentDownloadAction } from '@/app/(dashboard)/projects/[requestId]/_actions/get-proposal-document-download';
import { useProposalAttachmentDownload } from './use-proposal-attachment-download';

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));
vi.mock('@/app/(dashboard)/projects/[requestId]/_actions/get-proposal-document-download', () => ({
  getProposalDocumentDownloadAction: vi.fn(),
}));

const IDS = { requestId: 'req-1', relationshipId: 'rel-1', proposalId: 'prop-1' };
const ATTACHMENT = { id: 'doc-1', fileName: 'spec.pdf', sizeBytes: 100 };

const mockAction = vi.mocked(getProposalDocumentDownloadAction);

describe('useProposalAttachmentDownload', () => {
  const originalLocation = globalThis.location;
  const assign = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(globalThis, 'location', {
      configurable: true,
      value: { ...originalLocation, assign },
    });
  });

  afterEach(() => {
    Object.defineProperty(globalThis, 'location', {
      configurable: true,
      value: originalLocation,
    });
  });

  it('asks for the document by its ids and navigates to the presigned url', async () => {
    mockAction.mockResolvedValue({ success: true, url: 'https://r2.example/spec.pdf' });
    const { result } = renderHook(() => useProposalAttachmentDownload(IDS));

    act(() => result.current.download(ATTACHMENT));

    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://r2.example/spec.pdf'));
    expect(mockAction).toHaveBeenCalledWith({ ...IDS, documentId: 'doc-1' });
    expect(toast.error).not.toHaveBeenCalled();
    await waitFor(() => expect(result.current.downloadingId).toBeNull());
  });

  it('marks the attachment as downloading until the action settles', async () => {
    let release: (value: { success: true; url: string }) => void = () => {};
    mockAction.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      })
    );
    const { result } = renderHook(() => useProposalAttachmentDownload(IDS));
    expect(result.current.downloadingId).toBeNull();

    act(() => result.current.download(ATTACHMENT));
    await waitFor(() => expect(result.current.downloadingId).toBe('doc-1'));

    await act(async () => {
      release({ success: true, url: 'https://r2.example/spec.pdf' });
    });
    await waitFor(() => expect(result.current.downloadingId).toBeNull());
  });

  it('toasts the action’s error and does not navigate on a refusal', async () => {
    mockAction.mockResolvedValue({
      success: false,
      error: 'You do not have access to this document.',
    });
    const { result } = renderHook(() => useProposalAttachmentDownload(IDS));

    act(() => result.current.download(ATTACHMENT));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('You do not have access to this document.')
    );
    expect(assign).not.toHaveBeenCalled();
    await waitFor(() => expect(result.current.downloadingId).toBeNull());
  });

  it('toasts a generic error when the action call itself rejects', async () => {
    mockAction.mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() => useProposalAttachmentDownload(IDS));

    act(() => result.current.download(ATTACHMENT));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Could not open this document. Please try again.')
    );
    expect(assign).not.toHaveBeenCalled();
    await waitFor(() => expect(result.current.downloadingId).toBeNull());
  });
});
