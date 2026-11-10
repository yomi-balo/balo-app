import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/utils';

import { TimeTotals } from './time-totals';

const PERIOD = {
  hoursLabel: '12 hrs',
  detail: '1 Oct – 31 Oct · billed to Northwind on 1 Nov, whatever the review status',
};

describe('TimeTotals', () => {
  it('shows the logged hours, the estimate track and the billing period', () => {
    render(
      <TimeTotals
        totals={{
          loggedLabel: '12 of 40 hrs logged',
          fillPercent: 30,
          over: false,
          period: PERIOD,
        }}
      />
    );
    expect(screen.getByText('12 of 40 hrs logged')).toBeInTheDocument();
    expect(screen.getByRole('progressbar').firstElementChild).toHaveClass('bg-gradient-to-r');
    expect(screen.getByText('12 hrs')).toBeInTheDocument();
    expect(screen.getByText(/this billing period/)).toBeInTheDocument();
    expect(screen.getByText(/billed to Northwind on 1 Nov/)).toBeInTheDocument();
  });

  it('turns the track destructive when over', () => {
    render(
      <TimeTotals
        totals={{ loggedLabel: '45 of 40 hrs logged', fillPercent: 100, over: true, period: null }}
      />
    );
    expect(screen.getByRole('progressbar').firstElementChild).toHaveClass('bg-destructive');
  });

  it('omits the period column when there is no period, and the track when no estimate', () => {
    render(
      <TimeTotals
        totals={{ loggedLabel: '5 hrs logged', fillPercent: null, over: false, period: null }}
      />
    );
    expect(screen.getByText('5 hrs logged')).toBeInTheDocument();
    expect(screen.queryByText(/this billing period/)).not.toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('never renders a currency symbol', () => {
    const { container } = render(
      <TimeTotals
        totals={{
          loggedLabel: '12 of 40 hrs logged',
          fillPercent: 30,
          over: false,
          period: PERIOD,
        }}
      />
    );
    expect(container.textContent).not.toMatch(/[$€£]|A\$/);
  });
});
