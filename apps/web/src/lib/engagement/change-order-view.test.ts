import { describe, it, expect } from 'vitest';
import { applyBaloFee } from '@balo/shared/pricing';
import { clientPriceChangeCents } from '@balo/shared/engagements';
import {
  CHARLES,
  DANA,
  makeLine,
  makeMilestone,
  makeOrder,
  makeProject,
} from '@/test/change-order-fixtures';
import { deriveEngagementParties } from './engagement-parties';
import type { EngagementLens, EngagementViewerContext } from './resolve-engagement-lens';
import {
  effectiveExpertPriceCents,
  findOpenOrder,
  formatHours,
  mapChangeOrdersToView,
  signedHours,
  signedMoney,
} from './change-order-view';

const NOW = new Date('2026-10-26T10:00:00.000Z');

function ctxFor(lens: EngagementLens): EngagementViewerContext {
  return {
    lens,
    archetype: lens === 'admin' ? 'observer' : 'participant',
    isClientOwner: lens === 'client',
    isDeliveringExpert: lens === 'expert',
  };
}

function view(
  orders: Parameters<typeof mapChangeOrdersToView>[0],
  lens: EngagementLens,
  engagement = makeProject(),
  canDecide = true,
  loggedMinutesByMilestone: Record<string, number> = {}
): ReturnType<typeof mapChangeOrdersToView> {
  return mapChangeOrdersToView(
    orders,
    engagement,
    ctxFor(lens),
    deriveEngagementParties(engagement),
    canDecide,
    NOW,
    loggedMinutesByMilestone
  );
}

const requested = makeOrder({
  id: 'co-req',
  status: 'requested',
  requestNote: 'Can we add a reporting dashboard?',
  requestedAt: new Date('2026-10-15T00:00:00Z'),
  requestedByUserId: DANA.id,
  requestedBy: DANA,
});

const sentFixed = makeOrder({
  id: 'co-sent',
  status: 'sent',
  note: 'Adds a dashboard',
  priceDeltaCents: 100_000,
  sentAt: new Date('2026-10-19T00:00:00Z'),
  sentByUserId: CHARLES.id,
  sentBy: CHARLES,
  lines: [makeLine({ op: 'add', title: 'Reporting dashboard' })],
});

