import { describe, it, expect } from 'vitest';
import {
  CAPTURE_HEALTH_RANK,
  captureHealthRankOf,
  deriveCaptureHealthCategory,
  deriveRecapLadder,
  deriveRecordingLadder,
  deriveTranscriptionLadder,
  type CaptureHealthFacts,
} from './index';

/**
 * BAL-550 — the shared derivation, tested as pure functions.
 *
 * ⚠ THIS IS ONLY HALF THE GUARANTEE. It pins what the BROWSER renders. The other half —
 * that the SQL `CASE` in `packages/db/src/repositories/capture-health.ts` produces the SAME
 * category for the same row — is pinned in `capture-health.integration.test.ts`, against real
 * Postgres, over every ladder combination. Neither file can hold both.
 */

/** A HEALTHY meeting: one ready segment, a finished batch job, a published recap. */
function facts(
  overrides: {
    recording?: Partial<CaptureHealthFacts['recording']>;
    transcription?: Partial<CaptureHealthFacts['transcription']>;
    recap?: Partial<CaptureHealthFacts['recap']>;
    hasEngagementContext?: boolean;
  } = {}
): CaptureHealthFacts {
  return {
    recording: {
      segmentCount: 1,
      anyFailed: false,
      anySourceReady: false,
      anyIngesting: false,
      anyCapturing: false,
      anyReady: true,
      anyRedrivableFailure: false,
      ...overrides.recording,
    },
    transcription: {
      anyFailure: false,
      anySubmitted: true,
      anyOpen: false,
      anyWithheld: false,
      anyFinished: true,
      ...overrides.transcription,
    },
    recap: {
      transcriptCount: 1,
      anyFailed: false,
      anyPartial: false,
      anyProcessing: false,
      anyReady: true,
      ...overrides.recap,
    },
    hasEngagementContext: overrides.hasEngagementContext ?? true,
  };
}

describe('deriveRecordingLadder — worst state dominates', () => {
  it('ranks failed → source_ready → capturing → ingesting → ready, lowest present wins', () => {
    // All five true at once: `failed` must win, because only it is terminal.
    expect(
      deriveRecordingLadder(
        facts({
          recording: {
            anyFailed: true,
            anySourceReady: true,
            anyCapturing: true,
            anyIngesting: true,
            anyReady: true,
          },
        })
      )
    ).toBe('failed');
    expect(
      deriveRecordingLadder(
        facts({
          recording: { anySourceReady: true, anyCapturing: true, anyIngesting: true },
        })
      )
    ).toBe('source_ready');
    // `capturing` outranks `ingesting`: a stuck capture has nobody driving it, while an
    // ingest is a vendor callback genuinely in flight.
    expect(
      deriveRecordingLadder(facts({ recording: { anyCapturing: true, anyIngesting: true } }))
    ).toBe('capturing');
    expect(deriveRecordingLadder(facts({ recording: { anyIngesting: true } }))).toBe('ingesting');
    expect(deriveRecordingLadder(facts())).toBe('ready');
  });
});

describe('deriveTranscriptionLadder — first match wins', () => {
  it('a job failure beats everything, including a withheld source', () => {
    expect(
      deriveTranscriptionLadder(
        facts({ transcription: { anyFailure: true, anyWithheld: true, anyOpen: true } })
      )
    ).toBe('failed');
  });

  it('a withheld source (open past the threshold) beats a merely open one', () => {
    expect(
      deriveTranscriptionLadder(facts({ transcription: { anyOpen: true, anyWithheld: true } }))
    ).toBe('withheld');
    expect(
      deriveTranscriptionLadder(facts({ transcription: { anyOpen: true, anyFinished: false } }))
    ).toBe('submitted');
    expect(deriveTranscriptionLadder(facts())).toBe('finished');
  });

  it('`na` when nothing was ever going to transcribe: no engagement, or no submission', () => {
    // A match-routed discovery / an `admin` meeting: BAL-387's pipeline is engagement-anchored.
    expect(
      deriveTranscriptionLadder(
        facts({
          hasEngagementContext: false,
          transcription: { anySubmitted: false, anyFinished: false },
        })
      )
    ).toBe('na');
    // The source is ready and no batch job was ever submitted — capture is opt-in.
    expect(
      deriveTranscriptionLadder(
        facts({ transcription: { anySubmitted: false, anyFinished: false } })
      )
    ).toBe('na');
  });

  it('`none` when the recording itself failed — there is no source to transcribe', () => {
    expect(
      deriveTranscriptionLadder(
        facts({
          recording: { anyFailed: true, anyReady: false },
          transcription: { anySubmitted: false, anyFinished: false },
        })
      )
    ).toBe('none');
  });

  it('`pending` while the capture is still in flight', () => {
    expect(
      deriveTranscriptionLadder(
        facts({
          recording: { anyReady: false, anyCapturing: true },
          transcription: { anySubmitted: false, anyFinished: false },
        })
      )
    ).toBe('pending');
  });
});

