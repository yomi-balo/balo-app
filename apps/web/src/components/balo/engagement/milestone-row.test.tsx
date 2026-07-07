import { describe, expect, it } from 'vitest';

import { render, screen } from '@/test/utils';
import type { MilestoneNodeView } from '@/lib/engagement/engagement-view';

import { MilestoneRow } from './milestone-row';

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
});
