import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolvePartyHint, type ResolvePartyHintInput } from './resolve.js';
import {
  MEETING_ID,
  EXPERT_USER_ID,
  CLIENT_USER_ID,
  EXPERT_WAITING_HINT,
  expertWaitingInput,
} from './__fixtures__/scenarios.js';
import { dailyMultiSpeaker } from '../normalizers/__fixtures__/daily-deepgram.js';
import { normalizeDailyDeepgram } from '../normalizers/daily-deepgram.js';

const db = vi.hoisted(() => ({
  findByTranscriptJobId: vi.fn(),
  listByMeeting: vi.fn(),
}));
const logger = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));

// Mock ONLY the two repository members this module reads — any other access on these objects
// throws, which is itself part of the "only reads these two things" proof (see the happy-path
// test's comment).
vi.mock('@balo/db', () => ({
  meetingRecordingsRepository: { findByTranscriptJobId: db.findByTranscriptJobId },
  meetingPresenceRepository: { listByMeeting: db.listByMeeting },
}));

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => logger,
}));

const transcript = { id: 'tr1', meetingId: MEETING_ID, vendor: 'daily_deepgram' as const };

function baseInput(overrides?: Partial<ResolvePartyHintInput>): ResolvePartyHintInput {
  const waiting = expertWaitingInput();
  return {
    transcript,
    canonical: waiting.canonical,
    cleanedText: waiting.cleanedText,
    captureId: 'daily-batch:job-1',
    ...overrides,
  };
}

describe('resolvePartyHint', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('happy path: reads the recording + presence via the capture-id convention and resolves a hint', async () => {
    const waiting = expertWaitingInput();
    db.findByTranscriptJobId.mockResolvedValue(waiting.recording);
    db.listByMeeting.mockResolvedValue(waiting.presence);

    const hint = await resolvePartyHint(baseInput());

    expect(db.findByTranscriptJobId).toHaveBeenCalledWith('job-1');
    expect(db.listByMeeting).toHaveBeenCalledWith(MEETING_ID);
    expect(hint).toEqual(EXPERT_WAITING_HINT);
    expect(logger.info).toHaveBeenCalledWith(
      { transcriptId: 'tr1', meetingId: MEETING_ID, emitted: true, basis: 'presence_timing' },
      'Transcript party hint resolved'
    );
    // No other member of either mock is set — a lookup this module has no business making
    // (e.g. a `markTranscriptJob*` write) would throw, and this proves none happened.
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('precheck failure: zero repository reads, and the skip reason is logged', async () => {
    const authenticatedCanonical = normalizeDailyDeepgram(dailyMultiSpeaker);

    const hint = await resolvePartyHint(
      baseInput({ canonical: authenticatedCanonical, cleanedText: 'irrelevant' })
    );

    expect(hint).toBeNull();
    expect(db.findByTranscriptJobId).not.toHaveBeenCalled();
    expect(db.listByMeeting).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      {
        transcriptId: 'tr1',
        meetingId: MEETING_ID,
        emitted: false,
        reason: 'speakers_not_diarized',
      },
      'Transcript party hint resolved'
    );
  });

  it.each(['cap1', 'daily-batch:'])(
    'capture_id_unrecognised for %s — zero repository reads',
    async (captureId) => {
      const hint = await resolvePartyHint(baseInput({ captureId }));

      expect(hint).toBeNull();
      expect(db.findByTranscriptJobId).not.toHaveBeenCalled();
      expect(db.listByMeeting).not.toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ emitted: false, reason: 'capture_id_unrecognised' }),
        'Transcript party hint resolved'
      );
    }
  );

  it('recording_not_found: listByMeeting is never called', async () => {
    db.findByTranscriptJobId.mockResolvedValue(undefined);

    const hint = await resolvePartyHint(baseInput());

    expect(hint).toBeNull();
    expect(db.listByMeeting).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ emitted: false, reason: 'recording_not_found' }),
      'Transcript party hint resolved'
    );
  });

  it('never rejects: a findByTranscriptJobId failure degrades to null + a warn (never info)', async () => {
    db.findByTranscriptJobId.mockRejectedValue(new Error('db down'));

    const hint = await resolvePartyHint(baseInput());

    expect(hint).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        transcriptId: 'tr1',
        meetingId: MEETING_ID,
        error: 'db down',
        stack: expect.any(String),
      }),
      'Transcript party hint lookup failed — continuing without a hint'
    );
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('never rejects: a listByMeeting failure degrades to null + a warn (never info)', async () => {
    const waiting = expertWaitingInput();
    db.findByTranscriptJobId.mockResolvedValue(waiting.recording);
    db.listByMeeting.mockRejectedValue(new Error('db down'));

    const hint = await resolvePartyHint(baseInput());

    expect(hint).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ transcriptId: 'tr1', error: 'db down' }),
      'Transcript party hint lookup failed — continuing without a hint'
    );
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('log hygiene: no info/warn call carries a presence user or guest id', async () => {
    const waiting = expertWaitingInput();
    db.findByTranscriptJobId.mockResolvedValue(waiting.recording);
    db.listByMeeting.mockResolvedValue(waiting.presence);

    await resolvePartyHint(baseInput());

    // A paired existence assertion: without it, a refactor that stopped logging entirely (or
    // logged through a differently-named logger) would leave `json` as `'[]'` and the two
    // `not.toContain` checks below would pass vacuously.
    expect(logger.info).toHaveBeenCalledTimes(1);
    const json = JSON.stringify([...logger.info.mock.calls, ...logger.warn.mock.calls]);
    expect(json).not.toContain(EXPERT_USER_ID);
    expect(json).not.toContain(CLIENT_USER_ID);
  });
});
