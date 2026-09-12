import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { track, ADMIN_CAPTURE_HEALTH_EVENTS } from '@/lib/analytics';
import { HealthList } from './health-list';
import type { CaptureHealthRowView } from '../_lib/capture-health-view';

const { mockLoadMore, mockRequestRedrive } = vi.hoisted(() => ({
  mockLoadMore: vi.fn(),
  mockRequestRedrive: vi.fn(),
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../_actions/load-more-capture-health', () => ({
  loadMoreCaptureHealth: mockLoadMore,
}));
vi.mock('../_actions/request-redrive', () => ({ requestRedrive: mockRequestRedrive }));

function row(overrides: Partial<CaptureHealthRowView> = {}): CaptureHealthRowView {
  return {
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
    ...overrides,
  };
}

const CURSOR = { healthRank: 0, scheduledStartIso: '2026-08-28T14:00:00.000Z', meetingId: 'm-1' };

describe('HealthList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the initial rows and shows Load more when hasMore is true', () => {
    render(
      <HealthList
        initialRows={[row()]}
        initialHasMore={true}
        initialCursor={CURSOR}
        fromIso="2026-08-01"
        toIso="2026-08-31"
        category={null}
        withheldBeforeIso="2026-09-10T00:00:00.000Z"
        canRedrive={true}
        actorLabel="Dana"
      />
    );
    expect(screen.getByText('Consultation 28 Aug 2026')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Load more/ })).toBeInTheDocument();
  });

  it('omits Load more when there is no more', () => {
    render(
      <HealthList
        initialRows={[row()]}
        initialHasMore={false}
        initialCursor={null}
        fromIso="2026-08-01"
        toIso="2026-08-31"
        category={null}
        withheldBeforeIso="2026-09-10T00:00:00.000Z"
        canRedrive={true}
        actorLabel="Dana"
      />
    );
    expect(screen.queryByRole('button', { name: /Load more/ })).not.toBeInTheDocument();
  });

  it('Load more appends rows and updates the cursor', async () => {
    mockLoadMore.mockResolvedValue({
      success: true,
      rows: [row({ meetingId: '22222222-2222-4222-8222-222222222222', title: 'Second row' })],
      hasMore: false,
      nextCursor: null,
    });
    const user = userEvent.setup();
    render(
      <HealthList
        initialRows={[row()]}
        initialHasMore={true}
        initialCursor={CURSOR}
        fromIso="2026-08-01"
        toIso="2026-08-31"
        category={null}
        withheldBeforeIso="2026-09-10T00:00:00.000Z"
        canRedrive={true}
        actorLabel="Dana"
      />
    );

    await user.click(screen.getByRole('button', { name: /Load more/ }));

    await waitFor(() => expect(screen.getByText('Second row')).toBeInTheDocument());
    expect(mockLoadMore).toHaveBeenCalledWith({
      cursor: CURSOR,
      fromIso: '2026-08-01',
      toIso: '2026-08-31',
      category: null,
      withheldBeforeIso: '2026-09-10T00:00:00.000Z',
    });
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /Load more/ })).not.toBeInTheDocument()
    );
  });

  it('clicking a re-drive button opens the confirm sheet, and confirming fires the analytic exactly once on success', async () => {
    mockRequestRedrive.mockResolvedValue({
      success: true,
      jobId: 'recording-ingest--rec-1--redrive-audit-1',
    });
    const user = userEvent.setup();
    render(
      <HealthList
        initialRows={[row()]}
        initialHasMore={false}
        initialCursor={null}
        fromIso="2026-08-01"
        toIso="2026-08-31"
        category={null}
        withheldBeforeIso="2026-09-10T00:00:00.000Z"
        canRedrive={true}
        actorLabel="Dana"
      />
    );

    await user.click(screen.getByRole('button', { name: /Re-drive ingest/ }));
    expect(screen.getByText('Re-drive the recording ingest?')).toBeInTheDocument();

    const dialog = screen.getByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: /Re-drive ingest/ }));

    await waitFor(() => expect(mockRequestRedrive).toHaveBeenCalledTimes(1));
    expect(mockRequestRedrive).toHaveBeenCalledWith({
      kind: 'recording-ingest',
      entityId: 'rec-1',
    });
    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1));
    expect(track).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledWith(ADMIN_CAPTURE_HEALTH_EVENTS.REDRIVE_REQUESTED, {
      kind: 'recording-ingest',
      outcome: 'queued',
    });
  });

  it('a refused re-drive shows the error toast and fires the analytic with outcome "refused"', async () => {
    mockRequestRedrive.mockResolvedValue({
      success: false,
      reason: 'not_redrivable',
      error: 'This row already moved.',
    });
    const user = userEvent.setup();
    render(
      <HealthList
        initialRows={[row()]}
        initialHasMore={false}
        initialCursor={null}
        fromIso="2026-08-01"
        toIso="2026-08-31"
        category={null}
        withheldBeforeIso="2026-09-10T00:00:00.000Z"
        canRedrive={true}
        actorLabel="Dana"
      />
    );

    await user.click(screen.getByRole('button', { name: /Re-drive ingest/ }));
    const dialog = screen.getByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: /Re-drive ingest/ }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('This row already moved.'));
    expect(track).toHaveBeenCalledWith(ADMIN_CAPTURE_HEALTH_EVENTS.REDRIVE_REQUESTED, {
      kind: 'recording-ingest',
      outcome: 'refused',
    });
  });
});
