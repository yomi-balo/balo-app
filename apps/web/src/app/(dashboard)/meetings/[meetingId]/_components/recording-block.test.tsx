import { describe, it, expect, vi, beforeEach } from 'vitest';
import { axe } from 'jest-axe';
import userEvent from '@testing-library/user-event';
import { render, screen, waitFor } from '@/test/utils';
import type { RecapFileRowView, RecapRecordingRowView } from '@/lib/meetings/recap-view-types';

const MEETING_ID = 'a0000000-0000-4000-8000-000000000001';

vi.mock('server-only', () => ({}));

const mockRefresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mockRefresh }) }));

const mockToastError = vi.fn();
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: (...a: unknown[]) => mockToastError(...a) },
}));

const mockPlayback = vi.fn();
vi.mock('../_actions/get-meeting-recording-playback', () => ({
  getMeetingRecordingPlaybackAction: (...a: unknown[]) => mockPlayback(...a),
}));

const mockDownload = vi.fn();
vi.mock('../_actions/get-meeting-file-download', () => ({
  getMeetingFileDownloadAction: (...a: unknown[]) => mockDownload(...a),
}));

import { FilesCard } from './files-card';

const FILE: RecapFileRowView = {
  file: {
    id: 'f1',
    meetingId: MEETING_ID,
    fileName: 'deck.pdf',
    contentType: 'application/pdf',
    sizeBytes: 2048,
    party: 'expert',
    source: 'files_tab',
    uploadedByUserId: 'u-expert',
    createdAtIso: '2026-07-29T05:00:00.000Z',
  },
  uploaderLabel: 'Amara',
};

function recordingRow(over: Partial<RecapRecordingRowView> = {}): RecapRecordingRowView {
  return {
    recording: {
      id: 'rec-1',
      status: 'ready',
      playbackId: 'pb_1',
      durationSeconds: 2712,
      startedAt: '2026-07-29T04:14:00.000Z',
      readyAt: '2026-07-29T04:24:00.000Z',
    },
    posterUrl: 'https://image.mux.example/thumb.jpg?token=t',
    isLongTailProcessing: false,
    ...over,
  };
}

function baseProps(over: Record<string, unknown> = {}) {
  return {
    meetingId: MEETING_ID,
    lens: 'client' as const,
    files: [] as RecapFileRowView[],
    recordings: [] as RecapRecordingRowView[],
    transcriptReady: false,
    meetingTitle: 'Flow interview stuck on a loop',
    meetingOccurredAtIso: '2026-07-29T04:14:00.000Z',
    ...over,
  };
}

describe('FilesCard — the AC absence proof', () => {
  it('renders EXACTLY the pre-BAL-440 shape at zero recordings: title "Files", no recording text, 2 section children', () => {
    const { container } = render(<FilesCard {...baseProps()} />);
    expect(screen.getByText('Files')).toBeInTheDocument();
    expect(screen.queryByText(/Recording/i)).toBeNull();
    const section = container.querySelector('section');
    expect(section?.children).toHaveLength(2);
  });
});

describe('FilesCard — the "Recording & files" content-driven title', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('titles the card "Recording & files" and still renders the file list below', () => {
    render(<FilesCard {...baseProps({ recordings: [recordingRow()], files: [FILE] })} />);
    expect(screen.getByText('Recording & files')).toBeInTheDocument();
    expect(screen.getByText('deck.pdf')).toBeInTheDocument();
  });

  it('renders both the recording and the file, recording first', async () => {
    render(<FilesCard {...baseProps({ recordings: [recordingRow()], files: [FILE] })} />);
    // m13 — `RecordingBlock` is now `next/dynamic`-loaded (a real, un-mocked module boundary
    // under Vitest), so its content lands a beat after the initial render.
    const playButton = await screen.findByRole('button', { name: /play recording/i });
    const fileName = screen.getByText('deck.pdf');
    // DOCUMENT_POSITION_FOLLOWING (4) on `fileName` relative to `playButton` means the
    // recording block precedes the file list in DOM order.
    expect(playButton.compareDocumentPosition(fileName) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );
  });
});

