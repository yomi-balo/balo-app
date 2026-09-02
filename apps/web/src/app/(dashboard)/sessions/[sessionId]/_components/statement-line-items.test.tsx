import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/utils';
import type { SessionStatementView } from '../_lib/session-statement-view';
import { StatementLineItems } from './statement-line-items';

const CLIENT_VIEW: SessionStatementView = {
  lens: 'client',
  sessionId: 'session_1',
  mode: { kind: 'money' },
  occurredAtIso: '2026-08-12T10:00:00.000Z',
  title: 'Static analysis walkthrough',
  counterparty: { name: 'Priya Sharma', orgLabel: 'CloudPeak Consulting' },
  meetingId: 'meeting_1',
  block: {
    lens: 'client',
    state: 'finalized',
    sessionId: 'session_1',
    durationMinutes: 45,
    amountAudMinor: 15_750,
    ratePerMinuteMinor: 350,
    settlementStatus: 'not_required',
    actualMinutes: 45,
    billingFloorApplied: false,
    billingFloorMinutes: 0,
  },
};

const EXPERT_VIEW: SessionStatementView = {
  lens: 'expert',
  sessionId: 'session_1',
  mode: { kind: 'money' },
  occurredAtIso: '2026-08-12T10:00:00.000Z',
  title: 'Static analysis walkthrough',
  counterparty: { name: 'Northwind Industrial', orgLabel: null },
  meetingId: 'meeting_1',
  payout: null,
  block: {
    lens: 'expert',
    state: 'finalized',
    sessionId: 'session_1',
    durationMinutes: 45,
    earningsAudMinor: 11_250,
    actualMinutes: 45,
    billingFloorApplied: false,
    billingFloorMinutes: 0,
  },
};

describe('StatementLineItems', () => {
  it('client: shows the rate row, "Duration billed", and "Total charged"', () => {
    render(<StatementLineItems view={CLIENT_VIEW} />);
    expect(screen.getByText('Rate per minute')).toBeInTheDocument();
    expect(screen.getByText('A$3.50')).toBeInTheDocument();
    expect(screen.getByText('Duration billed')).toBeInTheDocument();
    expect(screen.getByText('45 min')).toBeInTheDocument();
    expect(screen.getByText('Total charged')).toBeInTheDocument();
    expect(screen.getByText('A$157.50')).toBeInTheDocument();
  });

  it('expert: NO rate row (not part of the expert payload); "Duration" and "Total earned"', () => {
    render(<StatementLineItems view={EXPERT_VIEW} />);
    expect(screen.queryByText('Rate per minute')).not.toBeInTheDocument();
    expect(screen.getByText('Duration')).toBeInTheDocument();
    expect(screen.getByText('Total earned')).toBeInTheDocument();
    expect(screen.getByText('A$112.50')).toBeInTheDocument();
    // Fee safety: the client's rate/total never appear on the expert's own statement.
    expect(screen.queryByText('A$3.50')).not.toBeInTheDocument();
    expect(screen.queryByText('A$157.50')).not.toBeInTheDocument();
  });

  it('renders the floor sub-line when the floor bound', () => {
    const view: SessionStatementView = {
      ...CLIENT_VIEW,
      block: {
        ...CLIENT_VIEW.block,
        durationMinutes: 15,
        amountAudMinor: 5_250,
        actualMinutes: 6,
        billingFloorApplied: true,
        billingFloorMinutes: 15,
        settlementShape: 'held',
      },
    };
    render(<StatementLineItems view={view} />);
    expect(screen.getByText('15 min')).toBeInTheDocument();
    expect(screen.getByText('6 min · billed at the 15-minute minimum')).toBeInTheDocument();
  });

  it('renders NO sub-line for the ordinary (no-floor) case', () => {
    render(<StatementLineItems view={CLIENT_VIEW} />);
    expect(screen.queryByText(/billed at the/)).not.toBeInTheDocument();
  });
});
