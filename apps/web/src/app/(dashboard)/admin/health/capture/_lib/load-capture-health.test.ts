import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockListPage,
  mockCountByCategory,
  mockHasAnyRecording,
  mockFindByMeetingId,
  mockLoadDetails,
} = vi.hoisted(() => ({
  mockListPage: vi.fn(),
  mockCountByCategory: vi.fn(),
  mockHasAnyRecording: vi.fn(),
  mockFindByMeetingId: vi.fn(),
  mockLoadDetails: vi.fn(),
}));

vi.mock('@balo/db', () => ({
  captureHealthRepository: {
    listPage: mockListPage,
    countByCategory: mockCountByCategory,
    hasAnyRecording: mockHasAnyRecording,
    findByMeetingId: mockFindByMeetingId,
    loadDetails: mockLoadDetails,
  },
}));
vi.mock('@balo/shared/admin-alerts', () => ({
  TRANSCRIPT_SOURCE_WITHHELD_AFTER_MS: 24 * 60 * 60 * 1000,
}));
// `@balo/shared/capture-health` is deliberately NOT mocked: it is pure (no I/O), and the view
// layer under test calls its three ladder derivations. A partial mock stubbing only the page
// size hid those exports — and mocking them would have meant asserting against fabricated
// ladders rather than the real derivation this page's correctness depends on.

import { loadCaptureHealth } from './load-capture-health';
import type { CaptureHealthWindowView } from './window';

const MEETING_1 = '11111111-1111-4111-8111-111111111111';
const MEETING_2 = '22222222-2222-4222-8222-222222222222';

const WINDOW: CaptureHealthWindowView = {
  from: new Date('2026-08-01T00:00:00.000Z'),
  to: new Date('2026-09-01T00:00:00.000Z'),
  days: 31,
  fromIso: '2026-08-01',
  toIso: '2026-08-31',
  fellBack: false,
};

function healthyFacts() {
  return {
    recording: {
      segmentCount: 1,
      anyFailed: false,
      anySourceReady: false,
      anyIngesting: false,
      anyCapturing: false,
      anyReady: true,
      anyRedrivableFailure: false,
    },
    transcription: {
      anyFailure: false,
      anySubmitted: true,
      anyOpen: false,
      anyWithheld: false,
      anyFinished: true,
    },
    recap: {
      transcriptCount: 1,
      anyFailed: false,
      anyPartial: false,
      anyProcessing: false,
      anyReady: true,
    },
    hasEngagementContext: true,
  };
}

function meetingRow(id: string, healthRank = 3) {
  return {
    meetingId: id,
    scheduledStart: new Date('2026-08-15T10:00:00.000Z'),
    scheduledEnd: new Date('2026-08-15T10:30:00.000Z'),
    startedAt: new Date('2026-08-15T10:00:00.000Z'),
    endedAt: new Date('2026-08-15T10:30:00.000Z'),
    meetingStatus: 'ended',
    healthRank,
    facts: healthyFacts(),
  };
}

const EMPTY_DETAILS = {
  recordings: new Map(),
  recap: new Map(),
  recapFailed: new Map(),
  expert: new Map(),
  party: new Map(),
};

