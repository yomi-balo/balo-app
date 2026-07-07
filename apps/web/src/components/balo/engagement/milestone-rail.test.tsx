import { describe, expect, it } from 'vitest';

import { render, screen, within } from '@/test/utils';
import type { MilestoneNodeView } from '@/lib/engagement/engagement-view';

import { MilestoneRail } from './milestone-rail';

function makeNode(overrides: Partial<MilestoneNodeView> = {}): MilestoneNodeView {
  return {
    id: 'm-1',
    title: 'Discovery workshop',
    descriptionHtml: null,
    acceptanceCriteria: null,
    status: 'pending',
    nodeVariant: 'pending',
    statusLabel: 'Not started',
    connectorFilled: false,
    valueLabel: null,
    startedLabel: null,
    completedLabel: null,
    completionNote: null,
    ...overrides,
  };
}

describe('MilestoneRail', () => {
  it('renders the section label and every milestone title', () => {
    render(
      <MilestoneRail
        milestones={[
          makeNode({ id: 'a', title: 'Discovery workshop' }),
          makeNode({ id: 'b', title: 'Build the integration' }),
        ]}
      />
    );

    expect(screen.getByText('Delivery plan')).toBeInTheDocument();
    expect(screen.getByText('Discovery workshop')).toBeInTheDocument();
    expect(screen.getByText('Build the integration')).toBeInTheDocument();
  });

  it('renders the status label for each node variant', () => {
    render(
      <MilestoneRail
        milestones={[
          makeNode({ id: 'a', nodeVariant: 'completed', statusLabel: 'Completed' }),
          makeNode({ id: 'b', nodeVariant: 'in_progress', statusLabel: 'In progress' }),
          makeNode({ id: 'c', nodeVariant: 'pending', statusLabel: 'Not started' }),
        ]}
      />
    );

    expect(screen.getByText('Completed')).toBeInTheDocument();
    expect(screen.getByText('In progress')).toBeInTheDocument();
    expect(screen.getByText('Not started')).toBeInTheDocument();
  });

  it('renders acceptance criteria under a "Done when:" label', () => {
    render(
      <MilestoneRail milestones={[makeNode({ acceptanceCriteria: 'The sandbox passes UAT.' })]} />
    );

    expect(screen.getByText('Done when:')).toBeInTheDocument();
    expect(screen.getByText(/The sandbox passes UAT\./)).toBeInTheDocument();
  });

  it('joins started and completed timing labels with a separator', () => {
    render(
      <MilestoneRail
        milestones={[
          makeNode({
            nodeVariant: 'completed',
            statusLabel: 'Completed',
            startedLabel: 'Started 16 Jun',
            completedLabel: 'Completed 30 Jun by Priya',
          }),
        ]}
      />
    );

    expect(screen.getByText('Started 16 Jun · Completed 30 Jun by Priya')).toBeInTheDocument();
  });

  it('renders the success-tinted "Delivered:" completion note', () => {
    render(
      <MilestoneRail
        milestones={[
          makeNode({
            nodeVariant: 'completed',
            statusLabel: 'Completed',
            completionNote: 'Shipped the report and recording.',
          }),
        ]}
      />
    );

    expect(screen.getByText('Delivered:')).toBeInTheDocument();
    expect(screen.getByText(/Shipped the report and recording\./)).toBeInTheDocument();
  });

  it('renders the description HTML through RichText', () => {
    render(
      <MilestoneRail
        milestones={[makeNode({ descriptionHtml: '<p>Scope the data model together.</p>' })]}
      />
    );

    expect(screen.getByText('Scope the data model together.')).toBeInTheDocument();
  });

  it('renders an optional value label pill', () => {
    render(<MilestoneRail milestones={[makeNode({ valueLabel: 'A$14,500' })]} />);

    expect(screen.getByText('A$14,500')).toBeInTheDocument();
  });

  it('is strictly read-only — renders no action buttons', () => {
    render(
      <MilestoneRail
        milestones={[
          makeNode({ id: 'a', nodeVariant: 'pending', statusLabel: 'Not started' }),
          makeNode({ id: 'b', nodeVariant: 'in_progress', statusLabel: 'In progress' }),
          makeNode({
            id: 'c',
            nodeVariant: 'completed',
            statusLabel: 'Completed',
            completionNote: 'Done.',
          }),
        ]}
      />
    );

    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(screen.queryByText(/start milestone/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/mark complete/i)).not.toBeInTheDocument();
  });

  it('fills the connector with the gradient only below completed nodes', () => {
    const { container } = render(
      <MilestoneRail
        milestones={[
          makeNode({
            id: 'a',
            nodeVariant: 'completed',
            statusLabel: 'Completed',
            connectorFilled: true,
          }),
          makeNode({ id: 'b', nodeVariant: 'in_progress', statusLabel: 'In progress' }),
        ]}
      />
    );

    const connectors = container.querySelectorAll('div.w-\\[2\\.5px\\]');
    // Only the first node (not last) renders a connector; it is gradient-filled.
    expect(connectors).toHaveLength(1);
    const [connector] = connectors;
    expect(connector?.className).toContain('from-primary');
  });

  it('marks the in-progress node with a reduced-motion-safe breathe animation', () => {
    const { container } = render(
      <MilestoneRail
        milestones={[makeNode({ nodeVariant: 'in_progress', statusLabel: 'In progress' })]}
      />
    );

    const breathing = container.querySelector('.motion-reduce\\:animate-none');
    expect(breathing).not.toBeNull();
    expect(breathing?.className).toContain('nodeBreathe');
  });

  it('scopes the completion note to the row containing the completed milestone', () => {
    render(
      <MilestoneRail
        milestones={[
          makeNode({
            id: 'a',
            title: 'First',
            nodeVariant: 'completed',
            statusLabel: 'Completed',
            completionNote: 'Artifact attached.',
          }),
          makeNode({
            id: 'b',
            title: 'Second',
            nodeVariant: 'pending',
            statusLabel: 'Not started',
          }),
        ]}
      />
    );

    const delivered = screen.getByText('Delivered:').closest('div');
    expect(delivered).not.toBeNull();
    if (delivered !== null) {
      expect(within(delivered).getByText(/Artifact attached\./)).toBeInTheDocument();
    }
  });
});
