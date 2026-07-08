import { describe, it, expect } from 'vitest';
import type { EngagementWithMilestones } from '@balo/db';
import type { EngagementViewerContext, EngagementLens } from './resolve-engagement-lens';
import { mapEngagementToWorkspaceView, DELIVERY_QUIET_THRESHOLD_DAYS } from './engagement-view';

// Deterministic "now" — all date math runs under TZ=UTC (see vitest env).
const NOW = new Date('2026-07-07T00:00:00.000Z');
const KICKOFF = new Date('2026-06-12T00:00:00.000Z');

type Milestone = EngagementWithMilestones['milestones'][number];

function makeMilestone(over: Partial<Milestone> = {}): Milestone {
  return {
    id: 'ms-1',
    engagementId: 'eng-1',
    sourceProposalMilestoneId: null,
    sortOrder: 0,
    title: 'Discovery & solution design',
    descriptionHtml: '<p>Workshops and architecture.</p>',
    acceptanceCriteria: 'Design doc signed off.',
    valueCents: null,
    estimatedMinutes: null,
    status: 'pending',
    startedByUserId: null,
    startedAt: null,
    completedByUserId: null,
    completedAt: null,
    completionNote: null,
    createdByUserId: null,
    createdAt: KICKOFF,
    updatedAt: KICKOFF,
    deletedAt: null,
    ...over,
  } as Milestone;
}

function makeEngagement(over: Partial<EngagementWithMilestones> = {}): EngagementWithMilestones {
  return {
    id: 'eng-1',
    companyId: 'company-northwind',
    expertProfileId: 'expert-priya',
    sourceProposalId: 'prop-1',
    relationshipId: 'rel-1',
    projectRequestId: 'req-1',
    pricingMethod: 'fixed',
    priceCents: 5_800_000,
    currency: 'aud',
    depositCents: null,
    rateCents: null,
    cadence: null,
    billingModel: 'proposal',
    approvalModel: 'admin_invoice',
    status: 'active',
    activatedAt: KICKOFF,
    completionRequestedByUserId: null,
    completionRequestedAt: null,
    acceptedByUserId: null,
    acceptedAt: null,
    acceptanceMethod: null,
    changeRequestNote: null,
    changeRequestedByUserId: null,
    changeRequestedAt: null,
    cancelledByUserId: null,
    cancelledAt: null,
    cancellationReason: null,
    createdAt: KICKOFF,
    updatedAt: KICKOFF,
    deletedAt: null,
    milestones: [],
    expertProfile: {
      id: 'expert-priya',
      agencyId: null,
      type: 'freelancer',
      headline: 'CPQ Specialist',
      user: { id: 'user-priya', firstName: 'Priya', lastName: 'Sharma', avatarUrl: null },
      agency: null,
    },
    company: { id: 'company-northwind', name: 'Northwind Industrial' },
    projectRequest: { id: 'req-1', title: 'CPQ implementation to replace legacy quoting tool' },
    acceptedBy: null,
    changeRequestedBy: null,
    ...over,
  } as EngagementWithMilestones;
}

function ctxFor(lens: EngagementLens): EngagementViewerContext {
  return {
    lens,
    archetype: lens === 'admin' ? 'observer' : 'participant',
    isClientOwner: lens === 'client',
    isDeliveringExpert: lens === 'expert',
  };
}

