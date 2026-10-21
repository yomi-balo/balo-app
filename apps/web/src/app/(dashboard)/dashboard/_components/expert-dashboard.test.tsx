import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/utils';

vi.mock('./getting-started-checklist', () => ({
  GettingStartedChecklist: () => <div data-testid="checklist" />,
}));
vi.mock('./celebration-card', () => ({
  CelebrationCard: ({ publicProfileHref }: { publicProfileHref: string | null }) => (
    <div data-testid="celebration" data-href={publicProfileHref ?? ''} />
  ),
}));
vi.mock('./earnings-card', () => ({
  EarningsCard: () => <div data-testid="earnings" />,
}));
vi.mock('./ghost-clients-card', () => ({
  GhostClientsCard: () => <div data-testid="ghost-clients" />,
}));

vi.mock('./dashboard-refresh-on-focus', () => ({
  DashboardRefreshOnFocus: () => <div data-testid="refresh-on-focus" />,
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
    searchable: true,
    username: 'dana',
    liveCelebrationSeen: false,
    liveStatus: null,
    ...overrides,
  };
}

describe('ExpertDashboard (BAL-566 R2/D13)', () => {
  it('places Up next after the header and before the Your move rail', () => {
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
    expect(header.compareDocumentPosition(upNext) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(
      upNext.compareDocumentPosition(yourMove) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it('stretches the top-row grid', () => {
    render(
      <ExpertDashboard
        checklistStatus={status()}
        userName="Priya"
        upNext={<div data-testid="up-next" />}
        yourMove={<div data-testid="your-move" />}
      />
    );
    const grid = screen.getByTestId('up-next').parentElement;
    expect(grid).toHaveClass('items-stretch');
    expect(grid).not.toHaveClass('items-start');
  });

  it('keeps the Clients card last in a flex-col side column', () => {
    render(
      <ExpertDashboard
        checklistStatus={status()}
        userName="Priya"
        upNext={<div data-testid="up-next" />}
        yourMove={<div data-testid="your-move" />}
      />
    );
    const column = screen.getByTestId('ghost-clients').parentElement;
    expect(column).toHaveClass('flex-col');
    expect(column?.lastElementChild).toBe(screen.getByTestId('ghost-clients'));
  });

  it('places the checklist before Up next while setup is incomplete', () => {
    render(
      <ExpertDashboard
        checklistStatus={status({ allComplete: false, completedCount: 3 })}
        userName="Priya"
        upNext={<div data-testid="up-next" />}
        yourMove={<div data-testid="your-move" />}
      />
    );
    expect(
      screen.getByTestId('checklist').compareDocumentPosition(screen.getByTestId('up-next')) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it('mounts the refresh-on-focus listener exactly once', () => {
    render(
      <ExpertDashboard
        checklistStatus={status()}
        userName="Priya"
        upNext={<div data-testid="up-next" />}
        yourMove={null}
      />
    );
    expect(screen.getAllByTestId('refresh-on-focus')).toHaveLength(1);
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

  describe('BAL-603 — one-time go-live card', () => {
    const base = { userName: 'Priya', upNext: null, yourMove: null } as const;

    it('shows the card for a complete, unseen expert with the profile href', () => {
      render(<ExpertDashboard {...base} checklistStatus={status()} />);
      expect(screen.getByTestId('celebration')).toHaveAttribute('data-href', '/experts/dana');
    });

    it('passes no href when the expert is not searchable', () => {
      render(<ExpertDashboard {...base} checklistStatus={status({ searchable: false })} />);
      expect(screen.getByTestId('celebration')).toHaveAttribute('data-href', '');
    });

    it('renders neither card nor checklist once seen', () => {
      render(<ExpertDashboard {...base} checklistStatus={status({ liveCelebrationSeen: true })} />);
      expect(screen.queryByTestId('celebration')).not.toBeInTheDocument();
      expect(screen.queryByTestId('checklist')).not.toBeInTheDocument();
    });

    it('keeps the card when the status refreshes to seen after mount', () => {
      const { rerender } = render(<ExpertDashboard {...base} checklistStatus={status()} />);
      rerender(
        <ExpertDashboard {...base} checklistStatus={status({ liveCelebrationSeen: true })} />
      );
      expect(screen.getByTestId('celebration')).toBeInTheDocument();
    });

    it('shows the checklist, not the card, after a post-live regression', () => {
      render(
        <ExpertDashboard
          {...base}
          checklistStatus={status({ allComplete: false, liveCelebrationSeen: true })}
        />
      );
      expect(screen.getByTestId('checklist')).toBeInTheDocument();
      expect(screen.queryByTestId('celebration')).not.toBeInTheDocument();
    });
  });
});