describe('mapChangeOrdersToView — open order and affordances', () => {
  it('expert sees a client request with the person heading and answer / propose controls', () => {
    const v = view([requested], 'expert');
    expect(v.open?.pill).toEqual({ tone: 'amber', label: 'Request from Northwind' });
    expect(v.open?.requestedHeading).toBe('Dana @ Northwind asked for a change on 15 Oct');
    expect(v.open?.requestNote).toBe('Can we add a reporting dashboard?');
    expect(v.affordances).toMatchObject({
      propose: true,
      answer: true,
      continueDraft: false,
      withdraw: false,
      decide: false,
      requestChange: false,
    });
    expect(v.composerHref).toBe('/engagements/a0000000-0000-4000-8000-000000000001/change-order');
  });

  it('client sees their own request in the second person and cannot open another', () => {
    const v = view([requested], 'client');
    expect(v.open?.pill).toEqual({ tone: 'amber', label: 'Requested' });
    expect(v.open?.requestedHeading).toBe('You asked for a change on 15 Oct');
    expect(v.affordances.requestChange).toBe(false);
  });

  it('client with nothing open may request a change; expert may propose one', () => {
    expect(view([], 'client').affordances.requestChange).toBe(true);
    const expert = view([], 'expert').affordances;
    expect(expert.propose).toBe(true);
    expect(expert.answer).toBe(false);
  });

  it('expert draft: continue and discard, labelled Draft', () => {
    const draft = makeOrder({ status: 'draft', note: 'WIP' });
    const v = view([draft], 'expert');
    expect(v.open?.pill).toEqual({ tone: 'slate', label: 'Draft' });
    expect(v.affordances).toMatchObject({
      continueDraft: true,
      discardDraft: true,
      propose: false,
    });
  });

  it('admin sees an open fresh draft with its id; so does the expert', () => {
    const draft = makeOrder({ id: 'co-fresh', status: 'draft', note: 'WIP' });
    expect(view([draft], 'admin').open?.id).toBe('co-fresh');
    expect(view([draft], 'expert').open?.id).toBe('co-fresh');
    const fromRequest = makeOrder({ ...requested, id: 'co-rd', status: 'draft' });
    expect(view([fromRequest], 'expert').open?.id).toBe('co-rd');
    expect(view([fromRequest], 'admin').open?.id).toBe('co-rd');
  });

  it('exposes pricing method, sent date and sender as fields', () => {
    const v = view([sentFixed], 'client');
    expect(v.open).toMatchObject({
      pricingMethod: 'fixed',
      sentOnLabel: '19 Oct',
      sentByLabel: 'Charles',
    });
    expect(view([requested], 'expert').open).toMatchObject({
      sentOnLabel: null,
      sentByLabel: null,
    });
    expect(
      view([sentFixed], 'expert', makeProject({ pricingMethod: 'tm' })).open?.pricingMethod
    ).toBe('tm');
  });

  it('client never sees a fresh expert draft, but it still blocks a second request', () => {
    const draft = makeOrder({ status: 'draft', note: 'WIP', priceDeltaCents: 5_000 });
    const v = view([draft], 'client');
    expect(v.open).toBeNull();
    expect(v.history).toEqual([]);
    expect(v.affordances.requestChange).toBe(false);
  });

  it('a draft made from a client request reads as Requested to the client', () => {
    const draft = makeOrder({ ...requested, status: 'draft', note: 'WIP' });
    const v = view([draft], 'client');
    expect(v.open?.pill).toEqual({ tone: 'amber', label: 'Requested' });
    expect(v.open?.summary).toBeNull();
    expect(v.open?.lines).toEqual([]);
    expect(v.open?.priceEffect).toBeNull();
  });

  it('sent: the client may decide, the expert may withdraw and cannot start another', () => {
    const client = view([sentFixed], 'client');
    expect(client.open?.pill).toEqual({ tone: 'violet', label: 'Waiting on you' });
    expect(client.affordances.decide).toBe(true);
    expect(client.affordances.decideNotice).toBeNull();
    expect(client.affordances.withdraw).toBe(false);

    const participant = view([sentFixed], 'client', makeProject(), false);
    expect(participant.affordances.decide).toBe(false);
    expect(participant.affordances.decideNotice).toBe(
      'Anyone who can approve proposals for Northwind can approve or decline this.'
    );

    const expert = view([sentFixed], 'expert');
    expect(expert.open?.pill).toEqual({ tone: 'violet', label: 'Waiting on Northwind' });
    expect(expert.affordances).toMatchObject({
      withdraw: true,
      propose: false,
      decide: false,
      decideNotice: null,
      proposeDisabledReason: 'A change is already waiting on Northwind',
    });
  });

  it('offers no controls on a project that is not active', () => {
    const v = view([requested], 'expert', makeProject({ status: 'pending_acceptance' }));
    expect(Object.values(v.affordances).filter((value) => value === true)).toEqual([]);
    expect(view([], 'client', makeProject({ status: 'completed' })).affordances.requestChange).toBe(
      false
    );
  });

  it('findOpenOrder returns the one undecided, unwithdrawn order', () => {
    const closed = makeOrder({ id: 'old', status: 'withdrawn', withdrawnAt: NOW });
    expect(findOpenOrder([closed, sentFixed])?.id).toBe('co-sent');
    expect(findOpenOrder([closed])).toBeNull();
  });
});

