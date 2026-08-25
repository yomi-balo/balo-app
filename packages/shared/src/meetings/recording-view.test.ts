import { describe, it, expect } from 'vitest';
import {
  toMeetingRecordingView,
  MEETING_RECORDING_VIEW_KEYS,
  MEETING_RECORDING_CONCEALED_KEYS,
  type MeetingRecordingView,
} from './recording-view';

/**
 * BAL-473 — THE SERIALIZER / CONCEALMENT TEST THE AC DEMANDS. Mirrors the shape of
 * `packages/shared/src/credit/money-block.test.ts` — the concealment is a TYPE-level
 * guarantee, but this test proves the RUNTIME projection actually honours it, over a
 * deliberately over-wide input carrying a unique sentinel in every field that must never
 * cross to a client.
 */

const SENTINELS = {
  dailyRecordingId: 'SENTINEL_DAILY',
  muxAssetId: 'SENTINEL_ASSET',
  failedStage: 'SENTINEL_STAGE',
  failureReason: 'SENTINEL_REASON',
  // ⚠ DELIBERATELY NOT `2026-01-01T00:00:00Z` — that instant is ALSO used below for the
  // legitimate (non-concealed) `startedAt` field, and a colliding timestamp would make this
  // sentinel's presence in the JSON indistinguishable from an allowed field's.
  sourceDeletedAt: new Date('2099-12-31T23:59:59Z'),
  downloadLink: 'https://SENTINEL_LINK',
} as const;

function overWideRow(): Record<string, unknown> {
  return {
    id: 'rec_1',
    status: 'ready',
    muxPlaybackId: 'pb_123',
    durationSeconds: 90,
    startedAt: new Date('2026-01-01T00:00:00Z'),
    readyAt: new Date('2026-01-01T00:05:00Z'),
    // ── Everything below MUST be concealed. ──
    dailyRecordingId: SENTINELS.dailyRecordingId,
    muxAssetId: SENTINELS.muxAssetId,
    failedStage: SENTINELS.failedStage,
    failureReason: SENTINELS.failureReason,
    sourceDeletedAt: SENTINELS.sourceDeletedAt,
    downloadLink: SENTINELS.downloadLink,
  };
}

describe('toMeetingRecordingView', () => {
  it('returns exactly the six client-safe keys, even from an over-wide input', () => {
    const view = toMeetingRecordingView(
      overWideRow() as unknown as Parameters<typeof toMeetingRecordingView>[0]
    );
    expect(Object.keys(view).sort()).toStrictEqual([...MEETING_RECORDING_VIEW_KEYS].sort());
  });

  it('never serializes any concealed sentinel', () => {
    const view = toMeetingRecordingView(
      overWideRow() as unknown as Parameters<typeof toMeetingRecordingView>[0]
    );
    const json = JSON.stringify(view);
    for (const sentinel of Object.values(SENTINELS)) {
      const needle = sentinel instanceof Date ? sentinel.toISOString() : sentinel;
      expect(json).not.toContain(needle);
    }
  });

  it('never carries any of the named concealed keys', () => {
    const view = toMeetingRecordingView(
      overWideRow() as unknown as Parameters<typeof toMeetingRecordingView>[0]
    ) as unknown as Record<string, unknown>;
    for (const key of MEETING_RECORDING_CONCEALED_KEYS) {
      expect(Object.prototype.hasOwnProperty.call(view, key)).toBe(false);
    }
  });

  it('maps null vendor/playback fields through as null', () => {
    const view: MeetingRecordingView = toMeetingRecordingView({
      id: 'rec_2',
      status: 'recording',
      muxPlaybackId: null,
      durationSeconds: null,
      startedAt: null,
      readyAt: null,
    });
    expect(view).toStrictEqual({
      id: 'rec_2',
      status: 'recording',
      playbackId: null,
      durationSeconds: null,
      startedAt: null,
      readyAt: null,
    });
  });

  it('serializes startedAt/readyAt as ISO-8601 strings', () => {
    const view = toMeetingRecordingView({
      id: 'rec_3',
      status: 'ready',
      muxPlaybackId: 'pb_1',
      durationSeconds: 60,
      startedAt: new Date('2026-02-01T10:00:00Z'),
      readyAt: new Date('2026-02-01T10:05:00Z'),
    });
    expect(view.startedAt).toBe('2026-02-01T10:00:00.000Z');
    expect(view.readyAt).toBe('2026-02-01T10:05:00.000Z');
  });
});
