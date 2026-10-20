import { describe, it, expect } from 'vitest';
import type { ExpertMoveDetail, ExpertOpenActionItemRow } from '@balo/db';
import type { ExpertMoveKind, PortfolioRowView } from '@/lib/projects-inbox/portfolio-row';
import {
  buildCalendarCards,
  buildYourMoveCards,
  sortYourMoveCards,
  type BuildYourMoveCardsInput,
  type YourMoveMessageThread,
} from './build-your-move-cards';
import type { YourMoveCardView } from './your-move-view-types';

const NOW = new Date('2026-10-20T10:00:00.000Z');
const hoursAgo = (h: number): Date => new Date(NOW.getTime() - h * 3_600_000);

function row(id: string, over: Partial<PortfolioRowView> = {}): PortfolioRowView {
  return {
    id,
    href: `/projects/${id}`,
    title: `Title ${id}`,
    companyName: 'Northwind',
    stage: 'invited',
    stageLabel: 'Invited',
    needsYou: true,
    nudgeLabel: '',
    unread: false,
    updatedRelative: '2 days ago',
    recencyAtIso: hoursAgo(48).toISOString(),
    signal: null,
    kind: 'request',
    moveKind: 'invitation',
    relationshipId: `rel-${id}`,
    delivery: null,
    ...over,
  };
}

function detail(id: string, over: Partial<ExpertMoveDetail> = {}): ExpertMoveDetail {
  return {
    projectRequestId: id,
    requestStatus: 'accepted',
    descriptionHtml: '<p>Rebuild our <b>journeys</b></p>',
    timeline: 'Early December',
    productNames: ['Marketing Cloud', 'Data Cloud'],
    tagNames: ['Data Cloud', 'CPQ'],
    clientBillingConfirmedAt: null,
    expertTermsConfirmedAt: null,
    currentProposal: null,
    latestChangeRequest: null,
    ...over,
  };
}

function build(over: Partial<BuildYourMoveCardsInput> = {}): YourMoveCardView[] {
  return buildYourMoveCards({
    rows: [],
    details: new Map(),
    actionItems: [],
    messages: [],
    calendarNeedsReconnect: false,
    now: NOW,
    ...over,
  });
}

const ALL_KINDS: ExpertMoveKind[] = [
  'invitation',
  'eoi_propose_times',
  'eoi_reply_owed',
  'proposal_requested',
  'changes_requested',
  'kickoff_terms',
  'delivery_changes',
];