describe('mapEngagementToWorkspaceView — header & title', () => {
  it('uses the source request title when present', () => {
    const view = mapEngagementToWorkspaceView(makeEngagement(), ctxFor('client'), NOW);
    expect(view.header.engagementTitle).toBe('CPQ implementation to replace legacy quoting tool');
    expect(view.header.provenance).toEqual({ requestId: 'req-1', href: '/projects/req-1' });
  });

  it('retainer fallback: no source request → "Delivery with {expertPartyShort}", no provenance', () => {
    const view = mapEngagementToWorkspaceView(
      makeEngagement({ projectRequestId: null, projectRequest: null }),
      ctxFor('client'),
      NOW
    );
    expect(view.header.engagementTitle).toBe('Delivery with Priya');
    expect(view.header.provenance).toBeNull();
  });

  it('blank request title → "Delivery with {expertPartyShort}" fallback, provenance still non-null', () => {
    const view = mapEngagementToWorkspaceView(
      makeEngagement({ projectRequest: { id: 'req-1', title: '   ' } }),
      ctxFor('client'),
      NOW
    );
    expect(view.header.engagementTitle).toBe('Delivery with Priya');
    // The present-but-empty-title branch still resolves provenance from the request.
    expect(view.header.provenance).toEqual({ requestId: 'req-1', href: '/projects/req-1' });
  });

  it('renders the status chip with the pending_acceptance "Awaiting client review" label', () => {
    const view = mapEngagementToWorkspaceView(
      makeEngagement({ status: 'pending_acceptance', completionRequestedAt: NOW }),
      ctxFor('client'),
      NOW
    );
    expect(view.header.statusChip).toEqual({
      status: 'pending_acceptance',
      label: 'Awaiting client review',
      tone: 'warning',
      icon: 'Clock',
    });
  });
});

describe('mapEngagementToWorkspaceView — terms strip', () => {
  it('pricing pill formats fixed price + whole currency; kicked-off date derived', () => {
    const view = mapEngagementToWorkspaceView(makeEngagement(), ctxFor('client'), NOW);
    const [pricing] = view.header.terms;
    expect(pricing?.value).toBe('Fixed price · A$58,000');
    const kicked = view.header.terms.find((t) => t.label === 'Kicked off');
    expect(kicked?.value).toBe('Kicked off 12 Jun');
  });

  it('timeframe: retainer cadence humanises to "Monthly retainer"', () => {
    const view = mapEngagementToWorkspaceView(
      makeEngagement({ cadence: 'monthly', pricingMethod: 'tm' }),
      ctxFor('client'),
      NOW
    );
    const timeframe = view.header.terms.find((t) => t.label === 'Timeframe');
    expect(timeframe?.value).toBe('Monthly retainer');
  });

  it('timeframe: no cadence → Σ estimatedMinutes → "~Nh estimated"', () => {
    const view = mapEngagementToWorkspaceView(
      makeEngagement({
        cadence: null,
        milestones: [
          makeMilestone({ id: 'm1', estimatedMinutes: 600 }),
          makeMilestone({ id: 'm2', estimatedMinutes: 300 }),
        ],
      }),
      ctxFor('client'),
      NOW
    );
    const timeframe = view.header.terms.find((t) => t.label === 'Timeframe');
    expect(timeframe?.value).toBe('~15h estimated');
  });

  it('timeframe: no cadence and no estimates → pill omitted', () => {
    const view = mapEngagementToWorkspaceView(
      makeEngagement({ cadence: null, milestones: [makeMilestone()] }),
      ctxFor('client'),
      NOW
    );
    expect(view.header.terms.find((t) => t.label === 'Timeframe')).toBeUndefined();
  });
});

