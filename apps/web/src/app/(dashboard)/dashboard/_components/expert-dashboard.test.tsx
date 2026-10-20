import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/utils';

vi.mock('./getting-started-checklist', () => ({
  GettingStartedChecklist: () => <div data-testid="checklist" />,
}));
vi.mock('./celebration-card', () => ({
  CelebrationCard: () => <div data-testid="celebration" />,
}));
vi.mock('./earnings-card', () => ({
  EarningsCard: () => <div data-testid="earnings" />,
}));
vi.mock('./ghost-clients-card', () => ({
  GhostClientsCard: () => <div data-testid="ghost-clients" />,
}));

import { ExpertDashboard } from './expert-dashboard';
import type { ChecklistStatus } from '@/lib/actions/expert-checklist';

function status(overrides: Partial<ChecklistStatus> = {}): ChecklistStatus {
  return {
    items: {
      profile: true,
      phone: true,
      rate: true,
      calendar: true,
      availability: true,
      payouts: true,
    },
    completedCount: 6,
    allComplete: true,
    rateCents: 313,
    availableForWork: true,
    calendarNeedsReconnect: false,
    ...overrides,
  };
}

describe('ExpertDashboard (BAL-566 R2/D13)', () => {
  it('places the Your move rail after the header and before the Up next grid', () => {
    render(
      <ExpertDashboard
        checklistStatus={status()}
        userName="Priya"
        upNext={<div data-testid="up-next" />}
        yourMove={<div data-testid="your-move" />}
      />
    );
    const header = screen.getByText('Welcome back, Priya');
    const yourMove = screen.getByTestId('your-move');
    const upNext = screen.getByTestId('up-next');
    expect(
      header.compareDocumentPosition(yourMove) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(
      yourMove.compareDocumentPosition(upNext) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it('the grid holds upNext, then a column of the Earnings and Clients cards', () => {
    render(
      <ExpertDashboard
        checklistStatus={status()}
        userName="Priya"
        upNext={<div data-testid="up-next" />}
        yourMove={null}
      />
    );
    const upNext = screen.getByTestId('up-next');
    const earnings = screen.getByTestId('earnings');
    const clients = screen.getByTestId('ghost-clients');

    expect(earnings.parentElement).toBe(clients.parentElement);
    expect(upNext.parentElement).toBe(earnings.parentElement?.parentElement);
    const column = [...(earnings.parentElement?.children ?? [])];
    expect(column.indexOf(earnings)).toBeLessThan(column.indexOf(clients));
  });

  it('renders the checklist when incomplete, the celebration card when complete', () => {
    const { rerender } = render(
      <ExpertDashboard
        checklistStatus={status({ allComplete: false })}
        userName="Priya"
        upNext={null}
        yourMove={null}
      />
    );
    expect(screen.getByTestId('checklist')).toBeInTheDocument();

    rerender(
      <ExpertDashboard
        checklistStatus={status({ allComplete: true })}
        userName="Priya"
        upNext={null}
        yourMove={null}
      />
    );
    expect(screen.getByTestId('celebration')).toBeInTheDocument();
  });
});
