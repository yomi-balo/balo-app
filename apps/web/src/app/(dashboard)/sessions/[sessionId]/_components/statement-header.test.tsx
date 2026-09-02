import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/utils';
import { StatementBackLink, StatementHeader } from './statement-header';

describe('StatementBackLink', () => {
  it('renders a link to the recap when meetingId is present', () => {
    render(<StatementBackLink meetingId="meeting_1" />);
    const link = screen.getByRole('link', { name: /Back to recap/ });
    expect(link).toHaveAttribute('href', '/meetings/meeting_1');
  });

  it('renders nothing when meetingId is null — never a guessed href', () => {
    const { container } = render(<StatementBackLink meetingId={null} />);
    expect(container.querySelector('a')).toBeNull();
  });
});

describe('StatementHeader', () => {
  it('renders the eyebrow, title, date and counterparty with an org label', () => {
    render(
      <StatementHeader
        eyebrow="Session receipt"
        title="Static analysis walkthrough"
        occurredAtIso="2026-08-12T10:00:00.000Z"
        counterparty={{ name: 'Priya Sharma', orgLabel: 'CloudPeak Consulting' }}
      />
    );
    expect(screen.getByText('Session receipt')).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Static analysis walkthrough' })
    ).toBeInTheDocument();
    expect(screen.getByText(/with Priya Sharma @ CloudPeak Consulting/)).toBeInTheDocument();
  });

  it('renders the bare name when there is no org label (independent expert / company)', () => {
    render(
      <StatementHeader
        eyebrow="Payout statement"
        title="Static analysis walkthrough"
        occurredAtIso="2026-08-12T10:00:00.000Z"
        counterparty={{ name: 'Northwind Industrial', orgLabel: null }}
      />
    );
    expect(screen.getByText(/with Northwind Industrial/)).toBeInTheDocument();
  });

  it('falls back to "Date pending" when occurredAtIso is null', () => {
    render(
      <StatementHeader
        eyebrow="Session receipt"
        title="Consultation session"
        occurredAtIso={null}
        counterparty={{ name: 'An expert', orgLabel: null }}
      />
    );
    expect(screen.getByText('Date pending')).toBeInTheDocument();
  });
});
