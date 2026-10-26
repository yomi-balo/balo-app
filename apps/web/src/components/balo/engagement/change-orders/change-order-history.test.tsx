import { describe, expect, it } from 'vitest';
import userEvent from '@testing-library/user-event';

import { render, screen } from '@/test/utils';
import { axe } from '@/test/axe';
import type { ChangeOrderItemView } from '@/lib/engagement/change-order-view';

import { ChangeOrderHistory } from './change-order-history';
import { ChangeOrderLines } from './change-order-lines';
import { ChangeOrderPriceEffect } from './change-order-price-effect';

function item(overrides: Partial<ChangeOrderItemView> = {}): ChangeOrderItemView {
  return {
    id: 'o1',
    pricingMethod: 'fixed',
    sentOnLabel: '18 Oct',
    sentByLabel: 'Charles @ CloudPeak',
    status: 'approved',
    pill: { label: 'Approved', tone: 'emerald' },
    summary: 'Adds a dashboard.',
    requestNote: null,
    requestedHeading: null,
    datesLabel: 'Sent 18 Oct · Approved 20 Oct',
    lines: [
      {
        op: 'add',
        title: 'Marketing dashboard',
        descriptionText: 'KPI board.',
        estimateLabel: null,
        loggedLabel: null,
        before: null,
      },
    ],
    priceEffect: { text: 'Project price A$15,625 → A$17,500 (+A$1,875)', hint: null },
    deltaChip: '+A$1,875',
    answerText: null,
    declineText: null,
    ...overrides,
  };
}