describe('mapChangeOrdersToView — fixed-price money, per lens (fee concealment)', () => {
  it('shows each lens its own figures and the other side never appears', () => {
    const client = view([sentFixed], 'client');
    const expert = view([sentFixed], 'expert');

    expect(client.open?.priceEffect).toEqual({
      text: 'Project price A$12,500 → A$13,750 (+A$1,250)',
      hint: 'If you approve, A$1,250 is added to your final invoice.',
    });
    expect(expert.open?.priceEffect).toEqual({
      text: 'Project price A$10,000 → A$11,000 (+A$1,000)',
      hint: 'If Northwind approves, the difference is settled at the end of the project.',
    });

    const clientJson = JSON.stringify(client);
    for (const expertFigure of ['A$10,000', 'A$11,000', '1,000)']) {
      expect(clientJson).not.toContain(expertFigure);
    }
    const expertJson = JSON.stringify(expert);
    for (const clientFigure of ['A$12,500', 'A$13,750', 'A$1,250']) {
      expect(expertJson).not.toContain(clientFigure);
    }
  });

  it('a price cut reads as coming off the final invoice', () => {
    const cut = makeOrder({ ...sentFixed, priceDeltaCents: -200_000 });
    const client = view([cut], 'client');
    expect(client.open?.priceEffect?.hint).toBe(
      'If you approve, A$2,500 comes off your final invoice.'
    );
    expect(client.open?.deltaChip).toBe('-A$2,500');
  });

  it('derives the client delta from the two client prices, never from the fee on the delta', () => {
    const feeBps = 2500;
    const from = 100_001;
    const delta = -3;
    const shared = clientPriceChangeCents(from, from + delta, feeBps);
    expect(shared).not.toBe(applyBaloFee(delta, feeBps));

    const engagement = makeProject({ priceCents: from });
    const order = makeOrder({ ...sentFixed, priceDeltaCents: delta });
    const v = view([order], 'client', engagement);
    expect(v.open?.deltaChip).toBe(signedMoney(shared, 'aud'));
  });

  it('a zero delta says the price does not change', () => {
    const order = makeOrder({ ...sentFixed, priceDeltaCents: null });
    expect(view([order], 'client').open?.priceEffect).toEqual({
      text: "The price doesn't change.",
      hint: null,
    });
  });

  it('later orders start from the price the earlier approved ones set', () => {
    const approved = makeOrder({
      id: 'co-ok',
      status: 'approved',
      priceDeltaCents: 100_000,
      sentAt: new Date('2026-10-05T00:00:00Z'),
      decidedAt: new Date('2026-10-06T00:00:00Z'),
      decidedBy: DANA,
      lines: [makeLine({ title: 'A' })],
    });
    const next = makeOrder({ ...sentFixed, id: 'co-next', priceDeltaCents: 100_000 });
    const expert = view([approved, next], 'expert');
    expect(expert.open?.priceEffect?.text).toBe('Project price A$11,000 → A$12,000 (+A$1,000)');
    expect(expert.history[0]?.priceEffect).toEqual({
      text: 'Project price A$10,000 → A$11,000 (+A$1,000)',
      hint: null,
    });
    expect(effectiveExpertPriceCents(1_000_000, [approved, next])).toBe(1_100_000);
  });
});

