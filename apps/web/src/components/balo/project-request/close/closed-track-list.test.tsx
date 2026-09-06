import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ClosedTrackList } from './closed-track-list';
import type { ClosedTrackView } from '@/lib/project-request/request-detail-view';

function track(overrides: Partial<ClosedTrackView> = {}): ClosedTrackView {
  return {
    relationshipId: 'rel-1',
    expertName: 'Priya Nair',
    expertInitials: 'PN',
    partyLabel: 'Priya Nair',
    finalChip: 'ended_request_closed',
    endedLabel: 'Ended when the request closed · files as they were',
    ...overrides,
  };
}

describe('ClosedTrackList', () => {
  it('renders nothing for an empty track list (purely retrospective — no invitation to make)', () => {
    const { container } = render(<ClosedTrackList tracks={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders one row per track with name and final chip', () => {
    render(
      <ClosedTrackList
        tracks={[
          track(),
          track({ relationshipId: 'rel-2', expertName: 'Marcus Lee', finalChip: 'declined' }),
        ]}
      />
    );
    expect(screen.getByText('Priya Nair')).toBeInTheDocument();
    expect(screen.getByText('Marcus Lee')).toBeInTheDocument();
    expect(screen.getByText('Ended — request closed')).toBeInTheDocument();
    expect(screen.getByText('Declined')).toBeInTheDocument();
  });

  it('shows "Invite withdrawn" for the invite_withdrawn chip', () => {
    render(<ClosedTrackList tracks={[track({ finalChip: 'invite_withdrawn' })]} />);
    expect(screen.getByText('Invite withdrawn')).toBeInTheDocument();
  });

  it('shows the ended label for each track', () => {
    render(<ClosedTrackList tracks={[track()]} />);
    expect(
      screen.getByText('Ended when the request closed · files as they were')
    ).toBeInTheDocument();
  });
});
