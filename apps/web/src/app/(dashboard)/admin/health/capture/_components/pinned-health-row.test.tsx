import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { PinnedHealthRow } from './pinned-health-row';
import type { CaptureHealthRowView } from '../_lib/capture-health-view';

const { mockRequestRedrive } = vi.hoisted(() => ({
  mockRequestRedrive: vi.fn(),
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../_actions/request-redrive', () => ({ requestRedrive: mockRequestRedrive }));

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

describe('PinnedHealthRow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the pinned row highlighted', () => {
    render(<PinnedHealthRow row={ROW} canRedrive={true} actorLabel="Dana" />);
    expect(screen.getByText('Consultation 28 Aug 2026')).toBeInTheDocument();
  });

  it('confirming a re-drive updates the pinned row in place (setCurrent) and shows the success toast', async () => {
    mockRequestRedrive.mockResolvedValue({
      success: true,
      jobId: 'recording-ingest--rec-1--redrive-audit-1',
    });
    const user = userEvent.setup();
    render(<PinnedHealthRow row={ROW} canRedrive={true} actorLabel="Dana" />);

    await user.click(screen.getByRole('button', { name: /Re-drive ingest/ }));
    const dialog = screen.getByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: /Re-drive ingest/ }));

    await waitFor(() => expect(mockRequestRedrive).toHaveBeenCalledTimes(1));
    expect(mockRequestRedrive).toHaveBeenCalledWith({
      kind: 'recording-ingest',
      entityId: 'rec-1',
    });
    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText('Re-driven just now')).toBeInTheDocument());
  });

  it('cancelling the sheet closes it without calling requestRedrive', async () => {
    const user = userEvent.setup();
    render(<PinnedHealthRow row={ROW} canRedrive={true} actorLabel="Dana" />);

    await user.click(screen.getByRole('button', { name: /Re-drive ingest/ }));
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();

    const dialog = screen.getByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: /Cancel/ }));

    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(mockRequestRedrive).not.toHaveBeenCalled();
  });
});
