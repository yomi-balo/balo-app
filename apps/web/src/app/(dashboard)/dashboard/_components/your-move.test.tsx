import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@/test/utils';
import userEvent from '@testing-library/user-event';

const mockRefresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mockRefresh }) }));

const clockState = vi.hoisted(() => ({
  value: null as { now: Date; timeZone: string } | null,
}));
vi.mock('@/hooks/use-viewer-clock', () => ({ useViewerClock: () => clockState.value }));

import { YourMove } from './your-move';
import { track, DASHBOARD_EVENTS, CALENDAR_EVENTS } from '@/lib/analytics';
import { DASHBOARD_YOUR_MOVE_CARD_KINDS } from '@balo/analytics/events';
import { YOUR_MOVE_EMPTY, YOUR_MOVE_ERROR } from '../_lib/your-move-copy';
import { buildCalendarCards } from '../_lib/build-your-move-cards';
import type { YourMoveCardView, YourMoveData } from '../_lib/your-move-view-types';

function card(overrides: Partial<YourMoveCardView> = {}): YourMoveCardView {
  return {
    id: 'c-1',
    kind: 'invitation',
    title: 'CPQ rollout',
    counterparty: 'Northwind',
    fact: 'Invited 2d ago',
    factAt: null,
    factTone: 'muted',
    actionLabel: 'Review invitation',
    href: '/projects/r-1',
    waitingSince: '2026-10-01T00:00:00.000Z',
    deadline: null,
    context: null,
    ...overrides,
  };
}

const REALISTIC_CONTEXTS: Record<YourMoveCardView['kind'], YourMoveCardView['context']> = {
  calendar_reconnect: {
    type: 'sentence',
    body: 'While it’s disconnected, you won’t appear in expert search.',
  },
  invitation: {
    type: 'brief',
    excerpt: 'Migrate CPQ to Revenue Cloud',
    tags: ['CPQ', 'Flow'],
    timeline: '6 weeks',
  },
  eoi_followup: {
    type: 'message',
    from: 'Northwind',
    at: null,
    snippet: 'Can we find a time this week?',
  },
  proposal_requested: { type: 'draft', label: 'Not started yet' },
  changes_requested: { type: 'change_note', note: 'Please tighten the scope', section: 'Pricing' },
  delivery_changes: { type: 'delivery', note: 'Rework the approval flow', done: 2, total: 5 },
  action_items: { type: 'items', items: [{ text: 'Send the SOW', overdue: true }], more: 1 },
  messages: { type: 'message', from: 'Northwind', at: '2h ago', snippet: 'Thanks, one question' },
  receivable: { type: 'sentence', body: 'Settling it lifts the hold on new bookings.' },
  reschedule: {
    type: 'reschedule',
    wasIso: '2026-10-21T10:00:00.000Z',
    optionIsos: ['2026-10-22T09:00:00.000Z'],
  },
  completion: {
    type: 'completion',
    done: 4,
    total: 4,
    autoAcceptIso: '2026-10-29T16:00:00.000Z',
  },
  kickoff_billing: {
    type: 'gates',
    gates: [
      { label: 'Your billing', state: 'yours' },
      { label: 'Balo kickoff', state: 'pending' },
    ],
    note: null,
  },
  kickoff_payment: {
    type: 'gates',
    gates: [
      { label: 'Your billing', state: 'done' },
      { label: 'Upfront invoice', state: 'done' },
      { label: 'Your payment', state: 'yours' },
    ],
    note: null,
  },
  exploratory_call: { type: 'sentence', body: 'Book a short call with Balo.' },
  eoi_reply: { type: 'message', from: 'Sam Rivera', at: null, snippet: 'Is Thursday good?' },
  proposal_review: {
    type: 'stats',
    stats: [
      { label: 'Version', value: '2' },
      { label: 'Milestones', value: '5' },
    ],
  },
  join_requests: {
    type: 'people',
    people: [{ name: 'Riley Morgan', email: 'riley@northwind.example' }],
    more: 0,
  },
};

/** Makes the rail report overflow so the scroll arrows render. */
function stubOverflow(overflowing: boolean): void {
  Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
    configurable: true,
    get: () => (overflowing ? 1200 : 300),
  });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get: () => 300,
  });
}

const ALL_KINDS: YourMoveCardView[] = DASHBOARD_YOUR_MOVE_CARD_KINDS.map((kind, i) =>
  card({
    id: `c-${kind}`,
    kind,
    title: `Title ${kind}`,
    href: `/x/${i}`,
    actionLabel: `Act ${kind}`,
    context: REALISTIC_CONTEXTS[kind],
  })
);

