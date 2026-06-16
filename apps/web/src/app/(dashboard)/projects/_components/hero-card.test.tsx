import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { track, PROJECTS_INBOX_EVENTS } from '@/lib/analytics';
import type { PortfolioRowView } from '@/lib/projects-inbox/portfolio-row';
import { HeroCard } from './hero-card';

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

const ROW: PortfolioRowView = {
  id: 'req-1',
  href: '/projects/req-1',
  title: 'CPQ implementation',
  companyName: 'Northwind Industrial',
  stage: 'prop_in',
  stageLabel: 'Proposals in',
  needsYou: true,
  nudgeLabel: 'Review 2 proposals',
  unread: true,
  updatedRelative: '2h ago',
  recencyAtIso: '2026-06-16T10:00:00.000Z',
  signal: { from: 'Expert', messagePreview: 'Proposal submitted — A$58,000.' },
  kind: 'request',
};

describe('HeroCard', () => {
  beforeEach(() => {
    trackMock.mockClear();
    globalThis.sessionStorage.clear();
  });

  it('renders the title, nudge CTA, stage chip and signal', () => {
    render(<HeroCard row={ROW} lens="client" index={0} />);
    expect(screen.getByText('CPQ implementation')).toBeInTheDocument();
    expect(screen.getByText('Review 2 proposals')).toBeInTheDocument();
    expect(screen.getByText('Proposals in')).toBeInTheDocument();
    expect(screen.getByText(/proposal submitted/i)).toBeInTheDocument();
  });

  it('fires inbox_hero_cta_clicked with the row context on CTA click', async () => {
    const user = userEvent.setup();
    render(<HeroCard row={ROW} lens="client" index={0} />);

    await user.click(screen.getByRole('link', { name: /review 2 proposals/i }));

    expect(trackMock).toHaveBeenCalledWith(
      PROJECTS_INBOX_EVENTS.INBOX_HERO_CTA_CLICKED,
      expect.objectContaining({
        lens: 'client',
        request_id: 'req-1',
        stage: 'prop_in',
        nudge: 'Review 2 proposals',
      })
    );
  });
});
