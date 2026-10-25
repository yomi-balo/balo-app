import { describe, expect, it, vi } from 'vitest';

import { render, screen } from '@/test/utils';
import type { ProjectEngagementWithMilestones } from '@balo/db';
import {
  mapEngagementToWorkspaceView,
  type CompletionCardView,
  type EngagementParties,
  type EngagementProgressView,
  type EngagementWorkspaceView,
  type MilestoneNodeView,
} from '@/lib/engagement/engagement-view';
import type { EngagementLens } from '@/lib/engagement/resolve-engagement-lens';
import type { EndOfCallRatingView } from '@/lib/meetings/end-of-call-view-types';

// The rating card's `RatingBlock` swaps its own content via `StateSwap`
// (`motion/react`, `mode="wait"`) — stubbed the same way `engagement-rating-card.test.tsx`
// stubs it, and `submit-engagement-review` is mocked so rendering the card never pulls
// its `@balo/db`-reaching Server Action module.
vi.mock('motion/react', async () => {
  const { createMotionStub } = await import('@/test/motion-stub');
  return createMotionStub();
});
vi.mock('@/app/(dashboard)/engagements/[id]/_actions/submit-engagement-review', () => ({
  submitEngagementReviewAction: vi.fn(),
}));

// Stub the interactive expert rail so this composition test doesn't pull the
// server-action module graph (@balo/db); its behaviour is covered in
// expert-milestone-rail.test.tsx.
vi.mock('./expert-milestone-rail', () => ({
  ExpertMilestoneRail: () => <div data-testid="expert-milestone-rail">Interactive rail</div>,
}));

