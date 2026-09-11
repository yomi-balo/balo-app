import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/utils';
import { HealthRow } from './health-row';
import type { CaptureHealthRowView } from '../_lib/capture-health-view';

function baseRow(overrides: Partial<CaptureHealthRowView> = {}): CaptureHealthRowView {
  return {
    meetingId: '11111111-1111-4111-8111-111111111111',
    title: 'Consultation 28 Aug 2026',
    parties: 'Bright Foods × Aisha Bello',
    when: '28 Aug',
    durationLabel: '42 min',
    contextLabel: 'case',
    recording: { state: 'ready' },
    transcription: { state: 'finished' },
    recap: { state: 'ready' },
    category: 'healthy',
    action: { kind: 'none' },
    ...overrides,
  };
}

describe('HealthRow', () => {
  it('renders the party line, when/duration/context, and the three ladders', () => {
    render(<HealthRow row={baseRow()} index={0} last canRedrive={true} onRedrive={vi.fn()} />);
    expect(screen.getByText('Bright Foods × Aisha Bello')).toBeInTheDocument();
    expect(screen.getByText(/28 Aug · 42 min · case/)).toBeInTheDocument();
    expect(screen.getByText('Playable')).toBeInTheDocument();
    expect(screen.getByText('Transcribed')).toBeInTheDocument();
    expect(screen.getByText('Ready')).toBeInTheDocument();
  });

  it('a recording-ingest action shows an enabled re-drive button when canRedrive', () => {
    const onRedrive = vi.fn();
    render(
      <HealthRow
        row={baseRow({
          category: 'recording',
          recording: { state: 'failed', note: 'boom' },
          action: {
            kind: 'recording-ingest',
            recordingId: 'rec-1',
            segmentLabel: 'Segment 1 of 1',
          },
        })}
        index={0}
        last
        canRedrive={true}
        onRedrive={onRedrive}
      />
    );
    const button = screen.getByRole('button', { name: /Re-drive ingest/ });
    expect(button).toBeEnabled();
    button.click();
    expect(onRedrive).toHaveBeenCalledTimes(1);
  });

  it('canRedrive: false ⇒ disabled button, "Needs an engineer", a title naming REDRIVE_JOB', () => {
    render(
      <HealthRow
        row={baseRow({
          category: 'recording',
          recording: { state: 'failed' },
          action: {
            kind: 'recording-ingest',
            recordingId: 'rec-1',
            segmentLabel: 'Segment 1 of 1',
          },
        })}
        index={0}
        last
        canRedrive={false}
        onRedrive={vi.fn()}
      />
    );
    const button = screen.getByRole('button', { name: /Re-drive ingest/ });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title', 'Re-drive needs an engineer (REDRIVE_JOB)');
    expect(screen.getByText('Needs an engineer')).toBeInTheDocument();
  });

  it('an unrecoverable note renders no button at all', () => {
    render(
      <HealthRow
        row={baseRow({
          category: 'recording',
          recording: { state: 'failed' },
          action: { kind: 'note', note: 'Not recoverable — Daily never produced a source.' },
        })}
        index={0}
        last
        canRedrive={true}
        onRedrive={vi.fn()}
      />
    );
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByText(/Not recoverable/)).toBeInTheDocument();
  });

  it('a transcript-pipeline action shows an enabled "Re-run recap" button when canRedrive', () => {
    const onRedrive = vi.fn();
    const row = baseRow({
      category: 'recap',
      recap: { state: 'failed', stage: 'summarize' },
      action: { kind: 'transcript-pipeline', transcriptId: 'tr-1' },
    });
    render(<HealthRow row={row} index={0} last canRedrive={true} onRedrive={onRedrive} />);
    const button = screen.getByRole('button', { name: /Re-run recap/ });
    expect(button).toBeEnabled();
    button.click();
    expect(onRedrive).toHaveBeenCalledTimes(1);
    expect(onRedrive).toHaveBeenCalledWith(row);
  });

  it('a transcript-pipeline action: canRedrive false ⇒ disabled button, "Needs an engineer"', () => {
    render(
      <HealthRow
        row={baseRow({
          category: 'recap',
          recap: { state: 'failed', stage: 'summarize' },
          action: { kind: 'transcript-pipeline', transcriptId: 'tr-1' },
        })}
        index={0}
        last
        canRedrive={false}
        onRedrive={vi.fn()}
      />
    );
    const button = screen.getByRole('button', { name: /Re-run recap/ });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title', 'Re-drive needs an engineer (REDRIVE_JOB)');
    expect(screen.getByText('Needs an engineer')).toBeInTheDocument();
  });

  /**
   * ⚠⚠ THE PARTIAL RECAP IS THE MOST LOAD-BEARING ASSERTION IN THIS SUITE. It must never render
   * as "Failed", and it must offer NO re-drive button.
   */
  it('a PARTIAL recap renders its warm label, never "Failed", and offers no re-drive button', () => {
    render(
      <HealthRow
        row={baseRow({
          category: 'recap',
          recap: { state: 'partial', stage: 'extract_action_items' },
          action: { kind: 'none' },
        })}
        index={0}
        last
        canRedrive={true}
        onRedrive={vi.fn()}
      />
    );
    expect(screen.getByText('Ready · action items skipped')).toBeInTheDocument();
    expect(screen.queryByText('Failed')).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
