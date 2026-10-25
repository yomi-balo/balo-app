import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { track, REQUEST_FILE_EVENTS } from '@/lib/analytics';
import { toast } from 'sonner';
import { useRequestFileShare, shareSuccessCopy } from './use-request-file-share';
import type { ShareRecipients, ShareSubmission } from './share-file-types';

const mocks = vi.hoisted(() => ({
  presign: vi.fn(),
  confirm: vi.fn(),
  discard: vi.fn(),
  put: vi.fn(),
  capture: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/app/(dashboard)/projects/[requestId]/_actions/request-shared-file-upload', () => ({
  requestSharedFileUploadAction: mocks.presign,
}));
vi.mock('@/app/(dashboard)/projects/[requestId]/_actions/confirm-request-file-upload', () => ({
  confirmRequestFileUploadAction: mocks.confirm,
}));
vi.mock('@/app/(dashboard)/projects/[requestId]/_actions/discard-request-file-upload', () => ({
  discardRequestFileUploadAction: mocks.discard,
}));
vi.mock('@/components/balo/document-uploader/upload-file', () => ({
  putWithProgress: mocks.put,
}));
vi.mock('@sentry/nextjs', () => ({ captureException: mocks.capture }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const REQUEST_ID = 'a0000000-0000-4000-8000-000000000001';
const REL_ID = 'b0000000-0000-4000-8000-000000000002';
const OTHER_REL_ID = 'b0000000-0000-4000-8000-000000000003';
const RECIPIENTS: ShareRecipients = {
  side: 'client',
  liveTracks: [
    { relationshipId: REL_ID, trackName: 'Wei Zhang' },
    { relationshipId: OTHER_REL_ID, trackName: 'Priya Raman' },
  ],
};
const SUBMISSION: ShareSubmission = {
  share: { mode: 'grants', relationshipIds: [REL_ID] },
  audienceChoice: 'this_thread',
  note: '  Here is the NDA ',
};
const SHARED = { success: true, view: { id: 'f1' }, threadMessages: [] };

const file = (): File => new File(['hello'], 'nda.pdf', { type: 'application/pdf' });

interface PutControl {
  resolve: () => void;
  reject: (error: Error) => void;
  abort: ReturnType<typeof vi.fn>;
  progress: (pct: number) => void;
}

/** Makes the next PUT hang until the test settles it, exposing the XHR and its progress callback. */
function holdPut(): { control: () => PutControl } {
  let current: PutControl | null = null;
  mocks.put.mockImplementationOnce(
    (opts: { onProgress: (pct: number) => void; onStart?: (xhr: XMLHttpRequest) => void }) =>
      new Promise<void>((resolve, reject) => {
        const abort = vi.fn(() => reject(new Error('Upload aborted')));
        opts.onStart?.({ abort } as unknown as XMLHttpRequest);
        current = { resolve, reject, abort, progress: opts.onProgress };
      })
  );
  return {
    control: () => {
      if (current === null) throw new Error('PUT not started');
      return current;
    },
  };
}

function setup(onShared = vi.fn()) {
  const hook = renderHook(() =>
    useRequestFileShare({
      requestId: REQUEST_ID,
      recipients: RECIPIENTS,
      defaultEntryPoint: 'composer',
      onShared,
    })
  );
  return { ...hook, onShared };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.presign.mockResolvedValue({ success: true, presignedUrl: 'https://r2/put', key: 'k1' });
  mocks.put.mockResolvedValue(undefined);
  mocks.confirm.mockResolvedValue(SHARED);
  mocks.discard.mockResolvedValue({ success: true });
});

describe('useRequestFileShare', () => {
  it('starts the upload on pick: presigns, PUTs with progress, and reports uploaded', async () => {
    const { result } = setup();
    act(() => result.current.pickFile(file(), 'composer'));
    expect(result.current.upload).toMatchObject({
      fileName: 'nda.pdf',
      progress: 0,
      status: 'uploading',
    });
    await waitFor(() => expect(result.current.upload?.status).toBe('uploaded'));
    expect(result.current.upload?.progress).toBe(100);
    expect(mocks.presign).toHaveBeenCalledWith({
      requestId: REQUEST_ID,
      contentType: 'application/pdf',
      fileName: 'nda.pdf',
      sizeBytes: 5,
    });
    expect(mocks.confirm).not.toHaveBeenCalled();
  });

  it('reports PUT progress as it arrives', async () => {
    const put = holdPut();
    const { result } = setup();
    act(() => result.current.pickFile(file(), 'composer'));
    await waitFor(() => expect(mocks.put).toHaveBeenCalled());
    act(() => put.control().progress(45));
    expect(result.current.upload?.progress).toBe(45);
    await act(async () => put.control().resolve());
  });

  it('confirms with the audience, trimmed note and origin when Share is pressed after the upload', async () => {
    const { result, onShared } = setup();
    act(() => result.current.pickFile(file(), 'drop'));
    await waitFor(() => expect(result.current.upload?.status).toBe('uploaded'));
    act(() => result.current.submit(SUBMISSION));
    await waitFor(() => expect(onShared).toHaveBeenCalledWith(SHARED));
    expect(mocks.confirm).toHaveBeenCalledWith({
      requestId: REQUEST_ID,
      key: 'k1',
      fileName: 'nda.pdf',
      contentType: 'application/pdf',
      sizeBytes: 5,
      share: { mode: 'grants', relationshipIds: [REL_ID] },
      note: 'Here is the NDA',
      origin: { entryPoint: 'drop', audienceChoice: 'this_thread' },
    });
    expect(toast.success).toHaveBeenCalledWith('Shared with Wei Zhang.');
    expect(result.current.upload).toBeNull();
  });

  it('sends no note field when the note is blank', async () => {
    const { result } = setup();
    act(() => result.current.pickFile(file(), 'composer'));
    await waitFor(() => expect(result.current.upload?.status).toBe('uploaded'));
    act(() => result.current.submit({ ...SUBMISSION, note: '   ' }));
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalled());
    expect(mocks.confirm.mock.calls[0]?.[0]).not.toHaveProperty('note');
  });

  /** AC3: Share pressed mid-upload completes on its own. */
  it('parks a Share pressed mid-upload and confirms once the PUT resolves', async () => {
    const put = holdPut();
    const { result, onShared } = setup();
    act(() => result.current.pickFile(file(), 'composer'));
    await waitFor(() => expect(mocks.put).toHaveBeenCalled());
    act(() => result.current.submit(SUBMISSION));
    expect(result.current.pending).toBe(true);
    expect(mocks.confirm).not.toHaveBeenCalled();
    await act(async () => put.control().resolve());
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onShared).toHaveBeenCalled());
  });

  it('ignores a second Share while one is already parked', async () => {
    const put = holdPut();
    const { result } = setup();
    act(() => result.current.pickFile(file(), 'composer'));
    await waitFor(() => expect(mocks.put).toHaveBeenCalled());
    act(() => result.current.submit(SUBMISSION));
    act(() => result.current.submit(SUBMISSION));
    await act(async () => put.control().resolve());
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalledTimes(1));
  });

  /** AC3: Cancel deletes the uploaded object. */
  it('aborts the PUT and discards the object on Cancel', async () => {
    const put = holdPut();
    const { result } = setup();
    act(() => result.current.pickFile(file(), 'composer'));
    await waitFor(() => expect(mocks.put).toHaveBeenCalled());
    act(() => result.current.cancel());
    expect(put.control().abort).toHaveBeenCalledTimes(1);
    expect(mocks.discard).toHaveBeenCalledWith({ requestId: REQUEST_ID, key: 'k1' });
    expect(result.current.upload).toBeNull();
    expect(track).toHaveBeenCalledWith(REQUEST_FILE_EVENTS.SHARE_DIALOG_CANCELLED, {
      entry_point: 'composer',
      upload_complete: false,
    });
    expect(mocks.confirm).not.toHaveBeenCalled();
  });

  it('records a cancel after the upload finished as complete', async () => {
    const { result } = setup();
    act(() => result.current.pickFile(file(), 'drop'));
    await waitFor(() => expect(result.current.upload?.status).toBe('uploaded'));
    act(() => result.current.cancel());
    expect(mocks.discard).toHaveBeenCalledWith({ requestId: REQUEST_ID, key: 'k1' });
    expect(track).toHaveBeenCalledWith(REQUEST_FILE_EVENTS.SHARE_DIALOG_CANCELLED, {
      entry_point: 'drop',
      upload_complete: true,
    });
  });

  it('attributes a cancel before any pick to the default entry point and discards nothing', () => {
    const { result } = setup();
    act(() => result.current.cancel());
    expect(track).toHaveBeenCalledWith(REQUEST_FILE_EVENTS.SHARE_DIALOG_CANCELLED, {
      entry_point: 'composer',
      upload_complete: false,
    });
    expect(mocks.discard).not.toHaveBeenCalled();
  });

  it('discards the object when a cancel lands while the presign is still in flight', async () => {
    let resolvePresign: (value: unknown) => void = () => {};
    mocks.presign.mockReturnValueOnce(
      new Promise((resolve) => {
        resolvePresign = resolve;
      })
    );
    const { result } = setup();
    act(() => result.current.pickFile(file(), 'composer'));
    act(() => result.current.cancel());
    await act(async () =>
      resolvePresign({ success: true, presignedUrl: 'https://r2/put', key: 'late' })
    );
    expect(mocks.discard).toHaveBeenCalledWith({ requestId: REQUEST_ID, key: 'late' });
    expect(mocks.put).not.toHaveBeenCalled();
  });

  it('discards the previous object when a new file replaces the pick', async () => {
    const { result } = setup();
    act(() => result.current.pickFile(file(), 'all_files'));
    await waitFor(() => expect(result.current.upload?.status).toBe('uploaded'));
    mocks.presign.mockResolvedValueOnce({
      success: true,
      presignedUrl: 'https://r2/put',
      key: 'k2',
    });
    act(() =>
      result.current.pickFile(
        new File(['y'], 'other.pdf', { type: 'application/pdf' }),
        'all_files'
      )
    );
    expect(mocks.discard).toHaveBeenCalledWith({ requestId: REQUEST_ID, key: 'k1' });
    await waitFor(() => expect(result.current.upload?.fileName).toBe('other.pdf'));
  });

  it('shows a refused presign as a failed upload with the server’s reason', async () => {
    mocks.presign.mockResolvedValueOnce({
      success: false,
      error: 'This file type is not supported.',
    });
    const { result } = setup();
    act(() => result.current.pickFile(file(), 'composer'));
    await waitFor(() => expect(result.current.upload?.status).toBe('failed'));
    expect(result.current.error).toBe('This file type is not supported.');
    expect(toast.error).toHaveBeenCalledWith('This file type is not supported.');
    act(() => result.current.submit(SUBMISSION));
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.put).not.toHaveBeenCalled();
  });

  it('does nothing when Share is pressed after the PUT failed', async () => {
    mocks.put.mockRejectedValueOnce(new Error('network down'));
    const { result } = setup();
    act(() => result.current.pickFile(file(), 'composer'));
    await waitFor(() => expect(result.current.upload?.status).toBe('failed'));
    act(() => result.current.submit(SUBMISSION));
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(result.current.pending).toBe(false);
  });

  it('reports a failed PUT to Sentry and offers a retry that uploads again', async () => {
    mocks.put.mockRejectedValueOnce(new Error('network down'));
    const { result } = setup();
    act(() => result.current.pickFile(file(), 'composer'));
    await waitFor(() => expect(result.current.upload?.status).toBe('failed'));
    expect(mocks.capture).toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith('Could not upload your file. Please try again.');
    act(() => result.current.retryUpload());
    await waitFor(() => expect(result.current.upload?.status).toBe('uploaded'));
    expect(result.current.error).toBeNull();
  });

  it('keeps the dialog usable when the share is refused, so Share can be pressed again', async () => {
    mocks.confirm.mockResolvedValueOnce({ success: false, error: 'This file was already shared.' });
    const { result, onShared } = setup();
    act(() => result.current.pickFile(file(), 'composer'));
    await waitFor(() => expect(result.current.upload?.status).toBe('uploaded'));
    act(() => result.current.submit(SUBMISSION));
    await waitFor(() => expect(result.current.error).toBe('This file was already shared.'));
    expect(toast.error).toHaveBeenCalledWith('This file was already shared.');
    expect(result.current.pending).toBe(false);
    expect(result.current.confirming).toBe(false);
    expect(onShared).not.toHaveBeenCalled();
    act(() => result.current.submit(SUBMISSION));
    await waitFor(() => expect(onShared).toHaveBeenCalled());
  });

  it('turns a rejected confirm call into a toast and a Sentry report', async () => {
    mocks.confirm.mockRejectedValueOnce(new Error('offline'));
    const { result } = setup();
    act(() => result.current.pickFile(file(), 'composer'));
    await waitFor(() => expect(result.current.upload?.status).toBe('uploaded'));
    act(() => result.current.submit(SUBMISSION));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Could not share your file. Please try again.')
    );
    expect(mocks.capture).toHaveBeenCalled();
    expect(result.current.pending).toBe(false);
  });

  it('discards an unshared object when the dialog unmounts', async () => {
    const { result, unmount } = setup();
    act(() => result.current.pickFile(file(), 'composer'));
    await waitFor(() => expect(result.current.upload?.status).toBe('uploaded'));
    unmount();
    expect(mocks.discard).toHaveBeenCalledWith({ requestId: REQUEST_ID, key: 'k1' });
  });

  it('does not discard the object when the dialog unmounts while the confirm is in flight', async () => {
    let resolveConfirm: (value: unknown) => void = () => {};
    mocks.confirm.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveConfirm = resolve;
      })
    );
    const { result, unmount } = setup();
    act(() => result.current.pickFile(file(), 'composer'));
    await waitFor(() => expect(result.current.upload?.status).toBe('uploaded'));
    act(() => result.current.submit(SUBMISSION));
    await waitFor(() => expect(result.current.confirming).toBe(true));
    unmount();
    await act(async () => resolveConfirm(SHARED));
    expect(mocks.discard).not.toHaveBeenCalled();
  });

  it('does not discard a claimed object on unmount after a successful share', async () => {
    const { result, unmount } = setup();
    act(() => result.current.pickFile(file(), 'composer'));
    await waitFor(() => expect(result.current.upload?.status).toBe('uploaded'));
    act(() => result.current.submit(SUBMISSION));
    await waitFor(() => expect(result.current.upload).toBeNull());
    mocks.discard.mockClear();
    unmount();
    expect(mocks.discard).not.toHaveBeenCalled();
  });
});

