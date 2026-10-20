import { describe, it, expect } from 'vitest';
import { DASHBOARD_TRACK_STAGES, DASHBOARD_TRACK_TURNS } from '@balo/analytics/events';
import type {
  ClientMoveKind,
  EngagementDeliveryState,
  ExpertMoveKind,
  PortfolioRowView,
  StageKey,
} from '@/lib/projects-inbox/portfolio-row';
import { buildClientYourMoveCards } from './build-client-move-cards';
import { buildProjectTrack } from './build-project-track';
import { buildYourMoveCards } from './build-your-move-cards';
import { PROJECT_TRACK_COPY, type ProjectTrackView } from './your-move-view-types';

const NOW = new Date('2026-10-20T10:00:00.000Z');

function row(id: string, over: Partial<PortfolioRowView> = {}): PortfolioRowView {
  return {
    id,
    href: `/projects/${id}`,
    title: `Title ${id}`,
    companyName: 'Northwind',
    stage: 'invited',
    stageLabel: 'Invited',
    needsYou: false,
    nudgeLabel: '',
    unread: false,
    updatedRelative: '2 days ago',
    recencyAtIso: '2026-10-18T10:00:00.000Z',
    signal: null,
    kind: 'request',
    moveKind: null,
    clientMoveKind: null,
    ...over,
  };
}

function tokensOf(view: ProjectTrackView | null): { stage: string; id: string; turn: string }[] {
  if (view === null) return [];
  return view.stages.flatMap((s) =>
    s.tokens.map((t) => ({ stage: s.key, id: t.id, turn: t.turn }))
  );
}

const EXPECTED_STAGE: Record<'expert' | 'company', Record<StageKey, string | null>> = {
  expert: {
    requested: 'invited',
    exploratory: 'invited',
    invited: 'invited',
    eoi: 'eoi',
    prop_req: 'proposal',
    prop_in: 'proposal',
    accepted: 'kickoff',
    kicked: 'delivery',
    closed: null,
  },
  company: {
    requested: 'matching',
    exploratory: 'matching',
    invited: 'matching',
    eoi: 'interest',
    prop_req: 'proposal',
    prop_in: 'proposal',
    accepted: 'kickoff',
    kicked: 'delivery',
    closed: null,
  },
};

describe('buildProjectTrack stages', () => {
  it('always emits the five stages in reference order and labels', () => {
    const expert = buildProjectTrack([row('a')], 'expert');
    const company = buildProjectTrack([row('a')], 'company');
    expect(expert?.stages.map((s) => [s.key, s.label])).toEqual([
      ['invited', 'Invited'],
      ['eoi', 'Interest sent'],
      ['proposal', 'Proposal'],
      ['kickoff', 'Kickoff'],
      ['delivery', 'Delivery'],
    ]);
    expect(company?.stages.map((s) => [s.key, s.label])).toEqual([
      ['matching', 'Matching'],
      ['interest', 'Interest'],
      ['proposal', 'Proposals'],
      ['kickoff', 'Kickoff'],
      ['delivery', 'Delivery'],
    ]);
  });

  it.each(['expert', 'company'] as const)('%s lens maps every stage key', (lens) => {
    for (const [stage, expected] of Object.entries(EXPECTED_STAGE[lens])) {
      const view = buildProjectTrack(
        [row('r1', { stage: stage as StageKey }), row('keep', { stage: 'kicked' })],
        lens
      );
      const found = tokensOf(view).find((t) => t.id === 'r1');
      expect(found?.stage ?? null).toBe(expected);
    }
  });

  it('puts a kicked request row (no engagement yet) in Delivery, waiting', () => {
    const view = buildProjectTrack([row('req', { stage: 'kicked', kind: 'request' })], 'company');
    expect(tokensOf(view)).toEqual([{ stage: 'delivery', id: 'req', turn: 'waiting' }]);
  });

  it('every emitted key and turn belongs to the analytics vocabularies', () => {
    const view = buildProjectTrack(
      [row('a', { needsYou: true, moveKind: 'invitation' })],
      'expert'
    );
    for (const s of view?.stages ?? []) expect(DASHBOARD_TRACK_STAGES).toContain(s.key);
    for (const t of tokensOf(view)) expect(DASHBOARD_TRACK_TURNS).toContain(t.turn);
  });
});

