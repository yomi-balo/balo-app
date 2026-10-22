import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import type { ClientMoveDetail } from '@balo/db';
import type { ClientMoveKind, PortfolioRowView } from '@/lib/projects-inbox/portfolio-row';
import {
  buildClientYourMoveCards,
  type BuildClientMoveCardsInput,
  type ClientRescheduleInput,
} from './build-client-move-cards';
import { YOUR_MOVE_KICKOFF_MEMBER_NOTE } from './your-move-copy';
import { YOUR_MOVE_CARD_VIEW_KEYS, type YourMoveCardView } from './your-move-view-types';

const NOW = new Date('2026-10-20T10:00:00.000Z');
const hoursAgo = (h: number): Date => new Date(NOW.getTime() - h * 3_600_000);
const hoursAhead = (h: number): Date => new Date(NOW.getTime() + h * 3_600_000);

const EXPERT_NAMES = new Map([
  ['ep-agency', { firstName: 'Maya', lastName: 'Patel', agencyName: 'Brightline Advisory' }],
  ['ep-solo', { firstName: 'Sam', lastName: 'Rivera', agencyName: null }],
  ['ep-other', { firstName: 'Alex', lastName: 'Chen', agencyName: 'Cirrus Partners' }],
  ['ep-unnamed', { firstName: null, lastName: null, agencyName: null }],
]);

function row(
  id: string,
  clientMoveKind: ClientMoveKind | null,
  over: Partial<PortfolioRowView> = {}
): PortfolioRowView {
  return {
    id,
    href: `/projects/${id}`,
    title: `Title ${id}`,
    companyName: null,
    stage: 'x',
    stageLabel: 'X',
    needsYou: clientMoveKind !== null,
    nudgeLabel: '',
    unread: false,
    updatedRelative: 'yesterday',
    recencyAtIso: hoursAgo(48).toISOString(),
    signal: null,
    kind: 'request',
    moveKind: null,
    clientMoveKind,
    ...over,
  } as PortfolioRowView;
}

type Rel = ClientMoveDetail['relationships'][number];
function rel(over: Partial<Rel> & Pick<Rel, 'relationshipId' | 'expertProfileId'>): Rel {
  return { status: 'proposal_submitted', currentProposal: null, ...over };
}
function proposal(
  over: Partial<NonNullable<Rel['currentProposal']>> = {}
): NonNullable<Rel['currentProposal']> {
  return {
    status: 'submitted',
    version: 2,
    timeframeWeeks: 6,
    milestoneCount: 5,
    submittedAt: hoursAgo(30),
    ...over,
  };
}
function detail(
  id: string,
  relationships: Rel[],
  invoiceRaisedAt: Date | null = null
): ClientMoveDetail {
  return { projectRequestId: id, upfrontInvoiceRaisedAt: invoiceRaisedAt, relationships };
}

function build(over: Partial<BuildClientMoveCardsInput> = {}): YourMoveCardView[] {
  return buildClientYourMoveCards({
    rows: [],
    details: new Map(),
    expertNames: EXPERT_NAMES,
    canManageBilling: true,
    billingHoldSince: null,
    reschedules: [],
    joinRequests: [],
    companyName: 'Northwind Logistics',
    actionItems: [],
    messages: [],
    now: NOW,
    ...over,
  });
}

describe('project cards', () => {
  const kinds: ClientMoveKind[] = [
    'exploratory_call',
    'eoi_reply',
    'proposal_review',
    'kickoff_billing',
    'kickoff_payment',
    'completion',
  ];

  it('yields exactly one card per needs-you row and none for the rest', () => {
    const needs = kinds.map((k, i) => row(`r${i}`, k));
    const quiet = [
      row('q1', null),
      row('q2', null, { needsYou: false, clientMoveKind: undefined }),
      row('q3', 'proposal_review', { needsYou: false }),
    ];
    const cards = build({ rows: [...quiet, ...needs] });
    expect(cards.map((c) => c.id).sort((a, b) => a.localeCompare(b))).toEqual(
      needs.map((n) => n.id).sort((a, b) => a.localeCompare(b))
    );
  });

  it('keeps href and title from the row and files each kind under its own card kind', () => {
    const cards = build({ rows: kinds.map((k, i) => row(`r${i}`, k)) });
    expect(cards.map((c) => c.kind).sort((a, b) => a.localeCompare(b))).toEqual(
      [...kinds].sort((a, b) => a.localeCompare(b))
    );
    expect(cards.find((c) => c.id === 'r0')).toMatchObject({
      href: '/projects/r0',
      title: 'Title r0',
    });
  });

  it('a needs-you row with no detail still renders, with an unnamed expert', () => {
    const [card] = build({ rows: [row('a', 'kickoff_billing')] });
    expect(card).toMatchObject({ counterparty: 'An expert', context: null });
  });

  it('never reads the stage or nudge text of a row', () => {
    const source = readFileSync(join(__dirname, 'build-client-move-cards.ts'), 'utf8');
    expect(source).not.toMatch(/\.stage\b|nudgeLabel/);
  });
});