/** The card articles only: gate and item lists nest their own listitems. */
const cardItems = (): HTMLElement[] =>
  within(screen.getByRole('list', { name: 'Waiting on you' }))
    .getAllByRole('listitem')
    .filter((el) => el.tagName === 'ARTICLE');

const ready = (cards: readonly YourMoveCardView[]): YourMoveData => ({ kind: 'ready', cards });

beforeEach(() => {
  vi.clearAllMocks();
  clockState.value = { now: new Date('2026-10-20T10:00:00.000Z'), timeZone: 'UTC' };
  stubOverflow(true);
});

describe('YourMove — states', () => {
  it('empty: one line, no rail, no viewed-with-cards noise', () => {
    render(<YourMove workspaceType="expert" data={ready([])} />);
    expect(screen.getByText(YOUR_MOVE_EMPTY)).toBeInTheDocument();
    expect(screen.queryByRole('list')).toBeNull();
    expect(screen.queryByRole('group', { name: 'Filter by type' })).toBeNull();
  });

  it('success: heading, count sentence and one listitem per card', () => {
    render(
      <YourMove workspaceType="expert" data={ready([card(), card({ id: 'c-2', title: 'B' })])} />
    );
    expect(screen.getByRole('heading', { name: 'Your move' })).toBeInTheDocument();
    expect(screen.getByText('2 things are waiting on you')).toBeInTheDocument();
    expect(cardItems()).toHaveLength(2);
  });

  it('error: keeps the calendar card, shows the error line, and Try again refreshes', async () => {
    const calendar = card({
      id: 'cal',
      kind: 'calendar_reconnect',
      title: 'Reconnect your calendar',
      actionLabel: 'Reconnect calendar',
    });
    render(<YourMove workspaceType="expert" data={{ kind: 'error', cards: [calendar] }} />);
    expect(screen.getByText('Reconnect your calendar')).toBeInTheDocument();
    expect(screen.getByText(YOUR_MOVE_ERROR)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(mockRefresh).toHaveBeenCalledTimes(1);
    expect(track).not.toHaveBeenCalledWith(DASHBOARD_EVENTS.YOUR_MOVE_VIEWED, expect.anything());
  });

  it('error: the alert disables Try again while the refresh is pending', async () => {
    let finish: () => void = () => undefined;
    mockRefresh.mockImplementation(() => {
      void new Promise<void>((resolve) => {
        finish = resolve;
      });
    });
    render(<YourMove workspaceType="expert" data={{ kind: 'error', cards: [] }} />);
    expect(screen.getByRole('alert')).toHaveTextContent(YOUR_MOVE_ERROR);
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(mockRefresh).toHaveBeenCalledTimes(1);
    finish();
  });

  it('error with no cards: only the error line', () => {
    render(<YourMove workspaceType="expert" data={{ kind: 'error', cards: [] }} />);
    expect(screen.getByText(YOUR_MOVE_ERROR)).toBeInTheDocument();
    expect(screen.queryByRole('list')).toBeNull();
  });
});

describe('YourMove — chips and filtering', () => {
  it('shows no chips when every card shares one group', () => {
    render(<YourMove workspaceType="expert" data={ready([card(), card({ id: 'c-2' })])} />);
    expect(screen.queryByRole('group', { name: 'Filter by type' })).toBeNull();
  });

  it('groups kinds that share a chip and counts them', () => {
    render(
      <YourMove
        workspaceType="expert"
        data={ready([
          card({ id: 'a', kind: 'proposal_requested' }),
          card({ id: 'b', kind: 'changes_requested' }),
          card({ id: 'c', kind: 'invitation' }),
        ])}
      />
    );
    const group = screen.getByRole('group', { name: 'Filter by type' });
    expect(within(group).getByRole('button', { name: /^Proposals\s*2$/ })).toBeInTheDocument();
    expect(within(group).getByRole('button', { name: /^All\s*3$/ })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
  });

  it('filters the rail, fires filtered with the remaining count, and drops the featured card', async () => {
    render(
      <YourMove
        workspaceType="expert"
        data={ready([
          card({ id: 'a', kind: 'proposal_requested', title: 'P1' }),
          card({ id: 'b', kind: 'invitation', title: 'I1' }),
        ])}
      />
    );
    await userEvent.click(screen.getByRole('button', { name: /^Invitations/ }));
    expect(track).toHaveBeenCalledWith(DASHBOARD_EVENTS.YOUR_MOVE_FILTERED, {
      workspace_type: 'expert',
      chip: 'invitations',
      card_count: 1,
    });
    const items = cardItems();
    expect(items).toHaveLength(1);
    expect(items[0]).not.toHaveAttribute('data-featured');

    await userEvent.click(screen.getByRole('button', { name: /^All/ }));
    expect(track).toHaveBeenCalledWith(DASHBOARD_EVENTS.YOUR_MOVE_FILTERED, {
      workspace_type: 'expert',
      chip: 'all',
      card_count: 2,
    });
    expect(cardItems()[0]).toHaveAttribute('data-featured', 'true');
  });
});

describe('YourMove — analytics', () => {
  it('fires viewed once with distinct kinds in tuple order and no ids', () => {
    const cards = [
      card({ id: 'a', kind: 'messages' }),
      card({ id: 'b', kind: 'invitation' }),
      card({ id: 'c', kind: 'invitation' }),
    ];
    const { rerender } = render(<YourMove workspaceType="expert" data={ready(cards)} />);
    rerender(<YourMove workspaceType="expert" data={ready([...cards])} />);
    const viewed = vi
      .mocked(track)
      .mock.calls.filter(([e]) => e === DASHBOARD_EVENTS.YOUR_MOVE_VIEWED);
    expect(viewed).toHaveLength(1);
    expect(viewed[0]?.[1]).toEqual({
      workspace_type: 'expert',
      card_count: 3,
      card_kinds: ['invitation', 'messages'],
    });
  });

  it('click events carry the target, kind and 1-based position, never an id', async () => {
    render(
      <YourMove
        workspaceType="expert"
        data={ready([
          card({ id: 'a', title: 'First', actionLabel: 'Go first' }),
          card({
            id: 'b',
            kind: 'messages',
            title: 'Second',
            actionLabel: 'Go second',
            href: '/messages',
          }),
        ])}
      />
    );
    await userEvent.click(screen.getByRole('link', { name: 'Second' }));
    expect(track).toHaveBeenCalledWith(DASHBOARD_EVENTS.YOUR_MOVE_CLICKED, {
      workspace_type: 'expert',
      target: 'card',
      card_kind: 'messages',
      position: 2,
    });
    await userEvent.click(screen.getByRole('link', { name: 'Go first' }));
    expect(track).toHaveBeenCalledWith(DASHBOARD_EVENTS.YOUR_MOVE_CLICKED, {
      workspace_type: 'expert',
      target: 'action',
      card_kind: 'invitation',
      position: 1,
    });
    expect(track).not.toHaveBeenCalledWith(CALENDAR_EVENTS.CONNECT_CTA_CLICKED, expect.anything());
  });

  it('the calendar action also keeps the connect-CTA funnel event', async () => {
    render(
      <YourMove
        workspaceType="expert"
        data={ready([
          card({
            id: 'cal',
            kind: 'calendar_reconnect',
            title: 'Cal',
            actionLabel: 'Reconnect calendar',
          }),
        ])}
      />
    );
    await userEvent.click(screen.getByRole('link', { name: 'Reconnect calendar' }));
    expect(track).toHaveBeenCalledWith(CALENDAR_EVENTS.CONNECT_CTA_CLICKED, {
      source: 'dashboard_banner',
    });
  });

  it('the calendar card never promises reconnection will fix everything ("until …")', () => {
    const cards = buildCalendarCards({ calendarNeedsReconnect: true, now: new Date() });
    render(<YourMove workspaceType="expert" data={ready(cards)} />);
    expect(
      screen.getByText('While it’s disconnected, you won’t appear in expert search.')
    ).toBeInTheDocument();
    expect(screen.queryByText(/until/i)).toBeNull();
  });
});

describe('YourMove — AC4 no money, AC5 touch and snap', () => {
  it('renders all seventeen kinds with no money wording', () => {
    const { container } = render(<YourMove workspaceType="expert" data={ready(ALL_KINDS)} />);
    expect(cardItems()).toHaveLength(17);
    expect(container.textContent ?? '').not.toMatch(/\$|budget|price/i);
  });

  it('the rail scroll-snaps, cards snap to start, and targets are 44px', () => {
    render(<YourMove workspaceType="expert" data={ready(ALL_KINDS)} />);
    const rail = screen.getByRole('list', { name: 'Waiting on you' });
    expect(rail).toHaveClass('snap-x', 'snap-mandatory', 'overflow-x-auto');
    for (const item of cardItems()) {
      expect(item).toHaveClass('snap-start');
    }
    for (const kind of ALL_KINDS) {
      expect(screen.getByRole('link', { name: kind.actionLabel })).toHaveClass('min-h-11');
    }
    const chips = within(screen.getByRole('group', { name: 'Filter by type' })).getAllByRole(
      'button'
    );
    for (const chip of chips) expect(chip).toHaveClass('min-h-11');
  });

  it('the scroll arrows are hidden below sm', () => {
    render(<YourMove workspaceType="expert" data={ready(ALL_KINDS)} />);
    expect(screen.getByRole('button', { name: 'Scroll back' })).toHaveClass('hidden', 'sm:flex');
    expect(screen.getByRole('button', { name: 'Scroll forward' })).toHaveClass('hidden', 'sm:flex');
  });

  it('the first card is featured only on the All view', () => {
    render(<YourMove workspaceType="expert" data={ready(ALL_KINDS)} />);
    expect(cardItems()[0]).toHaveAttribute('data-featured', 'true');
    expect(cardItems()[1]).not.toHaveAttribute('data-featured');
  });
});

describe('YourMove — scroll arrows (overflow only)', () => {
  it('renders the arrows when the rail overflows', () => {
    stubOverflow(true);
    render(<YourMove workspaceType="expert" data={ready([card(), card({ id: 'c-2' })])} />);
    expect(screen.getByRole('button', { name: 'Scroll back' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Scroll forward' })).toBeInTheDocument();
  });

  it('renders no arrows when the rail fits', () => {
    stubOverflow(false);
    render(<YourMove workspaceType="expert" data={ready([card()])} />);
    expect(screen.queryByRole('button', { name: 'Scroll back' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Scroll forward' })).toBeNull();
  });

  it('renders no arrows with zero cards', () => {
    stubOverflow(true);
    render(<YourMove workspaceType="expert" data={ready([])} />);
    expect(screen.queryByRole('button', { name: 'Scroll back' })).toBeNull();
  });

  it('renders no arrows on error, even with a calendar card', () => {
    stubOverflow(true);
    const calendar = card({ id: 'cal', kind: 'calendar_reconnect' });
    render(<YourMove workspaceType="expert" data={{ kind: 'error', cards: [calendar] }} />);
    expect(screen.queryByRole('button', { name: 'Scroll back' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Scroll forward' })).toBeNull();
  });
});

describe('YourMove — company workspace', () => {
  it('sends workspace_type company on viewed, clicked and filtered', async () => {
    render(
      <YourMove
        workspaceType="company"
        data={ready([
          card({ id: 'a', kind: 'exploratory_call', title: 'First', actionLabel: 'Book a call' }),
          card({ id: 'b', kind: 'join_requests', title: 'Second', actionLabel: 'Review requests' }),
        ])}
      />
    );
    expect(track).toHaveBeenCalledWith(
      DASHBOARD_EVENTS.YOUR_MOVE_VIEWED,
      expect.objectContaining({ workspace_type: 'company' })
    );
    await userEvent.click(screen.getByRole('link', { name: 'Book a call' }));
    expect(track).toHaveBeenCalledWith(
      DASHBOARD_EVENTS.YOUR_MOVE_CLICKED,
      expect.objectContaining({ workspace_type: 'company', card_kind: 'exploratory_call' })
    );
    await userEvent.click(screen.getByRole('button', { name: /^Team/ }));
    expect(track).toHaveBeenCalledWith(DASHBOARD_EVENTS.YOUR_MOVE_FILTERED, {
      workspace_type: 'company',
      chip: 'team',
      card_count: 1,
    });
  });

  it('formats a dated fact in the viewer zone and renders nothing while the clock is null', () => {
    const dated = card({
      id: 'r',
      kind: 'reschedule',
      fact: null,
      factAt: { template: 'reply_by', iso: '2026-10-21T22:00:00.000Z' },
      context: null,
    });
    clockState.value = { now: new Date('2026-10-20T10:00:00.000Z'), timeZone: 'Australia/Sydney' };
    const { unmount } = render(<YourMove workspaceType="company" data={ready([dated])} />);
    expect(screen.getByText('Reply by Thu 22 Oct')).toBeInTheDocument();
    unmount();

    clockState.value = null;
    const { container } = render(<YourMove workspaceType="company" data={ready([dated])} />);
    expect(container.textContent).not.toMatch(/Reply by/);
    expect(container.textContent).not.toMatch(/Oct/);
  });

  it('renders the client kinds with an icon each and no money wording', () => {
    const { container } = render(<YourMove workspaceType="company" data={ready(ALL_KINDS)} />);
    for (const item of cardItems()) {
      expect(item.querySelector('svg')).not.toBeNull();
    }
    expect(container.textContent ?? '').not.toMatch(/\$|budget|price/i);
  });
});
