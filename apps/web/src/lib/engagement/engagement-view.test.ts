import { describe, it, expect } from 'vitest';
import type { ProjectEngagementWithMilestones } from '@balo/db';
import type { EngagementViewerContext, EngagementLens } from './resolve-engagement-lens';
import { makeLine, makeOrder } from '@/test/change-order-fixtures';
import {
  mapEngagementToWorkspaceView,
  offersRatingCard,
  type EngagementWorkspaceStatus,
} from './engagement-view';

// Deterministic "now" — all date math runs under TZ=UTC (see vitest env).
const NOW = new Date('2026-07-07T00:00:00.000Z');
const KICKOFF = new Date('2026-06-12T00:00:00.000Z');

type Milestone = ProjectEngagementWithMilestones['milestones'][number];

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
    contentEditedAt: null,
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

function makeEngagement(
  over: Partial<ProjectEngagementWithMilestones> = {}
): ProjectEngagementWithMilestones {
  return {
    id: 'eng-1',
    companyId: 'company-northwind',
    expertProfileId: 'expert-priya',
    sourceProposalId: 'prop-1',
    relationshipId: 'rel-1',
    projectRequestId: 'req-1',
    pricingMethod: 'fixed',
    priceCents: 5_800_000,
    // Fee-neutral by default so unrelated currency assertions read the raw quote;
    // the three-lens gross-up tests override this to a non-zero bps.
    baloFeeBps: 0,
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
    changeRequestRounds: [],
    latestChangeRequest: null,
    changeRequestRoundCount: 0,
    ...over,
  } as ProjectEngagementWithMilestones;
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

  it('pricing pill: the tm arm reads "Time & materials" — lower-case m, as shipped', () => {
    // BAL-392 (F5): this strip now reads the SHARED `pricingMethodLabel`, so a copy change
    // made "for the proposal" would silently restate an ACCEPTED engagement's terms. Both
    // arms are pinned so such a change cannot land unnoticed. The lower-case `m` is the
    // ONE spelling — the proposal header pills read the same helper, so nothing on a
    // client surface still says capital-M `Time & Materials`.
    const view = mapEngagementToWorkspaceView(
      makeEngagement({ pricingMethod: 'tm' }),
      ctxFor('client'),
      NOW
    );
    const [pricing] = view.header.terms;
    expect(pricing?.label).toBe('Pricing');
    expect(pricing?.value).toBe('Time & materials');
  });

  it.each(['client', 'expert', 'admin'] as const)(
    'time and materials terms are the method, the billing cadence and the kickoff — no amount (%s)',
    (lens) => {
      const view = mapEngagementToWorkspaceView(
        makeEngagement({ pricingMethod: 'tm', cadence: 'monthly', rateCents: 15_000 }),
        ctxFor(lens),
        NOW
      );
      const terms = view.header.terms.filter((t) => t.label !== 'Last delivery activity');
      expect(terms.map((t) => t.value)).toEqual([
        'Time & materials',
        'Billed monthly',
        'Kicked off 12 Jun',
      ]);
      expect(terms[1]).toMatchObject({ icon: 'Receipt', label: 'Billing' });
      expect(JSON.stringify(view.header.terms)).not.toMatch(/A\$|\$|AUD/);
    }
  );

  it('time and materials with a fortnightly cadence reads "Billed fortnightly"', () => {
    const view = mapEngagementToWorkspaceView(
      makeEngagement({ pricingMethod: 'tm', cadence: 'fortnightly' }),
      ctxFor('client'),
      NOW
    );
    expect(view.header.terms.map((t) => t.value)).toContain('Billed fortnightly');
  });

  it('time and materials without a cadence omits the billing chip and the timeframe', () => {
    const view = mapEngagementToWorkspaceView(
      makeEngagement({
        pricingMethod: 'tm',
        cadence: null,
        milestones: [makeMilestone({ estimatedMinutes: 600 })],
      }),
      ctxFor('client'),
      NOW
    );
    expect(view.header.terms.map((t) => t.value)).toEqual([
      'Time & materials',
      'Kicked off 12 Jun',
    ]);
  });

  it('timeframe: a fixed-price retainer cadence humanises to "Monthly retainer"', () => {
    const view = mapEngagementToWorkspaceView(
      makeEngagement({ cadence: 'monthly', pricingMethod: 'fixed' }),
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

describe('mapEngagementToWorkspaceView — Balo fee gross-up (client lens only)', () => {
  // priceCents 5_800_000 @ 2500 bps → applyBaloFee grosses UP by 25% = 7_250_000.
  const withFee = makeEngagement({
    baloFeeBps: 2500,
    priceCents: 5_800_000,
    milestones: [makeMilestone({ id: 'm1', valueCents: 1_450_000 })],
  });

  const pricingValue = (lens: EngagementLens): string | undefined =>
    mapEngagementToWorkspaceView(withFee, ctxFor(lens), NOW).header.terms.find(
      (t) => t.label === 'Pricing'
    )?.value;

  const milestoneValue = (lens: EngagementLens): string | null | undefined =>
    mapEngagementToWorkspaceView(withFee, ctxFor(lens), NOW).milestones[0]?.valueLabel;

  it('Pricing pill: client sees the grossed-up figure', () => {
    // applyBaloFee(5_800_000, 2500) = 7_250_000 → A$72,500.
    expect(pricingValue('client')).toBe('Fixed price · A$72,500');
  });

  it('Pricing pill: expert & admin see the raw payout quote', () => {
    expect(pricingValue('expert')).toBe('Fixed price · A$58,000');
    expect(pricingValue('admin')).toBe('Fixed price · A$58,000');
  });

  it('milestone value: client sees the grossed-up figure', () => {
    // applyBaloFee(1_450_000, 2500) = 1_812_500 → A$18,125.
    expect(milestoneValue('client')).toBe('A$18,125');
  });

  it('milestone value: expert & admin see the raw value', () => {
    expect(milestoneValue('expert')).toBe('A$14,500');
    expect(milestoneValue('admin')).toBe('A$14,500');
  });

  it('never emits baloFeeBps / a fee field on the view model for ANY lens', () => {
    for (const lens of ['client', 'expert', 'admin'] as const) {
      const view = mapEngagementToWorkspaceView(withFee, ctxFor(lens), NOW);
      // Top-level, header, terms items, and milestone nodes carry formatted strings
      // only — the raw fee/bps must never leak into the serialized contract.
      expect(view).not.toHaveProperty('baloFeeBps');
      expect(view).not.toHaveProperty('fee');
      expect(view.header).not.toHaveProperty('baloFeeBps');
      for (const item of view.header.terms) {
        expect(item).not.toHaveProperty('baloFeeBps');
        expect(item).not.toHaveProperty('fee');
      }
      const [node] = view.milestones;
      expect(node).not.toHaveProperty('baloFeeBps');
      expect(node).not.toHaveProperty('fee');
    }
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

  it('client reviewCopy steps aside while a change request is outstanding', () => {
    const latest = {
      id: 'cr-1',
      note: 'Tighten the discount logic.',
      requestedAt: KICKOFF,
      requestedBy: { id: 'u-dana', firstName: 'Dana', lastName: 'Lee' },
      taggedMilestoneIds: [],
    };
    const view = mapEngagementToWorkspaceView(
      makeEngagement({
        status: 'active',
        milestones: [makeMilestone()],
        changeRequestRounds: [latest],
        latestChangeRequest: latest,
        changeRequestRoundCount: 1,
      } as Partial<ProjectEngagementWithMilestones>),
      ctxFor('client'),
      NOW
    );
    expect(view.changeRequestBanner).toMatchObject({ variant: 'client_waiting' });
    expect(view.progress.reviewCopy).toBeNull();
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

describe('mapEngagementToWorkspaceView — review banner', () => {
  it('client review banner names the expert (retro) and states the auto-accept date', () => {
    const view = mapEngagementToWorkspaceView(
      makeEngagement({
        status: 'pending_acceptance',
        completionRequestedAt: new Date('2026-07-04T00:00:00.000Z'),
        milestones: [makeMilestone({ status: 'completed' })],
      }),
      ctxFor('client'),
      NOW
    );
    expect(view.reviewBanner?.title).toBe('Priya says the project is ready');
    // requested 4 Jul + 7 days = 11 Jul.
    expect(view.reviewBanner?.autoAcceptOn).toBe('11 Jul 2026');
    expect(view.reviewBanner?.body).toBe(
      "Have a look through the milestones below, then accept the project or request changes. If you don't respond, it's accepted on 11 Jul 2026."
    );
  });

  it('carries no countdown wording in any lens', () => {
    const pending = makeEngagement({
      status: 'pending_acceptance',
      completionRequestedAt: new Date('2026-07-04T00:00:00.000Z'),
    });
    for (const lens of ['client', 'expert', 'admin'] as const) {
      const banner = mapEngagementToWorkspaceView(pending, ctxFor(lens), NOW).reviewBanner;
      expect(banner).not.toHaveProperty('countdown');
      expect(`${banner?.title} ${banner?.body}`).not.toMatch(/Auto-accepts/i);
    }
  });

  it('expert and admin bodies state the date and the final invoice', () => {
    const pending = makeEngagement({
      status: 'pending_acceptance',
      completionRequestedAt: new Date('2026-07-04T00:00:00.000Z'),
    });
    expect(mapEngagementToWorkspaceView(pending, ctxFor('expert'), NOW).reviewBanner?.body).toBe(
      "Requested 4 Jul. The delivery plan is locked while the project is in review. If Northwind Industrial doesn't respond, it's accepted on 11 Jul 2026 and the final invoice is raised then."
    );
    expect(mapEngagementToWorkspaceView(pending, ctxFor('admin'), NOW).reviewBanner?.body).toBe(
      "Requested 4 Jul by Priya. If Northwind Industrial doesn't respond, it's accepted on 11 Jul 2026 and the final invoice is raised then."
    );
  });

  it('falls back to the end of the review window when the request date is missing', () => {
    const view = mapEngagementToWorkspaceView(
      makeEngagement({ status: 'pending_acceptance', completionRequestedAt: null }),
      ctxFor('client'),
      NOW
    );
    expect(view.reviewBanner?.autoAcceptOn).toBeNull();
    expect(view.reviewBanner?.body).toContain("it's accepted at the end of the review window.");
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

  it('client review banner carries the accept + request-changes decision copy (D7)', () => {
    const pending = makeEngagement({ status: 'pending_acceptance', completionRequestedAt: NOW });
    const clientDecision = mapEngagementToWorkspaceView(pending, ctxFor('client'), NOW).reviewBanner
      ?.clientDecision;
    expect(clientDecision).not.toBeNull();
    expect(clientDecision?.acceptModalBody).toContain("can't be un-accepted");
    expect(clientDecision?.acceptModalBody).toContain('Balo raises the final invoice');
    expect(clientDecision?.requestChangesIntro).toContain('7-day review window restarts');
    expect(clientDecision?.requestChangesFieldHint).toContain('Priya');
  });

  it('expert/admin review banners carry no client decision copy', () => {
    const pending = makeEngagement({ status: 'pending_acceptance', completionRequestedAt: NOW });
    expect(
      mapEngagementToWorkspaceView(pending, ctxFor('expert'), NOW).reviewBanner?.clientDecision
    ).toBeNull();
    expect(
      mapEngagementToWorkspaceView(pending, ctxFor('admin'), NOW).reviewBanner?.clientDecision
    ).toBeNull();
  });
});

describe('mapEngagementToWorkspaceView — change-request wiring', () => {
  const DANA = { id: 'u-dana', firstName: 'Dana', lastName: 'Lee' };
  const REQUESTED_AT = new Date('2026-07-04T00:00:00.000Z');

  function round(over: Record<string, unknown> = {}) {
    return {
      id: 'cr-1',
      note: 'Tighten the discount logic.',
      requestedAt: REQUESTED_AT,
      requestedBy: DANA,
      taggedMilestoneIds: ['ms-2'],
      ...over,
    };
  }

  function afterRound(over: Partial<ProjectEngagementWithMilestones> = {}) {
    const latest = round();
    return makeEngagement({
      status: 'active',
      changeRequestRounds: [latest],
      latestChangeRequest: latest,
      changeRequestRoundCount: 1,
      milestones: [
        makeMilestone({ id: 'ms-1', title: 'Discovery', status: 'completed' }),
        makeMilestone({ id: 'ms-2', title: 'Build', status: 'in_progress' }),
      ],
      ...over,
    } as Partial<ProjectEngagementWithMilestones>);
  }

  it('has no banner, pill or feedback before any round', () => {
    const view = mapEngagementToWorkspaceView(makeEngagement(), ctxFor('expert'), NOW);
    expect(view.changeRequestBanner).toBeNull();
    expect(view.progress.reviewPill).toBeNull();
    expect(view.milestones.every((m) => m.feedback === null)).toBe(true);
  });

  it('reads the latest round, not the legacy column, for the expert banner', () => {
    const view = mapEngagementToWorkspaceView(
      afterRound({ changeRequestNote: null, changeRequestedBy: null }),
      ctxFor('expert'),
      NOW
    );
    expect(view.changeRequestBanner).toMatchObject({
      variant: 'work_outstanding',
      headline: 'Dana @ Northwind Industrial requested changes on Build.',
      quote: 'Tighten the discount logic.',
    });
  });

  it('client sees their own waiting banner; admin sees the banner without guidance', () => {
    expect(
      mapEngagementToWorkspaceView(afterRound(), ctxFor('client'), NOW).changeRequestBanner
    ).toMatchObject({ variant: 'client_waiting' });
    expect(
      mapEngagementToWorkspaceView(afterRound(), ctxFor('admin'), NOW).changeRequestBanner
    ).toMatchObject({ variant: 'work_outstanding', guidance: null });
  });

  it('wires the pill, the reopened segment and the tagged milestone feedback', () => {
    const view = mapEngagementToWorkspaceView(afterRound(), ctxFor('client'), NOW);
    expect(view.progress.reviewPill).toEqual({ label: 'Changes requested', tone: 'warning' });
    expect(view.progress.segments.map((segment) => segment.tone)).toEqual([
      'completed',
      'reopened',
    ]);
    const [discovery, build] = view.milestones;
    expect(discovery?.feedback).toBeNull();
    expect(build?.feedback).toMatchObject({
      calloutHeading: 'Your feedback · 4 Jul',
      note: 'Tighten the discount logic.',
      addressedLabel: 'Updated after your feedback',
    });
  });

  it('the completion card steps aside when the changes_made banner owns the control', () => {
    const done = afterRound({
      milestones: [
        makeMilestone({ id: 'ms-1', status: 'completed' }),
        makeMilestone({ id: 'ms-2', status: 'completed' }),
      ],
    });
    const view = mapEngagementToWorkspaceView(done, ctxFor('expert'), NOW);
    expect(view.changeRequestBanner).toMatchObject({ variant: 'changes_made' });
    expect(view.completionCard).toBeNull();
  });

  it('work_outstanding keeps the card as the single control, labelled "again"', () => {
    const view = mapEngagementToWorkspaceView(afterRound(), ctxFor('expert'), NOW);
    expect(view.changeRequestBanner).toMatchObject({ variant: 'work_outstanding' });
    expect(view.completionCard?.ctaLabel).toBe('Mark project ready again');
  });

  it('the first submission labels the card "Mark project ready"', () => {
    const view = mapEngagementToWorkspaceView(
      makeEngagement({ milestones: [makeMilestone({ status: 'completed' })] }),
      ctxFor('expert'),
      NOW
    );
    expect(view.completionCard?.ctaLabel).toBe('Mark project ready');
  });

  it('the client review banner quotes the previous round and offers the live milestones', () => {
    const latest = round();
    const view = mapEngagementToWorkspaceView(
      makeEngagement({
        status: 'pending_acceptance',
        completionRequestedAt: NOW,
        changeRequestRounds: [latest],
        latestChangeRequest: latest,
        changeRequestRoundCount: 1,
        milestones: [
          makeMilestone({ id: 'ms-1', title: 'Discovery', status: 'completed' }),
          makeMilestone({ id: 'ms-2', title: 'Build', status: 'completed' }),
        ],
      } as Partial<ProjectEngagementWithMilestones>),
      ctxFor('client'),
      NOW
    );
    expect(view.reviewBanner?.lastRequest).toEqual({
      heading: 'Your last request · 4 Jul',
      note: 'Tighten the discount logic.',
    });
    expect(view.reviewBanner?.clientDecision?.milestoneOptions).toEqual([
      { id: 'ms-1', title: 'Discovery' },
      { id: 'ms-2', title: 'Build' },
    ]);
    expect(view.reviewBanner?.clientDecision?.milestoneHelper).toContain('Priya');
  });

  it('expert and admin review banners carry no last-request quote or milestone picker', () => {
    const pending = makeEngagement({ status: 'pending_acceptance', completionRequestedAt: NOW });
    for (const lens of ['expert', 'admin'] as const) {
      const banner = mapEngagementToWorkspaceView(pending, ctxFor(lens), NOW).reviewBanner;
      expect(banner?.lastRequest).toBeNull();
      expect(banner?.clientDecision).toBeNull();
    }
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

  it('expert/admin count copy is singular at 1 and drops entirely at 0 (retainer seam)', () => {
    const base = {
      status: 'completed' as const,
      acceptanceMethod: 'auto' as const,
      acceptedBy: null,
      acceptedAt: new Date('2026-08-30T00:00:00.000Z'),
    };

    // total === 1 → singular, never "1 milestones".
    const one = makeEngagement({ ...base, milestones: [makeMilestone({ status: 'completed' })] });
    const expertOne = mapEngagementToWorkspaceView(one, ctxFor('expert'), NOW);
    expect(expertOne.completedBanner?.body).toContain('All 1 milestone delivered and the project');
    expect(expertOne.completedBanner?.body).not.toContain('1 milestones');
    const adminOne = mapEngagementToWorkspaceView(one, ctxFor('admin'), NOW);
    expect(adminOne.completedBanner?.body).toContain('— 1 milestone delivered.');
    expect(adminOne.completedBanner?.body).not.toContain('1 milestones');

    // total === 0 → no count at all.
    const zero = makeEngagement({ ...base, milestones: [] });
    const expertZero = mapEngagementToWorkspaceView(zero, ctxFor('expert'), NOW);
    expect(expertZero.completedBanner?.body).toContain('The project was delivered and the project');
    expect(expertZero.completedBanner?.body).not.toContain('0 milestones');
    const adminZero = mapEngagementToWorkspaceView(zero, ctxFor('admin'), NOW);
    expect(adminZero.completedBanner?.body).not.toContain('0 milestones');
    // The count clause is omitted → the body ends right after the acceptance clause.
    expect(adminZero.completedBanner?.body).toMatch(/review window\.$/);
  });

  it('client completed banner carries the next-step CTAs; expert/admin do not (D7)', () => {
    const completed = makeEngagement({
      status: 'completed',
      acceptanceMethod: 'client',
      acceptedBy: { id: 'u-dana', firstName: 'Dana', lastName: 'Lee' },
      acceptedAt: new Date('2026-08-30T00:00:00.000Z'),
    });
    const clientCta = mapEngagementToWorkspaceView(completed, ctxFor('client'), NOW).completedBanner
      ?.clientCta;
    expect(clientCta?.messageHref).toMatch(/^\/projects\//);
    expect(clientCta?.messagePersonLabel).toContain('Priya');

    expect(
      mapEngagementToWorkspaceView(completed, ctxFor('expert'), NOW).completedBanner?.clientCta
    ).toBeNull();
    expect(
      mapEngagementToWorkspaceView(completed, ctxFor('admin'), NOW).completedBanner?.clientCta
    ).toBeNull();
  });

  it('client Message CTA is omitted for a retainer (no source request)', () => {
    const retainer = makeEngagement({
      status: 'completed',
      acceptanceMethod: 'auto',
      acceptedBy: null,
      acceptedAt: new Date('2026-08-30T00:00:00.000Z'),
      projectRequest: null,
    });
    const clientCta = mapEngagementToWorkspaceView(retainer, ctxFor('client'), NOW).completedBanner
      ?.clientCta;
    expect(clientCta?.messageHref).toBeNull();
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
    expect(view.cancelledBanner?.title).toBe('Project cancelled');
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
    expect(view.emptyState?.body).toMatch(/^Add your first milestone so Northwind/);
  });

  it('expert empty state on T&M invites proposing the first milestone', () => {
    const view = mapEngagementToWorkspaceView(
      makeEngagement({ milestones: [], pricingMethod: 'tm' }),
      ctxFor('expert'),
      NOW
    );
    expect(view.emptyState?.body).toMatch(
      /^Propose the first milestone — Northwind Industrial approves it before work is tracked against it\./
    );
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

describe('mapEngagementToWorkspaceView — admin last-activity chip', () => {
  function chipOf(
    over: Partial<ProjectEngagementWithMilestones>,
    lens: EngagementLens
  ): { icon: string; label: string; value: string } | undefined {
    return mapEngagementToWorkspaceView(makeEngagement(over), ctxFor(lens), NOW).header.terms.find(
      (t) => t.label === 'Last delivery activity'
    );
  }

  it('shows how long since the last delivery signal on the admin lens', () => {
    const recent = new Date(NOW.getTime() - 2 * 24 * 60 * 60 * 1000);
    expect(chipOf({ status: 'active', activatedAt: recent, createdAt: recent }, 'admin')).toEqual({
      icon: 'Clock',
      label: 'Last delivery activity',
      value: 'Last delivery activity: 2d ago',
    });
  });

  it('is also shown while the project awaits review', () => {
    expect(
      chipOf({ status: 'pending_acceptance', completionRequestedAt: NOW }, 'admin')?.value
    ).toBe('Last delivery activity: today');
  });

  it('is absent for the client and expert lenses and on terminal states', () => {
    expect(chipOf({}, 'client')).toBeUndefined();
    expect(chipOf({}, 'expert')).toBeUndefined();
    expect(
      chipOf({ status: 'completed', acceptedAt: NOW, acceptanceMethod: 'auto' }, 'admin')
    ).toBeUndefined();
    expect(chipOf({ status: 'cancelled', cancelledAt: NOW }, 'admin')).toBeUndefined();
  });

  it('a recent milestone completion counts as delivery activity even when activation is stale', () => {
    const stale = new Date(NOW.getTime() - 20 * 24 * 60 * 60 * 1000);
    const recent = new Date(NOW.getTime() - 2 * 24 * 60 * 60 * 1000);
    const chip = chipOf(
      {
        status: 'active',
        activatedAt: stale,
        createdAt: stale,
        milestones: [makeMilestone({ status: 'completed', completedAt: recent })],
      },
      'admin'
    );
    expect(chip?.value).toBe('Last delivery activity: 2d ago');
  });
});

describe('mapEngagementToWorkspaceView — cancel dialog', () => {
  it('states the consequence and who sees the reason, naming the parties', () => {
    const view = mapEngagementToWorkspaceView(makeEngagement(), ctxFor('admin'), NOW);
    expect(view.cancelDialog).toEqual({
      body: "Delivery stops straight away for Northwind Industrial and Priya Sharma, and it can't be undone. Both are told, with your reason.",
      reasonHint: 'Northwind Industrial and Priya Sharma both see this.',
      reviewNote: null,
    });
  });

  it('names the agency party for an agency expert', () => {
    const view = mapEngagementToWorkspaceView(
      makeEngagement({
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
    expect(view.cancelDialog?.reasonHint).toBe(
      'Northwind Industrial and CloudPeak Consulting both see this.'
    );
  });

  it('adds the review note while the client is reviewing', () => {
    const view = mapEngagementToWorkspaceView(
      makeEngagement({
        status: 'pending_acceptance',
        completionRequestedAt: new Date('2026-07-04T00:00:00.000Z'),
      }),
      ctxFor('admin'),
      NOW
    );
    expect(view.cancelDialog?.reviewNote).toBe(
      "Priya has marked the project ready and Northwind Industrial is reviewing it. If they don't respond, it's accepted on 11 Jul 2026."
    );
  });

  it('is null once the project is completed or cancelled', () => {
    expect(
      mapEngagementToWorkspaceView(
        makeEngagement({ status: 'completed', acceptedAt: NOW, acceptanceMethod: 'auto' }),
        ctxFor('admin'),
        NOW
      ).cancelDialog
    ).toBeNull();
    expect(
      mapEngagementToWorkspaceView(
        makeEngagement({ status: 'cancelled', cancelledAt: NOW }),
        ctxFor('admin'),
        NOW
      ).cancelDialog
    ).toBeNull();
  });
});

describe('mapEngagementToWorkspaceView — completionCard (D4)', () => {
  it('is null for the client and admin lenses', () => {
    expect(
      mapEngagementToWorkspaceView(makeEngagement(), ctxFor('client'), NOW).completionCard
    ).toBeNull();
    expect(
      mapEngagementToWorkspaceView(makeEngagement(), ctxFor('admin'), NOW).completionCard
    ).toBeNull();
  });

  it('is null for the expert lens on a non-active engagement', () => {
    const view = mapEngagementToWorkspaceView(
      makeEngagement({ status: 'pending_acceptance', completionRequestedAt: NOW }),
      ctxFor('expert'),
      NOW
    );
    expect(view.completionCard).toBeNull();
  });

  it('zero milestones: enabled, "no milestones" body + modal copy', () => {
    const view = mapEngagementToWorkspaceView(
      makeEngagement({ milestones: [] }),
      ctxFor('expert'),
      NOW
    );
    expect(view.completionCard).toMatchObject({
      hasMilestones: false,
      milestonesRemaining: 0,
      milestonesTotal: 0,
      canRequest: true,
    });
    expect(view.completionCard?.bodyCopy).toContain('no milestones');
    expect(view.completionCard?.bodyCopy).toContain("Northwind Industrial's review");
    expect(view.completionCard?.modalBody).toContain('no milestones');
  });

  it('all milestones done: enabled, "Every milestone is delivered" body', () => {
    const view = mapEngagementToWorkspaceView(
      makeEngagement({ milestones: [makeMilestone({ status: 'completed' })] }),
      ctxFor('expert'),
      NOW
    );
    expect(view.completionCard).toMatchObject({
      hasMilestones: true,
      milestonesRemaining: 0,
      milestonesTotal: 1,
      canRequest: true,
    });
    expect(view.completionCard?.bodyCopy).toContain('Every milestone is delivered.');
    // The window length is baked into the copy (server-derived, not client-imported).
    expect(view.completionCard?.bodyCopy).toContain('7 days');
    // Single-milestone modal opener is singular with subject/verb agreement, never
    // the "All 1 milestones are delivered" bug.
    expect(view.completionCard?.modalBody).toContain('The milestone is delivered.');
    expect(view.completionCard?.modalBody).not.toContain('All 1 milestone');
  });

  it('blocked (remaining 1, total > 1): plural "milestones" keyed on TOTAL, not remaining', () => {
    const view = mapEngagementToWorkspaceView(
      makeEngagement({
        milestones: [
          makeMilestone({ id: 'ms-a', status: 'completed' }),
          makeMilestone({ id: 'ms-b', status: 'completed' }),
          makeMilestone({ id: 'ms-c', status: 'completed' }),
          makeMilestone({ id: 'ms-d', status: 'completed' }),
          makeMilestone({ id: 'ms-e', status: 'pending' }),
        ],
      }),
      ctxFor('expert'),
      NOW
    );
    expect(view.completionCard).toMatchObject({
      hasMilestones: true,
      milestonesRemaining: 1,
      milestonesTotal: 5,
      canRequest: false,
    });
    // The noun agrees with TOTAL (5), so it stays plural even though exactly one remains.
    expect(view.completionCard?.bodyCopy).toBe(
      "1 of 5 milestones still to complete before the project can be sent for Northwind Industrial's review."
    );
  });

  it('blocked (total 1, single pending milestone): singular "1 of 1 milestone"', () => {
    const view = mapEngagementToWorkspaceView(
      makeEngagement({ milestones: [makeMilestone({ status: 'pending' })] }),
      ctxFor('expert'),
      NOW
    );
    expect(view.completionCard).toMatchObject({
      hasMilestones: true,
      milestonesRemaining: 1,
      milestonesTotal: 1,
      canRequest: false,
    });
    expect(view.completionCard?.bodyCopy).toBe(
      "1 of 1 milestone still to complete before the project can be sent for Northwind Industrial's review."
    );
  });
});

describe('offersRatingCard', () => {
  const statuses: EngagementWorkspaceStatus[] = [
    'active',
    'pending_acceptance',
    'completed',
    'cancelled',
  ];
  const lenses: EngagementLens[] = ['client', 'expert', 'admin'];

  it.each(statuses.flatMap((status) => lenses.map((lens) => [status, lens] as const)))(
    'status=%s lens=%s',
    (status, lens) => {
      expect(offersRatingCard(status, lens)).toBe(status === 'completed' && lens === 'client');
    }
  );
});

describe('mapEngagementToWorkspaceView — change orders (BAL-622)', () => {
  const approvedWithLines = makeOrder({
    id: 'co-ok',
    status: 'approved',
    priceDeltaCents: 200_000,
    sentAt: new Date('2026-06-20T00:00:00Z'),
    decidedAt: new Date('2026-06-21T00:00:00Z'),
    lines: [
      makeLine({ op: 'add', engagementMilestoneId: 'ms-new', title: 'Added' }),
      makeLine({ id: 'l2', op: 'edit', engagementMilestoneId: 'ms-edit', title: 'Edited' }),
      makeLine({ id: 'l3', op: 'remove', engagementMilestoneId: 'ms-gone', title: 'Gone' }),
    ],
  });
  const sentOrder = makeOrder({
    id: 'co-sent',
    status: 'sent',
    sentAt: new Date('2026-07-01T00:00:00Z'),
    lines: [
      makeLine({ op: 'edit', engagementMilestoneId: 'ms-1', title: 'Edited' }),
      makeLine({ id: 'l2', op: 'remove', engagementMilestoneId: 'ms-2', title: 'Removed' }),
      makeLine({ id: 'l3', op: 'add', title: 'Brand new' }),
    ],
  });

  it('terms strip shows the effective price: the accepted price plus every approved delta', () => {
    const expert = mapEngagementToWorkspaceView(
      makeEngagement({ baloFeeBps: 2500 }),
      ctxFor('expert'),
      NOW,
      [approvedWithLines]
    );
    expect(expert.header.terms[0]?.value).toBe('Fixed price · A$60,000');

    const client = mapEngagementToWorkspaceView(
      makeEngagement({ baloFeeBps: 2500 }),
      ctxFor('client'),
      NOW,
      [approvedWithLines]
    );
    expect(client.header.terms[0]?.value).toBe('Fixed price · A$75,000');
  });

  it('ignores a change order that is not approved when pricing the strip', () => {
    const view = mapEngagementToWorkspaceView(makeEngagement(), ctxFor('expert'), NOW, [
      makeOrder({ ...sentOrder, priceDeltaCents: 900_000 }),
    ]);
    expect(view.header.terms[0]?.value).toBe('Fixed price · A$58,000');
  });

  it('locks only the milestones a SENT order edits or removes', () => {
    const milestones = [
      makeMilestone({ id: 'ms-1', sortOrder: 0 }),
      makeMilestone({ id: 'ms-2', sortOrder: 1 }),
      makeMilestone({ id: 'ms-3', sortOrder: 2 }),
    ];
    const view = mapEngagementToWorkspaceView(
      makeEngagement({ milestones }),
      ctxFor('expert'),
      NOW,
      [sentOrder]
    );
    expect(view.milestones.map((m) => m.changePending)).toEqual([true, true, false]);
  });

  it('locks nothing while the open order is only a draft or a request', () => {
    const milestones = [makeMilestone({ id: 'ms-1' })];
    const draft = makeOrder({ ...sentOrder, status: 'draft', sentAt: null });
    const view = mapEngagementToWorkspaceView(
      makeEngagement({ milestones }),
      ctxFor('expert'),
      NOW,
      [draft]
    );
    expect(view.milestones[0]?.changePending).toBe(false);
  });

  it('badges milestones an approved change added or updated, and nothing else', () => {
    const milestones = [
      makeMilestone({ id: 'ms-new', sortOrder: 0 }),
      makeMilestone({ id: 'ms-edit', sortOrder: 1 }),
      makeMilestone({ id: 'ms-plain', sortOrder: 2 }),
    ];
    const view = mapEngagementToWorkspaceView(
      makeEngagement({ milestones }),
      ctxFor('client'),
      NOW,
      [approvedWithLines]
    );
    expect(view.milestones.map((m) => m.changeProvenance)).toEqual(['added', 'updated', null]);
  });

  it('with no change orders every milestone is unbadged and unlocked', () => {
    const view = mapEngagementToWorkspaceView(
      makeEngagement({ milestones: [makeMilestone()] }),
      ctxFor('expert'),
      NOW
    );
    expect(view.milestones[0]).toMatchObject({ changePending: false, changeProvenance: null });
  });

  describe('completion card', () => {
    const done = [makeMilestone({ status: 'completed' })];

    it('blocks marking ready while a client request is open', () => {
      const requested = makeOrder({
        status: 'requested',
        requestedAt: new Date('2026-07-01T00:00:00Z'),
      });
      const card = mapEngagementToWorkspaceView(
        makeEngagement({ milestones: done }),
        ctxFor('expert'),
        NOW,
        [requested]
      ).completionCard;
      expect(card?.canRequest).toBe(false);
      expect(card?.bodyCopy).toBe(
        "Answer Northwind Industrial's change request first. The project can't be marked ready while it's open."
      );
    });

    it('blocks marking ready while a sent change waits on the client', () => {
      const card = mapEngagementToWorkspaceView(
        makeEngagement({ milestones: done }),
        ctxFor('expert'),
        NOW,
        [sentOrder]
      ).completionCard;
      expect(card?.canRequest).toBe(false);
      expect(card?.bodyCopy).toBe(
        "A change is waiting on Northwind Industrial. You can mark the project ready once it's decided."
      );
    });

    it('a draft made from a client request also blocks', () => {
      const draft = makeOrder({
        status: 'draft',
        requestedAt: new Date('2026-07-01T00:00:00Z'),
      });
      const card = mapEngagementToWorkspaceView(
        makeEngagement({ milestones: done }),
        ctxFor('expert'),
        NOW,
        [draft]
      ).completionCard;
      expect(card?.canRequest).toBe(false);
    });

    it('a fresh expert draft does not block', () => {
      const card = mapEngagementToWorkspaceView(
        makeEngagement({ milestones: done }),
        ctxFor('expert'),
        NOW,
        [makeOrder({ status: 'draft' })]
      ).completionCard;
      expect(card?.canRequest).toBe(true);
    });

    it('a decided order does not block', () => {
      const card = mapEngagementToWorkspaceView(
        makeEngagement({ milestones: done }),
        ctxFor('expert'),
        NOW,
        [approvedWithLines]
      ).completionCard;
      expect(card?.canRequest).toBe(true);
    });
  });
});

describe('mapEngagementToWorkspaceView — scope guards and changed-since-proposal (BAL-623)', () => {
  const EDITED_AT = new Date('2026-06-30T00:00:00.000Z');
  const reworded = makeMilestone({
    id: 'ms-reworded',
    title: 'Discovery & design',
    sourceProposalMilestoneId: 'pm-1',
    contentEditedAt: EDITED_AT,
  });
  const directEdit = {
    milestoneId: 'ms-reworded',
    kind: 'direct' as const,
    before: { title: 'Discovery' },
  };

  function inReview(
    lens: EngagementLens,
    milestones: Milestone[],
    edits = [directEdit]
  ): ReturnType<typeof mapEngagementToWorkspaceView> {
    return mapEngagementToWorkspaceView(
      makeEngagement({ status: 'pending_acceptance', completionRequestedAt: NOW, milestones }),
      ctxFor(lens),
      NOW,
      [],
      edits
    );
  }

  it('derives the reworded fields for a stamped milestone', () => {
    const view = mapEngagementToWorkspaceView(
      makeEngagement({ milestones: [reworded] }),
      ctxFor('client'),
      NOW,
      [],
      [directEdit]
    );
    expect(view.milestones[0]?.proposalChanges).toEqual([
      { field: 'title', label: 'Title', before: 'Discovery', after: 'Discovery & design' },
    ]);
  });

  it('shows nothing for an unstamped milestone, even with an edit row', () => {
    const view = mapEngagementToWorkspaceView(
      makeEngagement({ milestones: [makeMilestone({ id: 'ms-reworded' })] }),
      ctxFor('client'),
      NOW,
      [],
      [directEdit]
    );
    expect(view.milestones[0]?.proposalChanges).toEqual([]);
  });

  it('drops a field edited back to its original wording', () => {
    const view = mapEngagementToWorkspaceView(
      makeEngagement({ milestones: [{ ...reworded, title: 'Discovery' }] }),
      ctxFor('client'),
      NOW,
      [],
      [directEdit]
    );
    expect(view.milestones[0]?.proposalChanges).toEqual([]);
  });

  it('lists the reworded milestones on the client review banner only', () => {
    const banner = inReview('client', [reworded]).reviewBanner;
    expect(banner?.changedSinceProposal).toEqual({
      heading: 'Changed since proposal',
      intro:
        'Priya revised the wording of 1 milestone after the proposal was accepted. Each is marked below.',
      items: [
        { milestoneId: 'ms-reworded', milestoneTitle: 'Discovery & design', fieldsLabel: 'Title' },
      ],
    });
    expect(inReview('expert', [reworded]).reviewBanner?.changedSinceProposal).toBeNull();
    expect(inReview('admin', [reworded]).reviewBanner?.changedSinceProposal).toBeNull();
  });

  it('has no review list when nothing was reworded', () => {
    const banner = inReview('client', [makeMilestone()], []).reviewBanner;
    expect(banner?.changedSinceProposal).toBeNull();
  });

  describe('fixed-price removal needs a change order', () => {
    const removable = (milestone: Milestone, over = {}): boolean | undefined =>
      mapEngagementToWorkspaceView(
        makeEngagement({ milestones: [milestone], ...over }),
        ctxFor('expert'),
        NOW
      ).milestones[0]?.removalNeedsChangeOrder;

    it('is true for proposal-origin and valued milestones', () => {
      expect(removable(makeMilestone({ sourceProposalMilestoneId: 'pm-1' }))).toBe(true);
      expect(removable(makeMilestone({ valueCents: 100_000 }))).toBe(true);
    });

    it('is false for a milestone the expert added', () => {
      expect(removable(makeMilestone())).toBe(false);
    });

    it('is false on time and materials, where removal is unguarded', () => {
      expect(
        removable(makeMilestone({ sourceProposalMilestoneId: 'pm-1' }), { pricingMethod: 'tm' })
      ).toBe(false);
    });

    it('is true for a milestone an approved change order added', () => {
      const approved = makeOrder({
        status: 'approved',
        lines: [makeLine({ op: 'add', engagementMilestoneId: 'ms-1', title: 'Added' })],
      });
      const view = mapEngagementToWorkspaceView(
        makeEngagement({ milestones: [makeMilestone()] }),
        ctxFor('expert'),
        NOW,
        [approved]
      );
      expect(view.milestones[0]?.removalNeedsChangeOrder).toBe(true);
    });
  });

  it('flags adding a milestone as needing a change order on time and materials only', () => {
    const add = (pricingMethod: 'fixed' | 'tm'): boolean =>
      mapEngagementToWorkspaceView(makeEngagement({ pricingMethod }), ctxFor('expert'), NOW)
        .addMilestoneNeedsChangeOrder;
    expect(add('tm')).toBe(true);
    expect(add('fixed')).toBe(false);
  });
});