describe('mapChangeOrdersToView — time and materials', () => {
  const tm = makeProject({
    pricingMethod: 'tm',
    milestones: [
      makeMilestone({ id: 'ms-1', estimatedMinutes: 3000 }),
      makeMilestone({ id: 'ms-2', estimatedMinutes: 360 }),
    ],
  });
  const sentTm = makeOrder({
    ...sentFixed,
    priceDeltaCents: null,
    lines: [
      makeLine({ op: 'add', title: 'New', estimatedMinutes: 600 }),
      makeLine({
        id: 'line-2',
        op: 'edit',
        engagementMilestoneId: 'ms-2',
        title: 'Edited',
        estimatedMinutes: 480,
        beforeTitle: 'Old',
        beforeEstimatedMinutes: 360,
      }),
    ],
  });

  it('shows the estimate moving, with the billing hint for the client only', () => {
    const client = view([sentTm], 'client', tm);
    const expert = view([sentTm], 'expert', tm);
    expect(client.open?.priceEffect).toEqual({
      text: 'Estimate 56 hrs → 68 hrs (+12 hrs)',
      hint: "You're billed for the time logged, as now.",
    });
    expect(expert.open?.priceEffect?.hint).toBeNull();
    expect(expert.open?.deltaChip).toBe('+12 hrs');
  });

  it('shows a cap change beside the estimate: client figures for the client, expert figures otherwise', () => {
    const withCap = makeOrder({ ...sentTm, priceDeltaCents: 100_000 });
    const client = view([withCap], 'client', tm);
    const expert = view([withCap], 'expert', tm);
    expect(client.open?.priceEffect).toEqual({
      text: 'Estimate 56 hrs → 68 hrs (+12 hrs)',
      capText: 'Cap A$12,500 → A$13,750 (+A$1,250)',
      hint: "You're billed for the time logged, as now. The cap is the most that can be billed.",
    });
    expect(client.open?.deltaChip).toBe('+12 hrs · cap +A$1,250');
    expect(expert.open?.priceEffect?.capText).toBe('Cap A$10,000 → A$11,000 (+A$1,000)');
    expect(expert.open?.deltaChip).toBe('+12 hrs · cap +A$1,000');
    expect(JSON.stringify(client)).not.toContain('A$11,000');
  });

  it('words the approved outcome by whether the cap moved', () => {
    const approvedBase = {
      ...sentTm,
      status: 'approved' as const,
      decidedAt: new Date('2026-10-20T00:00:00Z'),
      decidedByUserId: DANA.id,
    };
    expect(view([makeOrder(approvedBase)], 'client', tm).outcome?.text).toContain(
      'The plan and estimates are updated.'
    );
    expect(
      view([makeOrder({ ...approvedBase, priceDeltaCents: 100_000 })], 'expert', tm).outcome?.text
    ).toContain('The plan, estimates and cap are updated.');
  });

  it('carries estimates on lines, with the before state of an edit', () => {
    const lines = view([sentTm], 'expert', tm).open?.lines;
    expect(lines?.[0]).toMatchObject({ op: 'add', estimateLabel: '10 hrs', before: null });
    expect(lines?.[1]).toMatchObject({
      op: 'edit',
      estimateLabel: '8 hrs',
      before: { title: 'Old', estimateLabel: '6 hrs' },
    });
  });

  describe('the hours already logged on an estimate edit', () => {
    // ms-2 goes from 6 to 8 hours.
    const editOf = (v: ReturnType<typeof view>): unknown =>
      v.open?.lines.find((l) => l.op === 'edit')?.loggedLabel;

    it('shows them on a sent order, to the client and the expert', () => {
      expect(editOf(view([sentTm], 'client', tm, true, { 'ms-2': 300 }))).toBe(
        '5 hrs logged so far'
      );
      expect(editOf(view([sentTm], 'expert', tm, true, { 'ms-2': 300 }))).toBe(
        '5 hrs logged so far'
      );
    });

    it('notes when the time logged is at or past the new estimate', () => {
      expect(editOf(view([sentTm], 'client', tm, true, { 'ms-2': 480 }))).toBe(
        '8 hrs logged so far · already past the new estimate'
      );
      expect(editOf(view([sentTm], 'client', tm, true, { 'ms-2': 630 }))).toBe(
        '10.5 hrs logged so far · already past the new estimate'
      );
    });

    it('is absent on the add line, and when nothing is logged on the milestone', () => {
      const v = view([sentTm], 'client', tm, true, { 'ms-1': 120 });
      expect(v.open?.lines.map((l) => l.loggedLabel)).toEqual([null, null]);
    });

    it('is absent when the edit leaves the estimate unchanged', () => {
      const unchanged = makeOrder({
        ...sentTm,
        lines: [
          makeLine({
            op: 'edit',
            engagementMilestoneId: 'ms-2',
            title: 'Renamed',
            estimatedMinutes: 360,
            beforeTitle: 'Old',
            beforeEstimatedMinutes: 360,
          }),
        ],
      });
      expect(editOf(view([unchanged], 'client', tm, true, { 'ms-2': 300 }))).toBeNull();
    });

    it('is absent on a fixed-price project', () => {
      const fixedProject = makeProject({ milestones: tm.milestones });
      expect(editOf(view([sentTm], 'client', fixedProject, true, { 'ms-2': 300 }))).toBeNull();
    });

    it.each([
      ['approved', { status: 'approved' as const, decidedAt: NOW, decidedByUserId: DANA.id }],
      ['withdrawn', { status: 'withdrawn' as const, withdrawnAt: NOW }],
    ])('is absent once the order is %s', (_, decided) => {
      const v = view([makeOrder({ ...sentTm, ...decided })], 'client', tm, true, { 'ms-2': 300 });
      expect(v.open).toBeNull();
      expect(v.history[0]?.lines.find((l) => l.op === 'edit')?.loggedLabel).toBeNull();
    });
  });

  it('formats hours with at most one decimal', () => {
    expect(formatHours(90)).toBe('1.5 hrs');
    expect(signedHours(-60)).toBe('-1 hr');
    expect(signedHours(0)).toBe('no change');
  });
});