describe('mapEngagementToWorkspaceView — progress & milestones', () => {
  it('computes done / total / pct', () => {
    const view = mapEngagementToWorkspaceView(
      makeEngagement({
        milestones: [
          makeMilestone({ id: 'm1', status: 'completed' }),
          makeMilestone({ id: 'm2', status: 'in_progress' }),
          makeMilestone({ id: 'm3', status: 'pending' }),
          makeMilestone({ id: 'm4', status: 'pending' }),
        ],
      }),
      ctxFor('client'),
      NOW
    );
    expect(view.progress).toMatchObject({ done: 1, total: 4, pct: 25 });
    expect(view.progress.reviewCopy).toContain('accept, or request changes within 7 days');
  });

  it('progress reviewCopy is null for the expert lens', () => {
    const view = mapEngagementToWorkspaceView(
      makeEngagement({ milestones: [makeMilestone()] }),
      ctxFor('expert'),
      NOW
    );
    expect(view.progress.reviewCopy).toBeNull();
  });

  it('guards div-by-zero: zero-milestone client engagement → { done: 0, total: 0, pct: 0 }', () => {
    const view = mapEngagementToWorkspaceView(
      makeEngagement({ milestones: [] }),
      ctxFor('client'),
      NOW
    );
    const { done, total, pct } = view.progress;
    expect({ done, total, pct }).toEqual({ done: 0, total: 0, pct: 0 });
  });

  it('client reviewCopy is present on a non-terminal (active) engagement', () => {
    const view = mapEngagementToWorkspaceView(
      makeEngagement({ status: 'active', milestones: [makeMilestone()] }),
      ctxFor('client'),
      NOW
    );
    expect(view.progress.reviewCopy).toContain('accept, or request changes within 7 days');
  });

  it('client reviewCopy is null on a completed engagement (no stale forward-looking caption)', () => {
    const view = mapEngagementToWorkspaceView(
      makeEngagement({
        status: 'completed',
        acceptanceMethod: 'auto',
        acceptedAt: NOW,
        milestones: [makeMilestone({ status: 'completed' })],
      }),
      ctxFor('client'),
      NOW
    );
    expect(view.progress.reviewCopy).toBeNull();
  });

  it('client reviewCopy is null on a cancelled engagement', () => {
    const view = mapEngagementToWorkspaceView(
      makeEngagement({ status: 'cancelled', cancelledAt: NOW, milestones: [makeMilestone()] }),
      ctxFor('client'),
      NOW
    );
    expect(view.progress.reviewCopy).toBeNull();
  });

  it('milestone node carries status, connector fill, and completion attribution by the expert', () => {
    const view = mapEngagementToWorkspaceView(
      makeEngagement({
        milestones: [
          makeMilestone({
            id: 'm1',
            status: 'completed',
            startedAt: new Date('2026-06-16T00:00:00.000Z'),
            completedAt: new Date('2026-06-30T00:00:00.000Z'),
            completionNote: 'Design doc approved.',
            valueCents: 1_450_000,
          }),
        ],
      }),
      ctxFor('client'),
      NOW
    );
    const [node] = view.milestones;
    expect(node?.nodeVariant).toBe('completed');
    expect(node?.statusLabel).toBe('Completed');
    expect(node?.connectorFilled).toBe(true);
    expect(node?.startedLabel).toBe('Started 16 Jun');
    expect(node?.completedLabel).toBe('Completed 30 Jun by Priya');
    expect(node?.completionNote).toBe('Design doc approved.');
    expect(node?.valueLabel).toBe('A$14,500');
    expect(node?.descriptionHtml).toBe('<p>Workshops and architecture.</p>');
    // Plain-text of the description for the expert edit-form prefill.
    expect(node?.descriptionText).toBe('Workshops and architecture.');
  });

  it('derives descriptionText as plain text (and null when the description is blank)', () => {
    const view = mapEngagementToWorkspaceView(
      makeEngagement({
        milestones: [
          makeMilestone({ id: 'm-has', descriptionHtml: '<p>Do the work.</p>' }),
          makeMilestone({ id: 'm-blank', descriptionHtml: null }),
          makeMilestone({ id: 'm-empty', descriptionHtml: '<p></p>' }),
        ],
      }),
      ctxFor('expert'),
      NOW
    );
    const [withText, blank, emptyTags] = view.milestones;
    expect(withText?.descriptionText).toBe('Do the work.');
    expect(blank?.descriptionText).toBeNull();
    // Tag-only HTML has no visible text → null (no phantom prefill).
    expect(emptyTags?.descriptionText).toBeNull();
  });

  it('strips hostile markup from the milestone descriptionHtml (server sanitises for the client)', () => {
    // D2 moved sanitisation into this mapper — the client `MilestoneRow` injects the
    // result via dangerouslySetInnerHTML with NO further sanitise, so a regression to
    // raw HTML here would be a stored-XSS hole. Feed hostile markup and assert it is
    // stripped before it ever reaches the read model.
    const view = mapEngagementToWorkspaceView(
      makeEngagement({
        milestones: [
          makeMilestone({
            descriptionHtml:
              '<p>Legit summary.</p><img src=x onerror="alert(1)"><script>alert(1)</script><a href="javascript:alert(1)">x</a>',
          }),
        ],
      }),
      ctxFor('client'),
      NOW
    );
    const [node] = view.milestones;
    const html = node?.descriptionHtml ?? '';
    // Dangerous tags/attributes are gone.
    expect(html).not.toContain('onerror');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('javascript:');
    // The safe content survives.
    expect(html).toContain('<p>Legit summary.</p>');
  });

  it('pending node has no started/completed labels and an empty connector', () => {
    const view = mapEngagementToWorkspaceView(
      makeEngagement({ milestones: [makeMilestone({ status: 'pending' })] }),
      ctxFor('client'),
      NOW
    );
    const [node] = view.milestones;
    expect(node?.connectorFilled).toBe(false);
    expect(node?.startedLabel).toBeNull();
    expect(node?.completedLabel).toBeNull();
    expect(node?.statusLabel).toBe('Not started');
  });
});

