import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { axe } from 'jest-axe';
import { dailySpies, dailyState, resetDailyMock } from '@/test/mocks/daily';
import { RECORDING_PILL_MESSAGE } from './meeting-notices';
import { RecordingIndicator } from './recording-indicator';

/**
 * BAL-473 (D1, D5, OD-9) — the in-call recording pill.
 *
 * ⚠⚠ THE LOAD-BEARING ASSERTION: `startRecording` / `stopRecording` are NEVER called from this
 * component. Recording starts/stops server-side, on the meeting's `in_progress` transition
 * (D1) — a client-initiated start/stop would contradict that the recorded window IS the
 * billable window.
 */

vi.mock('@daily-co/daily-react', async () => {
  const { dailyReactModuleMock } = await import('@/test/mocks/daily');
  return dailyReactModuleMock();
});

beforeEach(() => {
  resetDailyMock();
});

describe('RecordingIndicator', () => {
  it('renders the pill with RECORDING_PILL_MESSAGE when isRecording is true', () => {
    dailyState.isRecording = true;
    render(<RecordingIndicator />);

    expect(screen.getByText(RECORDING_PILL_MESSAGE)).toBeInTheDocument();
  });

  it('renders nothing when isRecording is false', () => {
    dailyState.isRecording = false;
    const { container } = render(<RecordingIndicator />);

    expect(container).toBeEmptyDOMElement();
  });

  it('⚠⚠ never calls startRecording, stopRecording, or updateRecording', () => {
    dailyState.isRecording = true;
    render(<RecordingIndicator />);

    expect(dailySpies.startRecording).not.toHaveBeenCalled();
    expect(dailySpies.stopRecording).not.toHaveBeenCalled();
    expect(dailySpies.updateRecording).not.toHaveBeenCalled();
  });

  it('renders as a neutral tone, not a warning', () => {
    dailyState.isRecording = true;
    const { container } = render(<RecordingIndicator />);

    // `MeetingPill`'s warning tone applies `bg-warning/15 text-warning`; the neutral tone does not.
    expect(container.innerHTML).not.toContain('bg-warning/15');
  });

  /**
   * ⚠⚠ FIX ROUND 1 (F15) — the pill is the "backstop" notice (plan §18 item 16) for a repeat
   * joiner who skips PreJoin; rendered with no visual differentiation from an ambient
   * "Change devices" hint, it was indistinguishable from routine chrome. A small filled dot is
   * what makes it catch a skimming eye — keep it, and keep it neutral/muted rather than the
   * warning tone's colour.
   */
  it('⚠⚠ renders a filled-dot glyph so it is not indistinguishable from an ambient device pill', () => {
    dailyState.isRecording = true;
    const { container } = render(<RecordingIndicator />);

    const dot = container.querySelector('svg');
    expect(dot).not.toBeNull();
    expect(dot).toHaveAttribute('aria-hidden', 'true');
    // Neutral/muted, never the warning tone's colour — no alarm red.
    expect(container.innerHTML).not.toContain('bg-warning/15');
  });

  it('has no accessibility violations while visible', async () => {
    dailyState.isRecording = true;
    const { container } = render(<RecordingIndicator />);

    expect(await axe(container)).toHaveNoViolations();
  });
});
