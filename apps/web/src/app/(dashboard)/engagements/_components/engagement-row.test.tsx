import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/utils';
import type { EngagementOversightRow } from '@/lib/engagements/oversight-row';
import { EngagementRow } from './engagement-row';

function makeRow(overrides: Partial<EngagementOversightRow> = {}): EngagementOversightRow {
  return {
    id: 'e-1',
    href: '/engagements/e-1',
    status: 'active',
    title: 'CPQ implementation',
    client: 'Northwind Industrial',
    expertLabel: 'Priya Nair @ CloudPeak',
    progress: { done: 2, total: 4 },
    pricingLabel: 'Fixed · A$58,000',
    kickoffIso: '2026-06-12T00:00:00.000Z',
    lastActivityRelative: '2 days ago',
    lastActivityIso: '2026-06-14T00:00:00.000Z',
    stalled: false,
    quietDays: 2,
    ...overrides,
  };
}

describe('EngagementRow', () => {
  it('links to the engagement detail and shows title, parties, progress, pricing, kickoff', () => {
    render(<EngagementRow row={makeRow()} last />);
    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('href', '/engagements/e-1');
    expect(screen.getByText('CPQ implementation')).toBeInTheDocument();
    expect(screen.getByText('Northwind Industrial')).toBeInTheDocument();
    expect(screen.getByText('Priya Nair @ CloudPeak')).toBeInTheDocument();
    expect(screen.getByText('2 of 4')).toBeInTheDocument();
    expect(screen.getByText('Fixed · A$58,000')).toBeInTheDocument();
    // Kickoff date renders viewer-local inside <LocalDate> (UTC "12 Jun" under TZ=UTC).
    expect(link).toHaveTextContent('Kicked off 12 Jun');
    expect(screen.getByText('Active')).toBeInTheDocument();
  });

  it('renders "No milestones" when the engagement has none', () => {
    render(<EngagementRow row={makeRow({ progress: { done: 0, total: 0 } })} last />);
    expect(screen.getByText('No milestones')).toBeInTheDocument();
  });

  it('shows the stalled chip and quiet-days fact for a stalled active row', () => {
    render(<EngagementRow row={makeRow({ stalled: true, quietDays: 18 })} last />);
    expect(screen.getByText('Quiet 18d')).toBeInTheDocument();
    expect(screen.getByText('No milestone activity in 18 days')).toBeInTheDocument();
  });

  it('states the auto-accept date as a helpful fact (not a countdown) for an in-review row', () => {
    render(
      <EngagementRow
        row={makeRow({
          status: 'pending_acceptance',
          autoAcceptIso: '2026-06-19T00:00:00.000Z',
          progress: { done: 5, total: 5 },
        })}
        last
      />
    );
    expect(screen.getByRole('link')).toHaveTextContent('Auto-accepts 19 Jun');
    expect(
      screen.getByText(/Northwind Industrial can accept or request changes until then/i)
    ).toBeInTheDocument();
    expect(screen.getByText('In review')).toBeInTheDocument();
  });

  it('attributes a client-accepted completion to the person @ company', () => {
    render(
      <EngagementRow
        row={makeRow({
          status: 'completed',
          acceptance: {
            method: 'client',
            byLabel: 'Sam Rivera @ Bright Foods',
            onIso: '2026-06-03T00:00:00.000Z',
          },
        })}
        last
      />
    );
    expect(screen.getByRole('link')).toHaveTextContent(
      'Accepted by Sam Rivera @ Bright Foods · 3 Jun'
    );
  });

  it('attributes an auto-accepted completion when there is no accepting person', () => {
    render(
      <EngagementRow
        row={makeRow({
          status: 'completed',
          acceptance: { method: 'auto', byLabel: null, onIso: '2026-06-03T00:00:00.000Z' },
        })}
        last
      />
    );
    expect(screen.getByRole('link')).toHaveTextContent('Auto-accepted 3 Jun');
  });

  it('shows the cancellation attribution and reason', () => {
    render(
      <EngagementRow
        row={makeRow({
          status: 'cancelled',
          cancellation: {
            byLabel: 'MJ Okonkwo @ Balo',
            onIso: '2026-05-28T00:00:00.000Z',
            reason: 'Programme paused after the acquisition.',
          },
        })}
        last
      />
    );
    expect(screen.getByRole('link')).toHaveTextContent(
      'Cancelled by MJ Okonkwo @ Balo · 28 May — Programme paused after the acquisition.'
    );
  });

  it('falls back to "an admin" when the cancelling actor is unknown', () => {
    render(
      <EngagementRow
        row={makeRow({
          status: 'cancelled',
          cancellation: { byLabel: null, onIso: '2026-05-28T00:00:00.000Z', reason: '' },
        })}
        last
      />
    );
    expect(screen.getByRole('link')).toHaveTextContent('Cancelled by an admin · 28 May');
  });
});
