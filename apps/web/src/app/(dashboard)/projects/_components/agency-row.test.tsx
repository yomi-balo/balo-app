import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/utils';
import type { AgencyRowView } from '@/lib/projects-inbox/portfolio-row';
import { AgencyRow, AgencyAvatar, StateChip } from './agency-row';

vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn() }) }));

function makeRow(overrides: Partial<AgencyRowView> = {}): AgencyRowView {
  return {
    id: 'e1',
    href: '/engagements/e1?from=agency',
    title: 'CPQ implementation',
    companyName: 'Northwind Industrial',
    deliveryState: 'changes_requested',
    detailLabel: '3 of 5 milestones',
    changeRequestNote: 'Rework the quote flow',
    deliverer: {
      expertProfileId: 'p1',
      name: 'Priya Shah',
      avatarUrl: null,
      isViewer: false,
      isFormerMember: false,
    },
    updatedRelative: '2 days ago',
    recencyAtIso: '2026-06-10T00:00:00.000Z',
    ...overrides,
  };
}

describe('AgencyRow', () => {
  it('links to the engagement with ?from=agency and labels the row for assistive tech', () => {
    render(<AgencyRow row={makeRow()} agencyName="Cloudline" fromFilter="all" last />);
    const link = screen.getByRole('link', {
      name: 'CPQ implementation for Northwind Industrial, delivered by Priya Shah, Changes requested, 3 of 5 milestones, change request: Rework the quote flow, updated 2 days ago',
    });
    expect(link).toHaveAttribute('href', '/engagements/e1?from=agency');
    expect(screen.getByText('“Rework the quote flow”')).toBeInTheDocument();
    expect(screen.getByText('3 of 5 milestones')).toBeInTheDocument();
  });

  it('names the viewer "You" and says "you" in the label', () => {
    const base = makeRow();
    render(
      <AgencyRow
        row={makeRow({ deliverer: { ...base.deliverer, isViewer: true } })}
        agencyName="Cloudline"
        fromFilter="all"
        last
      />
    );
    expect(screen.getByText('You')).toBeInTheDocument();
    expect(screen.getByRole('link')).toHaveAccessibleName(/delivered by you,/);
  });

  it('drops the note and detail on a finished row and dims it', () => {
    render(
      <AgencyRow
        row={makeRow({ deliveryState: 'completed' })}
        agencyName="Cloudline"
        fromFilter="all"
        last={false}
        finished
      />
    );
    expect(screen.queryByText(/Rework/)).not.toBeInTheDocument();
    expect(screen.queryByText('3 of 5 milestones')).not.toBeInTheDocument();
    expect(screen.getByRole('link')).toHaveClass('bg-muted/40');
    expect(screen.getByText('Completed')).toBeInTheDocument();
  });

  it('omits the marker for a current member', () => {
    render(<AgencyRow row={makeRow()} agencyName="Cloudline" fromFilter="all" last />);
    expect(screen.queryByText(/No longer at/)).not.toBeInTheDocument();
  });
});

describe('StateChip', () => {
  it.each([
    ['changes_requested', 'Changes requested'],
    ['pending_acceptance', 'Awaiting client review'],
    ['in_delivery', 'In delivery'],
    ['completed', 'Completed'],
    ['cancelled', 'Cancelled'],
  ] as const)('%s reads %s', (state, label) => {
    render(<StateChip state={state} />);
    expect(screen.getByText(label)).toBeInTheDocument();
  });
});

describe('AgencyAvatar', () => {
  it('shows up to two initials and hides from assistive tech', () => {
    const { container } = render(<AgencyAvatar id="p1" name="Priya Anne Shah" />);
    expect(container.firstChild).toHaveTextContent('PA');
    expect(container.firstChild).toHaveAttribute('aria-hidden', 'true');
  });
});
