import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import type { LookupTimelineResult } from '@balo/shared/lookup';
import { LookupTimelineSection } from './lookup-timeline-section';

const { mockFetchLookupTimelineAction } = vi.hoisted(() => ({
  mockFetchLookupTimelineAction: vi.fn(),
}));

vi.mock('../_actions/fetch-lookup-timeline', () => ({
  fetchLookupTimelineAction: mockFetchLookupTimelineAction,
}));

const mockCaptureException = vi.fn();
vi.mock('@sentry/nextjs', () => ({
  captureException: (...a: unknown[]) => mockCaptureException(...a),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

function okResult(
  overrides: Partial<Extract<LookupTimelineResult, { ok: true }>> = {}
): LookupTimelineResult {
  return {
    ok: true,
    entries: [],
    hasEarlier: false,
    earlier: null,
    ...overrides,
  };
}

describe('LookupTimelineSection', () => {
  it('renders a loading skeleton then the rows once resolved', async () => {
    mockFetchLookupTimelineAction.mockResolvedValue(
      okResult({
        entries: [
          {
            id: 'r1',
            action: 'agency.created',
            summary: 'Agency created — MJ @ Balo',
            occurredAtIso: '2026-06-02T10:15:30.000Z',
            instantKey: '2026-06-02 10:15:30.000000+00',
          },
        ],
      })
    );

    render(<LookupTimelineSection entityType="agency" entityId="a1" labelled={false} />);
    // `getByRole` throws (never returns null) when nothing matches, so a `?? …` fallback here
    // was unreachable dead code (BAL-555 fix round F9).
    expect(screen.getByRole('status', { hidden: true })).toBeTruthy();

    await waitFor(() => expect(screen.getByText('Agency created — MJ @ Balo')).toBeInTheDocument());
    expect(screen.getByText('agency.created')).toBeInTheDocument();
  });

  it('the action renders in a font-mono element', async () => {
    mockFetchLookupTimelineAction.mockResolvedValue(
      okResult({
        entries: [
          {
            id: 'r1',
            action: 'agency.created',
            summary: 'Agency created',
            occurredAtIso: '2026-06-02T10:15:30.000Z',
            instantKey: '2026-06-02 10:15:30.000000+00',
          },
        ],
      })
    );
    render(<LookupTimelineSection entityType="agency" entityId="a1" labelled={false} />);
    const actionEl = await screen.findByText('agency.created');
    expect(actionEl.className).toContain('font-mono');
  });

  it('BAL-555 fix round F4 — the timestamp renders in a font-mono <time> element', async () => {
    mockFetchLookupTimelineAction.mockResolvedValue(
      okResult({
        entries: [
          {
            id: 'r1',
            action: 'agency.created',
            summary: 'Agency created',
            occurredAtIso: '2026-06-02T10:15:30.000Z',
            instantKey: '2026-06-02 10:15:30.000000+00',
          },
        ],
      })
    );
    render(<LookupTimelineSection entityType="agency" entityId="a1" labelled={false} />);
    await waitFor(() => expect(screen.getByText('agency.created')).toBeInTheDocument());
    const timeEl = document.querySelector('time');
    expect(timeEl).not.toBeNull();
    expect(timeEl?.className).toContain('font-mono');
  });

  it('BAL-555 fix round F4 — the visible date includes the year', async () => {
    mockFetchLookupTimelineAction.mockResolvedValue(
      okResult({
        entries: [
          {
            id: 'r1',
            action: 'agency.created',
            summary: 'Agency created',
            occurredAtIso: '2026-06-02T10:15:30.000Z',
            instantKey: '2026-06-02 10:15:30.000000+00',
          },
        ],
      })
    );
    render(<LookupTimelineSection entityType="agency" entityId="a1" labelled={false} />);
    const timeEl = await waitFor(() => {
      const el = document.querySelector('time');
      if (el === null) throw new Error('time element not rendered yet');
      return el;
    });
    expect(timeEl.textContent).toContain('2026');
  });

  it('shows the exact empty-state copy, not absence-framed', async () => {
    mockFetchLookupTimelineAction.mockResolvedValue(okResult());
    render(<LookupTimelineSection entityType="agency" entityId="a1" labelled={false} />);
    await waitFor(() =>
      expect(
        screen.getByText(
          'Nothing has been recorded against this agency yet. Rows appear here the moment something changes.'
        )
      ).toBeInTheDocument()
    );
  });

  it('renders the footer line verbatim', async () => {
    mockFetchLookupTimelineAction.mockResolvedValue(
      okResult({
        entries: [
          {
            id: 'r1',
            action: 'agency.created',
            summary: 'Agency created',
            occurredAtIso: '2026-01-01T00:00:00.000Z',
            instantKey: '2026-01-01 00:00:00.000000+00',
          },
        ],
      })
    );
    render(<LookupTimelineSection entityType="agency" entityId="a1" labelled={false} />);
    await waitFor(() =>
      expect(
        screen.getByText(
          'From audit_events — every row was written in the same transaction as the change it records.'
        )
      ).toBeInTheDocument()
    );
  });

  it('an unavailable failure shows Retry, which refetches', async () => {
    mockFetchLookupTimelineAction.mockResolvedValueOnce({ ok: false, reason: 'unavailable' });
    const user = userEvent.setup();
    render(<LookupTimelineSection entityType="agency" entityId="a1" labelled={false} />);

    await waitFor(() => expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument());

    mockFetchLookupTimelineAction.mockResolvedValueOnce(okResult());
    await user.click(screen.getByRole('button', { name: /retry/i }));

    await waitFor(() => expect(mockFetchLookupTimelineAction).toHaveBeenCalledTimes(2));
  });

  it('a forbidden failure shows its reason copy with no Retry button', async () => {
    mockFetchLookupTimelineAction.mockResolvedValue({ ok: false, reason: 'forbidden' });
    render(<LookupTimelineSection entityType="agency" entityId="a1" labelled={false} />);
    await waitFor(() => expect(screen.getByText(/platform-admin access/i)).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument();
  });

  it('"Load earlier" prepends the older page', async () => {
    mockFetchLookupTimelineAction.mockResolvedValueOnce(
      okResult({
        entries: [
          {
            id: 'newer',
            action: 'engagement.accepted',
            summary: 'Delivery accepted',
            occurredAtIso: '2026-02-01T00:00:00.000Z',
            instantKey: '2026-02-01 00:00:00.000000+00',
          },
        ],
        hasEarlier: true,
        earlier: { createdAtPrecise: '2026-02-01T00:00:00.000Z', seq: 5 },
      })
    );
    const user = userEvent.setup();
    render(<LookupTimelineSection entityType="engagement" entityId="e1" labelled={false} />);

    await waitFor(() => expect(screen.getByText('Delivery accepted')).toBeInTheDocument());

    mockFetchLookupTimelineAction.mockResolvedValueOnce(
      okResult({
        entries: [
          {
            id: 'older',
            action: 'engagement.created',
            summary: 'Project created',
            occurredAtIso: '2026-01-01T00:00:00.000Z',
            instantKey: '2026-01-01 00:00:00.000000+00',
          },
        ],
        hasEarlier: false,
        earlier: null,
      })
    );
    await user.click(screen.getByRole('button', { name: /load earlier/i }));

    await waitFor(() => expect(screen.getByText('Project created')).toBeInTheDocument());
    expect(mockFetchLookupTimelineAction).toHaveBeenLastCalledWith({
      type: 'engagement',
      id: 'e1',
      before: { createdAtPrecise: '2026-02-01T00:00:00.000Z', seq: 5 },
    });
    // The older row now appears, alongside the original one.
    expect(screen.getByText('Delivery accepted')).toBeInTheDocument();
    // "Load earlier" is gone since hasEarlier is now false.
    expect(screen.queryByRole('button', { name: /load earlier/i })).not.toBeInTheDocument();
  });

  it('BAL-555 fix round F1 — a "Load earlier" that resolves ok:false shows an inline error and keeps the already-loaded rows', async () => {
    mockFetchLookupTimelineAction.mockResolvedValueOnce(
      okResult({
        entries: [
          {
            id: 'newer',
            action: 'engagement.accepted',
            summary: 'Delivery accepted',
            occurredAtIso: '2026-02-01T00:00:00.000Z',
            instantKey: '2026-02-01 00:00:00.000000+00',
          },
        ],
        hasEarlier: true,
        earlier: { createdAtPrecise: '2026-02-01T00:00:00.000Z', seq: 5 },
      })
    );
    const user = userEvent.setup();
    render(<LookupTimelineSection entityType="engagement" entityId="e1" labelled={false} />);

    await waitFor(() => expect(screen.getByText('Delivery accepted')).toBeInTheDocument());

    // A resolved `ok: false` (not a rejection) — the Server Action's own catch already logged
    // this server-side, so the component reports it inline WITHOUT a second client-side log.
    mockFetchLookupTimelineAction.mockResolvedValueOnce({ ok: false, reason: 'unavailable' });
    await user.click(screen.getByRole('button', { name: /load earlier/i }));

    // The already-loaded row is untouched — no rows lost, no silent no-op.
    await waitFor(() =>
      expect(screen.getByText(/didn.t load\. nothing was changed/i)).toBeInTheDocument()
    );
    expect(screen.getByText('Delivery accepted')).toBeInTheDocument();
    // "Load earlier" stays — hasEarlier from the ORIGINAL page is untouched by the failure.
    expect(screen.getByRole('button', { name: /load earlier/i })).toBeInTheDocument();
  });

  it('BAL-555 fix round F1 — a "Load earlier" promise REJECTION logs the failure and shows the unavailable copy', async () => {
    mockFetchLookupTimelineAction.mockResolvedValueOnce(
      okResult({
        entries: [
          {
            id: 'newer',
            action: 'engagement.accepted',
            summary: 'Delivery accepted',
            occurredAtIso: '2026-02-01T00:00:00.000Z',
            instantKey: '2026-02-01 00:00:00.000000+00',
          },
        ],
        hasEarlier: true,
        earlier: { createdAtPrecise: '2026-02-01T00:00:00.000Z', seq: 5 },
      })
    );
    const user = userEvent.setup();
    render(<LookupTimelineSection entityType="engagement" entityId="e1" labelled={false} />);

    await waitFor(() => expect(screen.getByText('Delivery accepted')).toBeInTheDocument());

    // A genuine REJECTION (transport failure before the Server Action's own catch could run) —
    // this is the one path nothing else has already logged, so the component must.
    mockFetchLookupTimelineAction.mockRejectedValueOnce(new Error('network gone'));
    await user.click(screen.getByRole('button', { name: /load earlier/i }));

    await waitFor(() =>
      expect(screen.getByText(/didn.t load\. nothing was changed/i)).toBeInTheDocument()
    );
    expect(screen.getByText('Delivery accepted')).toBeInTheDocument();
    expect(mockCaptureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: { feature: 'admin-lookup', step: 'timeline_load_earlier' },
        extra: { entityType: 'engagement', entityId: 'e1' },
      })
    );
  });

  it('BAL-555 fix round F1 — a "Load earlier" forbidden/not_found reason renders its own copy, no Retry implied', async () => {
    mockFetchLookupTimelineAction.mockResolvedValueOnce(
      okResult({
        entries: [
          {
            id: 'newer',
            action: 'engagement.accepted',
            summary: 'Delivery accepted',
            occurredAtIso: '2026-02-01T00:00:00.000Z',
            instantKey: '2026-02-01 00:00:00.000000+00',
          },
        ],
        hasEarlier: true,
        earlier: { createdAtPrecise: '2026-02-01T00:00:00.000Z', seq: 5 },
      })
    );
    const user = userEvent.setup();
    render(<LookupTimelineSection entityType="engagement" entityId="e1" labelled={false} />);
    await waitFor(() => expect(screen.getByText('Delivery accepted')).toBeInTheDocument());

    mockFetchLookupTimelineAction.mockResolvedValueOnce({ ok: false, reason: 'not_found' });
    await user.click(screen.getByRole('button', { name: /load earlier/i }));

    await waitFor(() => expect(screen.getByText(/timeline isn.t available/i)).toBeInTheDocument());
  });

  it('same-instant rows share one visible timestamp', async () => {
    mockFetchLookupTimelineAction.mockResolvedValue(
      okResult({
        entries: [
          {
            id: 'r1',
            action: 'engagement.created',
            summary: 'Project created',
            occurredAtIso: '2026-01-01T00:00:00.000Z',
            instantKey: '2026-01-01 00:00:00.083951+00',
          },
          {
            id: 'r2',
            action: 'engagement.milestones_snapshotted',
            summary: 'Milestones snapshotted from the accepted proposal',
            occurredAtIso: '2026-01-01T00:00:00.000Z',
            instantKey: '2026-01-01 00:00:00.083951+00',
          },
        ],
      })
    );
    render(<LookupTimelineSection entityType="engagement" entityId="e1" labelled={false} />);

    await waitFor(() => expect(screen.getByText('Project created')).toBeInTheDocument());
    expect(
      screen.getByText('Milestones snapshotted from the accepted proposal')
    ).toBeInTheDocument();

    const timeElements = document.querySelectorAll('time');
    expect(timeElements).toHaveLength(1);
  });

  it('BAL-555 fix round F1 — two rows in the SAME millisecond but DIFFERENT microseconds render as TWO groups, not one', async () => {
    // Both entries round-trip to the IDENTICAL millisecond-precision `occurredAtIso` — a
    // millisecond-truncated grouping key would incorrectly merge them into one visible change.
    // Their `instantKey`s (the full-microsecond opaque equality key) differ, so they must
    // render as two separate groups with two separate `<time>` elements.
    mockFetchLookupTimelineAction.mockResolvedValue(
      okResult({
        entries: [
          {
            id: 'r1',
            action: 'engagement.accepted',
            summary: 'Delivery accepted',
            occurredAtIso: '2026-03-01T12:00:00.083Z',
            instantKey: '2026-03-01 12:00:00.083999+00',
          },
          {
            id: 'r2',
            action: 'engagement.changes_requested',
            summary: 'Changes requested',
            occurredAtIso: '2026-03-01T12:00:00.083Z',
            instantKey: '2026-03-01 12:00:00.083001+00',
          },
        ],
      })
    );
    render(<LookupTimelineSection entityType="engagement" entityId="e1" labelled={false} />);

    await waitFor(() => expect(screen.getByText('Delivery accepted')).toBeInTheDocument());
    expect(screen.getByText('Changes requested')).toBeInTheDocument();

    const timeElements = document.querySelectorAll('time');
    expect(timeElements).toHaveLength(2);
  });

  it('renders the eyebrow chrome when labelled', async () => {
    mockFetchLookupTimelineAction.mockResolvedValue(okResult());
    render(<LookupTimelineSection entityType="agency" entityId="a1" labelled />);
    await waitFor(() => expect(screen.getByText('Timeline')).toBeInTheDocument());
  });

  it('BAL-555 fix round F4 — the eyebrow label uses font-semibold', async () => {
    mockFetchLookupTimelineAction.mockResolvedValue(okResult());
    render(<LookupTimelineSection entityType="agency" entityId="a1" labelled />);
    const eyebrowLabel = await screen.findByText('Timeline');
    expect(eyebrowLabel.className).toContain('font-semibold');
  });
});
