import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ExpertEndedTrackView } from './expert-ended-track-view';
import type { EndedTrackView } from '@/lib/project-request/resolve-ended-track-view';

function view(overrides: Partial<EndedTrackView> = {}): EndedTrackView {
  return {
    mode: 'declined',
    relationshipId: 'rel-1',
    title: 'CPQ implementation',
    companyName: 'Northwind Industrial',
    endedAtIso: '2026-09-05T00:00:00.000Z',
    hadProposal: true,
    ...overrides,
  };
}

describe('ExpertEndedTrackView', () => {
  it('declined + hadProposal: mentions the proposal specifically', () => {
    render(<ExpertEndedTrackView view={view({ mode: 'declined', hadProposal: true })} />);
    expect(screen.getByText(/isn’t proceeding with your proposal/)).toBeInTheDocument();
    expect(screen.getByText(/proposal is no longer under review/)).toBeInTheDocument();
    expect(screen.getByText('Declined 5 Sept 2026')).toBeInTheDocument();
  });

  it('declined + no proposal: never claims a proposal existed', () => {
    render(<ExpertEndedTrackView view={view({ mode: 'declined', hadProposal: false })} />);
    expect(screen.getByText(/isn’t proceeding with you\b/)).toBeInTheDocument();
    expect(screen.queryByText(/proposal/i)).not.toBeInTheDocument();
  });

  it('request_closed: names the company as having closed the request', () => {
    render(<ExpertEndedTrackView view={view({ mode: 'request_closed', hadProposal: true })} />);
    expect(screen.getByText('Northwind Industrial closed this request')).toBeInTheDocument();
    expect(screen.getByText('Closed 5 Sept 2026')).toBeInTheDocument();
  });

  it('always offers a way back to the projects list', () => {
    render(<ExpertEndedTrackView view={view()} />);
    const link = screen.getByRole('link', { name: /Back to your projects/i });
    expect(link).toHaveAttribute('href', '/projects');
  });

  it('never shows any action beyond the back link (no brief, no contact, no conversation)', () => {
    render(<ExpertEndedTrackView view={view()} />);
    expect(screen.getAllByRole('link')).toHaveLength(1);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