describe('deriveRecapLadder — `partial` is its own branch, never `failed`', () => {
  it('a partial recap (ready + a recorded stage skip) is NOT a failure', () => {
    expect(deriveRecapLadder(facts({ recap: { anyPartial: true, anyReady: false } }))).toBe(
      'partial'
    );
  });

  it('when BOTH are true across two transcript rows, `failed` legitimately wins', () => {
    // The two predicates are DISJOINT per row (`status='failed'` vs `status='ready'`), so this
    // state is reachable only with two rows — and the worse one must dominate.
    expect(
      deriveRecapLadder(facts({ recap: { anyFailed: true, anyPartial: true, anyReady: false } }))
    ).toBe('failed');
  });

  it('processing, ready, na and none', () => {
    expect(deriveRecapLadder(facts({ recap: { anyProcessing: true, anyReady: false } }))).toBe(
      'processing'
    );
    expect(deriveRecapLadder(facts())).toBe('ready');
    // `na` is inherited from the transcription ladder — nothing was ever going to run.
    expect(
      deriveRecapLadder(
        facts({
          hasEngagementContext: false,
          transcription: { anySubmitted: false, anyFinished: false },
          recap: { transcriptCount: 0, anyReady: false },
        })
      )
    ).toBe('na');
    // Transcription finished but no transcript row landed — genuinely missing, not `na`.
    expect(deriveRecapLadder(facts({ recap: { transcriptCount: 0, anyReady: false } }))).toBe(
      'none'
    );
  });
});

describe('deriveCaptureHealthCategory — the tile precedence', () => {
  it('recording beats transcription beats recap beats healthy', () => {
    expect(
      deriveCaptureHealthCategory(
        facts({
          recording: { anyFailed: true },
          transcription: { anyFailure: true },
          recap: { anyFailed: true },
        })
      )
    ).toBe('recording');
    expect(
      deriveCaptureHealthCategory(
        facts({ transcription: { anyFailure: true }, recap: { anyFailed: true } })
      )
    ).toBe('transcription');
    expect(
      deriveCaptureHealthCategory(facts({ transcription: { anyWithheld: true, anyOpen: true } }))
    ).toBe('transcription');
    expect(
      deriveCaptureHealthCategory(facts({ recap: { anyFailed: true, anyReady: false } }))
    ).toBe('recap');
    // ⚠ A PARTIAL RECAP IS A RECAP ISSUE (it counts toward the tile) but is never re-drivable
    // and is never rendered as a failure.
    expect(
      deriveCaptureHealthCategory(facts({ recap: { anyPartial: true, anyReady: false } }))
    ).toBe('recap');
    expect(deriveCaptureHealthCategory(facts())).toBe('healthy');
  });

  it('a transcription `na` is HEALTHY — an internal call is not a broken pipeline', () => {
    expect(
      deriveCaptureHealthCategory(
        facts({
          hasEngagementContext: false,
          transcription: { anySubmitted: false, anyFinished: false },
          recap: { transcriptCount: 0, anyReady: false },
        })
      )
    ).toBe('healthy');
  });

  it('captureHealthRankOf agrees with the ONE rank map', () => {
    expect(captureHealthRankOf(facts({ recording: { anyFailed: true } }))).toBe(
      CAPTURE_HEALTH_RANK.recording
    );
    expect(captureHealthRankOf(facts())).toBe(CAPTURE_HEALTH_RANK.healthy);
  });
});
