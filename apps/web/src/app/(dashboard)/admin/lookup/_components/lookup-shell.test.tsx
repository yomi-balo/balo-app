import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import type { LookupResult } from '@balo/shared/lookup';
import { track, ADMIN_LOOKUP_EVENTS } from '@/lib/analytics';
import { LookupShell } from './lookup-shell';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn() }),
}));

const { mockAction } = vi.hoisted(() => ({ mockAction: vi.fn() }));
vi.mock('../_actions/fetch-lookup-money-block', () => ({
  fetchLookupMoneyBlockAction: mockAction,
}));

const trackMock = vi.mocked(track);

function result(
  overrides: Partial<LookupResult> & Pick<LookupResult, 'id' | 'type'>
): LookupResult {
  return { title: 'Title', sub: 'Sub', publicExpertUsername: null, ...overrides };
}

beforeEach(() => {
  globalThis.localStorage.clear();
  mockAction.mockReturnValue(new Promise(() => {}));
  trackMock.mockClear();
});

describe('LookupShell', () => {
  it('empty query: renders the Recent section label and no chips', () => {
    render(<LookupShell query="" results={[]} truncated={false} tooShort={false} />);
    expect(screen.getByText(/recent · opened by you/i)).toBeInTheDocument();
    expect(
      screen.queryByRole('group', { name: /filter results by type/i })
    ).not.toBeInTheDocument();
  });

  it('searching: renders chips and the Results · N section label', () => {
    const results = [result({ id: 'u1', type: 'user', title: 'Dana' })];
    render(<LookupShell query="dana" results={results} truncated={false} tooShort={false} />);
    expect(screen.getByRole('group', { name: /filter results by type/i })).toBeInTheDocument();
    expect(screen.getByText(/results · 1/i)).toBeInTheDocument();
  });

  it('selecting a result shows the drill-in in a two-column grid', async () => {
    const user = userEvent.setup();
    const results = [result({ id: 'u1', type: 'user', title: 'Dana Whitfield' })];
    render(<LookupShell query="dana" results={results} truncated={false} tooShort={false} />);

    expect(screen.queryByText(/there's no user page yet/i)).not.toBeInTheDocument();
    await user.click(screen.getByText('Dana Whitfield'));
    expect(screen.getByText(/there's no user page yet/i)).toBeInTheDocument(); // drill-in mounted
  });

  it('clicking the "orgs" chip filters the list to companies + agencies', async () => {
    const user = userEvent.setup();
    const results = [
      result({ id: 'u1', type: 'user', title: 'Dana' }),
      result({ id: 'co1', type: 'company', title: 'Northwind' }),
    ];
    render(<LookupShell query="n" results={results} truncated={false} tooShort={false} />);

    await user.click(screen.getByRole('button', { name: /^Companies & agencies/ }));
    expect(screen.getByText('Northwind')).toBeInTheDocument();
    expect(screen.queryByText('Dana')).not.toBeInTheDocument();
  });

  it('changing the query resets the chip filter to All', async () => {
    const user = userEvent.setup();
    const results = [result({ id: 'co1', type: 'company', title: 'Northwind' })];
    const { rerender } = render(
      <LookupShell query="north" results={results} truncated={false} tooShort={false} />
    );
    await user.click(screen.getByRole('button', { name: /^Companies & agencies/ }));
    expect(screen.getByRole('button', { name: /^Companies & agencies/ })).toHaveAttribute(
      'aria-pressed',
      'true'
    );

    rerender(<LookupShell query="dana" results={[]} truncated={false} tooShort={false} />);
    expect(screen.getByRole('button', { name: /^All/ })).toHaveAttribute('aria-pressed', 'true');
  });

  it('the cap notice shows only when truncated', () => {
    const results = [result({ id: 'u1', type: 'user', title: 'Dana' })];
    render(<LookupShell query="d" results={results} truncated tooShort={false} />);
    expect(screen.getByText(/showing the first 20/i)).toBeInTheDocument();
  });

  it('changing to a DIFFERENT non-empty query clears a stale drill-in selection (F4)', async () => {
    const user = userEvent.setup();
    const resultsA = [result({ id: 'u1', type: 'user', title: 'Dana Whitfield' })];
    const { rerender } = render(
      <LookupShell query="dana" results={resultsA} truncated={false} tooShort={false} />
    );
    await user.click(screen.getByText('Dana Whitfield'));
    expect(screen.getByText(/there's no user page yet/i)).toBeInTheDocument();

    const resultsB = [result({ id: 'co1', type: 'company', title: 'Northwind' })];
    rerender(<LookupShell query="north" results={resultsB} truncated={false} tooShort={false} />);

    expect(screen.queryByText(/there's no user page yet/i)).not.toBeInTheDocument();
    expect(screen.queryByText('Dana Whitfield')).not.toBeInTheDocument();
  });

  it('selecting a result remembers it so it appears in Recent on an empty query', async () => {
    const user = userEvent.setup();
    const results = [result({ id: 'u1', type: 'user', title: 'Dana Whitfield' })];
    const { rerender } = render(
      <LookupShell query="dana" results={results} truncated={false} tooShort={false} />
    );
    await user.click(screen.getByText('Dana Whitfield'));

    rerender(<LookupShell query="" results={[]} truncated={false} tooShort={false} />);
    expect(screen.getByText(/recent · opened by you/i)).toBeInTheDocument();
    // The selected drill-in stays mounted (selection is independent client state) AND the
    // Recent list now carries the same entry — two matches is the expected shape here.
    expect(screen.getAllByText('Dana Whitfield').length).toBeGreaterThanOrEqual(1);
  });

  it('BAL-551 R1 (mutation-proof) — a query change with a non-All chip active fires SEARCHED exactly once, under "all"', async () => {
    const user = userEvent.setup();
    const resultsA = [
      result({ id: 'u1', type: 'user', title: 'Dana' }),
      result({ id: 'co1', type: 'company', title: 'Northwind' }),
    ];
    const { rerender } = render(
      <LookupShell query="dana" results={resultsA} truncated={false} tooShort={false} />
    );
    await user.click(screen.getByRole('button', { name: /^Companies & agencies/ }));
    expect(screen.getByRole('button', { name: /^Companies & agencies/ })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    trackMock.mockClear();

    const resultsB = [result({ id: 'co2', type: 'company', title: 'Southwind' })];
    rerender(<LookupShell query="south" results={resultsB} truncated={false} tooShort={false} />);

    // The fix: exactly ONE fire for the new query, already settled under 'all' — never a
    // first fire under the stale 'orgs' chip.
    expect(trackMock).toHaveBeenCalledTimes(1);
    expect(trackMock).toHaveBeenCalledWith(
      ADMIN_LOOKUP_EVENTS.SEARCHED,
      expect.objectContaining({ type_filter: 'all' })
    );
  });
});
