import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ClosedBanner } from './closed-banner';
import type { ClosedRequestSummary } from '@/lib/project-request/request-detail-view';

function closed(overrides: Partial<ClosedRequestSummary> = {}): ClosedRequestSummary {
  return {
    closedAtIso: '2026-09-05T10:00:00.000Z',
    reason: 'unfilled',
    closedByLabel: 'Adeeb @ Balo',
    closedByParty: 'balo',
    note: null,
    counts: { tracksEnded: 2, proposalsWithdrawn: 1, meetingsCancelled: 1 },
    ...overrides,
  };
}

describe('ClosedBanner', () => {
  it('renders the date, reason label and attribution', () => {
    render(<ClosedBanner closed={closed()} viewerLens="admin" />);
    expect(screen.getByText(/Closed on 5 Sept 2026/)).toBeInTheDocument();
    expect(screen.getByText(/Unfilled/)).toBeInTheDocument();
    expect(screen.getByText(/Adeeb @ Balo/)).toBeInTheDocument();
    expect(screen.getByText(/2 tracks ended/)).toBeInTheDocument();
    expect(screen.getByText(/1 meeting cancelled/)).toBeInTheDocument();
    expect(screen.getByText(/files unchanged/)).toBeInTheDocument();
  });

  it('says "Withdrawn by" for a withdrawn (client) close, "Closed by" otherwise', () => {
    render(<ClosedBanner closed={closed({ reason: 'withdrawn' })} viewerLens="client" />);
    expect(screen.getByText(/Withdrawn by/)).toBeInTheDocument();
  });

  it('negative: the Balo-only note block is absent when note is null', () => {
    render(<ClosedBanner closed={closed({ note: null })} viewerLens="admin" />);
    expect(screen.queryByText(/Balo only/)).not.toBeInTheDocument();
  });

  it('renders the Balo-only note block when note is set', () => {
    render(
      <ClosedBanner closed={closed({ note: 'Keep Priya warm for Q1.' })} viewerLens="admin" />
    );
    expect(screen.getByText(/Balo only/)).toBeInTheDocument();
    expect(screen.getByText(/Keep Priya warm for Q1\./)).toBeInTheDocument();
  });

  it('shows "Raise a new request" for the client lens only', () => {
    const { rerender } = render(<ClosedBanner closed={closed()} viewerLens="client" />);
    expect(screen.getByRole('link', { name: /Raise a new request/i })).toBeInTheDocument();

    rerender(<ClosedBanner closed={closed()} viewerLens="admin" />);
    expect(screen.queryByRole('link', { name: /Raise a new request/i })).not.toBeInTheDocument();
  });
});
