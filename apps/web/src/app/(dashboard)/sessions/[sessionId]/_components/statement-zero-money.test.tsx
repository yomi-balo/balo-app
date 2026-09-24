import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/utils';
import type { SessionStatementView } from '../_lib/session-statement-view';
import { StatementZeroMoney } from './statement-zero-money';

const BASE: SessionStatementView = {
  lens: 'client',
  sessionId: 'session_1',
  mode: { kind: 'zero' },
  occurredAtIso: '2026-08-12T10:00:00.000Z',
  title: 'Consultation session',
  counterparty: { name: 'An expert', orgLabel: null },
  meetingId: 'meeting_1',
  clientSideEverPresent: null,
  block: {
    lens: 'client',
    state: 'finalized',
    sessionId: 'session_1',
    durationMinutes: 0,
    amountAudMinor: 0,
    ratePerMinuteMinor: 350,
    settlementStatus: 'not_required',
    actualMinutes: 0,
    billingFloorApplied: false,
    billingFloorMinutes: 15,
    settlementShape: 'missed_call',
  },
};

describe('StatementZeroMoney', () => {
  it('renders the missed-call statement line, no currency', () => {
    render(<StatementZeroMoney view={BASE} />);
    expect(
      screen.getByText("Not charged — your consultant didn't join this time")
    ).toBeInTheDocument();
    expect(screen.queryByText(/A\$/)).not.toBeInTheDocument();
  });

  it('renders the line that names nobody when nobody on the client side joined either', () => {
    render(<StatementZeroMoney view={{ ...BASE, clientSideEverPresent: false }} />);
    const line = screen.getByText('Not charged — nobody joined this time');
    expect(line).toBeInTheDocument();
    expect(line.textContent).toBe('Not charged — nobody joined this time');
    expect(screen.queryByText(/consultant/)).not.toBeInTheDocument();
    expect(screen.queryByText(/A\$/)).not.toBeInTheDocument();
  });

  it.each([true, null])(
    'keeps the line that names the consultant when client presence is %s',
    (clientSideEverPresent) => {
      render(<StatementZeroMoney view={{ ...BASE, clientSideEverPresent }} />);
      expect(
        screen.getByText("Not charged — your consultant didn't join this time")
      ).toBeInTheDocument();
      expect(screen.queryByText(/nobody joined/)).not.toBeInTheDocument();
    }
  );

  it('the EXPERT missed-call line is unchanged (names nobody already)', () => {
    const expertView: SessionStatementView = {
      lens: 'expert',
      sessionId: 'session_1',
      mode: { kind: 'zero' },
      occurredAtIso: '2026-08-12T10:00:00.000Z',
      title: null,
      counterparty: { name: 'Northwind Industrial', orgLabel: null },
      meetingId: 'meeting_1',
      payout: null,
      block: {
        lens: 'expert',
        state: 'finalized',
        sessionId: 'session_1',
        durationMinutes: 0,
        earningsAudMinor: 0,
        actualMinutes: 0,
        billingFloorApplied: false,
        billingFloorMinutes: 15,
        settlementShape: 'missed_call',
      },
    };
    render(<StatementZeroMoney view={expertView} />);
    expect(
      screen.getByText("No earnings recorded — the call didn't take place")
    ).toBeInTheDocument();
  });

  it('renders the abandoned-wait line for that shape', () => {
    const view: SessionStatementView = {
      ...BASE,
      block: { ...BASE.block, settlementShape: 'abandoned_wait' },
    };
    render(<StatementZeroMoney view={view} />);
    expect(screen.getByText('Not charged')).toBeInTheDocument();
  });

  it('renders the cancelled copy for the cancelled mode, per lens', () => {
    const clientView: SessionStatementView = { ...BASE, mode: { kind: 'cancelled' } };
    render(<StatementZeroMoney view={clientView} />);
    expect(screen.getByText('Not charged — this consultation was cancelled.')).toBeInTheDocument();
  });

  it('renders the expert cancelled copy', () => {
    const expertView: SessionStatementView = {
      lens: 'expert',
      sessionId: 'session_1',
      mode: { kind: 'cancelled' },
      occurredAtIso: null,
      title: null,
      counterparty: { name: 'Northwind Industrial', orgLabel: null },
      meetingId: null,
      payout: null,
      block: {
        lens: 'expert',
        state: 'pending',
        sessionId: 'session_1',
        durationMinutes: 0,
        earningsAudMinor: 0,
        actualMinutes: 0,
        billingFloorApplied: false,
        billingFloorMinutes: 0,
      },
    };
    render(<StatementZeroMoney view={expertView} />);
    expect(
      screen.getByText('No earnings recorded — this consultation was cancelled.')
    ).toBeInTheDocument();
  });
});