describe('mapEngagementToWorkspaceView — review banner & countdown', () => {
  it('client review banner names the expert (retro) and counts down (clamped)', () => {
    const view = mapEngagementToWorkspaceView(
      makeEngagement({
        status: 'pending_acceptance',
        completionRequestedAt: new Date('2026-07-04T00:00:00.000Z'),
        milestones: [makeMilestone({ status: 'completed' })],
      }),
      ctxFor('client'),
      NOW
    );
    expect(view.reviewBanner?.title).toBe('Priya has marked the project complete');
    // requested 4 Jul + 7 days = 11 Jul; now = 7 Jul → 4 days remaining.
    expect(view.reviewBanner?.countdown).toEqual({
      autoOnDate: '11 Jul 2026',
      daysRemaining: 4,
      autoInLabel: '4 days',
    });
  });

  it('rounds a partial day UP (Math.ceil): 4.4 days remaining → "5 days"', () => {
    // Requested 2.6 days before NOW; auto-accepts 7 days after the request, so
    // 4.4 days remain — Math.ceil pins this to 5 (floor/round would give 4).
    const view = mapEngagementToWorkspaceView(
      makeEngagement({
        status: 'pending_acceptance',
        completionRequestedAt: new Date(NOW.getTime() - 2.6 * 24 * 60 * 60 * 1000),
        milestones: [makeMilestone({ status: 'completed' })],
      }),
      ctxFor('client'),
      NOW
    );
    expect(view.reviewBanner?.countdown?.daysRemaining).toBe(5);
    expect(view.reviewBanner?.countdown?.autoInLabel).toBe('5 days');
  });

  it('countdown clamps to 0 when the window has already elapsed', () => {
    const view = mapEngagementToWorkspaceView(
      makeEngagement({
        status: 'pending_acceptance',
        completionRequestedAt: new Date('2026-06-01T00:00:00.000Z'),
      }),
      ctxFor('expert'),
      NOW
    );
    expect(view.reviewBanner?.countdown?.daysRemaining).toBe(0);
    expect(view.reviewBanner?.countdown?.autoInLabel).toBe('0 days');
  });

  it('expert review banner names the client company, not the person', () => {
    const view = mapEngagementToWorkspaceView(
      makeEngagement({ status: 'pending_acceptance', completionRequestedAt: NOW }),
      ctxFor('expert'),
      NOW
    );
    expect(view.reviewBanner?.title).toBe(
      "Completion requested — awaiting Northwind Industrial's review"
    );
  });

  it('no review banner outside pending_acceptance', () => {
    const view = mapEngagementToWorkspaceView(makeEngagement(), ctxFor('client'), NOW);
    expect(view.reviewBanner).toBeNull();
  });
});

describe('mapEngagementToWorkspaceView — change-request banner', () => {
  it('is null for the client lens (client already knows)', () => {
    const view = mapEngagementToWorkspaceView(
      makeEngagement({ status: 'active', changeRequestNote: 'Tighten the discount logic.' }),
      ctxFor('client'),
      NOW
    );
    expect(view.changeRequestBanner).toBeNull();
  });

  it('attributes the requester @ company for the expert lens and adds the nudge', () => {
    const view = mapEngagementToWorkspaceView(
      makeEngagement({
        status: 'active',
        changeRequestNote: 'Tighten the discount logic.',
        changeRequestedBy: { id: 'u-dana', firstName: 'Dana', lastName: 'Lee' },
      }),
      ctxFor('expert'),
      NOW
    );
    expect(view.changeRequestBanner?.attribution).toBe('Dana @ Northwind Industrial');
    expect(view.changeRequestBanner?.note).toBe('Tighten the discount logic.');
    expect(view.changeRequestBanner?.expertNudge).toContain('mark the project complete again');
  });

  it('admin sees attribution but no expert nudge', () => {
    const view = mapEngagementToWorkspaceView(
      makeEngagement({
        status: 'active',
        changeRequestNote: 'Tighten the discount logic.',
        changeRequestedBy: { id: 'u-dana', firstName: 'Dana', lastName: 'Lee' },
      }),
      ctxFor('admin'),
      NOW
    );
    expect(view.changeRequestBanner?.expertNudge).toBeNull();
  });
});

