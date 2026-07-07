import { describe, expect, it, vi } from 'vitest';

import { render, screen } from '@/test/utils';
import type {
  EngagementParties,
  EngagementWorkspaceView,
  MilestoneNodeView,
} from '@/lib/engagement/engagement-view';

// Stub the interactive expert rail so this composition test doesn't pull the
// server-action module graph (@balo/db); its behaviour is covered in
// expert-milestone-rail.test.tsx.
vi.mock('./expert-milestone-rail', () => ({
  ExpertMilestoneRail: () => <div data-testid="expert-milestone-rail">Interactive rail</div>,
}));

import { EngagementWorkspace } from './engagement-workspace';

// `motion/react` renders its children synchronously in jsdom, so `<Reveal>`
// wrapped sections are queryable without waiting on the entrance animation.

function parties(overrides: Partial<EngagementParties> = {}): EngagementParties {
  return {
    isAgencyExpert: false,
    expertPerson: 'Priya Sharma',
    expertPersonShort: 'Priya',
    expertParty: 'Priya Sharma',
    expertPartyShort: 'Priya',
    expertHeadline: 'Salesforce CPQ specialist',
    expertRetroFirstMention: 'Priya',
    clientCompanyName: 'Northwind Industrial',
    ...overrides,
  };
}

function milestone(overrides: Partial<MilestoneNodeView> = {}): MilestoneNodeView {
  return {
    id: 'm-1',
    title: 'Discovery workshop',
    descriptionHtml: null,
    acceptanceCriteria: null,
    status: 'completed',
    nodeVariant: 'completed',
    statusLabel: 'Completed',
    connectorFilled: true,
    valueLabel: 'A$14,500',
    startedLabel: 'Started 16 Jun',
    completedLabel: 'Completed 30 Jun by Priya',
    completionNote: 'Delivered the discovery deck.',
    ...overrides,
  };
}

function view(overrides: Partial<EngagementWorkspaceView> = {}): EngagementWorkspaceView {
  return {
    engagementId: 'eng-1',
    lens: 'client',
    archetype: 'participant',
    status: 'active',
    isClientOwner: true,
    isDeliveringExpert: false,
    header: {
      engagementTitle: 'CPQ implementation',
      headerLine: 'Delivery with Priya',
      statusChip: { status: 'active', label: 'Active', tone: 'success', icon: 'Layers' },
      provenance: { requestId: 'req-1', href: '/projects/req-1' },
      terms: [{ icon: 'DollarSign', label: 'Pricing', value: 'Fixed price · A$58,000' }],
      backHref: '/projects',
    },
    parties: parties(),
    progress: { done: 1, total: 2, pct: 50, reviewCopy: null },
    milestones: [milestone({ id: 'a' }), milestone({ id: 'b', title: 'Build integration' })],
    hasMilestones: true,
    reviewBanner: null,
    changeRequestBanner: null,
    completedBanner: null,
    cancelledBanner: null,
    emptyState: null,
    adminOversight: null,
    ...overrides,
  };
}

describe('EngagementWorkspace — composition', () => {
  it('always renders the header title and the milestone rail when milestones exist', () => {
    render(<EngagementWorkspace view={view()} />);
    expect(screen.getByRole('heading', { name: /CPQ implementation/i })).toBeInTheDocument();
    expect(screen.getByText('Delivery plan')).toBeInTheDocument();
    expect(screen.getByText('Discovery workshop')).toBeInTheDocument();
  });

  it('renders the progress card only when there are milestones', () => {
    render(<EngagementWorkspace view={view()} />);
    expect(screen.getByText('milestones completed')).toBeInTheDocument();
  });
});

