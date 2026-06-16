import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { track, PROJECTS_INBOX_EVENTS } from '@/lib/analytics';
import type { AdminPortfolioDTO } from '@/lib/projects-inbox/portfolio-row';
import { AdminDash } from './admin-dash';

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

const DTO: AdminPortfolioDTO = {
  lens: 'admin',
  allowedLenses: ['client', 'admin'],
  triage: [
    {
      id: 't1',
      href: '/projects/t1',
      title: 'Org merge after acquisition',
      companyName: 'Pacific Retail Group',
      raisedRelative: 'yesterday',
      overdue: true,
    },
  ],
  kanban: [
    {
      stage: 'invited',
      label: 'Inviting',
      items: [
        {
          id: 'k1',
          href: '/projects/k1',
          title: 'Marketing Cloud audit',
          companyName: 'Bright Foods',
          updatedRelative: '3 days ago',
          stalledLabel: 'No EOIs · 3d',
        },
      ],
    },
    { stage: 'eoi', label: 'Conversations', items: [] },
    { stage: 'prop_req', label: 'Proposal requested', items: [] },
    { stage: 'prop_in', label: 'Proposals', items: [] },
    { stage: 'accepted', label: 'Kickoff gate', items: [] },
  ],
  tiles: { untriaged: 1, stalled: 1, pipeline: 1, gate: 0 },
  isEmpty: false,
};

describe('AdminDash', () => {
  beforeEach(() => {
    trackMock.mockClear();
    window.sessionStorage.clear();
  });

  it('renders the triage hero with the >24h overdue pill', () => {
    render(<AdminDash dto={DTO} />);
    const triage = screen.getByRole('region', { name: /needs triage/i });
    expect(within(triage).getByText('Org merge after acquisition')).toBeInTheDocument();
    expect(within(triage).getByText('>24h')).toBeInTheDocument();
  });

  it('renders the pipeline kanban with a stalled card pill', () => {
    render(<AdminDash dto={DTO} />);
    const pipeline = screen.getByRole('region', { name: /pipeline by stage/i });
    expect(within(pipeline).getByText('Marketing Cloud audit')).toBeInTheDocument();
    expect(within(pipeline).getByText('No EOIs · 3d')).toBeInTheDocument();
  });

  it('renders read-only stat tiles (disabled buttons)', () => {
    render(<AdminDash dto={DTO} />);
    const untriagedTile = screen.getByRole('button', { name: /untriaged/i });
    expect(untriagedTile).toBeDisabled();
  });

  it('fires inbox_hero_cta_clicked on the triage CTA', async () => {
    const user = userEvent.setup();
    render(<AdminDash dto={DTO} />);
    await user.click(screen.getByRole('link', { name: /^triage$/i }));
    expect(trackMock).toHaveBeenCalledWith(
      PROJECTS_INBOX_EVENTS.INBOX_HERO_CTA_CLICKED,
      expect.objectContaining({
        lens: 'admin',
        request_id: 't1',
        stage: 'requested',
        nudge: 'Triage',
      })
    );
  });

  it('fires inbox_list_row_clicked on a kanban card', async () => {
    const user = userEvent.setup();
    render(<AdminDash dto={DTO} />);
    await user.click(screen.getByRole('link', { name: /marketing cloud audit/i }));
    expect(trackMock).toHaveBeenCalledWith(PROJECTS_INBOX_EVENTS.INBOX_LIST_ROW_CLICKED, {
      lens: 'admin',
      request_id: 'k1',
      stage: 'pipeline',
      needs_you: true,
      from_filter: 'all',
    });
  });
});
