import { describe, expect, it } from 'vitest';

import { render, screen } from '@/test/utils';
import type { MilestoneNodeView } from '@/lib/engagement/engagement-view';

import { MilestoneRow } from './milestone-row';

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
});