describe('EngagementWorkspace — state × lens matrix', () => {
  it('empty state renders and rail/progress are absent when hasMilestones is false', () => {
    render(
      <EngagementWorkspace
        view={view({
          lens: 'expert',
          archetype: 'participant',
          isClientOwner: false,
          isDeliveringExpert: true,
          milestones: [],
          hasMilestones: false,
          progress: { done: 0, total: 0, pct: 0, reviewCopy: null },
          emptyState: {
            icon: 'Flag',
            title: 'Shape the delivery plan',
            body: 'Add your first milestone so Northwind Industrial can follow progress.',
          },
        })}
      />
    );
    expect(screen.getByText('Shape the delivery plan')).toBeInTheDocument();
    expect(screen.queryByText('Delivery plan')).not.toBeInTheDocument();
    expect(screen.queryByText('milestones completed')).not.toBeInTheDocument();
  });

  it('client lens · pending_acceptance renders the review banner', () => {
    render(
      <EngagementWorkspace
        view={view({
          status: 'pending_acceptance',
          header: {
            ...view().header,
            statusChip: {
              status: 'pending_acceptance',
              label: 'Awaiting client review',
              tone: 'warning',
              icon: 'Clock',
            },
          },
          reviewBanner: {
            title: 'Priya has marked the project complete',
            body: 'Review the delivery plan below, then accept or request changes.',
            countdown: { autoOnDate: '11 Jul 2026', daysRemaining: 5, autoInLabel: '5 days' },
          },
        })}
      />
    );
    expect(screen.getByText('Priya has marked the project complete')).toBeInTheDocument();
    expect(screen.getByText(/Auto-accepts in 5 days/i)).toBeInTheDocument();
  });

  it('expert lens · active with a change request renders the change-request banner', () => {
    render(
      <EngagementWorkspace
        view={view({
          lens: 'expert',
          archetype: 'participant',
          isClientOwner: false,
          isDeliveringExpert: true,
          changeRequestBanner: {
            attribution: 'Dana @ Northwind Industrial',
            note: 'Please revisit the reporting section.',
            expertNudge: '— fix it up and mark the project complete again when ready.',
          },
        })}
      />
    );
    expect(screen.getByText(/Dana @ Northwind Industrial/)).toBeInTheDocument();
    expect(screen.getByText(/Please revisit the reporting section\./)).toBeInTheDocument();
  });

  it('completed status renders the completed banner (expert lens)', () => {
    render(
      <EngagementWorkspace
        view={view({
          lens: 'expert',
          isClientOwner: false,
          isDeliveringExpert: true,
          status: 'completed',
          completedBanner: {
            title: 'Project delivered',
            body: 'All 2 milestones delivered and the project accepted.',
            readyToInvoice: false,
          },
        })}
      />
    );
    expect(screen.getByText('Project delivered')).toBeInTheDocument();
  });

  it('cancelled status renders the cancelled banner with the reason', () => {
    render(
      <EngagementWorkspace
        view={view({
          status: 'cancelled',
          cancelledBanner: {
            title: 'Engagement cancelled',
            body: 'Cancelled by Balo on 30 Aug 2026.',
            reason: 'Client changed direction.',
          },
        })}
      />
    );
    expect(screen.getByText('Engagement cancelled')).toBeInTheDocument();
    expect(screen.getByText(/Client changed direction\./)).toBeInTheDocument();
  });

  it('expert lens · active renders the INTERACTIVE rail (not the read-only rail)', () => {
    render(
      <EngagementWorkspace
        view={view({
          lens: 'expert',
          archetype: 'participant',
          isClientOwner: false,
          isDeliveringExpert: true,
        })}
      />
    );
    expect(screen.getByTestId('expert-milestone-rail')).toBeInTheDocument();
    // The read-only rail (which renders the milestone titles) is NOT used here.
    expect(screen.queryByText('Discovery workshop')).not.toBeInTheDocument();
  });

  it('expert lens · pending_acceptance renders the READ-ONLY rail (plan locked in review)', () => {
    render(
      <EngagementWorkspace
        view={view({
          lens: 'expert',
          archetype: 'participant',
          isClientOwner: false,
          isDeliveringExpert: true,
          status: 'pending_acceptance',
        })}
      />
    );
    expect(screen.queryByTestId('expert-milestone-rail')).not.toBeInTheDocument();
    expect(screen.getByText('Delivery plan')).toBeInTheDocument();
    expect(screen.getAllByText('Discovery workshop').length).toBeGreaterThan(0);
  });

  it('admin lens renders the oversight strip above the progress/rail', () => {
    render(
      <EngagementWorkspace
        view={view({
          lens: 'admin',
          archetype: 'observer',
          isClientOwner: false,
          adminOversight: {
            lastActivityLabel: 'Last delivery activity: 2d ago',
            stalled: false,
            stalledNote: null,
          },
        })}
      />
    );
    expect(screen.getByText('Oversight')).toBeInTheDocument();
    expect(screen.getByText('Last delivery activity: 2d ago')).toBeInTheDocument();
  });
});
