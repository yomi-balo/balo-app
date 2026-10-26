import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/utils';

import { HoursBar } from './hours-bar';
import { milestoneTimeView } from './fixtures';

describe('HoursBar', () => {
  it('fills with the primary token below 80%', () => {
    render(<HoursBar time={milestoneTimeView()} />);
    expect(screen.getByText('4 of 8 hrs logged')).toBeInTheDocument();
    const bar = screen.getByRole('progressbar', { name: 'Hours logged on Discovery workshop' });
    expect(bar).toHaveAttribute('aria-valuenow', '50');
    expect(bar.firstElementChild).toHaveClass('bg-primary');
    expect(bar.firstElementChild).toHaveStyle({ width: '50%' });
  });

  it('turns warning and says how much is left once near the estimate', () => {
    render(
      <HoursBar
        time={milestoneTimeView({
          tone: 'near',
          fillPercent: 88,
          loggedLabel: '7 of 8 hrs logged',
          remainingLabel: '1 hr left of estimate',
        })}
      />
    );
    expect(screen.getByText('1 hr left of estimate')).toHaveClass('text-warning-strong');
    expect(screen.getByRole('progressbar').firstElementChild).toHaveClass('bg-warning');
  });

  it('turns destructive and says so in words once over', () => {
    render(
      <HoursBar
        time={milestoneTimeView({
          tone: 'over',
          fillPercent: 100,
          loggedLabel: '9 of 8 hrs logged',
          remainingLabel: '1 hr over estimate',
        })}
      />
    );
    expect(screen.getByText('1 hr over estimate')).toHaveClass('text-destructive-strong');
    expect(screen.getByRole('progressbar').firstElementChild).toHaveClass('bg-destructive');
  });

  it('renders the hours alone, with no track, when there is no estimate', () => {
    render(
      <HoursBar
        time={milestoneTimeView({
          estimatedMinutes: null,
          fillPercent: 0,
          loggedLabel: '4 hrs logged',
        })}
      />
    );
    expect(screen.getByText('4 hrs logged')).toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });
});
