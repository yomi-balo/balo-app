import { describe, it, expect, vi } from 'vitest';
import { axe } from 'jest-axe';
import { render, screen } from '@/test/utils';
import type { SessionStatementView } from '../_lib/session-statement-view';

vi.mock('motion/react', async () => {
  const { createMotionStub } = await import('@/test/motion-stub');
  return createMotionStub();
});
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

import { StatementShell } from './statement-shell';

const CLIENT_MONEY: SessionStatementView = {
  lens: 'client',
  sessionId: 'session_1',
  mode: { kind: 'money' },
  occurredAtIso: '2026-08-12T10:00:00.000Z',
  title: 'Static analysis walkthrough',
  counterparty: { name: 'Priya Sharma', orgLabel: 'CloudPeak Consulting' },
  meetingId: 'meeting_1',
  clientSideEverPresent: null,
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

const EXPERT_MONEY: SessionStatementView = {
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
    payoutStatus: 'recorded',
    actualMinutes: 45,
    billingFloorApplied: false,
    billingFloorMinutes: 0,
  },
};

describe('StatementShell', () => {
  it('renders the client receipt: title, counterparty, line items, download link, no expert figure', () => {
    render(<StatementShell view={CLIENT_MONEY} />);
    expect(
      screen.getByRole('heading', { name: 'Static analysis walkthrough' })
    ).toBeInTheDocument();
    expect(screen.getByText('Total charged')).toBeInTheDocument();
    expect(screen.getByText('A$157.50')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Download this receipt/ })).toBeInTheDocument();
    // Fee safety: no expert-earnings figure on the client's own surface.
    expect(screen.queryByText('A$112.50')).not.toBeInTheDocument();
  });

  it('renders the expert payout: total earned, payout status block, no client charge', () => {
    render(<StatementShell view={EXPERT_MONEY} />);
    expect(screen.getByText('Total earned')).toBeInTheDocument();
    expect(screen.getByText('A$112.50')).toBeInTheDocument();
    expect(screen.getByText('Booked')).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /Download this payout statement/ })
    ).toBeInTheDocument();
    expect(screen.queryByText('A$157.50')).not.toBeInTheDocument();
  });

  it('renders the zero-money composition with NO download link and NO footer note', () => {
    const view: SessionStatementView = {
      ...CLIENT_MONEY,
      mode: { kind: 'zero' },
      block: { ...CLIENT_MONEY.block, settlementShape: 'missed_call' },
    };
    render(<StatementShell view={view} />);
    expect(
      screen.getByText("Not charged — your consultant didn't join this time")
    ).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Download/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/A record of/)).not.toBeInTheDocument();
  });

  it('renders the line that names nobody when nobody on the client side joined either', () => {
    const view: SessionStatementView = {
      ...CLIENT_MONEY,
      mode: { kind: 'zero' },
      block: { ...CLIENT_MONEY.block, settlementShape: 'missed_call' },
      clientSideEverPresent: false,
    };
    render(<StatementShell view={view} />);
    expect(screen.getByText('Not charged — nobody joined this time')).toBeInTheDocument();
    expect(screen.queryByText(/your consultant didn't join/)).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Download/ })).not.toBeInTheDocument();
  });

  it('renders the pending composition with no line items and no download link', () => {
    const view: SessionStatementView = {
      ...CLIENT_MONEY,
      mode: { kind: 'pending' },
      block: { ...CLIENT_MONEY.block, state: 'pending', durationMinutes: 0, amountAudMinor: 0 },
    };
    render(<StatementShell view={view} />);
    expect(screen.getByText('Charge pending')).toBeInTheDocument();
    expect(screen.queryByText('Total charged')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Download/ })).not.toBeInTheDocument();
  });

  it('renders the cancelled composition — the poller never arms', () => {
    const view: SessionStatementView = {
      ...CLIENT_MONEY,
      mode: { kind: 'cancelled' },
      block: { ...CLIENT_MONEY.block, state: 'pending', durationMinutes: 0, amountAudMinor: 0 },
    };
    render(<StatementShell view={view} />);
    expect(screen.getByText('Not charged — this consultation was cancelled.')).toBeInTheDocument();
    expect(screen.queryByText('Charge pending')).not.toBeInTheDocument();
  });

  it('renders NO back link when meetingId is null', () => {
    const view: SessionStatementView = { ...CLIENT_MONEY, meetingId: null };
    const { container } = render(<StatementShell view={view} />);
    expect(container.querySelector('a[href^="/meetings/"]')).toBeNull();
  });

  // BAL-474 (copy v2.1 §7) — the settlement note is shape-aware, and the shell hands it the shape.
  describe('the client settlement note (shape-aware)', () => {
    it('a no_show_client + failed receipt shows the no-show string and a /settings/billing link', () => {
      const view: SessionStatementView = {
        ...CLIENT_MONEY,
        block: {
          ...CLIENT_MONEY.block,
          settlementStatus: 'failed',
          settlementShape: 'no_show_client',
        },
      };
      render(<StatementShell view={view} />);
      expect(
        screen.getByText(
          /This booking was billed at its minimum charge, and the part your balance didn't cover couldn't be charged to a card\./
        )
      ).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Manage billing' })).toHaveAttribute(
        'href',
        '/settings/billing'
      );
    });

    it('a held + failed receipt shows the consultation string, NOT the no-show one (positive control)', () => {
      const view: SessionStatementView = {
        ...CLIENT_MONEY,
        block: { ...CLIENT_MONEY.block, settlementStatus: 'failed', settlementShape: 'held' },
      };
      render(<StatementShell view={view} />);
      expect(
        screen.getByText(/The part of this consultation your balance didn't cover couldn't be/)
      ).toBeInTheDocument();
      expect(screen.queryByText(/billed at its minimum charge/)).not.toBeInTheDocument();
    });

    it('a receipt with no shape (pre-BAL-412) falls back to the held wording', () => {
      const view: SessionStatementView = {
        ...CLIENT_MONEY,
        block: { ...CLIENT_MONEY.block, settlementStatus: 'processing' },
      };
      render(<StatementShell view={view} />);
      expect(
        screen.getByText(
          "The part of this consultation your balance didn't cover is still settling."
        )
      ).toBeInTheDocument();
    });

    it('the expert lens never renders the client settlement note', () => {
      render(<StatementShell view={EXPERT_MONEY} />);
      expect(screen.queryByText(/your balance didn't cover/)).not.toBeInTheDocument();
    });
  });
});

// ── Plan §15's a11y requirement, applied to the PAGE BODY rather than only the route shells.
// This is where the real structure lives: a <dl> of line items, status badges, an <output> live
// region and a motion wrapper. Walk every composition on BOTH lenses — a violation that only
// appears on, say, the zero-money or cancelled arm would otherwise ship unseen.
describe('StatementShell — accessibility across every composition', () => {
  const cases: ReadonlyArray<readonly [string, SessionStatementView]> = [
    ['client money', CLIENT_MONEY],
    ['expert money', EXPERT_MONEY],
    ['client zero-money', { ...CLIENT_MONEY, mode: { kind: 'zero' } } as SessionStatementView],
    ['expert zero-money', { ...EXPERT_MONEY, mode: { kind: 'zero' } } as SessionStatementView],
    ['client pending', { ...CLIENT_MONEY, mode: { kind: 'pending' } } as SessionStatementView],
    ['client cancelled', { ...CLIENT_MONEY, mode: { kind: 'cancelled' } } as SessionStatementView],
  ];

  it.each(cases)('%s has no accessibility violations', async (_label, view) => {
    const { container } = render(<StatementShell view={view} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