describe('exploratory call', () => {
  it('names Balo and carries the sentence', () => {
    const [card] = build({ rows: [row('a', 'exploratory_call')] });
    expect(card).toMatchObject({
      counterparty: 'Balo',
      fact: 'Asked yesterday',
      factAt: null,
      actionLabel: 'Book a call',
      context: {
        type: 'sentence',
        body: 'Book a short call with Balo so we can find the right experts for this brief.',
      },
    });
  });
});

describe('expert counterparty', () => {
  const eoi = (relationshipId: string, expertProfileId: string): PortfolioRowView =>
    row(`a-${expertProfileId}`, 'eoi_reply', {
      signal: { from: 'Dana', messagePreview: 'Can we talk Friday?', relationshipId },
    });

  it('shows an agency expert as person, agency, quoting the actual sender by first name', () => {
    const [card] = build({
      rows: [eoi('rel-1', 'ep-agency')],
      details: new Map([
        [
          'a-ep-agency',
          detail('a-ep-agency', [
            rel({ relationshipId: 'rel-1', expertProfileId: 'ep-agency', status: 'eoi_submitted' }),
          ]),
        ],
      ]),
    });
    expect(card?.counterparty).toBe('Maya Patel, Brightline Advisory');
    expect(card?.context).toEqual({
      type: 'message',
      from: 'Dana',
      at: null,
      snippet: 'Can we talk Friday?',
    });
    expect(card?.actionLabel).toBe('Reply');
    expect(card?.fact).toBe('Yesterday');
  });

  it('shows an independent expert by name alone and an unnamed one as "An expert"', () => {
    const solo = build({
      rows: [eoi('rel-1', 'ep-solo')],
      details: new Map([
        [
          'a-ep-solo',
          detail('a-ep-solo', [
            rel({ relationshipId: 'rel-1', expertProfileId: 'ep-solo', status: 'eoi_submitted' }),
          ]),
        ],
      ]),
    });
    expect(solo[0]?.counterparty).toBe('Sam Rivera');
    const unnamed = build({
      rows: [eoi('rel-1', 'ep-unnamed')],
      details: new Map([
        [
          'a-ep-unnamed',
          detail('a-ep-unnamed', [
            rel({
              relationshipId: 'rel-1',
              expertProfileId: 'ep-unnamed',
              status: 'eoi_submitted',
            }),
          ]),
        ],
      ]),
    });
    expect(unnamed[0]?.counterparty).toBe('An expert');
  });

  it('with no signal thread, names the experts of the eoi_submitted relationships', () => {
    const [card] = build({
      rows: [row('a', 'eoi_reply')],
      details: new Map([
        [
          'a',
          detail('a', [
            rel({ relationshipId: 'r1', expertProfileId: 'ep-agency', status: 'eoi_submitted' }),
            rel({ relationshipId: 'r2', expertProfileId: 'ep-solo', status: 'eoi_submitted' }),
            rel({ relationshipId: 'r3', expertProfileId: 'ep-other', status: 'invited' }),
          ]),
        ],
      ]),
    });
    expect(card?.counterparty).toBe('Maya Patel and Sam Rivera');
    expect(card?.context).toBeNull();
    expect(card?.actionLabel).toBe('Reply');
  });
});