describe('mapEngagementToWorkspaceView — completed banner attribution', () => {
  it('client-accepted: names the accepting person for expert/admin, first-person for client', () => {
    const engagement = makeEngagement({
      status: 'completed',
      acceptanceMethod: 'client',
      acceptedBy: { id: 'u-dana', firstName: 'Dana', lastName: 'Lee' },
      acceptedAt: new Date('2026-08-30T00:00:00.000Z'),
      milestones: [
        makeMilestone({ status: 'completed' }),
        makeMilestone({ id: 'm2', status: 'completed' }),
      ],
    });
    const expertView = mapEngagementToWorkspaceView(engagement, ctxFor('expert'), NOW);
    expect(expertView.completedBanner?.title).toBe('Project delivered');
    expect(expertView.completedBanner?.body).toContain(
      'accepted by Dana @ Northwind Industrial on 30 Aug 2026'
    );

    const clientView = mapEngagementToWorkspaceView(engagement, ctxFor('client'), NOW);
    expect(clientView.completedBanner?.body).toContain('You accepted the project on 30 Aug 2026');

    const adminView = mapEngagementToWorkspaceView(engagement, ctxFor('admin'), NOW);
    expect(adminView.completedBanner?.readyToInvoice).toBe(true);
    expect(adminView.completedBanner?.body).toContain('2 milestones delivered');
  });

  it('auto-accepted: names the review window, acceptedBy is null', () => {
    const engagement = makeEngagement({
      status: 'completed',
      acceptanceMethod: 'auto',
      acceptedBy: null,
      acceptedAt: new Date('2026-08-30T00:00:00.000Z'),
      milestones: [makeMilestone({ status: 'completed' })],
    });
    const clientView = mapEngagementToWorkspaceView(engagement, ctxFor('client'), NOW);
    expect(clientView.completedBanner?.body).toContain(
      'accepted automatically on 30 Aug 2026 after the 7-day review window'
    );
  });
});

describe('mapEngagementToWorkspaceView — cancelled banner', () => {
  it('attributes cancellation to Balo with the reason', () => {
    const view = mapEngagementToWorkspaceView(
      makeEngagement({
        status: 'cancelled',
        cancelledAt: new Date('2026-07-24T00:00:00.000Z'),
        cancellationReason: 'Programme paused after the acquisition.',
      }),
      ctxFor('client'),
      NOW
    );
    expect(view.cancelledBanner?.body).toBe('Cancelled by Balo on 24 Jul 2026.');
    expect(view.cancelledBanner?.reason).toBe('Programme paused after the acquisition.');
  });
});

describe('mapEngagementToWorkspaceView — empty state', () => {
  it('client empty state is invitation-framed and names the expert party', () => {
    const view = mapEngagementToWorkspaceView(
      makeEngagement({ milestones: [] }),
      ctxFor('client'),
      NOW
    );
    expect(view.hasMilestones).toBe(false);
    expect(view.emptyState?.title).toBe('Priya is shaping the delivery plan');
  });

  it('expert empty state invites the first milestone', () => {
    const view = mapEngagementToWorkspaceView(
      makeEngagement({ milestones: [] }),
      ctxFor('expert'),
      NOW
    );
    expect(view.emptyState?.title).toBe('Shape the delivery plan');
  });

  it('emptyState is null when milestones exist', () => {
    const view = mapEngagementToWorkspaceView(
      makeEngagement({ milestones: [makeMilestone()] }),
      ctxFor('client'),
      NOW
    );
    expect(view.emptyState).toBeNull();
  });

  it('emptyState is null on a completed engagement with zero milestones (terminal banner only)', () => {
    const view = mapEngagementToWorkspaceView(
      makeEngagement({
        status: 'completed',
        acceptanceMethod: 'auto',
        acceptedAt: NOW,
        milestones: [],
      }),
      ctxFor('client'),
      NOW
    );
    expect(view.emptyState).toBeNull();
  });

  it('emptyState is null on a cancelled engagement with zero milestones', () => {
    const view = mapEngagementToWorkspaceView(
      makeEngagement({ status: 'cancelled', cancelledAt: NOW, milestones: [] }),
      ctxFor('client'),
      NOW
    );
    expect(view.emptyState).toBeNull();
  });
});

