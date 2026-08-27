import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent } from '@testing-library/react';
import { render, screen, waitFor } from '@/test/utils';
import { track, RECAP_EVENTS } from '@/lib/analytics';
import { RecordingPlayerDialog } from './recording-player-dialog';

const MEETING_ID = 'a0000000-0000-4000-8000-000000000001';
const URL = 'https://stream.mux.example/pb_1.m3u8?token=t';

const {
  mockIsSupported,
  mockOn,
  mockLoadSource,
  mockAttachMedia,
  mockDestroy,
  mockStartLoad,
  importState,
} = vi.hoisted(() => ({
  mockIsSupported: vi.fn(() => true),
  mockOn: vi.fn(),
  mockLoadSource: vi.fn(),
  mockAttachMedia: vi.fn(),
  mockDestroy: vi.fn(),
  mockStartLoad: vi.fn(),
  // FIX ROUND 1 (M2c) — a mutable flag the factory reads on EVERY dynamic `import('hls.js')`,
  // so one test can make the import reject without poisoning every other test's resolution.
  importState: { shouldReject: false },
}));

vi.mock('hls.js', () => {
  if (importState.shouldReject) {
    throw new Error('Failed to fetch dynamically imported module');
  }
  class MockHls {
    static Events = { ERROR: 'hlsError' };
    static ErrorTypes = { NETWORK_ERROR: 'networkError', MEDIA_ERROR: 'mediaError' };
    static isSupported = mockIsSupported;
    on = mockOn;
    loadSource = mockLoadSource;
    attachMedia = mockAttachMedia;
    destroy = mockDestroy;
    startLoad = mockStartLoad;
    constructor(public config?: { autoStartLoad?: boolean }) {}
  }
  return { default: MockHls };
});

import Hls from 'hls.js';

/** The handler `hls.on(Hls.Events.ERROR, handler)` was last called with — destructure + guard,
 * never a bare `!` (house rule, `noUncheckedIndexedAccess`). */
function capturedErrorHandler(): (event: string, data: { fatal: boolean; type: string }) => void {
  const [call] = mockOn.mock.calls;
  if (call === undefined) {
    throw new Error('expected hls.on(Events.ERROR, …) to have been called');
  }
  const [, handler] = call as [
    string,
    (event: string, data: { fatal: boolean; type: string }) => void,
  ];
  return handler;
}

function baseProps(over: Record<string, unknown> = {}) {
  return {
    open: true,
    onOpenChange: vi.fn(),
    url: URL,
    posterUrl: null,
    segmentIndex: 1,
    segmentCount: 1,
    meetingId: MEETING_ID,
    lens: 'client' as const,
    durationSeconds: 2640,
    title: 'Flow interview stuck on a loop',
    // m12 — what `RecordingBlock` ACTUALLY passes: `formatLocalShortDate(occurredAtIso)`,
    // which is date-only ("29 Jul"), never a time. The old '29 Jul, 4:14pm' fixture asserted a
    // shape production never produces.
    description: '29 Jul',
    showCaptionsNote: false,
    ...over,
  };
}

function getVideo(container: HTMLElement): HTMLVideoElement {
  const video = container.ownerDocument.querySelector('video');
  if (video === null) {
    throw new Error('expected a <video> element to be rendered');
  }
  return video;
}

