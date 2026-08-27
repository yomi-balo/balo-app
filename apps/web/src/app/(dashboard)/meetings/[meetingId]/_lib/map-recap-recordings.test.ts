import { describe, it, expect, vi, beforeEach } from 'vitest';

const MEETING_ID = 'a0000000-0000-4000-8000-000000000001';
const NOW = new Date('2026-08-25T12:00:00Z');

vi.mock('server-only', () => ({}));

const mockSignedThumbnailUrl = vi.fn();
vi.mock('@/lib/mux/playback', () => ({
  signedThumbnailUrl: (...args: unknown[]) => mockSignedThumbnailUrl(...args),
}));

import {
  MEETING_RECORDING_VIEW_KEYS,
  MEETING_RECORDING_CONCEALED_KEYS,
} from '@balo/shared/meetings';
import { mapRecapRecordings, deriveRecordingState } from './map-recap-recordings';
import { log } from '@/lib/logging';
import type { RecapRecordingRowView } from '@/lib/meetings/recap-view-types';

/** ⚠ CARRIES A SENTINEL ON EVERY CONCEALED COLUMN — the concealment proof needs a FAT row. */
function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'rec-1',
    meetingId: MEETING_ID,
    status: 'ready',
    dailyRecordingId: 'daily-SECRET',
    muxAssetId: 'asset-SECRET',
    muxPlaybackId: 'pb_1',
    failedStage: 'mux_ingest',
    failureReason: 'SECRET-REASON',
    startedAt: new Date('2026-08-25T09:00:00Z'),
    captureEndedAt: new Date('2026-08-25T09:45:00Z'),
    durationSeconds: 600,
    readyAt: new Date('2026-08-25T09:46:00Z'),
    sourceDeletedAt: new Date('2026-08-25T10:00:00Z'),
    downloadLink: 'https://SECRET-DOWNLOAD',
    createdAt: new Date('2026-08-25T09:00:00Z'),
    updatedAt: new Date('2026-08-25T09:46:00Z'),
    deletedAt: null,
    ...over,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asRows = (rows: Record<string, unknown>[]) => rows as any;

