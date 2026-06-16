import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/utils';
import type { AdminPortfolioDTO, PortfolioDTO } from '@/lib/projects-inbox/portfolio-row';
import { ProjectsInboxShell } from './projects-inbox-shell';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
}));

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

const EMPTY_CLIENT: PortfolioDTO = {
  lens: 'client',
  allowedLenses: ['client'],
  rows: [],
  tiles: { needs: 0, inProgress: 0, kicked: 0, total: 0 },
  isEmpty: true,
};

const ADMIN_DTO: AdminPortfolioDTO = {
  lens: 'admin',
  allowedLenses: ['client', 'admin'],
  triage: [],
  kanban: [{ stage: 'invited', label: 'Inviting', items: [] }],
  tiles: { untriaged: 0, stalled: 0, pipeline: 0, gate: 0 },
  isEmpty: false,
};

describe('ProjectsInboxShell', () => {
  it('renders the per-lens "Viewing as" line and subtitle', () => {
    render(<ProjectsInboxShell dto={EMPTY_CLIENT} />);
    expect(screen.getByText('Client')).toBeInTheDocument();
    expect(screen.getByText(/from idea to kickoff/i)).toBeInTheDocument();
  });

  it('hides the lens switch for a single-lens viewer', () => {
    render(<ProjectsInboxShell dto={EMPTY_CLIENT} />);
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
  });

  it('shows the lens switch for a multi-lens viewer', () => {
    render(<ProjectsInboxShell dto={ADMIN_DTO} />);
    expect(screen.getByRole('tablist', { name: /portfolio lens/i })).toBeInTheDocument();
  });

  it('renders the empty state when the DTO is empty', () => {
    render(<ProjectsInboxShell dto={EMPTY_CLIENT} />);
    expect(screen.getByText('Start your first project')).toBeInTheDocument();
  });

  it('renders the admin dashboard for the admin lens', () => {
    render(<ProjectsInboxShell dto={ADMIN_DTO} />);
    expect(screen.getByRole('region', { name: /pipeline by stage/i })).toBeInTheDocument();
  });
});