describe('buildProjectTrack turns', () => {
  const engagement = (id: string, deliveryState: EngagementDeliveryState, over = {}) =>
    row(id, { kind: 'engagement', stage: 'kicked', deliveryState, ...over });

  it('needsYou is your_move, an in_delivery engagement is in_progress, the rest waiting', () => {
    const view = buildProjectTrack(
      [
        row('mine', { needsYou: true, moveKind: 'proposal_requested', stage: 'prop_req' }),
        engagement('live', 'in_delivery'),
        engagement('review', 'pending_acceptance'),
        row('quiet', { stage: 'eoi' }),
      ],
      'expert'
    );
    expect(tokensOf(view)).toEqual([
      { stage: 'eoi', id: 'quiet', turn: 'waiting' },
      { stage: 'proposal', id: 'mine', turn: 'your_move' },
      { stage: 'delivery', id: 'live', turn: 'in_progress' },
      { stage: 'delivery', id: 'review', turn: 'waiting' },
    ]);
  });

  it('reads the typed state, never the nudge label', () => {
    const view = buildProjectTrack(
      [engagement('c', 'changes_requested', { nudgeLabel: 'In delivery' })],
      'company'
    );
    expect(tokensOf(view)).toEqual([{ stage: 'delivery', id: 'c', turn: 'waiting' }]);
  });

  it("is your_move only with this lens's move kind, the same test the rail uses for a card", () => {
    const rows = [
      row('none', { needsYou: true, stage: 'eoi' }),
      row('expert', { needsYou: true, stage: 'eoi', moveKind: 'eoi_reply_owed' }),
      row('client', { needsYou: true, stage: 'eoi', clientMoveKind: 'eoi_reply' }),
    ];
    expect(tokensOf(buildProjectTrack(rows, 'expert'))).toEqual([
      { stage: 'eoi', id: 'none', turn: 'waiting' },
      { stage: 'eoi', id: 'expert', turn: 'your_move' },
      { stage: 'eoi', id: 'client', turn: 'waiting' },
    ]);
    expect(tokensOf(buildProjectTrack(rows, 'company'))).toEqual([
      { stage: 'interest', id: 'none', turn: 'waiting' },
      { stage: 'interest', id: 'expert', turn: 'waiting' },
      { stage: 'interest', id: 'client', turn: 'your_move' },
    ]);
  });

  it('flags hasYourMove only on stages holding a your_move token', () => {
    const view = buildProjectTrack(
      [
        row('mine', { needsYou: true, moveKind: 'eoi_reply_owed', stage: 'eoi' }),
        row('quiet', { stage: 'accepted' }),
      ],
      'expert'
    );
    expect(view?.stages.map((s) => s.hasYourMove)).toEqual([false, true, false, false, false]);
  });
});

describe('buildProjectTrack exclusions', () => {
  it('returns null for no rows, and for only finished or closed rows', () => {
    expect(buildProjectTrack([], 'expert')).toBeNull();
    expect(
      buildProjectTrack(
        [
          row('done', { kind: 'engagement', stage: 'kicked', deliveryState: 'completed' }),
          row('gone', { kind: 'engagement', stage: 'kicked', deliveryState: 'cancelled' }),
          row('shut', { stage: 'closed' }),
        ],
        'company'
      )
    ).toBeNull();
  });

  it('drops finished engagements but keeps live neighbours in row order', () => {
    const view = buildProjectTrack(
      [
        row('done', { kind: 'engagement', stage: 'kicked', deliveryState: 'completed' }),
        row('b', { stage: 'invited' }),
        row('a', { stage: 'invited' }),
      ],
      'expert'
    );
    expect(tokensOf(view).map((t) => t.id)).toEqual(['b', 'a']);
  });
});

describe('buildProjectTrack tokens', () => {
  it('uses the company name on the expert lens, falling back to the title', () => {
    const view = buildProjectTrack(
      [row('a', { companyName: 'Northwind' }), row('b', { companyName: null })],
      'expert'
    );
    expect(view?.stages[0]?.tokens.map((t) => t.label)).toEqual(['Northwind', 'Title b']);
  });

  it('uses the title on the client lens and falls back to /projects without an href', () => {
    const view = buildProjectTrack(
      [row('a', { href: null, companyName: 'Maya Patel' })],
      'company'
    );
    const [token] = view?.stages[0]?.tokens ?? [];
    expect(token).toEqual({
      id: 'a',
      label: 'Title a',
      title: 'Title a',
      href: '/projects',
      turn: 'waiting',
    });
  });

  it('carries no money, signal or person: fixed key set and no names in the output', () => {
    const rows = [
      row('a', {
        needsYou: true,
        moveKind: 'invitation',
        signal: { from: 'Dana Reyes', messagePreview: 'Budget is $90k' },
        companyName: 'Northwind',
      }),
    ];
    const view = buildProjectTrack(rows, 'expert');
    for (const t of view?.stages.flatMap((s) => s.tokens) ?? []) {
      expect(Object.keys(t).sort((a, b) => a.localeCompare(b))).toEqual([
        'href',
        'id',
        'label',
        'title',
        'turn',
      ]);
    }
    const json = JSON.stringify(view);
    expect(json).not.toContain('Dana Reyes');
    expect(json).not.toContain('$90k');
  });

  it('never names the expert on the client lens', () => {
    const view = buildProjectTrack(
      [row('a', { companyName: 'Maya Patel, Brightline' })],
      'company'
    );
    expect(JSON.stringify(view)).not.toContain('Maya Patel');
  });
});