describe('project cards (AC1, AC2)', () => {
  it('yields exactly the needs-you rows, ids 1:1, and none for needsYou:false', () => {
    const needs = ALL_KINDS.map((k, i) =>
      row(`r${i}`, {
        moveKind: k,
        kind: k === 'delivery_changes' ? 'engagement' : 'request',
        delivery: { changeRequestNote: 'Move it', milestonesDone: 1, milestonesTotal: 3 },
      })
    );
    const quiet = [
      row('q1', { needsYou: false, moveKind: null }),
      row('q2', { needsYou: false, moveKind: null, stageLabel: 'Awaiting kickoff' }),
    ];
    const cards = build({ rows: [...quiet, ...needs] });
    expect(cards.map((c) => c.id).sort((a, b) => a.localeCompare(b))).toEqual(
      needs.map((n) => n.id).sort((a, b) => a.localeCompare(b))
    );
    expect(cards.find((c) => c.id === 'q1')).toBeUndefined();
  });

  it('files both eoi kinds under eoi_followup and reads href/title from the row', () => {
    const cards = build({
      rows: [row('a', { moveKind: 'eoi_propose_times' }), row('b', { moveKind: 'eoi_reply_owed' })],
    });
    expect(cards.map((c) => c.kind)).toEqual(['eoi_followup', 'eoi_followup']);
    expect(cards[0]).toMatchObject({
      href: '/projects/a',
      title: 'Title a',
      counterparty: 'Northwind',
    });
  });

  it('invitation: plain-text brief, products then tags deduped, facts from the row', () => {
    const [card] = build({
      rows: [row('a')],
      details: new Map([['a', detail('a')]]),
    });
    expect(card?.fact).toBe('Invited 2 days ago');
    expect(card?.context).toEqual({
      type: 'brief',
      excerpt: 'Rebuild our journeys',
      tags: ['Marketing Cloud', 'Data Cloud', 'CPQ'],
      timeline: 'Early December',
    });
  });

  it('a missing detail gives a null context, not a missing card', () => {
    const [card] = build({ rows: [row('a')] });
    expect(card?.context).toBeNull();
  });

  it('proposal_requested: draft label and Finish proposal; otherwise not started', () => {
    const draft = detail('a', {
      currentProposal: { id: 'p', status: 'draft', version: 1, updatedAt: hoursAgo(30) },
    });
    const [started] = build({
      rows: [row('a', { moveKind: 'proposal_requested' })],
      details: new Map([['a', draft]]),
    });
    expect(started?.context).toEqual({ type: 'draft', label: 'Draft saved yesterday' });
    expect(started?.actionLabel).toBe('Finish proposal');

    const [fresh] = build({
      rows: [row('a', { moveKind: 'proposal_requested' })],
      details: new Map([['a', detail('a')]]),
    });
    expect(fresh?.context).toEqual({ type: 'draft', label: 'Not started yet' });
    expect(fresh?.actionLabel).toBe('Write proposal');
  });

  it('changes_requested: one section label, none for general', () => {
    const withSection = detail('a', {
      latestChangeRequest: { note: 'Split it', section: 'timeline', createdAt: hoursAgo(1) },
    });
    const general = detail('b', {
      latestChangeRequest: { note: 'Hmm', section: 'general', createdAt: hoursAgo(1) },
    });
    const cards = build({
      rows: [
        row('a', { moveKind: 'changes_requested' }),
        row('b', { moveKind: 'changes_requested' }),
      ],
      details: new Map([
        ['a', withSection],
        ['b', general],
      ]),
    });
    const byId = new Map(cards.map((c) => [c.id, c]));
    expect(byId.get('a')?.context).toEqual({
      type: 'change_note',
      note: 'Split it',
      section: 'Timeline',
    });
    expect(byId.get('b')?.context).toEqual({ type: 'change_note', note: 'Hmm', section: null });
  });

  it('kickoff_terms: gates follow billing and approval', () => {
    const [open] = build({
      rows: [row('a', { moveKind: 'kickoff_terms' })],
      details: new Map([['a', detail('a', { clientBillingConfirmedAt: hoursAgo(5) })]]),
    });
    expect(open?.context).toEqual({
      type: 'gates',
      gates: [
        { label: 'Client billing', state: 'done' },
        { label: 'Your terms', state: 'yours' },
        { label: 'Balo approval', state: 'pending' },
      ],
    });
    const [approved] = build({
      rows: [row('a', { moveKind: 'kickoff_terms' })],
      details: new Map([['a', detail('a', { requestStatus: 'kickoff_approved' })]]),
    });
    expect(approved?.context).toMatchObject({
      gates: [{ state: 'pending' }, { state: 'yours' }, { state: 'done' }],
    });
  });

  it('delivery_changes: note and counts from the row, no fact', () => {
    const [card] = build({
      rows: [
        row('e1', {
          moveKind: 'delivery_changes',
          kind: 'engagement',
          href: '/engagements/e1',
          delivery: { changeRequestNote: 'Move cutover', milestonesDone: 3, milestonesTotal: 5 },
        }),
      ],
    });
    expect(card?.fact).toBeNull();
    expect(card?.context).toEqual({ type: 'delivery', note: 'Move cutover', done: 3, total: 5 });
  });
});

describe('no person names (AC3)', () => {
  it('attributes eoi and messages to the company, never the sender', () => {
    const cards = build({
      rows: [
        row('a', {
          moveKind: 'eoi_reply_owed',
          signal: { from: 'Dana', messagePreview: 'Can we talk Friday?' },
        }),
      ],
      messages: [
        {
          companyName: 'Orbit Media',
          unreadCount: 2,
          earliestUnreadAt: hoursAgo(3),
          latestInbound: { body: '<p>Hello there</p>', at: hoursAgo(1) },
          latestActivityAt: hoursAgo(1),
        },
      ],
    });
    expect(JSON.stringify(cards)).not.toContain('Dana');
    const eoi = cards.find((c) => c.id === 'a');
    expect(eoi?.context).toEqual({
      type: 'message',
      from: 'Northwind',
      at: null,
      snippet: 'Can we talk Friday?',
    });
    expect(eoi?.actionLabel).toBe('Reply');
    const messages = cards.find((c) => c.kind === 'messages');
    expect(messages?.context).toMatchObject({ type: 'message', from: 'Orbit Media' });
  });

  it('an owed reply with no preview falls back to the sentence', () => {
    const [card] = build({ rows: [row('a', { moveKind: 'eoi_reply_owed', signal: null })] });
    expect(card?.context).toEqual({
      type: 'sentence',
      body: 'Share your availability so Northwind can book an intro call.',
    });
    expect(card?.actionLabel).toBe('Propose times');
  });
});