describe('proposal review', () => {
  it('one proposal: expert counterparty, sent fact from the newest submission and stats', () => {
    const [card] = build({
      rows: [row('a', 'proposal_review')],
      details: new Map([
        [
          'a',
          detail('a', [
            rel({
              relationshipId: 'r1',
              expertProfileId: 'ep-other',
              currentProposal: proposal({ submittedAt: hoursAgo(30) }),
            }),
          ]),
        ],
      ]),
    });
    expect(card).toMatchObject({
      counterparty: 'Alex Chen, Cirrus Partners',
      fact: 'Sent yesterday',
      waitingSince: hoursAgo(30).toISOString(),
      actionLabel: 'Review proposal',
      context: {
        type: 'stats',
        stats: [
          { label: 'Version', value: '2' },
          { label: 'Timeframe', value: 'About 6 weeks' },
          { label: 'Milestones', value: '5' },
        ],
      },
    });
  });

  it('a null timeframe omits that stat', () => {
    const [card] = build({
      rows: [row('a', 'proposal_review')],
      details: new Map([
        [
          'a',
          detail('a', [
            rel({
              relationshipId: 'r1',
              expertProfileId: 'ep-other',
              currentProposal: proposal({ timeframeWeeks: null }),
            }),
          ]),
        ],
      ]),
    });
    expect(card?.context).toEqual({
      type: 'stats',
      stats: [
        { label: 'Version', value: '2' },
        { label: 'Milestones', value: '5' },
      ],
    });
  });

  it('several proposals: names sentence, no stats, Review N proposals, oldest submission waits', () => {
    const [card] = build({
      rows: [row('a', 'proposal_review')],
      details: new Map([
        [
          'a',
          detail('a', [
            rel({
              relationshipId: 'r1',
              expertProfileId: 'ep-other',
              currentProposal: proposal({ submittedAt: hoursAgo(5) }),
            }),
            rel({
              relationshipId: 'r2',
              expertProfileId: 'ep-solo',
              currentProposal: proposal({ submittedAt: hoursAgo(50) }),
            }),
            rel({
              relationshipId: 'r3',
              expertProfileId: 'ep-agency',
              currentProposal: proposal({ status: 'changes_requested' }),
            }),
          ]),
        ],
      ]),
    });
    expect(card).toMatchObject({
      counterparty: 'Alex Chen and Sam Rivera',
      actionLabel: 'Review 2 proposals',
      context: null,
      waitingSince: hoursAgo(50).toISOString(),
    });
  });
});

describe('kickoff billing', () => {
  const details = new Map([
    [
      'a',
      detail('a', [
        rel({ relationshipId: 'r1', expertProfileId: 'ep-agency', status: 'accepted' }),
      ]),
    ],
  ]);

  it('a billing holder gets Confirm billing and no note', () => {
    const [card] = build({ rows: [row('a', 'kickoff_billing')], details });
    expect(card).toMatchObject({
      counterparty: 'Maya Patel, Brightline Advisory',
      fact: 'Accepted yesterday',
      actionLabel: 'Confirm billing',
      context: {
        type: 'gates',
        gates: [
          { label: 'Your billing', state: 'yours' },
          { label: 'Balo kickoff', state: 'pending' },
        ],
        note: null,
      },
    });
  });

  it('a plain member gets View kickoff and the owner/admin note', () => {
    const [card] = build({ rows: [row('a', 'kickoff_billing')], details, canManageBilling: false });
    expect(card?.actionLabel).toBe('View kickoff');
    expect(card?.context).toMatchObject({
      gates: [
        { label: 'Company billing', state: 'pending' },
        { label: 'Balo kickoff', state: 'pending' },
      ],
      note: YOUR_MOVE_KICKOFF_MEMBER_NOTE,
    });
  });
});

describe('kickoff payment', () => {
  const details = new Map([
    [
      'a',
      detail(
        'a',
        [rel({ relationshipId: 'r1', expertProfileId: 'ep-agency', status: 'accepted' })],
        hoursAgo(10)
      ),
    ],
  ]);

  it('a billing holder gets Pay invoice once Balo has raised the upfront invoice', () => {
    const [card] = build({ rows: [row('a', 'kickoff_payment')], details });
    expect(card).toMatchObject({
      counterparty: 'Maya Patel, Brightline Advisory',
      actionLabel: 'Pay invoice',
      context: {
        type: 'gates',
        gates: [
          { label: 'Your billing', state: 'done' },
          { label: 'Upfront invoice', state: 'done' },
          { label: 'Your payment', state: 'yours' },
        ],
        note: null,
      },
    });
  });

  it('a plain member gets View kickoff, with the payment pending rather than theirs', () => {
    const [card] = build({ rows: [row('a', 'kickoff_payment')], details, canManageBilling: false });
    expect(card?.actionLabel).toBe('View kickoff');
    expect(card?.context).toMatchObject({
      gates: [{ state: 'done' }, { state: 'done' }, { label: 'Your payment', state: 'pending' }],
      note: null,
    });
  });
});