describe('RecordingPlayerDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsSupported.mockReturnValue(true);
    importState.shouldReject = false;
    // jsdom's HTMLMediaElement.canPlayType always returns '' — the MSE/hls.js branch by default.
    vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockReturnValue('');
    // m5's teardown calls real `pause()`/`load()` on unmount; jsdom doesn't implement either
    // and logs a noisy (harmless) "Not implemented" warning otherwise.
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  });

  it('fires RECORDING_PLAYED on the FIRST playing event, with the exact property object', async () => {
    render(<RecordingPlayerDialog {...baseProps()} />);
    await waitFor(() => expect(mockAttachMedia).toHaveBeenCalled());
    const video = getVideo(document.body);

    fireEvent.playing(video);

    expect(track).toHaveBeenCalledWith(RECAP_EVENTS.RECORDING_PLAYED, {
      meeting_id: MEETING_ID,
      lens: 'client',
      segment_index: 1,
      segment_count: 1,
      duration_seconds: 2640,
    });
    expect(track).toHaveBeenCalledTimes(1);
  });

  it('does NOT fire on open — only on a genuine playing event', async () => {
    render(<RecordingPlayerDialog {...baseProps()} />);
    await waitFor(() => expect(mockAttachMedia).toHaveBeenCalled());
    expect(track).not.toHaveBeenCalled();
  });

  it('fires exactly once even if playing fires three times (scrub/pause/resume)', async () => {
    render(<RecordingPlayerDialog {...baseProps()} />);
    await waitFor(() => expect(mockAttachMedia).toHaveBeenCalled());
    const video = getVideo(document.body);

    fireEvent.playing(video);
    fireEvent.playing(video);
    fireEvent.playing(video);

    expect(track).toHaveBeenCalledTimes(1);
  });

  it('native path: a browser with native HLS support sets video.src and never imports hls.js', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockReturnValue('probably');
    render(<RecordingPlayerDialog {...baseProps()} />);
    const video = getVideo(document.body);

    await waitFor(() => expect(video.src).toBe(URL));
    expect(mockAttachMedia).not.toHaveBeenCalled();
    expect(mockLoadSource).not.toHaveBeenCalled();
  });

  it('MSE path: consults Hls.isSupported() and calls loadSource/attachMedia with the url and element', async () => {
    render(<RecordingPlayerDialog {...baseProps()} />);
    const video = getVideo(document.body);

    await waitFor(() => expect(mockIsSupported).toHaveBeenCalled());
    expect(mockLoadSource).toHaveBeenCalledWith(URL);
    expect(mockAttachMedia).toHaveBeenCalledWith(video);
  });

  it('renders the unplayable message when Hls.isSupported() is false', async () => {
    mockIsSupported.mockReturnValue(false);
    render(<RecordingPlayerDialog {...baseProps()} />);

    expect(
      await screen.findByText("This recording can't be played in this browser.")
    ).toBeInTheDocument();
  });

  it('renders the captions note when showCaptionsNote is true', () => {
    render(<RecordingPlayerDialog {...baseProps({ showCaptionsNote: true })} />);
    expect(screen.getByText('No captions yet — read the transcript above.')).toBeInTheDocument();
  });

  it('omits the captions note when showCaptionsNote is false', () => {
    render(<RecordingPlayerDialog {...baseProps({ showCaptionsNote: false })} />);
    expect(screen.queryByText(/No captions yet/)).not.toBeInTheDocument();
  });

  it('titles the dialog "Recording" for a single segment', () => {
    render(<RecordingPlayerDialog {...baseProps({ segmentCount: 1 })} />);
    expect(screen.getByRole('heading', { name: 'Recording' })).toBeInTheDocument();
  });

  it('titles the dialog "Segment {n} recording" for a multi-segment meeting', () => {
    render(<RecordingPlayerDialog {...baseProps({ segmentIndex: 2, segmentCount: 3 })} />);
    expect(screen.getByRole('heading', { name: 'Segment 2 recording' })).toBeInTheDocument();
  });

  it('builds the description from the title and description props', () => {
    render(<RecordingPlayerDialog {...baseProps()} />);
    expect(screen.getByText('Flow interview stuck on a loop · 29 Jul')).toBeInTheDocument();
  });

  it('gives the <video> an accessible name — the dialog title, not a bare icon-only control', async () => {
    render(<RecordingPlayerDialog {...baseProps()} />);
    await waitFor(() => expect(mockAttachMedia).toHaveBeenCalled());
    expect(getVideo(document.body)).toHaveAttribute('aria-label', 'Recording');
  });

  // ── M2 — mockDestroy was wired in and never asserted. ──────────────────────────────────

  it('M2a — destroys the hls.js instance on unmount', async () => {
    const { unmount } = render(<RecordingPlayerDialog {...baseProps()} />);
    await waitFor(() => expect(mockAttachMedia).toHaveBeenCalled());

    unmount();

    expect(mockDestroy).toHaveBeenCalledOnce();
  });

  it('M2b — a fatal NETWORK_ERROR shows the LOAD-failure message (not the unsupported-browser one) and destroys the instance', async () => {
    render(<RecordingPlayerDialog {...baseProps()} />);
    await waitFor(() => expect(mockOn).toHaveBeenCalled());

    act(() => {
      capturedErrorHandler()('hlsError', { fatal: true, type: Hls.ErrorTypes.NETWORK_ERROR });
    });

    expect(
      await screen.findByText("This recording couldn't be loaded. Please close and try again.")
    ).toBeInTheDocument();
    expect(
      screen.queryByText("This recording can't be played in this browser.")
    ).not.toBeInTheDocument();
    // The video unmounts once the error message replaces it, which drives the attach effect's
    // own cleanup — the same mechanism M2a proves on a normal unmount.
    await waitFor(() => expect(mockDestroy).toHaveBeenCalledOnce());
  });

  it('M2b — a NON-fatal error is ignored entirely', async () => {
    render(<RecordingPlayerDialog {...baseProps()} />);
    await waitFor(() => expect(mockOn).toHaveBeenCalled());

    act(() => {
      capturedErrorHandler()('hlsError', { fatal: false, type: Hls.ErrorTypes.NETWORK_ERROR });
    });

    expect(
      screen.queryByText("This recording couldn't be loaded. Please close and try again.")
    ).not.toBeInTheDocument();
    expect(getVideo(document.body)).toBeInTheDocument();
  });

  // ── M1 — the native/Safari path had no error handling at all. ──────────────────────────

  it('M1 — the native HLS path degrades to the SAME load-failure message on a video error', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockReturnValue('probably');
    render(<RecordingPlayerDialog {...baseProps()} />);
    const video = getVideo(document.body);
    await waitFor(() => expect(video.src).toBe(URL));

    fireEvent.error(video);

    expect(
      await screen.findByText("This recording couldn't be loaded. Please close and try again.")
    ).toBeInTheDocument();
  });

  it('m5 — the native path tears itself down (pause / removeAttribute / load) on unmount', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockReturnValue('probably');
    const { unmount } = render(<RecordingPlayerDialog {...baseProps()} />);
    const video = getVideo(document.body);
    await waitFor(() => expect(video.src).toBe(URL));

    unmount();

    // `beforeEach` stubs `pause`/`load` (jsdom implements neither) — assert against THOSE
    // stubs rather than re-spying, so this checks the same instances the component called.
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
    expect(HTMLMediaElement.prototype.load).toHaveBeenCalled();
  });

  // ── m4 — preload="none" was defeated on the hls.js path (autoStartLoad: true by default). ──

  it('m4 — constructs Hls with autoStartLoad: false, and never calls startLoad before play', async () => {
    render(<RecordingPlayerDialog {...baseProps()} />);
    await waitFor(() => expect(mockAttachMedia).toHaveBeenCalled());

    expect(mockStartLoad).not.toHaveBeenCalled();
  });

  it("m4 — starts the hls.js load on the video's first `play` event", async () => {
    render(<RecordingPlayerDialog {...baseProps()} />);
    const video = getVideo(document.body);
    await waitFor(() => expect(mockAttachMedia).toHaveBeenCalled());

    fireEvent.play(video);

    expect(mockStartLoad).toHaveBeenCalledOnce();
  });

  // ⚠ MUST STAY THE LAST TEST IN THIS FILE. `vi.doMock` (unhoisted) is the only reliable way
  // to override an already-resolved dynamic `import()`'s cached resolution, but the override
  // is NOT scoped to one test — it persists for the rest of the file's run, so every test that
  // needs 'hls.js' to actually resolve must run BEFORE this one.
  it("M2c — a rejected import('hls.js') degrades to the load-failure message rather than crashing", async () => {
    vi.doMock('hls.js', () => {
      throw new Error('Failed to fetch dynamically imported module');
    });
    render(<RecordingPlayerDialog {...baseProps()} />);

    expect(
      await screen.findByText("This recording couldn't be loaded. Please close and try again.")
    ).toBeInTheDocument();
  });
});
