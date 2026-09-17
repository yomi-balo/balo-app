import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/utils';

vi.mock('./getting-started-checklist', () => ({
  GettingStartedChecklist: () => <div data-testid="checklist" />,
}));
vi.mock('./celebration-card', () => ({
  CelebrationCard: () => <div data-testid="celebration" />,
}));
vi.mock('./metric-cards', () => ({
  MetricCards: () => <div data-testid="metric-cards" />,
}));
vi.mock('./ghost-clients-card', () => ({
  GhostClientsCard: () => <div data-testid="ghost-clients" />,
}));
vi.mock('./calendar-disconnected-banner', () => ({
  CalendarDisconnectedBanner: () => <div data-testid="banner" />,
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
    calendarNeedsReconnect: false,
    ...overrides,
  };
}

describe('ExpertDashboard (BAL-566 R2/D13)', () => {
  it('shows the banner only when calendarNeedsReconnect is true, and it is the first element', () => {
    render(
      <ExpertDashboard
        checklistStatus={status({ calendarNeedsReconnect: true })}
        userName="Priya"
        upNext={<div data-testid="up-next" />}
      />
    );
    const container = screen.getByTestId('banner').closest('div')?.parentElement;
    expect(screen.getByTestId('banner')).toBeInTheDocument();
    expect(container?.firstElementChild).toBe(screen.getByTestId('banner'));
  });

  it('hides the banner when calendarNeedsReconnect is false', () => {
    render(
      <ExpertDashboard
        checklistStatus={status({ calendarNeedsReconnect: false })}
        userName="Priya"
        upNext={<div data-testid="up-next" />}
      />
    );
    expect(screen.queryByTestId('banner')).toBeNull();
  });

  it('hides the banner when checklistStatus is null', () => {
    render(
      <ExpertDashboard
        checklistStatus={null}
        userName="Priya"
        upNext={<div data-testid="up-next" />}
      />
    );
    expect(screen.queryByTestId('banner')).toBeNull();
  });

  it('the grid holds upNext then the Clients card, and MetricCards sits after the grid', () => {
    render(
      <ExpertDashboard
        checklistStatus={status()}
        userName="Priya"
        upNext={<div data-testid="up-next">Up next slot</div>}
      />
    );
    const upNext = screen.getByTestId('up-next');
    const clients = screen.getByTestId('ghost-clients');
    const metrics = screen.getByTestId('metric-cards');

    // Same grid parent, upNext before clients.
    expect(upNext.parentElement).toBe(clients.parentElement);
    const gridChildren = [...(upNext.parentElement?.children ?? [])];
    expect(gridChildren.indexOf(upNext)).toBeLessThan(gridChildren.indexOf(clients));

    // MetricCards is a sibling AFTER the grid in document order.
    expect(upNext.compareDocumentPosition(metrics) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('renders the checklist when incomplete, the celebration card when complete', () => {
    const { rerender } = render(
      <ExpertDashboard
        checklistStatus={status({ allComplete: false })}
        userName="Priya"
        upNext={null}
      />
    );
    expect(screen.getByTestId('checklist')).toBeInTheDocument();

    rerender(
      <ExpertDashboard
        checklistStatus={status({ allComplete: true })}
        userName="Priya"
        upNext={null}
      />
    );
    expect(screen.getByTestId('celebration')).toBeInTheDocument();
  });
});