describe('calendar card', () => {
  it('is absent when connected and the out-of-search blocker when not', () => {
    expect(buildCalendarCards({ calendarNeedsReconnect: false, now: NOW })).toEqual([]);
    const [card] = buildCalendarCards({ calendarNeedsReconnect: true, now: NOW });
    expect(card).toMatchObject({
      kind: 'calendar_reconnect',
      counterparty: 'Out of search',
      href: '/expert/settings?tab=schedule&setup=calendar',
      waitingSince: NOW.toISOString(),
    });
  });
});

function item(over: Partial<ExpertOpenActionItemRow>): ExpertOpenActionItemRow {
  return {
    actionItemId: 'ai',
    engagementId: 'eng-1',
    engagementType: 'case',
    engagementTitle: 'Portal audit',
    companyName: 'Meridian',
    body: 'Do it',
    dueAt: null,
    createdAt: hoursAgo(10),
    ...over,
  };
}

describe('action item cards', () => {
  it('one card per engagement, overdue first, two shown, rest in more', () => {
    const cards = build({
      actionItems: [
        item({ actionItemId: '1', body: 'later', dueAt: new Date(NOW.getTime() + 86_400_000) }),
        item({ actionItemId: '2', body: 'nodue', createdAt: hoursAgo(20) }),
        item({ actionItemId: '3', body: 'late', dueAt: hoursAgo(5) }),
        item({
          actionItemId: '4',
          engagementId: 'eng-2',
          engagementType: 'project',
          engagementTitle: null,
          body: 'solo',
        }),
      ],
    });
    const first = cards.find((c) => c.id === 'action_items-eng-1');
    expect(first).toMatchObject({
      href: '/cases/eng-1',
      fact: '1 overdue',
      factTone: 'warning',
      waitingSince: hoursAgo(20).toISOString(),
    });
    expect(first?.context).toEqual({
      type: 'items',
      items: [
        { text: 'late', overdue: true },
        { text: 'later', overdue: false },
      ],
      more: 1,
    });
    const second = cards.find((c) => c.id === 'action_items-eng-2');
    expect(second).toMatchObject({
      title: 'Ongoing engagement',
      href: '/engagements/eng-2',
      fact: null,
      factTone: 'muted',
    });
  });
});

describe('messages card', () => {
  const thread = (over: Partial<YourMoveMessageThread>): YourMoveMessageThread => ({
    companyName: 'A',
    unreadCount: 1,
    earliestUnreadAt: hoursAgo(2),
    latestInbound: null,
    latestActivityAt: hoursAgo(1),
    ...over,
  });

  it('is absent with nothing unread', () => {
    expect(build({ messages: [thread({ unreadCount: 0 })] })).toEqual([]);
  });

  it('totals unread, names the companies, links /messages, null context when newest is ours', () => {
    const [card] = build({
      messages: [
        thread({ companyName: 'A', unreadCount: 2, earliestUnreadAt: hoursAgo(9) }),
        thread({ companyName: 'B', unreadCount: 1, latestActivityAt: hoursAgo(2) }),
      ],
    });
    expect(card).toMatchObject({
      title: '3 unread in 2 conversations',
      counterparty: 'A and B',
      href: '/messages',
      waitingSince: hoursAgo(9).toISOString(),
      context: null,
    });
  });
});

describe('ordering', () => {
  it('puts the calendar blocker first, then oldest waiting, then id', () => {
    const cards = build({
      calendarNeedsReconnect: true,
      rows: [
        row('b', { recencyAtIso: hoursAgo(10).toISOString() }),
        row('a', { recencyAtIso: hoursAgo(10).toISOString() }),
        row('c', { recencyAtIso: hoursAgo(50).toISOString() }),
      ],
      actionItems: [item({})],
    });
    expect(cards.map((c) => c.id)).toEqual([
      'calendar_reconnect',
      'c',
      'a',
      'b',
      'action_items-eng-1',
    ]);
  });

  it('sorts a card with a deadline ahead of one without within a tier', () => {
    const base = build({ rows: [row('a'), row('b')] });
    const [a, b] = base;
    if (a === undefined || b === undefined) throw new Error('expected two cards');
    const sorted = sortYourMoveCards([a, { ...b, deadline: '2026-10-25T00:00:00.000Z' }]);
    expect(sorted.map((c) => c.id)).toEqual([b.id, a.id]);
  });
});