describe('PROJECT_TRACK_COPY', () => {
  it('pins the reference copy', () => {
    expect(PROJECT_TRACK_COPY.expert).toEqual({
      title: 'Where your projects stand',
      sub: 'Every live project, and whose move it is.',
      waiting: 'Waiting on client',
    });
    expect(PROJECT_TRACK_COPY.company.sub).toBe(
      'Every open request and project, and whose move it is.'
    );
    expect(PROJECT_TRACK_COPY.company.waiting).toBe('Waiting on others');
  });
});

describe('rail/track agreement', () => {
  const EXPERT_STAGE_OF = {
    invitation: 'invited',
    eoi_propose_times: 'eoi',
    eoi_reply_owed: 'eoi',
    proposal_requested: 'prop_req',
    changes_requested: 'prop_in',
    kickoff_terms: 'accepted',
    delivery_changes: 'kicked',
  } satisfies Record<ExpertMoveKind, StageKey>;
  const CLIENT_STAGE_OF = {
    exploratory_call: 'exploratory',
    eoi_reply: 'eoi',
    proposal_review: 'prop_in',
    kickoff_billing: 'accepted',
    completion: 'kicked',
  } satisfies Record<ClientMoveKind, StageKey>;
  const EXPERT_KINDS = Object.entries(EXPERT_STAGE_OF) as [ExpertMoveKind, StageKey][];
  const CLIENT_KINDS = Object.entries(CLIENT_STAGE_OF) as [ClientMoveKind, StageKey][];
  const sorted = (xs: string[]): string[] => [...xs].sort((a, b) => a.localeCompare(b));

  it('expert: your_move tokens and project cards share ids and hrefs', () => {
    const rows = [
      ...EXPERT_KINDS.map(([moveKind, stage], i) =>
        row(`e${i}`, {
          needsYou: true,
          moveKind,
          stage,
          kind: moveKind === 'delivery_changes' ? 'engagement' : 'request',
          deliveryState: moveKind === 'delivery_changes' ? 'changes_requested' : undefined,
        })
      ),
      row('quiet', { stage: 'eoi' }),
      row('live', { kind: 'engagement', stage: 'kicked', deliveryState: 'in_delivery' }),
    ];
    const cards = buildYourMoveCards({
      rows,
      details: new Map(),
      actionItems: [],
      messages: [],
      expertNames: new Map(),
      calendarNeedsReconnect: false,
      now: NOW,
    });
    const view = buildProjectTrack(rows, 'expert');
    const mine = view?.stages.flatMap((s) => s.tokens).filter((t) => t.turn === 'your_move') ?? [];
    expect(sorted(mine.map((t) => t.href))).toEqual(sorted(cards.map((c) => c.href)));
    expect(sorted(mine.map((t) => t.id))).toEqual(sorted(cards.map((c) => c.id)));
    expect(cards).toHaveLength(EXPERT_KINDS.length);
  });

  it('client: your_move tokens and project cards share ids and hrefs', () => {
    const rows = [
      ...CLIENT_KINDS.map(([clientMoveKind, stage], i) =>
        row(`c${i}`, {
          needsYou: true,
          clientMoveKind,
          stage,
          kind: clientMoveKind === 'completion' ? 'engagement' : 'request',
          deliveryState: clientMoveKind === 'completion' ? 'pending_acceptance' : undefined,
        })
      ),
      row('quiet', { stage: 'prop_in' }),
    ];
    const cards = buildClientYourMoveCards({
      rows,
      details: new Map(),
      expertNames: new Map(),
      canManageBilling: false,
      billingHoldSince: null,
      reschedules: [],
      joinRequests: [],
      companyName: 'Northwind',
      actionItems: [],
      messages: [],
      now: NOW,
    });
    const view = buildProjectTrack(rows, 'company');
    const mine = view?.stages.flatMap((s) => s.tokens).filter((t) => t.turn === 'your_move') ?? [];
    expect(sorted(mine.map((t) => t.href))).toEqual(sorted(cards.map((c) => c.href)));
    expect(sorted(mine.map((t) => t.id))).toEqual(sorted(cards.map((c) => c.id)));
    expect(cards).toHaveLength(CLIENT_KINDS.length);
  });
});
