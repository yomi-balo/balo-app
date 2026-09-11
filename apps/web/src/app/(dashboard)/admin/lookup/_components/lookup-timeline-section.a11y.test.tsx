import { describe, it, expect, vi } from 'vitest';
import { axe } from 'jest-axe';
import { render, screen, waitFor } from '@/test/utils';
import { LookupTimelineSection } from './lookup-timeline-section';

/**
 * BAL-555 fix round F3 — automated a11y coverage for the Timeline section's own states
 * (loaded rows, empty state, failure state), following the established `jest-axe` pattern
 * (`apps/web/src/components/booking/booking-flow-dialog.a11y.test.tsx`).
 */

const { mockFetchLookupTimelineAction } = vi.hoisted(() => ({
  mockFetchLookupTimelineAction: vi.fn(),
}));

vi.mock('../_actions/fetch-lookup-timeline', () => ({
  fetchLookupTimelineAction: mockFetchLookupTimelineAction,
}));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));

describe('LookupTimelineSection — accessibility (BAL-555 fix round F3)', () => {
  it('has no violations once rows are loaded, including the "Load earlier" control', async () => {
    mockFetchLookupTimelineAction.mockResolvedValue({
      ok: true,
      entries: [
        {
          id: 'r1',
          action: 'agency.created',
          summary: 'Agency created — MJ @ Balo',
          occurredAtIso: '2026-06-02T10:15:30.000Z',
          instantKey: '2026-06-02 10:15:30.000000+00',
        },
      ],
      hasEarlier: true,
      earlier: { createdAtPrecise: '2026-06-02 10:15:30.000000+00', seq: 3 },
    });

    const { container } = render(
      <LookupTimelineSection entityType="agency" entityId="a1" labelled />
    );

    await waitFor(() => expect(screen.getByText('Agency created — MJ @ Balo')).toBeInTheDocument());
    expect(await axe(container)).toHaveNoViolations();
  });

  it('has no violations on the empty state', async () => {
    mockFetchLookupTimelineAction.mockResolvedValue({
      ok: true,
      entries: [],
      hasEarlier: false,
      earlier: null,
    });

    const { container } = render(
      <LookupTimelineSection entityType="agency" entityId="a1" labelled />
    );

    await waitFor(() => expect(screen.getByText(/nothing has been recorded/i)).toBeInTheDocument());
    expect(await axe(container)).toHaveNoViolations();
  });

  it('has no violations on the retryable failure state', async () => {
    mockFetchLookupTimelineAction.mockResolvedValue({ ok: false, reason: 'unavailable' });

    const { container } = render(
      <LookupTimelineSection entityType="agency" entityId="a1" labelled={false} />
    );

    await waitFor(() => expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument());
    expect(await axe(container)).toHaveNoViolations();
  });
});