describe('ChangeOrderHistory', () => {
  it('renders nothing when there is no history', () => {
    const { container } = render(<ChangeOrderHistory history={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('lists each order with its pill, chip, summary and dates, collapsed by default', () => {
    render(
      <ChangeOrderHistory
        history={[
          item(),
          item({
            id: 'o2',
            status: 'withdrawn',
            pill: { label: 'Withdrawn', tone: 'slate' },
            summary: 'Earlier idea.',
            lines: [],
            priceEffect: null,
            deltaChip: null,
            datesLabel: 'Sent 2 Oct · Withdrawn 3 Oct',
          }),
        ]}
      />
    );
    expect(screen.getByRole('heading', { name: 'Changes to this project' })).toBeInTheDocument();
    expect(screen.getByText('Approved')).toBeInTheDocument();
    expect(screen.getByText('+A$1,875')).toBeInTheDocument();
    expect(screen.getByText('Adds a dashboard.')).toBeInTheDocument();
    expect(screen.getByText('Sent 18 Oct · Approved 20 Oct')).toBeInTheDocument();
    expect(screen.getByText('Withdrawn')).toBeInTheDocument();
    expect(screen.queryByText('Marketing dashboard')).not.toBeInTheDocument();
    // Only the order with something to expand gets a Details control.
    expect(screen.getAllByRole('button', { name: /Details/ })).toHaveLength(1);
  });

  it('expands to the lines and settled price effect, then collapses', async () => {
    const user = userEvent.setup();
    render(<ChangeOrderHistory history={[item()]} />);
    const toggle = screen.getByRole('button', { name: /Details/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');

    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(toggle).toHaveTextContent('Hide');
    expect(screen.getByText('Marketing dashboard')).toBeInTheDocument();
    expect(screen.getByText('Project price A$15,625 → A$17,500 (+A$1,875)')).toBeInTheDocument();

    await user.click(toggle);
    expect(screen.queryByText('Marketing dashboard')).not.toBeInTheDocument();
  });

  it('quotes the request note for an answered request and shows the answer on expand', async () => {
    const user = userEvent.setup();
    render(
      <ChangeOrderHistory
        history={[
          item({
            status: 'declined',
            pill: { label: 'Answered', tone: 'slate' },
            summary: null,
            requestNote: 'Can we add a tab?',
            lines: [],
            priceEffect: null,
            deltaChip: null,
            answerText: 'Charles @ CloudPeak answered: “Already there.”',
          }),
        ]}
      />
    );
    expect(screen.getByText('“Can we add a tab?”')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Details/ }));
    expect(screen.getByText('Charles @ CloudPeak answered: “Already there.”')).toBeInTheDocument();
  });

  it('shows the decline reason on expand', async () => {
    const user = userEvent.setup();
    render(
      <ChangeOrderHistory
        history={[
          item({
            status: 'declined',
            pill: { label: 'Declined', tone: 'slate' },
            declineText: 'You declined: “Too costly.”',
          }),
        ]}
      />
    );
    await user.click(screen.getByRole('button', { name: /Details/ }));
    expect(screen.getByText('You declined: “Too costly.”')).toBeInTheDocument();
  });

  it('has no accessibility violations', async () => {
    const { container } = render(<ChangeOrderHistory history={[item()]} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('ChangeOrderLines', () => {
  it('says so when no milestone changes', () => {
    render(<ChangeOrderLines lines={[]} />);
    expect(screen.getByText('No change to the milestones.')).toBeInTheDocument();
  });

  it('renders New, Edited and Removed lines with before / after for changed fields only', () => {
    render(
      <ChangeOrderLines
        lines={[
          {
            op: 'add',
            title: 'Dashboard',
            descriptionText: 'KPI board.',
            estimateLabel: '5 hrs',
            loggedLabel: null,
            before: null,
          },
          {
            op: 'edit',
            title: 'Build v2',
            descriptionText: 'Same text.',
            estimateLabel: '30 hrs',
            loggedLabel: null,
            before: { title: 'Build', descriptionText: 'Same text.', estimateLabel: '20 hrs' },
          },
          {
            op: 'remove',
            title: 'Old step',
            descriptionText: null,
            estimateLabel: null,
            loggedLabel: null,
            before: null,
          },
        ]}
      />
    );
    expect(screen.getByText('New')).toBeInTheDocument();
    expect(screen.getByText('Edited')).toBeInTheDocument();
    expect(screen.getByText('Removed')).toBeInTheDocument();
    expect(screen.getByText('Estimate 5 hrs')).toBeInTheDocument();
    expect(screen.getByText('KPI board.')).toBeInTheDocument();
    expect(screen.getByText('Name before')).toBeInTheDocument();
    expect(screen.getByText('Name after')).toBeInTheDocument();
    expect(screen.queryByText('Description before')).not.toBeInTheDocument();
    expect(screen.getByText('20 hrs')).toBeInTheDocument();
    expect(screen.getByText('Old step')).toHaveClass('line-through');
  });

  it('shows the hours already logged, muted, under an estimate change', () => {
    render(
      <ChangeOrderLines
        lines={[
          {
            op: 'edit',
            title: 'Discovery',
            descriptionText: null,
            estimateLabel: '10 hrs',
            loggedLabel: '10.5 hrs logged so far · already past the new estimate',
            before: { title: 'Discovery', descriptionText: null, estimateLabel: '8 hrs' },
          },
        ]}
      />
    );
    expect(screen.getByText('8 hrs')).toBeInTheDocument();
    expect(screen.getByText('10.5 hrs logged so far · already past the new estimate')).toHaveClass(
      'text-muted-foreground'
    );
  });
});

describe('ChangeOrderPriceEffect', () => {
  it('renders the text and the hint verbatim', () => {
    render(
      <ChangeOrderPriceEffect effect={{ text: 'The price doesn’t change.', hint: 'A hint.' }} />
    );
    expect(screen.getByText('The price doesn’t change.')).toBeInTheDocument();
    expect(screen.getByText('A hint.')).toBeInTheDocument();
  });

  it('omits the hint when there is none', () => {
    render(
      <ChangeOrderPriceEffect effect={{ text: 'Estimate 56 hrs → 66 hrs (+10 hrs)', hint: null }} />
    );
    expect(screen.getByText('Estimate 56 hrs → 66 hrs (+10 hrs)')).toBeInTheDocument();
    expect(screen.getAllByText(/./)).toHaveLength(1);
  });
});