describe('completion', () => {
  const completionRow = (over: Partial<PortfolioRowView> = {}): PortfolioRowView =>
    row('a', 'completion', {
      kind: 'engagement',
      expertProfileId: 'ep-agency',
      completion: {
        milestonesDone: 4,
        milestonesTotal: 4,
        completionRequestedAtIso: '2026-10-15T16:00:00.000Z',
        autoAcceptAtIso: '2026-10-29T16:00:00.000Z',
      },
      ...over,
    });

  it('carries the marked-complete date, progress and auto-accept', () => {
    const [card] = build({ rows: [completionRow()] });
    expect(card).toMatchObject({
      counterparty: 'Maya Patel, Brightline Advisory',
      fact: null,
      factAt: { template: 'marked_complete', iso: '2026-10-15T16:00:00.000Z' },
      waitingSince: '2026-10-15T16:00:00.000Z',
      context: {
        type: 'completion',
        done: 4,
        total: 4,
        autoAcceptIso: '2026-10-29T16:00:00.000Z',
      },
    });
  });

  it('without a completion request the card has no context and no dated fact', () => {
    const [card] = build({ rows: [completionRow({ completion: null })] });
    expect(card).toMatchObject({ context: null, factAt: null, fact: null });
  });
});

describe('billing hold', () => {
  it('renders only with a hold date, with a dated fact and no amount', () => {
    expect(build({ billingHoldSince: null })).toEqual([]);
    const [card] = build({ billingHoldSince: new Date('2026-10-17T12:00:00.000Z') });
    expect(card).toMatchObject({
      id: 'receivable',
      kind: 'receivable',
      title: 'Outstanding balance',
      counterparty: 'New bookings are on hold',
      fact: null,
      factAt: { template: 'since', iso: '2026-10-17T12:00:00.000Z' },
      href: '/settings/billing',
      context: { type: 'sentence', body: 'Settling it lifts the hold on new bookings.' },
    });
  });

  it('sorts ahead of every tier-1 card', () => {
    const cards = build({
      billingHoldSince: hoursAgo(1),
      rows: [row('a', 'exploratory_call', { recencyAtIso: hoursAgo(500).toISOString() })],
    });
    expect(cards.map((c) => c.kind)).toEqual(['receivable', 'exploratory_call']);
  });
});

describe('reschedule options', () => {
  const proposalInput = (over: Partial<ClientRescheduleInput> = {}): ClientRescheduleInput => ({
    proposalId: 'p1',
    engagementId: 'eng-1',
    caseTitle: 'Flow error triage',
    expertProfileId: 'ep-agency',
    originalScheduledStart: new Date('2026-10-21T10:00:00.000Z'),
    expiresAt: new Date('2026-10-22T17:00:00.000Z'),
    createdAt: hoursAgo(2),
    optionStarts: [new Date('2026-10-22T09:00:00.000Z'), new Date('2026-10-23T14:30:00.000Z')],
    ...over,
  });

  it('builds a warning card with the deadline and the options', () => {
    const [card] = build({ reschedules: [proposalInput()] });
    expect(card).toMatchObject({
      id: 'reschedule-p1',
      kind: 'reschedule',
      title: 'Flow error triage',
      counterparty: 'Maya Patel, Brightline Advisory',
      fact: null,
      factAt: { template: 'reply_by', iso: '2026-10-22T17:00:00.000Z' },
      factTone: 'warning',
      deadline: '2026-10-22T17:00:00.000Z',
      waitingSince: hoursAgo(2).toISOString(),
      href: '/cases/eng-1',
      actionLabel: 'Choose a time',
      context: {
        type: 'reschedule',
        wasIso: '2026-10-21T10:00:00.000Z',
        optionIsos: ['2026-10-22T09:00:00.000Z', '2026-10-23T14:30:00.000Z'],
      },
    });
  });

  it('sorts the soonest deadline first within tier 1', () => {
    const cards = build({
      rows: [row('a', 'exploratory_call', { recencyAtIso: hoursAgo(900).toISOString() })],
      reschedules: [
        proposalInput({ proposalId: 'late', expiresAt: hoursAhead(80) }),
        proposalInput({ proposalId: 'soon', expiresAt: hoursAhead(20) }),
      ],
    });
    expect(cards.map((c) => c.id)).toEqual(['reschedule-soon', 'reschedule-late', 'a']);
  });
});

