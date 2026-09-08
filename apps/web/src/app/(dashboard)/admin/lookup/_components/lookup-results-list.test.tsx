import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import type { LookupResult } from '@balo/shared/lookup';
import type { RecentLookupEntry } from '../_lib/use-recent-lookups';
import { LookupResultsList } from './lookup-results-list';

vi.mock('motion/react', async () => {
  const { createMotionStub } = await import('@/test/motion-stub');
  return createMotionStub();
});

function result(
  overrides: Partial<LookupResult> & Pick<LookupResult, 'id' | 'type'>
): LookupResult {
  return { title: 'Title', sub: 'Sub', publicExpertUsername: null, ...overrides };
}

function baseProps(overrides: Partial<React.ComponentProps<typeof LookupResultsList>> = {}) {
  return {
    query: '',
    filter: 'all' as const,
    matches: [],
    filtered: [],
    recent: [],
    tooShort: false,
    truncated: false,
    isPending: false,
    selectedKey: null,
    onSelectResult: vi.fn(),
    onSelectRecent: vi.fn(),
    onShowAllTypes: vi.fn(),
    ...overrides,
  };
}

describe('LookupResultsList', () => {
  it('loading: renders the busy skeleton when isPending WHILE searching a non-empty query', () => {
    render(<LookupResultsList {...baseProps({ query: 'dana', isPending: true })} />);
    expect(screen.getByRole('status')).toHaveAttribute('aria-busy', 'true');
  });

  it('F13 — a stale isPending:true with an EMPTY query goes straight to Recent, no skeleton flash', () => {
    // Reproduces the reviewer-found bug: `isPending` (lifted from the search box's own
    // `useTransition` via an effect) can still read `true` on the very render that first
    // carries the just-cleared `query`. Recent is client-side and instant, so this must not
    // show a spurious loading skeleton over it.
    const recent: RecentLookupEntry[] = [
      { type: 'user', id: 'u1', title: 'Dana Whitfield', sub: 'Owner @ Northwind' },
    ];
    render(<LookupResultsList {...baseProps({ query: '', isPending: true, recent })} />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByText('Dana Whitfield')).toBeInTheDocument();
  });

  it('empty, no query, no recent: renders the invitation copy', () => {
    render(<LookupResultsList {...baseProps()} />);
    expect(screen.getByText(/search for anyone or anything/i)).toBeInTheDocument();
  });

  it('empty, no query, with recent: renders the recent rows', () => {
    const recent: RecentLookupEntry[] = [
      { type: 'user', id: 'u1', title: 'Dana Whitfield', sub: 'Owner @ Northwind' },
    ];
    render(<LookupResultsList {...baseProps({ recent })} />);
    expect(screen.getByText('Dana Whitfield')).toBeInTheDocument();
  });

  it('clicking a recent row calls onSelectRecent', async () => {
    const user = userEvent.setup();
    const onSelectRecent = vi.fn();
    const recent: RecentLookupEntry[] = [
      { type: 'user', id: 'u1', title: 'Dana Whitfield', sub: 'Owner @ Northwind' },
    ];
    render(<LookupResultsList {...baseProps({ recent, onSelectRecent })} />);
    await user.click(screen.getByText('Dana Whitfield'));
    expect(onSelectRecent).toHaveBeenCalledWith(recent[0]);
  });

  it('tooShort: renders the keep-typing notice, not the nothing-matches copy', () => {
    render(<LookupResultsList {...baseProps({ query: 'd', tooShort: true })} />);
    expect(screen.getByText(/needs at least two characters/i)).toBeInTheDocument();
    expect(screen.queryByText(/nothing matches/i)).not.toBeInTheDocument();
  });

  it('searching, nothing anywhere: renders the "Nothing matches" variant with no Show all types button', () => {
    render(<LookupResultsList {...baseProps({ query: 'zzz', matches: [], filtered: [] })} />);
    expect(screen.getByText('Nothing matches "zzz"')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /show all types/i })).not.toBeInTheDocument();
  });

  it('searching, chip-filtered zero but other types have matches: shows "N in other types" and the Show all types button', async () => {
    const user = userEvent.setup();
    const onShowAllTypes = vi.fn();
    const matches = [result({ id: 'co1', type: 'company' })];
    render(
      <LookupResultsList
        {...baseProps({
          query: 'north',
          filter: 'sessions',
          matches,
          filtered: [],
          onShowAllTypes,
        })}
      />
    );
    expect(screen.getByText('Nothing in sessions for "north"')).toBeInTheDocument();
    expect(screen.getByText('1 in other types.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /show all types/i }));
    expect(onShowAllTypes).toHaveBeenCalledTimes(1);
  });

  it('success: renders each filtered row with its title, sub and type badge', () => {
    const filtered = [result({ id: 'u1', type: 'user', title: 'Dana', sub: 'Owner @ Northwind' })];
    render(<LookupResultsList {...baseProps({ query: 'dana', matches: filtered, filtered })} />);
    expect(screen.getByText('Dana')).toBeInTheDocument();
    expect(screen.getByText('Owner @ Northwind')).toBeInTheDocument();
    expect(screen.getByText('User')).toBeInTheDocument();
  });

  it('clicking a result row calls onSelectResult with the full result', async () => {
    const user = userEvent.setup();
    const onSelectResult = vi.fn();
    const filtered = [result({ id: 'u1', type: 'user', title: 'Dana' })];
    render(
      <LookupResultsList
        {...baseProps({ query: 'dana', matches: filtered, filtered, onSelectResult })}
      />
    );
    await user.click(screen.getByText('Dana'));
    expect(onSelectResult).toHaveBeenCalledWith(filtered[0]);
  });

  it('the cap notice appears only when truncated', () => {
    const filtered = [result({ id: 'u1', type: 'user', title: 'Dana' })];
    const { rerender } = render(
      <LookupResultsList
        {...baseProps({ query: 'd', matches: filtered, filtered, truncated: false })}
      />
    );
    expect(screen.queryByText(/showing the first 20/i)).not.toBeInTheDocument();

    rerender(
      <LookupResultsList
        {...baseProps({ query: 'd', matches: filtered, filtered, truncated: true })}
      />
    );
    expect(screen.getByText(/showing the first 20/i)).toBeInTheDocument();
  });

  it('highlights the selected row', () => {
    const filtered = [result({ id: 'u1', type: 'user', title: 'Dana' })];
    render(
      <LookupResultsList
        {...baseProps({ query: 'd', matches: filtered, filtered, selectedKey: 'user:u1' })}
      />
    );
    expect(screen.getByText('Dana').closest('[role="button"]')).toHaveClass('bg-primary/10');
  });
});