describe('mapChangeOrdersToView — outcomes, history and answers', () => {
  const answered = makeOrder({
    ...requested,
    id: 'co-answered',
    status: 'declined',
    declineReason: 'It is already in scope.',
    decidedAt: new Date('2026-10-17T00:00:00Z'),
    decidedBy: CHARLES,
  });
  const approved = makeOrder({
    ...sentFixed,
    id: 'co-approved',
    status: 'approved',
    decidedAt: new Date('2026-10-22T00:00:00Z'),
    decidedBy: DANA,
  });
  const declined = makeOrder({
    ...sentFixed,
    id: 'co-declined',
    status: 'declined',
    declineReason: 'Too expensive.',
    decidedAt: new Date('2026-10-22T00:00:00Z'),
    decidedBy: DANA,
  });
  const withdrawn = makeOrder({
    ...sentFixed,
    id: 'co-withdrawn',
    status: 'withdrawn',
    withdrawnAt: new Date('2026-10-23T00:00:00Z'),
    withdrawnBy: CHARLES,
  });

  it('an answered request reads as Answered, with the answer for both parties', () => {
    const client = view([answered], 'client');
    expect(client.history[0]?.pill).toEqual({ tone: 'slate', label: 'Answered' });
    expect(client.history[0]?.answerText).toBe('Charles answered: “It is already in scope.”');
    expect(client.history[0]?.priceEffect).toBeNull();
    expect(client.outcome).toEqual({
      tone: 'slate',
      text: 'Charles answered your request: “It is already in scope.”',
    });
    expect(view([answered], 'expert').history[0]?.answerText).toBe(
      'You answered: “It is already in scope.”'
    );
    expect(view([answered], 'expert').outcome).toBeNull();
  });

  it('approved: warm outcome for both parties, naming the party then the person', () => {
    expect(view([approved], 'client').outcome).toEqual({
      tone: 'emerald',
      text: 'You approved the change on 22 Oct. The plan and price are updated.',
    });
    expect(view([approved], 'expert').outcome).toEqual({
      tone: 'emerald',
      text: 'Northwind approved the change on 22 Oct. The plan and price are updated.',
    });
  });

  it('declined: the expert hears who declined and why; the client sees no banner', () => {
    expect(view([declined], 'expert').outcome).toEqual({
      tone: 'slate',
      text: 'Dana @ Northwind declined the change on 22 Oct: “Too expensive.”',
    });
    expect(view([declined], 'client').outcome).toBeNull();
    expect(view([declined], 'client').history[0]?.declineText).toBe(
      'You declined: “Too expensive.”'
    );
    expect(view([declined], 'expert').history[0]?.declineText).toBe(
      'Dana @ Northwind declined: “Too expensive.”'
    );
  });

  it('withdrawn: the client is told nothing changed', () => {
    expect(view([withdrawn], 'client').outcome).toEqual({
      tone: 'slate',
      text: 'Charles withdrew the proposed change on 23 Oct. Nothing changed.',
    });
  });

  it('has no outcome while an order is open, and no admin outcome ever', () => {
    expect(view([approved, requested], 'client').outcome).toBeNull();
    expect(view([approved], 'admin').outcome).toBeNull();
  });

  it('lists closed orders newest first and omits a never-sent fresh draft that was withdrawn', () => {
    const quiet = makeOrder({ id: 'quiet', status: 'withdrawn', withdrawnAt: NOW });
    const v = view([approved, quiet, declined], 'expert');
    expect(v.history.map((item) => item.id)).toEqual(['co-declined', 'co-approved']);
    expect(view([], 'expert').history).toEqual([]);
  });

  it('describes when each step happened', () => {
    expect(view([approved], 'expert').history[0]?.datesLabel).toBe('Sent 19 Oct · Approved 22 Oct');
    expect(view([answered], 'expert').history[0]?.datesLabel).toBe(
      'Requested 15 Oct · Answered 17 Oct'
    );
  });
});

