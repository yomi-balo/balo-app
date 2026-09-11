import { describe, it, expect } from 'vitest';
import type {
  RecapLadderState,
  RecordingLadderState,
  TranscriptionLadderState,
} from '@balo/shared/capture-health';
import { render, screen } from '@/test/utils';
import { LadderChip } from './ladder-chip';

describe('LadderChip', () => {
  it('renders the label for a known state', () => {
    render(<LadderChip ladder="rec" state={{ state: 'ready' }} />);
    expect(screen.getByText('Playable')).toBeInTheDocument();
  });

  it('renders the stage suffix when present', () => {
    render(<LadderChip ladder="recap" state={{ state: 'failed', stage: 'summarize_extract' }} />);
    expect(screen.getByText('· summarize_extract')).toBeInTheDocument();
  });

  it('renders the note line when present', () => {
    render(<LadderChip ladder="rec" state={{ state: 'failed', note: 'Mux asset errored' }} />);
    expect(screen.getByText('Mux asset errored')).toBeInTheDocument();
  });

  it('the partial recap renders its own warm label, never "Failed"', () => {
    render(<LadderChip ladder="recap" state={{ state: 'partial' }} />);
    expect(screen.getByText('Ready · action items skipped')).toBeInTheDocument();
    expect(screen.queryByText('Failed')).not.toBeInTheDocument();
  });

  it('a fifth recording state (capturing) renders without crashing', () => {
    render(<LadderChip ladder="rec" state={{ state: 'capturing' }} />);
    expect(screen.getByText('Capturing')).toBeInTheDocument();
  });

  // The chip's props are a DISCRIMINATED UNION over the canonical `@balo/shared/capture-health`
  // state unions, so an unmapped state is a compile error rather than a rendered `—`; there is
  // no runtime fallback left to test. What IS worth holding is that the tables cover every
  // label the shared unions declare — walked here, not asserted by eye.
  it('every canonical state of every ladder renders a label', () => {
    const cases: readonly [RecordingLadderState[], TranscriptionLadderState[], RecapLadderState[]] =
      [
        ['ready', 'failed', 'ingesting', 'source_ready', 'capturing'],
        ['finished', 'submitted', 'withheld', 'failed', 'pending', 'na', 'none'],
        ['ready', 'processing', 'failed', 'partial', 'none', 'na'],
      ];
    const [rec, tx, recap] = cases;

    for (const state of rec) {
      const { unmount } = render(<LadderChip ladder="rec" state={{ state }} />);
      expect(screen.queryByText('—')).not.toBeInTheDocument();
      unmount();
    }
    for (const state of tx) {
      const { unmount } = render(<LadderChip ladder="tx" state={{ state }} />);
      // `none` is the one label that IS an em dash, deliberately.
      if (state !== 'none') expect(screen.queryByText('—')).not.toBeInTheDocument();
      unmount();
    }
    for (const state of recap) {
      const { unmount } = render(<LadderChip ladder="recap" state={{ state }} />);
      if (state !== 'none') expect(screen.queryByText('—')).not.toBeInTheDocument();
      unmount();
    }
  });
});
