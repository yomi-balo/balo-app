import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@/test/utils';
import userEvent from '@testing-library/user-event';

const mockRefresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mockRefresh }) }));

const mockUseRefreshOnFocus = vi.fn();
vi.mock('@/hooks/use-refresh-on-focus', () => ({
  useRefreshOnFocus: () => mockUseRefreshOnFocus(),
}));

import { YourMove } from './your-move';
import { track, DASHBOARD_EVENTS, CALENDAR_EVENTS } from '@/lib/analytics';
import { DASHBOARD_YOUR_MOVE_CARD_KINDS } from '@balo/analytics/events';
import { YOUR_MOVE_EMPTY, YOUR_MOVE_ERROR } from '../_lib/your-move-copy';
import type { YourMoveCardView, YourMoveData } from '../_lib/your-move-view-types';

function card(overrides: Partial<YourMoveCardView> = {}): YourMoveCardView {
  return {
    id: 'c-1',
    kind: 'invitation',
    title: 'CPQ rollout',
    counterparty: 'Northwind',
    fact: 'Invited 2d ago',
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
    body: 'Clients can’t find you in search until it’s reconnected.',
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
  kickoff_terms: {
    type: 'gates',
    gates: [
      { label: 'Client billing', state: 'done' },
      { label: 'Your terms', state: 'yours' },
      { label: 'Balo approval', state: 'pending' },
    ],
  },
  delivery_changes: { type: 'delivery', note: 'Rework the approval flow', done: 2, total: 5 },
  action_items: { type: 'items', items: [{ text: 'Send the SOW', overdue: true }], more: 1 },
  messages: { type: 'message', from: 'Northwind', at: '2h ago', snippet: 'Thanks, one question' },
};

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
});

describe('YourMove — states', () => {
  it('empty: one line, no rail, no viewed-with-cards noise', () => {
    render(<YourMove data={ready([])} />);
    expect(screen.getByText(YOUR_MOVE_EMPTY)).toBeInTheDocument();
    expect(screen.queryByRole('list')).toBeNull();
    expect(screen.queryByRole('group', { name: 'Filter by type' })).toBeNull();
  });

  it('success: heading, count sentence and one listitem per card', () => {
    render(<YourMove data={ready([card(), card({ id: 'c-2', title: 'B' })])} />);
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
    render(<YourMove data={{ kind: 'error', cards: [calendar] }} />);
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
    render(<YourMove data={{ kind: 'error', cards: [] }} />);
    expect(screen.getByRole('alert')).toHaveTextContent(YOUR_MOVE_ERROR);
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(mockRefresh).toHaveBeenCalledTimes(1);
    finish();
  });

  it('error with no cards: only the error line', () => {
    render(<YourMove data={{ kind: 'error', cards: [] }} />);
    expect(screen.getByText(YOUR_MOVE_ERROR)).toBeInTheDocument();
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('refreshes on focus', () => {
    render(<YourMove data={ready([card()])} />);
    expect(mockUseRefreshOnFocus).toHaveBeenCalled();
  });
});

describe('YourMove — chips and filtering', () => {
  it('shows no chips when every card shares one group', () => {
    render(<YourMove data={ready([card(), card({ id: 'c-2' })])} />);
    expect(screen.queryByRole('group', { name: 'Filter by type' })).toBeNull();
  });

  it('groups kinds that share a chip and counts them', () => {
    render(
      <YourMove
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
        data={ready([
          card({ id: 'a', kind: 'proposal_requested', title: 'P1' }),
          card({ id: 'b', kind: 'invitation', title: 'I1' }),
        ])}
      />
    );
    await userEvent.click(screen.getByRole('button', { name: /^Invitations/ }));
    expect(track).toHaveBeenCalledWith(DASHBOARD_EVENTS.YOUR_MOVE_FILTERED, {
      chip: 'invitations',
      card_count: 1,
    });
    const items = cardItems();
    expect(items).toHaveLength(1);
    expect(items[0]).not.toHaveAttribute('data-featured');

    await userEvent.click(screen.getByRole('button', { name: /^All/ }));
    expect(track).toHaveBeenCalledWith(DASHBOARD_EVENTS.YOUR_MOVE_FILTERED, {
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
    const { rerender } = render(<YourMove data={ready(cards)} />);
    rerender(<YourMove data={ready([...cards])} />);
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
      target: 'card',
      card_kind: 'messages',
      position: 2,
    });
    await userEvent.click(screen.getByRole('link', { name: 'Go first' }));
    expect(track).toHaveBeenCalledWith(DASHBOARD_EVENTS.YOUR_MOVE_CLICKED, {
      target: 'action',
      card_kind: 'invitation',
      position: 1,
    });
    expect(track).not.toHaveBeenCalledWith(CALENDAR_EVENTS.CONNECT_CTA_CLICKED, expect.anything());
  });

  it('the calendar action also keeps the connect-CTA funnel event', async () => {
    render(
      <YourMove
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
});

describe('YourMove — AC4 no money, AC5 touch and snap', () => {
  it('renders all nine kinds with no money wording', () => {
    const { container } = render(<YourMove data={ready(ALL_KINDS)} />);
    expect(cardItems()).toHaveLength(9);
    expect(container.textContent ?? '').not.toMatch(/\$|budget|price/i);
  });

  it('the rail scroll-snaps, cards snap to start, and targets are 44px', () => {
    render(<YourMove data={ready(ALL_KINDS)} />);
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
    render(<YourMove data={ready(ALL_KINDS)} />);
    expect(screen.getByRole('button', { name: 'Scroll back' })).toHaveClass('hidden', 'sm:flex');
    expect(screen.getByRole('button', { name: 'Scroll forward' })).toHaveClass('hidden', 'sm:flex');
  });

  it('the first card is featured only on the All view', () => {
    render(<YourMove data={ready(ALL_KINDS)} />);
    expect(cardItems()[0]).toHaveAttribute('data-featured', 'true');
    expect(cardItems()[1]).not.toHaveAttribute('data-featured');
  });
});
