import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { track, PROJECTS_INBOX_EVENTS } from '@/lib/analytics';
import type { PortfolioDTO, PortfolioRowView } from '@/lib/projects-inbox/portfolio-row';
import { ParticipantDash } from './participant-dash';

// Render motion elements as plain DOM so JSDOM doesn't choke on animations.
vi.mock('motion/react', () => ({
  motion: new Proxy(
    {},
    {
      get: (_target, tag: string) => {
        const Component = ({
          children,
          ...rest
        }: {
          children?: React.ReactNode;
        } & Record<string, unknown>): React.JSX.Element => {
          // Strip motion-only props that are invalid on DOM nodes.
          const { initial, animate, transition, exit, whileHover, whileTap, ...domProps } =
            rest as Record<string, unknown>;
          void initial;
          void animate;
          void transition;
          void exit;
          void whileHover;
          void whileTap;
          const Tag = tag as keyof React.JSX.IntrinsicElements;
          return <Tag {...domProps}>{children}</Tag>;
        };
        return Component;
      },
    }
  ),
}));

const trackMock = vi.mocked(track);

function makeRow(overrides: Partial<PortfolioRowView> = {}): PortfolioRowView {
  return {
    id: 'r1',
    href: '/projects/r1',
    title: 'Row',
    companyName: 'Co',
    stage: 'invited',
    stageLabel: 'Experts invited',
    needsYou: false,
    nudgeLabel: 'Waiting on experts',
    unread: false,
    updatedRelative: '3 days ago',
    recencyAtIso: '2026-06-10T00:00:00.000Z',
    signal: null,
    kind: 'request',
    ...overrides,
  };
}

const NEEDS_ROW = makeRow({
  id: 'needs-1',
  title: 'CPQ implementation',
  stage: 'prop_in',
  stageLabel: 'Proposals in',
  needsYou: true,
  nudgeLabel: 'Review 2 proposals',
  unread: true,
});
const PROGRESS_ROW = makeRow({ id: 'prog-1', title: 'Marketing Cloud audit' });
const KICKED_ROW = makeRow({
  id: 'kick-1',
  title: 'Sales Cloud health check',
  stage: 'kicked',
  stageLabel: 'Kicked off',
  nudgeLabel: 'Live project',
});

const DTO: PortfolioDTO = {
  lens: 'client',
  allowedLenses: ['client'],
  rows: [NEEDS_ROW, PROGRESS_ROW, KICKED_ROW],
  tiles: { needs: 1, inProgress: 1, kicked: 1, total: 3 },
  isEmpty: false,
};

describe('ParticipantDash', () => {
  beforeEach(() => {
    trackMock.mockClear();
  });

  it('renders the hero for needs-you rows AND lists them too (promotion, not partition)', () => {
    render(<ParticipantDash dto={DTO} />);

    const hero = screen.getByRole('region', { name: /needs your attention/i });
    expect(within(hero).getByText('CPQ implementation')).toBeInTheDocument();

    // The same needs-you row ALSO appears in the full list.
    const list = screen.getByRole('region', { name: /all requests/i });
    expect(within(list).getByText('CPQ implementation')).toBeInTheDocument();
    expect(within(list).getByText('Marketing Cloud audit')).toBeInTheDocument();
    expect(within(list).getByText('Sales Cloud health check')).toBeInTheDocument();
  });

  it('renders both chips on a needs-you list row (stage + nudge)', () => {
    render(<ParticipantDash dto={DTO} />);
    const list = screen.getByRole('region', { name: /all requests/i });
    // Stage chip + nudge chip both appear (nudge label is needs-you specific).
    expect(within(list).getAllByText('Proposals in').length).toBeGreaterThan(0);
    expect(within(list).getAllByText('Review 2 proposals').length).toBeGreaterThan(0);
  });

  it('filters to the kicked slice and fires inbox_filter_applied', async () => {
    const user = userEvent.setup();
    render(<ParticipantDash dto={DTO} />);

    await user.click(screen.getByRole('button', { name: /kicked off/i }));

    expect(trackMock).toHaveBeenCalledWith(PROJECTS_INBOX_EVENTS.INBOX_FILTER_APPLIED, {
      lens: 'client',
      filter: 'kicked',
      result_count: 1,
    });

    // Hero hides (filter !== all/needs); only the kicked row remains in the list.
    expect(screen.queryByRole('region', { name: /needs your attention/i })).not.toBeInTheDocument();
    const list = screen.getByRole('region', { name: /live projects/i });
    expect(within(list).getByText('Sales Cloud health check')).toBeInTheDocument();
    expect(within(list).queryByText('Marketing Cloud audit')).not.toBeInTheDocument();
  });

  it('shows the inline "nothing needs you" empty when the needs filter is empty', async () => {
    const user = userEvent.setup();
    const emptyNeeds: PortfolioDTO = {
      ...DTO,
      rows: [PROGRESS_ROW, KICKED_ROW],
      tiles: { needs: 0, inProgress: 1, kicked: 1, total: 2 },
    };
    render(<ParticipantDash dto={emptyNeeds} />);

    await user.click(screen.getByRole('button', { name: /needs you/i }));

    expect(screen.getByText(/nothing needs you right now/i)).toBeInTheDocument();
  });

  it('toggles a filter off (back to all) when the active tile is clicked again', async () => {
    const user = userEvent.setup();
    render(<ParticipantDash dto={DTO} />);

    // Re-query between clicks: each render replaces the tile DOM node.
    await user.click(screen.getByRole('button', { name: /kicked off/i })); // → kicked
    await user.click(screen.getByRole('button', { name: /kicked off/i })); // → back to all

    const lastCall = trackMock.mock.calls.at(-1);
    expect(lastCall?.[1]).toMatchObject({ filter: 'all', result_count: 3 });
  });

  it('shows the New request button for the client lens', () => {
    render(<ParticipantDash dto={DTO} />);
    expect(screen.getByRole('link', { name: /new request/i })).toHaveAttribute('href', '/experts');
  });
});