describe('mapRecapRecordings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSignedThumbnailUrl.mockResolvedValue('https://image.mux.com/pb_1/thumbnail.jpg?token=t');
  });

  it('NEVER lets a concealed key or its sentinel value cross the projection', async () => {
    const result = await mapRecapRecordings(asRows([row()]), NOW, NOW);
    const json = JSON.stringify(result);
    for (const key of MEETING_RECORDING_CONCEALED_KEYS) {
      expect(json).not.toContain(key);
    }
    expect(json).not.toContain('daily-SECRET');
    expect(json).not.toContain('asset-SECRET');
    expect(json).not.toContain('SECRET-REASON');
    expect(json).not.toContain('mux_ingest');
    expect(json).not.toContain('https://SECRET-DOWNLOAD');
    expect(json).not.toContain('2026-08-25T10:00:00');
  });

  it('projects `.recording` to exactly MEETING_RECORDING_VIEW_KEYS', async () => {
    const result = await mapRecapRecordings(asRows([row()]), NOW, NOW);
    expect(Object.keys(result[0]?.recording ?? {}).sort()).toEqual(
      [...MEETING_RECORDING_VIEW_KEYS].sort()
    );
  });

  describe('isLongTailProcessing', () => {
    it('is false inside the 30-minute window (29 minutes since endedAt)', async () => {
      const endedAt = new Date(NOW.getTime() - 29 * 60 * 1000);
      const result = await mapRecapRecordings(
        asRows([row({ status: 'ingesting', muxPlaybackId: null })]),
        endedAt,
        NOW
      );
      expect(result[0]?.isLongTailProcessing).toBe(false);
    });

    it('is true past the 30-minute window (31 minutes since endedAt)', async () => {
      const endedAt = new Date(NOW.getTime() - 31 * 60 * 1000);
      const result = await mapRecapRecordings(
        asRows([row({ status: 'ingesting', muxPlaybackId: null })]),
        endedAt,
        NOW
      );
      expect(result[0]?.isLongTailProcessing).toBe(true);
    });

    it('is true (timeless default) and logs a warning when endedAt is null', async () => {
      const result = await mapRecapRecordings(
        asRows([row({ status: 'recording', muxPlaybackId: null })]),
        null,
        NOW
      );
      expect(result[0]?.isLongTailProcessing).toBe(true);
      expect(log.warn).toHaveBeenCalledWith(
        'Recording present on a meeting with no endedAt',
        expect.objectContaining({ meetingId: MEETING_ID, recordingId: 'rec-1' })
      );
    });

    it('is false for a `ready` row at any age', async () => {
      const endedAt = new Date(NOW.getTime() - 6 * 60 * 60 * 1000);
      const result = await mapRecapRecordings(asRows([row({ status: 'ready' })]), endedAt, NOW);
      expect(result[0]?.isLongTailProcessing).toBe(false);
    });

    it('is false for a `failed` row at any age', async () => {
      const endedAt = new Date(NOW.getTime() - 6 * 60 * 60 * 1000);
      const result = await mapRecapRecordings(
        asRows([row({ status: 'failed', muxPlaybackId: null })]),
        endedAt,
        NOW
      );
      expect(result[0]?.isLongTailProcessing).toBe(false);
    });
  });

  describe('poster minting', () => {
    it('mints a poster for a single ready row', async () => {
      const result = await mapRecapRecordings(asRows([row()]), NOW, NOW);
      expect(mockSignedThumbnailUrl).toHaveBeenCalledOnce();
      expect(result[0]?.posterUrl).toBe('https://image.mux.com/pb_1/thumbnail.jpg?token=t');
    });

    it('does NOT mint when there are 2+ segments', async () => {
      const result = await mapRecapRecordings(
        asRows([row({ id: 'rec-1' }), row({ id: 'rec-2' })]),
        NOW,
        NOW
      );
      expect(mockSignedThumbnailUrl).not.toHaveBeenCalled();
      expect(result.every((r) => r.posterUrl === null)).toBe(true);
    });

    it('does NOT mint for a non-ready single row', async () => {
      const result = await mapRecapRecordings(
        asRows([row({ status: 'ingesting', muxPlaybackId: null })]),
        NOW,
        NOW
      );
      expect(mockSignedThumbnailUrl).not.toHaveBeenCalled();
      expect(result[0]?.posterUrl).toBeNull();
    });

    it('does NOT mint when muxPlaybackId is null, even on a `ready` row', async () => {
      const result = await mapRecapRecordings(
        asRows([row({ status: 'ready', muxPlaybackId: null })]),
        NOW,
        NOW
      );
      expect(mockSignedThumbnailUrl).not.toHaveBeenCalled();
      expect(result[0]?.posterUrl).toBeNull();
    });

    it('omits timeSeconds when durationSeconds is null', async () => {
      await mapRecapRecordings(asRows([row({ durationSeconds: null })]), NOW, NOW);
      expect(mockSignedThumbnailUrl).toHaveBeenCalledWith(
        'pb_1',
        expect.not.objectContaining({ timeSeconds: expect.anything() })
      );
    });

    it('omits timeSeconds when durationSeconds is at or below the poster frame offset (3s)', async () => {
      await mapRecapRecordings(asRows([row({ durationSeconds: 3 })]), NOW, NOW);
      expect(mockSignedThumbnailUrl).toHaveBeenCalledWith(
        'pb_1',
        expect.not.objectContaining({ timeSeconds: expect.anything() })
      );
    });

    it('passes timeSeconds: 5 for a recording longer than the poster frame offset', async () => {
      await mapRecapRecordings(asRows([row({ durationSeconds: 600 })]), NOW, NOW);
      expect(mockSignedThumbnailUrl).toHaveBeenCalledWith(
        'pb_1',
        expect.objectContaining({ timeSeconds: 5 })
      );
    });

    it('fails soft: a rejected mint resolves with posterUrl null, without rejecting, and logs no secrets', async () => {
      mockSignedThumbnailUrl.mockRejectedValue(new Error('MUX_SIGNING_KEY_ID is not set'));
      const result = await mapRecapRecordings(asRows([row()]), NOW, NOW);
      expect(result[0]?.posterUrl).toBeNull();
      expect(log.error).toHaveBeenCalledOnce();
      const [, payload] = vi.mocked(log.error).mock.calls[0] ?? [];
      const serialisedPayload = JSON.stringify(payload);
      expect(serialisedPayload).not.toContain('url');
      expect(serialisedPayload).not.toContain('token');
    });
  });

  it('preserves input order for a 3-row (multi-segment) input', async () => {
    const result = await mapRecapRecordings(
      asRows([row({ id: 'rec-1' }), row({ id: 'rec-2' }), row({ id: 'rec-3' })]),
      NOW,
      NOW
    );
    expect(result.map((r) => r.recording.id)).toEqual(['rec-1', 'rec-2', 'rec-3']);
  });
});

describe('deriveRecordingState', () => {
  function recordingRow(status: string): RecapRecordingRowView {
    return {
      recording: {
        id: 'r',
        status: status as RecapRecordingRowView['recording']['status'],
        playbackId: null,
        durationSeconds: null,
        startedAt: null,
        readyAt: null,
      },
      posterUrl: null,
      isLongTailProcessing: false,
    };
  }

  it('is absent for zero rows', () => {
    expect(deriveRecordingState([])).toBe('absent');
  });

  it('is ready when any row is ready', () => {
    expect(deriveRecordingState([recordingRow('ready')])).toBe('ready');
  });

  it('is processing for an in-flight row', () => {
    expect(deriveRecordingState([recordingRow('ingesting')])).toBe('processing');
  });

  it('is failed when every row failed', () => {
    expect(deriveRecordingState([recordingRow('failed')])).toBe('failed');
  });

  it('prefers ready over a mixed failed+ready set', () => {
    expect(deriveRecordingState([recordingRow('failed'), recordingRow('ready')])).toBe('ready');
  });

  it('prefers processing over a mixed failed+processing set', () => {
    expect(deriveRecordingState([recordingRow('failed'), recordingRow('ingesting')])).toBe(
      'processing'
    );
  });
});
