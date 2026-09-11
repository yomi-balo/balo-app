import { describe, it, expect } from 'vitest';
import {
  buildCaptureHealthRow,
  REDRIVE_NOTE,
  type CaptureHealthRowInput,
  type CaptureHealthRowDetails,
  type CaptureHealthRowView,
  type CaptureHealthRecordingDetailInput,
} from './capture-health-view';

const NOW = new Date('2026-09-11T12:00:00.000Z');
const MEETING_ID = '11111111-1111-4111-8111-111111111111';

function baseRow(overrides: Partial<CaptureHealthRowInput> = {}): CaptureHealthRowInput {
  return {
    meetingId: MEETING_ID,
    scheduledStart: new Date('2026-08-28T14:00:00.000Z'),
    scheduledEnd: new Date('2026-08-28T14:42:00.000Z'),
    startedAt: new Date('2026-08-28T14:00:00.000Z'),
    endedAt: new Date('2026-08-28T14:42:00.000Z'),
    facts: {
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
    },
    ...overrides,
  };
}

function baseDetails(overrides: Partial<CaptureHealthRowDetails> = {}): CaptureHealthRowDetails {
  return {
    recordings: [],
    recap: undefined,
    recapFailed: undefined,
    expert: { firstName: 'Aisha', lastName: 'Bello', agencyName: null },
    party: { contextType: 'case', companyName: 'Bright Foods' },
    ...overrides,
  };
}

/** No `$`/`A$`/`fee`/`margin`/`markup` text is producible from any fixture, and the row type
 *  itself has no money-shaped field — the money-less proof §10.7 requires. */
