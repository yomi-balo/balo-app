import { describe, it, expect, vi } from 'vitest';
import { render } from '@/test/utils';
import { track, ADMIN_CAPTURE_HEALTH_EVENTS } from '@/lib/analytics';
import { CaptureHealthAnalytics } from './capture-health-analytics';

describe('CaptureHealthAnalytics', () => {
  it('fires admin_capture_health_viewed once per mount', () => {
    render(<CaptureHealthAnalytics windowDays={30} filter="all" issueCount={3} />);
    expect(track).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledWith(ADMIN_CAPTURE_HEALTH_EVENTS.VIEWED, {
      window_days: 30,
      filter: 'all',
      issue_count: 3,
    });
  });

  it('re-rendering with the SAME props does not re-fire (StrictMode double-invoke guard)', () => {
    const { rerender } = render(
      <CaptureHealthAnalytics windowDays={30} filter="all" issueCount={3} />
    );
    vi.clearAllMocks();
    rerender(<CaptureHealthAnalytics windowDays={30} filter="all" issueCount={3} />);
    expect(track).not.toHaveBeenCalled();
  });

  it('renders nothing', () => {
    const { container } = render(
      <CaptureHealthAnalytics windowDays={30} filter="all" issueCount={0} />
    );
    expect(container).toBeEmptyDOMElement();
  });
});