describe('loadCaptureHealth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadDetails.mockResolvedValue(EMPTY_DETAILS);
    mockFindByMeetingId.mockResolvedValue(undefined);
  });

  it('maps a page of rows, tiles and hasMore/nextCursor', async () => {
    mockListPage.mockResolvedValue({ rows: [meetingRow(MEETING_1)], hasMore: true });
    mockCountByCategory.mockResolvedValue({ recording: 1, transcription: 2, recap: 0, healthy: 5 });
    mockHasAnyRecording.mockResolvedValue(true);

    const dto = await loadCaptureHealth({ window: WINDOW, category: null, pinnedMeetingId: null });

    expect(dto.rows).toHaveLength(1);
    expect(dto.rows[0]?.meetingId).toBe(MEETING_1);
    expect(dto.tiles).toEqual({ recording: 1, transcription: 2, recap: 0, healthy: 5 });
    expect(dto.issueCount).toBe(3);
    expect(dto.hasMore).toBe(true);
    expect(dto.nextCursor).toEqual({
      healthRank: 3,
      scheduledStartIso: '2026-08-15T10:00:00.000Z',
      meetingId: MEETING_1,
    });
    expect(dto.isTrueZero).toBe(false);
    expect(dto.pinned).toBeNull();
    expect(dto.pinnedMissing).toBe(false);
  });

  it('nextCursor is null when there is no more', async () => {
    mockListPage.mockResolvedValue({ rows: [meetingRow(MEETING_1)], hasMore: false });
    mockCountByCategory.mockResolvedValue({ recording: 0, transcription: 0, recap: 0, healthy: 1 });
    mockHasAnyRecording.mockResolvedValue(true);

    const dto = await loadCaptureHealth({ window: WINDOW, category: null, pinnedMeetingId: null });
    expect(dto.nextCursor).toBeNull();
  });

  it('true-zero is derived from hasAnyRecording, independent of the windowed page', async () => {
    mockListPage.mockResolvedValue({ rows: [], hasMore: false });
    mockCountByCategory.mockResolvedValue({ recording: 0, transcription: 0, recap: 0, healthy: 0 });
    mockHasAnyRecording.mockResolvedValue(false);

    const dto = await loadCaptureHealth({ window: WINDOW, category: null, pinnedMeetingId: null });
    expect(dto.isTrueZero).toBe(true);
  });

  it('the pinned row is resolved and de-duplicated out of the list below', async () => {
    mockListPage.mockResolvedValue({
      rows: [meetingRow(MEETING_1), meetingRow(MEETING_2)],
      hasMore: false,
    });
    mockCountByCategory.mockResolvedValue({ recording: 0, transcription: 0, recap: 0, healthy: 2 });
    mockHasAnyRecording.mockResolvedValue(true);
    mockFindByMeetingId.mockResolvedValue(meetingRow(MEETING_2));

    const dto = await loadCaptureHealth({
      window: WINDOW,
      category: null,
      pinnedMeetingId: MEETING_2,
    });

    expect(dto.pinned?.meetingId).toBe(MEETING_2);
    expect(dto.pinnedMissing).toBe(false);
    expect(dto.rows.map((r) => r.meetingId)).toEqual([MEETING_1]);
  });

  it('a `?row=` naming a meeting outside the window still resolves via findByMeetingId (not window-bounded)', async () => {
    mockListPage.mockResolvedValue({ rows: [], hasMore: false });
    mockCountByCategory.mockResolvedValue({ recording: 0, transcription: 0, recap: 0, healthy: 0 });
    mockHasAnyRecording.mockResolvedValue(true);
    mockFindByMeetingId.mockResolvedValue(meetingRow(MEETING_2));

    const dto = await loadCaptureHealth({
      window: WINDOW,
      category: null,
      pinnedMeetingId: MEETING_2,
    });
    expect(dto.pinned?.meetingId).toBe(MEETING_2);
  });

  it('pinnedMissing is true when `?row=` names a meeting that resolves to nothing', async () => {
    mockListPage.mockResolvedValue({ rows: [], hasMore: false });
    mockCountByCategory.mockResolvedValue({ recording: 0, transcription: 0, recap: 0, healthy: 0 });
    mockHasAnyRecording.mockResolvedValue(true);
    mockFindByMeetingId.mockResolvedValue(undefined);

    const dto = await loadCaptureHealth({
      window: WINDOW,
      category: null,
      pinnedMeetingId: 'missing',
    });
    expect(dto.pinned).toBeNull();
    expect(dto.pinnedMissing).toBe(true);
  });

  it('ONE withheldBefore is computed and returned for the client to carry into load-more', async () => {
    mockListPage.mockResolvedValue({ rows: [], hasMore: false });
    mockCountByCategory.mockResolvedValue({ recording: 0, transcription: 0, recap: 0, healthy: 0 });
    mockHasAnyRecording.mockResolvedValue(true);

    const dto = await loadCaptureHealth({ window: WINDOW, category: null, pinnedMeetingId: null });
    expect(mockListPage).toHaveBeenCalledWith(
      expect.objectContaining({ withheldBefore: new Date(dto.withheldBeforeIso) })
    );
    expect(mockCountByCategory).toHaveBeenCalledWith(
      expect.objectContaining({ withheldBefore: new Date(dto.withheldBeforeIso) })
    );
  });
});
