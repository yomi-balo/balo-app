import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/utils';
import { RedriveSheet, type RedriveTarget } from './redrive-sheet';
import type { CaptureHealthRowView } from '../_lib/capture-health-view';

const ROW: CaptureHealthRowView = {
  meetingId: '11111111-1111-4111-8111-111111111111',
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
};

describe('RedriveSheet', () => {
  it('closed when target is null', () => {
    render(
      <RedriveSheet
        target={null}
        actorLabel="Dana @ Balo"
        pending={false}
        onConfirm={vi.fn()}
        onOpenChange={vi.fn()}
      />
    );
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('the recording-ingest sheet states what is reset, the exact jobId shape, and the acting admin', () => {
    const target: RedriveTarget = {
      kind: 'recording-ingest',
      row: ROW,
      recordingId: 'rec-1',
      segmentLabel: 'Segment 1 of 1',
    };
    render(
      <RedriveSheet
        target={target}
        actorLabel="Dana"
        pending={false}
        onConfirm={vi.fn()}
        onOpenChange={vi.fn()}
      />
    );
    expect(screen.getByText('Re-drive the recording ingest?')).toBeInTheDocument();
    expect(screen.getByText(/source_ready/)).toBeInTheDocument();
    expect(screen.getByText(/recording-ingest--rec-1--redrive-<auditId>/)).toBeInTheDocument();
    expect(screen.getByText(/admin\.redrive\.recording-ingest by Dana @ Balo/)).toBeInTheDocument();
  });

  it('the transcript-pipeline sheet says nothing already done is redone, and adds the D5b processing sentence', () => {
    const target: RedriveTarget = {
      kind: 'transcript-pipeline',
      row: ROW,
      transcriptId: 'tr-1',
    };
    render(
      <RedriveSheet
        target={target}
        actorLabel="Dana"
        pending={false}
        onConfirm={vi.fn()}
        onOpenChange={vi.fn()}
      />
    );
    expect(screen.getByText('Re-run the recap pipeline?')).toBeInTheDocument();
    expect(screen.getByText(/Nothing is reset/)).toBeInTheDocument();
    expect(screen.getByText(/transcript-pipeline--tr-1--redrive-<auditId>/)).toBeInTheDocument();
    expect(screen.getByText(/The recap returns to processing while it runs/)).toBeInTheDocument();
  });

  it('confirm fires onConfirm exactly once', async () => {
    const onConfirm = vi.fn();
    const target: RedriveTarget = {
      kind: 'recording-ingest',
      row: ROW,
      recordingId: 'rec-1',
      segmentLabel: 'Segment 1 of 1',
    };
    render(
      <RedriveSheet
        target={target}
        actorLabel="Dana"
        pending={false}
        onConfirm={onConfirm}
        onOpenChange={vi.fn()}
      />
    );
    screen.getByRole('button', { name: /Re-drive ingest/ }).click();
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('shows the pending state and disables both actions while re-driving', () => {
    const target: RedriveTarget = {
      kind: 'recording-ingest',
      row: ROW,
      recordingId: 'rec-1',
      segmentLabel: 'Segment 1 of 1',
    };
    render(
      <RedriveSheet
        target={target}
        actorLabel="Dana"
        pending={true}
        onConfirm={vi.fn()}
        onOpenChange={vi.fn()}
      />
    );
    expect(screen.getByText('Re-driving…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Cancel/ })).toBeDisabled();
  });
});