describe('shareSuccessCopy', () => {
  it('names the client party for an expert', () => {
    expect(
      shareSuccessCopy(
        { side: 'expert', clientPartyName: 'Acme Corp' },
        { mode: 'all_live_tracks' }
      )
    ).toBe('Shared with Acme Corp.');
  });

  it('counts the live experts for an all-experts share', () => {
    expect(shareSuccessCopy(RECIPIENTS, { mode: 'all_live_tracks' })).toBe(
      'Shared with 2 experts.'
    );
    expect(
      shareSuccessCopy(
        { side: 'client', liveTracks: [{ relationshipId: REL_ID, trackName: 'Wei Zhang' }] },
        { mode: 'all_live_tracks' }
      )
    ).toBe('Shared with 1 expert.');
  });

  it('names the picked experts', () => {
    expect(
      shareSuccessCopy(RECIPIENTS, { mode: 'grants', relationshipIds: [REL_ID, OTHER_REL_ID] })
    ).toBe('Shared with Wei Zhang and Priya Raman.');
    expect(shareSuccessCopy(RECIPIENTS, { mode: 'grants', relationshipIds: ['unknown'] })).toBe(
      'Shared with the selected experts.'
    );
  });

  it('joins three names with commas and "and"', () => {
    const recipients: ShareRecipients = {
      side: 'client',
      liveTracks: ['A', 'B', 'C'].map((n) => ({ relationshipId: n, trackName: n })),
    };
    expect(shareSuccessCopy(recipients, { mode: 'grants', relationshipIds: ['A', 'B', 'C'] })).toBe(
      'Shared with A, B and C.'
    );
  });
});