// The D4 lifecycle islands (review-banner-actions, admin-cancel-button,
// expert-completion-card) call the shared hook (useRouter + toast) and import the
// lifecycle Server Actions. Mock the router/toast and the action modules so this
// composition test never pulls @balo/db through them.
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('@/app/(dashboard)/engagements/[id]/_actions/request-completion', () => ({
  requestCompletionAction: vi.fn(),
}));
vi.mock('@/app/(dashboard)/engagements/[id]/_actions/withdraw-completion-request', () => ({
  withdrawCompletionRequestAction: vi.fn(),
}));
vi.mock('@/app/(dashboard)/engagements/[id]/_actions/cancel-engagement', () => ({
  cancelEngagementAction: vi.fn(),
}));
vi.mock('@/app/(dashboard)/engagements/[id]/_actions/accept-project', () => ({
  acceptProjectAction: vi.fn(),
}));
vi.mock('@/app/(dashboard)/engagements/[id]/_actions/request-changes', () => ({
  requestProjectChangesAction: vi.fn(),
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
    descriptionText: null,
    acceptanceCriteria: null,
    status: 'completed',
    nodeVariant: 'completed',
    statusLabel: 'Completed',
    connectorFilled: true,
    valueLabel: 'A$14,500',
    startedLabel: 'Started 16 Jun',
    completedLabel: 'Completed 30 Jun by Priya',
    completionNote: 'Delivered the discovery deck.',
    feedback: null,
    ...overrides,
  };
}

function progress(overrides: Partial<EngagementProgressView> = {}): EngagementProgressView {
  return {
    done: 0,
    total: 0,
    pct: 0,
    reviewCopy: null,
    reviewPill: null,
    segments: [],
    ...overrides,
  };
}

function completionCard(overrides: Partial<CompletionCardView> = {}): CompletionCardView {
  return {
    hasMilestones: true,
    milestonesRemaining: 0,
    milestonesTotal: 2,
    canRequest: true,
    bodyCopy: 'Every milestone is delivered.',
    modalBody: 'All 2 milestones are delivered.',
    ctaLabel: 'Mark project ready',
    ...overrides,
  };
}

const EXPERT_LENS: Partial<EngagementWorkspaceView> = {
  lens: 'expert',
  archetype: 'participant',
  isClientOwner: false,
  isDeliveringExpert: true,
};

const NOW = new Date('2026-07-07T00:00:00.000Z');
const THEN = new Date('2026-06-12T00:00:00.000Z');

/**
 * A workspace view built by the real server-side derivation, so a regression in how the
 * banner and the completion card are wired together fails here rather than being hidden
 * by a hand-built fixture.
 */
function mappedView(
  lens: EngagementLens,
  statuses: readonly ('completed' | 'in_progress')[],
  withRound = true
): EngagementWorkspaceView {
  const round = {
    id: 'cr-1',
    note: 'Fix the totals.',
    requestedAt: THEN,
    requestedBy: { id: 'u-dana', firstName: 'Dana', lastName: 'Lee' },
    taggedMilestoneIds: ['ms-1', 'ms-2'],
  };
  const engagement = {
    id: 'eng-1',
    status: 'active',
    pricingMethod: 'fixed',
    priceCents: 5_800_000,
    baloFeeBps: 0,
    currency: 'aud',
    depositCents: null,
    rateCents: null,
    cadence: null,
    activatedAt: THEN,
    completionRequestedAt: null,
    acceptedAt: null,
    acceptanceMethod: null,
    cancelledAt: null,
    cancellationReason: null,
    createdAt: THEN,
    updatedAt: THEN,
    milestones: statuses.map((status, index) => ({
      id: `ms-${index + 1}`,
      title: `Milestone ${index + 1}`,
      sortOrder: index,
      descriptionHtml: null,
      acceptanceCriteria: null,
      valueCents: null,
      estimatedMinutes: null,
      status,
      startedAt: null,
      completedAt: status === 'completed' ? THEN : null,
      completionNote: null,
    })),
    expertProfile: {
      id: 'expert-priya',
      agencyId: null,
      type: 'freelancer',
      headline: 'CPQ Specialist',
      user: { id: 'user-priya', firstName: 'Priya', lastName: 'Sharma', avatarUrl: null },
      agency: null,
    },
    company: { id: 'company-northwind', name: 'Northwind Industrial' },
    projectRequest: { id: 'req-1', title: 'CPQ implementation' },
    changeRequestRounds: withRound ? [round] : [],
    latestChangeRequest: withRound ? round : null,
    changeRequestRoundCount: withRound ? 1 : 0,
  } as unknown as ProjectEngagementWithMilestones;
  return mapEngagementToWorkspaceView(
    engagement,
    {
      lens,
      archetype: 'participant',
      isClientOwner: lens === 'client',
      isDeliveringExpert: lens === 'expert',
    },
    NOW
  );
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
    progress: progress({ done: 1, total: 2, pct: 50 }),
    milestones: [milestone({ id: 'a' }), milestone({ id: 'b', title: 'Build integration' })],
    hasMilestones: true,
    reviewBanner: null,
    changeRequestBanner: null,
    completedBanner: null,
    cancelledBanner: null,
    emptyState: null,
    adminOversight: null,
    completionCard: null,
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
  it('read-only empty state renders and rail/progress are absent when hasMilestones is false', () => {
    render(
      <EngagementWorkspace
        view={view({
          lens: 'client',
          archetype: 'participant',
          isClientOwner: true,
          isDeliveringExpert: false,
          milestones: [],
          hasMilestones: false,
          progress: progress({ done: 0, total: 0, pct: 0 }),
          emptyState: {
            icon: 'Flag',
            title: 'Shape the delivery plan',
            body: 'Add your first milestone so Northwind Industrial can follow progress.',
          },
        })}
      />
    );
    expect(screen.getByText('Shape the delivery plan')).toBeInTheDocument();
    expect(screen.queryByTestId('expert-milestone-rail')).not.toBeInTheDocument();
    expect(screen.queryByText('Delivery plan')).not.toBeInTheDocument();
    expect(screen.queryByText('milestones completed')).not.toBeInTheDocument();
  });

  it('expert lens · active · EMPTY routes to the interactive rail (owns the add-first CTA), no progress bar', () => {
    render(
      <EngagementWorkspace
        view={view({
          lens: 'expert',
          archetype: 'participant',
          isClientOwner: false,
          isDeliveringExpert: true,
          milestones: [],
          hasMilestones: false,
          progress: progress({ done: 0, total: 0, pct: 0 }),
          emptyState: {
            icon: 'Flag',
            title: 'Shape the delivery plan',
            body: 'Add your first milestone so Northwind Industrial can follow progress.',
          },
        })}
      />
    );
    // The interactive island (stubbed) owns the empty case now — not the read-only state.
    expect(screen.getByTestId('expert-milestone-rail')).toBeInTheDocument();
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
            countdown: {
              autoOnDate: '11 Jul 2026',
              daysRemaining: 5,
              autoInLabel: 'Auto-accepts in 5 days',
            },
            clientDecision: null,
            lastRequest: null,
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
          ...EXPERT_LENS,
          changeRequestBanner: {
            variant: 'work_outstanding',
            headline: 'Dana @ Northwind Industrial requested changes on Build.',
            quote: 'Please revisit the reporting section.',
            guidance: 'Build is back in progress.',
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
            clientCta: null,
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

  it('expert lens · active renders the "Finish the project" completion card when present', () => {
    render(
      <EngagementWorkspace
        view={view({
          lens: 'expert',
          archetype: 'participant',
          isClientOwner: false,
          isDeliveringExpert: true,
          completionCard: completionCard(),
        })}
      />
    );
    expect(screen.getByText('Finish the project')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Mark project ready/i })).toBeEnabled();
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

describe('EngagementWorkspace — one "Mark project ready" control at a time', () => {
  const READY_BUTTON = { name: /Mark project ready/i };

  it('changes_made banner carries the control and the completion card is absent', () => {
    const mapped = mappedView('expert', ['completed', 'completed']);
    expect(mapped.changeRequestBanner).toMatchObject({ variant: 'changes_made' });
    render(<EngagementWorkspace view={mapped} />);
    expect(screen.getAllByRole('button', READY_BUTTON)).toHaveLength(1);
    expect(screen.getByText(/Changes made\. Ready to send back/)).toBeInTheDocument();
    expect(screen.queryByText('Finish the project')).not.toBeInTheDocument();
  });

  it('work_outstanding banner has no CTA; the completion card is the only control', () => {
    render(
      <EngagementWorkspace
        view={view({
          ...EXPERT_LENS,
          changeRequestBanner: {
            variant: 'work_outstanding',
            headline: 'Dana @ Northwind Industrial requested changes.',
            quote: 'Fix the totals.',
            guidance: 'Finish the remaining milestones, then mark the project ready again.',
          },
          completionCard: completionCard({
            canRequest: false,
            milestonesRemaining: 1,
            ctaLabel: 'Mark project ready again',
          }),
        })}
      />
    );
    expect(screen.getAllByRole('button', READY_BUTTON)).toHaveLength(1);
    expect(screen.getByRole('button', READY_BUTTON)).toBeDisabled();
  });

  it('client_waiting banner renders its body and no control', () => {
    render(
      <EngagementWorkspace
        view={view({
          changeRequestBanner: {
            variant: 'client_waiting',
            body: 'You requested changes on Build. Priya is working on them.',
          },
        })}
      />
    );
    expect(screen.getByText(/You requested changes on Build/)).toBeInTheDocument();
    expect(screen.queryAllByRole('button', READY_BUTTON)).toHaveLength(0);
  });

  it('shows exactly one control across every state the real view derivation produces', () => {
    const scenarios: [EngagementLens, readonly ('completed' | 'in_progress')[], boolean][] = [
      ['expert', ['completed', 'completed'], false],
      ['expert', ['completed', 'in_progress'], false],
      ['expert', ['completed', 'completed'], true],
      ['expert', ['completed', 'in_progress'], true],
    ];
    for (const [lens, statuses, withRound] of scenarios) {
      const { unmount } = render(
        <EngagementWorkspace view={mappedView(lens, statuses, withRound)} />
      );
      expect(screen.getAllByRole('button', READY_BUTTON)).toHaveLength(1);
      unmount();
    }
  });
});

describe('EngagementWorkspace — the in-app rating card', () => {
  const RATING: EndOfCallRatingView = {
    engagementId: 'eng-1',
    state: { kind: 'none' },
    existingBody: null,
  };

  it('renders the rating card heading after the completed banner when rating is non-null', () => {
    render(
      <EngagementWorkspace
        view={view({
          status: 'completed',
          completedBanner: {
            title: 'Project completed',
            body: 'The project was accepted automatically.',
            readyToInvoice: false,
            clientCta: {
              messageHref: '/projects/req-1',
              messagePersonLabel: 'Priya Sharma',
            },
          },
        })}
        rating={RATING}
      />
    );
    const banner = screen.getByText('Project completed');
    const heading = screen.getByText('How was working with Priya?');
    expect(banner.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('renders no rating heading or radio group when rating is omitted', () => {
    render(<EngagementWorkspace view={view({ status: 'completed' })} />);
    expect(screen.queryByText(/How was working with/)).not.toBeInTheDocument();
    expect(screen.queryAllByRole('radio')).toHaveLength(0);
  });
});