describe('team', () => {
  const people = (n: number): BuildClientMoveCardsInput['joinRequests'] =>
    Array.from({ length: n }, (_, i) => ({
      name: `Person ${i}`,
      email: `p${i}@northwind.example`,
      createdAt: hoursAgo(30 - i),
    }));

  it('is absent with no requests', () => {
    expect(build({ joinRequests: [] })).toEqual([]);
  });

  it('says "1 person" and names the company', () => {
    const [card] = build({ joinRequests: people(1) });
    expect(card).toMatchObject({
      title: '1 person asked to join',
      counterparty: 'Northwind Logistics',
      fact: 'Since yesterday',
      href: '/settings/team',
      actionLabel: 'Review requests',
    });
  });

  it('shows two people and counts the rest', () => {
    const [card] = build({ joinRequests: people(3) });
    expect(card?.title).toBe('3 people asked to join');
    expect(card?.context).toEqual({
      type: 'people',
      people: [
        { name: 'Person 0', email: 'p0@northwind.example' },
        { name: 'Person 1', email: 'p1@northwind.example' },
      ],
      more: 1,
    });
    expect(card?.waitingSince).toBe(hoursAgo(30).toISOString());
  });
});

describe('shared arms', () => {
  it('names the expert on action items and messages', () => {
    const cards = build({
      actionItems: [
        {
          engagementId: 'eng-1',
          engagementType: 'case',
          engagementTitle: 'Flow error triage',
          party: { kind: 'expert', expertProfileId: 'ep-agency' },
          body: 'Export the flows',
          dueAt: null,
          createdAt: hoursAgo(10),
        },
      ],
      messages: [
        {
          party: { kind: 'expert', expertProfileId: 'ep-other' },
          unreadCount: 1,
          earliestUnreadAt: hoursAgo(1),
          latestInbound: { body: '<p>Draft attached</p>', at: hoursAgo(1), senderFirstName: null },
          latestActivityAt: hoursAgo(1),
        },
      ],
    });
    expect(cards.find((c) => c.kind === 'action_items')?.counterparty).toBe(
      'Maya Patel, Brightline Advisory'
    );
    const messages = cards.find((c) => c.kind === 'messages');
    expect(messages?.counterparty).toBe('Cirrus Partners');
    expect(messages?.context).toMatchObject({ from: 'Alex Chen, Cirrus Partners' });
  });

  it('quotes a teammate-sent latest message by the sender first name, not the expert', () => {
    const cards = build({
      messages: [
        {
          party: { kind: 'expert', expertProfileId: 'ep-other' },
          unreadCount: 1,
          earliestUnreadAt: hoursAgo(1),
          latestInbound: {
            body: '<p>Draft attached</p>',
            at: hoursAgo(1),
            senderFirstName: 'Dana',
          },
          latestActivityAt: hoursAgo(1),
        },
      ],
    });
    expect(cards.find((c) => c.kind === 'messages')?.context).toMatchObject({ from: 'Dana' });
  });
});

describe('no money crosses the view model', () => {
  it('has no money-shaped key or currency value on any card', () => {
    const cards = build({
      billingHoldSince: hoursAgo(10),
      rows: [
        row('a', 'proposal_review'),
        row('b', 'kickoff_billing'),
        row('c', 'exploratory_call'),
      ],
      details: new Map([
        [
          'a',
          detail('a', [
            rel({ relationshipId: 'r1', expertProfileId: 'ep-other', currentProposal: proposal() }),
          ]),
        ],
      ]),
      joinRequests: [{ name: 'Riley', email: 'riley@northwind.example', createdAt: hoursAgo(3) }],
    });
    const json = JSON.stringify(cards);
    expect(json).not.toMatch(/\$|A\$|"(amount|price|budget|balance|fee|rate|cents|currency)\w*"/i);
    for (const card of cards) {
      expect(Object.keys(card).sort((a, b) => a.localeCompare(b))).toEqual(
        [...YOUR_MOVE_CARD_VIEW_KEYS].sort((a, b) => a.localeCompare(b))
      );
      expect(card.fact !== null && card.factAt !== null).toBe(false);
    }
  });
});
