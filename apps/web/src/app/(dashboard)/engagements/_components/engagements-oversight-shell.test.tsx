import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { track } from '@/lib/analytics';
import {
  deriveOversightCounts,
  type EngagementOversightRow,
  type EngagementsOversightDTO,
} from '@/lib/engagements/oversight-row';
import { EngagementsOversightShell } from './engagements-oversight-shell';

vi.mock('motion/react', () => ({
  motion: new Proxy(
    {},
    {
      get:
        (_t, tag: string) =>
        ({ children, ...rest }: { children?: React.ReactNode } & Record<string, unknown>) => {
          const { initial, animate, transition, ...domProps } = rest;
          void initial;
          void animate;
          void transition;
          const Tag = tag as keyof React.JSX.IntrinsicElements;
          return <Tag {...domProps}>{children}</Tag>;
        },
    }
  ),
}));

const trackMock = vi.mocked(track);

function makeRow(overrides: Partial<EngagementOversightRow> = {}): EngagementOversightRow {
  return {
    id: 'e-1',
    href: '/engagements/e-1',
    status: 'active',
    title: 'A generic engagement',
    client: 'Northwind Industrial',
    expertLabel: 'Priya Nair',
    progress: { done: 1, total: 3 },
    pricingLabel: 'Fixed · A$40,000',
    kickoffIso: '2026-06-12T00:00:00.000Z',
    lastActivityRelative: '2 days ago',
    lastActivityIso: '2026-06-14T00:00:00.000Z',
    stalled: false,
    quietDays: 2,
    ...overrides,
  };
}

// A worked portfolio: 1 active, 1 in-review, 1 stalled-active, 1 completed, 0 cancelled.
const ACTIVE_ROW = makeRow({ id: 'a', title: 'Active delivery project' });
const IN_REVIEW_ROW = makeRow({
  id: 'r',
  title: 'In review project',
  status: 'pending_acceptance',
  autoAcceptIso: '2026-06-19T00:00:00.000Z',
});
const STALLED_ROW = makeRow({
  id: 's',
  title: 'Stalled project',
  status: 'active',
  stalled: true,
  quietDays: 18,
});
const COMPLETED_ROW = makeRow({
  id: 'c',
  title: 'Completed project',
  status: 'completed',
  acceptance: {
    method: 'client',
    byLabel: 'Sam Rivera @ Bright Foods',
    onIso: '2026-06-03T00:00:00.000Z',
  },
});

function makeDto(rows: EngagementOversightRow[]): EngagementsOversightDTO {
  return { rows, counts: deriveOversightCounts(rows), isEmpty: rows.length === 0 };
}

const FULL_DTO = makeDto([ACTIVE_ROW, IN_REVIEW_ROW, STALLED_ROW, COMPLETED_ROW]);

describe('EngagementsOversightShell', () => {
  beforeEach(() => {
    trackMock.mockClear();
  });

  it('defaults to the in-flight slice (active + in review), hiding completed', () => {
    render(<EngagementsOversightShell dto={FULL_DTO} />);
    expect(screen.getByText('Active delivery project')).toBeInTheDocument();
    expect(screen.getByText('In review project')).toBeInTheDocument();
    expect(screen.getByText('Stalled project')).toBeInTheDocument();
    expect(screen.queryByText('Completed project')).not.toBeInTheDocument();
  });

  it('surfaces the one emphasised next-best-action (chase stalled) and applies it', async () => {
    const user = userEvent.setup();
    render(<EngagementsOversightShell dto={FULL_DTO} />);
    const action = screen.getByRole('button', { name: /chase 1 stalled/i });
    await user.click(action);
    // Now filtered to the stalled slice only.
    expect(screen.getByText('Stalled project')).toBeInTheDocument();
    expect(screen.queryByText('Active delivery project')).not.toBeInTheDocument();
  });

  it('switches the filter from a status tile', async () => {
    const user = userEvent.setup();
    render(<EngagementsOversightShell dto={FULL_DTO} />);
    await user.click(screen.getByRole('button', { name: /completed/i }));
    expect(screen.getByText('Completed project')).toBeInTheDocument();
    expect(screen.queryByText('Active delivery project')).not.toBeInTheDocument();
  });

  it('shows a per-filter invitation (not a bare empty) when a slice is empty, and clears back', async () => {
    const user = userEvent.setup();
    render(<EngagementsOversightShell dto={FULL_DTO} />);
    await user.click(screen.getByRole('button', { name: /cancelled/i }));
    expect(screen.getByText('Nothing cancelled')).toBeInTheDocument();
    // Both the section label and the empty-state offer the same clear action.
    const [backButton] = screen.getAllByRole('button', { name: /back to in flight/i });
    if (backButton === undefined) throw new Error('expected a back-to-in-flight action');
    await user.click(backButton);
    // Back on the in-flight default.
    expect(screen.getByText('Active delivery project')).toBeInTheDocument();
  });

  it('renders the true-zero invitation (not tiles) when the DTO is empty', () => {
    render(<EngagementsOversightShell dto={makeDto([])} />);
    expect(screen.getByText('No engagements in flight yet')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /active/i })).not.toBeInTheDocument();
  });

  it('surfaces the amber "in client review" action when nothing is stalled', async () => {
    const user = userEvent.setup();
    render(<EngagementsOversightShell dto={makeDto([ACTIVE_ROW, IN_REVIEW_ROW])} />);
    // No stalled rows → the amber review action, not the warm chase action.
    expect(screen.queryByRole('button', { name: /chase/i })).not.toBeInTheDocument();
    const action = screen.getByRole('button', { name: /1 in client review/i });
    await user.click(action);
    expect(screen.getByText('In review project')).toBeInTheDocument();
    expect(screen.queryByText('Active delivery project')).not.toBeInTheDocument();
  });

  it('shows no next-best-action and a pipeline CTA when only archived work exists', () => {
    // Non-empty DTO (a completed engagement) but the in-flight default slice is empty.
    render(<EngagementsOversightShell dto={makeDto([COMPLETED_ROW])} />);
    expect(
      screen.queryByRole('button', { name: /chase|in client review/i })
    ).not.toBeInTheDocument();
    expect(screen.getByText('Nothing in flight')).toBeInTheDocument();
    // The one action on the in-flight-empty surface points at the pipeline — not a no-op reset.
    expect(screen.getByRole('link', { name: /go to the pipeline/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /back to in flight/i })).not.toBeInTheDocument();
  });

  it('fires the list_viewed analytics event on mount', () => {
    render(<EngagementsOversightShell dto={FULL_DTO} />);
    expect(trackMock).toHaveBeenCalledWith(
      expect.stringContaining('admin_engagements_list_viewed'),
      expect.objectContaining({
        filter: 'in_flight',
        count_active: 2,
        count_in_review: 1,
        count_stalled: 1,
      })
    );
  });
});