describe('buildCaptureHealthRow — money-less', () => {
  it('produces no money-shaped text across a spread of fixtures', () => {
    const fixtures: CaptureHealthRowView[] = [
      buildCaptureHealthRow(baseRow(), baseDetails(), { now: NOW }),
      buildCaptureHealthRow(
        baseRow({
          facts: {
            ...baseRow().facts,
            recording: { ...baseRow().facts.recording, anyFailed: true, anyReady: false },
          },
        }),
        baseDetails({ recordings: [failedRecording()] }),
        { now: NOW }
      ),
    ];
    const serialized = JSON.stringify(fixtures);
    for (const forbidden of ['$', 'A$', 'fee', 'margin', 'markup']) {
      expect(serialized.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });

  it('CaptureHealthRowView has no money-shaped field (module-level structural proof)', () => {
    const view = buildCaptureHealthRow(baseRow(), baseDetails(), { now: NOW });
    const keys = Object.keys(view);
    for (const forbidden of ['amount', 'fee', 'margin', 'markup', 'price', 'cost']) {
      expect(keys.some((k) => k.toLowerCase().includes(forbidden))).toBe(false);
    }
  });
});

function failedRecording(
  overrides: Partial<CaptureHealthRecordingDetailInput> = {}
): CaptureHealthRecordingDetailInput {
  return {
    id: 'rec-1',
    status: 'failed',
    failedStage: 'mux_ingest',
    failureReason: 'Mux asset errored',
    dailyRecordingId: 'daily-1',
    sourceDeletedAt: null,
    transcriptJobSubmittedAt: null,
    transcriptJobFinishedAt: null,
    transcriptJobFailureReason: null,
    createdAt: new Date('2026-08-28T14:00:00.000Z'),
    ...overrides,
  };
}

describe('buildCaptureHealthRow — ladders and category', () => {
  it('a healthy row categorises as healthy, offers no action', () => {
    const view = buildCaptureHealthRow(baseRow(), baseDetails(), { now: NOW });
    expect(view.category).toBe('healthy');
    expect(view.recording.state).toBe('ready');
    expect(view.transcription.state).toBe('finished');
    expect(view.recap.state).toBe('ready');
    expect(view.action).toEqual({ kind: 'none' });
  });

  it('a redrivable failed recording offers the recording-ingest action, targeting the oldest qualifying segment', () => {
    const row = baseRow({
      facts: {
        ...baseRow().facts,
        recording: {
          segmentCount: 1,
          anyFailed: true,
          anySourceReady: false,
          anyIngesting: false,
          anyCapturing: false,
          anyReady: false,
          anyRedrivableFailure: true,
        },
      },
    });
    const details = baseDetails({ recordings: [failedRecording()] });
    const view = buildCaptureHealthRow(row, details, { now: NOW });

    expect(view.category).toBe('recording');
    expect(view.recording.state).toBe('failed');
    expect(view.recording.note).toBe('Mux asset errored');
    expect(view.action).toEqual({
      kind: 'recording-ingest',
      recordingId: 'rec-1',
      segmentLabel: 'Segment 1 of 1',
    });
  });

  it('a NON-redrivable failed recording (no Daily source) offers the unrecoverable note, no button', () => {
    const row = baseRow({
      facts: {
        ...baseRow().facts,
        recording: {
          segmentCount: 1,
          anyFailed: true,
          anySourceReady: false,
          anyIngesting: false,
          anyCapturing: false,
          anyReady: false,
          anyRedrivableFailure: false,
        },
      },
    });
    const details = baseDetails({
      recordings: [failedRecording({ dailyRecordingId: null })],
    });
    const view = buildCaptureHealthRow(row, details, { now: NOW });

    expect(view.category).toBe('recording');
    expect(view.action).toEqual({ kind: 'note', note: REDRIVE_NOTE.unrecoverable });
  });

  it('a withheld transcription offers the waiting-daily note with the submitted age', () => {
    const row = baseRow({
      facts: {
        ...baseRow().facts,
        transcription: {
          anyFailure: false,
          anySubmitted: true,
          anyOpen: true,
          anyWithheld: true,
          anyFinished: false,
        },
      },
    });
    const details = baseDetails({
      recordings: [
        {
          id: 'rec-1',
          status: 'ready',
          failedStage: null,
          failureReason: null,
          dailyRecordingId: 'daily-1',
          sourceDeletedAt: null,
          transcriptJobSubmittedAt: new Date('2026-09-08T12:00:00.000Z'), // 3 days before NOW
          transcriptJobFinishedAt: null,
          transcriptJobFailureReason: null,
          createdAt: new Date('2026-08-28T14:00:00.000Z'),
        },
      ],
    });
    const view = buildCaptureHealthRow(row, details, { now: NOW });

    expect(view.category).toBe('transcription');
    expect(view.transcription.state).toBe('withheld');
    expect(view.transcription.note).toBe('Submitted 3d ago · no webhook yet');
    expect(view.action).toEqual({ kind: 'note', note: REDRIVE_NOTE['waiting-daily'] });
  });

  /**
   * ⚠ THE AGE NAMES THE OLDEST OPEN SEGMENT. `recordings` arrives in `created_at` order, which
   * need not agree with submission order, so the first OPEN segment is not necessarily the
   * WITHHELD one — and reporting the wrong one always UNDER-reports the wait.
   */
  it('the withheld age names the oldest open job, not the first segment in created_at order', () => {
    const row = baseRow({
      facts: {
        ...baseRow().facts,
        transcription: {
          anyFailure: false,
          anySubmitted: true,
          anyOpen: true,
          anyWithheld: true,
          anyFinished: false,
        },
      },
    });
    const openSegment = (
      id: string,
      createdAt: string,
      submittedAt: string
    ): CaptureHealthRecordingDetailInput => ({
      id,
      status: 'ready',
      failedStage: null,
      failureReason: null,
      dailyRecordingId: 'daily-1',
      sourceDeletedAt: null,
      transcriptJobSubmittedAt: new Date(submittedAt),
      transcriptJobFinishedAt: null,
      transcriptJobFailureReason: null,
      createdAt: new Date(createdAt),
    });
    const details = baseDetails({
      recordings: [
        // Created FIRST, submitted LAST (a re-submission after the second segment's).
        openSegment('rec-1', '2026-08-28T14:00:00.000Z', '2026-09-11T02:00:00.000Z'),
        // Created second, submitted 5 days ago — the genuinely withheld one.
        openSegment('rec-2', '2026-08-28T15:00:00.000Z', '2026-09-06T12:00:00.000Z'),
      ],
    });
    const view = buildCaptureHealthRow(row, details, { now: NOW });

    expect(view.transcription.note).toBe('Submitted 5d ago · no webhook yet');
    expect(view.transcription.note).not.toBe('Submitted 10h ago · no webhook yet');
  });

  it('a failed recap offers the transcript-pipeline action on the newest live failed transcript', () => {
    const row = baseRow({
      facts: {
        ...baseRow().facts,
        recap: {
          transcriptCount: 1,
          anyFailed: true,
          anyPartial: false,
          anyProcessing: false,
          anyReady: false,
        },
      },
    });
    const failed = { id: 'tr-1', status: 'failed', failedStage: 'summarize_extract' };
    const details = baseDetails({ recap: failed, recapFailed: failed });
    const view = buildCaptureHealthRow(row, details, { now: NOW });

    expect(view.category).toBe('recap');
    expect(view.recap.state).toBe('failed');
    expect(view.recap.stage).toBe('summarize_extract');
    expect(view.action).toEqual({ kind: 'transcript-pipeline', transcriptId: 'tr-1' });
  });

  /**
   * ⚠⚠ THE ACTION TARGETS THE FAILED TRANSCRIPT, NOT THE NEWEST ONE. The recap ladder is an
   * AGGREGATE over every live transcript of the meeting, so an older `failed` row and a newer
   * `ready` row render `failed` while the newest-of-any-status detail names the `ready` one.
   * Handing that id to `claimRecapResume` would be refused by its CAS — a guaranteed
   * `409 not_redrivable` on every click.
   */
  it('with an older failed and a newer ready transcript, the action targets the FAILED one', () => {
    const row = baseRow({
      facts: {
        ...baseRow().facts,
        recap: {
          transcriptCount: 2,
          anyFailed: true,
          anyPartial: false,
          anyProcessing: false,
          anyReady: true,
        },
      },
    });
    const details = baseDetails({
      // newest live, ANY status
      recap: { id: 'tr-newest-ready', status: 'ready', failedStage: null },
      // newest live FAILED — the only row the CAS can claim, and the one the chip narrates
      recapFailed: { id: 'tr-older-failed', status: 'failed', failedStage: 'summarize_extract' },
    });
    const view = buildCaptureHealthRow(row, details, { now: NOW });

    expect(view.recap.state).toBe('failed');
    expect(view.action).toEqual({ kind: 'transcript-pipeline', transcriptId: 'tr-older-failed' });
  });

  /**
   * The chip's STAGE has the same two-rows hazard the action above does. Here the newest live
   * transcript is a PARTIAL (`ready` WITH a `failed_stage`), so reading the stage off it would
   * make the `failed` chip read "Failed · extract_action_items" — naming a stage that belongs to
   * a different, successful-but-skipped transcript rather than to the failure the chip describes.
   */
  it('the failed chip narrates the FAILED transcript stage, not a newer partial one', () => {
    const row = baseRow({
      facts: {
        ...baseRow().facts,
        recap: {
          transcriptCount: 2,
          anyFailed: true,
          anyPartial: true,
          anyProcessing: false,
          anyReady: true,
        },
      },
    });
    const details = baseDetails({
      recap: { id: 'tr-newest-partial', status: 'ready', failedStage: 'extract_action_items' },
      recapFailed: { id: 'tr-older-failed', status: 'failed', failedStage: 'summarize_extract' },
    });
    const view = buildCaptureHealthRow(row, details, { now: NOW });

    expect(view.recap.state).toBe('failed');
    expect(view.recap.stage).toBe('summarize_extract');
    expect(view.recap.stage).not.toBe('extract_action_items');
  });

  it('a failed recap with NO claimable transcript explains itself instead of a blank cell', () => {
    const row = baseRow({
      facts: {
        ...baseRow().facts,
        recap: {
          transcriptCount: 1,
          anyFailed: true,
          anyPartial: false,
          anyProcessing: false,
          anyReady: false,
        },
      },
    });
    const details = baseDetails({
      recap: { id: 'tr-1', status: 'processing', failedStage: null },
      recapFailed: undefined,
    });
    const view = buildCaptureHealthRow(row, details, { now: NOW });

    expect(view.recap.state).toBe('failed');
    expect(view.action).toEqual({ kind: 'note', note: REDRIVE_NOTE['recap-unclaimable'] });
    // Never a blank cell beside a Failed chip.
    expect(view.action.kind).not.toBe('none');
  });

  /**
   * ⚠⚠ THE PARTIAL RECAP IS NEVER RENDERED AS FAILED AND OFFERS NO RE-DRIVE (D8/design `h-svc`
   * fixture). This is the single most load-bearing branch in this module.
   */
  it('a PARTIAL recap renders its own state (never failed) and offers NO action', () => {
    const row = baseRow({
      facts: {
        ...baseRow().facts,
        recap: {
          transcriptCount: 1,
          anyFailed: false,
          anyPartial: true,
          anyProcessing: false,
          anyReady: false,
        },
      },
    });
    const details = baseDetails({
      recap: { id: 'tr-1', status: 'ready', failedStage: 'extract_action_items' },
    });
    const view = buildCaptureHealthRow(row, details, { now: NOW });

    expect(view.category).toBe('recap');
    expect(view.recap.state).toBe('partial');
    expect(view.recap.state).not.toBe('failed');
    expect(view.recap.stage).toBe('extract_action_items');
    expect(view.action).toEqual({ kind: 'none' });
  });

  it('parties label: agency expert gets "@ Agency", independent stays bare, missing party falls back', () => {
    const withAgency = buildCaptureHealthRow(
      baseRow(),
      baseDetails({ expert: { firstName: 'Aisha', lastName: 'Bello', agencyName: 'CloudPeak' } }),
      { now: NOW }
    );
    expect(withAgency.parties).toBe('Bright Foods × Aisha Bello @ CloudPeak');

    const independent = buildCaptureHealthRow(baseRow(), baseDetails(), { now: NOW });
    expect(independent.parties).toBe('Bright Foods × Aisha Bello');

    const noExpert = buildCaptureHealthRow(
      baseRow(),
      baseDetails({
        expert: undefined,
        party: { contextType: 'project_discovery', companyName: null },
      }),
      { now: NOW }
    );
    expect(noExpert.parties).toBe('no client company × expert unavailable');
  });

  it('duration prefers actual started/ended over scheduled', () => {
    const view = buildCaptureHealthRow(
      baseRow({
        startedAt: new Date('2026-08-28T14:00:00.000Z'),
        endedAt: new Date('2026-08-28T14:20:00.000Z'),
        scheduledStart: new Date('2026-08-28T14:00:00.000Z'),
        scheduledEnd: new Date('2026-08-28T14:42:00.000Z'),
      }),
      baseDetails(),
      { now: NOW }
    );
    expect(view.durationLabel).toBe('20 min');
  });

  it('duration falls back to scheduled when actual is absent', () => {
    const view = buildCaptureHealthRow(baseRow({ startedAt: null, endedAt: null }), baseDetails(), {
      now: NOW,
    });
    expect(view.durationLabel).toBe('42 min');
  });

  it('title reuses the Consultation-{date} derivation', () => {
    const view = buildCaptureHealthRow(baseRow(), baseDetails(), { now: NOW });
    expect(view.title).toBe('Consultation 28 Aug 2026');
    expect(view.when).toBe('28 Aug');
  });

  it('context label humanizes the underscore-separated context type', () => {
    const view = buildCaptureHealthRow(
      baseRow(),
      baseDetails({ party: { contextType: 'project_kickoff', companyName: 'Northwind' } }),
      { now: NOW }
    );
    expect(view.contextLabel).toBe('project kickoff');
  });
});