describe('mapChangeOrdersToView — footnote and admin line', () => {
  it('words the footnote per lens and pricing method', () => {
    expect(view([], 'client').footnote).toContain('Charles can tidy the wording');
    expect(view([], 'client').footnote).toContain('settled on your final invoice');
    expect(view([], 'expert').footnote).toContain('One change can be open at a time.');
    expect(view([], 'admin').footnote).toBe(
      'Amounts on the panel above are visible to Balo staff only.'
    );
    expect(view([], 'client', makeProject({ pricingMethod: 'tm' })).footnote).toContain(
      "You're billed for the time logged"
    );
  });

  it('reports where the open order stands to Balo staff only', () => {
    expect(view([sentFixed], 'admin').adminStateLine).toBe(
      "Waiting on Northwind since 19 Oct (5 business days). It's in the pending-actions queue."
    );
    expect(view([sentFixed], 'client').adminStateLine).toBeNull();
    expect(view([makeOrder({ status: 'draft' })], 'admin').adminStateLine).toBe(
      'Charles is drafting a change.'
    );
    expect(view([requested], 'admin').adminStateLine).toBe(
      'Northwind asked for a change. Waiting on Charles.'
    );
    expect(view([], 'admin').adminStateLine).toBeNull();
  });

  it.each([
    ['09:00Z, before the cutoff', '2026-11-02T09:00:00Z', false],
    ['15:00Z, exactly at the cutoff', '2026-11-02T15:00:00Z', true],
    ['16:00Z, after the cutoff', '2026-11-02T16:00:00Z', true],
  ])('gates the queue note on the stale cutoff at %s', (_label, nowIso, inQueue) => {
    const sentMonday = makeOrder({ ...sentFixed, sentAt: new Date('2026-10-26T15:00:00Z') });
    const engagement = makeProject();
    const line = mapChangeOrdersToView(
      [sentMonday],
      engagement,
      ctxFor('admin'),
      deriveEngagementParties(engagement),
      true,
      new Date(nowIso)
    ).adminStateLine;
    expect(line?.includes("It's in the pending-actions queue.")).toBe(inQueue);
  });

  it('keeps a sent order under five business days out of the queue note', () => {
    const recent = makeOrder({ ...sentFixed, sentAt: new Date('2026-10-22T00:00:00Z') });
    expect(view([recent], 'admin').adminStateLine).toBe(
      'Waiting on Northwind since 22 Oct (2 business days).'
    );
  });
});