describe('FilesCard — a single ready recording', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPlayback.mockResolvedValue({ success: true, url: 'https://stream.mux.example/x.m3u8' });
  });

  it('shows a "Play recording" button; clicking it calls the action and opens the dialog', async () => {
    const user = userEvent.setup();
    render(<FilesCard {...baseProps({ recordings: [recordingRow()] })} />);
    const button = await screen.findByRole('button', { name: /play recording/i });
    await user.click(button);

    expect(mockPlayback).toHaveBeenCalledWith({ meetingId: MEETING_ID, recordingId: 'rec-1' });
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());
  });

  it('toasts the returned error and never opens a dialog on a refused mint', async () => {
    mockPlayback.mockResolvedValue({ success: false, error: 'This recording is not ready yet.' });
    const user = userEvent.setup();
    render(<FilesCard {...baseProps({ recordings: [recordingRow()] })} />);
    await user.click(await screen.findByRole('button', { name: /play recording/i }));

    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith('This recording is not ready yet.')
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('button', { name: /play recording/i })).not.toBeDisabled();
  });

  it('toasts a friendly failure when the action throws', async () => {
    mockPlayback.mockRejectedValue(new Error('network'));
    const user = userEvent.setup();
    render(<FilesCard {...baseProps({ recordings: [recordingRow()] })} />);
    await user.click(await screen.findByRole('button', { name: /play recording/i }));

    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith("Couldn't load this recording. Please try again.")
    );
  });

  it('has no accessibility violations', async () => {
    const { container } = render(<FilesCard {...baseProps({ recordings: [recordingRow()] })} />);
    // Wait for the code-split `RecordingBlock` chunk to resolve so axe checks the tree users
    // actually see, not the transient (empty) loading state.
    await screen.findByRole('button', { name: /play recording/i });
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('FilesCard — the playback modal composes a REAL DialogDescription (m12)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPlayback.mockResolvedValue({ success: true, url: 'https://stream.mux.example/x.m3u8' });
  });

  it('shows "{title} · {formatted date}" using the ACTUAL formatLocalShortDate output — no hand-typed fixture standing in for it', async () => {
    const user = userEvent.setup();
    render(
      <FilesCard
        {...baseProps({
          recordings: [recordingRow()],
          meetingTitle: 'Flow interview stuck on a loop',
          meetingOccurredAtIso: '2026-07-29T04:14:00.000Z',
        })}
      />
    );
    await user.click(await screen.findByRole('button', { name: /play recording/i }));
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());

    // `formatLocalShortDate` is NOT mocked here — this proves what `RecordingBlock` actually
    // composes (`title={meetingTitle}` · `description={formatLocalShortDate(meetingOccurredAtIso)}`)
    // rather than a fixture someone typed by hand (the bug m12 found: '29 Jul, 4:14pm' was never
    // producible — the formatter is date-only).
    expect(screen.getByText('Flow interview stuck on a loop · 29 Jul')).toBeInTheDocument();
  });
});

describe('FilesCard — processing states (single segment)', () => {
  it('recent processing shows the time-based copy, no play button, but DOES offer Refresh', async () => {
    render(
      <FilesCard
        {...baseProps({
          recordings: [
            recordingRow({
              recording: {
                id: 'rec-1',
                status: 'ingesting',
                playbackId: null,
                durationSeconds: null,
                startedAt: null,
                readyAt: null,
              },
              posterUrl: null,
              isLongTailProcessing: false,
            }),
          ],
        })}
      />
    );
    expect(await screen.findByText('Processing your recording…')).toBeInTheDocument();
    expect(screen.queryByText('Still processing')).toBeNull();
    expect(screen.queryByRole('button', { name: /play/i })).toBeNull();
    // ⚠ REVIEW FIX — this used to assert NO Refresh here. The recent tier is exactly when a
    // refresh is most likely to surface a newly-ready recording, so it now gets the link too;
    // the gate is "any row still processing", not "any row long-tail".
    expect(screen.getByRole('button', { name: /refresh/i })).toBeInTheDocument();
  });

  it('offers NO Refresh when every row is terminal (ready / failed) — nothing left to change', async () => {
    render(
      <FilesCard
        {...baseProps({
          recordings: [
            recordingRow(),
            recordingRow({
              recording: {
                id: 'rec-2',
                status: 'failed',
                playbackId: null,
                durationSeconds: null,
                startedAt: '2026-07-29T04:14:00.000Z',
                readyAt: null,
              },
              posterUrl: null,
            }),
          ],
        })}
      />
    );
    expect(await screen.findByText('Recordings (2)')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /refresh/i })).toBeNull();
  });

  it('long-tail processing shows the timeless copy plus exactly one Refresh control', async () => {
    const user = userEvent.setup();
    render(
      <FilesCard
        {...baseProps({
          recordings: [
            recordingRow({
              recording: {
                id: 'rec-1',
                status: 'ingesting',
                playbackId: null,
                durationSeconds: null,
                startedAt: null,
                readyAt: null,
              },
              posterUrl: null,
              isLongTailProcessing: true,
            }),
          ],
        })}
      />
    );
    expect(await screen.findByText('Still processing')).toBeInTheDocument();
    const refreshButtons = screen.getAllByRole('button', { name: /refresh/i });
    expect(refreshButtons).toHaveLength(1);

    // House rule: destructure + guard, never an index-position `!` (noUncheckedIndexedAccess).
    const [refreshButton] = refreshButtons;
    if (refreshButton === undefined) {
      throw new Error('expected exactly one Refresh button');
    }
    await user.click(refreshButton);
    expect(mockRefresh).toHaveBeenCalled();
  });

  it('two long-tail segments still render exactly ONE Refresh control', async () => {
    render(
      <FilesCard
        {...baseProps({
          recordings: [
            recordingRow({
              recording: {
                id: 'rec-1',
                status: 'ingesting',
                playbackId: null,
                durationSeconds: null,
                startedAt: null,
                readyAt: null,
              },
              posterUrl: null,
              isLongTailProcessing: true,
            }),
            recordingRow({
              recording: {
                id: 'rec-2',
                status: 'recording',
                playbackId: null,
                durationSeconds: null,
                startedAt: null,
                readyAt: null,
              },
              posterUrl: null,
              isLongTailProcessing: true,
            }),
          ],
        })}
      />
    );
    expect(await screen.findAllByRole('button', { name: /refresh/i })).toHaveLength(1);
  });
});

