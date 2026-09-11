import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@/test/utils';
import { track, ADMIN_ALERTS_EVENTS } from '@/lib/analytics';
import { AdminQueueAnalytics } from './admin-queue-analytics';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('AdminQueueAnalytics (BAL-548)', () => {
  it('fires admin_queue_viewed once on mount with the given props', () => {
    render(<AdminQueueAnalytics openCount={5} oldestAgeDays={3.2} filter="all" />);
    expect(track).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledWith(ADMIN_ALERTS_EVENTS.QUEUE_VIEWED, {
      open_count: 5,
      oldest_age_days: 3.2,
      filter: 'all',
    });
  });

  it('passes the active group filter through unchanged', () => {
    render(<AdminQueueAnalytics openCount={2} oldestAgeDays={0} filter="money" />);
    expect(track).toHaveBeenCalledWith(ADMIN_ALERTS_EVENTS.QUEUE_VIEWED, {
      open_count: 2,
      oldest_age_days: 0,
      filter: 'money',
    });
  });

  it('does not re-fire on a rerender with the same props', () => {
    const { rerender } = render(
      <AdminQueueAnalytics openCount={5} oldestAgeDays={3} filter="all" />
    );
    rerender(<AdminQueueAnalytics openCount={5} oldestAgeDays={3} filter="all" />);
    expect(track).toHaveBeenCalledTimes(1);
  });

  it('renders nothing', () => {
    const { container } = render(
      <AdminQueueAnalytics openCount={0} oldestAgeDays={0} filter="all" />
    );
    expect(container).toBeEmptyDOMElement();
  });
});
