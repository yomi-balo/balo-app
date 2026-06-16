import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { track, PROJECTS_INBOX_EVENTS } from '@/lib/analytics';
import type { PortfolioRowView } from '@/lib/projects-inbox/portfolio-row';
import { ListRow } from './list-row';

const trackMock = vi.mocked(track);

function makeRow(overrides: Partial<PortfolioRowView> = {}): PortfolioRowView {
  return {
    id: 'req-1',
    href: '/projects/req-1',
    title: 'Service Cloud migration',
    companyName: 'Northwind',
    stage: 'eoi',
    stageLabel: 'In conversation',
    needsYou: false,
    nudgeLabel: 'Waiting on experts',
    unread: false,
    updatedRelative: 'yesterday',
    recencyAtIso: '2026-06-15T00:00:00.000Z',
    signal: null,
    kind: 'request',
    ...overrides,
  };
}

describe('ListRow', () => {
  beforeEach(() => {
    trackMock.mockClear();
  });

  it('renders both chips for a needs-you row (stage + gradient nudge)', () => {
    render(
      <ListRow
        row={makeRow({ needsYou: true, nudgeLabel: 'Submit your EOI' })}
        lens="expert"
        fromFilter="all"
        last
      />
    );
    expect(screen.getByText('In conversation')).toBeInTheDocument();
    expect(screen.getByText('Submit your EOI')).toBeInTheDocument();
  });

  it('fires inbox_list_row_clicked with the row context', async () => {
    const user = userEvent.setup();
    render(<ListRow row={makeRow()} lens="client" fromFilter="all" last />);

    await user.click(screen.getByRole('link', { name: /service cloud migration/i }));

    expect(trackMock).toHaveBeenCalledWith(PROJECTS_INBOX_EVENTS.INBOX_LIST_ROW_CLICKED, {
      lens: 'client',
      request_id: 'req-1',
      stage: 'eoi',
      needs_you: false,
      from_filter: 'all',
    });
  });

  it('renders a non-navigable row (no link) when href is null', () => {
    render(<ListRow row={makeRow({ href: null })} lens="expert" fromFilter="all" last />);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getByText('Service Cloud migration')).toBeInTheDocument();
  });
});