describe('mapEngagementToWorkspaceView — admin oversight', () => {
  it('flags stalled when the last activity exceeds the quiet threshold', () => {
    const stale = new Date(
      NOW.getTime() - (DELIVERY_QUIET_THRESHOLD_DAYS + 2) * 24 * 60 * 60 * 1000
    );
    const view = mapEngagementToWorkspaceView(
      makeEngagement({ status: 'active', activatedAt: stale, createdAt: stale, milestones: [] }),
      ctxFor('admin'),
      NOW
    );
    expect(view.adminOversight?.stalled).toBe(true);
    expect(view.adminOversight?.stalledNote).toContain('Priya');
  });

  it('is not stalled with recent activity, and null for non-admin lenses', () => {
    const recent = new Date(NOW.getTime() - 2 * 24 * 60 * 60 * 1000);
    const adminView = mapEngagementToWorkspaceView(
      makeEngagement({ status: 'active', activatedAt: recent, createdAt: recent }),
      ctxFor('admin'),
      NOW
    );
    expect(adminView.adminOversight?.stalled).toBe(false);
    expect(adminView.adminOversight?.lastActivityLabel).toBe('Last delivery activity: 2d ago');

    const clientView = mapEngagementToWorkspaceView(makeEngagement(), ctxFor('client'), NOW);
    expect(clientView.adminOversight).toBeNull();
  });

  it('admin oversight is hidden on terminal (completed / cancelled) states', () => {
    const view = mapEngagementToWorkspaceView(
      makeEngagement({ status: 'completed', acceptedAt: NOW, acceptanceMethod: 'auto' }),
      ctxFor('admin'),
      NOW
    );
    expect(view.adminOversight).toBeNull();
  });

  it('a recent milestone completion counts as delivery activity (not stalled) even when activation is stale', () => {
    const stale = new Date(NOW.getTime() - 20 * 24 * 60 * 60 * 1000);
    const recent = new Date(NOW.getTime() - 2 * 24 * 60 * 60 * 1000);
    const view = mapEngagementToWorkspaceView(
      makeEngagement({
        status: 'active',
        activatedAt: stale,
        createdAt: stale,
        milestones: [makeMilestone({ status: 'completed', completedAt: recent })],
      }),
      ctxFor('admin'),
      NOW
    );
    expect(view.adminOversight?.stalled).toBe(false);
    expect(view.adminOversight?.lastActivityLabel).toBe('Last delivery activity: 2d ago');
  });

  it('stalled note names the agency PARTY for an agency expert (not the bare first name)', () => {
    const stale = new Date(
      NOW.getTime() - (DELIVERY_QUIET_THRESHOLD_DAYS + 2) * 24 * 60 * 60 * 1000
    );
    const view = mapEngagementToWorkspaceView(
      makeEngagement({
        status: 'active',
        activatedAt: stale,
        createdAt: stale,
        milestones: [],
        expertProfile: {
          id: 'expert-priya',
          agencyId: 'agency-cloudpeak',
          type: 'agency',
          headline: 'CPQ Specialist',
          user: { id: 'user-priya', firstName: 'Priya', lastName: 'Sharma', avatarUrl: null },
          agency: { id: 'agency-cloudpeak', name: 'CloudPeak Consulting', logoUrl: null },
        },
      }),
      ctxFor('admin'),
      NOW
    );
    expect(view.adminOversight?.stalled).toBe(true);
    expect(view.adminOversight?.stalledNote).toContain('CloudPeak Consulting');
    expect(view.adminOversight?.stalledNote).not.toContain('Priya');
  });
});
