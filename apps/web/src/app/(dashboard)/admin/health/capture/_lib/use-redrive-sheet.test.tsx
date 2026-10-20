import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { toast } from 'sonner';
import { track, ADMIN_CAPTURE_HEALTH_EVENTS } from '@/lib/analytics';
import { useRedriveSheet, applyOptimisticAfter } from './use-redrive-sheet';
import type { CaptureHealthRowView } from './capture-health-view';

const { mockRequestRedrive } = vi.hoisted(() => ({ mockRequestRedrive: vi.fn() }));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../_actions/request-redrive', () => ({ requestRedrive: mockRequestRedrive }));

function row(overrides: Partial<CaptureHealthRowView> = {}): CaptureHealthRowView {
  return {
    meetingId: 'm-1',
    title: 'Consultation 28 Aug 2026',
    parties: 'Bright Foods × Aisha Bello',
    when: '28 Aug',
    durationLabel: '42 min',
    contextLabel: 'case',
    recording: { state: 'failed' },
    transcription: { state: 'pending' },
    recap: { state: 'none' },
    category: 'recording',
    action: { kind: 'recording-ingest', recordingId: 'rec-1', segmentLabel: 'Segment 1 of 1' },
    ...overrides,
  };
}

describe('useRedriveSheet', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('openSheet sets the target for a recording-ingest action', () => {
    const { result } = renderHook(() => useRedriveSheet(vi.fn()));
    act(() => result.current.openSheet(row()));
    expect(result.current.sheetTarget).toEqual({
      kind: 'recording-ingest',
      row: row(),
      recordingId: 'rec-1',
      segmentLabel: 'Segment 1 of 1',
    });
  });

  it('openSheet is a no-op for a row with no re-drivable action', () => {
    const { result } = renderHook(() => useRedriveSheet(vi.fn()));
    act(() => result.current.openSheet(row({ action: { kind: 'none' } })));
    expect(result.current.sheetTarget).toBeNull();
  });

  it('confirm success: toasts once, fires the analytic exactly once with outcome "queued", updates the row, closes', async () => {
    mockRequestRedrive.mockResolvedValue({
      success: true,
      jobId: 'recording-ingest--rec-1--redrive-audit-1',
    });
    const onRowUpdated = vi.fn();
    const { result } = renderHook(() => useRedriveSheet(onRowUpdated));

    act(() => result.current.openSheet(row()));
    act(() => result.current.confirm());

    await waitFor(() => expect(result.current.sheetTarget).toBeNull());
    expect(toast.success).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledWith(ADMIN_CAPTURE_HEALTH_EVENTS.REDRIVE_REQUESTED, {
      kind: 'recording-ingest',
      outcome: 'queued',
    });
    expect(onRowUpdated).toHaveBeenCalledWith(
      expect.objectContaining({ recording: { state: 'ingesting', note: 'Re-driven just now' } })
    );
  });

  it('confirm failure (not_redrivable) toasts the error and fires outcome "refused"', async () => {
    mockRequestRedrive.mockResolvedValue({
      success: false,
      reason: 'not_redrivable',
      error: 'This row already moved.',
    });
    const { result } = renderHook(() => useRedriveSheet(vi.fn()));

    act(() => result.current.openSheet(row()));
    act(() => result.current.confirm());

    await waitFor(() => expect(result.current.sheetTarget).toBeNull());
    expect(toast.error).toHaveBeenCalledWith('This row already moved.');
    expect(track).toHaveBeenCalledWith(ADMIN_CAPTURE_HEALTH_EVENTS.REDRIVE_REQUESTED, {
      kind: 'recording-ingest',
      outcome: 'refused',
    });
  });

  it('closeSheet clears the target without calling the api', () => {
    const { result } = renderHook(() => useRedriveSheet(vi.fn()));
    act(() => result.current.openSheet(row()));
    act(() => result.current.closeSheet());
    expect(result.current.sheetTarget).toBeNull();
    expect(mockRequestRedrive).not.toHaveBeenCalled();
  });
});

describe('applyOptimisticAfter', () => {
  it('recording-ingest → ingesting, note "Re-driven just now", action cleared', () => {
    const updated = applyOptimisticAfter(row(), 'recording-ingest');
    expect(updated.recording).toEqual({ state: 'ingesting', note: 'Re-driven just now' });
    expect(updated.action).toEqual({ kind: 'none' });
  });

  it('transcript-pipeline → processing, note "Re-run just now", action cleared', () => {
    const updated = applyOptimisticAfter(row(), 'transcript-pipeline');
    expect(updated.recap).toEqual({ state: 'processing', note: 'Re-run just now' });
    expect(updated.action).toEqual({ kind: 'none' });
  });
});
