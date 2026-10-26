import { describe, expect, it } from 'vitest';

import { render, screen } from '@/test/utils';
import type { MilestoneNodeView } from '@/lib/engagement/engagement-view';

import { MilestoneRow } from './milestone-row';
import { milestoneTimeView } from './time/fixtures';

function makeNode(overrides: Partial<MilestoneNodeView> = {}): MilestoneNodeView {
  return {
    id: 'm-1',
    title: 'Discovery workshop',
    descriptionHtml: null,
    descriptionText: null,
    acceptanceCriteria: null,
    status: 'pending',
    nodeVariant: 'pending',
    statusLabel: 'Not started',
    connectorFilled: false,
    valueLabel: null,
    startedLabel: null,
    completedLabel: null,
    completionNote: null,
    feedback: null,
    changePending: false,
    changeProvenance: null,
    proposalChanges: [],
    removalNeedsChangeOrder: false,
    ...overrides,
  };
}

describe('MilestoneRow', () => {
  it('renders the title, status pill, and optional value pill', () => {
    render(
      <MilestoneRow
        node={makeNode({ statusLabel: 'Not started', valueLabel: 'A$14,500' })}
        isLast
      />
    );
    expect(screen.getByText('Discovery workshop')).toBeInTheDocument();
    expect(screen.getByText('Not started')).toBeInTheDocument();
    expect(screen.getByText('A$14,500')).toBeInTheDocument();
  });

  it('injects the already-sanitised description HTML', () => {
    render(
      <MilestoneRow
        node={makeNode({ descriptionHtml: '<p>Scope the data model together.</p>' })}
        isLast
      />
    );
    expect(screen.getByText('Scope the data model together.')).toBeInTheDocument();
  });

  it('renders acceptance criteria under a "Done when:" label', () => {
    render(
      <MilestoneRow node={makeNode({ acceptanceCriteria: 'The sandbox passes UAT.' })} isLast />
    );
    expect(screen.getByText('Done when:')).toBeInTheDocument();
    expect(screen.getByText(/The sandbox passes UAT\./)).toBeInTheDocument();
  });

  it('joins started + completed timing labels with a separator', () => {
    render(
      <MilestoneRow
        node={makeNode({
          nodeVariant: 'completed',
          startedLabel: 'Started 16 Jun',
          completedLabel: 'Completed 30 Jun by Priya',
        })}
        isLast
      />
    );
    expect(screen.getByText('Started 16 Jun · Completed 30 Jun by Priya')).toBeInTheDocument();
  });

  it('renders the success-tinted "Delivered:" completion note', () => {
    render(
      <MilestoneRow
        node={makeNode({ nodeVariant: 'completed', completionNote: 'Shipped the report.' })}
        isLast
      />
    );
    expect(screen.getByText('Delivered:')).toBeInTheDocument();
    expect(screen.getByText(/Shipped the report\./)).toBeInTheDocument();
  });

  it('renders the actions slot when provided', () => {
    render(
      <MilestoneRow
        node={makeNode()}
        isLast
        actions={<button type="button">Start milestone</button>}
      />
    );
    expect(screen.getByRole('button', { name: 'Start milestone' })).toBeInTheDocument();
  });

  it('renders no action buttons when the actions slot is omitted', () => {
    render(<MilestoneRow node={makeNode()} isLast />);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('fills the connector with the gradient below a completed node (not the last)', () => {
    const { container } = render(
      <MilestoneRow
        node={makeNode({ nodeVariant: 'completed', connectorFilled: true })}
        isLast={false}
      />
    );
    const connector = container.querySelector('div.w-\\[2\\.5px\\]');
    expect(connector).not.toBeNull();
    expect(connector?.className).toContain('from-primary');
  });

  describe('change-request feedback', () => {
    const feedback = {
      calloutHeading: 'Dana @ Northwind requested changes · 6 Jul',
      note: 'The export is missing Q3.',
      addressedLabel: 'Feedback addressed',
    };

    it('shows the "Changes requested" chip and the quoted callout while the milestone is open', () => {
      render(
        <MilestoneRow
          node={makeNode({
            status: 'in_progress',
            nodeVariant: 'in_progress',
            statusLabel: 'In progress',
            feedback,
          })}
          isLast
        />
      );
      expect(screen.getByText('Changes requested')).toBeInTheDocument();
      expect(screen.getByText(feedback.calloutHeading)).toBeInTheDocument();
      expect(screen.getByText(feedback.note)).toBeInTheDocument();
      expect(screen.queryByText('Feedback addressed')).not.toBeInTheDocument();
    });

    it('swaps to the addressed chip, with no callout, once the milestone is completed', () => {
      render(
        <MilestoneRow
          node={makeNode({
            status: 'completed',
            nodeVariant: 'completed',
            statusLabel: 'Completed',
            feedback,
          })}
          isLast
        />
      );
      expect(screen.getByText('Feedback addressed')).toBeInTheDocument();
      expect(screen.queryByText('Changes requested')).not.toBeInTheDocument();
      expect(screen.queryByText(feedback.note)).not.toBeInTheDocument();
    });

    it('renders neither chip nor callout when the milestone carries no feedback', () => {
      render(<MilestoneRow node={makeNode()} isLast />);
      expect(screen.queryByText('Changes requested')).not.toBeInTheDocument();
      expect(screen.queryByText('Feedback addressed')).not.toBeInTheDocument();
    });
  });

  describe('approved-change markers', () => {
    it('marks a milestone added or updated by an approved change', () => {
      const { rerender } = render(
        <MilestoneRow node={makeNode({ changeProvenance: 'added' })} isLast />
      );
      expect(screen.getByText('Added by approved change')).toBeInTheDocument();
      rerender(<MilestoneRow node={makeNode({ changeProvenance: 'updated' })} isLast />);
      expect(screen.getByText('Updated by approved change')).toBeInTheDocument();
      expect(screen.queryByText('Added by approved change')).not.toBeInTheDocument();
    });

    it('shows the "Change pending" chip while a sent change touches the milestone', () => {
      render(<MilestoneRow node={makeNode({ changePending: true })} isLast />);
      expect(screen.getByText('Change pending')).toBeInTheDocument();
    });

    it('shows neither marker on an untouched milestone', () => {
      render(<MilestoneRow node={makeNode()} isLast />);
      expect(screen.queryByText('Change pending')).not.toBeInTheDocument();
      expect(screen.queryByText(/approved change/)).not.toBeInTheDocument();
    });
  });

  it('marks a reworded milestone and lists what changed under a disclosure', () => {
    render(
      <MilestoneRow
        node={makeNode({
          proposalChanges: [
            { field: 'title', label: 'Title', before: 'Discovery', after: 'Discovery & design' },
            { field: 'acceptance_criteria', label: 'Done when', before: '', after: 'Signed off' },
          ],
        })}
        isLast
      />
    );
    expect(screen.getByText('Changed since proposal')).toBeInTheDocument();
    expect(screen.getByText('What changed')).toBeInTheDocument();
    const items = screen.getAllByRole('listitem', { hidden: true });
    expect(items[0]).toHaveTextContent('Title: was “Discovery”, now “Discovery & design”');
    expect(items[1]).toHaveTextContent('Done when: was empty, now “Signed off”');
  });

  it('shows no chip or disclosure for a milestone with no wording changes', () => {
    render(<MilestoneRow node={makeNode()} isLast />);
    expect(screen.queryByText('Changed since proposal')).not.toBeInTheDocument();
    expect(screen.queryByText('What changed')).not.toBeInTheDocument();
  });

  describe('time and materials', () => {
    it('renders the hours bar and a collapsible time log with its entries', () => {
      render(<MilestoneRow node={makeNode()} isLast time={milestoneTimeView()} />);
      expect(screen.getByText('4 of 8 hrs logged')).toBeInTheDocument();
      expect(screen.getByText('Time log (1)')).toBeInTheDocument();
      expect(screen.getByText('Mapped the discovery flows')).toBeInTheDocument();
      expect(screen.getByText('Logged by Priya')).toBeInTheDocument();
    });

    it('renders the per-entry controls slot', () => {
      render(
        <MilestoneRow
          node={makeNode()}
          isLast
          time={milestoneTimeView()}
          timeControls={(entry) => <button type="button">Edit {entry.id}</button>}
        />
      );
      expect(screen.getByRole('button', { name: 'Edit te-1' })).toBeInTheDocument();
    });

    it('shows the invitation, and no time log toggle, when nothing is logged yet', () => {
      render(
        <MilestoneRow
          node={makeNode()}
          isLast
          time={milestoneTimeView({
            loggedMinutes: 0,
            entries: [],
            logToggleLabel: 'Time log (0)',
            authorsLabel: null,
            emptyLabel: 'Log time as you work — Northwind sees every entry and its note.',
            overNoticeSent: false,
          })}
        />
      );
      expect(screen.getByText(/Log time as you work/)).toBeInTheDocument();
      expect(screen.queryByText('Time log (0)')).not.toBeInTheDocument();
    });

    it('renders no time surface without a time view, or for an unestimated untouched milestone', () => {
      const { rerender } = render(<MilestoneRow node={makeNode()} isLast />);
      expect(screen.queryByText(/hrs logged/)).not.toBeInTheDocument();
      rerender(
        <MilestoneRow
          node={makeNode()}
          isLast
          time={milestoneTimeView({
            estimatedMinutes: null,
            loggedMinutes: 0,
            entries: [],
            authorsLabel: null,
          })}
        />
      );
      expect(screen.queryByText(/hrs logged/)).not.toBeInTheDocument();
    });
  });
});
