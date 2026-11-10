import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen, within } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { axe } from '@/test/axe';
import { track, PROJECTS_INBOX_EVENTS } from '@/lib/analytics';
import type { AgencyPortfolioDTO, AgencyRowView } from '@/lib/projects-inbox/portfolio-row';
import { AgencyDash } from './agency-dash';

const mockReplace = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mockReplace }),
  useSearchParams: () => new URLSearchParams(''),
}));

vi.mock('motion/react', () => ({
  useReducedMotion: () => false,
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

beforeAll(() => {
  // Radix Select needs pointer-capture and scrollIntoView, which JSDOM lacks.
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => undefined;
  Element.prototype.releasePointerCapture ??= () => undefined;
  Element.prototype.scrollIntoView ??= () => undefined;
});

const PRIYA = { id: 'p-priya', name: 'Priya Shah' };
const SELF = { id: 'p-self', name: 'Alex Rivera' };
const SAM = { id: 'p-sam', name: 'Sam Ortiz' };

function row(
  id: string,
  state: AgencyRowView['deliveryState'],
  who: { id: string; name: string },
  overrides: Partial<AgencyRowView> = {},
  deliverer: Partial<AgencyRowView['deliverer']> = {}
): AgencyRowView {
  return {
    id,
    href: `/engagements/${id}?from=agency`,
    title: `Project ${id}`,
    companyName: 'Northwind Industrial',
    deliveryState: state,
    detailLabel: null,
    changeRequestNote: null,
    deliverer: {
      expertProfileId: who.id,
      name: who.name,
      avatarUrl: null,
      isViewer: who.id === SELF.id,
      isFormerMember: false,
      ...deliverer,
    },
    updatedRelative: '2 days ago',
    recencyAtIso: '2026-06-10T00:00:00.000Z',
    ...overrides,
  };
}

function makeDto(overrides: Partial<AgencyPortfolioDTO> = {}): AgencyPortfolioDTO {
  const rows = [
    row('c1', 'changes_requested', PRIYA, { changeRequestNote: 'Rework the quote flow' }),
    row('r1', 'pending_acceptance', SAM, { detailLabel: 'Auto-accepts 21 Jun' }),
    row('d1', 'in_delivery', SELF, { detailLabel: '3 of 5 milestones' }),
    row('d2', 'in_delivery', PRIYA, {}, { isFormerMember: true }),
  ];
  return {
    lens: 'agency',
    allowedLenses: ['client', 'agency'],
    agency: { id: 'ag-1', name: 'Cloudline Partners' },
    agencies: [{ id: 'ag-1', name: 'Cloudline Partners', liveCount: 4 }],
    rows,
    finishedRows: [row('f1', 'completed', PRIYA), row('f2', 'cancelled', SAM)],
    tiles: {
      changesRequested: 1,
      inDelivery: 2,
      pendingAcceptance: 1,
      live: 4,
      expertCount: 3,
    },
    isEmpty: false,
    ...overrides,
  };
}

async function pickPerson(user: ReturnType<typeof userEvent.setup>, name: RegExp): Promise<void> {
  await user.click(screen.getByRole('combobox', { name: /delivered by/i }));
  await user.click(await screen.findByRole('option', { name }));
}

describe('AgencyDash', () => {
  beforeEach(() => {
    trackMock.mockClear();
    mockReplace.mockClear();
  });

  it('renders the four tiles with the design copy and the live list ranked as given', () => {
    render(<AgencyDash dto={makeDto()} />);
    expect(screen.getByRole('button', { name: /changes requested/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /in delivery/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /awaiting review/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^live/i })).toHaveTextContent('Across 3 experts');
    expect(screen.getByRole('region', { name: 'All live projects' })).toBeInTheDocument();
    const links = within(screen.getByRole('region', { name: 'All live projects' })).getAllByRole(
      'link'
    );
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      '/engagements/c1?from=agency',
      '/engagements/r1?from=agency',
      '/engagements/d1?from=agency',
      '/engagements/d2?from=agency',
    ]);
  });

  it('never claims a row needs the viewer', () => {
    render(<AgencyDash dto={makeDto()} />);
    expect(screen.queryByText(/needs you/i)).not.toBeInTheDocument();
  });

  it('filters by tile, toggles back on a second click, and tracks the count', async () => {
    const user = userEvent.setup();
    render(<AgencyDash dto={makeDto()} />);

    await user.click(screen.getByRole('button', { name: /in delivery/i }));
    expect(screen.getByRole('region', { name: 'In delivery' })).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: /project d/i })).toHaveLength(2);
    expect(trackMock).toHaveBeenCalledWith(PROJECTS_INBOX_EVENTS.INBOX_FILTER_APPLIED, {
      lens: 'agency',
      filter: 'in_delivery',
      result_count: 2,
    });

    await user.click(screen.getByRole('button', { name: /in delivery/i }));
    expect(screen.getByRole('region', { name: 'All live projects' })).toBeInTheDocument();
  });

  it('lists You first, then others alphabetically, with counts that follow the active tile', async () => {
    const user = userEvent.setup();
    render(<AgencyDash dto={makeDto()} />);

    await user.click(screen.getByRole('combobox', { name: /delivered by/i }));
    const options = await screen.findAllByRole('option');
    // Each person option leads with the avatar initials.
    expect(options.map((o) => o.textContent)).toEqual([
      'Everyone4',
      'YYou1',
      'PSPriya Shah2',
      'SOSam Ortiz1',
    ]);
  });

  it('combines the person filter with the tile (AND) and narrows the finished group', async () => {
    const user = userEvent.setup();
    render(<AgencyDash dto={makeDto()} />);

    await user.click(screen.getByRole('button', { name: /in delivery/i }));
    await pickPerson(user, /priya shah/i);

    expect(trackMock).toHaveBeenCalledWith(PROJECTS_INBOX_EVENTS.INBOX_EXPERT_FILTER_APPLIED, {
      lens: 'agency',
      is_self: false,
      result_count: 1,
    });
    const list = screen.getByRole('region', { name: 'In delivery' });
    expect(within(list).getAllByRole('link')).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: /completed and cancelled/i }));
    const finishedLinks = screen
      .getAllByRole('link')
      .filter((a) => a.getAttribute('href')?.startsWith('/engagements/f'));
    expect(finishedLinks.map((a) => a.getAttribute('href'))).toEqual([
      '/engagements/f1?from=agency',
    ]);
  });

  it('tracks is_self when the viewer picks themselves', async () => {
    const user = userEvent.setup();
    render(<AgencyDash dto={makeDto()} />);
    await pickPerson(user, /^you/i);
    expect(trackMock).toHaveBeenCalledWith(PROJECTS_INBOX_EVENTS.INBOX_EXPERT_FILTER_APPLIED, {
      lens: 'agency',
      is_self: true,
      result_count: 1,
    });
  });

  it('shows the no-match state and resets both filters with Show all', async () => {
    const user = userEvent.setup();
    render(<AgencyDash dto={makeDto()} />);

    await user.click(screen.getByRole('button', { name: /awaiting review/i }));
    await pickPerson(user, /priya shah/i);
    expect(screen.getByText('No live projects match these filters.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Show all' }));
    expect(screen.getByRole('region', { name: 'All live projects' })).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: /project/i }).length).toBeGreaterThanOrEqual(4);
  });

  it('shows the former-teammate marker in text and aria-label', () => {
    render(<AgencyDash dto={makeDto()} />);
    expect(screen.getByText('No longer at Cloudline Partners')).toBeInTheDocument();
    expect(
      screen.getByRole('link', {
        name: 'Project d2 for Northwind Industrial, delivered by Priya Shah, In delivery, no longer at Cloudline Partners, updated 2 days ago',
      })
    ).toBeInTheDocument();
  });

  it('shows the picker only with two or more agencies and writes the URL on change', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<AgencyDash dto={makeDto()} />);
    expect(screen.queryByRole('combobox', { name: /^agency:/i })).not.toBeInTheDocument();

    rerender(
      <AgencyDash
        dto={makeDto({
          agencies: [
            { id: 'ag-1', name: 'Cloudline Partners', liveCount: 4 },
            { id: 'ag-2', name: 'Zenith', liveCount: 1 },
          ],
        })}
      />
    );
    await user.click(screen.getByRole('combobox', { name: /^agency:/i }));
    await user.click(await screen.findByRole('option', { name: /zenith/i }));

    expect(mockReplace).toHaveBeenCalledWith('/projects?lens=agency&agency=ag-2', {
      scroll: false,
    });
    expect(trackMock).toHaveBeenCalledWith(PROJECTS_INBOX_EVENTS.INBOX_AGENCY_SWITCHED, {
      agency_count: 2,
    });
  });

  it('renders the invitation empty state with no filters', () => {
    render(
      <AgencyDash
        dto={makeDto({ rows: [], finishedRows: [], isEmpty: true, tiles: zeroTiles() })}
      />
    );
    expect(screen.getByText("Cloudline Partners's projects will gather here")).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: /delivered by/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/no live projects yet/i)).not.toBeInTheDocument();
  });

  it('invites rather than says "no match" when only finished work exists and no filter is on', () => {
    render(
      <AgencyDash
        dto={makeDto({
          rows: [],
          tiles: zeroTiles(),
          finishedRows: [row('f1', 'completed', PRIYA)],
        })}
      />
    );
    expect(
      screen.getByText(
        'Nothing is in delivery right now — new projects with Cloudline Partners experts will show up here.'
      )
    ).toBeInTheDocument();
    expect(screen.queryByText('No live projects match these filters.')).not.toBeInTheDocument();
  });

  it('renders nothing for the finished group when there are no finished rows', () => {
    render(<AgencyDash dto={makeDto({ finishedRows: [] })} />);
    expect(screen.queryByText('Completed and cancelled')).not.toBeInTheDocument();
  });

  it('fires the row click analytics with the agency lens', async () => {
    const user = userEvent.setup();
    render(<AgencyDash dto={makeDto()} />);
    const link = screen.getByRole('link', { name: /project d1 for/i });
    link.addEventListener('click', (e) => e.preventDefault());
    await user.click(link);
    expect(trackMock).toHaveBeenCalledWith(PROJECTS_INBOX_EVENTS.INBOX_LIST_ROW_CLICKED, {
      lens: 'agency',
      request_id: null,
      stage: 'in_delivery',
      needs_you: false,
      from_filter: 'all',
    });
  });

  it('has no axe violations', async () => {
    const { container } = render(<AgencyDash dto={makeDto()} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});

function zeroTiles(): AgencyPortfolioDTO['tiles'] {
  return { changesRequested: 0, inDelivery: 0, pendingAcceptance: 0, live: 0, expertCount: 0 };
}
