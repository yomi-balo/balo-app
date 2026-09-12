import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@/test/utils';
import { track, ADMIN_APPLICATIONS_EVENTS } from '@/lib/analytics';
import { ApplicationsAnalytics } from './applications-analytics';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ApplicationsAnalytics (BAL-549)', () => {
  it('fires admin_applications_list_viewed once on mount with the given props', () => {
    render(<ApplicationsAnalytics pendingCount={5} oldestDays={3} />);
    expect(track).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledWith(ADMIN_APPLICATIONS_EVENTS.LIST_VIEWED, {
      pending_count: 5,
      oldest_days: 3,
    });
  });

  it('does not re-fire on a rerender with the same props (StrictMode double-invoke guard)', () => {
    const { rerender } = render(<ApplicationsAnalytics pendingCount={5} oldestDays={3} />);
    rerender(<ApplicationsAnalytics pendingCount={5} oldestDays={3} />);
    expect(track).toHaveBeenCalledTimes(1);
  });

  it('reports 0 oldest_days when nothing is pending', () => {
    render(<ApplicationsAnalytics pendingCount={0} oldestDays={0} />);
    expect(track).toHaveBeenCalledWith(ADMIN_APPLICATIONS_EVENTS.LIST_VIEWED, {
      pending_count: 0,
      oldest_days: 0,
    });
  });

  it('renders nothing', () => {
    const { container } = render(<ApplicationsAnalytics pendingCount={0} oldestDays={0} />);
    expect(container).toBeEmptyDOMElement();
  });
});