describe('FilesCard — a failed single recording', () => {
  it('shows the muted failed copy, no play button, and carries no destructive class', async () => {
    const { container } = render(
      <FilesCard
        {...baseProps({
          recordings: [
            recordingRow({
              recording: {
                id: 'rec-1',
                status: 'failed',
                playbackId: null,
                durationSeconds: null,
                startedAt: null,
                readyAt: null,
              },
              posterUrl: null,
              isLongTailProcessing: false,
            }),
          ],
        })}
      />
    );
    expect(await screen.findByText("This recording couldn't be processed")).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /play/i })).toBeNull();
    expect(container.innerHTML).not.toContain('destructive');
  });
});

describe('FilesCard — 3 mixed segments (compact list)', () => {
  it('renders the "Recordings (3)" caption, three rows, one play button and one failed row', async () => {
    render(
      <FilesCard
        {...baseProps({
          recordings: [
            recordingRow({
              recording: {
                id: 'rec-1',
                status: 'ready',
                playbackId: 'pb_1',
                durationSeconds: 724,
                startedAt: '2026-07-29T04:14:00.000Z',
                readyAt: '2026-07-29T04:24:00.000Z',
              },
            }),
            recordingRow({
              recording: {
                id: 'rec-2',
                status: 'ingesting',
                playbackId: null,
                durationSeconds: null,
                startedAt: null,
                readyAt: null,
              },
              posterUrl: null,
              isLongTailProcessing: false,
            }),
            recordingRow({
              recording: {
                id: 'rec-3',
                status: 'failed',
                playbackId: null,
                durationSeconds: null,
                startedAt: null,
                readyAt: null,
              },
              posterUrl: null,
              isLongTailProcessing: false,
            }),
          ],
        })}
      />
    );
    expect(await screen.findByText('Recordings (3)')).toBeInTheDocument();
    expect(screen.getAllByText(/Segment \d/)).toHaveLength(3);
    expect(screen.getByRole('button', { name: 'Play segment 1' })).toBeInTheDocument();
    expect(screen.getByText("Couldn't process")).toBeInTheDocument();
  });

  it('has no accessibility violations', async () => {
    const { container } = render(
      <FilesCard
        {...baseProps({
          recordings: [
            recordingRow({ recording: { ...recordingRow().recording, id: 'rec-1' } }),
            recordingRow({
              recording: {
                id: 'rec-2',
                status: 'ingesting',
                playbackId: null,
                durationSeconds: null,
                startedAt: null,
                readyAt: null,
              },
              posterUrl: null,
              isLongTailProcessing: false,
            }),
            recordingRow({
              recording: {
                id: 'rec-3',
                status: 'failed',
                playbackId: null,
                durationSeconds: null,
                startedAt: null,
                readyAt: null,
              },
              posterUrl: null,
              isLongTailProcessing: false,
            }),
          ],
        })}
      />
    );
    await screen.findByText('Recordings (3)');
    expect(await axe(container)).toHaveNoViolations();
  });
});
